import { refreshStartupAttempt, roleInitializationReady } from '../run/role-initialization.js';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
/** Agy native hooks correlate persistent TUI turns with durable dispatches. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quote, type ManagedAttempt, type ExecutionObservation } from './runtime.js';

const delay = () => new Promise((resolve) => setTimeout(resolve, 100));

type NativeStep = {
  step_index: number;
  type: string;
  source: string;
  status: string;
  content?: string;
};

/** agy native transcript and status callbacks preserve exact conversation attribution. */
export class AgyInteractive {
  /** Rebuild only a missing owned Run terminal after all historical executions exited. */
  async prepareReplacement(prior: ManagedAttempt, attempts: ManagedAttempt[]): Promise<void> {
    if (!prior.run || prior.terminalSession !== `pc-run-${prior.run}`)
      throw new Error(
        'Unsupported legacy agy layout; end old executions before starting a new Run',
      );
    const session = prior.terminalSession;
    let sessions: string[];
    try {
      sessions = execFileSync('tmux', ['list-sessions', '-F', '#{session_name} #{@pc_run_id}'], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n');
    } catch (error) {
      if (!/no server running|error connecting/.test(String(error))) throw error;
      sessions = [];
    }
    const entry = sessions.find((line) => line.split(' ')[0] === session);
    if (entry !== undefined) {
      if (entry !== `${session} ${prior.run}`)
        throw new Error('Run session ownership missing or conflicting');
      return;
    }
    for (const a of attempts) {
      if (!(await this.terminated(a)))
        throw new Error('Run execution termination unresolved; cannot rebuild session');
    }
    execFileSync('tmux', ['new-session', '-d', '-s', session]);
    execFileSync('tmux', ['set-option', '-t', session, '@pc_run_id', prior.run]);
  }

  private verifyTerminal(a: ManagedAttempt): void {
    if (!a.run) return;
    if (a.terminalSession !== `pc-run-${a.run}`)
      throw new Error('Unsupported legacy agy layout; historical execution will not restart');
    const identity = execFileSync(
      'tmux',
      ['display-message', '-p', '-t', this.address(a), '#{session_name} #{@pc_run_id} #{pane_id}'],
      { encoding: 'utf8' },
    ).trim();
    if (identity !== `${a.terminalSession} ${a.run} ${this.address(a)}`)
      throw new Error('Run session or exact pane ownership unverified');
  }

  private native(a: ManagedAttempt): Record<string, string> | undefined {
    try {
      const n = JSON.parse(readFileSync(join(a.directory, 'agy-native.json'), 'utf8'));
      return !a.conversation || n.conversation_id === a.conversation ? n : undefined;
    } catch {
      return undefined;
    }
  }

  private steps(a: ManagedAttempt): NativeStep[] {
    const n = this.native(a);
    if (!n) return [];
    const paths = [
      n.transcript_path,
      join(
        homedir(),
        '.gemini',
        'antigravity-cli',
        'brain',
        n.conversation_id,
        '.system_generated',
        'logs',
        'transcript.jsonl',
      ),
      join(
        homedir(),
        '.gemini',
        'antigravity',
        'brain',
        n.conversation_id,
        '.system_generated',
        'logs',
        'transcript.jsonl',
      ),
    ];
    const file = paths.find((p) => p && existsSync(p));
    if (!file) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as NativeStep];
        } catch {
          return [];
        }
      });
  }

  private input(s: NativeStep, brief: string): boolean {
    if (s.type !== 'USER_INPUT' || s.source !== 'USER_EXPLICIT' || s.status !== 'DONE') {
      return false;
    }
    const body = s.content?.split('</USER_REQUEST>')[0]?.replace(/^<USER_REQUEST>\n?/, '');
    if (body === undefined) return false;
    return body === brief + '\n' || body.trim() === brief.trim();
  }

  private address(a: ManagedAttempt): string {
    if (!a.address && existsSync(join(a.directory, 'terminal.json'))) {
      try {
        a.address = (
          JSON.parse(readFileSync(join(a.directory, 'terminal.json'), 'utf8')) as {
            address?: string;
          }
        ).address;
      } catch {
        /* ignore read error */
      }
    }
    if (!a.address?.startsWith('tmux:')) throw new Error('Agy lacks persisted tmux identity');
    return a.address.slice(5);
  }

  async preflight(): Promise<void> {
    execFileSync('tmux', ['-V'], { timeout: 5000 });
    const probe = spawnSync('agy', ['--help'], { encoding: 'utf8', timeout: 5000 });
    if (probe.error || probe.status !== 0)
      throw new Error('agy capability probe failed: ' + String(probe.error ?? probe.stderr));
    const help = probe.stdout + probe.stderr;
    for (const flag of ['--prompt-interactive', '--conversation', '--settings', '--add-dir'])
      if (!help.includes(flag)) throw new Error('agy lacks interactive capability ' + flag);
  }

  private panes(): Map<string, string> {
    try {
      return new Map(
        execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead}'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split(' ') as [string, string]),
      );
    } catch (error: unknown) {
      const msg = String(
        (error as { stderr?: string; message?: string })?.stderr ?? (error as Error)?.message ?? '',
      );
      if (msg.includes('no server running') || msg.includes('error connecting')) {
        return new Map();
      }
      throw new Error('Cannot verify tmux occupancy', { cause: error });
    }
  }

  async stopped(a: ManagedAttempt): Promise<boolean> {
    const panes = this.panes();
    const addr = this.address(a);
    if (panes.has(addr)) this.verifyTerminal(a);
    return (
      panes.get(addr) === '1' ||
      (!panes.has(addr) &&
        (existsSync(join(a.directory, 'agy-terminated')) ||
          existsSync(join(a.directory, 'exit-code'))))
    );
  }

  async cancel(a: ManagedAttempt): Promise<{ evidence: string }> {
    const addr = this.address(a);
    this.verifyTerminal(a);
    execFileSync('tmux', ['kill-pane', '-t', addr]);
    if (this.panes().has(addr)) throw new Error('Agy pane termination unverified');
    writeFileSync(join(a.directory, 'agy-terminated'), addr);
    return { evidence: 'Owned Agy pane terminated and absence verified' };
  }

  async terminated(a: ManagedAttempt): Promise<boolean> {
    return this.stopped(a);
  }

  async start(a: ManagedAttempt) {
    if (!a.run) throw new Error('Agy child requires Run ownership');
    const session = `pc-run-${a.run}`;
    let sessions: string[];
    try {
      sessions = execFileSync('tmux', ['list-sessions', '-F', '#{session_name} #{@pc_run_id}'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .trim()
        .split('\n');
    } catch (error) {
      if (!/no server running|error connecting/.test(String(error))) throw error;
      sessions = [];
    }
    const existing = sessions.find((line) => line.split(' ')[0] === session);
    const initial = a.role === 'orchestrator' && !a.predecessor;
    if (initial && existing !== undefined)
      throw new Error('Run session already exists; ownership cannot be assumed');
    if (initial) {
      a.address =
        'tmux:' +
        execFileSync(
          'tmux',
          [
            'new-session',
            '-P',
            '-F',
            '#{pane_id}',
            '-d',
            '-s',
            session,
            '-n',
            `orchestrator-${a.id.slice(0, 8)}`,
          ],
          { encoding: 'utf8' },
        ).trim();
      execFileSync('tmux', ['set-option', '-t', session, '@pc_run_id', a.run]);
      sessions.push(`${session} ${a.run}`);
    }
    if (!sessions.includes(`${session} ${a.run}`))
      throw new Error(
        'Run session ownership missing or conflicting; reconcile the Orchestrator session before dispatch',
      );
    a.terminalSession = session;
    if (!existsSync(join(a.directory, 'brief.md'))) {
      writeFileSync(join(a.directory, 'brief.md'), a.brief, {
        mode: 0o400,
        flag: 'wx',
      });
    }
    const resume = !!a.conversation;
    if (resume && !a.predecessor) {
      throw new Error(
        'Agy resume requires a linked replacement attempt and a reconciliation brief',
      );
    }
    const hook = join(a.directory, 'agy-status.cjs');
    writeFileSync(
      hook,
      `const fs=require('node:fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const p=JSON.parse(s),f=${JSON.stringify(join(a.directory, 'agy-native.json'))};fs.writeFileSync(f+'.tmp',JSON.stringify({conversation_id:p.conversation_id,transcript_path:p.transcript_path,agent_state:p.agent_state,at:new Date().toISOString()}));fs.renameSync(f+'.tmp',f);});`,
    );
    const settings = join(a.directory, 'agy-settings.json');
    writeFileSync(
      settings,
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'node ' + quote(hook),
          enabled: true,
          stack_with_default: true,
        },
      }),
    );
    const delivered =
      a.brief +
      '\nBefore doing further work, acknowledge applicable role/project initialization and durable-state inspection with [pc ready role=' +
      a.role +
      ' attempt=' +
      a.id +
      (a.startupGate
        ? ']. End this turn immediately and await a separate activation message. Do not poll for activation in this turn.'
        : ']. Then perform only the assigned work.');
    writeFileSync(join(a.directory, 'agy-input.txt'), delivered);
    const args = [
      'agy',
      ...(a.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : []),
      '--settings',
      settings,
      ...[a.directory, ...(a.writableDirectories ?? [])].flatMap((p) => ['--add-dir', p]),
      ...(a.conversation ? ['--conversation', a.conversation] : []),
      '--prompt-interactive',
      delivered,
    ];
    const script = join(a.directory, 'agy-launch.sh');
    writeFileSync(
      script,
      `#!/bin/sh\nwhile [ ! -f ${quote(join(a.directory, 'agy-launch-ready'))} ]; do sleep 0.1; done\n${args.map(quote).join(' ')}\nprintf '%s' "$?" > ${quote(join(a.directory, 'exit-code'))}\n`,
      { mode: 0o700 },
    );
    if (initial) {
      execFileSync(
        'tmux',
        ['respawn-pane', '-k', '-t', this.address(a), '-c', a.checkout, script],
        { encoding: 'utf8' },
      );
    } else {
      a.address =
        'tmux:' +
        execFileSync(
          'tmux',
          [
            'new-window',
            '-d',
            '-P',
            '-F',
            '#{pane_id}',
            '-t',
            session + ':',
            '-n',
            `${a.role}-${a.id.slice(0, 8)}`,
            '-c',
            a.checkout,
            script,
          ],
          { encoding: 'utf8' },
        ).trim();
    }
    a.paneId = this.address(a);
    a.windowId = execFileSync('tmux', ['display-message', '-p', '-t', a.paneId, '#{window_id}'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(a.directory, 'terminal.json'),
      JSON.stringify({
        address: a.address,
        conversation: a.conversation,
        session,
        run: a.run,
        paneId: a.paneId,
        windowId: a.windowId,
      }),
    );
    execFileSync('tmux', ['set-option', '-p', '-t', this.address(a), 'remain-on-exit', 'on']);
    writeFileSync(join(a.directory, 'agy-launch-ready'), 'ready', { flag: 'wx' });
    for (let n = 0; n < 600; n++) {
      const receipt = await this.recoverReceipt(a);
      if (receipt && roleInitializationReady(a)) return receipt;
      if (await this.stopped(a)) {
        const pane = execFileSync('tmux', ['capture-pane', '-p', '-t', this.address(a)], {
          encoding: 'utf8',
        });
        throw new Error(
          `Agy exited before native acknowledgement; inspect terminal and authentication/configuration at ${a.address}: ${pane.slice(-2000)}`,
        );
      }
      await delay();
    }
    const pane = execFileSync('tmux', ['capture-pane', '-p', '-t', this.address(a)], {
      encoding: 'utf8',
    });
    throw new Error(
      `Agy startup unacknowledged; inspect trust/auth/configuration or waiting prompt at ${a.address}: ${pane.slice(-2000)}`,
    );
  }

  async recoverReceipt(a: ManagedAttempt) {
    if (existsSync(join(a.directory, 'terminal.json'))) {
      const terminal = JSON.parse(readFileSync(join(a.directory, 'terminal.json'), 'utf8')) as {
        address?: string;
        session?: string;
        run?: string;
        paneId?: string;
        windowId?: string;
      };
      if (a.run && (terminal.run !== a.run || terminal.session !== `pc-run-${a.run}`))
        throw new Error('Durable terminal Run ownership mismatch');
      if (a.address && terminal.address !== a.address)
        throw new Error('Durable terminal address mismatch');
      a.address ??= terminal.address;
      a.terminalSession ??= terminal.session;
      a.paneId ??= terminal.paneId;
      a.windowId ??= terminal.windowId;
    }
    if (a.run && a.terminalSession !== `pc-run-${a.run}`)
      throw new Error('Unsupported legacy agy layout; historical execution will not restart');
    if (a.address && this.panes().get(this.address(a)) === '0') this.verifyTerminal(a);
    const n = this.native(a);
    if (!n?.conversation_id || !a.address || this.panes().get(this.address(a)) !== '0')
      return undefined;
    a.conversation ??= n.conversation_id;
    if (existsSync(join(a.directory, 'terminal.json'))) {
      try {
        const terminal = JSON.parse(readFileSync(join(a.directory, 'terminal.json'), 'utf8')) as {
          address?: string;
          conversation?: string;
        };
        if (terminal.conversation !== a.conversation) {
          writeFileSync(
            join(a.directory, 'terminal.json'),
            JSON.stringify({ ...terminal, conversation: a.conversation }),
          );
        }
      } catch {
        /* ignore error */
      }
    }
    const steps = this.steps(a);
    const brief = existsSync(join(a.directory, 'agy-input.txt'))
      ? readFileSync(join(a.directory, 'agy-input.txt'), 'utf8')
      : a.brief;
    const input = steps.find((s) => this.input(s, brief));
    const marker = '[pc ready role=' + a.role + ' attempt=' + a.id + ']';
    if (
      !input ||
      !steps.some(
        (s) =>
          s.step_index > input.step_index &&
          s.type === 'PLANNER_RESPONSE' &&
          s.source === 'MODEL' &&
          s.status === 'DONE' &&
          s.content?.includes(marker),
      )
    )
      return undefined;
    return {
      conversation: a.conversation,
      address: a.address,
      evidence: 'Native agy exact conversation and complete submitted brief',
    };
  }

  async result(a: ManagedAttempt, id: string): Promise<string | undefined> {
    refreshStartupAttempt(a);
    if (this.native(a)?.agent_state !== 'idle' || (a.startupGate && !a.activation))
      return undefined;
    const isDispatch = id === (a.dispatchId ?? a.id);
    const messageFile = join(a.directory, `message-${id}.json`);
    let targetBrief: string;
    if (isDispatch) {
      targetBrief = a.startupGate
        ? a.activation!.brief
        : existsSync(join(a.directory, 'agy-input.txt'))
          ? readFileSync(join(a.directory, 'agy-input.txt'), 'utf8')
          : a.brief;
    } else if (existsSync(messageFile)) {
      try {
        targetBrief = (JSON.parse(readFileSync(messageFile, 'utf8')) as { brief: string }).brief;
      } catch {
        return undefined;
      }
    } else {
      return undefined;
    }
    const steps = this.steps(a);
    const inputs = steps.filter((s) => this.input(s, targetBrief));
    if (inputs.length !== 1) return undefined;
    const later = steps.filter((s) => s.step_index > inputs[0].step_index);
    const boundary = later.findIndex(
      (s) => s.type === 'USER_INPUT' && s.source === 'USER_EXPLICIT',
    );
    const responseSteps = boundary < 0 ? later : later.slice(0, boundary);
    const raw = responseSteps.findLast(
      (s) => s.type === 'PLANNER_RESPONSE' && s.source === 'MODEL' && s.status === 'DONE',
    )?.content;
    if (raw === undefined) return undefined;
    const marker = '[pc ready role=' + a.role + ' attempt=' + a.id + ']';
    const cleaned = raw
      .split('\n')
      .filter((line) => line.trim() !== marker)
      .join('\n')
      .trim();
    return cleaned.length > 0 ? cleaned : raw;
  }

  async messageReceipt(a: ManagedAttempt, message: { id: string; brief: string }) {
    this.verifyTerminal(a);
    return this.steps(a).some((s) => this.input(s, message.brief))
      ? 'Native exact agy activation input'
      : undefined;
  }
  async send(a: ManagedAttempt, message: { id: string; brief: string }) {
    this.verifyTerminal(a);
    const prior = new Set(this.steps(a).map((s) => s.step_index));
    const file = join(a.directory, `message-${message.id}.txt`);
    writeFileSync(file, message.brief);
    writeFileSync(join(a.directory, `message-${message.id}.json`), JSON.stringify(message));
    const buffer = `pc-${randomUUID()}`;
    try {
      execFileSync('tmux', ['load-buffer', '-b', buffer, file]);
      execFileSync('tmux', ['paste-buffer', '-p', '-d', '-b', buffer, '-t', this.address(a)]);
      execFileSync('tmux', ['send-keys', '-t', this.address(a), 'Enter']);
      for (let n = 0; n < 50; n++) {
        if (this.steps(a).some((s) => !prior.has(s.step_index) && this.input(s, message.brief)))
          return { status: 'delivered' as const, evidence: 'Native exact agy USER_INPUT step' };
        await delay();
      }
      return {
        status: 'uncertain' as const,
        evidence:
          'Input sent without exact native submission acknowledgement; reconcile before retry',
      };
    } catch (error) {
      return { status: 'uncertain' as const, evidence: String(error) };
    }
  }

  async observe(a: ManagedAttempt): Promise<ExecutionObservation> {
    let status: ExecutionObservation['status'] = 'unknown';
    let evidence = 'Native agy status callback; turn completion is not acceptance';
    try {
      if (await this.terminated(a)) status = 'exited';
      else {
        this.verifyTerminal(a);
        if (this.panes().get(this.address(a)) !== '0') throw new Error('Pane missing');
        const state = this.native(a)?.agent_state;
        if (state === 'idle') status = 'idle';
        else if (state === 'working') status = 'running';
      }
    } catch (error) {
      evidence = String(error);
    }
    return {
      status,
      at: new Date().toISOString(),
      evidence,
    };
  }
}
