import { test, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexRunner, type ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

test('specialists launch independent windows in the existing session and recover durable identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pc-window-'));
  const calls: string[][] = [];
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    const values = args as string[];
    calls.push(values);
    if (values[0] === 'new-window') {
      const home = dirname(values.at(-1)!);
      writeFileSync(
        join(home, 'events.jsonl'),
        [
          '{"type":"thread.started","thread_id":"actual-thread"}',
          '{"type":"turn.started"}',
          '{"type":"turn.completed"}',
        ].join('\n'),
      );
      writeFileSync(join(home, 'exit-code'), '0');
      writeFileSync(join(home, 'result.md'), 'actual task result');
      return '@7 %9';
    }
    return Buffer.from('');
  });
  try {
    const runner = new CodexRunner();
    const attempt: ManagedAttempt = {
      id: 'attempt-1',
      fleet: 'fleet-identity',
      role: 'pipeline-audit',
      runner: 'codex',
      brief: 'audit',
      status: 'starting',
      created: new Date().toISOString(),
      directory,
      checkout: directory,
      terminalSession: 'existing-fleet',
    };
    const receipt = await runner.start(attempt);
    expect(calls[0]).toEqual(['has-session', '-t', 'existing-fleet']);
    expect(calls[1]).toContain('new-window');
    expect(calls[1]).toContain('existing-fleet:');
    expect(calls.flat()).not.toContain('new-session');
    expect(receipt.address).toMatch(/^tmux:existing-fleet:/);
    expect(await runner.collect(attempt)).toBe('actual task result');
    expect((await runner.recoverReceipt({ ...attempt, address: undefined }))?.address).toBe(
      receipt.address,
    );
    const script = readFileSync(join(directory, 'launch.sh'), 'utf8');
    expect(script).toContain('--add-dir');
    expect(script).toContain('brief.md');
    calls.length = 0;
    await expect(
      runner.start({
        ...attempt,
        id: 'attempt-2',
        role: 'research-state',
        terminalSession: undefined,
      }),
    ).rejects.toThrow('existing tmux session');
    expect(calls).toHaveLength(0);
  } finally {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
});
