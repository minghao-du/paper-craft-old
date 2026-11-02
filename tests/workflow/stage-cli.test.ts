import { test, expect, vi } from 'vitest';
import { inspectRuns } from '../../packages/core/src/workflow/run/run-driver.js';
import { runPlanningDemo } from './scripted-epic-demo.js';

test('scripted planning uses the public CLI, separate activation and independent receipt acceptance without duplicate launch', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const demo = await runPlanningDemo();
    const registry = inspectRuns(demo.config);
    expect(registry.dispatches?.[0].lifecycle).toBe('accepted');
    expect(registry.dispatches?.[0].attempts[0].activation?.status).toBe('delivered');
    expect(demo.launched).toHaveLength(2);
    expect(registry.acknowledgements?.at(-1)?.accepted).toBe(true);
    expect(demo.terminated.size).toBe(1);
  } finally {
    log.mockRestore();
  }
}, 15000);

test('planning rejects changed evidence and accepts a separately collected scoped correction', async () => {
  const { prepareScriptedEpic } = await import('./scripted-epic-demo.js');
  const { writeFileSync, chmodSync } = await import('node:fs');
  const { join } = await import('node:path');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const priorExit = process.exitCode;
  try {
    const demo = await prepareScriptedEpic();
    const dispatch = await demo.dispatch({
      subject: 'toy/epic#1',
      role: 'epic',
      stage: 'planning',
      inputRevision: demo.git('rev-parse', 'HEAD'),
      brief: 'Plan the toy edit.',
      prerequisites: [],
    });
    await demo.cli('collect', ['--dispatch', dispatch.id]);
    const receipt = inspectRuns(demo.config).receipts!.at(-1)!;
    chmodSync(receipt.evidence[0].path, 0o600);
    writeFileSync(receipt.evidence[0].path, 'changed evidence');
    const decision = join(demo.directory, 'decision.md');
    writeFileSync(decision, 'Review planning scope');
    await demo.cli('accept', ['--receipt', receipt.id, '--decision', decision]);
    expect(process.exitCode).toBe(2);
    expect(inspectRuns(demo.config).dispatches![0].lifecycle).toBe('rejected');
    process.exitCode = priorExit;
    const brief = join(demo.directory, 'correction.md');
    writeFileSync(brief, 'Republish the intact bounded plan with current evidence.');
    await demo.cli('message', [
      '--dispatch',
      dispatch.id,
      '--message-id',
      'correct-plan',
      '--brief',
      brief,
    ]);
    await demo.cli('collect', ['--dispatch', dispatch.id, '--message-id', 'correct-plan']);
    const corrected = inspectRuns(demo.config).receipts!.at(-1)!;
    await demo.cli('accept', ['--receipt', corrected.id, '--decision', decision]);
    expect(inspectRuns(demo.config).dispatches![0].lifecycle).toBe('accepted');
    expect(inspectRuns(demo.config).dispatches![0].messages![0].status).toBe('completed');
    expect(demo.launched).toHaveLength(2);
  } finally {
    process.exitCode = priorExit;
    log.mockRestore();
  }
}, 15000);
