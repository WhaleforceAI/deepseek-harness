---
description: "Agent Runtime broker-backed subprocess provider for ctx.subprocess."
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess-broker

## Summary

`dsh-subprocess-broker` implements `ctx.subprocess` through Agent Runtime's authenticated run-local broker. Ordinary processes use the broker's exact `argv` form, and terminal processes add `tty: true`; both use `write_stdin` to poll, write, close, and kill the remote session.

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

Mount `dsh-runtime-broker` first; this provider injects its shared `ctx.runtimeBroker` service. Configure the run socket path and secret on that owner. Load ordinary subprocess consumers such as `dsh-bash-local`, `dsh-terminal-bash`, and `dsh-lsp-stdio` above it.

```yaml
- name: '@deepseek-ai/dsh-subprocess-broker'
  config:
    cwd: /workspace
    pollMs: 100
```

| Field | Default | Meaning |
|---|---|---|
| `cwd` | `/workspace` | Working directory used by executable lookup. |
| `pollMs` | `100` | Delay between remote command status polls. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subprocess-broker) is the exhaustive source for accepted configuration fields.

<a id="understand-the-implementation"></a>
## Understand the implementation

`spawn()` sends the supplied argument array unchanged as `argv`; it never converts the request into a shell string. The first broker response publishes the session, then bounded host-side readers append each polling response. `spawnTerminal()` uses the same lifecycle with `tty: true`, a writable input adapter, and one combined terminal output stream. Abort and service disposal issue the broker's `kill` action and await the final response.

Quota exhaustion is terminal for the shared run. Handles preserve the first quota error, including when another provider triggers cancellation. Ordinary `kill` calls also consume quota, so exhaustion delegates remote cleanup to Python Runtime's quota-exempt run completion; local handle settlement alone does not confirm remote termination.

`resolveExecutable()` follows the subprocess Service Definition: it rejects relative paths containing `/`, verifies absolute paths with `test`, and resolves bare names with `command -v` in the remote world. Shell syntax is restricted to that provider-owned lookup operation and is never used for `spawn()`.

<a id="further-exploration"></a>
## Further Exploration

- [Subprocess Service Definition](../../subprocess/subprocess/README.md) — the `ctx.subprocess` interface consumed here.
- [E2B subprocess provider](../../e2b/subprocess-e2b/README.md) — the provider whose execution-world placement this package mirrors.
- [Runtime broker](../broker/src/index.ts) — authenticated Unix-socket transport reused by this provider.

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumers such as `dsh-bash-local`, filesystem search, terminal, and LSP providers.

#### KV Cache effect

No direct invalidation; each consumer owns its model-visible presentation.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The broker request has no environment field** — explicit `SubprocessSpawnSpec.env` entries cannot be forwarded. The remote image and broker process environment therefore own command environment setup. Add an `env` object to `command.start` before relying on per-spawn environment overrides.
- **Termination is one broker kill operation** — `command.input` exposes `kill`, but no separate process-group `SIGTERM` and `SIGKILL` operations or liveness query. `graceMs` is validated but cannot drive the Service Definition's TERM-to-KILL escalation, and whole-tree quiescence is only as strong as the broker's session settlement.
- **The response schema is an integration assumption** — the supplied contract defines requests only. This provider validates and consumes `output`, `stdout`, `stderr`, `exit_code`, `signal`, `session_id`, and `truncated`, matching the retired shell provider. Publish these response fields in the broker contract before treating them as independently versioned.
- **Collected output has no complete spill** — broker responses can be truncated and expose no full-output file. The provider retains the requested in-memory tail and reports lossy reads, but cannot populate `spillPath` even when a caller requests spill collection.
- **Remote process identity is unavailable** — handles expose `pid: -1`, and the broker has no process-tree liveness operation. `waitForExit()` therefore observes broker-session completion, not an independently verified descendant tree.
- **Terminal control is limited to text input and session kill** — the protocol accepts `tty: true` but has no row/column allocation fields, foreground-group inspection, or targeted signal operation. `rows` and `cols` cannot be forwarded, `inspectForeground()` returns `undefined`, and `signalForeground()` rejects.
- **Output is text-only and polled** — broker responses return bounded JSON strings rather than byte frames or live streams. Raw pipe projection is therefore polling-based, broker truncation is not recoverable for pipe callers, and collected byte offsets are UTF-8 reconstructions that cannot prove byte-faithful delivery for arbitrary non-text command output.

<a id="dev-note"></a>
## Dev Note

None.
