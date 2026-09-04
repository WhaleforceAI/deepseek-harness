/**
 * Broker-backed provider for the subprocess capability seam. Exact argv and
 * terminal sessions cross the run-local bridge; polling projects broker output
 * onto the Harness process and terminal handles.
 * @module @deepseek-ai/dsh-subprocess-broker
 */

import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrokerBridge } from '@deepseek-ai/dsh-runtime-broker'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

const COMMAND_YIELD_MS = 250
const MAX_OUTPUT_TOKENS = 100_000
const MAX_ARGV_ITEMS = 1_024
const MAX_COMMAND_CHARACTERS = 32_768
const MAX_STDIN_CHARACTERS = 65_536
const MAX_WORKDIR_CHARACTERS = 1_024

/** Configuration for the Agent Runtime broker subprocess provider. */
export interface Config {
  /** Absolute Unix-socket path for the run-local broker. */
  socketPath: string
  /** Run-local broker authentication secret. */
  secret: string
  /** Base path used to resolve a relative PATH result. */
  cwd?: string
  /** Delay between remote command polls in milliseconds. */
  pollMs?: number
}

interface ResolvedConfig extends Config {
  cwd: string
  pollMs: number
}

/** Loader schema for {@link BrokerSubprocessRuntime}. */
export const Config: z<Config> = z.object({
  socketPath: z.string(),
  secret: z.string(),
  cwd: z.string().default('/workspace'),
  pollMs: z.number().default(100),
})

type BrokerInvoker = Pick<BrokerBridge, 'invoke'>
type BrokerSessionId = string | number

interface BrokerResult {
  output?: string
  stdout?: string
  stderr?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  sessionId?: BrokerSessionId
  truncated: boolean
}

function resultObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('subprocess-broker: invalid command response')
  }
  // The guard above proves an object; TS still needs the index signature.
  return value as Record<string, unknown>
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`subprocess-broker: invalid command response ${field}`)
  return value
}

function commandResult(value: unknown): BrokerResult {
  const result = resultObject(value)
  const output = optionalString(result.output, 'output')
  const stdout = optionalString(result.stdout, 'stdout')
  const stderr = optionalString(result.stderr, 'stderr')
  const exitCode = result.exit_code
  if (exitCode !== undefined && exitCode !== null
    && (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0 || (exitCode as number) > 255)) {
    throw new Error('subprocess-broker: invalid command response exit_code')
  }
  const rawSignal = result.signal
  if (rawSignal !== undefined && rawSignal !== null
    && (typeof rawSignal !== 'string' || !/^SIG[A-Z0-9]+$/.test(rawSignal))) {
    throw new Error('subprocess-broker: invalid command response signal')
  }
  const sessionId = result.session_id
  if (sessionId !== undefined
    && !((typeof sessionId === 'string' && sessionId.length > 0)
      || (Number.isSafeInteger(sessionId) && (sessionId as number) >= 0))) {
    throw new Error('subprocess-broker: invalid command response session_id')
  }
  if (result.truncated !== undefined && typeof result.truncated !== 'boolean') {
    throw new Error('subprocess-broker: invalid command response truncated')
  }
  return {
    ...(output === undefined ? {} : { output }),
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
    ...(exitCode === undefined ? {} : { exitCode: exitCode as number | null }),
    ...(rawSignal === undefined ? {} : { signal: rawSignal as NodeJS.Signals | null }),
    ...(sessionId === undefined ? {} : { sessionId: sessionId as BrokerSessionId }),
    truncated: result.truncated === true,
  }
}

function assertGrace(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * Count Unicode code points without materializing an array.
 *
 * The broker bounds its string arguments by code points (Python's `len`), so a
 * UTF-16 `.length` would over-count every astral character.
 */
function characters(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) index += 1
    count += 1
  }
  return count
}

function assertStartRequest(spec: SubprocessSpawnSpec): void {
  if (spec.argv.length > MAX_ARGV_ITEMS
    || spec.argv.some((argument, index) => characters(argument) > MAX_COMMAND_CHARACTERS
      || (index === 0 && argument.length === 0))) {
    throw new Error('subprocess-broker: argv exceeds the broker command.start limits')
  }
  if (characters(spec.cwd) < 1 || characters(spec.cwd) > MAX_WORKDIR_CHARACTERS) {
    throw new Error('subprocess-broker: cwd exceeds the broker command.start limits')
  }
  if (typeof spec.stdio.stdin === 'object'
    && characters(spec.stdio.stdin.data) > MAX_STDIN_CHARACTERS) {
    throw new Error('subprocess-broker: stdin exceeds the broker command.start limit')
  }
}

function waitTick(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', String.raw`'"'"'`)}'`
}

function outcome(result: BrokerResult, terminated: boolean): SubprocessOutcome {
  if (result.signal !== undefined && result.signal !== null) return { exitCode: null, signal: result.signal }
  if (terminated) return { exitCode: null, signal: 'SIGKILL' }
  return { exitCode: result.exitCode ?? null, signal: null }
}

function appendResult(first: BrokerResult, last: BrokerResult): BrokerResult {
  const join = (left: string | undefined, right: string | undefined): string | undefined =>
    left === undefined && right === undefined ? undefined : (left ?? '') + (right ?? '')
  const output = join(first.output, last.output)
  const stdout = join(first.stdout, last.stdout)
  const stderr = join(first.stderr, last.stderr)
  return {
    ...(output === undefined ? {} : { output }),
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
    ...(last.exitCode === undefined ? {} : { exitCode: last.exitCode }),
    ...(last.signal === undefined ? {} : { signal: last.signal }),
    ...(last.sessionId === undefined ? {} : { sessionId: last.sessionId }),
    truncated: first.truncated || last.truncated,
  }
}

function collectMode(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

class BrokerOutputReader implements SubprocessOutputReader {
  private chunks: Buffer[] = []
  private retainedBytes = 0
  private totalBytes = 0
  private transportLoss = false

  constructor(private readonly maxBytes: number) {}

  push(text: string, truncated: boolean): void {
    this.transportLoss ||= truncated
    if (text.length === 0) return
    const chunk = Buffer.from(text, 'utf8')
    this.totalBytes += chunk.length
    this.chunks.push(chunk)
    this.retainedBytes += chunk.length
    while (this.retainedBytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.retainedBytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retainedBytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retainedBytes -= excess
      }
    }
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    const retained = Buffer.concat(this.chunks, this.retainedBytes)
    const firstRetained = this.totalBytes - this.retainedBytes
    const lossy = this.transportLoss || fromByte < firstRetained
    const start = fromByte < firstRetained
      ? 0
      : Math.min(retained.length, Math.max(0, fromByte - firstRetained))
    return { text: retained.subarray(start).toString('utf8'), nextOffset: this.totalBytes, lossy }
  }
}

class BrokerStdin extends Writable {
  constructor(private readonly send: (action: 'write' | 'close', chars?: string) => Promise<void>) {
    super({ decodeStrings: false })
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void this.send('write', typeof chunk === 'string' ? chunk : chunk.toString('utf8')).then(
      () => { callback() },
      (error: unknown) => { callback(error instanceof Error ? error : new Error(String(error))) },
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.send('close').then(
      () => { callback() },
      (error: unknown) => { callback(error instanceof Error ? error : new Error(String(error))) },
    )
  }
}

class BrokerSubprocessHandle implements SubprocessHandle {
  readonly pid = -1
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  readonly ready: Promise<void>

  private readonly readyState = Promise.withResolvers<void>()
  private readonly sessionState = Promise.withResolvers<BrokerSessionId | undefined>()
  private readonly termination = new AbortController()
  private readonly stdoutReader: BrokerOutputReader | undefined
  private readonly stderrReader: BrokerOutputReader | undefined
  private controlTail: Promise<unknown> = Promise.resolve()
  private sessionId: BrokerSessionId | undefined
  private settled = false

  constructor(
    private readonly bridge: BrokerInvoker,
    private readonly spec: SubprocessSpawnSpec,
    private readonly pollMs: number,
    private readonly tty: boolean,
  ) {
    this.stdout = spec.stdio.stdout === 'pipe' || tty ? new PassThrough() : undefined
    this.stderr = spec.stdio.stderr === 'pipe' && !tty ? new PassThrough() : undefined
    this.stdoutReader = collectMode(spec.stdio.stdout) ? new BrokerOutputReader(spec.stdio.stdout.maxBytes) : undefined
    this.stderrReader = collectMode(spec.stdio.stderr) ? new BrokerOutputReader(spec.stdio.stderr.maxBytes) : undefined
    this.collected = {
      ...(this.stdoutReader === undefined ? {} : { stdout: this.stdoutReader }),
      ...(this.stderrReader === undefined ? {} : { stderr: this.stderrReader }),
    }
    this.stdin = spec.stdio.stdin === 'pipe'
      ? new BrokerStdin((action, chars) => this.sendInput(action, chars))
      : undefined
    this.ready = this.readyState.promise
    this.done = this.run()
    void this.ready.catch(() => {})
    void this.done.catch(() => {})
    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  /** @inheritdoc */
  terminate(): void {
    if (!this.settled) this.termination.abort(new Error('subprocess-broker: command terminated'))
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.settled) {
      await this.done
      return true
    }
    if (signal?.aborted === true) return false
    if (signal === undefined) {
      await this.done
      return true
    }
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => { cleanup(); resolve(false) }
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
      signal.addEventListener('abort', onAbort, { once: true })
      void this.done.then(
        () => { cleanup(); resolve(true) },
        (error: unknown) => {
          cleanup()
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }

  async sendInput(action: 'write' | 'close', chars?: string): Promise<void> {
    const sessionId = this.sessionId ?? await this.sessionState.promise
    if (sessionId === undefined || this.settled) throw new Error('subprocess-broker: process input is closed')
    const result = await this.input(sessionId, action, chars)
    this.append(result)
  }

  private readonly onAbort = (): void => { this.terminate() }

  private async run(): Promise<SubprocessOutcome> {
    let published = false
    try {
      const stdin = typeof this.spec.stdio.stdin === 'object' ? this.spec.stdio.stdin.data : undefined
      let current = commandResult(await this.bridge.invoke('exec_command', {
        argv: [...this.spec.argv],
        workdir: this.spec.cwd,
        tty: this.tty,
        yield_time_ms: COMMAND_YIELD_MS,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        ...(stdin === undefined ? {} : { stdin }),
      }))
      this.append(current)
      this.sessionId = current.sessionId
      this.sessionState.resolve(this.sessionId)
      published = true
      this.readyState.resolve()
      while (current.sessionId !== undefined) {
        if (this.termination.signal.aborted) {
          current = await this.input(this.sessionId as BrokerSessionId, 'kill')
          this.append(current)
          break
        }
        await waitTick(this.pollMs, this.termination.signal)
        // The checker narrows from the guard above and cannot see that the
        // awaited tick may abort in between; dropping this would poll once
        // more after an abort.
        // oxlint-disable-next-line typescript/no-unnecessary-condition
        if (this.termination.signal.aborted) continue
        current = await this.input(this.sessionId as BrokerSessionId, 'poll', undefined, this.termination.signal)
        this.append(current)
      }
      return outcome(current, this.termination.signal.aborted)
    } catch (error: unknown) {
      if (!published) {
        this.sessionState.resolve(undefined)
        this.readyState.reject(error)
      } else if (this.sessionId !== undefined) {
        try {
          const killed = await this.input(this.sessionId, 'kill')
          this.append(killed)
          if (this.termination.signal.aborted) return outcome(killed, true)
        } catch (cleanupError: unknown) {
          throw new AggregateError([error, cleanupError], 'subprocess-broker: command failed and broker kill failed')
        }
      }
      throw error
    } finally {
      this.settled = true
      this.spec.signal?.removeEventListener('abort', this.onAbort)
      this.stdout?.end()
      this.stderr?.end()
    }
  }

  private input(
    sessionId: BrokerSessionId,
    action: 'poll' | 'kill' | 'write' | 'close',
    chars?: string,
    signal?: AbortSignal,
  ): Promise<BrokerResult> {
    const invoke = async (): Promise<BrokerResult> => commandResult(await this.bridge.invoke('write_stdin', {
      session_id: sessionId,
      action,
      ...(chars === undefined ? {} : { chars }),
    }, signal))
    const result = this.controlTail.then(invoke, invoke)
    this.controlTail = result.then(() => undefined, () => undefined)
    return result
  }

  private append(result: BrokerResult): void {
    const stdout = result.stdout ?? result.output ?? ''
    const stderr = result.stderr ?? ''
    if (this.tty) {
      const combined = stdout + stderr
      if (combined.length > 0) this.stdout?.write(combined)
      return
    }
    this.stdoutReader?.push(stdout, result.truncated)
    this.stderrReader?.push(stderr, result.truncated)
    if (stdout.length > 0) {
      if (this.stdout !== undefined) this.stdout.write(stdout)
      else if (this.spec.stdio.stdout === 'inherit') process.stdout.write(stdout)
    }
    if (stderr.length > 0) {
      if (this.stderr !== undefined) this.stderr.write(stderr)
      else if (this.spec.stdio.stderr === 'inherit') process.stderr.write(stderr)
    }
  }
}

class BrokerTerminalHandle implements SubprocessTerminalHandle {
  readonly pid = -1
  readonly output: PassThrough
  readonly done: Promise<SubprocessOutcome>

  constructor(private readonly handle: BrokerSubprocessHandle) {
    this.output = handle.stdout as PassThrough
    this.done = handle.done
  }

  /** @inheritdoc */
  write(data: string): Promise<void> {
    return this.handle.sendInput('write', data)
  }

  /** @inheritdoc */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return Promise.resolve(undefined)
  }

  /** @inheritdoc */
  signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    return Promise.reject(new Error(`subprocess-broker: foreground ${signal} is unsupported by the broker`))
  }

  /** @inheritdoc */
  async terminate(): Promise<void> {
    this.handle.terminate()
    await this.handle.waitForExit()
  }
}

/** Agent Runtime broker command manager registered as `ctx.subprocess`. */
export class BrokerSubprocessRuntime extends SubprocessRuntime {
  static Config = Config

  private readonly config: ResolvedConfig
  private readonly live = new Set<BrokerSubprocessHandle>()
  private disposing = false

  /** Create the broker subprocess service and bind its disposal policy. */
  constructor(ctx: Context, config: Config, private readonly bridge: BrokerInvoker = new BrokerBridge(config)) {
    super(ctx)
    // Rebuilt field by field rather than spread: the loader hands us a
    // schemastery instance, and spreading one drops its prototype.
    this.config = {
      socketPath: config.socketPath,
      secret: config.secret,
      cwd: config.cwd ?? '/workspace',
      pollMs: config.pollMs ?? 100,
    }
    if (!posix.isAbsolute(this.config.cwd)) throw new Error('subprocess-broker: cwd must be absolute')
    if (!Number.isSafeInteger(this.config.pollMs)
      || this.config.pollMs <= 0
      || this.config.pollMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`subprocess-broker: pollMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    ctx.effect(() => async () => {
      this.disposing = true
      const handles = [...this.live]
      for (const handle of handles) handle.terminate()
      const outcomes = await Promise.allSettled(handles.map(handle => handle.waitForExit()))
      const failures = outcomes.flatMap<unknown>(
        entry => entry.status === 'rejected' ? [entry.reason as unknown] : [],
      )
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'subprocess-broker: teardown failed')
    }, 'broker subprocess teardown')
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-broker: executable name must be non-empty')
    signal?.throwIfAborted()
    if (!posix.isAbsolute(command) && command.includes('/')) {
      throw new Error(
        `subprocess-broker: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const args = posix.isAbsolute(command)
      ? { argv: ['test', '-f', command, '-a', '-x', command] }
      : {
        cmd: (env?.PATH === undefined ? '' : `PATH=${shellQuote(env.PATH)} `)
          + `command -v -- ${shellQuote(command)}`,
      }
    const result = await this.controlCommand(args, signal)
    if (result.exitCode !== 0) {
      throw new Error(posix.isAbsolute(command)
        ? `subprocess-broker: command ${JSON.stringify(command)} is not an executable file`
        : `subprocess-broker: command ${JSON.stringify(command)} was not found on PATH`)
    }
    if (posix.isAbsolute(command)) return command
    const executable = (result.stdout ?? result.output ?? '').trim()
    if (executable.includes('\n') || (!posix.isAbsolute(executable) && !executable.includes('/'))) {
      throw new Error(`subprocess-broker: executable ${JSON.stringify(command)} did not resolve to one path`)
    }
    return posix.resolve(this.config.cwd, executable)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.start(spec, false)
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const processSpec: SubprocessSpawnSpec = {
      argv: spec.argv,
      cwd: spec.cwd,
      env: spec.env,
      graceMs: spec.graceMs,
      signal: spec.signal,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    }
    const handle = this.start(processSpec, true)
    try {
      await handle.ready
      return new BrokerTerminalHandle(handle)
    } catch (error: unknown) {
      handle.terminate()
      await handle.done.catch(() => undefined)
      throw error
    }
  }

  private start(spec: SubprocessSpawnSpec, tty: boolean): BrokerSubprocessHandle {
    if (this.disposing) throw new Error('subprocess-broker: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error(tty
        ? 'subprocess-broker: terminal argv must contain a program'
        : 'invalid argv: expected a non-empty program name at argv[0]')
    }
    assertGrace(spec.graceMs)
    assertStartRequest(spec)
    if (spec.signal?.aborted === true) throw new Error(`aborted before spawn: ${String(spec.signal.reason)}`)
    const handle = new BrokerSubprocessHandle(this.bridge, spec, this.config.pollMs, tty)
    this.live.add(handle)
    const release = (): void => { this.live.delete(handle) }
    void handle.done.then(release, () => {
      // Retain a failed handle so service disposal reports the unresolved remote lifecycle.
    })
    return handle
  }

  private async controlCommand(
    command: { argv: string[] } | { cmd: string },
    signal?: AbortSignal,
  ): Promise<BrokerResult> {
    let result = commandResult(await this.bridge.invoke('exec_command', {
      ...command,
      workdir: this.config.cwd,
      tty: false,
      timeout_ms: 30_000,
      yield_time_ms: 30_000,
      max_output_tokens: 4_096,
    }, signal))
    if (result.sessionId !== undefined) {
      const completed = commandResult(await this.bridge.invoke('write_stdin', {
        session_id: result.sessionId,
        action: 'wait',
      }, signal))
      result = appendResult(result, completed)
    }
    signal?.throwIfAborted()
    return result
  }
}

export default BrokerSubprocessRuntime
