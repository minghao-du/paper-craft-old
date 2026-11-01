import { startRun } from '../../packages/core/src/workflow/run-driver.js';
import { createHash } from 'node:crypto';
import { stateDirectory } from '../../packages/core/src/workflow/handoff.js';
import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeEpic } from '../../packages/core/src/workflow/epic-completion.js';
test('collection failure resumes the original acceptance attempt and preserves explicit closure across failed close', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-recovery-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, 'config'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let starts = 0,
    fail = true,
    closes = 0;
  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return true;
    },
    async preflight() {},
    async start() {
      starts++;
      return { conversation: 'same', address: 'tmux:fleet:test', evidence: 'receipt' };
    },
    async collect(a: { role: string; brief: string }) {
      if (a.role === 'research-state' && a.brief.includes('Write ONLY the candidate report')) {
        const candidate = a.brief.match(/candidate report (.*?); do not/)![1];
        writeFileSync(
          candidate,
          'Objective\nAccepted delivery versions\nObserved repository versions\nPipeline disposition\nVerified findings\nInterpretation\nMissing evidence\nFollow-up Issues\nLimitations',
        );
        return JSON.stringify({
          head: 'a'.repeat(40),
          status: 'completed',
          evidence: ['verified report'],
          blockers: [],
          scope: [],
          checks: [],
          artifacts: [candidate],
          limitations: [],
        });
      }

      if (fail) {
        fail = false;
        throw Error('collection unavailable');
      }
      if (a.brief.includes('Confirm applicability'))
        return JSON.stringify({
          pipeline: { run: false, reason: 'No workflow impact' },
          coordinator: {
            identity: 'Project coordinator',
            entry: join(project, 'RESEARCH-STATE.local.md'),
            brief: 'verified judgments',
          },
          research: { run: false, reason: 'No research changes' },
        });
      if (a.role === 'pipeline-audit')
        return JSON.stringify({
          head: 'a'.repeat(40),
          status: 'completed',
          blockers: [],
          scope: ['checked'],
          checks: ['applicability'],
          artifacts: [],
          limitations: [],
          maintenance: [],
          disposition: 'not_applicable',
          evidence: ['no pipeline'],
          inspectedVersions: { repository: 'a'.repeat(40) },
          findings: [],
        });
      return a.role === 'epic'
        ? JSON.stringify({ satisfied: true, criteria: ['verified goal'], blockers: [] })
        : 'Confirm closure';
    },
  };
  const epic = {
    repository: 'o/r',
    epic: 1,
    goal: 'goal',
    constraints: [],
    tasks: [
      {
        number: 2,
        title: 'child',
        body: 'scope',
        brief: 'work',
        blockedBy: [],
        ready: true,
        result: 'delivered',
        checkout: project,
      },
    ],
    turns: [],
    status: 'delivered' as const,
  };
  const provider = {
    async finalizationContext() {
      return {
        head: 'a'.repeat(40),
        checkout: project,
        terminalSession: 'fleet',
        observedVersions: { repository: 'a'.repeat(40) },
        changes: 'verified PR files',
      };
    },
    async deliver() {
      return 'archived';
    },
    async close() {
      closes++;
      if (closes === 1) throw Error('network');
    },
  };
  try {
    await startRun(
      config,
      runner,
      { repository: 'o/r', number: 1, title: 'goal', body: 'goal', kind: 'epic' },
      'codex',
    );
    const key = createHash('sha256').update(`${config.file}:o/r:1`).digest('hex');
    const stale = join(stateDirectory(config, '.runtime', 'epic-completion', key), 'driver.lock');
    mkdirSync(stale);
    writeFileSync(join(stale, 'pid'), '2147483647');
    await expect(completeEpic(config, runner, provider, epic)).rejects.toThrow('collection');
    await expect(
      completeEpic(config, runner, provider, epic, {
        epic: 1,
        confirmed: true,
        source: 'human',
        evidence: 'yes',
      }),
    ).rejects.toThrow('network');
    expect(starts).toBe(3);
    expect((await completeEpic(config, runner, provider, epic)).status).toBe('completed');
    expect(starts).toBe(6);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

import { recoverAllRuns } from '../../packages/core/src/workflow/recovery.js';
import { writeFileSync } from 'node:fs';
import { inspectRuns, recoverRun } from '../../packages/core/src/workflow/run-driver.js';
test('batch recovery isolates failed providers, preserves unknown ownership and blocks legacy work', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-batch-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, 'config'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let receipts = 0;
  const runner = {
    interactive: true,
    name: 'codex',
    async preflight() {},
    async start() {
      throw Error('lost notification');
    },
    async recoverReceipt() {
      receipts++;
      return undefined;
    },
  };
  try {
    const first = await startRun(
      config,
      runner,
      { repository: 'o/r', number: 1, title: 'one', body: 'one', kind: 'issue' },
      'codex',
    );
    const second = await startRun(
      config,
      { ...runner, name: 'claude' },
      { repository: 'o/r', number: 2, title: 'two', body: 'two', kind: 'issue' },
      'claude',
    );
    const legacy = stateDirectory(config, '.runtime', 'legacy');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, 'task.json'),
      JSON.stringify({ repository: 'o/r', issue: 3, turns: [] }),
    );
    writeFileSync(join(legacy, ['con', 'ductor.json'].join('')), 'invalid ignored global record');
    const result = await recoverAllRuns(config, (provider) => {
      if (provider === 'claude') throw Error('provider unavailable');
      return runner;
    });
    expect(result.outcomes.map((o) => o.run)).toEqual([first.id, second.id]);
    expect(result.outcomes[0].blockers).toContain(
      'Orchestrator startup pending; unknown occupancy remains reserved',
    );
    expect(result.outcomes[1].error).toContain('provider unavailable');
    expect(result.legacy).toEqual([
      {
        file: join(legacy, 'task.json'),
        status: 'blocked',
        error: 'Work has no Run ownership; complete or archive it explicitly',
      },
    ]);
    expect(result.status).toBe('unknown');
    expect(receipts).toBe(1);
    expect(inspectRuns(config).runs.map((r) => r.orchestratorId)).toEqual([
      first.orchestratorId,
      second.orchestratorId,
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('Run recovery restores attributed startup evidence without relaunch or touching another Run', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-receipt-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, 'config'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let launches = 0;
  const runner = {
    interactive: true,
    name: 'codex',
    async preflight() {},
    async start() {
      launches++;
      throw Error('notification lost');
    },
    async recoverReceipt() {
      return { conversation: 'original', address: 'tmux:original', evidence: 'receipt' };
    },
  };
  try {
    const first = await startRun(
      config,
      runner,
      { repository: 'o/r', number: 1, title: 'one', body: 'one', kind: 'issue' },
      'codex',
    );
    const other = await startRun(
      config,
      runner,
      { repository: 'o/r', number: 2, title: 'two', body: 'two', kind: 'issue' },
      'codex',
    );
    await expect(recoverRun(config, runner, '')).rejects.toThrow('valid Run id');
    await expect(recoverRun(config, runner, 'missing')).rejects.toThrow('Unknown Run');
    expect((await recoverRun(config, runner, first.id)).blockers).toEqual([]);
    await recoverRun(config, runner, first.id);
    const denied = await recoverRun(config, runner, first.id, {
      replaceOrchestrator: true,
      stopped: async () => false,
    });
    expect(denied.blockers).toContain(
      'Orchestrator occupancy unresolved; verify termination before replacement',
    );
    expect(launches).toBe(2);
    const runs = inspectRuns(config).runs;
    expect(runs.find((r) => r.id === first.id)?.orchestrator?.conversation).toBe('original');
    expect(runs.find((r) => r.id === other.id)?.orchestrator?.status).toBe('unknown');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
