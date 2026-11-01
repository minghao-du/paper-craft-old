# Claude interactive Run execution

Production enablement remains blocked until all existing role-specific durable initialization gates are verified. Provider `claude` currently fails the mandatory interactive capability gate; the native adapter and opt-in candidate conformance do not advertise supported production execution.

Once enabled, use the normal Run intake, dispatch, inspection, receipt acceptance and recovery commands with provider `claude`; the provider stays fixed at intake. The adapter verifies installed interactive session/settings/resume flags and authentication before launch. A missing capability or authentication failure blocks launch.

Startup opens Claude's TUI under tmux, submits the complete initial brief as one argument, and requires a live recorded pane, native SessionStart, exact UserPromptSubmit and its correlated assistant acknowledgement. A pane alone is insufficient. If startup remains unacknowledged, inspect its recorded terminal for trust, authentication, configuration or authorization requests; resolve those explicitly before recovery. Never automatically confirm a permission or trust prompt.

Subsequent messages use bracketed paste and require an exact native submission acknowledgement. Uncertain delivery remains pending reconciliation; do not replay the brief or create a duplicate execution. Manual messages can coexist: native prompt IDs correlate Stop output with the intended submitted brief, and ambiguous repeated brief text remains unaccepted.

A native Stop marks an idle turn, not accepted work. Existing receipt validation and Run ownership gates decide acceptance. An accepted execution with no remaining assignment is terminated by its recorded pane ID; verified absence precedes checkout release. Unknown tmux observation blocks release.

Recovery reads per-attempt native hook evidence and the existing Run registry. Reconnect keeps a surviving attempt; verified restart uses the original exact conversation UUID and a new linked attempt, submitting only the Run-generated reconciliation brief. Never use `--continue`, a latest-conversation picker, print mode or background mode for these named roles.

Run the opt-in real-provider check from a trusted checkout with `PC_CLAUDE_CONFORMANCE=1 pnpm exec vitest run tests/workflow/claude-conformance.test.ts`. It makes real provider calls and verifies Run registration, persistent native completion, acceptance, terminal release and managed exact-conversation restart. Retain installed versions and native evidence outside this procedure.
