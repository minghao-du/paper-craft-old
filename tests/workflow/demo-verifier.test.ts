import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoVerifier, type DemoEvidence } from '../../packages/core/src/workflow/demo/verifier.js';
import { demoArtifacts } from '../../packages/core/src/workflow/demo/artifacts.js';
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
    expect(result.clean).toBe(false);
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
    writeFileSync(
      join(root, 'gate-authorization.json'),
      JSON.stringify({
        id: 'auth',
        roundId: 'raw-fixture',
        runId: 'run',
        issue: 3,
        stage: 'work',
        claimed: true,
        authorizedAt: '2026-01-02T00:00:00Z',
      }),
    );
    writeFileSync(
      join(root, 'human-closure.json'),
      JSON.stringify({
        deliveryVersion: 'v',
        source: 'human',
        evidence: 'manual confirmation',
      }),
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
    // On a fresh clean round without previous historical findings, verification is clear and clean
    const cleanRoot = mkdtempSync(join(tmpdir(), 'checker-clean-'));
    try {
      const cleanRound = { ...round, id: 'clean-fixture', root: cleanRoot };
      const cleanResult = await new DemoVerifier({ collect: async () => good }).verify(cleanRound, 'final');
      expect(cleanResult.defects).toBe('clear');
      expect(cleanResult.clean).toBe(true);
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('sticky historical findings: failed gate in delivery-boundaries is retained across verification runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sticky-gate-'));
  try {
    const round = { id: 'sticky-round', root } as DemoRound;
    writeFileSync(
      join(root, 'delivery-boundaries.jsonl'),
      JSON.stringify({
        at: '2026-01-01T00:00:00Z',
        stage: 'worker2',
        pass: false,
        error: 'Native dependency direction violated',
        facts: { children: [2, 3] },
      }) + '\n',
    );
    const evidence: DemoEvidence = {
      source: 'controlled',
      references: ['fixture'],
      checks: [
        {
          stage: 'ordering',
          expected: 'No failed gate boundaries in delivery history',
          observed: 'Gate 2 failed',
          verdict: 'finding',
        },
      ],
      business: 'completed',
      execution: 'released',
      cleanup: 'pending',
    };
    const verifier = new DemoVerifier({ collect: async () => evidence });
    const first = await verifier.verify(round, 'delivery');
    expect(first.defects).toBe('findings');
    expect(first.clean).toBe(false);

    // Later, even if fresh evidence reports pass, earlier finding from verification.jsonl is retained
    evidence.checks = [
      {
        stage: 'ordering',
        expected: 'No failed gate boundaries in delivery history',
        observed: 'Gate 2 pass',
        verdict: 'pass',
      },
    ];
    const second = await verifier.verify(round, 'final');
    expect(second.defects).toBe('findings');
    expect(second.clean).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('changed-input detection in temporary validation area without modifying accepted checkout', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifacts-val-')));
  try {
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    mkdirSync(join(checkout, 'tests'));

    // Correct generate.py
    writeFileSync(
      join(checkout, 'generate.py'),
      `import sys
with open('data.tsv', 'w') as f:
    f.write('id\\tvalue\\n')
    for i in range(1, 11):
        f.write(f'{i}\\t{i*10}\\n')
`,
    );

    // Hard-coded summarize.py that ignores changed input
    writeFileSync(
      join(checkout, 'summarize.py'),
      `import json
# Hard-coded ignoring actual file content
json.dump({'n': 10, 'mean': 55, 'min': 10, 'max': 100}, open('summary.json', 'w'))
`,
    );

    // Reader test that tests with input-dependent data
    writeFileSync(
      join(checkout, 'tests', 'test_demo.py'),
      `import unittest, os, json, subprocess
class TestDemo(unittest.TestCase):
    def test_reader(self):
        with open('data.tsv', 'w') as f:
            f.write('id\\tvalue\\n1\\t4\\n2\\t12\\n')
        subprocess.check_call(['python3', 'summarize.py'])
        with open('summary.json') as f:
            data = json.load(f)
        self.assertEqual(data['mean'], 8)
`,
    );

    // Pre-create data.tsv and summary.json
    writeFileSync(
      join(checkout, 'data.tsv'),
      'id\tvalue\n' + Array.from({ length: 10 }, (_, i) => `${i + 1}\t${(i + 1) * 10}\n`).join(''),
    );
    writeFileSync(join(checkout, 'summary.json'), '{"n":10,"mean":55,"min":10,"max":100}');

    git('add', '.');
    git('commit', '-m', 'delivered files');
    const sha = git('rev-parse', 'HEAD');

    const round = { id: 'artifact-check', root, checkout } as DemoRound;
    const checks = await demoArtifacts(round, sha, 'final');
    // Hard-coded summarize.py should fail changed temporary input check
    expect(checks.some((c) => c.verdict === 'finding')).toBe(true);
    expect(checks.find((c) => c.expected.includes('input-dependent'))?.verdict).toBe('finding');

    // Accepted source in checkout MUST be completely untouched!
    expect(readFileSync(join(checkout, 'summarize.py'), 'utf8')).toContain('Hard-coded');
    expect(git('status', '--porcelain')).toBe('');

    // Now write a proper summarize.py that really recomputes from data.tsv
    writeFileSync(
      join(checkout, 'summarize.py'),
      `import json
with open('data.tsv') as f:
    lines = [l.strip().split('\\t') for l in f if l.strip()]
header = lines[0]
rows = [[int(x) for x in r] for r in lines[1:]]
vals = [r[1] for r in rows]
result = {
    'n': len(vals),
    'mean': sum(vals) // len(vals) if vals else 0,
    'min': min(vals) if vals else 0,
    'max': max(vals) if vals else 0,
}
with open('summary.json', 'w') as f:
    json.dump(result, f)
`,
    );

    git('add', '.');
    git('commit', '-m', 'real summarize implementation');
    const goodSha = git('rev-parse', 'HEAD');

    const goodChecks = await demoArtifacts(round, goodSha, 'final');
    expect(goodChecks.every((c) => c.verdict === 'pass')).toBe(true);
    // Checkout still clean
    expect(git('status', '--porcelain')).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('verification requests no process-control, cancellation, release or deletion, leaving scene completely intact', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'no-side-effects-')));
  try {
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    writeFileSync(join(checkout, 'marker.txt'), 'preserved');
    const controlPath = join(root, 'control.json');
    writeFileSync(
      controlPath,
      JSON.stringify({
        runId: 'run-1',
        execution: 'running',
        observations: [],
      }),
    );
    const round = {
      id: 'round-intact',
      root,
      checkout,
      entry: join(root, 'report.md'),
    } as DemoRound;

    const evidence: DemoEvidence = {
      source: 'controlled',
      references: ['fixture'],
      checks: [
        {
          stage: 'structure',
          expected: 'Native structure',
          observed: 'valid',
          verdict: 'pass',
        },
      ],
      business: 'completed',
      execution: 'unknown',
      cleanup: 'pending',
    };

    const verifier = new DemoVerifier({
      collect: async () => evidence,
    });

    const result = await verifier.verify(round, 'final');
    // Result reports independently
    expect(result.business).toBe('completed');
    expect(result.execution).toBe('unknown');
    expect(result.clean).toBe(false);

    // Scene is completely intact
    expect(existsSync(join(checkout, 'marker.txt'))).toBe(true);
    expect(readFileSync(join(checkout, 'marker.txt'), 'utf8')).toBe('preserved');
    expect(existsSync(controlPath)).toBe(true);
    // Control was NOT modified or cancelled
    const controlAfter = JSON.parse(readFileSync(controlPath, 'utf8'));
    expect(controlAfter.execution).toBe('running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('business completed with execution active or unknown reports clean: false', async () => {
  const root = mkdtempSync(join(tmpdir(), 'biz-complete-exec-active-'));
  try {
    const round = { id: 'active-exec', root } as DemoRound;
    const evidence: DemoEvidence = {
      source: 'native',
      references: [root],
      checks: [
        {
          stage: 'delivery',
          expected: 'Deliveries completed',
          observed: 'both completed',
          verdict: 'pass',
        },
      ],
      business: 'completed',
      execution: 'unknown',
      cleanup: 'pending',
    };

    const verifier = new DemoVerifier({ collect: async () => evidence });
    const result = await verifier.verify(round, 'final');
    expect(result.business).toBe('completed');
    expect(result.execution).toBe('unknown');
    expect(result.defects).toBe('clear');
    expect(result.clean).toBe(false);

    // Once execution is confirmed released, clean becomes true
    evidence.execution = 'released';
    const cleanResult = await verifier.verify(round, 'final');
    expect(cleanResult.execution).toBe('released');
    expect(cleanResult.clean).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('pc demo verify CLI command is evidence-only with no release, disposal, or resolves options', async () => {
  const { Command } = await import('commander');
  const { registerDemoCommands } = await import('../../packages/cli/src/commands/demo.js');

  const demoProgram = new Command();
  registerDemoCommands(demoProgram);
  const demoCmd = demoProgram.commands.find((c) => c.name() === 'demo');
  expect(demoCmd).toBeDefined();

  const verifyCmd = demoCmd!.commands.find((c) => c.name() === 'verify');
  expect(verifyCmd).toBeDefined();

  // Description must reflect no side effects, release, or disposal
  expect(verifyCmd!.description()).toContain('without side effects, release, or disposal');

  // Must NOT have disposal or scene release options
  const optionNames = verifyCmd!.options.map((o) => o.name());
  expect(optionNames).not.toContain('resolves');
  expect(optionNames).not.toContain('confirm-resolved');
  expect(optionNames).not.toContain('release');
  expect(optionNames).not.toContain('dispose');

  // Must have boundary option
  expect(optionNames).toContain('boundary');
});
