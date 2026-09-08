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
}

export const Config: z<Config> = z.object({
  socketPath: z.string(),
  secret: z.string(),
  cacheDiscovery: z.boolean().default(false),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.any(),
    outputLimitBytes: z.number(),
  })).default([]),
})

/** A validated broker rejection, including the original HTTP status. */
export class BrokerInvokeError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super('runtime-broker: ' + code)
    this.name = 'BrokerInvokeError'
  }
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

/** Shared owner for a single Runtime bridge lease; never reuse across runs. */
export class BrokerBridge {
  private revision = 0
  private pendingMutations = 0
  // ponytail: command exit does not prove descendant exit; resume reuse only with broker whole-tree quiescence proof.
  private commandDispatched = false
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
  /** Whether discovery observations can be reused or stored. */
  get cacheAllowed(): boolean {
    return this.config.cacheDiscovery === true && !this.terminal && !this.lifetime.signal.aborted && !this.pendingMutations
      && !this.commandDispatched
  }
  /** The first quota denial, retained until disposal. */
  get terminalError(): BrokerInvokeError | undefined { return this.terminal }

  /** Advance the observation generation, including listing contradictions. */
  invalidate(): void { this.revision++ }

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
    if (command) this.commandDispatched = true
    if (mutation) { this.pendingMutations++; this.invalidate() }
    try {
      const result = await this.exchange(tool, args, signal)
      if (tool === 'list_files' && record(args) && typeof args.path === 'string') {
        for (const listener of this.listingListeners) {
          try { listener(args.path, result) }
          catch { console.warn('runtime-broker: listing listener failed') }
        }
      }
      return result
    } catch (error) {
      throw this.terminal ?? error
    } finally {
      if (mutation) { this.pendingMutations--; this.invalidate() }
    }
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
        const error = new BrokerInvokeError(failure.code, failure.status)
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
      execute: (args: unknown, exec: { signal: AbortSignal }) => bridge.invoke(tool.name, args, exec.signal),
    }))
  }
}
