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
import {
  verifyRoleInitialization,
  roleArtifactInstructions,
} from '../../packages/core/src/workflow/run/role-initialization.js';
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
  let run: any;
  const runner = {
    name: 'agy',
    interactive: true,
    async preflight() {},
    async result() {
      return undefined;
    },
    async stopped(a?: ManagedAttempt) {
      if (a && a.role === 'orchestrator' && a.id !== run?.orchestratorId) return false;
      return true;
    },
    async start(a: ManagedAttempt) {
      launches++;
      if (a.predecessor) {
        const durable = inspectRuns(config).runs.find((r) => r.id === a.run)!.orchestrator!;
        expect(durable.initialization).toEqual(a.initialization);
        expect(durable.brief).toBe(a.brief);
      }
      if (initialized) initializeRole(a);
      return { conversation: 'exact', address: 'tmux:known', evidence: 'native acknowledgement' };
    },
    async observe(a: ManagedAttempt) {
      return {
        status: a.terminalSession ? ('idle' as const) : ('unknown' as const),
        at: new Date().toISOString(),
        evidence: 'terminal identity inspection',
      };
    },
    async recoverReceipt(a: ManagedAttempt) {
      a.terminalSession = `pc-run-${a.run}`;
      return { conversation: 'exact', address: 'tmux:known', evidence: 'native acknowledgement' };
    },
  };
  try {
    writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
    run = await startRun(
      config,
      runner,
      { repository: 'o/r', number: 7, kind: 'epic', title: 'bounded scope', body: 'scope' },
      'agy',
    );
    expect(run.lifecycle).toBe('blocked');
    expect(run.orchestrator?.conversation).toBe('exact');
    await recoverRun(config, runner, run.id);
    expect(inspectRuns(config).runs[0].lifecycle).toBe('blocked');
    initializeRole(run.orchestrator!);
    updateRunRegistry(config, (state) => {
      state.runs[0].orchestrator!.terminalSession = undefined;
    });
    expect((await recoverRun(config, runner, run.id)).blockers).toEqual([]);
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

test('worker role initialization is verified solely via initialization.json without requiring .epic-status.json or .epic-worklog.md', () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'pc-worker-init-')));
  try {
    const attemptDir = join(temp, 'attempt');
    const checkoutDir = join(temp, 'checkout');
    const contextDir = join(temp, 'context');
    mkdirSync(attemptDir, { recursive: true });
    mkdirSync(checkoutDir, { recursive: true });
    mkdirSync(contextDir, { recursive: true });

    const contextPath = join(contextDir, 'brief.md');
    writeFileSync(contextPath, '# Context');
    const crypto = require('node:crypto');
    const contextHash = crypto.createHash('sha256').update('# Context').digest('hex');

    const registryPath = join(temp, 'registry.json');
    const registry = {
      runs: [
        {
          id: 'run-test',
          orchestratorId: 'orch-test',
          subject: { repository: 'o/r', number: 42 },
          lifecycle: 'running',
        },
      ],
    };
    writeFileSync(registryPath, JSON.stringify(registry));

    const expected = {
      run: 'run-test',
      registry: registryPath,
      authority: 'orch-test',
      subject: 'o/r#42',
      role: 'worker' as const,
      attempt: 'attempt-worker-1',
      briefHash: 'brief-hash',
      context: { path: contextPath, hash: contextHash },
    };

    expect(roleArtifactInstructions(expected)).toBe('');

    const attempt: ManagedAttempt = {
      id: 'attempt-worker-1',
      fleet: 'test-fleet',
      role: 'worker',
      runner: 'agy',
      brief: 'brief',
      status: 'running',
      created: new Date(Date.now() - 1000).toISOString(),
      directory: attemptDir,
      checkout: checkoutDir,
      initialization: expected,
    };

    // Write ONLY initialization.json in attempt directory (no .epic-status.json or .epic-worklog.md in checkoutDir)
    writeFileSync(join(attemptDir, 'initialization.json'), JSON.stringify(expected));

    // Must verify successfully without throwing ENOENT for .epic-status.json
    expect(verifyRoleInitialization(attempt)).toContain('Verified worker initialization');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
