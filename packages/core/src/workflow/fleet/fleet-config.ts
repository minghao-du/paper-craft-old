/** Configured filesystem boundary shared by all agent runtimes. */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { expandTilde } from '../utils/config.js';

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const schema = z.object({
  clone_root: z.string().min(1),
  main_checkout: z.string().min(1).optional(),
  clone_names: z.array(name).default([]),
  local_worktrees: z.boolean().default(false),
  base_branch: z.string().min(1).default('main'),
});

/** Canonical project and pool paths from an explicit Fleet configuration. */
export interface FleetConfig {
  file: string;
  project: string;
  root: string;
  slots: string[];
  worktrees: boolean;
  base: string;
}

/** Resolve a directory physically; missing or inaccessible directories are errors. */
export function directory(path: string): string {
  const result = realpathSync(expandTilde(path));
  if (!statSync(result).isDirectory()) throw new Error(`Expected directory: ${path}`);
  return result;
}

/** Only ENOENT means absent; access and filesystem errors remain failed probes. */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Test containment using path segments, including the root itself. */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Load the authoritative config; refuse frozen copies in worker checkouts. */
export function loadFleetConfig(path = '.epic-config.json'): FleetConfig {
  const file = realpathSync(expandTilde(path));
  const config = schema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const parent = dirname(file);
  const project = config.main_checkout
    ? directory(resolve(parent, expandTilde(config.main_checkout)))
    : parent;
  if (parent !== project) {
    throw new Error(`Worker config ${file}; use the authoritative config in ${project}`);
  }
  if (new Set(config.clone_names).size !== config.clone_names.length) {
    throw new Error(`Duplicate clone_names in ${file}`);
  }
  return {
    file,
    project,
    root: directory(resolve(parent, expandTilde(config.clone_root))),
    slots: config.clone_names,
    worktrees: config.local_worktrees,
    base: config.base_branch,
  };
}

/** Resolve an archive source inside the configured project or a configured slot. */
export function workflowSource(config: FleetConfig, path: string): string {
  const source = directory(path);
  if (source === config.project) return source;
  const slot = relative(config.root, source);
  if (
    slot.includes(sep) ||
    !slot ||
    !(config.slots.includes(slot) || (config.worktrees && /^issue-\d+$/.test(slot)))
  ) {
    throw new Error(`Directory ${source} is not the configured project or a registered slot`);
  }
  // Realpath above prevents a slot symlink escaping the configured root.
  if (!within(config.root, source)) throw new Error(`Slot escapes ${config.root}`);
  return source;
}
