import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { BrokerInvokeError } from '@deepseek-ai/dsh-runtime-broker'
import BrokerSubprocessRuntime from '../src/index.ts'
import { describe, expect, it } from 'vitest'

interface Invocation {
  tool: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

class FakeBridge {
  readonly calls: Invocation[] = []
  terminalError: BrokerInvokeError | undefined

  constructor(private readonly respond: (call: Invocation) => unknown) {}

  async invoke(tool: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const call = { tool, args: args as Record<string, unknown>, ...(signal === undefined ? {} : { signal }) }
    this.calls.push(call)
    return this.respond(call)
  }
}

function runtime(bridge: FakeBridge, pollMs = 1): BrokerSubprocessRuntime {
  return new BrokerSubprocessRuntime(
    new Context(),
    { pollMs },
    bridge,
  )
}

function spawnSpec(overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['printf', 'a b', '$HOME'],
    cwd: '/workspace',
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 },
      stderr: { maxBytes: 1024 },
    },
    graceMs: 10,
    ...overrides,
  }
}

describe('BrokerSubprocessRuntime', () => {
  it('polls a 60 s command a few times with the default poll wait', async () => {
    // A virtual broker clock: each call waits its yield_time_ms (250 ms broker
    // default for write_stdin) or returns early when the command exits at 60 s.
    const sixtySecondCommand = (): FakeBridge => {
      let clock = 0
      return new FakeBridge(({ tool, args }) => {
        clock = Math.min(60_000, clock + (typeof args.yield_time_ms === 'number' ? args.yield_time_ms : 250))
        if (tool === 'exec_command' || clock < 60_000) return { output: '', exit_code: null, session_id: 'build' }
        return { output: 'done', exit_code: 0 }
      })
    }
    const polls = async (pollYieldMs?: number): Promise<number> => {
      const bridge = sixtySecondCommand()
      const config = { pollMs: 1, ...(pollYieldMs === undefined ? {} : { pollYieldMs }) }
      const provider = new BrokerSubprocessRuntime(new Context(), config, bridge)
      await expect(provider.spawn(spawnSpec()).done).resolves.toMatchObject({ exitCode: 0 })
      return bridge.calls.filter(call => call.tool === 'write_stdin').length
    }

    expect(await polls(0)).toBe(239)
    expect(await polls()).toBe(20)
  })

  it('keeps polls short while stdin is open so a write is not queued behind a long poll', async () => {
    let closed = false
    const pollStarted = Promise.withResolvers<undefined>()
    const pending: (() => void)[] = []
    const bridge = new FakeBridge(({ tool, args }) => {
      if (tool === 'exec_command') return { output: '', exit_code: null, session_id: 'repl' }
      if (args.action === 'close') closed = true
      if (args.action !== 'poll') return { output: '', exit_code: null, session_id: 'repl' }
      if (closed) return { output: '', exit_code: 0 }
      pollStarted.resolve(undefined)
      return new Promise((resolve) => { pending.push(() => { resolve({ output: '', exit_code: null, session_id: 'repl' }) }) })
    })
    const provider = new BrokerSubprocessRuntime(new Context(), { pollMs: 1 }, bridge)
    const handle = provider.spawn(spawnSpec({ stdio: { stdin: 'pipe', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } }))
    await pollStarted.promise
    // The in-flight poll uses the broker's short default wait, which bounds how
    // long the write below queues; release it as that broker wait would.
    expect(bridge.calls.at(-1)?.args).not.toHaveProperty('yield_time_ms')
    const written = new Promise<void>((resolve, reject) => {
      handle.stdin!.write('1+1\n', (error) => { if (error) reject(error); else resolve() })
    })
    pending.shift()!()
    await written
    handle.stdin!.end()
    while (!closed) { pending.shift()?.(); await new Promise(resolve => setTimeout(resolve, 1)) }
    for (const release of pending.splice(0)) release()
    await expect(handle.done).resolves.toMatchObject({ exitCode: 0 })

    const calls = bridge.calls.filter(call => call.tool === 'write_stdin')
    const close = calls.findIndex(call => call.args.action === 'close')
    expect(calls.map(call => call.args.action)).toContain('write')
    for (const call of calls.slice(0, close)) expect(call.args).not.toHaveProperty('yield_time_ms')
    expect(calls.slice(close + 1).filter(call => call.args.action === 'poll').map(call => call.args.yield_time_ms))
      .toEqual([3_000])
  })

  it('rejects a poll wait the broker would not accept', () => {
    for (const pollYieldMs of [100, 110_001, 1.5]) {
      expect(() => new BrokerSubprocessRuntime(new Context(), { pollYieldMs }, new FakeBridge(() => ({}))))
        .toThrow('pollYieldMs must be 0 or an integer from 250 through 110000')
    }
  })

  it('preserves quota exhaustion during a poll without attempting an ordinary kill', async () => {
    const quota = new BrokerInvokeError('run_quota_exceeded', 403)
    const bridge = new FakeBridge(({ tool }) => {
      if (tool === 'exec_command') return { session_id: 'process' }
      bridge.terminalError = quota
      throw quota
    })
    const handle = runtime(bridge).spawn(spawnSpec())

    await expect(handle.done).rejects.toBe(quota)
    expect(bridge.calls.map(call => call.args.action).filter(Boolean)).toEqual(['poll'])
  })

  it('preserves the shared quota cause when another provider aborts the command', async () => {
    const quota = new BrokerInvokeError('run_quota_exceeded', 403)
    const pollStarted = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const bridge = new FakeBridge(({ tool, signal }) => {
      if (tool === 'exec_command') return { session_id: 'process' }
      pollStarted.resolve(undefined)
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('poll aborted')) }, { once: true })
      })
    })
    const handle = runtime(bridge).spawn(spawnSpec({ signal: controller.signal }))
    await pollStarted.promise
    bridge.terminalError = quota
    controller.abort()

    await expect(handle.done).rejects.toBe(quota)
    expect(bridge.calls.map(call => call.args.action).filter(Boolean)).toEqual(['poll'])
  })

  it('spawns with exact argv and no shell command', async () => {
    const bridge = new FakeBridge(({ tool, args }) => {
      if (tool === 'exec_command') return { stdout: 'one', session_id: 'process' }
      expect(args.action).toBe('poll')
      return { stdout: 'two', exit_code: 0 }
    })
    const handle = runtime(bridge).spawn(spawnSpec())

    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })

    expect(bridge.calls[0]?.args).toEqual({
      argv: ['printf', 'a b', '$HOME'],
      workdir: '/workspace',
      tty: false,
      yield_time_ms: 250,
      max_output_tokens: 100_000,
    })
    expect(bridge.calls[0]?.args).not.toHaveProperty('cmd')
    expect(handle.collected.stdout?.readFrom(0)).toEqual({ text: 'onetwo', nextOffset: 6, lossy: false })
  })

  it('kills the broker session when aborted during a poll', async () => {
    const pollStarted = Promise.withResolvers<undefined>()
    const bridge = new FakeBridge(({ tool, args, signal }) => {
      if (tool === 'exec_command') return { session_id: 'process' }
      if (args.action === 'kill') return { signal: 'SIGKILL' }
      pollStarted.resolve(undefined)
      return new Promise((_, reject) => {
        const abort = (): void => { reject(new Error('poll aborted')) }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted === true) abort()
      })
    })
    const controller = new AbortController()
    const handle = runtime(bridge).spawn(spawnSpec({ signal: controller.signal }))
    await pollStarted.promise

    controller.abort(new Error('test abort'))

    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    expect(bridge.calls.map(call => call.args.action).filter(Boolean)).toEqual(['poll', 'kill'])
  })

  it('allocates a terminal, writes input, and terminates its session', async () => {
    const bridge = new FakeBridge(({ tool, args }) => {
      if (tool === 'exec_command') return { output: 'ready\n', session_id: 'terminal' }
      if (args.action === 'kill') return { signal: 'SIGKILL' }
      return { session_id: 'terminal' }
    })
    const broker = runtime(bridge, 1000)
    const terminal = await broker.spawnTerminal({
      argv: ['/bin/bash', '--noprofile'],
      cwd: '/workspace',
      rows: 24,
      cols: 80,
      graceMs: 10,
    })

    await terminal.write('echo ok\n')
    await terminal.terminate()

    expect(bridge.calls[0]?.args).toMatchObject({
      argv: ['/bin/bash', '--noprofile'],
      workdir: '/workspace',
      tty: true,
    })
    expect(bridge.calls[0]?.args).not.toHaveProperty('cmd')
    expect(bridge.calls.map(call => call.args.action).filter(Boolean)).toEqual(['write', 'kill'])
  })

  it('rejects relative executable paths before calling the broker', async () => {
    const bridge = new FakeBridge(() => { throw new Error('unexpected broker call') })
    const broker = runtime(bridge)

    await expect(broker.resolveExecutable('./tool')).rejects.toThrow('is a relative path')
    expect(bridge.calls).toEqual([])
  })
})
