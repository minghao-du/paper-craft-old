import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';
import { preserveState } from '@paper-craft/core/workflow/handoff';
import { checkFleet, checkReclaim } from '@paper-craft/core/workflow/fleet';
import {
  startRun,
  reserveRunCheckout,
  updateRunRegistry,
  inspectRuns,
  home,
} from '@paper-craft/core/workflow/run-driver';

const repo = process.cwd();
function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  ).trim();
}

describe('portable workflow file contract', () => {
  let temp: string;
  let project: string;
  let pool: string;
  let configFile: string;
  beforeEach(() => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'pc-workflow-')));
    project = join(temp, 'project with spaces');
    pool = join(temp, 'pool');
    mkdirSync(project);
    mkdirSync(pool);
    mkdirSync(join(pool, 'cedar'));
    mkdirSync(join(pool, 'pine'));
    configFile = join(project, '.epic-config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        main_checkout: project,
        clone_root: '../pool',
        clone_names: ['cedar', 'pine'],
      }),
    );
  });
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  it('resolves config-relative paths and refuses frozen worker snapshots and escaping slots', () => {
    expect(loadFleetConfig(configFile).root).toBe(pool);
    const workerConfig = join(pool, 'cedar', '.epic-config.json');
    writeFileSync(workerConfig, readFileSync(configFile));
    expect(() => loadFleetConfig(workerConfig)).toThrow('authoritative');
    rmSync(join(pool, 'cedar'), { recursive: true });
    const outside = join(temp, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(pool, 'cedar'));
    writeFileSync(join(outside, '.epic-status.json'), '{}');
    expect(() => preserveState(loadFleetConfig(configFile), join(pool, 'cedar'), 'test')).toThrow(
      'registered slot',
    );
    expect(readFileSync(join(outside, '.epic-status.json'), 'utf8')).toBe('{}');
  });

  it('preserves exact state bytes without deleting sources and reports optional worklog absence', () => {
    const config = loadFleetConfig(configFile);
    const slot = join(pool, 'cedar');
    const status = '{"issue":123,"phase":"testing"}\n';
    writeFileSync(join(slot, '.epic-status.json'), status);
    const first = preserveState(config, slot, 'first handoff');
    expect(first.worklogMissing).toBe(true);
    expect(readFileSync(join(slot, '.epic-status.json'), 'utf8')).toBe(status);
    expect(readFileSync(join(first.path, '.epic-status.json'), 'utf8')).toBe(status);
    const manifest = JSON.parse(readFileSync(join(first.path, 'manifest.json'), 'utf8'));
    expect(manifest.files['.epic-status.json']).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(slot, '.epic-worklog.md'), 'Measured result\n');
    const second = preserveState(config, slot, 'second handoff');
    expect(second.path).not.toBe(first.path);
    expect(second.worklogMissing).toBe(false);
    expect(readFileSync(join(second.path, '.epic-worklog.md'), 'utf8')).toBe('Measured result\n');
  });

  it('preserves checkout files without requiring .epic-status.json or .epic-worklog.md', () => {
    const config = loadFleetConfig(configFile);
    const slot = join(pool, 'cedar');
    rmSync(join(slot, '.epic-status.json'), { force: true });
    rmSync(join(slot, '.epic-worklog.md'), { force: true });
    writeFileSync(join(slot, 'notes.txt'), 'test notes\n');
    writeFileSync(join(slot, '.pc-execution-owner'), JSON.stringify({ runId: 'run-1' }));
    const result = preserveState(config, slot, 'clean handoff');
    expect(result.status).toBe('preserved');
    expect(result.worklogMissing).toBe(true);
    expect(result.files['notes.txt']).toBeDefined();
    expect(result.files['.pc-execution-owner']).toBeDefined();
    expect(readFileSync(join(result.path, 'notes.txt'), 'utf8')).toBe('test notes\n');
    expect(readFileSync(join(slot, 'notes.txt'), 'utf8')).toBe('test notes\n');
  });

  it('fails preservation on malformed status or linked worklogs, retaining originals and removing partial archives', () => {
    const config = loadFleetConfig(configFile);
    const slot = join(pool, 'cedar');
    const status = join(slot, '.epic-status.json');
    writeFileSync(status, 'broken');
    expect(() => preserveState(config, slot, 'test')).toThrow();
    writeFileSync(status, '{}');
    const outside = join(temp, 'outside.md');
    writeFileSync(outside, 'precious');
    symlinkSync(outside, join(slot, '.epic-worklog.md'));
    expect(() => preserveState(config, slot, 'test')).toThrow('regular file');
    expect(readFileSync(status, 'utf8')).toBe('{}');
    expect(readFileSync(outside, 'utf8')).toBe('precious');
    expect(readdirSync(join(pool, '.preserved'))).toEqual([]);
  });

  it('subject command rejects missing Run with an actionable start command', () => {
    const noRun = spawnSync(
      resolve(repo, 'pc'),
      [
        'workflow',
        'orchestrator',
        'close-epic',
        '7',
        '--repository',
        'owner/repo',
        '--config',
        configFile,
      ],
      { cwd: project, encoding: 'utf8' },
    );
    expect(noRun.status).not.toBe(0);
    expect(noRun.stdout + noRun.stderr).toContain('workflow orchestrator start 7');
  }, 15000);

  it('rejects the retired workflow command group', () => {
    const launcher = join(temp, 'pc');
    symlinkSync(resolve(repo, 'pc'), launcher);
    const cli = (...args: string[]) =>
      spawnSync(launcher, args, {
        cwd: project,
        encoding: 'utf8',
      });
    for (const removed of ['start', 'status', 'recover']) {
      const result = cli('workflow', ['con', 'ductor'].join(''), removed);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unknown command');
    }
  }, 15000);

  it('requires a Run for recovery and reconciles an empty Fleet', () => {
    const launcher = join(temp, 'pc');
    symlinkSync(resolve(repo, 'pc'), launcher);
    const cli = (...args: string[]) =>
      spawnSync(launcher, args, {
        cwd: project,
        encoding: 'utf8',
      });
    const missingRun = cli('workflow', 'orchestrator', 'recover');
    expect(missingRun.status).not.toBe(0);
    expect(missingRun.stderr).toContain('missing required argument');
    const unknownRun = cli(
      'workflow',
      'orchestrator',
      'recover',
      'missing',
      '--config',
      configFile,
    );
    expect(unknownRun.status).toBe(2);
    const batch = cli('workflow', 'orchestrator', 'recover-all', '--config', configFile);
    expect(batch.status, batch.stderr).toBe(0);
    expect(JSON.parse(batch.stdout)).toEqual({ status: 'reconciled', outcomes: [] });
  }, 15000);

  it('reports configured roots and command failure exit codes', () => {
    const launcher = join(temp, 'pc');
    symlinkSync(resolve(repo, 'pc'), launcher);
    const cli = (...args: string[]) =>
      spawnSync(launcher, args, {
        cwd: project,
        encoding: 'utf8',
      });
    const root = cli('workflow', 'root', '--path');
    expect(root.status, root.stderr).toBe(0);
    expect(root.stdout.trim()).toBe(pool);
    expect(cli('workflow', 'intent', 'find', '999').status).toBe(1);
    const invalid = cli('fleet', 'currency', '--config', join(project, 'missing.json'));
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout).status).toBe('unknown');
    const reclaim = cli('fleet', 'reclaim-check', '--dir', join(pool, 'cedar'));
    expect(reclaim.status).toBe(2);
    expect(JSON.parse(reclaim.stdout).eligible).toBe(false);
  }, 25000);
});

describe('fleet checks against real Git clones', { timeout: 20000 }, () => {
  let temp: string;
  let project: string;
  let pool: string;
  let origin: string;
  let configFile: string;
  beforeEach(() => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'pc-fleet-')));
    project = join(temp, 'project');
    pool = join(temp, 'pool');
    mkdirSync(project);
    mkdirSync(pool);
    origin = join(temp, 'origin.git');
    mkdirSync(origin);
    git(origin, 'init', '--bare');
    git(project, 'init', '-b', 'main');
    git(project, 'config', 'user.name', 'Workflow Test');
    git(project, 'config', 'user.email', 'workflow@example.test');
    writeFileSync(join(project, '.gitignore'), '.epic-*\nbrief.md\n');
    writeFileSync(join(project, 'shared.txt'), 'base\n');
    git(project, 'add', '.');
    git(project, 'commit', '-m', 'base');
    git(project, 'remote', 'add', 'origin', origin);
    git(project, 'push', '-u', 'origin', 'main');
    for (const slot of ['cedar', 'pine']) {
      git(pool, 'clone', '-b', 'main', origin, slot);
      git(join(pool, slot), 'config', 'user.name', 'Workflow Test');
      git(join(pool, slot), 'config', 'user.email', 'workflow@example.test');
    }
    configFile = join(project, '.epic-config.json');
    writeFileSync(
      configFile,
      JSON.stringify({ main_checkout: project, clone_root: pool, clone_names: ['cedar', 'pine'] }),
    );
  });
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  it('distinguishes current Git state from unknown occupancy and blocks reclaim without mutations', () => {
    const config = loadFleetConfig(configFile);
    expect(checkFleet(config, 'currency').status).toBe('clear');
    expect(checkFleet(config, 'currency').occupancy).toBe('unknown');
    const slot = join(pool, 'cedar');
    const head = git(slot, 'rev-parse', 'HEAD');
    expect(checkReclaim(config, slot)).toMatchObject({ eligible: false, status: 'blocked' });
    expect(git(slot, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(slot, 'status', '--porcelain')).toBe('');
    expect(checkFleet(config, 'collisions').status).toBe('clear');
  });

  it('checkReclaim checks registry resources and .pc-execution-owner without inspecting .epic-status.json', () => {
    const config = loadFleetConfig(configFile);
    const slot = join(pool, 'cedar');
    writeFileSync(join(slot, '.pc-execution-owner'), JSON.stringify({ runId: 'run-99' }));
    updateRunRegistry(config, (reg) => {
      reg.resources = [{ path: realpathSync(slot), runId: 'run-99', registry: config.file }];
    });
    // Write historical .epic-status.json to verify it is NOT adopted or inspected in checks
    writeFileSync(join(slot, '.epic-status.json'), JSON.stringify({ phase: 'coding', issue: 123 }));
    const reclaim = checkReclaim(config, slot);
    expect(reclaim.eligible).toBe(false);
    expect(reclaim.status).toBe('blocked');
    expect(reclaim.checks.executionOwner).toEqual({ runId: 'run-99' });
    expect(reclaim.checks.resource).toMatchObject({ runId: 'run-99' });
    expect((reclaim.checks as any).workerState).toBeUndefined();
  });

  it('detects committed, staged, unstaged and untracked overlap including whitespace in names', () => {
    const cedar = join(pool, 'cedar');
    const pine = join(pool, 'pine');
    git(cedar, 'checkout', '-b', 'work');
    writeFileSync(join(cedar, 'shared.txt'), 'committed\n');
    git(cedar, 'add', '.');
    git(cedar, 'commit', '-m', 'worker change');
    // A working-tree reversal must not hide the committed branch's footprint.
    writeFileSync(join(cedar, 'shared.txt'), 'base\n');
    writeFileSync(join(pine, 'shared.txt'), 'unstaged\n');
    const filename = ' space\nfile.txt';
    writeFileSync(join(cedar, filename), 'staged');
    git(cedar, 'add', '--', filename);
    writeFileSync(join(pine, filename), 'untracked');
    const result = checkFleet(loadFleetConfig(configFile), 'collisions');
    expect(result.status).toBe('issues');
    expect(result.slots[0].touched).toContain(filename);
    expect(result.issues).toHaveLength(2);
  });

  it('reports held slots and distinguishes stale refs from a refreshed behind count', () => {
    mkdirSync(join(pool, '.holds'));
    writeFileSync(join(pool, '.holds', 'pine'), 'another task');
    expect(checkFleet(loadFleetConfig(configFile), 'currency').issues[0].slot).toBe('pine');
    writeFileSync(join(project, 'new.txt'), 'landed');
    git(project, 'add', '.');
    git(project, 'commit', '-m', 'landed');
    git(project, 'push');
    const cached = checkFleet(loadFleetConfig(configFile), 'currency');
    expect(cached.status).toBe('unknown');
    const fetched = checkFleet(loadFleetConfig(configFile), 'currency', true);
    expect(fetched.scope.remote).toBe('fetched');
    expect(fetched.slots[0]).toMatchObject({ relation: 'behind', behind: 1 });
  });

  it('detects overlap with landed changes and keeps missing-slot failures above observed problems', () => {
    const cedar = join(pool, 'cedar');
    git(cedar, 'checkout', '-b', 'work');
    writeFileSync(join(cedar, 'shared.txt'), 'pending\n');
    writeFileSync(join(project, 'shared.txt'), 'landed\n');
    git(project, 'add', '.');
    git(project, 'commit', '-m', 'landed');
    git(project, 'push');
    rmSync(join(pool, 'pine'), { recursive: true });
    const result = checkFleet(loadFleetConfig(configFile), 'collisions', true);
    expect(result.status).toBe('unknown');
    expect(result.issues[0].detail).toContain('shared.txt');
    expect(result.unknown[0].slot).toBe('pine');
  });

  it('refuses an empty roster and reports a detached checkout rather than skipping it', () => {
    const config = loadFleetConfig(configFile);
    expect(() => checkFleet({ ...config, slots: [] }, 'collisions')).toThrow('No configured slots');
    git(join(pool, 'cedar'), 'checkout', '--detach');
    expect(checkFleet(config, 'collisions').unknown[0].detail).toContain('Detached');
  });

  it('checks and preserves a linked worktree without treating its gitfile as a missing repository', () => {
    const path = join(pool, 'issue-77');
    git(project, 'worktree', 'add', '-b', 'worker-77', path, 'main');
    const config = { ...loadFleetConfig(configFile), worktrees: true };
    const result = checkFleet(config, 'collisions');
    expect(result.status).toBe('clear');
    expect(result.slots.map((slot) => slot.name)).toEqual(['issue-77']);
    writeFileSync(join(path, '.epic-status.json'), '{"issue":77}');
    expect(preserveState(config, path, 'worktree test').status).toBe('preserved');
    expect(checkReclaim(config, path).eligible).toBe(false);
    expect(existsSync(join(path, '.epic-status.json'))).toBe(true);
  });

  it('discovers dynamic checkouts from Managed Registry resources', () => {
    const config = loadFleetConfig(configFile);
    const dynamicSlot = join(pool, 'dynamic-1');
    git(pool, 'clone', '-b', 'main', origin, 'dynamic-1');
    git(dynamicSlot, 'config', 'user.name', 'Workflow Test');
    git(dynamicSlot, 'config', 'user.email', 'workflow@example.test');
    writeFileSync(join(dynamicSlot, '.git', 'info', 'exclude'), '.pc-execution-owner\n');

    const runId = 'run-10';
    updateRunRegistry(config, (reg) => {
      reg.runs.push({
        id: runId,
        subject: {
          repository: 'test/repo',
          number: 10,
          kind: 'issue',
          title: 'dynamic',
          body: 'work',
        },
        provider: 'agy',
        policy: { name: 'default', revision: 1 },
        lifecycle: 'running',
        orchestratorId: 'orch-10',
        brief: { path: '', hash: '' },
      });
      reg.resources = [{ path: dynamicSlot, runId, registry: join(home(config), 'registry.json') }];
    });
    writeFileSync(
      join(dynamicSlot, '.pc-execution-owner'),
      JSON.stringify({ path: dynamicSlot, runId, registry: join(home(config), 'registry.json') }),
    );

    const result = checkFleet(config, 'currency');
    expect(result.status).toBe('clear');
    const slotNames = result.slots.map((s) => s.name);
    expect(slotNames).toContain('cedar');
    expect(slotNames).toContain('pine');
    expect(slotNames).toContain(`${runId}/dynamic-1`);
  });

  it('reports missing registered checkouts as unknown, never inferred as released even if run completed', () => {
    const config = loadFleetConfig(configFile);
    const missingSlot = join(pool, 'missing-slot');
    const runId = 'run-11';
    updateRunRegistry(config, (reg) => {
      reg.runs.push({
        id: runId,
        subject: {
          repository: 'test/repo',
          number: 11,
          kind: 'issue',
          title: 'missing',
          body: 'work',
        },
        provider: 'agy',
        policy: { name: 'default', revision: 1 },
        lifecycle: 'completed',
        orchestratorId: 'orch-11',
        brief: { path: '', hash: '' },
      });
      reg.resources = [{ path: missingSlot, runId, registry: join(home(config), 'registry.json') }];
    });

    const result = checkFleet(config, 'currency');
    expect(result.status).toBe('unknown');
    expect(
      result.unknown.some(
        (u) => u.slot === `${runId}/missing-slot` && u.detail.includes('does not exist'),
      ),
    ).toBe(true);
  });

  it('isolates failed Registry reads so valid configured directories continue independent checks', () => {
    const config = loadFleetConfig(configFile);
    const regFile = join(home(config), 'registry.json');
    mkdirSync(home(config), { recursive: true });
    writeFileSync(regFile, '{"corrupted json');

    const result = checkFleet(config, 'currency');
    expect(result.status).toBe('unknown');
    expect(result.unknown.some((u) => u.slot === 'registry')).toBe(true);
    expect(result.slots.map((s) => s.name).sort()).toEqual(['cedar', 'pine']);
  });

  it('reports ownership conflicts and prevents overlapping configured paths from hiding conflicts', () => {
    const config = loadFleetConfig(configFile);
    const pine = join(pool, 'pine');
    const run1 = 'run-12';
    const run2 = 'run-13';

    // Both runs claim the same configured slot 'pine' in registry.resources
    updateRunRegistry(config, (reg) => {
      reg.runs.push(
        {
          id: run1,
          subject: { repository: 'test/repo', number: 12, kind: 'issue', title: 'c1', body: 'b' },
          provider: 'agy',
          policy: { name: 'default', revision: 1 },
          lifecycle: 'running',
          orchestratorId: 'orch-12',
          brief: { path: '', hash: '' },
        },
        {
          id: run2,
          subject: { repository: 'test/repo', number: 13, kind: 'issue', title: 'c2', body: 'b' },
          provider: 'agy',
          policy: { name: 'default', revision: 1 },
          lifecycle: 'running',
          orchestratorId: 'orch-13',
          brief: { path: '', hash: '' },
        },
      );
      reg.resources = [
        { path: pine, runId: run1, registry: join(home(config), 'registry.json') },
        { path: pine, runId: run2, registry: join(home(config), 'registry.json') },
      ];
    });
    writeFileSync(
      join(pine, '.pc-execution-owner'),
      JSON.stringify({ path: pine, runId: run1, registry: join(home(config), 'registry.json') }),
    );

    const result = checkFleet(config, 'currency');
    expect(result.status).toBe('unknown');
    expect(
      result.unknown.some((u) => u.slot === 'pine' && u.detail.includes('Multiple runs')),
    ).toBe(true);
    expect(result.slots.map((s) => s.name)).not.toContain('pine');
  });

  it('observes released resources as standard configured slots without checking managed identity', () => {
    const config = loadFleetConfig(configFile);
    const pine = join(pool, 'pine');
    // Pine has no .pc-execution-owner and is not in registry.resources (it was released or never registered)
    expect(existsSync(join(pine, '.pc-execution-owner'))).toBe(false);
    expect(inspectRuns(config).resources?.some((r) => r.path === pine)).toBeFalsy();

    const result = checkFleet(config, 'currency');
    expect(result.status).toBe('clear');
    expect(result.slots.map((s) => s.name).sort()).toEqual(['cedar', 'pine']);
  });
});

describe('installed shared resources', () => {
  let temp: string;
  beforeEach(() => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'pc-install-')));
  });
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  it('installs linked skills and their shared reference for a custom harness, idempotently', () => {
    const dest = join(temp, 'arbitrary-harness', 'skills');
    const install = () =>
      execFileSync('bash', [join(repo, 'scripts/setup/link-skills.sh'), '--dest', dest], {
        encoding: 'utf8',
      });
    mkdirSync(dest, { recursive: true });
    const retired = 'pc-' + 'con' + 'ductor';
    symlinkSync(join(repo, 'skills', retired), join(dest, retired));
    install();
    install();
    expect(readdirSync(dest)).not.toContain(retired);
    for (const suffix of ['', '-handoff', '-prepare-reboot', '-recover', '-tuckin']) {
      const name = 'pc-orchestrator' + suffix;
      expect(realpathSync(join(dest, name))).toBe(join(repo, 'skills', name));
      expect(readFileSync(join(dest, name, 'SKILL.md'), 'utf8')).toContain('name: ' + name);
    }
    expect(realpathSync(join(dest, 'lib', 'workflow.md'))).toBe(
      join(repo, 'skills/lib/workflow.md'),
    );
    expect(readFileSync(join(dest, 'pc-epic', 'SKILL.md'), 'utf8')).toContain('../lib/workflow.md');
    const linkedReference = resolve(join(dest, 'pc-orchestrator'), '../lib/workflow.md');
    expect(existsSync(linkedReference)).toBe(true);
  });

  it('retains conflicting directories and foreign shared libraries', () => {
    const dest = join(temp, 'skills');
    mkdirSync(dest);
    const foreign = join(temp, 'foreign-lib');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'precious.md'), 'keep');
    symlinkSync(foreign, join(dest, 'lib'));
    const result = spawnSync('bash', [join(repo, 'scripts/setup/link-skills.sh'), '--dest', dest], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(realpathSync(join(dest, 'lib'))).toBe(foreign);
    expect(readFileSync(join(foreign, 'precious.md'), 'utf8')).toBe('keep');
    expect(readdirSync(dest)).toEqual(['lib']);
  });
});
