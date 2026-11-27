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

-- v2: email verification + platform Paystack with per-business subaccounts (bank payouts)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verify_token_hash TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verify_sent_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS bank_code TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS account_name TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS paystack_subaccount TEXT;
CREATE INDEX IF NOT EXISTS businesses_verify_idx ON businesses (verify_token_hash);

-- v3: one shared phone line for all businesses. Callers say a business name or its 4-digit code.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS short_code TEXT UNIQUE;
UPDATE businesses SET short_code = (1000 + floor(random() * 9000))::int::text WHERE short_code IS NULL;
CREATE TABLE IF NOT EXISTS call_routes (
  call_id TEXT PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v4: password reset
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS reset_sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS businesses_reset_idx ON businesses (reset_token_hash);

-- v5: MCP API keys (hashed)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS mcp_key_hash TEXT UNIQUE;

-- v6: how the account signs in ('password' or 'google'); one method per email
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password';

-- v7: bookings, cashflow ledger (paid orders count as income automatically)
CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  service TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  amount_kobo INTEGER NOT NULL DEFAULT 0 CHECK (amount_kobo >= 0),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','completed','cancelled','no_show')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookings_business_idx ON bookings (business_id, starts_at);
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
  amount_kobo INTEGER NOT NULL CHECK (amount_kobo > 0),
  category TEXT NOT NULL DEFAULT 'Other',
  note TEXT,
  occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_business_idx ON transactions (business_id, occurred_on DESC);

-- v8: showcase media (photos/videos shown as reels on the customer page)
CREATE TABLE IF NOT EXISTS media (
  id SERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  s3_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  caption TEXT,
  visible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_business_idx ON media (business_id, created_at DESC);

-- v9: cover photo/video, separate from the Showcase gallery
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cover_key TEXT;
