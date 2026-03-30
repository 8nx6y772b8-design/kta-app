// ─── KTA App Constants ────────────────────────────────────────────────────────

export const T = {
  bg: "#f0f4f9", surface: "#ffffff", border: "#d0daea",
  ink: "#0d1b2e", sub: "#4a5a72", muted: "#8fa0b8",
  accent: "#1b4f8c", accentL: "#dce8f7", accentD: "#113570",
  warn: "#b86e1a", warnL: "#faebd7",
  red: "#bf2b2b", redL: "#fde8e8",
  hol: "#6b4fa0", holL: "#ece5f7",
  blue: "#1b6bbf", blueL: "#dceeff",
  teal: "#1a8a7a", tealL: "#d4f0ec",
  gold: "#a07820", goldL: "#fdf3d4",
  slate: "#4a5568", slateL: "#edf2f7",
  dark: "#2980B9", dark2: "#2472a4",
};

export const KTA_LOGO = "https://images.squarespace-cdn.com/content/v1/682fe0a84dcaf578b10d7882/cca16351-c2c6-4895-be1c-24f4a540ee3c/Copy+of+KTA+LOGO+BLUE+No+Background.png?format=300w";

// ─── Edge Function URLs ───────────────────────────────────────────────────────
export const EMAIL_PROXY        = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/email-proxy";
export const LEAVE_ACTION_URL   = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/leave-action";
export const CALENDAR_PROXY     = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/calendar-proxy";
export const TIMESHEET_ACTION_URL = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/timesheet-action";
export const HUBSPOT_PROXY_URL  = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/hubspot-proxy";

// ─── Roles ────────────────────────────────────────────────────────────────────
export const ROLES = ["Apprentice","Approver","Viewer","Mentor","Supervisor","Admin"];
export const ROLE_META = {
  Apprentice: { color: T.blue,   bg: T.blueL,  symbol: "◑", desc: "View & edit own timesheets (last 14 days)" },
  Approver:   { color: T.warn,   bg: T.warnL,  symbol: "▲", desc: "Approve or decline submitted timesheets for allocated apprentices" },
  Viewer:     { color: T.teal,   bg: T.tealL,  symbol: "◆", desc: "View all timesheet stages for allocated apprentices — read only" },
  Mentor:     { color: T.gold,   bg: T.goldL,  symbol: "✦", desc: "View allocated apprentice timesheets (read-only) and full CRM access" },
  Supervisor: { color: T.teal,   bg: T.tealL,  symbol: "⚙", desc: "View meeting reports, HSE check ins and leave requests. Timesheet access only if set as approver." },
  Admin:      { color: T.accent, bg: T.accentL,symbol: "★", desc: "Full access — manage all users, timesheets & CRM" },
  "Admin 1":  { color: T.accent, bg: T.accentL,symbol: "★", desc: "Full access including message history management" },
  "Admin 2":  { color: "#6d5fc7", bg: "#ede9ff",symbol: "☆", desc: "User management, timesheet view — cannot edit or delete messages" },
};

// ─── Entry types ──────────────────────────────────────────────────────────────
export const ENTRY_TYPES = ["Normal Hours","Annual Leave","Sick Leave","Bereavement Leave","Leave Without Pay","Public Holiday","Overtime","Block Course","Other"];
export const TYPE_META = {
  "Normal Hours":   { color: T.accent, bg: T.accentL, sym: "◈" },
  "Annual Leave":   { color: T.warn,   bg: T.warnL,   sym: "☀" },
  "Sick Leave":     { color: T.red,    bg: T.redL,    sym: "✚" },
  "Public Holiday": { color: T.hol,    bg: T.holL,    sym: "★" },
  "Overtime":       { color: T.gold,   bg: T.goldL,   sym: "⚡" },
  "Block Course":   { color: T.teal,   bg: T.tealL,   sym: "🎓" },
  "Other":          { color: T.slate,  bg: T.slateL,  sym: "◉" },
};
export const APPROVAL_META = {
  draft:     { color: T.muted,  bg: T.slateL, label: "Draft",      sym: "✎" },
  submitted: { color: T.warn,   bg: T.warnL,  label: "Submitted",  sym: "○" },
  approved:  { color: T.accent, bg: T.accentL,label: "Approved",   sym: "✓" },
  declined:  { color: T.red,    bg: T.redL,   label: "Declined",   sym: "✕" },
};

export const BREAK_OPTIONS = Array.from({length:9},(_,i)=>i*15);
export const TIME_OPTIONS = [];
for(let h=0;h<24;h++) for(let m=0;m<60;m+=15)
  TIME_OPTIONS.push(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`);

// ─── Trades ───────────────────────────────────────────────────────────────────
export const TRADES = ["Electrical","Plumbing","Construction","Carpentry","HVAC","Civil","Other"];

// ─── CRM stages ───────────────────────────────────────────────────────────────
export const STAGES = ["Lead","Qualified","Proposal","Negotiation","Won","Lost"];
export const STAGE_C = { Lead:T.muted, Qualified:T.blue, Proposal:T.warn, Negotiation:T.hol, Won:T.accent, Lost:T.red };

// ─── SharePoint folder URL builder ───────────────────────────────────────────
const SHAREPOINT_BASE = "https://kiwitradeapprenticesnz-my.sharepoint.com/shared";
const SHAREPOINT_LIST = "https://kiwitradeapprenticesnz.sharepoint.com/sites/CompanySharedDrive/Shared Documents";
const TRADE_FOLDER_MAP = {
  "Electrical":                  "Electrical Trainees",
  "Electrical Apprentice":       "Electrical Trainees",
  "Mechanical Engineering":      "Engineering Trainees",
  "Refrigeration & Air Conditioning": "Engineering Trainees",
  "Construction":                "Construction Trainees",
  "Carpentry":                   "Construction Trainees",
  "Joinery":                     "Construction Trainees",
  "Bricklaying":                 "Construction Trainees",
  "Plastering":                  "Construction Trainees",
  "Tiling":                      "Construction Trainees",
};
export const getSharePointUrl = (user) => {
  if (!user?.name || !user?.trade) return null;
  const folder = TRADE_FOLDER_MAP[user.trade];
  if (!folder) return null;
  const folderPath = `/sites/CompanySharedDrive/Shared Documents/Trainees Drives/${folder}/${user.name}`;
  const id   = encodeURIComponent(folderPath);
  const lurl = encodeURIComponent(SHAREPOINT_LIST);
  return `${SHAREPOINT_BASE}?id=${id}&listurl=${lurl}`;
};

// ─── Global CSS ───────────────────────────────────────────────────────────────
export const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  html,body{background:${T.bg};font-family:"DM Sans",sans-serif;color:${T.ink};font-size:15px;-webkit-tap-highlight-color:transparent;}
  ::-webkit-scrollbar{width:5px;height:5px;}
  ::-webkit-scrollbar-track{background:transparent;}
  ::-webkit-scrollbar-thumb{background:${T.border};border-radius:10px;}
`;
