import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const opened: string[] = []

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
      if (String(path).endsWith('.tmp')) opened.push(String(path))
      return (actual.open as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.open,
  }
})

const { writeAtomic } = await import('../src/atomic.ts')

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe('writeAtomic temp naming', () => {
  it('names the temp file after the hashed target and leaves no residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atomic-'))
    roots.push(root)
    opened.length = 0
    await writeAtomic(join(root, 'session-1.json'), '{}')
    const hash = createHash('sha256').update('session-1.json', 'utf8').digest('hex')
    expect(opened).toHaveLength(1)
    expect(opened[0]!.slice(root.length + 1)).toMatch(
      new RegExp(`^\\.record-${hash}\\.[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.tmp$`),
    )
    expect(await readdir(root)).toEqual(['session-1.json'])
    expect(await readFile(join(root, 'session-1.json'), 'utf8')).toBe('{}')
  })

  it('keeps the temp name within the filename limit for long record keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-atomic-'))
    roots.push(root)
    opened.length = 0
    await writeAtomic(join(root, `${'k'.repeat(240)}.json`), '{}')
    expect(opened[0]!.split('/').pop()!.length).toBeLessThan(255)
  })
})
