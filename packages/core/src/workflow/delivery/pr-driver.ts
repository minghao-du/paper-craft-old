import {
  orchestratorForSubject,
  dispatchStage,
  publishStageReceipt,
  acceptStageReceipt,
  updateRunRegistry,
  inspectRuns,
} from './run-driver.js';
import { claimDriver } from './driver-lock.js';
/** Current-head PR quality, repair and automatic landing workflow. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDirectory } from './handoff.js';
import { workflowSource, type FleetConfig } from './fleet-config.js';
import type { RoundRunner, IssueTurn } from './issue-driver.js';
/** Repository-scoped delivery; EPIC professional evidence is bound to its head. */
export interface PrDelivery {
  repository: string;
  issue: number;
  checkout: string;
  epic?: number;
  confirmation?: { epic: number; head: string; evidence: string };
  /** Re-evaluate professional approval whenever the live head changes. */
  confirmHead?: (head: string) => Promise<{ epic: number; head: string; evidence: string }>;
}
/** Live provider evidence and compare-and-merge operation. */
export interface PullRequestProvider {
  ensure(delivery: PrDelivery): Promise<number>;
  read(pr: number): Promise<{
    head: string;
    state: string;
    conflict: boolean;
    mergeCommit?: string;
    repository?: string;
    issues?: number[];
  }>;
  checks(pr: number): Promise<'passed' | 'failed' | 'pending'>;
  merge(pr: number, head: string): Promise<void>;
}
/** Durable gate results and execution receipts survive failed collection. */
export interface PrRun {
  pr: number;
  status: 'running' | 'merged' | 'blocked';
  turns: IssueTurn[];
  checkedHead?: string;
  mergeCommit?: string;
  runId?: string;
  dispatches?: string[];
  error?: string;
}
function save(file: string, value: PrRun) {
  const temp = file + '.' + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}
/** Drive repair and Landing automatically; only live evidence authorizes merge. */
export async function drivePullRequest(
  config: FleetConfig,
  runner: RoundRunner,
  github: PullRequestProvider,
  delivery: PrDelivery,
): Promise<PrRun> {
  workflowSource(config, delivery.checkout);
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(delivery.repository) ||
    !Number.isSafeInteger(delivery.issue) ||
    delivery.issue < 1
  )
    throw new Error('Expected repository and positive Issue identity');
  const owner = orchestratorForSubject(config, delivery.repository, delivery.issue);
  if (owner.runner !== runner.name) throw new Error('Run provider mismatch');
  await runner.preflight();
  const key = createHash('sha256')
    .update(`${config.file}:${delivery.repository}:${delivery.issue}`)
    .digest('hex');
  const home = stateDirectory(config, '.runtime', 'pull-requests', key);
  mkdirSync(home, { recursive: true });
  const file = join(home, 'pr.json'),
    lock = join(home, 'driver.lock');
  claimDriver(lock);
  let run: PrRun | undefined;
  try {
    run = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { pr: await github.ensure(delivery), status: 'running', turns: [] };
    const state = run!;
    const orchestrator = orchestratorForSubject(config, delivery.repository, delivery.issue);
    if (orchestrator?.run) state.runId = orchestrator.run;
    const record = () => {
      save(file, state);
      if (state.runId)
        updateRunRegistry(config, (registry) => {
          registry.pullRequests ??= [];
          const entry = {
            runId: state.runId!,
            repository: delivery.repository,
            issue: delivery.issue,
            pr: state.pr,
            evidence: file,
            status: state.status,
            checkedHead: state.checkedHead,
            mergeCommit: state.mergeCommit,
            dispatches: state.dispatches ?? [],
            error: state.error,
          };
          const old = registry.pullRequests.findIndex(
            (p) => p.runId === state.runId && p.pr === state.pr,
          );
          if (old < 0) registry.pullRequests.push(entry);
          else registry.pullRequests[old] = entry;
        });
    };
    save(file, state);
    let repair = false;
    let repairEvidence = '';
    for (let round = 0; round < 12; round++) {
      const live = await github.read(state.pr);
      if (
        (live.repository && live.repository !== delivery.repository) ||
        (live.issues && !live.issues.includes(delivery.issue))
      )
        throw new Error('PR repository or Issue attribution mismatch');
      if (live.state === 'MERGED') {
        const graph = inspectRuns(config);
        const pending = graph.dispatches
          ?.filter(
            (d) =>
              d.runId === orchestrator?.run &&
              d.subject === `${delivery.repository}#${delivery.issue}` &&
              d.stage === 'pr-merge' &&
              d.lifecycle !== 'superseded',
          )
          .at(-1);
        if (pending && pending.lifecycle !== 'accepted') {
          if (pending.inputRevision !== live.head || !live.mergeCommit)
            throw new Error('Merged version does not match reserved merge Dispatch');
          let receipt = graph.receipts?.find(
            (r) => r.dispatchId === pending.id && r.outcome === 'completed',
          );
          if (!receipt) {
            const path = join(
              pending.attempts[0].directory,
              'reconciled-merge-' + randomUUID() + '.json',
            );
            const body = JSON.stringify(live);
            writeFileSync(path, body, { flag: 'wx', mode: 0o400 });
            receipt = publishStageReceipt(config, {
              dispatchId: pending.id,
              attemptId: pending.attempts.at(-1)!.id,
              runId: pending.runId,
              subject: pending.subject,
              role: pending.role,
              stage: pending.stage,
              provider: pending.provider,
              inputRevision: pending.inputRevision,
              outcome: 'completed',
              evidence: [{ path, hash: createHash('sha256').update(body).digest('hex') }],
            });
          }
          await acceptStageReceipt(config, pending.authority, receipt.id, async () => ({
            currentRevision: live.head,
            ownership: true,
            evidence: 'Reconciled actual GitHub merge at reserved head and merge commit',
          }));
        }
        state.mergeCommit = live.mergeCommit;
        state.status = 'merged';
        record();
        return state;
      }
      if (live.state !== 'OPEN') throw new Error('Expected open PR');
      const checks = await github.checks(state.pr);
      if (checks === 'pending') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      const failed = repair || checks === 'failed' || live.conflict;
      repair = false;
      if (
        !failed &&
        delivery.epic &&
        delivery.confirmHead &&
        delivery.confirmation?.head !== live.head
      )
        delivery.confirmation = await delivery.confirmHead(live.head);
      if (
        !failed &&
        delivery.epic &&
        !(
          delivery.confirmation?.epic === delivery.epic &&
          delivery.confirmation.head === live.head &&
          delivery.confirmation.evidence.trim()
        )
      )
        throw new Error('Missing current-head EPIC professional confirmation');
      const role = failed ? 'worker' : 'landing';
      let previous = state.turns.at(-1);
      if (
        previous?.status === 'starting' &&
        orchestrator?.run &&
        !inspectRuns(config).dispatches?.some(
          (d) =>
            d.runId === orchestrator.run &&
            d.brief === previous!.brief &&
            d.role === previous!.role,
        )
      ) {
        state.turns.pop();
        previous = state.turns.at(-1);
        save(file, state);
      }
      if (previous && previous.result === undefined) {
        if (!previous.conversation || previous.status !== 'running')
          throw new Error('Missing original receipt; preserve unknown occupancy');
        previous.result = await runner.collect(previous);
        save(file, state);
      }
      const id = randomUUID(),
        directory = stateDirectory(config, '.runtime', 'pull-requests', key, id);
      mkdirSync(directory, { recursive: true });
      const turn: IssueTurn = {
        id,
        fleet: createHash('sha256').update(config.file).digest('hex'),
        role,
        runner: runner.name,
        status: 'starting',
        created: new Date().toISOString(),
        directory,
        checkout: delivery.checkout,
        brief: `Read project AGENTS.md and applicable checkout guidance. ${delivery.repository} Issue #${delivery.issue}, PR #${state.pr}, head ${live.head}. ${failed ? `Repair failed checks, conflicts or a stale base; fetch and integrate the latest base, push fixes and return evidence. ${repairEvidence}` : 'Run pc-pr-check and pc-pr-review quality gates at this head; return JSON {"passed":true,"head":"' + live.head + '","evidence":"quality outcomes"} only if all applicable gates pass. Do not merge; the driver performs compare-and-merge.'}`,
      };
      const retained =
        previous?.role === role && previous.brief === turn.brief ? previous : undefined;
      if (retained) {
        Object.assign(turn, retained);
      }
      writeFileSync(join(directory, 'brief.md'), turn.brief);
      if (!retained) state.turns.push(turn);
      save(file, state);
      let dispatch: Awaited<ReturnType<typeof dispatchStage>> | undefined;
      if (orchestrator?.run) {
        dispatch = await dispatchStage(config, runner, {
          runId: orchestrator.run,
          authority: orchestrator.id,
          subject: `${delivery.repository}#${delivery.issue}`,
          role,
          stage: failed ? 'pr-repair' : 'pr-quality',
          inputRevision: live.head,
          brief: turn.brief,
          prerequisites: [],
          checkout: delivery.checkout,
        });
        state.dispatches ??= [];
        if (!state.dispatches.includes(dispatch.id)) state.dispatches.push(dispatch.id);
        Object.assign(turn, dispatch.attempts.at(-1));
        record();
      }
      const receipt = dispatch
        ? dispatch.attempts.at(-1)!
        : (retained ?? (await runner.start(turn)));
      if (!receipt.conversation || !receipt.address || !receipt.evidence)
        throw new Error('Missing execution receipt');
      Object.assign(turn, receipt, { status: 'running' });
      save(file, state);
      turn.result = turn.result ?? (await runner.collect(turn));
      save(file, state);
      if (failed) {
        if (dispatch)
          updateRunRegistry(config, (registry) => {
            registry.dispatches!.find((d) => d.id === dispatch!.id)!.lifecycle = 'rejected';
          });
        continue;
      }
      const gate = JSON.parse(turn.result);
      if (
        gate.passed !== true ||
        gate.head !== live.head ||
        typeof gate.evidence !== 'string' ||
        !gate.evidence.trim()
      ) {
        if (dispatch)
          updateRunRegistry(config, (registry) => {
            registry.dispatches!.find((d) => d.id === dispatch!.id)!.lifecycle = 'rejected';
          });
        repair = true;
        continue;
      }
      const fresh = await github.read(state.pr);
      if (fresh.head !== live.head || fresh.conflict) {
        if (dispatch)
          updateRunRegistry(config, (registry) => {
            registry.dispatches!.find((d) => d.id === dispatch!.id)!.lifecycle = 'rejected';
          });
        continue;
      }
      if ((await github.checks(state.pr)) !== 'passed') continue;
      if (dispatch) {
        const evidencePath = join(
          dispatch.attempts[0].directory,
          'quality-result-' + randomUUID() + '.json',
        );
        writeFileSync(evidencePath, turn.result, { flag: 'wx', mode: 0o400 });
        const claim = publishStageReceipt(config, {
          dispatchId: dispatch.id,
          attemptId: turn.id,
          runId: dispatch.runId,
          subject: dispatch.subject,
          role: dispatch.role,
          stage: dispatch.stage,
          provider: dispatch.provider,
          inputRevision: live.head,
          outcome: 'completed',
          evidence: [
            { path: evidencePath, hash: createHash('sha256').update(turn.result).digest('hex') },
          ],
        });
        await acceptStageReceipt(config, dispatch.authority, claim.id, async () => ({
          currentRevision: (await github.read(state.pr)).head,
          ownership:
            inspectRuns(config).resources?.some(
              (resource) =>
                resource.runId === dispatch!.runId &&
                resource.path === dispatch!.attempts[0].checkout,
            ) === true,
          evidence: 'Live PR head and exclusive reserved checkout',
        }));
      }
      const mergeDispatch = dispatch
        ? await dispatchStage(config, runner, {
            runId: dispatch.runId,
            authority: dispatch.authority,
            subject: dispatch.subject,
            role: 'landing',
            stage: 'pr-merge',
            inputRevision: live.head,
            brief: `Verify accepted PR quality for head ${live.head}; authorize compare-and-merge by the driver. Return verification evidence.`,
            prerequisites: [dispatch.id],
            checkout: delivery.checkout,
          })
        : undefined;
      if (mergeDispatch) await runner.collect(mergeDispatch.attempts.at(-1)!);
      state.checkedHead = live.head;
      save(file, state);
      try {
        await github.merge(state.pr, live.head);
      } catch (error) {
        const changed = await github.read(state.pr);
        if (changed.state !== 'MERGED') {
          if (mergeDispatch)
            updateRunRegistry(config, (registry) => {
              registry.dispatches!.find((d) => d.id === mergeDispatch.id)!.lifecycle = 'rejected';
            });
          if (changed.head !== live.head) continue;
          repair = true;
          repairEvidence = String(error);
          continue;
        }
      }
      const merged = await github.read(state.pr);
      if (merged.state !== 'MERGED') throw new Error('Merge not verified');
      if (mergeDispatch) {
        const path = join(mergeDispatch.attempts[0].directory, 'verified-merge.json');
        const body = JSON.stringify(merged);
        writeFileSync(path, body, { flag: 'wx', mode: 0o400 });
        const claim = publishStageReceipt(config, {
          dispatchId: mergeDispatch.id,
          attemptId: mergeDispatch.attempts[0].id,
          runId: mergeDispatch.runId,
          subject: mergeDispatch.subject,
          role: 'landing',
          stage: 'pr-merge',
          provider: mergeDispatch.provider,
          inputRevision: live.head,
          outcome: 'completed',
          evidence: [{ path, hash: createHash('sha256').update(body).digest('hex') }],
        });
        await acceptStageReceipt(config, mergeDispatch.authority, claim.id, async () => ({
          currentRevision: live.head,
          ownership: true,
          evidence: 'Verified actual GitHub merge',
        }));
      }
      state.status = 'merged';
      state.mergeCommit = merged.mergeCommit;
      record();
      return state;
    }
    throw new Error('Repair loop limit reached; preserve checkout and evidence');
  } catch (error) {
    if (run) {
      run.status = 'blocked';
      run.error = error instanceof Error ? error.message : String(error);
      save(file, run);
      if (run.runId)
        updateRunRegistry(config, (registry) => {
          const pr = registry.pullRequests?.find((p) => p.runId === run!.runId && p.pr === run!.pr);
          if (pr) {
            pr.status = 'blocked';
            pr.error = run!.error;
          }
        });
    }
    throw error;
  } finally {
    rmSync(lock, { recursive: true });
  }
}
/** GitHub CLI adapter; checks and atomic expected-head merge remain provider operations. */
export class GitHubPullRequests implements PullRequestProvider {
  constructor(
    private readonly checkout: string,
    private readonly repository: string,
  ) {}
  private gh(args: string[]): string {
    return execFileSync('gh', args, { cwd: this.checkout, encoding: 'utf8' }).trim();
  }
  /** Reuse a branch PR, or create one from delivered commits. */
  async ensure(): Promise<number> {
    const prs = JSON.parse(
      this.gh([
        'pr',
        'list',
        '--repo',
        this.repository,
        '--head',
        execFileSync('git', ['branch', '--show-current'], {
          cwd: this.checkout,
          encoding: 'utf8',
        }).trim(),
        '--json',
        'number',
      ]),
    );
    if (prs.length) return prs[0].number;
    execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: this.checkout });
    this.gh(['pr', 'create', '--repo', this.repository, '--fill']);
    return JSON.parse(this.gh(['pr', 'view', '--json', 'number'])).number;
  }
  /** Read the live head and merge status again at each decision. */
  async read(pr: number) {
    const p = JSON.parse(
      this.gh([
        'pr',
        'view',
        String(pr),
        '--repo',
        this.repository,
        '--json',
        'headRefOid,state,mergeable,mergeCommit,closingIssuesReferences',
      ]),
    );
    return {
      head: p.headRefOid,
      state: p.state,
      conflict: p.mergeable !== 'MERGEABLE',
      mergeCommit: p.mergeCommit?.oid,
      repository: this.repository,
      issues: p.closingIssuesReferences.map((i: { number: number }) => i.number),
    };
  }
  /** Verify merge state before post-merge side effects. */
  async merged(pr: number): Promise<boolean> {
    return (await this.read(pr)).state === 'MERGED';
  }
  /** GitHub close is idempotent; verify actual state after the request. */
  async close(issue: number): Promise<void> {
    const args = ['issue', 'view', String(issue), '--repo', this.repository, '--json', 'state'];
    if (JSON.parse(this.gh(args)).state !== 'CLOSED')
      this.gh(['issue', 'close', String(issue), '--repo', this.repository]);
    if (JSON.parse(this.gh(args)).state !== 'CLOSED') throw new Error('Issue closure not verified');
  }
  /** Required check results only; no required checks is permitted. */
  async checks(pr: number): Promise<'passed' | 'failed' | 'pending'> {
    let raw: string;
    try {
      raw = this.gh([
        'pr',
        'checks',
        String(pr),
        '--repo',
        this.repository,
        '--required',
        '--json',
        'bucket',
      ]);
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? '');
      if (/no (required )?checks reported/i.test(stderr)) return 'passed';
      const stdout = (error as { stdout?: string }).stdout;
      if (!stdout) throw error;
      raw = stdout;
    }
    const checks = JSON.parse(raw) as { bucket: string }[];
    return checks.some((c) => ['fail', 'cancel'].includes(c.bucket))
      ? 'failed'
      : checks.some((c) => c.bucket !== 'pass' && c.bucket !== 'skipping')
        ? 'pending'
        : 'passed';
  }
  /** GitHub rejects a moved head instead of merging unchecked commits. */
  async merge(pr: number, head: string) {
    if (
      execFileSync('git', ['status', '--porcelain'], {
        cwd: this.checkout,
        encoding: 'utf8',
      }).trim()
    )
      throw new Error('Worker must account for dirty checkout before merge');
    if (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.checkout,
        encoding: 'utf8',
      }).trim() !== head
    )
      throw new Error('Local HEAD differs from evaluated PR head');
    const base = JSON.parse(
      this.gh(['pr', 'view', String(pr), '--repo', this.repository, '--json', 'baseRefName']),
    ).baseRefName;
    execFileSync('git', ['fetch', 'origin', base], { cwd: this.checkout });
    execFileSync('git', ['merge-base', '--is-ancestor', `origin/${base}`, head], {
      cwd: this.checkout,
    });
    this.gh([
      'pr',
      'merge',
      String(pr),
      '--repo',
      this.repository,
      '--squash',
      '--match-head-commit',
      head,
    ]);
  }
}
