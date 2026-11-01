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
