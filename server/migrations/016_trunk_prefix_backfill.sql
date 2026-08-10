-- normalizePhone used to keep India's STD trunk prefix, so a number typed as
-- "098765 43210" was stored as the unroutable "+09876543210" instead of
-- "+919876543210". The function now drops the 0; this backfills the rows that
-- were written under the old rule, otherwise those contacts/agents/invites stay
-- stored under a key no lookup will ever normalize to again.
--
-- Every UPDATE is guarded by a NOT EXISTS on the corrected value: where both the
-- broken and the correct row already exist, the broken one is left alone rather
-- than blowing up the UNIQUE constraint. Those are pre-existing duplicates and
-- merging them is a judgement call, not a migration's.

-- Agents' login numbers (UNIQUE).
UPDATE agents a SET phone = '+91' || substr(a.phone, 3)
 WHERE a.phone ~ '^\+0\d{10}$'
   AND NOT EXISTS (SELECT 1 FROM agents b WHERE b.phone = '+91' || substr(a.phone, 3));

-- Agents' WhatsApp Business display numbers (not unique, no guard needed).
UPDATE agents SET wa_phone_number = '+91' || substr(wa_phone_number, 3)
 WHERE wa_phone_number ~ '^\+0\d{10}$';

-- Contacts (UNIQUE on phone across all agents).
UPDATE contacts c SET phone = '+91' || substr(c.phone, 3)
 WHERE c.phone ~ '^\+0\d{10}$'
   AND NOT EXISTS (SELECT 1 FROM contacts d WHERE d.phone = '+91' || substr(c.phone, 3));

-- Team invites are addressed by login number, so a stale prefix here means the
-- invitee can never match their own invite. Only pending rows matter (answered
-- ones are history) and only pending rows collide — the unique index is partial.
UPDATE team_invites t SET phone = '+91' || substr(t.phone, 3)
 WHERE t.phone ~ '^\+0\d{10}$' AND t.status = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM team_invites u
      WHERE u.team_id = t.team_id AND u.status = 'pending'
        AND u.phone = '+91' || substr(t.phone, 3)
   );
