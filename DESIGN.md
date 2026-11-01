# paper-craft Design Decisions

[简体中文](DESIGN.zh.md)

Technical architecture decisions for paper-craft. These are
load-bearing choices — changing them has wide impact.

## I. JSONL Source of Truth

Structured persistent data lives in JSONL files (refs, projects, repos).
Project research state is an explicit exception: local-only Markdown in one
designated research home, outside Git history (see [research state](docs/guides/research-state.md)).
Indexes are ephemeral artifacts — rebuilt from JSONL via `pc rebuild`.
Schema changes require deleting the index and rebuilding, never
migration scripts.

JSONL is chosen for git-mergeability.

## II. Pure TypeScript, No Native Addons

`npm run build` MUST work without a C/C++ compiler or platform-specific
binaries. Use pure-JS/TS dependencies (e.g., `better-sqlite3` WASM or
equivalent for indexing). No `node-gyp`, no native modules. This keeps
installs fast and cross-platform.

## III. Local-First, Cloud-Optional

Core functionality works offline with local data. External APIs
(Semantic Scholar, GitHub, Slack, etc.) are optional enrichment.
pc never phones home.

## IV. Nexus Pattern

Structured research data lives in a single git-backed nexus repository. Path comes
from `~/.config/pc/config.yml` → `nexus_path`. The nexus is a git
repo — research data is versioned and shareable.
Workflow state may also be written inside the project and clone pool explicitly
configured by the authoritative `.epic-config.json`: task briefs, slot state,
holds and verified archives.
Paths are resolved physically and writes must stay inside these configured roots.
Project research state may live in its designated local research home, shared
across repositories and checkouts; it requires neither backup nor synchronization.
Other pc data stays in the nexus or pc's own config directory.

## V. Git-Compatible Collaboration

JSONL format enables standard git merge workflows. `pc resolve` handles
domain-aware conflict resolution (DOI-based deduplication, complementary
metadata merging). `pc dedupe` cleans up post-merge duplicates. Design
for the case where multiple people push to the same nexus.

## VI. TypeScript Skill Modules

Skills are authored as TypeScript modules — testable, debuggable, and
type-safe. The skill prefix is `pc-`. Skill docs remain canonical:
when behavior changes, skill docs MUST update in the same PR.

## VII. Runtime-Independent Workflows

The Run's active managed Orchestrator attempt makes scheduling, acceptance and rework decisions.
Lightweight Bash commands execute Git worktree, tmux and GitHub operations behind
`pc`; small JavaScript helpers validate and persist JSON state. Run intake records
the issue, transparent runner command and conversational requirements. Fleet is a
runtime resource boundary, not a scheduling agent.

Workers receive immutable brief files and publish durable `RECEIPT.md` results.
Synchronous wait detects verified premature exits; status exposes unhandled results
on reconnect. Runner commands are platform independent; wrappers adapt prompt input
when needed. Claude Code is not required.

Worktrees and directory locks isolate concurrent workers. Unknown occupancy never
means free. Landing verifies the tested PR HEAD and checks, preserves evidence,
then releases the worktree only after a verified merge.

## VIII. Host Adapters Depend on Core

The pnpm workspace separates `packages/core`, `packages/cli` and `packages/mcp`.
Core exposes domain data and services without Commander, MCP or model-host
contexts. CLI and MCP depend on Core's public package exports; Core never imports
an adapter. Host-specific registration, response formatting and process lifecycle
belong in adapters. A future native DeepSeek plugin follows the same direction.
Shared skills remain at the repository root. CLI commands, configuration paths and
JSONL formats are explicit public contracts.
