/** Authoritative delivery effects for a single Orchestrator-selected assignment. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preserveState } from '@paper-craft/core/workflow/handoff';
import {
  inspectRuns,
  updateRunRegistry,
  releaseRunCheckout,
  type StageDispatch,
} from '@paper-craft/core/workflow/run-driver';
import type { FleetConfig } from '@paper-craft/core/workflow/fleet-config';
import { GitHubPullRequests, type PullRequestProvider } from '@paper-craft/core/workflow/pr-driver';
import type { RunnerAdapter } from '@paper-craft/core/workflow/runtime';

/** Boundary for isolated external PR facts; production always reads GitHub. */
export type StagePullRequests = (
  config: FleetConfig,
  dispatch: StageDispatch,
) => PullRequestProvider;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
/** Use the assignment's repository, never an alternate caller-supplied repository. */
export const stagePullRequests: StagePullRequests = (config, dispatch) =>
  new GitHubPullRequests(
    existsSync(dispatch.attempts.at(-1)!.checkout)
      ? dispatch.attempts.at(-1)!.checkout
      : config.project,
    dispatch.subject.split('#')[0],
  );

/** Compare-and-merge or preserve-and-release only the explicitly selected stage. */
export async function executeDeliveryStage(
  config: FleetConfig,
  dispatch: StageDispatch,
  runner: RunnerAdapter,
  pr: number,
  provider: PullRequestProvider,
) {
  const checkout = dispatch.attempts.at(-1)!.checkout;
  const registry = inspectRuns(config);
  if (
    !registry.receipts?.some(
      (r) => r.dispatchId === dispatch.id && r.attemptId === dispatch.attempts.at(-1)!.id,
    )
  )
    throw new Error('Collect the selected stage result before executing effects');
  const accepted = (stage: string) =>
    registry.dispatches?.some(
      (d) =>
        d.runId === dispatch.runId &&
        d.subject === dispatch.subject &&
        d.stage === stage &&
        d.lifecycle === 'accepted',
    );
  if (dispatch.stage === 'pr-merge') {
    if (!accepted('pr-quality')) throw new Error('Expected accepted PR quality');
    const live = await provider.read(pr);
    if (
      live.head !== dispatch.inputRevision ||
      git(checkout, 'rev-parse', 'HEAD') !== live.head ||
      live.conflict ||
      (await provider.checks(pr)) !== 'passed'
    )
      throw new Error('Expected current evaluated head and passing checks');
    if (live.state !== 'MERGED') await provider.merge(pr, live.head);
    const merged = await provider.read(pr);
    if (merged.state !== 'MERGED' || merged.head !== dispatch.inputRevision)
      throw new Error('Expected verified evaluated-head merge');
    return merged;
  }
  if (dispatch.stage !== 'preservation-cleanup' || !accepted('final-records'))
    throw new Error('Expected cleanup assignment after accepted final records');
  if (checkout === config.project || !config.worktrees)
    throw new Error('Cleanup requires an owned local worktree');
  if ((await provider.read(pr)).state !== 'MERGED') throw new Error('Expected verified merged PR');
  const attempts =
    registry.dispatches
      ?.filter((d) => d.runId === dispatch.runId)
      .flatMap((d) => d.attempts)
      .filter((a) => a.checkout === checkout) ?? [];
  for (const attempt of attempts)
    if (!(await runner.stopped?.(attempt)))
      throw new Error('Execution termination unverified; retain checkout');
  const dirty = git(checkout, 'status', '--porcelain', '--untracked-files=all', '--ignored')
    .split('\n')
    .filter(Boolean);
  if (
    dirty.some(
      (line) =>
        !['.epic-status.json', '.epic-worklog.md', '.pc-execution-owner'].includes(line.slice(3)),
    )
  )
    throw new Error('Unaccounted checkout files; retain checkout');
  const archive = preserveState(config, checkout, 'merged delivery final records').path;
  const bundle = join(archive, 'repository.bundle');
  if (!existsSync(bundle)) git(checkout, 'bundle', 'create', bundle, '--all');
  git(config.project, 'bundle', 'verify', bundle);
  await releaseRunCheckout(
    config,
    dispatch.runId,
    checkout,
    async (a) => !!(await runner.stopped?.(a)),
    () => {
      git(config.project, 'worktree', 'remove', '--force', checkout);
    },
  );
  const result = { archive, released: true, checkout, pr };
  const evidence = join(dispatch.attempts.at(-1)!.directory, 'cleanup.json');
  writeFileSync(evidence, JSON.stringify(result));
  updateRunRegistry(config, (registry) => {
    registry.deliveries ??= [];
    registry.deliveries.push({
      runId: dispatch.runId,
      repository: dispatch.subject.split('#')[0],
      issue: Number(dispatch.subject.split('#')[1]),
      pr,
      status: 'done',
      recorded: true,
      archive,
      released: true,
      evidence,
      dispatches: registry
        .dispatches!.filter((d) => d.runId === dispatch.runId && d.subject === dispatch.subject)
        .map((d) => d.id),
    });
  });
  return result;
}

/** Verify current external facts independently of role-reported completion. */
export async function deliveryFacts(
  config: FleetConfig,
  dispatch: StageDispatch,
  pr: number | undefined,
  provider: PullRequestProvider,
) {
  const attempt = dispatch.attempts.at(-1)!;
  if (dispatch.stage === 'preservation-cleanup') {
    const registry = inspectRuns(config);
    const delivery = registry.deliveries?.find(
      (d) =>
        d.runId === dispatch.runId &&
        d.dispatches.includes(dispatch.id) &&
        d.released &&
        d.recorded,
    );
    if (
      !delivery?.archive ||
      delivery.pr !== pr ||
      delivery.repository !== dispatch.subject.split('#')[0] ||
      delivery.issue !== Number(dispatch.subject.split('#')[1])
    )
      throw new Error('Expected retained verified delivery release');
    const result = { archive: delivery.archive, checkout: attempt.checkout };
    git(config.project, 'bundle', 'verify', join(result.archive, 'repository.bundle'));
    if (existsSync(result.checkout) || registry.resources?.some((r) => r.path === result.checkout))
      throw new Error('Cleanup resource release unverified');
    const worktrees = git(config.project, 'worktree', 'list', '--porcelain');
    if (worktrees.split('\n').includes(`worktree ${result.checkout}`))
      throw new Error('Checkout still registered');
    return {
      currentRevision: dispatch.inputRevision,
      ownership: true,
      evidence: `Verified archive ${result.archive} and released checkout`,
    };
  }
  if (dispatch.stage === 'implementation') return;
  if (!pr) throw new Error('Expected --pr for current authoritative PR facts');
  const live = await provider.read(pr);
  if (live.head !== dispatch.inputRevision)
    throw new Error('PR head changed; repeat current-head quality');
  if (
    dispatch.stage === 'pr-quality' &&
    (live.conflict || (await provider.checks(pr)) !== 'passed')
  )
    throw new Error('PR quality is not passing');
  if (['pr-merge', 'final-records'].includes(dispatch.stage) && live.state !== 'MERGED')
    throw new Error('Expected verified merged PR');
  if (dispatch.stage === 'final-records') {
    const status = JSON.parse(readFileSync(join(attempt.checkout, '.epic-status.json'), 'utf8'));
    if (
      !status.assessment ||
      !readFileSync(join(attempt.checkout, '.epic-worklog.md'), 'utf8').trim()
    )
      throw new Error('Expected attributed final assessment and worklog');
  }
}
