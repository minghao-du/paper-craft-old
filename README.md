# paper-craft

[简体中文](README.zh.md)

Manuscript-driven agent development platform, rewritten in TypeScript.

paper-craft connects research ideas and implementation: manuscript sessions turn findings into scoped issues, and autonomous workers implement and test them. Humans steer research and review changes.

The ideas, workflow design and orchestration patterns originate from Erick Matsen's [bipartite](https://github.com/matsen/bipartite) (MIT). The `pc` CLI replaces `bip`; TypeScript brings shared types, testable skill modules and access to the JavaScript ecosystem.

## Skills

| Area | Entry points |
| --- | --- |
| Manuscripts | `pc-ms`, `pc-ms-poll`, `pc-ms-sweep`, `pc-ms-audit` |
| Literature and research | `pc-lit`, `pc-lit-import`, `pc-research-ideas`, `pc-research-plan`, `pc-research-state` |
| Issues | `pc-issue-file`, `pc-issue-check`, `pc-issue-next`, `pc-issue-iterate` |
| Agent orchestration | `pc-epic`, `pc-orchestrator`, `pc-subagent` |
| Review and landing | `pc-pr-check`, `pc-pr-review`, `pc-pr-land` |
| Operations | `pc-dashboard`, `pc-scout`, `pc-compute-config`, `pc-orchestrator-recover` |

Skills remain English-only. See the [skill directory](skills/) for the complete execution guidance.

## Guides

- [Principles](CONSTITUTION.md), [architecture](DESIGN.md) and [glossary](GLOSSARY.md)
- [Local MCP setup](docs/guides/mcp.md)
- [Bilingual documentation maintenance](docs/guides/documentation.md#navigation)

## Status and license

The project is in an early stage; architecture and core modules are being rewritten.

MIT, consistent with upstream bipartite. See Matsen's [workflow introduction](https://matsen.group/general/2026/06/06/bipartite.html) for background.
