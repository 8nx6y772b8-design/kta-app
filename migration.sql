-- KTA Workforce Management - Supabase Migration
-- Run in Supabase Dashboard > SQL Editor > New Query
-- Safe to run multiple times (uses IF NOT EXISTS)


-- SECTION 1: Add missing columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS address          text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suburb           text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city             text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS postcode         text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approver_user_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS viewer_user_id   text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS secondary_role   text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_level      integer DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS xero_employee_id text;


-- SECTION 2: Add Xero tracking columns to entries table
ALTER TABLE entries ADD COLUMN IF NOT EXISTS xero_status       text;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS xero_timesheet_id text;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS xero_error        text;


-- SECTION 3: Create messages table
CREATE TABLE IF NOT EXISTS messages (
  id            text PRIMARY KEY,
  apprentice_id text NOT NULL,
  sender_id     text NOT NULL,
  body          text NOT NULL,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_apprentice_idx ON messages (apprentice_id, created_at);


-- SECTION 4: Create meeting_reports table
CREATE TABLE IF NOT EXISTS meeting_reports (
  id                 text PRIMARY KEY,
  apprentice_id      text NOT NULL,
  mentor_id          text NOT NULL,
  date               date NOT NULL,
  location           text,
  off_job_progress   text,
  on_job_progress    text,
  previous_goals     text,
  goals_this_meeting text,
  comments_feedback  text,
  next_visit_date    date,
  summary            text,
  action_items       text,
  concerns           text,
  rating             text,
  notes              text,
  created_at         timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_reports_apprentice_idx ON meeting_reports (apprentice_id, date);


-- SECTION 5: Create ppe_allocations table
CREATE TABLE IF NOT EXISTS ppe_allocations (
  id            text PRIMARY KEY,
  apprentice_id text NOT NULL,
  mentor_id     text NOT NULL,
  item          text NOT NULL,
  quantity      integer DEFAULT 1,
  issued_date   date NOT NULL,
  notes         text,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ppe_allocations_apprentice_idx ON ppe_allocations (apprentice_id);


-- SECTION 6: Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id         text PRIMARY KEY,
  user_id    text NOT NULL,
  type       text NOT NULL,
  title      text NOT NULL,
  message    text,
  read       boolean DEFAULT false,
  created_by text,
  meta       jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);


-- Optional: delete seed/demo data (uncomment when ready)
-- DELETE FROM entries WHERE user_id IN ('u1','u2','u3','u4','u5','u6');
-- DELETE FROM users   WHERE id      IN ('u1','u2','u3','u4','u5','u6');


SELECT 'Migration complete' AS status;
