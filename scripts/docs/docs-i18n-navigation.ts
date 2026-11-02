import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { Nodes, Root } from 'mdast';
import { markdown } from './docs-i18n.js';

function visit(node: Nodes, fn: (node: Nodes) => void) {
  fn(node);
  if ('children' in node) for (const child of node.children) visit(child, fn);
}
function links(tree: Root) {
  const definitions = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node.url);
  });
  const result: string[] = [];
  visit(tree, (node) => {
    if (node.type === 'link' || node.type === 'image') result.push(node.url);
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const url = definitions.get(node.identifier.toLowerCase());
      if (!url) throw new Error(`missing link definition ${node.identifier}`);
      result.push(url);
    }
  });
  return result;
}
function explicitAnchors(text: string) {
  const anchors = new Set<string>();
  visit(markdown(text), (node) => {
    if (node.type === 'html')
      for (const match of node.value.matchAll(
        /<(?:a|[a-z][\w-]*)\b[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["'][^>]*>/gi,
      ))
        anchors.add(match[1]);
  });
  return anchors;
}
function anchorSection(text: string, anchor: string) {
  const nodes = markdown(text).children;
  const position = nodes.findIndex(
    (node) => node.type === 'html' && explicitAnchors(node.value).has(anchor),
  );
  // Anchors conventionally precede their heading: compare the next heading occurrence.
  return nodes.slice(0, position + 1).filter((node) => node.type === 'heading').length;
}
function textValue(node: Nodes): string {
  return 'value' in node
    ? node.value
    : 'children' in node
      ? node.children.map(textValue).join('')
      : '';
}
function fragments(text: string) {
  const anchors = explicitAnchors(text);
  const used = new Map<string, number>();
  visit(markdown(text), (node) => {
    if (node.type !== 'heading') return;
    const slug = textValue(node)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
      .replace(/\s/g, '-');
    const n = used.get(slug) ?? 0;
    used.set(slug, n + 1);
    anchors.add(slug + (n ? `-${n}` : ''));
  });
  return anchors;
}

/** Validate language switches and corresponding offline navigation before freshness confirmation. */
export function validateNavigation(enPath: string, en: string, zh: string, active: Set<string>) {
  const root = realpathSync(process.cwd());
  const zhPath = enPath.replace(/\.md$/, '.zh.md');
  const trees = [markdown(en), markdown(zh)];
  const paths = [enPath, zhPath];
  for (let i = 0; i < 2; i++) {
    const tree = trees[i];
    if (tree.children[0]?.type !== 'heading' || tree.children[0].depth !== 1)
      throw new Error(`${paths[i]}: expected main heading first`);
    const switchNode = tree.children[1];
    const switches =
      switchNode?.type === 'paragraph' ? links({ type: 'root', children: [switchNode] }) : [];
    const expected = resolve(dirname(paths[i]), switches[0] ?? '');
    if (switches.length !== 1 || /[?#]/.test(switches[0]) || expected !== resolve(paths[1 - i]))
      throw new Error(
        `${paths[i]}: reciprocal language switch must immediately follow main heading`,
      );
  }
  const urls = trees.map((tree) => links({ ...tree, children: tree.children.slice(2) }));
  if (urls[0].length !== urls[1].length) throw new Error('navigation link counts differ');
  function destination(url: string, source: string) {
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(url)) return { external: true, key: url };
    const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url)!;
    let target: string;
    let fragment: string;
    try {
      target = match[1] ? resolve(dirname(source), decodeURIComponent(match[1])) : resolve(source);
      fragment = decodeURIComponent((match[3] ?? '').slice(1));
    } catch {
      throw new Error(`${source}: invalid encoded link ${url}`);
    }
    if (!existsSync(target)) throw new Error(`${source}: missing local destination ${url}`);
    const inside = relative(root, realpathSync(target));
    if (inside.startsWith('..') || inside.startsWith('/'))
      throw new Error(`${source}: local destination leaves repository ${url}`);
    const rel = relative(process.cwd(), target);
    const canonical = rel.replace(/\.zh\.md$/, '.md');
    const paired = active.has(canonical);
    if (paired && source.endsWith('.zh.md') !== rel.endsWith('.zh.md'))
      throw new Error(`${source}: wrong-language destination ${url}`);
    if (fragment && statSync(target).isFile() && target.endsWith('.md')) {
      if (paired) {
        const counterpart = canonical.replace(/\.md$/, '.zh.md');
        for (const file of [canonical, counterpart]) {
          if (!existsSync(file)) throw new Error(`missing paired destination ${file}`);
          if (!explicitAnchors(readFileSync(file, 'utf8')).has(fragment))
            throw new Error(`${source}: missing shared explicit anchor ${fragment} in ${file}`);
        }
        if (
          anchorSection(readFileSync(canonical, 'utf8'), fragment) !==
          anchorSection(readFileSync(counterpart, 'utf8'), fragment)
        )
          throw new Error(`${source}: shared anchor ${fragment} points to different sections`);
      } else if (!fragments(readFileSync(target, 'utf8')).has(fragment))
        throw new Error(`${source}: missing anchor ${fragment} in ${url}`);
    }
    return {
      external: false,
      key: `${paired ? canonical : rel}${match[2] ?? ''}${match[3] ?? ''}`,
    };
  }
  for (let i = 0; i < urls[0].length; i++) {
    const a = destination(urls[0][i], enPath),
      b = destination(urls[1][i], zhPath);
    if (a.external !== b.external || a.key !== b.key)
      throw new Error(`navigation targets differ: ${urls[0][i]} / ${urls[1][i]}`);
  }
}
