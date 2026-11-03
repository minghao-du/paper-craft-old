import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoVerifier, type DemoEvidence } from '../../packages/core/src/workflow/demo/verifier.js';
import type { DemoRound } from '../../packages/core/src/workflow/demo/round.js';

test('public checker retains premature-start findings even after correct output arrives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'checker-'));
  try {
    const round = { id: 'controlled-checker-only', root } as DemoRound;
    const evidence: DemoEvidence = {
      source: 'controlled',
      references: ['fixture'],
      checks: [
        {
          stage: 'delivery',
          expected: 'Worker 2 after complete handover',
          observed: 'Worker 2 started early',
          verdict: 'finding',
        },
      ],
      business: 'completed',
      execution: 'released',
      cleanup: 'pending',
    };
    const verifier = new DemoVerifier({ collect: async () => evidence });
    expect((await verifier.verify(round, 'delivery')).defects).toBe('findings');
    evidence.checks = [
      {
        stage: 'delivery',
        expected: 'four computed values',
        observed: 'correct JSON',
        verdict: 'pass',
      },
    ];
    expect((await verifier.verify(round, 'final')).defects).toBe('findings');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

// Raw GitHub metadata adapter only; Git objects, registry and control journal are real local fixtures.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { nativeDemoEvidence } from '../../packages/core/src/workflow/demo/verifier.js';
import { loadFleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';
import { stateDirectory } from '../../packages/core/src/workflow/handoff.js';

test('native inspection rejects invalid raw delivery, provider, execution and observation evidence', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'checker-raw-')));
  try {
    const checkout = join(root, 'checkout'),
      pool = join(root, 'worktrees');
    mkdirSync(checkout);
    mkdirSync(pool);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: checkout,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'checker@example.invalid');
    git('config', 'user.name', 'Checker');
    writeFileSync(join(checkout, 'README.md'), 'controlled fixture');
    git('add', '.');
    git('commit', '-m', 'baseline');
    const initial = git('rev-parse', 'HEAD');
    writeFileSync(
      join(checkout, 'data.tsv'),
      'id\tvalue\n1\t10\n2\t20\n3\t30\n4\t40\n5\t50\n6\t60\n7\t70\n8\t80\n9\t90\n10\t100\n',
    );
    writeFileSync(join(checkout, 'summary.json'), '{"n":10,"mean":55,"min":10,"max":100}');
    git('add', '.');
    git('commit', '-m', 'actual toy artifacts');
    const merged = git('rev-parse', 'HEAD');
    writeFileSync(
      join(checkout, '.epic-config.json'),
      JSON.stringify({
        main_checkout: checkout,
        clone_root: pool,
        clone_names: [],
        local_worktrees: true,
      }),
    );
    const config = loadFleetConfig(join(checkout, '.epic-config.json'));
    const registryPath = join(
      stateDirectory(config, '.runtime', createHash('sha256').update(config.file).digest('hex')),
      'registry.json',
    );
    const round = {
      id: 'raw-fixture',
      root,
      checkout,
      entry: join(root, 'report.md'),
      repository: { id: 7, owner: 'fixture', name: 'toy' },
      parent: 1,
    } as DemoRound;
    const registry = {
      revision: 1,
      runs: [
        {
          id: 'run',
          subject: { repository: 'fixture/toy', number: 1 },
          provider: 'claude',
          lifecycle: 'completed',
        },
      ],
      dispatches: [
        {
          id: 'worker2',
          runId: 'run',
          subject: 'fixture/toy#3',
          role: 'worker',
          stage: 'work',
          provider: 'claude',
          inputRevision: initial,
          attempts: [],
          lifecycle: 'accepted',
        },
      ],
      resources: [{ runId: 'run', path: checkout, registry: registryPath }],
    };
    writeFileSync(registryPath, JSON.stringify(registry));
    writeFileSync(
      join(root, 'control.json'),
      JSON.stringify({
        runId: 'run',
        execution: 'running',
        observations: [{ id: 'observation', text: 'suspected problem' }],
      }),
    );
    const reader = nativeDemoEvidence({
      github(path) {
        if (path.endsWith('/fixture/toy')) return { id: 7 };
        if (path.includes('/sub_issues')) return [{ number: 2 }, { number: 3 }];
        if (path.includes('/blocked_by')) return [{ number: 2 }];
        if (path.includes('/pulls?'))
          return [1, 2].map((number) => ({
            number,
            merged_at: `2026-01-0${number}`,
            merge_commit_sha: merged,
            head: { sha: merged },
          }));
        return { state: 'closed' };
      },
    });
    const result = await new DemoVerifier(reader).verify(round);
    const diagnostic = (expected: string) => result.checks.find((c) => c.expected === expected);
    expect(diagnostic('Only n=10 mean=55 min=10 max=100')?.verdict).toBe('pass');
    expect(diagnostic('Worker 2 starting revision contains merged PR 1')?.verdict).toBe('finding');
    expect(diagnostic('Merged tested/reviewed HEAD with Final Records and release')?.verdict).toBe(
      'finding',
    );
    expect(diagnostic('Agy dispatch and stage-matched accepted Receipt')?.verdict).toBe('finding');
    expect(result.business).toBe('completed');
    expect(result.execution).toBe('unknown');
    expect(
      diagnostic('Attributable observation journal with no unresolved observations')?.verdict,
    ).toBe('missing');
    expect(result.defects).toBe('findings');
    // A separate collection after replacing all controlled external facts exercises the valid path.
    const clean = JSON.parse(JSON.stringify(registry));
    const attemptDir = join(root, 'attempt');
    mkdirSync(attemptDir);
    writeFileSync(
      join(attemptDir, 'control.json'),
      JSON.stringify({ execution: { status: 'terminated' } }),
    );
    const attempt = {
      id: 'a',
      role: 'worker',
      directory: attemptDir,
      created: '2026-01-03T00:00:00Z',
    };
    const worker = {
      ...clean.dispatches[0],
      provider: 'agy',
      inputRevision: merged,
      attempts: [attempt],
      acceptedReceipt: 'receipt',
    };
    const worker1 = {
      ...worker,
      id: 'worker1',
      subject: 'fixture/toy#2',
      acceptedReceipt: 'receipt1',
    };
    clean.dispatches = [worker1, worker];
    clean.resources = [];
    clean.receipts = [
      {
        id: 'receipt',
        dispatchId: worker.id,
        runId: 'run',
        role: worker.role,
        stage: worker.stage,
        provider: 'agy',
        subject: worker.subject,
        inputRevision: merged,
        attemptId: 'a',
      },
    ];
    clean.receipts.push({
      ...clean.receipts[0],
      id: 'receipt1',
      dispatchId: 'worker1',
      subject: 'fixture/toy#2',
    });
    const archive = join(root, 'archive');
    mkdirSync(archive);
    clean.deliveries = [1, 2].map((pr) => ({
      runId: 'run',
      pr,
      recorded: true,
      released: true,
      archive,
      checkedHead: merged,
    }));
    clean.pullRequests = [1, 2].map((pr) => ({
      runId: 'run',
      pr,
      checkedHead: merged,
      mergeCommit: merged,
    }));
    clean.runs[0].provider = 'agy';
    clean.runs[0].epicClosure = { head: merged, deliveryVersion: 'v' };
    clean.runs[0].pipeline = {
      head: merged,
      status: 'completed',
      evidence: ['audit'],
      blockers: [],
      scope: ['toy'],
      checks: ['inspect'],
      artifacts: [],
      limitations: [],
      disposition: 'completed_no_changes',
      inspectedVersions: { integrated: merged },
      findings: [],
      maintenance: [],
    };
    writeFileSync(round.entry, 'controlled report');
    const hash = createHash('sha256').update('controlled report').digest('hex');
    const receipt = join(root, 'report-receipt.json');
    writeFileSync(receipt, JSON.stringify({ path: round.entry, hash }));
    clean.runs[0].report = {
      path: round.entry,
      hash,
      receipt,
      revision: 'r',
      acceptedVersions: { integrated: merged },
      observedVersions: { integrated: merged },
    };
    writeFileSync(registryPath, JSON.stringify(clean));
    writeFileSync(
      join(root, 'control.json'),
      JSON.stringify({ runId: 'run', execution: 'released', observations: [] }),
    );
    writeFileSync(
      join(root, 'delivery-boundaries.jsonl'),
      JSON.stringify({
        at: '2026-01-02T00:00:00Z',
        stage: 'worker2',
        pass: true,
        facts: { children: [2, 3] },
      }) + '\n',
    );
    const good = await nativeDemoEvidence({
      github(path) {
        if (path.endsWith('/fixture/toy')) return { id: 7 };
        if (path.includes('/sub_issues')) return [{ number: 2 }, { number: 3 }];
        if (path.includes('/blocked_by')) return [{ number: 2 }];
        if (path.includes('/pulls?'))
          return [1, 2].map((number) => ({
            number,
            merged_at: `2026-01-0${number}`,
            merge_commit_sha: merged,
            head: { sha: merged },
          }));
        return { state: 'closed' };
      },
      termination: async () => true,
      // Artifact execution has its own actual-Git regression; no model execution is claimed here.
      artifacts: async () => [
        {
          stage: 'artifacts',
          expected: 'controlled external artifact result',
          observed: 'controlled',
          verdict: 'pass',
        },
      ],
    }).collect(round, 'final');
    expect(good.source).toBe('controlled');
    expect(good.checks.filter((c) => c.verdict !== 'pass')).toEqual([]);
    expect(good.execution).toBe('released');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
