# Agent Note: Explicit OpenAI-compatible DeepSeek wire dialect

Status: implemented

English | [中文](2026-09-01-explicit-openai-compatible-deepseek-dialect.zh.md)

## Problem

`dsh-llm-deepseek` can send chat-completions requests either to DeepSeek or to a generic OpenAI-compatible gateway selected by `Config.baseURL`. Those endpoints do not accept the same request vocabulary: DeepSeek uses top-level `thinking` and `reasoning_effort` plus assistant-history `reasoning_content`, while a strict generic gateway may reject all three as unknown fields.

The adapter previously had no endpoint dialect. It always advertised reasoning efforts and serialized the DeepSeek fields, so changing only `baseURL` could produce a request that failed before inference. Treating generic gateways as reasoning-capable also let the agent loop select a default that the configured endpoint did not support.

## Decision

`Config.wireDialect` explicitly selects `deepseek` or `openai-compatible` and defaults to `deepseek`, preserving the public DeepSeek route. The resolved request defaults always carry the selected dialect so model discovery, text serialization, and image serialization judge the same endpoint vocabulary.

The `openai-compatible` dialect publishes no reasoning capability or default. Its requests omit top-level `thinking` and `reasoning_effort`, and assistant history omits `reasoning_content`, while standard system, user, assistant, tool-call, tool-result, streaming, usage, and finish semantics remain unchanged. Combining the generic dialect with `thinking` or `reasoningEffort` fails configuration resolution because those policy values cannot take effect.

DeepSeek-dialect assistant history retains the passback behavior recorded in [DeepSeek reasoning passback on every reasoned turn](2026-08-19-deepseek-reasoning-passback-every-turn.md). The explicit endpoint dialect supplies the evidence that earlier decision lacked for a safe, fail-loud exception.

## Alternatives considered

- **Infer the dialect from `baseURL`.** Hostnames do not reveal whether an internal endpoint forwards DeepSeek fields, translates them, or rejects them, so inference would turn deployment naming into an undocumented protocol rule.
- **Configure `thinking: disabled`.** That policy still advertises an `off` reasoning capability and emits `thinking: {type: "disabled"}`. It disables inference behavior but does not produce a strict generic OpenAI request.
- **Create a separate generic adapter package.** The request and streaming formats are otherwise the same. Duplicating transport, tool, image, timeout, error, and usage handling would create two implementations for one small wire-vocabulary difference.

## Consequences

Deployments behind strict gateways must select the generic dialect explicitly. A misspelled or contradictory configuration fails at load; the default remains DeepSeek-compatible for existing users.

Generic routes do not replay provider reasoning text, so later requests cannot use it to reconstruct a DeepSeek thinking signature. That is deliberate because the route neither advertises reasoning nor accepts DeepSeek passback fields. Standard visible text and tool history remain cache-stable.

## Testing

The package integration test drives the real Cordis plugin through a pure OpenAI SSE tool-call, tool-result, and final-response sequence, pins every emitted stream chunk, and compares both request bodies exactly. Serializer tests pin dialect-specific reasoning passback, and the keyless headless snapshot boots a runnable Loader composition against a strict local gateway that rejects every DeepSeek reasoning field.
