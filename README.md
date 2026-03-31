# Delivery dispatch system (simulation)

Node.js (TypeScript) + PostgreSQL + Redis/BullMQ. Implements automatic driver assignment with row locking, queue-driven dispatch, wallet settlement with idempotency, idempotent webhooks, retries, and rate-limited order creation.

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Start infra:

```bash
docker compose up -d
```

3. Configure env (see `.env.example`):

```bash
cp .env.example .env
```

4. Migrate schema:

```bash
npm run db:migrate
```

5. Run API and worker (**two terminals**). The worker must be running for dispatch, timeouts, and wallet charges.

```bash
npm run dev:api
npm run dev:worker
```

Default API base URL: **http://localhost:4000** (`PORT` in `.env`).

## Without Docker

You only need **PostgreSQL** and **Redis** running somewhere. Install them however you like (Homebrew, Postgres.app, a cloud dev instance, etc.), then point `.env` at them.

### macOS with Homebrew (example)

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

Create a database (use your macOS username if that is how you connect—`psql` will show):

```bash
createdb dispatch
```

Edit `.env`:

- `DATABASE_URL` — usually `postgres://YOUR_USERNAME@localhost:5432/dispatch` (no password if peer/trust auth locally).
- `REDIS_URL` — usually `redis://127.0.0.1:6379`.

Then from this folder:

```bash
npm install
npm run db:migrate
npm run dev:api
npm run dev:worker
```

See commented lines in `.env.example` for the same URLs.

## Deliverables (project checklist)

| Artifact | Location | What it contains |
|----------|----------|------------------|
| **Database schema** | [`db/schema.sql`](db/schema.sql) | Tables, constraints, indexes (single active offer per order, wallet idempotency keys, webhook dedup). |
| **API endpoints** | [`docs/API.md`](docs/API.md) | Full list of routes, methods, and request shapes. |
| **Design & operations** | [`docs/EXPLANATION.md`](docs/EXPLANATION.md) | **Concurrency** (row locks + queue workers), **preventing duplicate assignments** (DB unique partial index + status rules), **wallet deduction safety** (locks, non-negative balance, idempotent debits), **retries** (BullMQ attempts, timeouts, charge retries), **webhook idempotency** (`webhook_events` + `ON CONFLICT`), **how the system could scale** (stateless API, pooled DB, Redis/queue HA). |
| **Source code** | [`src/`](src/) | HTTP API, dispatch / wallet / webhook services, BullMQ worker, config, migrations script. |

## Postman: how to call the API

### 1. Create an environment

In Postman: **Environments → Create environment**, add variables:

| Variable | Initial value | Notes |
|----------|---------------|--------|
| `baseUrl` | `http://localhost:4000` | Must match `PORT` in `.env`. |
| `webhookSecret` | same as `WEBHOOK_SHARED_SECRET` in `.env` | Default in `.env.example` is `change-me-for-callback-auth`. |
| `userId` | *(empty)* | Fill after **Create user**. |
| `driverId` | *(empty)* | Fill after **Create driver**. |
| `orderId` | *(empty)* | Fill after **Create order**. |
| `assignmentId` | *(empty)* | Fill from **Get order** response (`assignments[0].id` when status is `offered`). |
| `deliveryId` | `partner-delivery-001` | Any string; used for webhook dedup (same `deliveryId` = duplicate). |

Select this environment in the top-right dropdown so `{{baseUrl}}` resolves.

### 2. Default headers

For requests with a body, set **Headers** → `Content-Type: application/json` (Postman usually sets this when you pick **raw → JSON**).

### 3. Suggested request order (happy path)

Run the **worker** alongside the API so jobs execute.

1. **Health** — `GET {{baseUrl}}/health`  
   Expect `200` and `{ "ok": true }`.

2. **Create user** — `POST {{baseUrl}}/users`  
   Body (raw JSON):

   ```json
   {
     "email": "demo@example.com",
     "displayName": "Demo User"
   }
   ```

   Copy `id` from the response into environment variable **`userId`**.

3. **Credit wallet** — `POST {{baseUrl}}/users/{{userId}}/wallet/credit`  

   ```json
   {
     "amountCents": 5000
   }
   ```

4. **Create driver** — `POST {{baseUrl}}/drivers`  

   ```json
   {
     "name": "Driver One",
     "phone": "+15550001",
     "currentLat": 40.7128,
     "currentLng": -74.006,
     "isAvailable": true
   }
   ```

   Copy `id` into **`driverId`**. Pick coordinates **near** your order pickup so this driver is chosen as nearest.

5. **Create order** — `POST {{baseUrl}}/orders`  

   ```json
   {
     "userId": "{{userId}}",
     "pickupLat": 40.713,
     "pickupLng": -74.0065,
     "dropLat": 40.72,
     "dropLng": -74.01,
     "deliveryFeeCents": 500
   }
   ```

   Copy `id` into **`orderId`**. Wait a second or two for the assign worker, or poll the next step.

6. **Get order** — `GET {{baseUrl}}/orders/{{orderId}}`  
   Find an assignment with `"status": "offered"`. Copy its `id` into **`assignmentId`**.

7. **Driver accepts** — `POST {{baseUrl}}/drivers/{{driverId}}/assignments/{{assignmentId}}/accept`  
   No body. Expect `200` and `orderId`.

8. **Delivery webhook** — `POST {{baseUrl}}/webhooks/delivery`  
   **Headers:** `x-webhook-secret: {{webhookSecret}}` (must match `.env`).  
   Body:

   ```json
   {
     "orderId": "{{orderId}}",
     "deliveryId": "{{deliveryId}}"
   }
   ```

   This marks the order delivered and enqueues the wallet charge. Sending the **same** `deliveryId` again should return success with duplicate handling (see `docs/EXPLANATION.md`).

9. **Complete (optional explicit debit)** — `POST {{baseUrl}}/orders/{{orderId}}/complete`  
   No body. Idempotent: safe to retry; wallet uses a deterministic idempotency key.

### 4. Other useful calls

- **Reject offer** — `POST {{baseUrl}}/drivers/{{driverId}}/assignments/{{assignmentId}}/reject` (re-queues dispatch).
- **Rate limit** — `POST /orders` is limited (`ORDER_CREATE_RATE_LIMIT_*` in `.env`); repeated bursts may return `429`.

### 5. Import as a collection (optional)

In Postman: **Import → Raw text** and paste a minimal collection JSON, or create a collection manually using the URLs above. Official route reference: [`docs/API.md`](docs/API.md).

## Assumptions

- **Closest driver** uses Euclidean distance on lat/lng (adequate for a simulation; production would use haversine + routing).
- **Driver acceptance** is simulated via HTTP (`POST .../accept`); the 60s timeout is enforced by a delayed BullMQ job.
- **Redis** provides the job queue (BullMQ). PostgreSQL remains the source of truth for money and assignments.
