import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from 'vitest';

test('independent Fleets cannot dispatch workers into the same physical checkout', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-owners-')));
  const pool = join(root, 'pool');
  mkdirSync(pool);
  mkdirSync(join(pool, 'slot'));
  const script = join(root, 'compete.mts');
  writeFileSync(
    script,
    `
import {startRun, dispatchStage} from ${JSON.stringify(resolve('packages/core/src/workflow/run/run-driver.ts'))};
const config=JSON.parse(process.argv[2]);
const runner={interactive:true,name:'codex',async preflight(){},async start(a){return {conversation:a.id,address:'controlled',evidence:'ack'}}};
try {
const run=await startRun(config,runner,{repository:'owner/repo',number:Number(process.argv[3]),kind:'epic',title:'test',body:'test'},'codex');
await dispatchStage(config,runner,{runId:run.id,authority:run.orchestratorId,subject:'owner/repo#'+process.argv[3],role:'worker',stage:'implementation',inputRevision:'v1',brief:'bounded',prerequisites:[],checkout:config.root+'/slot'});
process.stdout.write('owned');
} catch(e) {process.stdout.write(String(e));}
`,
  );
  const compete = (n: number) => {
    const project = join(root, `project-${n}`);
    mkdirSync(project);
    const config = {
      file: join(project, '.epic-config.json'),
      project,
      root: pool,
      slots: ['slot'],
      worktrees: false,
      base: 'main',
    };
    return new Promise<string>((done, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', script, JSON.stringify(config), String(n)],
        { cwd: process.cwd() },
      );
      let output = '';
      child.stdout.on('data', (b) => (output += b));
      child.stderr.on('data', (b) => (output += b));
      child.on('error', reject);
      child.on('exit', () => done(output));
    });
  };
  try {
    const outcomes = await Promise.all([compete(1), compete(2)]);
    expect(outcomes.filter((s) => s === 'owned')).toHaveLength(1);
    expect(outcomes).toContainEqual(expect.stringMatching(/checkout occup/i));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('run-ownership functions directly manage subject and checkout reservations within and outside transactions', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-ownership-direct-')));
  const pool = join(root, 'pool');
  mkdirSync(pool);
  const checkout1 = join(pool, 'checkout-1');
  mkdirSync(checkout1);
  const project = join(root, 'project');
  mkdirSync(project);
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: pool,
    slots: ['checkout-1', 'checkout-2'],
    worktrees: false,
    base: 'main',
  };
  writeFileSync(config.file, JSON.stringify({ clone_root: 'pool' }));

  const runner = {
    interactive: true,
    name: 'codex',
    async preflight() {},
    async start() {
      return { conversation: 'sess-direct', address: 'tmux:test', evidence: 'ack' };
    },
    async stopped() {
      return true;
    },
  };

  try {
    const {
      reserveSubject,
      referenceRunSubject,
      reserveRunCheckout,
      orchestratorForSubject,
      releaseRunCheckout,
    } = await import('../../packages/core/src/workflow/run/run-ownership.js');
    const { startRun, dispatchStage, updateRunRegistry, inspectRuns } = await import(
      '../../packages/core/src/workflow/run/run-driver.js'
    );

    const run = await startRun(
      config,
      runner,
      { repository: 'owner/repo', number: 100, kind: 'issue', title: 'issue-100', body: 'body' },
      'codex',
    );

    // 1. orchestratorForSubject returns active orchestrator attempt
    const orch = orchestratorForSubject(config, 'owner/repo', 100);
    expect(orch.id).toBe(run.orchestratorId);

    // 2. referenceRunSubject consumes existing or reserves
    const refOwner = referenceRunSubject(config, run.id, 'owner/repo#100');
    expect(refOwner).toBe(run.id);

    // 3. reserveRunCheckout within an existing updateRunRegistry transaction
    const checkout2 = join(pool, 'checkout-2');
    mkdirSync(checkout2);
    updateRunRegistry(config, (reg) => {
      reserveRunCheckout(config, run.id, run.orchestratorId, checkout2, reg);
    });

    const regAfter = inspectRuns(config);
    expect(regAfter.resources?.some((r) => r.path === checkout2)).toBe(true);

    // 4. dispatch stage to checkout1, then releaseRunCheckout
    await dispatchStage(config, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'owner/repo#100',
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-1',
      brief: 'do work',
      prerequisites: [],
      checkout: checkout1,
    });

    let cleanedUp = false;
    await releaseRunCheckout(
      config,
      run.id,
      checkout1,
      async () => true,
      () => {
        cleanedUp = true;
      },
    );
    expect(cleanedUp).toBe(true);

    const regFinal = inspectRuns(config);
    expect(regFinal.resources?.some((r) => r.path === checkout1)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

