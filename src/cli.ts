#!/usr/bin/env node
// src/cli.ts — Entry point for the QueueCTL CLI (commander wiring)
import { Command } from "commander";
import { enqueue }             from "./commands/enqueue";
import { workerStart }         from "./commands/workerStart";
import { workerStop }          from "./commands/workerStop";
import { status }              from "./commands/status";
import { list }                from "./commands/list";
import { dlqList, dlqRetry }   from "./commands/dlq";
import { configSet }           from "./commands/configSet";

const program = new Command();

program
  .name("queuectl")
  .description(
    "QueueCTL — CLI-based background job queue system (Node.js + TypeScript + Prisma + PostgreSQL)"
  )
  .version("1.0.0");

// ─── queuectl enqueue '<json>' ───────────────────────────────────────────────
program
  .command("enqueue <json>")
  .description(
    "Enqueue a new job.\n" +
      '  JSON must contain "id" (string) and "command" (string).\n' +
      '  Optional: "max_retries" (integer, overrides Config table default).\n' +
      "  Example: queuectl enqueue '{\"id\":\"job-1\",\"command\":\"echo hello\"}'"
  )
  .action(async (json: string) => {
    await enqueue(json);
    process.exit(0);
  });

// ─── queuectl worker ─────────────────────────────────────────────────────────
const worker = program
  .command("worker")
  .description("Manage background worker processes");

worker
  .command("start")
  .description(
    "Fork and start background worker process(es).\n" +
      "  Workers poll the DB for pending/failed jobs and execute them.\n" +
      "  Example: queuectl worker start --count 2"
  )
  .option("-c, --count <n>", "Number of worker processes to start", "1")
  .action(async (opts: { count: string }) => {
    const count = parseInt(opts.count, 10);
    if (isNaN(count) || count < 1) {
      console.error("ERROR: --count must be a positive integer (e.g. --count 2).");
      process.exit(1);
    }
    await workerStart(count);
    process.exit(0);
  });

worker
  .command("stop")
  .description(
    "Gracefully stop all running workers by sending SIGTERM.\n" +
      "  Waits up to 20 seconds for each worker to finish its current job.\n" +
      "  Example: queuectl worker stop"
  )
  .action(async () => {
    await workerStop();
    process.exit(0);
  });

// ─── queuectl status ─────────────────────────────────────────────────────────
program
  .command("status")
  .description(
    "Display job counts grouped by state and worker status.\n" +
      "  Running workers with a stale heartbeat (>10s) are flagged as possibly dead.\n" +
      "  Example: queuectl status"
  )
  .action(async () => {
    await status();
    process.exit(0);
  });

// ─── queuectl list ───────────────────────────────────────────────────────────
program
  .command("list")
  .description(
    "List jobs filtered by state as a table.\n" +
      "  Valid states: pending, processing, completed, failed, dead\n" +
      "  Example: queuectl list --state pending"
  )
  .requiredOption(
    "-s, --state <state>",
    "Filter by job state (pending|processing|completed|failed|dead)"
  )
  .action(async (opts: { state: string }) => {
    await list(opts.state);
    process.exit(0);
  });

// ─── queuectl dlq ────────────────────────────────────────────────────────────
const dlq = program
  .command("dlq")
  .description("Dead-letter queue operations");

dlq
  .command("list")
  .description(
    "List all jobs in the dead-letter queue (state=dead).\n" +
      "  Example: queuectl dlq list"
  )
  .action(async () => {
    await dlqList();
    process.exit(0);
  });

dlq
  .command("retry <id>")
  .description(
    "Re-queue a dead job: resets state to pending, attempts to 0, nextRunAt to now.\n" +
      "  Errors clearly if the job does not exist or is not in dead state.\n" +
      "  Example: queuectl dlq retry job-42"
  )
  .action(async (id: string) => {
    await dlqRetry(id);
    process.exit(0);
  });

// ─── queuectl config ─────────────────────────────────────────────────────────
const config = program
  .command("config")
  .description("Manage queue configuration stored in the Config table");

config
  .command("set <key> <value>")
  .description(
    "Upsert a config key/value pair.\n" +
      "  Supported keys:\n" +
      "    max-retries   — default number of attempts before DLQ (integer ≥ 1)\n" +
      "    backoff-base  — base for exponential backoff in seconds (number > 1)\n" +
      "  Example: queuectl config set max-retries 5\n" +
      "  Example: queuectl config set backoff-base 3"
  )
  .action(async (key: string, value: string) => {
    await configSet(key, value);
    process.exit(0);
  });

program.parse(process.argv);
