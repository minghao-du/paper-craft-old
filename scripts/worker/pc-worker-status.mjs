import { readWorkerInventory } from '../../packages/core/src/workflow/fleet/worker-inventory.ts';
import { runtimeRoot } from '../shared/pc-runtime-paths.mjs';
/** Read-only recovery inventory, with explicit receipt acknowledgment. */
import process from 'node:process';
import console from 'node:console';
import { writeFileSync } from 'node:fs';
const safe = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: pc worker status [run-id] [--root <dir>] [--fleet <id>] [--ack <dispatch-id>]\nAlias: pc status [run-id]\nInspection preserves receipts; --ack records receipt consumption.',
    );
  } else {
    let root = process.cwd(),
      fleet = 'default',
      runId,
      ack;
    while (args.length) {
      const arg = args.shift();
      if (['--root', '--fleet', '--ack'].includes(arg)) {
        const value = args.shift();
        if (!value) throw new Error(`Expected value for ${arg}`);
        if (arg === '--root') root = value;
        else if (arg === '--fleet') fleet = value;
        else ack = value;
      } else if (!arg.startsWith('-') && !runId) runId = arg;
      else throw new Error(`Unexpected argument: ${arg}`);
    }
    if (!safe(fleet) || (runId && !safe(runId)) || (ack && !safe(ack)))
      throw new Error('Expected safe identifiers');
    runtimeRoot(root); // Preserve the CLI's runtime redirection guard.
    const attempts = readWorkerInventory(root, fleet, runId);
    if (ack) {
      const matches = attempts.filter((x) => x.dispatch_id === ack);
      if (matches.length !== 1 || matches[0].receipt === null)
        throw new Error('Expected one completed dispatch to acknowledge');
      const attempt = matches[0];
      if (!attempt.handled)
        writeFileSync(
          attempt.handledPath,
          JSON.stringify({ handled_at: new Date().toISOString() }) + '\n',
          { flag: 'wx' },
        );
      attempt.handled = true;
    }
    console.log(
      JSON.stringify(
        {
          fleet_id: fleet,
          attempts: attempts.map(
            ({ handledPath, source, worktree, modifiedAt, fleet_id, ...attempt }) => {
              void [handledPath, source, worktree, modifiedAt, fleet_id];
              return attempt;
            },
          ),
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
