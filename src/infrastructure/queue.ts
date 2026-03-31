import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";

export const QUEUE_NAME = "dispatch";

const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export const dispatchQueue = new Queue(QUEUE_NAME, { connection });

export function createWorkerConnection(): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}

export { connection as redisConnection };
