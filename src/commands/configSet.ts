// src/commands/configSet.ts — Upsert a key/value into the Config table
import { setConfig, getConfig } from "../config";

// Keys with special validation rules
const NUMERIC_KEYS: Record<string, { min: number; desc: string }> = {
  "max-retries": { min: 1,   desc: "positive integer ≥ 1" },
  "backoff-base": { min: 1.01, desc: "number > 1 (e.g. 2)" },
};

export async function configSet(key: string, value: string): Promise<void> {
  const rule = NUMERIC_KEYS[key];

  if (rule) {
    const num = Number(value);
    if (isNaN(num) || num < rule.min) {
      console.error(
        `ERROR: Value for "${key}" must be a ${rule.desc} (got: "${value}").`
      );
      process.exit(1);
    }
  } else {
    console.warn(
      `⚠ Unknown config key "${key}". ` +
        `Known keys: ${Object.keys(NUMERIC_KEYS).join(", ")}. Saving anyway.`
    );
  }

  const previous = await getConfig(key, "<not set>");
  await setConfig(key, value);

  console.log(
    `✔ Config updated:\n` +
      `  Key:      ${key}\n` +
      `  Previous: ${previous}\n` +
      `  New:      ${value}`
  );
}
