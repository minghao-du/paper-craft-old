import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadFleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';
import { inspectRuns, updateRunRegistry } from '../../packages/core/src/workflow/run/run-registry.js';
import { startRun } from '../../packages/core/src/workflow/run/startup.js';
import { dispatchStage } from '../../packages/core/src/workflow/run/stage-execution.js';
import {
  epicDeliveries,
  canonicalDeliveryFingerprint,
  confirmStageEpic,
  closeStageEpic,
  dispositionStagePipeline,
  publishStageReport,
  type EpicClosureResult,
  type PipelineDispositionResult,
} from '../../packages/core/src/workflow/run/epic-completion.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';

interface TestEnv {
  dir: string;
  config: ReturnType<typeof loadFleetConfig>;
  configFile: string;
  head: string;
}

function createEpicEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'pc-epic-completion-test-'));
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

  return { dir, config, configFile, head };
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

test('epic-completion operations function directly through epic-completion module without loading run-driver', async () => {
  const env = createEpicEnv();
  try {
    // 1. Start an EPIC run
    const run = await startRun(
      env.config,
      mockRunner,
      { repository: 'org/repo', number: 100, kind: 'epic', title: 'Epic 100', body: 'Epic Body' },
      'codex',
    );

    // 2. Add delivery
    const delivery = {
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
      reg.deliveries = [delivery];
    });

    // 3. Test epicDeliveries and canonicalDeliveryFingerprint
    const reg = inspectRuns(env.config);
    const deliveries = epicDeliveries(reg, run.id);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].issue).toBe(101);

    const version = canonicalDeliveryFingerprint(env.head, deliveries);
    expect(version).toBeTruthy();
    expect(typeof version).toBe('string');

    // 4. Confirm stage epic with human confirmation
    confirmStageEpic(env.config, run.id, run.orchestratorId, {
      source: 'human',
      deliveryVersion: version,
      evidence: 'verified by human reviewer',
    });

    const regAfterConfirm = inspectRuns(env.config);
    const confirmedRun = regAfterConfirm.runs.find((r) => r.id === run.id);
    expect(confirmedRun?.humanConfirmation?.deliveryVersion).toBe(version);

    // 5. Dispatch integrated-acceptance
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

    updateRunRegistry(env.config, (regState) => {
      const d = regState.dispatches?.find((x) => x.id === dispatch.id);
      if (d) {
        d.lifecycle = 'accepted';
        d.acceptedReceipt = 'receipt-int';
      }
      regState.receipts = [
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

    // 6. Close stage epic
    const closeResult: EpicClosureResult = await closeStageEpic(
      env.config,
      run.id,
      run.orchestratorId,
      dispatch.id,
      undefined,
      async () => ({ head: env.head, closed: true, evidence: 'closure verified' }),
    );

    expect(closeResult.head).toBe(env.head);
    expect(closeResult.deliveryVersion).toBe(version);

    const regAfterClose = inspectRuns(env.config);
    const closedRun = regAfterClose.runs.find((r) => r.id === run.id);
    expect(closedRun?.epicClosure?.status).toBe('closed');
    expect(closedRun?.phase).toBe('post_closure_finalization');

    // 7. Dispatch and disposition pipeline
    const pipeDispatch = await dispatchStage(env.config, mockRunner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'org/repo#100',
      role: 'pipeline-audit',
      stage: 'pipeline-audit',
      inputRevision: env.head,
      brief: 'Audit pipeline',
      prerequisites: [],
    });

    const pipeDispositionContent = JSON.stringify({
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
    });
    const pipePath = join(env.dir, 'pipeline-disposition.json');
    writeFileSync(pipePath, pipeDispositionContent);
    const pipeHash = createHash('sha256').update(pipeDispositionContent).digest('hex');

    updateRunRegistry(env.config, (regState) => {
      const d = regState.dispatches?.find((x) => x.id === pipeDispatch.id);
      if (d) {
        d.lifecycle = 'accepted';
        d.acceptedReceipt = 'receipt-pipe';
      }
      regState.receipts!.push({
        id: 'receipt-pipe',
        dispatchId: pipeDispatch.id,
        runId: run.id,
        role: 'pipeline-audit',
        stage: 'pipeline-audit',
        provider: 'codex',
        subject: 'org/repo#100',
        inputRevision: env.head,
        attemptId: pipeDispatch.attempts[0].id,
        evidence: [{ path: pipePath, hash: pipeHash }],
      });
    });

    const pipeResult: PipelineDispositionResult = dispositionStagePipeline(
      env.config,
      run.id,
      run.orchestratorId,
      pipeDispatch.id,
    );
    expect(pipeResult.disposition.disposition).toBe('completed_no_changes');
    expect(pipeResult.head).toBe(env.head);

    // 8. Dispatch and publish stage report
    const reportDispatch = await dispatchStage(env.config, mockRunner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'org/repo#100',
      role: 'research-state',
      stage: 'research-state',
      inputRevision: env.head,
      brief: 'Publish report',
      prerequisites: [],
    });

    const reportArtifact = join(env.dir, 'candidate-report.md');
    writeFileSync(
      reportArtifact,
      'Objective\nAccepted delivery versions\nObserved repository versions\nPipeline disposition\nVerified findings\nInterpretation\nMissing evidence\nFollow-up Issues\nLimitations',
    );
    const reportArtifactHash = createHash('sha256').update(readFileSync(reportArtifact)).digest('hex');

    const reportContent = JSON.stringify({
      status: 'completed',
      artifact: reportArtifact,
      artifactHash: reportArtifactHash,
    });
    const reportJsonPath = join(env.dir, 'report.json');
    writeFileSync(reportJsonPath, reportContent);
    const reportJsonHash = createHash('sha256').update(reportContent).digest('hex');

    updateRunRegistry(env.config, (regState) => {
      const d = regState.dispatches?.find((x) => x.id === reportDispatch.id);
      if (d) {
        d.lifecycle = 'accepted';
        d.acceptedReceipt = 'receipt-report';
      }
      regState.receipts!.push({
        id: 'receipt-report',
        dispatchId: reportDispatch.id,
        runId: run.id,
        role: 'research-state',
        stage: 'research-state',
        provider: 'codex',
        subject: 'org/repo#100',
        inputRevision: env.head,
        attemptId: reportDispatch.attempts[0].id,
        evidence: [{ path: reportJsonPath, hash: reportJsonHash }],
      });
    });

    const reportEntry = join(env.dir, 'final-report.md');
    const reportResult = await publishStageReport(
      env.config,
      run.id,
      run.orchestratorId,
      reportDispatch.id,
      {
        identity: 'coordinator-agent',
        entry: reportEntry,
        brief: 'Research summary for Epic 100',
      },
    );

    expect(reportResult).toBeDefined();
    const finalReg = inspectRuns(env.config);
    const completedRun = finalReg.runs.find((r) => r.id === run.id);
    expect(completedRun?.lifecycle).toBe('completed');
    expect(completedRun?.phase).toBe('completed');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});
