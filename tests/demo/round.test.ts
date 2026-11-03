import { test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoRounds, type DemoAdapter } from '../../packages/core/src/workflow/demo/round.js';

test('preflight is read-only; provisioning needs consent and reconnects; failures retain identity', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-round-')));
  const remote = new Map<string, { id: number; owner: string; name: string }>();
  const adapter: DemoAdapter = {
    check: async () => {},
    repository: async (owner, name) => remote.get(`${owner}/${name}`) ?? null,
    createRepository: async (owner, name) => {
      const repo = { id: 41, owner, name };
      remote.set(`${owner}/${name}`, repo);
      return repo;
    },
    initialize: async (_repository, checkout) => {
      mkdirSync(checkout);
      return 'a'.repeat(40);
    },
    createParent: async () => 1,
  };
  const config = {
    root,
    owner: 'tester',
    prefix: 'pc-demo-',
    coordinator: 'coordinator',
    brief: 'Report actual evidence',
  };
  try {
    const rounds = new DemoRounds(config, adapter);
    await rounds.preflight();
    expect(readdirSync(root)).toEqual([]);
    await expect(rounds.provision(false)).rejects.toThrow('confirmation');
    const round = await rounds.provision(true);
    expect(new DemoRounds(config, adapter).status(round.id)).toMatchObject({
      phase: 'provisioned',
      repository: { id: 41 },
      parent: 1,
    });
    adapter.createParent = async () => {
      throw new Error('policy denied');
    };
    await expect(rounds.provision(true)).rejects.toThrow('policy denied');
    const failed = readdirSync(root)
      .map((id) => rounds.status(id))
      .find((r) => r.phase === 'failed');
    expect(failed).toMatchObject({ repository: { id: 41 }, error: 'policy denied' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
