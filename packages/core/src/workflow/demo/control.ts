/** Durable demo controls; the Orchestrator alone schedules business work. */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DemoRound } from './round.js';
/** External execution boundary; controlled adapters never establish live acceptance. */
export interface DemoExecution {
  start(round: DemoRound): Promise<string>;
  watch?(round: DemoRound): void;
  stop(round: DemoRound, runId?: string, completed?: boolean): Promise<boolean>;
}
/** Reconnectable controls and observations survive a caller disconnect. */
export interface DemoControlState {
  runId?: string;
  started?: number;
  stopped: boolean;
  releasing?: boolean;
  execution: 'unknown' | 'running' | 'released';
  budgetMs: number;
  activeMs: number;
  tick: number;
  wait?: 'human' | 'permission';
  permissionEvidence?: string;
  observations: {
    id: string;
    text: string;
    evidence?: string;
    disposition?: { status: 'false_alarm'; reason: string };
  }[];
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
  private mutate(change: (state: DemoControlState) => void) {
    const lock = join(this.round.root, 'control.lock');
    // A stale lock is unknown occupancy, never silently broken.
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        mkdirSync(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline)
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      const state = this.status();
      change(state);
      const p = join(this.round.root, 'control.json');
      const tmp = p + '.' + randomUUID();
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, p);
      return state;
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
  /** Explicit start, one execution across the configured round home, never retry. */
  async start(confirmed: boolean, budgetMs = 3600000) {
    if (!confirmed || !Number.isFinite(budgetMs) || budgetMs <= 0)
      throw new Error('Expected explicit start confirmation and positive execution budget');
    let s = this.status();
    if (s.started || s.stopped)
      throw new Error('Round already started or stopped; use a fresh round');
    mkdirSync(join(this.round.config.root, 'execution.lock'));
    writeFileSync(join(this.round.config.root, 'execution.lock', 'owner'), this.round.id);
    s.started = Date.now();
    s.tick = s.started;
    s.budgetMs = budgetMs;
    this.mutate((current) => {
      current.started = s.started;
      current.tick = s.tick;
      current.budgetMs = budgetMs;
    });
    try {
      const runId = await this.adapter.start(this.round);
      s = this.status();
      s.runId = runId;
      if (s.stopped) {
        this.mutate((current) => {
          current.runId = runId;
        });
        return this.stop();
      }
      s = this.mutate((current) => {
        current.runId = runId;
        if (!current.stopped) current.execution = 'running';
      });
      this.adapter.watch?.(this.round);
      return s;
    } catch (e) {
      this.mutate((current) => {
        current.error = String(e);
        current.stopped = true;
      });
      throw e;
    }
  }
  /** Record an observation without requiring proof or stopping execution. */
  report(text: string, evidence?: string) {
    if (!text.trim()) throw new Error('Expected observation text');
    return this.mutate((s) => {
      s.observations.push({ id: randomUUID(), text, evidence });
    });
  }

  /** Explicit false-alarm disposition requires a durable reason. */
  resolve(id: string, reason: string) {
    return this.mutate((s) => {
      const o = s.observations.find((o) => o.id === id);
      if (!o || !reason.trim())
        throw new Error('Expected known observation and disposition reason');
      o.disposition = { status: 'false_alarm', reason };
    });
  }

  /** Account active time; caller must use verified human/permission boundaries. */
  async checkpoint(wait?: 'human' | 'permission', now = Date.now(), preserveWait = false) {
    const s = this.mutate((s) => {
      if (!s.wait && s.started) s.activeMs += Math.max(0, now - s.tick);
      s.tick = now;
      if (!preserveWait) s.wait = wait;
    });
    return s.activeMs >= s.budgetMs ? this.stop() : s;
  }

  /** Operator evidence identifies an observed native permission wait; no automatic detector is implied. */
  async permissionWait(evidence: string) {
    if (!evidence.trim() || this.status().wait === 'human')
      throw new Error('Expected permission evidence outside human closure wait');
    this.mutate((s) => {
      s.permissionEvidence = evidence;
    });
    return this.checkpoint('permission');
  }
  /** Resume only the permission pause, preserving any separate closure wait. */
  async permissionResume() {
    if (this.status().wait !== 'permission') throw new Error('No permission wait to resume');
    return this.checkpoint();
  }
  private releaseLock() {
    const lock = join(this.round.config.root, 'execution.lock');
    if (
      existsSync(join(lock, 'owner')) &&
      readFileSync(join(lock, 'owner'), 'utf8') === this.round.id
    )
      rmSync(lock, { recursive: true });
  }
  /** Terminate a completed business Run without recording a user stop or invalidating completion. */
  async release() {
    let s = this.status();
    if (s.stopped || !s.runId) return s;
    s.releasing = true;
    s.execution = 'unknown';
    this.mutate((current) => {
      current.releasing = true;
      current.execution = 'unknown';
    });
    // The correlated budget watcher exits when release begins; no business scheduling is performed here.
    for (let i = 0; i < 4; i++) {
      if (await this.adapter.stop(this.round, s.runId, true)) {
        s = this.status();
        s.execution = 'released';
        this.releaseLock();
        this.mutate((current) => {
          if (!current.stopped) current.execution = 'released';
        });
        return s;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return this.status();
  }
  /** Stop immediately, retain diagnostics, release the execution lock only with proof. */
  async stop() {
    let s = this.mutate((current) => {
      current.stopped = true;
      current.execution = 'unknown';
    });
    try {
      if (await this.adapter.stop(this.round, s.runId)) {
        this.releaseLock();
        s = this.mutate((current) => {
          current.execution = 'released';
        });
      }
    } catch (e) {
      s = this.mutate((current) => {
        current.error = String(e);
      });
    }
    return s;
  }
}
