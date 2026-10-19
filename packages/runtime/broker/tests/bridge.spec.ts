import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as RuntimeBroker from '../src/index.ts'

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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.socketPath, resolve)
  })
  const bridge = new RuntimeBroker.BrokerBridge(config)
  cleanups.push(async () => {
    bridge.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await rm(directory, { recursive: true, force: true })
  })
  return { bridge, config, calls }
}

describe('run-owned bridge', () => {
  it('puts the runtime hint into the error message the model reads, bounded', async () => {
    const hint = 'The peer rejected the parameters. Send again without context_id.'
    const { bridge } = await harness(() => ({ ok: false, error: { code: 'a2a_peer_invalid_params', status: 400, message: hint } }))
    const error = await bridge.invoke('a2a_send_message', {}).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(RuntimeBroker.BrokerInvokeError)
    expect(error).toMatchObject({ code: 'a2a_peer_invalid_params', status: 400, message: 'runtime-broker: a2a_peer_invalid_params: ' + hint })

    const long = await harness(() => ({ ok: false, error: { code: 'x_error', status: 400, message: 'a\nb'.repeat(1000) } }))
    const bounded = await long.bridge.invoke('t', {}).catch((error: unknown) => error) as Error
    expect(bounded.message).toBe('runtime-broker: x_error: ' + 'a ba ba b'.repeat(100).slice(0, 500))
  })

  it('retains the typed first quota denial and blocks every subsequent operation before transport', async () => {
    const { bridge, calls, config } = await harness(() => ({ ok: false, error: { code: 'run_quota_exceeded', status: 403 } }))
    const onTerminal = vi.fn()
    bridge.onTerminal(onTerminal)
    const error = await bridge.invoke('stat_file', {}).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(RuntimeBroker.BrokerInvokeError)
    expect(error).toMatchObject({ code: 'run_quota_exceeded', status: 403, message: 'runtime-broker: run_quota_exceeded' })
    for (let i = 0; i < 10; i++) {
      for (const tool of ['stat_file', 'exec_command', 'write_file', 'write_stdin']) {
        await expect(bridge.invoke(tool, {})).rejects.toBe(error)
      }
    }
    expect(calls).toEqual(['stat_file'])
    expect(onTerminal).toHaveBeenCalledExactlyOnceWith(error)
    expect(bridge.cacheAllowed).toBe(false)
    const fresh = new RuntimeBroker.BrokerBridge(config)
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
    await expect(write).rejects.toBeInstanceOf(RuntimeBroker.BrokerInvokeError)
    expect(bridge.generation).toBe(2)
    expect(bridge.cacheAllowed).toBe(true)
  })

  it('advances command epochs independently from non-command invalidations', async () => {
    const { bridge } = await harness(() => ({ ok: true, result: { exit_code: 0 } }))
    expect(bridge.commandEpoch).toBe(0)
    expect(bridge.discoveryGeneration).toBe(0)
    for (const tool of ['exec_command', 'write_stdin', 'exec_command']) {
      await bridge.invoke(tool, tool === 'write_stdin' ? { session_id: 'cmd-41' } : {})
    }
    expect(bridge.commandEpoch).toBe(3)
    expect(bridge.generation).toBe(6)
    expect(bridge.discoveryGeneration).toBe(0)
    expect(bridge.cacheAllowed).toBe(true)
    await bridge.invoke('write_file', {})
    expect(bridge.discoveryGeneration).toBe(2)
    expect(bridge.commandEpoch).toBe(3)
    bridge.invalidate()
    expect(bridge.discoveryGeneration).toBe(3)
  })

  it.each(['exec_command', 'write_stdin'])('blocks caching during %s and retains its epoch on failure', async (tool) => {
    const response = Promise.withResolvers<unknown>()
    const { bridge } = await harness(() => response.promise)
    const command = bridge.invoke(tool, {})
    expect(bridge.cacheAllowed).toBe(false)
    expect(bridge.commandEpoch).toBe(1)
    response.resolve({ ok: false, error: { code: 'command_failed', status: 500 } })
    await expect(command).rejects.toBeInstanceOf(RuntimeBroker.BrokerInvokeError)
    expect(bridge.cacheAllowed).toBe(false)
    expect(bridge.commandEpoch).toBe(1)
    expect(bridge.generation).toBe(2)
  })

  it('blocks discovery until every yielded command finishes, including stdin yields', async () => {
    const results = [
      { session_id: 'cmd-41', exit_code: null, signal: null, timed_out: false },
      { session_id: 42, exit_code: null },
      { session_id: 'cmd-41', exit_code: null },
      { exit_code: 0, signal: null },
      { exit_code: null, signal: 'SIGKILL', timed_out: true },
    ]
    const { bridge } = await harness(() => ({ ok: true, result: results.shift() }))
    await bridge.invoke('exec_command', { cmd: 'first' })
    expect(bridge.cacheAllowed).toBe(false)
    await bridge.invoke('exec_command', { cmd: 'second' })
    await bridge.invoke('write_stdin', { session_id: 'cmd-41' })
    expect(bridge.cacheAllowed).toBe(false)
    await bridge.invoke('write_stdin', { session_id: 'cmd-41' })
    expect(bridge.cacheAllowed).toBe(false)
    await bridge.invoke('write_stdin', { session_id: 42 })
    expect(bridge.cacheAllowed).toBe(true)
    expect(bridge.commandEpoch).toBe(5)
  })

  it.each([{}, null, { exit_code: null }, { exit_code: '0' }, { exit_code: 256 },
    { session_id: '', exit_code: 0 }, { session_id: null, exit_code: 0 }, { complete: true }])(
    'disables discovery for the lease after an unknown exec result: %j', async (unknownResult) => {
      let result = unknownResult
      const { bridge } = await harness(() => ({ ok: true, result }))
      await bridge.invoke('exec_command', {})
      expect(bridge.cacheAllowed).toBe(false)
      result = { exit_code: 0 }
      await bridge.invoke('exec_command', {})
      expect(bridge.cacheAllowed).toBe(false)
    },
  )

  it.each([
    { ok: true, result: {} },
    { ok: false, error: { code: 'sandbox_process_failure', status: 502 } },
  ])('retains an uncertain stdin session until its definitive completion: %j', async (uncertain) => {
    const responses = [
      { ok: true, result: { session_id: 'cmd-41' } },
      uncertain,
      { ok: true, result: { exit_code: 1 } },
    ]
    const { bridge } = await harness(() => responses.shift())
    await bridge.invoke('exec_command', {})
    await bridge.invoke('write_stdin', { session_id: 'cmd-41' }).catch(() => undefined)
    expect(bridge.cacheAllowed).toBe(false)
    await bridge.invoke('write_stdin', { session_id: 'cmd-41' })
    expect(bridge.cacheAllowed).toBe(true)
  })

  it('does not revive a completed session from an older yielded response', async () => {
    const received = Promise.withResolvers<undefined>()
    const delayed = Promise.withResolvers<unknown>()
    const { bridge } = await harness((request) => {
      if (request.tool === 'exec_command') return { ok: true, result: { session_id: 'cmd-41' } }
      if (request.arguments.chars === 'old') {
        received.resolve(undefined)
        return delayed.promise
      }
      return { ok: true, result: { exit_code: 0 } }
    })
    await bridge.invoke('exec_command', {})
    const old = bridge.invoke('write_stdin', { session_id: 'cmd-41', chars: 'old' })
    await received.promise
    await bridge.invoke('write_stdin', { session_id: 'cmd-41' })
    expect(bridge.cacheAllowed).toBe(false)
    delayed.resolve({ ok: true, result: { session_id: 'cmd-41' } })
    await old
    expect(bridge.cacheAllowed).toBe(true)
    await bridge.invoke('exec_command', {})
    expect(bridge.cacheAllowed).toBe(false)
  })

  it('keeps an aborted dispatch uncertain after its socket closes', async () => {
    const received = Promise.withResolvers<undefined>()
    const delayed = Promise.withResolvers<unknown>()
    const { bridge } = await harness(() => { received.resolve(undefined); return delayed.promise })
    const controller = new AbortController()
    const request = bridge.invoke('exec_command', {}, controller.signal)
    const rejected = expect(request).rejects.toThrow('invocation aborted')
    await received.promise
    controller.abort()
    await rejected
    expect(bridge.cacheAllowed).toBe(false)
    delayed.resolve({ ok: true, result: { exit_code: 0 } })
  })

  it('retains a newer session observation when an older completion arrives last', async () => {
    const received = Promise.withResolvers<undefined>()
    const delayed = Promise.withResolvers<unknown>()
    const { bridge } = await harness((request) => {
      if (request.tool === 'exec_command') return { ok: true, result: { session_id: 'cmd-41' } }
      if (request.arguments.chars === 'old') {
        received.resolve(undefined)
        return delayed.promise
      }
      return { ok: true, result: { exit_code: 0 } }
    })
    await bridge.invoke('exec_command', {})
    const old = bridge.invoke('write_stdin', { session_id: 'cmd-41', chars: 'old' })
    await received.promise
    await bridge.invoke('exec_command', {})
    delayed.resolve({ ok: true, result: { exit_code: 0 } })
    await old
    expect(bridge.cacheAllowed).toBe(false)
    await bridge.invoke('write_stdin', { session_id: 'cmd-41' })
    expect(bridge.cacheAllowed).toBe(true)
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

  it('removes every plugin contribution and disposes its bridge with the contributing fiber', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(RuntimeBroker, {
      socketPath: '/tmp/dsh-disposed-broker.sock',
      secret: 'a'.repeat(32),
      tools: [{
        name: 'broker_probe',
        description: 'Probe the Runtime broker.',
        inputSchema: { type: 'object', properties: {} },
        outputLimitBytes: 1024,
      }],
    })
    const bridge = ctx.get('runtimeBroker')
    if (bridge === undefined) throw new Error('runtime broker service was not mounted')
    const assertAvailable = vi.spyOn(bridge, 'assertAvailable')
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    expect(ctx.tools.get('broker_probe')).toBeDefined()
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', {} as never, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })
    expect(assertAvailable).toHaveBeenCalledOnce()

    await fiber.dispose()

    expect(ctx.get('runtimeBroker')).toBeUndefined()
    expect(ctx.tools.get('broker_probe')).toBeUndefined()
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', {} as never, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })
    expect(assertAvailable).toHaveBeenCalledOnce()
    await expect(bridge.invoke('stat_file', {})).rejects.toThrow('runtime-broker: bridge disposed')
  })

  it('raises only pure write_stdin polls to the poll floor', () => {
    const floor = 10_000
    expect(RuntimeBroker.stdinPollArguments({ session_id: 'p1' }, floor)).toEqual({ session_id: 'p1', yield_time_ms: floor })
    expect(RuntimeBroker.stdinPollArguments({ session_id: 7, action: 'poll', chars: '', yield_time_ms: 250 }, floor))
      .toEqual({ session_id: 7, action: 'poll', chars: '', yield_time_ms: floor })
    for (const args of [
      { session_id: 'p1', chars: 'y\n' },
      { session_id: 'p1', terminate: true },
      { session_id: 'p1', action: 'kill' },
      { session_id: '__all__' },
      { session_id: 'p1', yield_time_ms: 30_000 },
      'not an object',
    ]) expect(RuntimeBroker.stdinPollArguments(args, floor)).toBe(args)
    const poll = { session_id: 'p1' }
    expect(RuntimeBroker.stdinPollArguments(poll, 0)).toBe(poll)
  })

  it('forwards the poll floor only for a write_stdin tool whose schema accepts yield_time_ms', async () => {
    const forwarded: Request[] = []
    const { config } = await harness((request) => {
      forwarded.push(request)
      return { ok: true, result: { output: '', exit_code: null, signal: null, session_id: 'p1' } }
    })
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties })
    await ctx.plugin(RuntimeBroker, {
      ...config,
      tools: [
        { name: 'write_stdin', description: 'Poll.', inputSchema: schema({ session_id: {}, yield_time_ms: {} }), outputLimitBytes: 1024 },
        { name: 'exec_command', description: 'Run.', inputSchema: schema({ cmd: {}, yield_time_ms: {} }), outputLimitBytes: 1024 },
      ],
    })
    const exec = { signal: new AbortController().signal } as never
    await ctx.tools.get('write_stdin')!.execute({ session_id: 'p1' }, exec)
    await ctx.tools.get('exec_command')!.execute({ cmd: 'sleep 60', yield_time_ms: 250 }, exec)
    expect(forwarded.map(request => request.arguments)).toEqual([
      { session_id: 'p1', yield_time_ms: 3_000 },
      { cmd: 'sleep 60', yield_time_ms: 250 },
    ])
  })

  it('rejects a poll floor Agent Runtime would refuse', () => {
    for (const stdinPollYieldMs of [1, 249, 110_001, 1.5]) {
      expect(() => RuntimeBroker.apply({} as never, { stdinPollYieldMs } as never))
        .toThrow('stdinPollYieldMs must be 0 or an integer from 250 through 110000')
    }
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
