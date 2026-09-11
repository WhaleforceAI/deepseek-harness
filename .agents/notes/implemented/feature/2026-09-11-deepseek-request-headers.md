# Agent Note: Static DeepSeek observability request headers

Status: implemented

English | [中文](2026-09-11-deepseek-request-headers.zh.md)

## Problem

Agent Runtime needs to correlate provider traffic with host-owned traces, spans, projects, and threads. These static, non-secret values belong in HTTP metadata sent to the configured gateway, without entering model input or replacing harness-owned authentication and identity.

## Decision

The DeepSeek plugin accepts optional `requestHeaders` for chat and Files API requests. The [package README](../../../../packages/llm/llm-deepseek/README.md#static-request-headers) owns the complete validation rules: at most 32 entries, HTTP token names, case-insensitive reserved-name exclusion, and non-empty ASCII strings of at most 4096 bytes without any control characters, including horizontal tab. Authorization, content negotiation, framing, connection control, User-Agent, and the `x-deepseek-harness-` prefix remain reserved.

`resolveAdapterOptions` validates and copies headers before `apply` registers the provider. Invalid entries throw `LlmError` with code `INVALID_REQUEST_HEADER`, identifying the name and reason without including the value. The schema leaves this validation to the resolver because generic schema type errors can echo rejected values. Invalid live settings preserve the whole last-good configuration, including its endpoint and credential reference.

Chat requests and the Files client spread custom headers before harness-owned headers. Values remain outside request bodies, model-request defaults, telemetry, and session events. `request/header` is the agent loop's model-options event, not an HTTP-header log. The [app attribution decision](../architecture/2026-06-21-mandatory-app-attribution-headers.md) and [request identity decision](2026-08-11-deepseek-request-user-id-header.md) retain ownership of their headers.

## Verification

Mock-server tests inspect chat and Files headers on the wire, preserve owned authorization, and compare omitted versus empty config. Resolver and plugin-load tests cover reserved names and bounds; log capture checks successful requests and rejected settings without exposing values. The real Loader composition checks configuration propagation. No transcript snapshot changes because these values are not model-visible or user-visible transcript content.

## Alternatives considered

**Provider-specific config fields:** a generic bounded record supports the host's current correlation headers without adding an adapter option for each observability product.

**Request-body metadata:** provider schemas and model-request reconstruction would gain fields unrelated to model input.

**Request-time validation:** invalid deployment configuration would register a route and fail only when used; the existing resolution step rejects it before registration.

## Consequences

Hosts can correlate chat and Files traffic at the configured endpoint while harness-owned headers retain precedence. Header values must be non-secret, and configured gateways receive them. Static configuration cannot derive a new span for each request; the host owns the supplied values and their lifetime.
