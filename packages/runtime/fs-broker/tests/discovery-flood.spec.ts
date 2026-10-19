import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { BrokerBridge } from '@deepseek-ai/dsh-runtime-broker'
import { afterEach, describe, expect, it } from 'vitest'
import BrokerFileSystem from '../src/index.ts'

// Mirrors agent-service-broker e2b_adapter.py: stat_file reports mode, while
// list_files entries carry only name, type, size and mtime_ms, and paths
// outside /workspace are rejected with file_path_outside_workspace (422).
type Entry = { type: 'file' | 'dir'; size: number; mtime_ms: number; mode: number }
type Request = { id: string; tool: string; arguments: Record<string, unknown> }

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function realisticBroker() {
  const directory = await mkdtemp('/tmp/fs-flood-')
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const tree = new Map<string, Entry>([
    ['/workspace', { type: 'dir', size: 4096, mtime_ms: 1, mode: 0o755 }],
    ['/workspace/.git', { type: 'dir', size: 4096, mtime_ms: 1, mode: 0o755 }],
    ['/workspace/.skills', { type: 'dir', size: 4096, mtime_ms: 1, mode: 0o755 }],
    ['/workspace/AGENTS.md', { type: 'file', size: 120, mtime_ms: 1, mode: 0o644 }],
    ['/workspace/src', { type: 'dir', size: 4096, mtime_ms: 1, mode: 0o755 }],
    ['/workspace/src/main.py', { type: 'file', size: 10, mtime_ms: 1, mode: 0o644 }],
  ])
  const requests: Request[] = []
  const sockets = new Set<Socket>()
  let clock = 1
  let listingMode: ((path: string, mode: number) => number) | undefined
  const outside = (path: string): boolean => path !== '/workspace' && !path.startsWith('/workspace/')
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
      const path = typeof request.arguments.path === 'string' ? request.arguments.path : ''
      let reply: unknown
      if ((request.tool === 'stat_file' || request.tool === 'list_files') && outside(path)) {
        reply = { id: request.id, ok: false, error: { code: 'file_path_outside_workspace', status: 422 } }
      } else if (request.tool === 'stat_file') {
        const entry = tree.get(path)
        reply = { id: request.id, ok: true, result: entry === undefined ? { exists: false } : { exists: true, ...entry } }
      } else if (request.tool === 'list_files') {
        const entries = [...tree].filter(([key]) => posix.dirname(key) === path && key !== path)
          .map(([key, { type, size, mtime_ms, mode }]) => ({
            name: posix.basename(key), type, size, mtime_ms, ...(listingMode === undefined ? {} : { mode: listingMode(key, mode) }),
          }))
        reply = { id: request.id, ok: true, result: { entries, truncated: false } }
      } else if (request.tool === 'write_file') {
        clock += 1
        tree.set(path, { type: 'file', size: String(request.arguments.content).length, mtime_ms: clock, mode: 0o644 })
        reply = { id: request.id, ok: true, result: { path, size: String(request.arguments.content).length } }
      } else if (request.tool === 'exec_command') {
        // A command that edits a source file; discovery names are untouched.
        clock += 1
        tree.set('/workspace/src/main.py', { type: 'file', size: 10 + clock, mtime_ms: clock, mode: 0o644 })
        reply = { id: request.id, ok: true, result: { output: '', exit_code: 0, signal: null, timed_out: false } }
      } else {
        reply = { id: request.id, ok: true, result: {} }
      }
      socket.end(JSON.stringify(reply) + '\n')
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
  const count = (tool: string): number => requests.filter(request => request.tool === tool).length
  // The agent-instructions probe set issued before each model step: the
  // user-global file, the project-root marker walk, and the per-directory
  // candidates for the cwd and a touched descendant directory.
  const probes = [
    '/root/.dsh/AGENTS.md',
    '/workspace/.git',
    ...['/workspace', '/workspace/src'].flatMap(dir =>
      ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'].map(name => `${dir}/${name}`)),
    '/workspace/.skills',
  ]
  const discoveryPass = async (): Promise<void> => {
    for (const path of probes) {
      try {
        await fs.stat(await fs.resolve(path))
      } catch {
        // Outside-workspace probes fail; the instruction loader skips them.
      }
    }
  }
  return {
    bridge, fs, count, discoveryPass, probes,
    set listingMode(value: typeof listingMode) { listingMode = value },
    /** Change an entry's metadata as a command would, without a broker write. */
    touch(path: string, change: Partial<Entry>) { tree.set(path, { ...tree.get(path)!, ...change }) },
  }
}

describe('discovery cache against the real broker response shape', () => {
  it('does not re-stat unchanged discovery entries after commands, model listings or boundary rejections', async () => {
    const broker = await realisticBroker()
    await broker.discoveryPass()
    const firstPass = broker.count('stat_file')
    expect(firstPass).toBe(broker.probes.length)

    // A realistic Kimi session: six turns, each with a command, a native
    // listing of the workspace, and a discovery pass before the next step.
    for (let turn = 0; turn < 6; turn += 1) {
      await broker.bridge.invoke('exec_command', { cmd: 'python src/main.py' })
      await broker.discoveryPass()
      await broker.bridge.invoke('list_files', { path: '/workspace', limit: 1000 })
      await broker.discoveryPass()
    }

    // Before the fix every turn re-stat'd each existing entry (mode mismatch)
    // and the outside-workspace rejection, and a native listing cleared the
    // whole cache: 11 + 6 * (4 + 11) = 101 stat_file calls.
    expect(broker.count('stat_file')).toBe(firstPass)
    // One listing per in-workspace parent per command epoch, plus the model's own.
    expect(broker.count('list_files')).toBe(6 * 2 + 6)
  })

  it('compares mode when a listing reports it', async () => {
    const broker = await realisticBroker()
    await broker.discoveryPass()
    const firstPass = broker.count('stat_file')
    broker.listingMode = (path, mode) => path === '/workspace/AGENTS.md' ? 0o600 : mode
    await broker.bridge.invoke('exec_command', { cmd: 'chmod 600 AGENTS.md' })
    await broker.discoveryPass()
    expect(broker.count('stat_file')).toBe(firstPass + 1)
  })

  it('re-stats only the discovery entry whose listed size or mtime changed', async () => {
    const broker = await realisticBroker()
    await broker.discoveryPass()
    const firstPass = broker.count('stat_file')
    broker.touch('/workspace/AGENTS.md', { mtime_ms: 50 })
    await broker.bridge.invoke('exec_command', { cmd: 'touch AGENTS.md' })
    await broker.discoveryPass()
    expect(broker.count('stat_file')).toBe(firstPass + 1)
    broker.touch('/workspace/AGENTS.md', { size: 999 })
    await broker.bridge.invoke('exec_command', { cmd: 'echo more >> AGENTS.md' })
    await broker.discoveryPass()
    expect(broker.count('stat_file')).toBe(firstPass + 2)
    const info = await broker.fs.stat(await broker.fs.resolve('/workspace/AGENTS.md'))
    expect(info?.size).toBe(999)
  })
})
