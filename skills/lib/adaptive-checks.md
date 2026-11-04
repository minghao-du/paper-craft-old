# Adaptive Checks for Long Tasks

Shared protocol for monitoring long-running local or remote processes, computational tasks, model training, experiments, and long test suites across Managed Runs and Worker assignments.

## Core Contract

When launching or monitoring long-running operations:

1. **Explicit Identity & Completion Probes:**
   - Launch through the configured platform or runtime and capture the exact process ID (PID), SLURM job ID, or remote task identifier. Never rely on pattern-matching commands (like `pgrep -f`) that can match the monitoring shell itself.
   - Verify that completion probes return nonzero while unfinished and exit 0 only on true success.
   - Preserve pipeline or SSH exit statuses rather than masking them with successful output echos.
   - Verify output paths directly in the consuming environment, never assuming remote outputs exist locally without transfer.

2. **Adaptive Polling Intervals & Exponential Backoff:**
   - Base interval estimates on historical comparable runs, input data size, or measured throughput when known.
   - For multi-hour computational work, start with checks tens of minutes apart (e.g. 15–30 minutes) and shorten check intervals as the estimated completion time approaches.
   - When no reliable estimate exists, start with a 5-minute interval and double unchanged intervals up to a 30-minute ceiling (5m → 10m → 20m → 30m).
   - Adjust defaults dynamically based on observed progress, deadlines, and platform queue policies. Normal waiting does not trigger immediate retries or busy loops.

3. **Progress Detection & Stall Diagnosis:**
   - On each check, inspect observable progress markers: log file growth, mtime of updated output artifacts, iteration steps, checkpoint records, or batch loss logs.
   - Distinguish four operational conditions:
     - **Normal waiting:** process is alive, resources active, progress steadily advances.
     - **Probe error:** transient network/SSH or querying failure. Three consecutive probe errors prompt evaluation as a blocker; single probe glitches back off.
     - **Stalled/hung process:** process is running but zero progress for longer than expected iteration bounds. Diagnose logs, thread activity, or resource contention before intervening.
     - **Terminal failure:** nonzero exit, out-of-memory (OOM), or crash. Stop and report the failure root cause.
   - An exceeded duration estimate prompts diagnosis and schedule revision, never cancellation or resubmission by itself. Verify exit status and required outputs before continuing.

4. **SLURM & Cluster Scheduler Scheduling:**
   - Track submission, queue wait, and actual execution duration separately using exact job IDs and accounting:
     - **PENDING:** distinguish priority/resource waiting from dependency failures or administrator holds. Holds or failed prerequisites require immediate diagnosis; normal queueing maintains backoff.
     - **RUNNING:** separate queue time from execution time. Compute progress and remaining duration from actual start time. Requeue returns to queue scheduling; suspension or restart requires revising the estimate from the observed state.
     - **Terminal or missing from queue:** inspect accounting/exit status and outputs (`sacct`). Queue disappearance alone proves neither success nor failure; delayed accounting remains unconfirmed.
   - A requested wall-time limit is a limit, not a duration forecast.

5. **Durable Schedule & Wake-up Persistence:**
   - Persist each check's result, progress observation, estimate, next check appointment (UTC ISO 8601), and rationale in the task worklog or receipt state.
   - In Managed Runs, release execution occupancy between checks when using scheduled timer wake-ups or platform continuation, rather than keeping interactive agent turns open and idle.
