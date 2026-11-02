/** Isolated shared toy EPIC. Scripts execute tasks; the caller chooses the schedule. */
import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadFleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';
import {
  startRun,
  inspectRuns,
  type StageRequest,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { reconcileStartup } from '../../packages/core/src/workflow/run/startup.js';
import {
  type ManagedAttempt,
  type RunnerAdapter,
} from '../../packages/core/src/workflow/runtime/runtime.js';
import { registerStageCommands } from '../../packages/cli/src/commands/workflow-stages.js';
import { initializeRole } from './initialize-role.js';

/** Prepare shared evidence and controlled execution without dispatching subordinate work. */
export async function prepareScriptedEpic(native?: RunnerAdapter, brief?: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pc-scripted-epic-')));
  if (native)
    console.error(JSON.stringify({ evidenceDirectory: directory, phase: 'preparing-native-demo' }));
  mkdirSync(join(directory, 'pool'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Toy EPIC');
  git('config', 'user.email', 'toy@example.invalid');
  writeFileSync(join(directory, 'toy.txt'), 'Tiny isolated task\n');
  git('add', 'toy.txt');
  git('commit', '-m', 'Toy input');
  const file = join(directory, '.epic-config.json');
  writeFileSync(file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
  const config = loadFleetConfig(file);
  const launched: string[] = [];
  const activated = new Set<string>();
  const terminated = new Set<string>();
  const tasks = new Map<string, (a: ManagedAttempt) => string>();
  const delivery = { head: '', state: 'OPEN', conflict: false, mergeCommit: '' };
  const pullRequests = {
    async ensure() {
      return 2;
    },
    async read() {
      return { ...delivery };
    },
    async checks() {
      return 'passed' as const;
    },
    async merge(_pr: number, head: string) {
      if (head !== delivery.head) throw new Error('Head moved');
      delivery.state = 'MERGED';
      delivery.mergeCommit = head;
    },
  };
  const runner = {
    name: native?.name ?? 'codex',
    interactive: true,
    separateActivation: true,
    cancellation: true,
    async preflight() {
      await native?.preflight();
    },
    async start(a: ManagedAttempt) {
      launched.push(a.id);
      if (native && a.role === 'orchestrator') {
        a.startupGate = true;
        return native.start(a);
      }
      initializeRole(a);
      writeFileSync(
        join(a.directory, 'script-start.json'),
        JSON.stringify({ attempt: a.id, role: a.role }),
      );
      return {
        conversation: a.id,
        address: `controlled:${a.id}`,
        evidence: join(a.directory, 'script-start.json'),
      };
    },
    async recoverReceipt(a: ManagedAttempt) {
      if (native && a.role === 'orchestrator') return native.recoverReceipt?.(a);
      return {
        conversation: a.id,
        address: `controlled:${a.id}`,
        evidence: join(a.directory, 'initialization.json'),
      };
    },
    async messageReceipt(a: ManagedAttempt, message: { id: string; brief: string }) {
      if (native && a.role === 'orchestrator') return native.messageReceipt?.(a, message);
      return activated.has(a.id) ? join(a.directory, 'activation.json') : undefined;
    },
    async send(a: ManagedAttempt, message: { id: string; brief: string }) {
      if (native && a.role === 'orchestrator') return native.send!(a, message);
      activated.add(a.id);
      writeFileSync(join(a.directory, 'activation.json'), JSON.stringify(message));
      return { status: 'delivered' as const, evidence: join(a.directory, 'activation.json') };
    },
    async result(a: ManagedAttempt) {
      if (native && a.role === 'orchestrator') return native.result!(a, a.dispatchId ?? a.id);
      if (!activated.has(a.id)) return undefined;
      const dispatch = inspectRuns(config).dispatches?.find((d) =>
        d.attempts.some((x) => x.id === a.id),
      );
      const task = dispatch && tasks.get(dispatch.stage);
      if (task) return task(a);
      const path = join(a.directory, 'planning.md');
      writeFileSync(path, 'Toy plan: change toy.txt; preserve its Git history.\n');
      return JSON.stringify({ status: 'completed', artifact: path, role: a.role, attempt: a.id });
    },
    async stopped(a: ManagedAttempt) {
      if (native && a.role === 'orchestrator') return native.stopped!(a);
      return terminated.has(a.id);
    },
    async cancel(a: ManagedAttempt) {
      if (native && a.role === 'orchestrator') return native.cancel!(a);
      terminated.add(a.id);
      return { evidence: 'Controlled task termination' };
    },
    async collect(a: ManagedAttempt) {
      return (await this.result(a))!;
    },
    collectable() {
      return true;
    },
  };
  const run = await startRun(
    config,
    runner,
    {
      repository: 'toy/epic',
      number: 1,
      kind: 'epic',
      title: 'Tiny EPIC',
      body: brief ?? 'Change a tiny file using retained evidence.',
    },
    runner.name,
    native
      ? 'Only isolated toy files. Loopback demo endpoint only; no external network or scientific work.'
      : 'Only isolated toy files. No network or scientific work.',
  );
  await reconcileStartup(config, runner, run.id);
  let requestNumber = 0;
  async function cli(operation: string, args: string[] = []) {
    const program = new Command();
    registerStageCommands(
      program,
      { human: () => false },
      {
        runner: () => runner,
        pullRequests: () => pullRequests,
        closure: async () => ({
          head: git('rev-parse', 'HEAD'),
          closed: true,
          evidence: join(directory, 'human-closure.json'),
        }),
      },
    );
    await program.parseAsync(
      [
        'stage',
        operation,
        '--config',
        config.file,
        '--run',
        run.id,
        '--authority',
        run.orchestratorId,
        ...args,
      ],
      { from: 'user' },
    );
  }
  async function dispatch(input: Omit<StageRequest, 'runId' | 'authority'>) {
    const path = join(directory, `request-${++requestNumber}.json`);
    writeFileSync(path, JSON.stringify(input));
    await cli('dispatch', ['--input', path]);
    await reconcileStartup(config, runner, run.id);
    return inspectRuns(config).dispatches!.at(-1)!;
  }
  return {
    directory,
    config,
    run,
    runner,
    launched,
    activated,
    terminated,
    git,
    cli,
    dispatch,
    tasks,
    delivery,
  };
}

/** First vertical slice; later slices reuse this prepared context and public CLI calls. */
export async function runPlanningDemo() {
  const demo = await prepareScriptedEpic();
  const request = {
    subject: 'toy/epic#1',
    role: 'epic' as const,
    stage: 'planning',
    inputRevision: demo.git('rev-parse', 'HEAD'),
    brief: 'Produce a tiny implementation plan.',
    prerequisites: [],
  };
  const dispatch = await demo.dispatch(request);
  await demo.dispatch(request);
  if (demo.launched.length !== 2) throw new Error(`Idempotency failed: ${demo.directory}`);
  await demo.cli('collect', ['--dispatch', dispatch.id]);
  const receipt = inspectRuns(demo.config).receipts!.at(-1)!;
  const result = JSON.parse(readFileSync(receipt.evidence[0].path, 'utf8'));
  if (!readFileSync(result.artifact, 'utf8').includes('toy.txt'))
    throw new Error('Missing toy plan');
  const decision = join(demo.directory, 'planning-decision.md');
  writeFileSync(decision, 'Reviewed plan: bounded toy.txt change, retained Git history.');
  await demo.cli('accept', ['--receipt', receipt.id, '--decision', decision]);
  if (
    inspectRuns(demo.config).dispatches?.find((d) => d.id === dispatch.id)?.lifecycle !== 'accepted'
  )
    throw new Error(`Planning acceptance blocked; inspect ${demo.directory}`);
  return {
    ...demo,
    planning: dispatch.id,
    evidenceLevel:
      'Controlled lifecycle/CLI evidence; no native subordinate or scientific validity claim.',
  };
}

/** The same CLI scenario extended through independently verified local toy delivery. */
export async function runDeliveryDemo() {
  const demo = await runPlanningDemo();
  const checkout = prepareDeliveryTasks(demo);
  let previous = demo.planning;
  async function task(stage: string, role: 'worker' | 'landing', revision: string) {
    const dispatch = await demo.dispatch({
      subject: 'toy/epic#2',
      role,
      stage,
      inputRevision: revision,
      brief: `Execute only toy ${stage}; retain evidence.`,
      prerequisites: [previous],
      checkout,
    });
    await demo.cli('collect', ['--dispatch', dispatch.id]);
    return dispatch;
  }
  async function accept(id: string) {
    const receipt = inspectRuns(demo.config)
      .receipts!.filter((r) => r.dispatchId === id)
      .at(-1)!;
    const decision = join(demo.directory, `${id}-decision.md`);
    writeFileSync(
      decision,
      'Reviewed bounded toy artifact and independently checked current delivery facts.',
    );
    await demo.cli('accept', ['--receipt', receipt.id, '--decision', decision, '--pr', '2']);
    if (inspectRuns(demo.config).dispatches!.find((d) => d.id === id)!.lifecycle !== 'accepted')
      throw new Error(`Acceptance blocked; ${demo.directory}`);
    previous = id;
  }
  const worker = await task('implementation', 'worker', demo.git('rev-parse', 'HEAD'));
  // The implementation intentionally changes HEAD: dispatch binds the known resulting revision.
  // Correction uses a new assignment after independently stopped prior execution.
  demo.terminated.add(worker.attempts.at(-1)!.id);
  const oldExit = process.exitCode;
  const launches = demo.launched.length;
  await demo.dispatch({
    subject: 'toy/epic#2',
    role: 'landing',
    stage: 'pr-merge',
    inputRevision: demo.delivery.head,
    brief: 'Premature merge must not launch',
    prerequisites: [],
    checkout,
  });
  const prematureLaunches = demo.launched.length - launches;
  if (process.exitCode !== 2 || prematureLaunches)
    throw new Error('Missing prerequisite was not rejected');
  process.exitCode = oldExit;
  // Implementation acceptance verifies the resulting Git revision, not an agent assertion.
  // Re-dispatch with the final immutable revision and reuse the committed artifact.
  demo.tasks.set('implementation', (a) =>
    JSON.stringify({ status: 'completed', artifact: join(checkout, 'toy.txt'), attempt: a.id }),
  );
  // Original pre-edit revision cannot be accepted against the changed HEAD. Collect a current revision generation.
  const rejected = inspectRuns(demo.config).receipts!.find((r) => r.dispatchId === worker.id)!;
  const decision = join(demo.directory, 'stale-implementation.md');
  writeFileSync(decision, 'Reject stale pre-edit revision.');
  await demo.cli('accept', ['--receipt', rejected.id, '--decision', decision]);
  process.exitCode = oldExit;
  const implementation = await task('implementation', 'worker', demo.delivery.head);
  await accept(implementation.id);
  const quality = await task('pr-quality', 'landing', demo.delivery.head);
  await accept(quality.id);
  const merge = await task('pr-merge', 'landing', demo.delivery.head);
  await demo.cli('execute', ['--dispatch', merge.id, '--pr', '2']);
  await accept(merge.id);
  const records = await task('final-records', 'worker', demo.delivery.head);
  await accept(records.id);
  const cleanup = await task('preservation-cleanup', 'landing', demo.delivery.head);
  // The controlled script has returned and independently reports terminated before releasing its checkout.
  demo.terminated.add(cleanup.attempts.at(-1)!.id);
  await demo.cli('execute', ['--dispatch', cleanup.id, '--pr', '2']);
  await accept(cleanup.id);
  const archive = JSON.parse(
    readFileSync(join(cleanup.attempts.at(-1)!.directory, 'cleanup.json'), 'utf8'),
  ).archive as string;
  return {
    ...demo,
    checkout,
    archive,
    prematureLaunches,
    implementation: implementation.id,
    cleanup: cleanup.id,
  };
}

/** Complete the shared seven-role controlled scenario; retain all evidence for inspection. */
export async function runAllRoleDemo() {
  const demo = await runDeliveryDemo();
  demo.git('merge', '--ff-only', 'toy-worker');
  const head = demo.git('rev-parse', 'HEAD');
  let previous = demo.cleanup;
  async function task(
    stage: string,
    role: 'epic' | 'pipeline-audit' | 'pipeline-refactor' | 'research-state',
    body: (a: ManagedAttempt) => string,
  ) {
    demo.tasks.set(stage, body);
    const dispatch = await demo.dispatch({
      subject: 'toy/epic#1',
      role,
      stage,
      inputRevision: head,
      brief: `Bounded toy ${stage}; supplied judgments only; no scientific conclusions.`,
      prerequisites: [previous],
    });
    await demo.cli('collect', ['--dispatch', dispatch.id]);
    const receipt = inspectRuns(demo.config)
      .receipts!.filter((r) => r.dispatchId === dispatch.id)
      .at(-1)!;
    const decision = join(demo.directory, dispatch.id + '-decision.md');
    writeFileSync(decision, 'Reviewed toy evidence at the integrated revision.');
    await demo.cli('accept', ['--receipt', receipt.id, '--decision', decision]);
    if (
      inspectRuns(demo.config).dispatches!.find((d) => d.id === dispatch.id)!.lifecycle !==
      'accepted'
    )
      throw new Error('Finalization acceptance blocked: ' + demo.directory);
    previous = dispatch.id;
    return dispatch;
  }
  const before = demo.launched.length;
  const oldExit = process.exitCode;
  await demo.dispatch({
    subject: 'toy/epic#1',
    role: 'pipeline-audit',
    stage: 'pipeline-audit',
    inputRevision: head,
    brief: 'Must wait for closure',
    prerequisites: [],
  });
  if (process.exitCode !== 2 || demo.launched.length !== before)
    throw new Error('Premature specialist launched');
  process.exitCode = oldExit;
  const acceptance = await task('integrated-acceptance', 'epic', () =>
    JSON.stringify({
      satisfied: true,
      criteria: ['toy.txt delivered with preserved history'],
      blockers: [],
    }),
  );
  const deliveries = inspectRuns(demo.config).deliveries!.filter((d) => d.runId === demo.run.id);
  const deliveryVersion = createHash('sha256')
    .update(JSON.stringify({ head, deliveries }))
    .digest('hex');
  const confirmation = join(demo.directory, 'human-closure.json');
  writeFileSync(
    confirmation,
    JSON.stringify({
      deliveryVersion,
      source: 'human',
      evidence: 'Controlled fixture confirmation only; not production human judgment',
    }),
  );
  const validConfirmation = readFileSync(confirmation, 'utf8');
  writeFileSync(
    confirmation,
    JSON.stringify({ deliveryVersion: 'stale', source: 'human', evidence: 'old toy confirmation' }),
  );
  await demo.cli('close', ['--dispatch', acceptance.id, '--decision', confirmation]);
  if (
    process.exitCode !== 2 ||
    inspectRuns(demo.config).runs.find((r) => r.id === demo.run.id)!.epicClosure
  )
    throw new Error('Stale confirmation accepted');
  process.exitCode = oldExit;
  writeFileSync(confirmation, validConfirmation);
  await demo.cli('close', ['--dispatch', acceptance.id, '--decision', confirmation]);
  const pipeline = () =>
    JSON.stringify({
      head,
      status: 'completed',
      evidence: [demo.archive],
      blockers: [],
      scope: ['toy structural verification'],
      checks: ['toy Git history preserved'],
      artifacts: [demo.archive],
      limitations: ['Controlled fixture only'],
      disposition: 'completed_no_changes',
      inspectedVersions: { toy: head },
      findings: [],
      maintenance: [],
    });
  await task('pipeline-audit', 'pipeline-audit', pipeline);
  const refactor = await task('pipeline-refactor', 'pipeline-refactor', pipeline);
  await demo.cli('pipeline', ['--dispatch', refactor.id]);
  const report = await task('research-report', 'research-state', (a) => {
    const artifact = join(a.directory, 'toy-report.md');
    writeFileSync(
      artifact,
      [
        'Objective',
        'Accepted delivery versions',
        'Observed repository versions',
        'Pipeline disposition',
        'Verified findings',
        'Interpretation',
        'No scientific conclusions',
        'Missing evidence',
        'Follow-up Issues',
        'Limitations',
      ].join('\n'),
    );
    return JSON.stringify({
      status: 'completed',
      artifact,
      artifactHash: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
    });
  });
  const coordinator = join(demo.directory, 'coordinator.json');
  writeFileSync(
    coordinator,
    JSON.stringify({
      identity: 'Toy coordinator',
      entry: join(demo.directory, 'TOY-REPORT.md'),
      brief: 'Supplied toy judgment: infrastructure delivery only; no scientific conclusions.',
    }),
  );
  await demo.cli('publish', ['--dispatch', report.id, '--decision', coordinator]);
  if (inspectRuns(demo.config).runs.find((r) => r.id === demo.run.id)!.lifecycle !== 'completed')
    throw new Error('Incomplete toy finalization: ' + demo.directory);
  verifyAllRoleOutcome(demo.config, demo.run.id);
  return { ...demo, report: join(demo.directory, 'TOY-REPORT.md') };
}

/** Prepare tiny delivery scripts; never schedule them. */
export function prepareDeliveryTasks(demo: Awaited<ReturnType<typeof prepareScriptedEpic>>) {
  const checkout = join(demo.directory, 'pool', 'issue-2');
  demo.git('worktree', 'add', '-b', 'toy-worker', checkout);
  const localGit = (...args: string[]) =>
    execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
  demo.tasks.set('implementation', (a) => {
    writeFileSync(join(checkout, 'toy.txt'), 'Tiny delivered change\n');
    localGit('add', 'toy.txt');
    localGit('commit', '-m', 'Deliver tiny change');
    demo.delivery.head = localGit('rev-parse', 'HEAD');
    return JSON.stringify({
      status: 'completed',
      artifact: join(checkout, 'toy.txt'),
      attempt: a.id,
    });
  });
  demo.tasks.set('final-records', (a) => {
    writeFileSync(
      join(checkout, '.epic-status.json'),
      JSON.stringify({
        issue: 2,
        assessment: 'Toy change delivered at evaluated head',
        followups: [],
      }),
    );
    writeFileSync(
      join(checkout, '.epic-worklog.md'),
      'Worker final records: evaluated head merged; toy.txt delivered.\n',
    );
    return JSON.stringify({ complete: true, assessment: 'Toy delivered', attempt: a.id });
  });
  for (const stage of ['pr-quality', 'pr-merge', 'preservation-cleanup'])
    demo.tasks.set(stage, (a) =>
      JSON.stringify({ passed: true, head: demo.delivery.head, attempt: a.id, stage }),
    );
  return checkout;
}

/** Independently check the common scripted/live business outcome, retaining occupancy separately. */
export function verifyAllRoleOutcome(config: ReturnType<typeof loadFleetConfig>, runId: string) {
  const registry = inspectRuns(config);
  const run = registry.runs.find((r) => r.id === runId);
  const roles = new Set([
    'orchestrator',
    ...registry
      .dispatches!.filter((d) => d.runId === runId && d.lifecycle === 'accepted')
      .map((d) => d.role),
  ]);
  if (
    run?.lifecycle !== 'completed' ||
    !run.epicClosure ||
    !run.pipeline ||
    !run.report ||
    roles.size !== 7
  )
    throw new Error('Incomplete seven-role toy workflow; inspect retained registry evidence');
  if (!readFileSync(run.report.path, 'utf8').includes('No scientific conclusions'))
    throw new Error('Missing supplied toy report');
  return { run, roles: [...roles], resources: registry.resources };
}
