-- 002: full CRM schema for real-estate agents.
-- All monetary values are stored in paise as BIGINT — never floats.
-- Every agent-owned table carries agent_id for multi-tenancy.

-- contacts: auto-created from WhatsApp conversations (extends the legacy manual "Clients").
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'whatsapp_inbound'
    CHECK (source IN ('whatsapp_inbound','portal','facebook','walk_in','referral')),
  ADD COLUMN IF NOT EXISTS source_detail TEXT,
  ADD COLUMN IF NOT EXISTS first_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opt_in_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (opt_in_status IN ('unknown','opted_in','opted_out')),
  ADD COLUMN IF NOT EXISTS labels JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- leads: extended with pipeline/intent fields. The legacy conversation columns
-- (wa_id, temp, score, budget_*_l, ...) are kept so existing flows keep working;
-- a lead now optionally links to a contact and carries a pipeline position.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id),
  ADD COLUMN IF NOT EXISTS pipeline_type TEXT
    CHECK (pipeline_type IN ('buy_primary','buy_resale','rental')),
  ADD COLUMN IF NOT EXISTS stage TEXT,
  ADD COLUMN IF NOT EXISTS budget_min BIGINT,        -- paise
  ADD COLUMN IF NOT EXISTS budget_max BIGINT,        -- paise
  ADD COLUMN IF NOT EXISTS bhk TEXT,
  ADD COLUMN IF NOT EXISTS property_type TEXT
    CHECK (property_type IN ('apartment','villa','plot','commercial')),
  ADD COLUMN IF NOT EXISTS preferred_localities JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS financing TEXT
    CHECK (financing IN ('cash','loan','undecided')),
  ADD COLUMN IF NOT EXISTS ai_score TEXT
    CHECK (ai_score IN ('hot','warm','cold')),
  ADD COLUMN IF NOT EXISTS ai_score_reason TEXT,
  ADD COLUMN IF NOT EXISTS lost_reason TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads (contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_pipeline ON leads (agent_id, pipeline_type, stage);

-- properties: the agent's inventory.
CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  property_type TEXT CHECK (property_type IN ('apartment','villa','plot','commercial')),
  bhk TEXT,
  size_sqft DOUBLE PRECISION,
  size_unit TEXT DEFAULT 'sqft',
  price_paise BIGINT,
  locality TEXT,
  city TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','token','sold','rented')),
  rera_project_number TEXT,
  builder_name TEXT,
  owner_name TEXT,
  facing TEXT,
  floor INTEGER,
  total_floors INTEGER,
  amenities JSONB NOT NULL DEFAULT '[]',
  photos JSONB NOT NULL DEFAULT '[]',
  brochure_url TEXT,
  video_url TEXT,
  notes TEXT,
  micro_page_slug TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_properties_agent ON properties (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_properties_locality ON properties (city, locality);

-- pipeline_stages: configurable per pipeline type (defaults seeded in 003).
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id SERIAL PRIMARY KEY,
  pipeline_type TEXT NOT NULL CHECK (pipeline_type IN ('buy_primary','buy_resale','rental')),
  stage_name TEXT NOT NULL,
  stage_order INTEGER NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_type, stage_name)
);

CREATE TABLE IF NOT EXISTS site_visits (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  property_id INTEGER REFERENCES properties(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  scheduled_at TIMESTAMPTZ NOT NULL,
  pickup_required BOOLEAN NOT NULL DEFAULT false,
  pickup_location TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','confirmed','completed','no_show','rescheduled')),
  outcome_notes TEXT,
  builder_preregistered BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_visits_agent ON site_visits (agent_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_lead ON site_visits (lead_id);

CREATE TABLE IF NOT EXISTS followups (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  due_at TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL DEFAULT 'manual' CHECK (type IN ('manual','no_response','ai_suggested')),
  note TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups (agent_id, due_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_followups_lead ON followups (lead_id);

CREATE TABLE IF NOT EXISTS commissions (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  deal_value_paise BIGINT,
  commission_pct NUMERIC(5,2),
  commission_flat_paise BIGINT,
  payer_type TEXT CHECK (payer_type IN ('builder','buyer','seller')),
  expected_payout_date DATE,
  actual_payout_date DATE,
  status TEXT NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','invoiced','received','overdue')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commissions_agent ON commissions (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_commissions_lead ON commissions (lead_id);

CREATE TABLE IF NOT EXISTS message_templates (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'utility' CHECK (category IN ('marketing','utility','service')),
  body TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '[]',
  meta_template_id TEXT,
  meta_status TEXT NOT NULL DEFAULT 'pending' CHECK (meta_status IN ('pending','approved','rejected')),
  rera_auto_append BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, name)
);
CREATE INDEX IF NOT EXISTS idx_templates_agent ON message_templates (agent_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER REFERENCES agents(id),
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_logs (agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs (entity_type, entity_id);
