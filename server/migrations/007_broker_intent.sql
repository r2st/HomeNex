-- 007: allow 'broker' as a lead intent.
--
-- The AI inquiry-categorizer now distinguishes another property dealer/agent
-- reaching out ("main property dealer hu, tie-up karna hai") from an end buyer, so
-- the CHECK constraint added in 004 must accept 'broker' alongside the existing set.
-- Recreate the constraint (its default name is leads_intent_check) idempotently.

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_intent_check;
ALTER TABLE leads
  ADD CONSTRAINT leads_intent_check
  CHECK (intent IN ('buy','rent','sell','invest','browse','broker'));
