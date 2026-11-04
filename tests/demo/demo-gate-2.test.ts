import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DemoRounds,
  type DemoAdapter,
  type DemoConfig,
} from '../../tools/demo/round.js';
import {
  DemoControl,
  type DemoExecution,
} from '../../tools/demo/control.js';
import {
  DemoDelivery,
  demoChronology,
  type DemoDeliveryAdapter,
  type DemoDeliverySnapshot,
} from '../../tools/demo/delivery.js';
import { nativeDemoDelivery } from '../../tools/demo/delivery-native.js';
import {
  startRun,
  dispatchStage,
  inspectRun,
  updateRunRegistry,
  type StageRequest,
} from '../../packages/core/src/workflow/run/run-driver.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';

function gitCmd(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function setupGitRepoWithCommits(checkout: string) {
  mkdirSync(checkout, { recursive: true });
  gitCmd(checkout, 'init', '-b', 'main');
  gitCmd(checkout, 'config', 'user.name', 'Test');
  gitCmd(checkout, 'config', 'user.email', 'test@example.com');
  gitCmd(checkout, 'commit', '--allow-empty', '-m', 'Initial commit');
  const baseSha = gitCmd(checkout, 'rev-parse', 'HEAD');

  // Branch for task 1
  gitCmd(checkout, 'checkout', '-b', 'task-1');
  writeFileSync(join(checkout, 'generate.py'), 'print("tsv")');
  gitCmd(checkout, 'add', 'generate.py');
  gitCmd(checkout, 'commit', '-m', 'Task 1 generator');

  // Merge task 1 into main
  gitCmd(checkout, 'checkout', 'main');
  gitCmd(checkout, 'merge', '--no-ff', 'task-1', '-m', 'Merge pull request #1 from task-1');
  const task1MergeSha = gitCmd(checkout, 'rev-parse', 'HEAD');

  // Branch for task 2 - divergent (based on initial commit, NOT containing task 1 merge)
  gitCmd(checkout, 'checkout', '-b', 'task-2-divergent', baseSha);
  writeFileSync(join(checkout, 'other.py'), 'print("divergent")');
  gitCmd(checkout, 'add', 'other.py');
  gitCmd(checkout, 'commit', '-m', 'Task 2 divergent');
  const divergentSha = gitCmd(checkout, 'rev-parse', 'HEAD');

  // Branch for task 2 - valid (based on main, containing task 1 merge)
  gitCmd(checkout, 'checkout', '-b', 'task-2-valid', 'main');
  writeFileSync(join(checkout, 'summarize.py'), 'print("summary")');
  gitCmd(checkout, 'add', 'summarize.py');
  gitCmd(checkout, 'commit', '-m', 'Task 2 valid');
  const containingSha = gitCmd(checkout, 'rev-parse', 'HEAD');

  // Switch back to main
  gitCmd(checkout, 'checkout', 'main');

  return { baseSha, task1MergeSha, divergentSha, containingSha };
}

function setupDemoRoundFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-demo-gate2-test-')));
  const remote = new Map<string, { id: number; owner: string; name: string }>();
  let gitShas: { baseSha: string; task1MergeSha: string; divergentSha: string; containingSha: string } | undefined;
  const adapter: DemoAdapter = {
    check: async () => {},
    repository: async (owner, name) => remote.get(`${owner}/${name}`) ?? null,
    createRepository: async (owner, name) => {
      const repo = { id: 42, owner, name };
      remote.set(`${owner}/${name}`, repo);
      return repo;
    },
    initialize: async (_repository, checkout) => {
      gitShas = setupGitRepoWithCommits(checkout);
      return gitShas.task1MergeSha;
    },
    createParent: async () => 1,
  };
  const config: DemoConfig = {
    root,
    owner: 'testowner',
    prefix: 'demo-',
    coordinator: 'test-coord',
    brief: 'Test brief evidence',
  };
  return { root, adapter, config, getGitShas: () => gitShas! };
}

test('Criterion 1 & 2 & 3 & 4: Automatic Gate 2 verifies complete Task 1 handover, releases task 1 while Orchestrator remains active, and issues task 2 authorization', async () => {
  const { root, adapter, config, getGitShas } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);
    const gitShas = getGitShas();

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return true;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    // Persist demo-tasks.json
    writeFileSync(
      join(round.root, 'demo-tasks.json'),
      JSON.stringify({ roundId: round.id, parent: 1, task1: 2, task2: 3 }, null, 2),
    );

    // Gate 1 authorizes Worker 1
    const deliveryBeforeWorker1 = new DemoDelivery(round, {
      async inspect() {
        return {
          version: 'v1',
          children: [2, 3],
          nativeDependency: true,
          firstReleased: false,
          secondBaseline: false,
          accepted: false,
          task1: 2,
          task2: 3,
          parentValid: true,
          noExtraTasks: true,
        };
      },
      async close() {},
    });
    await deliveryBeforeWorker1.gate('worker1');

    // Create bundle for archive verification
    const archiveDir = join(round.root, 'archive-task-1');
    mkdirSync(archiveDir, { recursive: true });
    const bundlePath = join(archiveDir, 'repository.bundle');
    gitCmd(round.checkout, 'bundle', 'create', bundlePath, '--all');

    // Simulate task 1 completion in run registry:
    // Dispatches for task 1
    const task1Dispatch = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'worker',
      stage: 'implementation',
      inputRevision: gitShas.baseSha,
      brief: 'Implement TSV generator',
      prerequisites: [],
    });

    updateRunRegistry(fleetConfig, (reg) => {
      // Mark task 1 dispatch accepted
      const d = reg.dispatches!.find((x) => x.id === task1Dispatch.id)!;
      d.lifecycle = 'accepted';

      // Record task 1 delivery: status done, recorded, released, archive
      reg.deliveries ??= [];
      reg.deliveries.push({
        runId: run.id,
        repository: subject.repository,
        issue: 2,
        pr: 10,
        status: 'done',
        recorded: true,
        released: true,
        releasePrepared: true,
        checkedHead: gitShas.task1MergeSha,
        archive: archiveDir,
        evidence: 'delivery evidence',
        dispatches: [d.id],
      });
      // Resources: task 1 checkout is NOT in resources (released), but project root is preserved
    });

    // Verify Orchestrator remains active in public view
    const runViewBeforeGate2 = inspectRun(fleetConfig, run.id);
    expect(runViewBeforeGate2.lifecycle).toBe('running');
    expect(runViewBeforeGate2.orchestrator).toBeDefined();
    expect(runViewBeforeGate2.released).toBe(false); // Parent run not released!

    // Delivery adapter with complete handover facts
    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v2',
          children: [2, 3],
          nativeDependency: true,
          firstReleased: true,
          secondBaseline: true,
          accepted: false,
          task1: 2,
          task2: 3,
          task1MergeSha: gitShas.task1MergeSha,
          task1Pr: 10,
          parentValid: true,
          noExtraTasks: true,
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, deliveryAdapter);

    // Invoke Gate 2 automatically before Worker 2
    const gate2Result = await delivery.gate('worker2');
    expect(gate2Result.firstReleased).toBe(true);
    expect(gate2Result.authorization).toBeDefined();
    expect(gate2Result.authorization!.issue).toBe(3);
    expect(gate2Result.authorization!.requiredAncestorSha).toBe(gitShas.task1MergeSha);
    expect(gate2Result.authorization!.claimed).toBe(false);

    // Check delivery-boundaries.jsonl
    const boundaryPath = join(round.root, 'delivery-boundaries.jsonl');
    expect(existsSync(boundaryPath)).toBe(true);
    const boundaries = readFileSync(boundaryPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const gate2Event = boundaries.find((b) => b.stage === 'worker2');
    expect(gate2Event).toBeDefined();
    expect(gate2Event.pass).toBe(true);

    // Check gate-authorization.json on disk
    const authPath = join(round.root, 'gate-authorization.json');
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    expect(auth.issue).toBe(3);
    expect(auth.roundId).toBe(round.id);
    expect(auth.runId).toBe(run.id);
    expect(auth.requiredAncestorSha).toBe(gitShas.task1MergeSha);
    expect(auth.claimed).toBe(false);

    // Verify stage-specific authorizations and authorization history are preserved
    const g1Path = join(round.root, 'gate-worker1-authorization.json');
    expect(existsSync(g1Path)).toBe(true);
    const g1Auth = JSON.parse(readFileSync(g1Path, 'utf8'));
    expect(g1Auth.issue).toBe(2);
    expect(g1Auth.roundId).toBe(round.id);

    const g2Path = join(round.root, 'gate-worker2-authorization.json');
    expect(existsSync(g2Path)).toBe(true);
    const g2Auth = JSON.parse(readFileSync(g2Path, 'utf8'));
    expect(g2Auth.issue).toBe(3);
    expect(g2Auth.roundId).toBe(round.id);

    const authsJsonlPath = join(round.root, 'gate-authorizations.jsonl');
    expect(existsSync(authsJsonlPath)).toBe(true);
    const jsonlLines = readFileSync(authsJsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(jsonlLines.length).toBeGreaterThanOrEqual(2);
    expect(jsonlLines[0].gate).toBe('worker1');
    expect(jsonlLines[1].gate).toBe('worker2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);

test('Criterion 5 & 9: Non-containing second baseline is rejected by Gate 2 and prevents Worker 2 dispatch; valid containing revision launches Worker 2 exactly once', async () => {
  const { root, adapter, config, getGitShas } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);
    const gitShas = getGitShas();

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    let launchCount = 0;
    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        launchCount++;
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return true;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    writeFileSync(
      join(round.root, 'demo-tasks.json'),
      JSON.stringify({ roundId: round.id, parent: 1, task1: 2, task2: 3 }, null, 2),
    );

    const archiveDir = join(round.root, 'archive-task-1');
    mkdirSync(archiveDir, { recursive: true });
    gitCmd(round.checkout, 'bundle', 'create', join(archiveDir, 'repository.bundle'), '--all');

    // Scenario A: Gate 2 rejects a non-containing proposed revision
    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v2',
          children: [2, 3],
          nativeDependency: true,
          firstReleased: true,
          secondBaseline: false,
          accepted: false,
          task1: 2,
          task2: 3,
          task1MergeSha: gitShas.task1MergeSha,
          parentValid: true,
          noExtraTasks: true,
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, deliveryAdapter);

    // Non-containing revision fails Gate 2
    await expect(
      delivery.gate('worker2', { inputRevision: gitShas.divergentSha }),
    ).rejects.toThrow(/Gate 2 verification failed/i);

    // Verify control was stopped on Gate 2 failure
    const controlJson = JSON.parse(readFileSync(join(round.root, 'control.json'), 'utf8'));
    expect(controlJson.stopped).toBe(true);

    // Re-arm for testing valid Gate 2
    controlJson.stopped = false;
    delete controlJson.stoppedReason;
    writeFileSync(join(round.root, 'control.json'), JSON.stringify(controlJson, null, 2));

    // Valid containing revision passes Gate 2
    const validDeliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v2',
          children: [2, 3],
          nativeDependency: true,
          firstReleased: true,
          secondBaseline: true,
          accepted: false,
          task1: 2,
          task2: 3,
          task1MergeSha: gitShas.task1MergeSha,
          parentValid: true,
          noExtraTasks: true,
        };
      },
      async close() {},
    };

    const validDelivery = new DemoDelivery(round, validDeliveryAdapter);
    const gate2Pass = await validDelivery.gate('worker2', { inputRevision: gitShas.containingSha });
    expect(gate2Pass.authorization).toBeDefined();

    // Attempting to dispatch Worker 2 with a non-containing revision is denied by workflow
    await expect(
      dispatchStage(fleetConfig, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: `${subject.repository}#3`,
        role: 'worker',
        stage: 'implementation',
        inputRevision: gitShas.divergentSha,
        brief: 'Implement TSV summarizer',
        prerequisites: [],
      }),
    ).rejects.toThrow(/does not match authorized revision|does not contain Task 1 merge/i);

    expect(launchCount).toBe(1); // Only Orchestrator has launched

    // Valid containing revision dispatches Worker 2 exactly once
    const worker2Dispatch = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#3`,
      role: 'worker',
      stage: 'implementation',
      inputRevision: gitShas.containingSha,
      brief: 'Implement TSV summarizer',
      prerequisites: [],
    });
    expect(worker2Dispatch.id).toBeDefined();
    expect(launchCount).toBe(2); // Orchestrator + Worker 2

    // Authorization is now claimed
    const authPath = join(round.root, 'gate-authorization.json');
    const claimedAuth = JSON.parse(readFileSync(authPath, 'utf8'));
    expect(claimedAuth.claimed).toBe(true);

    // Second spawn with same authorization is prevented!
    await expect(
      dispatchStage(fleetConfig, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: `${subject.repository}#3`,
        role: 'worker',
        stage: 'implementation',
        inputRevision: gitShas.containingSha,
        brief: 'Implement TSV summarizer',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Gate authorization already claimed/i);

    expect(launchCount).toBe(2);

    // Parent run Orchestrator remains alive and available
    const runView = inspectRun(fleetConfig, run.id);
    expect(runView.lifecycle).toBe('running');
    expect(runView.orchestrator).toBeDefined();
    expect(runView.released).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);

test('Criterion 9: Incomplete first delivery or missing archive/release stops round and launches no second Worker', async () => {
  const { root, adapter, config, getGitShas } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);
    const gitShas = getGitShas();

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    let launchCount = 0;
    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        launchCount++;
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return true;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    // Incomplete first delivery: firstReleased is false
    const incompleteAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v2',
          children: [2, 3],
          nativeDependency: true,
          firstReleased: false, // Incomplete!
          secondBaseline: true,
          accepted: false,
          task1: 2,
          task2: 3,
          task1MergeSha: gitShas.task1MergeSha,
          parentValid: true,
          noExtraTasks: true,
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, incompleteAdapter);

    await expect(delivery.gate('worker2')).rejects.toThrow(/Task 1 delivery is incomplete or resources are not released/i);

    // No authorization issued for task 2
    const authPath = join(round.root, 'gate-authorization.json');
    expect(existsSync(authPath)).toBe(false);

    // Dispatching Worker 2 fails closed
    await expect(
      dispatchStage(fleetConfig, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: `${subject.repository}#3`,
        role: 'worker',
        stage: 'implementation',
        inputRevision: gitShas.containingSha,
        brief: 'Implement TSV summarizer',
        prerequisites: [],
      }),
    ).rejects.toThrow(/is stopped or expired|matching Gate authorization required/i);

    expect(launchCount).toBe(1); // Only Orchestrator was launched, no second Worker
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);

test('Criterion 7: Chronology records premature start finding and later success does not erase it', async () => {
  const { root, adapter, config, getGitShas } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);
    const gitShas = getGitShas();

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return true;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    // Record a failed gate event in delivery-boundaries.jsonl
    const boundaryPath = join(round.root, 'delivery-boundaries.jsonl');
    writeFileSync(
      boundaryPath,
      JSON.stringify({
        at: new Date(Date.now() - 60000).toISOString(),
        stage: 'worker2',
        pass: false,
        facts: { children: [2, 3] },
        error: 'Premature start attempt',
      }) + '\n',
    );

    // Even if a passing event is added later:
    const passingEvent = {
      at: new Date().toISOString(),
      stage: 'worker2',
      pass: true,
      facts: { children: [2, 3], task1: 2, task2: 3 },
    };
    writeFileSync(boundaryPath, JSON.stringify(passingEvent) + '\n', { flag: 'a' });

    // Chronology check must report a finding because a failure occurred
    const findings = await demoChronology(round);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].verdict).toBe('finding');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);

test('Criterion 8: Task 2 completes normal delivery, leaving two attributable child deliveries for integrated acceptance', async () => {
  const { root, adapter, config, getGitShas } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);
    const gitShas = getGitShas();

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return true;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    // Save demo-tasks.json
    writeFileSync(
      join(round.root, 'demo-tasks.json'),
      JSON.stringify({ roundId: round.id, parent: 1, task1: 2, task2: 3 }, null, 2),
    );

    // Task 1 already delivered
    const archiveDir1 = join(round.root, 'archive-task-1');
    mkdirSync(archiveDir1, { recursive: true });
    gitCmd(round.checkout, 'bundle', 'create', join(archiveDir1, 'repository.bundle'), '--all');

    updateRunRegistry(fleetConfig, (reg) => {
      reg.deliveries ??= [];
      reg.deliveries.push({
        runId: run.id,
        repository: subject.repository,
        issue: 2,
        pr: 10,
        status: 'done',
        recorded: true,
        released: true,
        releasePrepared: true,
        checkedHead: gitShas.task1MergeSha,
        archive: archiveDir1,
        evidence: 'delivery evidence 1',
        dispatches: ['d1'],
      });
    });

    // Gate 2 authorized for Task 2
    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v2',
          children: [2, 3],
          nativeDependency: true,
          firstReleased: true,
          secondBaseline: true,
          accepted: false,
          task1: 2,
          task2: 3,
          task1MergeSha: gitShas.task1MergeSha,
          parentValid: true,
          noExtraTasks: true,
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, deliveryAdapter);
    await delivery.gate('worker2', { inputRevision: gitShas.containingSha });

    // Dispatch Worker 2
    const worker2Dispatch = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#3`,
      role: 'worker',
      stage: 'implementation',
      inputRevision: gitShas.containingSha,
      brief: 'Implement TSV summarizer',
      prerequisites: [],
    });
    expect(worker2Dispatch.id).toBeDefined();

    // Worker 2 implementation and PR landing succeed
    updateRunRegistry(fleetConfig, (reg) => {
      const imp = reg.dispatches!.find((x) => x.id === worker2Dispatch.id)!;
      imp.lifecycle = 'accepted';
      reg.dispatches!.push({
        id: 'dispatch-task2-merge',
        runId: run.id,
        role: 'landing',
        stage: 'pr-merge',
        subject: `${subject.repository}#3`,
        inputRevision: gitShas.containingSha,
        brief: 'Merge PR 2',
        prerequisites: [],
        attempts: [],
        lifecycle: 'accepted',
      });
    });

    // Continuation for final records on task 2
    const finalRecordsDispatch = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#3`,
      role: 'worker',
      stage: 'final-records',
      inputRevision: gitShas.containingSha,
      brief: 'Record task 2 completion',
      prerequisites: [],
    });
    expect(finalRecordsDispatch.id).toBeDefined();

    // Complete task 2 delivery in registry
    const archiveDir2 = join(round.root, 'archive-task-2');
    mkdirSync(archiveDir2, { recursive: true });
    gitCmd(round.checkout, 'bundle', 'create', join(archiveDir2, 'repository.bundle'), '--all');

    updateRunRegistry(fleetConfig, (reg) => {
      reg.deliveries!.push({
        runId: run.id,
        repository: subject.repository,
        issue: 3,
        pr: 11,
        status: 'done',
        recorded: true,
        released: true,
        releasePrepared: true,
        checkedHead: gitShas.containingSha,
        archive: archiveDir2,
        evidence: 'delivery evidence 2',
        dispatches: [worker2Dispatch.id, finalRecordsDispatch.id],
      });
    });

    // Inspect run views: exactly two completed deliveries!
    const runView = inspectRun(fleetConfig, run.id);
    expect(runView.deliveries.length).toBe(2);
    expect(runView.deliveries[0].issue).toBe(2);
    expect(runView.deliveries[0].status).toBe('done');
    expect(runView.deliveries[0].released).toBe(true);
    expect(runView.deliveries[1].issue).toBe(3);
    expect(runView.deliveries[1].status).toBe('done');
    expect(runView.deliveries[1].released).toBe(true);

    // Parent Run remains active for integrated acceptance
    expect(runView.lifecycle).toBe('running');
    expect(runView.orchestrator).toBeDefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);

test('Criterion 2 & 3: nativeDemoDelivery independently verifies GitHub merge, dispatches, final records, bundle, cleanup, and scoped release', async () => {
  const { root, adapter, config, getGitShas } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);
    const gitShas = getGitShas();

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return true;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    const archiveDir = join(round.root, 'archive-task-1');
    mkdirSync(archiveDir, { recursive: true });
    gitCmd(round.checkout, 'bundle', 'create', join(archiveDir, 'repository.bundle'), '--all');

    const task1Checkout = join(round.checkout, 'task1-worktree');
    // Ensure task1Checkout does not exist on disk
    rmSync(task1Checkout, { recursive: true, force: true });

    // Mock GitHub state
    let prMergedAt: string | null = '2026-11-03T12:00:00Z';
    let prMergeSha = gitShas.task1MergeSha;

    const mockGh = (path: string) => {
      if (path.includes('/issues/1/sub_issues')) {
        return [{ number: 2 }, { number: 3 }];
      }
      if (path.includes('/issues/1')) {
        return { number: 1, state: 'open' };
      }
      if (path.includes('/issues/2/dependencies/blocked_by')) {
        return [];
      }
      if (path.includes('/issues/3/dependencies/blocked_by')) {
        return [{ number: 2 }];
      }
      if (path.includes('/pulls')) {
        return [
          {
            number: 10,
            merged_at: prMergedAt,
            merge_commit_sha: prMergeSha,
            head: { sha: gitShas.baseSha },
          },
        ];
      }
      if (path.includes('/issues?state=all')) {
        return [{ number: 1 }, { number: 2 }, { number: 3 }];
      }
      return {};
    };

    const attempt1: ManagedAttempt = {
      id: 'a1',
      role: 'worker',
      status: 'unknown',
      created: new Date().toISOString(),
      directory: join(round.root, 'a1'),
      checkout: task1Checkout,
    };
    mkdirSync(attempt1.directory, { recursive: true });
    writeFileSync(
      join(attempt1.directory, 'control.json'),
      JSON.stringify({ execution: { status: 'terminated' } }),
    );

    // Initial setup with all passing facts
    updateRunRegistry(fleetConfig, (reg) => {
      reg.dispatches ??= [];
      reg.dispatches.push({
        id: 'd1',
        runId: run.id,
        role: 'worker',
        stage: 'implementation',
        subject: `${subject.repository}#2`,
        inputRevision: gitShas.baseSha,
        brief: 'Implement TSV generator',
        prerequisites: [],
        attempts: [attempt1],
        lifecycle: 'accepted',
      });
      reg.deliveries ??= [];
      reg.deliveries.push({
        runId: run.id,
        repository: subject.repository,
        issue: 2,
        pr: 10,
        status: 'done',
        recorded: true,
        released: true,
        releasePrepared: true,
        checkedHead: gitShas.baseSha,
        archive: archiveDir,
        evidence: 'delivery evidence 1',
        dispatches: ['d1'],
      });
    });

    const nativeAdapter = nativeDemoDelivery(round, mockGh);
    const snap1 = await nativeAdapter.inspect();
    expect(snap1.firstReleased).toBe(true);
    expect(snap1.task1MergeSha).toBe(gitShas.task1MergeSha);

    // Condition 1: PR not merged -> firstReleased false
    prMergedAt = null;
    const snapNoPr = await nativeAdapter.inspect();
    expect(snapNoPr.firstReleased).toBe(false);
    prMergedAt = '2026-11-03T12:00:00Z';

    // Condition 2: PR merge commit missing in git -> firstReleased false
    prMergeSha = '0'.repeat(40);
    const snapMissingCommit = await nativeAdapter.inspect();
    expect(snapMissingCommit.firstReleased).toBe(false);
    prMergeSha = gitShas.task1MergeSha;

    // Condition 3: Dispatches not accepted -> firstReleased false
    updateRunRegistry(fleetConfig, (reg) => {
      reg.dispatches!.find((d) => d.id === 'd1')!.lifecycle = 'running';
    });
    const snapUnaccepted = await nativeAdapter.inspect();
    expect(snapUnaccepted.firstReleased).toBe(false);
    updateRunRegistry(fleetConfig, (reg) => {
      reg.dispatches!.find((d) => d.id === 'd1')!.lifecycle = 'accepted';
    });

    // Condition 4: Final records not recorded -> firstReleased false
    updateRunRegistry(fleetConfig, (reg) => {
      reg.deliveries!.find((d) => d.issue === 2)!.recorded = false;
    });
    const snapNotRecorded = await nativeAdapter.inspect();
    expect(snapNotRecorded.firstReleased).toBe(false);
    updateRunRegistry(fleetConfig, (reg) => {
      reg.deliveries!.find((d) => d.issue === 2)!.recorded = true;
    });

    // Condition 5: Archive bundle missing -> firstReleased false
    const bundleFile = join(archiveDir, 'repository.bundle');
    const tmpBundle = join(archiveDir, 'repository.bundle.bak');
    execFileSync('mv', [bundleFile, tmpBundle]);
    const snapMissingBundle = await nativeAdapter.inspect();
    expect(snapMissingBundle.firstReleased).toBe(false);
    execFileSync('mv', [tmpBundle, bundleFile]);

    // Condition 6: Task 1 worktree still on disk -> firstReleased false
    mkdirSync(task1Checkout, { recursive: true });
    const snapCheckoutOnDisk = await nativeAdapter.inspect();
    expect(snapCheckoutOnDisk.firstReleased).toBe(false);
    rmSync(task1Checkout, { recursive: true, force: true });

    // Condition 7: Task 1 checkout resource still held in resources -> firstReleased false
    updateRunRegistry(fleetConfig, (reg) => {
      reg.resources ??= [];
      reg.resources.push({ path: task1Checkout, runId: run.id, registry: '' });
    });
    const snapResourceHeld = await nativeAdapter.inspect();
    expect(snapResourceHeld.firstReleased).toBe(false);
    updateRunRegistry(fleetConfig, (reg) => {
      reg.resources = reg.resources?.filter((r) => r.path !== task1Checkout);
    });

    // Condition 8: Task 1 execution not terminated -> firstReleased false
    writeFileSync(
      join(attempt1.directory, 'control.json'),
      JSON.stringify({ execution: { status: 'running' } }),
    );
    const snapExecutionRunning = await nativeAdapter.inspect();
    expect(snapExecutionRunning.firstReleased).toBe(false);
    writeFileSync(
      join(attempt1.directory, 'control.json'),
      JSON.stringify({ execution: { status: 'terminated' } }),
    );

    // Condition 9: Parent Run terminated/released -> firstReleased false
    updateRunRegistry(fleetConfig, (reg) => {
      reg.runs.find((r) => r.id === run.id)!.lifecycle = 'completed';
    });
    const snapParentCompleted = await nativeAdapter.inspect();
    expect(snapParentCompleted.firstReleased).toBe(false);
    updateRunRegistry(fleetConfig, (reg) => {
      reg.runs.find((r) => r.id === run.id)!.lifecycle = 'running';
    });

    // All conditions passing again
    const snapFinal = await nativeAdapter.inspect();
    expect(snapFinal.firstReleased).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);
