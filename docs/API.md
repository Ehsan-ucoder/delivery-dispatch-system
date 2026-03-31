# API endpoints

Base URL: `http://localhost:4000` (default `PORT`).

## Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness probe |

## Users & wallets

| Method | Path | Description |
|--------|------|-------------|
| POST | `/users` | Create user + empty wallet. Body: `{ "email", "displayName" }` |
| POST | `/users/:userId/wallet/credit` | Test helper: add funds. Body: `{ "amountCents" }` |

## Drivers

| Method | Path | Description |
|--------|------|-------------|
| POST | `/drivers` | Register driver. Body: `{ "name", "phone"?, "currentLat"?, "currentLng"?, "isAvailable"? }` |

## Orders

| Method | Path | Description |
|--------|------|-------------|
| POST | `/orders` | **Rate limited.** Create order and enqueue dispatch. Body: `{ "userId", "pickupLat", "pickupLng", "dropLat", "dropLng", "deliveryFeeCents" }` |
| GET | `/orders/:orderId` | Order detail + assignment history |
| POST | `/orders/:orderId/complete` | Idempotent completion debit (same rules as background charger). Use after `delivered` or for tests |

## Driver assignment (simulation)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/drivers/:driverId/assignments/:assignmentId/accept` | Driver accepts offer → order `in_transit` |
| POST | `/drivers/:driverId/assignments/:assignmentId/reject` | Driver rejects → order `pending_dispatch`, re-queue assign |

## Webhooks

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/delivery` | Partner callback: mark `delivered`, enqueue wallet charge. Header: `x-webhook-secret` (must match `WEBHOOK_SHARED_SECRET`). Body: `{ "orderId", "deliveryId" }` |

## Rate limiting

`POST /orders` uses `express-rate-limit`. Defaults: `ORDER_CREATE_RATE_LIMIT_MAX` requests per `ORDER_CREATE_RATE_LIMIT_WINDOW_MS` (see `.env.example`).
