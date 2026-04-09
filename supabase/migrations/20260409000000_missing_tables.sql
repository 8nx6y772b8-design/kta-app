-- ─── MISSING TABLES (not in original migration) ──────────────────────────────

CREATE TABLE IF NOT EXISTS crm_companies (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  is_host_business boolean DEFAULT false,
  website          text,
  phone            text,
  email            text,
  address          text,
  notes            text,
  status           text DEFAULT 'Active',
  created_at       timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_notes (
  id            text PRIMARY KEY,
  person_id     text,
  person_email  text,
  person_name   text,
  type          text DEFAULT 'note',
  activity_type text,
  subject       text,
  body          text,
  direction     text,
  created_at    timestamptz DEFAULT now(),
  is_locked     boolean DEFAULT false,
  notif_type    text,
  company_id    text,
  company       text,
  contact_id    text
);

CREATE TABLE IF NOT EXISTS dash_contacts (
  id         text PRIMARY KEY,
  name       text,
  company    text,
  company_id text,
  email      text,
  phone      text,
  mobile     text,
  notes      text,
  status     text DEFAULT 'Active',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dash_hosts (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  phone            text,
  email            text,
  address          text,
  capacity         integer DEFAULT 0,
  notes            text,
  status           text DEFAULT 'Active',
  is_host_business boolean DEFAULT true,
  created_at       timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dash_deals (
  id         text PRIMARY KEY,
  title      text NOT NULL,
  contact    text,
  contact_id text,
  company    text,
  company_id text,
  value      numeric(10,2),
  stage      text DEFAULT 'Lead',
  close_date date,
  notes      text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE crm_companies  DISABLE ROW LEVEL SECURITY;
ALTER TABLE activity_notes DISABLE ROW LEVEL SECURITY;
ALTER TABLE dash_contacts  DISABLE ROW LEVEL SECURITY;
ALTER TABLE dash_hosts     DISABLE ROW LEVEL SECURITY;
ALTER TABLE dash_deals     DISABLE ROW LEVEL SECURITY;
