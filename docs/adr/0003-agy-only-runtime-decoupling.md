# Agy-only runtime cutover and Core provider decoupling

[简体中文](0003-agy-only-runtime-decoupling.zh.md)

Decision for [spec #144](https://github.com/minghao-du/paper-craft/issues/144).

## Context

Prior versions bundled experimental Claude Code and Codex interactive runner implementations directly in Core, intermingling concrete provider process lifecycles, provider-name branches, and migration shims inside domain orchestration.

## Decision

1. **Agy-only cutover**: Cut over to Agy as the sole supported managed workflow provider. Remove Claude and Codex runtime implementations, tests, and documentation. Ship no legacy compatibility layers, fallback translation paths, or speculative multi-provider plugin registries.
2. **Core decoupling**: Remove concrete provider imports, instantiation, and provider-name-driven branching from `packages/core`. Provider selection belongs exclusively to the host composition layer (`packages/cli`), while Core retains provider identity consistency verification (`runner.name === run.provider`).
3. **Encapsulated provider recovery state**: Provider adapters encapsulate session, pane, window, and execution evidence in opaque `providerState` fields stored on attempts and in `terminal.json`. Core does not inspect provider-specific internals.
4. **Historical data protection**: Do not delete operator-owned historical data or forcibly release live legacy executions during the cutover.

## Superseding effect

This decision supersedes prior multi-provider runtime assumptions without modifying historical ADRs 0001 or 0002.
