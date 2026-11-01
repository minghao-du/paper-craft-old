import { writeFileSync } from 'node:fs';
import { startRun } from '../../packages/core/src/workflow/run-driver.js';
import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeEpic } from '../../packages/core/src/workflow/epic-completion.js';
test('goal evidence and explicit target human confirmation gate EPIC closure; repeats do not close twice', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-epic-close-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, 'config'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let satisfied = false,
    closed = 0,
    landed = 0;
  let specialistPlans = 0;
  let head = 'a'.repeat(40);
  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return true;
    },
    async preflight() {},
    async start(a: { id: string }) {
      return { conversation: a.id, address: 'tmux:fleet:window', evidence: 'receipt' };
    },
    async collect(a: { role: string; brief: string }) {
      if (a.role === 'research-state' && a.brief.includes('Write ONLY the candidate report')) {
        const candidate = a.brief.match(/candidate report (.*?); do not/)![1];
        writeFileSync(
          candidate,
          'Objective\nAccepted delivery versions\nObserved repository versions\nPipeline disposition\nVerified findings\nInterpretation\nMissing evidence\nFollow-up Issues\nLimitations',
        );
        return JSON.stringify({
          head: head,
          status: 'completed',
          evidence: ['verified report'],
          blockers: [],
          scope: [],
          checks: [],
          artifacts: [candidate],
          limitations: [],
        });
      }

      if (a.brief.includes('Confirm applicability')) {
        specialistPlans++;
        expect(closed).toBe(1);
        return JSON.stringify({
          pipeline: { run: false, reason: 'No workflow changes' },
          coordinator: {
            identity: 'Project coordinator',
            entry: join(project, 'RESEARCH-STATE.local.md'),
            brief: 'verified judgments',
          },
          research: { run: false, reason: 'No scientific impact' },
        });
      }
      if (a.role === 'pipeline-audit')
        return JSON.stringify({
          head,
          status: 'completed',
          evidence: ['inspected project'],
          blockers: [],
          scope: [],
          checks: ['applicability'],
          artifacts: [],
          limitations: [],
          disposition: 'not_applicable',
          inspectedVersions: { repository: head },
          findings: [],
          maintenance: [],
        });
      return a.role === 'epic'
        ? JSON.stringify({
            satisfied,
            criteria: ['objective demonstrated'],
            blockers: satisfied ? [] : ['missing evidence'],
          })
        : 'Completion evidence received; confirm EPIC closure.';
    },
  };
  const epic = {
    repository: 'o/r',
    epic: 1,
    goal: 'Original goal',
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
        head,
        checkout: project,
        terminalSession: 'fleet',
        observedVersions: { repository: 'a'.repeat(40) },
        changes: 'verified PR diff',
      };
    },
    async deliver() {
      landed++;
      return 'merged, recorded and archived';
    },
    async close() {
      closed++;
    },
  };
  try {
    await startRun(
      config,
      runner,
      { repository: 'o/r', number: 1, title: 'goal', body: 'goal', kind: 'epic' },
      'codex',
    );
    expect((await completeEpic(config, runner, provider, epic)).status).toBe('blocked');
    expect(closed).toBe(0);
    satisfied = true;
    expect((await completeEpic(config, runner, provider, epic)).status).toBe(
      'awaiting_confirmation',
    );
    expect(
      (
        await completeEpic(config, runner, provider, epic, {
          epic: 1,
          confirmed: false,
          source: 'human',
          evidence: 'No',
        })
      ).status,
    ).toBe('awaiting_confirmation');
    expect(closed).toBe(0);
    expect(specialistPlans).toBe(0);
    head = 'b'.repeat(40);
    await expect(
      completeEpic(config, runner, provider, epic, {
        epic: 1,
        confirmed: true,
        source: 'human',
        evidence: 'stale confirmation',
      }),
    ).rejects.toThrow('Baseline changed');
    expect(closed).toBe(0);
    await completeEpic(config, runner, provider, epic);

    expect(
      (
        await completeEpic(config, runner, provider, epic, {
          epic: 1,
          confirmed: true,
          source: 'human',
          evidence: 'Close EPIC 1',
        })
      ).status,
    ).toBe('completed');
    await completeEpic(config, runner, provider, epic);
    expect(closed).toBe(1);
    expect(landed).toBe(1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('post-closure specialist failures preserve attempts and block reporting until verified retry', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-finalization-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, 'config'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  const head = 'a'.repeat(40);
  let closed = 0,
    failStartup = true,
    terminated = false;
  const starts: string[] = [];
  const epic = {
    repository: 'o/r',
    epic: 1,
    goal: 'Demonstrate research result',
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
  const runner = {
    interactive: true,
    name: 'codex',
    async preflight() {},
    async stopped(a: { role: string }) {
      return ['pipeline-audit', 'research-state'].includes(a.role) ? terminated : true;
    },
    async start(a: { id: string; role: string; terminalSession?: string }) {
      starts.push(a.role);
      if (a.role === 'pipeline-audit' && failStartup) throw new Error('lost acknowledgement');
      return {
        conversation: a.id,
        address: a.terminalSession ? `tmux:${a.terminalSession}:${a.id}` : 'tmux:fleet:controlled',
        evidence: 'runner acknowledgement',
      };
    },
    async collect(a: { role: string; brief: string }) {
      if (a.role === 'research-state' && a.brief.includes('Write ONLY the candidate report')) {
        const candidate = a.brief.match(/candidate report (.*?); do not/)![1];
        writeFileSync(
          candidate,
          'Objective\nAccepted delivery versions\nObserved repository versions\nPipeline disposition\nVerified findings\nInterpretation\nMissing evidence\nFollow-up Issues\nLimitations',
        );
        return JSON.stringify({
          head: head,
          status: 'completed',
          evidence: ['verified report'],
          blockers: [],
          scope: [],
          checks: [],
          artifacts: [candidate],
          limitations: [],
        });
      }

      if (a.brief.includes('Confirm applicability'))
        return JSON.stringify({
          pipeline: { run: true, reason: 'Changed workflow script' },
          research: { run: true, reason: 'New result' },
          coordinator: {
            identity: 'Project coordinator',
            entry: join(project, 'RESEARCH-STATE.local.md'),
            brief: 'Confirmed evidence and interpretation',
          },
        });
      if (a.role === 'pipeline-audit' || a.role === 'research-state')
        return JSON.stringify({
          head,
          status: 'completed',
          evidence: ['verified output'],
          disposition: 'completed_no_changes',
          inspectedVersions: { repository: head },
          findings: [],
          maintenance: [],
          blockers: [],
          scope: ['affected rule'],
          checks: ['production smoke'],
          artifacts: [],
          limitations: [],
        });
      if (a.role === 'epic')
        return JSON.stringify({
          satisfied: true,
          criteria: ['verified original objective'],
          blockers: [],
        });
      return 'Confirm closing this EPIC';
    },
  };
  const provider = {
    async finalizationContext() {
      return {
        head,
        checkout: project,
        terminalSession: 'fleet',
        observedVersions: { repository: 'a'.repeat(40) },
        changes: 'verified changed script',
      };
    },
    async deliver() {
      return 'merged and recorded';
    },
    async close() {
      closed++;
    },
  };
  const decision = { epic: 1, confirmed: true, source: 'human' as const, evidence: 'Close EPIC 1' };
  try {
    await startRun(
      config,
      runner,
      { repository: 'o/r', number: 1, title: 'goal', body: 'goal', kind: 'epic' },
      'codex',
    );
    await expect(completeEpic(config, runner, provider, epic, decision)).rejects.toThrow(
      'Specialist receipt',
    );
    await expect(completeEpic(config, runner, provider, epic, undefined, true)).rejects.toThrow(
      'verified specialist termination',
    );
    failStartup = false;
    await expect(completeEpic(config, runner, provider, epic, decision)).rejects.toThrow(
      'original receipt',
    );
    expect(starts.filter((r) => r === 'pipeline-audit')).toHaveLength(1);
    expect(starts).not.toContain('research-state');
    expect(closed).toBe(1);
    terminated = true;
    const retried = await completeEpic(config, runner, provider, epic, undefined, true);
    expect(retried.status).toBe('completed');
    expect(retried.turns.find((t) => t.role === 'pipeline-audit')?.retired).toBe(true);
    expect(retried.finalizationHistory).toHaveLength(1);
    expect(closed).toBe(1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
