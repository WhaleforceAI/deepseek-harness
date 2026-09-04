---
description: "Agent Runtime broker-backed filesystem provider for ctx.fs."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-broker

## Summary

`dsh-fs-broker` implements `ctx.fs` through Agent Runtime's authenticated run-local broker. File operations use the broker's `stat_file`, `read_file`, `write_file`, and `list_files` capabilities, so the Harness process does not require direct filesystem access.

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

Mount the provider with the same socket path and secret used by `dsh-runtime-broker` consumers. Relative paths resolve from `/workspace` unless `cwd` overrides it.

```yaml
- name: '@deepseek-ai/dsh-fs-broker'
  config:
    socketPath: /run/agent-runtime/broker.sock
    secret: broker-secret-from-the-run
    cwd: /workspace
```

| Field | Default | Meaning |
|---|---|---|
| `socketPath` | required | Absolute Unix-socket path for the run-local broker. |
| `secret` | required | Broker authentication secret. |
| `cwd` | `/workspace` | Base path for relative requests; it is not a containment boundary. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-fs-broker) is the exhaustive source for accepted configuration fields.

Broker responses are validated at the JSON transport boundary. `stat_file` must return `type`, `mtime_ms`, and, for regular files, `size`; an optional `mode` preserves an existing file's permission bits. A missing result (or `exists: false`) maps to `undefined`. `read_file` uses base64 so raw byte reads round-trip without text decoding, while `write_file` receives UTF-8 text. `sandboxMode` is `undefined`: this provider does not enforce a filesystem sandbox. The provider reports `FsError` codes and preserves the filesystem seam's guard ordering: it checks an edit version before literal matching and rejects stale writes with `FS_STALE_VERSION`.

<a id="understand-the-implementation"></a>
## Understand the implementation

`readBytes` and `streamText` request base64 ranges, decode one range at a time, and never issue a range outside the broker schema. `streamText` keeps one fatal UTF-8 decoder across ranges, so a multibyte character split across two broker reads remains valid. `writeText` sends UTF-8 text verbatim; raw-byte writes are not part of `ctx.fs`.

The provider uses the same in-process per-target FIFO lock and guard ordering as the local and E2B backends. It cannot make the broker's independent requests atomic: the broker remains the owner of any cross-client conditional write or publication primitive.

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — filesystem provider behavior and error codes.
- [Filesystem Service Definition](../../fs/fs/README.md) — the `ctx.fs` interface consumed here.
- [Runtime broker](../broker/src/index.ts) — authenticated Unix-socket transport reused by this provider.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-fs`, which renders filesystem results and typed errors.

#### KV Cache effect

No direct invalidation; the filesystem tool consumer owns result retention.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Broker protocol has no atomic filesystem primitive** — the provider serializes mutations only within its process. Guarded writes and edits are read-check-write sequences, so another broker client can still change a file between the check and `write_file`. Add a broker-side conditional write/version API before claiming cross-client atomicity.
- **Result fields are an integration assumption** — the supplied broker contract defines request schemas only. This provider requires the validated result fields documented above; add an explicit response schema to the broker contract when it becomes owned by the runtime. A bridge timeout or disconnect after `write_file` is delivered can leave publication successful but unacknowledged because the protocol has no transaction-status lookup.
- **Broker ceilings bound complete operations** — reads stop before the maximum valid offset plus one read window (1,074,790,400 bytes), writes reject UTF-8 text over 1,048,576 characters, and a 10,000-entry listing rejects because the broker offers no continuation token. Add a paginated listing and large-content protocol before the seam claims complete results beyond those limits.
- **Normalized paths are not canonical identities** — `resolve()` normalizes paths but cannot follow symlinks through the request-only broker API, so two aliases to the same file do not share a target key or in-process mutation lock. Add a broker canonical-path operation before relying on alias-safe stale guards.
- **Permission preservation depends on `stat_file.mode`** — new files request mode `0o600`; existing files retain their bits only when the broker reports `mode`. Add that response field and a broker-side conditional write before treating broker writes as equivalent to the local/E2B atomic publication path.

<a id="dev-note"></a>
## Dev Note

None.
