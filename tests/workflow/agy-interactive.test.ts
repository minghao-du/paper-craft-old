import { vi, test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyInteractive } from '../../packages/core/src/workflow/runtime/agy-interactive.js';
import { AgyRunner } from '../../packages/core/src/workflow/runtime/runtime.js';

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
    vi.spyOn(
      (runner as unknown as { tui: { result: () => Promise<string | undefined> } }).tui,
      'result',
    ).mockResolvedValue(undefined);
    await expect(runner.collect(attempt)).rejects.toThrow(
      /agy exited without a correlated task result/,
    );

    // If result becomes available after a delay, resolves
    let calls = 0;
    vi.spyOn(runner, 'stopped').mockResolvedValue(false);
    vi.spyOn(
      (runner as unknown as { tui: { result: () => Promise<string | undefined> } }).tui,
      'result',
    ).mockImplementation(async () => {
      calls++;
      return calls >= 3 ? 'completed output' : undefined;
    });
    expect(await runner.collect(attempt)).toBe('completed output');
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
      return {
        id: 'child-' + i,
        run,
        directory: dir,
        checkout: dir,
        brief: 'work',
        role: 'worker',
        runner: 'agy',
        fleet: 'f',
        status: 'starting',
        created: '',
        terminalSession: 'untrusted',
      } as import('../../packages/core/src/workflow/runtime/runtime.js').ManagedAttempt;
    });
    await Promise.all(attempts.map((a) => expect(adapter.start(a)).rejects.toThrow(/exited/)));
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

test('independent Orchestrator starts outside tmux and retains exact terminal on failed startup', async () => {
  const child = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'pc-independent-'));
  const prior = { tmux: process.env.TMUX, pane: process.env.TMUX_PANE };
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const calls: string[][] = [];
  const attempt = {
    id: 'attempt-independent',
    run: 'run-independent',
    directory,
    checkout: directory,
    fleet: 'fleet',
    role: 'orchestrator' as const,
    runner: 'agy',
    brief: 'Initialize only',
    status: 'starting' as const,
    created: new Date().toISOString(),
  };
  vi.mocked(child.execFileSync).mockImplementation((_command, args) => {
    const a = args as string[];
    calls.push(a);
    if (a[0] === 'list-sessions') return 'caller-session unrelated\n';
    if (a[0] === 'new-session') return '%401';
    if (a[0] === 'respawn-pane') {
      expect(
        JSON.parse(readFileSync(join(directory, 'agy-settings.json'), 'utf8')).statusLine.enabled,
      ).toBe(true);
      return '%401';
    }
    if (a[0] === 'list-panes') return '%401 1\n%200 0\n';
    if (a[0] === 'display-message') {
      return a.at(-1) === '#{window_id}' ? '@91' : 'pc-run-run-independent run-independent %401';
    }
    if (a[0] === 'capture-pane') return 'Login required';
    return '';
  });
  try {
    await expect(new AgyInteractive().start(attempt)).rejects.toThrow(/Login required/);
    expect(attempt).toMatchObject({
      address: 'tmux:%401',
      terminalSession: 'pc-run-run-independent',
      paneId: '%401',
      windowId: '@91',
    });
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
});
