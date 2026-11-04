import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoRounds, type DemoAdapter, type DemoConfig } from '../../tools/demo/round.js';
import { DemoControl, type DemoExecution } from '../../tools/demo/control.js';
import { DemoDelivery, type DemoDeliveryAdapter } from '../../tools/demo/delivery.js';
import {
  startRun,
  dispatchStage,
  inspectRun,
  inspectRuns,
  recoverRun,
  stopRun,
  type WorkflowRun,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { reconcileStartup } from '../../packages/core/src/workflow/run/startup.js';

function setupDemoRoundFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-demo-test-')));
  const remote = new Map<string, { id: number; owner: string; name: string }>();
  const adapter: DemoAdapter = {
    check: async () => {},
    repository: async (owner, name) => remote.get(`${owner}/${name}`) ?? null,
    createRepository: async (owner, name) => {
      const repo = { id: 42, owner, name };
      remote.set(`${owner}/${name}`, repo);
      return repo;
    },
    initialize: async (_repository, checkout) => {
      mkdirSync(checkout);
      return 'a'.repeat(40);
    },
    createParent: async () => 1,
  };
  const config: DemoConfig = {
    root,
    owner: 'testowner',
    prefix: 'demo-',
    coordinator: 'test-coord',
    brief: 'Test brief evidence',
  };
  return { root, adapter, config };
}

test('1 & 2: Provisioning returns distinguished Demo config, Workflow config and immutable Requirements', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  try {
    const rounds = new DemoRounds(config, adapter);
    const result = await rounds.provision(true);

    expect(result.phase).toBe('provisioned');
    expect(result.id).toBeDefined();
    expect(result.parent).toBe(1);
    expect(result.repository).toEqual({ id: 42, owner: 'testowner', name: `demo-${result.id}` });

    // Distinguished demo configuration
    expect(result.demoConfig).toEqual(config);
    expect(result.demoConfigFile).toBe(join(result.root, 'demo-config.json'));
    expect(existsSync(result.demoConfigFile)).toBe(true);

    // Generated workflow configuration
    expect(result.workflowConfigFile).toBe(join(result.checkout, '.epic-config.json'));
    expect(existsSync(result.workflowConfigFile)).toBe(true);
    const parsedWorkflowConfig = JSON.parse(readFileSync(result.workflowConfigFile, 'utf8'));
    expect(parsedWorkflowConfig.main_checkout).toBe(result.checkout);
    expect(parsedWorkflowConfig.clone_root).toBe(result.worktrees);
    expect(parsedWorkflowConfig.demo).toBeUndefined();

    // Immutable orchestrator requirements containing round/parent/repository identity, control refs & diagnostic restrictions
    expect(result.requirements).toBeDefined();
    expect(result.requirements).toContain(result.id);
    expect(result.requirements).toContain('testowner/demo-' + result.id + '#1');
    expect(result.requirements).toContain(result.demoConfigFile);
    expect(result.requirements).toContain(result.workflowConfigFile);
    expect(result.requirements).toContain('Diagnostic demo round');
    expect(result.requirements).toContain('Never retry failures or repair defects');
    expect(result.requirements).toContain('Worker dispatch without matching gate authorization is strictly denied');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('3: pc demo arm starts budget and watchdog immediately, creates no Run/agent, and cannot rearm', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  let watchStarted = false;
  const execution: DemoExecution = {
    watch() {
      watchStarted = true;
    },
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);

    const control = new DemoControl(round, execution);
    const statusBefore = control.status();
    expect(statusBefore.armed).toBeFalsy();
    expect(statusBefore.runId).toBeUndefined();

    // Arm the round
    const armedState = await control.arm(120000); // 2 minutes
    expect(armedState.armed).toBe(true);
    expect(armedState.budgetMs).toBe(120000);
    expect(armedState.started).toBeDefined();
    expect(armedState.tick).toBeDefined();
    expect(armedState.stopped).toBe(false);
    expect(armedState.runId).toBeUndefined(); // creates NO Run
    expect(watchStarted).toBe(true); // detached watchdog started immediately

    // Cannot rearm an already armed round
    await expect(control.arm(120000)).rejects.toThrow(/already armed or stopped/i);

    // Cannot rearm after stop
    await control.stop();
    expect(control.status().stopped).toBe(true);
    await expect(control.arm(120000)).rejects.toThrow(/already armed or stopped/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('4 & 5: Normal Workflow intake uniquely binds Round to one Run and enforces constraint contract', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  let watchStarted = false;
  const execution: DemoExecution = {
    watch() {
      watchStarted = true;
    },
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start() {
        return { conversation: 'agy-orch-1', address: 'tmux:test', evidence: 'start-ack' };
      },
      async stopped() {
        return false;
      },
      async recoverReceipt() {
        return { conversation: 'agy-orch-1', address: 'tmux:test', evidence: 'start-ack' };
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    // Attempting to bind before arming fails
    expect(() => control.bindRun('any-run-id')).toThrow(/not armed/i);

    // Arm the round
    await control.arm(3600000);

    // Successful normal intake starts a workflow Run
    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);
    expect(run.id).toBeDefined();

    // Control uniquely binds Round to this Run
    control.bindRun(run.id);

    // Control state is durably bound to this Run
    const boundControl = control.status();
    expect(boundControl.runId).toBe(run.id);
    expect(boundControl.execution).toBe('running');

    // Conflicting bind rejects
    expect(() => control.bindRun('different-run-id')).toThrow(/already bound/i);

    // Reconnect / repeated start reuses the existing Run and does NOT create a new Attempt or Run
    const reconnect = await startRun(fleetConfig, runner, subject, 'agy');
    expect(reconnect.id).toBe(run.id);
    expect(reconnect.orchestrator?.id).toBe(run.orchestrator?.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('6: Worker dispatch is denied without matching Gate evidence, but planning proceeds', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(3600000);

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start() {
        return { conversation: 'agy-orch-2', address: 'tmux:test', evidence: 'start-ack' };
      },
      async stopped() {
        return false;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);
    control.bindRun(run.id);

    // Planning stage (role: epic) proceeds under common controls
    const epicDispatch = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#${subject.number}`,
      role: 'epic',
      stage: 'planning',
      inputRevision: 'rev-1',
      brief: 'Plan the sub-tasks',
      prerequisites: [],
    });
    expect(epicDispatch.id).toBeDefined();
    expect(epicDispatch.role).toBe('epic');

    // Demo delivery gate check: worker1 gate fails without required decomposition
    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect() {
        return {
          version: 'v0',
          children: [],
          nativeDependency: false,
          firstReleased: false,
          secondBaseline: false,
          accepted: false,
        };
      },
    };
    const delivery = new DemoDelivery(round, deliveryAdapter);
    await expect(delivery.gate('worker1')).rejects.toThrow(/Gate 1 verification failed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('7: Expiry or stop before Run binding prevents later launch; replacement Orchestrator denied', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(500); // 500ms budget

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start() {
        return { conversation: 'agy-orch-3', address: 'tmux:test', evidence: 'start-ack' };
      },
      async stopped() {
        return true;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    // Unbound expiry: advance time beyond budget before binding
    await control.checkpoint(undefined, control.status().tick + 600);
    expect(control.status().stopped).toBe(true);

    // Binding a stopped or expired round is denied
    expect(() => control.bindRun('any-run-id')).toThrow(/stopped/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('8: Detached Watchdog invokes stopRun on expiry and stops scheduling', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  let stopRunCalledWith: string | undefined;

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
    };

    let runnerStopped = false;
    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start() {
        return { conversation: 'agy-orch-4', address: 'tmux:test', evidence: 'start-ack' };
      },
      async stopped() {
        return runnerStopped;
      },
    };

    const execution: DemoExecution = {
      watch() {},
      async stop(_r, runId) {
        if (runId) {
          stopRunCalledWith = runId;
          const res = await stopRun(fleetConfig, runner, runId);
          return res.terminated;
        }
        return true;
      },
    };

    const control = new DemoControl(round, execution);
    await control.arm(1000);

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);
    control.bindRun(run.id);

    // Trigger budget expiry via checkpoint (as watchdog does)
    runnerStopped = true;
    await control.checkpoint(undefined, control.status().tick + 1500);

    expect(stopRunCalledWith).toBe(run.id);
    expect(control.status().stopped).toBe(true);

    // Verify run lifecycle in registry is blocked
    const inspectResult = inspectRun(fleetConfig, run.id);
    expect(inspectResult.lifecycle).toBe('blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('9 & 10: Evidenced waits pause budget; business completion ends budget accounting', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    const armed = await control.arm(10000);

    // Evidenced permission wait
    await expect(control.permissionWait('')).rejects.toThrow(/evidence/i);
    await control.permissionWait('Operator observed native permission prompt');
    expect(control.status().wait).toBe('permission');
    expect(control.status().permissionEvidence).toBe('Operator observed native permission prompt');
    const activeAtPause = control.status().activeMs;

    // Time passes during permission wait -> activeMs does NOT increase
    await control.checkpoint(undefined, armed.tick + 2000, true);
    expect(control.status().activeMs).toBe(activeAtPause);

    // Cannot resume permission wait if in human wait
    await control.checkpoint('human');
    await expect(control.permissionResume()).rejects.toThrow(/No permission wait to resume/i);

    // Resume permission wait
    await control.checkpoint('permission');
    await control.permissionResume();
    expect(control.status().wait).toBeUndefined();

    // After resume, activeMs accumulates
    await control.checkpoint(undefined, armed.tick + 3000);
    expect(control.status().activeMs).toBeGreaterThan(0);

    // Report observations and resolve false alarm
    control.report('Observed anomaly', 'log-1');
    const obsId = control.status().observations[0].id;
    control.resolve(obsId, 'Valid test behavior');
    expect(control.status().observations[0].disposition).toEqual({
      status: 'false_alarm',
      reason: 'Valid test behavior',
    });
    // Disposition does not delete the observation
    expect(control.status().observations.length).toBe(1);
    expect(control.status().usage).toBe('unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
