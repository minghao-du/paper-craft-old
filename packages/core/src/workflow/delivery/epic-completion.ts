import { releaseResearchWriter } from './research-report.js';
import {
  startBusinessTurn,
  collectBusinessTurn,
  acceptValidatedBusinessTurns,
} from '../run/run-driver.js';
import {
  finalizeEpic,
  type EpicFinalization,
  type FinalizationContext,
  type PipelineMaintenanceProvider,
} from './epic-finalization.js';
import { inspectRuns, updateRunRegistry } from '../run/run-driver.js';
import { claimDriver } from '../run/driver-lock.js';
/** Goal acceptance and the sole human workflow approval: closing an EPIC. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../handoff.js';
import type { FleetConfig } from '../fleet/fleet-config.js';
import type { EpicRun, EpicTask } from './epic-driver.js';
import type { RoundRunner, IssueTurn } from './issue-driver.js';
/** Only the calling human-facing host may supply this decision, never a model result. */
export interface EpicCloseDecision {
  epic: number;
  confirmed: boolean;
  source: 'human';
  evidence: string;
  /** Delivery fingerprint presented by the closure request. */
  deliveryVersion?: string;
}
/** Delivery performs head-bound professional gates and verified postmerge completion. */
export interface EpicCompletionProvider {
  deliver(task: EpicTask): Promise<string>;
  maintenance?: PipelineMaintenanceProvider;
  close(epic: number): Promise<void>;
  /** Resolve verified merged changes and a safe checkout at the current integrated SHA. */
  finalizationContext(): Promise<FinalizationContext>;
}
/** Retained professional judgment and target-specific human decision. */
export interface EpicCompletion {
  status:
    'blocked' | 'awaiting_confirmation' | 'closed' | 'post_closure_finalization' | 'completed';
  closureVerified?: boolean;
  deliveryVersion?: string;
  acceptedHead?: string;
  deliveries: Record<string, string>;
  turns: IssueTurn[];
  acceptance?: { satisfied: boolean; criteria: string[]; blockers: string[] };
  request?: string;
  decision?: EpicCloseDecision;
  archive?: string;
  finalization?: EpicFinalization;
  finalizationHistory?: EpicFinalization[];
  finalAccepted?: string;
  error?: string;
}
/** Finish each child, evaluate the original objective, and wait for explicit human closure. */
export async function completeEpic(
  config: FleetConfig,
  runner: RoundRunner & { stopped?(turn: IssueTurn): Promise<boolean> },
  provider: EpicCompletionProvider,
  epic: EpicRun,
  decision?: EpicCloseDecision,
  retryFinalization = false,
): Promise<EpicCompletion> {
  const key = createHash('sha256')
    .update(`${config.file}:${epic.repository}:${epic.epic}`)
    .digest('hex');
  const home = stateDirectory(config, '.runtime', 'epic-completion', key),
    file = join(home, 'completion.json');
  const lock = join(home, 'driver.lock');
  claimDriver(lock);
  try {
    const run: EpicCompletion = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { status: 'blocked', deliveries: {}, turns: [] };
    const save = () => {
      const temp = file + randomUUID();
      writeFileSync(temp, JSON.stringify(run, null, 2));
      renameSync(temp, file);
      if (run.finalization?.pipeline)
        updateRunRegistry(config, (registry) => {
          const owner = registry.runs.find(
            (r) =>
              r.subject.repository === epic.repository &&
              r.subject.number === epic.epic &&
              r.subject.kind === 'epic',
          );
          if (owner) {
            owner.pipeline = run.finalization!.pipeline;
            owner.pipelineMaintenance = run.finalization!.maintenanceDeliveries;
            if (run.finalization!.report) owner.report = run.finalization!.report;
          }
        });
    };
    try {
      const owner = inspectRuns(config).runs.find(
        (r) =>
          r.subject.repository === epic.repository &&
          r.subject.number === epic.epic &&
          r.lifecycle !== 'completed',
      );
      if (owner && owner.subject.kind !== 'epic')
        throw new Error('Issue-only Run cannot close or finalize parent EPIC');
      if (
        epic.status !== 'delivered' ||
        !epic.tasks.length ||
        epic.tasks.some((t) => !t.result || !t.checkout)
      )
        throw new Error('Expected all attributed EPIC deliveries before goal acceptance');
      for (const t of epic.tasks)
        if (!run.deliveries[t.number]) {
          run.deliveries[t.number] = await provider.deliver(t);
          save();
        }
      const turn = async (
        role: IssueTurn['role'],
        brief: string,
        context?: FinalizationContext,
        reuse = false,
      ) => {
        const retained = run.turns.find(
          (t) =>
            t.role === role &&
            t.brief === brief &&
            (t.result === undefined || role === 'orchestrator' || reuse),
        );
        if (retained) {
          if (retained.result !== undefined) return retained.result;
          if (!retained.conversation || retained.status !== 'running')
            throw new Error('Missing original receipt; retain unknown occupancy');
          retained.result = await collectBusinessTurn(config, runner, retained);
          save();
          return retained.result;
        }
        const id = randomUUID(),
          directory = stateDirectory(config, '.runtime', 'epic-completion', key, id);
        const attempt: IssueTurn = {
          id,
          directory,
          brief,
          role,
          fleet: createHash('sha256').update(config.file).digest('hex'),
          runner: runner.name,
          status: 'starting',
          checkout: context?.checkout ?? config.project,
          terminalSession: context?.terminalSession,
          writableDirectories: context?.writableDirectories,
          created: new Date().toISOString(),
        };
        run.turns.push(attempt);
        writeFileSync(join(directory, 'brief.md'), brief);
        save();
        Object.assign(
          attempt,
          await startBusinessTurn(config, runner, attempt, epic.repository, epic.epic),
          { status: 'running' },
        );
        if (context && !attempt.address?.startsWith(`tmux:${context.terminalSession}:`))
          throw new Error(
            'Specialist receipt must identify a window in the existing fleet session',
          );
        if (!attempt.conversation || !attempt.evidence || !attempt.address)
          throw new Error('Expected actual Runner receipt');
        save();
        attempt.result = await collectBusinessTurn(config, runner, attempt);
        save();
        return attempt.result;
      };
      const context = await provider.finalizationContext();
      if (retryFinalization) {
        for (const attempt of run.turns) {
          if (
            attempt.retired ||
            !['pipeline-audit', 'pipeline-refactor', 'research-state'].includes(attempt.role)
          )
            continue;
          if (!runner.stopped || !(await runner.stopped(attempt)))
            throw new Error(
              'Retry requires verified specialist termination and released writing ownership',
            );
        }
      }
      if (retryFinalization && run.finalization?.plan?.coordinator) {
        await releaseResearchWriter(run.finalization.plan.coordinator.entry, async (owner) => {
          const writer = run.turns.find(
            (t) => t.role === 'research-state' && t.brief.includes('.report-' + owner.revision),
          );
          return !!writer && !!runner.stopped && (await runner.stopped(writer));
        });
      }
      if (retryFinalization) {
        for (const attempt of run.turns) {
          if (
            ['pipeline-audit', 'pipeline-refactor', 'research-state'].includes(attempt.role)
          )
            attempt.retired = true;
        }
        save();
      }
      const version = createHash('sha256')
        .update(
          JSON.stringify({
            head: context.head,
            changes: context.changes,
            deliveries: run.deliveries,
          }),
        )
        .digest('hex');
      if (!run.closureVerified && (run.deliveryVersion !== version || retryFinalization)) {
        run.deliveryVersion = version;
        if (
          !retryFinalization &&
          run.turns.some(
            (t) =>
              ['pipeline-audit', 'pipeline-refactor', 'research-state'].includes(t.role) &&
              !t.retired &&
              t.result === undefined,
          )
        )
          throw new Error(
            'Baseline changed; reconcile original specialist occupancy before replacement',
          );
        const superseded = !!run.finalization;
        if (run.finalization) (run.finalizationHistory ??= []).push(run.finalization);
        run.finalization = { context, round: randomUUID() };
        delete run.acceptance;
        delete run.finalAccepted;
        delete run.request;
        delete run.decision;
        run.status = 'blocked';
        save();
        if (superseded && decision)
          throw new Error('Baseline changed; obtain new finalization and human confirmation');
      }
      if (retryFinalization && run.closureVerified) {
        if (run.finalization) (run.finalizationHistory ??= []).push(run.finalization);
        run.finalization = { context, round: randomUUID() };
        save();
      }
      if (!run.acceptance?.satisfied) {
        const answer = JSON.parse(
          await turn(
            'epic',
            `Judge original EPIC ${epic.repository}#${epic.epic} goal and acceptance conditions at ${context.head}: ${epic.originalGoal ?? epic.goal}\nConstraints ${JSON.stringify(epic.constraints)}\nResults ${JSON.stringify(epic.tasks)}\nVerified completions ${JSON.stringify(run.deliveries)}\nDo not infer goal success from closed Issues. Reply JSON {"satisfied":true,"criteria":["criterion and evidence"],"blockers":[]}.`,
          ),
        );
        if (
          typeof answer.satisfied !== 'boolean' ||
          !Array.isArray(answer.criteria) ||
          !answer.criteria.length ||
          !answer.criteria.every((x: unknown) => typeof x === 'string' && x.trim()) ||
          !Array.isArray(answer.blockers) ||
          !answer.blockers.every((x: unknown) => typeof x === 'string')
        )
          throw new Error('Expected professional criteria, evidence and blockers');
        run.acceptance = answer;
        save();
      }
      if (!run.acceptance!.satisfied || run.acceptance!.blockers.length) {
        run.status = 'blocked';
        save();
        return run;
      }
      if (!run.closureVerified && !run.request) {
        run.request = await turn(
          'orchestrator',
          `Present evidence and request one explicit human confirmation to close EPIC ${epic.repository}#${epic.epic}. Delivery version ${run.deliveryVersion}. Goal ${epic.originalGoal ?? epic.goal}; acceptance ${JSON.stringify(run.acceptance)}; deliveries ${JSON.stringify(run.deliveries)}; finalization ${JSON.stringify(run.finalization)}. Do not close without human confirmation.`,
        );
        save();
      }
      if (!run.closureVerified) run.status = 'awaiting_confirmation';
      if (decision && !run.closureVerified) {
        if (decision.epic !== epic.epic || decision.source !== 'human' || !decision.evidence.trim())
          throw new Error('Expected explicit human decision for this EPIC');
        if (decision.deliveryVersion && decision.deliveryVersion !== run.deliveryVersion)
          throw new Error('Human confirmation delivery version changed');
        run.decision = { ...decision, deliveryVersion: run.deliveryVersion };
        save();
      }
      if (!run.closureVerified && run.decision?.confirmed) {
        const current = await provider.finalizationContext();
        if (current.head !== context.head || current.changes !== context.changes)
          throw new Error(
            'Delivery changed before closure; obtain renewed acceptance and confirmation',
          );
        await provider.close(epic.epic);
        run.archive = join(home, 'accepted.json');
        writeFileSync(
          run.archive,
          JSON.stringify(
            {
              epic,
              acceptance: run.acceptance,
              deliveries: run.deliveries,
              finalization: run.finalization,
              decision: run.decision,
            },
            null,
            2,
          ),
        );
        run.closureVerified = true;
        run.acceptedHead = context.head;
        save();
      }
      if (run.closureVerified) {
        run.status = 'post_closure_finalization';
        if (owner)
          updateRunRegistry(config, (registry) => {
            const current = registry.runs.find((r) => r.id === owner.id)!;
            current.phase = 'post_closure_finalization';
            current.epicClosure = {
              deliveryVersion: run.deliveryVersion!,
              head: run.acceptedHead!,
              evidence: run.archive!,
              confirmed: run.decision!.evidence,
            };
          });
        save();
        if (owner) {
          run.finalization!.context.requireReport = true;
          run.finalization!.context.closureEvidence = run.archive;
          run.finalization!.context.acceptedVersions = {
            ...run.deliveries,
            integrated: run.acceptedHead!,
          };
        }
        await finalizeEpic(
          run.finalization!,
          epic.originalGoal ?? epic.goal,
          (role, brief, context) => turn(role, brief, context, true),
          save,
          retryFinalization ? undefined : run.finalizationHistory?.at(-1),
          provider.maintenance,
        );
        await acceptValidatedBusinessTurns(
          config,
          run.turns.filter((t) => !t.retired),
          'Validated EPIC acceptance, human closure, Pipeline disposition and report publication',
        );
        if (owner && run.finalization!.report) {
          updateRunRegistry(config, (registry) => {
            const current = registry.runs.find((r) => r.id === owner.id)!;
            current.report = run.finalization!.report;
            current.phase = 'completed';
            current.lifecycle = 'completed';
          });
          run.status = 'completed';
        }
      }
      delete run.error;
      save();
      return run;
    } catch (error) {
      run.status = 'blocked';
      run.error = String(error);
      save();
      throw error;
    }
  } finally {
    rmSync(lock, { recursive: true });
  }
}
