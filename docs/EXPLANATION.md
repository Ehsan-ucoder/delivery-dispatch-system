# Delivery dispatch system — design notes

This document explains **why** the system is structured the way it is: concurrency-safe dispatch, **money** correctness, **idempotent** partner callbacks, and how it would **scale** operationally.

## What this simulates

A small **last-mile dispatch** domain: customers place **orders** (pickup/drop coordinates, **delivery fee** in cents), the platform **offers** the trip to a **nearest available driver**, the driver **accepts** or the offer **expires**, a partner marks **delivered** via **webhook**, and the customer’s **wallet** is **debited** exactly once when the order is **completed**. The stack is **Node.js (TypeScript)**, **PostgreSQL** (source of truth for money and assignment state), and **Redis** with **BullMQ** for **async jobs** (assign, timeout, charge, retries).

This is a **coding exercise / simulation**, but the patterns mirror production problems: **double dispatch**, **double charge**, **webhook retries**, and **horizontal workers**.

## Order lifecycle (statuses)

`orders.status` is constrained in `db/schema.sql` to a fixed set. Typical **happy path**:

1. **`pending_dispatch`** — Order created; waiting for an automatic **assign-order** job to pick a driver and create an **`offered`** `order_assignments` row.
2. **`awaiting_driver_acceptance`** — An offer is out; driver can **accept** or **reject**, or a delayed **assignment-timeout** job (60s) can expire it and re-queue dispatch.
3. **`accepted`** — Driver accepted; order moves toward **in_transit** / partner handling (simplified in the API).
4. **`in_transit`** — Partner/delivery in progress (as modeled by the HTTP flow and webhook).
5. **`delivered`** — Webhook from partner confirmed delivery (**idempotent**).
6. **`completed`** — Customer-facing completion; **wallet debit** ran with a deterministic **idempotency key** so repeats are safe.

Other terminal or failure states include **`cancelled`**, **`dispatch_failed`** (assign job exhausted retries), etc. The important invariant: **only one `offered` assignment per order** at a time, enforced by DB (see below).

## Happy path (events)

1. **Create user** → empty **wallet** row (`balance_cents >= 0` enforced by `CHECK`).
2. **Top up wallet** (credit) so the eventual debit can succeed.
3. **Create order** — may **enqueue** `assign-order` (and is **rate limited** on the HTTP layer to avoid abuse).
4. **Worker** runs dispatch: locks order row, finds nearest **available** driver, inserts **`offered`** assignment, enqueues **assignment-timeout**.
5. Driver **accepts** via HTTP → order becomes **`accepted`** / **`in_transit`** as implemented.
6. Partner **POST** webhook “delivered” with external **`delivery_id`** → **`webhook_events`** dedup → order **`delivered`** → **enqueue** `charge-order`.
7. **Charge worker** locks order + wallet, debits **delivery_fee_cents** if balance allows, records **`wallet_transactions`** with unique **`idempotency_key`**, sets **`completed`**.

Any duplicate webhook or duplicate **complete** call should **not** double-charge because of **idempotency keys** and **`ON CONFLICT DO NOTHING`** on webhooks.

## Concurrency and duplicate assignment prevention

**Order row as the serialization point:** Every automatic assignment runs inside a database transaction that begins with `SELECT ... FROM orders WHERE id = $1 FOR UPDATE`. `FOR UPDATE` forces concurrent assign workers to serialize on the same order: one worker holds the row lock until commit, others wait.

**Single active offer:** A partial unique index enforces at most one `offered` assignment per order:

```sql
CREATE UNIQUE INDEX uq_order_one_offered
  ON order_assignments (order_id)
  WHERE status = 'offered';
```

Before inserting, the code also checks that no `offered` row exists for the order (same transaction, same lock), so the common path avoids aborted transactions.

**States:** Only orders in `pending_dispatch` receive a new offer. After insert, the order moves to `awaiting_driver_acceptance`, so a second worker that acquires the lock later sees a non-pending status and exits without creating another offer.

**Queue vs database:** BullMQ (Redis) can deliver assign jobs to multiple workers. Correctness does not depend on a single worker—only on database locks and constraints.

## Wallet deduction and non-negative balance

**Row locking:** Wallet settlement locks the order (`FOR UPDATE`) and then the wallet (`SELECT ... FOR UPDATE`) in one transaction before any balance change.

**No negative balances:** The schema enforces `CHECK (balance_cents >= 0)` on `wallets`. Application logic refuses a debit when `balance_cents < delivery_fee_cents` and logs `insufficient_funds` (triggering a retry job instead of committing an illegal state).

**Idempotent completion:** Each completion uses a deterministic idempotency key stored in `wallet_transactions.idempotency_key` (`order:{orderId}:completion_debit`) with a **UNIQUE** constraint. A second call to `POST /orders/:id/complete`, a duplicate background job, or a retry after partial failure will see the existing row, align `orders.status` to `completed` if needed, and **not** post a second debit.

## Retries and failure handling

| Concern | Mechanism |
|---------|-----------|
| Assign job (no driver / transient DB) | BullMQ `attempts: 3` with exponential backoff; failures logged via `logs` table + worker `failed` events. |
| Assign permanently failing | After the last failed attempt, worker marks `orders.status = 'dispatch_failed'` if still `pending_dispatch`. |
| Driver timeout | Delayed `assignment-timeout` job (60s) expires the offer, sets `pending_dispatch`, enqueues a fresh `assign-order`. |
| Payment / charge | `charge-order` job with `attempts: 5` and backoff; insufficient funds or missing wallet throws to trigger retry after user tops up. All failures recorded in `logs`. |

## Webhook idempotency

Delivery partners often retry HTTP callbacks. The table `webhook_events` stores `(source, delivery_id)` with a **UNIQUE** constraint.

Transaction flow:

1. `INSERT ... ON CONFLICT DO NOTHING RETURNING id`
2. If no row returned → callback already processed → respond `200` with `{ duplicate: true }` without mutating business state again.

The first successful processing sets `orders` to `delivered` and enqueues `charge-order` exactly once per unique partner delivery id.

The schema also includes **`payload_hash`** (optional) for future integrity checks (e.g. detecting payload drift on replays); the core dedup key remains **`(source, delivery_id)`**.

## API layer: validation and rate limiting

- **Express** parses JSON bodies; handlers validate required fields and return **400** with a small error object when inputs are missing or inconsistent.
- **Order creation** uses **`express-rate-limit`** with limits from config (`orderCreateRateLimit`: window + max requests) so a single client cannot flood **pending_dispatch** with junk orders.
- **Health** endpoint for load balancers and local checks.

This is not a full auth story (no JWT/session in the exercise): in production you’d add **authentication**, **authorization**, and per-user quotas on top of global rate limits.

## Observability and audit

- **`logs` table:** structured rows with `level`, `message`, and **`context` JSONB** for correlation (order id, job name, failure reason). Useful for debugging **worker** failures without losing history when processes restart.
- **Postgres** is the **system of record** for assignments, wallet balances, transactions, and webhook dedup—**Redis** must be rebuildable from jobs + DB if treated only as a queue (BullMQ also persists job state in Redis, so treat Redis as **durable** in production or document job loss tolerance).

## Data model (short)

| Table | Role |
|-------|------|
| `users` / `drivers` | Actors in the simulation |
| `wallets` | One balance per user; **CHECK (balance_cents >= 0)** |
| `wallet_transactions` | Immutable ledger lines; **UNIQUE idempotency_key** |
| `orders` | Status machine + geo + fee |
| `order_assignments` | Offer lifecycle; partial unique index on **`offered`** |
| `webhook_events` | Dedup partner callbacks; **UNIQUE (source, delivery_id)** |
| `logs` | Append-only app/worker log stream |

## Scaling

- **API tier:** Horizontally scalable stateless HTTP servers; sticky sessions not required.
- **Workers:** Multiple BullMQ worker processes share one queue; assignment safety comes from PostgreSQL row locks, not from worker count.
- **PostgreSQL:** Primary bottleneck at high write volume; mitigate with read replicas for reporting, connection pooling (PgBouncer), and partitioning `logs` / webhook tables if they grow large.
- **Redis:** BullMQ queue; use Redis Cluster or a managed Redis for HA when job volume grows.
- **Stronger distributed locking:** For cross-service workflows, swap `FOR UPDATE` with PostgreSQL advisory locks or Redis Redlock *only where* the transaction cannot span a single DB round-trip—here, keeping money and assignment in one database favors row locks.

## Clean architecture (pragmatic)

Layers used in `src/`:

- **API (`api/`)** — HTTP adapters, validation, rate limits.
- **Services (`services/`)** — use cases (dispatch, wallet, webhook).
- **Infrastructure (`infrastructure/`)** — Postgres pool, Redis/BullMQ queue client, structured DB logging.

Domain rules (states, idempotency keys, job names) live beside services to avoid over-abstracting a coding exercise while keeping boundaries clear.
