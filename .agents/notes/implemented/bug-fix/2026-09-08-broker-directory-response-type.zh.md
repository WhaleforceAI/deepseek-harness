# Agent Note：Broker 目錄回應型別

Status: implemented

[English](2026-09-08-broker-directory-response-type.md) | 中文

## Problem

部署中的 broker 在 stat 與目錄列表回應中使用 `dir` 表示目錄。拒絕此值會阻止技能根目錄列舉；技能登錄將失敗的提供者觀察視為不完整，並在後續模型回合重試探索。

## Decision

[Broker 檔案系統提供者](../../../../packages/runtime/fs-broker/src/index.ts) 在共用 stat 解析器中，將 `dir` 對應至檔案系統接縫的 `directory`。既有的 `directory` 表示法仍有效。其餘回應驗證與快取規則保持有效。

## Alternatives considered

**從驗收中排除重複的技能根目錄 stat。** 這會隱藏無法使用的技能探索，卻不會恢復目錄存取。

**修改 broker 的共用回應型別。** 提供者負責轉換成其檔案系統接縫的型別；修改 broker 也會影響此 Harness 之外的消費者。

## Consequences

Stat、lstat 與目錄項目共用同一個正規化處理。[錄製的 Runtime 組合](../../../../snapshots/session/runtime-broker-quota/runtime-broker-fixture.mjs) 提供原始目錄回應，並要求技能列舉到達子檔案探測，因此靜默略過失敗的技能提供者會使重播失敗。
