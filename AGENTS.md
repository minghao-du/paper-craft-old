# paper-craft — agent guidance

## What this file is

**Facts + guardrails** for working in this repo — and *only* those. There are three layers,
and this is just one of them:

- **Principles / "why"** live in `CONSTITUTION.md` (skills-are-the-product, file-based state,
  scope discipline). Read it when making a design, scope, or quality-gate decision.
- **Architecture / "what and why this way"** lives in `DESIGN.md` (JSONL source of truth, pure
  TypeScript, local-first, nexus pattern, git-compatible collaboration, TypeScript skill
  modules). Read it when making a technical architecture decision.
- **Procedures / "how to do X"** are the `pc-*` skills. **Never catalog or describe a skill
  here** — duplicating the auto-injected list adds nothing and silently rots. Invoke skills by
  name; let their descriptions be canonical.

What's left for *this* file: rules that must hold even when no skill is invoked, plus project
facts no skill carries.

## Stack & layout

- TypeScript. CLI: `pc`. Storage: JSONL source of truth →
  ephemeral index, rebuilt on `pc rebuild`. No native addons — pure TS/JS only (`DESIGN.md` §II).
- Layout:
  `packages/` source · `skills/` skill modules · `tests/` tests · `docs/` guides.

## Build & style

- `npm run build && ./pc --help` (once scaffolded).
- Run `npm run lint` and `npm run typecheck` before any PR. Exported symbols get doc comments.
- Skill prefix is `pc-`.

## Config & data paths

- Config: `~/.config/pc/config.yml`.
- Nexus path comes from `nexus_path` in that config. Research data lives in the nexus repo;
  workflow state may also live under explicitly configured project/clone roots
  (`DESIGN.md` §IV). The index cache lives at `$NEXUS_PATH/.paper-craft/cache/`.

## Repo facts

- This repo is in early stage — architecture design and core module rewriting are in progress.
- Agents decide and land changes here without asking the user, under downward pressure on size:
  a peer's suggested addition is a proposal to weigh, not a fix to apply, and deleting beats
  adding.
- When porting upstream code, adapt to TypeScript idioms — don't transliterate Go or shell.

## Docs conventions

- Follow the [bilingual documentation contract](docs/guides/documentation.md).

- A skill or agent file carries procedure an agent must follow and facts it can't get by
  looking — no incident stories, dated measurements, or markers.
- `README.md` stays short (overview, motivation, skill table). Detailed guides live in
  `docs/guides/`. Skills live in `./skills/`.
- When a change adds or alters a command, run `./pc <cmd> --help` and make the skill docs
  match the real flags and workflow.

## Agent skills

### Issue tracker

GitHub Issues via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles mapped 1:1 (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (`GLOSSARY.md` + `docs/adr/`). See `docs/agents/domain.md`.

