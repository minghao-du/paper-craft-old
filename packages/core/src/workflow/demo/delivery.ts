/** Demo boundary checks and human consent; business assignments remain Orchestrator decisions. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { inspectRunViews } from '../run/run-observation.js';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import type { DemoRound } from './round.js';

/** Authorization bound to Round, Run, task Issue, stage and inputs. */
export interface GateAuthorization {
  id: string;
  roundId: string;
  runId: string;
  issue: number;
  stage: string;
  inputRevision?: string;
  requiredAncestorSha?: string;
  briefHash?: string;
  authorizedAt: string;
  claimed: boolean;
  claimedAt?: string;
  claimedLaunchId?: string;
  claimedAttemptId?: string;
}

/** Stable task identities from the plan, independent of GitHub array order. */
export interface DemoTaskIdentities {
  roundId: string;
  parent: number;
  task1: number;
  task2: number;
}

/** Independently observed current delivery, never an agent's asserted result. */
export interface DemoDeliverySnapshot {
  version: string;
  children: number[];
  nativeDependency: boolean;
  firstReleased: boolean;
  secondBaseline: boolean;
  accepted: boolean;
  task1?: number;
  task2?: number;
  task1MergeSha?: string;
  task1Pr?: number;
  parentValid?: boolean;
  noExtraTasks?: boolean;
  extraTasks?: number[];
  parent?: number;
}
/** External GitHub/Runtime facts; controlled adapters cannot establish live acceptance. */
export interface DemoDeliveryAdapter {
  inspect(): Promise<DemoDeliverySnapshot>;
}
/** Persisted public gates support reconnecting without continuing agent polling. */
export class DemoDelivery {
  constructor(
    readonly round: DemoRound,
    readonly adapter: DemoDeliveryAdapter,
  ) {}
  /** Reject invalid decomposition or premature sequential dispatch and retain the observed boundary. */
  async gate(
    stage: 'worker1' | 'worker2' | 'closure',
    options?: { stageName?: string; inputRevision?: string; brief?: string },
  ) {
    if (stage === 'worker1') {
      const controlFile = join(this.round.root, 'control.json');
      let roundArmed = false;
      let control: { stopped?: boolean; releasing?: boolean; activeMs?: number; budgetMs?: number; stoppedReason?: string } | undefined;
      if (existsSync(controlFile)) {
        control = JSON.parse(readFileSync(controlFile, 'utf8'));
        roundArmed = !control?.stopped && !control?.releasing && (control?.activeMs ?? 0) < (control?.budgetMs ?? Infinity);
      }
      const workflowConfigPath = this.round.workflowConfigFile ?? join(this.round.checkout, '.epic-config.json');
      let runBound = false;
      let boundRunId = '';
      if (existsSync(workflowConfigPath)) {
        try {
          const runs = inspectRunViews(loadFleetConfig(workflowConfigPath));
          const bound = runs.find(
            (r) => r.constraints?.kind === 'demo' && r.constraints.roundId === this.round.id && r.lifecycle !== 'completed',
          );
          if (bound) {
            runBound = true;
            boundRunId = bound.id;
          }
        } catch {
          // ignore error reading run
        }
      }
      const facts = await this.adapter.inspect();
      const parentValid = facts.parentValid !== false && (facts.parent === undefined || facts.parent === this.round.parent);
      const exactChildren = facts.children.length === 2;
      const noExtra = facts.noExtraTasks !== false && (!facts.extraTasks || facts.extraTasks.length === 0);

      // Resolve task1 and task2 stably
      let task1 = facts.task1;
      let task2 = facts.task2;
      if (task1 === undefined && exactChildren && facts.nativeDependency) {
        task1 = facts.children[0];
        task2 = facts.children[1];
      }
      const pass = Boolean(roundArmed && runBound && parentValid && exactChildren && facts.nativeDependency && noExtra && task1 !== undefined);

      let failureReason: string | undefined;
      if (!pass) {
        if (!roundArmed) failureReason = 'Round is not armed or budget is expired';
        else if (!runBound)
          failureReason = `No active bound Run found for round ${this.round.id}: expected an active Run bound to round ${this.round.id}, received none`;
        else if (!parentValid) failureReason = 'Parent identity mismatch';
        else if (!exactChildren) failureReason = `Expected exactly two child tasks, found ${facts.children.length}`;
        else if (!facts.nativeDependency) failureReason = 'Native dependency direction violated (second child must be blocked by first)';
        else if (!noExtra) failureReason = 'Extra tasks detected';
        else failureReason = 'Unknown prerequisite failure';
      }

      appendFileSync(
        join(this.round.root, 'delivery-boundaries.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), stage, pass, facts, ...(failureReason ? { error: failureReason } : {}) }) + '\n',
      );

      if (!pass) {
        if (control && existsSync(controlFile)) {
          control.stopped = true;
          control.stoppedReason = 'Gate 1 verification failed: ' + failureReason;
          writeFileSync(controlFile, JSON.stringify(control, null, 2));
        }
        throw new Error('Gate 1 verification failed: ' + failureReason);
      }

      // Persist stable task identities
      const taskIdentities: DemoTaskIdentities = {
        roundId: this.round.id,
        parent: this.round.parent ?? 1,
        task1: task1!,
        task2: task2!,
      };
      writeFileSync(join(this.round.root, 'demo-tasks.json'), JSON.stringify(taskIdentities, null, 2));

      // Issue durable Gate authorization
      const authorization: GateAuthorization = {
        id: randomUUID(),
        roundId: this.round.id,
        runId: boundRunId,
        issue: task1!,
        stage: options?.stageName ?? 'implementation',
        inputRevision: options?.inputRevision,
        briefHash: options?.brief ? createHash('sha256').update(options.brief).digest('hex') : undefined,
        authorizedAt: new Date().toISOString(),
        claimed: false,
      };
      writeFileSync(
        join(this.round.root, 'gate-worker1-authorization.json'),
        JSON.stringify(authorization, null, 2),
      );
      writeFileSync(
        join(this.round.root, 'gate-authorization.json'),
        JSON.stringify(authorization, null, 2),
      );
      appendFileSync(
        join(this.round.root, 'gate-authorizations.jsonl'),
        JSON.stringify({ gate: 'worker1', ...authorization }) + '\n',
      );

      return Object.assign(facts, { authorization, task1, task2 });
    }

    if (stage === 'worker2') {
      const controlFile = join(this.round.root, 'control.json');
      let roundArmed = false;
      let control: { stopped?: boolean; releasing?: boolean; activeMs?: number; budgetMs?: number; stoppedReason?: string } | undefined;
      if (existsSync(controlFile)) {
        control = JSON.parse(readFileSync(controlFile, 'utf8'));
        roundArmed = !control?.stopped && !control?.releasing && (control?.activeMs ?? 0) < (control?.budgetMs ?? Infinity);
      } else if (!existsSync(join(this.round.root, 'round.json')) && !this.round.workflowConfigFile) {
        roundArmed = true;
      }
      const workflowConfigPath = this.round.workflowConfigFile ?? (this.round.checkout ? join(this.round.checkout, '.epic-config.json') : undefined);
      let runBound = false;
      let boundRunId = '';
      if (workflowConfigPath && existsSync(workflowConfigPath)) {
        try {
          const runs = inspectRunViews(loadFleetConfig(workflowConfigPath));
          const bound = runs.find(
            (r) => r.constraints?.kind === 'demo' && r.constraints.roundId === this.round.id && r.lifecycle !== 'completed',
          );
          if (bound) {
            runBound = true;
            boundRunId = bound.id;
          }
        } catch {
          // ignore error reading run
        }
      }
      const facts = await this.adapter.inspect();
      const parentValid = facts.parentValid !== false && (facts.parent === undefined || facts.parent === this.round.parent);
      const exactChildren = facts.children.length === 2;
      const noExtra = facts.noExtraTasks !== false && (!facts.extraTasks || facts.extraTasks.length === 0);

      // Resolve task1 and task2 stably
      let task1 = facts.task1;
      let task2 = facts.task2;
      const savedTasksFile = join(this.round.root, 'demo-tasks.json');
      if (existsSync(savedTasksFile)) {
        try {
          const saved = JSON.parse(readFileSync(savedTasksFile, 'utf8'));
          task1 ??= saved.task1;
          task2 ??= saved.task2;
        } catch {
          /* ignore */
        }
      }
      if (task1 === undefined && exactChildren && facts.nativeDependency) {
        task1 = facts.children[0];
        task2 = facts.children[1];
      }

      // Check baseline ancestry if inputRevision is provided
      let baselineValid = true;
      if (options?.inputRevision) {
        if (facts.secondBaseline === false) {
          baselineValid = false;
        } else if (facts.task1MergeSha && this.round.checkout && existsSync(this.round.checkout)) {
          try {
            execFileSync('git', ['merge-base', '--is-ancestor', facts.task1MergeSha, options.inputRevision], {
              cwd: this.round.checkout,
              encoding: 'utf8',
              stdio: 'pipe',
            });
          } catch {
            baselineValid = false;
          }
        }
      }

      const pass = Boolean(
        roundArmed &&
        runBound &&
        parentValid &&
        exactChildren &&
        facts.nativeDependency &&
        noExtra &&
        task1 !== undefined &&
        task2 !== undefined &&
        facts.firstReleased &&
        baselineValid,
      );

      let failureReason: string | undefined;
      if (!pass) {
        if (!roundArmed) failureReason = 'Round is not armed or budget is expired';
        else if (!runBound)
          failureReason = `No active bound Run found for round ${this.round.id}: expected an active Run bound to round ${this.round.id}, received none`;
        else if (!parentValid) failureReason = 'Parent identity mismatch';
        else if (!exactChildren) failureReason = `Expected exactly two child tasks, found ${facts.children.length}`;
        else if (!facts.nativeDependency) failureReason = 'Native dependency direction violated';
        else if (!noExtra) failureReason = 'Extra tasks detected';
        else if (!facts.firstReleased) failureReason = 'Task 1 delivery is incomplete or resources are not released';
        else if (!baselineValid) failureReason = `Task 2 input revision ${options?.inputRevision} does not contain Task 1 merge ${facts.task1MergeSha ?? ''} as an ancestor`;
        else failureReason = 'Unknown prerequisite failure';
      }

      appendFileSync(
        join(this.round.root, 'delivery-boundaries.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), stage, pass, facts, ...(failureReason ? { error: failureReason } : {}) }) + '\n',
      );

      if (!pass) {
        if (control && existsSync(controlFile)) {
          control.stopped = true;
          control.stoppedReason = 'Gate 2 verification failed: ' + failureReason;
          writeFileSync(controlFile, JSON.stringify(control, null, 2));
        }
        throw new Error('Gate 2 verification failed: ' + failureReason);
      }

      // Issue durable Gate authorization for task 2
      const authorization: GateAuthorization = {
        id: randomUUID(),
        roundId: this.round.id,
        runId: boundRunId,
        issue: task2!,
        stage: options?.stageName ?? 'implementation',
        inputRevision: options?.inputRevision,
        requiredAncestorSha: facts.task1MergeSha,
        briefHash: options?.brief ? createHash('sha256').update(options.brief).digest('hex') : undefined,
        authorizedAt: new Date().toISOString(),
        claimed: false,
      };
      writeFileSync(
        join(this.round.root, 'gate-worker2-authorization.json'),
        JSON.stringify(authorization, null, 2),
      );
      writeFileSync(
        join(this.round.root, 'gate-authorization.json'),
        JSON.stringify(authorization, null, 2),
      );
      appendFileSync(
        join(this.round.root, 'gate-authorizations.jsonl'),
        JSON.stringify({ gate: 'worker2', ...authorization }) + '\n',
      );

      return Object.assign(facts, { authorization, task1, task2 });
    }

    const facts = await this.adapter.inspect();
    const pass =
      facts.children.length === 2 &&
      facts.nativeDependency &&
      facts.firstReleased &&
      (stage !== 'closure' || (facts.secondBaseline && facts.accepted));
    appendFileSync(
      join(this.round.root, 'delivery-boundaries.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), stage, pass, facts }) + '\n',
    );
    if (!pass)
      throw new Error('Native structure or complete sequential delivery prerequisite failed');
    return facts;
  }
  /** Present the actual version before accepting a human decision. */
  async request() {
    const facts = await this.gate('closure');
    writeFileSync(
      join(this.round.root, 'closure-request.json'),
      JSON.stringify({ deliveryVersion: facts.version }, null, 2),
    );
    return facts;
  }
  /** Only explicitly invoked human control creates consent, bound to the displayed version. */
  async confirm(version: string, confirmed: boolean) {
    const facts = await this.gate('closure');
    const reqFile = join(this.round.root, 'closure-request.json');
    if (!existsSync(reqFile)) {
      throw new Error('Closure request required before human confirmation');
    }
    const request = JSON.parse(readFileSync(reqFile, 'utf8'));
    if (!confirmed || request.deliveryVersion !== version || facts.version !== version)
      throw new Error('Expected explicit human confirmation of current requested delivery version');
    const consent = {
      deliveryVersion: version,
      source: 'human' as const,
      evidence: `Operator pc demo confirm for round ${this.round.id} at ${new Date().toISOString()}`,
    };
    writeFileSync(join(this.round.root, 'human-closure.json'), JSON.stringify(consent, null, 2));
    return consent;
  }
}
/** Historical checks use durable observed boundary snapshots, never eventual output alone. */
export async function demoChronology(round: DemoRound) {
  const path = join(round.root, 'delivery-boundaries.jsonl');
  const events: { at: string; stage: string; pass: boolean; facts: DemoDeliverySnapshot }[] =
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((x) => JSON.parse(x))
      : [];
  const configPath = round.workflowConfigFile ?? (round.checkout ? join(round.checkout, '.epic-config.json') : undefined);
  if (!configPath || !existsSync(configPath)) {
    return [
      {
        stage: 'ordering',
        expected: 'Witnessed complete handover before Worker 2 dispatch',
        observed: JSON.stringify(events),
        verdict: events.some((e) => !e.pass) ? ('finding' as const) : ('missing' as const),
        reference: path,
      },
    ];
  }
  const runs = inspectRunViews(loadFleetConfig(configPath));
  const dispatches = runs.flatMap((r) => r.dispatches ?? []);
  const worker2 = dispatches.filter(
    (d) => d.role === 'worker' && events.some((e) => d.subject.endsWith('#' + (e.facts.task2 ?? e.facts.children?.[1]))),
  );
  const failedGate = events.some((e) => !e.pass);
  const gate2Pass = events.find((e) => e.stage === 'worker2' && e.pass);
  const earlyStart =
    worker2.length > 0 &&
    worker2.some((d) =>
      d.attempts.some((a) =>
        !gate2Pass || Date.parse(a.created) < Date.parse(gate2Pass.at),
      ),
    );
  const witnessed =
    worker2.length > 0 &&
    !earlyStart &&
    worker2.every((d) =>
      d.attempts.every((a) =>
        events.some(
          (e) => e.stage === 'worker2' && e.pass && Date.parse(e.at) <= Date.parse(a.created),
        ),
      ),
    );
  return [
    {
      stage: 'ordering',
      expected: 'Witnessed complete handover before Worker 2 dispatch',
      observed: JSON.stringify(events),
      verdict: failedGate || earlyStart
        ? ('finding' as const)
        : witnessed
          ? ('pass' as const)
          : ('missing' as const),
      reference: path,
    },
  ];
}
