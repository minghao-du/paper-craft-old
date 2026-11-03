/** Durable demo controls; the Orchestrator alone schedules business work. */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DemoRound } from './round.js';
/** External execution boundary; controlled adapters never establish live acceptance. */
export interface DemoExecution {
  watch?(round: DemoRound): void;
  stop(round: DemoRound, runId?: string, completed?: boolean): Promise<boolean>;
}
/** Reconnectable controls and observations survive a caller disconnect. */
export interface DemoControlState {
  armed?: boolean;
  runId?: string;
  started?: number;
  stopped: boolean;
  releasing?: boolean;
  completed?: boolean;
  stoppedReason?: string;
  execution: 'unknown' | 'running' | 'released';
  budgetMs: number;
  activeMs: number;
  tick: number;
  wait?: 'human' | 'permission';
  permissionEvidence?: string;
  humanEvidence?: string;
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
          armed: false,
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
  /** Arm the round, starting budget accounting and detached watchdog immediately; creates no Run. */
  async arm(budgetMs = 3600000) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0)
      throw new Error('Expected positive execution budget');
    if (this.round.phase !== 'provisioned' || this.round.ownershipUncertain)
      throw new Error('Expected fully owned provisioned round to arm');
    let s = this.status();
    if (s.armed || s.started || s.stopped)
      throw new Error('Round already armed or stopped; use a fresh round');
    mkdirSync(join(this.round.config.root, 'execution.lock'));
    writeFileSync(join(this.round.config.root, 'execution.lock', 'owner'), this.round.id);
    const now = Date.now();
    s = this.mutate((current) => {
      current.armed = true;
      current.started = now;
      current.tick = now;
      current.budgetMs = budgetMs;
      current.activeMs = 0;
      current.stopped = false;
      current.execution = 'unknown';
    });
    this.adapter.watch?.(this.round);
    return s;
  }

  /** Uniquely and durably bind this armed round to a Run before managed execution. */
  bindRun(runId: string) {
    if (!runId || typeof runId !== 'string') throw new Error('Expected valid Run identity');
    return this.mutate((s) => {
      if (s.stopped) throw new Error(`Round is stopped; cannot bind Run ${runId}`);
      if (!s.armed) throw new Error(`Round is not armed; cannot bind Run ${runId}`);
      if (s.activeMs >= s.budgetMs) throw new Error(`Round budget expired; cannot bind Run ${runId}`);
      if (s.runId && s.runId !== runId)
        throw new Error(`Round already bound to Run ${s.runId}`);
      s.runId = runId;
      s.execution = 'running';
    });
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
      if (!s.wait && !s.completed && s.started) s.activeMs += Math.max(0, now - s.tick);
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
    this.mutate((s) => {
      s.permissionEvidence = undefined;
    });
    return this.checkpoint();
  }

  /** Operator evidence starts an evidenced human closure wait; no automatic judgment is implied. */
  async humanWait(evidence: string) {
    if (!evidence.trim() || this.status().wait === 'permission')
      throw new Error('Expected human wait evidence outside permission wait');
    this.mutate((s) => {
      s.humanEvidence = evidence;
    });
    return this.checkpoint('human');
  }

  /** Resume only the human closure pause, preserving any separate permission wait. */
  async humanResume() {
    if (this.status().wait !== 'human') throw new Error('No human wait to resume');
    this.mutate((s) => {
      s.humanEvidence = undefined;
    });
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
