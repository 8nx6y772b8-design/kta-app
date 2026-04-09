-- KTA Workforce Management — Full Schema
-- Migration: Initial schema for dev/test database

-- ─── USERS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                              text PRIMARY KEY,
  name                            text NOT NULL,
  email                           text UNIQUE NOT NULL,
  role                            text NOT NULL,
  password                        text,
  phone                           text,
  mobile                          text,
  address                         text,
  address_line2                   text,
  suburb                          text,
  city                            text,
  postcode                        text,
  allocated_to                    text[] DEFAULT '{}',
  supervisor_ids                  text[] DEFAULT '{}',
  approver_user_id                text,
  viewer_user_id                  text,
  secondary_role                  text,
  admin_level                     integer DEFAULT 1,
  xero_employee_id                text,
  overtime_type                   text,
  overtime_threshold              numeric,
  overtime_rate_id                text,
  mentor_user_id                  text,
  host_business                   text,
  date_of_birth                   date,
  gender                          text,
  start_date                      date,
  emergency_contact_name          text,
  emergency_contact_phone         text,
  emergency_contact_relationship  text,
  licence_number                  text,
  site_safe_number                text,
  reports_email                   text,
  company                         text,
  licence_expiry                  date,
  site_safe_expiry                date,
  first_aid_expiry                date,
  trade                           text,
  first_name                      text,
  last_name                       text,
  is_conf_owner                   boolean DEFAULT false,
  must_change_password            boolean DEFAULT false,
  created_at                      timestamptz DEFAULT now()
);

-- ─── ENTRIES ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entries (
  id                text PRIMARY KEY,
  user_id           text REFERENCES users(id) ON DELETE CASCADE,
  date              date NOT NULL,
  type              text NOT NULL,
  start_time        text,
  end_time          text,
  break_mins        integer DEFAULT 0,
  net_hours         numeric(4,2),
  note              text,
  approval          text DEFAULT 'draft',
  created_at        timestamptz DEFAULT now(),
  submitted_at      timestamptz,
  approved_by       text,
  approved_at       timestamptz,
  declined_by       text,
  declined_at       timestamptz,
  xero_status       text,
  xero_timesheet_id text,
  xero_error        text
);

-- ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
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

-- ─── MESSAGES ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id            text PRIMARY KEY,
  apprentice_id text NOT NULL,
  sender_id     text NOT NULL,
  body          text NOT NULL,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_apprentice_idx ON messages (apprentice_id, created_at);

-- ─── MEETING REPORTS ──────────────────────────────────────────────────────────
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

-- ─── PPE ALLOCATIONS ──────────────────────────────────────────────────────────
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

-- ─── LEAVE REQUESTS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_requests (
  id                text PRIMARY KEY,
  apprentice_id     text NOT NULL,
  approver_id       text,
  leave_type        text NOT NULL,
  date_from         date NOT NULL,
  date_to           date NOT NULL,
  notes             text,
  status            text DEFAULT 'pending',
  decline_reason    text,
  absence_notified  boolean DEFAULT false,
  reminder_due_at   timestamptz,
  reminder_sent     boolean DEFAULT false,
  created_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leave_requests_apprentice_idx ON leave_requests (apprentice_id, created_at DESC);

-- ─── HSE CHECK-INS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hse_checkins (
  id            text PRIMARY KEY,
  apprentice_id text NOT NULL,
  mentor_id     text,
  date          date NOT NULL,
  answers       jsonb DEFAULT '{}',
  notes         text,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hse_checkins_apprentice_idx ON hse_checkins (apprentice_id, date DESC);

-- ─── CRM CONTACTS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_contacts (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  company    text,
  company_id text,
  email      text,
  phone      text,
  mobile     text,
  status     text DEFAULT 'Active',
  notes      text,
  created_at timestamptz DEFAULT now()
);

-- ─── CRM DEALS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_deals (
  id         text PRIMARY KEY,
  title      text NOT NULL,
  contact    text,
  contact_id text,
  value      numeric(10,2),
  stage      text DEFAULT 'Lead',
  close_date date,
  notes      text,
  created_at timestamptz DEFAULT now()
);

-- ─── DISABLE ROW LEVEL SECURITY (app handles auth) ───────────────────────────
ALTER TABLE users              DISABLE ROW LEVEL SECURITY;
ALTER TABLE entries            DISABLE ROW LEVEL SECURITY;
ALTER TABLE notifications      DISABLE ROW LEVEL SECURITY;
ALTER TABLE messages           DISABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_reports    DISABLE ROW LEVEL SECURITY;
ALTER TABLE ppe_allocations    DISABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests     DISABLE ROW LEVEL SECURITY;
ALTER TABLE hse_checkins       DISABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts       DISABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deals          DISABLE ROW LEVEL SECURITY;

-- ─── SEED: Admin user (password = "admin") ───────────────────────────────────
-- SHA-256 hash of "admin" with salt "devtest"
-- Use the app's password reset to set a real password after first login
INSERT INTO users (id, name, email, role, admin_level, password, must_change_password)
VALUES ('admin-dev-001', 'Dev Admin', 'admin@kta.org.nz', 'Admin', 1,
        'devtest:cf389b528ed9e9fca5ad4ddde0e2dbc60e5bbded9d40fa05966cf4d76b9b7eed',
        true)
ON CONFLICT (email) DO NOTHING;
