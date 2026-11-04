import { execFileSync } from 'node:child_process';
import { startupRecoveryStatus } from '@paper-craft/core/workflow/startup';
import {
  startRun,
  inspectRuns,
  recoverRun,
  stopRun,
  releaseRun,
  orchestratorForSubject,
  closeStageEpic,
  type EpicClosureActions,
  type WorkflowRun,
  type RunRegistry,
} from '@paper-craft/core/workflow/run-driver';
import { recoverAllRuns } from '@paper-craft/core/workflow/recovery';
import { finishEpic } from '../workflow/epic-completion.js';
import { landDelivery } from '@paper-craft/core/workflow/postmerge';
import { registerStageCommands } from './workflow-stages.js';
import { registerSubagentCommands } from './workflow-subagents.js';
/** Portable workflow CLI shared by agents with filesystem and command execution access. */
import { Command, Option } from 'commander';
import { loadFleetConfig, type FleetConfig } from '@paper-craft/core/workflow/fleet-config';
import { preserveState } from '@paper-craft/core/workflow/handoff';
import { checkFleet, checkReclaim } from '@paper-craft/core/workflow/fleet';
import { quote } from '@paper-craft/core/workflow/runtime';
import { managedRunner } from '../workflow/composition.js';
import { inspectEpicRun } from '@paper-craft/core/workflow/epic-driver';
import { readIssue } from '@paper-craft/core/workflow/issue-driver';
import { GitHubPullRequests } from '@paper-craft/core/workflow/pr-driver';
import { inspectIssueRun } from '@paper-craft/core/workflow/issue-driver';
import { readFileSync, existsSync } from 'node:fs';
import { output } from '../utils/output.js';
import { conciseError, diagnosticError } from '../workflow/diagnostics.js';

interface Options {
  config: string;
  fetch?: boolean;
  dir?: string;
  reason?: string;
  detailed?: boolean;
}

/** Controlled runners can be supplied by isolated CLI scenarios. */
export interface WorkflowBoundary {
  runner?: (provider: string) => ReturnType<typeof managedRunner>;
}

function configured(command: Command): Command {
  return command.option(
    '--config <file>',
    'Authoritative Fleet configuration',
    '.epic-config.json',
  );
}

function run(action: () => void): void {
  try {
    action();
  } catch (error) {
    output(
      { status: 'unknown', error: error instanceof Error ? error.message : String(error) },
      false,
    );
    process.exitCode = 2;
  }
}

async function inspection(
  run: WorkflowRun,
  config: FleetConfig,
  detailed = true,
  registry?: RunRegistry,
  getRunner: (provider: string) => ReturnType<typeof managedRunner> = managedRunner,
) {
  const attempt = run.orchestrator;
  let usable = false;
  if (attempt?.address && attempt.terminalSession) {
    try {
      const observation = await getRunner(run.provider).observe?.(attempt);
      usable = !!observation && ['running', 'idle', 'waiting'].includes(observation.status);
    } catch {
      /* Unverified terminals remain inspectable through evidence only. */
    }
  }
  return {
    run: run.id,
    lifecycle: run.lifecycle,
    attempt: attempt?.id,
    attemptStatus: attempt?.status,
    activationStatus: attempt?.startupGate ? (attempt.activation?.status ?? 'pending') : undefined,
    startupRecovery: startupRecoveryStatus(
      config,
      run.id,
      registry ?? { revision: 0, runs: [run] },
    ),
    cause: detailed ? attempt?.error : attempt?.error ? conciseError(attempt.error) : undefined,
    evidenceDirectory: attempt?.directory,
    context: run.brief,
    statusCommand: `pc workflow orchestrator status --config ${quote(config.file)}`,
    recoverCommand: `pc workflow orchestrator recover ${run.id} --config ${quote(config.file)}`,
    ...(usable
      ? { attachCommand: `tmux attach-session -t ${quote(attempt!.terminalSession!)}` }
      : {}),
  };
}

function attemptSummary(attempt: WorkflowRun['orchestrator']) {
  if (!attempt) return undefined;
  return {
    ...attempt,
    error: attempt.error ? conciseError(attempt.error) : undefined,
    brief: undefined,
    startupFailures: undefined,
    initialization: undefined,
    activation: attempt.activation ? { ...attempt.activation, brief: undefined } : undefined,
  };
}

function statusSummary(registry: RunRegistry) {
  return {
    outcome: 'succeeded',
    revision: registry.revision,
    runs: registry.runs.map((run) => {
      return {
        ...run,
        requirements: undefined,
        priorOrchestrators: undefined,
        subject: { ...run.subject, body: undefined },
        reconciliation: run.reconciliation
          ? { ...run.reconciliation, blockers: run.reconciliation.blockers.map(conciseError) }
          : undefined,
        orchestrator: attemptSummary(run.orchestrator),
      };
    }),
    dispatches: registry.dispatches?.map((dispatch) => {
      return {
        ...dispatch,
        brief: undefined,
        attempts: dispatch.attempts.map(attemptSummary),
        messages: dispatch.messages
          ?.filter((message) => message.status !== 'completed')
          .map((message) => ({
            ...message,
            brief: undefined,
            reference: { dispatch: dispatch.id, message: message.id },
          })),
      };
    }),
    receipts: registry.receipts?.filter(
      (receipt) => !registry.acknowledgements?.some((ack) => ack.receiptId === receipt.id),
    ),
    resources: registry.resources,
    subjects: registry.subjects,
    pullRequests: registry.pullRequests,
    deliveries: registry.deliveries,
  };
}

/** Register workflow file operations and read-only fleet checks, with JSON output by default. */
export function registerWorkflowCommands(
  program: Command,
  opts: { human: () => boolean },
  boundary: WorkflowBoundary = {},
): void {
  const getRunner = boundary.runner ?? managedRunner;
  const workflow = program
    .command('workflow')
    .description('Portable file-based task handoff and preservation');
  configured(workflow.command('root').description('Resolve the configured clone root'))
    .option('--path', 'Print only the path for shell assignment')
    .action((options: Options & { path?: boolean }) =>
      run(() => {
        const config = loadFleetConfig(options.config);
        if (options.path) console.log(config.root);
        else output({ path: config.root }, opts.human());
      }),
    );
  registerSubagentCommands(workflow, opts);
  registerStageCommands(workflow, opts, boundary);
  const orchestrator = workflow
    .command('orchestrator')
    .description('Create or inspect a subject-scoped managed Run');
  configured(
    orchestrator
      .command('status')
      .description('Read concise current Runs, pending work and resource ownership')
      .option(
        '--detailed',
        'Return the complete current structured result; logs remain referenced',
      ),
  ).action(async (options: Options) => {
    try {
      const config = loadFleetConfig(options.config);
      const registry = inspectRuns(config);
      output(
        {
          ...(options.detailed ? registry : statusSummary(registry)),
          inspection: await Promise.all(
            registry.runs.map(async (entry) => ({
              ...(await inspection(entry, config, !!options.detailed, registry, getRunner)),
              ...(!options.detailed
                ? diagnosticError(
                    config,
                    entry.orchestrator?.error,
                    { command: 'status', run: entry.id, attempt: entry.orchestrator?.id },
                    false,
                  )
                : {}),
            })),
          ),
        },
        opts.human(),
      );
    } catch (error) {
      output(
        {
          outcome: 'failed',
          status: 'unknown',
          error: error instanceof Error ? error.message : String(error),
        },
        opts.human(),
      );
      process.exitCode = 2;
    }
  });
  configured(
    orchestrator
      .command('start <issue>')
      .description(
        'Create or reconnect a Run; automatically reconcile pending startup in the background',
      )
      .option('--detailed', 'Return the complete current structured result; logs remain referenced')
      .requiredOption('--provider <provider>', 'Managed provider: codex, agy, or claude')
      .option(
        '--dangerously-skip-permissions',
        'Auto-approve agy tool permissions for this Run (agy only)',
      )
      .option('--requirements <text>', 'Immutable additional Run Requirements')
      .option('--requirements-file <file>', 'Read immutable Run Requirements from a UTF-8 file')
      .option('--demo-round <id>', 'Bind Run to an armed Demo round')
      .option('--demo-config <file>', 'Demo configuration file for Demo-constrained Run')
      .addOption(
        new Option('--type <type>', 'Subject type; must match the title EPIC marker')
          .choices(['issue', 'epic'])
          .makeOptionMandatory(),
      ),
  ).action(
    async (
      number: string,
      options: Options & {
        provider: string;
        type: 'issue' | 'epic';
        requirements?: string;
        requirementsFile?: string;
        dangerouslySkipPermissions?: boolean;
        demoRound?: string;
        demoConfig?: string;
      },
    ) => {
      let config: FleetConfig | undefined;
      let subjectReference: string | undefined;
      let startupInvoked = false;
      try {
        if (options.dangerouslySkipPermissions && options.provider !== 'agy')
          throw new Error('--dangerously-skip-permissions requires --provider agy');
        if (options.requirements !== undefined && options.requirementsFile !== undefined)
          throw new Error('Use only one of --requirements or --requirements-file');
        let requirements = options.requirements;
        if (options.requirementsFile !== undefined) {
          try {
            requirements = readFileSync(options.requirementsFile, 'utf8');
          } catch (error) {
            throw new Error(
              `Cannot read Requirements file ${options.requirementsFile}; provide a readable UTF-8 file`,
              { cause: error },
            );
          }
        }
        config = loadFleetConfig(options.config);
        const subject = readIssue(config.project, Number(number));
        subjectReference = `${subject.repository}#${subject.number}`;
        const kind = /\bEPIC\b/i.test(subject.title) ? 'epic' : 'issue';
        if (options.type !== kind)
          throw new Error(
            `Type mismatch: --type ${options.type}, but title ${JSON.stringify(subject.title)} identifies ${kind}; correct the title or --type before retrying`,
          );
        startupInvoked = true;
        const constraints = options.demoRound
          ? {
              kind: 'demo' as const,
              roundId: options.demoRound,
              demoConfigPath: options.demoConfig,
            }
          : undefined;
        const result = await (constraints !== undefined
          ? startRun(
              config,
              getRunner(options.provider),
              { ...subject, kind },
              options.provider,
              requirements,
              options.dangerouslySkipPermissions,
              constraints,
            )
          : startRun(
              config,
              getRunner(options.provider),
              { ...subject, kind },
              options.provider,
              requirements,
              options.dangerouslySkipPermissions,
            ));
        const diagnostics = diagnosticError(config, result.orchestrator?.error, {
          command: 'start',
          run: result.id,
          attempt: result.orchestrator?.id,
          subject: subjectReference,
        });
        output(
          {
            ...(options.detailed ? result : {}),
            ...(await inspection(result, config, !!options.detailed)),
            ...diagnostics,
            outcome:
              result.orchestrator?.startupGate &&
              result.orchestrator.activation?.status !== 'delivered'
                ? 'pending'
                : result.lifecycle === 'running'
                  ? 'succeeded'
                  : 'blocked',
            ...(!options.detailed
              ? {
                  blockers: result.reconciliation?.blockers?.map(conciseError) ?? [],
                  observation: result.orchestrator?.observation,
                  evidence: result.orchestrator?.evidence,
                }
              : {}),
          },
          opts.human(),
        );
        if (result.lifecycle !== 'running') process.exitCode = 2;
      } catch (error) {
        let current: WorkflowRun | undefined;
        if (config && startupInvoked && subjectReference) {
          try {
            current = inspectRuns(config).runs.find(
              (entry) =>
                `${entry.subject.repository}#${entry.subject.number}` === subjectReference &&
                entry.provider === options.provider &&
                entry.lifecycle !== 'completed',
            );
          } catch {
            /* No verified state is available; do not repeat startup. */
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        const diagnostics = diagnosticError(config, message, {
          command: 'start',
          subject: subjectReference,
          run: current?.id,
          attempt: current?.orchestrator?.id,
        });
        output(
          {
            outcome: 'failed',
            status: 'unknown',
            ...(current && config
              ? {
                  ...(await inspection(current, config, !!options.detailed)),
                  blockers: current.reconciliation?.blockers.map(conciseError) ?? [],
                  observation: current.orchestrator?.observation,
                  evidence: current.orchestrator?.evidence,
                }
              : {}),
            ...diagnostics,
            ...(options.detailed ? { error: message } : {}),
          },
          opts.human(),
        );
        process.exitCode = 2;
      }
    },
  );
  configured(
    orchestrator
      .command('recover <run>')
      .description('Recover late startup evidence; report concise outcome and retained occupancy')
      .option('--detailed', 'Return the complete current structured result; logs remain referenced')
      .option('--replace', 'Replace Orchestrator only after verified termination'),
  ).action(async (id: string, options: Options & { replace?: boolean }) => {
    let config: FleetConfig | undefined;
    let current: WorkflowRun | undefined;
    try {
      config = loadFleetConfig(options.config);
      current = inspectRuns(config).runs.find((run) => run.id === id);
      if (!current) throw new Error(`Unknown Run: expected existing run with id ${id}`);
      const runner = getRunner(current.provider);
      const result = await recoverRun(config, runner, id, {
        replaceOrchestrator: options.replace,
        stopped: (attempt) => runner.stopped(attempt),
      });
      current = inspectRuns(config).runs.find((entry) => entry.id === id)!;
      const diagnostics = [current.orchestrator?.error, ...result.blockers]
        .filter((error): error is string => !!error && conciseError(error) !== error)
        .map((error) =>
          diagnosticError(config, error, {
            command: 'recover',
            run: id,
            attempt: current?.orchestrator?.id,
          }),
        );
      output(
        {
          ...result,
          blockers: options.detailed ? result.blockers : result.blockers.map(conciseError),
          inspection: await inspection(current, config, !!options.detailed, undefined, getRunner),
          ...(diagnostics.length
            ? {
                diagnostics: diagnostics.some((entry) => entry.diagnostics?.length)
                  ? diagnostics.map((entry) => entry.diagnostics ?? []).flat()
                  : undefined,
                diagnosticSaveError:
                  diagnostics
                    .map((entry) => entry.diagnosticSaveError)
                    .filter(Boolean)
                    .join('; ') || undefined,
              }
            : {}),
          outcome: result.blockers.length
            ? 'blocked'
            : current.orchestrator?.startupGate &&
                current.orchestrator.activation?.status !== 'delivered'
              ? 'pending'
              : 'succeeded',
          observation: current.orchestrator?.observation,
          evidence: current.orchestrator?.evidence,
          reconciliation: current.reconciliation
            ? {
                ...current.reconciliation,
                blockers: options.detailed
                  ? current.reconciliation.blockers
                  : current.reconciliation.blockers.map(conciseError),
              }
            : undefined,
        },
        opts.human(),
      );
      if (result.blockers.length) process.exitCode = 2;
    } catch (error) {
      // Recovery may have persisted new state before failing. Inspect without retrying work.
      if (config) {
        try {
          current = inspectRuns(config).runs.find((entry) => entry.id === id) ?? current;
        } catch {
          /* Retain the last verified state; failure is not evidence of termination. */
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      output(
        {
          outcome: 'failed',
          status: 'unknown',
          ...(current && config
            ? {
                inspection: await inspection(current, config, !!options.detailed),
                observation: current.orchestrator?.observation,
                evidence: current.orchestrator?.evidence,
              }
            : {}),
          ...diagnosticError(config, message, {
            command: 'recover',
            run: id,
            attempt: current?.orchestrator?.id,
          }),
          ...(options.detailed ? { error: message } : {}),
        },
        opts.human(),
      );
      process.exitCode = 2;
    }
  });
  configured(
    orchestrator
      .command('recover-all')
      .description('Reconcile each incomplete Run; report unowned work as blocked'),
  ).action(async (options: Options) => {
    try {
      const result = await recoverAllRuns(loadFleetConfig(options.config), getRunner);
      output(result, opts.human());
      if (result.status === 'unknown') process.exitCode = 2;
    } catch (error) {
      run(() => {
        throw error;
      });
    }
  });
  configured(
    orchestrator
      .command('stop <run>')
      .description('Revoke scheduling and terminate owned executions; retain completed business evidence')
      .option('--detailed', 'Return the complete current structured result; logs remain referenced'),
  ).action(async (id: string, options: Options) => {
    let config: FleetConfig | undefined;
    let current: WorkflowRun | undefined;
    try {
      config = loadFleetConfig(options.config);
      current = inspectRuns(config).runs.find((run) => run.id === id);
      if (!current) throw new Error(`Unknown Run: expected existing run with id ${id}`);
      const runner = getRunner(current.provider);
      const result = await stopRun(config, runner, id);
      current = inspectRuns(config).runs.find((entry) => entry.id === id)!;
      output(
        {
          ...result,
          blockers: options.detailed ? result.blockers : result.blockers.map(conciseError),
          inspection: await inspection(current, config, !!options.detailed, undefined, getRunner),
          outcome: result.released
            ? 'succeeded'
            : result.terminated
              ? 'succeeded'
              : 'blocked',
        },
        opts.human(),
      );
      if (!result.terminated || result.blockers.length) process.exitCode = 2;
    } catch (error) {
      if (config) {
        try {
          current = inspectRuns(config).runs.find((entry) => entry.id === id) ?? current;
        } catch {
          /* Retain the last verified state. */
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      output(
        {
          outcome: 'failed',
          status: 'unknown',
          ...(current && config
            ? {
                inspection: await inspection(current, config, !!options.detailed, undefined, getRunner),
                observation: current.orchestrator?.observation,
                evidence: current.orchestrator?.evidence,
              }
            : {}),
          ...diagnosticError(config, message, {
            command: 'stop',
            run: id,
            attempt: current?.orchestrator?.id,
          }),
          ...(options.detailed ? { error: message } : {}),
        },
        opts.human(),
      );
      process.exitCode = 2;
    }
  });
  configured(
    orchestrator
      .command('release <run>')
      .description('Terminate remaining executions and release resources for a completed Run')
      .option('--detailed', 'Return the complete current structured result; logs remain referenced'),
  ).action(async (id: string, options: Options) => {
    let config: FleetConfig | undefined;
    let current: WorkflowRun | undefined;
    try {
      config = loadFleetConfig(options.config);
      current = inspectRuns(config).runs.find((run) => run.id === id);
      if (!current) throw new Error(`Unknown Run: expected existing run with id ${id}`);
      const runner = getRunner(current.provider);
      const result = await releaseRun(config, runner, id);
      current = inspectRuns(config).runs.find((entry) => entry.id === id)!;
      output(
        {
          ...result,
          blockers: options.detailed ? result.blockers : result.blockers.map(conciseError),
          inspection: await inspection(current, config, !!options.detailed, undefined, getRunner),
          outcome: result.released
            ? 'succeeded'
            : result.terminated
              ? 'succeeded'
              : 'blocked',
        },
        opts.human(),
      );
      if (!result.terminated || result.blockers.length) process.exitCode = 2;
    } catch (error) {
      if (config) {
        try {
          current = inspectRuns(config).runs.find((entry) => entry.id === id) ?? current;
        } catch {
          /* Retain the last verified state. */
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      output(
        {
          outcome: 'failed',
          status: 'unknown',
          ...(current && config
            ? {
                inspection: await inspection(current, config, !!options.detailed),
                observation: current.orchestrator?.observation,
                evidence: current.orchestrator?.evidence,
              }
            : {}),
          ...diagnosticError(config, message, {
            command: 'release',
            run: id,
            attempt: current?.orchestrator?.id,
          }),
          ...(options.detailed ? { error: message } : {}),
        },
        opts.human(),
      );
      process.exitCode = 2;
    }
  });
  configured(
    orchestrator
      .command('finalize-epic <number>')
      .description('Assess EPIC delivery; finalize specialists only after confirmed closure')
      .requiredOption('--repository <owner/name>', 'Target repository')
      .option(
        '--retry',
        'Start a fresh finalization round only after verified specialist termination',
      ),
  ).action(async (number: string, options: Options & { repository: string; retry?: boolean }) => {
    try {
      const config = loadFleetConfig(options.config);
      const runner = getRunner(
        orchestratorForSubject(config, options.repository, Number(number)).runner,
      );
      const epic = inspectEpicRun(config, options.repository, Number(number));
      if (!epic) throw new Error('Expected delivered EPIC record');
      output(await finishEpic(config, runner, epic, undefined, options.retry), opts.human());
    } catch (error) {
      run(() => {
        throw error;
      });
    }
  });
  configured(
    orchestrator
      .command('close-epic <number>')
      .description('Record explicit human confirmation, close and archive an accepted EPIC')
      .option('--repository <owner/name>', 'Target repository')
      .option('--human-confirmation <text>', 'Exact explicit human closure confirmation')
      .option('--confirmation-file <file>', 'Human confirmation JSON file')
      .option('--authority <attempt>', 'Active Orchestrator authority')
      .option('--dispatch <id>', 'Accepted integrated acceptance Dispatch')
      .option('--run <id>', 'Owning Run identity'),
  ).action(
    async (
      number: string,
      options: Options & {
        repository?: string;
        humanConfirmation?: string;
        confirmationFile?: string;
        authority?: string;
        dispatch?: string;
        run?: string;
      },
    ) => {
      try {
        const config = loadFleetConfig(options.config);
        const num = Number(number);
        const registry = inspectRuns(config);
        const run = options.run
          ? registry.runs.find((r) => r.id === options.run)
          : registry.runs.find(
              (r) =>
                r.subject.number === num &&
                (!options.repository || r.subject.repository === options.repository) &&
                r.lifecycle !== 'completed',
            ) ??
            registry.runs.find(
              (r) =>
                r.subject.number === num &&
                (!options.repository || r.subject.repository === options.repository),
            );

        let confirmation: { deliveryVersion: string; source: 'human'; evidence: string } | undefined;
        if (options.confirmationFile && existsSync(options.confirmationFile)) {
          confirmation = JSON.parse(readFileSync(options.confirmationFile, 'utf8'));
        } else if (options.humanConfirmation) {
          if (existsSync(options.humanConfirmation)) {
            confirmation = JSON.parse(readFileSync(options.humanConfirmation, 'utf8'));
          } else {
            try {
              const parsed = JSON.parse(options.humanConfirmation);
              if (parsed && typeof parsed === 'object' && parsed.source) {
                confirmation = parsed;
              }
            } catch {
              /* plain text confirmation */
            }
            if (!confirmation) {
              confirmation = {
                deliveryVersion: '',
                source: 'human',
                evidence: options.humanConfirmation,
              };
            }
          }
        }
        if (!confirmation) {
          throw new Error('Expected explicit human confirmation');
        }

        if (run) {
          const repo = options.repository ?? run.subject.repository;
          const authority = options.authority ?? run.orchestratorId ?? run.orchestrator?.id;
          if (!authority) throw new Error('Active Orchestrator authority required');
          const dispatch = options.dispatch
            ? registry.dispatches?.find((d) => d.id === options.dispatch && d.runId === run.id)
            : registry.dispatches?.find(
                (d) =>
                  d.runId === run.id &&
                  d.role === 'epic' &&
                  d.stage === 'integrated-acceptance' &&
                  d.lifecycle === 'accepted',
              );
          if (!dispatch) {
            throw new Error(
              'Active Orchestrator and accepted integrated Dispatch required before GitHub close',
            );
          }

          const projectCwd = config.project;
          const git = (...args: string[]) =>
            execFileSync('git', args, { cwd: projectCwd, encoding: 'utf8', timeout: 10000 }).trim();

          const actions: EpicClosureActions = {
            head: () => git('rev-parse', 'HEAD'),
            view: async () => {
              const out = execFileSync(
                'gh',
                ['issue', 'view', String(num), '--repo', repo, '--json', 'state'],
                { cwd: projectCwd, encoding: 'utf8', timeout: 30000 },
              );
              return JSON.parse(out);
            },
            close: async () => {
              execFileSync('gh', ['issue', 'close', String(num), '--repo', repo], {
                cwd: projectCwd,
                encoding: 'utf8',
                timeout: 30000,
              });
            },
          };

          const result = await closeStageEpic(
            config,
            run.id,
            authority,
            dispatch.id,
            confirmation,
            actions,
          );
          output(
            {
              closed: true,
              run: run.id,
              epic: num,
              deliveryVersion: result.deliveryVersion,
              head: result.head,
              phase: 'post_closure_finalization',
            },
            opts.human(),
          );
          return;
        }

        if (!options.repository) throw new Error('Target repository required');
        const runner = getRunner(
          orchestratorForSubject(config, options.repository, num).runner,
        );
        const epic = inspectEpicRun(config, options.repository, num);
        if (!epic) throw new Error('Expected delivered EPIC record');
        output(
          await finishEpic(config, runner, epic, {
            epic: num,
            confirmed: true,
            source: 'human',
            evidence: confirmation.evidence,
            deliveryVersion: confirmation.deliveryVersion,
          }),
          opts.human(),
        );
      } catch (error) {
        run(() => {
          throw error;
        });
      }
    },
  );
  configured(
    orchestrator
      .command('land <issue>')
      .description('Merge, record, preserve and clean delivered PR stages automatically'),
  )
    .option(
      '--confirmation-file <file>',
      'EPIC professional confirmation JSON: epic, head, evidence',
    )
    .action(async (number: string, options: Options & { confirmationFile?: string }) => {
      try {
        const config = loadFleetConfig(options.config);
        const issue = readIssue(config.project, Number(number));
        const runner = getRunner(
          orchestratorForSubject(config, issue.repository, issue.number).runner,
        );
        const task = inspectIssueRun(config, issue.repository, issue.number);
        if (!task || task.status !== 'done')
          throw new Error('Expected delivered Issue stages before landing');
        output(
          await landDelivery(
            config,
            runner,
            new GitHubPullRequests(
              existsSync(task.checkout) ? task.checkout : config.project,
              issue.repository,
            ),
            {
              repository: issue.repository,
              issue: issue.number,
              checkout: task.checkout,
              epic: issue.parent,
              confirmation: options.confirmationFile
                ? JSON.parse(readFileSync(options.confirmationFile, 'utf8'))
                : undefined,
            },
          ),
          opts.human(),
        );
      } catch (error) {
        run(() => {
          throw error;
        });
      }
    });
  configured(
    workflow.command('preserve').description('Copy and verify slot state; retain all originals'),
  )
    .requiredOption('--dir <directory>', 'Configured project or slot to preserve')
    .requiredOption('--reason <text>', 'Reason recorded in the archive manifest')
    .action((options: Options & { dir: string; reason: string }) =>
      run(() => {
        output(
          preserveState(loadFleetConfig(options.config), options.dir, options.reason),
          opts.human(),
        );
      }),
    );
  const fleet = program
    .command('fleet')
    .description('Portable Git/file checks; runtime occupancy remains unknown');
  for (const kind of ['currency', 'collisions'] as const) {
    configured(
      fleet
        .command(kind)
        .description(
          kind === 'currency'
            ? 'Check registered slots against the base branch'
            : 'Check conservative file overlap across registered slots',
        ),
    )
      .option('--fetch', 'Refresh origin base refs in the project and slots before checking')
      .action((options: Options) =>
        run(() => {
          const report = checkFleet(loadFleetConfig(options.config), kind, options.fetch);
          output(report, opts.human(), () => JSON.stringify(report, null, 2));
          process.exitCode = report.status === 'unknown' ? 2 : report.status === 'issues' ? 1 : 0;
        }),
      );
  }
  configured(
    fleet
      .command('reclaim-check')
      .description('Report reclaim evidence without modifying the checkout; exits 2'),
  )
    .requiredOption('--dir <directory>', 'Configured project or slot to inspect')
    .action((options: Options & { dir: string }) =>
      run(() => {
        output(checkReclaim(loadFleetConfig(options.config), options.dir), opts.human());
        process.exitCode = 2;
      }),
    );
}
