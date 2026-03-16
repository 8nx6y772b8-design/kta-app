import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Row converters: Supabase snake_case ↔ app camelCase ─────────────────────

export const rowToUser = (r) => ({
  id:                r.id,
  name:              r.name,
  firstName:         r.first_name        || '',
  lastName:          r.last_name         || '',
  email:             r.email,
  phone:             r.phone             || '',
  role:              r.role,
  password:          r.password,
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
});

export const userToRow = (u) => ({
  id:                 u.id,
  name:               u.name,
  first_name:         u.firstName         || '',
  last_name:          u.lastName          || '',
  email:              u.email,
  phone:              u.phone             || null,
  role:               u.role,
  password:           u.password,
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
});

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
  xero_status:       e.xeroStatus      || null,
  xero_timesheet_id: e.xeroTimesheetId || null,
  xero_error:        e.xeroError       || null,
});

// ─── Data loaders ─────────────────────────────────────────────────────────────

export const loadUsers = async () => {
  const { data, error } = await sb.from('users').select('*');
  if (error) throw error;
  return data.map(rowToUser);
};

export const loadEntries = async () => {
  const { data, error } = await sb.from('entries').select('*');
  if (error) throw error;
  return data.map(rowToEntry);
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

export const deleteUser = async (id) => {
  const { error } = await sb.from('users').delete().eq('id', id);
  if (error) throw error;
};

// ─── Entries ──────────────────────────────────────────────────────────────────

export const upsertEntry = async (entry) => {
  const { error } = await sb.from('entries').upsert(entryToRow(entry));
  if (error) throw error;
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
