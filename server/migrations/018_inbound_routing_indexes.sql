-- Index the two lookups every inbound WhatsApp message makes.
--
-- findContactByWaId answers "which agent owns this sender?" for every message that
-- arrives on the shared number. It did that by reading `SELECT * FROM contacts` —
-- the entire table, every agent's address book — into Node and scanning it twice in
-- JavaScript. That is the hottest query in the product and the only unbounded one
-- left in db.js: at 500 agents with 2,000 clients each it moved a million rows
-- across the wire to find one, on every single message.
--
-- The match rule can't use the plain UNIQUE(phone) index because it compares
-- *digits*: '+91 98120 00001', '919812000001' and '098120-00001' are one number
-- typed three ways, and the fallback arm matches on the last 10 digits so a number
-- saved without its country code still routes. Both arms are expression indexes
-- over exactly the expressions the query uses. regexp_replace and right are
-- IMMUTABLE, so both are indexable.
CREATE INDEX IF NOT EXISTS idx_contacts_phone_digits
  ON contacts ((regexp_replace(phone, '\D', '', 'g')));

CREATE INDEX IF NOT EXISTS idx_contacts_phone_digits_10
  ON contacts ((right(regexp_replace(phone, '\D', '', 'g'), 10)));

-- The other per-message lookup: which agent owns the WhatsApp Business line this
-- message landed on. findAgentByPhoneNumberId runs once per webhook change and
-- twice when the first (active-WABA) arm misses, and wa_phone_number_id had no
-- index at all — a sequential scan over agents on the inbound path.
CREATE INDEX IF NOT EXISTS idx_agents_wa_phone_number_id
  ON agents (wa_phone_number_id) WHERE wa_phone_number_id IS NOT NULL;
