/**
 * Broker-backed implementation of the DeepSeek Harness filesystem seam.
 * @module @deepseek-ai/dsh-fs-broker
 */

import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { BrokerBridge } from '@deepseek-ai/dsh-runtime-broker'

const MAX_READ_BYTES = 1_048_576
const MAX_READ_OFFSET = 1_073_741_824
const MAX_READABLE_BYTES = MAX_READ_OFFSET + MAX_READ_BYTES
const MAX_WRITE_CHARACTERS = 1_048_576
const MAX_LIST_ENTRIES = 10_000
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Configuration for the filesystem provider backed by an Agent Runtime broker. */
export interface Config {
  /** Absolute Unix-socket path for the run-local broker. */
  socketPath: string
  /** Run-local broker authentication secret. */
  secret: string
  /** Base path for relative filesystem requests. */
  cwd?: string
}

type ResolvedConfig = Required<Config>
type BrokerInvoker = Pick<BrokerBridge, 'invoke'>

/** Loader schema for {@link BrokerFileSystem}. */
export const Config: z<Config> = z.object({
  socketPath: z.string(),
  secret: z.string(),
  cwd: z.string().default('/workspace'),
})

interface BrokerStat {
  type: 'file' | 'directory' | 'other' | 'symlink'
  size?: number
  mtimeMs: number
  mode?: number
}

interface BrokerListEntry extends BrokerStat {
  name: string
  path?: string
}

/**
 * Count Unicode code points without materializing an array.
 *
 * The broker bounds `content` by code points (Python's `len`), so a UTF-16
 * `.length` would over-count every astral character and reject writes the
 * broker would have accepted.
 */
function codePoints(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) index += 1
    count += 1
  }
  return count
}

function record(value: unknown, operation: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`fs-broker: invalid ${operation} response`)
  }
  // The guard above proves an object; TS still needs the index signature.
  return value as Record<string, unknown>
}

function integer(value: unknown, field: string, operation: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`fs-broker: invalid ${operation} response ${field}`)
  }
  return value as number
}

function statResult(value: unknown, operation: string): BrokerStat | undefined {
  if (value === undefined) return undefined
  const response = record(value, operation)
  if (response.exists === false) return undefined
  const type = response.type
  if (type !== 'file' && type !== 'directory' && type !== 'other' && type !== 'symlink') {
    throw new Error(`fs-broker: invalid ${operation} response type`)
  }
  const mtimeMs = integer(response.mtime_ms, 'mtime_ms', operation)
  const size = response.size === undefined ? undefined : integer(response.size, 'size', operation)
  const mode = response.mode === undefined ? undefined : integer(response.mode, 'mode', operation)
  if (type === 'file' && size === undefined) throw new Error(`fs-broker: invalid ${operation} response size`)
  if (mode !== undefined && (mode < 0o400 || mode > 0o777)) {
    throw new Error(`fs-broker: invalid ${operation} response mode`)
  }
  return { type, mtimeMs, ...(size === undefined ? {} : { size }), ...(mode === undefined ? {} : { mode }) }
}

function base64Content(value: unknown): Uint8Array {
  const content = record(value, 'read_file').content
  if (typeof content !== 'string' || !BASE64.test(content)) {
    throw new Error('fs-broker: invalid read_file response content')
  }
  const bytes = Buffer.from(content, 'base64')
  if (bytes.toString('base64') !== content) throw new Error('fs-broker: invalid read_file response content')
  return bytes
}

function listResult(value: unknown): BrokerListEntry[] {
  const entries = record(value, 'list_files').entries
  if (!Array.isArray(entries)) throw new Error('fs-broker: invalid list_files response entries')
  return entries.map((entry) => {
    const response = record(entry, 'list_files')
    if (typeof response.name !== 'string' || response.name.length === 0 || response.name.includes('/')) {
      throw new Error('fs-broker: invalid list_files response name')
    }
    const stat = statResult(response, 'list_files')
    if (stat === undefined) throw new Error('fs-broker: invalid list_files response entry')
    if (response.path !== undefined && typeof response.path !== 'string') {
      throw new Error('fs-broker: invalid list_files response path')
    }
    return { name: response.name, ...stat, ...(response.path === undefined ? {} : { path: response.path }) }
  })
}

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function restoresCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  return crlf > sample.split('\n').length - 1 - crlf
}

function literalEdit(content: string, request: FsEditRequest, path: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) throw new FsError(`cannot edit "${path}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${path}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${path}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

/** Filesystem backend whose operations run through a run-local Agent Runtime broker. */
export class BrokerFileSystem extends FileSystem {
  static Config = Config

  /** Validated configuration. */
  readonly config: ResolvedConfig
  private readonly locks = new Map<string, Promise<unknown>>()

  /** @inheritdoc */
  override get sandboxMode(): undefined {
    return undefined
  }

  /** Create a filesystem service over the configured broker bridge. */
  constructor(
    ctx: Context,
    config: Config,
    private readonly bridge: BrokerInvoker = new BrokerBridge(config),
  ) {
    super(ctx)
    // Rebuilt field by field rather than spread: the loader hands us a
    // schemastery instance, and spreading one drops its prototype.
    this.config = {
      socketPath: config.socketPath,
      secret: config.secret,
      cwd: config.cwd ?? '/workspace',
    }
    if (!this.config.cwd.startsWith('/')) throw new Error('fs-broker: cwd must be absolute')
  }

  // The FileSystem contract makes `resolve` async and permits provider I/O.
  // This backend resolves purely from the path, and dropping `async` would turn
  // its rejections into synchronous throws.
  // oxlint-disable-next-line typescript/require-await
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.config.cwd, path)
    return { targetKey: FsTargetKey(displayPath), displayPath }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return `file://${this.processPath(target).split('/').map(encodeURIComponent).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const stat = await this.inspect(target.displayPath, true, signal)
    if (stat === undefined) return undefined
    return {
      version: this.version(target.displayPath, stat),
      type: stat.type === 'directory' ? 'directory' : stat.type === 'file' ? 'file' : 'other',
      ...(stat.size === undefined ? {} : { size: stat.size }),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.config.cwd, path)
    const stat = await this.inspect(displayPath, false, signal)
    if (stat === undefined) return undefined
    return {
      version: this.version(displayPath, stat),
      type: stat.type,
      ...(stat.size === undefined ? {} : { size: stat.size }),
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const bytes = await this.readAll(target, Number.MAX_SAFE_INTEGER, signal)
    if (bytes.includes(0)) throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error: unknown) {
      throw new FsError(`cannot read "${target.displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file' || info.size === undefined) {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    this.requireReadableSize(target, info.size, Number.MAX_SAFE_INTEGER)
    // Bind the checked size: the generator below is a closure, so the
    // `info.size === undefined` narrowing above does not survive into it.
    const size = info.size
    // Bound method rather than a `this` alias, which the generator below cannot
    // capture cleanly.
    const readChunk = this.readChunk.bind(this)
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let offset = 0
        let sampledBytes = 0
        while (offset < size) {
          const chunk = await readChunk(target, offset, Math.min(MAX_READ_BYTES, size - offset), signal)
          if (sampledBytes < 8192) {
            const sample = chunk.subarray(0, 8192 - sampledBytes)
            if (sample.includes(0)) throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
            sampledBytes += sample.byteLength
          }
          try {
            const text = decoder.decode(chunk, { stream: true })
            if (text.length > 0) yield text
          } catch (error: unknown) {
            throw new FsError(`cannot read "${target.displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
          }
          offset += chunk.byteLength
        }
        try {
          const text = decoder.decode()
          if (text.length > 0) yield text
        } catch (error: unknown) {
          throw new FsError(`cannot read "${target.displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
        }
      },
    }
  }

  override readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.readAll(target, maxBytes, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    try {
      assertNotAborted(signal, 'list')
      const entries = listResult(await this.bridge.invoke('list_files', { path: this.processPath(target), limit: MAX_LIST_ENTRIES }, signal))
      assertNotAborted(signal, 'list')
      if (entries.length === MAX_LIST_ENTRIES) {
        throw new FsError(`cannot list "${target.displayPath}": broker limit is ${MAX_LIST_ENTRIES} entries`, 'FS_TOO_LARGE')
      }
      // Annotated so the literal `type` union does not widen to `string`.
      return entries.map((entry): FsDirEntry => {
        const displayPath = entry.path ?? posix.join(target.displayPath, entry.name)
        return {
          name: entry.name,
          type: entry.type === 'directory' ? 'directory' : entry.type === 'file' ? 'file' : 'other',
          target: { targetKey: FsTargetKey(displayPath), displayPath },
          version: this.version(displayPath, entry),
          ...(entry.size === undefined ? {} : { size: entry.size }),
        }
      }).sort((left, right) => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      throw this.error(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.requireWriteTarget(target, expected, signal)
      const before = existing === undefined ? null : await this.diffBasis(target, signal)
      await this.write(target, content, existing === undefined ? 0o600 : existing.mode, signal)
      const info = await this.stat(target)
      if (info === undefined || info.type !== 'file') {
        throw new FsError(
          `cannot write "${target.displayPath}": broker did not publish a regular file`,
          'FS_IO_ERROR',
        )
      }
      return { operation: existing === undefined ? 'create' : 'update', version: info.version, before, after: normalizeLineEndings(content) }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.inspect(target.displayPath, true, signal)
      if (existing === undefined) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (expected !== undefined && this.version(target.displayPath, existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readText(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      await this.write(target, restoresCrlf(raw) ? after.replaceAll('\n', '\r\n') : after, existing.mode, signal)
      const afterInfo = await this.stat(target)
      if (afterInfo === undefined || afterInfo.type !== 'file') {
        throw new FsError(
          `cannot edit "${target.displayPath}": broker did not publish a regular file`,
          'FS_IO_ERROR',
        )
      }
      return { version: afterInfo.version, before, after }
    })
  }

  private async inspect(path: string, followSymlinks: boolean, signal?: AbortSignal): Promise<BrokerStat | undefined> {
    try {
      assertNotAborted(signal, 'stat')
      const stat = statResult(await this.bridge.invoke('stat_file', { path, follow_symlinks: followSymlinks }, signal), 'stat_file')
      assertNotAborted(signal, 'stat')
      return stat
    } catch (error: unknown) {
      throw this.error(error, 'stat', path, signal)
    }
  }

  private async readAll(target: FsTarget, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file' || info.size === undefined) throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    this.requireReadableSize(target, info.size, maxBytes)
    const chunks: Uint8Array[] = []
    let offset = 0
    try {
      while (offset < info.size) {
        const chunk = await this.readChunk(target, offset, Math.min(MAX_READ_BYTES, info.size - offset), signal)
        chunks.push(chunk)
        offset += chunk.byteLength
      }
    } catch (error: unknown) {
      throw this.error(error, 'read', target.displayPath, signal)
    }
    const bytes = new Uint8Array(offset)
    let start = 0
    for (const chunk of chunks) {
      bytes.set(chunk, start)
      start += chunk.byteLength
    }
    return bytes
  }

  private async requireWriteTarget(
    target: FsTarget,
    expected: FsWriteIntent | undefined,
    signal?: AbortSignal,
  ): Promise<BrokerStat | undefined> {
    const existing = await this.inspect(target.displayPath, true, signal)
    if (existing !== undefined && existing.type !== 'file') throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion' && (existing === undefined || this.version(target.displayPath, existing) !== expected.version)) {
      throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    return existing
  }

  private async diffBasis(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      return normalizeLineEndings(await this.readText(target, signal))
    } catch (error: unknown) {
      if (error instanceof FsError && (error.code === 'FS_NOT_TEXT' || error.code === 'FS_TOO_LARGE')) return null
      throw error
    }
  }

  private async write(target: FsTarget, content: string, mode: number | undefined, signal?: AbortSignal): Promise<void> {
    try {
      assertNotAborted(signal, 'write')
      if (codePoints(content) > MAX_WRITE_CHARACTERS) {
        throw new FsError(`cannot write "${target.displayPath}": content exceeds the ${MAX_WRITE_CHARACTERS}-character broker limit`, 'FS_TOO_LARGE')
      }
      const result = await this.bridge.invoke('write_file', {
        path: this.processPath(target),
        content,
        encoding: 'utf-8',
        create_parents: false,
        ...(mode === undefined ? {} : { mode }),
      })
      record(result, 'write_file')
    } catch (error: unknown) {
      throw this.error(error, 'write', target.displayPath)
    }
  }

  private version(path: string, stat: BrokerStat): FsVersion {
    return FsVersion(`broker:${path}:${stat.type}:${stat.size ?? ''}:${stat.mtimeMs}`)
  }

  private requireReadableSize(target: FsTarget, size: number, maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    if (size > MAX_READABLE_BYTES) {
      throw new FsError(`cannot read "${target.displayPath}": ${size} bytes exceeds the ${MAX_READABLE_BYTES}-byte broker limit`, 'FS_TOO_LARGE')
    }
  }

  private async readChunk(target: FsTarget, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    try {
      assertNotAborted(signal, 'read')
      if (offset > MAX_READ_OFFSET || length <= 0 || length > MAX_READ_BYTES) {
        throw new Error('fs-broker: invalid read range')
      }
      const chunk = base64Content(await this.bridge.invoke('read_file', {
        path: this.processPath(target), encoding: 'base64', offset, length,
      }, signal))
      if (chunk.byteLength === 0 || chunk.byteLength > length) throw new Error('fs-broker: invalid read_file response length')
      assertNotAborted(signal, 'read')
      return chunk
    } catch (error: unknown) {
      throw this.error(error, 'read', target.displayPath, signal)
    }
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  private error(error: unknown, operation: string, path: string, signal?: AbortSignal): FsError {
    if (error instanceof FsError) return error
    if (signal?.aborted === true) return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
    return new FsError(`cannot ${operation} "${path}": ${String(error)}`, 'FS_IO_ERROR', { cause: error })
  }
}

export default BrokerFileSystem
