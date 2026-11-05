# paper-craft

[English](README.md)

以论文手稿驱动的智能体开发平台，使用 TypeScript 重写。

paper-craft 将研究想法与实现连接起来：手稿会话将发现转化为范围明确的 issue，自主工作智能体负责实现和测试。人类把握研究方向并审查变更。

本项目的思想、工作流设计和编排模式源自 Erick Matsen 的 [bipartite](https://github.com/matsen/bipartite)（MIT）。`pc` CLI 替代了 `bip`；TypeScript 带来了共享类型、可测试的技能模块，以及 JavaScript 生态的丰富资源。托管工作流仅支持 `agy`（Antigravity），不支持其他智能体运行时。

## 技能

| 领域 | 入口 |
| --- | --- |
| 手稿 | `pc-ms`, `pc-ms-poll`, `pc-ms-sweep`, `pc-ms-audit` |
| 文献与研究 | `pc-lit`, `pc-lit-import`, `pc-research-ideas`, `pc-research-plan`, `pc-research-state` |
| Issue | `pc-issue-file`, `pc-issue-check`, `pc-issue-next`, `pc-issue-iterate` |
| 智能体编排 | `pc-epic`, `pc-orchestrator`, `pc-subagent` |
| 审查与合入 | `pc-pr-check`, `pc-pr-review`, `pc-pr-land` |
| 运维 | `pc-dashboard`, `pc-scout`, `pc-compute-config`, `pc-orchestrator-recover` |

技能仅使用英文。完整的执行指引见[技能目录](skills/)。

## 指南

- [原则](CONSTITUTION.zh.md)、[架构](DESIGN.zh.md)和[术语表](GLOSSARY.zh.md)
- [本地 MCP 配置](docs/guides/mcp.md)
- [双语文档维护](docs/guides/documentation.zh.md#navigation)

## 状态与许可证

项目处于早期阶段，架构与核心模块正在重写。

采用 MIT，与上游 bipartite 一致。背景介绍见 Matsen 的[工作流文章](https://matsen.group/general/2026/06/06/bipartite.html)。
