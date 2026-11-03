/** Bounded demo finalization gates; the Orchestrator alone dispatches real specialists. */
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import { inspectRuns, dispositionStagePipeline, publishStageReport } from '../run/run-driver.js';
import { pipelineAccepted } from '../delivery/epic-finalization.js';
import type { DemoRound } from './round.js';
/** Facts independently inspected before invoking normal finalization operations. */
export interface DemoFinalizationAdapter {
  inspect(): Promise<{ closed: boolean; pipelineAccepted: boolean }>;
  pipeline(): Promise<void>;
  publish(coordinator: { identity: string; entry: string; brief: string }): Promise<unknown>;
}
/** Public demo gate forbids reporting around closure or Pipeline failures. */
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
  /** Accept the real specialist's inspected no-change conclusion, never implement repairs. */
  async pipeline() {
    const facts = await this.adapter.inspect();
    this.record('pipeline', facts);
    if (!facts.closed) throw new Error('Verified actual Parent closure required');
    await this.adapter.pipeline();
    const after = await this.adapter.inspect();
    this.record('pipeline-result', after);
    if (!after.pipelineAccepted)
      throw new Error('Pipeline changes or missing evidence block reporting; retain scene');
    return after;
  }
  /** Publish using only the operator-configured isolated Coordinator contract. */
  async publish() {
    const facts = await this.adapter.inspect();
    this.record('publication', facts);
    if (!facts.closed || !facts.pipelineAccepted)
      throw new Error('Verified closure and accepted Pipeline required');
    return this.adapter.publish({
      identity: this.round.config.coordinator,
      entry: this.round.entry,
      brief: this.round.config.brief,
    });
  }
}
/** Actual Runtime, GitHub and physical destination checks, with no scheduler or mock fallback. */
export function nativeDemoFinalization(
  round: DemoRound,
  authority: string,
  dispatch: string,
): DemoFinalizationAdapter {
  const config = loadFleetConfig(join(round.checkout, '.epic-config.json'));
  const state = () => {
    const control = JSON.parse(readFileSync(join(round.root, 'control.json'), 'utf8'));
    const registry = inspectRuns(config);
    const run = registry.runs.find((r) => r.id === control.runId);
    if (
      !run ||
      run.provider !== 'agy' ||
      run.orchestrator?.id !== authority ||
      run.lifecycle !== 'running' ||
      control.stopped
    )
      throw new Error('Active owned Agy Orchestrator required');
    if (
      realpathSync(round.research) !== round.research ||
      dirname(round.entry) !== round.research ||
      round.entry !== join(round.research, 'report.md')
    )
      throw new Error('Isolated physical report destination required');
    const d = registry.dispatches?.find((d) => d.id === dispatch && d.runId === run.id);
    if (!d || d.attempts.some((a) => a.runner !== 'agy'))
      throw new Error('Current Agy specialist Dispatch required');
    return { run, registry, d };
  };
  return {
    async inspect() {
      const { run } = state();
      const repo = round.repository!.owner + '/' + round.repository!.name;
      const parent = JSON.parse(
        execFileSync('gh', ['api', `repos/${repo}/issues/${round.parent}`], {
          encoding: 'utf8',
          timeout: 30000,
        }),
      );
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: round.checkout,
        encoding: 'utf8',
      }).trim();
      return {
        closed:
          parent.state === 'closed' &&
          run.phase === 'post_closure_finalization' &&
          run.epicClosure?.head === head,
        pipelineAccepted: pipelineAccepted(run.pipeline) && run.pipeline?.head === head,
      };
    },
    async pipeline() {
      const { run, registry, d } = state();
      const receipt = registry.receipts?.find((r) => r.id === d.acceptedReceipt);
      if (!receipt?.evidence[0]) throw new Error('Accepted real Pipeline evidence required');
      const result = JSON.parse(readFileSync(receipt.evidence[0].path, 'utf8'));
      // A maintenance delivery would violate the two-PR diagnostic scope.
      if (!['not_applicable', 'completed_no_changes'].includes(result.disposition))
        throw new Error('Pipeline changes require retention; no repair or third delivery');
      if (!Object.values(result.inspectedVersions ?? {}).includes(run.epicClosure!.head))
        throw new Error('Pipeline inspection must bind delivered revision');
      dispositionStagePipeline(config, run.id, authority, dispatch);
    },
    async publish(coordinator) {
      const { run } = state();
      return publishStageReport(config, run.id, authority, dispatch, coordinator);
    },
  };
}
