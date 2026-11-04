import {
  startBusinessTurn,
  collectBusinessTurn,
  acceptValidatedBusinessTurns,
} from '@paper-craft/core/workflow/run-driver';
/** Connect professional head gates and final human EPIC closure to public workflow. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { completeEpic, type EpicCloseDecision } from '@paper-craft/core/workflow/epic-completion';

import { landDelivery, finishDelivery } from '@paper-craft/core/workflow/postmerge';
import { GitHubPullRequests } from '@paper-craft/core/workflow/pr-driver';
import { stateDirectory } from '@paper-craft/core/workflow/handoff';
import type { FleetConfig } from '@paper-craft/core/workflow/fleet-config';
import type { EpicRun } from '@paper-craft/core/workflow/epic-driver';
import type { CompletionRunner } from '@paper-craft/core/workflow/postmerge';
import { driveIssue, readIssue, type IssueTurn } from '@paper-craft/core/workflow/issue-driver';
import {
  inspectRuns,
  orchestratorForSubject,
  referenceRunSubject,
  updateRunRegistry,
} from '@paper-craft/core/workflow/run-driver';
/**
 * @deprecated Legacy unmanaged EPIC completion is retired. Managed closeStageEpic in run-driver is authoritative.
 */
export async function finishEpic(
  config: FleetConfig,
  runner: CompletionRunner,
  epic: EpicRun,
  decision?: EpicCloseDecision,
  retryFinalization = false,
) {
  return completeEpic(
    config,
    runner,
    {
      maintenance: {
        async identify(finding) {
          const marker = `Pipeline maintenance EPIC #${epic.epic} finding ${finding.id}`;
          const issues = JSON.parse(
            execFileSync(
              'gh',
              [
                'issue',
                'list',
                '--repo',
                epic.repository,
                '--state',
                'all',
                '--search',
                marker,
                '--json',
                'number,body',
              ],
              { cwd: config.project, encoding: 'utf8' },
            ),
          );
          const existing = issues.filter((i: { body: string }) => i.body.includes(marker));
          if (existing.length > 1) throw new Error('Ambiguous maintenance Issue attribution');
          if (existing.length) return existing[0].number;
          const body = `${marker}\nOriginating closed EPIC: ${epic.repository}#${epic.epic}\nFinding: ${finding.description}\nEvidence: ${finding.evidence.join(', ')}\nBounded structural maintenance only. Use Worker and normal PR-Land delivery. ${finding.migrationLedger ? `Migration Ledger ${finding.migrationLedger} requires explicit approval before mutation.` : ''}`;
          const url = execFileSync(
            'gh',
            [
              'issue',
              'create',
              '--repo',
              epic.repository,
              '--title',
              `Pipeline maintenance: ${finding.id}`,
              '--body',
              body,
            ],
            { cwd: config.project, encoding: 'utf8' },
          ).trim();
          const number = Number(url.split('/').at(-1));
          if (!Number.isSafeInteger(number))
            throw new Error('Expected created maintenance Issue identity');
          return number;
        },
        async approveMigration(issue, ledger) {
          const file = join(
            stateDirectory(config, '.runtime', 'migration-approvals'),
            `${issue}.json`,
          );
          if (!existsSync(file)) return undefined;
          const approved = JSON.parse(readFileSync(file, 'utf8'));
          if (
            approved.source !== 'human' ||
            approved.ledger !== ledger ||
            !approved.evidence?.trim()
          )
            return undefined;
          updateRunRegistry(config, (registry) => {
            const owner = registry.runs.find(
              (r) => r.subject.repository === epic.repository && r.subject.number === epic.epic,
            );
            if (owner) (owner.pipelineApprovals ??= {})[issue] = approved;
          });
          return approved;
        },
        async deliver(number, finding) {
          const issue = readIssue(config.project, number);
          if (!issue.body.includes(`Pipeline maintenance EPIC #${epic.epic} finding ${finding.id}`))
            throw new Error('Maintenance Issue missing audit attribution');
          const owner = inspectRuns(config).runs.find(
            (r) =>
              r.subject.repository === epic.repository &&
              r.subject.number === epic.epic &&
              r.subject.kind === 'epic',
          );
          if (owner) referenceRunSubject(config, owner.id, `${epic.repository}#${number}`);
          const key = createHash('sha256')
            .update(`${config.file}:${epic.repository}:${number}`)
            .digest('hex');
          const priorFile = join(
            stateDirectory(config, '.runtime', 'completion', key),
            'completion.json',
          );
          const prFile = join(stateDirectory(config, '.runtime', 'pull-requests', key), 'pr.json');
          if (existsSync(priorFile) && existsSync(prFile)) {
            const prior = JSON.parse(readFileSync(priorFile, 'utf8'));
            const pr = JSON.parse(readFileSync(prFile, 'utf8')).pr;
            if (prior.status === 'done' && prior.archive) {
              const merged = await new GitHubPullRequests(config.project, epic.repository).read(pr);
              if (!merged.mergeCommit) throw new Error('Missing actual maintenance merge version');
              return { status: 'done', pr, version: merged.mergeCommit, evidence: prior.archive };
            }
          }
          const task = await driveIssue(config, runner, issue);
          if (task.status !== 'done') throw new Error('Maintenance Worker delivery pending');
          const github = new GitHubPullRequests(task.checkout, epic.repository);
          const pr = await github.ensure();
          const completion = await landDelivery(config, runner, github, {
            repository: epic.repository,
            issue: number,
            checkout: task.checkout,
          });
          const merged = await new GitHubPullRequests(config.project, epic.repository).read(pr);
          if (completion.status !== 'done' || !completion.archive || !merged.mergeCommit)
            throw new Error(
              'Maintenance requires verified merge, records, preservation and cleanup',
            );
          return { status: 'done', pr, version: merged.mergeCommit, evidence: completion.archive };
        },
      },
      async deliver(task) {
        const completionKey = createHash('sha256')
          .update(`${config.file}:${epic.repository}:${task.number}`)
          .digest('hex');
        const completed = join(
          stateDirectory(config, '.runtime', 'completion', completionKey),
          'completion.json',
        );
        if (existsSync(completed)) {
          const record = JSON.parse(readFileSync(completed, 'utf8'));
          if (record.status === 'done') return JSON.stringify(record);
          if (record.releasePrepared) {
            const prFile = join(
              stateDirectory(config, '.runtime', 'pull-requests', completionKey),
              'pr.json',
            );
            const pr = JSON.parse(readFileSync(prFile, 'utf8')).pr;
            return JSON.stringify(
              await finishDelivery(
                config,
                runner,
                new GitHubPullRequests(config.project, epic.repository),
                { repository: epic.repository, issue: task.number, checkout: task.checkout! },
                pr,
                epic.turns.filter((t) => t.checkout === task.checkout),
              ),
            );
          }
        }
        const checkout = task.checkout!,
          github = new GitHubPullRequests(checkout, epic.repository);
        const delivery = {
          repository: epic.repository,
          issue: task.number,
          checkout,
          epic: epic.epic,
        };
        const pr = await github.ensure(),
          head = (await github.read(pr)).head;
        const confirmHead = async (head: string) => {
          const id = createHash('sha256')
              .update(`${config.file}:${epic.repository}:${task.number}:${head}`)
              .digest('hex'),
            directory = stateDirectory(config, '.runtime', 'epic-gates', id);
          const brief = `Read AGENTS.md. Professionally review delivery ${epic.repository}#${task.number} PR #${pr} head ${head} against EPIC #${epic.epic} original objective ${epic.goal} and task ${task.body}. Result ${task.result}. Reply only JSON {"approved":true,"evidence":"review findings"}. Approval is professional judgment, not human EPIC closure.`;
          const persisted = join(directory, 'attempt.json');
          const fresh = !existsSync(persisted);
          const turn: IssueTurn = existsSync(persisted)
            ? JSON.parse(readFileSync(persisted, 'utf8'))
            : {
                id,
                directory,
                brief,
                role: 'epic',
                fleet: createHash('sha256').update(config.file).digest('hex'),
                runner: runner.name,
                status: 'starting',
                checkout: config.project,
                created: new Date().toISOString(),
              };
          const save = () =>
            writeFileSync(join(directory, 'attempt.json'), JSON.stringify(turn, null, 2));
          writeFileSync(join(directory, 'brief.md'), brief);
          save();
          if (fresh)
            Object.assign(
              turn,
              await startBusinessTurn(config, runner, turn, epic.repository, epic.epic),
              { status: 'running' },
            );
          save();
          if (!turn.conversation || turn.status !== 'running')
            throw new Error('Reconcile original professional gate before retry');
          turn.result = turn.result ?? (await collectBusinessTurn(config, runner, turn));
          save();
          const approval = JSON.parse(turn.result);
          if (
            approval.approved !== true ||
            typeof approval.evidence !== 'string' ||
            !approval.evidence.trim()
          )
            throw new Error('EPIC professional approval missing; retain delivery for repair');
          await acceptValidatedBusinessTurns(
            config,
            [turn],
            `Validated professional approval for ${epic.repository}#${task.number} head ${head}: ${approval.evidence}`,
            runner,
          );
          return { epic: epic.epic, head, evidence: approval.evidence };
        };
        const result = await landDelivery(
          config,
          runner,
          github,
          { ...delivery, confirmation: await confirmHead(head), confirmHead },
          epic.turns.filter((t) => t.checkout === checkout),
        );
        return JSON.stringify(result);
      },
      async finalizationContext() {
        const git = (...args: string[]) =>
          execFileSync('git', args, {
            cwd: config.project,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
        git('fetch', 'origin', config.base);
        const head = git('rev-parse', 'FETCH_HEAD');
        const changes = epic.tasks.map((task) => {
          const key = createHash('sha256')
            .update(`${config.file}:${epic.repository}:${task.number}`)
            .digest('hex');
          const record = JSON.parse(
            readFileSync(
              join(stateDirectory(config, '.runtime', 'pull-requests', key), 'pr.json'),
              'utf8',
            ),
          );
          const api = (...args: string[]) =>
            execFileSync('gh', args, { cwd: config.project, encoding: 'utf8' });
          const pull = JSON.parse(api('api', `repos/${epic.repository}/pulls/${record.pr}`));
          if (!pull.merged_at || !pull.merge_commit_sha)
            throw new Error('Expected independently verified merged PR');
          git('merge-base', '--is-ancestor', pull.merge_commit_sha, head);
          const files = JSON.parse(
            api(
              'api',
              '--paginate',
              '--slurp',
              `repos/${epic.repository}/pulls/${record.pr}/files`,
            ),
          ).flat();
          return {
            issue: task.number,
            pr: record.pr,
            base: pull.base.sha,
            head: pull.head.sha,
            merged: pull.merge_commit_sha,
            files,
            result: task.result,
          };
        });
        const checkout = join(stateDirectory(config, '.runtime', 'epic-snapshots'), head);
        if (!existsSync(checkout)) git('worktree', 'add', '--detach', checkout, head);
        if (
          execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim() !==
            head ||
          execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).trim()
        )
          throw new Error('Finalization snapshot changed; preserve and reconcile checkout');
        const orchestrator = orchestratorForSubject(config, epic.repository, epic.epic);
        const terminalSession = process.env.TMUX
          ? execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8' }).trim()
          : orchestrator?.address?.replace(/^tmux:/, '').split(':')[0];

        return {
          head,
          checkout,
          terminalSession: terminalSession ?? '',
          changes: JSON.stringify(changes),
        };
      },
      async close(number) {
        const existing = execFileSync(
          'gh',
          [
            'issue',
            'view',
            String(number),
            '--repo',
            epic.repository,
            '--json',
            'state',
            '--jq',
            '.state',
          ],
          { cwd: config.project, encoding: 'utf8' },
        ).trim();
        if (existing === 'CLOSED') return;
        execFileSync('gh', ['issue', 'close', String(number), '--repo', epic.repository], {
          cwd: config.project,
        });
        const state = execFileSync(
          'gh',
          [
            'issue',
            'view',
            String(number),
            '--repo',
            epic.repository,
            '--json',
            'state',
            '--jq',
            '.state',
          ],
          { cwd: config.project, encoding: 'utf8' },
        ).trim();
        if (state !== 'CLOSED') throw new Error('Expected actual EPIC closed state');
      },
    },
    epic,
    decision,
    retryFinalization,
  );
}
