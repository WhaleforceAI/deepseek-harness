import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import BrokerFileSystem from '../src/index.ts'
import { describe, expect, it, vi } from 'vitest'

interface FakeBridge {
  invoke(tool: string, args: unknown, signal?: AbortSignal): Promise<unknown>
}

function filesystem(bridge: FakeBridge): BrokerFileSystem {
  return new BrokerFileSystem(new Context(), { socketPath: '/run/broker.sock', secret: 'x'.repeat(32) }, bridge)
}

describe('BrokerFileSystem', () => {
  it('does not advertise a local sandbox mode', () => {
    expect(filesystem({ async invoke() { return {} } }).sandboxMode).toBeUndefined()
  })

  it('lists directory entries from the broker entries field', async () => {
    const fs = filesystem({
      async invoke(tool) {
        if (tool === 'stat_file') return { type: 'directory', mtime_ms: 1 }
        return { entries: [{ name: 'hello.txt', type: 'file', size: 5, mtime_ms: 2 }], truncated: false }
      },
    })

    expect(await fs.listDir(await fs.resolve('.'))).toEqual([
      {
        name: 'hello.txt',
        type: 'file',
        size: 5,
        target: await fs.resolve('hello.txt'),
        version: FsVersion('broker:/workspace/hello.txt:file:5:2'),
      },
    ])
  })

  it('rejects a broker list response with files instead of entries', async () => {
    const fs = filesystem({
      async invoke(tool) {
        if (tool === 'stat_file') return { type: 'directory', mtime_ms: 1 }
        return { files: [], truncated: false }
      },
    })

    await expect(fs.listDir(await fs.resolve('.')))
      .rejects.toThrow('fs-broker: invalid list_files response entries')
  })

  it('reads broker-sized ranges and reassembles base64 bytes exactly', async () => {
    const bytes = Buffer.alloc(1_048_577, 0)
    bytes[0] = 1
    bytes[bytes.length - 1] = 255
    const invoke = vi.fn(async (tool: string, args: unknown) => {
      if (tool === 'stat_file') return { type: 'file', size: bytes.length, mtime_ms: 1 }
      const request = args as { offset: number; length: number }
      return { content: bytes.subarray(request.offset, request.offset + request.length).toString('base64') }
    })
    const fs = filesystem({ invoke })

    const read = await fs.readBytes(await fs.resolve('bytes.bin'), undefined, bytes.length)

    expect(Buffer.from(read)).toEqual(bytes)
    expect(invoke.mock.calls.filter(([tool]) => tool === 'read_file').map(([, args]) => args)).toEqual([
      { path: '/workspace/bytes.bin', encoding: 'base64', offset: 0, length: 1_048_576 },
      { path: '/workspace/bytes.bin', encoding: 'base64', offset: 1_048_576, length: 1 },
    ])
  })

  it('uses UTF-8 text publication and reads binary transport bytes back exactly', async () => {
    // Buffer, not Uint8Array: the fake encodes ranged reads with toString('base64').
    let content: Buffer | undefined
    let mtime = 1
    const fs = filesystem({
      async invoke(tool, args) {
        const request = args as Record<string, unknown>
        if (tool === 'stat_file') return content === undefined ? undefined : { type: 'file', size: content.length, mtime_ms: mtime }
        if (tool === 'write_file') {
          expect(request).toMatchObject({ content: 'hello', encoding: 'utf-8', create_parents: false, mode: 0o600 })
          content = Buffer.from(request.content as string, 'utf8')
          mtime += 1
          return {}
        }
        if (tool === 'read_file') {
          const offset = request.offset as number
          const length = request.length as number
          return { content: content?.subarray(offset, offset + length).toString('base64') ?? '' }
        }
        throw new Error(`unexpected ${tool}`)
      },
    })
    const target = await fs.resolve('round-trip.txt')

    await fs.writeText(target, 'hello')

    expect(await fs.readBytes(target, undefined, 5)).toEqual(new TextEncoder().encode('hello'))
  })

  it('returns undefined for a missing stat result', async () => {
    const fs = filesystem({ async invoke() { return undefined } })

    expect(await fs.stat(await fs.resolve('missing.txt'))).toBeUndefined()
  })

  it('returns undefined when the broker explicitly reports a missing stat', async () => {
    const fs = filesystem({ async invoke() { return { exists: false } } })

    expect(await fs.stat(await fs.resolve('missing.txt'))).toBeUndefined()
  })

  it('streams decoded text through broker-sized ranges', async () => {
    const text = 'a'.repeat(1_048_575) + '€b'
    const bytes = Buffer.from(text)
    const invoke = vi.fn(async (tool: string, args: unknown) => {
      if (tool === 'stat_file') return { type: 'file', size: bytes.length, mtime_ms: 1 }
      const request = args as { offset: number; length: number }
      return { content: bytes.subarray(request.offset, request.offset + request.length).toString('base64') }
    })
    const fs = filesystem({ invoke })
    const target = await fs.resolve('stream.txt')
    let received = ''

    for await (const chunk of await fs.streamText(target)) received += chunk

    expect(received).toBe(text)
    expect(invoke.mock.calls.filter(([tool]) => tool === 'read_file')).toHaveLength(2)
  })

  it('writes when an existing broker file is too large for a contextual diff', async () => {
    let statCalls = 0
    const invoke = vi.fn(async (tool: string, args: unknown) => {
      if (tool === 'stat_file') {
        statCalls += 1
        return statCalls < 3
          ? { type: 'file', size: 1_074_790_401, mtime_ms: 1, mode: 0o640 }
          : { type: 'file', size: 4, mtime_ms: 2, mode: 0o640 }
      }
      if (tool === 'write_file') {
        expect(args).toMatchObject({ content: 'next', encoding: 'utf-8', mode: 0o640 })
        return {}
      }
      throw new Error(`unexpected ${tool}`)
    })
    const fs = filesystem({ invoke })

    const result = await fs.writeText(await fs.resolve('large.txt'), 'next')

    expect(result.before).toBeNull()
    expect(invoke).toHaveBeenCalledWith('write_file', expect.any(Object))
  })

  it('checks a stale write guard before invoking the broker write', async () => {
    const invoke = vi.fn(async (tool: string) => {
      if (tool === 'stat_file') return { type: 'file', size: 1, mtime_ms: 1 }
      throw new Error(`unexpected ${tool}`)
    })
    const fs = filesystem({ invoke })
    const target = await fs.resolve('stale.txt')

    await expect(fs.writeText(target, 'next', { kind: 'replaceIfVersion', version: FsVersion('old') }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
