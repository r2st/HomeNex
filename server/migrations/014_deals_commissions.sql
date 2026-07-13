-- 014: §5.4 Deal & Commission tracking.
-- Builds on the commissions scaffolding (table + createCommission etc. from 002)
-- with three new pieces: automatic deal capture at the booking stage, a builder
-- receivables ledger that can be aged, and GST-aware commission invoices.
-- All money is paise (BIGINT) — never floats.

-- A deal is the unit that commission receivables and invoices hang off. One is
-- captured automatically the moment a lead reaches its booking stage
-- (Token/Booking for buy pipelines, Deposit/Token for rentals); agents can also
-- create/edit one by hand. UNIQUE(lead_id) makes auto-capture idempotent.
CREATE TABLE IF NOT EXISTS deals (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  property_id INTEGER REFERENCES properties(id),
  deal_type TEXT NOT NULL DEFAULT 'sale' CHECK (deal_type IN ('sale','rental')),
  builder_name TEXT,                       -- CP counterparty for a sale deal
  deal_value_paise BIGINT,                 -- flat value (sale deals)
  monthly_rent_paise BIGINT,               -- monthly rent (rental deals) — drives the 1-month-rent suggestion
  stage_captured TEXT NOT NULL,            -- the pipeline stage that triggered capture
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','cancelled')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id)
);
CREATE INDEX IF NOT EXISTS idx_deals_agent ON deals (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_deals_builder ON deals (agent_id, builder_name);

-- Link each commission to its deal, and remember which builder owes the receivable
-- so the ledger can group + age by builder even when the payer is a builder but the
-- deal row was created/edited separately.
ALTER TABLE commissions
  ADD COLUMN IF NOT EXISTS deal_id INTEGER REFERENCES deals(id),
  ADD COLUMN IF NOT EXISTS builder_name TEXT;
CREATE INDEX IF NOT EXISTS idx_commissions_builder ON commissions (agent_id, builder_name);

-- GST-aware commission invoices. Amounts are integer paise and subtotal + gst =
-- total exactly (never re-derived from a float). gst_rate is stored per-invoice so
-- historical invoices survive a future rate change.
CREATE TABLE IF NOT EXISTS commission_invoices (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  commission_id INTEGER NOT NULL REFERENCES commissions(id),
  invoice_number TEXT NOT NULL,
  subtotal_paise BIGINT NOT NULL,
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 18,
  gst_paise BIGINT NOT NULL,
  total_paise BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','paid','cancelled')),
  notes TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_commission_invoices_agent ON commission_invoices (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_commission_invoices_commission ON commission_invoices (commission_id);
