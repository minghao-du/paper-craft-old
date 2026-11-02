import { runtimeRoot } from '../shared/pc-runtime-paths.mjs';
/** Dispatch lookup and immutable crash publication for worker wait. */
import process from 'node:process';
import console from 'node:console';
import { readdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
const safe = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
try {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'locate') {
    const [root, fleet, id] = args;
    if (!safe(fleet) || !safe(id)) throw new Error('Expected safe fleet and dispatch identifiers');
    const runs = join(runtimeRoot(root), fleet, 'runs');
    const matches = [];
    for (const run of readdirSync(runs, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const home = join(runs, run.name, 'dispatches', id);
      try {
        const dispatch = JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8'));
        if (dispatch.dispatch_id !== id) throw new Error('Dispatch identifier mismatch');
        matches.push(home);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (matches.length !== 1)
      throw new Error(`Expected one dispatch ${id}; found ${matches.length}`);
    console.log(matches[0]);
  } else if (action === 'release') {
    const [home] = args;
    const dispatch = JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8'));
    const root = home.split('/.runtime/')[0];
    const runtime = runtimeRoot(root);
    const lock = join(
      runtime,
      home.slice(runtime.length + 1).split('/')[0],
      'locks',
      `issue-${dispatch.issue_id}-${dispatch.role}.lock`,
    );
    if (dispatch.lock_path !== lock) throw new Error('Lock path mismatch');
    const receipt = readFileSync(join(home, 'RECEIPT.md'), 'utf8');
    if (!/^outcome:\s*(failed|crashed)\s*$/m.test(receipt))
      throw new Error('Expected failed or crashed receipt');
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    if (owner.dispatch_id !== dispatch.dispatch_id) throw new Error('Lock ownership conflict');
    writeFileSync(
      join(home, 'RELEASED.json'),
      JSON.stringify({ released_at: new Date().toISOString() }),
      { flag: 'wx' },
    );
    unlinkSync(join(lock, 'owner.json'));
    rmdirSync(lock);
    console.log('Released failed attempt; dispatch evidence and worktree preserved');
  } else if (action === 'crash') {
    const [home, reason] = args;
    const temp = join(home, `receipt-${process.pid}.tmp`);
    writeFileSync(temp, `outcome: crashed\nsummary: ${reason}\n`, { flag: 'wx' });
    try {
      linkSync(temp, join(home, 'RECEIPT.md'));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      unlinkSync(temp);
    }
  } else throw new Error('Unknown wait operation');
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
