# Agent Note: DeepSeek 静态可观测性请求标头

Status: implemented

[English](2026-09-11-deepseek-request-headers.md) | 中文

## 问题

Agent Runtime 需要将提供方流量与宿主拥有的 trace、span、项目和 thread 关联。这些静态、非机密值属于发往已配置 gateway 的 HTTP 元数据，不得进入模型输入，也不得替换 harness 自有的认证和身份。

## 决策

DeepSeek 插件接受可选的 `requestHeaders`，用于 chat 和 Files API 请求。[包 README](../../../../packages/llm/llm-deepseek/README.zh.md#静态请求标头) 定义完整校验规则：最多 32 个条目、HTTP token 名称、不区分大小写地排除保留名称，以及最多 4096 字节的非空 ASCII 字符串，且不得包含任何控制字符，包括水平制表符。授权、内容协商、消息分帧、连接控制、User-Agent 和 `x-deepseek-harness-` 前缀保持保留。

`resolveAdapterOptions` 在 `apply` 注册提供方之前校验并复制标头。无效条目抛出代码为 `INVALID_REQUEST_HEADER` 的 `LlmError`，指出名称和原因，但不包含值。schema 将此校验交给 resolver，因为通用 schema 类型错误可能回显被拒绝的值。无效的实时 settings 保留整份最近有效配置，包括端点和凭据引用。

chat 请求和 Files 客户端在 harness 自有标头之前展开自定义标头。值不会进入请求正文、模型请求默认值、遥测或会话事件。`request/header` 是 agent loop 的模型选项事件，并非 HTTP 标头日志。[应用归因决策](../architecture/2026-06-21-mandatory-app-attribution-headers.zh.md) 和[请求身份决策](2026-08-11-deepseek-request-user-id-header.zh.md) 继续拥有各自的标头。

## 验证

mock-server 测试检查线上 chat 和 Files 标头，保留自有授权，并比较省略配置与空配置。resolver 和插件加载测试覆盖保留名称及限制；日志捕获检查成功请求和被拒绝的 settings 不暴露值。真实 Loader 组合检查配置传递。由于这些值不是模型可见或用户可见的 transcript 内容，无需变更 transcript 快照。

## 考虑过的替代方案

**提供方特定配置字段：** 通用的有界记录支持宿主当前的关联标头，无需为每个可观测性产品新增适配器选项。

**请求正文元数据：** 提供方 schema 和模型请求重建会增加与模型输入无关的字段。

**请求时校验：** 无效部署配置会注册路由，直到使用时才失败；现有解析步骤在注册前拒绝它。

## 影响

宿主可以在已配置端点关联 chat 和 Files 流量，同时 harness 自有标头保留优先权。标头值必须是非机密的，且已配置的 gateway 会接收它们。静态配置不能为每个请求派生新 span；宿主负责所提供的值及其生命周期。
