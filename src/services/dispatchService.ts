import type { DbClient } from "../infrastructure/pool.js";
import { pool } from "../infrastructure/pool.js";
import { log } from "../infrastructure/logger.js";
import { dispatchQueue } from "../infrastructure/queue.js";
import {
  JOB_ASSIGN_ORDER,
  JOB_ASSIGNMENT_TIMEOUT,
  JOB_CHARGE_ORDER,
} from "../jobs/jobNames.js";
import { config } from "../config.js";

async function getLastExpiredDriverId(
  client: DbClient,
  orderId: string,
): Promise<string | null> {
  const r = await client.query<{ driver_id: string }>(
    `SELECT driver_id FROM order_assignments
     WHERE order_id = $1 AND status = 'expired'
     ORDER BY offered_at DESC LIMIT 1`,
    [orderId],
  );
  return r.rows[0]?.driver_id ?? null;
}

async function pickClosestDriver(
  client: DbClient,
  orderId: string,
  pickupLat: number,
  pickupLng: number,
): Promise<string | null> {
  const excludeDriverId = await getLastExpiredDriverId(client, orderId);
  const r = await client.query<{ id: string }>(
    `SELECT id FROM drivers
     WHERE is_available = true
       AND ($1::uuid IS NULL OR id <> $1::uuid)
     ORDER BY
       POWER(current_lat - $2, 2) + POWER(current_lng - $3, 2) ASC
     LIMIT 1`,
    [excludeDriverId, pickupLat, pickupLng],
  );
  return r.rows[0]?.id ?? null;
}

/** Runs inside a transaction with order row locked — caller must hold lock. */
export async function createOfferForOrder(
  client: DbClient,
  orderId: string,
): Promise<{ assignmentId: string; attemptNumber: number } | null> {
  const o = await client.query<{
    id: string;
    status: string;
    pickup_lat: string;
    pickup_lng: string;
  }>(
    `SELECT id, status, pickup_lat, pickup_lng FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const order = o.rows[0];
  if (!order) {
    await log("warn", "assign: order missing", { orderId }, client);
    return null;
  }
  if (order.status !== "pending_dispatch") {
    await log("info", "assign: skip, order not pending_dispatch", { orderId, status: order.status }, client);
    return null;
  }

  const existingOffer = await client.query(
    `SELECT 1 FROM order_assignments WHERE order_id = $1 AND status = 'offered' LIMIT 1`,
    [orderId],
  );
  if (existingOffer.rowCount) {
    await log("info", "assign: offer already active", { orderId }, client);
    return null;
  }

  const pickupLat = Number(order.pickup_lat);
  const pickupLng = Number(order.pickup_lng);
  const driverId = await pickClosestDriver(client, orderId, pickupLat, pickupLng);
  if (!driverId) {
    await log("warn", "assign: no available driver", { orderId }, client);
    return null;
  }

  const attemptRow = await client.query<{ n: string }>(
    `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM order_assignments WHERE order_id = $1`,
    [orderId],
  );
  const attemptNumber = Number(attemptRow.rows[0]?.n ?? 1);

  const ins = await client.query<{ id: string }>(
    `INSERT INTO order_assignments (order_id, driver_id, status, attempt_number)
     VALUES ($1, $2, 'offered', $3)
     RETURNING id`,
    [orderId, driverId, attemptNumber],
  );
  const assignmentId = ins.rows[0].id;

  await client.query(
    `UPDATE orders SET status = 'awaiting_driver_acceptance', updated_at = now() WHERE id = $1`,
    [orderId],
  );

  return { assignmentId, attemptNumber };
}

export async function enqueueAssignOrder(orderId: string): Promise<void> {
  await dispatchQueue.add(
    JOB_ASSIGN_ORDER,
    { orderId } satisfies { orderId: string },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}

export async function scheduleAssignmentTimeout(
  assignmentId: string,
  orderId: string,
): Promise<void> {
  await dispatchQueue.add(
    JOB_ASSIGNMENT_TIMEOUT,
    { assignmentId, orderId } satisfies { assignmentId: string; orderId: string },
    {
      delay: config.assignmentAcceptanceSeconds * 1000,
      attempts: 2,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}

export async function runAssignOrderJob(orderId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await createOfferForOrder(client, orderId);
    if (!result) {
      await client.query("ROLLBACK");
      const st = await pool.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [orderId],
      );
      if (st.rows[0]?.status === "pending_dispatch") {
        throw new Error("ASSIGN_DEFERRED_OR_FAILED");
      }
      return;
    }
    await client.query("COMMIT");

    await log("info", "assign: offer created", {
      orderId,
      assignmentId: result.assignmentId,
      attempt: result.attemptNumber,
    });

    await scheduleAssignmentTimeout(result.assignmentId, orderId);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function runAssignmentTimeoutJob(
  assignmentId: string,
  orderId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const a = await client.query<{ status: string }>(
      `SELECT status FROM order_assignments WHERE id = $1 FOR UPDATE`,
      [assignmentId],
    );
    const assignment = a.rows[0];
    if (!assignment) {
      await client.query("ROLLBACK");
      return;
    }
    if (assignment.status !== "offered") {
      await client.query("COMMIT");
      return;
    }

    await client.query(
      `UPDATE order_assignments SET status = 'expired', responded_at = now() WHERE id = $1`,
      [assignmentId],
    );
    await client.query(
      `UPDATE orders SET status = 'pending_dispatch', updated_at = now()
       WHERE id = $1 AND status = 'awaiting_driver_acceptance'`,
      [orderId],
    );
    await client.query("COMMIT");

    await log("warn", "assignment: offer expired, re-dispatch", { orderId, assignmentId });
    await enqueueAssignOrder(orderId);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function enqueueChargeOrder(orderId: string, delayMs = 0): Promise<void> {
  await dispatchQueue.add(
    JOB_CHARGE_ORDER,
    { orderId } satisfies { orderId: string },
    {
      delay: delayMs,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}
