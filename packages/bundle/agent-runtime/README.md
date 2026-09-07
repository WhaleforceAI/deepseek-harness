---
description: "Agent Runtime profile layer for brokered SDK execution."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-agent-runtime`

## Summary

This bundle layers after [`dsh-base`](../base/README.md) and [`dsh-sdk-app`](../sdk-app/README.md). It routes filesystem and subprocess work through Agent Runtime's authenticated run-local broker, mounts the ordinary Bash executor over that subprocess provider, and keeps the agent workspace at `/workspace`.

It disables local sandbox providers, interactive tools, direct Web access, telemetry, and local spill storage. Skill discovery reads only `/workspace/.skills`, where the Runtime uploads the run's skill bundle, and filesystem search calls the sandbox's `rg` executable.

## Use this package

Compose profile bundles in this order:

```json
[
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-sdk-app",
  "@deepseek-ai/dsh-agent-runtime"
]
```

The bundle deliberately omits broker `socketPath` and `secret` values. Supply both fields for `subprocess-broker`, `fs-broker`, and `runtime-broker-tools` in a final per-run patch. That patch also owns Runtime-specific session and storage roots, the model adapter, system prompt, and any native broker tool declarations.

Set `DSH_TELEMETRY_DISABLED=1` in the Harness environment as the process-level telemetry opt-out in addition to this layer's disabled telemetry row.

## Model Experience

### What the model sees

The SDK coding-agent persona and the retained base tools remain visible. Approval, questions, slash commands, plan mode, PowerShell, Web, telemetry, and spill tools are absent; Bash and filesystem tools operate on the broker's `/workspace`.

### Token effect

The disabled interactive and Web rows contribute no tool schemas or prompt sections. The retained tool set varies only through later per-run patches.

### KV Cache effect

The bundle is static for a profile process. Per-run model, prompt, and native broker tool changes affect the corresponding session request.

## Known Limitations and Deferred Work

Local spill files stay disabled because their Harness-container paths cannot be read through the brokered filesystem. Add a broker-backed spill provider before enabling spill policy.

**Runtime invariant:** No companion is published. The bundle owns static composition only; its focused composition test verifies every override resolves and that host-only providers remain disabled.
