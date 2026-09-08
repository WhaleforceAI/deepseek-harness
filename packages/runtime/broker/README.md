---
description: "Share Agent Runtime broker connections, stop quota-exhausted runs, and configure safe discovery reuse."
kind: "package-reference"
---

# @deepseek-ai/dsh-runtime-broker

English | [中文](README.zh.md)

## Summary

Use the Runtime broker to route native tools, filesystem access, and subprocesses through one authenticated run lease. A quota denial stops the run and blocks further ordinary requests. Discovery reuse is disabled unless the deployment explicitly confirms exclusive workspace ownership.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin once in the [Agent Runtime bundle](../../bundle/agent-runtime/cordis.patch.yml). Its `runtime-broker-tools` patch row supplies the run's `socketPath`, `secret`, and native `tools`. Filesystem and subprocess providers inject its shared `ctx.runtimeBroker` service.

| Field | Default | Meaning |
|---|---|---|
| `socketPath` | required | Absolute Unix socket path supplied by the Runtime run. |
| `secret` | required | Run authentication secret of at least 32 characters. |
| `tools` | `[]` | Native tool definitions registered with the tool registry. |
| `cacheDiscovery` | `false` | Enable discovery reuse only when this run owns every workspace writer. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-runtime-broker) owns the complete configuration. Enable `cacheDiscovery` only when every workspace mutation passes through this run's broker operations.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [bridge owner](src/index.ts) advances its generation before mutation dispatch and after settlement. Pending writes disable discovery reuse. The first command or stdin dispatch disables reuse for the rest of the run, because a completed command can leave detached descendants that still modify the workspace. Successful native listings notify the filesystem provider so contradictory observations invalidate its cache.

`BrokerInvokeError` retains the validated broker rejection's `code` and HTTP `status`. The first `run_quota_exceeded` latches that error, aborts in-flight bridge requests, cancels agents, and rejects further ordinary operations before opening a socket. Python Runtime preserves the typed terminal failure independently of the session cancellation event and owns quota-exempt remote completion. Cordis disposal closes the bridge and unregisters native tools; a new run creates fresh state.

Mutation state has one owner, with no independent runtime observation for an invariant to compare. Transport validation and focused lifecycle tests enforce its inputs and transitions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem provider](../../../docs/subsystems/filesystem.md) — bounded discovery observations and live content checks.
- [Subprocess provider](../../../docs/subsystems/subprocess.md) — remote sessions and command settlement.
- [Run ownership decision](../../../.agents/notes/implemented/bug-fix/2026-09-08-broker-run-discovery-cache.md) — invalidation and terminal-failure rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Native tools

#### What the model sees

Configured native tool descriptions and argument schemas enter the request. Successful results render as JSON text. `run_quota_exceeded` stops the run without another model request; Python Runtime reports the terminal cause to the caller.

#### Token effect

Configured schemas add request tokens; recorded calls and rendered results grow the conversation history. Discovery reuse changes broker traffic without adding model-visible content.

#### KV Cache effect

Tool definitions remain stable for one configuration. Tool calls and results append to existing history; discovery generations do not rewrite the model prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The run owner relies on these external guarantees.

- **Workspace ownership requires deployment verification.** Keep `cacheDiscovery` disabled when writers can bypass the run's broker operations.
- **Remote cleanup belongs to Python Runtime.** Local socket disposal does not prove remote-command termination; hosted acceptance must confirm quota-exempt completion independently.
- **Reuse ends at the first command.** Broker session completion does not prove that detached descendants stopped. Re-enabling reuse requires broker-provided proof that the whole process tree is quiescent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
