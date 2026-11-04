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

  start(attempt: ManagedAttempt): Promise<{ conversation: string; address: string; evidence: string }> {
    return this.tui.start(attempt);
  }

  recoverReceipt(
    attempt: ManagedAttempt,
  ): Promise<{ conversation: string; address: string; evidence: string } | undefined> {
    return this.tui.recoverReceipt(attempt);
  }

  messageReceipt(
    attempt: ManagedAttempt,
    message: { id: string; brief: string },
  ): Promise<string | undefined> {
    return this.tui.messageReceipt(attempt, message);
  }

  stopped(attempt: ManagedAttempt): Promise<boolean> {
    return this.tui.stopped(attempt);
  }

  termination(attempt: ManagedAttempt): Promise<boolean> {
    return this.tui.terminated(attempt);
  }

  terminate(attempt: ManagedAttempt): Promise<ExecutionTermination> {
    return this.tui.terminate(attempt);
  }

  cancel(attempt: ManagedAttempt): Promise<{ evidence: string }> {
    return this.tui.cancel(attempt);
  }

  send(
    attempt: ManagedAttempt,
    message: { id: string; brief: string },
  ): Promise<{ status: 'delivered' | 'uncertain'; evidence: string }> {
    return this.tui.send(attempt, message);
  }

  result(attempt: ManagedAttempt, id: string): Promise<string | undefined> {
    return this.tui.result(attempt, id);
  }

  observe(attempt: ManagedAttempt): Promise<ExecutionObservation> {
    return this.tui.observe(attempt);
  }

  /** Persistent completion uses correlated native turn output, never process exit. */
  async collect(
    attempt: ManagedAttempt,
    options?: { timeoutMs?: number; dispatchId?: string },
  ): Promise<string> {
    const id = options?.dispatchId ?? attempt.dispatchId ?? attempt.id;
    const deadline = options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
    for (;;) {
      const output = await this.result(attempt, id);
      if (output !== undefined) return output;
      if (await this.stopped(attempt)) {
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
}
