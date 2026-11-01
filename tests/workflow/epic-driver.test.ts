import {
  startRun,
  referenceRunSubject,
  inspectRuns,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from 'vitest';
import { type ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';
import { driveEpic } from '../../packages/core/src/workflow/delivery/epic-driver.js';

test('EPIC planning dispatches independent work concurrently, then dependencies, with attributed feedback', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-epic-')));
  mkdirSync(join(project, 'pool'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project });
  git('init', '-q');
  writeFileSync(join(project, '.git', 'info', 'exclude'), '.pc-execution-owner\n');
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
  let active = 0,
    peak = 0,
    interrupted = false;
  const delivered: number[] = [];
  let epicConversation: string | undefined;
  const tasks = [
    { number: 7, title: 'first', body: 'first', brief: 'deliver A', blockedBy: [], ready: true },
    {
      number: 8,
      title: 'parallel',
      body: 'parallel',
      brief: 'deliver B',
      blockedBy: [],
      ready: true,
    },
    {
      number: 9,
      title: 'dependent',
      body: 'dependent',
      brief: 'deliver C',
      blockedBy: [7, 8],
      ready: true,
    },
  ];
  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return true;
    },
    async preflight() {},
    async start(a: ManagedAttempt) {
      return {
        conversation: a.role === 'epic' ? 'epic-session' : (a.conversation ?? a.id),
        address: 'tmux:test',
        evidence: 'received',
      };
    },
    async collect(a: ManagedAttempt) {
      if (a.role === 'epic') {
        epicConversation ??= a.conversation;
        expect(a.conversation).toBe(epicConversation);
        return JSON.stringify({ goal: 'deliver all', constraints: ['keep scope'], tasks });
      }
      if (a.role === 'worker') {
        const n = Number(a.brief.match(/Issue #(\d+)/)?.[1]);
        if (n === 9) {
          expect(delivered.sort()).toEqual([7, 8]);
          expect(readFileSync(join(a.checkout, 'api-7'), 'utf8')).toBe('API 7');
          expect(readFileSync(join(a.checkout, 'api-8'), 'utf8')).toBe('API 8');
        }
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        if (n === 7 && !interrupted) {
          interrupted = true;
          throw Error('lost collection');
        }
        if (n !== 9) {
          writeFileSync(join(a.checkout, `api-${n}`), `API ${n}`);
          execFileSync('git', ['add', `api-${n}`], { cwd: a.checkout });
          execFileSync(
            'git',
            [
              '-c',
              'user.name=Test',
              '-c',
              'user.email=test@example.org',
              'commit',
              '-m',
              `API ${n}`,
            ],
            { cwd: a.checkout },
          );
        }
        delivered.push(n);
        return JSON.stringify({
          status: 'completed',
          repository: 'owner/repo',
          issue: n,
          evidence: `result ${n}`,
        });
      }
      return 'feedback received';
    },
  };
  try {
    await startRun(
      config,
      runner,
      { repository: 'owner/repo', number: 35, kind: 'epic', title: 'goal', body: 'deliver all' },
      'codex',
    );
    await expect(
      driveEpic(
        config,
        runner,
        { repository: 'owner/repo', number: 35, title: 'goal', body: 'deliver all' },
        2,
        { repository: 'owner/repo', number: 7, title: 'first', body: 'original child', parent: 35 },
      ),
    ).rejects.toThrow('Worker stage failed');
    const run = await driveEpic(
      config,
      runner,
      { repository: 'owner/repo', number: 35, title: 'goal', body: 'deliver all' },
      2,
    );
    expect(run.status).toBe('delivered');
    expect(peak).toBe(2);
    expect(run.goal).toBe('deliver all');
    expect(run.turns.filter((t) => t.role === 'orchestrator').at(-1)?.brief).toContain('result 9');
    expect(
      run.turns.filter((t) => t.role === 'worker').every((t) => t.brief.includes('AGENTS.md')),
    ).toBe(true);
    epicConversation = undefined;
    referenceRunSubject(config, inspectRuns(config).runs[0].id, 'owner/other#36');
    await expect(
      driveEpic(
        config,
        runner,
        { repository: 'owner/other', number: 36, title: 'collision', body: 'same task numbers' },
        2,
      ),
    ).rejects.toThrow('Checkout occupied');
    expect(delivered).toHaveLength(3);
    const count = run.turns.length;
    expect(
      (
        await driveEpic(
          config,
          runner,
          { repository: 'owner/repo', number: 35, title: 'goal', body: 'deliver all' },
          2,
        )
      ).turns,
    ).toHaveLength(count);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 20000);

test('blocked EPIC work retains scope without dispatch and separates repository and Fleet identity', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-epic-block-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'HEAD',
  };
  const started: ManagedAttempt[] = [];
  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return true;
    },
    async preflight() {},
    async start(a: ManagedAttempt) {
      started.push(a);
      return {
        conversation: a.role === 'epic' ? 'epic-session' : (a.conversation ?? a.id),
        address: 'tmux:test',
        evidence: 'received',
      };
    },
    async collect(a: ManagedAttempt) {
      return a.role === 'epic'
        ? JSON.stringify({
            goal: 'blocked goal',
            constraints: ['await input'],
            tasks: [
              {
                number: 7,
                title: 'held',
                body: 'held',
                brief: 'wait',
                blockedBy: [],
                ready: false,
              },
            ],
          })
        : 'ready';
    },
  };
  try {
    await startRun(
      config,
      runner,
      { repository: 'owner/one', number: 35, kind: 'epic', title: 'goal', body: 'goal' },
      'codex',
    );
    const epic = { repository: 'owner/one', number: 35, title: 'goal', body: 'goal' };
    await expect(driveEpic(config, runner, epic)).rejects.toThrow('readiness blockers');
    expect(started.filter((t) => t.role === 'worker')).toHaveLength(0);
    const { inspectEpicRun } = await import('../../packages/core/src/workflow/delivery/epic-driver.js');
    expect(inspectEpicRun(config, 'owner/one', 35)?.status).toBe('blocked');
    expect(inspectEpicRun(config, 'owner/two', 35)).toBeUndefined();
    expect(
      inspectEpicRun({ ...config, file: join(project, 'other-config.json') }, 'owner/one', 35),
    ).toBeUndefined();
    await expect(driveEpic(config, runner, epic)).rejects.toThrow(
      'unresolved semantic dependencies',
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 10000);
