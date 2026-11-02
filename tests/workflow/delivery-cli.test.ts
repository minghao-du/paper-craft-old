import { test, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRuns } from '../../packages/core/src/workflow/run/run-driver.js';
import { runDeliveryDemo } from './scripted-epic-demo.js';

test('CLI delivers the toy Worker change, rejects premature merge, and preserves Git before cleanup', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const exit = process.exitCode;
  try {
    const demo = await runDeliveryDemo();
    const registry = inspectRuns(demo.config);
    expect(registry.dispatches?.map((d) => [d.stage, d.lifecycle])).toEqual([
      ['planning', 'accepted'],
      ['implementation', 'superseded'],
      ['implementation', 'accepted'],
      ['pr-quality', 'accepted'],
      ['pr-merge', 'accepted'],
      ['final-records', 'accepted'],
      ['preservation-cleanup', 'accepted'],
    ]);
    expect(demo.prematureLaunches).toBe(0);
    expect(existsSync(demo.checkout)).toBe(false);
    expect(existsSync(join(demo.archive, 'repository.bundle'))).toBe(true);
    expect(registry.resources?.some((r) => r.path === demo.checkout)).toBe(false);
    expect(demo.delivery.head).toBe(demo.git('rev-parse', 'toy-worker'));
  } finally {
    process.exitCode = exit;
    log.mockRestore();
  }
}, 15000);
