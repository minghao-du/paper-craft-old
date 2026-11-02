import { test, expect, vi } from 'vitest';
import { prepareScriptedEpic, prepareDeliveryTasks } from './scripted-epic-demo.js';
import { initializeRole } from './initialize-role.js';
import { inspectRuns } from '../../packages/core/src/workflow/run/run-driver.js';
import type { RunnerAdapter } from '../../packages/core/src/workflow/runtime/runtime.js';

test('native scheduler setup initializes only Orchestrator and leaves all task selection to caller', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const starts: string[] = [];
  const native: RunnerAdapter = {
    name: 'claude',
    interactive: true,
    async preflight() {},
    async start(a) {
      starts.push(a.role);
      initializeRole(a);
      return { conversation: a.id, address: `controlled:${a.id}`, evidence: a.directory };
    },
    async recoverReceipt(a) {
      return { conversation: a.id, address: `controlled:${a.id}`, evidence: a.directory };
    },
    async send(a) {
      return { status: 'delivered', evidence: a.directory };
    },
    async result() {
      return undefined;
    },
    async stopped() {
      return false;
    },
  };
  try {
    const demo = await prepareScriptedEpic(native, 'Choose toy tasks yourself.');
    prepareDeliveryTasks(demo);
    expect(starts).toEqual(['orchestrator']);
    expect(demo.run.provider).toBe('claude');
    expect(inspectRuns(demo.config).dispatches ?? []).toEqual([]);
    const dispatch = await demo.dispatch({
      subject: 'toy/epic#1',
      role: 'epic',
      stage: 'planning',
      inputRevision: demo.git('rev-parse', 'HEAD'),
      brief: 'Caller-selected planning',
      prerequisites: [],
    });
    await demo.cli('collect', ['--dispatch', dispatch.id]);
    expect(starts).toEqual(['orchestrator']);
    expect(inspectRuns(demo.config).receipts!.some((r) => r.dispatchId === dispatch.id)).toBe(true);
  } finally {
    log.mockRestore();
  }
}, 20000);
