/** Real native relationship, delivery and closure boundary. No scheduling decisions. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
      const children: { number: number }[] = gh(
        `repos/${repo}/issues/${round.parent}/sub_issues?per_page=100`,
      );
      const blockers: { number: number }[] =
        children.length === 2
          ? gh(`repos/${repo}/issues/${children[1].number}/dependencies/blocked_by`)
          : [];
      const deliveries = (registry.deliveries ?? []).filter((d) => d.runId === run.id);
      const first = deliveries.find((d) => d.issue === children[0]?.number);
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
      const worker2 = d.find(
        (x) => x.role === 'worker' && x.subject === `${repo}#${children[1]?.number}`,
      );
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
        nativeDependency: blockers.length === 1 && blockers[0].number === children[0]?.number,
        firstReleased: complete,
        secondBaseline: ancestor,
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
