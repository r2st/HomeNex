-- 013: Admin Portal (§7). Staff-facing operations over the whole platform:
--   §7.1 agent onboarding + KYC/RERA verification (impersonation reuses audit_logs)
--   §7.2 template approval workflow (agent requests → staff reviews → submit to Meta)
--   §7.3 billing & usage: plans, subscriptions, GST invoices (all money in paise)
--   §7.4 support tickets with tenant context
--   §7.5 platform analytics reads existing tables (no new schema)

-- --- §7.1 Onboarding & KYC/RERA verification (columns on agents) ---
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (kyc_status IN ('unverified','pending','verified','rejected')),
  ADD COLUMN IF NOT EXISTS kyc_note TEXT,
  ADD COLUMN IF NOT EXISTS kyc_reviewed_by INTEGER REFERENCES agents(id),
  ADD COLUMN IF NOT EXISTS kyc_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rera_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rera_verified_at TIMESTAMPTZ;

-- --- §7.2 Template approval workflow (columns on message_templates) ---
-- meta_status already tracks Meta's verdict; review_status is HomeNex's internal
-- gate: an agent moves a template to pending_review, staff approve/reject, then
-- submit it to Meta.
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (review_status IN ('draft','pending_review','approved','rejected','submitted')),
  ADD COLUMN IF NOT EXISTS review_note TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES agents(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_templates_review ON message_templates (review_status)
  WHERE review_status = 'pending_review';

-- --- §7.3 Billing & usage ---
CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price_paise BIGINT NOT NULL DEFAULT 0,        -- monthly recurring, exclusive of GST
  conversation_quota INTEGER,                    -- included WA conversations/month; NULL = unlimited
  features JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_subscriptions (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL UNIQUE REFERENCES agents(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_start DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  current_period_end DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Invoices carry an explicit GST split so the total is auditable and never
-- recomputed from a float. subtotal + gst = total, all paise.
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  number TEXT UNIQUE NOT NULL,
  period_start DATE,
  period_end DATE,
  subtotal_paise BIGINT NOT NULL DEFAULT 0,
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 18.0,
  gst_paise BIGINT NOT NULL DEFAULT 0,
  total_paise BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('draft','issued','paid','void')),
  line_items JSONB NOT NULL DEFAULT '[]',        -- [{description, qty, unit_paise, amount_paise}]
  notes TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_agent ON invoices (agent_id, issued_at DESC);

-- --- §7.4 Support tickets ---
CREATE TABLE IF NOT EXISTS support_tickets (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('general','billing','whatsapp','technical','feature_request')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved','closed')),
  assigned_to INTEGER REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_agent ON support_tickets (agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_agent_id INTEGER REFERENCES agents(id),
  is_staff BOOLEAN NOT NULL DEFAULT false,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON support_ticket_messages (ticket_id, id);

-- Seed a starter plan catalogue (idempotent). Prices are monthly, ex-GST, in paise.
INSERT INTO plans (code, name, price_paise, conversation_quota, features) VALUES
  ('free',    'Free',     0,        100,  '["1 agent","Shared inbox","AI replies"]'),
  ('starter', 'Starter',  99900,    1000, '["1 agent","AI replies","Templates","Site visits"]'),
  ('growth',  'Growth',   299900,   5000, '["Up to 5 agents","Team inbox","Round-robin","Analytics"]'),
  ('pro',     'Pro',      799900,   NULL, '["Unlimited agents","Priority support","All features"]')
ON CONFLICT (code) DO NOTHING;
