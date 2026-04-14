import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://sprlcvxlcjwhfzspkrww.supabase.co";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNwcmxjdnhsY2p3aGZ6c3Brcnd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzkwNDMsImV4cCI6MjA4ODM1NTA0M30.PLc-d6jtIxILdqTev4lrMKOamrFJQ1nljNqJTLfHIU8";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Row converters: Supabase snake_case ↔ app camelCase ─────────────────────

export const rowToUser = (r) => ({
  id:                r.id,
  name:              r.name,
  firstName:         r.first_name        || '',
  lastName:          r.last_name         || '',
  email:             r.email,
  phone:             r.phone             || '',
  mobile:            r.mobile            || '',
  role:              r.role,
  // password intentionally excluded — never loaded into allUsers state
  // fetched separately at login time via loadUserPassword()
  allocatedTo:       r.allocated_to      || [],
  trade:             r.trade             || '',
  licenceExpiry:     r.licence_expiry    || '',
  siteSafeExpiry:    r.site_safe_expiry  || '',
  firstAidExpiry:    r.first_aid_expiry  || '',
  address:           r.address           || '',
  addressLine2:      r.address_line2     || '',
  suburb:            r.suburb            || '',
  city:              r.city              || '',
  postcode:          r.postcode          || '',
  approverUserId:    r.approver_user_id  || null,
  viewerUserId:      r.viewer_user_id    || null,
  secondaryRole:     r.secondary_role    || null,
  adminLevel:        r.admin_level       || 1,
  xeroEmployeeId:    r.xero_employee_id  || null,
  overtimeType:      r.overtime_type     || null,
  overtimeThreshold: r.overtime_threshold|| null,
  overtimeRateId:    r.overtime_rate_id  || null,
  mentorUserId:      r.mentor_user_id    || null,
  hostBusiness:      r.host_business     || '',
  dateOfBirth:       r.date_of_birth     || null,
  gender:            r.gender            || '',
  startDate:         r.start_date        || null,
  emergencyContactName:         r.emergency_contact_name         || '',
  emergencyContactPhone:        r.emergency_contact_phone        || '',
  emergencyContactRelationship: r.emergency_contact_relationship || '',
  licenceNumber:     r.licence_number    || '',
  siteSafeNumber:    r.site_safe_number  || '',
  reportsEmail:      r.reports_email     || '',
  company:           r.company           || '',
  supervisorIds:     r.supervisor_ids    || [],
  isConfOwner:       r.is_conf_owner     || false,
  mustChangePassword: r.must_change_password || false,
  lastLogin:         r.last_login         || null,
});

export const userToRow = (u) => {
  const row = {
    id:                 u.id,
    name:               u.name,
    first_name:         u.firstName         || '',
    last_name:          u.lastName          || '',
    email:              u.email,
    phone:              u.phone             || null,
    mobile:             u.mobile            || null,
    role:               u.role,
    allocated_to:       u.allocatedTo       || [],
    trade:              u.trade             || null,
    licence_expiry:     u.licenceExpiry     || null,
    site_safe_expiry:   u.siteSafeExpiry    || null,
    first_aid_expiry:   u.firstAidExpiry    || null,
    address:            u.address           || null,
    address_line2:      u.addressLine2      || null,
    suburb:             u.suburb            || null,
    city:               u.city              || null,
    postcode:           u.postcode          || null,
    approver_user_id:   u.approverUserId    || null,
    viewer_user_id:     u.viewerUserId      || null,
    secondary_role:     u.secondaryRole     || null,
    admin_level:        u.adminLevel        || 1,
    xero_employee_id:   u.xeroEmployeeId    || null,
    overtime_type:      u.overtimeType      || null,
    overtime_threshold: u.overtimeThreshold || null,
    overtime_rate_id:   u.overtimeRateId    || null,
    mentor_user_id:     u.mentorUserId      || null,
    host_business:      u.hostBusiness      || null,
    date_of_birth:      u.dateOfBirth       || null,
    gender:             u.gender            || null,
    start_date:         u.startDate         || null,
    emergency_contact_name:         u.emergencyContactName         || null,
    emergency_contact_phone:        u.emergencyContactPhone        || null,
    emergency_contact_relationship: u.emergencyContactRelationship || null,
    licence_number:     u.licenceNumber     || null,
    site_safe_number:   u.siteSafeNumber    || null,
    reports_email:      u.reportsEmail      || null,
    company:            u.company           || null,
  };
  // Only include must_change_password if explicitly provided
  if (u.mustChangePassword !== undefined) {
    row.must_change_password = u.mustChangePassword;
  }
  // Only include password if explicitly provided — prevents accidentally
  // clearing passwords when saving a user object loaded without the password field
  if (u.password !== undefined && u.password !== null && u.password !== '') {
    row.password = u.password;
  }
  return row;
};

export const rowToEntry = (r) => ({
  id:              r.id,
  userId:          r.user_id,
  date:            r.date,
  type:            r.type,
  start:           r.start_time,
  end:             r.end_time,
  breakMins:       r.break_mins,
  netHours:        parseFloat(r.net_hours),
  note:            r.note             || '',
  approval:        r.approval,
  createdAt:       r.created_at       || null,
  submittedAt:     r.submitted_at     || null,  // when apprentice submitted
  approvedBy:      r.approved_by      || null,  // user ID of approver
  approvedAt:      r.approved_at      || null,  // when approved
  declinedBy:      r.declined_by      || null,  // user ID who declined
  declinedAt:      r.declined_at      || null,  // when declined
  declinedNote:    r.declined_note    || null,  // approver's reason for declining
  xeroStatus:      r.xero_status      || null,
  xeroTimesheetId: r.xero_timesheet_id|| null,
  xeroError:       r.xero_error       || null,
});

export const entryToRow = (e) => ({
  id:                e.id,
  user_id:           e.userId,
  date:              e.date,
  type:              e.type,
  start_time:        e.start,
  end_time:          e.end,
  break_mins:        e.breakMins,
  net_hours:         e.netHours,
  note:              e.note            || '',
  approval:          e.approval,
  submitted_at:      e.submittedAt     || null,
  approved_by:       e.approvedBy      || null,
  approved_at:       e.approvedAt      || null,
  declined_by:       e.declinedBy      || null,
  declined_at:       e.declinedAt      || null,
  declined_note:     e.declinedNote    || null,
  xero_status:       e.xeroStatus      || null,
  xero_timesheet_id: e.xeroTimesheetId || null,
  xero_error:        e.xeroError       || null,
});

// ─── Data loaders ─────────────────────────────────────────────────────────────

// Explicit column list — deliberately excludes 'password' so hashes
// are never sent to the browser as part of the allUsers state.
// Password is only fetched at login time via loadUserPassword().
export const loadUsers = async () => {
  const { data, error } = await sb.from('users').select('*');
  if (error) throw error;
  return data.map(r => {
    const u = rowToUser(r);
    // Never expose password hashes in the browser — strip after fetch
    delete u.password;
    return u;
  });
};

// Fetches only the password hash for a single user at login time.
// Never loads all password hashes into the browser.
export const loadUserPassword = async (userId) => {
  const { data, error } = await sb
    .from('users')
    .select('id,password')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data?.password || null;
};

export const loadEntries = async () => {
  // Paginate to avoid Supabase's 1000-row default cap
  // WITHOUT pagination, rows >1000 are silently dropped and updateEntries
  // would then DELETE the missing rows from the database on next sync
  const PAGE = 1000;
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('entries')
      .select('*')
      .range(from, from + PAGE - 1)
      .order('date', { ascending: false });
    if (error) throw error;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all.map(rowToEntry);
};

// Fetches ALL rows from a table using pagination — bypasses Supabase's
// server-side PostgREST row cap (default 1000) by requesting in batches.
export const loadTable = async (table) => {
  const PAGE = 1000;
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from(table)
      .select('*')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < PAGE) break;   // last page — we're done
    from += PAGE;
  }
  return all;
};

// ─── Users ────────────────────────────────────────────────────────────────────

export const upsertUser = async (user) => {
  const { error } = await sb.from('users').upsert(userToRow(user));
  if (error) throw error;
};

// Targeted password change — only updates password + must_change_password.
// Avoids full-row upsert issues (RLS, missing fields, silent failures).
export const savePasswordChange = async (userId, hashedPassword) => {
  const { error } = await sb.from('users')
    .update({ password: hashedPassword, must_change_password: false })
    .eq('id', userId);
  if (error) throw error;
};

// Update a user's profile fields WITHOUT touching the password column.
// Use this for all profile saves where no password change is intended.
// Avoids the NOT NULL constraint on password when upsert sends null.
export const updateUserProfile = async (user) => {
  const row = userToRow(user);
  // Remove password fields entirely — DB keeps whatever it already has
  delete row.password;
  delete row.must_change_password;
  // If password was explicitly provided (admin reset), include it
  if (user.password !== undefined && user.password !== null && user.password !== '') {
    row.password = user.password;
  }
  if (user.mustChangePassword !== undefined) {
    row.must_change_password = user.mustChangePassword;
  }
  const { error } = await sb.from('users').upsert(row);
  if (error) throw error;
};

export const deleteUser = async (id) => {
  const { error } = await sb.from('users').delete().eq('id', id);
  if (error) throw error;
};

// ─── Entries ──────────────────────────────────────────────────────────────────

export const upsertEntry = async (entry) => {
  const row = {
    ...entryToRow(entry),
    created_at: entry.createdAt || new Date().toISOString(),
  };
  const { data, error } = await sb.from('entries').upsert(row, { onConflict: 'id' });
  if (error) {
    console.error('upsertEntry FAILED:', JSON.stringify(error), 'row:', JSON.stringify(row));
    throw error;
  }
  return data;
};

export const deleteEntry = async (id) => {
  const { error } = await sb.from('entries').delete().eq('id', id);
  if (error) throw error;
};

// ─── Generic table helpers ────────────────────────────────────────────────────

export const upsertRow = async (table, row) => {
  const { error } = await sb.from(table).upsert(row);
  if (error) throw error;
};

// Updates specific columns only — never overwrites unrelated columns
export const updateRow = async (table, id, changes) => {
  const { error } = await sb.from(table).update(changes).eq('id', id);
  if (error) throw error;
};

export const deleteRow = async (table, id) => {
  const { error } = await sb.from(table).delete().eq('id', id);
  if (error) throw error;
};

export const deleteAllRows = async (table) => {
  const { error } = await sb.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) throw error;
};

// ─── Notifications ────────────────────────────────────────────────────────────

export const loadNotifications = async (userId) => {
  const { data, error } = await sb
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
};

export const insertNotification = async (notif) => {
  const { error } = await sb.from('notifications').insert(notif);
  if (error) throw error;
};

export const markNotifRead = async (id) => {
  const { error } = await sb.from('notifications').update({ read: true }).eq('id', id);
  if (error) throw error;
};

export const markAllNotifsRead = async (userId) => {
  const { error } = await sb.from('notifications').update({ read: true }).eq('user_id', userId);
  if (error) throw error;
};

export const deleteNotif = async (id) => {
  const { error } = await sb.from('notifications').delete().eq('id', id);
  if (error) throw error;
};

// ─── Messages ─────────────────────────────────────────────────────────────────

export const insertMessage = async (msg) => {
  const { error } = await sb.from('messages').insert(msg);
  if (error) throw error;
};

export const loadMessages = async (apprenticeId) => {
  const { data, error } = await sb
    .from('messages')
    .select('*')
    .eq('apprentice_id', apprenticeId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
};

export const deleteMessage = async (id) => {
  const { error } = await sb.from('messages').delete().eq('id', id);
  if (error) throw error;
};

// ─── Licence reminders ────────────────────────────────────────────────────────

export const licenceReminderExists = async (userId, apprenticeId, daysUntil) => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from('notifications')
    .select('id')
    .eq('user_id', userId)
    .eq('type', 'licence_expiry')
    .gte('created_at', twoDaysAgo)
    .contains('meta', { apprenticeId, daysUntil });
  if (error) return false;
  return data.length > 0;
};
