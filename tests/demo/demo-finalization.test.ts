import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  startRun,
  dispatchStage,
  publishStageReceipt,
  acceptStageReceipt,
  dispositionStagePipeline,
  publishStageReport,
  inspectRuns,
  updateRunRegistry,
  type StageRequest,
  type WorkflowRun,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { loadFleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';
import { DemoControl } from '../../packages/core/src/workflow/demo/control.js';
import { DemoFinalization } from '../../packages/core/src/workflow/demo/finalization.js';
import { DemoRound, buildDemoRequirements } from '../../packages/core/src/workflow/demo/round.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';

interface TestEnv {
  dir: string;
  roundRoot: string;
  researchDir: string;
  entryFile: string;
  config: ReturnType<typeof loadFleetConfig>;
  head: string;
  round: DemoRound;
  run: WorkflowRun;
}

function createClosedDemoEnvironment(): TestEnv {
  const roundRoot = realpathSync(mkdtempSync(join(tmpdir(), 'demo-fin-test-')));
  const dir = join(roundRoot, 'checkout');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const pool = join(roundRoot, 'worktrees');
  mkdirSync(pool, { recursive: true });
  const researchDir = join(roundRoot, 'research');
  mkdirSync(researchDir, { recursive: true });
  const entryFile = join(researchDir, 'report.md');

  const configFile = join(dir, '.epic-config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      clone_root: pool,
      local_worktrees: true,
      project: dir,
      demo: {
        round: 'round-135',
        config: join(roundRoot, 'demo-config.json'),
      },
    }),
  );
  const config = loadFleetConfig(configFile);

  const round: DemoRound = {
    id: 'round-135',
    root: roundRoot,
    checkout: dir,
    worktrees: pool,
    state: join(roundRoot, 'state'),
    research: researchDir,
    entry: entryFile,
    parent: 100,
    repository: { id: 1, owner: 'org', name: 'repo' },
    phase: 'provisioned',
    provider: 'agy',
    baseline: 'baseline-sha',
    config: {
      root: roundRoot,
      owner: 'org',
      prefix: 'repo-',
      coordinator: 'operator',
      brief: 'bounded diagnostic demo report',
    },
    workflowConfigFile: configFile,
  };

  const demoConfigFile = join(roundRoot, 'demo-config.json');
  writeFileSync(demoConfigFile, JSON.stringify(round.config, null, 2));
  round.demoConfigFile = demoConfigFile;
  round.requirements = buildDemoRequirements(round);
  writeFileSync(join(roundRoot, 'requirements.txt'), round.requirements);

  writeFileSync(join(roundRoot, 'round.json'), JSON.stringify(round, null, 2));
  writeFileSync(
    join(roundRoot, 'control.json'),
    JSON.stringify(
      {
        armed: true,
        runId: '',
        started: Date.now(),
        stopped: false,
        execution: 'running',
        budgetMs: 3600000,
        activeMs: 0,
        tick: Date.now(),
        observations: [],
        usage: 'unavailable',
      },
      null,
      2,
    ),
  );

  return {
    dir,
    roundRoot,
    researchDir,
    entryFile,
    config,
    head,
    round,
    run: null as unknown as WorkflowRun,
  };
}

const mockAgyRunner = {
  name: 'agy',
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
      criteria: ['pass'],
      blockers: [],
    });
  },
};

test('verified Parent closure (status: closed) required before specialist dispatch', async () => {
  const env = createClosedDemoEnvironment();
  try {
    const run = await startRun(
      env.config,
      mockAgyRunner,
      { repository: 'org/repo', number: 100, kind: 'epic', title: 'Demo', body: 'Demo body' },
      'agy',
      env.round.requirements,
    );

    // Round control binds the run
    const control = JSON.parse(readFileSync(join(env.roundRoot, 'control.json'), 'utf8'));
    control.runId = run.id;
    writeFileSync(join(env.roundRoot, 'control.json'), JSON.stringify(control, null, 2));

    // 1. Attempting to dispatch pipeline specialist BEFORE closure fails
    const pipelineRequest: StageRequest = {
      subject: 'org/repo#100',
      role: 'pipeline-audit',
      stage: 'finalization',
      inputRevision: env.head,
      brief: 'Pipeline applicability audit',
      prerequisites: [],
      runId: run.id,
      authority: run.orchestratorId,
    };

    await expect(dispatchStage(env.config, mockAgyRunner, pipelineRequest)).rejects.toThrow(
      /closure/i,
    );

    // 2. An externally observed closed Parent without verified business closure does NOT complete the Run
    // nor allow specialist dispatch
    expect(run.lifecycle).toBe('running');
    expect(run.phase).toBeUndefined();

    // Set closure with status: closed
    updateRunRegistry(env.config, (reg) => {
      const r = reg.runs.find((x) => x.id === run.id)!;
      r.epicClosure = {
        deliveryVersion: 'dv-1',
        head: env.head,
        evidence: 'closure-evidence',
        confirmed: 'human-consent',
        status: 'closed',
      };
      r.phase = 'post_closure_finalization';
    });

    // Now specialist dispatch succeeds
    const dispatch = await dispatchStage(env.config, mockAgyRunner, pipelineRequest);
    expect(dispatch.role).toBe('pipeline-audit');
    expect(dispatch.lifecycle).toBe('running');
  } finally {
    rmSync(env.roundRoot, { recursive: true, force: true });
  }
});

test('real Agy Pipeline specialist dispatch and acceptance with not_applicable or completed_no_changes', async () => {
  const env = createClosedDemoEnvironment();
  try {
    const run = await startRun(
      env.config,
      mockAgyRunner,
      { repository: 'org/repo', number: 100, kind: 'epic', title: 'Demo', body: 'Demo body' },
      'agy',
      env.round.requirements,
    );
    const control = JSON.parse(readFileSync(join(env.roundRoot, 'control.json'), 'utf8'));
    control.runId = run.id;
    writeFileSync(join(env.roundRoot, 'control.json'), JSON.stringify(control, null, 2));

    updateRunRegistry(env.config, (reg) => {
      const r = reg.runs.find((x) => x.id === run.id)!;
      r.epicClosure = {
        deliveryVersion: 'dv-1',
        head: env.head,
        evidence: 'closure-evidence',
        confirmed: 'human-consent',
        status: 'closed',
      };
      r.phase = 'post_closure_finalization';
    });

    const pipelineRequest: StageRequest = {
      subject: 'org/repo#100',
      role: 'pipeline-audit',
      stage: 'finalization',
      inputRevision: env.head,
      brief: 'Pipeline applicability audit',
      prerequisites: [],
      runId: run.id,
      authority: run.orchestratorId,
    };
    const dispatch = await dispatchStage(env.config, mockAgyRunner, pipelineRequest);

    // Create valid completed_no_changes audit receipt
    const evidenceFile = join(env.dir, 'pipeline-evidence.json');
    const pipelineData = {
      head: env.head,
      status: 'completed',
      evidence: ['inspection passed with no diffs'],
      blockers: [],
      scope: ['repo'],
      checks: ['check-pass'],
      artifacts: ['art'],
      limitations: [],
      disposition: 'completed_no_changes',
      inspectedVersions: { repository: env.head },
      findings: [],
      maintenance: [],
    };
    writeFileSync(evidenceFile, JSON.stringify(pipelineData));
    const evidenceHash = createHash('sha256').update(JSON.stringify(pipelineData)).digest('hex');

    const receipt = publishStageReceipt(env.config, {
      dispatchId: dispatch.id,
      attemptId: dispatch.attempts[0].id,
      runId: run.id,
      subject: dispatch.subject,
      role: dispatch.role,
      stage: dispatch.stage,
      provider: run.provider,
      inputRevision: env.head,
      outcome: 'completed',
      evidence: [{ path: evidenceFile, hash: evidenceHash, evidence: 'audit' }],
    });
    await acceptStageReceipt(env.config, run.orchestratorId, receipt.id, async () => ({
      currentRevision: env.head,
      ownership: true,
      evidence: 'accepted audit receipt',
    }));

    // Normal workflow pipeline disposition
    dispositionStagePipeline(env.config, run.id, run.orchestratorId, dispatch.id);

    const snapshot = inspectRuns(env.config);
    const updatedRun = snapshot.runs.find((r) => r.id === run.id)!;
    expect(updatedRun.pipeline).toBeDefined();
    expect(updatedRun.pipeline?.disposition).toBe('completed_no_changes');
  } finally {
    rmSync(env.roundRoot, { recursive: true, force: true });
  }
});

test('changes_needed or acceptance-invalidating audit stops and retains diagnostic Round without maintenance', async () => {
  const env = createClosedDemoEnvironment();
  try {
    const run = await startRun(
      env.config,
      mockAgyRunner,
      { repository: 'org/repo', number: 100, kind: 'epic', title: 'Demo', body: 'Demo body' },
      'agy',
      env.round.requirements,
    );
    const control = JSON.parse(readFileSync(join(env.roundRoot, 'control.json'), 'utf8'));
    control.runId = run.id;
    writeFileSync(join(env.roundRoot, 'control.json'), JSON.stringify(control, null, 2));

    updateRunRegistry(env.config, (reg) => {
      const r = reg.runs.find((x) => x.id === run.id)!;
      r.epicClosure = {
        deliveryVersion: 'dv-1',
        head: env.head,
        evidence: 'closure-evidence',
        confirmed: 'human-consent',
        status: 'closed',
      };
      r.phase = 'post_closure_finalization';
    });

    const pipelineRequest: StageRequest = {
      subject: 'org/repo#100',
      role: 'pipeline-audit',
      stage: 'finalization',
      inputRevision: env.head,
      brief: 'Pipeline applicability audit',
      prerequisites: [],
      runId: run.id,
      authority: run.orchestratorId,
    };
    const dispatch = await dispatchStage(env.config, mockAgyRunner, pipelineRequest);

    // Create changes_needed audit receipt
    const evidenceFile = join(env.dir, 'pipeline-changes.json');
    const pipelineData = {
      head: env.head,
      status: 'completed',
      evidence: ['inspection detected rule break'],
      blockers: [],
      scope: ['repo'],
      checks: ['check-1'],
      artifacts: ['art'],
      limitations: [],
      disposition: 'changes_needed',
      inspectedVersions: { repository: env.head },
      findings: [
        {
          id: 'rule-break',
          classification: 'required_maintenance',
          description: 'Rule repair required',
          evidence: ['rule-break-evidence'],
        },
      ],
      maintenance: [],
    };
    writeFileSync(evidenceFile, JSON.stringify(pipelineData));
    const evidenceHash = createHash('sha256').update(JSON.stringify(pipelineData)).digest('hex');

    const receipt = publishStageReceipt(env.config, {
      dispatchId: dispatch.id,
      attemptId: dispatch.attempts[0].id,
      runId: run.id,
      subject: dispatch.subject,
      role: dispatch.role,
      stage: dispatch.stage,
      provider: run.provider,
      inputRevision: env.head,
      outcome: 'completed',
      evidence: [{ path: evidenceFile, hash: evidenceHash, evidence: 'audit' }],
    });
    await acceptStageReceipt(env.config, run.orchestratorId, receipt.id, async () => ({
      currentRevision: env.head,
      ownership: true,
      evidence: 'accepted changes receipt',
    }));

    // Disposition must stop round and throw retention error
    await expect(
      async () => dispositionStagePipeline(env.config, run.id, run.orchestratorId, dispatch.id),
    ).rejects.toThrow(/retention/i);

    // Check that round is stopped
    const updatedControl = JSON.parse(readFileSync(join(env.roundRoot, 'control.json'), 'utf8'));
    expect(updatedControl.stopped).toBe(true);
    expect(updatedControl.stoppedReason).toMatch(/pipeline/i);

    // Finalization remains incomplete
    const snapshot = inspectRuns(env.config);
    const updatedRun = snapshot.runs.find((r) => r.id === run.id)!;
    expect(updatedRun.phase).toBe('post_closure_finalization');
    expect(updatedRun.lifecycle).toBe('running');
    expect(updatedRun.pipeline).toBeUndefined();

    // No maintenance dispatch can proceed because round is stopped
    const maintenanceRequest: StageRequest = {
      subject: 'org/repo#100',
      role: 'worker',
      stage: 'implementation',
      inputRevision: env.head,
      brief: 'Fix maintenance',
      prerequisites: [],
      runId: run.id,
      authority: run.orchestratorId,
    };
    await expect(dispatchStage(env.config, mockAgyRunner, maintenanceRequest)).rejects.toThrow(
      /stopped/i,
    );
  } finally {
    rmSync(env.roundRoot, { recursive: true, force: true });
  }
});

test('normal Research-State specialist dispatch, isolated publication, and business completion', async () => {
  const env = createClosedDemoEnvironment();
  try {
    const run = await startRun(
      env.config,
      mockAgyRunner,
      { repository: 'org/repo', number: 100, kind: 'epic', title: 'Demo', body: 'Objective: demo' },
      'agy',
      env.round.requirements,
    );
    const control = JSON.parse(readFileSync(join(env.roundRoot, 'control.json'), 'utf8'));
    control.runId = run.id;
    writeFileSync(join(env.roundRoot, 'control.json'), JSON.stringify(control, null, 2));

    const pipelineData = {
      head: env.head,
      status: 'completed',
      evidence: ['inspection passed'],
      blockers: [],
      scope: ['repo'],
      checks: ['check'],
      artifacts: ['art'],
      limitations: [],
      disposition: 'completed_no_changes',
      inspectedVersions: { repository: env.head },
      findings: [],
      maintenance: [],
    };

    updateRunRegistry(env.config, (reg) => {
      const r = reg.runs.find((x) => x.id === run.id)!;
      r.epicClosure = {
        deliveryVersion: 'dv-1',
        head: env.head,
        evidence: 'closure-evidence',
        confirmed: 'human-consent',
        status: 'closed',
      };
      r.phase = 'post_closure_finalization';
      r.pipeline = pipelineData as any;
    });

    // 1. Dispatch research-state specialist
    const researchRequest: StageRequest = {
      subject: 'org/repo#100',
      role: 'research-state',
      stage: 'finalization',
      inputRevision: env.head,
      brief: 'Research state report',
      prerequisites: [],
      runId: run.id,
      authority: run.orchestratorId,
    };
    const dispatch = await dispatchStage(env.config, mockAgyRunner, researchRequest);
    expect(dispatch.role).toBe('research-state');

    // 2. Create artifact with 9 required sections and baseline values (n=10, mean=55, min=10, max=100)
    const reportArtifact = join(env.dir, 'candidate-report.md');
    const reportBody = `# Objective
Verify baseline demo execution.

# Accepted delivery versions
PR #1: ${env.head}
PR #2: ${env.head}

# Observed repository versions
${env.head}

# Pipeline disposition
completed_no_changes

# Verified findings
All unit tests pass. Summary baseline produced: n=10, mean=55, min=10, max=100.

# Interpretation
Task generator and reader execute as specified. No scientific claims from this infrastructure diagnostic.

# Missing evidence
None.

# Follow-up Issues
None.

# Limitations
Bounded synthetic diagnostic test.
`;
    writeFileSync(reportArtifact, reportBody);
    const artifactHash = createHash('sha256').update(reportBody).digest('hex');

    const receiptData = {
      status: 'completed',
      artifact: reportArtifact,
      artifactHash,
    };
    const receiptFile = join(env.dir, 'research-receipt.json');
    writeFileSync(receiptFile, JSON.stringify(receiptData));
    const receiptHash = createHash('sha256').update(JSON.stringify(receiptData)).digest('hex');

    const receipt = publishStageReceipt(env.config, {
      dispatchId: dispatch.id,
      attemptId: dispatch.attempts[0].id,
      runId: run.id,
      subject: dispatch.subject,
      role: dispatch.role,
      stage: dispatch.stage,
      provider: run.provider,
      inputRevision: env.head,
      outcome: 'completed',
      evidence: [{ path: receiptFile, hash: receiptHash, evidence: 'report' }],
    });
    await acceptStageReceipt(env.config, run.orchestratorId, receipt.id, async () => ({
      currentRevision: env.head,
      ownership: true,
      evidence: 'accepted report receipt',
    }));

    // 3. Publish report using normal workflow publishStageReport with coordinator
    const coordinator = {
      identity: 'operator',
      entry: env.entryFile,
      brief: 'bounded diagnostic demo report',
    };

    const publishedReport = await publishStageReport(
      env.config,
      run.id,
      run.orchestratorId,
      dispatch.id,
      coordinator,
    );

    expect(publishedReport.path).toBe(env.entryFile);
    expect(existsSync(env.entryFile)).toBe(true);
    const publishedContent = readFileSync(env.entryFile, 'utf8');
    expect(publishedContent).toContain('Verified workflow provenance');
    expect(publishedContent).toContain('n=10');
    expect(publishedContent).toContain('mean=55');

    // 4. Verify business completion and budget end
    const snapshot = inspectRuns(env.config);
    const completedRun = snapshot.runs.find((r) => r.id === run.id)!;
    expect(completedRun.phase).toBe('completed');
    expect(completedRun.lifecycle).toBe('completed');

    // Control state has completed: true, execution NOT released
    const updatedControl = JSON.parse(readFileSync(join(env.roundRoot, 'control.json'), 'utf8'));
    expect(updatedControl.completed).toBe(true);
    expect(updatedControl.execution).not.toBe('released');

    // Active budget ends: checkpoint does not increment activeMs
    const demoControl = new DemoControl(env.round, {
      stop: async () => true,
    });
    const beforeMs = updatedControl.activeMs;
    const checkpointResult = await demoControl.checkpoint(undefined, Date.now() + 10000);
    expect(checkpointResult.activeMs).toBe(beforeMs);

    // Scene is intact (not deleted)
    expect(existsSync(env.roundRoot)).toBe(true);
    expect(existsSync(env.entryFile)).toBe(true);
  } finally {
    rmSync(env.roundRoot, { recursive: true, force: true });
  }
});

test('pc demo pipeline and publish commands are removed and demo finalization view is provided', async () => {
  const { Command } = await import('commander');
  const { registerDemoCommands } = await import('../../packages/cli/src/commands/demo.js');

  const demoProgram = new Command();
  registerDemoCommands(demoProgram);
  const demoCmd = demoProgram.commands.find((c) => c.name() === 'demo');
  expect(demoCmd).toBeDefined();

  // "pipeline" and "publish" must NOT exist under pc demo
  expect(demoCmd!.commands.find((c) => c.name() === 'pipeline')).toBeUndefined();
  expect(demoCmd!.commands.find((c) => c.name() === 'publish')).toBeUndefined();

  // "finalization" must exist
  expect(demoCmd!.commands.find((c) => c.name() === 'finalization')).toBeDefined();
});

test('DemoFinalization inspects durable view and records observation', async () => {
  const env = createClosedDemoEnvironment();
  try {
    const mockView = {
      roundId: env.round.id,
      closed: true,
      epicClosure: {
        head: env.head,
        deliveryVersion: 'dv-1',
        evidence: 'closure-evidence',
        confirmed: 'human-consent',
        status: 'closed' as const,
      },
      pipeline: {
        disposition: 'completed_no_changes',
        head: env.head,
        inspectedVersions: { repository: env.head },
        accepted: true,
      },
      report: {
        path: env.entryFile,
        hash: 'hash-val',
        published: true,
        acceptedVersions: { integrated: env.head },
        observedVersions: { integrated: env.head },
      },
      businessCompleted: true,
    };

    const adapter = {
      async inspect() {
        return mockView;
      },
    };

    const service = new DemoFinalization(env.round, adapter);
    const view = await service.view();
    expect(view).toEqual(mockView);

    // Observation recorded in finalization-boundaries.jsonl
    const boundaryLog = readFileSync(join(env.roundRoot, 'finalization-boundaries.jsonl'), 'utf8');
    expect(boundaryLog).toContain('finalization-view');
  } finally {
    rmSync(env.roundRoot, { recursive: true, force: true });
  }
});
