import type { DbClient } from "./pool.js";
import { pool } from "./pool.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export async function log(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
  client?: DbClient,
): Promise<void> {
  const line = `[${level.toUpperCase()}] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`;
  console.error(line);
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO logs (level, message, context) VALUES ($1, $2, $3::jsonb)`,
    [level, message, JSON.stringify(context ?? {})],
  );
}
