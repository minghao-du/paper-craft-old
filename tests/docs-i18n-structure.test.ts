import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from 'vitest';

const script = resolve('scripts/docs/docs-i18n.ts');
const tsx = resolve('node_modules/tsx/dist/cli.mjs');

test('record and check reject structural drift before accepting confirmations', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-doc-structure-'));
  const put = (p: string, text: string) => writeFileSync(join(root, p), text);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [tsx, script, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
  try {
    put('docs-i18n.yaml', 'include: ["*.md"]\nexclude: []\nbacklog: {}\n');
    const en = '# Project\n\n[简体中文](README.zh.md)\n\n';
    const zh = '# 项目\n\n[English](README.md)\n\n';
    const pairs = [
      ['## Section\n\nText\n', '### 章节\n\n正文\n', 'heading'],
      ['- One\n- Two\n', '1. 一\n2. 二\n', 'list'],
      ['1. One\n2. Two\n', '2. 一\n3. 二\n', 'list'],
      ['- One\n- Two\n', '- 一\n', 'list'],
      ['| A | B |\n| - | - |\n| x | y |\n', '| 甲 |\n| - |\n| 一 |\n', 'table'],
      ['| A |\n| - |\n| x |\n', '| 甲 |\n| - |\n| 一 |\n| 二 |\n', 'table'],
      ['```ts title\nconst x = 1;\n```\n', '```ts other\nconst x = 1;\n```\n', 'code'],
      ['```ts\nconst x = 1;\n```\n', '```ts\nconst x = 2;\n```\n', 'code'],
      ['```ts\nconst x = 1;\n```\n', '~~~ts\nconst x = 1;\n~~~\n', 'code'],
    ];
    put('README.md', en + '## Section\n\nText\n');
    put('README.zh.md', zh + '## 章节\n\n正文\n');
    expect(run('record', 'README.md').status).toBe(0);
    const original = readFileSync(join(root, 'README.i18n.yaml'), 'utf8');
    for (const [english, chinese, kind] of pairs) {
      put('README.md', en + english);
      put('README.zh.md', zh + chinese);
      const recording = run('record', 'README.md');
      expect(recording.status, recording.stdout).toBe(1);
      expect(recording.stdout).toContain(`structure ${kind}`);
      expect(run('check', 'README.md').stdout).toContain(`structure ${kind}`);
      expect(readFileSync(join(root, 'README.i18n.yaml'), 'utf8')).toBe(original);
    }
    // Title edits and duplicate headings legitimately generate a new set of keys.
    put(
      'README.md',
      '# Renamed\n\n[简体中文](README.zh.md)\n\n## Repeat\n\nOne\n\n## Repeat\n\nTwo\n',
    );
    put('README.zh.md', '# 新标题\n\n[English](README.md)\n\n## 重复\n\n一\n\n## 重复\n\n二\n');
    expect(run('record', 'README.md').status).toBe(0);
    const updated = readFileSync(join(root, 'README.i18n.yaml'), 'utf8');
    expect(updated).toContain('/renamed/repeat~2:');
    expect(updated).not.toContain('/project:');
    expect(run('check').status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
