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
| `stdinPollYieldMs` | `3000` | Minimum `yield_time_ms` for a model `write_stdin` call that only polls a command (no `chars`, no termination); `0` disables it. The broker returns as soon as the command exits. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-runtime-broker) owns the complete configuration. Enable `cacheDiscovery` only when every workspace mutation passes through this run's broker operations.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [bridge owner](src/index.ts) advances its generation before mutation dispatch and after settlement. Pending mutations and live command sessions block discovery reuse and fills; writes clear cached observations. Each command or stdin dispatch advances the command epoch. Once all command sessions finish, the next discovery inspection revalidates cached observations through parent-directory listings before reuse; concurrent inspections share that check once per epoch. Successful native listings notify the filesystem provider so contradictory observations invalidate its cache.

A command result with a nonempty string or nonnegative safe-integer `session_id` retains a live session. Completion requires an omitted `session_id` and either an integer `exit_code` from 0 through 255 or a `SIG*` signal; a completed `write_stdin` clears only its addressed session. Dispatch epochs prevent delayed yields from reviving completed sessions and delayed completions from clearing newer running observations. Unknown results and invocation failures retain an addressed stdin session until a later definitive completion. An uncertain command without an addressed session, or a stdin response naming a different session, disables discovery caching for the rest of the lease. A timeout flag or `complete` field alone does not prove completion.

`BrokerInvokeError` retains the validated broker rejection's `code` and HTTP `status`. The first `run_quota_exceeded` latches that error, aborts in-flight bridge requests, cancels agents, and rejects further ordinary operations before opening a socket. The session records hook cancellation with `runtime-broker: run_quota_exceeded`, including denial before the first model request. Python Runtime preserves the typed terminal failure independently of the session cancellation event and owns quota-exempt remote completion. Cordis disposal closes the bridge and unregisters native tools; a new run creates fresh state.

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
- **Epoch revalidation does not prove process-tree quiescence.** Detached descendants can mutate files after the check. Keep `cacheDiscovery` disabled when those mutations cannot be observed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
