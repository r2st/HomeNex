-- 008: pipeline stage-transition history (for time-in-stage / conversion analytics)
-- and site-visit WhatsApp confirmation tracking.
--
-- The pipeline board already moves leads between stages, but each move overwrote
-- leads.stage with no record of when it happened — so "how long do leads sit in
-- Negotiation?" or "what's my Site Visit → Booking conversion?" was unanswerable.
-- lead_stage_events is an append-only log: one row per move, carrying the previous
-- stage and how long the lead spent there.

CREATE TABLE IF NOT EXISTS lead_stage_events (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  pipeline_type TEXT NOT NULL,
  from_stage TEXT,                          -- NULL for the very first stage a lead enters
  to_stage TEXT NOT NULL,
  lost_reason TEXT,                         -- set only when to_stage = 'Lost'
  seconds_in_from_stage BIGINT,             -- dwell time in from_stage, NULL when from_stage is NULL
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stage_events_agent ON lead_stage_events (agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stage_events_lead ON lead_stage_events (lead_id, id);

-- site_visits: remember which automated WhatsApp confirmations have already gone out
-- so the scheduler never double-sends (idempotent, like the notification dedupe).
ALTER TABLE site_visits
  ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ,   -- booking confirmation
  ADD COLUMN IF NOT EXISTS reminder_t1_sent_at TIMESTAMPTZ,    -- ~1 day before
  ADD COLUMN IF NOT EXISTS reminder_t2_sent_at TIMESTAMPTZ;    -- ~2 hours before (with location pin)
