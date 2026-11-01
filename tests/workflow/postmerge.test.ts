import {
  startRun,
  inspectRuns,
  dispatchStage,
  publishStageReceipt,
  acceptStageReceipt,
} from '../../packages/core/src/workflow/run-driver.js';
import type { IssueTurn } from '../../packages/core/src/workflow/issue-driver.js';
import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { finishDelivery } from '../../packages/core/src/workflow/postmerge.js';
test('merged delivery records and archives before releasing a real worktree; unknown occupancy retains it', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-finish-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(project, 'README'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  mkdirSync(join(project, 'pool'));
  const checkout = join(project, 'pool', 'issue-7');
  git('worktree', 'add', '-b', 'task', checkout);
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'HEAD',
  };
  let stopped = false,
    closed = 0,
    interrupted = false;
  const roles: string[] = [];
  const runner = {
    interactive: true,
    name: 'codex',
    async preflight() {},
    async start(a: IssueTurn) {
      roles.push(a.role);
      return { conversation: a.id, address: 'tmux:test', evidence: 'started' };
    },
    async collect(a: IssueTurn) {
      if (a.role === 'orchestrator' && !interrupted) {
        interrupted = true;
        throw Error('notification lost after cleanup');
      }
      return a.role === 'worker'
        ? JSON.stringify({
            complete: true,
            assessment: 'delivered',
            worklog: 'Verified merged delivery',
            followups: [],
            releaseEvidence: 'Controlled runner termination independently verified by driver',
          })
        : 'Orchestrator received completion';
    },
    async stopped() {
      return stopped;
    },
  };
  const provider = {
    async merged() {
      return true;
    },
    async close() {
      closed++;
    },
  };
  try {
    const managed = await startRun(
      config,
      runner,
      { repository: 'o/r', number: 7, title: 'delivery', body: 'bounded', kind: 'issue' },
      'codex',
    );
    // Supply the already accepted quality/merge boundary required by managed postmerge.
    stopped = true;
    let predecessor: string[] = [];
    for (const stage of ['implementation', 'pr-quality', 'pr-merge']) {
      const d = await dispatchStage(config, runner, {
        runId: managed.id,
        authority: managed.orchestratorId,
        subject: 'o/r#7',
        role: stage === 'implementation' ? 'worker' : 'landing',
        stage,
        inputRevision: 'merged-head',
        brief: stage,
        prerequisites: predecessor,
        checkout,
      });
      const evidence = join(d.attempts[0].directory, 'verified.txt');
      writeFileSync(evidence, 'verified');
      const { createHash } = await import('node:crypto');
      const receipt = publishStageReceipt(config, {
        dispatchId: d.id,
        attemptId: d.attempts[0].id,
        runId: managed.id,
        subject: d.subject,
        role: d.role,
        stage,
        provider: 'codex',
        inputRevision: d.inputRevision,
        outcome: 'completed',
        evidence: [{ path: evidence, hash: createHash('sha256').update('verified').digest('hex') }],
      });
      await acceptStageReceipt(config, managed.orchestratorId, receipt.id, async () => ({
        currentRevision: d.inputRevision,
        ownership: true,
        evidence: 'verified merge boundary',
      }));
      predecessor = [d.id];
    }
    stopped = false;
    roles.length = 0;
    await expect(
      finishDelivery(config, runner, provider, { repository: 'o/r', issue: 7, checkout }, 4, []),
    ).rejects.toThrow(/occupancy/);
    expect(existsSync(checkout)).toBe(true);
    expect(closed).toBe(0);
    expect(inspectRuns(config).runs[0].lifecycle).toBe('running');
    stopped = true;
    await expect(
      finishDelivery(config, runner, provider, { repository: 'o/r', issue: 7, checkout }, 4, []),
    ).rejects.toThrow('notification lost');
    expect(existsSync(checkout)).toBe(false);
    const done = await finishDelivery(
      config,
      runner,
      provider,
      { repository: 'o/r', issue: 7, checkout },
      4,
      [],
    );
    expect(done.status).toBe('done');
    expect(existsSync(checkout)).toBe(false);
    expect(existsSync(join(done.archive!, '.epic-worklog.md'))).toBe(true);
    expect(closed).toBe(1);
    expect(roles).toEqual(['worker', 'landing', 'orchestrator']);
    const graph = inspectRuns(config);
    expect(graph.deliveries?.[0]).toMatchObject({
      runId: managed.id,
      recorded: true,
      released: true,
      status: 'done',
    });
    expect(
      graph.dispatches
        ?.filter((d) => !['implementation', 'pr-quality', 'pr-merge'].includes(d.stage))
        .map((d) => [d.stage, d.lifecycle]),
    ).toEqual([
      ['final-records', 'accepted'],
      ['preservation-cleanup', 'accepted'],
    ]);
    expect(graph.runs[0].lifecycle).toBe('completed');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
