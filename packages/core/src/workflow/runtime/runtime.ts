import { assertWorkflowRole, type WorkflowRole } from './workflow-role.js';
import { ClaudeInteractive } from './claude-interactive.js';
import { AgyInteractive } from './agy-interactive.js';
/** Managed role startup and durable runner evidence, independent of the model host. */
import { InteractiveCodexRunner } from './codex-interactive.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDirectory } from '../handoff.js';
import {
  verifyRoleInitialization,
  initializationInstructions,
  type RoleInitialization,
} from '../run/role-initialization.js';
import type { FleetConfig } from '../fleet/fleet-config.js';

/** One execution attempt; unknown retains occupancy until independently verified. */
export interface ManagedAttempt {
  id: string;
  fleet: string;
  /** Run ownership recorded at intake. */
  run?: string;
  role: WorkflowRole;
  runner: string;
  /** Previous process identity when this attempt replaces a terminated execution. */
  dispatchId?: string;
  /** The adapter supports correlated results from a process that remains alive. */
  persistent?: boolean;
  initialization?: RoleInitialization;
  predecessor?: string;
  observation?: ExecutionObservation;
  brief: string;
  status: 'starting' | 'running' | 'unknown';
  created: string;
  directory: string;
  checkout: string;
  /** Existing fleet session required for specialist windows. */
  terminalSession?: string;
  /** Explicit local writing roots passed to capable runners. */
  writableDirectories?: string[];
  conversation?: string;
  address?: string;
  windowId?: string;
  paneId?: string;
  evidence?: string;
  error?: string;
  /** Resolved startup failures remain visible after exact-identity recovery. */
  startupFailures?: { error: string; resolvedAt: string }[];
}
/** Adapter owns capability checks and evidence; a terminal alone is insufficient. */
export interface RunnerAdapter {
  name: string;
  /** True only after the complete persistent interactive lifecycle is verified. */
  interactive?: boolean;
  /** Correlated input into the existing process; uncertainty forbids automatic replay. */
  send?(
    attempt: ManagedAttempt,
    message: { id: string; brief: string },
  ): Promise<{
    status: 'delivered' | 'uncertain';
    evidence: string;
  }>;
  /** Durable task output; implementations must not wait for process exit. */
  result?(attempt: ManagedAttempt, dispatchId: string): Promise<string | undefined>;
  /** Observe execution independently of receipt acceptance. */
  observe?(attempt: ManagedAttempt): Promise<ExecutionObservation>;
  stopped?(attempt: ManagedAttempt): Promise<boolean>;
  /** Recover normalized startup evidence from this Runner only. */
  recoverReceipt?(
    attempt: ManagedAttempt,
  ): Promise<{ conversation: string; address: string; evidence: string } | undefined>;
  cancellation?: boolean;
  cancel?(attempt: ManagedAttempt): Promise<{ evidence: string }>;
  preflight(): Promise<void>;
  start(
    attempt: ManagedAttempt,
  ): Promise<{ conversation: string; address: string; evidence: string }>;
}
function home(config: FleetConfig): string {
  return stateDirectory(config, '.runtime', createHash('sha256').update(config.file).digest('hex'));
}
function save(path: string, attempt: ManagedAttempt): void {
  assertWorkflowRole(attempt.role, path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(attempt, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}
/** Read durable occupancy, without treating missing runtime evidence as release. */
export function inspectOrchestrator(config: FleetConfig, run: string): ManagedAttempt | undefined {
  if (!run || !/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('Expected a valid Run id');
  const path = join(home(config), `orchestrator-${run}.json`);
  if (!existsSync(path)) return undefined;
  const attempt = JSON.parse(readFileSync(path, 'utf8')) as ManagedAttempt;
  assertWorkflowRole(attempt.role, path);
  if (attempt.role !== 'orchestrator') throw new Error(`${path}: expected orchestrator role`);
  return attempt;
}
/** Exclusively claim the Run orchestrator, preserving failed/unknown launches for recovery. */
export async function startOrchestrator(
  config: FleetConfig,
  runner: RunnerAdapter,
  brief: string,
  run: string,
  initialization?: Omit<RoleInitialization, 'role' | 'attempt' | 'briefHash'>,
): Promise<ManagedAttempt> {
  if (!run || !/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('Expected a valid Run id');
  if (!brief.trim()) throw new Error('Expected a non-empty Orchestrator brief');
  requireInteractive(runner);
  await runner.preflight();
  mkdirSync(home(config), { recursive: true });
  try {
    mkdirSync(join(home(config), `orchestrator-${run}.lock`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('Orchestrator occupied; inspect persisted attempt before recovery', {
        cause: error,
      });
    throw error;
  }
  const id = run;
  const directory = join(home(config), id);
  mkdirSync(directory);
  const attempt: ManagedAttempt = {
    id,
    run,
    fleet: createHash('sha256').update(config.file).digest('hex'),
    role: 'orchestrator',
    runner: runner.name,
    persistent: !!runner.result,
    brief,
    status: 'starting',
    created: new Date().toISOString(),
    directory,
    checkout: config.project,
  };
  if (!run || !/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('Expected a valid Run id');
  const path = join(home(config), `orchestrator-${run}.json`);
  if (runner.result) {
    if (!initialization)
      throw new Error('Persistent Orchestrator requires Run-derived initialization context');
    attempt.initialization = {
      ...initialization,
      role: attempt.role,
      attempt: attempt.id,
      briefHash: createHash('sha256').update(brief).digest('hex'),
    };
    attempt.brief += initializationInstructions(attempt.initialization, directory);
  }
  save(path, attempt);
  writeFileSync(join(directory, 'brief.md'), attempt.brief, { mode: 0o600 });
  try {
    const receipt = await runner.start(attempt);
    if (!receipt.conversation || !receipt.address || !receipt.evidence)
      throw new Error('Expected Runner conversation, runtime address and startup evidence');
    Object.assign(attempt, receipt);
    if (attempt.initialization) verifyRoleInitialization(attempt);
    Object.assign(attempt, receipt, { status: 'running' });
  } catch (error) {
    attempt.status = 'unknown';
    attempt.error = error instanceof Error ? error.message : String(error);
  }
  save(path, attempt);
  save(join(directory, 'attempt.json'), attempt);
  return attempt;
}
/** Escape a shell argument by wrapping it in single quotes. */
export function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
const shell = quote;
/** Codex JSONL is the receipt/result channel; resume supplies subsequent input.
 * The workflow driver polls the durable log to wake and dispatch the next turn.
 */
export class CodexRunner implements RunnerAdapter {
  readonly name: string = 'codex';
  readonly interactive: boolean = false;
  protected command(attempt: ManagedAttempt): string {
    return `codex exec ${[attempt.directory, ...(attempt.writableDirectories ?? [])].map((path) => `--add-dir ${shell(path)}`).join(' ')} ${attempt.conversation ? `resume ${shell(attempt.conversation)} ` : ''} -c sandbox_mode='"workspace-write"' -c approval_policy='"never"' --json --output-last-message ${shell(join(attempt.directory, 'result.md'))} -`;
  }
  protected normalize(event: Record<string, unknown>): Record<string, unknown> {
    return event;
  }
  readonly cancellation: boolean = false;
  /** Verified process exit releases execution capacity, never checkout ownership. */
  async termination(attempt: ManagedAttempt): Promise<boolean> {
    const file = join(attempt.directory, 'exit-code');
    return existsSync(file) && /^-?\d+$/.test(readFileSync(file, 'utf8').trim());
  }
  /** Probe installed CLI capabilities instead of inferring support from its name. */
  async preflight(): Promise<void> {
    execFileSync('tmux', ['-V'], { timeout: 5000 });
    const help = execFileSync('codex', ['exec', '--help'], { encoding: 'utf8', timeout: 5000 });
    const resume = execFileSync('codex', ['exec', 'resume', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (
      !help.includes('--add-dir') ||
      !help.includes('--json') ||
      !help.includes('--output-last-message') ||
      !resume.includes('--json')
    )
      throw new Error(
        'Codex must support JSON event/result output and resume input for automatic round trips',
      );
  }
  /** Exit receipt plus absent or dead panes verifies this managed process stopped. */
  async stopped(attempt: ManagedAttempt): Promise<boolean> {
    const terminal = join(attempt.directory, 'terminal.json');
    const address: string | undefined =
      attempt.address ??
      (existsSync(terminal) ? JSON.parse(readFileSync(terminal, 'utf8')).address : undefined);
    if (!existsSync(join(attempt.directory, 'exit-code')) || !address?.startsWith('tmux:'))
      return false;
    try {
      const panes = execFileSync(
        'tmux',
        ['list-panes', '-t', address.slice(5), '-F', '#{pane_dead}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      return !!panes && panes.split('\n').every((value) => value === '1');
    } catch {
      return true;
    }
  }
  /** Collect a completed turn from durable Runner output, never from pane disappearance. */
  /** Recovery never blocks on an execution whose exit is not yet observed. */
  /** Read this adapter's durable startup protocol after a lost notification. */
  async recoverReceipt(attempt: ManagedAttempt) {
    const events = join(attempt.directory, 'events.jsonl');
    if (!existsSync(events)) return undefined;
    const lines = readFileSync(events, 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          return [this.normalize(JSON.parse(line))];
        } catch {
          return [];
        }
      });
    const thread = lines.find((e) => e.type === 'thread.started' && e.thread_id);
    if (!thread || !lines.some((e) => e.type === 'turn.started')) return undefined;
    const terminal = join(attempt.directory, 'terminal.json');
    return {
      conversation: thread.thread_id as string,
      address:
        attempt.address ??
        (existsSync(terminal)
          ? JSON.parse(readFileSync(terminal, 'utf8')).address
          : `tmux:pc-${attempt.fleet.slice(0, 12)}-${attempt.id}`),
      evidence: 'Recovered thread.started and turn.started from durable Runner events',
    };
  }
  collectable(attempt: ManagedAttempt): boolean {
    return existsSync(join(attempt.directory, 'exit-code'));
  }
  async collect(attempt: ManagedAttempt): Promise<string> {
    const exit = join(attempt.directory, 'exit-code');
    while (!existsSync(exit)) await new Promise((resolve) => setTimeout(resolve, 100));
    if (readFileSync(exit, 'utf8').trim() !== '0')
      throw new Error(`Runner failed; inspect ${attempt.directory}`);
    const events = readFileSync(join(attempt.directory, 'events.jsonl'), 'utf8');
    if (
      !events.split('\n').some((line) => {
        try {
          return this.normalize(JSON.parse(line)).type === 'turn.completed';
        } catch {
          return false;
        }
      })
    )
      throw new Error('Expected completed turn evidence');
    return readFileSync(join(attempt.directory, 'result.md'), 'utf8');
  }
  /** Start in tmux and wait for the Runner-generated conversation acknowledgement. */
  async start(
    attempt: ManagedAttempt,
  ): Promise<{ conversation: string; address: string; evidence: string }> {
    const specialist = ['pipeline-audit', 'pipeline-refactor', 'research-state'].includes(
      attempt.role,
    );
    if (specialist && !attempt.terminalSession)
      throw new Error('Specialist requires a verified existing tmux session');
    const session = `pc-${attempt.fleet.slice(0, 12)}-${attempt.id}`;
    let address = specialist ? `${attempt.terminalSession}:${session}` : session;
    attempt.address = `tmux:${address}`;
    writeFileSync(
      join(attempt.directory, 'terminal.json'),
      JSON.stringify({ address: attempt.address }),
    );
    const events = join(attempt.directory, 'events.jsonl');
    const script = join(attempt.directory, 'launch.sh');
    writeFileSync(
      script,
      `#!/bin/sh\n${attempt.role === 'orchestrator' ? `tmux set-option -w -t ${shell(session + ':0')} remain-on-exit on\n` : ''}${this.command(attempt)} < ${shell(join(attempt.directory, 'brief.md'))} > ${shell(events)} 2> ${shell(join(attempt.directory, 'stderr.log'))}\nprintf '%s' "$?" > ${shell(join(attempt.directory, 'exit-code'))}\n`,
      { mode: 0o700 },
    );
    if (specialist) execFileSync('tmux', ['has-session', '-t', attempt.terminalSession!]);
    const terminal = execFileSync(
      'tmux',
      specialist
        ? [
            'new-window',
            '-P',
            '-F',
            '#{window_id} #{pane_id}',
            '-d',
            '-t',
            attempt.terminalSession + ':',
            '-n',
            session,
            '-c',
            attempt.checkout,
            'sh',
            script,
          ]
        : [
            'new-session',
            '-P',
            '-F',
            '#{window_id} #{pane_id}',
            '-d',
            '-s',
            session,
            '-c',
            attempt.checkout,
            'sh',
            script,
          ],
      { timeout: 5000, encoding: 'utf8' },
    );
    {
      const [windowId, paneId] = terminal.trim().split(/\s+/);
      if (!/^@\d+$/.test(windowId ?? '') || !/^%\d+$/.test(paneId ?? ''))
        throw new Error('Expected actual tmux window and pane identities');
      address = `${specialist ? attempt.terminalSession : session}:${windowId}`;
      Object.assign(attempt, { windowId, paneId, address: `tmux:${address}` });
      writeFileSync(
        join(attempt.directory, 'terminal.json'),
        JSON.stringify({ address: attempt.address, windowId, paneId }),
      );
    }
    const deadline = Date.now() + 15000;
    let conversation: string | undefined;
    let receipt: string | undefined;
    while (Date.now() < deadline) {
      if (existsSync(events)) {
        for (const line of readFileSync(events, 'utf8').split('\n')) {
          try {
            const event = this.normalize(JSON.parse(line)) as { type: string; thread_id?: string };
            if (event.type === 'thread.started' && event.thread_id) {
              conversation = event.thread_id;
              receipt = line;
            }
            if (event.type === 'turn.started' && conversation && receipt)
              return { conversation, address: `tmux:${address}`, evidence: receipt + '\n' + line };
          } catch {
            /* Incomplete final JSONL line is retried. */
          }
        }
      }
      if (existsSync(join(attempt.directory, 'exit-code')))
        throw new Error(`Runner exited without acknowledgement; inspect ${attempt.directory}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `No Runner acknowledgement within 15s; preserve occupancy and inspect ${attempt.directory}`,
    );
  }
}

/** Stream-JSON providers share terminal identity/exit verification with Codex. */
abstract class StreamRunner extends CodexRunner {
  protected abstract resumeFlag: string;
  async preflight(): Promise<void> {
    execFileSync('tmux', ['-V'], { timeout: 5000 });
    const help = execFileSync(this.name, ['--help'], { encoding: 'utf8', timeout: 5000 });
    for (const flag of ['--print', '--output-format', '--add-dir', this.resumeFlag]) {
      if (!help.includes(flag)) throw new Error(`${this.name} lacks managed capability ${flag}`);
    }
  }
  protected command(attempt: ManagedAttempt): string {
    return `${this.name} --print --output-format stream-json ${this.name === 'claude' ? '--verbose' : ''} ${[attempt.directory, ...(attempt.writableDirectories ?? [])].map((path) => `--add-dir ${shell(path)}`).join(' ')} ${attempt.conversation ? `${this.resumeFlag} ${shell(attempt.conversation)}` : ''}`;
  }
  protected normalize(event: Record<string, unknown>): Record<string, unknown> {
    if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string')
      return { type: 'thread.started', thread_id: event.session_id };
    if (event.type === 'assistant') return { type: 'turn.started' };
    if (
      event.type === 'result' &&
      !event.is_error &&
      (event.subtype === 'success' || event.subtype === undefined)
    )
      return { type: 'turn.completed' };
    return event;
  }
  async collect(attempt: ManagedAttempt): Promise<string> {
    const exit = join(attempt.directory, 'exit-code');
    while (!existsSync(exit)) await new Promise((resolve) => setTimeout(resolve, 100));
    if (readFileSync(exit, 'utf8').trim() !== '0')
      throw new Error(`${this.name} failed; inspect ${attempt.directory}`);
    const results = readFileSync(join(attempt.directory, 'events.jsonl'), 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const result = results.findLast((event) => this.normalize(event).type === 'turn.completed');
    if (!result || typeof result.result !== 'string')
      throw new Error(`${this.name} lacks completed result evidence`);
    return result.result;
  }
}
/** Explicit Claude Code stream protocol adapter. */
export class ClaudeRunner extends StreamRunner {
  readonly name = 'claude';
  readonly cancellation = true;
  readonly interactive: boolean = true;
  protected resumeFlag = '--resume';
  private readonly tui = new ClaudeInteractive();
  preflight() {
    return this.tui.preflight();
  }
  start(a: ManagedAttempt) {
    return this.tui.start(a);
  }
  recoverReceipt(a: ManagedAttempt) {
    return this.tui.recoverReceipt(a);
  }
  stopped(a: ManagedAttempt) {
    return this.tui.terminated(a);
  }
  termination(a: ManagedAttempt) {
    return this.tui.terminated(a);
  }
  cancel(a: ManagedAttempt) {
    return this.tui.cancel(a);
  }
  send(a: ManagedAttempt, m: { id: string; brief: string }) {
    return this.tui.send(a, m);
  }
  result(a: ManagedAttempt, id: string) {
    return this.tui.result(a, id);
  }
  observe(a: ManagedAttempt) {
    return this.tui.observe(a);
  }
  /** Persistent completion uses correlated native turn output, never process exit. */
  async collect(a: ManagedAttempt): Promise<string> {
    for (;;) {
      const output = await this.tui.result(a, a.dispatchId ?? a.id);
      if (output !== undefined) return output;
      if (await this.stopped(a)) throw new Error('Claude exited without a correlated task result');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  collectable(a: ManagedAttempt): boolean {
    return existsSync(join(a.directory, 'claude-hooks'));
  }
}
/** Managed agy persistent TUI adapter backed by native hook transcripts. */
export class AgyRunner implements RunnerAdapter {
  readonly name = 'agy';
  readonly cancellation = true;
  readonly interactive = true;
  private readonly tui = new AgyInteractive();
  preflight() {
    return this.tui.preflight();
  }
  start(a: ManagedAttempt) {
    return this.tui.start(a);
  }
  recoverReceipt(a: ManagedAttempt) {
    return this.tui.recoverReceipt(a);
  }
  stopped(a: ManagedAttempt) {
    return this.tui.stopped(a);
  }
  termination(a: ManagedAttempt) {
    return this.tui.terminated(a);
  }
  cancel(a: ManagedAttempt) {
    return this.tui.cancel(a);
  }
  send(a: ManagedAttempt, m: { id: string; brief: string }) {
    return this.tui.send(a, m);
  }
  result(a: ManagedAttempt, id: string) {
    return this.tui.result(a, id);
  }
  observe(a: ManagedAttempt) {
    return this.tui.observe(a);
  }
  /** Persistent completion uses correlated native turn output, never process exit. */
  async collect(a: ManagedAttempt): Promise<string> {
    for (;;) {
      const output = await this.tui.result(a, a.dispatchId ?? a.id);
      if (output !== undefined) return output;
      if (await this.stopped(a)) throw new Error('agy exited without a correlated task result');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  collectable(a: ManagedAttempt): boolean {
    return existsSync(join(a.directory, 'agy-native.json'));
  }
}
/** Resolve a supported provider without fallback. */
export function managedRunner(provider: string): RunnerAdapter & {
  stopped(attempt: ManagedAttempt): Promise<boolean>;
  collect(attempt: ManagedAttempt): Promise<string>;
  collectable(attempt: ManagedAttempt): boolean;
} {
  switch (provider) {
    case 'codex':
      return new InteractiveCodexRunner();
    case 'agy':
      return new AgyRunner();
    case 'claude':
      return new ClaudeRunner();
    default:
      throw new Error(`Unsupported managed provider ${provider}`);
  }
}

/** Control observations do not overwrite the persisted execution identity or ownership. */
export interface AttemptControl {
  execution?: { status: 'running' | 'unknown' | 'terminated'; evidence?: string };
  wait?: { timedOut: boolean; at: string };
  cancellation?: {
    requested: string;
    outcome: 'unsupported' | 'failed' | 'confirmed';
    evidence?: string;
    error?: string;
  };
}
/** Read durable wait/cancellation observations, independently of execution status. */
export function inspectAttemptControl(attempt: ManagedAttempt): AttemptControl {
  const file = join(attempt.directory, 'control.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}
/** A bounded wait leaves the original collection running and permits later collection. */
export async function waitAttempt(
  attempt: ManagedAttempt,
  runner: { collect(attempt: ManagedAttempt): Promise<string> },
  timeoutMs: number,
): Promise<{ timedOut: boolean; result?: string }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Expected nonnegative timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runner.collect(attempt).then((result) => ({ timedOut: false, result })),
      new Promise<{ timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
    const control = inspectAttemptControl(attempt);
    control.wait = { timedOut: result.timedOut, at: new Date().toISOString() };
    writeFileSync(join(attempt.directory, 'control.json'), JSON.stringify(control));
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Cancellation is unsupported unless the adapter explicitly supplies a terminal receipt. */
export async function cancelAttempt(
  attempt: ManagedAttempt,
  runner: {
    cancellation?: boolean;
    cancel?(attempt: ManagedAttempt): Promise<{ evidence: string }>;
  },
): Promise<AttemptControl> {
  const control = inspectAttemptControl(attempt);
  control.cancellation = { requested: new Date().toISOString(), outcome: 'failed' };
  const file = join(attempt.directory, 'control.json');
  writeFileSync(file, JSON.stringify(control));
  try {
    if (!runner.cancellation || !runner.cancel) control.cancellation.outcome = 'unsupported';
    else {
      const receipt = await runner.cancel(attempt);
      if (!receipt.evidence) throw new Error('Expected verified termination receipt');
      Object.assign(control.cancellation, { outcome: 'confirmed', evidence: receipt.evidence });
      control.execution = { status: 'terminated', evidence: receipt.evidence };
    }
  } catch (error) {
    control.cancellation.error = String(error);
  }
  writeFileSync(file, JSON.stringify(control));
  return control;
}

/** Reconcile execution without changing logical role or checkout ownership. */
export async function reconcileAttempt(
  attempt: ManagedAttempt,
  runner: { termination?(attempt: ManagedAttempt): Promise<boolean> },
): Promise<AttemptControl> {
  const control = inspectAttemptControl(attempt);
  if (control.execution?.status === 'terminated') return control;
  const terminated = runner.termination ? await runner.termination(attempt) : false;
  control.execution = terminated
    ? { status: 'terminated', evidence: 'Adapter verified execution exit' }
    : { status: 'unknown' };
  writeFileSync(join(attempt.directory, 'control.json'), JSON.stringify(control));
  return control;
}

/** A timestamped execution observation never grants task acceptance or ownership. */
export interface ExecutionObservation {
  status: 'running' | 'idle' | 'waiting' | 'error' | 'exited' | 'unknown';
  at: string;
  evidence: string;
}
/** Named roles require persistent interactive execution; adapters must explicitly opt in. */
export function requireInteractive(runner: RunnerAdapter): void {
  if (runner.interactive !== true)
    throw new Error(`${runner.name} lacks verified persistent interactive lifecycle support`);
}
