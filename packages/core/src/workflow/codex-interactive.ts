import { roleInitializationReady, initializationInstructions } from './role-initialization.js';
/** Persistent Codex TUI adapter backed by native, correlated rollout evidence. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ManagedAttempt, ExecutionObservation, RunnerAdapter } from './runtime.js';

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
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
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
  // Native transport is verified; role-specific startup facts still lack a shared contract.
  readonly interactive = false;
  async termination(attempt: ManagedAttempt) {
    return this.stopped(attempt);
  }
  collectable(attempt: ManagedAttempt) {
    return existsSync(join(attempt.directory, 'exit-code'));
  }
  async collect(attempt: ManagedAttempt) {
    const result = await this.result(attempt, attempt.dispatchId ?? attempt.id);
    if (result === undefined) throw new Error('Codex has no uniquely correlated completed turn');
    return result;
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
    const auth = execFileSync('codex', ['login', 'status'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    void auth;
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
      attempt.conversation && attempt.initialization
        ? initializationInstructions(attempt.initialization, attempt.directory)
        : '';
    args.push(
      `${marker(attempt)}\nInitialize the ${attempt.role} role using applicable project/role instructions and durable workflow state. After initialization, first emit a commentary acknowledgement exactly [pc ready role=${attempt.role} attempt=${attempt.id}], then execute the assigned work.\n${instruction}${roleInstructions}`,
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
    attempt.paneId = output;
    attempt.address = `tmux:${output}`;
    writeFileSync(
      join(attempt.directory, 'terminal.json'),
      JSON.stringify({ address: attempt.address, paneId: output }),
      { mode: 0o600 },
    );
    const deadline = Date.now() + 20000;
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
  async result(attempt: ManagedAttempt, dispatchId: string): Promise<string | undefined> {
    if (dispatchId !== (attempt.dispatchId ?? attempt.id)) return undefined;
    const data = this.native(attempt)?.data ?? [];
    const turns = new Set(
      data
        .filter(
          (e) =>
            e.payload.thread_id === attempt.conversation &&
            e.payload.item?.type === 'UserMessage' &&
            e.payload.item.content?.some((c) =>
              c.text?.startsWith(`[pc attempt=${attempt.id} dispatch=${dispatchId} message=`),
            ),
        )
        .map((e) => e.payload.turn_id),
    );
    const completed = data.filter(
      (e) =>
        e.payload.type === 'task_complete' && e.payload.turn_id && turns.has(e.payload.turn_id),
    );
    return completed.length === 1 ? completed[0].payload.last_agent_message : undefined;
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
    execFileSync('tmux', ['send-keys', '-t', pane, 'C-c']);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await this.stopped(attempt))
        return { evidence: 'Codex exited and terminal termination verified' };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Codex termination unknown; retain checkout ownership');
  }
}
