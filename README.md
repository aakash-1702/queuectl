# QueueCTL

QueueCTL is a CLI-based background job queue system built with Node.js, TypeScript, Prisma, and PostgreSQL. It demonstrates a robust, decentralized worker architecture driven by the database, rather than relying on a central message broker like Redis or RabbitMQ.

## Setup Instructions

**Prerequisites:** Node.js (v24 or later recommended) and npm.

1. **Clone and Install:**
   ```bash
   git clone <repository-url>
   cd queuectl
   npm install
   ```

2. **Configure the Database:**
   This project relies on PostgreSQL. We chose NeonDB for a zero-config, serverless setup so you don't need to install Postgres locally. 
   - Get a connection string from [neon.tech](https://neon.tech).
   - Create a `.env` file in the project root:
     ```env
     DATABASE_URL="postgresql://user:pass@ep-name.region.aws.neon.tech/dbname?sslmode=require"
     ```

3. **Initialize the Schema:**
   We use Prisma 7 with the pg driver adapter (`@prisma/adapter-pg`). Run the migrations to sync the schema:
   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   ```
   *Note: If you run into issues with the `url` inside the Prisma datasource block during setup, ensure you are using the explicit driver adapter pattern in `src/db.ts` as we configured it, since Prisma 7 restricts connection strings inside the schema for adapters.*

4. **Running the CLI:**
   You can run the CLI directly using `tsx` (which we found works much more reliably than `ts-node` on Node 24):
   ```bash
   npx tsx src/cli.ts <command>
   ```
   Alternatively, you can build the project and run the JavaScript output:
   ```bash
   npm run build
   node dist/cli.js <command>
   ```

## Usage Examples

Here is how to use the 8 core commands, with realistic outputs based on how the CLI actually formats them.

**1. Enqueue a job:**
```bash
npx tsx src/cli.ts enqueue '{"id":"job-1","command":"echo hello"}'
```
*Output:*
```
✔ Job enqueued successfully.
  ID:         job-1
  Command:    echo hello
  MaxRetries: 3
  State:      pending
```

**2. Start workers:**
Forks background daemon processes that poll the database for jobs.
```bash
npx tsx src/cli.ts worker start --count 2
```
*Output:*
```
Spawning 2 background worker(s)...
✔ Worker 1 spawned (PID: 12345)
✔ Worker 2 spawned (PID: 12346)
All workers started in the background.
```

**3. Stop workers:**
Gracefully signals all running workers to finish their current job and exit.
```bash
npx tsx src/cli.ts worker stop
```
*Output:*
```
Sending shutdown signal to 2 running worker(s)...
  → Shutdown signal sent to worker-standalone-12345 (PID: 12345)
  → Shutdown signal sent to worker-standalone-12346 (PID: 12346)
Waiting up to 20s for workers to finish...
✔ All workers stopped successfully.
```

**4. Check system status:**
Shows aggregate job counts and the health of registered workers.
```bash
npx tsx src/cli.ts status
```
*Output:*
```
┌─────────────────────────────────┐
│          Job Queue Status       │
└─────────────────────────────────┘

  Jobs by State
  ──────────────────────────
  State         Count     
  ──────────────────────────
  pending       0         
  processing    0         
  completed     1         
  failed        0         
  dead          0         
  ──────────────────────────
  Total         1         

  Workers
  ──────────────────────────────────────────────────────────────────────────────────────────
  ID                                        PID     Status      Started               Note
  ──────────────────────────────────────────────────────────────────────────────────────────
  worker-standalone-12345                   12345   stopped     2026-07-18 02:46:12   
  ──────────────────────────────────────────────────────────────────────────────────────────
  stopped: 1
```

**5. List jobs by state:**
```bash
npx tsx src/cli.ts list --state completed
```
*Output:*
```
  Jobs — state: completed (1 total)
  ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ID                      Command                     State       Attempts MaxRetries NextRunAt             UpdatedAt
  ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  job-1                   echo hello                  completed   0        3          2026-07-18 02:46:12   2026-07-18 02:46:12
  ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

**6. View the Dead-Letter Queue (DLQ):**
```bash
npx tsx src/cli.ts dlq list
```
*Output:*
```
  ☠  Dead-Letter Queue — 1 job(s)
  ───────────────────────────────────────────────────────────────────────────────────────────────
  ID                      Command                         Attempts  MaxRetries Last Updated
  ───────────────────────────────────────────────────────────────────────────────────────────────
  job-broken              exit 1                          3         3          2026-07-18 02:46:12
  ───────────────────────────────────────────────────────────────────────────────────────────────

  Tip: use 'queuectl dlq retry <id>' to re-queue a dead job.
```

**7. Retry a dead job:**
```bash
npx tsx src/cli.ts dlq retry job-broken
```
*Output:*
```
✔ Job "job-broken" has been reset to 'pending' with attempts=0 and re-queued immediately.
```

**8. Manage configuration:**
```bash
npx tsx src/cli.ts config set max-retries 5
```
*Output:*
```
✔ Config updated:
  Key:      max-retries
  Previous: 3
  New:      5
```

## Architecture Overview

### Job Lifecycle
The system tracks jobs across five distinct states, backed by the `JobState` enum in the Prisma schema:
- `pending`: Enqueued and waiting to be claimed.
- `processing`: Currently executing by a worker.
- `completed`: Successfully finished (process exited with code 0).
- `failed`: Failed but will be retried.
- `dead`: Failed and exhausted all retries (moved to DLQ).

### Persistence Strategy
All state (jobs, configuration, and worker heartbeats) lives in Postgres. We chose Postgres via NeonDB because it allows anyone testing this tool to run it without setting up a local database server, while still providing the advanced locking primitives necessary for a decentralized queue.

### Concurrency and Locking
Duplicate job claiming is prevented at the database level using Postgres's `FOR UPDATE SKIP LOCKED`. 
When a worker queries for the next pending job, it acquires a row-level lock on it. If multiple workers poll simultaneously, the `SKIP LOCKED` clause ensures they gracefully bypass rows already locked by other workers. This prevents deadlocks and double-execution without requiring a complex application-level lock manager or a separate Redis instance.

### Worker Processes
Workers are spawned via Node's `child_process.fork()`. Using separate detached OS processes ensures that a catastrophic failure in a job (like a native segfault or out-of-memory error) doesn't take down the main CLI or crash other running workers.

### Exponential Backoff
When a job fails, it isn't retried immediately. The worker schedules a `nextRunAt` time using exponential backoff: `delay = backoffBase ^ attempts` (in seconds). Both the default `max-retries` and the `backoff-base` can be adjusted dynamically via the `queuectl config set` command.

### Cross-Platform Graceful Shutdown
Killing background workers cleanly without abandoning in-flight jobs is notoriously tricky across operating systems. We implemented a three-channel shutdown design because Windows does not deliver POSIX signals (like `SIGTERM`) to child processes gracefully—`process.kill(pid, 'SIGTERM')` on Windows just hard-kills the process. This was discovered directly while testing on Windows.

Our strategy:
1. **DB-driven signal (CLI `worker stop`)**: The parent CLI writes `status = 'stopping'` to the worker's DB row. The worker's heartbeat loop polls this every 5 seconds and self-terminates smoothly.
2. **IPC Message (Tests)**: When the parent process still holds a reference to the child (like in `test/e2e.ts`), we send a direct `{ type: 'shutdown' }` message over Node's built-in IPC channel.
3. **SIGTERM (Fallback)**: A traditional `SIGTERM` listener remains active for manual termination on Unix-like systems.

## Assumptions & Trade-offs

During development, we made several deliberate trade-offs to keep the architecture focused and maintainable:

- **Strict ID Uniqueness**: Duplicate job IDs on `enqueue` are explicitly rejected rather than silently overwriting existing jobs. This prevents accidental data loss if two systems enqueue the same semantic task.
- **DLQ Retry Behavior**: Running `dlq retry` explicitly resets the job's `attempts` counter back to `0`. If a job lands in the DLQ, the assumption is that human intervention fixed the underlying issue, so it deserves a fresh full retry cycle.
- **Stale Lock Recovery (Orphan Jobs)**: There is currently no automatic recovery for jobs stuck in the `processing` state if a worker is hard-killed (e.g., via `SIGKILL`). As demonstrated in Scenario 5 of our test suite, these jobs survive the crash but must be manually reset to `pending`. Implementing a background sweep to reclaim jobs based on stale `updatedAt` timestamps is a natural next step, but was omitted here given time constraints.
- **Polling Intervals**: Workers poll the database every 1000ms (`POLL_INTERVAL_MS`). Heartbeats ping every 5000ms. These are hardcoded in `src/worker-process.ts` as a reasonable middle ground between responsiveness and database load, rather than implementing complex long-polling.
- **Direct Database Connections**: We use direct Prisma connections (`@prisma/adapter-pg`) rather than a pooled connection manager like pgBouncer. Since this is a CLI where workers run as standalone processes, the total concurrent connection count remains relatively low.
- **Postgres via Neon vs. SQLite**: We chose a hosted Postgres instance over a local SQLite file. While SQLite is simpler for standalone CLIs, Postgres's `SKIP LOCKED` behavior is much more predictable for concurrent worker testing, and Neon makes the setup frictionless.

## Testing Instructions

We built a custom, dependency-free end-to-end test suite that exercises the entire system using real subprocesses and real database transactions (no mocks).

Run the suite using:
```bash
npx tsx test/e2e.ts
```

The script automatically resets the database state at the beginning of execution, making it fully idempotent and safe to run repeatedly.

It verifies five critical scenarios:
1. **Basic Success**: Enqueues a job, starts a worker, polls until completion, and verifies clean worker shutdown.
2. **Retry → DLQ**: Forces a job to fail repeatedly and ensures it lands in the Dead-Letter Queue after exhausting `max_retries`.
3. **Invalid Command**: Verifies that if the underlying shell command is garbage, the worker survives, logs the failure, and moves on.
4. **Concurrency & Locking**: Spawns 3 simultaneous workers against 10 jobs to prove that `SKIP LOCKED` prevents duplicate execution.
5. **Persistence Across Hard Crash**: Simulates a catastrophic worker failure (`SIGKILL`). Verifies that the job remains in the database and can be successfully completed by a new worker after manual state recovery.
