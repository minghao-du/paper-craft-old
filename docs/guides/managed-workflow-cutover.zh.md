# 托管工作流操作者切换指南

[English](managed-workflow-cutover.md)

本指南为切换至统一的托管工作流架构提供具体的操作步骤。托管工作流是 `paper-craft` 中唯一受支持的 Issue 与 EPIC 执行路径。独立驱动、非托管轮次循环以及本地工作区状态文件已被废弃。

## 背景与架构考量

早期版本维护了两套相互竞争的执行架构：托管工作流（以 `RunRegistry`、`WorkflowRun` 和 `StageDispatch` 为核心）与独立的非托管驱动（`issue-driver`、`epic-driver`、`epic-completion` 和 `postmerge`）。传统驱动在 `.runtime/tasks/`、`.runtime/epics/` 和 `.runtime/completion/` 中记录附属数据，并依赖易变的检出目录标记文件（`.epic-status.json` 与 `.epic-worklog.md`）。这种重复导致了生命周期权限割裂、恢复路径冲突以及状态观测不一致。

在统一架构下，`RunRegistry` 是调度、进度跟踪、验收、交付和恢复的唯一事实来源。该运行模型遵循四项核心原则：

- 单一状态权威：`RunRegistry` 是调度、进度、验收、交付和恢复的权威依据。
- Run 作用域 Orchestrator：每个 Run 拥有专属的 Orchestrator attempt；无全局调度智能体或非托管轮次循环。
- 跨 Run 交付引用：EPIC 通过验证证据与标准指纹引用子交付，不重复创建 worker 也不转移所有权。
- 门禁关闭与可恢复收尾：关闭需要集成验收和显式人工确认；关闭后阶段失败保持 Run 可恢复。

## 切换前准备

在切换到统一工作流之前，操作者必须确保所有执行环境达到静止状态。严禁尝试对运行中的执行进行在线迁移。

1. 清理并停止所有正在运行的传统驱动进程和后台工作进程。
2. 停止活跃的恢复监听器和集群轮询器，防止在切换期间生成新任务。
3. 检查各工作检出目录，确认不存在未提交的修改或残留的进程锁。
4. 在推进切换操作前，保留全部既有证据与验证记录。

## 历史数据保护

在整个切换过程中，操作者拥有的历史数据受到严格保护。系统不会篡改或销毁传统执行记录。

- 无自动采纳：`.runtime/`（`tasks/`、`epics/`、`completion/`）及检出目录（`.epic-status.json`、`.epic-worklog.md`）中的传统记录绝不会导入 `RunRegistry`。
- 无自动删除：操作者拥有的历史数据在切换期间或之后绝不会被修改或删除。
- 显式重新验证：任何需要继续的工作必须作为新的 Managed Run 启动，独立验证已有代码和测试结果，而非直接恢复陈旧状态。

## 切换执行步骤

切换操作作为一次性协调步骤执行。在启动新任务之前，确认软件构建正常且预期命令接口可用。

1. 更新仓库代码并重新构建工作区所有软件包。
2. 验证公开 CLI 帮助输出，确认已废弃命令（`finalize-epic`、独立 `run`/`pr`/`worker`）均不存在。
3. 确认 `agy` CLI 可访问，且提供方依赖项已满足。
4. 重新链接当前 agent skills（`pc-orchestrator`、`pc-issue-work`、`pc-pr-land`、`pc-dashboard`）并移除过期链接。

```sh
pnpm install
pnpm run build
./pc workflow orchestrator --help
```

## 干净启动托管工作流

所有新工作均通过 `pc workflow orchestrator` 命令套件启动。每个 Run 在创建时均明确指定主体和提供方，建立负责的拥有者及受追踪的调度分派。

1. 普通 Issue 录入：使用 `--type issue --provider agy` 启动 Issue，分配专属的 Managed Run 与 Orchestrator。
2. EPIC 录入：使用 `--type epic --provider agy` 启动 EPIC，分解规划阶段、子交付分派以及集成验收。
3. 可观测性与检查：使用 `pc workflow orchestrator status` 查看活跃 Run 和资源分配，或通过集群仪表盘进行监控。
4. 恢复与继续：使用 `pc workflow orchestrator recover <run>` 协调中断的尝试，不会重复执行已成功的外部合并、关闭或发布操作。
5. 交付合流与关闭：执行交付阶段并关闭通过验收的 EPIC，要求提供绑定至标准交付指纹的显式人工确认。

```sh
pc workflow orchestrator start 152 --type epic --provider agy
pc workflow orchestrator status --detailed
pc workflow orchestrator recover 152
pc workflow stage execute --dispatch d-delivery-001 --pr 153
pc workflow orchestrator close-epic 152 --fingerprint fp-abc1234
```
