-- 006: the decision layer — the half of a CRM that tells the agent what to do,
-- ported in spirit from Landline (scoring decay, worklist/briefing, notification
-- queue, send limiter, contact groups) and adapted to HomeNex's WhatsApp channel.
--
-- Design notes:
--   * Lead scoring is split. The AI's fit assessment (leads.score / ai_score) is
--     slow-moving and left untouched. A fast-moving ENGAGEMENT score and a decayed
--     EFFECTIVE score/temperature are added so a lead that goes silent cools down.
--   * Micro-page views can now be attributed to a lead (the shared link carries a
--     ?l=<leadId> ref), turning property_page_views into a real per-lead signal.

-- --- Lead scoring: fit (kept) + engagement (new, decaying) ---
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS engagement_score INTEGER,        -- 0-100, fast-moving
  ADD COLUMN IF NOT EXISTS effective_score INTEGER,         -- fit decayed by recency
  ADD COLUMN IF NOT EXISTS effective_temp TEXT
    CHECK (effective_temp IN ('Hot','Warm','Cold')),
  ADD COLUMN IF NOT EXISTS score_factors JSONB,             -- explainable breakdown
  ADD COLUMN IF NOT EXISTS last_decay_at TIMESTAMPTZ;       -- when decay last recomputed

-- Attribute a micro-page hit to the lead the link was sent to (?l=<leadId>).
ALTER TABLE property_page_views
  ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_page_views_lead ON property_page_views (lead_id, viewed_at);

-- --- Notification queue: background jobs write, the Today tab reads ---
-- dedupe_key stops the same reason notifying twice; it embeds enough identity
-- (lead id + window/day) that a fresh reason still gets through tomorrow.
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  entity_type TEXT,
  entity_id INTEGER,
  dedupe_key TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_agent ON notifications (agent_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications (agent_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- --- Outbound send log: quality-rating protection (Meta's version of Landline's
-- email-reputation limiter). Every marketing/festive send is recorded so per-contact
-- gaps and per-number daily caps are enforceable.
CREATE TABLE IF NOT EXISTS message_sends (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'marketing'
    CHECK (kind IN ('marketing','utility','service','festive')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_sends_agent ON message_sends (agent_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_message_sends_contact ON message_sends (contact_id, sent_at);

-- New-number warmup: when this agent's number first sent in bulk. The send limiter
-- ramps the daily cap over the first three weeks from that anchor.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS bulk_send_started_at TIMESTAMPTZ;

-- --- Contact groups / segments ---
-- Static groups have explicit membership rows; dynamic groups store criteria and
-- resolve members on read (so they don't go stale as leads move stages).
CREATE TABLE IF NOT EXISTS contact_groups (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2563eb',
  kind TEXT NOT NULL DEFAULT 'static' CHECK (kind IN ('static','dynamic')),
  criteria JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, name)
);

CREATE TABLE IF NOT EXISTS contact_group_members (
  group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_contact ON contact_group_members (contact_id);
