# Claude interactive Run execution

Use the normal Run intake, dispatch, inspection, receipt acceptance and recovery commands with provider `claude`; the provider stays fixed at intake. The adapter verifies installed interactive session/settings/resume flags and authentication before launch. A missing capability or authentication failure blocks launch.

Startup opens Claude's TUI under tmux, submits the complete initial brief as one argument, and requires native SessionStart and exact UserPromptSubmit evidence. A pane alone is insufficient. If startup remains unacknowledged, inspect its recorded terminal for trust, authentication, configuration or authorization requests; resolve those explicitly before recovery. Never automatically confirm a permission or trust prompt.

Subsequent messages use bracketed paste and require an exact native submission acknowledgement. Uncertain delivery remains pending reconciliation; do not replay the brief or create a duplicate execution. Manual messages can coexist: native prompt IDs correlate Stop output with the intended submitted brief, and ambiguous repeated brief text remains unaccepted.

A native Stop marks an idle turn, not accepted work. Existing receipt validation and Run ownership gates decide acceptance. An accepted execution with no remaining assignment is terminated by its recorded pane ID; verified absence precedes checkout release. Unknown tmux observation blocks release.

Recovery reads per-attempt native hook evidence and the existing Run registry. Reconnect keeps a surviving attempt; verified restart uses the original exact conversation UUID with no initial brief and a new linked attempt. Never use `--continue`, a latest-conversation picker, print mode or background mode for these named roles.

Run the opt-in real-provider check from a trusted checkout with `PC_CLAUDE_CONFORMANCE=1 pnpm exec vitest run tests/workflow/claude-conformance.test.ts`. It makes real provider calls and verifies Run registration, persistent native completion, acceptance and terminal release. Retain installed versions and native evidence outside this procedure.
