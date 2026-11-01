import { test, expect } from 'vitest';
import {
  finalizeEpic,
  type EpicFinalization,
} from '../../packages/core/src/workflow/delivery/epic-finalization.js';

const context = {
  head: 'a'.repeat(40),
  checkout: '/snapshot',
  terminalSession: 'fleet',
  changes: 'merged workflow script',
};
const receipt = {
  head: context.head,
  status: 'completed' as const,
  evidence: ['verified run'],
  blockers: [] as string[],
  scope: ['rule'],
  checks: ['production smoke'],
  artifacts: ['/smoke/result'],
  limitations: [],
  disposition: 'completed_no_changes' as const,
  inspectedVersions: { repository: context.head },
  findings: [],
  maintenance: [],
};

test.each(['blocked', 'wrong SHA', 'missing evidence'])(
  '%s pipeline receipt prevents research writing',
  async (failure) => {
    const state: EpicFinalization = { context };
    const roles: string[] = [];
    await expect(
      finalizeEpic(
        state,
        'original goal',
        async (role) => {
          roles.push(role);
          if (role === 'epic')
            return JSON.stringify({
              pipeline: { run: true, reason: 'changed script' },
              research: { run: true, reason: 'new findings' },
              coordinator: {
                identity: 'coordinator',
                entry: '/research/research-state/RESEARCH-STATE.local.md',
                brief: 'confirmed findings',
              },
            });
          return JSON.stringify({
            ...receipt,
            ...(failure === 'blocked'
              ? { status: 'blocked', blockers: ['smoke failed'] }
              : failure === 'wrong SHA'
                ? { head: 'other' }
                : { evidence: [] }),
          });
        },
        () => {},
      ),
    ).rejects.toThrow();
    expect(roles).toEqual(['epic', 'pipeline-audit']);
  },
);

test('changed integration requires a fresh applicability audit despite reuse suggestion', async () => {
  const prior: EpicFinalization = {
    context,
    pipeline: receipt,
    research: { status: 'skipped', reason: 'No scientific impact' },
  };
  const state: EpicFinalization = { context: { ...context, head: 'b'.repeat(40) } };
  const roles: string[] = [];
  await finalizeEpic(
    state,
    'original goal',
    async (role) => {
      roles.push(role);
      if (role === 'pipeline-audit')
        return JSON.stringify({ ...receipt, head: state.context.head });
      return JSON.stringify({
        pipeline: {
          run: true,
          reuse: true,
          reason: 'Only unrelated README changed since prior smoke',
        },
        research: { run: false, reason: 'No scientific impact' },
      });
    },
    () => {},
    prior,
  );
  expect(roles).toEqual(['epic', 'pipeline-audit']);
  expect(state.pipeline).toMatchObject({
    status: 'completed',
    head: state.context.head,
    checks: ['production smoke'],
  });
});

test('every EPIC audits applicability and required maintenance blocks reporting', async () => {
  const roles: string[] = [];
  const state: EpicFinalization = { context };
  await expect(
    finalizeEpic(
      state,
      'goal',
      async (role) => {
        roles.push(role);
        if (role === 'epic')
          return JSON.stringify({
            pipeline: { run: false, reason: 'No workflow changes' },
            research: { run: false, reason: 'No impact' },
          });
        return JSON.stringify({
          ...receipt,
          disposition: 'changes_needed',
          inspectedVersions: { repository: context.head },
          findings: [
            {
              id: 'layout',
              classification: 'required_maintenance',
              description: 'Move affected rule',
              evidence: ['rule graph'],
              issue: 123,
            },
          ],
          maintenance: [],
        });
      },
      () => {},
    ),
  ).rejects.toThrow(/Pipeline/);
  expect(roles).toEqual(['epic', 'pipeline-audit']);
  expect(state.pipeline).toMatchObject({ disposition: 'changes_needed' });
});

test.each([
  'not_applicable',
  'completed_no_changes',
  'completed',
  'acceptance_invalidated',
] as const)('Pipeline %s gates finalization with inspected versions', async (disposition) => {
  const state: EpicFinalization = { context };
  const work = finalizeEpic(
    state,
    'goal',
    async (role) =>
      role === 'epic'
        ? JSON.stringify({
            pipeline: { run: false, reason: 'planning opinion' },
            research: { run: false, reason: 'no impact' },
          })
        : JSON.stringify({
            ...receipt,
            disposition,
            findings:
              disposition === 'acceptance_invalidated'
                ? [
                    {
                      id: 'invalid',
                      classification: 'invalidates_acceptance',
                      description: 'Outcome unsupported',
                      evidence: ['failed reproduction'],
                    },
                  ]
                : [],
          }),
    () => {},
  );
  if (disposition === 'acceptance_invalidated') await expect(work).rejects.toThrow(/Pipeline/);
  else await work;
  expect(state.pipeline?.disposition).toBe(disposition);
});

test('maintenance waits for ledger approval and complete delivery before specialist verification', async () => {
  const state: EpicFinalization = {
    context,
    plan: { pipeline: { run: true, reason: 'audit' }, research: { run: false, reason: 'none' } },
    pipeline: {
      ...receipt,
      disposition: 'changes_needed',
      findings: [
        {
          id: 'move',
          classification: 'required_maintenance',
          description: 'Move rule',
          evidence: ['audit'],
          issue: 123,
          migrationLedger: 'ledger-v1',
        },
      ],
    },
  };
  const calls: string[] = [];
  const provider = {
    identify: async () => 123,
    approveMigration: async () => undefined,
    deliver: async () => {
      calls.push('worker');
      return { pr: 4, version: 'fix', evidence: 'archive', status: 'done' as const };
    },
  };
  const turn = async () => {
    calls.push('verify');
    return JSON.stringify({
      ...receipt,
      disposition: 'completed',
      findings: state.pipeline!.findings,
      maintenance: [
        {
          finding: 'move',
          issue: 123,
          delivered: true,
          verifiedVersions: { repository: 'fix' },
          evidence: ['verification'],
        },
      ],
    });
  };
  await expect(finalizeEpic(state, 'goal', turn, () => {}, undefined, provider)).rejects.toThrow(
    /Ledger/,
  );
  expect(calls).toEqual([]);
  provider.approveMigration = async () => ({
    source: 'human' as const,
    ledger: 'ledger-v1',
    evidence: 'approved exact ledger',
  });
  await finalizeEpic(state, 'goal', turn, () => {}, undefined, provider);
  expect(calls).toEqual(['worker', 'verify']);
  expect(state.pipeline?.disposition).toBe('completed');
});

test('managed reporting serializes aliases, preserves prior report on failure and publishes verified provenance', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'pc-report-'));
  const entry = join(home, 'README.md');
  const alias = home + '-alias';
  symlinkSync(home, alias);
  writeFileSync(entry, 'previous accepted report');
  const state: EpicFinalization = {
    context: {
      ...context,
      requireReport: true,
      closureEvidence: 'closed-confirmed',
      acceptedVersions: { repository: 'accepted-sha' },
      observedVersions: { repository: 'concurrent-sha' },
    },
    plan: {
      pipeline: { run: true, reason: 'audit' },
      research: { run: true, reason: 'report' },
      coordinator: { identity: 'project', entry, brief: 'confirmed' },
    },
    pipeline: receipt,
  };
  try {
    await expect(
      finalizeEpic(
        state,
        'goal',
        async () => {
          throw new Error('writer failed');
        },
        () => {},
      ),
    ).rejects.toThrow('writer failed');
    expect(readFileSync(entry, 'utf8')).toBe('previous accepted report');
    const { releaseResearchWriter } =
      await import('../../packages/core/src/workflow/delivery/research-report.js');
    await expect(releaseResearchWriter(entry, async () => false)).rejects.toThrow(/termination/);
    await releaseResearchWriter(entry, async () => true);
    await finalizeEpic(
      state,
      'goal',
      async (_role, brief) => {
        const other = structuredClone(state);
        other.plan!.coordinator!.entry = join(alias, 'README.md');
        await expect(
          finalizeEpic(
            other,
            'goal',
            async () => {
              throw new Error('must not launch');
            },
            () => {},
          ),
        ).rejects.toThrow(/occupied/);
        const candidate = brief.match(/candidate report ([^;]+);/)![1];
        writeFileSync(
          candidate,
          [
            'Objective',
            'Accepted delivery versions',
            'Observed repository versions',
            'Pipeline disposition',
            'Verified findings',
            'Interpretation',
            'Missing evidence',
            'Follow-up Issues',
            'Limitations',
          ]
            .map((h) => '# ' + h + '\nEvidence or explicit none')
            .join('\n'),
        );
        return JSON.stringify(receipt);
      },
      () => {},
    );
    expect(state.report?.acceptedVersions).toEqual({ repository: 'accepted-sha' });
    expect(state.report?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(entry, 'utf8')).toContain('accepted-sha');
    expect(readFileSync(state.report!.path, 'utf8')).toContain('Verified workflow provenance');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(alias, { force: true });
  }
});
