import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';
import { updateRunRegistry } from '@paper-craft/core/workflow/run-driver';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';

test('delivery reads isolate repositories and retain successful evidence after auth failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-gh-')),
    oldPath = process.env.PATH;
  let dashboard;
  try {
    mkdirSync(join(root, 'bin'));
    writeFileSync(
      join(root, 'bin', 'gh'),
      `#!/usr/bin/env node\nconst fs=require('fs');if(fs.existsSync(${JSON.stringify(join(root, 'fail'))})){process.stderr.write('authentication required');process.exit(1)};const a=process.argv;console.log(JSON.stringify({number:7,title:a[a.indexOf('--repo')+1],state:'OPEN',url:'https://github.com/'+a[a.indexOf('--repo')+1]+'/issues/7'}));`,
      { mode: 0o755 },
    );
    process.env.PATH = join(root, 'bin') + ':' + oldPath;
    const configs = ['one', 'two'].map((name) => {
      const dir = join(root, name);
      mkdirSync(dir);
      mkdirSync(join(dir, 'pool'));
      execFileSync('git', ['init', '--quiet', dir]);
      execFileSync('git', [
        '-C',
        dir,
        'remote',
        'add',
        'origin',
        `https://github.com/team/${name}.git`,
      ]);
      const config = join(dir, '.epic-config.json');
      writeFileSync(config, JSON.stringify({ clone_root: 'pool' }));
      const fleetConfig = loadFleetConfig(config);
      const briefPath = join(dir, 'brief.md');
      writeFileSync(briefPath, '# Brief');
      updateRunRegistry(fleetConfig, (registry) => {
        registry.runs.push({
          id: 'run-' + name,
          subject: { repository: 'team/' + name, number: 7 },
          provider: 'codex',
          policy: { name: 'default', revision: 1 },
          lifecycle: 'running',
          phase: 'implementing',
          orchestratorId: 'orch-1',
          brief: { path: briefPath, hash: 'h' },
        });
      });
      return config;
    });
    dashboard = await createDashboard({
      configs,
      dataDir: join(root, 'data'),
      token: 'secret',
      githubIntervalMs: 100,
    });
    const read = () =>
      dashboard!.app.request('http://127.0.0.1:4317/api/github', {
        headers: { host: '127.0.0.1:4317', authorization: 'Bearer secret' },
      });
    const first = await (await read()).json();
    expect(first.map((v: any) => v.value.issue.title).sort()).toEqual(['team/one', 'team/two']);
    expect(first.every((v: any) => v.approvalRequest === 'unknown')).toBe(true);
    writeFileSync(join(root, 'fail'), '');
    await new Promise((resolve) => setTimeout(resolve, 110));
    await dashboard.app.request('http://127.0.0.1:4317/api/refresh', {
      headers: { host: '127.0.0.1:4317', authorization: 'Bearer secret' },
    });
    await expect
      .poll(async () => {
        const values = await (await read()).json();
        return values.every((v: any) => v.stale);
      }, { timeout: 5000 })
      .toBe(true);
    const failed = await (await read()).json();
    expect(
      failed.every(
        (v: any) => v.stale && v.error.includes('gh auth login') && v.value.issue.state === 'OPEN',
      ),
    ).toBe(true);
    expect(
      (
        await dashboard.app.request('http://127.0.0.1:4317/api/github', {
          headers: { host: '127.0.0.1:4317' },
        })
      ).status,
    ).toBe(401);
  } finally {
    dashboard?.stop();
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
