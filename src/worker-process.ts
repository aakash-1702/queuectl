// src/worker-process.ts — Polling worker loop with atomic job claim, exec, retry/backoff/DLQ, graceful shutdown

// ---------------------------------------------------------------------------
// Global error visibility — must be first so no crash is ever silent
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  console.error(`[worker] uncaughtException:`, err);
});
process.on("unhandledRejection", (err) => {
  console.error(`[worker] unhandledRejection:`, err);
});

import "dotenv/config";
import { exec } from "child_process";
import { promisify } from "util";
import { prisma } from "./db";
import { getConfig } from "./config";

const execAsync = promisify(exec);

const WORKER_ID = process.env["WORKER_ID"] ?? `worker-standalone-${process.pid}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 5000;

let shuttingDown = false;
let processingJob = false;

// ---------------------------------------------------------------------------
// Atomic job claim via raw SQL with FOR UPDATE SKIP LOCKED
// ---------------------------------------------------------------------------
interface ClaimedJob {
  id: string;
  command: string;
  attempts: number;
  maxRetries: number;
}

async function claimJob(): Promise<ClaimedJob | null> {
  const result = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "Job"
    SET
      state    = 'processing',
      "lockedBy"  = ${WORKER_ID},
      "lockedAt"  = NOW(),
      "updatedAt" = NOW()
    WHERE id = (
      SELECT id FROM "Job"
      WHERE state IN ('pending', 'failed')
        AND "nextRunAt" <= NOW()
      ORDER BY "nextRunAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, command, attempts, "maxRetries"
  `;

  return result[0] ?? null;
}

// ---------------------------------------------------------------------------
// Execute a job and handle success / failure / retry / DLQ
// ---------------------------------------------------------------------------
async function runJob(job: ClaimedJob): Promise<void> {
  processingJob = true;
  console.log(`[${WORKER_ID}] ▶ Running job ${job.id}: ${job.command}`);

  try {
    const { stdout, stderr } = await execAsync(job.command);
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");

    await prisma.job.update({
      where: { id: job.id },
      data: { state: "completed", output, lockedBy: null, lockedAt: null },
    });

    console.log(`[${WORKER_ID}] ✔ Job ${job.id} completed.`);
  } catch (err: unknown) {
    // Non-zero exit or exec failure
    const attempts = job.attempts + 1;

    let errorOutput = "";
    if (err instanceof Error) {
      const execErr = err as Error & { stderr?: string; stdout?: string };
      errorOutput = [execErr.stderr?.trim(), execErr.message]
        .filter(Boolean)
        .join("\n");
    } else {
      errorOutput = String(err);
    }

    const backoffBaseStr = await getConfig("backoff-base", "2");
    const backoffBase = parseFloat(backoffBaseStr);
    const safeBase = isNaN(backoffBase) || backoffBase <= 0 ? 2 : backoffBase;

    if (attempts >= job.maxRetries) {
      // Move to dead-letter queue
      await prisma.job.update({
        where: { id: job.id },
        data: { state: "dead", attempts, output: errorOutput },
      });
      console.log(
        `[${WORKER_ID}] ✘ Job ${job.id} moved to DLQ after ${attempts} attempt(s).`
      );
    } else {
      // Exponential backoff: delay = backoffBase^attempts (seconds)
      const delaySec = Math.pow(safeBase, attempts);
      const nextRunAt = new Date(Date.now() + delaySec * 1000);

      await prisma.job.update({
        where: { id: job.id },
        data: {
          state: "failed",
          attempts,
          output: errorOutput,
          nextRunAt,
          lockedBy: null,
          lockedAt: null,
        },
      });
      console.log(
        `[${WORKER_ID}] ✘ Job ${job.id} failed (attempt ${attempts}/${job.maxRetries}). ` +
          `Retrying in ${delaySec.toFixed(1)}s.`
      );
    }
  } finally {
    processingJob = false;
  }
}

// ---------------------------------------------------------------------------
// Main polling loop
// ---------------------------------------------------------------------------
async function poll(): Promise<void> {
  while (!shuttingDown) {
    try {
      const job = await claimJob();
      if (job) {
        await runJob(job);
      } else {
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (err) {
      console.error(`[${WORKER_ID}] Poll error:`, err);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat: keep Worker.updatedAt fresh so status command can detect staleness
// ---------------------------------------------------------------------------
async function heartbeat(): Promise<void> {
  while (!shuttingDown) {
    await sleep(HEARTBEAT_INTERVAL_MS);
    if (shuttingDown) break;
    try {
      await prisma.worker.update({
        where: { id: WORKER_ID },
        data: { status: "running" }, // triggers @updatedAt
      });
    } catch {
      // Worker row may not exist yet (race at startup) — harmless
    }
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown on SIGTERM
// ---------------------------------------------------------------------------
async function shutdown(): Promise<void> {
  console.log(
    `[${WORKER_ID}] SIGTERM received. Finishing current job before exiting...`
  );
  shuttingDown = true;

  // Wait for any in-flight job to finish (max 30s)
  const deadline = Date.now() + 30_000;
  while (processingJob && Date.now() < deadline) {
    await sleep(200);
  }
  if (processingJob) {
    console.warn(`[${WORKER_ID}] Timed out waiting for job to finish.`);
  }

  // Mark this worker stopped in the DB
  try {
    await prisma.worker.update({
      where: { id: WORKER_ID },
      data: { status: "stopped" },
    });
  } catch {
    // Worker row may not exist in standalone mode
  }

  await prisma.$disconnect();
  console.log(`[${WORKER_ID}] Stopped gracefully.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
process.on("SIGTERM", () => {
  void shutdown();
});

console.log(`[${WORKER_ID}] Starting (PID ${process.pid})...`);
void heartbeat();
void poll();
