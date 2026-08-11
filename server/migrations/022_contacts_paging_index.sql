-- Supporting index for the paged contact list (GET /api/contacts).
--
-- The list is ordered `last_message_at DESC NULLS LAST, created_at DESC, id DESC` and
-- now takes a LIMIT, so the planner can stop after one page instead of sorting every
-- contact the agent has captured. idx_contacts_agent from 001 is (agent_id, created_at)
-- ASC, which does not match that sort at all and forces a full sort per poll.
--
-- The NULLS LAST in the index is not decoration: a DESC index defaults to NULLS FIRST,
-- and the ordering has to match the query's exactly or the planner sorts anyway. Most
-- contacts have a NULL last_message_at until someone messages, so that arm is the
-- common case rather than the edge.
CREATE INDEX IF NOT EXISTS idx_contacts_agent_recent
  ON contacts (agent_id, last_message_at DESC NULLS LAST, created_at DESC, id DESC);

-- The source filter (?source=referral) narrows by an equality before that sort.
CREATE INDEX IF NOT EXISTS idx_contacts_agent_source
  ON contacts (agent_id, source, last_message_at DESC NULLS LAST, id DESC);
