-- Meta redelivers webhook events on any ack hiccup (slow response, network blip,
-- restart mid-request). Without a uniqueness guard, a redelivered inbound message
-- was persisted twice, triggering a duplicate AI reply (and a duplicate WhatsApp
-- send + OpenRouter call) for the same buyer message. wa_message_id is Meta's own
-- message id and is globally unique, so a partial unique index (NULLs — outbound
-- messages sent before this migration, or sends that failed before getting a wa id —
-- are never compared against each other) is enough to make inbound processing
-- idempotent: the second insert attempt fails and the handler treats that as
-- "already processed".
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_message_id
  ON messages (wa_message_id) WHERE wa_message_id IS NOT NULL;
