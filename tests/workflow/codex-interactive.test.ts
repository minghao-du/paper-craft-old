vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));
import { test, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveCodexRunner } from '../../packages/core/src/workflow/runtime/codex-interactive.js';

test('native completed turns require exact attempt and dispatch correlation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pc-native-'));
  const attempt = {
    id: 'replacement',
    dispatchId: 'task',
    directory,
    conversation: 'conversation',
    fleet: 'fleet',
    role: 'worker' as const,
    runner: 'codex',
    brief: 'brief',
    status: 'running' as const,
    created: '',
    checkout: directory,
  };
  const path = join(directory, 'native.jsonl');
  const events = [
    { type: 'session_meta', payload: { id: 'conversation' } },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'conversation',
        turn_id: 'old',
        item: {
          type: 'UserMessage',
          content: [
            { type: 'text', text: '[pc attempt=predecessor dispatch=task message=initial]' },
          ],
        },
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'old', last_agent_message: 'wrong' },
    },
  ];
  const save = () => writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n'));
  writeFileSync(join(directory, 'codex-native.json'), JSON.stringify({ path }));
  try {
    save();
    const runner = new InteractiveCodexRunner();
    expect(await runner.result(attempt, 'task')).toBeUndefined();
    events.push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'conversation',
        turn_id: 'new',
        item: {
          type: 'UserMessage',
          content: [
            { type: 'text', text: '[pc attempt=replacement dispatch=task message=initial]' },
          ],
        },
      },
    });
    save();
    expect(await runner.result(attempt, 'task')).toBeUndefined();
    events.push({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'new', last_agent_message: 'accepted result' },
    });
    save();
    expect(await runner.result(attempt, 'task')).toBe('accepted result');

    // Multiple turns in rollout for the same dispatch: subsequent turn replaces previous
    events.push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'conversation',
        turn_id: 'turn-2',
        item: {
          type: 'UserMessage',
          content: [
            { type: 'text', text: '[pc attempt=replacement dispatch=task message=followup]' },
          ],
        },
      },
    });
    save();
    expect(await runner.result(attempt, 'task')).toBeUndefined();
    events.push({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-2', last_agent_message: 'followup result' },
    });
    save();
    expect(await runner.result(attempt, 'task')).toBe('followup result');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('preflight validates installed flags and login status', async () => {
  const child = await import('node:child_process');
  const runner = new InteractiveCodexRunner();
  const spy = vi.mocked(child.execFileSync).mockImplementation((cmd, args) => {
    if (cmd === 'tmux') return 'tmux 3.3a';
    if (cmd === 'codex') {
      const argStr = (args as string[]).join(' ');
      if (argStr === '--help') return '--no-alt-screen --add-dir [PROMPT]';
      if (argStr === 'queue --help') return '--thread --message';
      if (argStr === 'resume --help') return 'SESSION_ID';
      if (argStr === 'login status') return 'Logged in using ChatGPT\n';
    }
    return '';
  });
  try {
    await expect(runner.preflight()).resolves.toBeUndefined();

    // Not logged in throws actionable error
    spy.mockImplementation((cmd, args) => {
      if (cmd === 'tmux') return 'tmux 3.3a';
      if (cmd === 'codex') {
        const argStr = (args as string[]).join(' ');
        if (argStr === '--help') return '--no-alt-screen --add-dir [PROMPT]';
        if (argStr === 'queue --help') return '--thread --message';
        if (argStr === 'resume --help') return 'SESSION_ID';
        if (argStr === 'login status') return 'Not logged in\n';
      }
      return '';
    });
    await expect(runner.preflight()).rejects.toThrow(/Codex authentication required: run codex login/);

    // Authentication failure exit code throws actionable error
    spy.mockImplementation((cmd, args) => {
      if (cmd === 'tmux') return 'tmux 3.3a';
      if (cmd === 'codex') {
        const argStr = (args as string[]).join(' ');
        if (argStr === '--help') return '--no-alt-screen --add-dir [PROMPT]';
        if (argStr === 'queue --help') return '--thread --message';
        if (argStr === 'resume --help') return 'SESSION_ID';
        if (argStr === 'login status') throw new Error('Command failed: codex login status');
      }
      return '';
    });
    await expect(runner.preflight()).rejects.toThrow(/Codex authentication check failed.*run codex login/);
  } finally {
    spy.mockRestore();
  }
});

test('startup requires role acknowledgement and exact live pane; another pane never proves termination', async () => {
  const child = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'pc-startup-'));
  const attempt = {
    id: 'new',
    dispatchId: 'task',
    directory,
    conversation: 'conversation',
    address: 'tmux:%123',
    fleet: 'fleet',
    role: 'worker' as const,
    runner: 'codex',
    brief: 'brief',
    status: 'running' as const,
    created: '',
    checkout: directory,
  };
  const path = join(directory, 'native.jsonl');
  const data = [
    { type: 'session_meta', payload: { id: 'conversation' } },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'conversation',
        turn_id: 'turn',
        item: {
          type: 'UserMessage',
          content: [{ text: '[pc attempt=new dispatch=task message=initial]' }],
        },
      },
    },
  ];
  writeFileSync(join(directory, 'codex-native.json'), JSON.stringify({ path }));
  let inventory = '%123 0\n%999 1\n';
  const spy = vi.mocked(child.execFileSync).mockImplementation(() => inventory);
  const save = () => writeFileSync(path, data.map((e) => JSON.stringify(e)).join('\n'));
  try {
    const runner = new InteractiveCodexRunner();
    save();
    expect(await runner.recoverReceipt(attempt)).toBeUndefined();
    data.push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'conversation',
        turn_id: 'turn',
        item: { type: 'AgentMessage', content: [{ text: '[pc ready role=worker attempt=new]' }] },
      },
    });
    save();
    expect((await runner.recoverReceipt(attempt))?.conversation).toBe('conversation');
    inventory = '%999 1\n';
    expect(await runner.recoverReceipt(attempt)).toBeUndefined();
    expect(await runner.stopped(attempt)).toBe(false);
    writeFileSync(join(directory, 'exit-code'), '0');
    expect(await runner.stopped(attempt)).toBe(true);
    inventory = '%123 0\n%999 1\n';
    expect(await runner.stopped(attempt)).toBe(false);
  } finally {
    spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
