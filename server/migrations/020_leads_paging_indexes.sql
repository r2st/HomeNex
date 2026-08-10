-- Supporting indexes for the paged lead list (GET /api/leads).
--
-- The list is ordered `updated_at DESC, id DESC` and now takes a LIMIT, so the planner
-- can stop after one page instead of sorting every lead the agent owns. idx_leads_agent
-- from 001 is (agent_id, updated_at) ASC with no id tiebreak, which forces a sort once
-- id joins the ORDER BY; this one matches the sort exactly.
CREATE INDEX IF NOT EXISTS idx_leads_agent_recent ON leads (agent_id, updated_at DESC, id DESC);

-- The list also unions in the shared unassigned pool (agent_id IS NULL). That arm is a
-- small slice of the table, so a partial index keeps it cheap and stays tiny.
CREATE INDEX IF NOT EXISTS idx_leads_unassigned_recent
  ON leads (updated_at DESC, id DESC) WHERE agent_id IS NULL;

-- leadCounts() groups by (pipeline_type, stage) for one agent. idx_leads_pipeline from
-- 002 already covers (agent_id, pipeline_type, stage) for the owned arm; the pool arm
-- needs its own, again partial.
CREATE INDEX IF NOT EXISTS idx_leads_unassigned_pipeline
  ON leads (pipeline_type, stage) WHERE agent_id IS NULL;
