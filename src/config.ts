// src/config.ts — getConfig and setConfig helpers using the Config table
import { prisma } from "./db";

/**
 * Retrieve a config value by key.
 * Returns `fallback` if the key does not exist in the Config table.
 */
export async function getConfig(key: string, fallback: string): Promise<string> {
  const row = await prisma.config.findUnique({ where: { key } });
  return row?.value ?? fallback;
}

/**
 * Upsert a config value by key.
 * Creates the row if it doesn't exist, updates it if it does.
 */
export async function setConfig(key: string, value: string): Promise<void> {
  await prisma.config.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}
