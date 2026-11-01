import { runtimeRoot } from './pc-runtime-paths.mjs';
/** Validate landing evidence and preserve durable completion metadata. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
try {
  const [action, rootText, id, tested, ...args] = process.argv.slice(2);
  const root = realpathSync(rootText);
  const safe = (x) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(x);
  if (!safe(id)) throw new Error('Expected safe dispatch identifier');
  const runtime = runtimeRoot(root);
  const homes = [];
  for (const fleet of readdirSync(runtime)) {
    const runs = join(runtime, fleet, 'runs');
    if (!existsSync(runs)) continue;
    for (const run of readdirSync(runs)) {
      const home = join(runs, run, 'dispatches', id);
      if (existsSync(join(home, 'dispatch.json'))) homes.push(home);
    }
  }
  if (homes.length !== 1) throw new Error('Expected one matching dispatch');
  const home = homes[0];
  const inside = (path, base) => {
    const physical = realpathSync(path);
    if (!physical.startsWith(realpathSync(base) + sep))
      throw new Error(`Path escapes runtime: ${path}`);
    return physical;
  };
  inside(home, runtime);
  const dispatch = JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8'));
  if (dispatch.dispatch_id !== id) throw new Error('Dispatch identity mismatch');
  const archive = join(dirname(dirname(dirname(dirname(home)))), 'archives', id);
  if (action === 'prepare') {
    if (!/^[a-f0-9]{40}$/.test(tested)) throw new Error('Expected full tested HEAD SHA');
    if (existsSync(join(home, 'LANDED.json'))) throw new Error('Dispatch already landed');
    inside(
      dispatch.worktree,
      join(runtime, home.slice(runtime.length + 1).split(sep)[0], 'worktrees'),
    );
    inside(
      dispatch.lock_path,
      join(runtime, home.slice(runtime.length + 1).split(sep)[0], 'locks'),
    );
    const owner = JSON.parse(readFileSync(join(dispatch.lock_path, 'owner.json'), 'utf8'));
    if (owner.dispatch_id !== id) throw new Error('Active lock ownership conflict');
    const receipt = readFileSync(join(home, 'RECEIPT.md'), 'utf8');
    if (!/^outcome:\s*succeeded\s*$/m.test(receipt) || !receipt.includes(tested))
      throw new Error('Expected succeeded receipt identifying tested HEAD');
    console.log(home);
  } else if (action === 'get') {
    console.log(tested === 'archive' ? archive : dispatch[tested]);
  } else if (action === 'checks') {
    const pr = JSON.parse(readFileSync(tested, 'utf8'));
    const [head] = args;
    if (
      pr.headRefOid !== head ||
      pr.state !== 'OPEN' ||
      pr.isDraft ||
      pr.headRefName !== dispatch.branch
    )
      throw new Error('PR must be open, ready and match tested HEAD and dispatch branch');
    if (
      !Array.isArray(pr.statusCheckRollup) ||
      pr.statusCheckRollup.length === 0 ||
      pr.statusCheckRollup.some((x) =>
        x.status ? x.status !== 'COMPLETED' || x.conclusion !== 'SUCCESS' : x.state !== 'SUCCESS',
      )
    )
      throw new Error('Expected all PR checks to pass');
  } else if (action === 'archive') {
    mkdirSync(archive, { recursive: true });
    for (const file of readdirSync(home)) {
      if (file.endsWith('.json') || file.endsWith('.md'))
        cpSync(join(home, file), join(archive, file), { dereference: false });
    }
    const log = join(dispatch.worktree, '.epic-worklog.md');
    if (existsSync(log)) cpSync(log, join(archive, 'WORKLOG.md'), { dereference: false });
  } else if (action === 'landed') {
    writeFileSync(
      join(home, 'LANDED.json'),
      JSON.stringify({ tested_head: tested, merged_at: new Date().toISOString() }),
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({ dispatch_id: id, archive, bundle: join(archive, 'worker.bundle') }),
    );
  } else throw new Error('Unknown landing operation');
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
