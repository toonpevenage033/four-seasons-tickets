CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','staff')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('admin','staff')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE events (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  location text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 100),
  capacity integer NOT NULL CHECK (capacity > 0),
  is_test boolean NOT NULL,
  published boolean NOT NULL DEFAULT false,
  scanning_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (is_test AND published))
);
CREATE TABLE orders (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id),
  buyer_name text NOT NULL,
  buyer_email text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','canceled','expired','refunded','chargeback')),
  payment_id text UNIQUE,
  checkout_url text,
  is_test boolean NOT NULL,
  access_hash text UNIQUE NOT NULL,
  access_token text UNIQUE NOT NULL,
  request_id uuid UNIQUE NOT NULL,
  input_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_payment_check_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX orders_inventory ON orders(event_id,status);
CREATE INDEX orders_pending ON orders(created_at) WHERE status IN ('pending','paid');
CREATE TABLE tickets (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  event_id uuid NOT NULL REFERENCES events(id),
  code text UNIQUE NOT NULL,
  scanned_at timestamptz,
  scanned_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_order ON tickets(order_id);
CREATE TABLE scan_requests (
  user_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  input_hash text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id)
);
CREATE TABLE mail_jobs (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','preview')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text
);
CREATE TABLE mock_payments (
  id text PRIMARY KEY,
  order_id uuid UNIQUE NOT NULL REFERENCES orders(id),
  amount_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'open',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);
