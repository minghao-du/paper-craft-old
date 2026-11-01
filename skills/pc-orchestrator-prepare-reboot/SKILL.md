---
name: pc-orchestrator-prepare-reboot
description: Save a tmux workspace and verified agent conversation identities before a planned shutdown or reboot.
---

# Save before shutdown

Before parking runtime sessions, persist each project's state under the shared
[Lifecycle recovery](../pc-orchestrator/managed-lifecycle.md) contract. The orchestrator holds
new dispatch, requests role tuckins, and accounts for every EPIC, worker and landing
agent, including local Git operations and explicit checkout ownership. Preserve approval
sources and separate merge, final-record and cleanup outcomes. Silent roles stay unknown;
a pane snapshot does not substitute for their records.

Use the selected runner's supported exact-session save/resume mechanism. If unavailable,
retain file-based continuation and report manual recovery required. Let local operations
reach a safe point or preserve their interrupted state. Saving a conversation does not
preserve a running job or authorize a PR merge.

Run on the machine about to shut down. Set `HELPER` to this skill directory plus `/epic-prepare-reboot`. This saves every session on the selected tmux server; repeat for independently configured servers.

## 1. Check what can resume

```sh
"$HELPER" --dry-run
```

For missing plugin configuration or unresolved conversation identities, follow [workspace recovery](../pc-orchestrator-recover/SKILL.md) and load only the relevant runner reference. Save ongoing task state in files and let in-flight local operations reach a safe stopping point. Conversation recovery restarts a CLI; it does not preserve a running build, editor buffer, or shell process.

Done when every pane is accounted for and unresolved IDs or unfinished local work have been surfaced.

## 2. Save immediately

```sh
"$HELPER"
```

The snapshot pairs layout, directories, and verified conversation IDs in one resurrect file. Existing settings are described by [plugin setup](../pc-orchestrator-recover/references/tmux.md).

Done when saving succeeds and the final recording table has been checked. If a pane changes conversation or layout afterwards, save again before shutdown. This helper saves state; the user shuts down through their usual controls.

## 3. Recover

On the next tmux server start, continuum restores the latest saved workspace and opens recorded conversations without sending a prompt. Follow [workspace recovery](../pc-orchestrator-recover/SKILL.md) to resolve startup failures or missing identities. Without a prior snapshot, report the missing evidence rather than promising a complete reconstruction.
