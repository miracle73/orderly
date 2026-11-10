CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  paystack_secret_enc TEXT,
  vapi_assistant_id TEXT,
  vapi_phone_number_id TEXT,
  phone_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  price_kobo INTEGER NOT NULL CHECK (price_kobo > 0),
  available BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (business_id, name)
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL UNIQUE,
  customer_phone TEXT,
  state JSONB NOT NULL,
  status TEXT NOT NULL,
  fulfilment TEXT NOT NULL DEFAULT 'new',
  payment_ref TEXT UNIQUE,
  payment_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_business_idx ON orders (business_id, updated_at DESC);

-- Audit log of every attempted action (accepted or rejected) for QA.
CREATE TABLE IF NOT EXISTS order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  action JSONB NOT NULL,
  ok BOOLEAN NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transcripts (
  id BIGSERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL UNIQUE,
  customer_phone TEXT,
  transcript TEXT,
  messages JSONB,
  recording_url TEXT,
  ended_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transcripts_business_idx ON transcripts (business_id, created_at DESC);
