import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// CLI seam: receipt delivery and both exit signals must prevent an indefinite wait.
it('returns published receipts and records crashes after runner exit or tmux death', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-wait-'));
  const pc = resolve('pc');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho no server running >&2\nexit 1\n', {
    mode: 0o755,
  });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  try {
    for (const kind of ['success', 'exit', 'pane', 'unknown']) {
      const home = join(root, '.runtime', 'default', 'runs', 'run', 'dispatches', kind);
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'dispatch.json'),
        JSON.stringify({ dispatch_id: kind, tmux_pane: '%42' }),
      );
      const receipt = join(home, 'RECEIPT.md');
      if (kind === 'unknown')
        writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho permission denied >&2\nexit 1\n', {
          mode: 0o755,
        });
      if (kind === 'success') writeFileSync(receipt, 'outcome: succeeded\nsummary: Done\n');
      if (kind === 'exit') writeFileSync(join(home, 'EXIT.json'), '{"exit_code":2}');
      const result = spawnSync(pc, ['worker', 'wait', kind, '--root', root], {
        env,
        encoding: 'utf8',
        timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      if (kind === 'unknown') {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Cannot determine worker liveness');
        expect(() => readFileSync(receipt)).toThrow();
        continue;
      }
      expect(result.status).toBe(kind === 'success' ? 0 : 1);
      expect(result.stdout).toContain(`outcome: ${kind === 'success' ? 'succeeded' : 'crashed'}`);
      expect(readFileSync(receipt, 'utf8')).toBe(result.stdout);
      expect(
        execFileSync(pc, ['worker', 'wait', kind, '--root', root], { env, encoding: 'utf8' }),
      ).toBe(result.stdout);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
