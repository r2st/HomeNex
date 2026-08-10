-- agents.email had no uniqueness constraint and no index, yet both signup and the
-- admin profile edit enforce "this email is taken" with a SELECT-then-INSERT. Two
-- concurrent signups with the same address both pass the check and both write, and
-- from then on findAgentByEmail returns whichever row Postgres happens to hand back
-- first — so logging in by email lands in an arbitrary one of two accounts.
--
-- The same index also gets the lookup off a sequential scan. It is on the login
-- path, and it was the only unindexed one there.
--
-- Emails are written lowercased everywhere (createAgent, updateAgentProfile), but
-- the index is on lower(email) so the constraint holds even if some future path
-- forgets, and so "Bob@x.com" can never become a second account beside "bob@x.com".

-- Normalize the empty string to NULL first: "no email" has always meant NULL here,
-- and '' would otherwise collide with itself across every emailless agent.
UPDATE agents SET email = NULL WHERE email = '';

-- Collapse any pre-existing collisions before constraining, or this migration
-- fails and takes the boot with it. The oldest account keeps the address; the
-- later ones lose it. Nothing is locked out: the WhatsApp number is the login
-- identity ("email still accepted for older accounts"), and for a duplicated
-- address email login was already ambiguous — this makes it honest.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY lower(email) ORDER BY id) AS rn
    FROM agents WHERE email IS NOT NULL
)
UPDATE agents a SET email = NULL
  FROM ranked r WHERE a.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_email_unique
  ON agents (lower(email)) WHERE email IS NOT NULL;
