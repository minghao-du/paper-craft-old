import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  canonicalDeliveryFingerprint,
  closeStageEpic,
  confirmStageEpic,
  startRun,
  dispatchStage,
  inspectRuns,
  updateRunRegistry,
  dispositionStagePipeline,
  publishStageReport,
  recoverRun,
  type WorkflowRun,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { loadFleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';

interface TestEnv {
  dir: string;
  config: ReturnType<typeof loadFleetConfig>;
  configFile: string;
  head: string;
  run: WorkflowRun;
  dispatchId: string;
}

function createEpicEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'pc-epic-closure-test-'));
  const pool = join(dir, 'pool');
  mkdirSync(pool, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const configFile = join(dir, '.epic-config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      clone_root: 'pool',
      local_worktrees: true,
      project: dir,
    }),
  );
  const config = loadFleetConfig(configFile);

  return {
    dir,
    config,
    configFile,
    head,
    run: null as any,
    dispatchId: '',
  };
}

const mockRunner = {
  name: 'codex',
  interactive: true,
  async preflight() {},
  async start(a: ManagedAttempt) {
    return { conversation: a.id, address: `controlled:${a.id}`, evidence: 'receipt' };
  },
  async stopped() {
    return true;
  },
  async collect() {
    return JSON.stringify({
      satisfied: true,
      criteria: ['All requirements delivered'],
      blockers: [],
    });
  },
};

test('closure requires human confirmation with matching delivery version; scope change invalidates it', async () => {
  const env = createEpicEnv();
  try {
    const run = await startRun(
      env.config,
      mockRunner,
      { repository: 'org/repo', number: 100, kind: 'epic', title: 'Epic 100', body: 'Epic Body' },
      'codex',
    );

    // Initial child delivery
    const delivery1 = {
      runId: run.id,
      repository: 'org/repo',
      issue: 101,
      pr: 101,
      status: 'done',
      recorded: true,
      released: true,
      archive: join(env.dir, 'archive1'),
      checkedHead: env.head,
      evidence: 'evidence-1',
      dispatches: ['d-101'],
    };

    updateRunRegistry(env.config, (reg) => {
      reg.deliveries = [delivery1];
    });

    const dispatch = await dispatchStage(env.config, mockRunner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'org/repo#100',
      role: 'epic',
      stage: 'integrated-acceptance',
      inputRevision: env.head,
      brief: 'Evaluate integrated acceptance',
      prerequisites: [],
    });

    const judgmentContent = JSON.stringify({
      satisfied: true,
      criteria: ['All goals delivered'],
      blockers: [],
    });
    const judgmentPath = join(env.dir, 'judgment.json');
    writeFileSync(judgmentPath, judgmentContent);
    const judgmentHash = createHash('sha256').update(judgmentContent).digest('hex');

    updateRunRegistry(env.config, (reg) => {
      const d = reg.dispatches?.find((x) => x.id === dispatch.id);
      if (d) {
        d.lifecycle = 'accepted';
        d.acceptedReceipt = 'receipt-int';
      }
      reg.receipts = [
        {
          id: 'receipt-int',
          dispatchId: dispatch.id,
          runId: run.id,
          role: 'epic',
          stage: 'integrated-acceptance',
          provider: 'codex',
          subject: 'org/repo#100',
          inputRevision: env.head,
          attemptId: dispatch.attempts[0].id,
          evidence: [{ path: judgmentPath, hash: judgmentHash }],
        },
      ];
    });

    const initialVersion = canonicalDeliveryFingerprint(env.head, [delivery1]);

    // Pre-record human confirmation on run
    confirmStageEpic(env.config, run.id, run.orchestratorId, {
      source: 'human',
      deliveryVersion: initialVersion,
      evidence: 'initial human confirmation',
    });

    let currentRun = inspectRuns(env.config).runs.find((r) => r.id === run.id)!;
    expect(currentRun.humanConfirmation?.deliveryVersion).toBe(initialVersion);

    // Scope change: a new child delivery is added to the deliveries list
    const delivery2 = {
      runId: run.id,
      repository: 'org/repo',
      issue: 102,
      pr: 102,
      status: 'done',
      recorded: true,
      released: true,
      archive: join(env.dir, 'archive2'),
      checkedHead: env.head,
      evidence: 'evidence-2',
      dispatches: ['d-102'],
    };

    updateRunRegistry(env.config, (reg) => {
      reg.deliveries!.push(delivery2);
    });

    let closeCallCount = 0;
    let issueState = 'open';
    const actions = {
      head: () => env.head,
      view: async () => ({ state: issueState }),
      close: async () => {
        closeCallCount++;
        issueState = 'closed';
      },
    };

    // Attempting closure with prior confirmation fails because version no longer matches
    await expect(
      closeStageEpic(
        env.config,
        run.id,
        run.orchestratorId,
        dispatch.id,
        undefined, // uses stored run.humanConfirmation
        actions,
      ),
    ).rejects.toThrow(/mismatch|invalidat/i);
    expect(closeCallCount).toBe(0);

    // Stored human confirmation was invalidated!
    currentRun = inspectRuns(env.config).runs.find((r) => r.id === run.id)!;
    expect(currentRun.humanConfirmation).toBeUndefined();

    // Now supply fresh human confirmation matching the new delivery fingerprint
    const updatedVersion = canonicalDeliveryFingerprint(env.head, [delivery1, delivery2]);
    const closeResult = await closeStageEpic(
      env.config,
      run.id,
      run.orchestratorId,
      dispatch.id,
      {
        source: 'human',
        deliveryVersion: updatedVersion,
        evidence: 'renewed human confirmation after scope change',
      },
      actions,
    );

    expect(closeResult.deliveryVersion).toBe(updatedVersion);
    expect(closeCallCount).toBe(1);

    // Check Run state after closure
    currentRun = inspectRuns(env.config).runs.find((r) => r.id === run.id)!;
    expect(currentRun.epicClosure?.status).toBe('closed');
    expect(currentRun.epicClosure?.deliveryVersion).toBe(updatedVersion);
    expect(currentRun.phase).toBe('post_closure_finalization');
    expect(currentRun.lifecycle).toBe('running');

    // Calling close again on already-closed epic fails and does NOT repeat close action
    await expect(
      closeStageEpic(
        env.config,
        run.id,
        run.orchestratorId,
        dispatch.id,
        {
          source: 'human',
          deliveryVersion: updatedVersion,
          evidence: 'repeated close attempt',
        },
        actions,
      ),
    ).rejects.toThrow();
    expect(closeCallCount).toBe(1);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('post-closure failure leaves run incomplete in post_closure_finalization phase', async () => {
  const env = createEpicEnv();
  try {
    const run = await startRun(
      env.config,
      mockRunner,
      { repository: 'org/repo', number: 200, kind: 'epic', title: 'Epic 200', body: 'Epic Body' },
      'codex',
    );

    const delivery = {
      runId: run.id,
      repository: 'org/repo',
      issue: 201,
      pr: 201,
      status: 'done',
      recorded: true,
      released: true,
      archive: join(env.dir, 'archive201'),
      checkedHead: env.head,
      evidence: 'evidence-201',
      dispatches: ['d-201'],
    };

    updateRunRegistry(env.config, (reg) => {
      reg.deliveries = [delivery];
    });

    const intDispatch = await dispatchStage(env.config, mockRunner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'org/repo#200',
      role: 'epic',
      stage: 'integrated-acceptance',
      inputRevision: env.head,
      brief: 'Evaluate integrated acceptance',
      prerequisites: [],
    });

    const judgmentContent = JSON.stringify({
      satisfied: true,
      criteria: ['Delivered'],
      blockers: [],
    });
    const judgmentPath = join(env.dir, 'judgment200.json');
    writeFileSync(judgmentPath, judgmentContent);
    const judgmentHash = createHash('sha256').update(judgmentContent).digest('hex');

    updateRunRegistry(env.config, (reg) => {
      const d = reg.dispatches?.find((x) => x.id === intDispatch.id);
      if (d) {
        d.lifecycle = 'accepted';
        d.acceptedReceipt = 'receipt-int-200';
      }
      reg.receipts = [
        {
          id: 'receipt-int-200',
          dispatchId: intDispatch.id,
          runId: run.id,
          role: 'epic',
          stage: 'integrated-acceptance',
          provider: 'codex',
          subject: 'org/repo#200',
          inputRevision: env.head,
          attemptId: intDispatch.attempts[0].id,
          evidence: [{ path: judgmentPath, hash: judgmentHash }],
        },
      ];
    });

    const version = canonicalDeliveryFingerprint(env.head, [delivery]);
    let issueState = 'open';
    await closeStageEpic(
      env.config,
      run.id,
      run.orchestratorId,
      intDispatch.id,
      { source: 'human', deliveryVersion: version, evidence: 'approved' },
      {
        head: () => env.head,
        view: async () => ({ state: issueState }),
        close: async () => {
          issueState = 'closed';
        },
      },
    );

    let currentRun = inspectRuns(env.config).runs.find((r) => r.id === run.id)!;
    expect(currentRun.phase).toBe('post_closure_finalization');
    expect(currentRun.lifecycle).toBe('running');

    // Dispatch pipeline-audit post-closure stage
    const pipeDispatch = await dispatchStage(env.config, mockRunner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'org/repo#200',
      role: 'pipeline-audit',
      stage: 'pipeline-audit',
      inputRevision: env.head,
      brief: 'Audit pipeline changes',
      prerequisites: [],
    });

    // Provide a pipeline disposition that requires changes
    const failingDisposition = {
      head: env.head,
      disposition: 'changes_needed',
      inspectedVersions: { pipeline: env.head },
      findings: [{ id: 'f-1', description: 'Pipeline broke' }],
    };
    const pipeReceiptPath = join(env.dir, 'failing-pipe.json');
    writeFileSync(pipeReceiptPath, JSON.stringify(failingDisposition));
    const pipeReceiptHash = createHash('sha256').update(JSON.stringify(failingDisposition)).digest('hex');

    updateRunRegistry(env.config, (reg) => {
      const d = reg.dispatches?.find((x) => x.id === pipeDispatch.id)!;
      d.lifecycle = 'accepted';
      d.acceptedReceipt = 'receipt-pipe-fail';
      reg.receipts!.push({
        id: 'receipt-pipe-fail',
        dispatchId: pipeDispatch.id,
        runId: run.id,
        role: 'pipeline-audit',
        stage: 'pipeline-audit',
        provider: 'codex',
        subject: 'org/repo#200',
        inputRevision: env.head,
        attemptId: pipeDispatch.attempts[0].id,
        evidence: [{ path: pipeReceiptPath, hash: pipeReceiptHash }],
      });
    });

    // dispositionStagePipeline rejects changes_needed
    expect(() => {
      dispositionStagePipeline(env.config, run.id, run.orchestratorId, pipeDispatch.id);
    }).toThrow();

    // Run remains incomplete and in post_closure_finalization!
    currentRun = inspectRuns(env.config).runs.find((r) => r.id === run.id)!;
    expect(currentRun.phase).toBe('post_closure_finalization');
    expect(currentRun.lifecycle).toBe('running');

    // Now update receipt to accepted disposition: completed_no_changes
    const cleanDisposition = {
      head: env.head,
      status: 'completed',
      evidence: ['verified pipeline unchanged'],
      blockers: [],
      scope: ['packages/core'],
      checks: ['pipeline structural audit'],
      artifacts: [],
      limitations: [],
      disposition: 'completed_no_changes',
      inspectedVersions: { pipeline: env.head },
      findings: [],
      maintenance: [],
    };
    writeFileSync(pipeReceiptPath, JSON.stringify(cleanDisposition));
    updateRunRegistry(env.config, (reg) => {
      const r = reg.receipts!.find((x) => x.id === 'receipt-pipe-fail')!;
      r.evidence[0].hash = createHash('sha256').update(JSON.stringify(cleanDisposition)).digest('hex');
    });

    dispositionStagePipeline(env.config, run.id, run.orchestratorId, pipeDispatch.id);
    currentRun = inspectRuns(env.config).runs.find((r) => r.id === run.id)!;
    expect(currentRun.pipeline?.disposition).toBe('completed_no_changes');
    // Still not completed because report is not published!
    expect(currentRun.phase).toBe('post_closure_finalization');
    expect(currentRun.lifecycle).toBe('running');

    // Now dispatch research-report
    const reportDispatch = await dispatchStage(env.config, mockRunner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'org/repo#200',
      role: 'research-state',
      stage: 'research-report',
      inputRevision: env.head,
      brief: 'Publish final report',
      prerequisites: [pipeDispatch.id],
    });

    const reportArtifact = join(env.dir, 'candidate-report.md');
    writeFileSync(
      reportArtifact,
      'Objective\nAccepted delivery versions\nObserved repository versions\nPipeline disposition\nVerified findings\nInterpretation\nMissing evidence\nFollow-up Issues\nLimitations',
    );
    const reportHash = createHash('sha256').update(readFileSync(reportArtifact)).digest('hex');

    const reportResult = {
      status: 'completed',
      artifact: reportArtifact,
      artifactHash: reportHash,
    };
    const reportReceiptPath = join(env.dir, 'report-receipt.json');
    writeFileSync(reportReceiptPath, JSON.stringify(reportResult));
    const reportReceiptHash = createHash('sha256').update(JSON.stringify(reportResult)).digest('hex');

    updateRunRegistry(env.config, (reg) => {
      const d = reg.dispatches?.find((x) => x.id === reportDispatch.id)!;
      d.lifecycle = 'accepted';
      d.acceptedReceipt = 'receipt-report-ok';
      reg.receipts!.push({
        id: 'receipt-report-ok',
        dispatchId: reportDispatch.id,
        runId: run.id,
        role: 'research-state',
        stage: 'research-report',
        provider: 'codex',
        subject: 'org/repo#200',
        inputRevision: env.head,
        attemptId: reportDispatch.attempts[0].id,
        evidence: [{ path: reportReceiptPath, hash: reportReceiptHash }],
      });
    });

    const coordinator = {
      identity: 'Lead Researcher',
      entry: join(env.dir, 'report.md'),
      brief: 'Research summary for Epic 200',
    };

    await publishStageReport(env.config, run.id, run.orchestratorId, reportDispatch.id, coordinator);

    // Only now is Run completed!
    currentRun = inspectRuns(env.config).runs.find((r) => r.id === run.id)!;
    expect(currentRun.phase).toBe('completed');
    expect(currentRun.lifecycle).toBe('completed');

    // Repeated call throws and does NOT re-publish
    await expect(
      publishStageReport(env.config, run.id, run.orchestratorId, reportDispatch.id, coordinator),
    ).rejects.toThrow();
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('recovery does not repeat GitHub close or report publication and identifies unfinished post-closure stages', async () => {
  const env = createEpicEnv();
  try {
    const run = await startRun(
      env.config,
      mockRunner,
      { repository: 'org/repo', number: 300, kind: 'epic', title: 'Epic 300', body: 'Epic Body' },
      'codex',
    );

    const delivery = {
      runId: run.id,
      repository: 'org/repo',
      issue: 301,
      pr: 301,
      status: 'done',
      recorded: true,
      released: true,
      archive: join(env.dir, 'archive301'),
      checkedHead: env.head,
      evidence: 'evidence-301',
      dispatches: ['d-301'],
    };

    updateRunRegistry(env.config, (reg) => {
      reg.deliveries = [delivery];
    });

    const intDispatch = await dispatchStage(env.config, mockRunner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'org/repo#300',
      role: 'epic',
      stage: 'integrated-acceptance',
      inputRevision: env.head,
      brief: 'Evaluate integrated acceptance',
      prerequisites: [],
    });

    const judgmentContent = JSON.stringify({
      satisfied: true,
      criteria: ['Delivered'],
      blockers: [],
    });
    const judgmentPath = join(env.dir, 'judgment300.json');
    writeFileSync(judgmentPath, judgmentContent);
    const judgmentHash = createHash('sha256').update(judgmentContent).digest('hex');

    updateRunRegistry(env.config, (reg) => {
      const d = reg.dispatches?.find((x) => x.id === intDispatch.id)!;
      d.lifecycle = 'accepted';
      d.acceptedReceipt = 'receipt-int-300';
      reg.receipts = [
        {
          id: 'receipt-int-300',
          dispatchId: intDispatch.id,
          runId: run.id,
          role: 'epic',
          stage: 'integrated-acceptance',
          provider: 'codex',
          subject: 'org/repo#300',
          inputRevision: env.head,
          attemptId: intDispatch.attempts[0].id,
          evidence: [{ path: judgmentPath, hash: judgmentHash }],
        },
      ];
    });

    let closeCallCount = 0;
    let issueState3 = 'open';
    const version = canonicalDeliveryFingerprint(env.head, [delivery]);
    await closeStageEpic(
      env.config,
      run.id,
      run.orchestratorId,
      intDispatch.id,
      { source: 'human', deliveryVersion: version, evidence: 'approved' },
      {
        head: () => env.head,
        view: async () => ({ state: issueState3 }),
        close: async () => {
          closeCallCount++;
          issueState3 = 'closed';
        },
      },
    );
    expect(closeCallCount).toBe(1);

    // Dispatch a pipeline-audit stage that remains pending
    const pipeDispatch = await dispatchStage(env.config, mockRunner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'org/repo#300',
      role: 'pipeline-audit',
      stage: 'pipeline-audit',
      inputRevision: env.head,
      brief: 'Audit pipeline',
      prerequisites: [],
    });

    // Recover run: verify it does NOT re-call GitHub close and identifies unfinished post-closure dispatch
    const recovery = await recoverRun(env.config, mockRunner, run.id);
    expect(closeCallCount).toBe(1); // not repeated!
    expect(recovery.pendingDispatches).toContain(pipeDispatch.id);

    const currentRun = inspectRuns(env.config).runs.find((r) => r.id === run.id)!;
    expect(currentRun.phase).toBe('post_closure_finalization');
    expect(currentRun.lifecycle).toBe('running');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('missing Managed ownership on close-epic CLI fails explicitly', () => {
  const env = createEpicEnv();
  try {
    const repoRoot = resolve(__dirname, '../..');
    const pcCli = resolve(repoRoot, 'pc');

    const result = spawnSync(
      pcCli,
      ['workflow', 'orchestrator', 'close-epic', '999', '--config', env.configFile],
      { cwd: env.dir, encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('Missing Managed Run for EPIC 999');
    expect(output).toContain('pc workflow orchestrator start 999 --type epic');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});
