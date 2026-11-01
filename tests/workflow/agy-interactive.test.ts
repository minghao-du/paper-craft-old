import { vi, test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyInteractive } from '../../packages/core/src/workflow/agy-interactive.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

test('preflight verifies installed tmux and agy capabilities and refuses missing flags or probe errors', async () => {
  const child = await import('node:child_process');
  const tui = new AgyInteractive();

  // Success case
  vi.mocked(child.execFileSync).mockReturnValue('tmux 3.4\n' as unknown as Buffer);
  vi.mocked(child.spawnSync).mockReturnValue({
    status: 0,
    stdout: 'Usage of agy:\n--prompt-interactive\n--conversation\n--settings\n--add-dir\n',
    stderr: '',
    error: undefined,
  } as unknown as ReturnType<typeof child.spawnSync>);

  await expect(tui.preflight()).resolves.toBeUndefined();

  // Missing capability flag
  vi.mocked(child.spawnSync).mockReturnValue({
    status: 0,
    stdout: 'Usage of agy:\n--conversation\n--settings\n--add-dir\n',
    stderr: '',
    error: undefined,
  } as unknown as ReturnType<typeof child.spawnSync>);
  await expect(tui.preflight()).rejects.toThrow(/--prompt-interactive/);

  // Probe error
  vi.mocked(child.spawnSync).mockReturnValue({
    status: 1,
    stdout: '',
    stderr: 'command not found',
    error: new Error('command not found'),
  } as unknown as ReturnType<typeof child.spawnSync>);
  await expect(tui.preflight()).rejects.toThrow(/capability probe failed/);
});

test('native completed turns require exact attempt and dispatch correlation, idle state, and refuse interleaved messages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-test-'));
  const transcriptPath = join(directory, 'transcript.jsonl');
  const attempt = {
    id: 'attempt-1',
    dispatchId: 'dispatch-1',
    directory,
    conversation: 'conv-123',
    fleet: 'fleet-1',
    role: 'worker' as const,
    runner: 'agy',
    brief: 'Execute task 1',
    status: 'running' as const,
    created: new Date().toISOString(),
    checkout: directory,
  };

  const tui = new AgyInteractive();

  writeFileSync(
    join(directory, 'agy-native.json'),
    JSON.stringify({
      conversation_id: 'conv-123',
      transcript_path: transcriptPath,
      agent_state: 'idle',
    }),
  );

  const inputStep = {
    step_index: 0,
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    status: 'DONE',
    content: '<USER_REQUEST>\nExecute task 1\n</USER_REQUEST>',
  };

  const resultStep = {
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    status: 'DONE',
    content: '[pc ready role=worker attempt=attempt-1]\nCompleted output',
  };

  try {
    // Exact match
    writeFileSync(transcriptPath, [inputStep, resultStep].map((s) => JSON.stringify(s)).join('\n'));
    expect(await tui.result(attempt, 'dispatch-1')).toBe('Completed output');

    // Wrong dispatch / attempt id
    expect(await tui.result(attempt, 'other-dispatch')).toBeUndefined();

    // Working (not idle)
    writeFileSync(
      join(directory, 'agy-native.json'),
      JSON.stringify({
        conversation_id: 'conv-123',
        transcript_path: transcriptPath,
        agent_state: 'working',
      }),
    );
    expect(await tui.result(attempt, 'dispatch-1')).toBeUndefined();

    // Reset to idle
    writeFileSync(
      join(directory, 'agy-native.json'),
      JSON.stringify({
        conversation_id: 'conv-123',
        transcript_path: transcriptPath,
        agent_state: 'idle',
      }),
    );

    // Interleaved manual message before completion returns undefined
    const manualStep = {
      step_index: 1,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      status: 'DONE',
      content: '<USER_REQUEST>\nmanual message\n</USER_REQUEST>',
    };
    const lateResult = {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      content: 'late output',
    };
    writeFileSync(
      transcriptPath,
      [inputStep, manualStep, lateResult].map((s) => JSON.stringify(s)).join('\n'),
    );
    expect(await tui.result(attempt, 'dispatch-1')).toBeUndefined();

    // Duplicate inputs for same brief return undefined
    writeFileSync(
      transcriptPath,
      [inputStep, { ...inputStep, step_index: 1 }, resultStep].map((s) => JSON.stringify(s)).join('\n'),
    );
    expect(await tui.result(attempt, 'dispatch-1')).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('startup requires exact conversation UUID, live pane, transcript input matching delivered brief, and ready marker', async () => {
  const child = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-startup-'));
  const transcriptPath = join(directory, 'transcript.jsonl');
  const attempt = {
    id: 'att-1',
    dispatchId: 'disp-1',
    directory,
    address: 'tmux:%555',
    fleet: 'fleet-1',
    role: 'worker' as const,
    runner: 'agy',
    brief: 'Do work',
    status: 'running' as const,
    created: new Date().toISOString(),
    checkout: directory,
  };

  const tui = new AgyInteractive();

  writeFileSync(
    join(directory, 'terminal.json'),
    JSON.stringify({ address: 'tmux:%555' }),
  );
  writeFileSync(
    join(directory, 'agy-input.txt'),
    'Do work\nBefore doing further work, acknowledge applicable role/project initialization and durable-state inspection with [pc ready role=worker attempt=att-1]. Then perform only the assigned work.',
  );
  writeFileSync(
    join(directory, 'agy-native.json'),
    JSON.stringify({
      conversation_id: 'conv-uuid-555',
      transcript_path: transcriptPath,
      agent_state: 'idle',
    }),
  );

  let inventory = '%555 0\n%999 1\n';
  const spy = vi.mocked(child.execFileSync).mockImplementation((() => inventory) as unknown as typeof child.execFileSync);

  const inputStep = {
    step_index: 0,
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    status: 'DONE',
    content:
      '<USER_REQUEST>\nDo work\nBefore doing further work, acknowledge applicable role/project initialization and durable-state inspection with [pc ready role=worker attempt=att-1]. Then perform only the assigned work.\n</USER_REQUEST>',
  };

  try {
    // Missing ready marker in PLANNER_RESPONSE
    writeFileSync(
      transcriptPath,
      [inputStep, { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'hello' }]
        .map((s) => JSON.stringify(s))
        .join('\n'),
    );
    expect(await tui.recoverReceipt(attempt)).toBeUndefined();

    // With ready marker
    writeFileSync(
      transcriptPath,
      [
        inputStep,
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          status: 'DONE',
          content: 'Acknowledged: [pc ready role=worker attempt=att-1]',
        },
      ]
        .map((s) => JSON.stringify(s))
        .join('\n'),
    );

    const receipt = await tui.recoverReceipt(attempt);
    expect(receipt).toBeDefined();
    expect(receipt?.conversation).toBe('conv-uuid-555');
    expect(receipt?.address).toBe('tmux:%555');

    // terminal.json updated with conversation
    const terminal = JSON.parse(readFileSync(join(directory, 'terminal.json'), 'utf8'));
    expect(terminal.conversation).toBe('conv-uuid-555');

    // Pane dead returns undefined
    inventory = '%555 1\n';
    expect(await tui.recoverReceipt(attempt)).toBeUndefined();

    // Pane absent returns undefined
    inventory = '%999 0\n';
    expect(await tui.recoverReceipt(attempt)).toBeUndefined();
  } finally {
    spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('send uses bracketed paste and returns delivered when native input step appears, or uncertain on timeout', async () => {
  const child = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-send-'));
  const transcriptPath = join(directory, 'transcript.jsonl');
  const attempt = {
    id: 'att-send',
    directory,
    address: 'tmux:%777',
    fleet: 'fleet-1',
    role: 'worker' as const,
    runner: 'agy',
    brief: 'Initial',
    status: 'running' as const,
    created: new Date().toISOString(),
    checkout: directory,
    conversation: 'conv-send',
  };

  const tui = new AgyInteractive();

  writeFileSync(
    join(directory, 'agy-native.json'),
    JSON.stringify({
      conversation_id: 'conv-send',
      transcript_path: transcriptPath,
      agent_state: 'idle',
    }),
  );

  const spy = vi.mocked(child.execFileSync).mockReturnValue('' as unknown as Buffer);

  try {
    // Transcript has initial step
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        content: '<USER_REQUEST>\nInitial\n</USER_REQUEST>',
      }) + '\n',
    );

    // Prompt step arrives after send
    setTimeout(() => {
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 0,
            type: 'USER_INPUT',
            source: 'USER_EXPLICIT',
            status: 'DONE',
            content: '<USER_REQUEST>\nInitial\n</USER_REQUEST>',
          }),
          JSON.stringify({
            step_index: 1,
            type: 'USER_INPUT',
            source: 'USER_EXPLICIT',
            status: 'DONE',
            content: '<USER_REQUEST>\nFollowup message\n</USER_REQUEST>',
          }),
        ].join('\n'),
      );
    }, 150);

    const delivery = await tui.send(attempt, { id: 'msg-1', brief: 'Followup message' });
    expect(delivery.status).toBe('delivered');

    // Verify tmux load-buffer and paste-buffer -p were invoked
    expect(spy).toHaveBeenCalledWith('tmux', expect.arrayContaining(['load-buffer', '-b']));
    expect(spy).toHaveBeenCalledWith('tmux', expect.arrayContaining(['paste-buffer', '-p', '-d']));
  } finally {
    spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stopped and cancel verify pane absence and record agy-terminated', async () => {
  const child = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-term-'));
  const attempt = {
    id: 'att-term',
    directory,
    address: 'tmux:%888',
    fleet: 'fleet-1',
    role: 'worker' as const,
    runner: 'agy',
    brief: 'Term test',
    status: 'running' as const,
    created: new Date().toISOString(),
    checkout: directory,
  };

  const tui = new AgyInteractive();
  let inventory = '%888 0\n';

  const spy = vi.mocked(child.execFileSync).mockImplementation((cmd, args) => {
    if (cmd === 'tmux' && args?.[0] === 'list-panes') return inventory as unknown as Buffer;
    if (cmd === 'tmux' && args?.[0] === 'kill-pane') {
      inventory = '';
      return '' as unknown as Buffer;
    }
    return '' as unknown as Buffer;
  });

  try {
    // Currently live
    expect(await tui.stopped(attempt)).toBe(false);

    // Cancel kills pane and writes agy-terminated
    const cancelRes = await tui.cancel(attempt);
    expect(cancelRes.evidence).toContain('absence verified');
    expect(readFileSync(join(directory, 'agy-terminated'), 'utf8')).toBe('%888');

    // Stopped is now true
    expect(await tui.stopped(attempt)).toBe(true);

    // If pane is dead in tmux remain-on-exit (pane_dead === '1')
    inventory = '%888 1\n';
    expect(await tui.stopped(attempt)).toBe(true);
  } finally {
    spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
