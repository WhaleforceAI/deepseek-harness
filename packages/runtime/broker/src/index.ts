/** Run-local broker bridge and native Cordis tool provider. */

import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

const MAX_BRIDGE_RESPONSE_BYTES = 12 * 1024 * 1024

export interface BrokerBridgeConfig {
  /** Absolute Unix socket path for this run’s Runtime bridge. */
  socketPath: string
  /** Run-scoped bridge authentication secret, at least 32 characters. */
  secret: string
}

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

export interface Config extends BrokerBridgeConfig {
  /** Native broker tools to register; an empty list registers none. */
  tools?: NativeBrokerTool[]
}

export const Config: z<Config> = z.object({
  socketPath: z.string(),
  secret: z.string(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.any(),
    outputLimitBytes: z.number(),
  })).default([]),
})

type BridgeResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; status: number } }

export class BrokerBridge {
  constructor(readonly config: BrokerBridgeConfig) {
    if (!config.socketPath.startsWith('/') || config.secret.length < 32) {
      throw new Error('runtime-broker: invalid run bridge configuration')
    }
  }

  invoke(tool: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.config.socketPath)
      let settled = false
      let body = ''

      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        socket.destroy()
        if (error !== undefined) reject(error)
        else resolve(result)
      }
      const abort = (): void => { finish(new Error('runtime-broker: invocation aborted')) }
      if (signal?.aborted === true) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })

      socket.setTimeout(125_000, () => { finish(new Error('runtime-broker: invocation timed out')) })
      socket.on('error', () => { finish(new Error('runtime-broker: bridge unavailable')) })
      socket.on('connect', () => {
        socket.write(JSON.stringify({ id, secret: this.config.secret, tool, arguments: args }) + '\n')
      })
      socket.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
        if (Buffer.byteLength(body, 'utf8') > MAX_BRIDGE_RESPONSE_BYTES) {
          finish(new Error('runtime-broker: bridge response too large'))
          return
        }
        const newline = body.indexOf('\n')
        if (newline < 0) return
        try {
          const response = JSON.parse(body.slice(0, newline)) as BridgeResponse
          if (response.id !== id || !response.ok) {
            const code = response.ok ? 'bridge_response_invalid' : response.error.code
            finish(new Error('runtime-broker: ' + code))
            return
          }
          finish(undefined, response.result)
        } catch {
          finish(new Error('runtime-broker: bridge response invalid'))
        }
      })
    })
  }
}

export const name = 'runtime-broker'
export const inject = ['tools']

export function apply(ctx: Context, config: Config): void {
  const bridge = new BrokerBridge(config)
  for (const tool of config.tools ?? []) {
    ctx.tools.register({
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
    })
  }
}
