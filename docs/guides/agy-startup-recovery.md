# Diagnose and recover agy startup

[简体中文](agy-startup-recovery.zh.md)

Use this procedure to inspect a failed or pending managed startup before choosing manual recovery. The [managed lifecycle contract](../../skills/pc-orchestrator/managed-lifecycle.md) is authoritative for initialization, authority, termination and release; the [agy procedure](../../skills/pc-orchestrator/agy-interactive.md) defines provider evidence. This guide does not authorize recovery or scientific execution.

## Locate the assignment

Run read-only inspection with the authoritative Fleet configuration:

```sh
pc workflow orchestrator status --config /absolute/path/.epic-config.json
pc workflow orchestrator status --detailed --config /absolute/path/.epic-config.json
```

Find the Run by repository and Issue, then its current Orchestrator or child Dispatch and latest Attempt. Keep the command outcome, Run lifecycle, Attempt status, `startupRecovery` and `activationStatus` distinct. A running Run alone does not prove continuation delivery. Follow returned Evidence and diagnostic paths; detailed status does not read logs or transcripts. If `diagnosticSaveError` is present, preserve the reported business outcome rather than repeating successful work to repair logging.

In the Attempt evidence directory, compare retained `terminal.json` and `agy-native.json` with the selected Attempt and its recorded native conversation, terminal address, pane/window and Run session. Follow the native callback's `transcript_path` to the original transcript. Inspect the recorded terminal only when ownership is verified; use an attach command only when status offers a verified usable terminal. Missing or conflicting ownership is a blocker, not permission to claim a pane.

## Identify the failed gate

1. **Submitted input and completed native reply.** Inspect the original `agy-input.txt`. In the exact native conversation, require matching `USER_INPUT` with `source: USER_EXPLICIT` and `status: DONE`, followed by the completed model `PLANNER_RESPONSE` containing the exact role/Attempt ready marker. Verify the live owned terminal as well. A visible marker, callback or latest reply alone cannot satisfy attribution. For historical inline launches, retain the original saved input; never replace it with a short prompt or rewrite transcripts. If historical input is missing, retain existing runtime handling and report that absence; do not synthesize evidence.
2. **Factual role initialization.** Compare `initialization.json` and actual role/project state against the assignment-bound requirements in the managed lifecycle contract, including context hashes and current authority. A file's existence is insufficient. Follow that contract for role-specific checks rather than copying another Attempt's evidence. Missing or stale evidence keeps startup pending even when native readiness is established.
3. **Independent activation and continuation.** Inspect committed activation for this exact current Attempt and native delivery of its separate continuation input. Readiness is neither task acceptance nor scheduling authority. Unconfirmed continuation remains pending; do not paste it again to overcome uncertainty. The existing helper reconciles exact native input without blind replay.

For a new-format Attempt **when `startup.md` exists**, inspect it separately: it is the complete current Attempt startup instructions, including initialization and applicable reconciliation. `agy-input.txt` is the actual submitted short pointer prompt used for native correlation. Original task/context files remain hash-bound assignment evidence with their original meaning; they need not contain appended initialization. Check identity and pointer against this Attempt and preserve missing, unreadable or mismatched content as diagnostic evidence. Do not overwrite it or substitute inline instructions. Historical Attempts are not required to have this artifact.

## Choose a manual action

Before any action, inspect persisted results, immutable Receipts, accepted acknowledgements, current authority and resource ownership. Reconcile accepted work instead of replaying it. Unknown execution occupancy remains reserved regardless of elapsed time. The following are choices for the operator, not commands to execute as part of diagnosis:

- Leave a live or unknown Attempt reserved while the background helper reconciles late readiness; inspect trust, login or authorization prompts in its verified terminal and have the user resolve them explicitly.
- Explicitly request existing reconciliation with `pc workflow orchestrator recover <run> --config <config>` (optionally `--detailed`). This can activate the same Attempt once all native identity, terminal, initialization and authority gates pass; it is not read-only inspection.
- Reconnect through the original `start` request when appropriate. Repeated start reconnects the unfinished Run and repairs a stopped helper without relaunching execution; preserve the original provider and immutable requirements. It may advance startup, so the operator chooses it deliberately.
- Use `pc workflow orchestrator recover <run> --replace --config <config>` only after independent verified termination of the previous Orchestrator. Stage retry likewise requires verified termination and creates a new Attempt with current reconciliation instructions. Never reuse predecessor startup authority or replay accepted work.
- Release a checkout only through the existing `releaseRunCheckout` contract after verified termination of every recorded execution and required preservation/cleanup. It is a driver operation, not an additional recovery CLI command. Do not remove owner markers or infer release from a timeout or completed output.

Diagnosis is complete when each gate has verified evidence or a specific retained blocker, current occupancy and authority are recorded, and the operator can choose an existing action. Successful reconnection requires the selected current Attempt, valid initialization, committed activation and confirmed continuation; business acceptance and resource release remain separate.

## Evidence limits

A short prompt reduces exposure to transcript truncation without guaranteeing immunity. Simulated protocol tests cannot prove that native agy fully reads a startup document or establish native transcript limits. Do not run a real-provider smoke test, recover the reported Run or execute downstream scientific analysis as documentation validation. Incident-specific reported evidence is retained separately in [the incident note](../research/agy-startup-112.md).
