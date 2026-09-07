# Agent Note: Agent Runtime profile launcher

Status: implemented

## Problem

The packaged Python runtime needs profile composition and SDK startup semantics without carrying the interactive CLI dependency closure. Disabling a plugin row alone retains its package and transitive assets in the executable.

## Decision

The [`runtime launcher`](../../../../packages/runtime/launcher/README.md) uses public app-boot APIs and its own installation manifest. It assembles startup patches with the CLI precedence, publishes environment provenance, and commits application readiness only after Loader settlement. SDK EOF cannot report success before that commit. Signals and normal exit share bounded root disposal.

The [`Agent Runtime bundle`](../../../../packages/bundle/agent-runtime/README.md) selects broker filesystem and subprocess providers over base plus sdk-app. The Runtime supplies connection configuration through per-run overlays. Base omits the pi-ai row and dependency together; the dedicated headless compatibility fixture inserts its provider explicitly.

## Alternatives considered

**A flat-config launcher** discards named profile initialization, installation fallback resolution, environment provenance, and SDK readiness semantics.

**Disabling pi-ai in an overlay** leaves its dependency and packaged assets reachable, so it does not meet closure pruning requirements.

## Consequences

The fork maintains a small profile launcher without live reload or interactive commands. Source composition tests cover patch targets and disabled execution providers; subprocess tests cover failed startup racing EOF. Install, executable build, and byte-scanner acceptance remain distinct required artifact checks; source tests cannot establish packaged closure contents.
