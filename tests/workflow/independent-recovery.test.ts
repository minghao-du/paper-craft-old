import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  startRun,
  recoverRun,
  inspectRuns,
  updateRunRegistry,
} from '../../packages/core/src/workflow/run/run-driver.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';
import { initializeRole } from './initialize-role.js';

function fixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-recovery-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let launches = 0;
  let ready = false;
  let stopped = false;
  const runner = {
    name: 'agy',
    interactive: true,
    async preflight() {},
    async stopped() {
      return stopped;
    },
    async result() {
      return undefined;
    },
    async start(a: ManagedAttempt) {
      launches++;
      a.terminalSession = `pc-run-${a.run}`;
      a.address = `tmux:%${launches}`;
      if (!ready) throw new Error('startup timed out; authorization pending');
      initializeRole(a);
      return {
        conversation: `native-${launches}`,
        address: a.address,
        evidence: 'native readiness',
      };
    },
    async recoverReceipt(a: ManagedAttempt) {
      if (!ready) return undefined;
      initializeRole(a);
      return { conversation: 'native-1', address: a.address!, evidence: 'late native readiness' };
    },
  };
  return {
    config,
    runner,
    get launches() {
      return launches;
    },
    ready() {
      ready = true;
    },
    stop() {
      stopped = true;
    },
    cleanup() {
      rmSync(project, { recursive: true, force: true });
    },
  };
}
const subject = {
  repository: 'owner/repo',
  number: 7,
  kind: 'issue' as const,
  title: 'task',
  body: 'deliver',
};

test('explicit recovery activates late initialization without another launch and preserves uncertain occupancy', async () => {
  const f = fixture();
  try {
    const run = await startRun(f.config, f.runner, subject, 'agy', 'retain source data');
    expect(run.lifecycle).toBe('blocked');
    expect((await startRun(f.config, f.runner, subject, 'agy')).id).toBe(run.id);
    expect(
      (
        await recoverRun(f.config, f.runner, run.id, {
          replaceOrchestrator: true,
          stopped: f.runner.stopped,
        })
      ).blockers,
    ).toContain('Orchestrator occupancy unresolved; verify termination before replacement');
    expect(f.launches).toBe(1);
    f.ready();
    expect((await recoverRun(f.config, f.runner, run.id)).blockers).toEqual([]);
    expect(inspectRuns(f.config).runs[0].lifecycle).toBe('running');
    expect(f.launches).toBe(1);
  } finally {
    f.cleanup();
  }
});

test('replacement clears stale startup state, inherits requirements, and binds fresh initialization', async () => {
  const f = fixture();
  try {
    const run = await startRun(f.config, f.runner, subject, 'agy', 'retain source data');
    f.ready();
    f.stop();
    await recoverRun(f.config, f.runner, run.id, {
      replaceOrchestrator: true,
      stopped: f.runner.stopped,
    });
    const current = inspectRuns(f.config).runs[0];
    expect(current.lifecycle).toBe('running');
    expect(current.orchestrator?.predecessor).toBe(run.orchestratorId);
    expect(current.orchestrator?.error).toBeUndefined();
    expect(current.orchestrator?.brief).toContain('retain source data');
    expect(current.orchestrator?.brief).toContain('wait until');
    expect(current.orchestrator?.initialization?.briefHash).not.toBe(
      run.orchestrator?.initialization?.briefHash,
    );
    expect(current.priorOrchestrators).toHaveLength(1);
    expect(f.launches).toBe(2);
  } finally {
    f.cleanup();
  }
});

test('recovery cannot activate a reserved Run from stale running status without initialization', async () => {
  const f = fixture();
  try {
    const run = await startRun(f.config, f.runner, subject, 'agy');
    updateRunRegistry(f.config, (registry) => {
      registry.runs[0].orchestrator!.status = 'running';
    });
    const recovered = await recoverRun(f.config, f.runner, run.id);
    expect(recovered.blockers.length).toBeGreaterThan(0);
    expect(inspectRuns(f.config).runs[0].lifecycle).toBe('blocked');
  } finally {
    f.cleanup();
  }
});
