import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgyInteractive } from './agy-interactive.js';
import type { RunnerAdapter, ManagedAttempt, ExecutionObservation, ExecutionTermination } from './runtime.js';

/** Managed agy persistent TUI adapter backed by native hook transcripts. */
export class AgyRunner implements RunnerAdapter {
  readonly name = 'agy';
  readonly automaticStartup = true;
  readonly cancellation = true;
  readonly interactive = true;
  private readonly tui = new AgyInteractive();

  prepareReplacement(prior: ManagedAttempt, attempts: ManagedAttempt[]): Promise<void> {
    return this.tui.prepareReplacement(prior, attempts);
  }

  preflight(): Promise<void> {
    return this.tui.preflight();
  }

  start(a: ManagedAttempt): Promise<{ conversation: string; address: string; evidence: string }> {
    return this.tui.start(a);
  }

  recoverReceipt(
    a: ManagedAttempt,
  ): Promise<{ conversation: string; address: string; evidence: string } | undefined> {
    return this.tui.recoverReceipt(a);
  }

  messageReceipt(
    a: ManagedAttempt,
    m: { id: string; brief: string },
  ): Promise<string | undefined> {
    return this.tui.messageReceipt(a, m);
  }

  stopped(a: ManagedAttempt): Promise<boolean> {
    return this.tui.stopped(a);
  }

  termination(a: ManagedAttempt): Promise<boolean> {
    return this.tui.terminated(a);
  }

  async terminate(a: ManagedAttempt): Promise<ExecutionTermination> {
    try {
      if (await this.stopped(a)) {
        return {
          status: 'terminated',
          evidence: 'Owned Agy process already exited or terminated',
        };
      }
      const receipt = await this.cancel(a);
      if (!(await this.stopped(a))) {
        return {
          status: 'unconfirmed',
          error: 'Agy pane termination unverified after cancellation',
        };
      }
      return {
        status: 'terminated',
        evidence: receipt.evidence,
      };
    } catch (error) {
      return {
        status: 'unconfirmed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  cancel(a: ManagedAttempt): Promise<{ evidence: string }> {
    return this.tui.cancel(a);
  }

  send(
    a: ManagedAttempt,
    m: { id: string; brief: string },
  ): Promise<{ status: 'delivered' | 'uncertain'; evidence: string }> {
    return this.tui.send(a, m);
  }

  result(a: ManagedAttempt, id: string): Promise<string | undefined> {
    return this.tui.result(a, id);
  }

  observe(a: ManagedAttempt): Promise<ExecutionObservation> {
    return this.tui.observe(a);
  }

  /** Persistent completion uses correlated native turn output, never process exit. */
  async collect(
    a: ManagedAttempt,
    options?: { timeoutMs?: number; dispatchId?: string },
  ): Promise<string> {
    const id = options?.dispatchId ?? a.dispatchId ?? a.id;
    const deadline = options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
    for (;;) {
      const output = await this.result(a, id);
      if (output !== undefined) return output;
      if (await this.stopped(a)) {
        throw new Error(
          'agy exited without a correlated task result (Runner stopped without a correlated task result)',
        );
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error('Timed out waiting for correlated task result');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  collectable(a: ManagedAttempt): boolean {
    return existsSync(join(a.directory, 'agy-native.json'));
  }
}
