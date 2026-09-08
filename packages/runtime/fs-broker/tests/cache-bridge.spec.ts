import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import { createServer, type Server, type Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { BrokerBridge } from '@deepseek-ai/dsh-runtime-broker'
import { BrokerSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-broker'
import { afterEach, describe, expect, it } from 'vitest'
import BrokerFileSystem from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const directory = await mkdtemp('/tmp/fs-cache-')
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  let file: { type: 'file'; size: number; mtime_ms: number } | undefined
  let listing: unknown = { entries: [] }
  let statCalls = 0
  const server: Server = createServer((socket) => {
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk.toString()
      if (!input.includes('\n')) return
      const request = JSON.parse(input.split('\n')[0]!) as { id: string; tool: string; arguments: { path: string; content?: string } }
      let result: unknown
      if (request.tool === 'stat_file') {
        statCalls += 1
        result = request.arguments.path === '/workspace' ? { type: 'directory', mtime_ms: 1 } : file ?? { exists: false }
      } else if (request.tool === 'list_files') result = listing
      else if (request.tool === 'write_file') {
        file = { type: 'file', size: request.arguments.content!.length, mtime_ms: 2 }
        result = {}
      } else if (request.tool === 'read_file') result = { content: Buffer.alloc(file!.size, 'x').toString('base64') }
      socket.end(JSON.stringify({ id: request.id, ok: true, result }) + '\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(`${directory}/broker.sock`, resolve)
  })
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() })))
  const bridge = new BrokerBridge({ cacheDiscovery: true, socketPath: `${directory}/broker.sock`, secret: 'x'.repeat(32) })
  cleanups.push(async () => { bridge.dispose() })
  const ctx = new Context()
  const fs = new BrokerFileSystem(ctx, {}, bridge)
  cleanups.push(async () => { await ctx.fiber.dispose() })
  return {
    bridge, fs,
    get statCalls() { return statCalls },
    set file(value: typeof file) { file = value },
    set listing(value: unknown) { listing = value },
  }
}

// The broker transport and inherited file descriptor require POSIX sockets/processes.
describe.skipIf(process.platform === 'win32')('discovery cache with real broker transport', () => {
  it('keeps discovery live during stdin writes and after a parent exits before its background child writes', async () => {
    const directory = await mkdtemp('/tmp/fs-command-cache-')
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const started = Promise.withResolvers<undefined>()
    let command: ChildProcess | undefined
    let exited: { exit_code: number | null; signal: NodeJS.Signals | null } | undefined
    let closed: Promise<unknown> | undefined
    let statCalls = 0
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let input = ''
      socket.on('data', function receive(chunk) {
        input += chunk.toString()
        if (!input.includes('\n')) return
        socket.off('data', receive)
        const request = JSON.parse(input.split('\n')[0]!) as {
          id: string
          tool: string
          arguments: { path: string; argv: string[]; action: string; chars: string }
        }
        const respond = (result: unknown): void => { socket.end(JSON.stringify({ id: request.id, ok: true, result }) + '\n') }
        if (request.tool === 'exec_command') {
          command = spawn(request.arguments.argv[0]!, request.arguments.argv.slice(1), {
            cwd: directory,
            env: {},
            detached: true,
            // fd 3 gates the descendant independently of the parent's stdin.
            stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
          })
          closed = once(command, 'close')
          command.once('exit', (exit_code, signal) => { exited = { exit_code, signal } })
          command.once('error', started.reject)
          command.once('spawn', () => { respond({ session_id: 1 }); started.resolve(undefined) })
        } else if (request.tool === 'write_stdin') {
          if (request.arguments.action === 'write') command!.stdin!.write(request.arguments.chars)
          if (request.arguments.action === 'kill') command!.kill('SIGKILL')
          respond(exited ?? { session_id: 1 })
        } else if (request.tool === 'stat_file') {
          if (request.arguments.path.endsWith('/AGENTS.md') || request.arguments.path.endsWith('/CLAUDE.md')) statCalls += 1
          void stat(request.arguments.path).then(
            (value) => { respond({ type: value.isDirectory() ? 'directory' : 'file', size: value.size, mtime_ms: Math.trunc(value.mtimeMs) }) },
            (error: unknown) => {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
              respond({ exists: false })
            },
          )
        } else throw new Error(`unexpected broker operation ${request.tool}`)
      })
    })
    cleanups.push(async () => {
      // fd 3 stays open in the descendant after parent exit. Cancel its owned
      // barrier before awaiting close, including assertion-failure teardown.
      if (command !== undefined) {
        const childInput = command.stdio[3] as Writable
        if (!childInput.destroyed) childInput.end('cancel')
        if (exited === undefined) command.kill('SIGKILL')
        await closed
      }
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(`${directory}/broker.sock`, resolve)
    })
    const bridge = new BrokerBridge({ cacheDiscovery: true, socketPath: `${directory}/broker.sock`, secret: 'x'.repeat(32) })
    cleanups.push(async () => { bridge.dispose() })
    const ctx = new Context()
    const fs = new BrokerFileSystem(ctx, { cwd: directory }, bridge)
    const subprocess = new BrokerSubprocessRuntime(ctx, { cwd: directory, pollMs: 1 }, bridge)
    cleanups.push(async () => { await ctx.fiber.dispose() })
    const target = await fs.resolve('AGENTS.md')
    const inputTarget = await fs.resolve('CLAUDE.md')
    expect(await fs.stat(target)).toBeUndefined()
    expect(await fs.stat(inputTarget)).toBeUndefined()
    await fs.stat(target)
    await fs.stat(inputTarget)
    expect(statCalls).toBe(2)
    const descendant = `
      const fs = require('node:fs');
      const input = fs.createReadStream(null, { fd: 3 });
      input.once('data', data => {
        if (data.toString() === 'release') fs.writeFileSync('AGENTS.md', 'child');
        input.destroy();
      });
    `
    const parent = `
      const fs = require('node:fs');
      process.stdin.once('data', data => {
        fs.writeFileSync('CLAUDE.md', data);
        process.stdout.write('written');
        process.stdin.once('data', () => {
          const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
            detached: true, stdio: ['ignore', 'ignore', 'ignore', 3],
          });
          child.unref();
          process.stdin.destroy();
        });
      });
    `
    const handle = subprocess.spawn({
      argv: [process.execPath, '-e', parent], cwd: directory, env: {}, graceMs: 100,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    await started.promise
    expect(await fs.stat(target)).toBeUndefined()
    expect(await fs.stat(inputTarget)).toBeUndefined()
    expect(statCalls).toBe(4)
    const written = once(command!.stdout!, 'data')
    await new Promise<void>((resolve, reject) => handle.stdin!.write('stdin', (error) => { if (error) reject(error); else resolve() }))
    await written
    expect(exited).toBeUndefined()
    expect(await readFile(`${directory}/CLAUDE.md`, 'utf8')).toBe('stdin')
    expect(await fs.stat(inputTarget)).toMatchObject({ size: 5 })
    await new Promise<void>((resolve, reject) => handle.stdin!.write('detach', (error) => { if (error) reject(error); else resolve() }))
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })
    expect(await fs.stat(target)).toBeUndefined()
    expect(statCalls).toBe(6)
    const childInput = command!.stdio[3] as Writable
    childInput.end('release')
    await closed
    expect(await readFile(`${directory}/AGENTS.md`, 'utf8')).toBe('child')
    expect(await fs.stat(target)).toMatchObject({ size: 5 })
    await fs.stat(target)
    expect(statCalls).toBe(8)
    expect(bridge.cacheAllowed).toBe(false)
  })

  it('invalidates native and filesystem writes through the shared owner', async () => {
    const setup = await fixture()
    const target = await setup.fs.resolve('AGENTS.md')
    await setup.fs.stat(target)
    await setup.bridge.invoke('write_file', { path: target.displayPath, content: 'xx' })
    expect(await setup.fs.stat(target)).toMatchObject({ type: 'file', size: 2 })
    await setup.fs.writeText(target, 'xxxxx')
    expect(await setup.fs.stat(target)).toMatchObject({ size: 5 })
  })

  it('refreshes when native listing reveals cached absence, but unchanged or omitted entries retain reuse', async () => {
    const setup = await fixture()
    const target = await setup.fs.resolve('AGENTS.md')
    await setup.fs.stat(target)
    setup.file = { type: 'file', size: 1, mtime_ms: 1 }
    setup.listing = { entries: [{ name: 'AGENTS.md', type: 'file', size: 1, mtime_ms: 1 }] }
    await setup.bridge.invoke('list_files', { path: '/workspace' })
    expect(await setup.fs.stat(target)).toMatchObject({ size: 1 })
    const generation = setup.bridge.generation
    await setup.bridge.invoke('list_files', { path: '/workspace' })
    await setup.fs.stat(target)
    expect(setup.statCalls).toBe(2)
    expect(setup.bridge.generation).toBe(generation)
    setup.listing = { entries: [], truncated: true }
    await setup.bridge.invoke('list_files', { path: '/workspace' })
    await setup.fs.stat(target)
    expect(setup.statCalls).toBe(2)
    expect(setup.bridge.generation).toBe(generation)
  })

  it('uses live listing metadata and invalidates changed cached entries through ctx.fs', async () => {
    const setup = await fixture()
    const target = await setup.fs.resolve('AGENTS.md')
    setup.file = { type: 'file', size: 1, mtime_ms: 1 }
    await setup.fs.stat(target)
    setup.file = { type: 'file', size: 2, mtime_ms: 2 }
    setup.listing = { entries: [{ name: 'AGENTS.md', type: 'file', size: 2, mtime_ms: 2 }] }
    expect(await setup.fs.listDir(await setup.fs.resolve('/workspace'))).toMatchObject([{ size: 2 }])
    expect(await setup.fs.stat(target)).toMatchObject({ size: 2 })
    expect(setup.statCalls).toBe(3)
  })
})
