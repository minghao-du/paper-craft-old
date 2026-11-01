# paper-craft 设计决策

[English](DESIGN.md)

paper-craft 的技术架构决策。这些选择承载着整个系统——改变它们会产生广泛影响。

## I. JSONL 是唯一事实来源

结构化持久数据保存在 JSONL 文件中（文献、项目、仓库）。项目研究状态是明确的例外：它是仅保存在本地、位于指定研究主目录且不进入 Git 历史的 Markdown（见[研究状态](docs/guides/research-state.md)）。索引是临时产物——通过 `pc rebuild` 从 JSONL 重建。模式变更必须删除索引并重建，绝不使用迁移脚本。

选择 JSONL 是为了便于 Git 合并。

## II. 纯 TypeScript，无原生扩展

`npm run build` 必须能在没有 C/C++ 编译器或平台专用二进制文件的环境中工作。使用纯 JS/TS 依赖（例如 `better-sqlite3` WASM 或等效索引方案）。不使用 `node-gyp`，不使用原生模块。这使安装保持快速且跨平台。

## III. 本地优先，云端可选

核心功能使用本地数据离线运行。外部 API（Semantic Scholar、GitHub、Slack 等）是可选增强。pc 绝不主动向开发方回传信息。

## IV. Nexus 模式

结构化研究数据存于一个由 Git 管理的 nexus 仓库。路径来自 `~/.config/pc/config.yml` → `nexus_path`。nexus 是 Git 仓库——研究数据有版本记录且可共享。工作流状态也可以写入权威 `.epic-config.json` 明确配置的项目目录和克隆池：任务简报、槽位状态、暂停状态和已验证归档。路径按物理位置解析，写入必须保持在这些配置的根目录内。项目研究状态可存于指定的本地研究主目录，由多个仓库与检出目录共享；它不要求备份或同步。其他 pc 数据仍保存在 nexus 或 pc 自身的配置目录中。

## V. 与 Git 兼容的协作

JSONL 格式支持标准 Git 合并工作流。`pc resolve` 处理领域感知的冲突解决（基于 DOI 去重、合并互补元数据）。`pc dedupe` 清理合并后的重复项。设计时应考虑多人向同一个 nexus 推送的情况。

## VI. TypeScript Skill 模块

Skills 以 TypeScript 模块编写——可测试、可调试且类型安全。skill 前缀为 `pc-`。Skill 文档始终是权威依据：行为改变时，必须在同一 PR 中更新 skill 文档。

## VII. 独立于运行时的工作流

Run 的活跃托管 Orchestrator attempt 决定调度、验收和返工。
轻量 Bash 命令通过 `pc` 执行 Git worktree、tmux 和 GitHub 操作；
小型 JavaScript 辅助程序验证并持久化 JSON 状态。Run 入口记录
议题、透明的 runner 命令及对话中的补充要求。Fleet 是
运行时资源边界，不是调度代理。

Worker 接收不可变的任务说明文件，并发布持久化的 `RECEIPT.md` 结果。
同步等待检测已确认的提前退出；状态查看在重新连接时显示尚未处理的结果。
Runner 命令独立于平台；需要时可通过包装脚本适配提示输入。
Claude Code 不是必需的。自主执行的
`workflow orchestrator issue` 驱动已弃用。

Worktree 和目录锁隔离并发 worker。未知占用状态绝不意味着空闲。
落地时验证已测试的 PR HEAD 和检查结果，保全证据，
仅在合并得到确认后释放 worktree。

## VIII. 宿主适配器依赖 Core

pnpm 工作区分离 `packages/core`、`packages/cli` 和 `packages/mcp`。Core 暴露领域数据与服务，不包含 Commander、MCP 或模型宿主上下文。CLI 和 MCP 依赖 Core 的公共包导出；Core 绝不导入适配器。宿主专用的注册、响应格式和进程生命周期属于适配器。未来的原生 DeepSeek 插件也遵循同一依赖方向。共享 skills 仍位于仓库根目录。CLI 命令、配置路径和 JSONL 格式是明确的公共契约。
