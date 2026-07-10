-- 004: AI lead categorization, WhatsApp 24h service window, property micro-pages,
-- and festive greeting scheduling.

-- leads: AI-extracted intent + raw extraction payload, and the service-window anchor.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS intent TEXT
    CHECK (intent IN ('buy','rent','sell','invest','browse')),
  ADD COLUMN IF NOT EXISTS ai_extracted JSONB,
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

-- Backfill the window anchor from the latest buyer message per lead.
UPDATE leads l SET last_inbound_at = m.last_buyer_at
FROM (
  SELECT lead_id, MAX(created_at) AS last_buyer_at
  FROM messages WHERE role = 'buyer' GROUP BY lead_id
) m
WHERE m.lead_id = l.id AND l.last_inbound_at IS NULL;

-- properties: micro-page view counter (slug column already exists from 002).
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS page_views INTEGER NOT NULL DEFAULT 0;

-- Raw view log — each public micro-page hit, used as an engagement signal.
CREATE TABLE IF NOT EXISTS property_page_views (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  referrer TEXT,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_page_views_property ON property_page_views (property_id, viewed_at);

-- Festive greeting sends: an agent schedules (or fires immediately) a greeting
-- to their contacts for a festival. The scheduler delivers due rows.
CREATE TABLE IF NOT EXISTS festive_schedules (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  festival_key TEXT NOT NULL,
  message TEXT NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sent','cancelled','failed')),
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_festive_due ON festive_schedules (status, send_at);
CREATE INDEX IF NOT EXISTS idx_festive_agent ON festive_schedules (agent_id, send_at);
