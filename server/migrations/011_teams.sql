-- 011: Team Management (§5.3).
--
-- Until now every agent has been a flat, independent tenant: leads/contacts/
-- properties are scoped by agent_id and nobody else can see them. A brokerage,
-- though, is a team — an owner with managers and agents working one WhatsApp
-- Business number (or per-agent lines under one WABA), sharing an inbox, with
-- leads distributed between them.
--
-- This migration layers a team over the existing agents table without disturbing
-- the solo-agent model:
--   * An agent belongs to at most one team (team_members.agent_id is UNIQUE).
--   * A solo agent has no team row and behaves exactly as before.
--   * Ownership of a lead is still agent_id; team_id is a denormalized tag that
--     lets managers see the whole team's pipeline. The privacy wall is enforced
--     in the API: agents only ever see their own leads through /api/leads, while
--     /api/team/* is gated to managers and owners.

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  owner_agent_id INTEGER NOT NULL REFERENCES agents(id),
  -- How new/pooled leads are handed to members:
  --   round_robin — cycle through members who accept leads (rr_cursor tracks position)
  --   locality    — match the lead's locality against each member's localities
  --   manual      — a manager assigns every lead by hand
  --   pool        — leads sit in a shared inbox for members to claim
  assignment_strategy TEXT NOT NULL DEFAULT 'manual'
    CHECK (assignment_strategy IN ('round_robin','locality','manual','pool')),
  rr_cursor INTEGER NOT NULL DEFAULT 0,       -- monotonic round-robin counter
  -- The shared WhatsApp Business line, when the team works one number. Inbound on
  -- this phone_number_id is a team lead. NULL = members use their own per-agent lines.
  shared_wa_phone_number_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL UNIQUE REFERENCES agents(id),   -- one team per agent
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('owner','manager','agent')),
  localities JSONB NOT NULL DEFAULT '[]',      -- for locality-based assignment
  accepts_leads SMALLINT NOT NULL DEFAULT 1,   -- 0 = skip in round-robin/locality routing
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members (team_id);

-- Pending invitations. An owner/manager invites by login (WhatsApp) number; the
-- invited agent — who must have or create a HomeNex account on that number — sees
-- the invite and accepts. Only one live invite per (team, phone).
CREATE TABLE IF NOT EXISTS team_invites (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,                          -- canonical E.164 of the invitee
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('manager','agent')),
  invited_by INTEGER NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_invites_pending
  ON team_invites (team_id, phone) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_team_invites_phone ON team_invites (phone) WHERE status = 'pending';

-- Leads gain a team tag + assignment timestamp. team_id is set whenever a lead is
-- owned (or pooled) within a team; it is what team-wide manager views read.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_leads_team ON leads (team_id, stage);
