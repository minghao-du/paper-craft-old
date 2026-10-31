/** Read-only recovery inventory, with explicit receipt acknowledgment. */
import process from 'node:process';
import console from 'node:console';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
    const runs = resolve(root, '.runtime', fleet, 'runs');
    const ids = runId
      ? [runId]
      : readdirSync(runs, { withFileTypes: true })
          .filter((x) => x.isDirectory())
          .map((x) => x.name)
          .sort();
    const attempts = [];
    for (const id of ids) {
      const runDir = join(runs, id);
      const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
      if (run.run_id !== id) throw new Error(`Run identifier mismatch: ${id}`);
      const dispatches = join(runDir, 'dispatches');
      if (!existsSync(dispatches)) continue;
      for (const entry of readdirSync(dispatches, { withFileTypes: true })
        .filter((x) => x.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const dir = join(dispatches, entry.name);
        const dispatch = JSON.parse(readFileSync(join(dir, 'dispatch.json'), 'utf8'));
        if (dispatch.dispatch_id !== entry.name || dispatch.run_id !== id)
          throw new Error(`Dispatch identifier mismatch: ${entry.name}`);
        const receiptPath = join(dir, 'RECEIPT.md');
        const receipt = existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : null;
        const handledPath = join(dir, 'HANDLED.json');
        attempts.push({
          run_id: id,
          dispatch_id: entry.name,
          issue_id: dispatch.issue_id,
          role: dispatch.role,
          state:
            receipt !== null
              ? 'completed'
              : existsSync(join(dir, 'EXIT.json'))
                ? 'exited-without-receipt'
                : 'in-flight',
          handled: existsSync(handledPath),
          receipt_path: receiptPath,
          receipt,
          handledPath,
        });
      }
    }
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
          attempts: attempts.map(({ handledPath, ...attempt }) => {
            void handledPath;
            return attempt;
          }),
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
