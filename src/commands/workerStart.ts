// src/commands/workerStart.ts — Fork n worker-process instances, insert Worker rows
import { fork } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { prisma } from "../db";

export async function workerStart(count: number): Promise<void> {
  // Detect whether we are running as TypeScript (tsx) or compiled JS
  const isTs = __filename.endsWith(".ts");

  const workerScript = isTs
    ? path.join(__dirname, "../worker-process.ts")
    : path.join(__dirname, "../worker-process.js");

  const forkExecArgv = isTs
    ? ["--import", "tsx"]
    : ([] as string[]);

  console.log(`Starting ${count} worker(s) (${isTs ? "tsx" : "compiled JS"} mode)...`);

  for (let i = 0; i < count; i++) {
    const workerId = `worker-${randomUUID()}`;

    // Open a log file for the worker's stdout/stderr
    const logPath = path.resolve(`queuectl-${workerId}.log`);
    const logFd = fs.openSync(logPath, "a");

    const child = fork(workerScript, [], {
      execArgv: forkExecArgv,
      env: { ...process.env, WORKER_ID: workerId },
      detached: true,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });

    const pid = child.pid ?? 0;

    // Surface startup crashes immediately in the parent terminal
    child.on("error", (err) =>
      console.error(`[worker ${pid}] failed to start:`, err)
    );
    child.on("exit", (code, signal) =>
      console.log(`[worker ${pid}] exited — code=${code} signal=${signal}`)
    );

    // Create the Worker row in DB BEFORE unref so the heartbeat finds it
    await prisma.worker.create({
      data: { id: workerId, pid, status: "running" },
    });

    child.unref();        // Allow this CLI process to exit independently
    fs.closeSync(logFd);  // Parent no longer needs the fd

    console.log(
      `  ✔ Worker ${workerId} started (PID: ${pid}, log: ${path.basename(logPath)})`
    );
  }
}
