/** Run-local broker bridge and native Cordis tool provider. */

import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'

const MAX_BRIDGE_RESPONSE_BYTES = 12 * 1024 * 1024

/** Run lease authentication and discovery-reuse policy. */
export interface BrokerBridgeConfig {
  /** Absolute Unix socket path for this run’s Runtime bridge. */
  socketPath: string
  /** Run-scoped bridge authentication secret, at least 32 characters. */
  secret: string
  /** Enable discovery reuse only when this run exclusively owns workspace mutations. */
  cacheDiscovery?: boolean
}

/** Native tool definition forwarded to the shared broker. */
export interface NativeBrokerTool {
  /** Broker tool name registered with the Harness tool registry. */
  name: string
  /** Model-facing description of the broker tool. */
  description: string
  /** JSON Schema for the tool arguments forwarded to the broker. */
  inputSchema: Record<string, unknown>
  /** Declared per-tool output byte limit; this adapter does not enforce it. */
  outputLimitBytes: number
}

/** Shared bridge settings and its native tool registrations. */
export interface Config extends BrokerBridgeConfig {
  /** Native broker tools to register; an empty list registers none. */
  tools?: NativeBrokerTool[]
  /**
   * Minimum `yield_time_ms` for a model `write_stdin` call that only polls a
   * running command; 0 disables the floor. The broker returns as soon as the
   * command exits, so a longer wait only reduces repeated polling requests.
   */
  stdinPollYieldMs?: number
}

export const Config: z<Config> = z.object({
  socketPath: z.string(),
  secret: z.string(),
  cacheDiscovery: z.boolean().default(false),
  // Every broker call shares Agent Runtime's bridge invocation lock, so a poll
  // wait also bounds how long a kill or another call can queue behind it.
  stdinPollYieldMs: z.natural().max(110_000).default(3_000),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.any(),
    outputLimitBytes: z.number(),
  })).default([]),
})

/** A validated broker rejection, including the original HTTP status. */
export class BrokerInvokeError extends Error {
  constructor(readonly code: string, readonly status: number, hint?: string) {
    super('runtime-broker: ' + code + (hint ? ': ' + hint : ''))
    this.name = 'BrokerInvokeError'
  }
}

const MAX_HINT_CHARS = 500

/** Runtime-written guidance from the bridge's optional error message, bounded and single-line. */
function bridgeHint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return text ? text.slice(0, MAX_HINT_CHARS) : undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Transport, mutation generations, and terminal state for one Runtime lease. */
    runtimeBroker: BrokerBridge
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type CommandSessionId = string | number

function commandSessionId(value: unknown): value is CommandSessionId {
  return (typeof value === 'string' && value.length > 0 && value !== '__all__')
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

/** Shared owner for a single Runtime bridge lease; never reuse across runs. */
export class BrokerBridge {
  private revision = 0
  private pendingMutations = 0
  private discoveryRevision = 0
  private commands = 0
  private readonly liveCommands = new Map<CommandSessionId, number>()
  private readonly completedCommands = new Map<CommandSessionId, number>()
  private unknownCommand = false
  private readonly lifetime = new AbortController()
  private terminal: BrokerInvokeError | undefined
  private readonly terminalListeners = new Set<(error: BrokerInvokeError) => void>()
  private readonly listingListeners = new Set<(path: string, result: unknown) => void>()

  constructor(readonly config: BrokerBridgeConfig) {
    if (!config.socketPath.startsWith('/') || config.secret.length < 32) {
      throw new Error('runtime-broker: invalid run bridge configuration')
    }
  }

  /** Current filesystem mutation generation. */
  get generation(): number { return this.revision }
  /** Generation of non-command invalidations; command epochs require separate revalidation. */
  get discoveryGeneration(): number { return this.discoveryRevision }
  /** Number of command and stdin dispatches, including failed requests. */
  get commandEpoch(): number { return this.commands }
  /** Whether discovery checks and storage are permitted with no pending or live commands; reuse requires epoch revalidation. */
  get cacheAllowed(): boolean {
    return this.config.cacheDiscovery === true && !this.terminal && !this.lifetime.signal.aborted
      && !this.pendingMutations && !this.liveCommands.size && !this.unknownCommand
  }
  /** The first quota denial, retained until disposal. */
  get terminalError(): BrokerInvokeError | undefined { return this.terminal }

  /** Advance the observation generation, including listing contradictions. */
  invalidate(): void { this.revision++; this.discoveryRevision++ }

  /** Reject terminal, disposed, or aborted work before using cached data or opening a socket.
   * @param signal - optional caller cancellation.
   */
  assertAvailable(signal?: AbortSignal): void {
    if (this.terminal) throw this.terminal
    this.lifetime.signal.throwIfAborted()
    signal?.throwIfAborted()
  }

  /** Subscribe to the first quota denial.
   * @param listener - synchronous run-cancellation callback.
   * @returns subscription disposer.
   */
  onTerminal(listener: (error: BrokerInvokeError) => void): () => void {
    this.terminalListeners.add(listener)
    return () => { this.terminalListeners.delete(listener) }
  }

  /** Subscribe to successful listings, including native-tool calls.
   * @param listener - synchronous cache observation callback; validates its own listing data.
   * @returns subscription disposer.
   */
  onListing(listener: (path: string, result: unknown) => void): () => void {
    this.listingListeners.add(listener)
    return () => { this.listingListeners.delete(listener) }
  }

  /** Close transport work; Python Runtime owns quota-exempt remote run completion. */
  dispose(): void {
    this.terminalListeners.clear()
    this.listingListeners.clear()
    this.invalidate()
    this.lifetime.abort(new Error('runtime-broker: bridge disposed'))
  }

  /** Invoke an ordinary broker operation while tracking all mutation paths.
   * @param tool - broker operation name.
   * @param args - JSON operation arguments.
   * @param signal - caller cancellation.
   * @returns validated bridge result; operation-specific validation belongs to the provider.
   */
  async invoke(tool: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    this.assertAvailable(signal)
    const command = tool === 'exec_command' || tool === 'write_stdin'
    const mutation = command || tool === 'write_file'
    if (command) this.commands++
    const commandEpoch = this.commands
    if (mutation) {
      this.pendingMutations++
      if (command) this.revision++
      else this.invalidate()
    }
    try {
      const result = await this.exchange(tool, args, signal)
      if (command) this.observeCommand(tool, args, result, commandEpoch)
      if (tool === 'list_files' && record(args) && typeof args.path === 'string') {
        for (const listener of this.listingListeners) {
          try { listener(args.path, result) }
          catch { console.warn('runtime-broker: listing listener failed') }
        }
      }
      return result
    } catch (error) {
      if (command) this.observeCommand(tool, args, undefined, commandEpoch)
      throw this.terminal ?? error
    } finally {
      if (mutation) {
        this.pendingMutations--
        if (command) this.revision++
        else this.invalidate()
      }
    }
  }

  private observeCommand(tool: string, args: unknown, result: unknown, epoch: number): void {
    const addressed = tool === 'write_stdin' && record(args) && commandSessionId(args.session_id)
      ? args.session_id : undefined
    const retain = (session: CommandSessionId): void => {
      // A completion also fences older responses still in flight for this session.
      if ((this.completedCommands.get(session) ?? -1) < epoch) {
        this.liveCommands.set(session, Math.max(this.liveCommands.get(session) ?? -1, epoch))
      }
    }
    if (record(result) && commandSessionId(result.session_id)) {
      retain(result.session_id)
      if (tool === 'write_stdin' && addressed !== result.session_id) {
        if (addressed !== undefined) retain(addressed)
        this.unknownCommand = true
      }
      return
    }
    const complete = record(result) && !Object.hasOwn(result, 'session_id')
      && ((typeof result.exit_code === 'number' && Number.isInteger(result.exit_code)
        && result.exit_code >= 0 && result.exit_code <= 255)
        || (typeof result.signal === 'string' && /^SIG[A-Z0-9]+$/.test(result.signal)))
    if (complete && (tool === 'exec_command' || addressed !== undefined)) {
      if (addressed !== undefined) {
        if ((this.liveCommands.get(addressed) ?? -1) <= epoch) this.liveCommands.delete(addressed)
        this.completedCommands.set(addressed, Math.max(this.completedCommands.get(addressed) ?? -1, epoch))
      }
      return
    }
    if (addressed !== undefined) retain(addressed)
    else this.unknownCommand = true
  }

  private exchange(tool: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = randomUUID()
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.config.socketPath)
      let settled = false
      let body = ''
      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return
        settled = true
        combined.removeEventListener('abort', abort)
        socket.destroy()
        if (error !== undefined) reject(this.terminal ?? error)
        else resolve(result)
      }
      const abort = (): void => { finish(new Error('runtime-broker: invocation aborted', { cause: combined.reason })) }
      combined.addEventListener('abort', abort, { once: true })
      socket.setEncoding('utf8')
      socket.setTimeout(125_000, () => { finish(new Error('runtime-broker: invocation timed out')) })
      socket.on('error', () => { finish(new Error('runtime-broker: bridge unavailable')) })
      socket.on('end', () => { finish(new Error('runtime-broker: bridge response incomplete')) })
      socket.on('connect', () => {
        if (settled) return
        socket.write(JSON.stringify({ id, secret: this.config.secret, tool, arguments: args }) + '\n')
      })
      socket.on('data', (chunk: string) => {
        body += chunk
        if (Buffer.byteLength(body, 'utf8') > MAX_BRIDGE_RESPONSE_BYTES) {
          finish(new Error('runtime-broker: bridge response too large'))
          return
        }
        const newline = body.indexOf('\n')
        if (newline < 0) return
        let response: unknown
        try { response = JSON.parse(body.slice(0, newline)) }
        catch { finish(new Error('runtime-broker: bridge response invalid')); return }
        if (!record(response) || response.id !== id || typeof response.ok !== 'boolean') {
          finish(new Error('runtime-broker: bridge response invalid')); return
        }
        if (response.ok) {
          if (!Object.hasOwn(response, 'result')) {
            finish(new Error('runtime-broker: bridge response invalid')); return
          }
          finish(undefined, response.result); return
        }
        const failure = response.error
        if (!record(failure) || typeof failure.code !== 'string' || !failure.code
          || typeof failure.status !== 'number' || !Number.isInteger(failure.status)
          || failure.status < 100 || failure.status > 599) {
          finish(new Error('runtime-broker: bridge response invalid')); return
        }
        const error = new BrokerInvokeError(failure.code, failure.status, bridgeHint(failure.message))
        if (error.code === 'run_quota_exceeded' && !this.terminal) {
          this.terminal = error
          this.invalidate()
          // Settle this request before cancellation synchronously aborts sibling tool signals.
          finish(error)
          this.lifetime.abort(error)
          for (const listener of this.terminalListeners) {
            try { listener(error) }
            catch { console.warn('runtime-broker: terminal listener failed') }
          }
          return
        }
        finish(error)
      })
    })
  }
}

/**
 * Raise the wait of a pure `write_stdin` poll (no input, no termination) to the configured floor.
 * @param args - model tool arguments.
 * @param floor - minimum `yield_time_ms`; 0 leaves the arguments unchanged.
 * @returns arguments to forward to the broker.
 */
export function stdinPollArguments(args: unknown, floor: number): unknown {
  if (floor === 0 || !record(args) || !commandSessionId(args.session_id)) return args
  if ((args.chars !== undefined && args.chars !== '') || args.terminate === true) return args
  if (args.action !== undefined && args.action !== 'poll') return args
  if (typeof args.yield_time_ms === 'number' && args.yield_time_ms >= floor) return args
  return { ...args, yield_time_ms: floor }
}

export const name = 'runtime-broker'
export const inject = ['tools', 'agents']

export function apply(ctx: Context, config: Config): void {
  const bridge = new BrokerBridge(config)
  ctx.provide('runtimeBroker', bridge)
  ctx.effect(() => () => { bridge.dispose() })
  ctx.effect(() => bridge.onTerminal((error) => {
    const cause = { kind: 'hook' as const, reason: error.message }
    for (const agent of ctx.agents.list()) agent.cancel(cause)
    ctx.agents.currentInitiator()?.cancel(cause)
  }))
  ctx.on('agent/pre-step', (_event, next) => {
    bridge.assertAvailable()
    return next()
  })
  ctx.on('agent/request', (_event, next) => {
    bridge.assertAvailable()
    return next()
  })
  for (const tool of config.tools ?? []) {
    const properties = record(tool.inputSchema) && record(tool.inputSchema.properties) ? tool.inputSchema.properties : {}
    const pollFloor = tool.name === 'write_stdin' && Object.hasOwn(properties, 'yield_time_ms')
      ? config.stdinPollYieldMs ?? 0 : 0
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: {
        schema: { type: 'object' },
        // JSON.stringify returns undefined for a top-level `undefined`; the
        // bridge only ever yields JSON-parsed values, so that is the one case.
        render: (_args: unknown, value: unknown) => [{
          type: 'text',
          text: value === undefined ? 'null' : JSON.stringify(value),
        }],
      },
      timeoutMs: 120_000,
      execute: (args: unknown, exec: { signal: AbortSignal }) =>
        bridge.invoke(tool.name, stdinPollArguments(args, pollFloor), exec.signal),
    }))
  }
}
