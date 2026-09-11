# Agent Note: Agent Runtime pins from the `agent-runtime-pin` branch

Status: implemented

## Problem

Whaleforce Agent Runtime vendors this fork and stages the SDK runtime's Node closure (`python/sdk-runtime`) into its DeepSeek image. That staging refuses any package that is, or declares a dependency on, an MCP-capable package (`@modelcontextprotocol/sdk`, `@google/genai`, …), and Agent Runtime composes exactly one LLM provider (`@deepseek-ai/dsh-llm-deepseek`, routed to LiteLLM) through its own cordis overlay.

`master` mirrors upstream deepseek-harness, whose releases embrace MCP: the 0.1.2-alpha.5 sync (`49a606bc`) mounted the pi-ai provider in the base bundle and added `@modelcontextprotocol/sdk` to the deploy-root graph. Re-pruning such packages after every sync (fork PRs #5 and #6) is a losing race and turns every runtime pin bump into an audit of upstream's dependency graph.

## Decision

Agent Runtime pins are cut from the `agent-runtime-pin` branch, not from `master`. The branch starts at `8cf92e63`, the revision Agent Runtime already ran in production (closure clean, SDK API `session_root`/`cordis`/`runtime_bin`), and receives only changes Agent Runtime needs, cherry-picked and reviewed by pull request into the branch (first: the `dsh-llm-deepseek` `requestHeaders` plugin config). `agent-runtime-pin-X.Y.Z` tags point at commits on this branch; Agent Runtime's `harness.lock.toml`, submodule pointer, and `tests/test_pins.py` reference the tagged revision.

`master` keeps tracking upstream for everything else. Moving the pin branch forward to a newer upstream base is a deliberate, separate task: rebase or merge, then prove the staged closure is free of MCP-bearing packages before tagging.

## Verification

- Agent Runtime's `Verify Agent Runtime` job builds and stages the closure at the tagged revision and runs the plugin's wire-level tests.
- `tests/test_pins.py` in Agent Runtime asserts the reviewed revision and that the deploy root contains only `dsh-llm-deepseek` as the LLM provider.
