-- WhatsApp sending is wa.me click-to-chat by default: the agent's own WhatsApp app
-- opens with the message pre-filled, so a broker needs no Meta Business setup to use
-- the dashboard. The Meta WhatsApp Cloud API (WABA) becomes an opt-in upgrade per
-- account, switched on here.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS wa_api_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Accounts already wired to Meta keep sending through the API exactly as before.
UPDATE agents SET wa_api_enabled = TRUE
 WHERE wa_api_enabled = FALSE
   AND (waba_status = 'active' OR wa_phone_number_id IS NOT NULL);

-- An agent message the dashboard handed to the agent's WhatsApp app (wa.me) rather
-- than delivering through the API. NULL = API / AI delivery.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_via TEXT;
