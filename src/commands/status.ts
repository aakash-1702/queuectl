// src/commands/status.ts — Print job counts by state and worker counts by status
import { prisma } from "../db";
import type { JobState, WorkerStatus } from "@prisma/client";

const STALE_THRESHOLD_MS = 10_000; // 10 seconds without a heartbeat = possibly dead

const ALL_JOB_STATES: JobState[] = [
  "pending",
  "processing",
  "completed",
  "failed",
  "dead",
];

const ALL_WORKER_STATUSES: WorkerStatus[] = ["running", "stopping", "stopped"];

export async function status(): Promise<void> {
  const [jobCounts, workers] = await Promise.all([
    prisma.job.groupBy({ by: ["state"], _count: { id: true } }),
    prisma.worker.findMany({ orderBy: { startedAt: "asc" } }),
  ]);

  // --- Job table ---
  const countMap = new Map<JobState, number>(
    jobCounts.map((j) => [j.state, j._count.id])
  );

  console.log("\n┌─────────────────────────────────┐");
  console.log("│          Job Queue Status        │");
  console.log("└─────────────────────────────────┘\n");

  console.log("  Jobs by State");
  console.log("  " + "─".repeat(26));
  console.log("  " + pad("State", 14) + pad("Count", 10));
  console.log("  " + "─".repeat(26));

  let total = 0;
  for (const state of ALL_JOB_STATES) {
    const cnt = countMap.get(state) ?? 0;
    total += cnt;
    console.log("  " + pad(state, 14) + pad(String(cnt), 10));
  }
  console.log("  " + "─".repeat(26));
  console.log("  " + pad("Total", 14) + pad(String(total), 10));

  // --- Worker table ---
  console.log("\n  Workers");
  console.log("  " + "─".repeat(90));
  console.log(
    "  " +
      pad("ID", 42) +
      pad("PID", 8) +
      pad("Status", 12) +
      pad("Started", 22) +
      "Note"
  );
  console.log("  " + "─".repeat(90));

  const now = Date.now();

  if (workers.length === 0) {
    console.log("  (no workers registered)");
  } else {
    for (const w of workers) {
      const ageMs = now - new Date(w.updatedAt).getTime();
      const isStale = w.status === "running" && ageMs > STALE_THRESHOLD_MS;
      const note = isStale
        ? `⚠ stale heartbeat (${Math.round(ageMs / 1000)}s ago)`
        : "";

      console.log(
        "  " +
          pad(w.id, 42) +
          pad(String(w.pid), 8) +
          pad(w.status, 12) +
          pad(w.startedAt.toISOString().replace("T", " ").slice(0, 19), 22) +
          note
      );
    }
  }

  // Worker count summary
  const wCountMap = new Map<WorkerStatus, number>();
  for (const w of workers) {
    wCountMap.set(w.status, (wCountMap.get(w.status) ?? 0) + 1);
  }

  console.log("  " + "─".repeat(90));
  for (const st of ALL_WORKER_STATUSES) {
    const cnt = wCountMap.get(st) ?? 0;
    if (cnt > 0) {
      console.log(`  ${st}: ${cnt}`);
    }
  }
  console.log("");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width - 1) + " " : s.padEnd(width);
}
