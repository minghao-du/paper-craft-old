import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { stateDirectory } from '../../packages/core/src/workflow/handoff.js';
import {
  startRun,
  dispatchStage,
  publishStageReceipt,
  acceptStageReceipt,
  inspectRun,
  stopRun,
  releaseRun,
  releaseRunCheckout,
  updateRunRegistry,
  type WorkflowRun,
  type ManagedAttempt,
} from '../../packages/core/src/workflow/run/run-driver.js';

function createFixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-control-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
  return { project, config };
}

test('inspectRun exposes stable narrow public view of run identity, attempts, helpers, execution state, and resource ownership', async () => {
  const { project, config } = createFixture();
  let verifiedStopped = false;
  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return verifiedStopped;
    },
    async preflight() {},
    async start() {
      return { conversation: 'sess-1', address: 'tmux:test', evidence: 'start-ack' };
    },
  };
  const subject = {
    repository: 'owner/repo',
    number: 10,
    kind: 'issue' as const,
    title: 'test issue',
    body: 'test body',
  };

  try {
    const run = await startRun(config, runner, subject, 'codex');
    const view = inspectRun(config, run.id);

    expect(view.id).toBe(run.id);
    expect(view.provider).toBe('codex');
    expect(view.lifecycle).toBe('running');
    expect(view.subject.repository).toBe('owner/repo');
    expect(view.subject.number).toBe(10);
    expect(view.orchestratorId).toBe(run.id);
    expect(view.orchestrator?.id).toBe(run.orchestrator?.id);
    expect(view.attempts.length).toBeGreaterThanOrEqual(1);
    expect(view.helper).toBeDefined();
    expect(view.helper.active).toBe(false);
    expect(view.execution).toBe('running');
    expect(view.terminated).toBe(false);
    expect(view.released).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('stopRun revokes further scheduling before requesting cancellation, and blocks further launch', async () => {
  const { project, config } = createFixture();
  let verifiedStopped = false;
  let cancelCalled = false;

  const runner = {
    interactive: true,
    name: 'codex',
    cancellation: true,
    async cancel() {
      cancelCalled = true;
      verifiedStopped = true;
      return { evidence: 'cancelled-ack' };
    },
    async stopped() {
      return verifiedStopped;
    },
    async preflight() {},
    async start() {
      return { conversation: 'sess-2', address: 'tmux:test', evidence: 'start-ack' };
    },
  };
  const subject = {
    repository: 'owner/repo',
    number: 11,
    kind: 'issue' as const,
    title: 'stop test',
    body: 'stop body',
  };

  try {
    const run = await startRun(config, runner, subject, 'codex');
    expect(run.lifecycle).toBe('running');

    // Perform stop
    const stopResult = await stopRun(config, runner, run.id);

    expect(cancelCalled).toBe(true);
    expect(stopResult.lifecycle).toBe('blocked');
    expect(stopResult.terminated).toBe(true);

    // Verified view
    const view = inspectRun(config, run.id);
    expect(view.lifecycle).toBe('blocked');
    expect(view.terminated).toBe(true);

    // Stop-before-further-launch: attempting to dispatch new stage throws because authority is revoked
    await expect(
      dispatchStage(config, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: 'owner/repo#11',
        role: 'worker',
        stage: 'worker-stage',
        inputRevision: 'rev-1',
        brief: 'do work',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Inactive or wrong Orchestrator authority/);

    // Reconnecting via startRun preserves blocked state and does not launch a new orchestrator
    const reconnect = await startRun(config, runner, subject, 'codex');
    expect(reconnect.id).toBe(run.id);
    expect(reconnect.lifecycle).toBe('blocked');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('failed or unknown cancellation remains occupied and blocks resource reuse', async () => {
  const { project, config } = createFixture();
  // Runner acknowledges cancellation, but stopped() remains FALSE (process has not exited)
  let verifiedStopped = false;
  let cancelAttemptCount = 0;

  const runner = {
    interactive: true,
    name: 'codex',
    cancellation: true,
    async cancel() {
      cancelAttemptCount++;
      return { evidence: 'cancellation-requested' };
    },
    async stopped() {
      return verifiedStopped; // remains false
    },
    async preflight() {},
    async start() {
      return { conversation: 'sess-3', address: 'tmux:test', evidence: 'start-ack' };
    },
  };
  const subject = {
    repository: 'owner/repo',
    number: 12,
    kind: 'issue' as const,
    title: 'failed cancel test',
    body: 'body',
  };

  try {
    const run = await startRun(config, runner, subject, 'codex');

    // Add a dispatch stage with a checkout
    const checkoutDir = join(project, 'pool', 'issue-12');
    mkdirSync(checkoutDir, { recursive: true });

    const dispatch = await dispatchStage(config, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'owner/repo#12',
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-1',
      brief: 'do work',
      prerequisites: [],
      checkout: checkoutDir,
    });

    // Attempt stop - since verifiedStopped is false, termination is unverified
    const stopResult = await stopRun(config, runner, run.id);

    expect(cancelAttemptCount).toBeGreaterThanOrEqual(1);
    expect(stopResult.terminated).toBe(false);
    expect(stopResult.released).toBe(false);
    expect(stopResult.blockers.length).toBeGreaterThan(0);
    expect(stopResult.blockers.some((b) => b.includes('termination unverified'))).toBe(true);

    const view = inspectRun(config, run.id);
    expect(view.terminated).toBe(false);
    expect(view.released).toBe(false);

    // Resources remain occupied
    expect(view.resources.some((r) => r.path === checkoutDir)).toBe(true);

    // Releasing checkout throws because termination evidence is required
    await expect(
      releaseRunCheckout(config, run.id, checkoutDir, async () => false, () => {}),
    ).rejects.toThrow(/Unknown checkout occupancy; termination evidence required/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('completed success survives release without changing business success into failure', async () => {
  const { project, config } = createFixture();
  let verifiedStopped = true;

  const runner = {
    interactive: true,
    name: 'codex',
    cancellation: true,
    async cancel() {
      return { evidence: 'cancel-ack' };
    },
    async stopped() {
      return verifiedStopped;
    },
    async preflight() {},
    async start() {
      return { conversation: 'sess-4', address: 'tmux:test', evidence: 'start-ack' };
    },
  };
  const subject = {
    repository: 'owner/repo',
    number: 13,
    kind: 'epic' as const,
    title: 'completed release test',
    body: 'body',
  };

  try {
    const run = await startRun(config, runner, subject, 'codex');

    // Simulate completed business deliveries
    updateRunRegistry(config, (registry) => {
      const current = registry.runs.find((r) => r.id === run.id)!;
      current.lifecycle = 'completed';
      current.phase = 'completed';
      current.epicClosure = {
        deliveryVersion: 'v1.0',
        head: 'sha-head',
        evidence: 'human-confirmed',
        confirmed: 'confirmed',
      };
      registry.deliveries = [
        {
          runId: run.id,
          repository: 'owner/repo',
          issue: 13,
          pr: 101,
          status: 'done',
          recorded: true,
          released: true,
          archive: '/tmp/archive.tar.gz',
          evidence: 'delivery-evidence',
          dispatches: [],
        },
      ];
    });

    // Calling releaseRun on completed Run
    const releaseResult = await releaseRun(config, runner, run.id);

    expect(releaseResult.lifecycle).toBe('completed');
    expect(releaseResult.terminated).toBe(true);
    expect(releaseResult.released).toBe(true);

    // Public view preserves business completion and deliverables
    const view = inspectRun(config, run.id);
    expect(view.lifecycle).toBe('completed');
    expect(view.phase).toBe('completed');
    expect(view.deliveries).toHaveLength(1);
    expect(view.deliveries[0].status).toBe('done');
    expect(view.released).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('releaseRun refuses to release incomplete Run', async () => {
  const { project, config } = createFixture();
  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return true;
    },
    async preflight() {},
    async start() {
      return { conversation: 'sess-5', address: 'tmux:test', evidence: 'start-ack' };
    },
  };
  const subject = {
    repository: 'owner/repo',
    number: 14,
    kind: 'issue' as const,
    title: 'incomplete test',
    body: 'body',
  };

  try {
    const run = await startRun(config, runner, subject, 'codex');
    expect(run.lifecycle).toBe('running');

    await expect(releaseRun(config, runner, run.id)).rejects.toThrow(
      /is not completed/,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('refusal to release unrelated ownership', async () => {
  const { project, config } = createFixture();
  let verifiedStopped = true;

  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return verifiedStopped;
    },
    async preflight() {},
    async start() {
      return { conversation: 'sess-6', address: 'tmux:test', evidence: 'start-ack' };
    },
  };

  try {
    const run1 = await startRun(
      config,
      runner,
      { repository: 'owner/repo', number: 21, kind: 'issue', title: 'r1', body: 'b1' },
      'codex',
    );
    const run2 = await startRun(
      config,
      runner,
      { repository: 'owner/repo', number: 22, kind: 'issue', title: 'r2', body: 'b2' },
      'codex',
    );

    const checkoutDir = join(project, 'pool', 'issue-21');
    mkdirSync(checkoutDir, { recursive: true });

    // Run 1 dispatches and claims checkoutDir
    await dispatchStage(config, runner, {
      runId: run1.id,
      authority: run1.orchestratorId,
      subject: 'owner/repo#21',
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-1',
      brief: 'work 1',
      prerequisites: [],
      checkout: checkoutDir,
    });

    // Run 2 attempts to release Run 1's checkout
    await expect(
      releaseRunCheckout(config, run2.id, checkoutDir, async () => true, () => {}),
    ).rejects.toThrow(/(Checkout owner conflict|Unknown checkout occupancy)/);

    // Checkout owner file and resource registry still belong to Run 1
    const owner = JSON.parse(readFileSync(join(checkoutDir, '.pc-execution-owner'), 'utf8'));
    expect(owner.runId).toBe(run1.id);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('repeated stop and release reconcile existing owned state without launching replacements', async () => {
  const { project, config } = createFixture();
  let launches = 0;
  let verifiedStopped = true;

  const runner = {
    interactive: true,
    name: 'codex',
    cancellation: true,
    async cancel() {
      return { evidence: 'cancel-ack' };
    },
    async stopped() {
      return verifiedStopped;
    },
    async preflight() {},
    async start() {
      launches++;
      return { conversation: 'sess-7', address: 'tmux:test', evidence: 'start-ack' };
    },
  };
  const subject = {
    repository: 'owner/repo',
    number: 30,
    kind: 'issue' as const,
    title: 'reconcile test',
    body: 'body',
  };

  try {
    const run = await startRun(config, runner, subject, 'codex');
    expect(launches).toBe(1);

    // First stop
    const firstStop = await stopRun(config, runner, run.id);
    expect(firstStop.terminated).toBe(true);
    expect(launches).toBe(1);

    // Second stop: reconciles without launching
    const secondStop = await stopRun(config, runner, run.id);
    expect(secondStop.terminated).toBe(true);
    expect(launches).toBe(1);

    // Complete the run
    updateRunRegistry(config, (registry) => {
      registry.runs.find((r) => r.id === run.id)!.lifecycle = 'completed';
    });

    // First release
    const firstRelease = await releaseRun(config, runner, run.id);
    expect(firstRelease.terminated).toBe(true);
    expect(launches).toBe(1);

    // Second release
    const secondRelease = await releaseRun(config, runner, run.id);
    expect(secondRelease.terminated).toBe(true);
    expect(launches).toBe(1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('CLI stop and release commands execute verified control operations and reject invalid state', async () => {
  const root = resolve(import.meta.dirname, '../..');
  const pcBin = resolve(root, 'pc');
  const { project, config } = createFixture();

  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return true;
    },
    async preflight() {},
    async start() {
      return { conversation: 'sess-cli', address: 'tmux:%999999', evidence: 'start-ack' };
    },
  };

  try {
    const run = await startRun(
      config,
      runner,
      { repository: 'owner/repo', number: 42, kind: 'issue', title: 'cli test', body: 'body' },
      'codex',
    );

    // Mock attempt directory termination for codex runner (exit-code file)
    writeFileSync(join(run.orchestrator!.directory, 'exit-code'), '0');

    // 1. CLI stop command
    const stopOut = execFileSync(
      pcBin,
      ['workflow', 'orchestrator', 'stop', run.id, '--config', config.file],
      { cwd: project, encoding: 'utf8', timeout: 20000 },
    );
    const stopJson = JSON.parse(stopOut);
    expect(stopJson.outcome).toBe('succeeded');
    expect(stopJson.lifecycle).toBe('blocked');
    expect(stopJson.terminated).toBe(true);
    expect(stopJson.inspection.lifecycle).toBe('blocked');

    // 2. CLI release on non-completed run should fail with exit code 2
    try {
      execFileSync(
        pcBin,
        ['workflow', 'orchestrator', 'release', run.id, '--config', config.file],
        { cwd: project, encoding: 'utf8', timeout: 20000 },
      );
      expect.unreachable('Should have failed');
    } catch (error: any) {
      expect(error.status).toBe(2);
      const errJson = JSON.parse(error.stdout.toString());
      expect(errJson.outcome).toBe('failed');
      expect(errJson.error).toMatch(/not completed/);
    }

    // 3. Complete run and test CLI release
    updateRunRegistry(config, (registry) => {
      registry.runs.find((r) => r.id === run.id)!.lifecycle = 'completed';
    });

    const releaseOut = execFileSync(
      pcBin,
      ['workflow', 'orchestrator', 'release', run.id, '--config', config.file],
      { cwd: project, encoding: 'utf8', timeout: 20000 },
    );
    const releaseJson = JSON.parse(releaseOut);
    expect(releaseJson.outcome).toBe('succeeded');
    expect(releaseJson.lifecycle).toBe('completed');
    expect(releaseJson.terminated).toBe(true);
    expect(releaseJson.released).toBe(true);
    expect(releaseJson.inspection.lifecycle).toBe('completed');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 25000);

