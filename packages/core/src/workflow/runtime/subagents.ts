/** Durable temporary delegation. Parents retain checkout ownership throughout execution. */
import { claimDriver } from './driver-lock.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, isAbsolute, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { stateDirectory } from './handoff.js';
import { workflowSource, type FleetConfig } from './fleet-config.js';

/** Identity of the accountable parent and its logical task. */
export interface TaskParent {
  id: string;
  role: 'orchestrator' | 'epic' | 'worker' | 'landing';
  task: string;
}
/** Requested permission and explicit file allocation for a temporary task. */
export interface ShortInput {
  parent: TaskParent;
  checkout: string;
  mode: 'read' | 'write';
  brief: string;
  files: string[];
}
/** Durable execution facts; unknown continues occupying concurrency. */
export interface ShortTask extends ShortInput {
  id: string;
  attempt: string;
  directory: string;
  status: 'queued' | 'running' | 'unknown' | 'succeeded' | 'failed';
  runner?: string;
  result?: string;
  evidence?: string;
  error?: string;
  collected?: boolean;
  wait?: { timedOut: boolean; at: string };
  cancellation?: {
    requested: string;
    outcome: 'unsupported' | 'failed' | 'confirmed';
    evidence?: string;
    error?: string;
  };
  handoff?: { issue: number; status: 'requested' };
}
/** A short-task adapter must enforce mode and report verifiable termination. */
export interface ShortRunner {
  name: string;
  cancellation?: boolean;
  cancel?(task: ShortTask): Promise<{ evidence: string }>;
  observe?(task: ShortTask): Promise<{
    status: 'running' | 'unknown' | 'failed' | 'succeeded';
    evidence?: string;
    result?: string;
  }>;
  run(
    task: ShortTask,
  ): Promise<{ status: 'succeeded' | 'failed'; result: string; evidence: string }>;
}
function save(path: string, value: unknown): void {
  const temp = path + '.' + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}
/** Fleet-scoped queue and result interface available to every core role. */
export class Subagents {
  private readonly home: string;
  constructor(
    private readonly config: FleetConfig,
    private readonly limits = { fleet: 4, parent: 2 },
  ) {
    if (
      !Number.isSafeInteger(limits.fleet) ||
      limits.fleet < 1 ||
      !Number.isSafeInteger(limits.parent) ||
      limits.parent < 1
    )
      throw new Error('Expected positive integer Subagent limits');
    this.home = stateDirectory(
      config,
      '.runtime',
      'subagents',
      createHash('sha256').update(config.file).digest('hex'),
    );
    mkdirSync(this.home, { recursive: true });
    const policy = join(this.home, 'limits.json');
    if (existsSync(policy)) {
      if (JSON.stringify(JSON.parse(readFileSync(policy, 'utf8'))) !== JSON.stringify(limits))
        throw new Error('Expected existing Fleet Subagent limits');
    } else writeFileSync(policy, JSON.stringify(limits), { flag: 'wx' });
  }
  private path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Expected task UUID');
    return join(this.home, id + '.json');
  }
  /** Query persisted execution and ownership without inferring terminal success. */
  get(id: string): ShortTask {
    return JSON.parse(readFileSync(this.path(id), 'utf8')) as ShortTask;
  }
  /** List queued, occupied and completed tasks in this Fleet. */
  list(): ShortTask[] {
    return readdirSync(this.home)
      .filter((x) => /^[a-f0-9-]{36}\.json$/.test(x))
      .map((x) => this.get(x.slice(0, -5)));
  }
  /** Queue a task after validating parent, permissions and file responsibility. */
  create(input: ShortInput): ShortTask {
    if (
      !input.brief.trim() ||
      !input.parent.id ||
      !input.parent.task ||
      !['orchestrator', 'epic', 'worker', 'landing'].includes(input.parent.role)
    )
      throw new Error('Expected parent identity, core role, task and brief');
    if (!['read', 'write'].includes(input.mode))
      throw new Error('Expected read or write permission');
    const checkout = workflowSource(this.config, input.checkout);
    if (input.files.some((f) => !f || isAbsolute(f) || normalize(f).startsWith('..')))
      throw new Error('Expected relative allocated file paths');
    if (input.mode === 'write' && !input.files.length)
      throw new Error('Writable tasks require explicit file responsibility');
    const id = randomUUID();
    const directory = stateDirectory(
      this.config,
      '.runtime',
      'subagents',
      createHash('sha256').update(this.config.file).digest('hex'),
      id,
    );
    const task: ShortTask = {
      ...input,
      checkout,
      id,
      attempt: randomUUID(),
      directory,
      status: 'queued',
    };
    save(this.path(id), task);
    return task;
  }
  /** Dispatch available work; a persistent lock makes separate callers respect one queue. */
  async dispatch(runner: ShortRunner): Promise<void> {
    const lock = join(this.home, 'dispatch.lock');
    try {
      claimDriver(lock);
    } catch (error) {
      if (existsSync(lock)) return;
      throw error;
    }
    try {
      while (true) {
        const tasks = this.list(),
          occupied = tasks.filter((t) => t.status === 'running' || t.status === 'unknown');
        const task = tasks.find(
          (t) =>
            t.status === 'queued' &&
            occupied.length < this.limits.fleet &&
            occupied.filter((o) => o.parent.id === t.parent.id).length < this.limits.parent,
        );
        if (!task) return;
        task.status = 'running';
        task.runner = runner.name;
        save(this.path(task.id), task);
        try {
          const result = await runner.run(task);
          if (!result.evidence) throw new Error('Expected verified terminal receipt');
          Object.assign(task, result);
        } catch (error) {
          task.status = 'unknown';
          task.error = error instanceof Error ? error.message : String(error);
        }
        const latest = this.get(task.id);
        if (latest.cancellation?.outcome === 'confirmed') {
          task.status = latest.status;
          task.evidence = latest.evidence;
          task.result = latest.result;
        }
        task.wait = latest.wait;
        task.cancellation = latest.cancellation;
        save(this.path(task.id), task);
      }
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
  /** Wait observes durable execution; dispatch is owned by the parent driver. */
  async wait(id: string, timeoutMs?: number): Promise<ShortTask> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0))
      throw new Error('Expected nonnegative timeout');
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    while (true) {
      const task = this.get(id);
      if (['succeeded', 'failed', 'unknown'].includes(task.status)) return task;
      if (Date.now() >= deadline) {
        task.wait = { timedOut: true, at: new Date().toISOString() };
        save(this.path(id), task);
        return task;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** Cancellation requests never imply execution stopped; only a receipt releases capacity. */
  async cancel(id: string, runner: ShortRunner): Promise<ShortTask> {
    let task = this.get(id);
    if (!['running', 'unknown'].includes(task.status))
      throw new Error('Expected occupied execution');
    task.cancellation = { requested: new Date().toISOString(), outcome: 'failed' };
    save(this.path(id), task);
    try {
      if (!runner.cancellation || !runner.cancel) {
        task = this.get(id);
        task.cancellation = { ...task.cancellation!, outcome: 'unsupported' };
      } else {
        const receipt = await runner.cancel(task);
        if (!receipt.evidence) throw new Error('Expected verified termination receipt');
        task = this.get(id);
        task.cancellation = {
          requested: task.cancellation!.requested,
          outcome: 'confirmed',
          evidence: receipt.evidence,
        };
        if (['running', 'unknown'].includes(task.status)) {
          task.status = 'failed';
          task.error = 'Execution cancelled with verified termination';
          task.evidence = receipt.evidence;
          task.result = '';
        }
      }
    } catch (error) {
      task = this.get(id);
      task.cancellation = { ...task.cancellation!, outcome: 'failed', error: String(error) };
    }
    save(this.path(id), task);
    return task;
  }
  /** Reconcile loss using adapter evidence; missing execution is unknown, never success. */
  async reconcile(id: string, runner: ShortRunner): Promise<ShortTask> {
    let task = this.get(id);
    if (!['running', 'unknown'].includes(task.status)) return task;
    try {
      const observed = runner.observe ? await runner.observe(task) : { status: 'unknown' as const };
      if (['failed', 'succeeded'].includes(observed.status) && !observed.evidence)
        throw new Error('Expected termination evidence');
      task = this.get(id);
      if (!['running', 'unknown'].includes(task.status)) return task;
      Object.assign(task, observed);
    } catch (error) {
      task.status = 'unknown';
      task.error = String(error);
    }
    save(this.path(id), task);
    return task;
  }
  /** Collect once or repeatedly without repeating execution. */
  collect(id: string): ShortTask {
    const task = this.get(id);
    if (!['succeeded', 'failed'].includes(task.status) || !task.evidence)
      throw new Error('Expected verified terminal result before collection');
    task.collected = true;
    save(this.path(id), task);
    return task;
  }
  /** Remove scratch only after result collection; the durable outcome remains queryable. */
  cleanup(id: string): void {
    const task = this.get(id);
    if (!task.collected) throw new Error('Collect persisted result before cleanup');
    rmSync(task.directory, { recursive: true, force: true });
  }
  /** Request durable Worker ownership through Orchestrator, without launching another lifecycle. */
  handoff(id: string, issue: number): ShortTask['handoff'] {
    if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('Expected Worker Issue number');
    const task = this.get(id);
    task.handoff = { issue, status: 'requested' };
    save(this.path(id), task);
    return task.handoff;
  }
}
/** Direct Codex process with explicit sandbox permissions; never creates tmux. */
export class CodexShortRunner implements ShortRunner {
  readonly name = 'codex-short';
  readonly cancellation = false;
  /** Reconcile only an attributed durable exit/result receipt. */
  async observe(
    task: ShortTask,
  ): Promise<{ status: 'unknown' | 'succeeded' | 'failed'; evidence?: string; result?: string }> {
    const file = join(task.directory, 'outcome.json');
    if (!existsSync(file)) return { status: 'unknown' };
    const outcome = JSON.parse(readFileSync(file, 'utf8'));
    if (
      outcome.attempt !== task.attempt ||
      !['succeeded', 'failed'].includes(outcome.status) ||
      !outcome.evidence ||
      typeof outcome.result !== 'string'
    )
      throw new Error('Expected attributed terminal short-task receipt');
    return { status: outcome.status, evidence: outcome.evidence, result: outcome.result };
  }
  /** Completion requires process exit, completed-turn event and attributed result. */
  async run(
    task: ShortTask,
  ): Promise<{ status: 'succeeded' | 'failed'; result: string; evidence: string }> {
    const output = join(task.directory, 'result.md');
    const args = [
      'exec',
      '--json',
      '--sandbox',
      task.mode === 'read' ? 'read-only' : 'workspace-write',
      '--output-last-message',
      output,
      '-',
    ];
    const brief = `Read AGENTS.md and applicable directory instructions first. Parent ${task.parent.id} retains checkout ownership. Permission: ${task.mode}. Allocated files: ${task.files.join(', ')}. Coordinate conflicts and stay within this allocation.\n${task.brief}`;
    return new Promise((resolve, reject) => {
      const child = spawn('codex', args, { cwd: task.checkout, stdio: ['pipe', 'pipe', 'pipe'] });
      let events = '',
        errors = '';
      child.stdout.on('data', (chunk) => {
        events += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        errors += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        writeFileSync(join(task.directory, 'events.jsonl'), events);
        writeFileSync(join(task.directory, 'stderr.log'), errors);
        const completed = events.split('\n').some((line) => {
          try {
            return JSON.parse(line).type === 'turn.completed';
          } catch {
            return false;
          }
        });
        if (code === null || (code === 0 && (!completed || !existsSync(output)))) {
          reject(new Error('Expected completed-turn receipt'));
          return;
        }
        const outcome = {
          status: code === 0 ? 'succeeded' : 'failed',
          result: existsSync(output) ? readFileSync(output, 'utf8') : errors,
          evidence: JSON.stringify({ attempt: task.attempt, exit: code, completed }),
        } as const;
        save(join(task.directory, 'outcome.json'), { ...outcome, attempt: task.attempt });
        resolve(outcome);
      });
      child.stdin.end(brief);
    });
  }
}
