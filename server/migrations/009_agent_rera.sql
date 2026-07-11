-- 009: complete the agent RERA registration record.
--
-- 005 added agents.rera_id (the registration number). Indian RERA registrations are
-- issued per state and carry a validity period (typically 5 years), so compliance
-- surfaces need the issuing state and the expiry date alongside the number to warn
-- an agent before their registration lapses.
--
-- Both columns are nullable: existing agents keep working, and an agent who only
-- knows their number can leave state/expiry blank until they fill them in.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS rera_state TEXT,
  ADD COLUMN IF NOT EXISTS rera_expiry DATE;
