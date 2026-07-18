// src/commands/workerStop.ts — Signal workers via DB (cross-platform) and wait for stopped status
import { prisma } from "../db";

const STOP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

export async function workerStop(): Promise<void> {
  const workers = await prisma.worker.findMany({
    where: { status: "running" },
  });

  if (workers.length === 0) {
    console.log("No running workers found.");
    return;
  }

  console.log(`Sending shutdown signal to ${workers.length} running worker(s)...`);

  const signalled: string[] = [];

  for (const worker of workers) {
    try {
      // Set status to 'stopping' — the worker's heartbeat loop detects this via the DB
      // and initiates a graceful shutdown. This is cross-platform (no OS signals needed).
      await prisma.worker.update({
        where: { id: worker.id },
        data: { status: "stopping" },
      });
      signalled.push(worker.id);
      console.log(`  → Shutdown signal sent to ${worker.id} (PID: ${worker.pid})`);
    } catch (err) {
      // Row may already be gone — mark stopped
      console.warn(
        `  ⚠ Could not signal ${worker.id} (PID: ${worker.pid}): ${String(err)}`
      );
      await prisma.worker.update({
        where: { id: worker.id },
        data: { status: "stopped" },
      }).catch(() => {/* already gone */});
    }
  }

  if (signalled.length === 0) {
    console.log("All workers were already gone — marked stopped.");
    return;
  }

  // Poll DB until all signalled workers flip to 'stopped' or we time out
  console.log(`Waiting up to ${STOP_TIMEOUT_MS / 1000}s for workers to finish...`);

  let remaining = [...signalled];
  const deadline = Date.now() + STOP_TIMEOUT_MS;

  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const rows = await prisma.worker.findMany({
      where: { id: { in: remaining } },
      select: { id: true, status: true },
    });

    remaining = rows
      .filter((r) => r.status !== "stopped")
      .map((r) => r.id);
  }

  if (remaining.length > 0) {
    console.warn(
      `⚠ ${remaining.length} worker(s) did not stop within the timeout:\n` +
        remaining.map((id) => `  - ${id}`).join("\n")
    );
  } else {
    console.log("✔ All workers stopped successfully.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
