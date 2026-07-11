-- 010: Lead Source Integrations (FEATURE_RESEARCH §1.7 Portal Lead Ingestion,
-- §3.1 Managed Click-to-WhatsApp Ads, and the Technical-Notes portal/syndication layer).
--
-- Before this, every lead was born from an inbound WhatsApp message. Agents also pay
-- for portals (99acres/MagicBricks/Housing), run Facebook/Instagram Lead Ads, click-to-
-- WhatsApp ads, and take walk-in/phone enquiries — all of which leaked out of the CRM.
-- This migration gives each workspace a unique ingest email address, records where every
-- lead actually came from, logs each raw ingestion event (for dedupe + audit + replay),
-- stores per-agent direct portal API config, and caches portal-formatted listing exports.

-- Each agent (workspace) gets a stable token used to build a unique ingest email address
-- like  lead-<token>@<INGEST_EMAIL_DOMAIN>  that portals send lead notifications to.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS ingest_token TEXT;
-- Backfill existing agents with a short, URL/email-safe token. random()+md5 needs no extension.
UPDATE agents
  SET ingest_token = substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 12)
  WHERE ingest_token IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_ingest_token ON agents (ingest_token);

-- Structured provenance on the lead itself. The legacy free-text `source` column
-- ('WhatsApp') is kept for back-compat; these add machine-readable channel/portal + the
-- ad/portal metadata and the click-to-WhatsApp free-entry window anchor.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source_channel TEXT
    CHECK (source_channel IN ('whatsapp','portal_email','portal_api','meta_lead_ad','ctwa','walk_in','phone','referral')),
  ADD COLUMN IF NOT EXISTS source_portal TEXT,          -- '99acres','magicbricks','housing','nobroker','facebook','instagram'
  ADD COLUMN IF NOT EXISTS source_ref TEXT,             -- listing/property the buyer enquired about
  ADD COLUMN IF NOT EXISTS source_meta JSONB NOT NULL DEFAULT '{}',  -- ad_id, campaign, form_id, ctwa_clid, raw fields
  ADD COLUMN IF NOT EXISTS ctwa_clid TEXT,              -- Click-to-WhatsApp click id (Meta ReferralCtwaClid)
  ADD COLUMN IF NOT EXISTS free_entry_at TIMESTAMPTZ;   -- start of the 72h free-messaging window (CTWA / ad free entry)
CREATE INDEX IF NOT EXISTS idx_leads_source_channel ON leads (agent_id, source_channel);

-- Append-only log of every ingestion attempt (email parse, leadgen webhook, CTWA,
-- walk-in, portal API pull). Powers dedupe (external_id), audit, and manual replay.
CREATE TABLE IF NOT EXISTS lead_source_events (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER REFERENCES agents(id),          -- NULL if the ingest couldn't be attributed to an agent yet
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  channel TEXT NOT NULL
    CHECK (channel IN ('portal_email','portal_api','meta_lead_ad','ctwa','walk_in','phone')),
  portal TEXT,
  external_id TEXT,                                -- portal lead id / Meta leadgen_id, for dedupe
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','created','merged','duplicate','unmatched','failed')),
  contact_phone TEXT,
  contact_name TEXT,
  auto_reply_status TEXT,                          -- 'sent','skipped','failed:<reason>' — did the instant WhatsApp go out?
  raw JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lse_agent ON lead_source_events (agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lse_lead ON lead_source_events (lead_id);
-- Dedupe guard: the same portal lead id is never ingested twice for an agent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lse_dedupe
  ON lead_source_events (agent_id, channel, external_id)
  WHERE external_id IS NOT NULL;

-- Per-agent direct portal API/push config (99acres partner API, MagicBricks lead push).
CREATE TABLE IF NOT EXISTS portal_integrations (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  portal TEXT NOT NULL CHECK (portal IN ('99acres','magicbricks','housing','nobroker')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  api_key TEXT,
  api_secret TEXT,
  config JSONB NOT NULL DEFAULT '{}',              -- feed url, listing prefs, portal-specific ids
  last_sync_at TIMESTAMPTZ,
  last_status TEXT,                                -- 'ok','error: ...','never'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, portal)
);
CREATE INDEX IF NOT EXISTS idx_portal_integrations_agent ON portal_integrations (agent_id);

-- Listing syndication: compose a property once, export portal-formatted content per portal.
CREATE TABLE IF NOT EXISTS property_syndications (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  portal TEXT NOT NULL CHECK (portal IN ('99acres','magicbricks','housing','nobroker')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','exported','pushed','error')),
  formatted JSONB NOT NULL DEFAULT '{}',           -- portal-shaped listing payload
  external_listing_id TEXT,                        -- id returned by a direct-push integration
  exported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, portal)
);
CREATE INDEX IF NOT EXISTS idx_prop_synd_agent ON property_syndications (agent_id);
