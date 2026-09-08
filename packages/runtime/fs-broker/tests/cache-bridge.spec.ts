import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { BrokerBridge } from '@deepseek-ai/dsh-runtime-broker'
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
      else if (request.tool === 'exec_command') result = { exit_code: 0, stdout: '', stderr: '' }
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

describe('discovery cache with real broker transport', () => {
  it('keeps discovery live after command exit when a detached descendant writes later', async () => {
    const setup = await fixture()
    const target = await setup.fs.resolve('AGENTS.md')
    await setup.fs.stat(target)
    await setup.fs.stat(target)
    expect(setup.statCalls).toBe(1)
    await setup.bridge.invoke('exec_command', { argv: ['sh', '-c', 'sleep 1; touch AGENTS.md &'] })
    expect(await setup.fs.stat(target)).toBeUndefined()
    // Remote filesystem mutation occurs after the parent has reported exit.
    setup.file = { type: 'file', size: 1, mtime_ms: 2 }
    expect(await setup.fs.stat(target)).toMatchObject({ size: 1 })
    await setup.fs.stat(target)
    expect(setup.statCalls).toBe(4)
    expect(setup.bridge.cacheAllowed).toBe(false)
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
