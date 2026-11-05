# Agent Note: Broker calling session identity

Status: implemented

## Problem

运行级 broker 认证不能区分根代理与子代理发起的原生工具调用。需要访问调用会话的操作必须获得实际的执行所有者。

## Decision

[Runtime broker](../../../../packages/runtime/broker/README.zh.md) 将 `exec.agent.session.id` 作为可选顶层 `session_id`，将 `exec.callId` 作为可选 `tool_call_id` 转发。共享桥接将这些元数据与操作参数分开接收。没有执行身份的调用会省略这些字段。

## Alternatives considered

**仅使用运行级身份。** 一次运行可以包含多个代理，因此根会话不能标识所有调用者。

**将身份放入工具参数。** 工具参数属于操作 schema，可能包含无关的命令会话标识符；执行元数据属于桥接请求。

## Consequences

原生操作可以选择发起调用的 Harness 会话，无需修改工具 schema 或模型可见参数。没有原生执行上下文、直接调用共享桥接的 provider 保留运行级行为。聚焦的 socket 测试覆盖不同的根代理与子代理身份，以及元数据缺省情况。
