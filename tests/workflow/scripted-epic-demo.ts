/** Isolated shared toy EPIC. Scripts execute tasks; the caller chooses the schedule. */
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadFleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';
import {
  startRun,
  inspectRuns,
  type StageRequest,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { reconcileStartup } from '../../packages/core/src/workflow/run/startup.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';
import { registerStageCommands } from '../../packages/cli/src/commands/workflow-stages.js';
import { initializeRole } from './initialize-role.js';

/** Prepare shared evidence and controlled execution without dispatching subordinate work. */
export async function prepareScriptedEpic() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pc-scripted-epic-')));
  mkdirSync(join(directory, 'pool'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Toy EPIC');
  git('config', 'user.email', 'toy@example.invalid');
  writeFileSync(join(directory, 'toy.txt'), 'Tiny isolated task\n');
  git('add', 'toy.txt');
  git('commit', '-m', 'Toy input');
  const file = join(directory, '.epic-config.json');
  writeFileSync(file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
  const config = loadFleetConfig(file);
  const launched: string[] = [];
  const activated = new Set<string>();
  const terminated = new Set<string>();
  const runner = {
    name: 'codex',
    interactive: true,
    separateActivation: true,
    cancellation: true,
    async preflight() {},
    async start(a: ManagedAttempt) {
      launched.push(a.id);
      initializeRole(a);
      writeFileSync(
        join(a.directory, 'script-start.json'),
        JSON.stringify({ attempt: a.id, role: a.role }),
      );
      return {
        conversation: a.id,
        address: `controlled:${a.id}`,
        evidence: join(a.directory, 'script-start.json'),
      };
    },
    async recoverReceipt(a: ManagedAttempt) {
      return {
        conversation: a.id,
        address: `controlled:${a.id}`,
        evidence: join(a.directory, 'initialization.json'),
      };
    },
    async send(a: ManagedAttempt, message: { id: string; brief: string }) {
      activated.add(a.id);
      writeFileSync(join(a.directory, 'activation.json'), JSON.stringify(message));
      return { status: 'delivered' as const, evidence: join(a.directory, 'activation.json') };
    },
    async result(a: ManagedAttempt) {
      if (!activated.has(a.id)) return undefined;
      const path = join(a.directory, 'planning.md');
      writeFileSync(path, 'Toy plan: change toy.txt; preserve its Git history.\n');
      return JSON.stringify({ status: 'completed', artifact: path, role: a.role, attempt: a.id });
    },
    async stopped(a: ManagedAttempt) {
      return terminated.has(a.id);
    },
    async cancel(a: ManagedAttempt) {
      terminated.add(a.id);
      return { evidence: 'Controlled task termination' };
    },
    async collect(a: ManagedAttempt) {
      return (await this.result(a))!;
    },
    collectable() {
      return true;
    },
  };
  const run = await startRun(
    config,
    runner,
    {
      repository: 'toy/epic',
      number: 1,
      kind: 'epic',
      title: 'Tiny EPIC',
      body: 'Change a tiny file using retained evidence.',
    },
    runner.name,
    'Only isolated toy files. No network or scientific work.',
  );
  await reconcileStartup(config, runner, run.id);
  let requestNumber = 0;
  async function cli(operation: string, args: string[] = []) {
    const program = new Command();
    registerStageCommands(program, { human: () => false }, { runner: () => runner });
    await program.parseAsync(
      [
        'stage',
        operation,
        '--config',
        config.file,
        '--run',
        run.id,
        '--authority',
        run.orchestratorId,
        ...args,
      ],
      { from: 'user' },
    );
  }
  async function dispatch(input: Omit<StageRequest, 'runId' | 'authority'>) {
    const path = join(directory, `request-${++requestNumber}.json`);
    writeFileSync(path, JSON.stringify(input));
    await cli('dispatch', ['--input', path]);
    await reconcileStartup(config, runner, run.id);
    return inspectRuns(config).dispatches!.at(-1)!;
  }
  return { directory, config, run, runner, launched, activated, terminated, git, cli, dispatch };
}

/** First vertical slice; later slices reuse this prepared context and public CLI calls. */
export async function runPlanningDemo() {
  const demo = await prepareScriptedEpic();
  const request = {
    subject: 'toy/epic#1',
    role: 'epic' as const,
    stage: 'planning',
    inputRevision: demo.git('rev-parse', 'HEAD'),
    brief: 'Produce a tiny implementation plan.',
    prerequisites: [],
  };
  const dispatch = await demo.dispatch(request);
  await demo.dispatch(request);
  if (demo.launched.length !== 2) throw new Error(`Idempotency failed: ${demo.directory}`);
  await demo.cli('collect', ['--dispatch', dispatch.id]);
  const receipt = inspectRuns(demo.config).receipts!.at(-1)!;
  const result = JSON.parse(readFileSync(receipt.evidence[0].path, 'utf8'));
  if (!readFileSync(result.artifact, 'utf8').includes('toy.txt'))
    throw new Error('Missing toy plan');
  const decision = join(demo.directory, 'planning-decision.md');
  writeFileSync(decision, 'Reviewed plan: bounded toy.txt change, retained Git history.');
  await demo.cli('accept', ['--receipt', receipt.id, '--decision', decision]);
  if (
    inspectRuns(demo.config).dispatches?.find((d) => d.id === dispatch.id)?.lifecycle !== 'accepted'
  )
    throw new Error(`Planning acceptance blocked; inspect ${demo.directory}`);
  return {
    ...demo,
    planning: dispatch.id,
    evidenceLevel:
      'Controlled lifecycle/CLI evidence; no native subordinate or scientific validity claim.',
  };
}
