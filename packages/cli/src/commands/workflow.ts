import {
  startRun,
  inspectRuns,
  recoverRun,
  orchestratorForSubject,
  type WorkflowRun,
  type RunRegistry,
} from '@paper-craft/core/workflow/run-driver';
import { recoverAllRuns } from '@paper-craft/core/workflow/recovery';
import { finishEpic } from '../workflow/epic-completion.js';
import { landDelivery } from '@paper-craft/core/workflow/postmerge';
import { registerSubagentCommands } from './workflow-subagents.js';
/** Portable workflow CLI shared by agents with filesystem and command execution access. */
import { Command, Option } from 'commander';
import { loadFleetConfig, type FleetConfig } from '@paper-craft/core/workflow/fleet-config';
import { preserveState } from '@paper-craft/core/workflow/handoff';
import { checkFleet, checkReclaim } from '@paper-craft/core/workflow/fleet';
import { managedRunner, quote } from '@paper-craft/core/workflow/runtime';
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

async function inspection(run: WorkflowRun, config: string, detailed = true) {
  const attempt = run.orchestrator;
  let usable = false;
  if (attempt?.address && attempt.terminalSession) {
    try {
      const observation = await managedRunner(run.provider).observe?.(attempt);
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
    cause: detailed ? attempt?.error : attempt?.error ? conciseError(attempt.error) : undefined,
    evidenceDirectory: attempt?.directory,
    context: run.brief,
    statusCommand: `pc workflow orchestrator status --config ${quote(config)}`,
    recoverCommand: `pc workflow orchestrator recover ${run.id} --config ${quote(config)}`,
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
export function registerWorkflowCommands(program: Command, opts: { human: () => boolean }): void {
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
              ...(await inspection(entry, config.file, !!options.detailed)),
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
      .description('Create or reconnect a Run; report concise startup state')
      .option('--detailed', 'Return the complete current structured result; logs remain referenced')
      .requiredOption('--provider <provider>', 'Managed provider: codex, agy, or claude')
      .option(
        '--dangerously-skip-permissions',
        'Auto-approve agy tool permissions for this Run (agy only)',
      )
      .option('--requirements <text>', 'Immutable additional Run Requirements')
      .option('--requirements-file <file>', 'Read immutable Run Requirements from a UTF-8 file')
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
        const result = await startRun(
          config,
          managedRunner(options.provider),
          { ...subject, kind },
          options.provider,
          requirements,
          options.dangerouslySkipPermissions,
        );
        const diagnostics = diagnosticError(config, result.orchestrator?.error, {
          command: 'start',
          run: result.id,
          attempt: result.orchestrator?.id,
          subject: subjectReference,
        });
        output(
          {
            ...(options.detailed ? result : {}),
            ...(await inspection(result, config.file, !!options.detailed)),
            ...diagnostics,
            outcome: result.lifecycle === 'running' ? 'succeeded' : 'blocked',
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
                  ...(await inspection(current, config.file, !!options.detailed)),
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
      if (!current) throw new Error('Unknown Run');
      const runner = managedRunner(current.provider);
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
          inspection: await inspection(current, config.file, !!options.detailed),
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
          outcome: result.blockers.length ? 'blocked' : 'succeeded',
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
                inspection: await inspection(current, config.file, !!options.detailed),
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
      const result = await recoverAllRuns(loadFleetConfig(options.config), managedRunner);
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
      const runner = managedRunner(
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
      .requiredOption('--repository <owner/name>', 'Target repository')
      .requiredOption('--human-confirmation <text>', 'Exact explicit human closure confirmation'),
  ).action(
    async (
      number: string,
      options: Options & { repository: string; humanConfirmation: string },
    ) => {
      try {
        const config = loadFleetConfig(options.config);
        const runner = managedRunner(
          orchestratorForSubject(config, options.repository, Number(number)).runner,
        );
        const epic = inspectEpicRun(config, options.repository, Number(number));
        if (!epic) throw new Error('Expected delivered EPIC record');
        output(
          await finishEpic(config, runner, epic, {
            epic: Number(number),
            confirmed: true,
            source: 'human',
            evidence: options.humanConfirmation,
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
        const runner = managedRunner(
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
