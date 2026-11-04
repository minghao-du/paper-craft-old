import { vi, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyInteractive } from '../../packages/core/src/workflow/runtime/agy-interactive.js';
import { AgyRunner } from '../../packages/core/src/workflow/runtime/agy-runner.js';

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
      [inputStep, { ...inputStep, step_index: 1 }, resultStep]
        .map((s) => JSON.stringify(s))
        .join('\n'),
    );
    expect(await tui.result(attempt, 'dispatch-1')).toBeUndefined();

    // Non-USER_EXPLICIT step (e.g. system notification or tool output) does not prematurely truncate
    const systemStep = {
      step_index: 1,
      type: 'USER_INPUT',
      source: 'SYSTEM',
      status: 'DONE',
      content: '<SYSTEM_MESSAGE>background tool notification</SYSTEM_MESSAGE>',
    };
    const finalStep = {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      content: '[pc ready role=worker attempt=attempt-1]\nFinal output after tool',
    };
    writeFileSync(
      transcriptPath,
      [inputStep, systemStep, finalStep].map((s) => JSON.stringify(s)).join('\n'),
    );
    expect(await tui.result(attempt, 'dispatch-1')).toBe('Final output after tool');
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

  writeFileSync(join(directory, 'terminal.json'), JSON.stringify({ address: 'tmux:%555' }));
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
  const spy = vi
    .mocked(child.execFileSync)
    .mockImplementation((() => inventory) as unknown as typeof child.execFileSync);

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
      [
        inputStep,
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          status: 'DONE',
          content: 'hello',
        },
      ]
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

test('AgyRunner.collect polls result until completed or process stopped', async () => {
  const runner = new AgyRunner();
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-collect-'));
  const attempt = {
    id: 'att-collect',
    dispatchId: 'disp-collect',
    directory,
    address: 'tmux:%999',
    fleet: 'fleet-1',
    role: 'worker' as const,
    runner: 'agy',
    brief: 'Collect test',
    status: 'running' as const,
    created: new Date().toISOString(),
    checkout: directory,
  };
  try {
    // If stopped before result, throws
    vi.spyOn(runner, 'stopped').mockResolvedValue(true);
    vi.spyOn(runner, 'result').mockResolvedValue(undefined);
    await expect(runner.collect(attempt)).rejects.toThrow(
      /agy exited without a correlated task result/,
    );

    // If result becomes available after a delay, resolves
    let calls = 0;
    vi.spyOn(runner, 'stopped').mockResolvedValue(false);
    vi.spyOn(runner, 'result').mockImplementation(async () => {
      calls++;
      return calls >= 3 ? 'completed output' : undefined;
    });
    expect(await runner.collect(attempt)).toBe('completed output');

    // If deadline is exceeded, throws timeout error
    vi.spyOn(runner, 'stopped').mockResolvedValue(false);
    vi.spyOn(runner, 'result').mockResolvedValue(undefined);
    await expect(runner.collect(attempt, { timeoutMs: 50 })).rejects.toThrow(
      /Timed out waiting for correlated task result/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('messageReceipt verifies exact delivery and writes message definition', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-receipt-'));
  const transcriptPath = join(directory, 'transcript.jsonl');
  const attempt = {
    id: 'att-msg',
    directory,
    address: 'tmux:%777',
    fleet: 'fleet-1',
    role: 'worker' as const,
    runner: 'agy',
    brief: 'Work brief',
    status: 'running' as const,
    created: new Date().toISOString(),
    checkout: directory,
  };

  writeFileSync(
    join(directory, 'agy-native.json'),
    JSON.stringify({
      conversation_id: 'conv-msg-1',
      transcript_path: transcriptPath,
      agent_state: 'idle',
    }),
  );

  const tui = new AgyInteractive();
  try {
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        content: '<USER_REQUEST>\nConfirmed brief\n</USER_REQUEST>',
      }) + '\n',
    );

    // Matching message returns receipt and creates message file
    const receipt = await tui.messageReceipt(attempt, { id: 'msg-rec-1', brief: 'Confirmed brief' });
    expect(receipt).toBe('Native exact agy message input');
    expect(existsSync(join(directory, 'message-msg-rec-1.json'))).toBe(true);

    // Unmatched message returns undefined
    const missing = await tui.messageReceipt(attempt, { id: 'msg-rec-2', brief: 'Unmatched brief' });
    expect(missing).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('result refuses mismatched Run terminal or unactivated gated worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-attrib-'));
  const transcriptPath = join(directory, 'transcript.jsonl');
  const attempt: ManagedAttempt = {
    id: 'att-attr',
    run: 'run-1',
    dispatchId: 'disp-attr',
    directory,
    address: 'tmux:%555',
    fleet: 'fleet-1',
    role: 'worker' as const,
    runner: 'agy',
    brief: 'Task input',
    status: 'running' as const,
    created: new Date().toISOString(),
    checkout: directory,
    startupGate: true,
  };

  writeFileSync(
    join(directory, 'agy-native.json'),
    JSON.stringify({
      conversation_id: 'conv-attr',
      transcript_path: transcriptPath,
      agent_state: 'idle',
    }),
  );
  writeFileSync(
    join(directory, 'terminal.json'),
    JSON.stringify({
      run: 'run-different',
      session: 'pc-run-run-different',
      address: 'tmux:%555',
    }),
  );
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        content: '<USER_REQUEST>\nTask input\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        content: '[pc ready role=worker attempt=att-attr]\nOutput',
      }),
    ].join('\n'),
  );

  const tui = new AgyInteractive();
  try {
    // Run mismatch in terminal.json returns undefined
    expect(await tui.result(attempt, 'disp-attr')).toBeUndefined();

    // Fix terminal to match run-1
    writeFileSync(
      join(directory, 'terminal.json'),
      JSON.stringify({
        run: 'run-1',
        session: 'pc-run-run-1',
        address: 'tmux:%555',
      }),
    );

    // Still undefined because startupGate is true and activation is missing or uncertain
    expect(await tui.result(attempt, 'disp-attr')).toBeUndefined();

    // Activation uncertain also returns undefined
    attempt.activation = {
      id: 'act-1',
      brief: 'Task input',
      status: 'uncertain',
      evidence: 'lost connection',
    };
    expect(await tui.result(attempt, 'disp-attr')).toBeUndefined();

    // Activation delivered correlates successfully
    attempt.activation.status = 'delivered';
    expect(await tui.result(attempt, 'disp-attr')).toBe('Output');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Preparation must bind callback evidence to the launching pane, not a recent transcript.
test('child startup refuses missing or conflicting Run session ownership', async () => {
  const child = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-child-'));
  const attempt = {
    id: 'child',
    run: 'r1',
    directory,
    checkout: directory,
    brief: 'work',
    role: 'worker',
    runner: 'agy',
    fleet: 'f',
    status: 'starting',
    created: '',
  } as import('../../packages/core/src/workflow/runtime/runtime.js').ManagedAttempt;
  const launches: string[][] = [];
  vi.mocked(child.execFileSync).mockImplementation((_cmd, args) => {
    const a = args as string[];
    if (a[0] === 'list-sessions') return 'pc-run-r1 wrong\n';
    if (a[0] === 'new-window' || a[0] === 'new-session') launches.push(a);
    throw new Error('unexpected launch');
  });
  const persisted = { ...attempt };
  try {
    await expect(new AgyInteractive().start(attempt)).rejects.toThrow(/ownership/);
    expect(launches).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('children use separate exact panes in their Run session and cancellation leaves peers alive', async () => {
  const child = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-windows-'));
  const { mkdirSync } = await import('node:fs');
  const panes = new Map<string, string>();
  const targets: string[] = [];
  let nextPane = 100;
  vi.mocked(child.execFileSync).mockImplementation((_cmd, args) => {
    const a = args as string[];
    if (a[0] === 'list-sessions') return 'pc-run-r1 r1\npc-run-r2 r2\n';
    if (a[0] === 'display-message') {
      const pane = a[a.indexOf('-t') + 1];
      const run = pane === '%102' ? 'r2' : 'r1';
      return `pc-run-${run} ${run} ${pane}`;
    }
    if (a[0] === 'new-session') throw new Error('Child cannot create sessions');
    if (a[0] === 'new-window') {
      expect(a).toEqual(expect.arrayContaining(['-P', '-F', '#{pane_id}']));
      targets.push(a[a.indexOf('-t') + 1]);
      const pane = '%' + nextPane++;
      panes.set(pane, '1'); // immediate failure must affect only this pane
      return pane;
    }
    if (a[0] === 'list-panes') return [...panes].map(([p, state]) => `${p} ${state}`).join('\n');
    if (a[0] === 'kill-pane') panes.delete(a[a.indexOf('-t') + 1]);
    return '';
  });
  try {
    const adapter = new AgyInteractive();
    const attempts = ['r1', 'r1', 'r2'].map((run, i) => {
      const dir = join(directory, String(i));
      mkdirSync(dir);
      writeFileSync(join(dir, 'brief.md'), 'Original hash-bound task');
      return {
        id: 'child-' + i,
        ...(i === 1 ? { predecessor: 'prior-child' } : {}),
        run,
        directory: dir,
        checkout: dir,
        brief:
          i === 1
            ? 'Current retry reconciliation: inspect accepted results; initialize child-1'
            : 'Original hash-bound task\nAppended role initialization instructions',
        role: 'worker',
        runner: 'agy',
        fleet: 'f',
        status: 'starting',
        created: '',
        terminalSession: 'untrusted',
      } as import('../../packages/core/src/workflow/runtime/runtime.js').ManagedAttempt;
    });
    await Promise.all(attempts.map((a) => expect(adapter.start(a)).rejects.toThrow(/exited/)));
    for (const attempt of attempts) {
      const startup = readFileSync(join(attempt.directory, 'startup.md'), 'utf8');
      expect(startup).not.toContain(attempt.brief);
      expect(startup).toContain(join(attempt.directory, 'startup-assignment.md'));
      expect(readFileSync(join(attempt.directory, 'startup-assignment.md'), 'utf8')).toBe(
        attempt.brief,
      );
      expect(
        createHash('sha256')
          .update(readFileSync(join(attempt.directory, 'brief.md')))
          .digest('hex'),
      ).toBe(createHash('sha256').update('Original hash-bound task').digest('hex'));
      expect(readFileSync(join(attempt.directory, 'agy-input.txt'), 'utf8')).not.toContain(
        attempt.brief,
      );
    }
    expect(targets).toEqual(['pc-run-r1:', 'pc-run-r1:', 'pc-run-r2:']);
    expect(new Set(attempts.map((a) => a.address)).size).toBe(3);
    await adapter.cancel(attempts[0]);
    expect(panes.has(attempts[1].address!.slice(5))).toBe(true);
    expect(panes.has(attempts[2].address!.slice(5))).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('replacement rebuild requires every old Run execution terminated and rejects unknown session ownership', async () => {
  const child = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-rebuild-'));
  const a = {
    id: 'old',
    run: 'r1',
    terminalSession: 'pc-run-r1',
    address: 'tmux:%7',
    directory,
  } as import('../../packages/core/src/workflow/runtime/runtime.js').ManagedAttempt;
  let sessions = '';
  let creates = 0;
  vi.mocked(child.execFileSync).mockImplementation((_cmd, args) => {
    if (args?.[0] === 'list-sessions') return sessions;
    if (args?.[0] === 'list-panes') return '';
    if (args?.[0] === 'new-session') creates++;
    return '';
  });
  try {
    const tui = new AgyInteractive();
    await expect(tui.prepareReplacement(a, [a])).rejects.toThrow(/termination/);
    expect(creates).toBe(0);
    writeFileSync(join(directory, 'exit-code'), '0');
    await tui.prepareReplacement(a, [a]);
    expect(creates).toBe(1);
    sessions = 'pc-run-r1 wrong';
    await expect(tui.prepareReplacement(a, [a])).rejects.toThrow(/ownership/);
    expect(creates).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([false, true])(
  'independent Orchestrator retains exact terminal (skip permissions: %s)',
  async (dangerouslySkipPermissions) => {
    const child = await import('node:child_process');
    const directory = mkdtempSync(join(tmpdir(), 'pc-independent-'));
    const prior = { tmux: process.env.TMUX, pane: process.env.TMUX_PANE };
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const calls: string[][] = [];
    let live = false;
    const attempt = {
      id: 'attempt-independent',
      dangerouslySkipPermissions,
      run: 'run-independent',
      directory,
      checkout: directory,
      fleet: 'fleet',
      role: 'orchestrator' as const,
      runner: 'agy',
      brief: 'Task payload '.repeat(3000) + '\nInitialize only',
      status: 'starting' as const,
      created: new Date().toISOString(),
    };
    vi.mocked(child.execFileSync).mockImplementation((_command, args) => {
      const a = args as string[];
      calls.push(a);
      if (a[0] === 'list-sessions') return 'caller-session unrelated\n';
      if (a[0] === 'new-session') return '%401';
      if (a[0] === 'respawn-pane') {
        if (a.includes('-P') || a.includes('-F'))
          throw new Error('respawn-pane: unknown flag -P/-F');
        expect(
          JSON.parse(readFileSync(join(directory, 'agy-settings.json'), 'utf8')).statusLine.enabled,
        ).toBe(true);
        return ''; // tmux respawn-pane does not print the pane ID
      }
      if (a[0] === 'list-panes') return `%401 ${live ? 0 : 1}\n%200 0\n`;
      if (a[0] === 'display-message') {
        return a.at(-1) === '#{window_id}' ? '@91' : 'pc-run-run-independent run-independent %401';
      }
      if (a[0] === 'capture-pane') return 'Login required';
      return '';
    });
    const contextPath = join(directory, 'context.md');
    writeFileSync(contextPath, attempt.brief);
    const initialization = {
      registry: join(directory, 'registry.json'),
      authority: attempt.id,
      run: attempt.run,
      subject: 'owner/repo#1',
      role: attempt.role,
      attempt: attempt.id,
      briefHash: createHash('sha256').update(attempt.brief).digest('hex'),
      context: {
        path: contextPath,
        hash: createHash('sha256').update(attempt.brief).digest('hex'),
      },
    };
    const managed = { ...attempt, initialization, startupGate: true };
    const persisted = { ...managed };
    try {
      await expect(new AgyInteractive().start(managed)).rejects.toThrow(/Login required/);
      const startup = readFileSync(join(directory, 'startup.md'), 'utf8');
      expect(startup).not.toContain('Task payload');
      expect(startup).not.toContain('startup-assignment.md');
      expect(startup).toContain('End this turn immediately');
      expect(startup.indexOf('## Steps')).toBeLessThan(
        startup.indexOf('## Initialization payload'),
      );
      const payload = startup.match(/```json\n([\s\S]*?)\n```/)![1];
      expect(JSON.parse(payload)).toEqual(initialization);
      expect(readFileSync(contextPath, 'utf8')).toBe(attempt.brief);
      const submitted = readFileSync(join(directory, 'agy-input.txt'), 'utf8');
      expect(submitted).toContain(join(directory, 'startup.md'));
      expect(submitted).toContain(attempt.id);
      expect(submitted).not.toContain('Task payload');
      expect(submitted).not.toContain('Initialize only');
      expect(
        readFileSync(join(directory, 'agy-launch.sh'), 'utf8').includes(
          "'--dangerously-skip-permissions'",
        ),
      ).toBe(dangerouslySkipPermissions);
      expect(managed).toMatchObject({
        address: 'tmux:%401',
        terminalSession: 'pc-run-run-independent',
        providerState: {
          paneId: '%401',
          windowId: '@91',
        },
      });
      await expect(new AgyInteractive().recoverReceipt(persisted)).resolves.toBeUndefined();
      expect(persisted).toMatchObject({
        address: 'tmux:%401',
        terminalSession: 'pc-run-run-independent',
        providerState: {
          paneId: '%401',
          windowId: '@91',
        },
      });
      live = true;
      const transcript = join(directory, 'native.jsonl');
      writeFileSync(
        join(directory, 'agy-native.json'),
        JSON.stringify({
          conversation_id: 'new-native',
          transcript_path: transcript,
          agent_state: 'idle',
        }),
      );
      const ready = {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        content: '[pc ready role=orchestrator attempt=attempt-independent]',
      };
      const input = {
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        content: submitted,
      };
      writeFileSync(transcript, [input, ready].map((s) => JSON.stringify(s)).join('\n'));
      await expect(new AgyInteractive().recoverReceipt(persisted)).resolves.toMatchObject({
        conversation: 'new-native',
      });
      writeFileSync(
        transcript,
        [{ ...input, content: attempt.brief }, ready].map((s) => JSON.stringify(s)).join('\n'),
      );
      await expect(new AgyInteractive().recoverReceipt(persisted)).resolves.toBeUndefined();
      expect(calls.find((a) => a[0] === 'new-session')).toEqual([
        'new-session',
        '-P',
        '-F',
        '#{pane_id}',
        '-d',
        '-s',
        'pc-run-run-independent',
        '-n',
        'orchestrator-attempt-',
      ]);
      expect(
        calls.some((a) =>
          ['move-window', 'rename-session', 'rename-window', 'kill-pane'].includes(a[0]),
        ),
      ).toBe(false);
    } finally {
      if (prior.tmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = prior.tmux;
      if (prior.pane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = prior.pane;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// These failures occur after publication but before the release marker, retaining the failed evidence.
test.each(['missing', 'unreadable', 'mismatched'])(
  'startup content %s fails before execution release without inline fallback',
  async (failure) => {
    const child = await import('node:child_process');
    const { existsSync, mkdirSync } = await import('node:fs');
    const directory = mkdtempSync(join(tmpdir(), "pc startup 'quoted'-"));
    const startup = join(directory, 'startup.md');
    const attempt = {
      id: 'new-attempt',
      run: 'r1',
      directory,
      checkout: directory,
      fleet: 'f',
      role: 'orchestrator' as const,
      runner: 'agy',
      brief: 'Complete initialization payload',
      status: 'starting' as const,
      created: '',
      startupGate: true,
    };
    vi.mocked(child.execFileSync).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === 'list-sessions') return '';
      if (a[0] === 'new-session') return '%1';
      if (a[0] === 'display-message') return '@1';
      if (a[0] === 'set-option' && a.includes('remain-on-exit')) {
        rmSync(startup);
        if (failure === 'unreadable') mkdirSync(startup);
        if (failure === 'mismatched') writeFileSync(startup, 'Unrelated prior content');
      }
      return '';
    });
    try {
      await expect(new AgyInteractive().start(attempt)).rejects.toThrow(
        /startup document .*startup\.md/,
      );
      expect(existsSync(join(directory, 'agy-launch-ready'))).toBe(false);
      expect(readFileSync(join(directory, 'brief.md'), 'utf8')).toBe(attempt.brief);
      expect(readFileSync(join(directory, 'agy-input.txt'), 'utf8')).not.toContain(attempt.brief);
      if (failure === 'mismatched')
        expect(readFileSync(startup, 'utf8')).toBe('Unrelated prior content');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('recoverReceipt validates and updates encapsulated providerState and refuses corrupt evidence', async () => {
  const child = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'pc-agy-rec-'));
  const transcriptPath = join(directory, 'transcript.jsonl');
  const tui = new AgyInteractive();

  const attempt: import('../../packages/core/src/workflow/runtime/runtime.js').ManagedAttempt = {
    id: 'att-1',
    run: 'r1',
    directory,
    checkout: directory,
    fleet: 'f',
    role: 'orchestrator',
    runner: 'agy',
    brief: 'brief text',
    status: 'running',
    created: '',
    address: 'tmux:%5',
    providerState: {
      session: 'pc-run-r1',
      paneId: '%5',
      windowId: '@1',
      address: 'tmux:%5',
      run: 'r1',
    },
  };

  vi.mocked(child.execFileSync).mockImplementation((_cmd, args) => {
    const a = args as string[];
    if (a[0] === 'list-panes') return '%5 0\n';
    if (a[0] === 'display-message') return 'pc-run-r1 r1 %5';
    return '';
  });

  try {
    // 1. Mismatched Run ownership in providerState
    await expect(
      tui.recoverReceipt({
        ...attempt,
        providerState: { ...attempt.providerState, run: 'r-foreign' },
      }),
    ).rejects.toThrow(/Durable terminal Run ownership mismatch/);

    // 2. Mismatched session in providerState
    await expect(
      tui.recoverReceipt({
        ...attempt,
        providerState: { ...attempt.providerState, session: 'pc-run-other' },
      }),
    ).rejects.toThrow(/Durable terminal Run ownership mismatch/);

    // 3. Mismatched address in providerState
    await expect(
      tui.recoverReceipt({
        ...attempt,
        address: 'tmux:%5',
        providerState: { ...attempt.providerState, address: 'tmux:%99' },
      }),
    ).rejects.toThrow(/Durable terminal address mismatch/);

    // 4. Corrupt terminal.json throws explicit error
    writeFileSync(join(directory, 'terminal.json'), '{ broken json');
    await expect(tui.recoverReceipt(attempt)).rejects.toThrow(
      /Corrupt terminal recovery evidence/,
    );
    rmSync(join(directory, 'terminal.json'));

    // 5. Corrupt agy-native.json throws explicit error
    writeFileSync(join(directory, 'agy-native.json'), '{ broken json');
    await expect(tui.recoverReceipt(attempt)).rejects.toThrow(
      /Corrupt native recovery evidence/,
    );

    // 6. Valid native output and transcript recovery updates providerState
    writeFileSync(
      join(directory, 'agy-native.json'),
      JSON.stringify({ conversation_id: 'conv-rec', transcript_path: transcriptPath }),
    );
    writeFileSync(join(directory, 'agy-input.txt'), 'brief text');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          source: 'USER_EXPLICIT',
          status: 'DONE',
          content: '<USER_REQUEST>\nbrief text\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          status: 'DONE',
          content: '[pc ready role=orchestrator attempt=att-1]\nready output',
        }),
      ].join('\n'),
    );

    const testAttempt = { ...attempt, conversation: undefined };
    const receipt = await tui.recoverReceipt(testAttempt);
    expect(receipt).toEqual({
      conversation: 'conv-rec',
      address: 'tmux:%5',
      evidence: 'Native agy exact conversation and complete submitted brief',
    });
    expect(testAttempt.providerState?.conversation).toBe('conv-rec');
    expect(testAttempt.providerState?.session).toBe('pc-run-r1');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

