/** Deterministic run-local Unix-socket broker for the Runtime composition snapshot. */
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

export const name = 'runtime-broker-snapshot-fixture'

export async function apply(ctx) {
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
        calls.push(request.tool)
        if (request.tool === 'write_file') {
          socket.end(JSON.stringify({
            id: request.id,
            ok: false,
            error: { code: 'run_quota_exceeded', status: 403 },
          }) + '\n')
          return
        }
        if (request.tool !== 'stat_file') {
          throw new Error(`runtime-broker snapshot: unexpected operation ${request.tool}`)
        }
        const key = `${request.arguments.follow_symlinks ? 'S' : 'L'}:${request.arguments.path}`
        if (statKeys.has(key)) throw new Error(`runtime-broker snapshot: duplicate discovery stat ${key}`)
        statKeys.add(key)
        const outside = !request.arguments.path.startsWith(`${process.cwd()}/`)
          && request.arguments.path !== process.cwd()
        socket.end(JSON.stringify(outside
          ? { id: request.id, ok: false, error: { code: 'file_path_outside_workspace', status: 422 } }
          : { id: request.id, ok: true, result: { exists: false } }) + '\n')
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
      if (calls.filter(call => call === 'write_file').length !== 1 || calls.at(-1) !== 'write_file') {
        throw new Error(`runtime-broker snapshot: quota call was not terminal: ${calls.join(',')}`)
      }
    }
  }, 'runtime-broker-snapshot-fixture')
}
