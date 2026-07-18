// src/commands/list.ts — List jobs filtered by state as a table
import { prisma } from "../db";
import type { JobState } from "@prisma/client";

const VALID_STATES: JobState[] = [
  "pending",
  "processing",
  "completed",
  "failed",
  "dead",
];

export async function list(state: string): Promise<void> {
  if (!VALID_STATES.includes(state as JobState)) {
    console.error(
      `ERROR: Invalid state "${state}". Valid values: ${VALID_STATES.join(", ")}`
    );
    process.exit(1);
  }

  const jobs = await prisma.job.findMany({
    where: { state: state as JobState },
    orderBy: { createdAt: "asc" },
  });

  if (jobs.length === 0) {
    console.log(`No jobs with state "${state}".`);
    return;
  }

  // Column widths
  const W = {
    id:         24,
    command:    28,
    state:      12,
    attempts:    9,
    maxRetries: 11,
    nextRunAt:  22,
    updatedAt:  22,
  };

  const header =
    pad("ID",         W.id) +
    pad("Command",    W.command) +
    pad("State",      W.state) +
    pad("Attempts",   W.attempts) +
    pad("MaxRetries", W.maxRetries) +
    pad("NextRunAt",  W.nextRunAt) +
    "UpdatedAt";

  const divider = "─".repeat(
    Object.values(W).reduce((a, b) => a + b, 0) + 20
  );

  console.log(`\n  Jobs — state: ${state} (${jobs.length} total)`);
  console.log("  " + divider);
  console.log("  " + header);
  console.log("  " + divider);

  for (const job of jobs) {
    const row =
      pad(job.id,                         W.id) +
      pad(job.command,                    W.command) +
      pad(job.state,                      W.state) +
      pad(String(job.attempts),           W.attempts) +
      pad(String(job.maxRetries),         W.maxRetries) +
      pad(fmt(job.nextRunAt),             W.nextRunAt) +
      fmt(job.updatedAt);
    console.log("  " + row);
  }

  console.log("  " + divider + "\n");
}

function pad(s: string, width: number): string {
  const truncated = s.length >= width ? s.slice(0, width - 2) + "… " : s;
  return truncated.padEnd(width);
}

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}
