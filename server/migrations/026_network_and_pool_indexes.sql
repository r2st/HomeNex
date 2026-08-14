-- 026: two indexes for the reads that stayed unindexed.

-- The broker network board is the only table nobody's agent_id scopes — every agent
-- reads every listing — so it grows with the platform, not with one brokerage. Both
-- reads over it filter or order on columns with no index at all:
--
--   * computeMatches() takes only type = 'INVENTORY', and requirements are roughly
--     half the board, so the scan did double the work it needed to. It is a cross
--     join against the agent's buyers, which means this scan is the inner side —
--     exactly where a sequential scan hurts most.
--   * listNetworkPosts() takes the newest 50 by id. The primary key already serves
--     that, so it is only the type filter that needed help.
--
-- (type, id DESC) rather than (type): the id column makes it a covering order for a
-- per-type feed, which is the obvious next thing this board grows.
CREATE INDEX IF NOT EXISTS idx_network_posts_type
  ON network_posts (type, id DESC);

-- The shared unassigned pool is now team-scoped: a pool lead carrying a team tag
-- belongs to that team's inbox and is invisible to everybody else (see poolReachable
-- in db.js). Every pool read therefore filters on team_id as well as agent_id.
--
-- idx_leads_unassigned_recent from 020 still drives the ordering, and the pool is a
-- small slice of the table, so this is deliberately the cheap version of the fix:
-- one partial index that lets the planner resolve the team leg from the index instead
-- of re-reading heap tuples for pool rows belonging to other brokerages. It stays
-- tiny for the same reason 020's does — WHERE agent_id IS NULL.
CREATE INDEX IF NOT EXISTS idx_leads_unassigned_team
  ON leads (team_id) WHERE agent_id IS NULL;
