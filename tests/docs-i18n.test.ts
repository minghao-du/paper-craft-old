import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from 'vitest';

const script = resolve('scripts/docs/docs-i18n.ts');
const tsx = resolve('node_modules/tsx/dist/cli.mjs');
test('reviewed pairs detect stale content, preserve unrelated sections and only record named pairs', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-docs-'));
  const put = (p: string, s: string) => {
    const counterpart = p.endsWith('.zh.md')
      ? p.replace(/\.zh\.md$/, '.md')
      : p.replace(/\.md$/, '.zh.md');
    writeFileSync(
      join(root, p),
      p.endsWith('.md') ? s.replace(/^(# [^\n]+)\n/, `$1\n\n[Language](${counterpart})\n`) : s,
    );
  };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [tsx, script, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    put('docs-i18n.yaml', 'include: ["*.md"]\nexclude: ["AGENTS.md"]\nbacklog: {}\n');
    put('README.md', '# Project\n\nEnglish\n\n## Next\n\nMore\n');
    put('README.zh.md', '# 项目\n\n中文\n\n## 下一步\n\n更多\n');
    expect(run('check').status).toBe(1);
    expect(run('record').status).toBe(1);
    expect(run('record', 'README.md').status).toBe(0);
    expect(run('check').status).toBe(0);
    const before = readFileSync(join(root, 'README.i18n.yaml'), 'utf8');
    put('README.md', '# Project\n\nChanged\n\n## Next\n\nMore\n');
    expect(run('check').stdout).toContain('stale');
    expect(readFileSync(join(root, 'README.i18n.yaml'), 'utf8')).toBe(before);
    expect(run('record', 'README.md').status).toBe(0);
    const after = readFileSync(join(root, 'README.i18n.yaml'), 'utf8');
    expect(after.split('project/next:')[1]).toBe(before.split('project/next:')[1]);
    put('README.zh.md', '# 项目\n\n变更\n\n## 下一步\n\n更多\n');
    expect(run('check').status).toBe(1);
    put('OTHER.md', '# Other\n');
    put('OTHER.zh.md', '# 其他\n');
    expect(run('record', 'OTHER.md').status).toBe(0);
    const other = readFileSync(join(root, 'OTHER.i18n.yaml'), 'utf8');
    put('OTHER.md', '# Other\n\nChanged\n');
    put('NEW.md', '# New\n');
    expect(run('record', 'README.md').status).toBe(0);
    expect(run('check').stdout).toContain('NEW.zh.md');
    expect(readFileSync(join(root, 'OTHER.i18n.yaml'), 'utf8')).toBe(other);
    put('AGENTS.md', '# Excluded\n');
    expect(run('check', 'README.md').status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45000);

test('adoption backlog permits only existing unpaired documents and orphan artifacts fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-docs-'));
  const put = (p: string, s: string) => {
    const counterpart = p.endsWith('.zh.md')
      ? p.replace(/\.zh\.md$/, '.md')
      : p.replace(/\.md$/, '.zh.md');
    writeFileSync(
      join(root, p),
      p.endsWith('.md') ? s.replace(/^(# [^\n]+)\n/, `$1\n\n[Language](${counterpart})\n`) : s,
    );
  };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [tsx, script, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    put('OLD.md', '# Old\n');
    git('add', '.');
    git('commit', '-qm', 'adoption');
    const adoption = git('rev-parse', 'HEAD').stdout.trim();
    const manifest = (backlog: string) =>
      `include: ["*.md"]\nexclude: ["AGENTS.md"]\nadoption: ${adoption}\nbacklog: ${backlog}\n`;
    put('docs-i18n.yaml', manifest('{OLD.md: existing}'));
    put('OLD.md', '# Edited legacy document\n');
    expect(run('check').status).toBe(0);
    expect(run('list').stdout).toContain('backlog OLD.md');
    put('NEW.md', '# New\n');
    put('docs-i18n.yaml', manifest('{OLD.md: existing, NEW.md: existing}'));
    expect(run('check').status).toBe(1);
    put('docs-i18n.yaml', manifest('{OLD.md: existing}'));
    rmSync(join(root, 'NEW.md'));
    put('ORPHAN.zh.md', '# 孤立\n');
    expect(run('check').stdout).toContain('missing ORPHAN.md');
    rmSync(join(root, 'ORPHAN.zh.md'));
    put('OLD.zh.md', '# 旧文档\n');
    expect(run('check').status).toBe(1);
    put('docs-i18n.yaml', manifest('{}'));
    expect(run('record', 'OLD.md').status).toBe(0);
    expect(run('check').status).toBe(0);
    git('add', '.');
    git('commit', '-qm', 'migrate');
    put('OLD.zh.md', '# 旧文档\n\n审阅后的更新\n');
    expect(run('check').stdout).toContain('stale');
    expect(run('record', 'OLD.md').status).toBe(0);
    expect(run('check').status).toBe(0);
    rmSync(join(root, 'OLD.zh.md'));
    rmSync(join(root, 'OLD.i18n.yaml'));
    put('docs-i18n.yaml', manifest('{OLD.md: existing}'));
    expect(run('check').status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test('adoption snapshot cannot move forward to exempt newly introduced documents', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-docs-adoption-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const put = (p: string, text: string) => writeFileSync(join(root, p), text);
  const check = () =>
    spawnSync(process.execPath, [tsx, script, 'check'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    put('OLD.md', '# Old\n');
    git('add', '.');
    git('commit', '-qm', 'legacy');
    const adoption = git('rev-parse', 'HEAD').stdout.trim();
    const manifest = (revision: string, backlog: string) =>
      `include: ["*.md"]\nexclude: []\nadoption: ${revision}\nbacklog: ${backlog}\n`;
    put('docs-i18n.yaml', manifest(adoption, '{OLD.md: existing}'));
    git('add', '.');
    git('commit', '-qm', 'adopt bilingual policy');
    put('OLD.md', '# Edited legacy\n');
    expect(check().status).toBe(0);
    put('NEW.md', '# New\n');
    git('add', '.');
    git('commit', '-qm', 'new unpaired document');
    const moved = git('rev-parse', 'HEAD').stdout.trim();
    put('docs-i18n.yaml', manifest(moved, '{OLD.md: existing, NEW.md: existing}'));
    expect(check().status).toBe(1);
    expect(check().stderr).toContain('adoption snapshot');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
