-- Add last_login tracking to the users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login timestamptz;
