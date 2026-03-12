import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Generic helpers ────────────────────────────────────────────────────────

// Convert Supabase snake_case row → camelCase app object
export const rowToUser = (r) => ({
  id:            r.id,
  name:          r.name,
  firstName:     r.first_name  || "",
  lastName:      r.last_name   || "",
  email:         r.email,
  phone:         r.phone       || "",
  role:          r.role,
  password:      r.password,
  allocatedTo:   r.allocated_to || [],
  trade:         r.trade        || "",
  licenceExpiry: r.licence_expiry || "",
  address:       r.address      || "",
  suburb:        r.suburb       || "",
  city:          r.city         || "",
  postcode:      r.postcode     || "",
  approverUserId: r.approver_user_id || null,
  viewerUserId:   r.viewer_user_id   || null,
  secondaryRole:  r.secondary_role   || null,
  adminLevel:     r.admin_level      || 1,
  xeroEmployeeId: r.xero_employee_id || null,
  overtimeType:      r.overtime_type      || null,
  overtimeThreshold: r.overtime_threshold || null,
  overtimeRateId:    r.overtime_rate_id   || null,
  mentorUserId:      r.mentor_user_id     || null,
  hostBusiness:      r.host_business      || "",
  dateOfBirth:       r.date_of_birth      || null,
  gender:            r.gender             || "",
  startDate:         r.start_date         || null,
  addressLine2:      r.address_line2      || "",
});

export const rowToEntry = (r) => ({
  id:        r.id,
  userId:    r.user_id,
  date:      r.date,
  type:      r.type,
  start:     r.start_time,
  end:       r.end_time,
  breakMins: r.break_mins,
  netHours:  parseFloat(r.net_hours),
  note:      r.note || "",
  approval:  r.approval,
  xeroStatus:      r.xero_status      || null,
  xeroTimesheetId: r.xero_timesheet_id || null,
  xeroError:       r.xero_error       || null,
});

export const userToRow = (u) => ({
  id:             u.id,
  name:           u.name,
  first_name:     u.firstName  || "",
  last_name:      u.lastName   || "",
  email:          u.email,
  phone:          u.phone      || "",
  role:           u.role,
  password:       u.password,
  allocated_to:   u.allocatedTo || [],
  trade:          u.trade        || null,
  licence_expiry: u.licenceExpiry || null,
  address:        u.address      || null,
  suburb:         u.suburb       || null,
  city:           u.city         || null,
  postcode:       u.postcode     || null,
  approver_user_id: u.approverUserId || null,
  viewer_user_id:   u.viewerUserId   || null,
  secondary_role:   u.secondaryRole  || null,
  admin_level:      u.adminLevel     || 1,
  xero_employee_id: u.xeroEmployeeId || null,
  overtime_type:      u.overtimeType      || null,
  overtime_threshold: u.overtimeThreshold || null,
  overtime_rate_id:   u.overtimeRateId    || null,
  mentor_user_id:     u.mentorUserId      || null,
  host_business:      u.hostBusiness      || null,
  date_of_birth:      u.dateOfBirth       || null,
  gender:             u.gender            || null,
  start_date:         u.startDate         || null,
  address_line2:      u.addressLine2      || null,
});

export const entryToRow = (e) => ({
  id:          e.id,
  user_id:     e.userId,
  date:        e.date,
  type:        e.type,
  start_time:  e.start,
  end_time:    e.end,
  break_mins:  e.breakMins,
  net_hours:   e.netHours,
  note:        e.note || "",
  approval:    e.approval,
  xero_status:       e.xeroStatus       || null,
  xero_timesheet_id: e.xeroTimesheetId  || null,
  xero_error:        e.xeroError        || null,
});

// ─── Data loaders ────────────────────────────────────────────────────────────

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

export const loadTable = async (table) => {
  const { data, error } = await sb.from(table).select('*');
  if (error) throw error;
  return data;
};

// ─── Upsert helpers (insert or update) ──────────────────────────────────────

export const upsertUser = async (user) => {
  const { error } = await sb.from('users').upsert(userToRow(user));
  if (error) throw error;
};

export const upsertEntry = async (entry) => {
  const { error } = await sb.from('entries').upsert(entryToRow(entry));
  if (error) throw error;
};

export const deleteEntry = async (id) => {
  const { error } = await sb.from('entries').delete().eq('id', id);
  if (error) throw error;
};

export const deleteUser = async (id) => {
  const { error } = await sb.from('users').delete().eq('id', id);
  if (error) throw error;
};

export const upsertRow = async (table, row) => {
  const { error } = await sb.from(table).upsert(row);
  if (error) throw error;
};

// Update specific columns only (never overwrites other columns unlike upsert)
export const updateRow = async (table, id, changes) => {
  const { error } = await sb.from(table).update(changes).eq('id', id);
  if (error) throw error;
};

export const deleteRow = async (table, id) => {
  const { error } = await sb.from(table).delete().eq('id', id);
  if (error) throw error;
};

// ─── Notifications ───────────────────────────────────────────────────────────

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

// ─── Messages (permanent conversation store) ────────────────────────────────

// A message row: { id, apprentice_id, sender_id, body, created_at }
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
export const licenceReminderExists = async (userId, apprenticeId, daysUntil) => {
  const twoDaysAgo = new Date(Date.now() - 2*24*60*60*1000).toISOString();
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
