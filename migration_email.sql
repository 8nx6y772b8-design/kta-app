-- KTA Email Activity Tracking — run in Supabase SQL Editor
-- Safe to re-run (uses IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS activity_notes (
  id             text PRIMARY KEY,
  person_email   text,           -- email address of the person this relates to
  person_id      text,           -- Supabase user id (if a KTA user)
  person_name    text,
  type           text DEFAULT 'note',  -- 'note' | 'email'
  subject        text,
  body           text,
  direction      text DEFAULT 'note',  -- 'inbound' | 'outbound' | 'note'
  email_id       text,           -- M365 message id (for pinned emails)
  from_address   text,
  to_address     text,
  email_date     timestamptz,
  created_at     timestamptz DEFAULT now()
);

-- Indexes for fast lookup by person
CREATE INDEX IF NOT EXISTS idx_activity_notes_person_email ON activity_notes(person_email);
CREATE INDEX IF NOT EXISTS idx_activity_notes_person_id   ON activity_notes(person_id);
CREATE INDEX IF NOT EXISTS idx_activity_notes_created_at  ON activity_notes(created_at DESC);

-- RLS: allow authenticated users full access (adjust to your policy if needed)
ALTER TABLE activity_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "activity_notes_all" ON activity_notes;
CREATE POLICY "activity_notes_all" ON activity_notes
  FOR ALL USING (true) WITH CHECK (true);
