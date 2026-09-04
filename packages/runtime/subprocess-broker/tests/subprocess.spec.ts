import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import BrokerSubprocessRuntime from '../src/index.ts'
import { describe, expect, it } from 'vitest'

interface Invocation {
  tool: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

class FakeBridge {
  readonly calls: Invocation[] = []

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
    { socketPath: '/run/broker.sock', secret: 'x'.repeat(32), pollMs },
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
