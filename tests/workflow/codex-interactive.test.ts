import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveCodexRunner } from '../../packages/core/src/workflow/codex-interactive.js';

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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
