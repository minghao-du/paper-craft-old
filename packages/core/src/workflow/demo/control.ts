/** Durable demo controls; the Orchestrator alone schedules business work. */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DemoRound } from './round.js';
/** External execution boundary; controlled adapters never establish live acceptance. */
export interface DemoExecution {
  start(round: DemoRound): Promise<string>;
  watch?(round: DemoRound): void;
  stop(round: DemoRound, runId?: string): Promise<boolean>;
}
/** Reconnectable controls and observations survive a caller disconnect. */
export interface DemoControlState {
  runId?: string;
  started?: number;
  stopped: boolean;
  execution: 'unknown' | 'running' | 'released';
  budgetMs: number;
  activeMs: number;
  tick: number;
  wait?: 'human' | 'permission';
  observations: { id: string; text: string; evidence?: string; disposition?: string }[];
  error?: string;
  usage: 'unavailable';
}
/** Public control seam shared by launcher, verifier and disposition. */
export class DemoControl {
  constructor(
    readonly round: DemoRound,
    readonly adapter: DemoExecution,
  ) {}
  /** Inspect durable state without asserting termination from business completion. */
  status(): DemoControlState {
    const p = join(this.round.root, 'control.json');
    return existsSync(p)
      ? JSON.parse(readFileSync(p, 'utf8'))
      : {
          stopped: false,
          execution: 'unknown',
          budgetMs: 3600000,
          activeMs: 0,
          tick: Date.now(),
          observations: [],
          usage: 'unavailable',
        };
  }
  private save(s: DemoControlState) {
    const p = join(this.round.root, 'control.json');
    const tmp = p + '.' + randomUUID();
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, p);
  }
  /** Explicit start, one execution across the configured round home, never retry. */
  async start(confirmed: boolean, budgetMs = 3600000) {
    if (!confirmed || !Number.isFinite(budgetMs) || budgetMs <= 0)
      throw new Error('Expected explicit start confirmation and positive execution budget');
    let s = this.status();
    if (s.started || s.stopped)
      throw new Error('Round already started or stopped; use a fresh round');
    mkdirSync(join(this.round.config.root, 'execution.lock'));
    s.started = Date.now();
    s.tick = s.started;
    s.budgetMs = budgetMs;
    this.save(s);
    try {
      const runId = await this.adapter.start(this.round);
      s = this.status();
      s.runId = runId;
      if (s.stopped) {
        this.save(s);
        return this.stop();
      }
      s.execution = 'running';
      this.save(s);
      this.adapter.watch?.(this.round);
      return s;
    } catch (e) {
      s.error = String(e);
      s.stopped = true;
      this.save(s);
      throw e;
    }
  }
  /** Record an observation without requiring proof or stopping execution. */
  report(text: string, evidence?: string) {
    if (!text.trim()) throw new Error('Expected observation text');
    const s = this.status();
    s.observations.push({ id: randomUUID(), text, evidence });
    this.save(s);
    return s;
  }
  /** Explicit false-alarm disposition requires a durable reason. */
  resolve(id: string, reason: string) {
    const s = this.status();
    const o = s.observations.find((o) => o.id === id);
    if (!o || !reason.trim()) throw new Error('Expected known observation and disposition reason');
    o.disposition = { status: 'false_alarm', reason };
    this.save(s);
    return s;
  }
  /** Account active time; caller must use verified human/permission boundaries. */
  async checkpoint(wait?: 'human' | 'permission', now = Date.now()) {
    const s = this.status();
    if (!s.wait && s.started) s.activeMs += Math.max(0, now - s.tick);
    s.tick = now;
    s.wait = wait;
    this.save(s);
    return s.activeMs >= s.budgetMs ? this.stop() : s;
  }
  /** Stop immediately, retain diagnostics, release the execution lock only with proof. */
  async stop() {
    const s = this.status();
    s.stopped = true;
    s.execution = 'unknown';
    this.save(s);
    try {
      if (await this.adapter.stop(this.round, s.runId)) {
        s.execution = 'released';
        rmSync(join(this.round.config.root, 'execution.lock'), { recursive: true });
      }
    } catch (e) {
      s.error = String(e);
    }
    s.observations = this.status().observations;
    this.save(s);
    return s;
  }
}
