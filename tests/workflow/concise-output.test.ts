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
import { inspectRuns, startRun } from '@paper-craft/core/workflow/run-driver';

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
vi.mock('@paper-craft/core/workflow/fleet-config', async (original) => ({
  ...(await original<typeof import('@paper-craft/core/workflow/fleet-config')>()),
  loadFleetConfig: vi.fn(() => ({ project: '/project', file: '/project/.epic-config.json' })),
}));
vi.mock('@paper-craft/core/workflow/runtime', async (original) => ({
  ...(await original<typeof import('@paper-craft/core/workflow/runtime')>()),
  managedRunner: () => ({ name: 'agy' }),
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
