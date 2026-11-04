import { test, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';
import { AgyRunner } from '../../packages/core/src/workflow/runtime/agy-runner.js';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

test('specialists launch independent windows in the existing session and recover durable identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pc-window-'));
  const directory2 = mkdtempSync(join(tmpdir(), 'pc-window-2-'));
  const calls: string[][] = [];
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    const values = args as string[];
    calls.push(values);
    if (values[0] === 'list-sessions') {
      return 'pc-run-run-1 run-1\n';
    }
    if (values[0] === 'list-panes') {
      return '%9 0\n';
    }
    if (values[0] === 'display-message') {
      if (values.includes('#{window_id}')) return '@7\n';
      if (values.includes('#{session_name} #{@pc_run_id} #{pane_id}')) return 'pc-run-run-1 run-1 %9\n';
      return '';
    }
    if (values[0] === 'new-window') {
      const delivered = readFileSync(join(directory, 'agy-input.txt'), 'utf8');
      const transcriptPath = join(directory, 'transcript.jsonl');
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 0,
            type: 'USER_INPUT',
            source: 'USER_EXPLICIT',
            status: 'DONE',
            content: `<USER_REQUEST>\n${delivered}\n</USER_REQUEST>`,
          }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            status: 'DONE',
            content: '[pc ready role=pipeline-audit attempt=attempt-1]\nSpecialist ready',
          }),
        ].join('\n') + '\n',
      );
      writeFileSync(
        join(directory, 'agy-native.json'),
        JSON.stringify({
          conversation_id: 'actual-conversation',
          agent_state: 'idle',
          transcript_path: transcriptPath,
        }),
      );
      return '%9\n';
    }
    return '';
  });
  try {
    const runner = new AgyRunner();
    const attempt: ManagedAttempt = {
      id: 'attempt-1',
      run: 'run-1',
      fleet: 'fleet-identity',
      role: 'pipeline-audit',
      runner: 'agy',
      brief: 'audit',
      status: 'starting',
      created: new Date().toISOString(),
      directory,
      checkout: directory,
    };
    const receipt = await runner.start(attempt);
    const windowCall = calls.find((c) => c[0] === 'new-window');
    expect(windowCall).toBeDefined();
    expect(windowCall).toContain('pc-run-run-1:');
    expect(windowCall).toContain('pipeline-audit-attempt-');
    expect(calls.filter((c) => c[0] === 'new-session')).toHaveLength(0);
    expect(receipt.address).toBe('tmux:%9');
    expect(receipt.conversation).toBe('actual-conversation');

    const script = readFileSync(join(directory, 'agy-launch.sh'), 'utf8');
    expect(script).toContain('agy');
    expect(script).toContain('--settings');
    expect(script).toContain('--prompt-interactive');

    calls.length = 0;
    // Missing or conflicting session must reject
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const values = args as string[];
      calls.push(values);
      if (values[0] === 'list-sessions') {
        return 'unrelated-session unrelated-run\n';
      }
      return '';
    });
    await expect(
      runner.start({
        ...attempt,
        id: 'attempt-2',
        role: 'research-state',
        directory: directory2,
        checkout: directory2,
      }),
    ).rejects.toThrow('Run session ownership missing or conflicting');
  } finally {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
    rmSync(directory2, { recursive: true, force: true });
  }
});
