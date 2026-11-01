/** Portable handoff operations. Originals are retained until the caller verifies the archive. */
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathExists, within, workflowSource, type FleetConfig } from './fleet-config.js';

/** Create a workflow subdirectory and reject symlinks that leave its configured root. */
export function stateDirectory(config: FleetConfig, ...parts: string[]): string {
  let path = config.root;
  for (const part of parts) {
    const next = join(path, part);
    if (!pathExists(next)) mkdirSync(next);
    path = realpathSync(next);
    if (!within(config.root, path) || lstatSync(next).isSymbolicLink()) {
      throw new Error(`Workflow directory must not be a symlink: ${next}`);
    }
  }
  return path;
}

function regularFile(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error(`Expected regular file, not symlink: ${path}`);
}

/** A verified archive records hashes; optional missing worklogs are explicit. */
export interface Preservation {
  status: 'preserved';
  path: string;
  files: Record<string, string>;
  worklogMissing: boolean;
}

/** Copy and verify both state files, leaving source files intact on success and failure. */
export function preserveState(config: FleetConfig, path: string, reason: string): Preservation {
  const source = workflowSource(config, path);
  const status = join(source, '.epic-status.json');
  regularFile(status);
  const statusBytes = readFileSync(status);
  const parsed: unknown = JSON.parse(statusBytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON status object: ${status}`);
  }
  const parent = stateDirectory(config, '.preserved');
  const dest = mkdtempSync(join(parent, `${basename(source)}-`));
  const hashes: Record<string, string> = {};
  const worklogMissing = !pathExists(join(source, '.epic-worklog.md'));
  try {
    for (const name of ['.epic-status.json', '.epic-worklog.md']) {
      const from = join(source, name);
      if (name === '.epic-worklog.md' && worklogMissing) continue;
      regularFile(from);
      const original = name === '.epic-status.json' ? statusBytes : readFileSync(from);
      const to = join(dest, name);
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      if (!original.equals(readFileSync(to)) || !original.equals(readFileSync(from))) {
        throw new Error(`State changed while preserving ${from}; retry before deleting anything`);
      }
      hashes[name] = createHash('sha256').update(original).digest('hex');
    }
    for (const [name, hash] of Object.entries(hashes)) {
      if (
        createHash('sha256')
          .update(readFileSync(join(source, name)))
          .digest('hex') !== hash
      ) {
        throw new Error(
          `State changed during preservation: ${name}; retry before deleting anything`,
        );
      }
    }
    if (worklogMissing && pathExists(join(source, '.epic-worklog.md'))) {
      throw new Error('Worklog appeared during preservation; retry before deleting anything');
    }
    writeFileSync(
      join(dest, 'manifest.json'),
      JSON.stringify(
        {
          source,
          reason,
          created_at: new Date().toISOString(),
          files: hashes,
          worklogMissing,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    return { status: 'preserved', path: dest, files: hashes, worklogMissing };
  } catch (error) {
    rmSync(dest, { recursive: true });
    throw error;
  }
}
