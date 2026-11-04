# Demo Tools (`tools/demo`)

This directory provides developer acceptance tools for isolated disposable Agy EPIC demonstration and verification rounds.

> **Note**: This is an internal developer and maintainer acceptance tool, **not** a user-facing product feature. The core product and product CLI do not depend on this directory.

## Architecture & Dependency Rule

The dependency rule is strictly one-way:

```text
Developer
  │
  ▼
tools/demo (scenario preparation, control, acceptance, disposal)
  │
  ├── Product CLI (pc)
  │       │
  │       ▼
  │      Core
  │
  └── Public Core APIs (@paper-craft/core/*)

Core / CLI / MCP ──DO NOT DEPEND ON──▶ tools/demo
```

Deleting `tools/demo` leaves all product builds and features 100% operational.

## Usage

Commands are executed via `pnpm demo --config <file> <subcommand>`:

```sh
# Read-only prerequisites and write scope check
pnpm demo --config demo-config.json preflight

# Provision a fresh disposable demo environment (creates repo & epic; no agents)
pnpm demo --config demo-config.json provision --confirm

# Check persisted round status
pnpm demo --config demo-config.json status <round-id>

# Arm execution budget (e.g. 60 minutes) and start detached watchdog
pnpm demo --config demo-config.json arm <round-id> --budget-minutes 60

# Check gate prerequisites and issue durable authorization
pnpm demo --config demo-config.json gate <round-id> worker1
pnpm demo --config demo-config.json gate <round-id> worker2

# Request closure and human confirmation
pnpm demo --config demo-config.json closure-request <round-id>
pnpm demo --config demo-config.json confirm <round-id> <version> --confirm

# Verify independent boundary evidence
pnpm demo --config demo-config.json verify <round-id> [--boundary <stage>]

# Inspect finalization state
pnpm demo --config demo-config.json finalization <round-id>

# Dispose verified round
pnpm demo --config demo-config.json dispose <round-id>

# Emergency stop
pnpm demo --config demo-config.json stop <round-id>
```
