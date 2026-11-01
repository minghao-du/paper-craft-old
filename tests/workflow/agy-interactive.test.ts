import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { AgyInteractive } from '../../packages/core/src/workflow/agy-interactive.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime.js';

test('agy attributes native output to exact submitted input and refuses interleaved responses', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-'));
  const a: ManagedAttempt = {
    id: 'attempt',
    fleet: 'fleet',
    role: 'worker',
    runner: 'agy',
    brief: 'task',
    directory,
    checkout: directory,
    created: new Date().toISOString(),
    status: 'running',
    conversation: 'native-id',
  };
  const transcript = join(directory, 'transcript.jsonl');
  writeFileSync(
    join(directory, 'agy-native.json'),
    JSON.stringify({
      conversation_id: 'native-id',
      transcript_path: transcript,
      agent_state: 'idle',
    }),
  );
  const input = {
    step_index: 2,
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    status: 'DONE',
    content: '<USER_REQUEST>\ntask\n</USER_REQUEST>',
  };
  const result = {
    step_index: 3,
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    status: 'DONE',
    content: 'accepted output',
  };
  try {
    writeFileSync(transcript, [input, result].map((x) => JSON.stringify(x)).join('\n'));
    expect(await new AgyInteractive().result(a, 'attempt')).toBe('accepted output');
    writeFileSync(
      transcript,
      [
        input,
        { ...input, step_index: 3, content: '<USER_REQUEST>\nmanual\n</USER_REQUEST>' },
        { ...result, step_index: 4 },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n'),
    );
    expect(await new AgyInteractive().result(a, 'attempt')).toBeUndefined();
    expect(await new AgyInteractive().result(a, 'predecessor')).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
