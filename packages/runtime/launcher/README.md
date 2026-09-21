---
description: "Profile launcher for the packaged Agent Runtime stdio process."
kind: "package-reference"
---

# `@deepseek-ai/dsh-runtime-launcher`

## Summary

`dsh-jsonrpc-agent --profile <name> [--patch <absolute-path>]...` boots one named profile through the public app-boot APIs. Its installation manifest supplies bundle and plugin resolution. Custom profiles keep their own manifests; shipped names initialize through app-boot.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The launcher applies bundle, profile, home, and ordered command-line patches at startup, followed by the telemetry opt-out when its row exists. It publishes the layered environment snapshot and an immutable empty command line before mounting plugins. Loader settlement commits readiness; stdin EOF waits for that signal through the SDK startup plugin. SIGTERM exits 0 and SIGINT exits 130 after disposal, bounded to five seconds; another signal exits immediately. Invalid arguments write usage to stderr and exit 2. Startup errors exit 1. Stdout belongs to the protocol.

Compose [`agent-runtime`](../../bundle/agent-runtime/README.md) over base and sdk-app in the selected profile, with broker connection fields supplied by a per-run overlay.

<a id="model-experience"></a>
## Model Experience

### Profile-owned model context

#### What the model sees

The launcher contributes no prompt or tool schema; the selected bundles and overlays own model input.

#### Token effect

No direct token contribution.

#### KV Cache effect

No direct cache effect; composition remains fixed for the process lifetime.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Profile patch reload settings do not enable live reload in this launcher. Trusted plugins can write to stdout, so arbitrary external composition is not a stdout isolation mechanism. Packaged module resolution and the executable closure require built-artifact acceptance in addition to source tests.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Readiness and shutdown are process lifecycle facts covered by launcher subprocess tests, not independently diverging service observations.
