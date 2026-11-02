import { test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { inspectRuns } from '../../packages/core/src/workflow/run/run-driver.js';
import { runAllRoleDemo } from './scripted-epic-demo.js';

test('CLI closes delivered EPIC before accepted Pipeline and transactional toy report completion', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const exit = process.exitCode;
  try {
    const demo = await runAllRoleDemo();
    const registry = inspectRuns(demo.config);
    const run = registry.runs.find((r) => r.id === demo.run.id)!;
    expect(run.lifecycle).toBe('completed');
    expect(run.epicClosure?.head).toBe(demo.git('rev-parse', 'HEAD'));
    expect(run.pipeline?.disposition).toBe('completed_no_changes');
    expect(readFileSync(run.report!.path, 'utf8')).toContain('No scientific conclusions');
    expect(
      new Set(
        registry.runs
          .flatMap((r) => [r.orchestrator!.role])
          .concat(registry.dispatches!.map((d) => d.role)),
      ),
    ).toEqual(
      new Set([
        'orchestrator',
        'epic',
        'worker',
        'landing',
        'pipeline-audit',
        'pipeline-refactor',
        'research-state',
      ]),
    );
    expect(demo.prematureLaunches).toBe(0);
  } finally {
    process.exitCode = exit;
    log.mockRestore();
  }
}, 20000);
