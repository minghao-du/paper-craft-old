# agy CLI

Read for an agy pane. Confirm installed flags with `agy --help`.

Setup wraps the CLI's [statusLine command](https://antigravity.google/docs/cli/statusline/) in `~/.gemini/antigravity-cli/settings.json`. The previous statusLine configuration is preserved in `~/.config/pc/tmux-recovery/agy-statusline.json`; an existing command receives the original stdin and its output is forwarded. With no existing command, the built-in status line remains visible. Restart an existing agy CLI to load the recorder.

The callback records `conversation_id` on state changes and clears the ID when the CLI reports an empty conversation. It validates that its process belongs to the pane. The payload's other fields, including account information and message text, are not persisted. A recorder failure does not suppress the original status command.

Launch through `"$HELPER" run agy [arguments...]`, the installed zsh function, or directly with the configured status line. To adopt an existing conversation whose recorder is unavailable, obtain its exact ID from agy's own conversation view and run:

```sh
"$HELPER" bind agy <conversation-id> --pane <target>
```

Re-register after switching conversations if automatic recording is unavailable. Recovery executes `agy --conversation <conversation-id>` from the saved directory, with no initial prompt or permission-bypass flags. Keep agy's own conversation storage available and verify the original conversation opens and waits for input.

Managed Run launch remains capability-gated until the complete role lifecycle is qualified. Manual conversation recovery above does not grant Run authority. Native agy status callbacks provide exact conversation identity and observations; task output must be correlated to the exact submitted user step in that conversation's CLI transcript. Unknown or interleaved attribution remains pending. A native ready response is supporting execution evidence; retain the role-specific initialization gates in the launch procedure.
