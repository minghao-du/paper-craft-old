# 仅保留托管工作流切换与废弃独立驱动

[English](0004-managed-only-workflow-cutover.md)

[spec #152](https://github.com/minghao-du/paper-craft/issues/152) 的架构决策。

## 背景

早期版本存在两套并行的执行架构：基于 `RunRegistry`、`WorkflowRun` 和 `StageDispatch` 的托管工作流（Managed Workflow），以及独立的非托管驱动（`issue-driver`、`epic-driver`、`epic-completion` 和 `postmerge`）。旧版驱动依赖旁路记录（`task.json`、`epic.json`、`completion.json`）与本地检出标记（`.epic-status.json`、`.epic-worklog.md`），造成生命周期逻辑重复和执行状态割裂。

## 决策

1. **唯一托管执行路径**：托管工作流（`pc workflow orchestrator start`、`pc workflow stage`）是唯一受支持的 Issue 与 EPIC 执行架构。
2. **废弃独立驱动**：删除 `issue-driver`、`epic-driver`、`epic-completion`、`postmerge`、`finalize-epic` 以及独立的 `drivePullRequest`。纯粹的主体读取（`readIssue`、`IssueInput`）归入 `run-subject`，PR 提供者抽象保留在 `pr-driver`。
3. **不设向后兼容桥接**：不为已删除的独立执行循环提供兼容垫片、运行时读取兼容或废弃别名。
4. **保护历史数据**：操作员保存在 `.runtime/` 或工作检出目录中的历史数据受到保护，既不会自动纳入托管状态，也不会被自动删除。

## 替代效应

本决策替代了先前的独立驱动工作流，并在所有文档与 ADR 中将独立 issue/EPIC 驱动执行标记为废弃。
