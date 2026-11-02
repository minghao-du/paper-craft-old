# Paper Craft

[English](GLOSSARY.md)

研究组织与 agent 工作流术语。

## 术语

**Project（研究项目）**：
将相关仓库归为一组的研究项目。Project 与 Fleet 不同。
_避免_：将 Fleet 用作 Project 的同义词

**Fleet（工作流集群）**：
由配置定义的资源与协调边界，包含 Run 和工作目录池。每个 Run 拥有自己的 Orchestrator。Fleet 没有调度代理；Run Registry 以确定性规则仲裁资源。
_避免_：将 Project 用作 Fleet 的同义词

**Run**：
一次请求的 Issue 或 EPIC 工作流，使用固定提供方并拥有独立的 Orchestrator。

**Launcher（启动器）**：
为 Run 请求启动独立 Orchestrator 的入口角色。报告启动结果后，其职责结束；调用它的对话仍是普通对话。

**Orchestrator**：
Run 的唯一调度权限，由恰好一个活跃的受管执行尝试承载。替换前必须验证原尝试已终止，并保留先前尝试作为历史。

**Orchestrator attempt（执行尝试）**：
恰好属于一个 Run 的受管执行，通过 Managed Runtime 启动和检查。

**Coordinator**：
Project 范围的研究报告代理；它不是 Run 调度器。
