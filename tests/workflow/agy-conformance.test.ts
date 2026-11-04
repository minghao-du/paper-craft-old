import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { AgyRunner } from '../../packages/core/src/workflow/runtime/agy-runner.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';
import {
  startRun,
  recoverRun,
  dispatchStage,
  collectBusinessTurn,
  inspectRuns,
} from '../../packages/core/src/workflow/run/run-driver.js';

// Opt in from an explicitly trusted checkout; this performs real provider calls.
test.skipIf(!process.env.PC_AGY_CONFORMANCE)(
  'agy Run accepts a native persistent turn and verifies execution release',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-agy-run-')));
    const project = process.cwd();
    const config = {
      file: join(root, 'fleet.json'),
      project,
      root,
      slots: [],
      worktrees: true,
      base: 'main',
    };
    writeFileSync(config.file, '{}');
    mkdirSync(join(root, 'pool'));

    const runner = new AgyRunner();
    const owned: ManagedAttempt[] = [];
    const started = Date.now();
    try {
      const run = await startRun(
        config,
        runner,
        {
          repository: 'owner/conformance',
          number: 90,
          kind: 'issue',
          title: 'Native conformance',
          body: 'Do not use tools. Reply PC90_ORCHESTRATOR and remain idle. This is a controlled conformance check, do not manage any real issue.',
        },
        'agy',
      );
      if (run.orchestrator) owned.push(run.orchestrator);
      expect(run.lifecycle).toBe('running');
      const dispatch = await dispatchStage(config, runner, {
        runId: run.id,
        authority: run.orchestrator!.id,
        subject: 'owner/conformance#90',
        role: 'worker',
        stage: 'conformance',
        inputRevision: '1',
        brief: 'Do not use tools.\nReply exactly PC90_NATIVE',
        prerequisites: [],
        checkout: project,
      });
      const attempt = dispatch.attempts.at(-1)!;
      owned.push(attempt);
      let result: string | undefined;
      for (let n = 0; n < 350; n++) {
        result = await runner.result(attempt, dispatch.id);
        if (result) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(result).toBe('PC90_NATIVE');
      expect(await runner.stopped(attempt)).toBe(false);
      await collectBusinessTurn(config, runner, attempt, (value) =>
        expect(value).toBe('PC90_NATIVE'),
      );
      expect(inspectRuns(config).dispatches!.find((d) => d.id === dispatch.id)!.lifecycle).toBe(
        'accepted',
      );
      expect(await runner.stopped(attempt)).toBe(true);
      const old = run.orchestrator!;
      await runner.cancel(old);
      expect(await runner.recoverReceipt(old)).toBeUndefined();
      const recovered = await recoverRun(config, runner, run.id, {
        replaceOrchestrator: true,
        stopped: runner.stopped.bind(runner),
      });
      const replacement = inspectRuns(config).runs.find((r) => r.id === run.id)!.orchestrator!;
      owned.push(replacement);
      expect(recovered.blockers).toEqual([]);
      expect(replacement.id).not.toBe(old.id);
      expect(replacement.predecessor).toBe(old.id);
      expect(replacement.conversation).toBe(old.conversation);
      expect(replacement.brief).not.toBe(old.brief);
      expect(replacement.brief).toContain('Do not replay');
      expect(await runner.result(replacement, replacement.id)).toBeTruthy();
      expect(await runner.stopped(replacement)).toBe(false);
      await runner.cancel(replacement);
      const reassigned = await recoverRun(config, runner, run.id, {
        replaceOrchestrator: true,
        newConversation: true,
        stopped: runner.stopped.bind(runner),
      });
      const fresh = inspectRuns(config).runs.find((r) => r.id === run.id)!.orchestrator!;
      owned.push(fresh);
      expect(reassigned.blockers).toEqual([]);
      expect(fresh.predecessor).toBe(replacement.id);
      expect(fresh.conversation).not.toBe(replacement.conversation);
      expect(fresh.brief).not.toBe(old.brief);
      expect(await runner.result(fresh, fresh.id)).toBeTruthy();

      console.log(
        'agy complete Run lifecycle and exact managed recovery ms',
        Date.now() - started,
      );
    } finally {
      for (const attempt of owned) {
        if (!(await runner.stopped(attempt))) await runner.cancel(attempt);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  110_000,
);
