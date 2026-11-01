import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// CLI seam: prevents losing isolation or launching without the immutable task contract.
it('allocates isolated worktree and launches the runner with its immutable brief', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-spawn space-'));
  const pc = resolve('pc');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'tmux.log');
  writeFileSync(
    join(bin, 'tmux'),
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TMUX_LOG"\nif [ "$1" = new-window ]; then bash -c "${!#}"; echo %42; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'fake-runner'), '#!/bin/bash\ncat -- "$1" > "$RUNNER_LOG"\n', {
    mode: 0o755,
  });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMUX_LOG: log,
    RUNNER_LOG: join(root, 'runner.log'),
  };
  const invoke = (...args: string[]) =>
    JSON.parse(execFileSync(pc, args, { encoding: 'utf8', env }));
  try {
    execFileSync('git', ['init', root]);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ]);
    const run = invoke(
      'run',
      'create',
      '--root',
      root,
      '--issue',
      '79',
      '--runner',
      'fake-runner',
      '--instructions',
      'Preserve evidence',
    );
    expect(() =>
      invoke('worker', 'spawn', '81', 'worker', '--root', root, '--run', run.run_id),
    ).toThrow();
    const dispatch = invoke(
      'worker',
      'spawn',
      '81',
      'temporary-check',
      '--root',
      root,
      '--run',
      run.run_id,
    );
    expect(dispatch).toMatchObject({
      issue_id: 81,
      role: 'temporary-check',
      runner_cmd: 'fake-runner',
      tmux_pane: '%42',
    });
    expect(
      execFileSync('git', ['-C', dispatch.worktree, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(dispatch.worktree);
    expect(readFileSync(dispatch.brief_path, 'utf8')).toContain('Preserve evidence');
    expect(readFileSync(dispatch.brief_path, 'utf8')).toContain('RECEIPT.md');
    expect(readFileSync(log, 'utf8')).toContain('new-window');
    expect(readFileSync(join(root, 'runner.log'), 'utf8')).toContain('GitHub issue #81');
    expect(JSON.parse(readFileSync(join(dispatch.brief_path, '..', 'EXIT.json'), 'utf8'))).toEqual({
      exit_code: 0,
    });
    expect(() =>
      invoke('worker', 'spawn', '81', 'temporary-check', '--root', root, '--run', run.run_id),
    ).toThrow();
    writeFileSync(dispatch.receipt_path, 'outcome: failed\nsummary: retry\n');
    execFileSync(pc, ['worker', 'release', dispatch.dispatch_id, '--root', root], { env });
    const retry = invoke(
      'worker',
      'spawn',
      '81',
      'temporary-check',
      '--root',
      root,
      '--run',
      run.run_id,
    );
    expect(retry.dispatch_id).not.toBe(dispatch.dispatch_id);
    expect(readFileSync(dispatch.receipt_path, 'utf8')).toContain('retry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
