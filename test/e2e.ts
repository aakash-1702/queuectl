/**
 * test/e2e.ts — QueueCTL End-to-End Demo & Test Suite
 *
 * Run with:  npx ts-node test/e2e.ts
 *
 * No test framework — plain assert() + clear console output per scenario.
 * Uses the real Prisma client (src/db.ts) and forks real worker processes
 * (src/worker-process.ts) via ts-node/register.
 *
 * NOTE: Uses `node -e "..."` for sleep/exit commands to stay cross-platform
 * (works on Windows cmd.exe, macOS, Linux).
 */

import assert from "assert";
import { fork, ChildProcess } from "child_process";
import * as path from "path";
import { randomUUID } from "crypto";
import { prisma } from "../src/db";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface WorkerHandle {
  child: ChildProcess;
  workerId: string;
  pid: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Delete all Job and Worker rows so the script is idempotent across re-runs. */
async function resetDb(): Promise<void> {
  await prisma.job.deleteMany();
  await prisma.worker.deleteMany();
  console.log("  [DB] All Job and Worker rows cleared.\n");
}

/**
 * Poll the DB every 500 ms until the job reaches `targetState`.
 * Throws a descriptive assertion error on timeout.
 */
async function waitForJobState(
  id: string,
  targetState: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await prisma.job.findUnique({ where: { id } });
    if (job?.state === targetState) return;
    await sleep(500);
  }
  const job = await prisma.job.findUnique({ where: { id } });
  assert.fail(
    `Timed out after ${timeoutMs}ms waiting for job "${id}" → state="${targetState}". ` +
      `Current state: "${job?.state ?? "NOT FOUND"}"`
  );
}

/**
 * Fork a worker-process.ts instance via tsx, register it in the DB,
 * and return a handle with the child process reference + workerId + pid.
 */
async function spawnWorker(): Promise<WorkerHandle> {
  const workerId = `e2e-worker-${randomUUID()}`;
  const workerScript = path.resolve(__dirname, "../src/worker-process.ts");

  const child = fork(workerScript, [], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, WORKER_ID: workerId },
    detached: false, // stay in same process group for easy lifecycle management
    stdio: ["inherit", "inherit", "inherit", "ipc"], // visible startup errors
  });

  const pid = child.pid ?? 0;

  // Surface any startup crash immediately in the terminal
  child.on("error", (err) =>
    console.error(`[e2e-worker ${pid}] failed to start:`, err)
  );
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
      console.error(`[e2e-worker ${pid}] unexpected exit — code=${code} signal=${signal}`);
    }
  });

  // Create Worker row BEFORE the heartbeat fires so stop/status logic works
  await prisma.worker.create({
    data: { id: workerId, pid, status: "running" },
  });

  return { child, workerId, pid };
}

/**
 * Gracefully stop a worker by sending an IPC { type: 'shutdown' } message and
 * waiting for its exit event. Works cross-platform (no OS signals needed).
 * Times out after 10 s as a safety net.
 */
async function stopWorker(handle: WorkerHandle): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 10_000); // safety net

    handle.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    // Use IPC instead of SIGTERM — works reliably on Windows
    if (handle.child.connected) {
      handle.child.send({ type: "shutdown" }, (err) => {
        if (err) {
          // IPC send failed — fall back to SIGTERM
          console.warn(`[stopWorker] IPC send failed, falling back to SIGTERM:`, err);
          try {
            process.kill(handle.pid, "SIGTERM");
          } catch {
            clearTimeout(timer);
            resolve(); // already dead
          }
        }
      });
    } else {
      // No IPC channel (e.g. already disconnected) — fall back to SIGTERM
      try {
        process.kill(handle.pid, "SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve(); // already dead
      }
    }
  });
}


/** Hard-kill a worker (SIGKILL) — simulates a crash, no graceful shutdown. */
function killWorker(handle: WorkerHandle): void {
  try {
    process.kill(handle.pid, "SIGKILL");
  } catch {
    // Already dead — ignore
  }
}

/** Returns true if a process with the given PID is currently alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario runner
// ─────────────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  n: number;
  description: string;
  passed: boolean;
  error?: string;
}

const results: ScenarioResult[] = [];

async function runScenario(
  n: number,
  description: string,
  fn: () => Promise<void>
): Promise<void> {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  Scenario ${n}: ${description}`);
  console.log("─".repeat(64));

  try {
    await fn();
    console.log(`\n✅ Scenario ${n} passed: ${description}`);
    results.push({ n, description, passed: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Scenario ${n} FAILED: ${description}`);
    console.error(`   → ${msg}`);
    results.push({ n, description, passed: false, error: msg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║           QueueCTL E2E Demo & Test Suite                     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  console.log("Resetting database (ensures idempotent re-runs)...");
  await resetDb();

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 1 — Basic success
  // ───────────────────────────────────────────────────────────────────────────
  await runScenario(1, "Basic success — echo hello world", async () => {
    await prisma.job.create({
      data: { id: "e2e-1", command: "echo hello world" },
    });
    console.log('  Enqueued job "e2e-1": echo hello world');

    const w = await spawnWorker();
    console.log(`  Worker spawned (PID: ${w.pid})`);

    // Wait for completion (10 s timeout)
    await waitForJobState("e2e-1", "completed", 10_000);

    const job = await prisma.job.findUnique({ where: { id: "e2e-1" } });
    assert.strictEqual(job?.state, "completed", "state should be completed");
    assert(
      job?.output?.toLowerCase().includes("hello world"),
      `output should contain "hello world", got: "${job?.output}"`
    );
    console.log(`  ✔ state=completed  output="${job!.output?.trim()}"`);

    // Stop worker and verify it reports 'stopped' in the DB
    await stopWorker(w);
    await sleep(500); // allow DB write to propagate

    const workerRow = await prisma.worker.findUnique({ where: { id: w.workerId } });
    assert.strictEqual(
      workerRow?.status,
      "stopped",
      `Worker should show status=stopped, got: ${workerRow?.status}`
    );
    console.log("  ✔ Worker shut down cleanly (DB status=stopped)");

    // Cleanup
    await prisma.job.deleteMany({ where: { id: "e2e-1" } });
    await prisma.worker.deleteMany({ where: { id: w.workerId } });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 2 — Retry → DLQ
  // ───────────────────────────────────────────────────────────────────────────
  await runScenario(2, "Retry → DLQ — failing job exhausts max_retries", async () => {
    // node -e "process.exit(1)" is cross-platform (works on Windows + Unix)
    await prisma.job.create({
      data: {
        id: "e2e-2",
        command: 'node -e "process.exit(1)"',
        maxRetries: 2,
      },
    });
    console.log('  Enqueued job "e2e-2": node -e "process.exit(1)", maxRetries=2');

    const w = await spawnWorker();
    console.log(`  Worker spawned (PID: ${w.pid})`);

    // backoff delays: 2^1=2s + 2^2=4s = 6s of sleep + processing overhead
    // Give 25 s to be safe
    await waitForJobState("e2e-2", "dead", 25_000);

    const job = await prisma.job.findUnique({ where: { id: "e2e-2" } });
    assert.strictEqual(job?.state, "dead", "Job should be in DLQ (state=dead)");
    assert.strictEqual(
      job?.attempts,
      2,
      `Expected attempts=2, got ${job?.attempts}`
    );
    console.log(`  ✔ state=dead  attempts=${job!.attempts} (maxRetries=2 exhausted)`);

    // Verify DLQ query: job should appear when filtering state=dead
    const deadJobs = await prisma.job.findMany({ where: { state: "dead" } });
    assert(
      deadJobs.some((j) => j.id === "e2e-2"),
      'DLQ list query should return job "e2e-2"'
    );
    console.log(`  ✔ Job visible in DLQ list (${deadJobs.length} dead job(s) total)`);

    await stopWorker(w);
    await prisma.job.deleteMany({ where: { id: "e2e-2" } });
    await prisma.worker.deleteMany({ where: { id: w.workerId } });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 3 — Invalid command fails gracefully (worker does NOT crash)
  // ───────────────────────────────────────────────────────────────────────────
  await runScenario(3, "Invalid command — worker survives, job lands in dead", async () => {
    await prisma.job.create({
      data: {
        id: "e2e-3",
        command: "this-command-does-not-exist-xyz",
        maxRetries: 1,
      },
    });
    console.log("  Enqueued job with non-existent command (maxRetries=1)");

    const w = await spawnWorker();
    console.log(`  Worker spawned (PID: ${w.pid})`);

    // maxRetries=1 → 1 attempt → dead immediately (backoff 2^1=2s)
    // Give 15 s
    await waitForJobState("e2e-3", "dead", 15_000);

    const job = await prisma.job.findUnique({ where: { id: "e2e-3" } });
    assert(
      job?.state === "dead" || job?.state === "failed",
      `Expected dead or failed, got: "${job?.state}"`
    );
    console.log(`  ✔ Job state="${job!.state}" (not stuck in processing)`);

    // Confirm worker process is still alive (did NOT crash on exec error)
    const alive = isProcessAlive(w.pid);
    assert(alive, `Worker PID ${w.pid} should still be alive after exec failure`);
    console.log(`  ✔ Worker process (PID: ${w.pid}) is still running — did not crash`);

    // Worker DB row should still show running (heartbeat still firing)
    const workerRow = await prisma.worker.findUnique({ where: { id: w.workerId } });
    assert(
      workerRow?.status === "running" || workerRow?.status === "stopping",
      `Worker DB status should be running/stopping, got: "${workerRow?.status}"`
    );
    console.log(`  ✔ Worker DB status="${workerRow!.status}" (healthy)`);

    await stopWorker(w);
    await prisma.job.deleteMany({ where: { id: "e2e-3" } });
    await prisma.worker.deleteMany({ where: { id: w.workerId } });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 4 — Multiple workers, no duplicate processing
  // ───────────────────────────────────────────────────────────────────────────
  await runScenario(4, "3 workers process 10 jobs — no duplicate claiming", async () => {
    const JOB_COUNT = 10;
    const jobIds = Array.from({ length: JOB_COUNT }, (_, i) => `e2e-4-${i}`);

    // Use node setTimeout for a ~500ms job so workers overlap in time
    for (const id of jobIds) {
      await prisma.job.create({
        data: { id, command: 'node -e "setTimeout(()=>{},500)"' },
      });
    }
    console.log(`  Enqueued ${JOB_COUNT} jobs (each ~500ms runtime)`);

    const workers = await Promise.all([spawnWorker(), spawnWorker(), spawnWorker()]);
    console.log(`  3 workers spawned (PIDs: ${workers.map((w) => w.pid).join(", ")})`);

    // ── Dual-mode check ────────────────────────────────────────────────────
    // During processing, capture lockedBy assignments to detect any overlap.
    // After completion lockedBy is cleared, so we sample while jobs run.
    const lockedByHistory = new Map<string, Set<string>>(); // jobId → set of workerIds seen

    const deadline = Date.now() + 30_000;
    let allDone = false;

    while (Date.now() < deadline) {
      const jobs = await prisma.job.findMany({
        where: { id: { startsWith: "e2e-4-" } },
      });

      // Record any active lockedBy assignments
      for (const job of jobs) {
        if (job.lockedBy) {
          if (!lockedByHistory.has(job.id)) lockedByHistory.set(job.id, new Set());
          lockedByHistory.get(job.id)!.add(job.lockedBy);
        }
      }

      if (jobs.length === JOB_COUNT && jobs.every((j) => j.state === "completed")) {
        allDone = true;
        break;
      }
      await sleep(400);
    }

    assert(allDone, `All ${JOB_COUNT} jobs should reach 'completed' within 30s`);
    console.log(`  ✔ All ${JOB_COUNT} jobs completed`);

    // Assert: no single job was ever locked by more than one worker
    let duplicateClaims = 0;
    for (const [jobId, workerSet] of lockedByHistory) {
      if (workerSet.size > 1) {
        console.error(
          `  ✘ Duplicate claim on job "${jobId}" — locked by: ${[...workerSet].join(", ")}`
        );
        duplicateClaims++;
      }
    }
    assert.strictEqual(
      duplicateClaims,
      0,
      `${duplicateClaims} job(s) were claimed by more than one worker — FOR UPDATE SKIP LOCKED failed`
    );
    console.log(
      "  ✔ No duplicate claiming detected (FOR UPDATE SKIP LOCKED works correctly)"
    );

    // Assert: total processed = JOB_COUNT, each in completed
    const finalJobs = await prisma.job.findMany({
      where: { id: { startsWith: "e2e-4-" } },
    });
    assert.strictEqual(finalJobs.length, JOB_COUNT, `Should have ${JOB_COUNT} job rows`);
    assert(
      finalJobs.every((j) => j.state === "completed"),
      "All jobs should be in completed state"
    );
    console.log(
      `  ✔ Distribution confirmed: ${JOB_COUNT}/${JOB_COUNT} completed across 3 workers`
    );

    await Promise.all(workers.map(stopWorker));
    await prisma.job.deleteMany({ where: { id: { startsWith: "e2e-4-" } } });
    await prisma.worker.deleteMany({ where: { id: { in: workers.map((w) => w.workerId) } } });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 5 — Persistence across hard worker crash (SIGKILL)
  // ───────────────────────────────────────────────────────────────────────────
  await runScenario(
    5,
    "Persistence across hard crash — job survives SIGKILL, completes after restart",
    async () => {
      // 2-second job gives us a window to SIGKILL before it finishes
      await prisma.job.create({
        data: { id: "e2e-5", command: 'node -e "setTimeout(()=>{},2000)"' },
      });
      console.log('  Enqueued slow job "e2e-5" (~2 s runtime)');

      const w1 = await spawnWorker();
      console.log(`  Worker 1 spawned (PID: ${w1.pid})`);

      // Wait for the worker to claim the job
      await waitForJobState("e2e-5", "processing", 10_000);
      console.log('  ✔ Job is in "processing" state — worker has claimed it');

      // Simulate a hard crash (no graceful shutdown, no SIGTERM)
      killWorker(w1);
      await sleep(600); // Let the OS reap the process
      console.log(`  ✔ Worker 1 killed with SIGKILL (crash simulated)`);

      // ── Core assertion: job row persists in DB after crash ───────────────
      const jobAfterCrash = await prisma.job.findUnique({ where: { id: "e2e-5" } });
      assert(jobAfterCrash !== null, "Job row must still exist after worker crash");
      assert.strictEqual(
        jobAfterCrash.state,
        "processing",
        `Job should still be "processing" (orphaned lock), got: "${jobAfterCrash.state}"`
      );
      console.log(
        `  ✔ Job persisted in DB with state="processing" — data not lost after crash`
      );

      // ── Stale-lock note ──────────────────────────────────────────────────
      // This system does NOT implement an automatic stale-lock sweep.
      // A job stuck in "processing" with no live worker requires operator recovery:
      //   queuectl dlq retry <id>  (only works for dead jobs)
      //   or a direct DB reset:   UPDATE Job SET state='pending' WHERE id='...'
      // This trade-off is documented in README § Assumptions & Trade-offs.
      console.log(
        "  ⚠ NOTE: No automatic stale-lock recovery — resetting job manually to 'pending'"
      );

      await prisma.job.update({
        where: { id: "e2e-5" },
        data: {
          state: "pending",
          lockedBy: null,
          lockedAt: null,
          nextRunAt: new Date(),
        },
      });
      console.log("  ✔ Job manually reset to state=pending (operator recovery step)");

      // ── Start a new worker and verify the job is picked up ───────────────
      const w2 = await spawnWorker();
      console.log(`  Worker 2 spawned (PID: ${w2.pid})`);

      await waitForJobState("e2e-5", "completed", 10_000);
      const jobAfterRestart = await prisma.job.findUnique({ where: { id: "e2e-5" } });
      assert.strictEqual(
        jobAfterRestart?.state,
        "completed",
        "Job should complete after manual reset + new worker"
      );
      console.log("  ✔ Job completed by Worker 2 after operator-assisted recovery");

      // Cleanup
      await stopWorker(w2);
      // w1 Worker row is orphaned (SIGKILL skipped graceful shutdown) — mark stopped
      await prisma.worker
        .update({ where: { id: w1.workerId }, data: { status: "stopped" } })
        .catch(() => {/* row may already be clean */});
      await prisma.job.deleteMany({ where: { id: "e2e-5" } });
      await prisma.worker.deleteMany({ where: { id: { in: [w1.workerId, w2.workerId] } } });
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Final summary
  // ─────────────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  console.log(`\n${"═".repeat(64)}`);
  console.log(`  QueueCTL E2E Suite — ${passed}/${total} scenarios passed`);
  console.log("═".repeat(64));

  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`  ${icon}  Scenario ${r.n}: ${r.description}`);
    if (r.error) {
      console.log(`         ↳ ${r.error}`);
    }
  }
  console.log("");

  await prisma.$disconnect();
  process.exit(passed < total ? 1 : 0);
}

main().catch(async (err) => {
  console.error("\nFATAL: Test suite crashed unexpectedly:", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
