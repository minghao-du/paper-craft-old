import {
  startBusinessTurn,
  collectBusinessTurn,
  acceptValidatedBusinessTurns,
  validateImplementationResult,
} from './run-driver.js';
import {
  orchestratorForSubject,
  reserveRunCheckout,
  referenceRunSubject,
  inspectRuns,
} from './run-driver.js';
import { claimDriver } from './driver-lock.js';
/** Repository-scoped EPIC planning and dependency-aware Worker dispatch. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDirectory } from './handoff.js';
import { workflowSource, type FleetConfig } from './fleet-config.js';
import {
  driveIssue,
  inspectIssueRun,
  type IssueRun,
  type IssueInput,
  type IssueTurn,
  type RoundRunner,
} from './issue-driver.js';
/** EPIC professional judgment, separate from mechanical resource allocation. */
export interface EpicTask {
  number: number;
  title: string;
  body: string;
  brief: string;
  blockedBy: number[];
  ready: boolean;
  result?: string;
  checkout?: string;
}
/** Durable attributed plan and role exchanges; delivered is not EPIC closure. */
export interface EpicRun {
  repository: string;
  epic: number;
  goal: string;
  /** Immutable original issue objective, independent of professional replanning. */
  originalGoal?: string;
  /** Original child intake survives a recovery invoked by EPIC identity alone. */
  intake?: IssueInput;
  constraints: string[];
  tasks: EpicTask[];
  turns: IssueTurn[];
  status: 'running' | 'delivered' | 'blocked';
  error?: string;
  ownedCheckouts?: Record<number, string>;
}
function save(file: string, value: unknown) {
  const temp = file + '.' + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}
function location(config: FleetConfig, repository: string, number: number) {
  return stateDirectory(
    config,
    '.runtime',
    'epics',
    createHash('sha256').update(`${config.file}:${repository}:${number}`).digest('hex'),
  );
}
/** Observe an EPIC without scheduling additional work. */
export function inspectEpicRun(
  config: FleetConfig,
  repository: string,
  number: number,
): EpicRun | undefined {
  const file = join(location(config, repository, number), 'epic.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}
/** Compatibility child entry: deliver only the requested child, never expand to its parent. */
export async function driveEpicIssue(
  config: FleetConfig,
  runner: RoundRunner,
  issue: IssueInput,
): Promise<IssueRun> {
  if (!issue.parent) throw new Error('Expected issue with verified EPIC parent');
  return driveIssue(config, runner, issue);
}
/** Ask the EPIC Agent for professional readiness, then dispatch bounded independent batches. */
export async function driveEpic(
  config: FleetConfig,
  runner: RoundRunner,
  epic: IssueInput,
  maxWorkers = 2,
  intake?: IssueInput,
): Promise<EpicRun> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(epic.repository) ||
    !Number.isSafeInteger(epic.number) ||
    epic.number < 1 ||
    !Number.isSafeInteger(maxWorkers) ||
    maxWorkers < 1
  )
    throw new Error('Expected repository, positive EPIC number and Worker limit');
  await runner.preflight();
  const orchestrator = orchestratorForSubject(config, epic.repository, epic.number);
  if (orchestrator?.run && orchestrator.runner !== runner.name)
    throw new Error('Run provider conflict');
  if (!orchestrator?.conversation || orchestrator.status !== 'running')
    throw new Error('Expected acknowledged managed Orchestrator');
  const home = location(config, epic.repository, epic.number);
  mkdirSync(home, { recursive: true });
  const file = join(home, 'epic.json');
  const previous = inspectEpicRun(config, epic.repository, epic.number);
  if (previous?.status === 'delivered') return previous;
  const lock = join(
    stateDirectory(config, '.runtime'),
    `driver-${orchestrator.run ?? orchestrator.fleet}.lock`,
  );
  claimDriver(lock);
  const run: EpicRun = previous ?? {
    repository: epic.repository,
    epic: epic.number,
    goal: epic.body,
    originalGoal: epic.body,
    intake,
    constraints: [],
    tasks: [],
    turns: [],
    status: 'running',
  };
  run.ownedCheckouts ??= Object.fromEntries(
    run.tasks.filter((t) => t.checkout).map((t) => [t.number, t.checkout!]),
  );
  const owned = new Map(
    Object.entries(run.ownedCheckouts).map(([number, checkout]) => [Number(number), checkout]),
  );
  run.tasks = [];
  save(file, run);
  let epicConversation: string | undefined;
  let replay = 0;
  async function turn(
    role: IssueTurn['role'],
    brief: string,
    checkout = config.project,
    subjectNumber = epic.number,
  ) {
    const retained = run.turns[replay++];
    if (retained) {
      if (retained.role !== role || retained.brief !== brief)
        throw new Error('Recovery route differs; preserve original attempts');
      if (retained.result === undefined) {
        if (!retained.conversation || retained.status !== 'running')
          throw new Error('Missing original receipt; retain unknown occupancy');
        retained.result = await collectBusinessTurn(
          config,
          runner,
          retained,
          role === 'worker'
            ? (raw) => validateImplementationResult(raw, epic.repository, subjectNumber)
            : undefined,
        );
        save(file, run);
      }
      if (role === 'epic') epicConversation = retained.conversation;
      return retained.result;
    }
    const id = randomUUID();
    const directory = stateDirectory(
      config,
      '.runtime',
      'epics',
      createHash('sha256').update(`${config.file}:${epic.repository}:${epic.number}`).digest('hex'),
      id,
    );
    mkdirSync(directory, { recursive: true });
    const t: IssueTurn = {
      id,
      fleet: orchestrator!.fleet,
      role,
      runner: runner.name,
      brief,
      status: 'starting',
      created: new Date().toISOString(),
      directory,
      checkout,
      conversation:
        role === 'epic'
          ? epicConversation
          : role === 'orchestrator'
            ? orchestrator!.conversation
            : undefined,
    };
    run.turns.push(t);
    writeFileSync(join(directory, 'brief.md'), brief);
    save(file, run);
    try {
      if (role === 'worker' && orchestrator!.run)
        reserveRunCheckout(config, orchestrator!.run, orchestrator!.id, checkout);
      const receipt = await startBusinessTurn(config, runner, t, epic.repository, subjectNumber);
      if (!receipt.conversation || !receipt.address || !receipt.evidence)
        throw new Error('Expected actual Runner receipt');
      Object.assign(t, receipt, { status: 'running' });
      if (role === 'epic') epicConversation = t.conversation;
      save(file, run);
      t.result = await collectBusinessTurn(
        config,
        runner,
        t,
        role === 'worker'
          ? (raw) => validateImplementationResult(raw, epic.repository, subjectNumber)
          : undefined,
      );
      save(file, run);
      return t.result;
    } catch (error) {
      t.error = String(error);
      save(file, run);
      throw error;
    }
  }
  function plan(raw: string) {
    const p = JSON.parse(raw);
    if (
      typeof p.goal !== 'string' ||
      !p.goal.trim() ||
      !Array.isArray(p.constraints) ||
      !p.constraints.every((x: unknown) => typeof x === 'string') ||
      !Array.isArray(p.tasks)
    )
      throw new Error('Expected EPIC goal, constraints and task plan');
    const seen = new Set<number>();
    for (const t of p.tasks) {
      if (
        !Number.isSafeInteger(t.number) ||
        t.number < 1 ||
        t.number === epic.number ||
        seen.has(t.number) ||
        typeof t.brief !== 'string' ||
        !t.brief.trim() ||
        typeof t.title !== 'string' ||
        typeof t.body !== 'string' ||
        typeof t.ready !== 'boolean' ||
        !Array.isArray(t.blockedBy) ||
        !t.blockedBy.every((n: unknown) => Number.isSafeInteger(n))
      )
        throw new Error('Expected unique scoped tasks and dependency/readiness judgment');
      seen.add(t.number);
    }
    for (const t of p.tasks)
      if (t.blockedBy.some((n: number) => !seen.has(n) || n === t.number))
        throw new Error('Expected dependencies within EPIC plan');
    if (run.tasks.some((t) => !seen.has(t.number)))
      throw new Error('EPIC plan must retain existing tasks and delivery evidence');
    const delivered = new Map(run.tasks.filter((t) => t.result).map((t) => [t.number, t]));
    run.goal = p.goal;
    run.constraints = p.constraints;
    run.tasks = p.tasks.map((t: EpicTask) => ({
      ...t,
      result: delivered.get(t.number)?.result,
      checkout: owned.get(t.number),
    }));
    save(file, run);
  }
  const schema =
    'Reply only JSON {"goal":"original objective","constraints":[],"tasks":[{"number":1,"title":"task","body":"scope","brief":"bounded stage","blockedBy":[],"ready":true}]}. Include every outstanding task and preserve delivered tasks. Judge semantic dependencies and readiness; Orchestrator alone allocates checkouts and launches Workers. Do not create Worker sessions yourself.';
  try {
    await runner.collect(orchestrator);
    plan(
      await turn(
        'epic',
        run.turns[0]?.brief ??
          `Plan ${epic.repository} EPIC #${epic.number}: ${epic.title}\n${epic.body}\nIntake: ${JSON.stringify(run.intake)}\n${schema}`,
      ),
    );
    for (let cycle = 0; cycle < 20; cycle++) {
      const pending = run.tasks.filter((t) => !t.result);
      if (!pending.length) {
        await acceptValidatedBusinessTurns(
          config,
          run.turns,
          'Validated EPIC readiness and all scoped child results against original objective',
        );
        run.status = 'delivered';
        delete run.error;
        save(file, run);
        return run;
      }
      const ready = pending
        .filter(
          (t) =>
            t.ready && t.blockedBy.every((n) => run.tasks.some((d) => d.number === n && d.result)),
        )
        .slice(0, maxWorkers);
      if (!ready.length)
        throw new Error('EPIC has unresolved semantic dependencies or readiness blockers');
      if (!config.worktrees) throw new Error('Automatic EPIC allocation requires local_worktrees');
      // Claim or reference every child before allocating any execution.
      for (const task of ready) {
        if (!orchestrator.run) continue;
        const owner = referenceRunSubject(
          config,
          orchestrator.run,
          `${epic.repository}#${task.number}`,
        );
        if (owner === orchestrator.run) continue;
        const ownerRun = inspectRuns(config).runs.find((r) => r.id === owner)!;
        if (ownerRun.provider !== runner.name)
          throw new Error('Referenced child provider conflict');
        const delivery = inspectIssueRun(config, epic.repository, task.number);
        if (!delivery || delivery.status !== 'done')
          throw new Error(`Referenced child #${task.number} delivery pending in Run ${owner}`);
        const acceptance = JSON.parse(
          await turn(
            'epic',
            `Validate referenced child #${task.number} against this EPIC objective and scoped brief: ${epic.body}\n${task.brief}\nEvidence: ${JSON.stringify(delivery)}\nReply only JSON {"accepted":true} or {"accepted":false}. Do not inherit authorization.`,
          ),
        );
        if (acceptance.accepted !== true)
          throw new Error('Referenced child requires EPIC acceptance');
        task.result = JSON.stringify(delivery);
        task.checkout = delivery.checkout;
        save(file, run);
      }
      const ownedReady = ready.filter((t) => !t.result);
      // Allocate serially: each checkout has one owner before concurrent execution begins.
      for (const task of ownedReady) {
        if (task.checkout) {
          workflowSource(config, task.checkout);
          continue;
        }
        const checkout = join(config.root, `issue-${task.number}`);
        if (existsSync(checkout))
          throw new Error('Checkout occupied or unknown; preserve existing owner');
        const key = createHash('sha256')
          .update(`${config.file}:${epic.repository}:${task.number}`)
          .digest('hex');
        execFileSync(
          'git',
          ['worktree', 'add', '-b', `codex/task-${key.slice(0, 16)}`, checkout, config.base],
          { cwd: config.project },
        );
        workflowSource(config, checkout);
        task.checkout = checkout;
        run.ownedCheckouts![task.number] = checkout;
        owned.set(task.number, checkout);
        save(file, run);
      }
      // A stage result unlocks scheduling only after its code is present locally.
      for (const task of ownedReady) {
        for (const number of task.blockedBy) {
          const prerequisite = run.tasks.find((t) => t.number === number)!;
          if (!prerequisite.checkout) throw new Error('Missing prerequisite checkout evidence');
          const git = (cwd: string, args: string[]) =>
            execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
          if (git(prerequisite.checkout, ['status', '--porcelain']))
            throw new Error('Prerequisite must commit its delivery before dependent dispatch');
          const head = git(prerequisite.checkout, ['rev-parse', 'HEAD']);
          git(task.checkout!, [
            '-c',
            'user.name=paper-craft',
            '-c',
            'user.email=pc@localhost',
            'merge',
            '--no-edit',
            head,
          ]);
        }
      }
      const results = await Promise.allSettled(
        ownedReady.map(async (t) => {
          t.result = await turn(
            'worker',
            `Read project AGENTS.md at ${join(config.project, 'AGENTS.md')} first and applicable lower directory guidance.\nRepository ${epic.repository}, EPIC #${epic.number}, Issue #${t.number}.\nScope: ${t.body}\n${t.brief}\nReturn JSON {"status":"completed","repository":"${epic.repository}","issue":${t.number},"evidence":"implementation and tests"} only on success; otherwise status changes_needed. Stop after this stage.`,
            t.checkout,
            t.number,
          );
          save(file, run);
        }),
      );
      if (results.some((r) => r.status === 'rejected'))
        throw new Error(
          'Worker stage failed; retained attempts and checkout ownership require reconciliation',
        );
      await turn(
        'orchestrator',
        `EPIC ${epic.repository}#${epic.number} attributed Worker results: ${JSON.stringify(ready)}. Record results for professional EPIC evaluation. Reply with coordination feedback; do not dispatch duplicate work.`,
      );
      plan(
        await turn(
          'epic',
          `Evaluate delivered results and update professional readiness: ${JSON.stringify(run.tasks)}\nOriginal objective: ${epic.body}\n${schema}`,
        ),
      );
    }
    throw new Error('EPIC planning round limit reached');
  } catch (error) {
    run.status = 'blocked';
    run.error = error instanceof Error ? error.message : String(error);
    save(file, run);
    throw error;
  } finally {
    rmSync(lock, { recursive: true });
  }
}
