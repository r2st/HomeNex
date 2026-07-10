-- 003: seed default pipeline stages.
-- The buy journey applies to both primary (builder) and resale purchases.

INSERT INTO pipeline_stages (pipeline_type, stage_name, stage_order, is_default)
SELECT p.pipeline_type, s.stage_name, s.stage_order, true
FROM (VALUES ('buy_primary'), ('buy_resale')) AS p(pipeline_type)
CROSS JOIN (VALUES
  ('New', 1),
  ('Qualified', 2),
  ('Shortlist Sent', 3),
  ('Site Visit Scheduled', 4),
  ('Site Visit Done', 5),
  ('Negotiation', 6),
  ('Token/Booking', 7),
  ('Agreement', 8),
  ('Registered/Closed', 9),
  ('Lost', 10)
) AS s(stage_name, stage_order)
ON CONFLICT (pipeline_type, stage_name) DO NOTHING;

INSERT INTO pipeline_stages (pipeline_type, stage_name, stage_order, is_default)
VALUES
  ('rental', 'New', 1, true),
  ('rental', 'Qualified', 2, true),
  ('rental', 'Options Sent', 3, true),
  ('rental', 'Visit', 4, true),
  ('rental', 'Deposit/Token', 5, true),
  ('rental', 'Agreement Signed', 6, true),
  ('rental', 'Closed', 7, true),
  ('rental', 'Lost', 8, true)
ON CONFLICT (pipeline_type, stage_name) DO NOTHING;
