# Delivery dispatch system (simulation)

Node.js (TypeScript) + PostgreSQL + Redis/BullMQ. Implements automatic driver assignment with row locking, queue-driven dispatch, wallet settlement with idempotency, idempotent webhooks, retries, and rate-limited order creation.

## Quick start

1. Start infra:

```bash
docker compose up -d
```

2. Configure env (see `.env.example`):

```bash
cp .env.example .env
```

3. Migrate schema:

```bash
npm run db:migrate
```

4. Run API and worker (two terminals):

```bash
npm run dev:api
npm run dev:worker
```

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

## Deliverables

| Artifact | Location |
|----------|----------|
| Database schema | `db/schema.sql` |
| API reference | `docs/API.md` |
| Design & concurrency notes | `docs/EXPLANATION.md` |
| Application source | `src/` |

A short manifest for archival is also under `storage/delivery-dispatch-system/README.md`.

## Assumptions

- **Closest driver** uses Euclidean distance on lat/lng (adequate for a simulation; production would use haversine + routing).
- **Driver acceptance** is simulated via HTTP (`POST .../accept`); the 60s timeout is enforced by a delayed BullMQ job.
- **Redis** provides the job queue (BullMQ). PostgreSQL remains the source of truth for money and assignments.
