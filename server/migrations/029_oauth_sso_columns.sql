-- Add OAuth SSO columns to agents table for Google/GitHub/Microsoft login
ALTER TABLE agents ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(30);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS oauth_id VARCHAR(255);

-- Allow password_hash to be empty for OAuth-only accounts
ALTER TABLE agents ALTER COLUMN password_hash SET DEFAULT '';
