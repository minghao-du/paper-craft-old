/** Explicitly opted-in disposable demo provisioning, separate from business scheduling. */
import {
  readdirSync,
  renameSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

/** Pinned minimal input: no task outputs or implementations. */
export const demoBaseline = {
  'README.md':
    '# EPIC demo\n\nTask 1: Python standard-library generator generate.py writes data.tsv with id/value header and ten tab-separated rows (1,10) through (10,100). Deliver generator, minimal unittest and TSV in PR 1.\n\nTask 2: summarize.py reads data.tsv and writes summary.json containing n=10, mean=55, min=10, max=100. Deliver reader, unittest using changed temporary input, and JSON in PR 2.\n\nCreate exactly two native sub-issues with task 2 blocked by task 1. Worker 2 waits for full PR 1 landing, final records, preservation, cleanup and verified handover. Run python3 -m unittest discover -s tests.\n',
  'tests/__init__.py': '',
  '.gitignore': '__pycache__/\n',
};
/** Content identity makes baseline drift visible across rounds. */
export const demoBaselineId = createHash('sha256')
  .update(JSON.stringify(demoBaseline))
  .digest('hex');
/** Explicit operator boundary; root must already exist and be physically resolved. */
export interface DemoConfig {
  root: string;
  owner: string;
  prefix: string;
  coordinator: string;
  brief: string;
}
/** GitHub identity retained even after a partially failed write. */
export interface DemoRepository {
  id: number;
  owner: string;
  name: string;
}
/** External operations: controlled adapters are not live acceptance evidence. */
export interface DemoAdapter {
  check(config: DemoConfig): Promise<void>;
  repository(owner: string, name: string): Promise<DemoRepository | null>;
  createRepository(owner: string, name: string): Promise<DemoRepository>;
  initialize(
    repository: DemoRepository,
    checkout: string,
    files: Record<string, string>,
  ): Promise<string>;
  createParent(repository: DemoRepository, title: string, body: string): Promise<number>;
}
/** Durable reconnectable identity and original evidence pointers. */
export interface DemoRound {
  id: string;
  phase: 'provisioning' | 'provisioned' | 'failed';
  provider: 'agy';
  config: DemoConfig;
  baseline: string;
  root: string;
  checkout: string;
  worktrees: string;
  state: string;
  research: string;
  entry: string;
  ownershipUncertain?: boolean;
  repository?: DemoRepository;
  initialRevision?: string;
  parent?: number;
  error?: string;
}
/** Public round-control seam. This slice never launches an agent or Run. */
export class DemoRounds {
  constructor(
    readonly config: DemoConfig,
    readonly adapter: DemoAdapter,
  ) {}
  /** Read-only prerequisite inspection and reviewable intended write boundary. */
  async preflight() {
    const c = this.config;
    if (!isAbsolute(c.root) || realpathSync(c.root) !== c.root)
      throw new Error('Expected absolute physical demo root');
    if (!/^[a-zA-Z0-9-]+$/.test(c.owner) || !/^[a-zA-Z0-9-]+-$/.test(c.prefix))
      throw new Error('Expected explicit owner and repository prefix ending in -');
    if (!c.coordinator.trim() || !c.brief.trim())
      throw new Error('Expected Coordinator identity and confirmed report brief');
    if (createHash('sha256').update(JSON.stringify(demoBaseline)).digest('hex') !== demoBaselineId)
      throw new Error('Pinned baseline identity mismatch');
    for (const name of readdirSync(c.root)) {
      const path = join(c.root, name);
      if (
        !/^[0-9a-f-]{36}$/.test(name) ||
        realpathSync(path) !== path ||
        !existsSync(join(path, 'round.json'))
      )
        throw new Error(`Unowned resource in demo root: ${path}`);
      const prior = this.status(name);
      if (prior.phase === 'provisioning')
        throw new Error(`Unresolved provisioning occupancy: ${name}`);
    }
    await this.adapter.check(c);
    return {
      ...c,
      baseline: demoBaselineId,
      provider: 'agy',
      writes: [
        'new private repository and initial EPIC',
        'two task PRs and human-confirmed closure during execution',
        'isolated checkout, worktrees, workflow state and research report',
        'eligible repository and local round deletion',
      ],
      permissionBypass: false,
    };
  }
  /** Reconnect without modifying any round evidence. */
  status(id: string): DemoRound {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid round identifier');
    if (
      realpathSync(this.config.root) !== this.config.root ||
      realpathSync(join(this.config.root, id)) !== join(this.config.root, id)
    )
      throw new Error('Round physical root ownership mismatch');
    const round: DemoRound = JSON.parse(
      readFileSync(join(this.config.root, id, 'round.json'), 'utf8'),
    );
    if (
      round.id !== id ||
      round.config.root !== this.config.root ||
      round.root !== join(this.config.root, id) ||
      round.checkout !== join(round.root, 'checkout') ||
      round.worktrees !== join(round.root, 'worktrees') ||
      round.state !== join(round.root, 'state') ||
      round.research !== join(round.root, 'research') ||
      round.entry !== join(round.root, 'research', 'report.md')
    )
      throw new Error('Round ownership mismatch');
    return round;
  }
  /** Consent authorizes this fresh round only; partial failures remain inspectable. */
  async provision(confirmed: boolean): Promise<DemoRound> {
    if (!confirmed) throw new Error('Explicit confirmation required after reviewing preflight');
    await this.preflight();
    const id = randomUUID();
    const root = join(this.config.root, id);
    const round: DemoRound = {
      id,
      phase: 'provisioning',
      provider: 'agy',
      config: this.config,
      baseline: demoBaselineId,
      root,
      checkout: join(root, 'checkout'),
      worktrees: join(root, 'worktrees'),
      state: join(root, 'state'),
      research: join(root, 'research'),
      entry: join(root, 'research', 'report.md'),
    };
    const lock = join(this.config.root, 'provision.lock');
    mkdirSync(lock);
    mkdirSync(root);
    const save = () => {
      writeFileSync(join(root, 'round.json.tmp'), JSON.stringify(round, null, 2));
      renameSync(join(root, 'round.json.tmp'), join(root, 'round.json'));
    };
    save();
    try {
      const name = `${this.config.prefix}${id}`;
      if (await this.adapter.repository(this.config.owner, name))
        throw new Error('Refusing existing same-name repository');
      try {
        round.repository = await this.adapter.createRepository(this.config.owner, name);
      } catch (error) {
        round.ownershipUncertain = true;
        round.repository = (await this.adapter.repository(this.config.owner, name)) ?? undefined;
        save();
        throw error;
      }
      if (
        round.repository.owner.toLowerCase() !== this.config.owner.toLowerCase() ||
        round.repository.name !== name ||
        !Number.isSafeInteger(round.repository.id) ||
        round.repository.id <= 0
      )
        throw new Error('Created repository identity mismatch');
      save();
      for (const dir of [round.worktrees, round.state, round.research]) {
        if (existsSync(dir)) throw new Error(`Ownership conflict: ${dir}`);
        mkdirSync(dir);
      }
      round.initialRevision = await this.adapter.initialize(
        round.repository,
        round.checkout,
        demoBaseline,
      );
      writeFileSync(
        join(round.checkout, '.epic-config.json'),
        JSON.stringify({
          main_checkout: round.checkout,
          clone_root: round.worktrees,
          clone_names: [],
          local_worktrees: true,
          base_branch: 'main',
        }),
      );
      writeFileSync(join(round.research, 'brief.md'), this.config.brief);
      save();
      round.parent = await this.adapter.createParent(
        round.repository,
        `[EPIC] Independent Agy demo ${id}`,
        demoBaseline['README.md'],
      );
      round.phase = 'provisioned';
      save();
      return round;
    } catch (error) {
      round.phase = 'failed';
      round.error = error instanceof Error ? error.message : String(error);
      save();
      throw error;
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
}
