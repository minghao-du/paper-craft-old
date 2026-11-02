import type { Nodes, Root } from 'mdast';

type Structure = { kind: string; value: string; line?: number };
function structures(tree: Root, source: string): Structure[] {
  const result: Structure[] = [];
  const visit = (node: Nodes) => {
    let value: unknown;
    switch (node.type) {
      case 'heading':
        value = node.depth;
        break;
      case 'list':
        value = [node.ordered, node.start, node.children.length];
        break;
      case 'table':
        value = node.children.map((row) => row.children.length);
        break;
      case 'code':
        value = source.slice(node.position!.start.offset, node.position!.end.offset);
        break;
    }
    if (value !== undefined)
      result.push({
        kind: node.type,
        value: JSON.stringify(value),
        line: node.position?.start.line,
      });
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  return result;
}

/** Reject incompatible heading/list/table structure and any authored code-block changes. */
export function validateStructure(en: Root, zh: Root, english: string, chinese: string): void {
  const a = structures(en, english),
    b = structures(zh, chinese);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]?.kind !== b[i]?.kind || a[i]?.value !== b[i]?.value)
      throw new Error(
        `structure ${a[i]?.kind ?? b[i]?.kind} mismatch at English line ${a[i]?.line ?? 'missing'}, Chinese line ${b[i]?.line ?? 'missing'}${a[i]?.kind === 'code' || b[i]?.kind === 'code' ? ': code kind, fence metadata and body must be byte-identical' : ''}`,
      );
  }
}
