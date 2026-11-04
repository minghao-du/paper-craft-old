/** EPIC completion: verified deliveries, closure verification, pipeline disposition, and stage report publication. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { writeResearchReport, type ResearchReport } from '../delivery/research-report.js';
import { pipelineAccepted, type PipelineDisposition } from '../delivery/epic-finalization.js';
import type { FleetConfig } from '../fleet/fleet-config.js';
import {
  inspectRuns,
  updateRunRegistry,
  type WorkflowRun,
  type RunRegistry,
  type StageReceipt,
  type StageDispatch,
} from './run-registry.js';
import {
  epicChildSubjects,
  verifyEpicDeliveries,
} from './stage-execution.js';

function findDispatch(registry: RunRegistry, id: string): StageDispatch {
  const dispatch = registry.dispatches?.find((d) => d.id === id);
  if (!dispatch) throw new Error('Unknown Dispatch');
  return dispatch;
}

function authorize(
  registry: RunRegistry,
  runId: string,
  authority: string,
  allowCompleted = false,
): WorkflowRun {
  const run = registry.runs.find((r) => r.id === runId);
  if (
    !run ||
    run.orchestratorId !== authority ||
    (run.lifecycle !== 'running' && (!allowCompleted || run.lifecycle !== 'completed'))
  )
    throw new Error('Inactive or wrong Orchestrator authority');
  return run;
}

/** Actions seam for actual native EPIC closure, verification and head resolution. */
export interface EpicClosureActions {
  /** Resolve current Git HEAD */
  head?: () => Promise<string> | string;
  /** Check current GitHub issue state without modifying it */
  view?: () => Promise<{ state: string; number?: number }>;
  /** Execute actual close on GitHub */
  close?: () => Promise<void>;
}

/** Summary of an individual delivery associated with an EPIC or child Run. */
export type DeliverySummary = NonNullable<RunRegistry['deliveries']>[number];

/** Explicit human confirmation bound to delivery version on an EPIC Run. */
export interface HumanEpicConfirmation {
  /** Delivery fingerprint version. */
  deliveryVersion: string;
  /** Confirmation origin, must be human. */
  source: 'human';
  /** External evidence or reasoning string. */
  evidence: string;
}

/** Result of closing an EPIC run after verified delivery and human confirmation. */
export interface EpicClosureResult {
  /** Canonical delivery fingerprint of HEAD and deliveries. */
  deliveryVersion: string;
  /** Git commit HEAD at the time of closure. */
  head: string;
}

/** Result of pipeline disposition on an EPIC run. */
export interface PipelineDispositionResult {
  /** Recorded pipeline disposition. */
  disposition: PipelineDisposition;
  /** Git commit HEAD of the evaluated pipeline. */
  head: string;
}

/** Coordinator identification and input options for publishing a stage research report. */
export interface StageReportOptions {
  /** Coordinator agent identity. */
  identity: string;
  /** Report entry path or destination. */
  entry: string;
  /** Research brief or objective. */
  brief: string;
}

/** Result of publishing a stage research report. */
export type StageReportResult = ResearchReport;

/** Retrieve all completed or required deliveries associated with an EPIC run (including referenced external deliveries). */
export function epicDeliveries(
  registry: RunRegistry,
  runId: string,
): DeliverySummary[] {
  const children = epicChildSubjects(registry, runId);
  const allDeliveries = registry.deliveries ?? [];
  const result: DeliverySummary[] = [];

  for (const d of allDeliveries) {
    if (d.runId === runId) {
      result.push(d);
    }
  }

  for (const child of children) {
    const [repo, numStr] = child.split('#');
    const num = Number(numStr);
    const d = allDeliveries.find((del) => del.repository === repo && del.issue === num);
    if (
      d &&
      !result.some(
        (existing) =>
          existing === d || (existing.repository === d.repository && existing.issue === d.issue),
      )
    ) {
      result.push(d);
    }
  }

  result.sort((a, b) => {
    const repoCmp = a.repository.localeCompare(b.repository);
    if (repoCmp !== 0) return repoCmp;
    return a.issue - b.issue;
  });

  return result;
}

/** Canonical accepted delivery fingerprint for closure request, human consent, native close, and recorded closure. */
export function canonicalDeliveryFingerprint(head: string, deliveries: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ head, deliveries }))
    .digest('hex');
}

/** Record explicit human confirmation bound to delivery version on an EPIC Run. */
export function confirmStageEpic(
  config: FleetConfig,
  runId: string,
  authority: string,
  confirmation: HumanEpicConfirmation,
): void {
  const snapshot = inspectRuns(config);
  const run = authorize(snapshot, runId, authority);
  if (run.subject.kind !== 'epic') {
    throw new Error('Only EPIC runs accept delivery confirmation');
  }
  if (
    !confirmation ||
    confirmation.source !== 'human' ||
    !confirmation.deliveryVersion?.trim() ||
    !confirmation.evidence?.trim()
  ) {
    throw new Error('Explicit human confirmation with deliveryVersion and evidence required');
  }
  updateRunRegistry(config, (registry) => {
    const current = authorize(registry, runId, authority);
    current.humanConfirmation = confirmation;
  });
}

/** Invalidate cached human confirmation upon delivery revision changes. */
function invalidateHumanConfirmation(config: FleetConfig, runId: string): void {
  updateRunRegistry(config, (registry) => {
    const current = registry.runs.find((r) => r.id === runId);
    if (current?.humanConfirmation) delete current.humanConfirmation;
  });
}

/** Commit externally verified closure after accepted integrated goal judgment and delivery. */
export async function closeStageEpic(
  config: FleetConfig,
  runId: string,
  authority: string,
  dispatchId: string,
  confirmation?: HumanEpicConfirmation,
  observeOrActions?: (() => Promise<{ head: string; closed: boolean; evidence: string }>) | EpicClosureActions,
): Promise<EpicClosureResult> {
  const snapshot = inspectRuns(config);
  const run = authorize(snapshot, runId, authority);
  const dispatch = findDispatch(snapshot, dispatchId);
  verifyEpicDeliveries(snapshot, runId);
  const deliveries = epicDeliveries(snapshot, runId);

  if (run.subject.kind !== 'epic') {
    throw new Error('Issue-only Run cannot close or finalize parent EPIC');
  }

  if (run.epicClosure?.status === 'closed') {
    throw new Error(
      'EPIC has already been closed; registration that merely observes an already-closed Parent is not a substitute for actual closure',
    );
  }

  if (
    dispatch.runId !== runId ||
    dispatch.role !== 'epic' ||
    dispatch.stage !== 'integrated-acceptance' ||
    dispatch.lifecycle !== 'accepted'
  ) {
    throw new Error(
      'Active Orchestrator and accepted integrated Dispatch required before GitHub close',
    );
  }

  const receipt = snapshot.receipts!.find((r) => r.id === dispatch.acceptedReceipt)!;
  verifyRetainedStageEvidence(receipt);
  const judgment = JSON.parse(readFileSync(receipt.evidence[0].path, 'utf8'));
  if (
    judgment.satisfied !== true ||
    !judgment.criteria?.length ||
    !Array.isArray(judgment.blockers) ||
    judgment.blockers.length
  ) {
    throw new Error('Integrated goal remains unaccepted');
  }

  if (
    !deliveries.length ||
    deliveries.some((d) => d.status !== 'done' || !d.recorded || !d.released || !d.archive)
  ) {
    throw new Error(
      'Expected accepted integrated goal, completed delivery, current human confirmation and verified closure',
    );
  }

  const humanConf = confirmation ?? run.humanConfirmation;
  if (
    !humanConf ||
    humanConf.source !== 'human' ||
    !humanConf.evidence?.trim() ||
    !humanConf.deliveryVersion?.trim()
  ) {
    throw new Error(
      'Expected accepted integrated goal, completed delivery, current human confirmation and verified closure',
    );
  }

  if (typeof observeOrActions === 'function') {
    const facts = await observeOrActions();
    const version = canonicalDeliveryFingerprint(facts.head, deliveries);
    if (dispatch.inputRevision !== facts.head) {
      if (run.humanConfirmation) {
        invalidateHumanConfirmation(config, runId);
      }
      throw new Error('Delivery changed after acceptance; obtain renewed acceptance and confirmation');
    }
    if (humanConf.deliveryVersion !== version) {
      if (run.humanConfirmation) {
        invalidateHumanConfirmation(config, runId);
      }
      throw new Error(
        `Delivery version mismatch: expected ${version}, but received ${humanConf.deliveryVersion}. Prior confirmation invalidated.`,
      );
    }
    if (!facts.closed || !facts.evidence?.trim()) {
      throw new Error(
        'Expected accepted integrated goal, completed delivery, current human confirmation and verified closure',
      );
    }

    updateRunRegistry(config, (registry) => {
      const current = authorize(registry, runId, authority);
      if (registry.revision !== snapshot.revision)
        throw new Error('Registry changed during closure verification');
      current.epicClosure = {
        deliveryVersion: version,
        head: facts.head,
        evidence: facts.evidence,
        confirmed: humanConf.evidence,
        status: 'closed',
      };
      current.phase = 'post_closure_finalization';
      current.lifecycle = 'running';
      delete current.humanConfirmation;
    });
    return { deliveryVersion: version, head: facts.head };
  }

  const actions = observeOrActions ?? {};
  const projectCwd = config.project;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: projectCwd, encoding: 'utf8', timeout: 10000 }).trim();

  const head = await (actions.head ? actions.head() : git('rev-parse', 'HEAD'));
  if (dispatch.inputRevision !== head) {
    if (run.humanConfirmation) {
      invalidateHumanConfirmation(config, runId);
    }
    throw new Error('Delivery changed after acceptance; obtain renewed acceptance and confirmation');
  }

  const version = canonicalDeliveryFingerprint(head, deliveries);

  if (humanConf.deliveryVersion !== version) {
    if (run.humanConfirmation) {
      invalidateHumanConfirmation(config, runId);
    }
    throw new Error(
      `Delivery version mismatch: expected ${version}, but received ${humanConf.deliveryVersion}. Prior confirmation invalidated.`,
    );
  }

  const viewState = async (): Promise<{ state: string }> => {
    if (actions.view) return actions.view();
    const out = execFileSync(
      'gh',
      ['issue', 'view', String(run.subject.number), '--repo', run.subject.repository, '--json', 'state'],
      { cwd: projectCwd, encoding: 'utf8', timeout: 30000 },
    );
    return JSON.parse(out);
  };

  const closeIssue = async (): Promise<void> => {
    if (actions.close) return actions.close();
    execFileSync('gh', ['issue', 'close', String(run.subject.number), '--repo', run.subject.repository], {
      cwd: projectCwd,
      encoding: 'utf8',
      timeout: 30000,
    });
  };

  // Check if Parent was already closed BEFORE actual closure
  const before = await viewState();
  if (before && before.state?.toLowerCase() === 'closed') {
    throw new Error('Registration that merely observes an already-closed Parent is not a substitute for actual closure');
  }

  // Perform actual close with reconciliation of uncertain results
  let closeError: unknown;
  try {
    await closeIssue();
  } catch (err) {
    closeError = err;
  }

  if (closeError) {
    // Reconcile uncertain close result: check external state
    const reconciled = await viewState();
    if (reconciled && reconciled.state?.toLowerCase() === 'closed') {
      // Reconciled! Closed despite uncertainty
    } else {
      throw closeError;
    }
  }

  // Independently verify closed state
  const after = await viewState();
  if (!after || after.state?.toLowerCase() !== 'closed') {
    throw new Error('Expected verified actual closure; Parent remains open');
  }

  const evidence = `GitHub ${run.subject.repository}#${run.subject.number} actual closure`;

  updateRunRegistry(config, (registry) => {
    const current = authorize(registry, runId, authority);
    if (registry.revision !== snapshot.revision)
      throw new Error('Registry changed during closure verification');
    current.epicClosure = {
      deliveryVersion: version,
      head,
      evidence,
      confirmed: humanConf.evidence,
      status: 'closed',
    };
    current.phase = 'post_closure_finalization';
    current.lifecycle = 'running';
    delete current.humanConfirmation;
  });
  return { deliveryVersion: version, head };
}

/** Retain a validated accepted Pipeline result; receipt acceptance alone is insufficient. */
export function dispositionStagePipeline(
  config: FleetConfig,
  runId: string,
  authority: string,
  dispatchId: string,
): PipelineDispositionResult {
  let evaluatedResult: PipelineDisposition | undefined;
  let evaluatedHead: string | undefined;

  updateRunRegistry(config, (registry) => {
    const run = authorize(registry, runId, authority);
    const dispatch = findDispatch(registry, dispatchId);
    if (
      !run.epicClosure ||
      (run.epicClosure.status !== undefined && run.epicClosure.status !== 'closed') ||
      dispatch.runId !== runId ||
      !['pipeline-audit', 'pipeline-refactor'].includes(dispatch.role) ||
      dispatch.lifecycle !== 'accepted'
    )
      throw new Error('Expected accepted post-closure Pipeline receipt');
    const receipt = registry.receipts!.find((r) => r.id === dispatch.acceptedReceipt)!;
    verifyRetainedStageEvidence(receipt);
    const result = JSON.parse(
      readFileSync(receipt.evidence[0].path, 'utf8'),
    ) as PipelineDisposition;

    if (run.constraints?.kind === 'demo') {
      const roundRoot = dirname(config.project);
      const controlFile = join(roundRoot, 'control.json');
      const isCleanNoChanges =
        ['not_applicable', 'completed_no_changes'].includes(result.disposition) &&
        pipelineAccepted(result) &&
        result.head === run.epicClosure.head &&
        Object.values(result.inspectedVersions ?? {}).includes(run.epicClosure.head) &&
        (receipt.evidence?.length ?? 0) > 0;

      if (!isCleanNoChanges) {
        if (existsSync(controlFile)) {
          const control = JSON.parse(readFileSync(controlFile, 'utf8'));
          control.stopped = true;
          control.stoppedReason =
            result.disposition === 'changes_needed'
              ? 'Pipeline changes require retention; no repair or third delivery'
              : 'Pipeline disposition invalidates acceptance; retaining diagnostic round';
          writeFileSync(controlFile, JSON.stringify(control, null, 2));
        }
        throw new Error(
          result.disposition === 'changes_needed'
            ? 'Pipeline changes require retention; no repair or third delivery'
            : 'Pipeline disposition blocks reporting',
        );
      }
    }

    if (result.head !== run.epicClosure.head || !pipelineAccepted(result))
      throw new Error('Pipeline disposition blocks reporting');
    run.pipeline = result;
    evaluatedResult = result;
    evaluatedHead = run.epicClosure.head;
  });

  return {
    disposition: evaluatedResult!,
    head: evaluatedHead!,
  };
}

/** Publish an accepted bounded report through the normal transactional writer and complete business state. */
export async function publishStageReport(
  config: FleetConfig,
  runId: string,
  authority: string,
  dispatchId: string,
  coordinator: StageReportOptions,
): Promise<StageReportResult> {
  const snapshot = inspectRuns(config);
  const run = authorize(snapshot, runId, authority);
  const dispatch = findDispatch(snapshot, dispatchId);
  if (run.report) {
    throw new Error('Research report has already been published; cannot repeat publication');
  }
  if (
    !run.epicClosure ||
    (run.epicClosure.status !== undefined && run.epicClosure.status !== 'closed') ||
    !pipelineAccepted(run.pipeline) ||
    dispatch.runId !== runId ||
    dispatch.role !== 'research-state' ||
    dispatch.lifecycle !== 'accepted' ||
    dispatch.inputRevision !== run.epicClosure.head
  )
    throw new Error('Expected accepted current Research-State result after Pipeline');
  const receipt = snapshot.receipts!.find((r) => r.id === dispatch.acceptedReceipt)!;
  verifyRetainedStageEvidence(receipt);
  const result = JSON.parse(readFileSync(receipt.evidence[0].path, 'utf8'));
  if (
    result.status !== 'completed' ||
    typeof result.artifact !== 'string' ||
    !coordinator.identity.trim() ||
    !coordinator.brief.trim()
  )
    throw new Error('Expected completed report artifact and coordinator-provided judgments');
  if (
    createHash('sha256').update(readFileSync(result.artifact)).digest('hex') !== result.artifactHash
  )
    throw new Error('Report artifact changed since accepted result');

  if (run.constraints?.kind === 'demo') {
    const roundRoot = dirname(config.project);
    const roundFile = join(roundRoot, 'round.json');
    if (existsSync(roundFile)) {
      const round = JSON.parse(readFileSync(roundFile, 'utf8'));
      if (
        coordinator.identity !== round.config.coordinator ||
        coordinator.brief !== round.config.brief ||
        coordinator.entry !== round.entry ||
        realpathSync(round.research) !== round.research ||
        dirname(round.entry) !== round.research ||
        round.entry !== join(round.research, 'report.md')
      ) {
        throw new Error('Isolated physical report destination and operator coordinator configuration required');
      }
    }

    const artifactContent = readFileSync(result.artifact, 'utf8');
    const hasSummaryValues =
      /\b10\b/.test(artifactContent) &&
      /\b55\b/.test(artifactContent) &&
      /\b100\b/.test(artifactContent);
    const hasReferences = /#\d+|PR\s*\d+|Issue\s*\d+/i.test(artifactContent);
    const hasPipelineConclusion = /(not_applicable|completed_no_changes|pipeline)/i.test(artifactContent);

    if (!hasSummaryValues || !hasReferences || !hasPipelineConclusion) {
      throw new Error('Demo report does not satisfy required checks, baseline values, or sections');
    }
  }
  const observedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: config.project,
    encoding: 'utf8',
  }).trim();
  if (observedHead !== run.epicClosure.head)
    throw new Error('Integrated revision changed before report publication');
  const report = await writeResearchReport(
    coordinator,
    {
      objective: run.subject.body,
      acceptedVersions: { integrated: run.epicClosure.head },
      observedVersions: { integrated: dispatch.inputRevision },
      pipeline: run.pipeline,
      closureEvidence: run.epicClosure.evidence,
    },
    async (brief) => {
      const candidate = brief.match(/candidate report (.*?); do not/)![1];
      writeFileSync(candidate, readFileSync(result.artifact));
      return receipt.evidence.map((e) => e.path);
    },
  );
  updateRunRegistry(config, (registry) => {
    const current = authorize(registry, runId, authority);
    if (registry.revision !== snapshot.revision)
      throw new Error('Registry changed during report publication');
    current.report = report;
    current.phase = 'completed';
    current.lifecycle = 'completed';
    if (current.constraints?.kind === 'demo') {
      const roundRoot = dirname(config.project);
      const controlFile = join(roundRoot, 'control.json');
      if (existsSync(controlFile)) {
        const control = JSON.parse(readFileSync(controlFile, 'utf8'));
        control.completed = true;
        writeFileSync(controlFile, JSON.stringify(control, null, 2));
      }
    }
  });
  return report;
}

function verifyRetainedStageEvidence(receipt: StageReceipt): void {
  if (
    !receipt.evidence.length ||
    receipt.evidence.some(
      (e) => createHash('sha256').update(readFileSync(e.path)).digest('hex') !== e.hash,
    )
  )
    throw new Error('Accepted stage evidence changed');
}
