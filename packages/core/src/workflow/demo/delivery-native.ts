/** Real native relationship, delivery and closure boundary. No scheduling decisions. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRun } from '../run/run-observation.js';
import { inspectRuns } from '../run/run-registry.js';
import { canonicalDeliveryFingerprint } from '../run/epic-completion.js';
import { inspectAttemptControl } from '../runtime/runtime.js';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import type { DemoRound } from './round.js';
import type { DemoDeliveryAdapter } from './delivery.js';
/** Real native relationship, delivery and closure boundary. No scheduling decisions. */
export function nativeDemoDelivery(
  round: DemoRound,
  customGh?: (path: string) => ReturnType<typeof JSON.parse>,
): DemoDeliveryAdapter {
  const config = loadFleetConfig(round.workflowConfigFile ?? join(round.checkout, '.epic-config.json'));
  const repo = `${round.repository!.owner}/${round.repository!.name}`;
  const gh = customGh ?? ((path: string) =>
    JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 30000 })));
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
      const { run } = state();
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
      const runView = inspectRun(config, run.id);
      const deliveries = runView.deliveries;
      const first = task1 ? deliveries.find((d) => d.issue === task1) : undefined;
      let prs: {
        number: number;
        merge_commit_sha: string;
        merged_at: string;
        head: { sha: string };
      }[] = [];
      try {
        prs = gh(`repos/${repo}/pulls?state=all&per_page=100`);
      } catch {
        /* fail closed */
      }
      const pr = prs.find((p) => p.number === first?.pr);
      const d = runView.dispatches;

      // 1. GitHub PR merge and merge SHA in git
      const isPrMerged = Boolean(pr?.merged_at && pr?.merge_commit_sha);
      let mergeCommitInGit = false;
      if (isPrMerged && pr?.merge_commit_sha) {
        try {
          git('cat-file', '-e', pr.merge_commit_sha);
          mergeCommitInGit = true;
        } catch {
          mergeCommitInGit = false;
        }
      }

      // 2. Accepted delivery evidence
      const task1Dispatches = d.filter((x) => first?.dispatches.includes(x.id));
      const dispatchesAccepted = Boolean(
        first &&
        first.status === 'done' &&
        first.checkedHead === pr?.head?.sha &&
        first.dispatches.length > 0 &&
        task1Dispatches.length === first.dispatches.length &&
        task1Dispatches.every((x) => x.lifecycle === 'accepted'),
      );

      // 3. Final records
      const finalRecordsRecorded = Boolean(first?.recorded === true);

      // 4. Preservation/archive bundle verified
      let archiveValid = false;
      if (first?.archive && existsSync(first.archive)) {
        const bundle = join(first.archive, 'repository.bundle');
        if (existsSync(bundle)) {
          try {
            git('bundle', 'verify', bundle);
            archiveValid = true;
          } catch {
            archiveValid = false;
          }
        }
      }

      // 5. Completed cleanup: task 1 worktrees removed from disk and git worktree list
      const task1Attempts = task1Dispatches.flatMap((x) => x.attempts);
      const task1Checkouts = [...new Set(task1Attempts.map((a) => a.checkout).filter(Boolean))];
      let cleanupCompleted = true;
      if (task1Checkouts.length > 0) {
        const onDisk = task1Checkouts.some((co) => existsSync(co));
        let inWorktreeList: boolean;
        try {
          const wtList = git('worktree', 'list', '--porcelain');
          inWorktreeList = task1Checkouts.some((co) => wtList.includes(`worktree ${co}`));
        } catch {
          inWorktreeList = true;
        }
        cleanupCompleted = !onDisk && !inWorktreeList;
      }

      // 6. Actual release of task 1's execution and checkout resources
      const checkoutsReleased = !task1Checkouts.some((co) =>
        runView.resources.some((r) => r.path === co),
      );
      const executionsReleased = task1Attempts.every((a) => {
        const ctrl = inspectAttemptControl(a);
        return (
          ctrl.execution?.status === 'terminated' ||
          (a.startupStopped === true && a.status !== 'running' && !a.address)
        );
      });
      const task1Released = Boolean(first?.released && checkoutsReleased && executionsReleased);

      // 7. Scoped release: Parent Run Orchestrator remains alive and available
      const orchestratorAvailable =
        runView.lifecycle === 'running' && runView.orchestrator !== undefined && !runView.released;

      // Complete handover requires all independent checks
      const complete = Boolean(
        isPrMerged &&
        mergeCommitInGit &&
        dispatchesAccepted &&
        finalRecordsRecorded &&
        archiveValid &&
        cleanupCompleted &&
        task1Released &&
        orchestratorAvailable,
      );

      const worker2 = task2
        ? d.find((x) => x.role === 'worker' && x.subject === `${repo}#${task2}`)
        : undefined;
      let ancestor = false;
      if (pr?.merge_commit_sha && worker2)
        try {
          git('merge-base', '--is-ancestor', pr.merge_commit_sha, worker2.inputRevision);
          ancestor = true;
        } catch {
          /* fail closed */
        }
      const head = git('rev-parse', 'HEAD');
      return {
        version: canonicalDeliveryFingerprint(head, deliveries),
        children: children.map((c) => c.number),
        nativeDependency,
        firstReleased: complete,
        secondBaseline: ancestor,
        task1,
        task2,
        task1MergeSha: pr?.merge_commit_sha,
        task1Pr: pr?.number,
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
  };
}
