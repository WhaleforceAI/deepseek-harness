#!/usr/bin/env node
/**
 * Packaged entry point for the Agent Runtime's Python SDK runtime.
 *
 * The upstream build packages the full `dsh` CLI as the runtime executable's
 * entry. Agent Runtime cannot ship that closure: the CLI declares the MCP
 * client and the ACP app, and the base bundle it carries reaches Google's
 * generative-AI SDK through the pi-ai provider — all of which the Runtime's
 * staged-closure scanner rejects outright.
 *
 * The package names are deliberately spelled out nowhere in this file: the
 * scanner also byte-searches the packaged executable for them, so naming one
 * even in a comment would fail the very check this launcher exists to pass.
 *
 * This launcher composes a named profile and ordered patches once at startup.
 * The SDK owns stdio; readiness is published only after the Loader settles.
 *
 * @module @deepseek-ai/dsh-runtime-launcher
 */

import { writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'

export const NAME = 'dsh-jsonrpc-agent'
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/**
 * Parse the stdio launcher's profile and ordered absolute patch paths.
 * @param argv - launcher arguments without the executable prefix.
 * @returns the selected profile and overlays; invalid arguments exit 2.
 */
export function parseLaunchArgs(argv: readonly string[]): { profile: string; patches: string[] } {
  const usage = (): never => {
    process.stderr.write(`usage: ${NAME} --profile <name> [--patch <absolute-path>]...\n`)
    process.exit(2)
  }
  let profile: string | undefined
  const patches: string[] = []
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!value || value.startsWith('-')) return usage()
    if (flag === '--profile' && profile === undefined) profile = value
    else if (flag === '--patch' && isAbsolute(value)) patches.push(value)
    else return usage()
  }
  if (profile === undefined) return usage()
  return { profile, patches }
}

/**
 * Load a profile and apply startup layers in their precedence order.
 * @param name - shipped or existing custom profile name.
 * @param patchFiles - absolute overlay paths in argv order.
 * @returns the profile and complete ordered patch list.
 */
export async function composeProfile(name: string, patchFiles: readonly string[]): Promise<{
  profile: ReturnType<typeof loadProfile>
  patches: NonNullable<Parameters<typeof boot>[2]>
}> {
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR)
  // Loader write-back can persist composed inserts. Reset its resolution root
  // every boot so those rows cannot be inserted twice; customization is a patch.
  writeFileSync(join(profile.dir, 'cordis.yml'), PROFILE_ROOT_CONFIG)
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile })
  const layers = [
    profile.layers.flatMap(layer => layer.patches),
    profile.patches,
    loadOptionalPatches(NAME, join(resolveDshHome(), 'cordis.patch.yml')) ?? [],
    ...patchFiles.map(file => loadOverlayPatches(NAME, file)),
  ]
  const patches = layers.flat()
  if ((process.env.DSH_TELEMETRY_DISABLED ?? '') !== ''
    && composeEntries(layers).some(row => row.id === 'session-telemetry-otel')) {
    patches.push({ id: 'session-telemetry-otel', disabled: true })
  }
  return { profile, patches }
}

/** Successful startup is a launcher fact, never inferred from stdin EOF. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/**
 * Boot the selected profile and own bounded process shutdown.
 * @param argv - launcher arguments; defaults to the process invocation.
 */
export async function runJsonrpcAgent(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const invocation = parseLaunchArgs(argv)
  const environment = loadLayeredEnv(NAME)
  const { profile, patches } = await composeProfile(invocation.profile, invocation.patches)
  let root: Context | undefined
  let pending: Promise<void> | undefined
  const signalShutdown = new AbortController()
  const appReady = createAppReady()
  const dispose = async (): Promise<void> => { await root?.fiber.dispose() }
  const shutdown = (code: number, forceAfterDispose = false): Promise<void> => {
    if (pending !== undefined) return pending
    const timeout = setTimeout(() => { process.exit(code) }, 5_000)
    pending = Promise.resolve().then(dispose).then(
      () => {
        clearTimeout(timeout)
        if (forceAfterDispose) process.exit(code)
        process.exitCode = code
      },
      () => { process.exit(code) },
    )
    return pending
  }
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    if (pending !== undefined) process.exit(code)
    void shutdown(code, true)
  }
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, dispose)

  root = await boot(NAME, join(profile.dir, 'cordis.yml'), patches, (ctx) => {
    root = ctx
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    provideCmdline(ctx, {
      args: Object.freeze([]),
      exit: code => void shutdown(code),
      ready: appReady.service,
    })
  })
  if (!signalShutdown.signal.aborted
    && root.fiber.state === FiberState.ACTIVE
    && root.get('loader') !== undefined) {
    appReady.commit()
  }
}

// Resolve bin symlinks too: the installed npm bin and packaged entry share this module.
