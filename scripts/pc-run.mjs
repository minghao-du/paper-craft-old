/** Lightweight Run intake: JSON state only; scheduling belongs to the agent. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const usage = `Usage: pc run <create|inspect> [options]
  create --issue <number> --runner <command> [--instructions <text>]...
  inspect <run-id>
  --root <directory>  Runtime root (default: current directory)
  --fleet <id>        Fleet directory identifier (default: default)
  -h, --help         Show help

State: <root>/.runtime/<fleet>/runs/<run-id>/run.json`;
try {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
  const action = args.shift();
  const id = action === 'inspect' ? args.shift() : undefined;
  const options = { root: process.cwd(), fleet: 'default', instructions: [] };
  while (args.length) {
    const option = args.shift();
    if (!['--root', '--fleet', '--issue', '--runner', '--instructions'].includes(option))
      throw new Error(`Unknown option: ${option}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Expected value for ${option}`);
    if (option === '--instructions') options.instructions.push(value);
    else options[option.slice(2)] = value;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.fleet))
    throw new Error('Expected safe fleet identifier');
  const directory = join(realpathSync(options.root), '.runtime', options.fleet, 'runs');
  let run;
  if (action === 'create') {
    const issue = Number(options.issue);
    if (!Number.isSafeInteger(issue) || issue < 1)
      throw new Error('Expected positive --issue number');
    if (!options.runner?.trim()) throw new Error('Expected non-empty --runner command');
    run = {
      run_id: randomUUID(),
      issue_id: issue,
      runner_cmd: options.runner,
      custom_instructions: options.instructions,
      created_at: new Date().toISOString(),
    };
    const home = join(directory, run.run_id);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'run.json'), JSON.stringify(run, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } else if (action === 'inspect') {
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new Error('Expected safe run-id');
    run = JSON.parse(readFileSync(join(directory, id, 'run.json'), 'utf8'));
    if (
      run.run_id !== id ||
      !Number.isSafeInteger(run.issue_id) ||
      run.issue_id < 1 ||
      typeof run.runner_cmd !== 'string' ||
      !run.runner_cmd.trim() ||
      !Array.isArray(run.custom_instructions) ||
      run.custom_instructions.some((x) => typeof x !== 'string') ||
      typeof run.created_at !== 'string' ||
      !Number.isFinite(Date.parse(run.created_at))
    )
      throw new Error(`Invalid run.json for ${id}`);
  } else throw new Error(`Expected create or inspect, received ${action}`);
  console.log(JSON.stringify(run, null, 2));
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
