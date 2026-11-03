/** Bounded demo finalization observation; the Orchestrator alone schedules business work. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import { inspectRuns } from '../run/run-driver.js';
import { pipelineAccepted } from '../delivery/epic-finalization.js';
import type { DemoRound } from './round.js';

/** Stable public view of post-closure finalization and report publication for a Demo round. */
export interface DemoFinalizationView {
  roundId: string;
  closed: boolean;
  epicClosure?: {
    head: string;
    deliveryVersion: string;
    evidence: string;
    confirmed: string;
    status?: 'closed';
  };
  pipeline?: {
    disposition: string;
    head: string;
    inspectedVersions: Record<string, string>;
    accepted: boolean;
  };
  report?: {
    path: string;
    hash: string;
    published: boolean;
    acceptedVersions: Record<string, string>;
    observedVersions: Record<string, string>;
  };
  businessCompleted: boolean;
}

/** Adapter providing observation facts for Demo finalization. */
export interface DemoFinalizationAdapter {
  inspect(): Promise<DemoFinalizationView>;
}

/** Public demo finalization observation seam; records boundary facts on inspection. */
export class DemoFinalization {
  constructor(
    readonly round: DemoRound,
    readonly adapter: DemoFinalizationAdapter,
  ) {}

  private record(stage: string, facts: unknown) {
    appendFileSync(
      join(this.round.root, 'finalization-boundaries.jsonl'),
      JSON.stringify({ stage, facts, at: new Date().toISOString() }) + '\n',
    );
  }

  /** Observe the durable post-closure finalization and publication state. */
  async view(): Promise<DemoFinalizationView> {
    const facts = await this.adapter.inspect();
    this.record('finalization-view', facts);
    return facts;
  }
}

/** Native inspection of runtime registry, repository, and isolated destination facts. */
export function nativeDemoFinalization(round: DemoRound): DemoFinalizationAdapter {
  const config = loadFleetConfig(join(round.checkout, '.epic-config.json'));
  return {
    async inspect(): Promise<DemoFinalizationView> {
      const controlPath = join(round.root, 'control.json');
      const control = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, 'utf8')) : {};
      const registry = inspectRuns(config);
      const run = registry.runs.find((r) => r.id === control.runId);

      let head: string;
      try {
        head = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: round.checkout,
          encoding: 'utf8',
        }).trim();
      } catch {
        head = run?.epicClosure?.head ?? '';
      }

      let parentClosed: boolean;
      if (round.repository && round.parent) {
        try {
          const repo = `${round.repository.owner}/${round.repository.name}`;
          const parentJson = JSON.parse(
            execFileSync('gh', ['api', `repos/${repo}/issues/${round.parent}`], {
              encoding: 'utf8',
              timeout: 10000,
            }),
          );
          parentClosed = parentJson.state === 'closed';
        } catch {
          parentClosed = run?.epicClosure?.status === 'closed';
        }
      } else {
        parentClosed = run?.epicClosure?.status === 'closed';
      }

      const closed = Boolean(
        parentClosed &&
          run?.epicClosure?.status === 'closed' &&
          run.epicClosure.head === head &&
          (run.phase === 'post_closure_finalization' || run.phase === 'completed'),
      );

      const pipe = run?.pipeline;
      const isPipeAccepted = Boolean(
        pipe &&
          pipelineAccepted(pipe) &&
          pipe.head === head &&
          ['not_applicable', 'completed_no_changes'].includes(pipe.disposition) &&
          Object.values(pipe.inspectedVersions ?? {}).includes(head),
      );

      const report = run?.report;
      const reportExists = existsSync(round.entry);
      const reportPublished = Boolean(
        report &&
          reportExists &&
          report.path === round.entry &&
          createHash('sha256').update(readFileSync(round.entry)).digest('hex') === report.hash,
      );

      return {
        roundId: round.id,
        closed,
        epicClosure: run?.epicClosure,
        pipeline: pipe
          ? {
              disposition: pipe.disposition,
              head: pipe.head,
              inspectedVersions: pipe.inspectedVersions,
              accepted: isPipeAccepted,
            }
          : undefined,
        report: report
          ? {
              path: report.path,
              hash: report.hash,
              published: reportPublished,
              acceptedVersions: report.acceptedVersions,
              observedVersions: report.observedVersions,
            }
          : undefined,
        businessCompleted:
          run?.phase === 'completed' &&
          run.lifecycle === 'completed' &&
          Boolean(control.completed),
      };
    },
  };
}
