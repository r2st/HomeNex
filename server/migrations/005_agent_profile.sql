-- 005: agent profile, preferences and account activation.
--
-- Profile fields an Indian real-estate agent actually needs (business name, city,
-- RERA registration id, bio, photo), locale preferences that drive day boundaries,
-- and an is_active flag so admins can suspend an agent without deleting their data.
--
-- SMALLINT 0/1 flags match the existing is_admin/ai_enabled convention so the API
-- keeps returning the values the frontend already compares against.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS business_name TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS rera_id TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS notify_new_lead SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS notify_followup_due SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS notify_daily_digest SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quiet_hours_start SMALLINT,
  ADD COLUMN IF NOT EXISTS quiet_hours_end SMALLINT,
  ADD COLUMN IF NOT EXISTS is_active SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

ALTER TABLE agents
  ADD CONSTRAINT agents_quiet_hours_start_check
    CHECK (quiet_hours_start IS NULL OR (quiet_hours_start BETWEEN 0 AND 23)),
  ADD CONSTRAINT agents_quiet_hours_end_check
    CHECK (quiet_hours_end IS NULL OR (quiet_hours_end BETWEEN 0 AND 23)),
  -- Quiet hours are a range: either both ends are set, or neither is.
  ADD CONSTRAINT agents_quiet_hours_pair_check
    CHECK ((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)),
  ADD CONSTRAINT agents_is_active_check CHECK (is_active IN (0, 1)),
  -- deactivated_at is set exactly when the agent is deactivated.
  ADD CONSTRAINT agents_deactivated_at_check
    CHECK ((is_active = 0) = (deactivated_at IS NOT NULL));

-- Admin listings filter on activation state; agent counts filter on both.
CREATE INDEX IF NOT EXISTS idx_agents_is_active ON agents(is_active);
CREATE INDEX IF NOT EXISTS idx_agents_admin_active ON agents(is_admin, is_active);
