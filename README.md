# QueueCTL

A **CLI-based background job queue system** built with **Node.js + TypeScript**, using **Prisma + PostgreSQL (NeonDB)** for persistence and **`FOR UPDATE SKIP LOCKED`** for safe concurrent job dispatch.

---

## Table of Contents

1. [Setup Instructions](#setup-instructions)
2. [Usage Examples](#usage-examples)
3. [Architecture Overview](#architecture-overview)
4. [Assumptions & Trade-offs](#assumptions--trade-offs)
5. [Testing Instructions](#testing-instructions)

---

## Setup Instructions

### Prerequisites

- Node.js ≥ 18
- A PostgreSQL database (NeonDB recommended — free tier available at [neon.tech](https://neon.tech))
- All npm dependencies already installed (`npm install` if starting fresh)

### Environment Variables

Create a `.env` file in the project root:

```env
DATABASE_URL="postgresql://<user>:<password>@<host>.neon.tech/<dbname>?sslmode=require"
```

> **NeonDB note:** Use the **direct** (non-pooled) connection string for migrations.  
> For long-running workers, the pooled URL works fine.

### Database Migration

Run once to create all tables (`Job`, `Config`, `Worker`):

```powershell
npx prisma migrate dev --name init
```

### Running the CLI (development)

```powershell
# Via ts-node (no build required)
npx ts-node src/cli.ts --help

# Or use the npm alias
npm run dev -- --help
```

### Running the CLI (production)

```powershell
npm run build         # compiles src/ → dist/
node dist/cli.js --help
```

---

## Usage Examples

### `queuectl enqueue`

Enqueue a new job. JSON must have `id` and `command`; `max_retries` is optional.

```powershell
npx ts-node src/cli.ts enqueue '{"id":"job-1","command":"echo hello"}'
# ✔ Job enqueued successfully.
#   ID:         job-1
#   Command:    echo hello
#   MaxRetries: 3
#   State:      pending

npx ts-node src/cli.ts enqueue '{"id":"job-2","command":"node -e \"process.exit(1)\"","max_retries":2}'
```

### `queuectl worker start`

Fork background worker processes that poll for jobs.

```powershell
npx ts-node src/cli.ts worker start --count 2
# Starting 2 worker(s) (ts-node mode)...
#   ✔ Worker worker-<uuid> started (PID: 12345, log: queuectl-worker-<uuid>.log)
#   ✔ Worker worker-<uuid> started (PID: 12346, log: queuectl-worker-<uuid>.log)
```

### `queuectl worker stop`

Gracefully stop all running workers (sends SIGTERM, waits up to 20s).

```powershell
npx ts-node src/cli.ts worker stop
# Sending SIGTERM to 2 running worker(s)...
#   → SIGTERM sent to worker-<uuid> (PID: 12345)
#   → SIGTERM sent to worker-<uuid> (PID: 12346)
# Waiting up to 20s for workers to finish...
# ✔ All workers stopped successfully.
```

### `queuectl status`

Show job counts by state and worker health.

```powershell
npx ts-node src/cli.ts status

# ┌─────────────────────────────────┐
# │          Job Queue Status        │
# └─────────────────────────────────┘
#
#   Jobs by State
#   ──────────────────────────
#   State         Count
#   ──────────────────────────
#   pending       2
#   processing    1
#   completed     14
#   failed        0
#   dead          1
#   ──────────────────────────
#   Total         18
#
#   Workers
#   ──────────────────────────────────────────────────────────────────────────────────────────
#   ID                                        PID     Status      Started                Note
#   ──────────────────────────────────────────────────────────────────────────────────────────
#   worker-abc123...                          12345   running     2026-07-18 01:30:00
#   worker-def456...                          12346   running     2026-07-18 01:30:01    ⚠ stale heartbeat (15s ago)
```

### `queuectl list`

List jobs by state as a table.

```powershell
npx ts-node src/cli.ts list --state pending
npx ts-node src/cli.ts list --state completed
npx ts-node src/cli.ts list --state dead
```

### `queuectl dlq list`

List all dead (DLQ) jobs.

```powershell
npx ts-node src/cli.ts dlq list
# ☠  Dead-Letter Queue — 1 job(s)
# ID                      Command                         Attempts   MaxRetries   Last Updated
# ──────────────────────────────────────────────────────────────────────────────
# job-2                   node -e "process.exit(1)"       2          2            2026-07-18 01:35:00
```

### `queuectl dlq retry`

Re-queue a dead job (resets to `pending`, `attempts=0`, `nextRunAt=now`).

```powershell
npx ts-node src/cli.ts dlq retry job-2
# ✔ Job "job-2" has been reset to 'pending' with attempts=0 and re-queued immediately.
```

### `queuectl config set`

Set queue-wide configuration values.

```powershell
npx ts-node src/cli.ts config set max-retries 5
# ✔ Config updated:
#   Key:      max-retries
#   Previous: 3
#   New:      5

npx ts-node src/cli.ts config set backoff-base 3
```

### `queuectl --help`

```powershell
npx ts-node src/cli.ts --help
npx ts-node src/cli.ts worker --help
npx ts-node src/cli.ts dlq --help
```

---

## Architecture Overview

### Job Lifecycle

```
                      ┌─────────┐
           enqueue()  │ pending │◄─────────────────────┐
                      └────┬────┘                      │
                           │ worker claims job          │ dlq retry
                           ▼                           │
                     ┌────────────┐               ┌─────────┐
                     │ processing │               │  dead   │
                     └─────┬──────┘               └─────────┘
                    ╔══════╩═══════╗                    ▲
              exit=0║              ║exit≠0               │
                    ▼              ▼                    │
              ┌───────────┐  ┌────────┐  attempts     │
              │ completed │  │ failed │──≥ maxRetries──┘
              └───────────┘  └────┬───┘
                                  │ backoff expires
                                  ▼
                             (back to pending poll)
```

### Locking Mechanism: `FOR UPDATE SKIP LOCKED`

When a worker polls for a job, it runs a single **atomic SQL statement**:

```sql
UPDATE "Job"
SET
  state    = 'processing',
  "lockedBy"  = $1,           -- worker ID
  "lockedAt"  = NOW(),
  "updatedAt" = NOW()
WHERE id = (
  SELECT id FROM "Job"
  WHERE state IN ('pending', 'failed')
    AND "nextRunAt" <= NOW()
  ORDER BY "nextRunAt" ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED      -- skip rows locked by other workers
)
RETURNING id, command, attempts, "maxRetries"
```

**Why this works:**
- `FOR UPDATE` acquires a row-level exclusive lock on the candidate row.
- `SKIP LOCKED` means other concurrent workers **skip** any row already locked — they don't wait or fail; they just pick the next available row.
- Because this is a single SQL statement, the check-and-claim is fully **atomic** — no two workers can claim the same job.

### Worker Process Model

```
CLI Process (short-lived)
│
├── queuectl worker start --count 2
│     ├── fork() → Worker A (detached, PID saved to DB)
│     └── fork() → Worker B (detached, PID saved to DB)
│
└── exits immediately (workers run in background)

Worker A / Worker B (long-lived daemons)
│
├── heartbeat loop (every 5s) → updates Worker.updatedAt in DB
│
└── poll loop (every 1s when idle)
      ├── claimJob() → atomic SQL → get job or null
      ├── if job: exec command, capture output
      │    ├── success → state='completed'
      │    └── failure → attempts++
      │         ├── attempts < maxRetries → state='failed', nextRunAt=now+backoff
      │         └── attempts ≥ maxRetries → state='dead'
      └── if no job: sleep 1s, retry
```

### Retry / Backoff Formula

```
delay (seconds) = backoffBase ^ attempts
```

With `backoffBase=2`:

| Attempt | Delay   |
|---------|---------|
| 1       | 2s      |
| 2       | 4s      |
| 3       | 8s      |
| 4       | 16s     |

---

## Assumptions & Trade-offs

| Topic | Decision | Rationale |
|-------|----------|-----------|
| **Duplicate ID rejection** | Hard error on duplicate `id` | IDs are caller-controlled; silently ignoring re-enqueue could hide bugs |
| **DLQ retry resets attempts** | `attempts` → 0 on `dlq retry` | Gives the job a full fresh retry budget; partial budget would be confusing |
| **Polling interval** | 1 second when idle | Simple trade-off between latency and DB query load; configurable via code |
| **Detached workers** | Workers fork with `detached: true` + `unref()` | Allows the CLI to exit while workers keep running as background processes |
| **Worker log files** | Each worker writes to `queuectl-<workerId>.log` | Prevents mixed output in terminal; inspect logs with `Get-Content -Wait` |
| **NeonDB pooled vs direct** | Direct URL for migrations; pooled acceptable for workers | NeonDB's pooler may reject `FOR UPDATE SKIP LOCKED` in some configurations; direct is safest |
| **SIGTERM on Windows** | Node.js `process.kill(pid, 'SIGTERM')` | Node.js emulates SIGTERM for forked child processes on Windows |
| **`max-retries` from Config** | Default=3 if not set in DB | Avoids hardcoding defaults in the worker; operator can change via `config set` |

---

## Testing Instructions

### Prerequisites

Ensure the `.env` file is set with a valid `DATABASE_URL` and the migration has been applied.

### Run E2E Tests

```powershell
npm run test:e2e
# or directly:
npx ts-node test/e2e.ts
```

### What the Tests Cover

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | Job with `echo hello` (or `node -e`) | Reaches `completed` state; output captured |
| 2 | Job with `process.exit(1)`, `max_retries=2` | Reaches `dead` after exactly 2 attempts |
| 3 | Non-existent binary as command | Reaches `dead` gracefully; worker does not crash |
| 4 | 6 jobs + 2 workers | All jobs complete; `lockedBy` null (no double-execution) |
| 5 | Job enqueued → workers stopped → restarted | Job eventually completes after restart cycle |

### Inspect Worker Logs

```powershell
# Follow a worker's log in real time
Get-Content -Wait queuectl-worker-<uuid>.log
```

### Manual Smoke Test

```powershell
# 1. Enqueue a job
npx ts-node src/cli.ts enqueue '{"id":"smoke-1","command":"echo smoke test"}'

# 2. Start a worker
npx ts-node src/cli.ts worker start --count 1

# 3. Check status (wait a moment)
Start-Sleep 3
npx ts-node src/cli.ts status

# 4. Verify job completed
npx ts-node src/cli.ts list --state completed

# 5. Stop the worker
npx ts-node src/cli.ts worker stop
```
