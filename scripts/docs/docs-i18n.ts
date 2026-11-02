import { validateNavigation } from './docs-i18n-navigation.js';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { matchesGlob } from 'node:path';
import { parse, stringify } from 'yaml';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent, Nodes } from 'mdast';
import { validateStructure } from './docs-i18n-structure.js';

const root = process.cwd();
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
/** Parse authored GFM with source offsets retained for exact block hashing. */
export function markdown(text: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(text);
}
/** The three sibling artifacts maintained as one pair. */
export function pairPaths(en: string) {
  return { en, zh: en.replace(/\.md$/, '.zh.md'), record: en.replace(/\.md$/, '.i18n.yaml') };
}
function headingText(node: Nodes): string {
  return 'value' in node
    ? node.value
    : 'children' in node
      ? node.children.map(headingText).join('')
      : '';
}
function sections(text: string) {
  const result: { heading?: Extract<RootContent, { type: 'heading' }>; blocks: string[] }[] = [
    { blocks: [] },
  ];
  for (const node of markdown(text).children) {
    if (node.type === 'heading') result.push({ heading: node, blocks: [] });
    if (node.type !== 'code')
      result
        .at(-1)!
        .blocks.push(text.slice(node.position!.start.offset, node.position!.end.offset));
  }
  return result;
}
/** Compute independent hashes in heading occurrence order using upstream path and hash semantics. */
export function computeRecord(en: string, zh: string) {
  const a = sections(en),
    b = sections(zh);
  if (a.length !== b.length) throw new Error('heading count differs between languages');
  const ancestors: { depth: number; slug: string }[] = [];
  const keys = new Set<string>();
  const record: Record<string, { en: string; zh: string }> = {};
  for (let i = 0; i < a.length; i++) {
    const heading = a[i].heading;
    if (heading) {
      while ((ancestors.at(-1)?.depth ?? 0) >= heading.depth) ancestors.pop();
      ancestors.push({
        depth: heading.depth,
        slug:
          headingText(heading)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'section',
      });
    }
    const path = '/' + ancestors.map((x) => x.slug).join('/');
    let key = path;
    for (let n = 2; keys.has(key); n++) key = `${path}~${n}`;
    keys.add(key);
    if (a[i].blocks.length || b[i].blocks.length)
      record[key] = { en: hash(a[i].blocks.join('\n')), zh: hash(b[i].blocks.join('\n')) };
  }
  return record;
}
function walk(dir = ''): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(dir, entry.name);
    if (
      entry.isSymbolicLink() ||
      ['.git', 'node_modules', 'dist', 'vendor', '.paper-craft'].includes(entry.name)
    )
      return [];
    return entry.isDirectory() ? walk(path) : [path];
  });
}
function main() {
  const args = process.argv.slice(2).filter((x) => x !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: docs:i18n:<list|check|record> [English.md ...]\ncheck: all active pairs or named pairs; record: explicitly named reviewed pairs only.\nRun: pnpm docs:i18n:check -- README.md',
    );
    return;
  }
  const [command, ...names] = args;
  if (!['list', 'check', 'record'].includes(command))
    throw new Error('expected list, check or record; use --help');
  if (command === 'record' && !names.length)
    throw new Error('record requires explicitly named reviewed English.md pairs');
  const manifest = parse(readFileSync('docs-i18n.yaml', 'utf8')) as {
    include: string[];
    exclude: string[];
    adoption?: string;
    backlog: Record<string, string>;
  };
  if (manifest.adoption) {
    const firstManifest = execFileSync(
      'git',
      ['log', '--reverse', '--format=%H', '--diff-filter=A', '--', 'docs-i18n.yaml'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')[0];
    if (firstManifest) {
      const snapshot = parse(
        execFileSync('git', ['show', `${firstManifest}:docs-i18n.yaml`], {
          encoding: 'utf8',
        }),
      ) as typeof manifest;
      if (manifest.adoption !== snapshot.adoption)
        throw new Error('adoption snapshot is immutable; restore the original adoption revision');
      for (const path of Object.keys(manifest.backlog))
        if (!Object.hasOwn(snapshot.backlog, path))
          throw new Error(`document was not in adoption snapshot backlog: ${path}`);
    }
  }
  const eligible = (p: string) =>
    manifest.include.some((g) => matchesGlob(p, g)) &&
    !manifest.exclude.some((g) => matchesGlob(p, g));
  const all = walk();
  const sources = new Set(
    all
      .filter((p) => /(?:\.md|\.i18n\.yaml)$/.test(p))
      .map((p) => p.replace(/\.zh\.md$/, '.md').replace(/\.i18n\.yaml$/, '.md'))
      .filter(eligible),
  );
  for (const path of Object.keys(manifest.backlog)) {
    if (!eligible(path) || !existsSync(path)) throw new Error(`invalid backlog entry: ${path}`);
    if (
      !manifest.adoption ||
      execFileSync('git', ['show', `${manifest.adoption}:${path}`], { encoding: 'utf8' }).length ===
        0
    )
      throw new Error(`backlog entry not present at adoption: ${path}`);
    const history = execFileSync(
      'git',
      ['log', '--format=%H', `${manifest.adoption}..HEAD`, '--', pairPaths(path).zh],
      { encoding: 'utf8' },
    );
    if (history.trim() || existsSync(pairPaths(path).zh) || existsSync(pairPaths(path).record))
      throw new Error(`migrated pair cannot return to backlog: ${path}`);
  }
  const selected = names.length ? names.map((p) => relative(root, resolve(p))) : [...sources];
  for (const path of selected)
    if (!sources.has(path) || path.endsWith('.zh.md'))
      throw new Error(`expected eligible English document: ${path}`);
  let failures = 0;
  for (const path of selected.sort()) {
    if (Object.hasOwn(manifest.backlog, path)) {
      console.log(`backlog ${path}`);
      continue;
    }
    try {
      const paths = pairPaths(path);
      for (const file of [paths.en, paths.zh, ...(command === 'record' ? [] : [paths.record])])
        if (!existsSync(file)) throw new Error(`missing ${file}`);
      const en = readFileSync(paths.en, 'utf8'),
        zh = readFileSync(paths.zh, 'utf8');
      validateNavigation(
        path,
        en,
        zh,
        new Set([...sources].filter((p) => !Object.hasOwn(manifest.backlog, p))),
      );
      validateStructure(markdown(en), markdown(zh), en, zh);
      const current = computeRecord(en, zh);

      if (command === 'record') writeFileSync(paths.record, stringify(current, { lineWidth: 0 }));
      else {
        const stored = parse(readFileSync(paths.record, 'utf8'));
        for (const key of new Set([...Object.keys(stored ?? {}), ...Object.keys(current)]))
          if (JSON.stringify(stored?.[key]) !== JSON.stringify(current[key]))
            throw new Error(
              `section ${key}: stale or missing confirmation; review both languages then record ${path}`,
            );
      }
      console.log(`ok ${path}`);
    } catch (error) {
      console.log(`${path}: ${error instanceof Error ? error.message : error}`);
      failures++;
    }
  }
  if (failures) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
