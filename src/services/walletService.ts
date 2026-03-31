import type { DbClient } from "../infrastructure/pool.js";
import { pool } from "../infrastructure/pool.js";
import { log } from "../infrastructure/logger.js";

export const completionIdempotencyKey = (orderId: string) => `order:${orderId}:completion_debit`;

/**
 * Debits delivery fee when order is completed. Must be called inside a transaction
 * after locking the order row. Returns false if not applicable (already charged, etc.).
 */
export async function debitOrderCompletionIfNeeded(
  client: DbClient,
  orderId: string,
): Promise<{ charged: boolean; reason?: string }> {
  const orderRow = await client.query<{
    id: string;
    user_id: string;
    delivery_fee_cents: string;
    status: string;
  }>(
    `SELECT id, user_id, delivery_fee_cents, status FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const order = orderRow.rows[0];
  if (!order) return { charged: false, reason: "order_not_found" };

  if (order.status === "completed") {
    return { charged: false, reason: "already_completed" };
  }

  const idem = completionIdempotencyKey(orderId);
  const existing = await client.query(
    `SELECT 1 FROM wallet_transactions WHERE idempotency_key = $1`,
    [idem],
  );
  if (existing.rowCount) {
    await client.query(
      `UPDATE orders SET status = 'completed', updated_at = now() WHERE id = $1 AND status <> 'completed'`,
      [orderId],
    );
    return { charged: false, reason: "already_charged_idempotency" };
  }

  if (order.status !== "delivered") {
    return { charged: false, reason: "not_delivered_yet" };
  }

  const fee = BigInt(order.delivery_fee_cents);

  const w = await client.query<{ id: string; balance_cents: string }>(
    `SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE`,
    [order.user_id],
  );
  const wallet = w.rows[0];
  if (!wallet) {
    await log("error", "wallet: missing for user", { orderId, userId: order.user_id }, client);
    return { charged: false, reason: "no_wallet" };
  }

  const balance = BigInt(wallet.balance_cents);
  if (balance < fee) {
    await log(
      "error",
      "wallet: insufficient balance",
      { orderId, balance: balance.toString(), fee: fee.toString() },
      client,
    );
    return { charged: false, reason: "insufficient_funds" };
  }

  await client.query(
    `INSERT INTO wallet_transactions (wallet_id, order_id, amount_cents, type, idempotency_key)
     VALUES ($1, $2, $3, 'debit', $4)`,
    [wallet.id, orderId, fee, idem],
  );

  await client.query(
    `UPDATE wallets SET balance_cents = balance_cents - $2, updated_at = now() WHERE id = $1`,
    [wallet.id, fee],
  );

  await client.query(
    `UPDATE orders SET status = 'completed', updated_at = now() WHERE id = $1`,
    [orderId],
  );

  return { charged: true };
}

export async function runChargeOrderJob(orderId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await debitOrderCompletionIfNeeded(client, orderId);
    await client.query("COMMIT");

    if (res.charged) {
      await log("info", "wallet: completion debit ok", { orderId });
      return;
    }
    if (res.reason === "insufficient_funds" || res.reason === "no_wallet") {
      await log("warn", "wallet: charge deferred — job retry", { orderId, reason: res.reason });
      throw new Error(`CHARGE_RETRY:${res.reason}`);
    }
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* committed or no txn */
    }
    throw e;
  } finally {
    client.release();
  }
}
