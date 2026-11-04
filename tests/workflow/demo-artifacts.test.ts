import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { demoArtifacts } from '../../tools/demo/artifacts.js';
import type { DemoRound } from '../../tools/demo/round.js';
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
    writeFileSync(
      join(root, 'tests', 'test_reader.py'),
      `import unittest,subprocess,tempfile,pathlib,json,shutil
class Reader(unittest.TestCase):
 def test_changed(self):
  with tempfile.TemporaryDirectory() as d:
   shutil.copy('summarize.py',d)
   pathlib.Path(d,'data.tsv').write_text('id\\tvalue\\n1\\t4\\n2\\t12\\n')
   subprocess.run(['python3','summarize.py'],cwd=d,check=True)
   self.assertEqual(json.loads(pathlib.Path(d,'summary.json').read_text()),dict(n=2,mean=8,min=4,max=12))
`,
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

test('stage first validates PR 1 committed TSV and generator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-artifacts-first-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(root, 'tests'));
    writeFileSync(
      join(root, 'tests', 'test_toy.py'),
      'import unittest\nclass Toy(unittest.TestCase):\n def test_runs(self): self.assertTrue(True)\n',
    );
    writeFileSync(
      join(root, 'generate.py'),
      `from pathlib import Path\nPath('data.tsv').write_text('id\\tvalue\\n'+''.join(f'{i}\\t{i*10}\\n' for i in range(1,11)))\n`,
    );
    // Missing committed data.tsv initially
    git('add', '.');
    git('commit', '-qm', 'first without tsv');
    const round = { checkout: root } as DemoRound;
    const checksFinding = await demoArtifacts(round, git('rev-parse', 'HEAD'), 'first');
    expect(checksFinding.some((c) => c.verdict === 'finding')).toBe(true);
    expect(checksFinding[0].observed).toContain('PR 1 lacks committed TSV');

    // Commit valid data.tsv (header + 10 rows + trailing newline = 12 lines when split by newline)
    const exactTsv =
      'id\tvalue\n' + Array.from({ length: 10 }, (_, i) => `${i + 1}\t${(i + 1) * 10}\n`).join('');
    writeFileSync(join(root, 'data.tsv'), exactTsv);
    git('add', '.');
    git('commit', '-qm', 'first with tsv');
    const checksPass = await demoArtifacts(round, git('rev-parse', 'HEAD'), 'first');
    expect(checksPass.every((c) => c.verdict === 'pass')).toBe(true);
    expect(checksPass[0].expected).toBe('PR 1 generator, test and TSV');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

