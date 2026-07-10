-- 001: legacy HomeNex schema, translated from SQLite to PostgreSQL.
-- Integer 0/1 flags (is_admin, ai_enabled) stay SMALLINT so the API keeps
-- returning the same values the frontend already checks against.

CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,        -- WhatsApp number, canonical E.164 e.g. +919812345678
  email TEXT,
  password_hash TEXT NOT NULL,
  wa_phone_number_id TEXT,           -- Meta phone_number_id for the agent's own WhatsApp Business line
  wa_phone_number TEXT,              -- display phone number for the agent's WA Business line, E.164
  waba_status TEXT NOT NULL DEFAULT 'none' CHECK (waba_status IN ('none','pending','registered','active')),
  waba_registered_at TIMESTAMPTZ,
  meta_waba_id TEXT,                 -- Meta WABA (WhatsApp Business Account) ID
  is_admin SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER REFERENCES agents(id),  -- NULL = unassigned pool (unknown sender on the shared number)
  wa_id TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  source TEXT DEFAULT 'WhatsApp',
  temp TEXT DEFAULT 'Cold',
  score INTEGER DEFAULT 0,
  config TEXT,
  config_note TEXT,
  locality TEXT,
  location_note TEXT,
  budget_min_l DOUBLE PRECISION,     -- legacy budget in lakhs; new CRM budgets live in paise columns (002)
  budget_max_l DOUBLE PRECISION,
  budget_note TEXT,
  timeline TEXT,
  timeline_note TEXT,
  ai_summary TEXT,
  next_step TEXT,
  score_breakdown TEXT,
  ai_enabled SMALLINT NOT NULL DEFAULT 1,
  first_response_s DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, wa_id)           -- NULL agent_id rows are all distinct, matching SQLite behaviour
);
CREATE INDEX IF NOT EXISTS idx_leads_agent ON leads (agent_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  role TEXT NOT NULL CHECK (role IN ('buyer','ai','agent')),
  text TEXT NOT NULL,
  wa_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages (lead_id, id);

CREATE TABLE IF NOT EXISTS activity (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER,
  lead_id INTEGER,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity (agent_id, id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Clients an agent owns on the shared WhatsApp Business number. When one of these
-- numbers messages the shared line, the inbound is routed to this agent.
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  phone TEXT NOT NULL UNIQUE,        -- client's WhatsApp number, canonical E.164
  name TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contacts_agent ON contacts (agent_id, created_at);

CREATE TABLE IF NOT EXISTS network_posts (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('INVENTORY','REQUIREMENT')),
  broker TEXT NOT NULL,
  firm TEXT,
  text TEXT NOT NULL,
  config TEXT,
  locality TEXT,
  budget_min_l DOUBLE PRECISION,
  budget_max_l DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
