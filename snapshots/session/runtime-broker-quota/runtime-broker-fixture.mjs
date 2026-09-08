/** Deterministic run-local Unix-socket broker for the Runtime composition snapshot. */
import { unlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

export const name = 'runtime-broker-snapshot-fixture'

export async function apply(ctx) {
  const mode = process.env.DSH_RUNTIME_BROKER_FIXTURE_MODE ?? 'write-quota'
  const socketPath = join(process.cwd(), '.runtime-broker.sock')
  const statKeys = new Set()
  const calls = []
  const sockets = new Set()
  await rm(socketPath, { force: true })

  await ctx.effect(async () => {
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let body = ''
      socket.on('data', (chunk) => {
        body += chunk.toString('utf8')
        const newline = body.indexOf('\n')
        if (newline < 0) return
        const request = JSON.parse(body.slice(0, newline))
        if (request.secret !== 'snapshot-runtime-broker-secret-0001') {
          socket.end(JSON.stringify({ id: request.id, ok: false, error: { code: 'unauthorized', status: 401 } }) + '\n')
          return
        }
        calls.push({ tool: request.tool, arguments: request.arguments })
        const quota = () => socket.end(JSON.stringify({
          id: request.id,
          ok: false,
          error: { code: 'run_quota_exceeded', status: 403 },
        }) + '\n')
        if (request.tool === 'stat_file') {
          const key = `${request.arguments.follow_symlinks ? 'S' : 'L'}:${request.arguments.path}`
          if (statKeys.has(key)) throw new Error(`runtime-broker snapshot: duplicate discovery stat ${key}`)
          statKeys.add(key)
          if (mode === 'discovery-quota') { quota(); return }
          if (request.arguments.path === join(process.cwd(), '.skills')) {
            socket.end(JSON.stringify({ id: request.id, ok: true, result: {
              exists: true, type: 'dir', size: 4096, mode: 0o755, mtime_ms: 1,
            } }) + '\n')
            return
          }
          const outside = !request.arguments.path.startsWith(`${process.cwd()}/`)
            && request.arguments.path !== process.cwd()
          socket.end(JSON.stringify(outside
            ? { id: request.id, ok: false, error: { code: 'file_path_outside_workspace', status: 422 } }
            : { id: request.id, ok: true, result: { exists: false } }) + '\n')
          return
        }
        if (request.tool === 'list_files' && request.arguments.path === join(process.cwd(), '.skills')) {
          socket.end(JSON.stringify({ id: request.id, ok: true, result: {
            entries: [{ name: 'empty-skill', type: 'dir', size: 4096, mtime_ms: 1 }], truncated: false,
          } }) + '\n')
          return
        }
        if ((request.tool === 'write_file' || request.tool === 'write_stdin') && (
          calls.filter(call => call.tool === 'list_files').length !== 1
          || !statKeys.has(`S:${join(process.cwd(), '.skills/empty-skill/SKILL.md')}`)
        )) {
          unlinkSync(socketPath)
          throw new Error('runtime-broker snapshot: raw directory responses did not reach skill discovery')
        }
        if (mode === 'write-quota' && request.tool === 'write_file') { quota(); return }
        if (mode === 'command-quota' && request.tool === 'exec_command') {
          socket.end(JSON.stringify({
            id: request.id,
            ok: true,
            result: { session_id: 'snapshot-command', truncated: false },
          }) + '\n')
          return
        }
        if (mode === 'command-quota' && request.tool === 'write_stdin') { quota(); return }
        throw new Error(`runtime-broker snapshot: unexpected operation ${request.tool}`)
      })
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ path: socketPath }, resolve)
    })
    server.unref()
    return async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined)))
      await rm(socketPath, { force: true })
      if (statKeys.size === 0) throw new Error('runtime-broker snapshot: context discovery made no stat requests')
      const terminalCall = mode === 'discovery-quota' ? 'stat_file'
        : mode === 'command-quota' ? 'write_stdin'
          : 'write_file'
      const toolCalls = calls.map(call => call.tool)
      if (toolCalls.filter(tool => tool === terminalCall).length !== 1 || toolCalls.at(-1) !== terminalCall) {
        throw new Error(`runtime-broker snapshot: quota call was not terminal: ${toolCalls.join(',')}`)
      }
      if (mode === 'command-quota' && (toolCalls.filter(tool => tool === 'exec_command').length !== 1
        || calls.at(-1)?.arguments?.action !== 'poll')) {
        throw new Error(`runtime-broker snapshot: active command was not terminated by its first poll: ${toolCalls.join(',')}`)
      }
    }
  }, 'runtime-broker-snapshot-fixture')
}
