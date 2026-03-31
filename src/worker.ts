import { Worker } from "bullmq";
import {
  JOB_ASSIGN_ORDER,
  JOB_ASSIGNMENT_TIMEOUT,
  JOB_CHARGE_ORDER,
} from "./jobs/jobNames.js";
import {
  runAssignOrderJob,
  runAssignmentTimeoutJob,
} from "./services/dispatchService.js";
import { runChargeOrderJob } from "./services/walletService.js";
import { createWorkerConnection, QUEUE_NAME } from "./infrastructure/queue.js";
import { log } from "./infrastructure/logger.js";
import { config } from "./config.js";
import { pool } from "./infrastructure/pool.js";

const connection = createWorkerConnection();

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    if (job.name === JOB_ASSIGN_ORDER) {
      const { orderId } = job.data as { orderId: string };
      try {
        await runAssignOrderJob(orderId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "ASSIGN_DEFERRED_OR_FAILED") {
          await log("warn", "assign-order job retry", { orderId, attempt: job.attemptsMade });
          throw e;
        }
        await log("error", "assign-order failed", { orderId, err: msg });
        throw e;
      }
      return;
    }
    if (job.name === JOB_ASSIGNMENT_TIMEOUT) {
      const { assignmentId, orderId } = job.data as {
        assignmentId: string;
        orderId: string;
      };
      await runAssignmentTimeoutJob(assignmentId, orderId);
      return;
    }
    if (job.name === JOB_CHARGE_ORDER) {
      const { orderId } = job.data as { orderId: string };
      await runChargeOrderJob(orderId);
      return;
    }
    await log("warn", "unknown job name", { name: job.name });
  },
  { connection },
);

worker.on("completed", (job) => {
  void log("info", "job completed", { id: job.id, name: job.name });
});

worker.on("failed", (job, err) => {
  void log("error", "job failed", {
    id: job?.id,
    name: job?.name,
    err: err.message,
    attempts: job?.attemptsMade,
  });
  const maxAssignAttempts = typeof job?.opts.attempts === "number" ? job.opts.attempts : 3;
  if (job?.name === JOB_ASSIGN_ORDER && job.attemptsMade >= maxAssignAttempts) {
    const orderId = (job.data as { orderId: string }).orderId;
    void pool
      .query(
        `UPDATE orders SET status = 'dispatch_failed', updated_at = now()
         WHERE id = $1 AND status = 'pending_dispatch'`,
        [orderId],
      )
      .then(() => log("error", "assign-order exhausted retries", { orderId }));
  }
});

await log("info", "worker listening", { queue: QUEUE_NAME, assignmentSeconds: config.assignmentAcceptanceSeconds });
