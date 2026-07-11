-- 012: Unified WhatsApp Inbox upgrade + Template Messages.
--
-- (Numbered 012 to sit after the concurrently-added 010_lead_sources and 011_teams
-- migrations. This layer is independent of teams: it adds assigned_agent_id for
-- lightweight thread reassignment, distinct from teams' team_id/assigned_at.)
--
-- Adds the team-inbox layer (assignment, unread tracking, internal notes), saved
-- quick replies with variables, a reusable media library with per-contact send
-- tracking, and an auto+manual label system. Extends message_templates so a curated
-- pre-approved pack can ship per workspace with bodies agents may fill but not edit.
--
-- Money stays in paise (no monetary columns here). Every agent-owned table carries
-- agent_id for multi-tenancy, matching 002.

-- --- Team inbox: assignment + unread state on the thread (a thread == a lead) ---
ALTER TABLE leads
  -- Who is actively handling this thread. Defaults to the owner (agent_id); an admin
  -- or the owner can reassign. NULL falls back to agent_id in the API layer.
  ADD COLUMN IF NOT EXISTS assigned_agent_id INTEGER REFERENCES agents(id),
  -- When the handling agent last opened this thread. Unread = a buyer message exists
  -- with created_at > last_read_at. Computing it this way avoids counter drift.
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads (assigned_agent_id);

-- --- Internal notes: private to the team, never sent to WhatsApp ---
CREATE TABLE IF NOT EXISTS lead_notes (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes (lead_id, id);

-- --- Quick replies: saved snippets with {{name}}/{{property}}/{{visit_time}} vars ---
CREATE TABLE IF NOT EXISTS quick_replies (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,          -- short label / shortcut shown in the picker
  body TEXT NOT NULL,           -- snippet body, may contain {{variables}}
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, title)
);
CREATE INDEX IF NOT EXISTS idx_quick_replies_agent ON quick_replies (agent_id);

-- --- Media library: upload once, attach to any chat; track sends per contact ---
CREATE TABLE IF NOT EXISTS media_assets (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'document'
    CHECK (kind IN ('brochure','floor_plan','photo','video','document')),
  -- Where the file lives. 'local' files are written under server/uploads and served
  -- at /uploads/<file>; 'url' assets are already-hosted links (e.g. a portal PDF).
  storage TEXT NOT NULL DEFAULT 'local' CHECK (storage IN ('local','url')),
  url TEXT NOT NULL,            -- public URL WhatsApp can fetch (link-based media send)
  filename TEXT,               -- original filename, for the download name / display
  mime TEXT,
  size_bytes BIGINT,
  caption TEXT,                -- optional default caption sent with the media
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_assets_agent ON media_assets (agent_id, created_at DESC);

-- Every time an asset is sent to a contact, so the UI can show "already sent".
CREATE TABLE IF NOT EXISTS media_sends (
  id SERIAL PRIMARY KEY,
  media_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  wa_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_sends_media ON media_sends (media_id);
CREATE INDEX IF NOT EXISTS idx_media_sends_lead ON media_sends (lead_id);

-- --- Labels: auto + manual tags on a thread ---
CREATE TABLE IF NOT EXISTS labels (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b',   -- hex, for the chip
  -- Non-null on system labels that HomeNex applies automatically. The API maps a
  -- lifecycle event (new lead, went hot, visit booked, ...) to this key.
  auto_key TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, name)
);
CREATE INDEX IF NOT EXISTS idx_labels_agent ON labels (agent_id);

CREATE TABLE IF NOT EXISTS lead_labels (
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  applied_by TEXT NOT NULL DEFAULT 'manual' CHECK (applied_by IN ('auto','manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_labels_label ON lead_labels (label_id);

-- --- Template Messages: curated pre-approved pack; agents fill, cannot edit body ---
ALTER TABLE message_templates
  -- Shipped by HomeNex as part of the workspace pack (vs. an agent's own template).
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false,
  -- Body is frozen: agents may fill variables but not edit the approved wording.
  -- The API refuses body edits when is_locked, and locks any Meta-approved template.
  ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';

-- === Seed workspace defaults for every EXISTING agent ==========================
-- New agents get the same defaults via seedWorkspaceDefaults() on signup. All seeds
-- are ON CONFLICT DO NOTHING so re-running (or a partial prior seed) is safe.

-- System labels (the six lifecycle labels from the spec).
INSERT INTO labels (agent_id, name, color, auto_key, is_system, sort)
SELECT a.id, v.name, v.color, v.auto_key, true, v.sort
FROM agents a
CROSS JOIN (VALUES
  ('New',                  '#3b82f6', 'new',                  0),
  ('Hot',                  '#ef4444', 'hot',                  1),
  ('Site Visit Scheduled', '#8b5cf6', 'site_visit_scheduled', 2),
  ('Token Paid',           '#10b981', 'token_paid',           3),
  ('Lost',                 '#6b7280', 'lost',                 4),
  ('Broker',               '#f59e0b', 'broker',               5)
) AS v(name, color, auto_key, sort)
ON CONFLICT (agent_id, name) DO NOTHING;

-- Default quick replies.
INSERT INTO quick_replies (agent_id, title, body, is_system)
SELECT a.id, v.title, v.body, true
FROM agents a
CROSS JOIN (VALUES
  ('Greeting',        'Hi {{name}}, thanks for reaching out! How can I help with your property search today?'),
  ('Share brochure',  'Hi {{name}}, sharing the details for {{property}}. Let me know what you think!'),
  ('Visit confirm',   'Great, {{name}}! Your site visit for {{property}} is confirmed for {{visit_time}}. See you there.'),
  ('Ask budget',      'To shortlist the best options for you, may I know your budget range and preferred locality?'),
  ('Follow up',       'Hi {{name}}, just following up on your property enquiry. Are you still looking? Happy to help.')
) AS v(title, body)
ON CONFLICT (agent_id, title) DO NOTHING;

-- Curated pre-approved template pack. Bodies are locked; agents fill the variables.
-- Marketing templates carry rera_auto_append=true so the agent's RERA number is
-- appended at send time.
INSERT INTO message_templates
  (agent_id, name, category, body, variables, rera_auto_append, is_system, is_locked, meta_status, language)
SELECT a.id, v.name, v.category, v.body, v.variables::jsonb, v.rera, true, true, 'approved', 'en'
FROM agents a
CROSS JOIN (VALUES
  ('welcome',            'utility',
   'Hi {{name}}, thanks for connecting with us. How can we help you find your next home today?',
   '["name"]', false),
  ('site_visit_reminder','utility',
   'Hi {{name}}, a reminder for your site visit at {{property}} on {{visit_time}}. Reply here if you need to reschedule.',
   '["name","property","visit_time"]', false),
  ('new_listing',        'marketing',
   'Hi {{name}}, a new property matching your requirement just came up: {{property}}. Would you like the details?',
   '["name","property"]', true),
  ('price_update',       'marketing',
   'Hi {{name}}, there is a price update on {{property}}. Reply YES to get the latest pricing and availability.',
   '["name","property"]', true),
  ('festival_greeting',  'marketing',
   'Hi {{name}}, wishing you and your family a joyful festive season from all of us!',
   '["name"]', true)
) AS v(name, category, body, variables, rera)
ON CONFLICT (agent_id, name) DO NOTHING;
