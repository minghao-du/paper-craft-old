import {
  startRun,
  initializeCurrentRun,
  inspectRuns,
  recoverRun,
  orchestratorForSubject,
} from '@paper-craft/core/workflow/run-driver';
import { recoverAllRuns } from '@paper-craft/core/workflow/recovery';
import { finishEpic } from '../workflow/epic-completion.js';
import { landDelivery } from '@paper-craft/core/workflow/postmerge';
import { registerSubagentCommands } from './workflow-subagents.js';
/** Portable workflow CLI shared by agents with filesystem and command execution access. */
import { Command, Option } from 'commander';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';
import { preserveState } from '@paper-craft/core/workflow/handoff';
import { checkFleet, checkReclaim } from '@paper-craft/core/workflow/fleet';
import { AgyInteractive, managedRunner } from '@paper-craft/core/workflow/runtime';
import { inspectEpicRun } from '@paper-craft/core/workflow/epic-driver';
import { readIssue } from '@paper-craft/core/workflow/issue-driver';
import { GitHubPullRequests } from '@paper-craft/core/workflow/pr-driver';
import { inspectIssueRun } from '@paper-craft/core/workflow/issue-driver';
import { readFileSync, existsSync } from 'node:fs';
import { output } from '../utils/output.js';

interface Options {
  config: string;
  fetch?: boolean;
  dir?: string;
  reason?: string;
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
  workflow
    .command('agy')
    .description('Prepare a native agy user conversation')
    .command('prepare')
    .description(
      'Start agy in the current single-pane tmux window with registration evidence (no Run)',
    )
    .action(async () => {
      try {
        await new AgyInteractive().prepare();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });
  registerSubagentCommands(workflow, opts);
  const orchestrator = workflow
    .command('orchestrator')
    .description('Create or inspect a subject-scoped managed Run');
  configured(
    orchestrator
      .command('initialize <run>')
      .description('Activate the prepared current agy Orchestrator after role initialization'),
  ).action((id: string, options: Options) =>
    run(() =>
      output(
        initializeCurrentRun(loadFleetConfig(options.config), managedRunner('agy'), id),
        opts.human(),
      ),
    ),
  );
  configured(
    orchestrator.command('status').description('Read Fleet Run and Orchestrator ownership'),
  ).action((options: Options) =>
    run(() => output(inspectRuns(loadFleetConfig(options.config)), opts.human())),
  );
  configured(
    orchestrator
      .command('start <issue>')
      .description('Create or reconnect a Run from configured repository context')
      .requiredOption('--provider <provider>', 'Managed provider: codex, agy, or claude')
      .addOption(
        new Option('--type <type>', 'Subject type; must match the title EPIC marker')
          .choices(['issue', 'epic'])
          .makeOptionMandatory(),
      ),
  ).action(
    async (number: string, options: Options & { provider: string; type: 'issue' | 'epic' }) => {
      try {
        const config = loadFleetConfig(options.config);
        const subject = readIssue(config.project, Number(number));
        const kind = /\bEPIC\b/i.test(subject.title) ? 'epic' : 'issue';
        if (options.type !== kind)
          throw new Error(
            `Type mismatch: --type ${options.type}, but title ${JSON.stringify(subject.title)} identifies ${kind}; correct the title or --type before retrying`,
          );
        output(
          await startRun(
            config,
            managedRunner(options.provider),
            { ...subject, kind },
            options.provider,
          ),
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
      .command('recover <run>')
      .description('Reconcile durable results and startup identity; preserve unknown occupancy')
      .option('--replace', 'Replace Orchestrator only after verified termination'),
  ).action(async (id: string, options: Options & { replace?: boolean }) => {
    try {
      const config = loadFleetConfig(options.config);
      const run = inspectRuns(config).runs.find((run) => run.id === id);
      if (!run) throw new Error('Unknown Run');
      const runner = managedRunner(run.provider);
      const result = await recoverRun(config, runner, id, {
        replaceOrchestrator: options.replace,
        stopped: (attempt) => runner.stopped(attempt),
      });
      output(result, opts.human());
      if (result.blockers.length) process.exitCode = 2;
    } catch (error) {
      run(() => {
        throw error;
      });
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
