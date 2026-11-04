import { chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  startupDirectory,
  startupRecoveryStatus,
} from '../../packages/core/src/workflow/run/startup.js';
import { reconcileStartup } from '../../packages/core/src/workflow/run/startup.js';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  startRun,
  recoverRun,
  inspectRuns,
  dispatchStage,
  retryStage,
  updateRunRegistry,
} from '../../packages/core/src/workflow/run/run-driver.js';
import {
  type ManagedAttempt,
} from '../../packages/core/src/workflow/runtime/runtime.js';
import { createRunner } from '../../packages/cli/src/workflow/composition.js';
import { initializeRole } from './initialize-role.js';

test.each(['agy'])(
  'late %s readiness activates the original attempt and continues it once',
  async (name) => {
    const f = await fixture(name);
    const send = f.runner.send;
    f.runner.send = async (a, message) => {
      const current = inspectRuns(f.config).runs[0];
      expect(current.lifecycle).toBe('running');
      expect(current.orchestratorId).toBe(a.id);
      return send(a, message);
    };
    try {
      expect(f.run.lifecycle).toBe('blocked');
      await recoverRun(f.config, f.runner, f.run.id);
      expect(f.sent).toEqual([]);
      f.ready = true;
      await recoverRun(f.config, f.runner, f.run.id);
      expect(inspectRuns(f.config).runs[0].lifecycle).toBe('running');
      expect(f.sent).toHaveLength(1);
      await recoverRun(f.config, f.runner, f.run.id);
      expect(f.sent).toHaveLength(1);
      expect((await startRun(f.config, f.runner, f.run.subject, name)).orchestratorId).toBe(
        f.run.orchestratorId,
      );
    } catch (err) {
      const logFile = join(directory, 'startup.log');
      if (existsSync(logFile)) console.error('STARTUP LOG:\n' + readFileSync(logFile, 'utf8'));
      throw err;
    } finally {
      f.close();
    }
  },
);

test('uncertain activation reconciles native input without resending or accepting business work', async () => {
  const f = await fixture();
  let acknowledged = false;
  let sends = 0;
  f.runner.send = async () => {
    sends++;
    return { status: 'uncertain', evidence: 'submission acknowledgement lost' };
  };
  const runner = {
    ...f.runner,
    async messageReceipt() {
      return acknowledged ? 'exact native input' : undefined;
    },
  };
  try {
    f.ready = true;
    expect(await reconcileStartup(f.config, runner, f.run.id)).toBe(true);
    expect(await reconcileStartup(f.config, runner, f.run.id)).toBe(true);
    expect(sends).toBe(1);
    acknowledged = true;
    expect(await reconcileStartup(f.config, runner, f.run.id)).toBe(false);
    expect(sends).toBe(1);
    const registry = inspectRuns(f.config);
    expect(registry.runs[0].orchestrator?.activation?.status).toBe('delivered');
    expect(registry.acknowledgements).toBeUndefined();
  } finally {
    f.close();
  }
});

test('late child startup and a verified retry each continue once; superseded attempts stay untouched', async () => {
  const f = await fixture();
  try {
    f.ready = true;
    await reconcileStartup(f.config, f.runner, f.run.id);
    f.ready = false;
    const request = {
      runId: f.run.id,
      authority: f.run.orchestratorId,
      subject: 'test/fixture#1',
      role: 'worker' as const,
      stage: 'implementation',
      inputRevision: 'rev',
      brief: 'isolated fixture only',
      prerequisites: [],
    };
    const child = await dispatchStage(f.config, f.runner, request);
    expect(child.attempts[0].status).toBe('unknown');
    const claim = JSON.parse(
      readFileSync(join(child.attempts[0].directory, 'initialization.json'), 'utf8'),
    );
    writeFileSync(
      join(child.attempts[0].directory, 'initialization.json'),
      JSON.stringify({ ...claim, authority: 'wrong-authority' }),
    );
    f.ready = true;
    expect(await reconcileStartup(f.config, f.runner, f.run.id)).toBe(true);
    expect(f.sent).toHaveLength(1);
    writeFileSync(join(child.attempts[0].directory, 'initialization.json'), JSON.stringify(claim));
    expect(await reconcileStartup(f.config, f.runner, f.run.id)).toBe(false);
    expect(inspectRuns(f.config).dispatches![0].lifecycle).toBe('running');
    const first = inspectRuns(f.config).dispatches![0].attempts[0];
    f.ready = false;
    const retried = await retryStage(
      f.config,
      f.runner,
      child.id,
      f.run.orchestratorId,
      async () => true,
    );
    f.ready = true;
    await reconcileStartup(f.config, f.runner, f.run.id);
    await reconcileStartup(f.config, f.runner, f.run.id);
    expect(f.sent).toEqual([
      `activate-${f.run.orchestratorId}`,
      `activate-${first.id}`,
      `activate-${retried.attempts[1].id}`,
    ]);
    expect(inspectRuns(f.config).dispatches![0].attempts[0]).toEqual(first);
    expect(inspectRuns(f.config).receipts).toBeUndefined();
  } finally {
    f.close();
  }
});

test('replacement revokes the predecessor and never inherits its delivered activation', async () => {
  const f = await fixture();
  try {
    f.ready = true;
    await reconcileStartup(f.config, f.runner, f.run.id);
    await recoverRun(f.config, f.runner, f.run.id, {
      replaceOrchestrator: true,
      stopped: async () => true,
    });
    const current = inspectRuns(f.config).runs[0];
    expect(current.orchestratorId).not.toBe(f.run.orchestratorId);
    expect(f.sent).toEqual([
      `activate-${f.run.orchestratorId}`,
      `activate-${current.orchestratorId}`,
    ]);
    expect(current.priorOrchestrators![0].activation?.id).toBe(`activate-${f.run.orchestratorId}`);
  } finally {
    f.close();
  }
});

async function fixture(name = 'agy') {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-startup-fixture-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
  const sent: string[] = [];
  const f = {
    config,
    project,
    sent,
    ready: false,
    close() {
      rmSync(project, { recursive: true, force: true });
    },
  };
  const runner = {
    name,
    interactive: true,
    async preflight() {},
    async stopped() {
      return false;
    },
    async result() {
      return undefined;
    },
    async start(a: ManagedAttempt) {
      a.startupGate = true;
      initializeRole(a);
      throw new Error('startup unacknowledged');
    },
    async recoverReceipt() {
      return f.ready
        ? { conversation: 'original', address: 'tmux:%1', evidence: 'native ready' }
        : undefined;
    },
    async send(
      _a: ManagedAttempt,
      message: { id: string; brief: string },
    ): Promise<{ status: 'delivered' | 'uncertain'; evidence: string }> {
      sent.push(message.id);
      return { status: 'delivered', evidence: 'exact input' };
    },
  };
  const run = await startRun(
    config,
    runner,
    { repository: 'test/fixture', number: 1, kind: 'issue', title: 'fixture', body: 'no analysis' },
    runner.name,
  );
  return Object.assign(f, { runner, run });
}

test.each(['src', 'dist'])(
  'detached %s startup survives caller exit and repairs an interrupted helper',
  async (variant) => {
    const f = await fixture();
    const directory = startupDirectory(f.config, f.run.id);
    const bin = join(f.project, 'bin');
    mkdirSync(bin);
    const submitted = join(f.project, 'submitted.json');
    updateRunRegistry(f.config, (registry) => {
      const o = registry.runs[0].orchestrator!;
      o.terminalSession = `pc-run-${f.run.id}`;
      o.address = 'tmux:%1';
      o.providerState = {
        session: `pc-run-${f.run.id}`,
        address: 'tmux:%1',
        run: f.run.id,
      };
    });
    const attempt = inspectRuns(f.config).runs[0].orchestrator!;
    writeFileSync(
      join(attempt.directory, 'terminal.json'),
      JSON.stringify({
        address: 'tmux:%1',
        session: `pc-run-${f.run.id}`,
        run: f.run.id,
      }),
    );
    const native = join(f.project, 'native.jsonl');
    writeFileSync(
      join(attempt.directory, 'agy-native.json'),
      JSON.stringify({ conversation_id: 'original', transcript_path: native, agent_state: 'idle' }),
    );
    const events: Array<{
      step_index: number;
      type: string;
      source: string;
      status: string;
      content?: string;
    }> = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        content: attempt.brief,
      },
    ];
    const save = () => writeFileSync(native, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    save();

    writeFileSync(
      join(bin, 'tmux'),
      `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'list-panes') {
  process.stdout.write('%1 0\\n');
} else if (args[0] === 'display-message') {
  process.stdout.write(${JSON.stringify(`pc-run-${f.run.id} ${f.run.id} %1\n`)});
} else if (args[0] === 'list-sessions') {
  process.stdout.write(${JSON.stringify(`pc-run-${f.run.id} ${f.run.id}\n`)});
} else if (args[0] === 'load-buffer') {
  const filePath = args.at(-1);
  if (filePath && fs.existsSync(filePath)) {
    const text = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(${JSON.stringify(submitted)}, JSON.stringify(['queue']));
    try {
      const raw = fs.readFileSync(${JSON.stringify(native)}, 'utf8');
      const lines = raw.trim() ? raw.trim().split('\\n').map(l => JSON.parse(l)) : [];
      lines.push({
        step_index: lines.length,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        content: '<USER_REQUEST>\\n' + text + '\\n</USER_REQUEST>',
      });
      fs.writeFileSync(${JSON.stringify(native)}, lines.map(l => JSON.stringify(l)).join('\\n') + '\\n');
    } catch {}
  }
}
`,
    );
    chmodSync(join(bin, 'tmux'), 0o700);
    const harness = join(f.project, 'caller.ts');
    const source = join(process.cwd(), 'packages/core', variant, 'workflow');
    const cliSource = join(process.cwd(), 'packages/cli', variant, 'workflow');
    const extension = variant === 'src' ? '.ts' : '.js';
    writeFileSync(
      harness,
      `
    import { loadFleetConfig } from ${JSON.stringify(source + '/fleet/fleet-config' + extension)};
    import { startRun, inspectRuns } from ${JSON.stringify(source + '/run/run-driver' + extension)};
    import { createRunner } from ${JSON.stringify(cliSource + '/composition' + extension)};
    const config = loadFleetConfig(process.argv[2]);
    const run = inspectRuns(config).runs[0];
    const runner = createRunner('agy');
    runner.preflight = async () => {};
    runner.start = async () => { throw new Error('Repeated start must never launch another provider'); };
    await startRun(config, runner, run.subject, 'agy');
  `,
    );
    writeFileSync(join(f.project, 'package.json'), JSON.stringify({ type: 'module' }));
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
    const invoke = () =>
      execFileSync(
        process.execPath,
        [
          '--import',
          join(process.cwd(), 'node_modules/tsx/dist/loader.mjs'),
          ...(variant === 'src' ? ['--conditions=paper-craft-source'] : []),
          harness,
          f.config.file,
        ],
        { env, timeout: 10000, stdio: 'pipe' },
      );
    const wait = async (condition: () => boolean) => {
      const deadline = Date.now() + 8000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Isolated startup helper did not converge');
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    const lockPid = () => Number(readFileSync(join(directory, 'startup.lock', 'pid'), 'utf8'));
    try {
      invoke();
      await wait(() => startupRecoveryStatus(f.config, f.run.id).active);
      expect(existsSync(submitted)).toBe(false);
      process.kill(lockPid(), 'SIGTERM');
      await wait(() => !startupRecoveryStatus(f.config, f.run.id).active);
      invoke();
      await wait(() => startupRecoveryStatus(f.config, f.run.id).active);
      events.push({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'RUNNING',
        content: `[pc ready role=orchestrator attempt=${attempt.id}]`,
      });
      // A ready line in an unfinished response must not activate the Run.
      save();
      await new Promise((r) => setTimeout(r, 2200));
      expect(existsSync(submitted)).toBe(false);
      events[1].status = 'DONE';
      save();
      await wait(() => existsSync(submitted));
      await wait(() => !startupRecoveryStatus(f.config, f.run.id).active);
      const current = inspectRuns(f.config).runs[0];
      expect(current.id).toBe(f.run.id);
      expect(current.orchestratorId).toBe(attempt.id);
      expect(current.orchestrator?.activation?.status).toBe('delivered');
      expect(current.lifecycle).toBe('running');
      expect(JSON.parse(readFileSync(submitted, 'utf8'))).toContain('queue');
    } catch (err) {
      const logFile = join(directory, 'startup.log');
      if (existsSync(logFile)) console.error('STARTUP LOG:\n' + readFileSync(logFile, 'utf8'));
      throw err;
    } finally {
      if (startupRecoveryStatus(f.config, f.run.id).active) process.kill(lockPid(), 'SIGTERM');
      await wait(() => !startupRecoveryStatus(f.config, f.run.id).active);
      f.close();
    }
  },
  30000,
);

test.each(['agy'])(
  '%s result collection refreshes a stale attempt and ignores the completed ready turn',
  async (name) => {
    const f = await fixture(name);
    const stale = structuredClone(f.run.orchestrator!);
    const directory = stale.directory;
    const path = join(directory, 'business-native.jsonl');
    const events: object[] = [];
    const save = () => writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n'));
    const ready = `[pc ready role=orchestrator attempt=${stale.id}]`;
    writeFileSync(
      join(directory, 'agy-native.json'),
      JSON.stringify({ conversation_id: 'original', transcript_path: path, agent_state: 'idle' }),
    );
    events.push(
      {
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        content: stale.brief,
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        content: ready + ' ready only',
      },
    );
    save();
    const provider = createRunner(name);
    try {
      expect(await provider.result!(stale, stale.id)).toBeUndefined();
      f.ready = true;
      await reconcileStartup(f.config, f.runner, f.run.id);
      expect(await provider.result!(stale, stale.id)).toBeUndefined();
      const activation = inspectRuns(f.config).runs[0].orchestrator!.activation!;
      events.push(
        {
          step_index: 2,
          type: 'USER_INPUT',
          source: 'USER_EXPLICIT',
          status: 'DONE',
          content: activation.brief,
        },
        {
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          status: 'DONE',
          content: 'fixture business output',
        },
      );
      save();
      expect(await provider.result!(stale, stale.id)).toBe('fixture business output');
      expect(stale.conversation).toBe('original');
    } catch (err) {
      const logFile = join(directory, 'startup.log');
      if (existsSync(logFile)) console.error('STARTUP LOG:\n' + readFileSync(logFile, 'utf8'));
      throw err;
    } finally {
      f.close();
    }
  },
);

test('verified termination stops observation and retains the original blocked execution', async () => {
  const f = await fixture();
  try {
    f.ready = true;
    updateRunRegistry(f.config, (registry) => {
      registry.runs[0].lifecycle = 'running';
      registry.runs[0].orchestrator!.status = 'running';
    });
    expect(
      await reconcileStartup(
        f.config,
        {
          ...f.runner,
          async stopped() {
            return true;
          },
        },
        f.run.id,
      ),
    ).toBe(false);
    const current = inspectRuns(f.config).runs[0];
    expect(current.lifecycle).toBe('blocked');
    expect(current.orchestrator?.status).toBe('unknown');
    expect(current.orchestrator?.startupStopped).toBe(true);
    expect(f.sent).toEqual([]);
    expect((await startRun(f.config, f.runner, f.run.subject, f.runner.name)).orchestratorId).toBe(
      f.run.orchestratorId,
    );
  } finally {
    f.close();
  }
});

test('an interrupted initial caller reconnects its durable Attempt instead of launching another', async () => {
  const f = await fixture();
  try {
    updateRunRegistry(f.config, (registry) => {
      delete registry.runs[0].orchestrator;
    });
    f.ready = true;
    expect(await reconcileStartup(f.config, f.runner, f.run.id)).toBe(false);
    const current = inspectRuns(f.config).runs[0];
    expect(current.orchestratorId).toBe(f.run.orchestratorId);
    expect(current.orchestrator?.activation?.status).toBe('delivered');
    expect(f.sent).toEqual([`activate-${f.run.orchestratorId}`]);
  } finally {
    f.close();
  }
});

test('concurrent recovery shares one activation intent and never demotes confirmed delivery', async () => {
  const f = await fixture();
  try {
    f.ready = true;
    const runner = {
      ...f.runner,
      async messageReceipt() {
        await new Promise((r) => setTimeout(r, 10));
        return undefined;
      },
    };
    await Promise.all([
      reconcileStartup(f.config, runner, f.run.id),
      reconcileStartup(f.config, runner, f.run.id),
    ]);
    expect(f.sent).toHaveLength(1);
    expect(inspectRuns(f.config).runs[0].orchestrator?.activation?.status).toBe('delivered');
  } finally {
    f.close();
  }
});

test('startup and recovery operate directly through run-registry without loading run-driver', async () => {
  const { startRun: directStartRun, verifyRunRequirements: directVerify } = await import(
    '../../packages/core/src/workflow/run/startup.js'
  );
  const { recoverRun: directRecoverRun } = await import(
    '../../packages/core/src/workflow/run/recovery.js'
  );
  const { inspectRuns: directInspectRuns } = await import(
    '../../packages/core/src/workflow/run/run-registry.js'
  );

  const f = await fixture('agy');
  try {
    const reg = directInspectRuns(f.config);
    expect(reg.runs.length).toBeGreaterThan(0);
    expect(reg.runs[0].id).toBe(f.run.id);

    expect(() => directVerify(reg.runs[0])).not.toThrow();

    const recoveryResult = await directRecoverRun(f.config, f.runner, f.run.id);
    expect(recoveryResult.blockers).toBeDefined();

    const reconnected = await directStartRun(f.config, f.runner, f.run.subject, 'agy');
    expect(reconnected.id).toBe(f.run.id);
    expect(reconnected.orchestratorId).toBe(f.run.orchestratorId);
  } finally {
    f.close();
  }
});
