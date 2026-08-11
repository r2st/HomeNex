-- Supporting index for the paged property list (GET /api/properties).
--
-- The list is ordered `updated_at DESC, id DESC` and now takes a LIMIT, so the planner
-- can stop after one page instead of sorting the agent's whole inventory on every poll.
-- idx_properties_agent from 002 is (agent_id, status), which narrows the status filter
-- but says nothing about the sort, so every poll still sorted the full match set.
--
-- No NULLS clause here, unlike the contacts index in 022: properties.updated_at is
-- NOT NULL DEFAULT now(), so the NULLS FIRST that a DESC index defaults to describes an
-- arm that cannot occur, and matching the query's ordering needs nothing extra.
CREATE INDEX IF NOT EXISTS idx_properties_agent_recent
  ON properties (agent_id, updated_at DESC, id DESC);

-- The status filter (?status=available) is the one the Properties screen sends most —
-- it is a chip on the default view — and it narrows by equality before that same sort.
CREATE INDEX IF NOT EXISTS idx_properties_agent_status_recent
  ON properties (agent_id, status, updated_at DESC, id DESC);
