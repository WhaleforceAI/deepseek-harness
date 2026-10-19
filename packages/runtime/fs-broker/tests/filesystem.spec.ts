import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import { BrokerBridge, BrokerInvokeError } from '@deepseek-ai/dsh-runtime-broker'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import BrokerFileSystem from '../src/index.ts'
import { describe, expect, it, vi } from 'vitest'

interface FakeBridge {
  invoke(tool: string, args: unknown, signal?: AbortSignal): Promise<unknown>
}

function filesystem(bridge: FakeBridge): BrokerFileSystem {
  const owner = new BrokerBridge({ cacheDiscovery: true, socketPath: '/run/broker.sock', secret: 'x'.repeat(32) })
  owner.invoke = bridge.invoke.bind(bridge)
  return new BrokerFileSystem(new Context(), {}, owner)
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

  it('normalizes raw broker directory types for discovery and listing entries', async () => {
    const directory = { exists: true, type: 'dir', size: 4096, mode: 0o755, mtime_ms: 1 }
    const invoke = vi.fn(async (tool: string) => tool === 'stat_file'
      ? directory
      : { entries: [{ name: 'application-policy', ...directory }], truncated: false })
    const fs = filesystem({ invoke })
    const root = await fs.resolve('/workspace/.skills')

    for (let turn = 0; turn < 11; turn++) {
      expect(await fs.stat(root)).toMatchObject({ type: 'directory', size: 4096 })
      expect(await fs.lstat('/workspace/.skills')).toMatchObject({ type: 'directory', size: 4096 })
    }
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(await fs.listDir(root)).toEqual([{
      name: 'application-policy', type: 'directory', size: 4096,
      target: await fs.resolve('/workspace/.skills/application-policy'),
      version: FsVersion('broker:/workspace/.skills/application-policy:directory:4096:1'),
    }])
    expect(invoke.mock.calls.map(([tool]) => tool)).toEqual(['stat_file', 'stat_file', 'stat_file', 'list_files'])
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
        if (tool === 'stat_file') return content === undefined ? { exists: false } : { type: 'file', size: content.length, mtime_ms: mtime }
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

  it('rejects a missing stat result', async () => {
    const fs = filesystem({ async invoke() { return undefined } })

    await expect(fs.stat(await fs.resolve('missing.txt'))).rejects.toThrow('invalid stat_file response')
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

function cachedFilesystem(invoke: FakeBridge['invoke']): { fs: BrokerFileSystem; bridge: BrokerBridge } {
  const bridge = new BrokerBridge({ cacheDiscovery: true, socketPath: '/run/broker.sock', secret: 'x'.repeat(32) })
  bridge.invoke = invoke
  return { fs: new BrokerFileSystem(new Context(), {}, bridge), bridge }
}

describe('discovery metadata cache', () => {
  it('revalidates cached parents once per observed command epoch', async () => {
    const file = { type: 'file', size: 1, mtime_ms: 1, mode: 0o600 }
    const invoke = vi.fn(async (tool: string) => tool === 'list_files'
      ? { entries: [{ name: 'AGENTS.md', ...file }] }
      : file)
    const { fs, bridge } = cachedFilesystem(invoke)
    const epoch = vi.spyOn(bridge, 'commandEpoch', 'get').mockReturnValue(0)
    const turn = async (): Promise<void> => {
      for (const name of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md', '.git', '.skills']) {
        await fs.stat(await fs.resolve(name))
      }
      await fs.lstat('AGENTS.md')
      await fs.lstat('CLAUDE.md')
    }
    // A full listing must include every cached present path to retain eight entries.
    invoke.mockImplementation(async tool => tool === 'list_files' ? {
      entries: ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md', '.git', '.skills']
        .map(name => ({ name, ...file })),
    } : file)
    await turn()
    expect(invoke).toHaveBeenCalledTimes(8)
    await turn()
    expect(invoke).toHaveBeenCalledTimes(8)
    epoch.mockReturnValue(1)
    await turn()
    expect(invoke.mock.calls.filter(([tool]) => tool === 'stat_file')).toHaveLength(8)
    expect(invoke.mock.calls.filter(([tool]) => tool === 'list_files')).toHaveLength(1)
    await turn()
    expect(invoke).toHaveBeenCalledTimes(9)
    epoch.mockReturnValue(2)
    await turn()
    // The old command-disabled behavior adds eight stats every turn; this adds one listing per epoch.
    expect(invoke).toHaveBeenCalledTimes(10)
  })

  it.each([
    { name: 'changed metadata', listing: { entries: [{ name: 'AGENTS.md', type: 'file', size: 2, mtime_ms: 1 }] } },
    { name: 'removed file', listing: { entries: [] } },
    { name: 'followed symlink', listing: { entries: [{ name: 'AGENTS.md', type: 'symlink', mtime_ms: 1 }] } },
    { name: 'truncated listing', listing: { entries: [], truncated: true } },
    { name: 'malformed listing', listing: { entries: [{ name: 'AGENTS.md' }] } },
  ])('refreshes cached discovery after $name', async ({ listing }) => {
    const invoke = vi.fn(async (tool: string) => tool === 'list_files'
      ? listing : { type: 'file', size: 1, mtime_ms: 1 })
    const { fs, bridge } = cachedFilesystem(invoke)
    const target = await fs.resolve('AGENTS.md')
    await fs.stat(target)
    vi.spyOn(bridge, 'commandEpoch', 'get').mockReturnValue(1)
    await fs.stat(target)
    await fs.stat(target)
    expect(invoke.mock.calls.map(([tool]) => tool)).toEqual(['stat_file', 'list_files', 'stat_file'])
  })

  it('discards revalidation across write invalidation before filling a fresh epoch', async () => {
    const listing = Promise.withResolvers<unknown>()
    const invoke = vi.fn(async (tool: string) => tool === 'list_files' ? listing.promise : { exists: false })
    const { fs, bridge } = cachedFilesystem(invoke)
    const target = await fs.resolve('AGENTS.md')
    await fs.stat(target)
    vi.spyOn(bridge, 'commandEpoch', 'get').mockReturnValue(1)
    const pending = fs.stat(target)
    expect(invoke.mock.calls.map(([tool]) => tool)).toEqual(['stat_file', 'list_files'])
    bridge.invalidate()
    listing.resolve({ entries: [] })
    await pending
    await fs.stat(target)
    await fs.stat(target)
    expect(invoke.mock.calls.map(([tool]) => tool)).toEqual(['stat_file', 'list_files', 'stat_file', 'stat_file'])
  })

  it.each([{ entries: [] }, { entries: [{ name: 'AGENTS.md', type: 'symlink', mtime_ms: 1 }] }])(
    'evicts cached workspace rejection on command revalidation with entries $entries', async ({ entries }) => {
      const denial = new BrokerInvokeError('file_path_outside_workspace', 422)
      const invoke = vi.fn<FakeBridge['invoke']>()
        .mockRejectedValueOnce(denial)
        .mockResolvedValueOnce({ entries })
        .mockResolvedValue({ exists: false })
      const { fs, bridge } = cachedFilesystem(invoke)
      const target = await fs.resolve('AGENTS.md')
      await expect(fs.stat(target)).rejects.toMatchObject({ cause: denial })
      await expect(fs.stat(target)).rejects.toMatchObject({ cause: denial })
      vi.spyOn(bridge, 'commandEpoch', 'get').mockReturnValue(1)
      expect(await fs.stat(target)).toBeUndefined()
      expect(await fs.stat(target)).toBeUndefined()
      expect(invoke.mock.calls.map(([tool]) => tool)).toEqual(['stat_file', 'list_files', 'stat_file'])
    },
  )

  it('retains only cached absence when a complete revalidation omits the name', async () => {
    const invoke = vi.fn(async (tool: string) => tool === 'list_files' ? { entries: [] } : { exists: false })
    const { fs, bridge } = cachedFilesystem(invoke)
    const target = await fs.resolve('AGENTS.md')
    await fs.stat(target)
    vi.spyOn(bridge, 'commandEpoch', 'get').mockReturnValue(1)
    expect(await fs.stat(target)).toBeUndefined()
    expect(invoke.mock.calls.map(([tool]) => tool)).toEqual(['stat_file', 'list_files'])
  })

  it.each(['initiator', 'joiner'])('cancels the %s independently of shared revalidation', async (cancelled) => {
    const listing = Promise.withResolvers<unknown>()
    const invoke = vi.fn<FakeBridge['invoke']>(async (tool, _args, signal) => {
      if (tool !== 'list_files') return { exists: false }
      // A caller abort must never own the listing needed by another inspection.
      signal?.addEventListener('abort', () => { listing.reject(signal.reason) }, { once: true })
      return listing.promise
    })
    const { fs, bridge } = cachedFilesystem(invoke)
    const target = await fs.resolve('AGENTS.md')
    await fs.stat(target)
    vi.spyOn(bridge, 'commandEpoch', 'get').mockReturnValue(1)
    const firstSignal = new AbortController()
    const secondSignal = new AbortController()
    const first = fs.stat(target, firstSignal.signal)
    const second = fs.stat(target, secondSignal.signal)
    const aborted = cancelled === 'initiator' ? first : second
    const survivor = cancelled === 'initiator' ? second : first
    const rejection = expect(aborted).rejects.toMatchObject({ code: 'FS_ABORTED', message: 'stat aborted' })
    const controller = cancelled === 'initiator' ? firstSignal : secondSignal
    controller.abort()
    // Cancellation settles before the held listing, while a third caller still joins it.
    await rejection
    const third = fs.stat(target)
    expect(invoke.mock.calls.map(([tool]) => tool)).toEqual(['stat_file', 'list_files'])
    listing.resolve({ entries: [] })
    expect(await survivor).toBeUndefined()
    expect(await third).toBeUndefined()
    expect(await fs.stat(target)).toBeUndefined()
    expect(invoke.mock.calls.map(([tool]) => tool)).toEqual(['stat_file', 'list_files'])
  })

  it('requires explicit workspace exclusivity opt-in', async () => {
    const bridge = new BrokerBridge({ socketPath: '/run/broker.sock', secret: 'x'.repeat(32) })
    const invoke = vi.fn(async () => ({ exists: false }))
    bridge.invoke = invoke
    const fs = new BrokerFileSystem(new Context(), {}, bridge)
    const target = await fs.resolve('AGENTS.md')
    await fs.stat(target)
    await fs.stat(target)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('bypasses and does not fill while the owner has an active mutation', async () => {
    const invoke = vi.fn(async () => ({ exists: false }))
    const { fs, bridge } = cachedFilesystem(invoke)
    const allowed = vi.spyOn(bridge, 'cacheAllowed', 'get').mockReturnValue(false)
    const target = await fs.resolve('AGENTS.md')
    await fs.stat(target)
    await fs.stat(target)
    allowed.mockRestore()
    await fs.stat(target)
    await fs.stat(target)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('reuses only the six discovery basenames, normalized and separated by symlink policy', async () => {
    const invoke = vi.fn(async () => ({ exists: false }))
    const { fs } = cachedFilesystem(invoke)
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md', '.git', '.skills']) {
      const target = await fs.resolve(`nested/../${name}`)
      await fs.stat(target)
      await fs.stat(await fs.resolve(name))
      await fs.lstat(name)
      await fs.lstat(`./${name}`)
    }
    expect(invoke).toHaveBeenCalledTimes(12)
    for (let count = 0; count < 2; count += 1) await fs.stat(await fs.resolve('ordinary.txt'))
    expect(invoke).toHaveBeenCalledTimes(14)
  })

  it('caches only structured workspace rejection and preserves the original cause', async () => {
    const denial = new BrokerInvokeError('file_path_outside_workspace', 422)
    const invoke = vi.fn(async () => { throw denial })
    const { fs } = cachedFilesystem(invoke)
    for (let count = 0; count < 2; count += 1) {
      await expect(fs.stat(await fs.resolve('/AGENTS.md'))).rejects.toMatchObject({ cause: denial })
    }
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it.each([
    new Error('runtime-broker: file_path_outside_workspace'),
    new BrokerInvokeError('file_path_outside_workspace', 403),
    new BrokerInvokeError('run_quota_exceeded', 403),
    new BrokerInvokeError('token_expired', 403),
    new Error('socket disconnected'),
  ])('does not cache transient or non-workspace failure %s', async (error) => {
    const invoke = vi.fn(async () => { throw error })
    const { fs } = cachedFilesystem(invoke)
    const target = await fs.resolve('AGENTS.md')
    await expect(fs.stat(target)).rejects.toThrow()
    await expect(fs.stat(target)).rejects.toThrow()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, null, {}, { type: 'file', size: -1, mtime_ms: 1 },
    { exists: 'false', type: 'file', size: 1, mtime_ms: 1 }])('does not cache malformed metadata %s', async (response) => {
    const invoke = vi.fn(async () => response)
    const { fs } = cachedFilesystem(invoke)
    const target = await fs.resolve('AGENTS.md')
    await expect(fs.stat(target)).rejects.toThrow()
    await expect(fs.stat(target)).rejects.toThrow()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('checks abort and terminal state before a cached success', async () => {
    const invoke = vi.fn(async () => ({ exists: false }))
    const { fs, bridge } = cachedFilesystem(invoke)
    const target = await fs.resolve('AGENTS.md')
    await fs.stat(target)
    await expect(fs.stat(target, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
    const quota = new BrokerInvokeError('run_quota_exceeded', 403)
    vi.spyOn(bridge, 'assertAvailable').mockImplementation(() => { throw quota })
    await expect(fs.stat(target)).rejects.toBe(quota)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('drops a stat fill that settles after invalidation', async () => {
    let finish!: (value: unknown) => void
    const invoke = vi.fn<FakeBridge['invoke']>()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValue({ type: 'file', size: 1, mtime_ms: 2 })
    const { fs, bridge } = cachedFilesystem(invoke)
    const target = await fs.resolve('AGENTS.md')
    const pending = fs.stat(target)
    bridge.invalidate()
    finish({ exists: false })
    await pending
    expect(await fs.stat(target)).toMatchObject({ type: 'file' })
    await fs.stat(target)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('bounds cache storage at 256 entries and starts each run empty', async () => {
    const invoke = vi.fn(async () => ({ exists: false }))
    const { fs } = cachedFilesystem(invoke)
    for (let count = 0; count < 257; count += 1) await fs.stat(await fs.resolve(`${count}/AGENTS.md`))
    await fs.stat(await fs.resolve('256/AGENTS.md'))
    expect(invoke).toHaveBeenCalledTimes(257)
    await fs.stat(await fs.resolve('0/AGENTS.md'))
    expect(invoke).toHaveBeenCalledTimes(258)
    const fresh = cachedFilesystem(invoke).fs
    await fresh.stat(await fresh.resolve('256/AGENTS.md'))
    expect(invoke).toHaveBeenCalledTimes(259)
  })

  it('reads and streams fresh discovery-file sizes and rejects stale edit/write guards', async () => {
    let content = 'a'
    let mtime = 1
    const invoke = vi.fn(async (tool: string) => tool === 'stat_file'
      ? { type: 'file', size: content.length, mtime_ms: mtime }
      : { content: Buffer.from(content).toString('base64') })
    const { fs } = cachedFilesystem(invoke)
    const target = await fs.resolve('AGENTS.md')
    const original = await fs.stat(target)
    content = 'fresh'
    mtime += 1
    expect(await fs.readText(target)).toBe('fresh')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe('fresh')
    await expect(fs.editText(target, { oldString: 'fresh', newString: 'next', replaceAll: false }, { version: original!.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(fs.writeText(target, 'next', { kind: 'replaceIfVersion', version: original!.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(invoke.mock.calls.filter(([tool]) => tool === 'write_file')).toHaveLength(0)
  })
})
