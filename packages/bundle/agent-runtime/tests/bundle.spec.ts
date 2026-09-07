/** The Agent Runtime bundle's effective SDK composition. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'

function readPatches(root: string): PatchOptions[] {
  return yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), {
    schema: entryListSchema,
  }) as PatchOptions[]
}

describe('dsh-agent-runtime bundle', () => {
  it('replaces host execution and disables unsupported SDK surfaces', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-bash-local',
      '@deepseek-ai/dsh-fs-broker',
      '@deepseek-ai/dsh-runtime-broker',
      '@deepseek-ai/dsh-subprocess-broker',
    ])

    const agentRuntime = readPatches(root)
    const referencedIds = agentRuntime.flatMap(patch => patch.id === undefined ? [] : [patch.id])
    const warnings: string[] = []
    const entries = composeEntries([
      readPatches(resolve(root, '..', 'base')),
      readPatches(resolve(root, '..', 'sdk-app')),
      agentRuntime,
    ], warning => warnings.push(warning))
    expect(warnings).toEqual([])
    expect(referencedIds.every(id => entries.some(entry => entry.id === id))).toBe(true)

    expect(entries.find(entry => entry.id === 'subprocess')).toMatchObject({ disabled: true })
    expect(entries.find(entry => entry.id === 'fs-sandbox')).toMatchObject({ disabled: true })
    expect(entries.find(entry => entry.id === 'subprocess-broker')).toMatchObject({
      name: '@deepseek-ai/dsh-subprocess-broker',
      config: { cwd: '/workspace' },
    })
    expect(entries.find(entry => entry.id === 'fs-broker')).toMatchObject({
      name: '@deepseek-ai/dsh-fs-broker',
      config: { cwd: '/workspace' },
    })
    expect(entries.find(entry => entry.id === 'bash')).toMatchObject({
      name: '@deepseek-ai/dsh-bash-local',
      config: { cwd: '/workspace', timeoutMs: 60000 },
    })
    expect(entries.find(entry => entry.id === 'runtime-broker-tools')).toMatchObject({
      name: '@deepseek-ai/dsh-runtime-broker',
      config: { tools: [] },
    })
    expect(['subprocess-broker', 'fs-broker', 'bash', 'runtime-broker-tools'].every(
      id => entries.find(entry => entry.id === id)?.disabled !== true,
    )).toBe(true)
    expect(entries.find(entry => entry.id === 'tool-fs-search')?.config).toEqual({
      sampleOverCapGlobResults: false,
      ripgrepPath: 'rg',
    })
    expect(entries.find(entry => entry.id === 'skill-filesystem')?.config).toEqual({
      includeDefaultRoots: false,
      customSkillDirs: ['/workspace/.skills'],
      watch: false,
    })

    const forbidden = /(?:web|sandbox|spill|telemetry)/
    expect(entries.filter(entry => entry.disabled !== true && forbidden.test(entry.name ?? ''))).toEqual([])
  })
})
