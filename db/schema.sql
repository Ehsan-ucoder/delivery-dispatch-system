-- Delivery dispatch system — PostgreSQL schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users (customers)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drivers (independent of auth for this simulation)
CREATE TABLE drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  current_lat DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_lng DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One wallet per user
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending_dispatch',
      'awaiting_driver_acceptance',
      'accepted',
      'in_transit',
      'delivered',
      'completed',
      'cancelled',
      'dispatch_failed'
    )
  ),
  pickup_lat DOUBLE PRECISION NOT NULL,
  pickup_lng DOUBLE PRECISION NOT NULL,
  drop_lat DOUBLE PRECISION NOT NULL,
  drop_lng DOUBLE PRECISION NOT NULL,
  delivery_fee_cents BIGINT NOT NULL CHECK (delivery_fee_cents >= 0),
  external_delivery_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_user ON orders (user_id);
CREATE INDEX idx_orders_status ON orders (status);

-- Assignment attempts: offered -> accepted | rejected | expired
CREATE TABLE order_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES drivers (id),
  status TEXT NOT NULL CHECK (status IN ('offered', 'accepted', 'rejected', 'expired')),
  attempt_number INT NOT NULL DEFAULT 1,
  offered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assignments_order ON order_assignments (order_id);
CREATE INDEX idx_assignments_driver ON order_assignments (driver_id);

-- At most one active "offered" assignment per order (concurrency + business rule)
CREATE UNIQUE INDEX uq_order_one_offered
  ON order_assignments (order_id)
  WHERE status = 'offered';

CREATE TABLE wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders (id),
  amount_cents BIGINT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('debit', 'credit', 'adjustment')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallet_tx_wallet ON wallet_transactions (wallet_id);

-- Application / audit logs
CREATE TABLE logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  context JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_logs_level_time ON logs (level, created_at DESC);

-- Webhook idempotency (same external event must not apply twice)
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'delivery_partner',
  delivery_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES orders (id),
  payload_hash TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, delivery_id)
);
