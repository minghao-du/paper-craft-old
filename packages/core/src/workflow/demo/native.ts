/** Real GitHub/Git provisioning boundary. Mutations are spaced and never retried. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { DemoAdapter, DemoRepository } from './round.js';
const run = (bin: string, args: string[], cwd?: string) =>
  execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** Adapter deliberately does not enable Agy permission bypass. */
export function nativeDemoAdapter(): DemoAdapter {
  let lastMutation = 0;
  const mutate = async (args: string[]) => {
    await setTimeout(Math.max(0, 1100 - (Date.now() - lastMutation)));
    lastMutation = Date.now();
    return run('gh', args);
  };
  const repository = async (owner: string, name: string): Promise<DemoRepository | null> => {
    try {
      const r = JSON.parse(run('gh', ['api', `repos/${owner}/${name}`]));
      return { id: r.id, owner: r.owner.login, name: r.name };
    } catch (error) {
      if (String(error).includes('HTTP 404')) return null;
      throw error;
    }
  };
  return {
    async check(config) {
      run('agy', ['--version']);
      run('python3', ['--version']);
      run('git', ['--version']);
      run('gh', ['auth', 'status']);
      run('gh', ['api', `users/${config.owner}`]);
    },
    repository,
    async createRepository(owner, name) {
      await mutate(['repo', 'create', `${owner}/${name}`, '--private']);
      const created = await repository(owner, name);
      if (!created) throw new Error('Repository creation returned without verified identity');
      return created;
    },
    async initialize(repo, checkout, files) {
      run('git', ['clone', `https://github.com/${repo.owner}/${repo.name}.git`, checkout]);
      for (const [path, body] of Object.entries(files)) {
        const target = join(checkout, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body);
      }
      run('git', ['checkout', '-b', 'main'], checkout);
      run('git', ['add', '.'], checkout);
      run('git', ['commit', '-m', 'Initialize pinned EPIC demo baseline'], checkout);
      await setTimeout(1100);
      run('git', ['push', '-u', 'origin', 'main'], checkout);
      return run('git', ['rev-parse', 'HEAD'], checkout);
    },
    async createParent(repo, title, body) {
      let url: string;
      try {
        url = await mutate([
          'issue',
          'create',
          '--repo',
          `${repo.owner}/${repo.name}`,
          '--title',
          title,
          '--body',
          body,
        ]);
      } catch (error) {
        const issues = JSON.parse(
          run('gh', [
            'issue',
            'list',
            '--repo',
            `${repo.owner}/${repo.name}`,
            '--state',
            'all',
            '--json',
            'title,url',
          ]),
        );
        const found = issues.filter((issue: { title: string }) => issue.title === title);
        throw new Error(
          `Parent creation uncertain; reconciled matches: ${JSON.stringify(found)}; ${String(error)}`,
          { cause: error },
        );
      }
      const n = Number(url.split('/').at(-1));
      if (!Number.isInteger(n) || n < 1) throw new Error(`Uncertain Parent creation: ${url}`);
      return n;
    },
  };
}
