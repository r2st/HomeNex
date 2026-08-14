-- Who spoke last, kept on the lead row instead of derived per lead, per poll.
--
-- Seven queries behind the polled screens all asked the same question — "when did
-- this lead last hear from us, and when did we last hear from them?" — and every one
-- of them answered it by reaching into `messages` once per lead. On a broker with
-- 8,400 open leads the dashboard's "unanswered" widget alone ran 8,400 index scans
-- into a 350k-row table to return 400 rows: 34,000 buffer reads, every poll, per
-- agent. The worklist's stale rule did 5,468 more for 22 rows.
--
-- `leads.last_inbound_at` already existed for the WhatsApp 24h service window, and
-- was already maintained on every buyer message. This adds its other half, so the
-- pair can answer all seven from the lead row itself.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_outbound_at TIMESTAMPTZ;

-- Backfill from history, same shape as 004's backfill of last_inbound_at.
UPDATE leads l
   SET last_outbound_at = m.last_at
  FROM (
    SELECT lead_id, MAX(created_at) AS last_at
      FROM messages WHERE role IN ('ai', 'agent') GROUP BY lead_id
  ) m
 WHERE m.lead_id = l.id AND l.last_outbound_at IS NULL;

-- And re-derive last_inbound_at for any lead that missed it. 004 only filled rows
-- that were NULL at the time, and addMessage has been stamping it as now() rather
-- than as the message's own created_at, so a backdated import could sit ahead of its
-- own last message. GREATEST keeps whichever is later — this never moves a marker
-- backwards.
UPDATE leads l
   SET last_inbound_at = GREATEST(COALESCE(l.last_inbound_at, m.last_at), m.last_at)
  FROM (
    SELECT lead_id, MAX(created_at) AS last_at
      FROM messages WHERE role = 'buyer' GROUP BY lead_id
  ) m
 WHERE m.lead_id = l.id;

-- Maintained by the database, not by addMessage.
--
-- This is the whole point of doing it here: the app has exactly one message-writing
-- path today, but a denormalised column that only one call site remembers to update
-- is a correctness bug waiting for the second one — an importer, a backfill script, a
-- test fixture inserting a conversation directly. A trigger cannot be forgotten.
--
-- messages.role is CHECK-constrained to ('buyer','ai','agent'), so an INSERT can only
-- ever push one of the two markers forward — GREATEST, one row, no scan.
CREATE OR REPLACE FUNCTION lead_message_recency() RETURNS trigger AS $$
BEGIN
  IF NEW.role = 'buyer' THEN
    UPDATE leads
       SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, NEW.created_at), NEW.created_at)
     WHERE id = NEW.lead_id;
  ELSE
    UPDATE leads
       SET last_outbound_at = GREATEST(COALESCE(last_outbound_at, NEW.created_at), NEW.created_at)
     WHERE id = NEW.lead_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_message_recency ON messages;
CREATE TRIGGER trg_lead_message_recency
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION lead_message_recency();

-- Rewriting history: the exact path, for the rare event.
--
-- The app appends messages and never edits or removes one, so in production this
-- never fires. It exists because "these two columns are the newest message in each
-- direction" is either always true or it is not a fact you can query — and an
-- incremental GREATEST cannot answer a row that moved BACKWARDS (a corrected
-- timestamp, a re-parented import, a row pulled out again). So when the columns the
-- markers are derived from change, the markers are re-derived from scratch rather
-- than nudged: two aggregates over one lead's messages (the buyer half comes off
-- 024's partial index; the other half reads the lead's rows and filters), on an
-- event the hot path never raises.
--
-- The suite leans on this constantly: ageing a conversation ("this lead has been
-- quiet a month") is a backdating UPDATE over messages, and without this the fixture
-- would say one thing and the lead row another.
CREATE OR REPLACE FUNCTION lead_message_recency_resync() RETURNS trigger AS $$
DECLARE
  target INTEGER;
BEGIN
  -- One statement per affected lead; a re-parented row has two.
  FOREACH target IN ARRAY (
    CASE
      WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.lead_id]
      WHEN OLD.lead_id IS DISTINCT FROM NEW.lead_id THEN ARRAY[OLD.lead_id, NEW.lead_id]
      ELSE ARRAY[NEW.lead_id]
    END
  ) LOOP
    UPDATE leads l
       SET last_inbound_at =
             (SELECT MAX(created_at) FROM messages WHERE lead_id = target AND role = 'buyer'),
           last_outbound_at =
             (SELECT MAX(created_at) FROM messages WHERE lead_id = target AND role IN ('ai','agent'))
     WHERE l.id = target;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_message_recency_resync ON messages;
CREATE TRIGGER trg_lead_message_recency_resync
AFTER UPDATE OF created_at, role, lead_id OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION lead_message_recency_resync();

-- "Leads waiting on a reply" is the dashboard's first widget and the worklist's
-- hottest signal, and it is a small slice of a large table — exactly what a partial
-- index is for. The predicate is written to match the query's word for word so the
-- planner can prove the index applies.
CREATE INDEX IF NOT EXISTS idx_leads_awaiting_reply
  ON leads (agent_id, last_inbound_at DESC)
  WHERE closed_at IS NULL
    AND last_inbound_at IS NOT NULL
    AND (last_outbound_at IS NULL OR last_outbound_at < last_inbound_at);

-- The mirror image, for the stale/quiet sweeps: leads nobody has spoken to in weeks.
CREATE INDEX IF NOT EXISTS idx_leads_last_contact
  ON leads (agent_id, GREATEST(last_inbound_at, last_outbound_at))
  WHERE closed_at IS NULL;
