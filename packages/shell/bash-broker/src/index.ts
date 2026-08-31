/** Broker-backed provider for the DeepSeek Harness shell capability seam. */

import { posix as path } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrokerBridge } from '@deepseek-ai/dsh-runtime-broker'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'

export interface Config {
  socketPath: string
  secret: string
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
}

type ResolvedConfig = Required<Config>

export const Config: z<Config> = z.object({
  socketPath: z.string(),
  secret: z.string(),
  timeoutMs: z.number().default(120_000),
  maxTimeoutMs: z.number().default(600_000),
  maxOutputBytes: z.number().default(1_048_576),
})

interface ExecResult {
  output?: string
  stdout?: string
  stderr?: string
  exit_code?: number | null
  signal?: string | null
  session_id?: string
  timed_out?: boolean
  truncated?: boolean
}

function resultObject(value: unknown): ExecResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('bash-broker: invalid execution response')
  }
  return value as ExecResult
}

function confinedWorkdir(value: string | undefined): string {
  if (value === undefined || value.length === 0) return '/workspace'
  if (!value.startsWith('/')) {
    const resolved = path.resolve('/workspace', value)
    return resolved === '/workspace' || resolved.startsWith('/workspace/')
      ? resolved
      : '/workspace'
  }
  const normalized = path.normalize(value)
  return normalized === '/workspace' || normalized.startsWith('/workspace/')
    ? normalized
    : '/workspace'
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function output(value: string | undefined, truncated = false): CollectedOutput {
  return { text: value ?? '', truncated }
}

export class BrokerBashExecutor extends ShellExecutor {
  static Config = Config
  readonly config: ResolvedConfig
  private readonly bridge: BrokerBridge

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    if (this.config.timeoutMs <= 0 || this.config.maxTimeoutMs <= 0 || this.config.maxOutputBytes <= 0) {
      throw new Error('bash-broker: execution limits must be positive')
    }
    this.bridge = new BrokerBridge(config)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    const requestedTimeout = request.timeoutMs ?? this.config.timeoutMs
    return {
      command: request.command,
      workdir: confinedWorkdir(request.workdir),
      timeoutMs: Math.min(requestedTimeout, this.config.maxTimeoutMs),
      stdoutMaxBytes: Math.min(request.stdoutMaxBytes ?? this.config.maxOutputBytes, this.config.maxOutputBytes),
      ...request.signal === undefined ? {} : { signal: request.signal },
      ...request.stdin === undefined ? {} : { stdin: request.stdin },
      sandboxPolicy: undefined,
    }
  }

  private async input(
    sessionId: string,
    action: string,
    signal?: AbortSignal,
    chars = '',
  ): Promise<ExecResult> {
    return resultObject(await this.bridge.invoke('write_stdin', {
      session_id: sessionId,
      chars,
      yield_time_ms: 250,
      max_output_tokens: 100_000,
      terminate: action === 'kill',
      action,
    }, signal))
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const started = Date.now()
    let current = resultObject(await this.bridge.invoke('exec_command', {
      cmd: spec.command,
      workdir: spec.workdir,
      yield_time_ms: 250,
      max_output_tokens: Math.max(1, Math.floor(spec.stdoutMaxBytes / 4)),
      tty: false,
      ...spec.stdin === undefined ? {} : { stdin: spec.stdin },
      timeout_ms: spec.timeoutMs,
    }, spec.signal))
    let stdoutText = current.stdout ?? current.output ?? ''
    let stderrText = current.stderr ?? ''
    let timedOut = current.timed_out === true
    const sessionId = current.session_id
    if (sessionId !== undefined) {
      while (current.session_id !== undefined) {
        if (spec.signal?.aborted === true) {
          current = await this.input(sessionId, 'kill')
          break
        }
        if (Date.now() - started >= spec.timeoutMs) {
          timedOut = true
          current = await this.input(sessionId, 'kill')
          break
        }
        await sleep(100)
        current = await this.input(sessionId, 'poll', spec.signal)
        stdoutText += current.stdout ?? current.output ?? ''
        stderrText += current.stderr ?? ''
      }
    }
    return {
      exitCode: current.exit_code ?? null,
      signal: (current.signal ?? null) as NodeJS.Signals | null,
      timedOut,
      aborted: spec.signal?.aborted === true && !timedOut,
      timeoutMs: spec.timeoutMs,
      stdout: output(stdoutText, current.truncated === true),
      stderr: output(stderrText, current.truncated === true),
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    let buffer = ''
    let lossy = false
    let sessionId: string | undefined
    let finish: () => void = () => {}
    const done = new Promise<void>((resolve) => { finish = resolve })
    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done,
      readOutput: (): ShellProcessRead => {
        const delta = buffer
        buffer = ''
        return { delta, lossy }
      },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        if (sessionId !== undefined) void this.input(sessionId, 'kill').finally(finish)
        return true
      },
    }

    const append = (result: ExecResult): void => {
      const stdout = result.stdout ?? result.output ?? ''
      const stderr = result.stderr ?? ''
      buffer += stdout
      if (stderr.length > 0) buffer += (stdout.endsWith('\n') || stdout.length === 0 ? '' : '\n') + '[stderr]\n' + stderr
      lossy = lossy || result.truncated === true
    }

    void (async () => {
      try {
        let current = resultObject(await this.bridge.invoke('exec_command', {
          cmd: spec.command,
          workdir: spec.workdir,
          yield_time_ms: 250,
          max_output_tokens: Math.max(1, Math.floor(this.config.maxOutputBytes / 4)),
          tty: true,
          ...spec.stdin === undefined ? {} : { stdin: spec.stdin },
        }, spec.signal))
        append(current)
        sessionId = current.session_id
        if (proc.status === 'killed' && sessionId !== undefined) {
          current = await this.input(sessionId, 'kill')
          append(current)
        }
        while (proc.status === 'running' && current.session_id !== undefined) {
          await sleep(250)
          current = await this.input(current.session_id, 'poll', spec.signal)
          append(current)
        }
        if (proc.status === 'running') proc.status = current.signal === undefined || current.signal === null ? 'completed' : 'killed'
        proc.exitCode = current.exit_code ?? null
        proc.signal = (current.signal ?? null) as NodeJS.Signals | null
      } catch (error) {
        proc.status = 'killed'
        buffer += 'broker execution failed: ' + String(error)
      } finally {
        finish()
      }
    })()
    spec.signal?.addEventListener('abort', () => proc.kill(), { once: true })
    return proc
  }
}

export default BrokerBashExecutor
