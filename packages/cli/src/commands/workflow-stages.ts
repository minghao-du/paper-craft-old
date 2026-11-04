import { createHash } from 'node:crypto';
/** Public Orchestrator-requested stage lifecycle; task choice remains with the caller. */
import { Command } from 'commander';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadFleetConfig, type FleetConfig } from '@paper-craft/core/workflow/fleet-config';
import { managedRunner } from '../workflow/composition.js';
import {
  inspectRuns,
  closeStageEpic,
  dispositionStagePipeline,
  publishStageReport,
  dispatchStage,
  collectBusinessTurn,
  acceptStageReceipt,
  retryStage,
  sendStageMessage,
  type StageRequest,
  type StageDispatch,
  type StageFacts,
} from '@paper-craft/core/workflow/run-driver';
import {
  executeDeliveryStage,
  deliveryFacts,
  stagePullRequests,
  type StagePullRequests,
} from '@paper-craft/core/workflow/stage-delivery';
import { output } from '../utils/output.js';

/** Controlled runners and external facts can be supplied by isolated CLI scenarios only. */
export interface StageBoundary {
  runner?: (provider: string) => ReturnType<typeof managedRunner>;
  pullRequests?: StagePullRequests;
  closure?: (
    config: FleetConfig,
    runId: string,
  ) => Promise<{ head: string; closed: boolean; evidence: string }>;
  facts?: (config: FleetConfig, dispatch: StageDispatch) => Promise<StageFacts>;
}

async function currentFacts(config: FleetConfig, dispatch: StageDispatch): Promise<StageFacts> {
  if (
    ![
      'planning',
      'implementation',
      'pr-quality',
      'pr-merge',
      'final-records',
      'integrated-acceptance',
      'pipeline-audit',
      'pipeline-refactor',
      'research-report',
    ].includes(dispatch.stage)
  )
    throw new Error('Stage requires a domain-specific authoritative acceptance operation');
  const attempt = dispatch.attempts.at(-1)!;
  const checkout = realpathSync(attempt.checkout);
  const owner = JSON.parse(readFileSync(join(checkout, '.pc-execution-owner'), 'utf8'));
  const registry = inspectRuns(config);
  const resource = registry.resources?.find((r) => realpathSync(r.path) === checkout);
  const currentRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: checkout,
    encoding: 'utf8',
  }).trim();
  return {
    currentRevision,
    ownership:
      owner.runId === dispatch.runId &&
      owner.registry === resource?.registry &&
      resource?.runId === dispatch.runId,
    evidence: `Current Git HEAD ${currentRevision}; checkout owner ${owner.runId}; registry ${owner.registry}`,
  };
}

/** Register supported dispatch, collection, disposition and scoped correction operations. */
export function registerStageCommands(
  workflow: Command,
  opts: { human: () => boolean },
  boundary: StageBoundary = {},
): void {
  const group = workflow
    .command('stage')
    .description('Orchestrator-selected stage assignments and correlated results');
  for (const operation of [
    'dispatch',
    'inspect',
    'collect',
    'accept',
    'retry',
    'message',
    'execute',
    'close',
    'pipeline',
    'publish',
  ]) {
    group
      .command(operation)
      .option('--config <file>', 'Authoritative Fleet configuration', '.epic-config.json')
      .requiredOption('--run <id>', 'Owning Run identity')
      .requiredOption('--authority <attempt>', 'Current Orchestrator attempt identity')
      .option(
        '--input <file>',
        'JSON assignment: subject, role, stage, inputRevision (Git HEAD), brief, prerequisites, checkout',
      )
      .option('--pr <number>', 'PR whose current external facts must match the assignment')
      .option('--dispatch <id>', 'Dispatch identity')
      .option('--receipt <id>', 'Receipt selected after reviewing collected evidence')
      .option(
        '--decision <file>',
        'Orchestrator domain acceptance rationale; current facts are verified separately',
      )
      .option(
        '--message-id <id>',
        'Stable correction identity (message), or correction covered by collection',
      )
      .option('--brief <file>', 'Scoped correction text')
      .option('--timeout-ms <number>', 'Collection deadline in milliseconds', '1000')
      .action(async (o) => {
        try {
          const config = loadFleetConfig(o.config);
          const registry = inspectRuns(config);
          const run = registry.runs.find((r) => r.id === o.run);
          if (
            !run ||
            run.lifecycle !== 'running' ||
            run.orchestratorId !== o.authority ||
            run.orchestrator?.status !== 'running'
          )
            throw new Error('Inactive or wrong Orchestrator authority');
          const runner = (boundary.runner ?? managedRunner)(run.provider);
          let result: unknown;
          if (operation === 'dispatch') {
            if (!o.input) throw new Error('Expected --input assignment JSON');
            const input = JSON.parse(readFileSync(o.input, 'utf8')) as StageRequest;
            if (
              input.stage === 'implementation' &&
              run.subject.kind === 'epic' &&
              !registry.dispatches?.some(
                (d) =>
                  d.runId === run.id &&
                  d.role === 'epic' &&
                  d.stage === 'planning' &&
                  d.lifecycle === 'accepted' &&
                  input.prerequisites?.includes(d.id),
              )
            )
              throw new Error(
                'EPIC Worker implementation requires its accepted planning prerequisite',
              );
            result = await dispatchStage(config, runner, {
              ...input,
              runId: run.id,
              authority: o.authority,
            });
          } else {
            const receipt = registry.receipts?.find((r) => r.id === o.receipt);
            const dispatch = registry.dispatches?.find(
              (d) => d.id === (o.dispatch ?? receipt?.dispatchId) && d.runId === run.id,
            );
            if (!dispatch) throw new Error('Expected Dispatch belonging to this Run');
            const attempt = dispatch.attempts.at(-1)!;
            if (operation === 'close') {
              if (!o.decision)
                throw new Error(
                  'Expected human confirmation and configured authoritative closure boundary',
                );
              result = await closeStageEpic(
                config,
                run.id,
                o.authority,
                dispatch.id,
                JSON.parse(readFileSync(o.decision, 'utf8')),
                async () => {
                  if (boundary.closure) return boundary.closure(config, run.id);
                  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
                    cwd: config.project,
                    encoding: 'utf8',
                  }).trim();
                  const state = execFileSync(
                    'gh',
                    [
                      'issue',
                      'view',
                      String(run.subject.number),
                      '--repo',
                      run.subject.repository,
                      '--json',
                      'state',
                    ],
                    { encoding: 'utf8' },
                  );
                  return {
                    head,
                    closed: JSON.parse(state).state === 'CLOSED',
                    evidence: `GitHub ${run.subject.repository}#${run.subject.number}: ${state}`,
                  };
                },
              );
            }
            if (operation === 'pipeline') {
              dispositionStagePipeline(config, run.id, o.authority, dispatch.id);
              result = { disposition: 'accepted' };
            }
            if (operation === 'publish') {
              if (!o.decision)
                throw new Error('Expected coordinator identity, entry and confirmed brief JSON');
              result = await publishStageReport(
                config,
                run.id,
                o.authority,
                dispatch.id,
                JSON.parse(readFileSync(o.decision, 'utf8')),
              );
            }
            if (operation === 'execute') {
              const pr = Number(o.pr);
              if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('Expected positive --pr');
              result = await executeDeliveryStage(
                config,
                dispatch,
                runner,
                pr,
                (boundary.pullRequests ?? stagePullRequests)(config, dispatch),
              );
            }
            if (operation === 'inspect')
              result = {
                dispatch,
                closureRequest:
                  dispatch.stage === 'integrated-acceptance'
                    ? {
                        head: dispatch.inputRevision,
                        deliveryVersion: createHash('sha256')
                          .update(
                            JSON.stringify({
                              head: dispatch.inputRevision,
                              deliveries:
                                registry.deliveries?.filter((d) => d.runId === run.id) ?? [],
                            }),
                          )
                          .digest('hex'),
                        epic: run.subject.number,
                      }
                    : undefined,
                receipts: registry.receipts?.filter((r) => r.dispatchId === dispatch.id),
                acknowledgements: registry.acknowledgements?.filter((a) =>
                  registry.receipts?.some(
                    (r) => r.id === a.receiptId && r.dispatchId === dispatch.id,
                  ),
                ),
              };
            if (operation === 'collect') {
              const timeoutMs = Number(o.timeoutMs);
              if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
                throw new Error('Expected nonnegative --timeout-ms');
              await collectBusinessTurn(config, runner, attempt, undefined, {
                timeoutMs,
                messageIds: o.messageId ? [o.messageId] : undefined,
              });
              result = inspectRuns(config).receipts?.filter((r) => r.dispatchId === dispatch.id);
            }
            if (operation === 'accept') {
              if (!receipt || !o.decision)
                throw new Error('Expected --receipt and --decision after reviewing result');
              const decision = readFileSync(o.decision, 'utf8').trim();
              if (!decision) throw new Error('Expected nonempty domain acceptance rationale');
              await acceptStageReceipt(
                config,
                o.authority,
                receipt.id,
                async (d, selectedReceipt) => {
                  const provider = (boundary.pullRequests ?? stagePullRequests)(config, d);
                  const specialized = [
                    'implementation',
                    'pr-quality',
                    'pr-merge',
                    'final-records',
                    'preservation-cleanup',
                  ].includes(d.stage)
                    ? await deliveryFacts(
                        config,
                        d,
                        Number(o.pr) || undefined,
                        provider,
                        selectedReceipt,
                      )
                    : undefined;
                  const facts = specialized ?? (await (boundary.facts ?? currentFacts)(config, d));
                  return {
                    ...facts,
                    evidence: `${facts.evidence}\nOrchestrator decision: ${decision}`,
                  };
                },
                runner,
              );
              result = { accepted: receipt.id };
            }
            if (operation === 'retry')
              result = await retryStage(
                config,
                runner,
                dispatch.id,
                o.authority,
                async (a) => !!(await runner.stopped?.(a)),
              );
            if (operation === 'message') {
              if (!o.messageId || !o.brief) throw new Error('Expected --message-id and --brief');
              await sendStageMessage(config, runner, dispatch.id, o.authority, {
                id: o.messageId,
                brief: readFileSync(o.brief, 'utf8'),
              });
              result = { dispatch: dispatch.id, message: o.messageId };
            }
          }
          output(result, opts.human());
        } catch (error) {
          output(
            { outcome: 'blocked', error: error instanceof Error ? error.message : String(error) },
            false,
          );
          process.exitCode = 2;
        }
      });
  }
}
