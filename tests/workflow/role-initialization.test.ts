import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  startRun,
  dispatchStage,
  recoverRun,
  inspectRuns,
  updateRunRegistry,
} from '../../packages/core/src/workflow/run/run-driver.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';
import { initializeRole } from './initialize-role.js';

test('managed role startup requires actual role evidence and recovery never relaunches missing initialization', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-role-init-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, 'config'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let initialized = false,
    launches = 0;
  const runner = {
    name: 'codex',
    interactive: true,
    async preflight() {},
    async result() {
      return undefined;
    },
    async stopped() {
      return true;
    },
    async start(a: ManagedAttempt) {
      launches++;
      if (initialized) initializeRole(a);
      return { conversation: 'exact', address: 'tmux:known', evidence: 'native acknowledgement' };
    },
    async recoverReceipt() {
      return { conversation: 'exact', address: 'tmux:known', evidence: 'native acknowledgement' };
    },
  };
  try {
    writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
    const run = await startRun(
      config,
      runner,
      { repository: 'o/r', number: 7, kind: 'epic', title: 'bounded scope', body: 'scope' },
      'codex',
    );
    expect(run.lifecycle).toBe('blocked');
    expect(run.orchestrator?.conversation).toBe('exact');
    await recoverRun(config, runner, run.id);
    expect(inspectRuns(config).runs[0].lifecycle).toBe('blocked');
    initializeRole(run.orchestrator!);
    await recoverRun(config, runner, run.id);
    expect(inspectRuns(config).runs[0].lifecycle).toBe('running');
    expect(launches).toBe(1);
    initialized = true;
    updateRunRegistry(config, (state) => {
      state.runs[0].epicClosure = {
        deliveryVersion: 'head',
        head: 'head',
        evidence: 'verified',
        confirmed: 'human',
      };
      state.runs[0].pipeline = {
        head: 'head',
        status: 'completed',
        evidence: ['verified'],
        blockers: [],
        scope: [],
        checks: [],
        artifacts: [],
        limitations: [],
        disposition: 'not_applicable',
        inspectedVersions: { integrated: 'head' },
        findings: [],
        maintenance: [],
      };
    });
    for (const role of ['epic', 'worker', 'landing', 'pipeline-audit', 'research-state'] as const) {
      const dispatch = await dispatchStage(config, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: 'o/r#7',
        role,
        stage: 'initialize-' + role,
        inputRevision: 'head',
        brief: 'Read scope before starting ' + role,
        prerequisites: [],
      });
      expect(dispatch.attempts[0].status).toBe('running');
    }
    const missing = await recoverRun(config, runner, run.id, {
      replaceOrchestrator: true,
      stopped: async () => true,
    });
    expect(missing.blockers).toBeDefined();
    expect(inspectRuns(config).runs[0].orchestrator?.initialization?.attempt).not.toBe(
      run.orchestratorId,
    );
    expect(inspectRuns(config).runs[0].orchestrator?.status).toBe('running');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
