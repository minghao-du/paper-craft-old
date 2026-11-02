import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerWorkflowCommands } from '../../packages/cli/src/commands/workflow.js';
import { outputRegistry } from './fixtures/concise-output/registry.js';
import { inspectRuns } from '@paper-craft/core/workflow/run-driver';

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
vi.mock('@paper-craft/core/workflow/fleet-config', () => ({
  loadFleetConfig: () => ({ project: '/project', file: '/project/.epic-config.json' }),
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
