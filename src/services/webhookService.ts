import { pool } from "../infrastructure/pool.js";
import { log } from "../infrastructure/logger.js";
import { enqueueChargeOrder } from "./dispatchService.js";

export type WebhookInput = {
  source?: string;
  deliveryId: string;
  orderId: string;
};

export type WebhookResult =
  | { status: "duplicate" }
  | { status: "ok" }
  | { status: "invalid"; reason: string };

/**
 * Idempotent: UNIQUE (source, delivery_id). Marks order delivered and enqueues wallet charge.
 */
export async function processDeliveryWebhook(input: WebhookInput): Promise<WebhookResult> {
  const source = input.source ?? "delivery_partner";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query<{ id: string }>(
      `INSERT INTO webhook_events (source, delivery_id, order_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (source, delivery_id) DO NOTHING
       RETURNING id`,
      [source, input.deliveryId, input.orderId],
    );

    if (!ins.rowCount) {
      await client.query("COMMIT");
      return { status: "duplicate" };
    }

    const o = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`,
      [input.orderId],
    );
    const order = o.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return { status: "invalid", reason: "order_not_found" };
    }

    if (!["in_transit", "accepted"].includes(order.status)) {
      if (order.status === "delivered" || order.status === "completed") {
        await client.query("COMMIT");
        return { status: "ok" };
      }
      await client.query("ROLLBACK");
      return { status: "invalid", reason: `bad_state:${order.status}` };
    }

    await client.query(
      `UPDATE orders
       SET status = 'delivered',
           external_delivery_ref = $2,
           updated_at = now()
       WHERE id = $1`,
      [input.orderId, input.deliveryId],
    );

    await client.query("COMMIT");
    await log("info", "webhook: order marked delivered", {
      orderId: input.orderId,
      deliveryId: input.deliveryId,
    });
    await enqueueChargeOrder(input.orderId);
    return { status: "ok" };
  } catch (e) {
    await client.query("ROLLBACK");
    await log("error", "webhook: failed", { err: String(e), input });
    throw e;
  } finally {
    client.release();
  }
}
