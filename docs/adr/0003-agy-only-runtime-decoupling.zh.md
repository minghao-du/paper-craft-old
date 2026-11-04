# Agy 专用运行时切换与 Core 提供者解耦

[English](0003-agy-only-runtime-decoupling.md)

针对 [spec #144](https://github.com/minghao-du/paper-craft/issues/144) 的决策。

## 背景

先前版本将试验性的 Claude Code 与 Codex 交互式 runner 实现直接内置于 Core 中，导致具体提供者的进程生命周期、提供者名称分支逻辑以及临时迁移垫片与领域编排混杂在一起。

## 决策

1. **Agy 专用切换**：切换至 Agy 作为唯一受支持的托管工作流提供者。移除 Claude 与 Codex 运行时实现、测试与文档。不发布旧版兼容层、回退翻译路径或投机性的多提供者插件注册表。
2. **Core 解耦**：从 `packages/core` 中移除具体提供者的导入、实例化以及基于提供者名称的分支逻辑。提供者选择完全属于宿主组合层（`packages/cli`），而 Core 仅保留提供者身份一致性校验（`runner.name === run.provider`）。
3. **封装提供者恢复状态**：提供者适配器将会话、窗格、窗口与执行证据封装在 attempt 和 `terminal.json` 的不透明 `providerState` 字段中。Core 不解析提供者专用的内部细节。
4. **历史数据保护**：切换期间不自动删除操作员拥有的历史数据，也不强制释放正在运行的旧版执行。

## 替代效力

本决策取代了先前的多提供者运行时假设，而不修改历史 ADR 0001 与 0002。
