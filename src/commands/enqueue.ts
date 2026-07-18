// src/commands/enqueue.ts — Parse JSON arg, validate, insert job into DB
import { prisma } from "../db";
import { getConfig } from "../config";

interface EnqueueInput {
  id: string;
  command: string;
  max_retries?: number;
}

export async function enqueue(jsonStr: string): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(jsonStr);
  } catch {
    console.error("ERROR: Invalid JSON. Please provide a valid JSON string.");
    process.exit(1);
  }

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    console.error("ERROR: Input must be a JSON object.");
    process.exit(1);
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj["id"] !== "string" || !obj["id"].trim()) {
    console.error(
      'ERROR: Missing or invalid required field "id" (must be a non-empty string).'
    );
    process.exit(1);
  }

  if (typeof obj["command"] !== "string" || !obj["command"].trim()) {
    console.error(
      'ERROR: Missing or invalid required field "command" (must be a non-empty string).'
    );
    process.exit(1);
  }

  const { id, command } = obj as unknown as EnqueueInput;

  // Reject duplicate IDs
  const existing = await prisma.job.findUnique({ where: { id } });
  if (existing) {
    console.error(
      `ERROR: A job with id "${id}" already exists (state: ${existing.state}). ` +
        `Duplicate IDs are not allowed.`
    );
    process.exit(1);
  }

  // Resolve maxRetries: explicit arg > Config table > hardcoded default
  let maxRetries: number;
  if (typeof obj["max_retries"] === "number") {
    maxRetries = Math.max(1, Math.floor(obj["max_retries"]));
  } else {
    const configVal = await getConfig("max-retries", "3");
    const parsed = parseInt(configVal, 10);
    maxRetries = isNaN(parsed) || parsed < 1 ? 3 : parsed;
  }

  const job = await prisma.job.create({
    data: { id, command, maxRetries },
  });

  console.log(
    `✔ Job enqueued successfully.\n` +
      `  ID:         ${job.id}\n` +
      `  Command:    ${job.command}\n` +
      `  MaxRetries: ${job.maxRetries}\n` +
      `  State:      ${job.state}`
  );
}
