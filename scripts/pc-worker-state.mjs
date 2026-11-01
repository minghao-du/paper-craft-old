import { runtimeRoot } from './pc-runtime-paths.mjs';
/** JSON preparation for the Bash worker execution primitive. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const safe = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
try {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'prepare') {
    const [issueText, role, rootText, fleet, runIdText, override] = args;
    const issue = Number(issueText);
    if (!Number.isSafeInteger(issue) || issue < 1 || !safe(role) || !safe(fleet))
      throw new Error('Expected positive issue and safe role/fleet identifiers');
    if (['orchestrator', 'epic', 'worker', 'landing', 'pr-land', 'pipeline-audit',
      'pipeline-refactor', 'research-state'].includes(role.toLowerCase().replace(/^pc-/, '')))
      throw new Error('Persistent roles require a verified interactive Runner Adapter; use the managed Run lifecycle instead of a transparent command');
    const root = realpathSync(rootText);
    const runtime = join(runtimeRoot(root), fleet);
    const runs = join(runtime, 'runs');
    const runId =
      runIdText ||
      (() => {
        const ids = readdirSync(runs);
        if (ids.length !== 1) throw new Error('Specify --run when multiple Runs exist');
        return ids[0];
      })();
    if (!safe(runId)) throw new Error('Expected safe run identifier');
    const run = JSON.parse(readFileSync(join(runs, runId, 'run.json'), 'utf8'));
    if (
      run.run_id !== runId ||
      !Array.isArray(run.custom_instructions) ||
      run.custom_instructions.some((x) => typeof x !== 'string')
    )
      throw new Error('Invalid run.json');
    const runner = override || run.runner_cmd;
    if (typeof runner !== 'string' || !runner.trim())
      throw new Error('Expected non-empty runner command');
    const id = randomUUID();
    const home = join(runs, runId, 'dispatches', id);
    const lock = join(runtime, 'locks', `issue-${issue}-${role}.lock`);
    mkdirSync(join(runtime, 'locks'), { recursive: true });
    mkdirSync(lock); // Atomic directory lock; never infer stale ownership.
    try {
      mkdirSync(home, { recursive: true });
      const dispatch = {
        dispatch_id: id,
        run_id: runId,
        issue_id: issue,
        role,
        runner_cmd: runner,
        worktree: join(runtime, 'worktrees', id),
        branch: `codex/worker-${id}`,
        brief_path: join(home, 'BRIEF.md'),
        receipt_path: join(home, 'RECEIPT.md'),
        lock_path: lock,
        tmux_session: `pc-${fleet}`,
        tmux_pane: null,
        created_at: new Date().toISOString(),
      };
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ dispatch_id: id }), { flag: 'wx' });
      writeFileSync(join(home, 'dispatch.json'), JSON.stringify(dispatch, null, 2) + '\n', {
        flag: 'wx',
      });
      writeFileSync(
        dispatch.brief_path,
        `# Task\n\nImplement GitHub issue #${issue} as ${role}. Read the issue and repository guidance before acting.\n\n## Requirements\n\n${run.custom_instructions.map((x) => `- ${x}`).join('\n')}\n\n## Completion contract\n\nWork in ${dispatch.worktree}. Publish ${dispatch.receipt_path} atomically (temporary file then rename), without replacing an existing receipt. Include outcome: succeeded|failed, summary, commit/head revision, validation evidence and any blockers. This RECEIPT.md is the durable completion signal.\n`,
        { flag: 'wx', mode: 0o444 },
      );
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(
        join(home, 'launch.sh'),
        `#!/usr/bin/env bash\nset +e\ncd -- ${quote(dispatch.worktree)} || exit 1\n${runner} ${quote(dispatch.brief_path)}\nresult=$?\nprintf '{"exit_code":%s}\\n' "$result" > ${quote(join(home, 'EXIT.json.tmp'))}\nmv -- ${quote(join(home, 'EXIT.json.tmp'))} ${quote(join(home, 'EXIT.json'))}\nexit "$result"\n`,
        { flag: 'wx', mode: 0o700 },
      );
      console.log(home);
    } catch (error) {
      throw new Error(`Preparation failed; lock retained at ${lock}: ${error.message}`);
    }
  } else if (action === 'get') {
    const [home, field] = args;
    console.log(JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8'))[field]);
  } else if (action === 'launched') {
    const [home, pane] = args;
    const file = join(home, 'dispatch.json');
    const dispatch = JSON.parse(readFileSync(file, 'utf8'));
    dispatch.tmux_pane = pane;
    writeFileSync(file, JSON.stringify(dispatch, null, 2) + '\n');
    console.log(JSON.stringify(dispatch, null, 2));
  } else throw new Error('Unknown worker state operation');
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
