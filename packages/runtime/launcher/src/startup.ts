/**
 * Packaged entry for the Agent Runtime's Python SDK runtime.
 *
 * Kept separate from `index.ts` so the launcher's functions can be imported
 * by tests without booting, while this module boots unconditionally. It must
 * not guard on `realpath(process.argv[1])`: inside the packaged executable's
 * snapshot filesystem that call fails with ENOENT before anything mounts.
 *
 * @module @deepseek-ai/dsh-runtime-launcher/startup
 */

import { NAME, runJsonrpcAgent } from './index.ts'

await runJsonrpcAgent().catch((error: unknown) => {
  process.stderr.write(`${NAME}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
