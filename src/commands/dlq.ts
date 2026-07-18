// src/commands/dlq.ts — Dead-letter queue: list dead jobs, retry a dead job by id
import { prisma } from "../db";

export async function dlqList(): Promise<void> {
  const jobs = await prisma.job.findMany({
    where: { state: "dead" },
    orderBy: { updatedAt: "desc" },
  });

  if (jobs.length === 0) {
    console.log("Dead-letter queue is empty. No dead jobs found.");
    return;
  }

  const W = { id: 24, command: 32, attempts: 10, maxRetries: 11, updatedAt: 22 };
  const header =
    pad("ID",         W.id) +
    pad("Command",    W.command) +
    pad("Attempts",   W.attempts) +
    pad("MaxRetries", W.maxRetries) +
    "Last Updated";

  const divider = "─".repeat(
    Object.values(W).reduce((a, b) => a + b, 0) + 16
  );

  console.log(`\n  ☠  Dead-Letter Queue — ${jobs.length} job(s)`);
  console.log("  " + divider);
  console.log("  " + header);
  console.log("  " + divider);

  for (const job of jobs) {
    console.log(
      "  " +
        pad(job.id,                 W.id) +
        pad(job.command,            W.command) +
        pad(String(job.attempts),   W.attempts) +
        pad(String(job.maxRetries), W.maxRetries) +
        fmt(job.updatedAt)
    );
  }

  console.log("  " + divider);
  console.log(
    `\n  Tip: use 'queuectl dlq retry <id>' to re-queue a dead job.\n`
  );
}

export async function dlqRetry(id: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id } });

  if (!job) {
    console.error(`ERROR: Job "${id}" not found.`);
    process.exit(1);
  }

  if (job.state !== "dead") {
    console.error(
      `ERROR: Job "${id}" is not in 'dead' state (current state: ${job.state}). ` +
        `Only dead jobs can be retried via dlq retry.`
    );
    process.exit(1);
  }

  await prisma.job.update({
    where: { id },
    data: {
      state:     "pending",
      attempts:  0,
      nextRunAt: new Date(),
      lockedBy:  null,
      lockedAt:  null,
      output:    null,
    },
  });

  console.log(
    `✔ Job "${id}" has been reset to 'pending' with attempts=0 and re-queued immediately.`
  );
}

function pad(s: string, width: number): string {
  const truncated = s.length >= width ? s.slice(0, width - 2) + "… " : s;
  return truncated.padEnd(width);
}

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}
