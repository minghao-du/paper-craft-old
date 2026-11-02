/** Prepare synthetic, non-executable Fleet state for an ordinary-conversation smoke. */
import { outputRegistry } from './registry.js';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const target = process.argv[2];
if (!target) throw new Error('Provide an isolated temporary fixture directory');
mkdirSync(target, { recursive: true });
const project = realpathSync(target);
const config = join(project, '.epic-config.json');
writeFileSync(config, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
const runtime = join(
  project,
  'pool',
  '.runtime',
  createHash('sha256').update(config).digest('hex'),
);
mkdirSync(runtime, { recursive: true });
const registry = outputRegistry();
registry.dispatches = registry.dispatches.slice(0, 2);
registry.receipts = registry.receipts.slice(0, 2);
registry.stageEvents = registry.stageEvents.slice(0, 2);
for (const run of registry.runs) {
  const directory = join(runtime, run.id);
  mkdirSync(directory, { recursive: true });
  const brief = join(directory, 'context.md');
  writeFileSync(brief, 'Fixture context only. No work authorized.\n');
  run.brief = {
    path: brief,
    hash: createHash('sha256').update('Fixture context only. No work authorized.\n').digest('hex'),
  };
  if (run.orchestrator) {
    run.orchestrator.directory = directory;
    run.orchestrator.checkout = project;
    Object.assign(run.orchestrator, {
      error:
        'Agy exited before native acknowledgement; inspect terminal and authentication/configuration at tmux:%fixture: ' +
        'FIXTURE-TERMINAL-DETAIL '.repeat(60),
    });
  }
}
for (const dispatch of registry.dispatches) {
  for (const attempt of dispatch.attempts) {
    attempt.directory = join(runtime, attempt.id);
    attempt.checkout = project;
    mkdirSync(attempt.directory, { recursive: true });
  }
  const path = join(runtime, dispatch.id + '.md');
  const content = 'Fixture pending work only. No work authorized.\n';
  writeFileSync(path, content);
  dispatch.briefReference = { path, hash: createHash('sha256').update(content).digest('hex') };
}
for (const receipt of registry.receipts) {
  const path = join(runtime, receipt.id + '.json');
  const content = JSON.stringify({
    fixture: true,
    result: 'Original fixture business Evidence, not diagnostic acceptance',
  });
  writeFileSync(path, content);
  receipt.evidence = [{ path, hash: createHash('sha256').update(content).digest('hex') }];
}
registry.resources = [
  {
    path: join(project, 'pool', 'issue-7'),
    runId: 'run-1',
    registry: join(runtime, 'registry.json'),
  },
];
writeFileSync(join(runtime, 'registry.json'), JSON.stringify(registry, null, 2));
console.log(runtime);
