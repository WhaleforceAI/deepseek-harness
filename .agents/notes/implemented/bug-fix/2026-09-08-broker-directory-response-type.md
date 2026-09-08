# Agent Note: Broker directory response type

Status: implemented

English | [中文](2026-09-08-broker-directory-response-type.zh.md)

## Problem

The deployed broker emits `dir` for directories in stat and listing responses. Rejecting this value prevents skill-root enumeration; the skill registry treats the failed provider observation as incomplete and retries discovery on later model turns.

## Decision

The [broker filesystem provider](../../../../packages/runtime/fs-broker/src/index.ts) maps `dir` to the filesystem seam's `directory` in its shared stat parser. The existing `directory` representation remains valid. All other response validation and cache rules remain in force.

## Alternatives considered

**Exclude repeated skill-root stats from acceptance.** This hides unavailable skill discovery without restoring directory access.

**Change the broker's shared response type.** The provider owns translation into its filesystem seam; changing the broker would also affect consumers outside this Harness.

## Consequences

Stat, lstat, and directory entries share one normalization. The [recorded Runtime composition](../../../../snapshots/session/runtime-broker-quota/runtime-broker-fixture.mjs) supplies raw directory responses and requires skill enumeration to reach the child file probe, so silently skipping a failed skill provider fails the replay.
