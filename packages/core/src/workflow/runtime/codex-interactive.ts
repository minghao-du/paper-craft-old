import {
  refreshStartupAttempt,
  roleInitializationReady,
  initializationInstructions,
} from '../run/role-initialization.js';
/** Persistent Codex TUI adapter backed by native, correlated rollout evidence. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  quote,
  type ManagedAttempt,
  type ExecutionObservation,
  type RunnerAdapter,
} from './runtime.js';

interface NativeEvent {
  type: string;
  payload: {
    id?: string;
    cwd?: string;
    originator?: string;
    type?: string;
    thread_id?: string;
    turn_id?: string;
    last_agent_message?: string;
    item?: { type: string; content?: { text?: string }[] };
  };
}
const marker = (a: ManagedAttempt, id = 'initial') =>
  `[pc attempt=${a.id} dispatch=${a.dispatchId ?? a.id} message=${id}]`;
function events(path: string): NativeEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as NativeEvent];
      } catch {
        return [];
      }
    });
}
function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(directory, e.name))
      : e.name.endsWith('.jsonl')
        ? [join(directory, e.name)]
        : [],
  );
}
/** Native rollout identity and turn attribution are required; panes alone never acknowledge work. */
export class InteractiveCodexRunner implements RunnerAdapter {
  readonly name = 'codex';
  readonly interactive = true;
  readonly automaticStartup = true;
  async termination(attempt: ManagedAttempt) {
    return this.stopped(attempt);
  }
  collectable(attempt: ManagedAttempt) {
    return existsSync(join(attempt.directory, 'exit-code'));
  }
  async collect(
    attempt: ManagedAttempt,
    options?: { timeoutMs?: number; dispatchId?: string },
  ): Promise<string> {
    const id = options?.dispatchId ?? attempt.dispatchId ?? attempt.id;
    const deadline = options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
    for (;;) {
      const result = await this.result(attempt, id);
      if (result !== undefined) return result;
      if (await this.stopped(attempt))
        throw new Error('Codex exited without a correlated task result');
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error('Timed out waiting for correlated task result');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  private pane(attempt: ManagedAttempt): 'live' | 'dead' | 'absent' | 'unknown' {
    if (!attempt.address?.match(/^tmux:%[0-9]+$/)) return 'unknown';
    try {
      const inventory = execFileSync(
        'tmux',
        ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const row = inventory
        .split('\n')
        .find((line) => line.split(' ')[0] === attempt.address!.slice(5));
      return row
        ? row.split(' ')[1] === '0'
          ? 'live'
          : row.split(' ')[1] === '1'
            ? 'dead'
            : 'unknown'
        : 'absent';
    } catch {
      return 'unknown';
    }
  }
  async stopped(attempt: ManagedAttempt): Promise<boolean> {
    if (!existsSync(join(attempt.directory, 'exit-code'))) return false;
    return ['dead', 'absent'].includes(this.pane(attempt));
  }
  readonly cancellation = true;
  async preflight(): Promise<void> {
    execFileSync('tmux', ['-V'], { timeout: 5000 });
    for (const [args, required] of [
      [['--help'], ['--no-alt-screen', '--add-dir', '[PROMPT]']],
      [
        ['queue', '--help'],
        ['--thread', '--message'],
      ],
      [['resume', '--help'], ['SESSION_ID']],
    ] as const) {
      const help = execFileSync('codex', [...args], { encoding: 'utf8', timeout: 5000 });
      if (required.some((flag) => !help.includes(flag)))
        throw new Error(
          'Installed Codex lacks persistent prompt, queue or exact resume capabilities',
        );
    }
    let auth: string;
    try {
      auth = execFileSync('codex', ['login', 'status'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(
        `Codex authentication check failed: ${error instanceof Error ? error.message : String(error)}: run codex login`,
        { cause: error },
      );
    }
    if (!auth.trim() || /not logged in/i.test(auth)) {
      throw new Error('Codex authentication required: run codex login');
    }
  }
  private native(attempt: ManagedAttempt): { path: string; data: NativeEvent[] } | undefined {
    const state = join(attempt.directory, 'codex-native.json');
    if (existsSync(state)) {
      const { path } = JSON.parse(readFileSync(state, 'utf8')) as { path: string };
      const data = events(path);
      if (data[0]?.payload.id === attempt.conversation || !attempt.conversation)
        return { path, data };
      return undefined;
    }
    const candidates = files(
      join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
    ).filter((p) => {
      if (!attempt.conversation && Date.parse(attempt.created) > statSync(p).mtimeMs) return false;
      const data = events(p);
      return (
        data[0]?.payload.cwd === attempt.checkout &&
        (attempt.conversation
          ? data[0]?.payload.id === attempt.conversation
          : data.some(
              (e) =>
                e.payload.item?.type === 'UserMessage' &&
                e.payload.item.content?.some((c) => c.text?.startsWith(marker(attempt))),
            ))
      );
    });
    if (candidates.length !== 1) return undefined;
    writeFileSync(state, JSON.stringify({ path: candidates[0] }), { mode: 0o600 });
    return { path: candidates[0], data: events(candidates[0]) };
  }
  async recoverReceipt(attempt: ManagedAttempt) {
    const native = this.native(attempt);
    const conversation = native?.data[0]?.payload.id;
    if (!conversation || !native) return undefined;
    const address =
      attempt.address ??
      (existsSync(join(attempt.directory, 'terminal.json'))
        ? (JSON.parse(readFileSync(join(attempt.directory, 'terminal.json'), 'utf8'))
            .address as string)
        : undefined);
    if (!address || this.pane({ ...attempt, address }) !== 'live') return undefined;
    const turns = new Set(
      native.data
        .filter(
          (e) =>
            e.payload.item?.type === 'UserMessage' &&
            e.payload.item.content?.some((c) => c.text?.startsWith(marker(attempt))),
        )
        .map((e) => e.payload.turn_id),
    );
    const ready = `[pc ready role=${attempt.role} attempt=${attempt.id}]`;
    if (
      !native.data.some(
        (e) =>
          e.payload.item?.type === 'AgentMessage' &&
          turns.has(e.payload.turn_id) &&
          (!attempt.startupGate ||
            native.data.some(
              (done) =>
                done.payload.type === 'task_complete' && done.payload.turn_id === e.payload.turn_id,
            )) &&
          e.payload.item.content?.some((c) => c.text?.includes(ready)),
      )
    )
      return undefined;
    return {
      conversation,
      address,
      evidence: `Native Codex UserMessage acknowledgement: ${native.path}`,
    };
  }
  async start(attempt: ManagedAttempt) {
    // The new attempt receives reconciliation instructions, never a replay of its predecessor brief.
    if (!existsSync(join(attempt.directory, 'brief.md')))
      writeFileSync(join(attempt.directory, 'brief.md'), attempt.brief, {
        mode: 0o400,
        flag: 'wx',
      });
    const args = attempt.conversation ? ['resume', attempt.conversation] : [];
    args.push(
      '--cd',
      attempt.checkout,
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--no-alt-screen',
      '--add-dir',
      attempt.directory,
    );
    for (const path of attempt.writableDirectories ?? []) args.push('--add-dir', path);
    const instruction = attempt.conversation
      ? `Recover role ${attempt.role} for Run ${attempt.run ?? attempt.id}, Dispatch ${attempt.dispatchId ?? attempt.id}. This is a new authorized execution attempt. Reconcile durable brief and receipts in ${attempt.directory} and checkout ${attempt.checkout}; accepted work must not repeat. Inspect predecessor evidence and the original immutable brief before continuing only incomplete assigned work. If ownership or results are uncertain, report that uncertainty instead of executing.`
      : attempt.brief;
    const roleInstructions =
      attempt.initialization && !instruction.includes('Role initialization gate:')
        ? initializationInstructions(attempt.initialization, attempt.directory)
        : '';
    args.push(
      `${marker(attempt)}\nInitialize the ${attempt.role} role using applicable project/role instructions and durable workflow state. After initialization, first emit a commentary acknowledgement exactly [pc ready role=${attempt.role} attempt=${attempt.id}], ${attempt.startupGate ? 'then end this turn immediately and await a separate activation message. Do not poll for activation in this turn.' : 'then execute the assigned work.'}\n${instruction}${roleInstructions}`,
    );
    const command = ['codex', ...args].map(quote).join(' ');
    const script = join(attempt.directory, 'codex-tui.sh');
    writeFileSync(
      script,
      `#!/bin/sh\n${command}\ncode=$?\nprintf '%s' "$code" > ${quote(join(attempt.directory, 'exit-code'))}\nexit "$code"\n`,
      { mode: 0o700 },
    );
    const name = `pc-codex-${attempt.id}`;
    const output = execFileSync(
      'tmux',
      attempt.terminalSession
        ? ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', attempt.terminalSession, script]
        : ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', name, script],
      { encoding: 'utf8' },
    ).trim();
    attempt.providerState = { ...(attempt.providerState ?? {}), paneId: output };
    attempt.address = `tmux:${output}`;
    writeFileSync(
      join(attempt.directory, 'terminal.json'),
      JSON.stringify({ address: attempt.address, paneId: output }),
      { mode: 0o600 },
    );
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const ack = await this.recoverReceipt(attempt);
      if (ack && roleInitializationReady(attempt)) return ack;
      if (await this.stopped(attempt))
        throw new Error(
          'Codex exited before native acknowledgement; inspect terminal and authentication/configuration',
        );
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(
      `Codex startup not acknowledged; inspect ${attempt.address} for authentication, configuration, trust or authorization waiting. Preserve identity; do not replay brief.`,
    );
  }
  async send(attempt: ManagedAttempt, message: { id: string; brief: string }) {
    if (!attempt.conversation) throw new Error('Exact Codex conversation required');
    try {
      const evidence = execFileSync(
        'codex',
        [
          'queue',
          '--thread',
          attempt.conversation,
          '--message',
          `${marker(attempt, message.id)}\n${message.brief}`,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      return { status: 'delivered' as const, evidence };
    } catch (error) {
      return { status: 'uncertain' as const, evidence: String(error) };
    }
  }
  async messageReceipt(attempt: ManagedAttempt, message: { id: string; brief: string }) {
    const exact = `${marker(attempt, message.id)}\n${message.brief}`;
    return this.native(attempt)?.data.some(
      (e) =>
        e.payload.item?.type === 'UserMessage' &&
        e.payload.item.content?.some((c) => c.text === exact),
    )
      ? 'Native exact Codex activation input'
      : undefined;
  }
  async result(attempt: ManagedAttempt, dispatchId: string): Promise<string | undefined> {
    refreshStartupAttempt(attempt);
    if (
      dispatchId !== (attempt.dispatchId ?? attempt.id) ||
      (attempt.startupGate && !attempt.activation)
    )
      return undefined;
    const data = this.native(attempt)?.data ?? [];
    const matchingTurns = data
      .filter(
        (e) =>
          e.payload.thread_id === attempt.conversation &&
          e.payload.item?.type === 'UserMessage' &&
          e.payload.item.content?.some(
            (c) =>
              c.text?.startsWith(`[pc attempt=${attempt.id} dispatch=${dispatchId} message=`) &&
              (!attempt.startupGate || !c.text.startsWith(marker(attempt))),
          ),
      )
      .map((e) => e.payload.turn_id)
      .filter((id): id is string => Boolean(id));
    if (matchingTurns.length === 0) return undefined;
    const lastTurnId = matchingTurns.at(-1)!;
    const complete = data.findLast(
      (e) => e.payload.type === 'task_complete' && e.payload.turn_id === lastTurnId,
    );
    return complete?.payload.last_agent_message;
  }
  async observe(attempt: ManagedAttempt): Promise<ExecutionObservation> {
    if (await this.stopped(attempt))
      return {
        status: 'exited',
        at: new Date().toISOString(),
        evidence: 'Verified Codex wrapper exit and terminal termination',
      };
    const result = await this.result(attempt, attempt.dispatchId ?? attempt.id);
    return {
      status: result === undefined ? 'unknown' : 'idle',
      at: new Date().toISOString(),
      evidence:
        result === undefined
          ? 'No uniquely correlated completed native turn'
          : 'Correlated native task_complete; acceptance remains separate',
    };
  }
  async cancel(attempt: ManagedAttempt) {
    if (!attempt.address?.startsWith('tmux:'))
      throw new Error('Exact Codex terminal address required');
    const pane = attempt.address.slice(5);
    execFileSync('tmux', ['send-keys', '-t', pane, 'C-c']);
    let nextInterrupt = Date.now() + 1000;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await this.stopped(attempt))
        return { evidence: 'Codex exited and terminal termination verified' };
      if (Date.now() >= nextInterrupt && this.pane(attempt) === 'live') {
        execFileSync('tmux', ['send-keys', '-t', pane, 'C-c']);
        nextInterrupt = Date.now() + 1000;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Codex termination unknown; retain checkout ownership');
  }
}

/**
 * Temporary legacy internal contract retained for migration slices (#146-#150).
 * Removed in ticket #150.
 */
export class CodexRunner implements RunnerAdapter {
  readonly name: string = 'codex';
  readonly interactive: boolean = false;
  protected command(attempt: ManagedAttempt): string {
    return `codex exec ${[attempt.directory, ...(attempt.writableDirectories ?? [])].map((path) => `--add-dir ${quote(path)}`).join(' ')} ${attempt.conversation ? `resume ${quote(attempt.conversation)} ` : ''} -c sandbox_mode='"workspace-write"' -c approval_policy='"never"' --json --output-last-message ${quote(join(attempt.directory, 'result.md'))} -`;
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
      `#!/bin/sh\n${attempt.role === 'orchestrator' ? `tmux set-option -w -t ${quote(session + ':0')} remain-on-exit on\n` : ''}${this.command(attempt)} < ${quote(join(attempt.directory, 'brief.md'))} > ${quote(events)} 2> ${quote(join(attempt.directory, 'stderr.log'))}\nprintf '%s' "$?" > ${quote(join(attempt.directory, 'exit-code'))}\n`,
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
      attempt.providerState = { ...(attempt.providerState ?? {}), windowId, paneId };
      Object.assign(attempt, { address: `tmux:${address}` });
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

/**
 * Temporary legacy internal contract retained for migration slices (#146-#150).
 * Removed in ticket #150.
 */
export abstract class StreamRunner extends CodexRunner {
  protected abstract resumeFlag: string;
  async preflight(): Promise<void> {
    execFileSync('tmux', ['-V'], { timeout: 5000 });
    const help = execFileSync(this.name, ['--help'], { encoding: 'utf8', timeout: 5000 });
    for (const flag of ['--print', '--output-format', '--add-dir', this.resumeFlag]) {
      if (!help.includes(flag)) throw new Error(`${this.name} lacks managed capability ${flag}`);
    }
  }
  protected command(attempt: ManagedAttempt): string {
    return `${this.name} --print --output-format stream-json ${this.name === 'claude' ? '--verbose' : ''} ${[attempt.directory, ...(attempt.writableDirectories ?? [])].map((path) => `--add-dir ${quote(path)}`).join(' ')} ${attempt.conversation ? `${this.resumeFlag} ${quote(attempt.conversation)}` : ''}`;
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

