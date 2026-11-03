/** Real native relationship, delivery and closure boundary. No scheduling decisions. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRuns, closeStageEpic } from '../run/run-driver.js';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import type { DemoRound } from './round.js';
import type { DemoDeliveryAdapter } from './delivery.js';
/** Authority and accepted integrated Dispatch are supplied by the active Orchestrator for closure. */
export function nativeDemoDelivery(
  round: DemoRound,
  authority = '',
  dispatch = '',
): DemoDeliveryAdapter {
  const config = loadFleetConfig(join(round.checkout, '.epic-config.json'));
  const repo = `${round.repository!.owner}/${round.repository!.name}`;
  const gh = (path: string) =>
    JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 30000 }));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: round.checkout, encoding: 'utf8', timeout: 10000 }).trim();
  const state = () => {
    const registry = inspectRuns(config);
    const run = registry.runs.find(
      (r) => r.subject.repository === repo && r.subject.number === round.parent,
    );
    if (!run) throw new Error('Missing attributable demo Run');
    return { registry, run };
  };
  return {
    async inspect() {
      const { registry, run } = state();
      let parentValid = false;
      try {
        const parentIssue = gh(`repos/${repo}/issues/${round.parent}`);
        parentValid = parentIssue && parentIssue.number === round.parent;
      } catch {
        /* fail closed */
      }
      const children: { number: number }[] = gh(
        `repos/${repo}/issues/${round.parent}/sub_issues?per_page=100`,
      );
      let task1: number | undefined;
      let task2: number | undefined;
      let nativeDependency = false;
      if (children.length === 2) {
        const c0 = children[0].number;
        const c1 = children[1].number;
        let blockers0: { number: number }[] = [];
        let blockers1: { number: number }[] = [];
        try {
          blockers0 = gh(`repos/${repo}/issues/${c0}/dependencies/blocked_by`);
        } catch {
          /* ignore */
        }
        try {
          blockers1 = gh(`repos/${repo}/issues/${c1}/dependencies/blocked_by`);
        } catch {
          /* ignore */
        }
        if (blockers0.length === 1 && blockers0[0].number === c1 && blockers1.length === 0) {
          task1 = c1;
          task2 = c0;
          nativeDependency = true;
        } else if (blockers1.length === 1 && blockers1[0].number === c0 && blockers0.length === 0) {
          task1 = c0;
          task2 = c1;
          nativeDependency = true;
        }
      }
      const savedTasksFile = join(round.root, 'demo-tasks.json');
      if (existsSync(savedTasksFile)) {
        try {
          const saved = JSON.parse(readFileSync(savedTasksFile, 'utf8'));
          if (saved.task1 && saved.task2) {
            task1 = saved.task1;
            task2 = saved.task2;
          }
        } catch {
          /* ignore */
        }
      }
      let noExtraTasks = true;
      let extraTasks: number[] = [];
      try {
        const allIssues: { number: number }[] = gh(`repos/${repo}/issues?state=all&per_page=100`);
        extraTasks = allIssues
          .map((i) => i.number)
          .filter((n) => n !== round.parent && !children.some((c) => c.number === n));
        noExtraTasks = extraTasks.length === 0;
      } catch {
        /* ignore */
      }
      const deliveries = (registry.deliveries ?? []).filter((d) => d.runId === run.id);
      const first = task1 ? deliveries.find((d) => d.issue === task1) : undefined;
      const prs: {
        number: number;
        merge_commit_sha: string;
        merged_at: string;
        head: { sha: string };
      }[] = gh(`repos/${repo}/pulls?state=all&per_page=100`);
      const pr = prs.find((p) => p.number === first?.pr);
      const d = (registry.dispatches ?? []).filter((d) => d.runId === run.id);
      const complete = Boolean(
        first?.recorded &&
        first.released &&
        first.archive &&
        pr?.merged_at &&
        first.checkedHead === pr.head.sha &&
        first.status === 'done' &&
        first.dispatches.length &&
        first.dispatches.every((id) => d.some((x) => x.id === id && x.lifecycle === 'accepted')),
      );
      const worker2 = task2
        ? d.find((x) => x.role === 'worker' && x.subject === `${repo}#${task2}`)
        : undefined;
      let ancestor = false;
      if (pr && worker2)
        try {
          git('merge-base', '--is-ancestor', pr.merge_commit_sha, worker2.inputRevision);
          ancestor = true;
        } catch {
          /* fail closed */
        }
      const head = git('rev-parse', 'HEAD');
      return {
        version: createHash('sha256').update(JSON.stringify({ head, deliveries })).digest('hex'),
        children: children.map((c) => c.number),
        nativeDependency,
        firstReleased: complete,
        secondBaseline: ancestor,
        task1,
        task2,
        parentValid,
        noExtraTasks,
        extraTasks,
        accepted:
          prs.length === 2 &&
          deliveries.length === 2 &&
          deliveries.every((x) => x.status === 'done' && x.recorded && x.released && x.archive) &&
          d.some(
            (x) =>
              x.role === 'epic' &&
              x.stage === 'integrated-acceptance' &&
              x.lifecycle === 'accepted' &&
              x.inputRevision === head,
          ),
      };
    },
    async createChildren(customTasks) {
      const tasks = customTasks ?? [
        {
          title: 'Task 1: Generate TSV data with Python standard library',
          body: 'Python standard-library generator generate.py writes data.tsv with id/value header and ten tab-separated rows (1,10) through (10,100). Deliver generator, minimal unittest and TSV in PR 1.',
        },
        {
          title: 'Task 2: Summarize TSV data into JSON',
          body: 'summarize.py reads data.tsv and writes summary.json containing n=10, mean=55, min=10, max=100. Deliver reader, unittest using changed temporary input, and JSON in PR 2.',
        },
      ];
      const c1Url = execFileSync(
        'gh',
        ['issue', 'create', '--repo', repo, '--title', tasks[0].title, '--body', tasks[0].body],
        { encoding: 'utf8' },
      ).trim();
      const task1 = Number(c1Url.split('/').at(-1));
      execFileSync(
        'gh',
        ['issue', 'edit', String(round.parent), '--repo', repo, '--add-sub-issue', String(task1)],
        { encoding: 'utf8' },
      );
      const c2Url = execFileSync(
        'gh',
        ['issue', 'create', '--repo', repo, '--title', tasks[1].title, '--body', tasks[1].body],
        { encoding: 'utf8' },
      ).trim();
      const task2 = Number(c2Url.split('/').at(-1));
      execFileSync(
        'gh',
        ['issue', 'edit', String(round.parent), '--repo', repo, '--add-sub-issue', String(task2)],
        { encoding: 'utf8' },
      );
      const task1Obj = gh(`repos/${repo}/issues/${task1}`);
      execFileSync(
        'gh',
        ['api', `repos/${repo}/issues/${task2}/dependencies/blocked_by`, '-F', `issue_id=${task1Obj.id}`],
        { encoding: 'utf8' },
      );
      const taskIdentities = { roundId: round.id, parent: round.parent!, task1, task2 };
      writeFileSync(join(round.root, 'demo-tasks.json'), JSON.stringify(taskIdentities, null, 2));
      return { task1, task2 };
    },
    async close(consent) {
      const { run, registry } = state();
      if (
        run.orchestrator?.id !== authority ||
        run.lifecycle !== 'running' ||
        !registry.dispatches?.some(
          (d) =>
            d.id === dispatch &&
            d.runId === run.id &&
            d.role === 'epic' &&
            d.stage === 'integrated-acceptance' &&
            d.lifecycle === 'accepted',
        )
      )
        throw new Error(
          'Active Orchestrator and accepted integrated Dispatch required before GitHub close',
        );
      if (!authority || !dispatch)
        throw new Error('Active Orchestrator authority and accepted integrated Dispatch required');
      execFileSync('gh', ['issue', 'close', String(round.parent), '--repo', repo], {
        encoding: 'utf8',
        timeout: 30000,
      });
      await closeStageEpic(config, run.id, authority, dispatch, consent, async () => ({
        head: git('rev-parse', 'HEAD'),
        closed: gh(`repos/${repo}/issues/${round.parent}`).state === 'closed',
        evidence: `GitHub ${repo}#${round.parent} actual closure`,
      }));
    },
  };
}
