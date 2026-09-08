# Agent Note: Run-owned broker discovery observations

Status: implemented

English | [中文](2026-09-08-broker-run-discovery-cache.zh.md)

## Problem

Repeated context discovery consumes remote request quota even when workspace metadata is unchanged. Separate filesystem, subprocess, and native-tool bridges cannot observe each other's mutations or stop retries consistently after exhaustion.

## Decision

One Cordis-owned bridge represents the Runtime run lease. It owns mutation generations, pending writes, a command-dispatched latch, and the first validated quota denial. The filesystem provider keeps at most 256 discovery observations, admits fills only in the same inactive generation, and preserves structured workspace denials. Internal content and mutation checks remain live. Native listings reach the same contradiction check.

Discovery reuse is an explicit opt-in for run-exclusive workspaces. The first command or stdin dispatch disables reuse until disposal, including successful commands: a completed broker session can leave detached descendants that continue to modify files. Full generation invalidation replaces path-specific dependency tracking because commands can modify arbitrary authorized paths.

Any quota denial stops this harness run, even if another operation could have a higher limit. Existing hook cancellation aborts the current activity and records the quota message in the session, including discovery before the first model request; bridge guards block subsequent requests. Python Runtime preserves the typed quota failure independently of the session cancellation record and completes the remote run through its quota-exempt control path. Cleanup failure remains separate from the original denial.

## Alternatives considered

**Increase the budget.** This postpones exhaustion while preserving repeated discovery costs and retry loops.

**Cache every stat.** Content reads and edit guards need fresh metadata; a broad cache can conceal concurrent mutation or stale versions.

**Separate per-provider invalidation.** Native tools and persistent command sessions mutate the same workspace, so provider-local ownership misses current writers.

**Introduce another cancellation event.** Python already owns the broker lease and terminal failure. Existing cancellation plus that owner preserves failure reporting without another session schema variant.

## Consequences

Unchanged discovery intervals before the first command reuse bounded observations. Every discovery after a command stays live until run disposal, so whole-run request counts depend on the first command and later traffic. Workspaces with unobserved writers keep caching disabled. Local checks do not establish deployed ownership or remote cleanup; hosted acceptance remains necessary.
