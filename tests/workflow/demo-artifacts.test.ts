import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { demoArtifacts } from '../../packages/core/src/workflow/demo/artifacts.js';
import type { DemoRound } from '../../packages/core/src/workflow/demo/round.js';
test('immutable merged scripts must compute changed input rather than replay committed summary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-artifacts-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(root, 'tests'));
    writeFileSync(
      join(root, 'generate.py'),
      `from pathlib import Path\nPath('data.tsv').write_text('id\\tvalue\\n'+''.join(f'{i}\\t{i*10}\\n' for i in range(1,11)))\n`,
    );
    writeFileSync(
      join(root, 'summarize.py'),
      `import json\njson.dump(dict(n=10,mean=55,min=10,max=100),open('summary.json','w'))\n`,
    );
    writeFileSync(
      join(root, 'tests', 'test_toy.py'),
      'import unittest\nclass Toy(unittest.TestCase):\n def test_runs(self): self.assertTrue(True)\n',
    );
    git('add', '.');
    git('commit', '-qm', 'fixture');
    const round = { checkout: root } as DemoRound;
    const checks = await demoArtifacts(round, git('rev-parse', 'HEAD'));
    expect(checks.some((c) => c.verdict === 'finding')).toBe(true);
    writeFileSync(
      join(root, 'summarize.py'),
      `import csv,json\nv=[int(r['value']) for r in csv.DictReader(open('data.tsv'),delimiter='\\t')]\njson.dump(dict(n=len(v),mean=sum(v)/len(v),min=min(v),max=max(v)),open('summary.json','w'))\n`,
    );
    git('add', '.');
    git('commit', '-qm', 'compute');
    expect(
      (await demoArtifacts(round, git('rev-parse', 'HEAD'))).every((c) => c.verdict === 'pass'),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
