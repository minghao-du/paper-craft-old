import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from 'vitest';

// Command boundary catches invalid reader navigation that freshness hashes cannot detect.
test('recording and checking require reciprocal switches and corresponding local destinations and anchors', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-nav-'));
  const put = (p: string, s: string) => writeFileSync(join(root, p), s);
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/docs/docs-i18n.ts'), ...args],
      { cwd: root, encoding: 'utf8', timeout: 10000 },
    );
  const en = '# Guide\n\n[中文](Guide.zh.md)\n\n';
  const zh = '# 指南\n\n[English](Guide.md)\n\n';
  try {
    put('docs-i18n.yaml', 'include: ["*.md"]\nexclude: [Outside.md]\nbacklog: {}\n');
    put('Outside.md', '# Outside\n');
    put('Guide.md', en + '[Next](Target.md?q=1#usage)\n');
    put('Guide.zh.md', zh + '[下一步](Target.zh.md?q=1#usage)\n');
    put('Target.md', '# Target\n\n[中文](Target.zh.md)\n\n<a id="usage"></a>\n\n## Usage\n');
    put('Target.zh.md', '# 目标\n\n[English](Target.md)\n\n<a id="usage"></a>\n\n## 用法\n');
    expect(run('record', 'Guide.md', 'Target.md').status).toBe(0);
    expect(run('check').status).toBe(0);
    const before = readFileSync(join(root, 'Guide.i18n.yaml'), 'utf8');
    for (const body of [
      '# 指南\n\n无链接\n',
      zh + '[下一步](Target.md?q=1#usage)\n',
      zh + '[下一步](Target.zh.md?q=2#usage)\n',
      zh + '[下一步](Outside.md?q=1#usage)\n',
    ]) {
      put('Guide.zh.md', body);
      expect(run('record', 'Guide.md').status).toBe(1);
      expect(readFileSync(join(root, 'Guide.i18n.yaml'), 'utf8')).toBe(before);
    }
    put('Guide.zh.md', zh + '[下一步](Target.zh.md?q=1#usage)\n');
    put('Target.zh.md', '# 目标\n\n[English](Target.md)\n\n## 用法\n');
    expect(run('record', 'Guide.md').stdout).toContain('anchor');
    put('Guide.md', en + '[Outside](Outside.md)\n');
    put('Guide.zh.md', zh + '[外部](Outside.md)\n');
    expect(run('record', 'Guide.md').status).toBe(0);
    rmSync(join(root, 'Outside.md'));
    expect(run('check', 'Guide.md').stdout).toContain('missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

// Renames must update inbound links; deletion cannot leave stale reader destinations.
test('complete pair renames and deletes require updated inbound references', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-nav-rename-'));
  const put = (p: string, s: string) => writeFileSync(join(root, p), s);
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/docs/docs-i18n.ts'), ...args],
      { cwd: root, encoding: 'utf8', timeout: 10000 },
    );
  const pair = (name: string, link = '') => {
    put(
      `${name}.md`,
      `# ${name}\n\n[中文](${name}.zh.md)\n\n${link ? `[Next](${link}.md)` : ''}\n`,
    );
    put(
      `${name}.zh.md`,
      `# 中文\n\n[English](${name}.md)\n\n${link ? `[下一步](${link}.zh.md)` : ''}\n`,
    );
  };
  const remove = (name: string) => {
    for (const suffix of ['.md', '.zh.md', '.i18n.yaml']) rmSync(join(root, name + suffix));
  };
  try {
    put('docs-i18n.yaml', 'include: ["*.md"]\nexclude: []\nbacklog: {}\n');
    pair('Index', 'Old');
    pair('Old');
    expect(run('record', 'Index.md', 'Old.md').status).toBe(0);
    remove('Old');
    pair('New');
    expect(run('record', 'New.md').status).toBe(0);
    expect(run('check').stdout).toContain('missing local destination');
    pair('Index', 'New');
    expect(run('record', 'Index.md').status).toBe(0);
    expect(run('check').status).toBe(0);
    remove('New');
    pair('Index');
    expect(run('record', 'Index.md').status).toBe(0);
    expect(run('check').status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
