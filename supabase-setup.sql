-- ============================================================
-- WorkOS — Supabase Database Setup
-- Run this entire script in Supabase → SQL Editor → New Query
-- ============================================================

-- 1. USERS TABLE
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text unique not null,
  role          text not null check (role in ('Apprentice','Approver','Supervisor','Mentor','Admin')),
  phone         text,
  password_hash text not null,
  allocated_to  uuid[] default '{}',
  created_at    timestamptz default now()
);

-- 2. TIMESHEET ENTRIES
create table if not exists timesheet_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete cascade,
  date        date not null,
  type        text not null,
  start_time  text not null,
  end_time    text not null,
  break_mins  integer default 0,
  net_hours   numeric(4,2) not null,
  note        text,
  approval    text default 'pending' check (approval in ('pending','approved','declined')),
  created_at  timestamptz default now()
);

-- 3. CRM CONTACTS
create table if not exists crm_contacts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  company    text,
  email      text,
  phone      text,
  status     text default 'Active',
  notes      text,
  created_at timestamptz default now()
);

-- 4. CRM DEALS
create table if not exists crm_deals (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  contact    text,
  value      numeric(10,2),
  stage      text default 'Lead',
  close_date date,
  notes      text,
  created_at timestamptz default now()
);

-- ============================================================
-- SEED DEMO USERS  (all passwords = "password")
-- ============================================================
insert into users (name, email, role, phone, password_hash, allocated_to) values
  ('Alex Admin',       'admin@work.com',  'Admin',      '+61 400 001 001', 'cGFzc3dvcmQ=', '{}'),
  ('Sam Supervisor',   'sam@work.com',    'Supervisor',  '+61 400 001 002', 'cGFzc3dvcmQ=', '{}'),
  ('Ava Approver',     'ava@work.com',    'Approver',    '+61 400 001 003', 'cGFzc3dvcmQ=', '{}'),
  ('Mike Mentor',      'mike@work.com',   'Mentor',      '+61 400 001 004', 'cGFzc3dvcmQ=', '{}'),
  ('Jamie Apprentice', 'jamie@work.com',  'Apprentice',  '+61 400 001 005', 'cGFzc3dvcmQ=', '{}'),
  ('Riley Apprentice', 'riley@work.com',  'Apprentice',  '+61 400 001 006', 'cGFzc3dvcmQ=', '{}')
on conflict (email) do nothing;

-- ============================================================
-- OPTIONAL: Disable Row Level Security for quick setup
-- (Re-enable and add policies before going to production)
-- ============================================================
alter table users              disable row level security;
alter table timesheet_entries  disable row level security;
alter table crm_contacts       disable row level security;
alter table crm_deals          disable row level security;
