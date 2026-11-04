import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerWorkflowCommands } from '../../packages/cli/src/commands/workflow.js';
import { outputRegistry } from './fixtures/concise-output/registry.js';
import { inspectRuns, startRun, recoverRun } from '@paper-craft/core/workflow/run-driver';

const fixture = JSON.parse(JSON.stringify(outputRegistry()));
vi.mock('@paper-craft/core/workflow/run-driver', async (original) => ({
  ...(await original<typeof import('@paper-craft/core/workflow/run-driver')>()),
  inspectRuns: vi.fn(),
  startRun: vi.fn(async () => fixture.runs[0]),
  recoverRun: vi.fn(async () => ({
    blockers: ['Occupancy unknown'],
    pendingDispatches: ['pending-0'],
  })),
}));
vi.mock('@paper-craft/core/workflow/issue-driver', async (original) => ({
  ...(await original<typeof import('@paper-craft/core/workflow/issue-driver')>()),
  readIssue: () => fixture.runs[0].subject,
}));
vi.mock('@paper-craft/core/workflow/run-subject', async (original) => ({
  ...(await original<typeof import('@paper-craft/core/workflow/run-subject')>()),
  readIssue: () => fixture.runs[0].subject,
}));
vi.mock('@paper-craft/core/workflow/fleet-config', async (original) => ({
  ...(await original<typeof import('@paper-craft/core/workflow/fleet-config')>()),
  loadFleetConfig: vi.fn(() => ({ project: '/project', file: '/project/.epic-config.json' })),
}));
vi.mock('../../packages/cli/src/workflow/composition.js', () => ({
  createRunner: () => ({ name: 'agy', preflight: async () => {} }),
  launchStartupSupervisor: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

async function invoke(args: string[]) {
  const stdout: string[] = [],
    stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s) => {
    stdout.push(String(s) + '\n');
  });
  vi.spyOn(console, 'error').mockImplementation((s) => {
    stderr.push(String(s) + '\n');
  });
  process.exitCode = 0;
  const program = new Command();
  registerWorkflowCommands(program, { human: () => false });
  await program.parseAsync(['workflow', 'orchestrator', ...args], { from: 'user' });
  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: process.exitCode };
}

it('retains every current Run and pending matter while omitting handled bodies', async () => {
  vi.mocked(inspectRuns).mockReturnValue(structuredClone(fixture));
  if (process.env.PC_CAPTURE_BASELINE) {
    const calls = [
      ['status'],
      ['start', '7', '--provider', 'agy', '--type', 'issue'],
      ['recover', 'run-1'],
    ];
    const baseline = [];
    for (const args of calls) {
      const result = await invoke(args);
      baseline.push({
        args,
        ...result,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
        totalBytes: Buffer.byteLength(result.stdout + result.stderr),
      });
    }
    writeFileSync(
      new URL('./fixtures/concise-output/baseline.json', import.meta.url),
      JSON.stringify(baseline, null, 2) + '\n',
    );
    return;
  }
  const result = await invoke(['status']);
  if (process.env.PC_MEASURE_STATUS)
    writeFileSync(
      '/tmp/pc-106-context/status-after.json',
      JSON.stringify({
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
        totalBytes: Buffer.byteLength(result.stdout + result.stderr),
      }),
    );
  const visible = JSON.parse(result.stdout);
  expect(visible.outcome).toBe('succeeded');
  expect(visible.runs.map((r: { id: string }) => r.id)).toEqual(['run-1', 'run-2']);
  expect(visible.dispatches).toHaveLength(35);
  expect(visible.receipts).toHaveLength(35);
  expect(result.stdout).toContain('/runtime/result-34.json');
  expect(result.stdout).toContain('Occupancy unknown');
  expect(result.stdout).toContain('"status":"unknown"');
  expect(visible.resources).toEqual(fixture.resources);
  expect(result.stdout).not.toContain('IMMUTABLE-BRIEF-BODY');
  expect(result.stdout).not.toContain('HANDLED-HISTORY');
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  const baseline = JSON.parse(
    readFileSync(new URL('./fixtures/concise-output/baseline.json', import.meta.url), 'utf8'),
  )[0];
  expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThan(baseline.totalBytes);
  const detailed = await invoke(['status', '--detailed']);
  expect(JSON.parse(detailed.stdout).runs).toEqual(fixture.runs);
  expect(detailed.exitCode).toBe(0);
  fixture.runs[0].priorOrchestrators.push({
    ...fixture.runs[0].orchestrator,
    id: 'older',
    brief: 'NEW-HANDLED-BODY'.repeat(500),
  });
  const historical = structuredClone(fixture.dispatches[0]);
  historical.id = 'handled-dispatch';
  historical.lifecycle = 'accepted';
  historical.brief = 'HANDLED-DISPATCH-BODY'.repeat(500);
  historical.attempts[0].brief = 'HANDLED-ATTEMPT-BODY'.repeat(500);
  historical.messages = [
    {
      id: 'old-message',
      attemptId: historical.attempts[0].id,
      status: 'completed',
      brief: 'HANDLED-MESSAGE-BODY'.repeat(500),
    },
  ];
  fixture.dispatches.push(historical);
  fixture.receipts.push({
    ...fixture.receipts[0],
    id: 'handled-receipt',
    dispatchId: historical.id,
  });
  fixture.acknowledgements.push({
    id: 'ack',
    receiptId: 'handled-receipt',
    accepted: true,
    evidence: '/runtime/acceptance.json',
  });
  vi.mocked(inspectRuns).mockReturnValue(structuredClone(fixture));
  const grown = await invoke(['status']);
  expect(grown.stdout).not.toContain('NEW-HANDLED-BODY');
  expect(JSON.parse(grown.stdout).dispatches).toHaveLength(36);
  expect(JSON.parse(grown.stdout).receipts).toHaveLength(35);
  expect(grown.stdout).not.toContain('HANDLED-DISPATCH-BODY');
  expect(grown.stdout).not.toContain('HANDLED-ATTEMPT-BODY');
  expect(grown.stdout).not.toContain('HANDLED-MESSAGE-BODY');
});

it('reports status read failures without treating unknown occupancy as termination', async () => {
  vi.mocked(inspectRuns).mockImplementation(() => {
    throw new Error('Registry unavailable; inspect configured root');
  });
  const result = await invoke(['status']);
  expect(JSON.parse(result.stdout)).toEqual({
    outcome: 'failed',
    status: 'unknown',
    error: 'Registry unavailable; inspect configured root',
  });
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(2);
});

it('returns concise Start state and full detail without launching twice per invocation', async () => {
  const current = structuredClone(outputRegistry().runs[0]);
  vi.mocked(startRun).mockResolvedValue(current as never);
  vi.mocked(startRun).mockClear();
  const args = ['start', '7', '--provider', 'agy', '--type', 'issue'];
  const result = await invoke(args);
  if (process.env.PC_MEASURE_START)
    writeFileSync(
      '/tmp/pc-106-context/start-after.json',
      JSON.stringify({
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
        totalBytes: Buffer.byteLength(result.stdout + result.stderr),
      }),
    );
  const value = JSON.parse(result.stdout);
  expect(value.outcome).toBe('blocked');
  expect(value.run).toBe('run-1');
  expect(value.lifecycle).toBe('blocked');
  expect(value.attempt).toBe('attempt-current');
  expect(value.attemptStatus).toBe('unknown');
  expect(value.observation).toEqual({ status: 'unknown', evidence: 'Cannot establish occupancy' });
  expect(value.blockers).toEqual(['Occupancy unknown']);
  expect(value.context).toEqual({ path: '/runtime/context.md', hash: 'context-hash' });
  expect(result.stdout).not.toContain('IMMUTABLE-BRIEF-BODY');
  expect(result.stdout).not.toContain('HANDLED-HISTORY');
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(2);
  const baseline = JSON.parse(
    readFileSync(new URL('./fixtures/concise-output/baseline.json', import.meta.url), 'utf8'),
  )[1];
  expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThan(baseline.totalBytes);
  const detailed = await invoke([...args, '--detailed']);
  expect(JSON.parse(detailed.stdout).requirements).toBe(current.requirements);
  expect(detailed.exitCode).toBe(2);
  current.lifecycle = 'running';
  current.orchestrator.status = 'running';
  Object.assign(current.orchestrator, { evidence: '/runtime/native-ack.json' });
  const success = await invoke(args);
  expect(JSON.parse(success.stdout)).toMatchObject({
    outcome: 'succeeded',
    lifecycle: 'running',
    attemptStatus: 'running',
  });
  expect(JSON.parse(success.stdout).evidence).toBe('/runtime/native-ack.json');
  expect(success.exitCode).toBe(0);
  expect(startRun).toHaveBeenCalledTimes(3);
});

it('keeps hidden startup diagnostics readable without changing failed or successful work', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-start-output-')));
  const config = {
    root,
    project: root,
    file: join(root, '.epic-config.json'),
    slots: [],
    worktrees: false,
    base: 'main',
  };
  vi.mocked(loadFleetConfig).mockReturnValue(config);
  const home = join(root, '.runtime', createHash('sha256').update(config.file).digest('hex'));
  const message =
    'agy capability probe failed: ' + 'TERMINAL-DETAIL '.repeat(200) + 'api_key=do-not-save';
  const args = ['start', '7', '--provider', 'agy', '--type', 'issue'];
  try {
    vi.mocked(startRun).mockRejectedValue(new Error(message));
    const failed = await invoke(args);
    if (process.env.PC_CAPTURE_START_ERROR) {
      writeFileSync(
        new URL('./fixtures/concise-output/start-error-baseline.json', import.meta.url),
        JSON.stringify(
          {
            message,
            stdoutBytes: Buffer.byteLength(failed.stdout),
            stderrBytes: Buffer.byteLength(failed.stderr),
            totalBytes: Buffer.byteLength(failed.stdout + failed.stderr),
            exitCode: failed.exitCode,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    if (process.env.PC_MEASURE_START)
      writeFileSync(
        '/tmp/pc-106-context/start-error-after.json',
        JSON.stringify({
          stdoutBytes: Buffer.byteLength(failed.stdout),
          stderrBytes: Buffer.byteLength(failed.stderr),
          totalBytes: Buffer.byteLength(failed.stdout + failed.stderr),
        }),
      );
    const value = JSON.parse(failed.stdout);
    expect(value).toMatchObject({
      outcome: 'failed',
      status: 'unknown',
      error: 'agy capability probe failed; inspect diagnostics and authentication/configuration',
    });
    expect(failed.stdout + failed.stderr).not.toContain('TERMINAL-DETAIL');
    expect(failed.exitCode).toBe(2);
    expect(failed.stderr).toBe('');
    const saved = JSON.parse(readFileSync(value.diagnostics[0].path, 'utf8'));
    expect(saved).toMatchObject({ command: 'start', subject: 'org/repo#7' });
    expect(saved.invocation).toBeTruthy();
    expect(saved.error).toContain('TERMINAL-DETAIL');
    expect(saved.error).not.toContain('do-not-save');
    vi.mocked(startRun).mockRejectedValueOnce(
      new Error(
        'agy capability probe failed: {"api_key":"JSON-SECRET", "password": "QUOTED SECRET"}',
      ),
    );
    const quoted = JSON.parse((await invoke(args)).stdout);
    const quotedRecord = readFileSync(quoted.diagnostics[0].path, 'utf8');
    expect(quotedRecord).not.toContain('JSON-SECRET');
    expect(quotedRecord).not.toContain('QUOTED SECRET');
    const current = structuredClone(outputRegistry().runs[0]);
    current.lifecycle = 'running';
    current.orchestrator.status = 'running';
    Object.assign(current.orchestrator, { error: message });
    vi.mocked(startRun).mockResolvedValue(current as never);
    const success = await invoke(args);
    expect(JSON.parse(success.stdout)).toMatchObject({
      outcome: 'succeeded',
      lifecycle: 'running',
    });
    expect(success.exitCode).toBe(0);
    const startupError =
      'Error: Agy exited before native acknowledgement; inspect terminal and authentication/configuration at tmux:%12: ' +
      'SAVED-TERMINAL '.repeat(100);
    Object.assign(current.orchestrator, { error: startupError });
    const registryPath = join(home, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({ runs: [current] }));
    const count = readdirSync(home).length;
    const existing = JSON.parse((await invoke(args)).stdout);
    expect(existing.diagnostics).toEqual([
      { path: registryPath, run: 'run-1', attempt: 'attempt-current' },
    ]);
    expect(readdirSync(home).length).toBe(count);
    vi.mocked(inspectRuns).mockReturnValue({
      ...structuredClone(fixture),
      runs: [current],
    } as never);
    const status = await invoke(['status']);
    expect(status.stdout).not.toContain('SAVED-TERMINAL');
    expect(status.stdout).toContain(registryPath);
    // A non-directory at the existing runtime home forces a real filesystem save failure.
    rmSync(home, { recursive: true, force: true });
    writeFileSync(home, 'blocked storage');
    const unavailable = await invoke(args);
    const unavailableValue = JSON.parse(unavailable.stdout);
    expect(unavailableValue.outcome).toBe('succeeded');
    expect(unavailableValue.diagnosticSaveError).toBeTruthy();
    expect(unavailableValue.diagnostics).toBeUndefined();
    expect(unavailable.exitCode).toBe(0);
    expect(unavailable.stderr).toBe('');
    // Physical-root escape must fail independently of the business result.
    rmSync(home);
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'pc-outside-')));
    try {
      symlinkSync(elsewhere, home);
      const escaped = JSON.parse((await invoke(args)).stdout);
      expect(escaped.outcome).toBe('succeeded');
      expect(escaped.diagnosticSaveError).toContain('symlink');
      expect(escaped.diagnostics).toBeUndefined();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reports Recover outcome, current evidence and uncertainty without changing recovery in detailed mode', async () => {
  const current = structuredClone(outputRegistry().runs[0]);
  vi.mocked(inspectRuns).mockReturnValue({ ...structuredClone(fixture), runs: [current] } as never);
  vi.mocked(recoverRun).mockClear();
  vi.mocked(recoverRun).mockResolvedValue({
    blockers: ['Occupancy unknown'],
    pendingDispatches: ['pending-0'],
  });
  const blocked = await invoke(['recover', 'run-1']);
  expect(JSON.parse(blocked.stdout)).toMatchObject({
    outcome: 'blocked',
    blockers: ['Occupancy unknown'],
    pendingDispatches: ['pending-0'],
    inspection: {
      run: 'run-1',
      lifecycle: 'blocked',
      attempt: 'attempt-current',
      attemptStatus: 'unknown',
      context: { path: '/runtime/context.md', hash: 'context-hash' },
    },
    observation: { status: 'unknown', evidence: 'Cannot establish occupancy' },
    reconciliation: current.reconciliation,
  });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stderr).toBe('');
  expect(blocked.stdout).not.toContain('IMMUTABLE-BRIEF-BODY');
  if (process.env.PC_MEASURE_RECOVER)
    writeFileSync(
      '/tmp/pc-106-context/recover-after.json',
      JSON.stringify({
        stdoutBytes: Buffer.byteLength(blocked.stdout),
        stderrBytes: Buffer.byteLength(blocked.stderr),
        totalBytes: Buffer.byteLength(blocked.stdout + blocked.stderr),
      }),
    );
  current.lifecycle = 'running';
  current.orchestrator.status = 'running';
  current.reconciliation.blockers = [];
  Object.assign(current.orchestrator, { evidence: '/runtime/recovery-ack.json' });
  vi.mocked(recoverRun).mockResolvedValue({ blockers: [], pendingDispatches: ['pending-0'] });
  const success = await invoke(['recover', 'run-1', '--replace']);
  expect(JSON.parse(success.stdout)).toMatchObject({
    outcome: 'succeeded',
    blockers: [],
    inspection: { lifecycle: 'running', attemptStatus: 'running' },
  });
  expect(JSON.parse(success.stdout).evidence).toBe('/runtime/recovery-ack.json');
  expect(success.exitCode).toBe(0);
  expect(success.stderr).toBe('');
  const detailed = await invoke(['recover', 'run-1', '--replace', '--detailed']);
  expect(JSON.parse(detailed.stdout)).toEqual(JSON.parse(success.stdout));
  expect(detailed.exitCode).toBe(0);
  expect(detailed.stderr).toBe('');
  expect(recoverRun).toHaveBeenCalledTimes(3);
  expect(vi.mocked(recoverRun).mock.calls[1][3]).toMatchObject({ replaceOrchestrator: true });
  expect(vi.mocked(recoverRun).mock.calls[2][3]).toMatchObject({ replaceOrchestrator: true });
});

it('keeps Recover diagnostic failures separate from recovery and preserves current state on errors', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-recover-output-')));
  const config = {
    root,
    project: root,
    file: join(root, '.epic-config.json'),
    slots: [],
    worktrees: false,
    base: 'main',
  };
  vi.mocked(loadFleetConfig).mockReturnValue(config);
  const current = structuredClone(outputRegistry().runs[0]);
  current.lifecycle = 'running';
  current.orchestrator.status = 'running';
  const message = 'agy capability probe failed: ' + 'RECOVER-TERMINAL '.repeat(200);
  vi.mocked(inspectRuns).mockReturnValue({ ...structuredClone(fixture), runs: [current] } as never);
  try {
    vi.mocked(recoverRun).mockRejectedValue(new Error(message));
    const failed = await invoke(['recover', 'run-1']);
    if (process.env.PC_CAPTURE_RECOVER_ERROR) {
      writeFileSync(
        new URL('./fixtures/concise-output/recover-error-baseline.json', import.meta.url),
        JSON.stringify(
          {
            message,
            stdoutBytes: Buffer.byteLength(failed.stdout),
            stderrBytes: Buffer.byteLength(failed.stderr),
            totalBytes: Buffer.byteLength(failed.stdout + failed.stderr),
            exitCode: failed.exitCode,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    const value = JSON.parse(failed.stdout);
    expect(value).toMatchObject({
      outcome: 'failed',
      status: 'unknown',
      inspection: { run: 'run-1', lifecycle: 'running', attemptStatus: 'running' },
    });
    expect(failed.stdout + failed.stderr).not.toContain('RECOVER-TERMINAL');
    expect(failed.exitCode).toBe(2);
    expect(failed.stderr).toBe('');
    const saved = JSON.parse(readFileSync(value.diagnostics[0].path, 'utf8'));
    expect(saved).toMatchObject({
      command: 'recover',
      run: 'run-1',
      attempt: 'attempt-current',
      error: message,
    });
    expect(saved.invocation).toBeTruthy();
    if (process.env.PC_MEASURE_RECOVER)
      writeFileSync(
        '/tmp/pc-106-context/recover-error-after.json',
        JSON.stringify({
          stdoutBytes: Buffer.byteLength(failed.stdout),
          stderrBytes: Buffer.byteLength(failed.stderr),
          totalBytes: Buffer.byteLength(failed.stdout + failed.stderr),
        }),
      );
    const detailed = await invoke(['recover', 'run-1', '--detailed']);
    expect(JSON.parse(detailed.stdout).error).toBe(message);
    expect(detailed.exitCode).toBe(2);
    expect(detailed.stderr).toBe('');
    const blocker = 'worker-1: Error: Startup failed at tmux:%12: ' + 'BLOCKER-DETAIL '.repeat(100);
    vi.mocked(recoverRun).mockResolvedValue({
      blockers: [blocker],
      pendingDispatches: ['pending-0'],
    });
    const blocked = await invoke(['recover', 'run-1']);
    expect(JSON.parse(blocked.stdout).blockers).toEqual([
      'worker-1: Error: Startup failed at tmux:%12',
    ]);
    expect(blocked.stdout + blocked.stderr).not.toContain('BLOCKER-DETAIL');
    expect(
      JSON.parse(readFileSync(JSON.parse(blocked.stdout).diagnostics[0].path, 'utf8')).error,
    ).toBe(blocker);
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toBe('');
    current.reconciliation.blockers = [blocker];
    const storedHome = join(
      root,
      '.runtime',
      createHash('sha256').update(config.file).digest('hex'),
    );
    const storedRegistry = join(storedHome, 'registry.json');
    writeFileSync(storedRegistry, JSON.stringify({ runs: [current] }));
    const storedCount = readdirSync(storedHome).length;
    const reused = JSON.parse((await invoke(['recover', 'run-1'])).stdout);
    expect(reused.diagnostics).toEqual([
      {
        path: storedRegistry,
        run: 'run-1',
        attempt: 'attempt-current',
        field: 'reconciliation.blockers',
        index: 0,
      },
    ]);
    expect(readdirSync(storedHome).length).toBe(storedCount);
    // Successful reconciliation may retain an old diagnostic, without changing its outcome.
    Object.assign(current.orchestrator, { error: message });
    vi.mocked(recoverRun).mockResolvedValue({ blockers: [], pendingDispatches: [] });
    const home = join(root, '.runtime', createHash('sha256').update(config.file).digest('hex'));
    const registryPath = join(home, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({ runs: [current] }));
    const before = readdirSync(home).length;
    const success = await invoke(['recover', 'run-1']);
    expect(JSON.parse(success.stdout)).toMatchObject({
      outcome: 'succeeded',
      diagnostics: [{ path: registryPath, run: 'run-1', attempt: 'attempt-current' }],
    });
    expect(success.stdout + success.stderr).not.toContain('RECOVER-TERMINAL');
    expect(success.exitCode).toBe(0);
    expect(readdirSync(home).length).toBe(before);
    rmSync(home, { recursive: true });
    writeFileSync(home, 'blocked storage');
    const unavailable = await invoke(['recover', 'run-1']);
    expect(JSON.parse(unavailable.stdout)).toMatchObject({
      outcome: 'succeeded',
      diagnosticSaveError: expect.any(String),
    });
    expect(JSON.parse(unavailable.stdout).diagnostics).toBeUndefined();
    expect(unavailable.exitCode).toBe(0);
    expect(unavailable.stderr).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps pending message identities and references without repeating their Brief bodies', async () => {
  const registry = structuredClone(outputRegistry());
  Object.assign(registry.dispatches[0], {
    messages: [
      {
        id: 'followup-1',
        status: 'uncertain',
        attemptId: 'worker-0',
        brief: 'PENDING-FOLLOWUP-BODY'.repeat(100),
      },
    ],
  });
  vi.mocked(inspectRuns).mockReturnValue(registry as never);
  const concise = await invoke(['status']);
  expect(JSON.parse(concise.stdout).dispatches[0].messages[0]).toMatchObject({
    id: 'followup-1',
    status: 'uncertain',
    attemptId: 'worker-0',
    reference: { dispatch: 'pending-0', message: 'followup-1' },
  });
  expect(concise.stdout).not.toContain('PENDING-FOLLOWUP-BODY');
  const detailed = await invoke(['status', '--detailed']);
  expect(detailed.stdout).toContain('PENDING-FOLLOWUP-BODY');
});

it('reports already reserved Start state on failure without retrying startup', async () => {
  const registry = structuredClone(outputRegistry());
  vi.mocked(inspectRuns).mockReturnValue(registry as never);
  vi.mocked(startRun).mockClear();
  vi.mocked(startRun).mockRejectedValueOnce(new Error('Second startup preflight failed'));
  const result = await invoke(['start', '7', '--provider', 'agy', '--type', 'issue']);
  expect(JSON.parse(result.stdout)).toMatchObject({
    outcome: 'failed',
    run: 'run-1',
    lifecycle: 'blocked',
    attempt: 'attempt-current',
    attemptStatus: 'unknown',
    blockers: ['Occupancy unknown'],
  });
  expect(result.exitCode).toBe(2);
  expect(startRun).toHaveBeenCalledTimes(1);
});

it('reports pending continuation instead of startup success after readiness is verified', async () => {
  const registry = structuredClone(fixture);
  const current = registry.runs[0];
  Object.assign(current, { lifecycle: 'running' });
  Object.assign(current.orchestrator, {
    status: 'running',
    startupGate: true,
    activation: undefined,
  });
  vi.mocked(inspectRuns).mockReturnValue(registry);
  vi.mocked(startRun).mockResolvedValue(current);
  const result = await invoke(['start', '7', '--provider', 'agy', '--type', 'issue']);
  expect(JSON.parse(result.stdout)).toMatchObject({
    outcome: 'pending',
    lifecycle: 'running',
    attemptStatus: 'running',
    activationStatus: 'pending',
  });
  expect(startRun).toHaveBeenCalled();
});
