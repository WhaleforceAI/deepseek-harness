---
description: "共享 Agent Runtime broker 连接，停止配额耗尽的运行，并配置安全的发现结果复用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-runtime-broker

[English](README.md) | 中文

## Summary

使用 Runtime broker 将原生工具、文件系统访问和子进程路由到同一个经过认证的运行租约。配额拒绝会停止运行并阻止后续普通请求。只有部署显式确认工作区由该运行独占时，才能启用发现结果复用。

## Table of Contents

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 [Agent Runtime bundle](../../bundle/agent-runtime/cordis.patch.yml) 中挂载此 plugin（插件）一次。它的 `runtime-broker-tools` 补丁行提供运行的 `socketPath`、`secret` 和原生 `tools`。文件系统和子进程 provider（提供者）注入其共享的 `ctx.runtimeBroker` 服务。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `socketPath` | 必填 | Runtime 运行提供的绝对 Unix socket 路径。 |
| `secret` | 必填 | 至少 32 个字符的运行认证密钥。 |
| `tools` | `[]` | 注册到工具 registry（注册表）的原生工具定义。 |
| `cacheDiscovery` | `false` | 仅当此运行持有所有工作区写入者时启用发现结果复用。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-runtime-broker)持有完整配置。仅当每次工作区修改都经过此运行的 broker 操作时，才启用 `cacheDiscovery`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

[bridge 所有者](src/index.ts)在修改派发前及完成后推进代次。待完成写入会禁用发现结果复用。第一次命令或 stdin 派发会在该运行余下时间禁用复用，因为已完成的命令仍可能留下继续修改工作区的脱离后代进程。成功的原生目录列表会通知文件系统 provider，使相互矛盾的观察结果令缓存失效。

`BrokerInvokeError` 保留经过验证的 broker 拒绝的 `code` 和 HTTP `status`。第一个 `run_quota_exceeded` 会锁定该错误、中止进行中的 bridge 请求、取消 agent（智能体），并在打开 socket 之前拒绝后续普通操作。会话通过 hook 取消记录 `runtime-broker: run_quota_exceeded`，包括第一次模型请求之前发生的拒绝。Python Runtime 独立于会话取消事件保留带类型的终止失败，并负责免配额的远程完成操作。Cordis 释放过程关闭 bridge 并注销原生工具；新运行创建全新状态。

修改状态只有一个所有者，不存在可供 invariant（不变量）比较的独立运行时观察结果。传输验证和针对性的生命周期测试约束其输入与状态转换。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [文件系统 provider](../../../docs/subsystems/filesystem.zh.md) — 有界的发现结果与实时内容检查。
- [子进程 provider](../../../docs/subsystems/subprocess.zh.md) — 远程会话与命令完成。
- [运行所有权决策](../../../.agents/notes/implemented/bug-fix/2026-09-08-broker-run-discovery-cache.zh.md) — 失效与终止失败的依据。

-----

<a id="model-experience"></a>
## 模型体验

### 原生工具

#### 模型看到的内容

配置的原生工具描述和参数 schema（结构定义）进入请求。成功结果渲染为 JSON 文本。`run_quota_exceeded` 会停止运行，不再发出模型请求；Python Runtime 向调用者报告终止原因。

#### Token 影响

配置的 schema 增加请求 token；记录的调用和渲染结果扩大对话历史。发现结果复用改变 broker 流量，不增加模型可见内容。

#### KV Cache 影响

工具定义在同一配置下保持稳定。工具调用和结果追加到已有历史；发现代次不会改写模型前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

运行所有者依赖以下外部保证。

- **工作区所有权需要部署验证。** 写入者能够绕过该运行的 broker 操作时，保持 `cacheDiscovery` 禁用。
- **远程清理由 Python Runtime 负责。** 本地 socket 释放不能证明远程命令已终止；托管环境验收必须独立确认免配额完成操作。
- **复用在第一条命令时结束。** broker 会话完成不能证明脱离的后代进程已经停止。重新启用复用需要 broker 提供整个进程树已静止的证明。

<a id="dev-note"></a>
### 开发笔记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
