/** Git/file checks deliberately make no claims about agent or process liveness. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { readWorkerInventory } from './worker-inventory.js';
import { join } from 'node:path';
import { directory, pathExists, workflowSource, type FleetConfig } from './fleet-config.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: 3000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  }).trimEnd();
}

function files(dir: string, ...args: string[]): string[] {
  // Preserve whitespace and newlines in filenames; only NUL is a separator.
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: 3000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
    .split('\0')
    .filter(Boolean);
}

/** A failed probe remains distinct from an observed scheduling problem. */
export interface Finding {
  slot: string;
  detail: string;
}

/** Fleet checks report their full scope and explicitly unknown runtime occupancy. */
export interface FleetReport {
  status: 'clear' | 'issues' | 'unknown';
  scope: {
    config: string;
    project: string;
    cloneRoot: string;
    base: string;
    remote: 'fetched' | 'cached';
  };
  occupancy: 'unknown';
  slots: SlotReport[];
  issues: Finding[];
  unknown: Finding[];
}

/** Git evidence for one registered slot; this is not permission to launch or reclaim. */
export interface SlotReport {
  name: string;
  path: string;
  branch: string;
  head: string;
  dirty: boolean;
  held: boolean;
  relation: 'current' | 'behind' | 'ahead' | 'diverged';
  behind: number;
  ahead: number;
  touched: string[];
  landedOverlap: string[];
}

function slotLocations(config: FleetConfig): { name: string; path: string; runtime: boolean }[] {
  const names = config.worktrees
    ? readdirSync(config.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^issue-\d+$/.test(d.name))
        .map((d) => d.name)
        .sort()
    : config.slots;
  const locations = names.map((name) => ({
    name,
    path: join(config.root, name),
    runtime: false,
  }));
  const workers = readWorkerInventory(config.project);
  for (const worker of workers) {
    // Released/completed attempts may retain records after checkout removal.
    // Missing in-flight checkouts remain visible as failed probes.
    if (worker.state === 'completed' && !pathExists(worker.worktree)) continue;
    if (!locations.some((location) => location.path === worker.worktree))
      locations.push({
        name: `${worker.fleet_id}/${worker.dispatch_id}`,
        path: worker.worktree,
        runtime: true,
      });
  }
  if (!locations.length && !workers.length)
    throw new Error(`No configured slots to check in ${config.file}`);
  return locations;
}

function reference(config: FleetConfig): string {
  git(config.project, 'check-ref-format', '--branch', config.base);
  return `refs/remotes/origin/${config.base}`;
}

function inspectSlot(
  config: FleetConfig,
  location: { name: string; path: string; runtime: boolean },
  origin: string,
  fetch: boolean,
): SlotReport {
  const { name } = location;
  const path = location.runtime ? directory(location.path) : workflowSource(config, location.path);
  if (location.runtime && (lstatSync(location.path).isSymbolicLink() || path !== location.path))
    throw new Error(`Runtime checkout must not be redirected: ${location.path}`);
  if (directory(git(path, 'rev-parse', '--show-toplevel')) !== path) {
    throw new Error(`Expected a Git checkout at ${path}, received a parent repository`);
  }
  if (git(path, 'remote', 'get-url', 'origin') !== origin) {
    throw new Error(`Slot ${name} has a different origin from ${config.project}`);
  }
  const ref = reference(config);
  if (fetch) git(path, 'fetch', '--quiet', 'origin', `+refs/heads/${config.base}:${ref}`);
  const tip = git(path, 'rev-parse', '--verify', `${ref}^{commit}`);
  const projectTip = git(config.project, 'rev-parse', '--verify', `${ref}^{commit}`);
  if (tip !== projectTip)
    throw new Error(`Slot ${name} has a different cached base; rerun with --fetch`);
  const head = git(path, 'rev-parse', 'HEAD');
  const branch = git(path, 'branch', '--show-current');
  if (!branch) throw new Error(`Detached HEAD in ${name}`);
  const mergeBase = git(path, 'merge-base', 'HEAD', ref);
  const [ahead, behind] = git(path, 'rev-list', '--left-right', '--count', `HEAD...${ref}`)
    .split(/\s+/)
    .map(Number);
  const touched = [
    ...new Set([
      ...files(path, 'diff', '--name-only', '--no-renames', '-z', mergeBase, 'HEAD', '--'),
      ...files(path, 'diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD', '--'),
      ...files(path, 'diff', '--name-only', '--no-renames', '-z', '--'),
      ...files(path, 'ls-files', '--others', '--exclude-standard', '-z'),
    ]),
  ].sort();
  const landed = new Set(
    files(path, 'diff', '--name-only', '--no-renames', '-z', mergeBase, ref, '--'),
  );
  return {
    name,
    path,
    branch,
    head,
    dirty: git(path, 'status', '--porcelain=v1', '--untracked-files=all') !== '',
    held: pathExists(join(config.root, '.holds', name)),
    relation: ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'current',
    ahead,
    behind,
    touched,
    landedOverlap: touched.filter((file) => landed.has(file)),
  };
}

/** Check configured slots and dispatched worktrees, including uncommitted work and cached base overlap. */
export function checkFleet(
  config: FleetConfig,
  kind: 'currency' | 'collisions',
  fetch = false,
): FleetReport {
  const locations = slotLocations(config);
  const report: FleetReport = {
    status: 'clear',
    scope: {
      config: config.file,
      project: config.project,
      cloneRoot: config.root,
      base: config.base,
      remote: fetch ? 'fetched' : 'cached',
    },
    occupancy: 'unknown',
    slots: [],
    issues: [],
    unknown: [],
  };
  const ref = reference(config);
  const origin = git(config.project, 'remote', 'get-url', 'origin');
  if (fetch) git(config.project, 'fetch', '--quiet', 'origin', `+refs/heads/${config.base}:${ref}`);
  git(config.project, 'rev-parse', '--verify', `${ref}^{commit}`);
  for (const location of locations) {
    const { name } = location;
    try {
      const slot = inspectSlot(config, location, origin, fetch);
      report.slots.push(slot);
      if (kind === 'currency') {
        if (slot.branch !== config.base || slot.dirty || slot.held || slot.relation !== 'current') {
          report.issues.push({
            slot: name,
            detail: `branch=${slot.branch} dirty=${slot.dirty} held=${slot.held} relation=${slot.relation}`,
          });
        }
      } else if (slot.landedOverlap.length) {
        report.issues.push({
          slot: name,
          detail: `Files also changed on base: ${JSON.stringify(slot.landedOverlap)}`,
        });
      }
    } catch (error) {
      report.unknown.push({
        slot: name,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (kind === 'collisions') {
    const owners = new Map<string, string[]>();
    for (const slot of report.slots) {
      for (const file of slot.touched) owners.set(file, [...(owners.get(file) ?? []), slot.name]);
    }
    for (const [file, slots] of owners) {
      if (slots.length > 1)
        report.issues.push({
          slot: slots.join(', '),
          detail: `Overlapping file: ${JSON.stringify(file)}`,
        });
    }
  }
  report.status = report.unknown.length ? 'unknown' : report.issues.length ? 'issues' : 'clear';
  return report;
}

/** Read-only reclaim evidence; runtime occupancy and GitHub terminal checks remain unverified. */
export function checkReclaim(
  config: FleetConfig,
  path: string,
): {
  status: 'blocked';
  eligible: false;
  path: string;
  checks: Record<string, unknown>;
} {
  const source = workflowSource(config, path);
  const checks: Record<string, unknown> = {
    occupancy: 'unknown',
    githubTerminalState: 'unknown',
    archiveVerified: false,
    reasons: ['No runtime occupancy provider; automatic reclaim is unavailable'],
  };
  try {
    checks.branch = git(source, 'branch', '--show-current');
    checks.dirty = git(source, 'status', '--porcelain=v1', '--untracked-files=all') !== '';
    checks.held = pathExists(join(config.root, '.holds', source.slice(config.root.length + 1)));
    checks.unmergedCommits = Number(
      git(source, 'rev-list', '--count', `${reference(config)}..HEAD`),
    );
    const status = join(source, '.epic-status.json');
    checks.workerState = pathExists(status) ? JSON.parse(readFileSync(status, 'utf8')) : null;
  } catch (error) {
    checks.error = error instanceof Error ? error.message : String(error);
  }
  return { status: 'blocked', eligible: false, path: source, checks };
}
