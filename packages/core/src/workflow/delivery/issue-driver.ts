import {
  startBusinessTurn,
  collectBusinessTurn,
  acceptValidatedBusinessTurns,
  validateImplementationResult,
} from './run-driver.js';
import { orchestratorForSubject, reserveRunCheckout, inspectRuns } from './run-driver.js';
import { claimDriver } from './driver-lock.js';
/** Durable automatic standalone Issue round trips. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDirectory } from './handoff.js';
import { workflowSource, type FleetConfig } from './fleet-config.js';
import { type RunnerAdapter, type ManagedAttempt } from './runtime.js';
/** Verified repository-scoped issue input from an issue tracker. */
export interface IssueInput {
  repository: string;
  number: number;
  title: string;
  body: string;
  parent?: number;
  /** Open tracker dependencies; undefined on a child is unresolved metadata. */
  blockedBy?: number[];
}
/** Runner completion is distinct from startup receipt. */
export interface RoundRunner extends RunnerAdapter {
  collect(attempt: ManagedAttempt): Promise<string>;
}
/** A result belongs to its persisted turn and execution attempt. */
export interface IssueTurn extends ManagedAttempt {
  /** Explicit replacement after verified termination preserves the old attempt without recollecting it. */
  retired?: boolean;
  result?: string;
}
/** Durable task, including reserved checkout and all acknowledged turns. */
export interface IssueRun {
  repository: string;
  issue: number;
  parent?: number;
  id: string;
  checkout: string;
  status: 'running' | 'done' | 'blocked';
  turns: IssueTurn[];
  error?: string;
}
function save(file: string, value: unknown) {
  const temp = file + '.' + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}
/** Read GitHub identity and parent directly; API failures remain errors. */
export function readIssue(project: string, number: number): IssueInput {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('Expected positive issue number');
  const repo = repository(project);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Expected GitHub repository owner/name');
  const data = JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `query=query { repository(owner: "${repo.split('/')[0]}", name: "${repo.split('/')[1]}") { nameWithOwner issue(number: ${number}) { number title body parent { number } } } }`,
      ],
      { cwd: project, encoding: 'utf8' },
    ),
  );
  if (data.errors || !data.data?.repository?.issue)
    throw new Error('Expected accessible GitHub issue and parent evidence');
  const r = data.data.repository;
  const dependencies = JSON.parse(
    execFileSync('gh', ['api', `repos/${repo}/issues/${number}/dependencies/blocked_by`], {
      cwd: project,
      encoding: 'utf8',
    }),
  );
  if (!Array.isArray(dependencies))
    throw new Error('Expected accessible GitHub issue dependencies');
  return {
    ...r.issue,
    repository: r.nameWithOwner,
    parent: r.issue.parent?.number,
    blockedBy: dependencies
      .filter((d: { state: string }) => d.state !== 'closed')
      .map((d: { number: number }) => d.number),
  };
}
function repository(project: string): string {
  return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    cwd: project,
    encoding: 'utf8',
  }).trim();
}
/** Inspect the durable task without dispatching or consuming notifications. */
export function inspectIssueRun(
  config: FleetConfig,
  repository: string,
  number: number,
): IssueRun | undefined {
  const key = createHash('sha256').update(`${config.file}:${repository}:${number}`).digest('hex');
  const file = join(stateDirectory(config, '.runtime', 'tasks', key), 'task.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as IssueRun) : undefined;
}
/** Run automatic Orchestrator/Worker turns; persisted receipts prevent duplicate dispatch. */
export async function driveIssue(
  config: FleetConfig,
  runner: RoundRunner,
  issue: IssueInput,
): Promise<IssueRun> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(issue.repository) ||
    !Number.isSafeInteger(issue.number) ||
    issue.number < 1
  )
    throw new Error('Expected repository owner/name and positive issue number');
  if (issue.parent && !issue.blockedBy)
    throw new Error('Child dependencies unresolved; refresh tracker metadata');
  if (issue.blockedBy?.length) throw new Error(`Unmet dependencies: ${issue.blockedBy.join(', ')}`);
  await runner.preflight();
  const orchestrator = orchestratorForSubject(config, issue.repository, issue.number);
  if (orchestrator?.run && orchestrator.runner !== runner.name)
    throw new Error('Run provider conflict');
  if (!orchestrator?.conversation || orchestrator.status !== 'running')
    throw new Error('Expected acknowledged managed Orchestrator');
  if (orchestrator.run) {
    const owner = inspectRuns(config).runs.find((r) => r.id === orchestrator.run);
    const finding =
      owner?.epicClosure &&
      owner.pipeline?.findings.find(
        (f) => f.classification === 'required_maintenance' && f.issue === issue.number,
      );
    if (
      finding?.migrationLedger &&
      (owner!.pipelineApprovals?.[issue.number]?.ledger !== finding.migrationLedger ||
        owner!.pipelineApprovals?.[issue.number]?.source !== 'human')
    )
      throw new Error('Migration Ledger approval missing before maintenance dispatch');
    if (owner?.subject.kind === 'epic' && !finding)
      throw new Error(`Child execution owned by EPIC Run ${owner.id}; inspect or resume that Run`);
  }
  // Finish its initial turn before resuming the same conversation.
  await runner.collect(orchestrator);
  const key = createHash('sha256')
    .update(`${config.file}:${issue.repository}:${issue.number}`)
    .digest('hex');
  const home = stateDirectory(config, '.runtime', 'tasks', key);
  mkdirSync(home, { recursive: true });
  const file = join(home, 'task.json');
  const lock = join(
    stateDirectory(config, '.runtime'),
    `driver-${orchestrator.run ?? orchestrator.fleet}.lock`,
  );
  try {
    claimDriver(lock);
  } catch (error) {
    throw new Error('Task driver occupied; inspect persisted task', { cause: error });
  }
  let task: IssueRun;
  try {
    if (existsSync(file)) {
      task = JSON.parse(readFileSync(file, 'utf8'));
      if (task.parent !== issue.parent)
        throw new Error(`Parent scope conflict: EPIC #${issue.parent}`);
      if (task.status === 'done') return task;
    } else {
      if (!config.worktrees)
        throw new Error('Automatic allocation requires local_worktrees and a new unowned checkout');
      const checkout = join(config.root, `issue-${issue.number}`);
      if (existsSync(checkout))
        throw new Error('Checkout already exists; occupancy must be verified before reuse');
      execFileSync(
        'git',
        ['worktree', 'add', '-b', `codex/task-${key.slice(0, 16)}`, checkout, config.base],
        { cwd: config.project },
      );
      workflowSource(config, checkout);
      task = {
        repository: issue.repository,
        issue: issue.number,
        parent: issue.parent,
        id: key,
        checkout,
        status: 'running',
        turns: [],
      };
      save(file, task);
    }
    try {
      for (let round = 0; round < 20; round++) {
        const last = task.turns.at(-1);
        if (last && !last.result) {
          if (!last.conversation || last.status !== 'running')
            throw new Error('Missing receipt: inspect original attempt before retry');
          last.result = await collectBusinessTurn(
            config,
            runner,
            last,
            last.role === 'worker'
              ? (raw) => validateImplementationResult(raw, issue.repository, issue.number)
              : undefined,
          );
          save(file, task);
        }
        const completed = task.turns.at(-1);
        let role: ManagedAttempt['role'] = 'orchestrator';
        let brief: string;
        if (completed?.role === 'orchestrator') {
          const decision = JSON.parse(completed.result!);
          if (decision.action === 'done') {
            await acceptValidatedBusinessTurns(
              config,
              task.turns,
              'Validated scoped Worker completion and Orchestrator done decision',
            );
            task.status = 'done';
            delete task.error;
            save(file, task);
            return task;
          }
          if (
            decision.action !== 'worker' ||
            typeof decision.brief !== 'string' ||
            !decision.brief.trim()
          )
            throw new Error('Expected Orchestrator action worker with brief, or done');
          role = 'worker';
          brief = `Read project AGENTS.md at ${join(config.project, 'AGENTS.md')} first and obey all applicable lower directory guidance in your checkout.\nRepository ${issue.repository}, Issue #${issue.number}.\nParent context: ${issue.parent ?? 'none'}; no siblings or parent closure authorized.\nScope: ${issue.body}\n${decision.brief}\nReturn JSON {"status":"completed","repository":"${issue.repository}","issue":${issue.number},"evidence":"implementation and tests"} only after successful scoped implementation. Otherwise return status changes_needed with evidence. Stop after this assigned stage.`;
        } else
          brief = `Coordinate Issue ${issue.repository}#${issue.number}: ${issue.title}\n${issue.body}\nParent context: ${issue.parent ?? 'none'}; no siblings or parent closure authorized.\n${completed ? `Worker result (${completed.id}): ${completed.result}` : 'Select first task.'}\nReply only JSON {"action":"worker","brief":"bounded next stage"} or {"action":"done"}. Done means stages requested here are delivered; PR merge and final cleanup are separate workflow phases.`;
        const id = randomUUID();
        const dir = stateDirectory(config, '.runtime', 'tasks', key, id);
        mkdirSync(dir, { recursive: true });
        const turn: IssueTurn = {
          id,
          fleet: orchestrator.fleet,
          role,
          runner: runner.name,
          brief,
          status: 'starting',
          created: new Date().toISOString(),
          directory: dir,
          checkout: role === 'worker' ? task.checkout : config.project,
          conversation: role === 'orchestrator' ? orchestrator.conversation : undefined,
        };
        writeFileSync(join(dir, 'brief.md'), brief);
        task.turns.push(turn);
        save(file, task);
        if (role === 'worker' && orchestrator.run)
          reserveRunCheckout(config, orchestrator.run, orchestrator.id, task.checkout);
        const receipt = await startBusinessTurn(
          config,
          runner,
          turn,
          issue.repository,
          issue.number,
        );
        if (!receipt.conversation || !receipt.address || !receipt.evidence)
          throw new Error('Expected actual Runner receipt');
        Object.assign(turn, receipt, { status: 'running' });
        save(file, task);
      }
      throw new Error('Automatic round limit reached; inspect task');
    } catch (error) {
      task.status = 'blocked';
      task.error = error instanceof Error ? error.message : String(error);
      save(file, task);
      throw error;
    }
  } finally {
    rmSync(lock, { recursive: true });
  }
}
