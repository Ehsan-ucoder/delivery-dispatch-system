import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  port: Number(process.env.PORT ?? "4000"),
  webhookSharedSecret: required("WEBHOOK_SHARED_SECRET", "dev-insecure"),
  orderCreateRateLimit: {
    windowMs: Number(process.env.ORDER_CREATE_RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: Number(process.env.ORDER_CREATE_RATE_LIMIT_MAX ?? 30),
  },
  assignmentAcceptanceSeconds: 60,
};
