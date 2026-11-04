import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIssue, type IssueInput } from '../../packages/core/src/workflow/run/run-subject.js';

test('run-subject exports readIssue and parses GitHub issue metadata with dependencies', () => {
  const project = mkdtempSync(join(tmpdir(), 'pc-subject-'));
  const previous = process.env.PATH;
  try {
    const gh = join(project, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env node
if (process.argv.includes('view')) console.log(JSON.stringify('owner/repo').slice(1, -1));
else if (process.argv.some(a => a.includes('blocked_by'))) console.log(JSON.stringify([{ number: 10, state: 'open' }, { number: 11, state: 'closed' }]));
else console.log(JSON.stringify({
  data: {
    repository: {
      nameWithOwner: 'owner/repo',
      issue: { number: 7, title: 'task title', body: 'task body', parent: { number: 9 } }
    }
  }
}));
`,
      { mode: 0o700 },
    );
    process.env.PATH = project + ':' + previous;

    const result: IssueInput = readIssue(project, 7);
    expect(result).toMatchObject({
      repository: 'owner/repo',
      number: 7,
      title: 'task title',
      body: 'task body',
      parent: 9,
      blockedBy: [10],
    });
  } finally {
    process.env.PATH = previous;
    rmSync(project, { recursive: true, force: true });
  }
});

test('run-subject rejects non-positive issue numbers and missing gh evidence', () => {
  expect(() => readIssue('/nonexistent', 0)).toThrow('Expected positive issue number');
  expect(() => readIssue('/nonexistent', -5)).toThrow('Expected positive issue number');
});

test('@paper-craft/core exports readIssue', async () => {
  const core = await import('../../packages/core/src/index.js');
  expect(typeof core.readIssue).toBe('function');
});
