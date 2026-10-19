import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { BrokerBridge } from '@deepseek-ai/dsh-runtime-broker'
import { afterEach, describe, expect, it } from 'vitest'
import BrokerFileSystem from '../src/index.ts'

type Metadata = { type: 'file' | 'symlink'; size: number; mtime_ms: number }
type Request = { id: string; tool: string; arguments: { path: string; content?: string; follow_symlinks?: boolean; limit?: number } }
type Reply = () => void
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const directory = await mkdtemp('/tmp/fs-cache-')
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const files = new Map<string, Metadata>()
  const requests: Request[] = []
  const sockets = new Set<Socket>()
  let listing: unknown
  let failListing = false
  let hold: ((request: Request, reply: Reply) => boolean) | undefined
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let input = ''
    socket.on('data', function receive(chunk) {
      input += chunk.toString()
      if (!input.includes('\n')) return
      socket.off('data', receive)
      const request = JSON.parse(input.split('\n')[0]!) as Request
      requests.push(request)
      let result: unknown = {}
      if (request.tool === 'stat_file') {
        result = request.arguments.path === '/workspace' ? { type: 'directory', mtime_ms: 1 }
          : files.get(request.arguments.path) ?? { exists: false }
      } else if (request.tool === 'list_files') {
        result = listing ?? { entries: [...files].filter(([path]) => path.startsWith(request.arguments.path + '/'))
          .map(([path, metadata]) => ({ name: path.slice(path.lastIndexOf('/') + 1), ...metadata })) }
      } else if (request.tool === 'write_file') {
        files.set(request.arguments.path, { type: 'file', size: request.arguments.content!.length, mtime_ms: 2 })
      } else if (request.tool === 'read_file') result = { content: Buffer.alloc(files.get(request.arguments.path)!.size, 'x').toString('base64') }
      const failed = request.tool === 'list_files' && failListing
      const reply = (): void => {
        socket.end(JSON.stringify(failed
          ? { id: request.id, ok: false, error: { code: 'list_failed', status: 500 } }
          : { id: request.id, ok: true, result }) + '\n')
      }
      if (!hold?.(request, reply)) reply()
    })
  })
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(`${directory}/broker.sock`, resolve)
  })
  const bridge = new BrokerBridge({ cacheDiscovery: true, socketPath: `${directory}/broker.sock`, secret: 'x'.repeat(32) })
  cleanups.push(async () => { bridge.dispose() })
  const ctx = new Context()
  const fs = new BrokerFileSystem(ctx, {}, bridge)
  cleanups.push(async () => { await ctx.fiber.dispose() })
  return {
    bridge, fs, files, requests,
    get statCalls() { return requests.filter(request => request.tool === 'stat_file').length },
    get listCalls() { return requests.filter(request => request.tool === 'list_files').length },
    set file(value: Metadata | undefined) { if (value) files.set('/workspace/AGENTS.md', value); else files.delete('/workspace/AGENTS.md') },
    set listing(value: unknown) { listing = value },
    set failListing(value: boolean) { failListing = value },
    set hold(value: typeof hold) { hold = value },
    command: () => bridge.invoke('exec_command', { argv: ['true'] }),
  }
}

async function inspectEight(setup: Awaited<ReturnType<typeof fixture>>) {
  const results = []
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']) {
    results.push(await setup.fs.stat(await setup.fs.resolve(name)))
    results.push(await setup.fs.lstat(name))
  }
  return results
}

// The broker transport requires Unix sockets.
describe.skipIf(process.platform === 'win32')('discovery cache with real broker transport', () => {
  it('revalidates eight cached inspections once per command and reuses unchanged turns', async () => {
    const setup = await fixture()
    await inspectEight(setup)
    expect([setup.statCalls, setup.listCalls]).toEqual([8, 0])
    await inspectEight(setup)
    expect([setup.statCalls, setup.listCalls]).toEqual([8, 0])
    await setup.command()
    await inspectEight(setup)
    // Permanent command disablement cost eight live stats on every later turn.
    expect([setup.statCalls, setup.listCalls]).toEqual([8, 1])
    expect(setup.requests.find(request => request.tool === 'list_files')?.arguments).toEqual({ path: '/workspace', limit: 10_000 })
    await inspectEight(setup)
    expect([setup.statCalls, setup.listCalls]).toEqual([8, 1])
    await setup.command()
    await inspectEight(setup)
    expect([setup.statCalls, setup.listCalls]).toEqual([8, 2])
  })

  it('refreshes only affected cached paths when commands create, modify, and delete a file', async () => {
    const setup = await fixture()
    await inspectEight(setup)
    setup.file = { type: 'file', size: 1, mtime_ms: 1 }
    await setup.command()
    expect((await inspectEight(setup)).slice(0, 2)).toMatchObject([{ size: 1 }, { size: 1 }])
    expect([setup.statCalls, setup.listCalls]).toEqual([10, 1])
    setup.file = { type: 'file', size: 2, mtime_ms: 2 }
    await setup.command()
    expect((await inspectEight(setup)).slice(0, 2)).toMatchObject([{ size: 2 }, { size: 2 }])
    expect([setup.statCalls, setup.listCalls]).toEqual([12, 2])
    setup.file = undefined
    await setup.command()
    expect(await inspectEight(setup)).toEqual(Array.from({ length: 8 }, () => undefined))
    expect([setup.statCalls, setup.listCalls]).toEqual([14, 3])
  })

  it.each(['malformed', 'truncated', 'failed'])('falls back to live inspections after a %s listing', async (kind) => {
    const setup = await fixture()
    await inspectEight(setup)
    if (kind === 'failed') setup.failListing = true
    else setup.listing = kind === 'malformed' ? { entries: [{ name: 'AGENTS.md' }] } : { entries: [], truncated: true }
    await setup.command()
    await inspectEight(setup)
    expect([setup.statCalls, setup.listCalls]).toEqual([16, 1])
    await inspectEight(setup)
    expect([setup.statCalls, setup.listCalls]).toEqual([16, 1])
  })

  it('refreshes followed symlink metadata even when the link listing is unchanged', async () => {
    const setup = await fixture()
    setup.file = { type: 'file', size: 1, mtime_ms: 1 }
    setup.listing = { entries: [{ name: 'AGENTS.md', type: 'symlink', mtime_ms: 1 }] }
    const target = await setup.fs.resolve('AGENTS.md')
    await setup.fs.stat(target)
    setup.file = { type: 'file', size: 2, mtime_ms: 2 }
    await setup.command()
    expect(await setup.fs.stat(target)).toMatchObject({ size: 2 })
    expect([setup.statCalls, setup.listCalls]).toEqual([2, 1])
  })

  it('coalesces concurrent parent revalidation', async () => {
    const setup = await fixture()
    await inspectEight(setup)
    await setup.command()
    const arrived = Promise.withResolvers<Reply>()
    setup.hold = (request, reply) => {
      if (request.tool !== 'list_files') return false
      arrived.resolve(reply)
      return true
    }
    const first = setup.fs.stat(await setup.fs.resolve('AGENTS.md'))
    const reply = await arrived.promise
    const second = setup.fs.stat(await setup.fs.resolve('CLAUDE.md'))
    reply()
    await Promise.all([first, second])
    expect([setup.statCalls, setup.listCalls]).toEqual([8, 1])
  })

  it('does not reuse a stat response that crosses a command dispatch', async () => {
    const setup = await fixture()
    const arrived = Promise.withResolvers<Reply>()
    setup.hold = (request, reply) => {
      if (request.tool !== 'stat_file') return false
      arrived.resolve(reply)
      return true
    }
    const target = await setup.fs.resolve('AGENTS.md')
    const first = setup.fs.stat(target)
    const reply = await arrived.promise
    await setup.command()
    setup.file = { type: 'file', size: 3, mtime_ms: 3 }
    setup.hold = undefined
    reply()
    await first
    expect(await setup.fs.stat(target)).toMatchObject({ size: 3 })
    expect(setup.statCalls).toBe(2)
  })
  it('does not reuse a listing response that crosses another command', async () => {
    const setup = await fixture()
    await inspectEight(setup)
    await setup.command()
    const arrived = Promise.withResolvers<Reply>()
    setup.hold = (request, reply) => {
      if (request.tool !== 'list_files') return false
      arrived.resolve(reply)
      return true
    }
    const target = await setup.fs.resolve('AGENTS.md')
    const first = setup.fs.stat(target)
    const reply = await arrived.promise
    await setup.command()
    setup.file = { type: 'file', size: 4, mtime_ms: 4 }
    setup.hold = undefined
    reply()
    await first
    expect(await setup.fs.stat(target)).toMatchObject({ size: 4 })
    await inspectEight(setup)
    expect(setup.listCalls).toBe(1)
    expect(setup.statCalls).toBeGreaterThan(8)
  })

  it('keeps discovery live while a command request is pending', async () => {
    const setup = await fixture()
    const target = await setup.fs.resolve('AGENTS.md')
    await setup.fs.stat(target)
    const arrived = Promise.withResolvers<Reply>()
    setup.hold = (request, reply) => {
      if (request.tool !== 'exec_command') return false
      arrived.resolve(reply)
      return true
    }
    const command = setup.command()
    const reply = await arrived.promise
    expect(await setup.fs.stat(target)).toBeUndefined()
    setup.file = { type: 'file', size: 5, mtime_ms: 5 }
    expect(await setup.fs.stat(target)).toMatchObject({ size: 5 })
    expect(setup.statCalls).toBe(3)
    expect(setup.listCalls).toBe(0)
    reply()
    await command
    expect(await setup.fs.stat(target)).toMatchObject({ size: 5 })
    expect(await setup.fs.stat(target)).toMatchObject({ size: 5 })
    expect(setup.bridge.cacheAllowed).toBe(true)
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
