import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// CLI seam: stale validation must never merge, and landing must preserve evidence before release.
it('rejects stale HEAD and conflicting ownership, then merges and preserves worker evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-land-'));
  const pc = resolve('pc');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['init', root]);
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    );
    const head = git('rev-parse', 'HEAD');
    const home = join(root, '.runtime/default/runs/run/dispatches/dispatch');
    const lock = join(root, '.runtime/default/locks/issue-1-worker.lock');
    const worktree = join(root, '.runtime/default/worktrees/dispatch');
    mkdirSync(home, { recursive: true });
    mkdirSync(lock, { recursive: true });
    git('worktree', 'add', '-b', 'worker', worktree);
    const dispatch = {
      dispatch_id: 'dispatch',
      run_id: 'run',
      worktree,
      branch: 'worker',
      lock_path: lock,
      tmux_pane: '%1',
    };
    writeFileSync(join(home, 'dispatch.json'), JSON.stringify(dispatch));
    writeFileSync(
      join(home, 'RECEIPT.md'),
      `outcome: succeeded\nhead: ${head}\nsummary: verified\n`,
    );
    writeFileSync(join(home, 'EXIT.json'), '{"exit_code":0}');
    writeFileSync(join(lock, 'owner.json'), '{"dispatch_id":"other"}');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'gh.log');
    writeFileSync(log, '');
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/bash\nprintf "%s\\n" "$*" >> "$GH_LOG"\ncase "$2" in\nview) printf \'{"headRefOid":"%s","state":"OPEN","isDraft":false,"headRefName":"worker","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}\\n\' "$HEAD_SHA";;\nchecks) exit 0;;\nmerge) exit 0;;\nesac\n',
      { mode: 0o755 },
    );
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, HEAD_SHA: head };
    const invoke = (sha: string) =>
      spawnSync(
        pc,
        [
          'pr',
          'ready-and-merge',
          '12',
          '--root',
          root,
          '--dispatch',
          'dispatch',
          '--tested-head',
          sha,
        ],
        { env, encoding: 'utf8' },
      );
    expect(invoke('0'.repeat(40)).status).not.toBe(0);
    expect(invoke(head).status).not.toBe(0);
    expect(readFileSync(log, 'utf8')).not.toContain('merge ');
    writeFileSync(join(lock, 'owner.json'), '{"dispatch_id":"dispatch"}');
    env.HEAD_SHA = 'f'.repeat(40);
    expect(invoke(head).status).not.toBe(0);
    expect(readFileSync(log, 'utf8')).not.toContain('merge ');
    env.HEAD_SHA = head;
    const landed = invoke(head);
    expect(landed.stderr).toBe('');
    expect(landed.status).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain(`--match-head-commit ${head}`);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(join(home, 'LANDED.json'))).toBe(true);
    const result = JSON.parse(landed.stdout);
    expect(
      execFileSync('git', ['bundle', 'verify', result.bundle], { cwd: root, encoding: 'utf8' }),
    ).toContain('complete history');
    expect(readFileSync(join(result.archive, 'RECEIPT.md'), 'utf8')).toContain('summary: verified');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
