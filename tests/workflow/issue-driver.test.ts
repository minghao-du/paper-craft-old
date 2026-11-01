import {
  startRun,
  referenceRunSubject,
  inspectRuns,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from 'vitest';
import {
  driveIssue,
  inspectIssueRun,
  readIssue,
} from '../../packages/core/src/workflow/delivery/issue-driver.js';
import { type ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';
test('standalone intake automatically routes two worker results back to orchestrator without replay', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-drive-')));
  mkdirSync(join(project, 'pool'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project });
  git('init', '-q');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.org',
    'commit',
    '--allow-empty',
    '-m',
    'initial',
  );
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'HEAD',
  };
  let workerResults = 0;
  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return true;
    },
    async preflight() {},
    async start(a: ManagedAttempt) {
      return { conversation: a.conversation ?? a.id, address: 'tmux:test', evidence: 'received' };
    },
    async collect(a: ManagedAttempt) {
      if (a.role === 'worker')
        return JSON.stringify({
          status: 'completed',
          repository: 'owner/repo',
          issue: 7,
          evidence: `delivered ${++workerResults}`,
        });
      return JSON.stringify(
        a.brief.includes('delivered 2')
          ? { action: 'done' }
          : { action: 'worker', brief: 'deliver' },
      );
    },
  };
  try {
    await startRun(
      config,
      runner,
      { repository: 'owner/repo', number: 7, kind: 'issue', title: 'task', body: 'deliver' },
      'codex',
    );
    const issue = {
      repository: 'owner/repo',
      number: 7,
      title: 'task',
      body: 'deliver',
      parent: 3,
      blockedBy: [],
    };
    await expect(driveIssue(config, runner, { ...issue, blockedBy: [6] })).rejects.toThrow(
      /dependencies/,
    );
    const first = await driveIssue(config, runner, issue);
    expect(first.parent).toBe(3);
    expect(
      first.turns.filter((t) => t.role === 'worker').every((t) => t.brief.includes('no siblings')),
    ).toBe(true);
    expect(first.status).toBe('done');
    expect(first.turns.filter((t) => t.role === 'worker')).toHaveLength(2);
    expect(first.turns.find((t) => t.role === 'worker')?.brief).toContain('AGENTS.md');
    const failedIssue = { ...issue, number: 8 };
    referenceRunSubject(config, inspectRuns(config).runs[0].id, 'owner/repo#8');
    const failedRunner = {
      ...runner,
      async start() {
        throw new Error('lost acknowledgement');
      },
    };
    await expect(driveIssue(config, failedRunner, failedIssue)).rejects.toThrow(
      'Expected actual Runner receipt',
    );
    const failed = inspectIssueRun(config, 'owner/repo', 8)!;
    expect(failed).toMatchObject({ status: 'blocked' });
    expect(failed.turns[0].brief).toContain('owner/repo#8');
    await expect(driveIssue(config, runner, failedIssue)).rejects.toThrow('Missing receipt');
    expect(inspectIssueRun(config, 'owner/repo', 8)?.turns).toHaveLength(1);
    await expect(driveIssue(config, runner, { ...issue, parent: 9 })).rejects.toThrow('EPIC #9');
    const second = await driveIssue(config, runner, issue);
    expect(second.turns).toHaveLength(first.turns.length);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 20000);

test('GitHub intake retains repository and parent identity and fails on unreadable metadata', () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-intake-')));
  const previous = process.env.PATH;
  try {
    const gh = join(project, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env node
if(process.argv.includes('view')) console.log(JSON.stringify('owner/repo').slice(1,-1));
else if (process.argv.some(a => a.includes('blocked_by'))) console.log('[]');
else console.log(process.env.PC_TEST_GH_FAILURE ? JSON.stringify({errors:[{message:'unavailable'}]}) : JSON.stringify({data:{repository:{nameWithOwner:'owner/repo',issue:{number:7,title:'task',body:'body',parent:{number:9}}}}}));
`,
      { mode: 0o700 },
    );
    process.env.PATH = project + ':' + previous;
    expect(readIssue(project, 7)).toMatchObject({ repository: 'owner/repo', number: 7, parent: 9 });
    process.env.PC_TEST_GH_FAILURE = '1';
    expect(() => readIssue(project, 7)).toThrow('Expected accessible GitHub issue');
  } finally {
    process.env.PATH = previous;
    delete process.env.PC_TEST_GH_FAILURE;
    rmSync(project, { recursive: true, force: true });
  }
}, 10000);
