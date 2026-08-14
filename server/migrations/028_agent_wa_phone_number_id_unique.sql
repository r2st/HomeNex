-- agents.wa_phone_number_id is the Meta phone_number_id of an agent's WhatsApp
-- Business line, and it is what every inbound message is routed by:
-- findAgentByPhoneNumberId turns the webhook's metadata.phone_number_id into the
-- agent whose workspace the buyer's message belongs in.
--
-- Two agents were able to hold the same one. updateAgentPhoneConfig — the route an
-- agent uses on themselves — checks for a collision and refuses with PHONE_ID_TAKEN,
-- but updateWabaStatus, the admin route that sets the same column while flipping a
-- workspace to 'active', never did. So the constraint the product states was only
-- enforced on the path a support engineer is least likely to use, and there was
-- nothing underneath it: no unique index, and the only index on the column
-- (migration 018) is a plain one.
--
-- With a duplicate in place the routing query has no ORDER BY and no LIMIT, so
-- `rows[0]` is whichever row Postgres hands back first — and that is not stable,
-- because an UPDATE to either agent moves its row. A broker's buyer conversations
-- land in another broker's workspace, the AI answers under that broker's name, and
-- the pair can swap over on nothing more than an unrelated profile edit. It is
-- silent from both sides: neither agent sees an error, one just stops receiving.
--
-- The index is what makes the rule real, on both paths and against the check-then-act
-- race that both of them are.

-- Empty string first: "no line configured" has always meant NULL here, and '' would
-- otherwise collide with itself across every agent who has never set one up.
UPDATE agents SET wa_phone_number_id = NULL WHERE wa_phone_number_id = '';

-- Collapse any collision already in the table before constraining it, or this
-- migration fails and takes the boot down with it (same reasoning as 017).
--
-- Which agent keeps the line is not the oldest-wins rule 017 uses for email, because
-- for a phone_number_id there is a better answer available: the agent whose WABA is
-- actually live on it. 'active' outranks 'registered', which outranks anything else;
-- ties go to whoever registered first, then to the lower id. That is the agent Meta
-- is delivering to, so it is the agent already receiving the messages — this keeps
-- routing where it has been going rather than moving it.
--
-- The losers keep wa_phone_number (their display number, which is theirs and is not
-- a routing key) and their waba_status. Only the routing id is cleared, and clearing
-- it is what the agent-facing route would have done all along: they can set it again
-- and now get a straight "already assigned to another agent" instead of a coin flip.
WITH ranked AS (
  SELECT id, row_number() OVER (
           PARTITION BY wa_phone_number_id
           ORDER BY CASE waba_status WHEN 'active' THEN 0 WHEN 'registered' THEN 1 ELSE 2 END,
                    waba_registered_at NULLS LAST,
                    id
         ) AS rn
    FROM agents WHERE wa_phone_number_id IS NOT NULL
)
UPDATE agents a SET wa_phone_number_id = NULL
  FROM ranked r WHERE a.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_wa_phone_number_id_unique
  ON agents (wa_phone_number_id) WHERE wa_phone_number_id IS NOT NULL;

-- The plain index from 018 is now redundant: the unique index above covers exactly
-- the same column and the same partial predicate, so it serves the routing lookup
-- just as well while costing one fewer index to maintain on every agent write.
DROP INDEX IF EXISTS idx_agents_wa_phone_number_id;
