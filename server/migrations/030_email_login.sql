-- Email + password is now the login identity. The WhatsApp number becomes optional
-- at signup (an agent can add it later in Settings), so it can no longer be NOT NULL.
-- The UNIQUE constraint stays: Postgres treats NULLs as distinct.
ALTER TABLE agents ALTER COLUMN phone DROP NOT NULL;
