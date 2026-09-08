import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrokerBridge, BrokerInvokeError } from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

interface Request { id: string; tool: string; arguments: Record<string, unknown> }

async function harness(reply: (request: Request) => unknown) {
  const directory = await mkdtemp('/tmp/dsh-broker-')
  const sockets = new Set<Socket>()
  const calls: string[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let body = ''
    socket.on('data', (chunk) => {
      body += chunk.toString()
      if (!body.includes('\n')) return
      const request = JSON.parse(body) as Request
      calls.push(request.tool)
      void Promise.resolve(reply(request)).then((response) => {
        socket.end(JSON.stringify({ id: request.id, ...response as object }) + '\n')
      })
    })
  })
  const config = { socketPath: join(directory, 'bridge.sock'), secret: 'a'.repeat(32), cacheDiscovery: true }
  await new Promise<void>(resolve => server.listen(config.socketPath, resolve))
  const bridge = new BrokerBridge(config)
  cleanups.push(async () => {
    bridge.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await rm(directory, { recursive: true, force: true })
  })
  return { bridge, config, calls }
}

describe('run-owned bridge', () => {
  it('retains the typed first quota denial and blocks every subsequent operation before transport', async () => {
    const { bridge, calls, config } = await harness(() => ({ ok: false, error: { code: 'run_quota_exceeded', status: 403 } }))
    const onTerminal = vi.fn()
    bridge.onTerminal(onTerminal)
    const error = await bridge.invoke('stat_file', {}).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(BrokerInvokeError)
    expect(error).toMatchObject({ code: 'run_quota_exceeded', status: 403, message: 'runtime-broker: run_quota_exceeded' })
    for (let i = 0; i < 10; i++) {
      for (const tool of ['stat_file', 'exec_command', 'write_file', 'write_stdin']) {
        await expect(bridge.invoke(tool, {})).rejects.toBe(error)
      }
    }
    expect(calls).toEqual(['stat_file'])
    expect(onTerminal).toHaveBeenCalledExactlyOnceWith(error)
    expect(bridge.cacheAllowed).toBe(false)
    const fresh = new BrokerBridge(config)
    expect(fresh.terminalError).toBeUndefined()
    expect(fresh.generation).toBe(0)
    expect(fresh.cacheAllowed).toBe(true)
    fresh.dispose()
  })

  it('validates error envelopes before treating quota as terminal', async () => {
    const { bridge } = await harness(() => ({ ok: false, error: { code: 'run_quota_exceeded', status: '403' } }))
    await expect(bridge.invoke('stat_file', {})).rejects.toThrow('bridge response invalid')
    expect(bridge.terminalError).toBeUndefined()
  })

  it('rejects successful envelopes missing a result instead of caching an absence', async () => {
    const { bridge } = await harness(() => ({ ok: true }))
    await expect(bridge.invoke('stat_file', {})).rejects.toThrow('bridge response invalid')
    expect(bridge.terminalError).toBeUndefined()
  })

  it('invalidates before and after pending writes, including failures', async () => {
    const result = Promise.withResolvers<unknown>()
    const { bridge } = await harness(() => result.promise)
    const write = bridge.invoke('write_file', {})
    expect(bridge.generation).toBe(1)
    expect(bridge.cacheAllowed).toBe(false)
    result.resolve({ ok: false, error: { code: 'write_failed', status: 500 } })
    await expect(write).rejects.toBeInstanceOf(BrokerInvokeError)
    expect(bridge.generation).toBe(2)
    expect(bridge.cacheAllowed).toBe(true)
  })

  it('keeps caching disabled after all overlapping commands exit because descendants may survive', async () => {
    let nextSession = 0
    const { bridge } = await harness(request => ({ ok: true, result: request.tool === 'exec_command'
      ? { session_id: ++nextSession }
      : request.arguments.action === 'kill' ? { exit_code: 137 } : { session_id: request.arguments.session_id } }))
    await bridge.invoke('exec_command', {})
    await bridge.invoke('exec_command', {})
    expect(bridge.cacheAllowed).toBe(false)
    await bridge.invoke('write_stdin', { session_id: 1, chars: 'touch AGENTS.md\n' })
    await bridge.invoke('write_stdin', { session_id: 1, action: 'kill' })
    expect(bridge.cacheAllowed).toBe(false)
    await bridge.invoke('write_stdin', { session_id: 2, action: 'kill' })
    expect(bridge.cacheAllowed).toBe(false)
    expect(bridge.generation).toBe(10)
  })

  it.each(['exec_command', 'write_stdin'])('disables reuse permanently at first %s dispatch even on immediate exit', async (tool) => {
    const response = Promise.withResolvers<unknown>()
    const { bridge } = await harness(() => response.promise)
    const command = bridge.invoke(tool, {})
    expect(bridge.cacheAllowed).toBe(false)
    response.resolve({ ok: true, result: { exit_code: 0 } })
    await command
    expect(bridge.cacheAllowed).toBe(false)
    bridge.invalidate()
    expect(bridge.cacheAllowed).toBe(false)
  })

  it('notifies listing observers across direct/native calls and removes subscriptions', async () => {
    const result = { entries: [] }
    const { bridge } = await harness(() => ({ ok: true, result }))
    const listener = vi.fn()
    const remove = bridge.onListing(listener)
    await bridge.invoke('list_files', { path: '/workspace' })
    expect(listener).toHaveBeenCalledExactlyOnceWith('/workspace', result)
    remove()
    await bridge.invoke('list_files', { path: '/workspace' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('aborts already-dispatched siblings with the original quota error', async () => {
    const received = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<unknown>()
    const { bridge } = await harness((request) => {
      if (request.tool === 'read_file') { received.resolve(undefined); return pending.promise }
      return { ok: false, error: { code: 'run_quota_exceeded', status: 403 } }
    })
    const read = bridge.invoke('read_file', {}).catch((error: unknown) => error)
    await received.promise
    const quota = await bridge.invoke('stat_file', {}).catch((error: unknown) => error)
    expect(await read).toBe(quota)
    pending.resolve({ ok: true, result: 'late' })
  })
})
