import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { composeProfile, parseLaunchArgs } from '../src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const launcher = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const sdkStartup = fileURLToPath(new URL('../../../bundle/sdk-app/src/index.ts', import.meta.url))
const roots: string[] = []
const originalHome = process.env.DSH_HOME
const originalTelemetry = process.env.DSH_TELEMETRY_DISABLED

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  if (originalTelemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED
  else process.env.DSH_TELEMETRY_DISABLED = originalTelemetry
})

function expectUsage(argv: readonly string[]): void {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  expect(() => parseLaunchArgs(argv)).toThrow('exit')
  expect(exit).toHaveBeenCalledWith(2)
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('usage: dsh-jsonrpc-agent --profile <name>'))
  vi.restoreAllMocks()
}

describe('parseLaunchArgs', () => {
  it('preserves argv and repeated patch order', () => {
    const argv = Object.freeze(['--profile', 'sdk', '--patch', '/first.yml', '--patch', '/second.yml'])
    expect(parseLaunchArgs(argv)).toEqual({ profile: 'sdk', patches: ['/first.yml', '/second.yml'] })
    expect(argv).toEqual(['--profile', 'sdk', '--patch', '/first.yml', '--patch', '/second.yml'])
  })

  it('prints usage and exits 2 for invalid launcher arguments', () => {
    expectUsage([])
    expectUsage(['--profile'])
    expectUsage(['--profile', 'sdk', '--unknown', 'value'])
    expectUsage(['--profile', 'sdk', '--patch', 'relative.yml'])
    expectUsage(['--profile', 'sdk', '--profile', 'again'])
  })
})

function writeBundle(profileDir: string, name: string, patch: string): void {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version: '0.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }) + '\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
}

function stageProfile(withTelemetry = true): { home: string; profileDir: string; overlays: string[] } {
  const home = temp('dsh-launcher-profile-')
  const profileDir = join(home, 'profiles', 'layered')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-layered', private: true,
    dependencies: { 'spec-base': '0.0.0', 'spec-sdk': '0.0.0' },
    dsh: { profile: { bundles: ['spec-base', 'spec-sdk'], patchReload: 'startup' } },
  }) + '\n')
  const telemetryRow = withTelemetry
    ? "    - id: session-telemetry-otel\n      name: 'data:text/javascript,export function apply(){}'\n"
    : ''
  writeBundle(profileDir, 'spec-base', [
    '- insert:', '    - id: layer-marker',
    "      name: 'data:text/javascript,export function apply(){}'",
    '      config: { source: base }', telemetryRow.trimEnd(), '',
  ].filter(Boolean).join('\n'))
  writeBundle(profileDir, 'spec-sdk', '- id: layer-marker\n  config: { source: sdk }\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: layer-marker\n  config: { source: profile }\n')
  writeFileSync(join(profileDir, 'cordis.yml'), '- id: stale\n  name: stale\n')
  writeFileSync(join(home, 'cordis.patch.yml'), '- id: layer-marker\n  config: { source: home }\n')
  const overlays = ['first', 'second'].map((source) => {
    const path = join(home, `${source}.yml`)
    writeFileSync(path, `- id: layer-marker\n  config: { source: ${source} }\n`)
    return path
  })
  return { home, profileDir, overlays }
}

describe('composeProfile', () => {
  it.each(['0', 'false'])('keeps layer order and treats telemetry value %j as disabled', async (value) => {
    const { home, profileDir, overlays } = stageProfile()
    process.env.DSH_HOME = home
    process.env.DSH_TELEMETRY_DISABLED = value
    const { profile, patches } = await composeProfile('layered', overlays)
    expect(profile.dir).toBe(profileDir)
    expect(readFileSync(join(profileDir, 'cordis.yml'), 'utf8')).toContain('[]')
    expect(readFileSync(join(profileDir, 'cordis.yml'), 'utf8')).not.toContain('stale')
    expect(patches.slice(1, -1).map(patch => (patch.config as { source: string }).source))
      .toEqual(['sdk', 'profile', 'home', 'first', 'second'])
    expect(patches.at(-1)).toEqual({ id: 'session-telemetry-otel', disabled: true })
    expect(composeEntries([patches]).find(row => row.id === 'layer-marker')?.config)
      .toEqual({ source: 'second' })
  })

  it('does not append a telemetry patch when the composition has no telemetry row', async () => {
    const { home, overlays } = stageProfile(false)
    process.env.DSH_HOME = home
    process.env.DSH_TELEMETRY_DISABLED = 'false'
    const { patches } = await composeProfile('layered', overlays)
    expect(patches.some(patch => patch.id === 'session-telemetry-otel')).toBe(false)
  })

  it.each([undefined, ''])('keeps telemetry enabled for value %j', async (value) => {
    const { home, overlays } = stageProfile()
    process.env.DSH_HOME = home
    if (value === undefined) delete process.env.DSH_TELEMETRY_DISABLED
    else process.env.DSH_TELEMETRY_DISABLED = value
    const { patches } = await composeProfile('layered', overlays)
    expect(patches.some(patch => patch.id === 'session-telemetry-otel')).toBe(false)
  })
})

function runWithClosedStdin(home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', launcher, '--profile', 'broken'], {
      cwd: repoRoot, env: { ...process.env, DSH_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`launcher did not exit after stdin EOF; stderr=${stderr}`))
    }, 10_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end()
  })
}

describe('stdio startup lifecycle', () => {
  it('keeps EOF from hiding a startup failure', async () => {
    const home = temp('dsh-launcher-eof-')
    const profileDir = join(home, 'profiles', 'broken')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-broken', private: true, dependencies: {},
      dsh: { profile: { bundles: [], patchReload: 'startup' } },
    }) + '\n')
    const failurePlugin = join(home, 'fail-after-eof.mjs')
    writeFileSync(failurePlugin, [
      "export const inject = ['sdkAppStartup']",
      'export async function apply() {',
      '  process.stdin.resume()',
      "  if (!process.stdin.readableEnded) await new Promise(resolve => process.stdin.once('end', resolve))",
      "  throw new Error('startup failed after stdin EOF')",
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- insert:', '    - id: sdk-app-startup',
      `      name: ${JSON.stringify(pathToFileURL(sdkStartup).href)}`,
      '    - id: startup-failure',
      `      name: ${JSON.stringify(pathToFileURL(failurePlugin).href)}`,
      '      inject: [sdkAppStartup]',
      '',
    ].join('\n'))
    const result = await runWithClosedStdin(home)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/dsh-jsonrpc-agent:.*startup failed after stdin EOF/s)
  }, 20_000)
})
