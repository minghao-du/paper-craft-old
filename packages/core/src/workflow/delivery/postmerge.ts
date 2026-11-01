import {
  orchestratorForSubject,
  inspectRuns,
  updateRunRegistry,
  dispatchStage,
  publishStageReceipt,
  acceptStageReceipt,
  releaseRunCheckout,
} from '../run/run-driver.js';
import { claimDriver } from '../run/driver-lock.js';
/** Durable post-merge assessment, preservation and resource release. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDirectory, preserveState } from '../handoff.js';
import { workflowSource, type FleetConfig } from '../fleet/fleet-config.js';
import { inspectIssueRun, type RoundRunner, type IssueTurn } from './issue-driver.js';
import { drivePullRequest, type PrDelivery, type PullRequestProvider } from './pr-driver.js';
/** External completion facts; absence of stop evidence preserves ownership. */
export interface CompletionProvider {
  merged(pr: number): Promise<boolean>;
  close(issue: number): Promise<void>;
}
/** Runner must verify termination before checkout release. */
export interface CompletionRunner extends RoundRunner {
  stopped?(turn: IssueTurn): Promise<boolean>;
}
/** Each completed side effect is retained for safe continuation. */
export interface CompletionRun {
  status: 'running' | 'done' | 'blocked';
  turns: IssueTurn[];
  runId?: string;
  dispatches?: string[];
  ownershipReleased?: boolean;
  recorded?: boolean;
  closed?: boolean;
  archive?: string;
  released?: boolean;
  releasePrepared?: boolean;
  error?: string;
}
/** Continue merged delivery without repeating completed record/close stages. */
export async function finishDelivery(
  config: FleetConfig,
  runner: CompletionRunner,
  github: CompletionProvider,
  delivery: PrDelivery,
  pr: number,
  prior: IssueTurn[],
): Promise<CompletionRun> {
  const key = createHash('sha256')
    .update(`${config.file}:${delivery.repository}:${delivery.issue}`)
    .digest('hex');
  const home = stateDirectory(config, '.runtime', 'completion', key);
  const file = join(home, 'completion.json');
  const orchestrator = orchestratorForSubject(config, delivery.repository, delivery.issue);
  const save = () => {
    const tmp = file + randomUUID();
    writeFileSync(tmp, JSON.stringify(run, null, 2));
    renameSync(tmp, file);
    if (run.runId)
      updateRunRegistry(config, (registry) => {
        registry.deliveries ??= [];
        const entry = {
          runId: run.runId!,
          repository: delivery.repository,
          issue: delivery.issue,
          pr,
          status: run.status,
          recorded: run.recorded,
          archive: run.archive,
          released: run.released,
          evidence: file,
          dispatches: run.dispatches ?? [],
        };
        const old = registry.deliveries.findIndex(
          (d) => d.runId === run.runId && d.issue === delivery.issue,
        );
        if (old < 0) registry.deliveries.push(entry);
        else registry.deliveries[old] = entry;
      });
  };
  const lock = join(home, 'driver.lock');
  claimDriver(lock);
  const run: CompletionRun = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { status: 'running', turns: [], runId: orchestrator?.run };
  const turn = async (role: IssueTurn['role'], brief: string) => {
    let attempt = run.turns.find((t) => t.role === role);
    if (
      attempt?.status === 'starting' &&
      run.runId &&
      !inspectRuns(config).dispatches?.some(
        (d) =>
          d.runId === run.runId &&
          d.stage === (role === 'worker' ? 'final-records' : 'preservation-cleanup'),
      )
    ) {
      run.turns = run.turns.filter((t) => t !== attempt);
      attempt = undefined;
      save();
    }
    if (!attempt) {
      const id = randomUUID(),
        directory = stateDirectory(config, '.runtime', 'completion', key, id);
      attempt = {
        id,
        directory,
        role,
        brief,
        checkout: role === 'worker' ? delivery.checkout : config.project,
        fleet: createHash('sha256').update(config.file).digest('hex'),
        runner: runner.name,
        status: 'starting',
        created: new Date().toISOString(),
      };
      writeFileSync(join(directory, 'brief.md'), brief);
      run.turns.push(attempt);
      save();
      let receipt;
      if (run.runId && orchestrator && role !== 'orchestrator') {
        const dispatch = await dispatchStage(config, runner, {
          runId: run.runId,
          authority: orchestrator.id,
          subject: `${delivery.repository}#${delivery.issue}`,
          role,
          stage: role === 'worker' ? 'final-records' : 'preservation-cleanup',
          inputRevision: `merged-pr-${pr}`,
          brief,
          prerequisites: role === 'landing' ? [run.dispatches![0]] : [],
          checkout: delivery.checkout,
        });
        run.dispatches ??= [];
        if (!run.dispatches.includes(dispatch.id)) run.dispatches.push(dispatch.id);
        Object.assign(attempt, dispatch.attempts.at(-1));
        receipt = dispatch.attempts.at(-1)!;
        save();
      } else receipt = await runner.start(attempt);
      if (!receipt.conversation || !receipt.address || !receipt.evidence)
        throw new Error('Missing completion Runner receipt');
      Object.assign(attempt, receipt, { status: 'running' });
      save();
    }
    if (attempt.result === undefined) {
      if (attempt.status !== 'running')
        throw new Error('Reconcile original completion attempt before retry');
      attempt.result = await runner.collect(attempt);
      save();
    }
    return attempt.result;
  };
  const accept = async (role: IssueTurn['role'], evidence: string) => {
    if (!run.runId || !orchestrator) return;
    const dispatch = inspectRuns(config).dispatches?.find(
      (d) => run.dispatches?.includes(d.id) && d.role === role,
    );
    if (!dispatch || dispatch.lifecycle === 'accepted') return;
    const path = join(home, randomUUID() + '.evidence');
    writeFileSync(path, evidence, { flag: 'wx', mode: 0o400 });
    const claim = publishStageReceipt(config, {
      dispatchId: dispatch.id,
      attemptId: dispatch.attempts.at(-1)!.id,
      runId: run.runId,
      subject: dispatch.subject,
      role: dispatch.role,
      stage: dispatch.stage,
      provider: dispatch.provider,
      inputRevision: dispatch.inputRevision,
      outcome: 'completed',
      evidence: [{ path, hash: createHash('sha256').update(evidence).digest('hex') }],
    });
    await acceptStageReceipt(
      config,
      orchestrator.id,
      claim.id,
      async () => ({
        currentRevision: dispatch.inputRevision,
        ownership:
          run.ownershipReleased === true ||
          inspectRuns(config).resources?.some(
            (r) => r.runId === run.runId && r.path === delivery.checkout,
          ) === true,
        evidence: 'Verified merge, final records and execution termination',
      }),
      runner,
    );
  };
  try {
    if (run.status === 'done') return run;
    if (!(await github.merged(pr)))
      throw new Error('Expected verified merged PR before final records');
    if (!existsSync(delivery.checkout) && run.releasePrepared && run.archive) {
      execFileSync('git', ['bundle', 'verify', join(run.archive, 'repository.bundle')], {
        cwd: config.project,
        stdio: 'pipe',
      });
      const registered = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: config.project,
        encoding: 'utf8',
      });
      if (registered.split('\n').includes(`worktree ${delivery.checkout}`))
        throw new Error('Checkout missing but still registered; inspect preservation');
      run.released = true;
      if (run.runId) {
        updateRunRegistry(config, (registry) => {
          registry.resources = registry.resources?.filter(
            (r) => !(r.runId === run.runId && r.path === delivery.checkout),
          );
        });
        run.ownershipReleased = true;
      }
      save();
    }
    if (!run.released) workflowSource(config, delivery.checkout);
    if (delivery.checkout === config.project || !config.worktrees)
      throw new Error('Automatic cleanup requires an owned local worktree');
    if (!run.recorded) {
      const result = JSON.parse(
        await turn(
          'worker',
          `Read AGENTS.md and applicable guidance. PR ${delivery.repository}#${pr} merged for Issue #${delivery.issue}. Assess actual delivery; return JSON {"complete":true,"assessment":"evidence","worklog":"final work record","followups":[],"releaseEvidence":"execution release evidence"}. Report incomplete work honestly. Do not clean checkout.`,
        ),
      );
      if (
        result.complete !== true ||
        typeof result.assessment !== 'string' ||
        !result.assessment.trim() ||
        typeof result.worklog !== 'string' ||
        !result.worklog.trim() ||
        (run.runId &&
          (!Array.isArray(result.followups) ||
            typeof result.releaseEvidence !== 'string' ||
            !result.releaseEvidence.trim()))
      )
        throw new Error('Worker final records incomplete');
      writeFileSync(
        join(delivery.checkout, '.epic-status.json'),
        JSON.stringify({
          issue: delivery.issue,
          pr,
          repository: delivery.repository,
          assessment: result.assessment,
          followups: result.followups,
          releaseEvidence: result.releaseEvidence,
        }),
      );
      writeFileSync(join(delivery.checkout, '.epic-worklog.md'), result.worklog);
      run.recorded = true;
      save();
    }
    for (const a of [...prior, ...run.turns.filter((t) => t.role === 'worker')])
      if (!runner.stopped || !(await runner.stopped(a)))
        throw new Error('Unverified execution occupancy; retain checkout');
    if (!run.released)
      await accept(
        'worker',
        JSON.stringify({
          assessment: readFileSync(join(delivery.checkout, '.epic-status.json'), 'utf8'),
          worklog: readFileSync(join(delivery.checkout, '.epic-worklog.md'), 'utf8'),
        }),
      );
    await turn(
      'landing',
      `Read final records for ${delivery.repository} Issue #${delivery.issue}. Verify delivery is ready for preservation and cleanup; return evidence. Do not remove files; the workflow verifies archives and execution occupancy.`,
    );
    for (const a of [...prior, ...run.turns])
      if (!runner.stopped || !(await runner.stopped(a)))
        throw new Error('Unverified execution occupancy; retain checkout');
    if (!run.archive) {
      run.archive = preserveState(config, delivery.checkout, 'merged delivery final records').path;
      save();
    }
    if (!run.released) {
      const dirty = execFileSync(
        'git',
        ['status', '--porcelain', '--untracked-files=all', '--ignored'],
        { cwd: delivery.checkout, encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean);
      if (
        dirty.some(
          (line) =>
            ![
              '.epic-status.json',
              '.epic-worklog.md',
              ...(run.runId ? ['.pc-execution-owner'] : []),
            ].includes(line.slice(3)),
        )
      )
        throw new Error('Unaccounted checkout files; preserve before cleanup');
      const bundle = join(run.archive, 'repository.bundle');
      if (!existsSync(bundle))
        execFileSync('git', ['bundle', 'create', bundle, '--all'], { cwd: delivery.checkout });
      execFileSync('git', ['bundle', 'verify', bundle], { cwd: delivery.checkout, stdio: 'pipe' });
      run.releasePrepared = true;
      save();
      const remove = () => {
        execFileSync('git', ['worktree', 'remove', '--force', delivery.checkout], {
          cwd: config.project,
        });
      };
      if (run.runId && !run.ownershipReleased) {
        await releaseRunCheckout(
          config,
          run.runId,
          delivery.checkout,
          async (a) => !!runner.stopped && (await runner.stopped(a)),
          remove,
        );
        run.ownershipReleased = true;
      } else remove();
      run.released = true;
      save();
    }
    await accept('landing', JSON.stringify({ archive: run.archive, released: run.released }));
    if (!run.closed) {
      await github.close(delivery.issue);
      run.closed = true;
      save();
    }
    await turn(
      'orchestrator',
      `Completion ${delivery.repository} Issue #${delivery.issue}, PR #${pr}: Worker records complete, Issue closed, archive ${run.archive}, checkout released. Report final result.`,
    );
    run.status = 'done';
    if (run.runId)
      updateRunRegistry(config, (registry) => {
        const owner = registry.runs.find((r) => r.id === run.runId)!;
        if (owner.subject.kind === 'issue') owner.lifecycle = 'completed';
      });
    delete run.error;
    save();
    return run;
  } catch (error) {
    run.status = 'blocked';
    run.error = String(error);
    save();
    throw error;
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/** Automatically finish delivery after the live PR loop verifies merge. */
export async function landDelivery(
  config: FleetConfig,
  runner: CompletionRunner,
  github: PullRequestProvider & CompletionProvider,
  delivery: PrDelivery,
  prior: IssueTurn[] = [],
) {
  const key = createHash('sha256')
    .update(`${config.file}:${delivery.repository}:${delivery.issue}`)
    .digest('hex');
  const completed = join(stateDirectory(config, '.runtime', 'completion', key), 'completion.json');
  if (existsSync(completed)) {
    const record: CompletionRun = JSON.parse(readFileSync(completed, 'utf8'));
    if (record.status === 'done') return record;
  }
  const prFile = join(stateDirectory(config, '.runtime', 'pull-requests', key), 'pr.json');
  const retained = existsSync(prFile) ? JSON.parse(readFileSync(prFile, 'utf8')) : undefined;
  const merged =
    retained?.status === 'merged'
      ? retained
      : await drivePullRequest(config, runner, github, delivery);
  return finishDelivery(config, runner, github, delivery, merged.pr, [
    ...prior,
    ...(inspectIssueRun(config, delivery.repository, delivery.issue)?.turns ?? []),
    ...merged.turns,
  ]);
}
