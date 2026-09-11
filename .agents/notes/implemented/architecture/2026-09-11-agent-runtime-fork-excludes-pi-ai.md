# Agent Note: This fork's base bundle excludes the pi-ai provider

Status: implemented

## Problem

WhaleforceAI/deepseek-harness is the harness line that Whaleforce Agent Runtime vendors and pins (`agent-runtime-pin-*` tags). Agent Runtime stages the SDK runtime's Node closure (`python/sdk-runtime`) into its DeepSeek image and refuses any package in that closure that declares an MCP-capable dependency; `@earendil-works/pi-ai` (behind `@deepseek-ai/dsh-llm-pi-ai`) declares `@google/genai`, so every path from the deploy root to `dsh-llm-pi-ai` fails the image build (`forbidden MCP dependency declaration in staged Node closure: @google/genai`). Agent Runtime also selects exactly one LLM provider, `@deepseek-ai/dsh-llm-deepseek`, through its own cordis overlay and routes it to LiteLLM.

Earlier fork commits removed `dsh-llm-pi-ai` from the deploy root itself (#1, "prune unused pi-ai provider"; "keep MCP-bearing pi-ai out of closure"; #5 on master). The upstream sync merged in `49a606bc` added a dormant `llm-pi-ai` mount to `@deepseek-ai/dsh-base`, which the deploy root reaches through `@deepseek-ai/dsh`, reopening the path.

## Decision

In this fork the base bundle does not depend on or mount `@deepseek-ai/dsh-llm-pi-ai`. The dormant mount (zero routes until an `llm-pi-ai:` settings section exists) is an upstream feature for interactive users of the web Models page; this fork serves Agent Runtime, where provider composition is owned by the runtime's overlay and pi-ai profiles are never configured. Users who want pi-ai providers use upstream deepseek-harness.

Each upstream sync must re-apply this exclusion (base bundle manifest, `cordis.patch.yml`, lockfile) before a new `agent-runtime-pin-*` tag is cut; Agent Runtime's `tests/test_pins.py` and its closure staging enforce it on the consuming side.

## Verification

- `packages/bundle/base` tests pass without the mount.
- Agent Runtime's `Verify Agent Runtime` job (Node-closure staging) passes at the tagged revision.
