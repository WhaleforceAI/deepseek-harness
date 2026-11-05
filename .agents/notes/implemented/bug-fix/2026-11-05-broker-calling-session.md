# Agent Note: Broker calling session identity

Status: implemented

## Problem

Run-scoped broker authentication does not distinguish native tool calls made by the root agent from calls made by child agents. Operations that address the calling session need the actual execution owner.

## Decision

The [Runtime broker](../../../../packages/runtime/broker/README.md) forwards `exec.agent.session.id` as optional top-level `session_id` and `exec.callId` as optional `tool_call_id`. The shared bridge accepts this metadata separately from operation arguments. Calls without execution identity omit the fields.

## Alternatives considered

**Run-level identity alone.** A run can contain multiple agents, so its root session cannot identify every caller.

**Identity inside tool arguments.** Tool arguments belong to the operation schema and can contain unrelated command-session identifiers; execution metadata belongs to the bridge request.

## Consequences

Native operations can select the calling Harness session without altering tool schemas or model-visible arguments. Filesystem and subprocess providers invoke the shared bridge without tool execution input; the bridge attributes those calls to `ctx.agents.currentInitiator()`, the Agent that initiated the current asynchronous chain, and omits the session for agentless calls. Explicit execution identity takes precedence. Focused socket tests cover distinct root and child identities and omitted metadata.
