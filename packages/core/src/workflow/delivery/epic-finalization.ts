/** Specialist contracts for post-merge EPIC finalization, using existing managed turns. */
import { dirname, isAbsolute } from 'node:path';
import { writeResearchReport, type ResearchReport } from './research-report.js';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import type { IssueTurn } from './issue-driver.js';

const text = z.string().trim().min(1);
const disposition = z.object({ run: z.boolean(), reason: text, reuse: z.boolean().optional() });
const planSchema = z.object({
  pipeline: disposition,
  research: disposition,
  coordinator: z
    .object({
      identity: text,
      entry: text.refine(isAbsolute, 'Expected absolute research entry'),
      brief: text,
    })
    .optional(),
});
const receiptSchema = z.object({
  head: text,
  status: z.enum(['completed', 'blocked']),
  evidence: z.array(text).min(1),
  blockers: z.array(text),
  scope: z.array(text),
  checks: z.array(text),
  artifacts: z.array(text),
  limitations: z.array(text),
});
const pipelineSchema = receiptSchema.extend({
  disposition: z.enum([
    'not_applicable',
    'completed_no_changes',
    'completed',
    'changes_needed',
    'acceptance_invalidated',
  ]),
  inspectedVersions: z.record(text, text).refine((v) => Object.keys(v).length > 0),
  findings: z.array(
    z.object({
      id: text,
      classification: z.enum([
        'required_maintenance',
        'unrelated_defect',
        'invalidates_acceptance',
      ]),
      description: text,
      evidence: z.array(text).min(1),
      issue: z.number().int().positive().optional(),
      migrationLedger: text.optional(),
    }),
  ),
  maintenance: z.array(
    z.object({
      finding: text,
      issue: z.number().int().positive(),
      delivered: z.boolean(),
      verifiedVersions: z.record(text, text),
      evidence: z.array(text),
    }),
  ),
});
/** Version-bound Pipeline audit contract shared with maintenance delivery and reporting. */
export type PipelineDisposition = z.infer<typeof pipelineSchema>;
/** Only explicit, evidence-backed dispositions unlock the report writer. */
export function pipelineAccepted(result: PipelineDisposition | undefined): boolean {
  if (
    !result ||
    !pipelineSchema.safeParse(result).success ||
    result.status !== 'completed' ||
    result.blockers.length ||
    !result.evidence.length ||
    !Object.keys(result.inspectedVersions).length ||
    result.findings.some((f) => f.classification === 'invalidates_acceptance')
  )
    return false;
  if (result.findings.some((f) => f.classification === 'unrelated_defect' && !f.issue))
    return false;
  const required = result.findings.filter((f) => f.classification === 'required_maintenance');
  if (result.disposition === 'not_applicable' || result.disposition === 'completed_no_changes')
    return (
      required.length === 0 &&
      (result.disposition !== 'completed_no_changes' || result.checks.length > 0)
    );
  return (
    result.disposition === 'completed' &&
    required.every((f) =>
      result.maintenance.some(
        (m) =>
          m.finding === f.id &&
          m.issue === f.issue &&
          m.delivered &&
          m.evidence.length > 0 &&
          Object.keys(m.verifiedVersions).length > 0,
      ),
    )
  );
}
/** Host connects bounded maintenance to the ordinary Worker/PR-Land lifecycle. */
export interface PipelineMaintenanceProvider {
  identify(finding: PipelineDisposition['findings'][number]): Promise<number>;
  approveMigration(
    issue: number,
    ledger: string,
  ): Promise<{ source: 'human'; ledger: string; evidence: string } | undefined>;
  deliver(
    issue: number,
    finding: PipelineDisposition['findings'][number],
  ): Promise<{ status: 'done'; pr: number; version: string; evidence: string }>;
}
/** Verified integrated code and actual per-PR changes; never inferred from a single range. */
export interface FinalizationContext {
  head: string;
  checkout: string;
  terminalSession: string;
  changes: string;
  /** Additional local writing roots for the research writer only. */
  writableDirectories?: string[];
  /** Managed closure requires verified transactional reporting, even without scientific impact. */
  requireReport?: boolean;
  acceptedVersions?: Record<string, string>;
  observedVersions?: Record<string, string>;
  closureEvidence?: string;
}
/** Durable specialist results supplement, rather than replace, managed attempt records. */
export interface EpicFinalization {
  context: FinalizationContext;
  report?: ResearchReport;
  /** Distinguishes explicit retries at the same integrated SHA. */
  round?: string;
  plan?: z.infer<typeof planSchema>;
  pipeline?: PipelineDisposition;
  maintenanceDeliveries?: Record<
    string,
    {
      issue: number;
      pr: number;
      version: string;
      evidence: string;
      approval?: { source: 'human'; ledger: string; evidence: string };
    }
  >;

  research?: z.infer<typeof receiptSchema> | { status: 'skipped'; reason: string };
}
/** Sequentially obtain professional applicability and verified specialist results. */
export async function finalizeEpic(
  state: EpicFinalization,
  objective: string,
  turn: (role: IssueTurn['role'], brief: string, context?: FinalizationContext) => Promise<string>,
  save: () => void,
  previous?: EpicFinalization,
  maintenance?: PipelineMaintenanceProvider,
): Promise<void> {
  const context = JSON.stringify({ ...state.context, round: state.round });
  state.plan ??= planSchema.parse(
    JSON.parse(
      await turn(
        'epic',
        `Read project AGENTS.md and load finalization.md from the installed /pc-orchestrator skill directory. Confirm applicability for post-merge EPIC finalization against original objective ${objective}. Verified context ${context}. Previous round ${JSON.stringify(previous)}. Compare intervening changes; set reuse:true only for a previously completed specialist whose checks and conclusions remain unaffected, with concrete evidence in reason. Inspect actual PR paths and dependencies. Reply only JSON {"pipeline":{"run":true,"reason":"scope evidence"},"research":{"run":true,"reason":"scientific impact evidence"},"coordinator":{"identity":"designated Project coordinator","entry":"absolute shared research entry","brief":"coordinator-provided or confirmed judgments, evidence and requested updates"}}. Omit coordinator only when research is skipped. Do not assume coordination authority: unresolved coordinator or scientific decisions must block, not be invented. Only skip with concrete evidence.`,
      ),
    ),
  );
  save();
  if ((state.plan.research.run || state.context.requireReport) && !state.plan.coordinator)
    throw new Error(
      'Research finalization requires designated coordinator and confirmed writing brief',
    );
  const schema =
    'Reply only JSON {"head":"evaluated integration SHA","status":"completed|blocked","evidence":["inspected evidence locations"],"blockers":[],"scope":[],"checks":[],"artifacts":[],"limitations":[]}. Account for every required check and requested update. Missing required evidence is blocking; retain unresolved research questions explicitly without promoting them to conclusions.';
  for (const kind of ['pipeline', 'research'] as const) {
    const decision = state.plan[kind];
    if (kind === 'pipeline') {
      // Applicability is itself an audit: a planning skip can never bypass the specialist.
      if (!state.pipeline) {
        state.pipeline = pipelineSchema.parse(
          JSON.parse(
            await turn(
              'pipeline-audit',
              `Read project AGENTS.md; invoke /pc-pipeline-refactor for a bounded post-closure applicability/audit only. Never implement through your own subagents. Objective ${objective}. Verified context ${context}. Inspect affected structural scope and record actual versions and evidence. Return unrelated defects as linked follow-up Issues and report limitations; acceptance-invalidating findings require human disposition. Required maintenance is delivered by Worker/PR-Land, with approved Migration Ledger before covered mutations. Reply JSON with head, status (completed|blocked), evidence, blockers, scope, checks, artifacts, limitations, disposition (not_applicable|completed_no_changes|completed|changes_needed|acceptance_invalidated), inspectedVersions (repository-to-version map), findings [{id,classification:required_maintenance|unrelated_defect|invalidates_acceptance,description,evidence,issue,migrationLedger (exact ledger version required for covered moves/deletions)}], maintenance [{finding,issue,delivered,verifiedVersions,evidence}]. not_applicable requires inspected evidence, completed_no_changes requires an actual audit. Changes-needed stays pending until all required fixes are delivered and specialist-verified.`,
              state.context,
            ),
          ),
        );
        save();
      }
      if (state.pipeline.disposition === 'changes_needed' && maintenance) {
        state.maintenanceDeliveries ??= {};
        for (const finding of state.pipeline.findings.filter(
          (f) => f.classification === 'required_maintenance',
        )) {
          finding.issue ??= await maintenance.identify(finding);
          if (!Number.isSafeInteger(finding.issue) || finding.issue < 1)
            throw new Error('Maintenance requires a bounded linked Issue');
          save();
          if (state.maintenanceDeliveries[finding.id]) continue;
          const approval = finding.migrationLedger
            ? await maintenance.approveMigration(finding.issue, finding.migrationLedger)
            : undefined;
          if (
            finding.migrationLedger &&
            (!approval ||
              approval.source !== 'human' ||
              approval.ledger !== finding.migrationLedger ||
              !approval.evidence.trim())
          )
            throw new Error(
              'Migration Ledger requires explicit human approval before Worker mutation',
            );
          const delivered = await maintenance.deliver(finding.issue, finding);
          if (
            delivered.status !== 'done' ||
            !delivered.pr ||
            !delivered.version ||
            !delivered.evidence
          )
            throw new Error('Maintenance delivery remains pending');
          state.maintenanceDeliveries[finding.id] = {
            ...delivered,
            issue: finding.issue,
            approval,
          };
          save();
        }
        const verified = pipelineSchema.parse(
          JSON.parse(
            await turn(
              'pipeline-audit',
              `Invoke /pc-pipeline-refactor to verify only the required structural findings after Worker/PR-Land delivery. Do not implement. Original audit ${JSON.stringify(state.pipeline)}. Complete merge, final records, archive and cleanup evidence ${JSON.stringify(state.maintenanceDeliveries)}. Verify actual delivered versions and applicable local/remote evidence; unresolved fixes stay changes_needed. Reply using the original PipelineDisposition JSON contract with maintenance delivered and verifiedVersions, head ${state.context.head}.`,
              state.context,
            ),
          ),
        );
        if (
          verified.findings.some(
            (f) =>
              f.classification === 'required_maintenance' &&
              !state.pipeline!.findings.some((original) => original.id === f.id),
          )
        )
          throw new Error('Verification expanded maintenance scope');
        for (const original of state.pipeline.findings.filter(
          (f) => f.classification === 'required_maintenance',
        )) {
          const delivery = state.maintenanceDeliveries[original.id];
          if (
            !verified.findings.some((f) => f.id === original.id && f.issue === original.issue) ||
            !verified.maintenance.some(
              (m) =>
                m.finding === original.id &&
                m.issue === original.issue &&
                Object.values(m.verifiedVersions).includes(delivery.version),
            )
          )
            throw new Error('Verification must retain and verify every delivered finding');
        }
        state.pipeline = verified;
        save();
      }
      if (state.pipeline.head !== state.context.head || !pipelineAccepted(state.pipeline))
        throw new Error(
          'Pipeline disposition pending: required maintenance, verification or human disposition blocks reporting',
        );
      continue;
    }
    if (state.context.requireReport && !state.report) {
      if (!state.context.closureEvidence || !pipelineAccepted(state.pipeline))
        throw new Error(
          'Verified closure and accepted Pipeline disposition required for reporting',
        );
      state.report = await writeResearchReport(
        state.plan.coordinator!,
        {
          objective,
          acceptedVersions: state.context.acceptedVersions ?? {},
          observedVersions: state.context.observedVersions ?? {
            checkout: execFileSync('git', ['-C', state.context.checkout, 'rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim(),
          },
          pipeline: state.pipeline!,
          closureEvidence: state.context.closureEvidence,
        },
        async (brief, writableDirectories) => {
          const result = receiptSchema.parse(
            JSON.parse(
              await turn('research-state', brief, { ...state.context, writableDirectories }),
            ),
          );
          if (
            result.status !== 'completed' ||
            result.blockers.length ||
            result.head !== state.context.head
          )
            throw new Error('Research receipt failed validation');
          return result.evidence;
        },
      );
      state.research = {
        ...state.pipeline!,
        artifacts: [state.report.path],
        evidence: state.report.evidence,
      };
      save();
    }
    if (!state[kind]) {
      if (decision.reuse) {
        const prior = previous?.[kind];
        if (!decision.run || !prior || prior.status !== 'completed' || prior.blockers.length)
          throw new Error(
            'Reuse requires a previously completed specialist and unaffected-scope evidence',
          );
        state[kind] = {
          ...prior,
          head: state.context.head,
          limitations: [
            ...prior.limitations,
            `Reused from ${previous!.context.head}: ${decision.reason}`,
          ],
        };
      } else if (!decision.run) state[kind] = { status: 'skipped', reason: decision.reason };
      else {
        const skill = 'pc-research-state';
        const raw = await turn(
          'research-state',
          `Read project AGENTS.md and load finalization.md from the installed /pc-orchestrator skill directory; invoke /${skill} for EPIC post-merge finalization. Objective ${objective}. Context ${context}. Applicability ${decision.reason}. ${`Coordinator-approved writing brief ${JSON.stringify(state.plan.coordinator)}. Pipeline result ${JSON.stringify(state.pipeline)}. Coordinate serial writing with that designated Project coordinator, including other Fleets; do not write until prior writer has returned. Read finalization.md from the installed /pc-research-state skill directory.`} ${schema}`,
          { ...state.context, writableDirectories: [dirname(state.plan.coordinator!.entry)] },
        );
        state[kind] = receiptSchema.parse(JSON.parse(raw));
        save();
      }
      save();
    }
    const receipt = state[kind]!;
    if (
      receipt.status !== 'skipped' &&
      (receipt.head !== state.context.head ||
        receipt.status !== 'completed' ||
        receipt.blockers.length)
    )
      throw new Error(
        `${kind} finalization blocked or evaluated a different SHA; retain original attempt and route repair through EPIC`,
      );
  }
}
