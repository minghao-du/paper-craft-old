import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ClaudeRunner, type ManagedAttempt } from '../../packages/core/src/workflow/runtime.js';
import { verifyRoleInitialization } from '../../packages/core/src/workflow/role-initialization.js';
import {
  startRun,
  recoverRun,
  dispatchStage,
  collectBusinessTurn,
  inspectRuns,
  retryStage,
  releaseAcceptedExecution,
} from '../../packages/core/src/workflow/run-driver.js';

// Each mode is independent: setup, real calls, assertions and teardown fit one budget.
test.skipIf(!process.env.PC_CLAUDE_CONFORMANCE).each(['acceptance', 'restart', 'takeover'])(
  'Claude native Run %s with actual durable role initialization',
  async (mode) => {
    const project = process.cwd();
    const root = realpathSync(mkdtempSync(join(project, '.pc-claude-conformance-')));
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
    // Production runner uses the complete verified native lifecycle.
    const runner = new ClaudeRunner();
    const owned: ManagedAttempt[] = [];
    const originals = new Map(
      ['.epic-status.json', '.epic-worklog.md'].map((f) => [
        f,
        existsSync(join(project, f)) ? readFileSync(join(project, f)) : undefined,
      ]),
    );
    rmSync(join(project, '.epic-status.json'), { force: true });
    rmSync(join(project, '.epic-worklog.md'), { force: true });
    const lock = join(project, '.pc-execution-owner');
    if (existsSync(lock)) {
      try {
        const owner = JSON.parse(readFileSync(lock, 'utf8'));
        if (!existsSync(owner.registry)) rmSync(lock);
      } catch {
        rmSync(lock);
      }
    }
    let completed = false;
    const started = Date.now();
    try {
      const run = await startRun(
        config,
        runner,
        {
          repository: 'owner/conformance',
          number: 89,
          kind: 'issue',
          title: 'Harmless native conformance',
          body: 'This is a disposable conformance assignment. Read only supplied initialization context, then use Python to write the required initialization.json atomically. Do not search repository files. No GitHub/network calls or repository changes beyond required initialization files. After initialization reply PC89_ORCHESTRATOR and remain idle.',
        },
        'claude',
      );
      if (run.orchestrator) owned.push(run.orchestrator);
      expect(run.lifecycle).toBe('running');
      verifyRoleInitialization(run.orchestrator!);
      await recoverRun(config, runner, run.id);
      expect(inspectRuns(config).runs[0].orchestratorId).toBe(run.orchestratorId);
      const dispatch = await dispatchStage(config, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: 'owner/conformance#89',
        role: 'worker',
        stage: 'conformance',
        inputRevision: '1',
        brief:
          'Disposable conformance only. Read supplied initialization context then use Python to write actual initialization.json and checkout .epic-status.json and startup worklog as instructed. Set issue=89, phase=exploring, summary=Native conformance initialization, and updated_at to actual datetime.now(timezone.utc). Do not search repository files. No other edits, tools or network calls. After initialization reply exactly PC89_NATIVE and remain idle.',
        prerequisites: [],
        checkout: project,
      });
      let attempt = dispatch.attempts.at(-1)!;
      owned.push(attempt);
      expect(attempt.status).toBe('running');
      verifyRoleInitialization(attempt);
      if (mode !== 'acceptance') {
        const prior = attempt;
        await runner.cancel(prior);
        expect(await runner.recoverReceipt(prior)).toBeUndefined();
        const retried = await retryStage(
          config,
          runner,
          dispatch.id,
          run.orchestratorId,
          runner.stopped.bind(runner),
          { replaceConversation: mode === 'takeover' },
        );
        attempt = retried.attempts.at(-1)!;
        owned.push(attempt);
        expect(attempt.id).not.toBe(prior.id);
        expect(attempt.predecessor).toBe(prior.id);
        if (mode === 'restart') expect(attempt.conversation).toBe(prior.conversation);
        else expect(attempt.conversation).not.toBe(prior.conversation);
        expect(attempt.brief).not.toContain('After initialization reply exactly PC89_NATIVE');
        expect(attempt.brief).toContain('Do not replay');
        verifyRoleInitialization(attempt);
      }
      let output: string | undefined;
      for (let n = 0; n < 200; n++) {
        output = await runner.result(attempt, dispatch.id);
        if (output) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(output).toBeTruthy();
      if(mode==='acceptance') expect(output).toBe('PC89_NATIVE');
      expect(await runner.stopped(attempt)).toBe(false);
      await collectBusinessTurn(config, runner, attempt, (value) => { if(mode==='acceptance')expect(value).toBe('PC89_NATIVE');else expect(value).toBeTruthy(); });
      expect(inspectRuns(config).dispatches![0].lifecycle).toBe('accepted');
      expect(await runner.stopped(attempt)).toBe(true);
      expect(existsSync(join(project, '.pc-execution-owner'))).toBe(true);
      await releaseAcceptedExecution(config, runner, dispatch.id, run.orchestratorId, () => {
        completed = true;
      });
      expect(completed).toBe(true);
      expect(existsSync(join(project, '.pc-execution-owner'))).toBe(false);
      console.log(`Claude ${mode} native lifecycle ${Date.now() - started}ms`);
    } finally {
      // Also recover a failed startup's persisted pane so bounded failures cannot leak it.
      for (const run of inspectRuns(config).runs) {
        if (run.orchestrator && !owned.some((a) => a.id === run.orchestrator!.id))
          owned.push(run.orchestrator);
      }
      for (const dispatch of inspectRuns(config).dispatches ?? [])
        for (const a of dispatch.attempts) if (!owned.some((b) => b.id === a.id)) owned.push(a);
      for (const a of owned) if (a.address && !(await runner.stopped(a))) await runner.cancel(a);
      const lock = join(project, '.pc-execution-owner');
      if (existsSync(lock) && readFileSync(lock, 'utf8').includes(root)) rmSync(lock);
      for (const [file, data] of originals) {
        if (data) writeFileSync(join(project, file), data);
        else rmSync(join(project, file), { force: true });
      }
      if (!process.env.PC_KEEP_CONFORMANCE) rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
