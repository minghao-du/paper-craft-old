/** Re-execute immutable merged source in a disposable directory, never the accepted checkout. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoRound } from './round.js';
import type { DemoCheck } from './verifier.js';
/** Validate the actual merged programs and their standard-library tests, including changed input. */
export async function demoArtifacts(
  round: DemoRound,
  revision?: string,
  stage: 'first' | 'final' = 'final',
): Promise<DemoCheck[]> {
  const root = mkdtempSync(join(tmpdir(), 'pc-demo-validation-'));
  let ref = revision ?? '';
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: round.checkout, timeout: 10000 });
    ref ||= git('rev-parse', 'HEAD').toString().trim();
    const archive = git('archive', '--format=tar', ref);
    execFileSync('tar', ['-xf', '-', '-C', root], { input: archive, timeout: 10000 });
    const python = (...args: string[]) =>
      execFileSync('python3', args, {
        cwd: root,
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    if (!readdirSync(join(root, 'tests')).some((p) => p.startsWith('test') && p.endsWith('.py')))
      throw new Error('Missing standard-library tests');
    python('-m', 'unittest', 'discover', '-s', 'tests');
    if (
      stage === 'first' &&
      (!existsSync(join(root, 'data.tsv')) ||
        readFileSync(join(root, 'data.tsv'), 'utf8').split('\n').length !== 12)
    )
      throw new Error('PR 1 lacks committed TSV');
    python('generate.py');
    const expected =
      'id\tvalue\n' + Array.from({ length: 10 }, (_, i) => `${i + 1}\t${(i + 1) * 10}\n`).join('');
    if (readFileSync(join(root, 'data.tsv'), 'utf8') !== expected)
      throw new Error('Generator did not produce exact ten-row TSV');
    if (stage === 'first')
      return [
        {
          stage: 'artifacts',
          expected: 'PR 1 generator, test and TSV',
          observed: 'Merged first tree tests and exact generation passed',
          verdict: 'pass',
          reference: ref,
        },
      ];
    python('summarize.py');
    const summary = () => JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8'));
    const matches = (v: Record<string, number>, expected: Record<string, number>) =>
      Object.keys(v).length === 4 && Object.entries(expected).every(([k, n]) => v[k] === n);
    if (!matches(summary(), { n: 10, mean: 55, min: 10, max: 100 }))
      throw new Error('Summary mismatch');
    writeFileSync(join(root, 'data.tsv'), 'id\tvalue\n1\t4\n2\t12\n');
    rmSync(join(root, 'summary.json'));
    python('summarize.py');
    if (!matches(summary(), { n: 2, mean: 8, min: 4, max: 12 }))
      throw new Error('Reader ignored changed temporary input');
    writeFileSync(
      join(root, 'summarize.py'),
      "import json\njson.dump(dict(n=10,mean=55,min=10,max=100),open('summary.json','w'))\n",
    );
    let rejected = false;
    try {
      python('-m', 'unittest', 'discover', '-s', 'tests');
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw new Error('Delivered reader test does not reject an input-independent summary');
    return [
      {
        stage: 'artifacts',
        expected: 'Merged scripts/tests and input-dependent computation',
        observed: 'Exact TSV, four summary values and changed input passed in isolated copy',
        verdict: 'pass',
        reference: ref,
      },
    ];
  } catch (error) {
    return [
      {
        stage: 'artifacts',
        expected: 'Merged scripts/tests and input-dependent computation',
        observed: String(error),
        verdict: 'finding',
        reference: ref,
      },
    ];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
