# Agent Note: Explicit OpenAI-compatible DeepSeek wire dialect

Status: implemented

[English](2026-09-01-explicit-openai-compatible-deepseek-dialect.md) | 中文

## Problem

`dsh-llm-deepseek` 可以把 chat-completions 请求发送到 DeepSeek，也可以通过 `Config.baseURL` 选择通用 OpenAI 兼容网关。这两类端点接受的请求词汇并不相同：DeepSeek 使用顶层 `thinking`、`reasoning_effort` 与 assistant 历史中的 `reasoning_content`，严格的通用网关则可能把这三个字段全部当作未知字段拒绝。

适配器原先没有端点方言。它始终公布推理强度并序列化 DeepSeek 字段，因此只修改 `baseURL` 就可能生成在推理前失败的请求。把通用网关视为支持推理，也会让 agent loop 选择配置端点并不支持的默认值。

## Decision

`Config.wireDialect` 显式选择 `deepseek` 或 `openai-compatible`，并默认为 `deepseek`，从而保留公开 DeepSeek 路由的行为。解析后的请求默认值始终携带所选方言，因此模型发现、文本序列化与图片序列化会按同一套端点词汇作出判断。

`openai-compatible` 方言不公布推理能力或默认值。其请求省略顶层 `thinking` 与 `reasoning_effort`，assistant 历史也省略 `reasoning_content`，而标准 system、user、assistant、工具调用、工具结果、流式输出、usage 与 finish 语义保持不变。把通用方言与 `thinking` 或 `reasoningEffort` 组合使用会使配置解析失败，因为这些策略值无法生效。

DeepSeek 方言的 assistant 历史仍保留[每个推理轮次的 DeepSeek 推理回传](2026-08-19-deepseek-reasoning-passback-every-turn.zh.md)所记录的行为。显式端点方言为安全且明确失败的例外提供了早期决策当时缺少的证据。

## Alternatives considered

- **根据 `baseURL` 推断方言。** 主机名无法说明内部端点会转发、转换还是拒绝 DeepSeek 字段，因此推断会把部署命名变成未记录的协议规则。
- **配置 `thinking: disabled`。** 该策略仍会公布 `off` 推理能力，并发出 `thinking: {type: "disabled"}`。它会禁用推理行为，却无法生成严格的通用 OpenAI 请求。
- **创建单独的通用适配器包。** 除请求词汇的这一小处差异外，请求与流式格式完全相同。复制传输、工具、图片、超时、错误和 usage 处理，会为同一行为制造两套实现。

## Consequences

严格网关背后的部署必须显式选择通用方言。拼写错误或互相矛盾的配置会在加载时失败；现有用户的默认行为仍与 DeepSeek 相容。

通用路由不会回传提供方推理文本，因此后续请求不能用它重建 DeepSeek 思考签名。这是有意取舍，因为该路由既不公布推理，也不接受 DeepSeek 回传字段。标准可见文本与工具历史仍保持缓存稳定。

## Testing

包集成测试通过真实 Cordis 插件运行纯 OpenAI SSE 的工具调用、工具结果与最终响应序列，固定每一个输出流分片，并精确比较两份请求正文。序列化测试固定不同方言的推理回传行为；无密钥 headless snapshot 则通过 Loader 启动可运行组合，连接会拒绝全部 DeepSeek 推理字段的严格本地网关。
