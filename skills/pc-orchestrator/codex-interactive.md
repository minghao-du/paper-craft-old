# Codex persistent TUI

Use the managed Codex adapter for named persistent roles; follow [Managed Run lifecycle](managed-lifecycle.md) for authority, acceptance, recovery and release.

1. Preflight verifies installed interactive prompt, queue and exact-resume capabilities plus login. Resolve authentication or configuration failures before dispatch. Startup preserves its pane and Attempt on uncertainty; inspect the recorded tmux address for trust or authorization requests. Review those requests explicitly; never confirm them automatically. Completion criterion: native Codex conversation identity and acknowledgement of the complete initial message are recorded.
2. Initial input uses one prompt argument. Later messages use the exact conversation's official queue command, with Attempt, Dispatch and message correlation included in the body. Native rollout UserMessage and task_complete events bind a result to its turn. Queue acknowledgement alone is delivery evidence, not task acceptance. Completion criterion: a uniquely correlated native completed turn is available to the existing receipt workflow.
3. Reconnect reconciles the saved native rollout and retains the Attempt. A verified process restart uses exact conversation resume without replaying its brief; the owning Run authorizes subsequent messages. Missing conversation or ambiguous native evidence stays pending for investigation or verified reassignment. Completion criterion: exact identity is restored and predecessor output cannot satisfy the replacement Attempt.
4. Acceptance uses the common workflow gates. Unused executions receive interrupt requests; release requires the wrapper exit record and independently absent or dead terminal. Unknown termination retains ownership. Completion criterion: common cleanup and checkout release have completed.

Native rollout history is provider evidence, not the workflow's source of acceptance. Keep it available for reconciliation; missing history leaves results unknown.
