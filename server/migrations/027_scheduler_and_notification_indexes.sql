-- 027: the two reads that stayed sequential once the scheduler stopped running per agent.

-- The service-window watch is the tightest job on the box — every 15 minutes, and its
-- miss is the expensive one (a free conversation becomes a paid template request). It
-- asks for leads whose last inbound message landed between 20 and 24 hours ago: a
-- four-hour slice of a column that spans the whole history of the business, which on a
-- seeded 48,000-lead book was 180 rows found by reading all 1,406 pages of `leads`.
--
-- No existing index could serve it. idx_leads_awaiting_reply (025) carries the whole
-- "waiting on a reply" rule in its predicate, and this query deliberately does not ask
-- that question — a window closes whether or not the agent has already replied — so the
-- planner cannot prove the query implies the index. idx_leads_last_contact is on
-- GREATEST(inbound, outbound), which is a different column for any lead the agent has
-- answered.
--
-- last_inbound_at leads rather than agent_id, which is the opposite of every other
-- index on this table, because this read is no longer per agent: one statement now
-- serves the whole customer base, and the four-hour window is the selective half.
-- Same seed: 1,406 buffers and 7.5ms became 9 buffers and 0.07ms.
CREATE INDEX IF NOT EXISTS idx_leads_service_window
  ON leads (last_inbound_at)
  WHERE closed_at IS NULL AND last_inbound_at IS NOT NULL;

-- The unread-notification badge is polled by every open dashboard, and it counts the
-- one slice of the table that stays small while the table itself only grows: the
-- scheduler files notifications forever and the agent reads nearly all of them.
--
-- idx_notifications_agent (agent_id, created_at DESC) has to hand every notification
-- the agent has ever received to a filter to find the handful still unread. At 600
-- notifications an agent that was 604 buffers per poll for 30 rows. The partial index
-- is a twentieth of the size of the full one because the rows leave it as they are
-- read — and it serves the unread LIST as well as the count, which is the same slice in
-- the same order.
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (agent_id, created_at DESC)
  WHERE read_at IS NULL;
