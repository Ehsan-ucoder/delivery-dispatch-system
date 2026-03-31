import express from "express";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { pool } from "../infrastructure/pool.js";
import { log } from "../infrastructure/logger.js";
import { enqueueAssignOrder } from "../services/dispatchService.js";
import { processDeliveryWebhook } from "../services/webhookService.js";
import { debitOrderCompletionIfNeeded } from "../services/walletService.js";

export function buildApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const orderCreateLimiter = rateLimit({
    windowMs: config.orderCreateRateLimit.windowMs,
    limit: config.orderCreateRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.post("/users", async (req, res) => {
    const { email, displayName } = req.body ?? {};
    if (!email || !displayName) {
      res.status(400).json({ error: "email and displayName required" });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const u = await client.query<{ id: string }>(
        `INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
        [email, displayName],
      );
      const userId = u.rows[0].id;
      await client.query(`INSERT INTO wallets (user_id, balance_cents) VALUES ($1, 0)`, [userId]);
      await client.query("COMMIT");
      res.status(201).json({ id: userId });
    } catch (e) {
      await client.query("ROLLBACK");
      const err = e as { code?: string };
      if (err.code === "23505") {
        res.status(409).json({ error: "email_exists" });
        return;
      }
      await log("error", "users.create failed", { err: String(e) });
      res.status(500).json({ error: "internal" });
    } finally {
      client.release();
    }
  });

  app.post("/drivers", async (req, res) => {
    const { name, phone, currentLat, currentLng, isAvailable } = req.body ?? {};
    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }
    const r = await pool.query<{ id: string }>(
      `INSERT INTO drivers (name, phone, current_lat, current_lng, is_available)
       VALUES ($1, $2, COALESCE($3, 0), COALESCE($4, 0), COALESCE($5, true))
       RETURNING id`,
      [name, phone ?? null, currentLat, currentLng, isAvailable],
    );
    res.status(201).json({ id: r.rows[0].id });
  });

  app.post("/users/:userId/wallet/credit", async (req, res) => {
    const { userId } = req.params;
    const amountCents = Number(req.body?.amountCents ?? req.body?.amount_cents);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      res.status(400).json({ error: "amountCents must be positive number" });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const w = await client.query<{ id: string }>(
        `SELECT id FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (!w.rowCount) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "wallet_not_found" });
        return;
      }
      const walletId = w.rows[0].id;
      const idem = `manual_credit:${userId}:${Date.now()}:${Math.random()}`;
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, amount_cents, type, idempotency_key)
         VALUES ($1, $2, 'credit', $3)`,
        [walletId, amountCents, idem],
      );
      await client.query(
        `UPDATE wallets SET balance_cents = balance_cents + $2, updated_at = now() WHERE id = $1`,
        [walletId, amountCents],
      );
      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK");
      await log("error", "wallet.credit failed", { err: String(e) });
      res.status(500).json({ error: "internal" });
    } finally {
      client.release();
    }
  });

  app.post("/orders", orderCreateLimiter, async (req, res) => {
    const {
      userId,
      pickupLat,
      pickupLng,
      dropLat,
      dropLng,
      deliveryFeeCents,
    } = req.body ?? {};
    if (!userId || ![pickupLat, pickupLng, dropLat, dropLng].every((n: unknown) => Number.isFinite(Number(n)))) {
      res.status(400).json({ error: "userId and coordinates required" });
      return;
    }
    const fee = Number(deliveryFeeCents ?? 0);
    if (!Number.isFinite(fee) || fee < 0) {
      res.status(400).json({ error: "invalid deliveryFeeCents" });
      return;
    }
    const r = await pool.query<{ id: string }>(
      `INSERT INTO orders (user_id, status, pickup_lat, pickup_lng, drop_lat, drop_lng, delivery_fee_cents)
       VALUES ($1, 'pending_dispatch', $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, pickupLat, pickupLng, dropLat, dropLng, fee],
    );
    const orderId = r.rows[0].id;
    res.status(201).json({ id: orderId });
    await enqueueAssignOrder(orderId);
  });

  app.get("/orders/:orderId", async (req, res) => {
    const r = await pool.query(`SELECT * FROM orders WHERE id = $1`, [req.params.orderId]);
    if (!r.rowCount) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const assigns = await pool.query(
      `SELECT * FROM order_assignments WHERE order_id = $1 ORDER BY created_at ASC`,
      [req.params.orderId],
    );
    res.json({ order: r.rows[0], assignments: assigns.rows });
  });

  app.post("/drivers/:driverId/assignments/:assignmentId/accept", async (req, res) => {
    const { driverId, assignmentId } = req.params;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const a = await client.query<{
        id: string;
        order_id: string;
        driver_id: string;
        status: string;
      }>(`SELECT * FROM order_assignments WHERE id = $1 FOR UPDATE`, [assignmentId]);
      const row = a.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "assignment_not_found" });
        return;
      }
      if (row.driver_id !== driverId) {
        await client.query("ROLLBACK");
        res.status(403).json({ error: "driver_mismatch" });
        return;
      }
      if (row.status !== "offered") {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `assignment_${row.status}` });
        return;
      }
      await client.query(
        `UPDATE order_assignments SET status = 'accepted', responded_at = now() WHERE id = $1`,
        [assignmentId],
      );
      await client.query(
        `UPDATE orders SET status = 'in_transit', updated_at = now() WHERE id = $1`,
        [row.order_id],
      );
      await client.query("COMMIT");
      res.json({ ok: true, orderId: row.order_id });
    } catch (e) {
      await client.query("ROLLBACK");
      await log("error", "assignment.accept failed", { err: String(e) });
      res.status(500).json({ error: "internal" });
    } finally {
      client.release();
    }
  });

  app.post("/drivers/:driverId/assignments/:assignmentId/reject", async (req, res) => {
    const { driverId, assignmentId } = req.params;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const a = await client.query<{ order_id: string; driver_id: string; status: string }>(
        `SELECT order_id, driver_id, status FROM order_assignments WHERE id = $1 FOR UPDATE`,
        [assignmentId],
      );
      const row = a.rows[0];
      if (!row || row.driver_id !== driverId) {
        await client.query("ROLLBACK");
        res.status(row ? 403 : 404).json({ error: row ? "driver_mismatch" : "not_found" });
        return;
      }
      if (row.status !== "offered") {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `assignment_${row.status}` });
        return;
      }
      await client.query(
        `UPDATE order_assignments SET status = 'rejected', responded_at = now() WHERE id = $1`,
        [assignmentId],
      );
      await client.query(
        `UPDATE orders SET status = 'pending_dispatch', updated_at = now() WHERE id = $1`,
        [row.order_id],
      );
      await client.query("COMMIT");
      await enqueueAssignOrder(row.order_id);
      res.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK");
      await log("error", "assignment.reject failed", { err: String(e) });
      res.status(500).json({ error: "internal" });
    } finally {
      client.release();
    }
  });

  /**
   * Explicit completion endpoint (e.g. mobile app) — idempotent via wallet idempotency key.
   */
  app.post("/orders/:orderId/complete", async (req, res) => {
    const { orderId } = req.params;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await debitOrderCompletionIfNeeded(client, orderId);
      await client.query("COMMIT");
      if (r.charged) {
        res.json({ ok: true, charged: true });
        return;
      }
      res.status(r.reason === "insufficient_funds" ? 402 : 200).json({
        ok: r.reason === "already_completed" || r.reason === "already_charged_idempotency",
        charged: false,
        reason: r.reason,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      await log("error", "orders.complete failed", { err: String(e) });
      res.status(500).json({ error: "internal" });
    } finally {
      client.release();
    }
  });

  app.post("/webhooks/delivery", async (req, res) => {
    const secret = req.header("x-webhook-secret");
    if (secret !== config.webhookSharedSecret) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { orderId, deliveryId } = req.body ?? {};
    if (!orderId || !deliveryId) {
      res.status(400).json({ error: "orderId and deliveryId required" });
      return;
    }
    try {
      const result = await processDeliveryWebhook({ orderId, deliveryId });
      if (result.status === "duplicate") {
        res.json({ ok: true, duplicate: true });
        return;
      }
      if (result.status === "invalid") {
        res.status(400).json({ error: result.reason });
        return;
      }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "internal" });
    }
  });

  return app;
}
