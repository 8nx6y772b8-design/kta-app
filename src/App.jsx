// KTA Workforce Management — v1.6.6
// Changelog:
//   v1.4.6 — one-click approve/decline leave from email (HMAC tokens, edge fn)
//   v1.4.7 — leave status stepper all views, 4-tab panel, 30s polling,
//             inline decline reason, Admin 1 delete, KTA email → admin@kta.org.nz only
//   v1.4.8 — fix leave status reverting on refresh (updateRow vs partial upsert)
//   v1.4.9 — add fully-approved leave to M365 team calendar (calendar-proxy edge fn)
//   v1.5.0 — auto-fill timesheet entries for approved leave (Mon-Fri, 8hrs/day)
//             added Bereavement Leave + Leave Without Pay to entry types
//   v1.5.1 — leave overview card in admin dashboard timesheet section (colour-coded table)
//   v1.5.2 — timesheets moved to stat card; dashboard no longer shows full timesheet grid
//   v1.5.3 — leave requests stat card added; clicking scrolls to leave panel
//   v1.5.4 — leave card shows colour-coded breakdown by status
//   v1.5.5 — leave card opens full page; awaiting KTA listed first; consistent card height
//   v1.5.6 — conf notes PIN stored in Supabase (fixes mobile PIN reset issue)
//   v1.5.7 — fix admin delete leave (use deleteRow); remove large leave panel from dashboard
//   v1.5.8 — fix delete button not showing for Admin 1 on leave requests page
//   v1.5.9 — fix delete hidden on approved/declined leave (was inside canApprove guard)
//   v1.6.0 — Xero settings moved from localStorage to Supabase; edge fn uses refresh_token
//   v1.6.1 — persist xeroStatus to Supabase on submit (was in-memory only)
//   v1.6.2 — Xero OAuth connect button; refresh token stored in Supabase app_settings
//   v1.6.1 — Xero import checks for email match; merges into existing user instead of duplicating
import { useState, useEffect, useCallback, useRef } from "react";
import { loadUsers, loadEntries, loadTable, upsertUser, upsertEntry, deleteEntry, deleteUser as sbDeleteUser, upsertRow, updateRow, deleteRow, loadNotifications, insertNotification, markNotifRead, markAllNotifsRead, deleteNotif, licenceReminderExists, insertMessage, loadMessages, deleteMessage, sb } from "./supabaseClient";
// Email via Microsoft Graph (timesheet@kta.org.nz)

const EMAIL_PROXY       = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/email-proxy";
const LEAVE_ACTION_URL  = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/leave-action";
const CALENDAR_PROXY    = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/calendar-proxy";

// ── Auto-fill timesheet entries for approved leave ───────────────────────────
// Maps leave request types to timesheet entry types
const LEAVE_TO_ENTRY_TYPE = {
  "Annual Leave":      "Annual Leave",
  "Sick Leave":        "Sick Leave",
  "Bereavement Leave": "Bereavement Leave",
  "Leave Without Pay": "Leave Without Pay",
  "Other":             "Other",
};

// Generate one timesheet entry per working day (Mon–Fri) in the leave range
const autoFillLeaveEntries = async (apprenticeId, leaveType, dateFrom, dateTo, existingEntries, setEntries) => {
  const entryType = LEAVE_TO_ENTRY_TYPE[leaveType] || "Other";
  const start = "08:00", end = "16:30", breakMins = 30;
  const netHours = calcNet(start, end, breakMins); // 8.0

  const days = [];
  const cur = new Date(dateFrom + "T00:00:00");
  const last = new Date(dateTo   + "T00:00:00");

  while (cur <= last) {
    const dow = cur.getDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) {
      const dateStr = cur.toISOString().slice(0, 10);
      // Skip if entry already exists for this date
      const exists = existingEntries.some(e => e.userId === apprenticeId && e.date === dateStr);
      if (!exists) days.push(dateStr);
    }
    cur.setDate(cur.getDate() + 1);
  }

  if (days.length === 0) return 0;

  const newEntries = days.map(date => ({
    id:        uid(),
    userId:    apprenticeId,
    date,
    type:      entryType,
    start,
    end,
    breakMins,
    netHours,
    note:      `Auto-filled from approved ${leaveType}`,
    approval:  "draft",
  }));

  // Save all to Supabase
  await Promise.all(newEntries.map(e => upsertEntry(e).catch(console.error)));

  // Update local state
  if (setEntries) setEntries(prev => [...newEntries, ...prev]);

  return newEntries.length;
};

// Add approved leave as an all-day event on the KTA M365 team calendar
const addLeaveToCalendar = async (apprenticeName, leaveType, dateFrom, dateTo) => {
  try {
    const res = await fetch(CALENDAR_PROXY, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ apprenticeName, leaveType, dateFrom, dateTo }),
    });
    if (!res.ok) {
      const err = await res.json().catch(()=>({}));
      console.error("Calendar proxy error:", err.error || res.status);
    } else {
      console.log("Calendar event created for", apprenticeName);
    }
  } catch(e) {
    console.error("addLeaveToCalendar failed:", e);
  }
};
const LEAVE_TOKEN_SECRET = "kta-leave-action-secret-v1"; // must match LEAVE_TOKEN_SECRET in Supabase secrets

// HMAC-SHA256 token for one-click email approve/decline (browser SubtleCrypto)
const signLeaveToken = async (payload) => {
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey("raw", enc.encode(LEAVE_TOKEN_SECRET),
    { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const data = enc.encode(JSON.stringify(payload));
  const sig  = await crypto.subtle.sign("HMAC", key, data);
  const b64  = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  return btoa(JSON.stringify(payload)) + "." + b64;
};

const leaveActionUrl = async (leaveId, action, actorId, actorRole) => {
  const exp     = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const token   = await signLeaveToken({ id: leaveId, action, actorId, actorRole, exp });
  return `${LEAVE_ACTION_URL}?token=${token}`;
};
const sendKTAEmail = async ({ to, subject, html, attachments }) => {
  const res = await fetch(EMAIL_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sendEmail", to, subject, html, attachments }),
  });
  if (!res.ok) throw new Error("Email send failed: " + await res.text());
};

// Generate a meeting report PDF — pure JS, no library required
const generateReportPDF = (report, apprentice, mentor) => {
  const W = 595, H = 842, margin = 50, contentW = 495;
  const fD = (iso) => { if(!iso) return "TBC"; const [y,m,d]=(iso||"").split('-'); return `${d||"?"}/${m||"?"}/${y||"?"}`; };
  const esc = (s) => String(s||"N/a").replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)");
  const wrap = (text, maxChars) => {
    const words = (String(text||"N/a")).split(/\s+/).filter(Boolean);
    const out = []; let line = "";
    for(const w of words) {
      const candidate = line ? line + " " + w : w;
      if(candidate.length > maxChars) { if(line) out.push(line); line = w; }
      else line = candidate;
    }
    if(line) out.push(line);
    return out.length ? out : ["N/a"];
  };

  const objs = [];
  let id = 0;
  const add = (c) => { objs.push({ id:++id, c }); return id; };

  const S = [];
  let y = H - 60;

  // Navy header bar
  S.push("0.106 0.310 0.549 rg");
  S.push(`${margin - 10} ${H - 70} ${W - 80} 50 re f`);
  S.push("1 1 1 rg");
  S.push(`BT /F1 14 Tf ${margin} ${H - 45} Td (${esc("Apprentice Check In Report")}) Tj ET`);
  S.push(`BT /F2 8 Tf 1 1 1 rg ${margin} ${H - 58} Td (${esc("Kiwi Trade Apprentices  -  kta.org.nz  -  timesheet@kta.org.nz")}) Tj ET`);

  y = H - 90;

  // Meta rows
  const meta = [
    ["Trainee Name",       apprentice.name],
    ["Trade",              apprentice.trade || "Not specified"],
    ["Host Business",      apprentice.hostBusiness || "Not specified"],
    ["Location",           report.location || "Not specified"],
    ["Date of Visit",      fD(report.date)],
    ["KTA Representative", mentor.name],
    ["Licence Expiry",     apprentice.licenceExpiry ? fD(apprentice.licenceExpiry) : "Not set"],
    ["Next Visit",         fD(report.next_visit_date)],
  ];
  meta.forEach(([label, val], i) => {
    const bg = i % 2 === 0 ? "0.941 0.957 0.976" : "0.969 0.980 0.992";
    S.push(`${bg} rg ${margin} ${y - 2} ${contentW} 14 re f`);
    S.push(`0.290 0.353 0.443 rg BT /F1 8 Tf ${margin + 2} ${y + 4} Td (${esc(label)}) Tj ET`);
    S.push(`0.051 0.106 0.180 rg BT /F2 8 Tf ${margin + 105} ${y + 4} Td (${esc(String(val||""))}) Tj ET`);
    y -= 15;
  });
  y -= 8;

  const section = (title, body) => {
    if(y < 120) { S.push(""); y = H - 60; } // new page not needed for typical reports
    S.push(`0.102 0.541 0.478 rg ${margin} ${y - 2} ${contentW} 14 re f`);
    S.push(`1 1 1 rg BT /F1 9 Tf ${margin + 2} ${y + 4} Td (${esc(title)}) Tj ET`);
    y -= 18;
    const wrapped = wrap(body, 90);
    for(const line of wrapped) {
      S.push(`0.051 0.106 0.180 rg BT /F2 8 Tf ${margin + 2} ${y + 2} Td (${esc(line)}) Tj ET`);
      y -= 12;
    }
    y -= 6;
  };

  section("Off Job Progress Since Last Visit",  report.off_job_progress);
  section("On Job Progress Since Last Visit",   report.on_job_progress);
  section("Previous Goals",                     report.previous_goals);
  section("Goals Before Next Visit",            report.goals_this_meeting);
  section("Comments and Feedback",              report.comments_feedback);

  // Footer
  S.push(`0.106 0.310 0.549 rg 0 0 ${W} 24 re f`);
  S.push(`1 1 1 rg BT /F2 7 Tf ${margin} 9 Td (${esc("KTA Workforce Management  ·  timesheet@kta.org.nz")}) Tj ET`);
  const dateStr = new Date().toLocaleDateString("en-NZ");
  S.push(`1 1 1 rg BT /F2 7 Tf ${W - margin - 55} 9 Td (${esc("Generated " + dateStr)}) Tj ET`);

  const stream = S.join("\n");
  const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  const f1Id      = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`);
  const f2Id      = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  const pageId    = add(`<< /Type /Page /Parent 5 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${f1Id} 0 R /F2 ${f2Id} 0 R >> >> >>`);
  const pagesId   = add(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = "%PDF-1.4\n";
  const offsets = {};
  for(const o of objs) { offsets[o.id] = pdf.length; pdf += `${o.id} 0 obj\n${o.c}\nendobj\n`; }
  const xOff = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for(const o of objs) pdf += String(offsets[o.id]).padStart(10,"0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xOff}\n%%EOF\n`;

  // Encode to base64 — use Uint8Array to handle any characters safely
  const bytes = new Uint8Array(pdf.length);
  for(let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  let b64 = "";
  const CHUNK = 0x8000;
  for(let i = 0; i < bytes.length; i += CHUNK) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(b64);
};

// ─── Browser push notifications ─────────────────────────────────────────────
const requestPushPermission = async () => {
  if(!("Notification" in window)) return false;
  if(Notification.permission === "granted") return true;
  if(Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
};

const sendBrowserPush = (title, body, type="info") => {
  if(!("Notification" in window)||Notification.permission!=="granted") return;
  const icons = { approval:"✓", decline:"✕", licence:"⚠", info:"◈" };
  new Notification(`${icons[type]||"◈"} ${title}`, { body, icon:"/favicon.ico" });
};

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────
const T = {
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

// KTA logo (from kta.org.nz)
const KTA_LOGO = "https://images.squarespace-cdn.com/content/v1/682fe0a84dcaf578b10d7882/cca16351-c2c6-4895-be1c-24f4a540ee3c/Copy+of+KTA+LOGO+BLUE+No+Background.png?format=300w";

// Confidential notes — only this email can see the card (checked at render + inside component)
const CONF_OWNER_EMAIL = "kristeena@kta.org.nz";

// ─── HubSpot lookup ──────────────────────────────────────────────────────────
const lookupHubspot = async (value) => {
  const token = import.meta.env.VITE_HUBSPOT_TOKEN;
  if(!token) return null;
  const isPhone = /^[+\d\s\-()]{6,}$/.test(value) && !/[@.]/.test(value);
  const property = isPhone ? "phone" : "email";
  try {
    // HubSpot search — try exact match first
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value: value.trim() }] }],
        properties: ["firstname","lastname","email","phone","company","jobtitle"],
        limit: 1,
      }),
    });
    if(!res.ok) return null;
    const data = await res.json();
    // If phone search returned nothing, try searching all and matching
    if(!data.results?.length && isPhone) {
      const res2 = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "phone", operator: "CONTAINS_TOKEN", value: value.replace(/\D/g,"").slice(-8) }] }],
          properties: ["firstname","lastname","email","phone","company","jobtitle"],
          limit: 1,
        }),
      });
      if(res2.ok) {
        const data2 = await res2.json();
        if(data2.results?.length) {
          const p = data2.results[0].properties;
          return {
            name:    [p.firstname, p.lastname].filter(Boolean).join(" ") || "",
            email:   p.email || "",
            phone:   p.phone || value,
            company: p.company || "",
            notes:   p.jobtitle ? `Job title: ${p.jobtitle}` : "",
            status:  "Active",
          };
        }
      }
      return null;
    }
    if(!data.results?.length) return null;
    const p = data.results[0].properties;
    return {
      name:    [p.firstname, p.lastname].filter(Boolean).join(" ") || "",
      email:   p.email || (isPhone ? "" : value),
      phone:   p.phone || (isPhone ? value : ""),
      company: p.company || "",
      notes:   p.jobtitle ? `Job title: ${p.jobtitle}` : "",
      status:  "Active",
    };
  } catch(e) {
    console.warn("HubSpot lookup failed:", e);
    return null;
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const ROLES = ["Apprentice","Approver","Viewer","Mentor","Admin"];
const ROLE_META = {
  Apprentice: { color: T.blue,   bg: T.blueL,  symbol: "◑", desc: "View & edit own timesheets (last 14 days)" },
  Approver:   { color: T.warn,   bg: T.warnL,  symbol: "▲", desc: "Approve or decline submitted timesheets for allocated apprentices" },
  Viewer:     { color: T.teal,   bg: T.tealL,  symbol: "◆", desc: "View all timesheet stages for allocated apprentices — read only" },
  Mentor:     { color: T.gold,   bg: T.goldL,  symbol: "✦", desc: "View allocated apprentice timesheets (read-only) and full CRM access" },
  Admin:      { color: T.accent, bg: T.accentL,symbol: "★", desc: "Full access — manage all users, timesheets & CRM" },
  "Admin 1":  { color: T.accent, bg: T.accentL,symbol: "★", desc: "Full access including message history management" },
  "Admin 2":  { color: "#6d5fc7", bg: "#ede9ff",symbol: "☆", desc: "User management, timesheet view — cannot edit or delete messages" },
};

const ENTRY_TYPES = ["Normal Hours","Annual Leave","Sick Leave","Bereavement Leave","Leave Without Pay","Public Holiday","Overtime","Block Course","Other"];
const TYPE_META = {
  "Normal Hours":   { color: T.accent, bg: T.accentL, sym: "◈" },
  "Annual Leave":   { color: T.warn,   bg: T.warnL,   sym: "☀" },
  "Sick Leave":     { color: T.red,    bg: T.redL,    sym: "✚" },
  "Public Holiday": { color: T.hol,    bg: T.holL,    sym: "★" },
  "Overtime":       { color: T.gold,   bg: T.goldL,   sym: "⚡" },
  "Block Course":   { color: T.teal,   bg: T.tealL,   sym: "🎓" },
  "Other":          { color: T.slate,  bg: T.slateL,  sym: "◉" },
};
const APPROVAL_META = {
  draft:     { color: T.muted,  bg: T.slateL, label: "Draft",      sym: "✎" },
  submitted: { color: T.warn,   bg: T.warnL,  label: "Submitted",  sym: "○" },
  approved:  { color: T.accent, bg: T.accentL,label: "Approved",   sym: "✓" },
  declined:  { color: T.red,    bg: T.redL,   label: "Declined",   sym: "✕" },
};

const BREAK_OPTIONS = Array.from({length:9},(_,i)=>i*15);
const TIME_OPTIONS = [];
for(let h=0;h<24;h++) for(let m=0;m<60;m+=15)
  TIME_OPTIONS.push(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`);

const TRADES = ["Electrical","Plumbing","Construction","Carpentry","HVAC","Civil","Other"];
const STAGES = ["Lead","Qualified","Proposal","Negotiation","Won","Lost"];
const STAGE_C = { Lead:T.muted, Qualified:T.blue, Proposal:T.warn, Negotiation:T.hol, Won:T.accent, Lost:T.red };

// ─────────────────────────────────────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────────────────────────────────────
// Simple hash: XOR + encode so passwords aren't plaintext in storage
const hashPw = (pw) => btoa([...pw].map((c,i)=>String.fromCharCode(c.charCodeAt(0)^(42+i%7))).join(""));
const checkPw = (pw, hash) => hashPw(pw) === hash;

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
const uid      = () => Math.random().toString(36).slice(2,9);
const tod      = () => new Date().toISOString().slice(0,10);
const toMin    = t => { const[h,m]=t.split(":").map(Number); return h*60+m; };
const calcNet  = (s,e,b) => { const d=toMin(e)-toMin(s)-b; return d>0?+(d/60).toFixed(2):0; };
const fmtD     = d => new Date(d+"T00:00:00").toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short"});
const within14  = d => { const diff=(new Date(tod())-new Date(d+"T00:00:00"))/(86400000); return diff>=0&&diff<14; };
const weekStart = () => { const d=new Date(); d.setDate(d.getDate()-((d.getDay()+6)%7)); d.setHours(0,0,0,0); return d.toISOString().slice(0,10); };
const withinWeek = d => d >= weekStart();
const daysAgoStr = n => { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };

// Send email notification to approvers when apprentice submits timesheets
const notifyApprovers = async (apprentice, approvers, entries) => {
  if(!approvers.length) return;
  const entryList = entries.map(e=>
    `<li>${fmtD(e.date)} — ${e.type} — ${e.netHours}h${e.note?" ("+e.note+")":""}</li>`
  ).join("");
  for(const approver of approvers) {
    try {
      await sendKTAEmail({
        to: approver.email,
        subject: `Timesheet submitted — ${apprentice.name}`,
        html: `<p>Hi ${approver.name},</p>
<p><strong>${apprentice.name}</strong> has submitted ${entries.length} timesheet entr${entries.length===1?"y":"ies"} for approval:</p>
<ul>${entryList}</ul>
<p>Please log in to <a href="https://crmkta.com">crmkta.com</a> to review.</p>
<p style="color:#888;font-size:12px">KTA Workforce Management · timesheet@kta.org.nz</p>`,
      });
    } catch(err) {
      console.error("notifyApprovers error:", err);
    }
  }
};

// Notify apprentice of approval or decline
const notifyApprentice = async (apprentice, approver, entries, approved) => {
  if(!apprentice?.email) return;
  const entryList = entries.map(e=>
    `<li>${fmtD(e.date)} — ${e.type} — ${e.netHours}h${e.note?" ("+e.note+")":""}</li>`
  ).join("");
  const statusColor = approved ? "#1a8a7a" : "#bf2b2b";
  const statusText  = approved ? "APPROVED ✓" : "DECLINED ✕";
  const message     = approved
    ? `Your timesheet entr${entries.length===1?"y has":"ies have"} been approved.`
    : `Your timesheet entr${entries.length===1?"y has":"ies have"} been declined. Please check with your approver.`;
  try {
    await sendKTAEmail({
      to: apprentice.email,
      subject: `Timesheet ${approved?"approved":"declined"} — ${approver?.name||"KTA"}`,
      html: `<p>Hi ${apprentice.name},</p>
<p><strong style="color:${statusColor}">${statusText}</strong></p>
<p>${message}</p>
<ul>${entryList}</ul>
<p style="color:#888;font-size:12px">KTA Workforce Management · timesheet@kta.org.nz</p>`,
    });
  } catch(err) {
    console.error("notifyApprentice error:", err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STYLES
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  html,body{background:${T.bg};font-family:"DM Sans",sans-serif;color:${T.ink};font-size:14px;-webkit-tap-highlight-color:transparent;}
  ::-webkit-scrollbar{width:5px;height:5px;}
  ::-webkit-scrollbar-track{background:${T.border};}
  ::-webkit-scrollbar-thumb{background:${T.muted};border-radius:3px;}
  select,input,textarea{
    font-family:"DM Sans",sans-serif;background:${T.surface};
    border:1.5px solid ${T.border};color:${T.ink};border-radius:9px;
    padding:9px 12px;font-size:16px;outline:none;width:100%;
    transition:border-color .15s,box-shadow .15s;
    appearance:none;-webkit-appearance:none;
  }
  select{
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='6'%3E%3Cpath d='M1 1l4.5 4 4.5-4' stroke='%23b0a898' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat:no-repeat;background-position:right 11px center;padding-right:30px;
  }
  select option{background:white;}
  input:focus,select:focus,textarea:focus{border-color:${T.accent};box-shadow:0 0 0 3px ${T.accentL};}
  input[type=date]::-webkit-calendar-picker-indicator{opacity:.4;cursor:pointer;}
  button{cursor:pointer;font-family:"DM Sans",sans-serif;border:none;transition:all .14s;}
  textarea{resize:vertical;min-height:64px;line-height:1.55;font-size:16px;}

  @keyframes fadeUp  {from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
  @keyframes fadeIn  {from{opacity:0;}to{opacity:1;}}
  @keyframes rowIn   {from{opacity:0;transform:translateX(-5px);}to{opacity:1;transform:translateX(0);}}
  @keyframes shake   {0%,100%{transform:translateX(0);}20%,60%{transform:translateX(-6px);}40%,80%{transform:translateX(6px);}}
  @keyframes spin    {to{transform:rotate(360deg);}}
  .fu{animation:fadeUp .3s ease both;}
  .fi{animation:fadeIn .25s ease both;}
  .ri{animation:rowIn .22s ease both;}
  .shake{animation:shake .35s ease;}

  /* Login page */
  .login-wrap{min-height:100vh;display:flex;background:linear-gradient(135deg,${T.dark} 0%,${T.dark2} 50%,#2060a0 100%);}
  .login-left{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:60px;position:relative;overflow:hidden;}
  .login-left::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 30% 50%,${T.accent}22 0%,transparent 60%),radial-gradient(ellipse at 80% 20%,${T.blue}14 0%,transparent 50%);}
  .login-right{width:440px;flex-shrink:0;background:${T.surface};display:flex;flex-direction:column;justify-content:center;padding:56px 48px;box-shadow:-20px 0 60px #00000033;overflow-y:auto;}
  .login-input-wrap{position:relative;margin-bottom:14px;}
  .login-input-wrap input{padding:13px 16px 13px 44px;background:#f9f8f5;border:1.5px solid ${T.border};font-size:16px;border-radius:10px;}
  .login-input-wrap input:focus{background:white;}
  .login-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:16px;color:${T.muted};pointer-events:none;}
  .pw-toggle{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:${T.muted};cursor:pointer;font-size:13px;padding:2px 6px;border-radius:4px;font-family:"DM Sans",sans-serif;}
  .pw-toggle:hover{color:${T.sub};}

  /* App shell */
  .desktop-nav{display:flex;}
  .desktop-user-name{display:block;}
  .desktop-signout{display:flex;}
  .bottom-nav{display:none;}
  .main-content{max-width:1300px;margin:0 auto;padding:28px 24px;}
  .stat-grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px;}
  .stat-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:22px;}
  .table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}

  /* Form grid defaults (desktop) */
  .fg3{grid-template-columns:1fr 1fr 1fr;}
  .fg2{grid-template-columns:1fr 1fr;}
  .fg-entry{grid-template-columns:1fr 1fr;}
  .fg-addr{grid-template-columns:2fr 1fr 1fr 1fr;}

  /* ── MOBILE ──────────────────────────────────────────── */
  @media(max-width:768px){
    /* Login — stack vertically */
    .login-wrap{flex-direction:column;}
    .login-left{flex:none;padding:32px 24px 24px;align-items:flex-start;}
    .login-left h1{font-size:26px !important;margin-bottom:12px !important;}
    .login-left p,.login-left .role-badges{display:none;}
    .login-right{width:100%;flex:1;padding:28px 20px max(32px,env(safe-area-inset-bottom));box-shadow:none;border-radius:22px 22px 0 0;margin-top:-16px;z-index:2;position:relative;}

    /* Header — compact */
    .desktop-nav{display:none !important;}
    .desktop-user-name{display:none !important;}
    .desktop-signout{display:none !important;}

    /* Bottom tab bar */
    .bottom-nav{
      display:flex;position:fixed;bottom:0;left:0;right:0;z-index:200;
      background:${T.dark};border-top:1px solid #ffffff15;
      padding:6px 0 max(6px,env(safe-area-inset-bottom));
      box-shadow:0 -4px 24px #00000044;
    }
    .bottom-nav-btn{
      flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:2px;background:none;border:none;padding:4px 2px;cursor:pointer;
      font-family:"DM Sans",sans-serif;transition:all .14s;min-height:52px;
    }
    .bottom-nav-icon{font-size:22px;line-height:1;display:block;}
    .bottom-nav-label{font-size:10px;font-weight:600;letter-spacing:.2px;display:block;}
    .bottom-nav-btn.active .bottom-nav-icon,
    .bottom-nav-btn.active .bottom-nav-label{color:${T.accentL};}
    .bottom-nav-btn:not(.active) .bottom-nav-icon,
    .bottom-nav-btn:not(.active) .bottom-nav-label{color:#ffffff40;}
    .bottom-nav-btn.active{position:relative;}
    .bottom-nav-btn.active::before{content:"";position:absolute;top:0;left:20%;right:20%;height:2px;background:${T.accentL};border-radius:0 0 3px 3px;}

    /* Main */
    .main-content{padding:14px 12px 86px;}

    /* Stat grids */
    .stat-grid-4{grid-template-columns:repeat(2,1fr);gap:10px;}
    .stat-grid-3{grid-template-columns:repeat(2,1fr);gap:10px;}

    /* Page heading */
    .page-heading{font-size:20px !important;}

    /* Form grids collapse to 1 or 2 col */
    .fg3{grid-template-columns:1fr !important;}
    .fg2{grid-template-columns:1fr !important;}
    .fg-addr{grid-template-columns:1fr 1fr !important;}
    .fg-entry{grid-template-columns:1fr 1fr !important;}

    /* Table horizontal scroll */
    .table-scroll{margin:0 -12px;border-radius:0 !important;}

    /* Hide less-important table columns on mobile via utility class */
    .hide-mobile{display:none !important;}

    /* Notification bell dropdown — full width on mobile */
    .notif-dropdown{
      position:fixed !important;
      top:58px !important;
      left:8px !important;
      right:8px !important;
      width:auto !important;
      max-width:100vw !important;
    }
    .notif-dropdown .notif-title{white-space:normal !important;word-break:break-word;}
    .notif-dropdown .notif-msg{white-space:pre-wrap !important;word-break:break-word;}
  }

  @media(max-width:400px){
    .login-right{padding:22px 16px max(28px,env(safe-area-inset-bottom));}
    .main-content{padding:12px 10px 84px;}
    .stat-grid-4,.stat-grid-3{grid-template-columns:repeat(2,1fr);gap:8px;}
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// MICRO COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
const Pill = ({label,color,bg,sym,size="md"}) => (
  <span style={{display:"inline-flex",alignItems:"center",gap:4,background:bg,color,
    padding:size==="sm"?"2px 8px":"4px 10px",borderRadius:99,
    fontSize:size==="sm"?11:12,fontWeight:600,whiteSpace:"nowrap"}}>
    {sym&&<span style={{fontSize:size==="sm"?9:10}}>{sym}</span>}{label}
  </span>
);
const RolePill = ({role, size="md", adminLevel=null}) => {
  const displayRole = role==="Admin" && adminLevel ? `Admin ${adminLevel}` : role;
  const m = ROLE_META[displayRole] || ROLE_META[role] || ROLE_META.Apprentice;
  return <Pill label={displayRole} color={m.color} bg={m.bg} sym={m.symbol} size={size}/>;
};
const TypePill = ({type,size="md"}) => { const m=TYPE_META[type]||TYPE_META["Other"]; return <Pill label={type} color={m.color} bg={m.bg} sym={m.sym} size={size}/> };
const AppvPill = ({status}) => { const m=APPROVAL_META[status]||APPROVAL_META.draft; return <Pill label={m.label} color={m.color} bg={m.bg} sym={m.sym} size="sm"/> };

const FL = ({children,req}) => (
  <div style={{fontSize:11,fontWeight:600,color:T.sub,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>
    {children}{req&&<span style={{color:T.red}}> *</span>}
  </div>
);

const Btn = ({children,onClick,v="primary",sm=false,disabled=false,full=false,style:sx={}}) => {
  const vs = {
    primary: {background:T.accent,color:"#fff",border:`1.5px solid ${T.accentD}`},
    ghost:   {background:T.surface,color:T.sub,border:`1.5px solid ${T.border}`},
    danger:  {background:T.redL,color:T.red,border:`1.5px solid ${T.red}44`},
    approve: {background:T.accentL,color:T.accent,border:`1.5px solid ${T.accent}55`},
    decline: {background:T.redL,color:T.red,border:`1.5px solid ${T.red}55`},
    blue:    {background:T.blueL,color:T.blue,border:`1.5px solid ${T.blue}55`},
    loginbtn:{background:T.accent,color:"#fff",border:`1.5px solid ${T.accentD}`,fontSize:15,padding:"13px 20px",borderRadius:10,fontWeight:700},
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...vs[v]||vs.primary,borderRadius:8,
      padding:sm?"5px 12px":"9px 16px",fontSize:sm?12:13,fontWeight:600,
      display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,
      opacity:disabled?.45:1,width:full?"100%":undefined,...sx
    }}
      onMouseEnter={e=>{if(!disabled)e.currentTarget.style.filter="brightness(.93)";}}
      onMouseLeave={e=>{e.currentTarget.style.filter="none";}}>
      {children}
    </button>
  );
};

const Card = ({children,style:sx={},onClick}) => (
  <div onClick={onClick} style={{background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:14,padding:20,...sx}}>
    {children}
  </div>
);
const StatCard = ({label,value,sub,color=T.accent}) => (
  <Card style={{paddingBlock:18}}>
    <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>{label}</div>
    <div style={{fontSize:24,fontWeight:700,color,fontFamily:"'Libre Baskerville'"}}>{value}</div>
    {sub&&<div style={{fontSize:11,color:T.sub,marginTop:2}}>{sub}</div>}
  </Card>
);
const Avatar = ({name,role,size=36}) => {
  const m=ROLE_META[role]||ROLE_META.Apprentice;
  return (
    <div style={{width:size,height:size,borderRadius:"50%",flexShrink:0,
      background:m.bg,border:`2px solid ${m.color}44`,
      display:"flex",alignItems:"center",justifyContent:"center",
      fontWeight:700,fontSize:size*.38,color:m.color}}>
      {name?.[0]?.toUpperCase()||"?"}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────
function LoginScreen({users, onLogin}) {
  const [email, setEmail]   = useState("");
  const [pw, setPw]         = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr]       = useState("");
  const [loading, setLoading] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [forgotMode, setForgotMode]   = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg]     = useState(null); // {ok, text}
  const [forgotSending, setForgotSending] = useState(false);

  const sendReset = async () => {
    if(!forgotEmail.trim()) { setForgotMsg({ok:false,text:"Please enter your email address."}); return; }
    const user = users.find(u=>u.email.toLowerCase()===forgotEmail.trim().toLowerCase());
    setForgotSending(true);
    // Small delay so it feels like something is happening regardless
    await new Promise(r=>setTimeout(r,800));
    setForgotSending(false);
    if(!user) {
      // Don't reveal whether email exists — always show success for security
      setForgotMsg({ok:true,text:"If that email is registered, a reset link has been sent."});
      return;
    }
    // Send reset email via Graph API
    try {
      await sendKTAEmail({
        to: user.email,
        subject: "KTA Password Reset Request",
        html: `<p>Hi ${user.name},</p>
<p>A password reset was requested for your KTA account.</p>
<p>Please contact your administrator to have your password reset.</p>
<p>If you did not request this, please ignore this email.</p>
<p style="color:#888;font-size:12px">KTA Workforce Management · timesheet@kta.org.nz</p>`,
      });
      setForgotMsg({ok:true,text:"Reset instructions have been sent to your email."});
    } catch(e) {
      setForgotMsg({ok:true,text:"If that email is registered, a reset link has been sent."});
    }
  };

  const attempt = () => {
    setErr("");
    if(!email.trim()||!pw) { setErr("Please enter your email and password."); return; }
    setLoading(true);
    setTimeout(() => {
      const user = users.find(u=>u.email.toLowerCase()===email.trim().toLowerCase());
      if(!user) { setErr("No account found with that email address."); setLoading(false); trigShake(); return; }
      if(!checkPw(pw, user.password)) { setErr("Incorrect password. Please try again."); setLoading(false); trigShake(); return; }
      onLogin(user.id);
    }, 600);
  };

  const trigShake = () => { setShaking(true); setTimeout(()=>setShaking(false),400); };

  return (
    <div className="login-wrap">
      {/* LEFT — branding */}
      <div className="login-left fi">
        <div style={{position:"relative",zIndex:1,maxWidth:420}}>
          {/* KTA Logo */}
          <div style={{marginBottom:52}}>
            <img src={KTA_LOGO} alt="Kiwi Trade Apprentices"
              style={{height:60,objectFit:"contain",filter:"brightness(0) invert(1)"}}
              onError={e=>{e.target.style.display="none";}}
            />
          </div>

          {/* Tagline */}
          <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:36,fontWeight:700,color:"#fff",lineHeight:1.25,marginBottom:20,letterSpacing:"-.5px"}}>
            Timesheet management, approvals, and CRM
          </h1>
          <p style={{fontSize:16,color:"#ffffffaa",lineHeight:1.7}}>
            Built around your team and their training needs.
          </p>
        </div>
      </div>

      {/* RIGHT — login form */}
      <div className="login-right">
        <div style={{marginBottom:36}}>
          <h2 style={{fontFamily:"'Libre Baskerville'",fontSize:26,fontWeight:700,color:T.ink,marginBottom:8}}>
            Welcome back
          </h2>
          <p style={{fontSize:13,color:T.sub}}>Sign in to your account to continue.</p>
        </div>

        <div className={shaking?"shake":""}>
          {/* Email */}
          <div style={{marginBottom:4}}>
            <FL>Email Address</FL>
          </div>
          <div className="login-input-wrap">
            <span className="login-icon">✉</span>
            <input
              type="email" placeholder="you@work.com"
              value={email} onChange={e=>{setEmail(e.target.value);setErr("");}}
              onKeyDown={e=>e.key==="Enter"&&attempt()}
              style={{borderColor:err?T.red:undefined}}
            />
          </div>

          {/* Password */}
          <div style={{marginBottom:4}}>
            <FL>Password</FL>
          </div>
          <div className="login-input-wrap">
            <span className="login-icon">🔒</span>
            <input
              type={showPw?"text":"password"} placeholder="Enter your password"
              value={pw} onChange={e=>{setPw(e.target.value);setErr("");}}
              onKeyDown={e=>e.key==="Enter"&&attempt()}
              style={{borderColor:err?T.red:undefined}}
            />
            <button className="pw-toggle" onClick={()=>setShowPw(s=>!s)} type="button">
              {showPw?"Hide":"Show"}
            </button>
          </div>

          {/* Error */}
          {err&&(
            <div style={{background:T.redL,border:`1px solid ${T.red}44`,borderRadius:8,
              padding:"9px 13px",marginBottom:14,fontSize:13,color:T.red,display:"flex",gap:8,alignItems:"center"}}>
              <span>⚠</span>{err}
            </div>
          )}

          {/* Submit */}
          <button onClick={attempt} disabled={loading} style={{
            width:"100%",padding:"13px",marginTop:err?0:6,marginBottom:20,
            background:loading?T.accentL:T.accent,
            color:loading?T.accent:"#fff",
            border:`1.5px solid ${T.accentD}`,
            borderRadius:10,fontSize:15,fontWeight:700,
            display:"flex",alignItems:"center",justifyContent:"center",gap:10,
            cursor:loading?"default":"pointer",fontFamily:"DM Sans,sans-serif",transition:"all .15s"
          }}>
            {loading
              ? <><span style={{width:16,height:16,border:`2px solid ${T.accent}`,borderTopColor:"transparent",borderRadius:"50%",display:"inline-block",animation:"spin .7s linear infinite"}}/>Signing in…</>
              : "Sign In →"
            }
          </button>
        </div>

        {/* Forgot Password */}
        <div style={{borderTop:`1px solid ${T.border}`,paddingTop:20}}>
          {!forgotMode ? (
            <button onClick={()=>{setForgotMode(true);setErr("");setForgotMsg("");}} style={{
              background:"none",border:"none",color:T.accent,fontSize:13,
              fontWeight:600,cursor:"pointer",fontFamily:"DM Sans,sans-serif",
              padding:0,display:"block",margin:"0 auto"
            }}>Forgot your password?</button>
          ) : (
            <div className="fi">
              <div style={{fontSize:13,fontWeight:600,color:T.ink,marginBottom:8}}>Reset Password</div>
              <div style={{fontSize:12,color:T.sub,marginBottom:12,lineHeight:1.5}}>
                Enter your email and we'll send a reset link to your inbox.
              </div>
              <div className="login-input-wrap" style={{marginBottom:10}}>
                <span className="login-icon">✉</span>
                <input type="email" placeholder="your@email.com"
                  value={forgotEmail} onChange={e=>{setForgotEmail(e.target.value);setForgotMsg("");}}
                  onKeyDown={e=>e.key==="Enter"&&sendReset()}
                />
              </div>
              {forgotMsg&&(
                <div style={{background:forgotMsg.ok?T.accentL:T.redL,border:`1px solid ${forgotMsg.ok?T.accent:T.red}44`,
                  borderRadius:8,padding:"9px 13px",marginBottom:10,fontSize:12,
                  color:forgotMsg.ok?T.accent:T.red}}>
                  {forgotMsg.text}
                </div>
              )}
              <div style={{display:"flex",gap:8}}>
                <button onClick={sendReset} disabled={forgotSending} style={{
                  flex:1,padding:"10px",background:T.accent,color:"#fff",
                  border:`1.5px solid ${T.accentD}`,borderRadius:9,fontSize:13,fontWeight:700,
                  cursor:forgotSending?"default":"pointer",fontFamily:"DM Sans,sans-serif",
                  opacity:forgotSending?0.6:1,transition:"all .15s"
                }}>{forgotSending?"Sending…":"Send Reset Link"}</button>
                <button onClick={()=>{setForgotMode(false);setForgotEmail("");setForgotMsg("");}} style={{
                  padding:"10px 16px",background:"none",color:T.sub,
                  border:`1.5px solid ${T.border}`,borderRadius:9,fontSize:13,fontWeight:600,
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif"
                }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        {/* Version */}
        <div style={{marginTop:24,textAlign:"center",fontSize:11,color:T.muted,fontFamily:"DM Sans,sans-serif"}}>
          v1.6.6
        </div>
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────
function EntryForm({onSave,onCancel,initial=null,minDate=null,maxDate=null,usedDates=[]}) {
  const blank = {date:tod(),type:"Normal Hours",start:"09:00",end:"17:00",breakMins:30,note:""};
  const [f,setF] = useState(initial||blank);
  const [err,setErr] = useState({});
  const sf=(k,v)=>setF(p=>({...p,[k]:v}));
  const dateConflict = !initial && usedDates.includes(f.date);
  const netH = calcNet(f.start,f.end,Number(f.breakMins));
  const gross = toMin(f.end)-toMin(f.start);

  const submit = () => {
    const e={};
    if(gross<=0) e.time="End must be after start";
    else if(netH<=0) e.time="Net hours must be > 0 after break";
    if(Object.keys(e).length){setErr(e);return;}
    if(dateConflict) return;
    onSave({...f,breakMins:Number(f.breakMins),netHours:netH,approval:initial?f.approval:"draft"});
  };

  return (
    <Card style={{border:`1.5px solid ${T.accent}44`}} className="fu">
      <div className="fg-entry" style={{display:"grid",gap:12,marginBottom:12}}>
        <div><FL>Date</FL><input type="date" value={f.date} onChange={e=>sf("date",e.target.value)} min={minDate||undefined} max={maxDate||undefined}
                style={{borderColor:dateConflict?T.red:undefined}}/>
              {dateConflict&&<div style={{fontSize:11,color:T.red,marginTop:3}}>You already have an entry for this date</div>}</div>
        <div>
          <FL>Entry Type</FL>
          <select value={f.type} onChange={e=>sf("type",e.target.value)}>
            {ENTRY_TYPES.map(t=><option key={t}>{t}</option>)}
          </select>
          <div style={{marginTop:6}}><TypePill type={f.type}/></div>
        </div>
        <div><FL>Start Time</FL>
          <select value={f.start} onChange={e=>sf("start",e.target.value)}>
            {TIME_OPTIONS.map(t=><option key={t}>{t}</option>)}
          </select>
        </div>
        <div><FL>End Time</FL>
          <select value={f.end} onChange={e=>sf("end",e.target.value)}>
            {TIME_OPTIONS.map(t=><option key={t}>{t}</option>)}
          </select>
        </div>
      </div>
      {err.time&&<div style={{color:T.red,fontSize:11,marginBottom:10}}>{err.time}</div>}
      <div style={{marginBottom:12}}>
        <FL>Break Duration</FL>
        <select value={f.breakMins} onChange={e=>sf("breakMins",e.target.value)}>
          {BREAK_OPTIONS.map(m=><option key={m} value={m}>{m===0?"No break":`${m} minutes`}</option>)}
        </select>
      </div>
      <div style={{background:netH>0?T.accentL:T.redL,border:`1.5px solid ${netH>0?T.accent+"44":T.red+"44"}`,
        borderRadius:9,padding:"10px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:11,color:T.sub,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px"}}>Net Hours</div>
          <div style={{fontSize:11,color:T.muted,marginTop:1}}>{gross>0?`${f.start}–${f.end} minus ${f.breakMins}m`:"—"}</div>
        </div>
        <div style={{fontFamily:"'Libre Baskerville'",fontSize:26,fontWeight:700,color:netH>0?T.accent:T.red}}>
          {netH>0?`${netH}h`:"—"}
        </div>
      </div>
      <div style={{marginBottom:16}}>
        <FL>Note</FL>
        <textarea placeholder="Optional note…" value={f.note} onChange={e=>sf("note",e.target.value)}/>
      </div>
      <div style={{display:"flex",gap:8}}>
        <Btn onClick={submit}>{initial?"Update Entry":"Save Entry"}</Btn>
        {onCancel&&<Btn v="ghost" onClick={onCancel}>Cancel</Btn>}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY ROW
// ─────────────────────────────────────────────────────────────────────────────
function EntryRow({entry,canEdit,canDelete,canApprove,canSubmitXero,onDelete,onApprove,onDecline,onEdit,onSubmit,onSubmitXero,idx,showUser,users}) {
  const user=users?.find(u=>u.id===entry.userId);
  const tcols=showUser
    ?"130px 130px 1fr 130px 64px 60px 70px 100px 68px"
    :"130px 1fr 130px 64px 60px 70px 100px 68px";
  const isLocked = !canEdit && (entry.approval==="submitted"||entry.approval==="approved");
  return (
    <div className="ri" style={{display:"grid",gridTemplateColumns:tcols,
      padding:"12px 16px",borderBottom:`1px solid ${T.border}44`,
      background:idx%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${idx*.03}s`}}>
      <div>
        <div style={{fontSize:13,fontWeight:600}}>{fmtD(entry.date)}</div>
      </div>
      {showUser&&(
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          <Avatar name={user?.name} role={user?.role} size={26}/>
          <span style={{fontSize:12,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user?.name||"—"}</span>
        </div>
      )}
      <div style={{fontSize:12,color:entry.note?T.ink:T.muted,fontStyle:entry.note?"normal":"italic",
        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.note||"No note"}</div>
      <TypePill type={entry.type} size="sm"/>
      <div style={{textAlign:"center",fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:15,
        color:TYPE_META[entry.type]?.color||T.accent}}>{entry.netHours}h</div>
      <div style={{textAlign:"center",fontSize:11,color:T.sub}}>{entry.breakMins>0?`${entry.breakMins}m`:"—"}</div>
      <div style={{textAlign:"center",fontSize:11,color:T.muted,fontFamily:"monospace"}}>{entry.start}–{entry.end}</div>
      <AppvPill status={entry.approval}/>
      <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
        {canApprove&&entry.approval==="submitted"&&(<>
          <button onClick={()=>onApprove(entry.id)} title="Approve" style={{
            width:26,height:26,borderRadius:6,fontSize:12,background:T.accentL,color:T.accent,
            border:`1px solid ${T.accent}44`,display:"flex",alignItems:"center",justifyContent:"center"}}>✓</button>
          <button onClick={()=>onDecline(entry.id)} title="Decline" style={{
            width:26,height:26,borderRadius:6,fontSize:12,background:T.redL,color:T.red,
            border:`1px solid ${T.red}44`,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </>)}
        {canSubmitXero && entry.approval==="approved" && !entry.xeroStatus && (
          <button onClick={()=>onSubmitXero&&onSubmitXero(entry.id)}
            title="Submit to Xero Payroll"
            style={{height:26,borderRadius:6,fontSize:11,fontWeight:700,
              background:"#e6f7fd",color:"#0d7bb5",padding:"0 7px",
              border:"1px solid #13b5ea55",display:"flex",alignItems:"center",gap:3,
              cursor:"pointer",whiteSpace:"nowrap"}}
            onMouseEnter={e=>{e.currentTarget.style.background="#13b5ea";e.currentTarget.style.color="#fff";}}
            onMouseLeave={e=>{e.currentTarget.style.background="#e6f7fd";e.currentTarget.style.color="#0d7bb5";}}>
            𝕏 Xero
          </button>
        )}
        {entry.xeroStatus==="submitted" && (
          <div title="Submitted to Xero"
            style={{height:26,borderRadius:6,fontSize:11,fontWeight:700,
              background:"#e6f7fd",color:"#0d7bb5",padding:"0 7px",
              border:"1px solid #13b5ea55",display:"flex",alignItems:"center",gap:3}}>
            𝕏 ✓
          </div>
        )}
        {entry.xeroStatus==="error" && (
          <div title={entry.xeroError||"Xero error"}
            style={{height:26,borderRadius:6,fontSize:11,fontWeight:700,
              background:T.redL,color:T.red,padding:"0 7px",
              border:`1px solid ${T.red}44`,display:"flex",alignItems:"center",gap:3}}>
            𝕏 ✕
          </div>
        )}
        {isLocked&&(
          <div title={entry.approval==="approved"?"Approved — contact admin to edit":"Submitted — wait for approval or decline"}
            style={{width:26,height:26,borderRadius:6,fontSize:13,background:T.bg,color:T.muted,
              border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}>🔒</div>
        )}
        {canEdit&&(<>
          <button onClick={()=>onEdit(entry)} style={{width:26,height:26,borderRadius:6,fontSize:12,
            background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
            display:"flex",alignItems:"center",justifyContent:"center"}}
            onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
          {(canDelete===undefined?canEdit:canDelete)&&(
            <button onClick={()=>onDelete(entry.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,
              background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
              display:"flex",alignItems:"center",justifyContent:"center"}}
              onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
          )}
        </>)}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMESHEET MODULE
// ─────────────────────────────────────────────────────────────────────────────
function TimesheetModule({currentUser,allUsers,entries,setEntries,forcedApprenticeId=null}) {
  const [showForm,setShowForm] = useState(false);
  const [editEntry,setEditEntry] = useState(null);
  const [filterUid,setFilterUid] = useState(forcedApprenticeId||"all");
  const [toast,setToast] = useState(null); // {msg, ok}
  const [weekPickerDrafts, setWeekPickerDrafts] = useState(null); // null | {weeks:[...], draftsPerWeek:{}}
  const [weekPickerSelected, setWeekPickerSelected] = useState(null);
  const role=currentUser.role;

  const showToast = (msg, ok=true) => {
    setToast({msg,ok});
    setTimeout(()=>setToast(null), 4000);
  };

  const visibleIds = useCallback(()=>{
    if(forcedApprenticeId) return [forcedApprenticeId];
    if(role==="Admin") return allUsers.map(u=>u.id);
    if(["Viewer","Approver"].includes(role)) {
      // Legacy: allocatedTo on the viewer/approver record
      const fromAlloc = currentUser.allocatedTo||[];
      // New: apprentices who have this user set as their approver/viewer
      const fromApprentice = allUsers
        .filter(u=>u.role==="Apprentice"&&(u.approverUserId===currentUser.id||u.viewerUserId===currentUser.id))
        .map(u=>u.id);
      return [...new Set([currentUser.id,...fromAlloc,...fromApprentice])];
    }
    if(role==="Mentor") {
      // Legacy: allocatedTo on the mentor record
      const fromAlloc = currentUser.allocatedTo||[];
      // New: apprentices who have this user set as their mentor
      const fromApprentice = allUsers
        .filter(u=>u.role==="Apprentice"&&u.mentorUserId===currentUser.id)
        .map(u=>u.id);
      return [...new Set([...fromAlloc,...fromApprentice])];
    }
    return [currentUser.id];
  },[role,currentUser,allUsers,forcedApprenticeId]);

  // Helper: effective roles this user has (Admin may also have a secondaryRole)
  const hasRole = (r) => role===r || (role==="Admin" && currentUser.secondaryRole===r);

  const canEdit=(entry)=>{
    if(role==="Admin") return true;
    // Apprentice: only draft entries within 21 days are editable
    // Submitted entries are locked until declined, approved entries are permanently locked
    if(role==="Apprentice"&&entry.userId===currentUser.id&&entry.approval==="draft"&&entry.date>=daysAgoStr(21)) return true;
    return false;
  };
  const canDelete=(entry)=>{
    if(role==="Admin") return true;
    // Apprentice can delete own draft entries only
    if(role==="Apprentice"&&entry.userId===currentUser.id&&entry.approval==="draft") return true;
    return false;
  };
  const canApprove=(entry)=>{
    if(entry.approval!=="submitted") return false;
    if(role==="Admin") return true;
    if(role==="Approver") {
      const apprentice = allUsers.find(u=>u.id===entry.userId);
      if((currentUser.allocatedTo||[]).includes(entry.userId)) return true;
      if(apprentice?.approverUserId===currentUser.id) return true;
    }
    return false;
  };
  const canAdd=forcedApprenticeId ? false : (role==="Admin"||role==="Apprentice");

  const vids=visibleIds();
  let shown=entries.filter(e=>vids.includes(e.userId));
  if(!forcedApprenticeId && filterUid!=="all") shown=shown.filter(e=>e.userId===filterUid);
  if(role==="Apprentice") shown=shown.filter(e=>e.date>=daysAgoStr(21)||e.approval!=="draft");
  shown=[...shown].sort((a,b)=>b.date.localeCompare(a.date));

  const myE=entries.filter(e=>e.userId===currentUser.id);
  const todayEntries=myE.filter(e=>e.date===tod());
  const todayH=todayEntries.length>0?todayEntries.reduce((a,e)=>a+e.netHours,0).toFixed(2):null;
  const ws=()=>{const d=new Date();d.setDate(d.getDate()-d.getDay());return d.toISOString().slice(0,10);};
  const weekH=myE.filter(e=>e.date>=ws()).reduce((a,e)=>a+e.netHours,0).toFixed(2);
  const pending=entries.filter(e=>vids.includes(e.userId)&&e.approval==="submitted").length;

  const handleSave=(data)=>{
    if(editEntry){
      setEntries(prev=>prev.map(e=>e.id===editEntry.id?{...e,...data}:e));
    } else {
      // Block duplicate date for apprentices
      if(role==="Apprentice"){
        const already=entries.some(e=>e.userId===currentUser.id&&e.date===data.date);
        if(already){ showToast("You already have an entry for this date. Edit the existing one instead.",false); return; }
      }
      setEntries(prev=>[{id:uid(),userId:currentUser.id,...data},...prev]);
    }
    setShowForm(false); setEditEntry(null);
  };
  const handleApprove=async(id)=>{
    const entry=entries.find(e=>e.id===id);
    setEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"approved"}:e));
    if(entry){
      const apprentice=allUsers.find(u=>u.id===entry.userId);
      // Check if all submitted entries for that week are now approved (including this one)
      const getWk=d=>{const dt=new Date(d+"T00:00:00");dt.setDate(dt.getDate()-((dt.getDay()+6)%7));return dt.toISOString().slice(0,10);};
      const weekKey=getWk(entry.date);
      const weekEntries=entries.filter(e=>e.userId===entry.userId&&getWk(e.date)===weekKey);
      const nowAllApproved=weekEntries.every(e=>e.id===id?true:e.approval==="approved");
      if(nowAllApproved && weekEntries.length>1){
        // Full week approved — send week summary
        await notifyApprentice(apprentice, currentUser, weekEntries.map(e=>e.id===id?{...e,approval:"approved"}:e), true);
        showToast(`✓ Week approved — emailed ${apprentice?.name}`);
      } else {
        // Single day approved
        await notifyApprentice(apprentice, currentUser, [entry], true);
        showToast(`✓ Entry approved — emailed ${apprentice?.name}`);
      }
    }
  };
  const handleDecline=async(id)=>{
    const entry=entries.find(e=>e.id===id);
    setEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"declined"}:e));
    if(entry){
      const apprentice=allUsers.find(u=>u.id===entry.userId);
      await notifyApprentice(apprentice, currentUser, [entry], false);
      showToast(`Entry declined — emailed ${apprentice?.name}`, false);
    }
  };
  const handleDelete=(id)=>{
    const e=entries.find(x=>x.id===id);
    if(e && !canDelete(e)) return; // safety guard
    setEntries(prev=>prev.filter(e=>e.id!==id));
  };
  const handleEdit=(entry)=>{setEditEntry(entry);setShowForm(true);};

  const filterableUsers=allUsers.filter(u=>vids.includes(u.id));
  const showUserCol=role!=="Apprentice";
  const tcols=showUserCol
    ?"130px 130px 1fr 130px 64px 60px 70px 100px 68px"
    :"130px 1fr 130px 64px 60px 70px 100px 68px";

  return (
    <div className="fu">
      {toast&&(
        <div style={{position:"fixed",bottom:24,right:24,zIndex:999,
          background:toast.ok?T.accentL:T.warnL,
          border:`1.5px solid ${toast.ok?T.accent:T.warn}`,
          borderRadius:10,padding:"12px 20px",fontSize:13,fontWeight:600,
          color:toast.ok?T.accent:T.warn,boxShadow:"0 4px 20px #00000022",
          maxWidth:360,lineHeight:1.4}}>
          {toast.msg}
        </div>
      )}
      <div style={{background:ROLE_META[role].bg,border:`1.5px solid ${ROLE_META[role].color}44`,
        borderRadius:10,padding:"10px 16px",marginBottom:20,display:"flex",gap:10,alignItems:"center"}}>
        <span style={{fontSize:16}}>{ROLE_META[role].symbol}</span>
        <span style={{fontWeight:700,color:ROLE_META[role].color,fontSize:13}}>{role} View — </span>
        <span style={{fontSize:13,color:T.sub}}>{ROLE_META[role]?.desc||""}</span>
      </div>
      <div className="stat-grid-4">
        <StatCard label="Today (mine)" value={todayH?`${todayH}h`:"—"} color={todayH?T.accent:T.muted}/>
        <StatCard label="This Week (mine)" value={`${weekH}h`} color={T.warn}/>
        <StatCard label="Visible Entries" value={shown.length} color={T.blue}/>
        <StatCard label="Pending Approval" value={pending} sub="in your scope" color={pending>0?T.warn:T.muted}/>
      </div>
      {canAdd&&(
        <div style={{marginBottom:16,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <Btn onClick={()=>{setShowForm(s=>!s);setEditEntry(null);}} v={showForm?"ghost":"primary"}>
            {showForm?"✕ Cancel":"+ Log Entry"}
          </Btn>
          {role==="Apprentice"&&(()=>{
            const myDrafts=shown.filter(e=>e.approval==="draft"&&e.userId===currentUser.id);
            if(!myDrafts.length) return null;

            // Group drafts by week-ending Sunday
            const getWeekEnding = (dateStr) => {
              const [y,m,d] = dateStr.split('-').map(Number);
              // Use UTC to avoid timezone shifts
              const date = new Date(Date.UTC(y,m-1,d));
              const day = date.getUTCDay(); // 0=Sun
              const diff = day===0 ? 0 : 7-day;
              date.setUTCDate(date.getUTCDate()+diff);
              return date.toISOString().slice(0,10);
            };
            const draftsPerWeek = {};
            myDrafts.forEach(e=>{
              const we = getWeekEnding(e.date);
              if(!draftsPerWeek[we]) draftsPerWeek[we]=[];
              draftsPerWeek[we].push(e);
            });
            const weeks = Object.keys(draftsPerWeek).sort();

            const doSubmit = async (weekEnding) => {
              const toSubmit = weekEnding ? draftsPerWeek[weekEnding] : myDrafts;
              const ids = toSubmit.map(e=>e.id);
              setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"submitted"}:e));
              setWeekPickerDrafts(null);
              setWeekPickerSelected(null);
              const approvers = allUsers.filter(u=>
                (u.allocatedTo||[]).includes(currentUser.id) || currentUser.approverUserId===u.id
              );
              if(!approvers.length){
                showToast("Submitted — no approver assigned yet, no email sent",false);
              } else {
                try {
                  await notifyApprovers(currentUser, approvers, toSubmit);
                  showToast(`✓ Submitted & emailed ${approvers.map(a=>a.name).join(", ")}`);
                } catch(err) {
                  showToast(`Submitted but email failed: ${err.message}`,false);
                }
              }
            };

            return (
              <>
                <Btn v="blue" onClick={()=>{
                  if(weeks.length>1) {
                    setWeekPickerDrafts({weeks, draftsPerWeek});
                    setWeekPickerSelected(null);
                  } else {
                    doSubmit(weeks[0]);
                  }
                }}>
                  ↑ Submit {myDrafts.length} Draft{myDrafts.length!==1?"s":""}
                </Btn>

                {/* Week picker modal */}
                {weekPickerDrafts&&(
                  <div style={{position:"fixed",inset:0,background:"#00000066",zIndex:300,
                    display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
                    <Card style={{width:"100%",maxWidth:420,padding:24}}>
                      <div style={{fontWeight:700,fontSize:16,marginBottom:6}}>Which week to submit?</div>
                      <div style={{fontSize:13,color:T.sub,marginBottom:18}}>
                        Your drafts span multiple weeks. Choose which week to submit for approval.
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
                        {weekPickerDrafts.weeks.map(we=>{
                          const cnt = weekPickerDrafts.draftsPerWeek[we].length;
                          const hrs = weekPickerDrafts.draftsPerWeek[we].reduce((a,e)=>a+e.netHours,0).toFixed(2);
                          const [wy,wm,wd] = we.split('-');
                          const label = `${wd}/${wm}/${wy}`;
                          const selected = weekPickerSelected===we;
                          return (
                            <button key={we} onClick={()=>setWeekPickerSelected(we)} style={{
                              padding:"12px 14px",borderRadius:10,textAlign:"left",cursor:"pointer",
                              border:`2px solid ${selected?T.accent:T.border}`,
                              background:selected?T.accentL:T.surface,
                              fontFamily:"DM Sans,sans-serif",transition:"all .14s"}}>
                              <div style={{fontWeight:700,fontSize:14,color:selected?T.accent:T.ink}}>
                                Week ending {label}
                              </div>
                              <div style={{fontSize:12,color:T.sub,marginTop:3}}>
                                {cnt} entr{cnt===1?"y":"ies"} · {hrs}h total
                              </div>
                            </button>
                          );
                        })}
                        <button onClick={()=>setWeekPickerSelected("all")} style={{
                          padding:"12px 14px",borderRadius:10,textAlign:"left",cursor:"pointer",
                          border:`2px solid ${weekPickerSelected==="all"?T.blue:T.border}`,
                          background:weekPickerSelected==="all"?T.blueL:T.surface,
                          fontFamily:"DM Sans,sans-serif",transition:"all .14s"}}>
                          <div style={{fontWeight:700,fontSize:14,color:weekPickerSelected==="all"?T.blue:T.ink}}>
                            Submit all weeks at once
                          </div>
                          <div style={{fontSize:12,color:T.sub,marginTop:3}}>
                            {myDrafts.length} entries · {myDrafts.reduce((a,e)=>a+e.netHours,0).toFixed(2)}h total
                          </div>
                        </button>
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <Btn onClick={()=>{ if(weekPickerSelected) doSubmit(weekPickerSelected==="all"?null:weekPickerSelected); }}
                          disabled={!weekPickerSelected}>
                          Submit
                        </Btn>
                        <Btn v="ghost" onClick={()=>{setWeekPickerDrafts(null);setWeekPickerSelected(null);}}>Cancel</Btn>
                      </div>
                    </Card>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
      {showForm&&<div style={{marginBottom:20}}>
        <EntryForm onSave={handleSave} onCancel={()=>{setShowForm(false);setEditEntry(null);}} initial={editEntry}
          minDate={role==="Apprentice"?daysAgoStr(21):null}
          maxDate={role==="Apprentice"?tod():null}
          usedDates={role==="Apprentice"?entries.filter(e=>e.userId===currentUser.id).map(e=>e.date):[]}/>
      </div>}
      {filterableUsers.length>1&&(
        <div style={{display:"flex",gap:10,marginBottom:14}}>
          <select value={filterUid} onChange={e=>setFilterUid(e.target.value)}
            style={{width:220,fontSize:12,padding:"7px 28px 7px 11px"}}>
            <option value="all">All Visible Users</option>
            {filterableUsers.map(u=><option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
          </select>
        </div>
      )}
      {/* ── Approver view: grouped by apprentice with per-day + approve-week actions ── */}
      {(role==="Approver"||(role==="Admin"&&currentUser.secondaryRole==="Approver")) ? (()=>{
        const myApprentices = allUsers.filter(u=>
          u.role==="Apprentice" && (
            (currentUser.allocatedTo||[]).includes(u.id) ||
            u.approverUserId===currentUser.id
          )
        );
        if(myApprentices.length===0) return (
          <Card><div style={{padding:32,textAlign:"center",color:T.muted}}>No apprentices allocated to you yet.</div></Card>
        );

        // Week-ending Sunday, UTC-safe
        const getWeekEnding = (dateStr) => {
          const [y,m,d] = dateStr.split('-').map(Number);
          const date = new Date(Date.UTC(y,m-1,d));
          const day = date.getUTCDay();
          date.setUTCDate(date.getUTCDate() + (day===0 ? 0 : 7-day));
          return date.toISOString().slice(0,10);
        };
        const fmtWeekEnd = (we) => { const [y,m,d]=we.split('-'); return `${d}/${m}/${y}`; };

        return myApprentices.map(app=>{
          const appEntries = shown.filter(e=>e.userId===app.id).sort((a,b)=>b.date.localeCompare(a.date));
          const submitted  = appEntries.filter(e=>e.approval==="submitted");
          const weeks      = [...new Set(appEntries.map(e=>getWeekEnding(e.date)))].sort((a,b)=>b.localeCompare(a));

          const approveWeek = async (weekEnding)=>{
            const toApprove = submitted.filter(e=>getWeekEnding(e.date)===weekEnding);
            const ids = toApprove.map(e=>e.id);
            if(!ids.length) return;
            setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"approved"}:e));
            await notifyApprentice(app, currentUser, toApprove, true);
            showToast(`✓ Week approved — emailed ${app.name}`);
          };

          const approveAllWeeks = async ()=>{
            if(!submitted.length) return;
            const ids = submitted.map(e=>e.id);
            setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"approved"}:e));
            await notifyApprentice(app, currentUser, submitted, true);
            showToast(`✓ All pending entries approved — emailed ${app.name}`);
          };

          return (
            <Card key={app.id} style={{marginBottom:16,padding:0,overflow:"hidden"}}>
              {/* Apprentice header */}
              <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
                background:T.bg,borderBottom:`1.5px solid ${T.border}`,flexWrap:"wrap"}}>
                <Avatar name={app.name} role="Apprentice" size={34}/>
                <div style={{flex:1,minWidth:120}}>
                  <div style={{fontWeight:700,fontSize:14}}>{app.name}</div>
                  <div style={{fontSize:12,color:T.sub}}>{appEntries.length} entries · {submitted.length} awaiting approval</div>
                </div>
              </div>

              {/* Week approve buttons — one per week with pending entries */}
              {submitted.length>0&&(
                <div style={{padding:"10px 16px",background:T.warnL+"44",borderBottom:`1px solid ${T.border}`,
                  display:"flex",flexDirection:"column",gap:8}}>
                  <div style={{fontSize:11,fontWeight:600,color:T.warn,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>
                    Pending approval
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                    {weeks.filter(we=>submitted.some(e=>getWeekEnding(e.date)===we)).map(we=>{
                      const cnt = submitted.filter(e=>getWeekEnding(e.date)===we).length;
                      const hrs = submitted.filter(e=>getWeekEnding(e.date)===we).reduce((a,e)=>a+e.netHours,0).toFixed(2);
                      return (
                        <button key={we} onClick={()=>{
                          if(window.confirm(`Approve week ending ${fmtWeekEnd(we)} for ${app.name}?\n${cnt} ${cnt===1?"entry":"entries"} · ${hrs}h total`))
                            approveWeek(we);
                        }} style={{
                          padding:"9px 16px",borderRadius:8,fontSize:13,fontWeight:700,
                          background:T.accent,color:"#fff",border:"none",
                          cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                          display:"flex",alignItems:"center",gap:7,transition:"opacity .14s"}}
                          onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
                          onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                          ✓ Approve week ending {fmtWeekEnd(we)}
                          <span style={{fontWeight:400,opacity:.8,fontSize:12}}>({cnt} {cnt===1?"entry":"entries"} · {hrs}h)</span>
                        </button>
                      );
                    })}
                    {weeks.filter(we=>submitted.some(e=>getWeekEnding(e.date)===we)).length > 1 && (
                      <button onClick={()=>{
                        if(window.confirm(`Approve ALL ${submitted.length} pending entries for ${app.name}?`))
                          approveAllWeeks();
                      }} style={{
                        padding:"9px 16px",borderRadius:8,fontSize:13,fontWeight:700,
                        background:T.accentD,color:"#fff",border:"none",
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif",transition:"opacity .14s"}}
                        onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
                        onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                        ✓✓ Approve all pending
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Column headers */}
              <div style={{display:"grid",
                gridTemplateColumns:"100px 1fr 110px 56px 80px 70px 80px",
                padding:"8px 16px",background:T.bg,
                fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
                <span>Date</span><span>Note</span><span>Type</span>
                <span style={{textAlign:"center"}}>Hours</span>
                <span style={{textAlign:"center"}}>Start–End</span>
                <span style={{textAlign:"center"}}>Break</span>
                <span>Status / Action</span>
              </div>

              {appEntries.length===0&&(
                <div style={{padding:"24px",textAlign:"center",color:T.muted,fontSize:12,fontStyle:"italic"}}>No entries yet.</div>
              )}
              {appEntries.map((e,i)=>(
                <div key={e.id} style={{display:"grid",
                  gridTemplateColumns:"100px 1fr 110px 56px 80px 70px 80px",
                  padding:"9px 16px",gap:8,alignItems:"center",fontSize:12,
                  borderBottom:i<appEntries.length-1?`1px solid ${T.border}44`:"none",
                  background:e.approval==="submitted"?T.warnL+"55":i%2===0?T.surface:T.bg}}>
                  <div style={{fontWeight:600,fontSize:12}}>{fmtD(e.date)}</div>
                  <div style={{color:e.note?T.ink:T.muted,fontStyle:e.note?"normal":"italic",
                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12}}>{e.note||"No note"}</div>
                  <TypePill type={e.type} size="sm"/>
                  <div style={{textAlign:"center",fontWeight:700,color:TYPE_META[e.type]?.color||T.accent,
                    fontFamily:"'Libre Baskerville'",fontSize:14}}>{e.netHours}h</div>
                  <div style={{textAlign:"center",fontSize:11,color:T.muted,fontFamily:"monospace"}}>{e.start}–{e.end}</div>
                  <div style={{textAlign:"center",fontSize:11,color:T.sub}}>{e.breakMins>0?`${e.breakMins}m`:"—"}</div>
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>
                    {e.approval==="submitted"&&(<>
                      <button onClick={()=>handleApprove(e.id)} title="Approve" style={{
                        width:26,height:26,borderRadius:6,fontSize:12,background:T.accentL,color:T.accent,
                        border:`1px solid ${T.accent}44`,cursor:"pointer",flexShrink:0,
                        display:"flex",alignItems:"center",justifyContent:"center"}}>✓</button>
                      <button onClick={()=>handleDecline(e.id)} title="Decline" style={{
                        width:26,height:26,borderRadius:6,fontSize:12,background:T.redL,color:T.red,
                        border:`1px solid ${T.red}44`,cursor:"pointer",flexShrink:0,
                        display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                    </>)}
                    {e.approval==="approved"&&<AppvPill status="approved"/>}
                    {e.approval==="declined"&&(<>
                      <AppvPill status="declined"/>
                      <button onClick={()=>handleApprove(e.id)} title="Re-approve" style={{
                        width:26,height:26,borderRadius:6,fontSize:11,background:T.accentL,color:T.accent,
                        border:`1px solid ${T.accent}44`,cursor:"pointer",flexShrink:0,
                        display:"flex",alignItems:"center",justifyContent:"center"}}>↺</button>
                    </>)}
                    {e.approval==="draft"&&<AppvPill status="draft"/>}
                  </div>
                </div>
              ))}
            </Card>
          );
        });
      })() : (<>
        <Card style={{padding:0,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:tcols,padding:"10px 16px",
            background:T.bg,borderBottom:`1.5px solid ${T.border}`,
            fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
            <span>Date</span>{showUserCol&&<span>Person</span>}<span>Note</span><span>Type</span>
            <span style={{textAlign:"center"}}>Hours</span><span style={{textAlign:"center"}}>Break</span>
            <span style={{textAlign:"center"}}>Time</span><span>Status</span>
            <span style={{textAlign:"right"}}>Actions</span>
          </div>
          {shown.length===0&&(
            <div style={{padding:"48px 24px",textAlign:"center",color:T.muted}}>
              <div style={{fontSize:32,marginBottom:8}}>◈</div>
              <div style={{fontWeight:600}}>No entries to display</div>
              <div style={{fontSize:12,marginTop:4}}>{canAdd?"Use the button above to log your first entry.":"No entries in your scope yet."}</div>
            </div>
          )}
          {shown.map((e,i)=>(
            <EntryRow key={e.id} entry={e} idx={i}
              canEdit={canEdit(e)} canApprove={canApprove(e)}
              onDelete={handleDelete} onApprove={handleApprove}
              onDecline={handleDecline} onEdit={handleEdit}
              canDelete={canDelete(e)}
              canSubmitXero={role==="Admin" && (currentUser?.adminLevel||1)===1}
              onSubmitXero={async(id)=>{
                const en = entries.find(x=>x.id===id);
                if(!en) return;
                const app = allUsers.find(u=>u.id===en.userId);
                if(!app?.xeroEmployeeId) {
                  showToast(`No Xero Employee ID set for ${app?.name||"this apprentice"} — map them in the Xero module first.`, false);
                  return;
                }
                setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"submitting"}:x));
                try {
                  const res = await submitEntryToXero(en, app, entries);
                  if(res.ok) {
                    await updateRow("entries", id, { xero_status: "submitted", xero_timesheet_id: res.timesheetId||null }).catch(console.error);
                    setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"submitted",xeroTimesheetId:res.timesheetId}:x));
                    showToast(`✓ Submitted to Xero for ${app.name}`);
                  } else {
                    await updateRow("entries", id, { xero_status: "error" }).catch(console.error);
                    setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"error",xeroError:res.error}:x));
                    showToast(`Xero error: ${res.error}`, false);
                  }
                } catch(e) {
                  await updateRow("entries", id, { xero_status: "error" }).catch(console.error);
                  setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"error",xeroError:e.message}:x));
                  showToast(`Xero error: ${e.message}`, false);
                }
              }}
              onSubmit={role==="Apprentice"?async(id)=>{
                setEntries(prev=>prev.map(x=>x.id===id?{...x,approval:"submitted"}:x));
                const entry=shown.find(e=>e.id===id);
                if(entry){
                  const approvers=allUsers.filter(u=>
                    (u.allocatedTo||[]).includes(currentUser.id) ||
                    currentUser.approverUserId===u.id
                  );
                  if(!approvers.length){
                    showToast("Submitted — no approver assigned yet, no email sent",false);
                  } else {
                    try {
                      await notifyApprovers(currentUser, approvers, [entry]);
                      showToast(`✓ Submitted & emailed ${approvers.map(a=>a.name).join(", ")}`);
                    } catch(e) {
                      showToast(`Submitted but email failed: ${e.message}`,false);
                    }
                  }
                }
              }:null}
              showUser={showUserCol} users={allUsers}/>
          ))}
        </Card>
        {shown.length>0&&(
          <div style={{textAlign:"right",fontSize:12,color:T.sub,marginTop:10}}>
            {shown.length} entr{shown.length===1?"y":"ies"} · <strong style={{color:T.accent}}>{shown.reduce((a,e)=>a+e.netHours,0).toFixed(2)}h</strong> net
          </div>
        )}
      </>)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
function UserManagement({users, setUsers, currentUser}) {
  const myLevel = currentUser?.adminLevel || 1; // 1 = superadmin, 2 = limited admin

  // Roles this admin level is allowed to create/edit
  // Admin 1: all roles. Admin 2: all except Admin 1.
  const creatableRoles = myLevel===1
    ? ["Apprentice","Approver","Viewer","Mentor","Admin"]
    : ["Apprentice","Approver","Viewer","Mentor","Admin"]; // same list — Admin 2 can create Admin 2 but not Admin 1 (enforced below)

  // Can this admin edit a given user?
  const canEditUser = (u) => {
    if(myLevel===1) return true;
    // Admin 2 cannot edit Admin 1 users
    if(u.role==="Admin" && (u.adminLevel||1)===1) return false;
    return true;
  };
  const canDeleteUser = (u) => canEditUser(u);
  const canCreateUsers = true; // both admin levels can create users

  const blank={name:"",role:"Apprentice",email:"",phone:"",password:"",allocatedTo:[],
    address:"",suburb:"",city:"",postcode:"",approverUserId:null,viewerUserId:null,secondaryRole:null,adminLevel:1};
  const [form,setForm]=useState(blank);
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [pwField,setPwField]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [appApprover, setAppApprover] = useState("");
  const [appViewer,   setAppViewer]   = useState("");
  const [appMentor,   setAppMentor]   = useState("");
  const sf=(k,v)=>setForm(f=>({...f,[k]:v}));

  const toggleAlloc=(uid)=>setForm(f=>({...f,allocatedTo:f.allocatedTo.includes(uid)?f.allocatedTo.filter(x=>x!==uid):[...f.allocatedTo,uid]}));

  const submit=()=>{
    if(!form.name.trim()||!form.email.trim()) return;
    const finalForm={...form};
    if(pwField.trim()) finalForm.password=hashPw(pwField.trim());
    const targetId = editId || uid();

    // Always bake approver/viewer into finalForm for apprentices
    if(finalForm.role==="Apprentice") {
      finalForm.approverUserId = appApprover||null;
      finalForm.viewerUserId   = appViewer||null;
      finalForm.mentorUserId   = appMentor||null;
    }
    // Clear secondaryRole if not Admin; default adminLevel to 1 for non-admins
    if(finalForm.role!=="Admin") { finalForm.secondaryRole = null; finalForm.adminLevel = null; }
    // Admin 2 cannot create/promote to Admin 1
    if(finalForm.role==="Admin" && myLevel===2) finalForm.adminLevel = 2;

    setUsers(prev=>{
      let next = editId
        ? prev.map(u=>u.id===editId?{...u,...finalForm}:u)
        : [...prev,{id:targetId,...finalForm}];

      if(finalForm.role==="Apprentice") {
        // Sync allocatedTo on approver/viewer users (legacy support)
        next = next.map(u => {
          if(u.id === targetId) return u;
          if(!["Approver","Viewer","Admin"].includes(u.role)) return u;
          const isApprover = appApprover === u.id;
          const isViewer   = appViewer   === u.id;
          const shouldHave = isApprover || isViewer;
          const has        = (u.allocatedTo||[]).includes(targetId);
          if(shouldHave && !has) return {...u, allocatedTo:[...(u.allocatedTo||[]), targetId]};
          if(!shouldHave && has) return {...u, allocatedTo:(u.allocatedTo||[]).filter(x=>x!==targetId)};
          return u;
        });
      }
      return next;
    });
    setEditId(null);
    setForm(blank);setPwField("");setShowForm(false);
    setAppApprover("");setAppViewer("");setAppMentor("");
  };

  const startEdit=(u)=>{
    setForm({name:u.name,role:u.role,email:u.email||"",phone:u.phone||"",password:u.password,
      allocatedTo:u.allocatedTo||[],address:u.address||"",suburb:u.suburb||"",
      city:u.city||"",postcode:u.postcode||"",
      approverUserId:u.approverUserId||null,viewerUserId:u.viewerUserId||null,
      secondaryRole:u.secondaryRole||null,adminLevel:u.adminLevel||1});
    setPwField(""); setEditId(u.id); setShowForm(true);
    if(u.role==="Apprentice") {
      // Prefer the value stored directly on the apprentice record (new approach)
      // Fall back to searching allocatedTo on approver/viewer users (legacy + always works without DB migration)
      const approverFromRecord = u.approverUserId||"";
      const viewerFromRecord   = u.viewerUserId||"";
      const approverFromAlloc  = users.find(x=>["Approver","Admin"].includes(x.role)&&(x.allocatedTo||[]).includes(u.id))?.id||"";
      const viewerFromAlloc    = users.find(x=>["Viewer","Admin"].includes(x.role)&&(x.allocatedTo||[]).includes(u.id))?.id||"";
      setAppApprover(approverFromRecord||approverFromAlloc);
      setAppViewer(viewerFromRecord||viewerFromAlloc);
      setAppMentor(u.mentorUserId||"");
    }
    setTimeout(()=>document.getElementById("um-form")?.scrollIntoView({behavior:"smooth",block:"start"}),50);
  };
  const deleteUser=(id)=>{if(window.confirm("Remove this user?"))setUsers(prev=>prev.filter(u=>u.id!==id));};

  // For Approver/Viewer/Mentor: allocatable = apprentices (or apprentices+viewers for mentor)
  const allocatable=users.filter(u=>u.id!==(editId||"__")&&
    (["Approver","Viewer"].includes(form.role)?u.role==="Apprentice":
     form.role==="Mentor"?["Apprentice","Viewer"].includes(u.role):false));

  // For Apprentice approver/viewer dropdowns: include Admins with matching secondary role too
  const approverOptions = users.filter(u=>u.role==="Approver"||u.role==="Admin");
  const viewerOptions   = users.filter(u=>u.role==="Viewer"  ||u.role==="Admin");

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:18}}>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setPwField("");setShowForm(s=>!s);setAppApprover("");setAppViewer("");}}>
          {showForm?"✕ Cancel":"+ Add User"}
        </Btn>
      </div>

      {showForm&&(
        <Card id="um-form" style={{marginBottom:20,border:`1.5px solid ${T.blue}44`}}>
          <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:T.blue}}>
            {editId?"✎ Edit User":"+ New User"}
          </div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Full Name</FL><input placeholder="Jane Smith" value={form.name} onChange={e=>sf("name",e.target.value)}/></div>
            <div>
              <FL req>Role</FL>
              <select value={form.role} onChange={e=>sf("role",e.target.value)}>
                {ROLES.map(r=><option key={r}>{r}</option>)}
              </select>
              <div style={{marginTop:6}}><RolePill role={form.role}/></div>
            </div>
            {form.role==="Admin"&&(
              <div>
                <FL>Secondary Role <span style={{fontWeight:400,color:T.muted}}>(optional — grants additional access)</span></FL>
                <select value={form.secondaryRole||""} onChange={e=>sf("secondaryRole",e.target.value||null)}>
                  <option value="">— None —</option>
                  <option value="Approver">Approver — can approve timesheets for allocated apprentices</option>
                  <option value="Viewer">Viewer — read-only access to allocated apprentices' timesheets</option>
                </select>
                {form.secondaryRole&&(
                  <div style={{marginTop:6,display:"flex",alignItems:"center",gap:8}}>
                    <RolePill role="Admin"/>
                    <span style={{fontSize:12,color:T.muted}}>+</span>
                    <RolePill role={form.secondaryRole}/>
                  </div>
                )}
              </div>
            )}
            {form.role==="Admin"&&(
              <div>
                <FL>Admin Level</FL>
                <div style={{display:"flex",gap:10,marginTop:4}}>
                  {[1,2].map(lvl=>{
                    const locked = myLevel===2 && lvl===1; // Admin 2 cannot create Admin 1
                    return (
                      <button key={lvl} type="button"
                        onClick={()=>!locked&&sf("adminLevel",lvl)}
                        style={{
                          flex:1,padding:"10px 12px",borderRadius:9,fontSize:13,fontWeight:600,
                          border:`2px solid ${locked?T.border:(form.adminLevel||1)===lvl?T.accent:T.border}`,
                          background:locked?T.bg:(form.adminLevel||1)===lvl?T.accentL:T.surface,
                          color:locked?T.muted:(form.adminLevel||1)===lvl?T.accent:T.sub,
                          cursor:locked?"not-allowed":"pointer",textAlign:"left",
                          fontFamily:"DM Sans,sans-serif",transition:"all .15s",opacity:locked?.5:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                          <span style={{fontSize:16}}>{lvl===1?"★":"☆"}</span>
                          <span>Admin Level {lvl}{locked?" (requires Admin 1)":""}</span>
                        </div>
                        <div style={{fontSize:11,fontWeight:400,lineHeight:1.4,
                          color:locked?T.muted:(form.adminLevel||1)===lvl?T.accent:T.muted}}>
                          {lvl===1
                            ? "Full access — edit, delete & manage all data including message history"
                            : "User management & timesheet viewing — cannot edit or delete messages"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div><FL req>Email</FL><input type="email" placeholder="jane@work.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+64 4xx xxx xxx" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
            <div>
              <FL>{editId?"New Password (leave blank to keep)":"Password"}</FL>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} placeholder={editId?"Leave blank to keep current":"Set password"}
                  value={pwField} onChange={e=>setPwField(e.target.value)}
                  style={{paddingRight:60}}/>
                <button onClick={()=>setShowPw(s=>!s)} type="button" style={{
                  position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
                  background:"none",border:"none",color:T.muted,cursor:"pointer",
                  fontSize:12,fontFamily:"DM Sans,sans-serif"}}>
                  {showPw?"Hide":"Show"}
                </button>
              </div>
              {!editId&&<div style={{fontSize:11,color:T.muted,marginTop:4}}>Required for new users</div>}
            </div>
          </div>

          {/* Address fields — optional */}
          <div style={{borderTop:`1px dashed ${T.border}`,paddingTop:12,marginBottom:12}}>
            <div style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:10}}>
              Address <span style={{fontWeight:400,textTransform:"none",letterSpacing:0}}>(optional)</span>
            </div>
            <div className="fg-addr" style={{display:"grid",gap:12}}>
              <div><FL>Street Address</FL><input placeholder="123 Main Street" value={form.address} onChange={e=>sf("address",e.target.value)}/></div>
              <div><FL>Suburb</FL><input placeholder="Ponsonby" value={form.suburb} onChange={e=>sf("suburb",e.target.value)}/></div>
              <div><FL>City</FL><input placeholder="Auckland" value={form.city} onChange={e=>sf("city",e.target.value)}/></div>
              <div><FL>Postcode</FL><input placeholder="1011" value={form.postcode} onChange={e=>sf("postcode",e.target.value)}/></div>
            </div>
          </div>

          {/* Approver/Viewer/Mentor: pick which apprentices (or apprentices+viewers for mentor) they cover */}
          {["Approver","Viewer","Mentor"].includes(form.role)&&(
            <div style={{marginBottom:16}}>
              <FL>Allocated {form.role==="Mentor"?"Apprentices & Viewers":"Apprentices"}</FL>
              {allocatable.length===0
                ? <div style={{fontSize:12,color:T.muted,fontStyle:"italic",marginTop:4}}>
                    No {form.role==="Mentor"?"apprentices or viewers":"apprentices"} found
                  </div>
                : <>
                    <select
                      value=""
                      onChange={e=>{if(e.target.value)toggleAlloc(e.target.value);}}
                      style={{marginTop:6,marginBottom:8}}>
                      <option value="">+ Add {form.role==="Mentor"?"person":"apprentice"}…</option>
                      {allocatable.filter(u=>!form.allocatedTo.includes(u.id)).map(u=>(
                        <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                      ))}
                    </select>
                    {form.allocatedTo.length>0&&(
                      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                        {form.allocatedTo.map(id=>{
                          const u=allocatable.find(x=>x.id===id);
                          if(!u) return null;
                          return (
                            <div key={id} style={{
                              display:"inline-flex",alignItems:"center",gap:6,
                              padding:"4px 10px",borderRadius:99,fontSize:12,fontWeight:600,
                              background:T.accentL,color:T.accent,
                              border:`1.5px solid ${T.accent}44`}}>
                              {u.name}
                              <button onClick={()=>toggleAlloc(id)} style={{
                                background:"none",border:"none",color:T.accent,
                                cursor:"pointer",padding:0,fontSize:13,lineHeight:1,
                                fontFamily:"DM Sans,sans-serif"}}>×</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {form.allocatedTo.length===0&&(
                      <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>None selected yet</div>
                    )}
                  </>
              }
            </div>
          )}

          {/* Apprentice: pick which Approver and Viewer are assigned to them */}
          {form.role==="Apprentice"&&(
            <div className="fg2" style={{display:"grid",gap:16,marginBottom:16}}>
              <div>
                <FL>Approver <span style={{fontWeight:400,color:T.muted}}>(approves timesheets)</span></FL>
                <select value={appApprover} onChange={e=>setAppApprover(e.target.value)}>
                  <option value="">— None —</option>
                  {approverOptions.map(u=>(
                    <option key={u.id} value={u.id}>
                      {u.name}{u.role==="Admin"?` (Admin${u.secondaryRole?` + ${u.secondaryRole}`:""})`:""}</option>
                  ))}
                </select>
              </div>
              <div>
                <FL>Viewer <span style={{fontWeight:400,color:T.muted}}>(read-only access)</span></FL>
                <select value={appViewer} onChange={e=>setAppViewer(e.target.value)}>
                  <option value="">— None —</option>
                  {viewerOptions.map(u=>(
                    <option key={u.id} value={u.id}>
                      {u.name}{u.role==="Admin"?` (Admin${u.secondaryRole?` + ${u.secondaryRole}`:""})`:""}</option>
                  ))}
                </select>
              </div>
              <div>
                <FL>Mentor <span style={{fontWeight:400,color:T.muted}}>(assigned KTA mentor)</span></FL>
                <select value={appMentor} onChange={e=>setAppMentor(e.target.value)}>
                  <option value="">— None —</option>
                  {users.filter(u=>u.role==="Mentor"||(u.role==="Admin")).map(u=>(
                    <option key={u.id} value={u.id}>{u.name}{u.role==="Admin"?" (Admin)":""}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update User":"Create User"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);setAppApprover("");setAppViewer("");setAppMentor("");}}>Cancel</Btn>
          </div>
        </Card>
      )}

      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"44px 1fr 130px 170px 1fr 72px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <span/><span>Name</span><span>Role</span><span>Email</span><span>Allocated To</span><span/>
        </div>
        {users.map((u,i)=>{
          const isEditing = editId===u.id && showForm;
          return (
          <div key={u.id} className="ri" style={{
            display:"grid",gridTemplateColumns:"44px 1fr 130px 170px 1fr 72px",
            padding:"12px 16px",borderBottom:i<users.length-1?`1px solid ${T.border}44`:"none",
            background:isEditing?T.blueL:i%2===0?T.surface:T.bg,
            alignItems:"center",gap:8,animationDelay:`${i*.03}s`,
            cursor:canEditUser(u)?"pointer":"default"}}
            onClick={()=>canEditUser(u)&&startEdit(u)}
            onMouseEnter={e=>{if(!isEditing&&canEditUser(u))e.currentTarget.style.background=T.blueL+"99";}}
            onMouseLeave={e=>{e.currentTarget.style.background=isEditing?T.blueL:i%2===0?T.surface:T.bg;}}>
            <Avatar name={u.name} role={u.role}/>
            <div>
              <div style={{fontWeight:700,fontSize:13}}>{u.name}</div>
              {u.phone&&<div style={{fontSize:11,color:T.muted}}>{u.phone}</div>}
              <div style={{fontSize:11,color:canEditUser(u)?T.blue:T.muted,marginTop:1}}>
                {isEditing?"editing…":canEditUser(u)?"click to edit":"view only"}
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
              <RolePill role={u.role} adminLevel={u.adminLevel||null} size="sm"/>
              {u.role==="Admin"&&u.secondaryRole&&(
                <><span style={{fontSize:10,color:T.muted}}>+</span><RolePill role={u.secondaryRole} size="sm"/></>
              )}
            </div>
            <div style={{fontSize:12,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.email||"—"}</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center"}}>
              {(u.allocatedTo||[]).length===0&&<span style={{fontSize:11,color:T.muted,fontStyle:"italic"}}>—</span>}
              {(u.allocatedTo||[]).map(aid=>{
                const a=users.find(x=>x.id===aid);
                return a?<span key={aid} style={{fontSize:12,color:T.sub,display:"flex",alignItems:"center",gap:4}}>
                  <RolePill role={a.role} size="sm"/>{a.name}
                </span>:null;
              })}
            </div>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}} onClick={e=>e.stopPropagation()}>
              {canEditUser(u)&&(
                <button onClick={()=>startEdit(u)} style={{width:26,height:26,borderRadius:6,fontSize:12,
                  background:isEditing?T.blueL:"transparent",color:isEditing?T.blue:T.muted,
                  border:`1px solid ${isEditing?T.blue+"66":T.border}`,
                  display:"flex",alignItems:"center",justifyContent:"center"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                  onMouseLeave={e=>{e.currentTarget.style.background=isEditing?T.blueL:"transparent";e.currentTarget.style.color=isEditing?T.blue:T.muted;}}>✎</button>
              )}
              {canDeleteUser(u)&&(
                <button onClick={()=>deleteUser(u.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,
                  background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
                  display:"flex",alignItems:"center",justifyContent:"center"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                  onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
              )}
              {!canEditUser(u)&&(
                <span style={{fontSize:11,color:T.muted,fontStyle:"italic",padding:"0 4px"}}>🔒</span>
              )}
            </div>
          </div>
          );
        })}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CRM MODULE
// ─────────────────────────────────────────────────────────────────────────────
function CRMModule({currentUser,allUsers}) {
  const [contacts,setContacts]=useState([]);
  const [deals,setDeals]=useState([]);
  const [crmLoading,setCrmLoading]=useState(true);
  const [tab,setTab]=useState("contacts");
  const [showCF,setShowCF]=useState(false);
  const [showDF,setShowDF]=useState(false);
  const [cForm,setCForm]=useState({name:"",company:"",email:"",phone:"",status:"Active",notes:""});
  const [dForm,setDForm]=useState({title:"",contact:"",value:"",stage:"Lead",closeDate:"",notes:""});
  const [editCId,setEditCId]=useState(null);
  const [hsEmail,setHsEmail]=useState("");
  const [hsStatus,setHsStatus]=useState(null); // null | "searching" | "found" | "notfound" | "error"
  const [hsSource,setHsSource]=useState(false); // true if form was populated from HubSpot

  useEffect(()=>{
    (async()=>{
      try{
        const [c,d]=await Promise.all([loadTable('crm_contacts'),loadTable('crm_deals')]);
        setContacts(c.map(x=>({id:x.id,name:x.name,company:x.company||"",email:x.email||"",phone:x.phone||"",status:x.status||"Active",notes:x.notes||""})));
        setDeals(d.map(x=>({id:x.id,title:x.title,contact:x.contact||"",value:x.value||"",stage:x.stage||"Lead",closeDate:x.close_date||"",notes:x.notes||""})));
      }catch(e){console.error('CRM load',e);}
      finally{setCrmLoading(false);}
    })();
  },[]);

  const role=currentUser.role;
  const fullAccess=role==="Admin"||role==="Mentor";
  const canEdit=role==="Admin"||role==="Mentor"; // Both Admins (all levels) and Mentors can create/edit contacts & deals

  const sc=(k,v)=>setCForm(f=>({...f,[k]:v}));
  const sd=(k,v)=>setDForm(f=>({...f,[k]:v}));

  const resetContactForm = () => {
    setCForm({name:"",company:"",email:"",phone:"",status:"Active",notes:""});
    setHsEmail(""); setHsStatus(null); setHsSource(false);
  };

  const handleHsLookup = async () => {
    const val = hsEmail.trim();
    if(!val) return;
    setHsStatus("searching");
    const result = await lookupHubspot(val);
    if(result) {
      setCForm(result);
      setHsStatus("found");
      setHsSource(true);
    } else {
      // Pre-fill whichever field they typed so they don't have to retype
      const isPhone = /^[+\d\s\-()]{6,}$/.test(val) && !/[@.]/.test(val);
      setCForm(f=>({...f, [isPhone?"phone":"email"]: val}));
      setHsStatus("notfound");
      setHsSource(false);
    }
  };

  const saveContact=()=>{
    if(!cForm.name.trim()) return;
    const row={...cForm};
    if(editCId){
      const updated={id:editCId,...row};
      setContacts(prev=>prev.map(c=>c.id===editCId?{...c,...row}:c));
      upsertRow('crm_contacts',{id:editCId,name:row.name,company:row.company||"",email:row.email||"",phone:row.phone||"",status:row.status||"Active",notes:row.notes||""}).catch(console.error);
      setEditCId(null);
    } else {
      const id=uid();
      setContacts(prev=>[{id,...row},...prev]);
      upsertRow('crm_contacts',{id,name:row.name,company:row.company||"",email:row.email||"",phone:row.phone||"",status:row.status||"Active",notes:row.notes||""}).catch(console.error);
    }
    setCForm({name:"",company:"",email:"",phone:"",status:"Active",notes:""});resetContactForm();setShowCF(false);
  };
  const saveDeal=()=>{
    if(!dForm.title.trim()) return;
    const id=uid();
    const row={id,...dForm};
    setDeals(prev=>[row,...prev]);
    upsertRow('crm_deals',{id,title:dForm.title,contact:dForm.contact||"",value:dForm.value||"",stage:dForm.stage||"Lead",close_date:dForm.closeDate||null,notes:dForm.notes||""}).catch(console.error);
    setDForm({title:"",contact:"",value:"",stage:"Lead",closeDate:"",notes:""});setShowDF(false);
  };
  const moveDeal=(id,stage)=>{ setDeals(prev=>prev.map(d=>d.id===id?{...d,stage}:d)); upsertRow("crm_deals",{id,stage}).catch(console.error); };
  const startEditC=(c)=>{setCForm({name:c.name,company:c.company||"",email:c.email||"",phone:c.phone||"",status:c.status,notes:c.notes||""});setEditCId(c.id);setHsStatus(null);setHsSource(false);setHsEmail("");setShowCF(true);};

  const pipeline=STAGES.map(s=>({stage:s,color:STAGE_C[s],
    items:deals.filter(d=>d.stage===s),
    value:deals.filter(d=>d.stage===s).reduce((a,d)=>a+(parseFloat(d.value)||0),0)}));
  const totalOpen=deals.filter(d=>!["Won","Lost"].includes(d.stage)).reduce((a,d)=>a+(parseFloat(d.value)||0),0);
  const totalWon=deals.filter(d=>d.stage==="Won").reduce((a,d)=>a+(parseFloat(d.value)||0),0);

  if(!fullAccess) return (
    <div className="fu">
      <div style={{background:T.warnL,border:`1.5px solid ${T.warn}44`,borderRadius:10,padding:"16px 20px",display:"flex",gap:12,alignItems:"center"}}>
        <span style={{fontSize:22}}>🔒</span>
        <div>
          <strong style={{color:T.warn,fontSize:14}}>Restricted Access</strong>
          <div style={{fontSize:13,color:T.sub,marginTop:3}}>CRM is available to Admins and Mentors only.</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fu">
      <div style={{background:ROLE_META[role].bg,border:`1.5px solid ${ROLE_META[role].color}44`,
        borderRadius:10,padding:"10px 16px",marginBottom:20,display:"flex",gap:10,alignItems:"center"}}>
        <span style={{fontSize:16}}>{ROLE_META[role].symbol}</span>
        <span style={{fontWeight:700,color:ROLE_META[role].color,fontSize:13}}>{role} View — </span>
        <span style={{fontSize:13,color:T.sub}}>{canEdit?"Full CRM access — edit contacts and deals":"Read-only CRM view"}</span>
      </div>
      <div className="stat-grid-4">
        <StatCard label="Contacts" value={contacts.length} color={T.blue}/>
        <StatCard label="Active Deals" value={deals.filter(d=>!["Won","Lost"].includes(d.stage)).length} color={T.warn}/>
        <StatCard label="Pipeline" value={`$${(totalOpen/1000).toFixed(1)}k`} color={T.accent}/>
        <StatCard label="Won" value={`$${(totalWon/1000).toFixed(1)}k`} color={T.hol}/>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        {["contacts","pipeline","deals"].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{
            padding:"7px 16px",borderRadius:8,fontSize:13,fontWeight:600,
            background:tab===t?T.accent:T.surface,color:tab===t?"#fff":T.sub,
            border:`1.5px solid ${tab===t?T.accentD:T.border}`,
            fontFamily:"DM Sans,sans-serif",cursor:"pointer",transition:"all .14s"
          }}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>
        ))}
      </div>
      {tab==="contacts"&&(<>
        {canEdit&&<div style={{marginBottom:14}}>
          <Btn sm onClick={()=>{ resetContactForm(); setEditCId(null); setShowCF(s=>!s); }}>
            {showCF?"✕ Cancel":"+ Add Contact"}
          </Btn>
        </div>}

        {showCF&&<Card style={{marginBottom:16,border:`1.5px solid ${T.blue}44`}}>
          {/* ── Step 1: HubSpot lookup (only shown for new contacts) ── */}
          {!editCId&&hsStatus!=="found"&&hsStatus!=="notfound"&&(
            <div style={{marginBottom:16}}>
              <div style={{fontWeight:700,fontSize:13,color:T.ink,marginBottom:4,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:16}}>🔍</span> Look up in HubSpot
              </div>
              <div style={{fontSize:12,color:T.sub,marginBottom:10}}>Enter an email or phone number to auto-fill from HubSpot.</div>
              <div style={{display:"flex",gap:8}}>
                <input
                  placeholder="Email address or phone number…"
                  value={hsEmail}
                  onChange={e=>setHsEmail(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&handleHsLookup()}
                  style={{flex:1,borderColor:T.border}}
                />
                <button onClick={handleHsLookup} disabled={hsStatus==="searching"||!hsEmail.trim()} style={{
                  padding:"9px 18px",background:T.accent,color:"#fff",border:`1.5px solid ${T.accentD}`,
                  borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",
                  fontFamily:"DM Sans,sans-serif",opacity:(!hsEmail.trim()||hsStatus==="searching")?0.5:1,
                  display:"flex",alignItems:"center",gap:7,transition:"all .15s"
                }}>
                  {hsStatus==="searching"
                    ? <><span style={{width:13,height:13,border:"2px solid #ffffff66",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin .7s linear infinite"}}/>Searching…</>
                    : "Search HubSpot"
                  }
                </button>
              </div>
              <div style={{marginTop:10,textAlign:"right"}}>
                <button onClick={()=>setHsStatus("notfound")} style={{
                  background:"none",border:"none",color:T.muted,fontSize:12,
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif",textDecoration:"underline"
                }}>Skip — enter manually</button>
              </div>
            </div>
          )}

          {/* ── HubSpot result banner ── */}
          {hsStatus==="found"&&(
            <div style={{background:T.accentL,border:`1.5px solid ${T.accent}44`,borderRadius:9,
              padding:"9px 14px",marginBottom:14,display:"flex",gap:10,alignItems:"center",fontSize:13}}>
              <span style={{fontSize:16}}>✓</span>
              <div style={{flex:1}}>
                <strong style={{color:T.accent}}>Found in HubSpot</strong>
                <span style={{color:T.sub,marginLeft:8}}>Fields auto-filled — review and save.</span>
              </div>
              <button onClick={()=>{setHsStatus(null);setHsSource(false);resetContactForm();}} style={{
                background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:13,fontFamily:"DM Sans,sans-serif"
              }}>✕ Clear</button>
            </div>
          )}
          {hsStatus==="notfound"&&!editCId&&(
            <div style={{background:T.warnL,border:`1.5px solid ${T.warn}44`,borderRadius:9,
              padding:"9px 14px",marginBottom:14,display:"flex",gap:10,alignItems:"center",fontSize:13}}>
              <span>⚠</span>
              <span style={{color:T.warn,flex:1}}>Not found in HubSpot — fill in manually below.</span>
              <button onClick={()=>{setHsStatus(null);setHsEmail("");}} style={{
                background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:13,fontFamily:"DM Sans,sans-serif"
              }}>← Try again</button>
            </div>
          )}

          {/* ── Contact fields (shown after lookup result or skip) ── */}
          {(editCId||hsStatus==="found"||hsStatus==="notfound")&&(<>
            <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
              <div><FL req>Name</FL><input value={cForm.name} onChange={e=>sc("name",e.target.value)} placeholder="Contact name"/></div>
              <div><FL>Company</FL><input value={cForm.company} onChange={e=>sc("company",e.target.value)} placeholder="Company"/></div>
              <div><FL>Email</FL><input value={cForm.email} onChange={e=>sc("email",e.target.value)} placeholder="email@co.com"/></div>
              <div><FL>Phone</FL><input value={cForm.phone} onChange={e=>sc("phone",e.target.value)} placeholder="+64…"/></div>
              <div><FL>Status</FL>
                <select value={cForm.status} onChange={e=>sc("status",e.target.value)}>
                  {["Active","Prospect","Inactive"].map(s=><option key={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={cForm.notes} onChange={e=>sc("notes",e.target.value)} placeholder="Notes…"/></div>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={saveContact}>{editCId?"Update":"Save Contact"}</Btn>
              <Btn v="ghost" onClick={()=>{setShowCF(false);setEditCId(null);resetContactForm();}}>Cancel</Btn>
            </div>
          </>)}
        </Card>}
        <Card style={{padding:0,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 140px 160px 100px 60px",
            padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
            fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
            <span>Name</span><span>Email</span><span>Phone</span><span>Status</span><span/>
          </div>
          {contacts.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No contacts yet.</div>}
          {contacts.map((c,i)=>(
            <div key={c.id} className="ri" style={{display:"grid",gridTemplateColumns:"1fr 140px 160px 100px 60px",
              padding:"12px 16px",borderBottom:i<contacts.length-1?`1px solid ${T.border}44`:"none",
              background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
              <div>
                <div style={{fontWeight:700,fontSize:13}}>{c.name}</div>
                {c.company&&<div style={{fontSize:11,color:T.muted}}>{c.company}</div>}
              </div>
              <div style={{fontSize:12,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.email||"—"}</div>
              <div style={{fontSize:12,color:T.sub}}>{c.phone||"—"}</div>
              <Pill label={c.status} size="sm"
                color={c.status==="Active"?T.accent:c.status==="Prospect"?T.warn:T.muted}
                bg={c.status==="Active"?T.accentL:c.status==="Prospect"?T.warnL:T.slateL}/>
              {canEdit&&<div style={{display:"flex",gap:5}}>
                <button onClick={()=>startEditC(c)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                  onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
                <button onClick={()=>setContacts(prev=>prev.filter(x=>x.id!==c.id))} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                  onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
              </div>}
            </div>
          ))}
        </Card>
      </>)}
      {tab==="pipeline"&&<div style={{overflowX:"auto"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,minWidth:900}}>
          {pipeline.map(({stage,color,items,value})=>(
            <div key={stage}>
              <div style={{padding:"8px 11px",borderRadius:"9px 9px 0 0",background:color+"18",borderBottom:`2px solid ${color}`,marginBottom:8}}>
                <div style={{fontWeight:700,fontSize:12,color}}>{stage}</div>
                <div style={{fontSize:11,color:T.muted,marginTop:2}}>{items.length} · ${value.toLocaleString()}</div>
              </div>
              {items.map(d=>(
                <div key={d.id} style={{background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:9,padding:"10px 12px",marginBottom:8}}>
                  <div style={{fontWeight:700,fontSize:13}}>{d.title}</div>
                  {d.contact&&<div style={{color:T.muted,fontSize:11,marginTop:2}}>{d.contact}</div>}
                  {d.value&&<div style={{color,fontWeight:700,fontSize:14,marginTop:5}}>${parseFloat(d.value).toLocaleString()}</div>}
                  {canEdit&&<div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:9}}>
                    {STAGES.filter(s=>s!==stage).map(s=>(
                      <button key={s} onClick={()=>moveDeal(d.id,s)} style={{
                        fontSize:9,padding:"2px 6px",borderRadius:4,
                        background:STAGE_C[s]+"22",color:STAGE_C[s],border:"none",
                        fontWeight:700,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>→{s}</button>
                    ))}
                  </div>}
                </div>
              ))}
              {items.length===0&&<div style={{color:T.muted,fontSize:11,textAlign:"center",paddingTop:12}}>Empty</div>}
            </div>
          ))}
        </div>
      </div>}
      {tab==="deals"&&(<>
        {canEdit&&<div style={{marginBottom:14}}>
          <Btn sm onClick={()=>setShowDF(s=>!s)}>{showDF?"✕ Cancel":"+ Add Deal"}</Btn>
        </div>}
        {showDF&&<Card style={{marginBottom:16,border:`1.5px solid ${T.warn}44`}}>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Title</FL><input value={dForm.title} onChange={e=>sd("title",e.target.value)} placeholder="Deal name"/></div>
            <div><FL>Contact</FL><input value={dForm.contact} onChange={e=>sd("contact",e.target.value)} placeholder="Name / Company"/></div>
            <div><FL>Value ($)</FL><input type="number" value={dForm.value} onChange={e=>sd("value",e.target.value)} placeholder="10000"/></div>
            <div><FL>Stage</FL><select value={dForm.stage} onChange={e=>sd("stage",e.target.value)}>{STAGES.map(s=><option key={s}>{s}</option>)}</select></div>
            <div><FL>Close Date</FL><input type="date" value={dForm.closeDate} onChange={e=>sd("closeDate",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={dForm.notes} onChange={e=>sd("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={saveDeal}>Save Deal</Btn>
            <Btn v="ghost" onClick={()=>setShowDF(false)}>Cancel</Btn>
          </div>
        </Card>}
        <Card style={{padding:0,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"8px 1fr 140px 100px 120px 100px 40px",
            padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
            fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:10}}>
            <span/><span>Deal</span><span>Contact</span><span style={{textAlign:"right"}}>Value</span>
            <span>Stage</span><span>Close</span><span/>
          </div>
          {deals.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No deals yet.</div>}
          {deals.map((d,i)=>(
            <div key={d.id} className="ri" style={{display:"grid",gridTemplateColumns:"8px 1fr 140px 100px 120px 100px 40px",
              padding:"12px 16px",borderBottom:i<deals.length-1?`1px solid ${T.border}44`:"none",
              background:i%2===0?T.surface:T.bg,alignItems:"center",gap:10,animationDelay:`${i*.03}s`}}>
              <div style={{width:8,height:34,borderRadius:3,background:STAGE_C[d.stage]||T.muted}}/>
              <div><div style={{fontWeight:700,fontSize:13}}>{d.title}</div>
                {d.notes&&<div style={{fontSize:11,color:T.muted,marginTop:1}}>{d.notes}</div>}</div>
              <div style={{fontSize:12,color:T.sub}}>{d.contact||"—"}</div>
              <div style={{textAlign:"right",fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:14,color:STAGE_C[d.stage]||T.muted}}>
                {d.value?`$${parseFloat(d.value).toLocaleString()}`:"—"}</div>
              <Pill label={d.stage} size="sm" color={STAGE_C[d.stage]||T.muted} bg={(STAGE_C[d.stage]||T.muted)+"1a"}/>
              <div style={{fontSize:11,color:T.muted}}>{d.closeDate?new Date(d.closeDate+"T00:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}):"—"}</div>
              {canEdit&&<button onClick={()=>{ setDeals(prev=>prev.filter(x=>x.id!==d.id)); deleteRow("crm_deals",d.id).catch(console.error); }} style={{
                width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,
                border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>}
            </div>
          ))}
        </Card>
      </>)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN DASHBOARD  — overview cards linking to each apprentice's timesheets
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// HOURS THIS WEEK LIST  — all entries this week, grouped by apprentice A-Z
// ─────────────────────────────────────────────────────────────────────────────
function WeeklyHoursList({allUsers, entries}) {
  const ws = ()=>{ const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };
  const wsDate = ws();
  const apprentices = [...allUsers.filter(u=>u.role==="Apprentice")].sort((a,b)=>a.name.localeCompare(b.name));
  const weekEntries = entries.filter(e=>e.date>=wsDate);

  // Total hours by type across all apprentices this week
  const globalTypeHrs = ENTRY_TYPES.map(t=>({
    type:t,
    hrs:weekEntries.reduce((a,e)=>e.type===t?a+e.netHours:a,0)
  })).filter(x=>x.hrs>0);
  const globalTotal = weekEntries.reduce((a,e)=>a+e.netHours,0).toFixed(1);

  return (
    <div className="fu">
      <div style={{marginBottom:18}}>
        <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>Hours This Week</div>
        <div style={{fontSize:12,color:T.sub,marginTop:3}}>All timesheet entries from this week, grouped by apprentice.</div>
      </div>

      {/* Global type summary bar */}
      {weekEntries.length>0 && (
        <Card style={{marginBottom:20,padding:"16px 20px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700}}>All Apprentices — Week Total</div>
            <div style={{fontFamily:"'Libre Baskerville'",fontSize:22,fontWeight:700,color:T.accent}}>{globalTotal}h</div>
          </div>
          {/* Type breakdown pills */}
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:12}}>
            {globalTypeHrs.map(({type,hrs})=>{
              const m = TYPE_META[type]||TYPE_META["Other"];
              return (
                <div key={type} style={{display:"flex",alignItems:"center",gap:6,
                  background:m.bg,border:`1px solid ${m.color}44`,
                  borderRadius:8,padding:"5px 10px"}}>
                  <span style={{fontSize:13}}>{m.sym}</span>
                  <span style={{fontSize:12,color:m.color,fontWeight:600}}>{type}</span>
                  <span style={{fontSize:13,fontWeight:700,color:m.color,fontFamily:"'Libre Baskerville'"}}>{hrs.toFixed(1)}h</span>
                </div>
              );
            })}
          </div>
          {/* Stacked bar */}
          <div style={{display:"flex",height:8,borderRadius:4,overflow:"hidden",gap:1}}>
            {globalTypeHrs.map(({type,hrs})=>{
              const m = TYPE_META[type]||TYPE_META["Other"];
              const pct = (hrs/parseFloat(globalTotal))*100;
              return <div key={type} style={{width:`${pct}%`,background:m.color,transition:"width .3s"}} title={`${type}: ${hrs.toFixed(1)}h`}/>;
            })}
          </div>
        </Card>
      )}

      {apprentices.length===0 && <Card><div style={{color:T.muted,textAlign:"center",padding:24}}>No apprentices found.</div></Card>}
      {apprentices.map(app=>{
        const appEntries = weekEntries.filter(e=>e.userId===app.id).sort((a,b)=>b.date.localeCompare(a.date));
        const totalHrs = appEntries.reduce((a,e)=>a+e.netHours,0);
        // Per-apprentice type breakdown
        const typeHrs = ENTRY_TYPES.map(t=>({
          type:t,
          hrs:appEntries.reduce((a,e)=>e.type===t?a+e.netHours:a,0)
        })).filter(x=>x.hrs>0);

        return (
          <Card key={app.id} style={{marginBottom:14}}>
            {/* Header row */}
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:appEntries.length>0?12:0}}>
              <Avatar name={app.name} role="Apprentice" size={36}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14}}>{app.name}</div>
                <div style={{fontSize:12,color:T.sub}}>{appEntries.length} entr{appEntries.length===1?"y":"ies"} this week</div>
              </div>
              <div style={{fontFamily:"'Libre Baskerville'",fontSize:22,fontWeight:700,color:T.accent}}>{totalHrs.toFixed(1)}h</div>
            </div>

            {appEntries.length===0 && <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>No entries this week.</div>}

            {appEntries.length>0 && (<>
              {/* Type breakdown pills for this apprentice */}
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
                {typeHrs.map(({type,hrs})=>{
                  const m = TYPE_META[type]||TYPE_META["Other"];
                  return (
                    <div key={type} style={{display:"flex",alignItems:"center",gap:5,
                      background:m.bg,border:`1px solid ${m.color}33`,
                      borderRadius:6,padding:"3px 8px"}}>
                      <span style={{fontSize:11}}>{m.sym}</span>
                      <span style={{fontSize:11,color:m.color,fontWeight:600}}>{type}</span>
                      <span style={{fontSize:12,fontWeight:700,color:m.color}}>{hrs.toFixed(1)}h</span>
                    </div>
                  );
                })}
              </div>
              {/* Mini stacked bar */}
              {totalHrs>0 && (
                <div style={{display:"flex",height:5,borderRadius:3,overflow:"hidden",gap:1,marginBottom:10}}>
                  {typeHrs.map(({type,hrs})=>{
                    const m = TYPE_META[type]||TYPE_META["Other"];
                    return <div key={type} style={{width:`${(hrs/totalHrs)*100}%`,background:m.color}} title={`${type}: ${hrs.toFixed(1)}h`}/>;
                  })}
                </div>
              )}
              {/* Entry rows */}
              <div style={{borderTop:`1px solid ${T.border}`,paddingTop:10}}>
                {appEntries.map((e,i)=>(
                  <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 120px 60px 90px",
                    gap:8,padding:"7px 4px",borderBottom:i<appEntries.length-1?`1px solid ${T.border}44`:"none",
                    alignItems:"center",fontSize:12}}>
                    <div style={{fontWeight:600}}>{fmtD(e.date)}</div>
                    <div style={{color:e.note?T.ink:T.muted,fontStyle:e.note?"normal":"italic",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note||"No note"}</div>
                    <TypePill type={e.type} size="sm"/>
                    <div style={{fontWeight:700,color:TYPE_META[e.type]?.color||T.accent,textAlign:"center"}}>{e.netHours}h</div>
                    <AppvPill status={e.approval}/>
                  </div>
                ))}
              </div>
            </>)}
          </Card>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING / APPROVED ENTRIES LIST  — grouped by apprentice A-Z
// ─────────────────────────────────────────────────────────────────────────────
function ApprovalList({allUsers, entries, status, onApprove, onDecline}) {
  const apprentices = [...allUsers.filter(u=>u.role==="Apprentice")].sort((a,b)=>a.name.localeCompare(b.name));
  const filtered = entries.filter(e=>e.approval===status);
  const isPending = status==="submitted";

  return (
    <div className="fu">
      <div style={{marginBottom:18}}>
        <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>
          {status==="submitted"?"Pending":status==="approved"?"Submitted — Approved":"Submitted — Not Approved"}
        </div>
        <div style={{fontSize:12,color:T.sub,marginTop:3}}>
          {filtered.length} entr{filtered.length===1?"y":"ies"} — grouped by apprentice A–Z.
        </div>
      </div>
      {filtered.length===0 && (
        <Card style={{textAlign:"center",padding:"48px 24px"}}>
          <div style={{fontSize:32,marginBottom:8}}>{isPending?"✓":"◈"}</div>
          <div style={{fontWeight:600,fontSize:15}}>{status==="submitted"?"All caught up!":status==="approved"?"No approved entries yet.":"No declined entries."}</div>
          <div style={{fontSize:12,color:T.sub,marginTop:6}}>{status==="submitted"?"No timesheets are waiting for approval.":""}</div>
        </Card>
      )}
      {apprentices.map(app=>{
        const appEntries = filtered.filter(e=>e.userId===app.id).sort((a,b)=>b.date.localeCompare(a.date));
        if(appEntries.length===0) return null;
        return (
          <Card key={app.id} style={{marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
              <Avatar name={app.name} role="Apprentice" size={36}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14}}>{app.name}</div>
                <div style={{fontSize:12,color:T.sub}}>{appEntries.length} {status} entr{appEntries.length===1?"y":"ies"}</div>
              </div>
            </div>
            <div style={{borderTop:`1px solid ${T.border}`,paddingTop:10}}>
              {appEntries.map((e,i)=>(
                <div key={e.id} style={{display:"grid",
                  gridTemplateColumns:isPending?"110px 1fr 120px 60px 80px":"110px 1fr 120px 60px",
                  gap:8,padding:"8px 4px",borderBottom:i<appEntries.length-1?`1px solid ${T.border}44`:"none",
                  alignItems:"center",fontSize:12}}>
                  <div style={{fontWeight:600}}>{fmtD(e.date)}</div>
                  <div style={{color:e.note?T.ink:T.muted,fontStyle:e.note?"normal":"italic",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note||"No note"}</div>
                  <TypePill type={e.type} size="sm"/>
                  <div style={{fontWeight:700,color:TYPE_META[e.type]?.color||T.accent,textAlign:"center"}}>{e.netHours}h</div>
                  {isPending && (
                    <div style={{display:"flex",gap:4}}>
                      <button onClick={()=>onApprove(e.id)} style={{width:28,height:28,borderRadius:6,fontSize:13,background:T.accentL,color:T.accent,border:`1px solid ${T.accent}44`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}} title="Approve">✓</button>
                      <button onClick={()=>onDecline(e.id)} style={{width:28,height:28,borderRadius:6,fontSize:13,background:T.redL,color:T.red,border:`1px solid ${T.red}44`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}} title="Decline">✕</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APPRENTICE LIST
// ─────────────────────────────────────────────────────────────────────────────
function ApprenticeList({allUsers, setUsers, onViewTimesheet}) {
  const apprentices = [...allUsers.filter(u => u.role === "Apprentice")].sort((a,b)=>a.name.localeCompare(b.name));
  const approvers   = allUsers.filter(u => u.role === "Approver" || u.role === "Admin");
  const viewers     = allUsers.filter(u => u.role === "Viewer"   || u.role === "Admin");
  const mentors     = allUsers.filter(u => u.role === "Mentor"   || u.role === "Admin");

  const blank = {firstName:"", lastName:"", email:"", phone:"", trade:"", licenceExpiry:"", hostBusiness:"", role:"Apprentice", allocatedTo:[], password:"", overtimeType:null, overtimeThreshold:"", overtimeRateId:""};
  const [form, setForm]         = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState(null);
  const [pwField, setPwField]   = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [expandId, setExpandId] = useState(null);
  const [formApproverId, setFormApproverId] = useState("");
  const [formViewerId,   setFormViewerId]   = useState("");
  const [formMentorId,   setFormMentorId]   = useState("");
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));

  const getAllocated = (role, appId) =>
    allUsers.filter(u => (u.role===role || u.role==="Admin") && (u.allocatedTo||[]).includes(appId));

  // Get approver/viewer/mentor using direct fields (source of truth) with allocatedTo fallback
  const getApprover = (apprentice) => {
    if(apprentice.approverUserId) return allUsers.find(u=>u.id===apprentice.approverUserId);
    return allUsers.find(u=>(u.role==="Approver"||u.role==="Admin")&&(u.allocatedTo||[]).includes(apprentice.id));
  };
  const getViewer = (apprentice) => {
    if(apprentice.viewerUserId) return allUsers.find(u=>u.id===apprentice.viewerUserId);
    return allUsers.find(u=>(u.role==="Viewer"||u.role==="Admin")&&(u.allocatedTo||[]).includes(apprentice.id));
  };
  const getMentor = (apprentice) => {
    if(apprentice.mentorUserId) return allUsers.find(u=>u.id===apprentice.mentorUserId);
    return null;
  };

  const toggleAlloc = (staffId, appId) => {
    setUsers(prev => prev.map(u => {
      if(u.id !== staffId) return u;
      const has = (u.allocatedTo||[]).includes(appId);
      return {...u, allocatedTo: has
        ? (u.allocatedTo||[]).filter(x=>x!==appId)
        : [...(u.allocatedTo||[]), appId]};
    }));
  };

  const submit = () => {
    const firstName = form.firstName.trim();
    const lastName  = form.lastName.trim();
    if(!firstName||!form.email.trim()) return;
    const fullName = `${firstName} ${lastName}`.trim();
    const finalForm = {...form, name: fullName, firstName, lastName,
      approverUserId: formApproverId||null,
      viewerUserId:   formViewerId||null,
      mentorUserId:   formMentorId||null,
    };
    if(pwField.trim()) finalForm.password = hashPw(pwField.trim());
    let appId = editId;
    if(editId) {
      setUsers(prev => prev.map(u => u.id===editId ? {...u,...finalForm} : u));
      setEditId(null);
    } else {
      appId = uid();
      setUsers(prev => [...prev, {id:appId, ...finalForm}]);
    }
    // Sync allocatedTo on approver/viewer/admin users
    setUsers(prev => prev.map(u => {
      if(!["Approver","Viewer","Admin"].includes(u.role)) return u;
      const isApprover = u.id === formApproverId;
      const isViewer   = u.id === formViewerId;
      const shouldHave = isApprover || isViewer;
      const has        = (u.allocatedTo||[]).includes(appId);
      if(shouldHave && !has) return {...u, allocatedTo:[...(u.allocatedTo||[]), appId]};
      if(!shouldHave && has) return {...u, allocatedTo:(u.allocatedTo||[]).filter(x=>x!==appId)};
      return u;
    }));
    setForm(blank); setPwField(""); setFormApproverId(""); setFormViewerId(""); setFormMentorId(""); setShowForm(false);
  };

  const startEdit = (u) => {
    const parts = u.name.split(" ");
    setForm({
      firstName: u.firstName || parts[0] || "",
      lastName:  u.lastName  || parts.slice(1).join(" ") || "",
      email: u.email||"", phone: u.phone||"",
      trade: u.trade||"", licenceExpiry: u.licenceExpiry||"", hostBusiness: u.hostBusiness||"",
      role:"Apprentice", allocatedTo:[], password:u.password,
      overtimeType: u.overtimeType||null, overtimeThreshold: u.overtimeThreshold||"", overtimeRateId: u.overtimeRateId||"",
    });
    // Pre-select from approverUserId/viewerUserId/mentorUserId (new) or fall back to allocatedTo (legacy)
    const curApprover = u.approverUserId || allUsers.find(x=>(x.role==="Approver"||x.role==="Admin")&&(x.allocatedTo||[]).includes(u.id))?.id || "";
    const curViewer   = u.viewerUserId   || allUsers.find(x=>(x.role==="Viewer"  ||x.role==="Admin")&&(x.allocatedTo||[]).includes(u.id)&&x.id!==curApprover)?.id || "";
    const curMentor   = u.mentorUserId   || "";
    setFormApproverId(curApprover);
    setFormViewerId(curViewer);
    setFormMentorId(curMentor);
    setPwField(""); setEditId(u.id); setShowForm(true);
    setExpandId(null);
  };

  const deleteUser = (id) => {
    if(window.confirm("Remove this apprentice?")) setUsers(prev => prev.filter(u => u.id !== id));
  };

  // licence expiry colour
  const licColour = (expiry) => {
    if(!expiry) return T.muted;
    const days = (new Date(expiry) - new Date()) / 86400000;
    if(days < 0)   return T.red;
    if(days < 60)  return T.warn;
    if(days < 180) return T.gold;
    return T.accent;
  };

  return (
    <div className="fu">
      {/* Header */}
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:18}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'", fontSize:18, fontWeight:700}}>Apprentices</div>
          <div style={{fontSize:12, color:T.sub, marginTop:3}}>{apprentices.length} apprentice{apprentices.length!==1?"s":""} — click a row to view their timesheet, or expand to manage allocations.</div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setPwField("");setExpandId(null);setFormApproverId("");setFormViewerId("");setShowForm(s=>!s);}}>
          {showForm ? "✕ Cancel" : "+ Add Apprentice"}
        </Btn>
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <Card style={{marginBottom:20, border:`1.5px solid ${T.blue}44`}}>
          <div style={{fontWeight:700, fontSize:14, marginBottom:16, color:T.blue}}>{editId?"✎ Edit Apprentice":"+ New Apprentice"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>First Name</FL><input placeholder="Jamie" value={form.firstName} onChange={e=>sf("firstName",e.target.value)}/></div>
            <div><FL req>Last Name</FL><input placeholder="Smith" value={form.lastName} onChange={e=>sf("lastName",e.target.value)}/></div>
            <div><FL req>Email</FL><input type="email" placeholder="jamie@work.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+61 4xx xxx xxx" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
            <div><FL>Trade</FL>
              <select value={form.trade} onChange={e=>sf("trade",e.target.value)}>
                <option value="">Select trade…</option>
                {TRADES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div><FL>Licence Expiry</FL><input type="date" value={form.licenceExpiry} onChange={e=>sf("licenceExpiry",e.target.value)}/></div>
            <div><FL>Host Business</FL><input placeholder="e.g. Sparks Electrical Ltd" value={form.hostBusiness||""} onChange={e=>sf("hostBusiness",e.target.value)}/></div>
            {/* ── Overtime Settings ── */}
            <div style={{gridColumn:"1/-1"}}>
              <div style={{fontWeight:700,fontSize:12,color:T.sub,textTransform:"uppercase",letterSpacing:".6px",marginBottom:8,marginTop:4,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
                Overtime Settings
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                <div>
                  <FL>Overtime Type</FL>
                  <select value={form.overtimeType||""} onChange={e=>sf("overtimeType",e.target.value||null)}>
                    <option value="">— No overtime —</option>
                    <option value="daily">Daily threshold</option>
                    <option value="weekly">Weekly threshold</option>
                  </select>
                </div>
                {form.overtimeType&&<div>
                  <FL>Threshold Hours</FL>
                  <input type="number" min="1" max="24" step="0.5"
                    placeholder={form.overtimeType==="daily"?"e.g. 8":"e.g. 40"}
                    value={form.overtimeThreshold}
                    onChange={e=>sf("overtimeThreshold",parseFloat(e.target.value)||"")}/>
                  <div style={{fontSize:10,color:T.muted,marginTop:2}}>
                    {form.overtimeType==="daily"?"Hours per day before overtime":"Hours per week before overtime"}
                  </div>
                </div>}
                {form.overtimeType&&<div>
                  <FL>Xero Overtime Rate ID</FL>
                  <input placeholder="Xero earnings rate UUID"
                    value={form.overtimeRateId||""}
                    onChange={e=>sf("overtimeRateId",e.target.value)}/>
                  <div style={{fontSize:10,color:T.muted,marginTop:2}}>Find in Xero → Payroll → Pay Items</div>
                </div>}
              </div>
              {form.overtimeType&&(
                <div style={{marginTop:8,padding:"8px 12px",background:T.accentL,borderRadius:7,fontSize:12,color:T.accent}}>
                  {form.overtimeType==="daily"
                    ? `Any hours beyond ${form.overtimeThreshold||"?"}h in a single day will submit to Xero as overtime`
                    : `Any hours beyond ${form.overtimeThreshold||"?"}h in a week will submit to Xero as overtime`}
                </div>
              )}
            </div>
            <div>
              <FL>Approver <span style={{fontWeight:400,color:T.muted}}>(can approve timesheets)</span></FL>
              <select value={formApproverId} onChange={e=>setFormApproverId(e.target.value)}>
                <option value="">— None —</option>
                {approvers.map(a=><option key={a.id} value={a.id}>{a.name}{a.role==="Admin"?" (Admin)":""}</option>)}
              </select>
            </div>
            <div>
              <FL>Viewer <span style={{fontWeight:400,color:T.muted}}>(read-only access)</span></FL>
              <select value={formViewerId} onChange={e=>setFormViewerId(e.target.value)}>
                <option value="">— None —</option>
                {viewers.map(v=><option key={v.id} value={v.id}>{v.name}{v.role==="Admin"?" (Admin)":""}</option>)}
              </select>
            </div>
            <div>
              <FL>Mentor <span style={{fontWeight:400,color:T.muted}}>(assigned KTA mentor)</span></FL>
              <select value={formMentorId} onChange={e=>setFormMentorId(e.target.value)}>
                <option value="">— None —</option>
                {mentors.map(m=><option key={m.id} value={m.id}>{m.name}{m.role==="Admin"?" (Admin)":""}</option>)}
              </select>
            </div>
            <div>
              <FL>{editId?"New Password (blank = keep)":"Password"}</FL>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} placeholder={editId?"Leave blank to keep":"Set password"}
                  value={pwField} onChange={e=>setPwField(e.target.value)} style={{paddingRight:60}}/>
                <button onClick={()=>setShowPw(s=>!s)} type="button" style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:12,fontFamily:"DM Sans,sans-serif"}}>{showPw?"Hide":"Show"}</button>
              </div>
              {!editId && <div style={{fontSize:11,color:T.muted,marginTop:3}}>Required for new users</div>}
            </div>
          </div>
          <div style={{display:"flex", gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Add Apprentice"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);setFormApproverId("");setFormViewerId("");setFormMentorId("");}}>Cancel</Btn>
          </div>
        </Card>
      )}

      {/* Table header */}
      <Card style={{padding:0, overflow:"hidden"}}>
        <div style={{display:"grid",
          gridTemplateColumns:"36px 1fr 140px 130px 120px 110px 110px 72px",
          padding:"10px 16px", background:T.bg, borderBottom:`1.5px solid ${T.border}`,
          fontSize:11, fontWeight:600, color:T.muted, textTransform:"uppercase", letterSpacing:".6px", gap:8}}>
          <span/><span>Name</span><span>Email</span><span>Phone</span>
          <span>Trade</span><span>Licence Exp.</span><span>Allocations</span>
          <span style={{textAlign:"right"}}>Actions</span>
        </div>

        {apprentices.length === 0 && (
          <div style={{padding:"48px 24px", textAlign:"center", color:T.muted}}>
            <div style={{fontSize:32, marginBottom:8}}>◑</div>
            <div style={{fontWeight:600}}>No apprentices yet</div>
            <div style={{fontSize:12, marginTop:4}}>Add your first apprentice above.</div>
          </div>
        )}

        {apprentices.map((u,i) => {
          const approver   = getApprover(u);
          const viewer     = getViewer(u);
          const mentor     = getMentor(u);
          const isExpanded = expandId === u.id;
          const lc         = licColour(u.licenceExpiry);

          return (
            <div key={u.id}>
              {/* Main row */}
              <div className="ri" style={{
                display:"grid",
                gridTemplateColumns:"36px 1fr 140px 130px 120px 110px 110px 72px",
                padding:"12px 16px",
                borderBottom:(!isExpanded&&i<apprentices.length-1)?`1px solid ${T.border}44`:"none",
                background:isExpanded?T.blueL:i%2===0?T.surface:T.bg,
                alignItems:"center", gap:8, animationDelay:`${i*.03}s`}}>

                {/* Avatar — click → timesheet */}
                <div onClick={()=>onViewTimesheet(u.id)} style={{cursor:"pointer"}}>
                  <Avatar name={u.name} role="Apprentice"/>
                </div>

                {/* Name — click → timesheet */}
                <div onClick={()=>onViewTimesheet(u.id)} style={{cursor:"pointer"}}>
                  <div style={{fontWeight:700, fontSize:13, color:T.accent}}>{u.firstName||u.name.split(" ")[0]} <span style={{color:T.sub}}>{u.lastName||u.name.split(" ").slice(1).join(" ")}</span></div>
                </div>

                <div style={{fontSize:12, color:T.sub, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{u.email||"—"}</div>
                <div style={{fontSize:12, color:T.sub}}>{u.phone||"—"}</div>

                {/* Trade */}
                <div>{u.trade
                  ? <Pill label={u.trade} size="sm" color={T.teal} bg={T.tealL}/>
                  : <span style={{fontSize:12,color:T.muted}}>—</span>}
                </div>

                {/* Licence expiry */}
                <div>
                  {u.licenceExpiry
                    ? <div style={{fontSize:12,fontWeight:600,color:lc}}>
                        {new Date(u.licenceExpiry+"T00:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}
                        {licColour(u.licenceExpiry)===T.red&&<div style={{fontSize:10,color:T.red}}>EXPIRED</div>}
                        {licColour(u.licenceExpiry)===T.warn&&<div style={{fontSize:10,color:T.warn}}>Expiring soon</div>}
                      </div>
                    : <span style={{fontSize:12,color:T.muted}}>—</span>}
                </div>

                {/* Allocation summary — click to expand */}
                <button onClick={()=>setExpandId(isExpanded?null:u.id)} style={{
                  background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left"}}>
                  <div style={{fontSize:11}}>
                    <div style={{color:approver?T.warn:T.muted, fontWeight:approver?600:400}}>
                      ▲ {approver?approver.name.split(" ")[0]:"No approver"}
                    </div>
                    <div style={{color:viewer?T.teal:T.muted, fontWeight:viewer?600:400, marginTop:2}}>
                      ◆ {viewer?viewer.name.split(" ")[0]:"No viewer"}
                    </div>
                    {mentor&&<div style={{color:T.accent, fontWeight:600, marginTop:2}}>
                      ✦ {mentor.name.split(" ")[0]}
                    </div>}
                  </div>
                  <div style={{fontSize:10,color:T.blue,marginTop:3}}>{isExpanded?"▲ collapse":"✎ manage"}</div>
                </button>

                {/* Actions */}
                <div style={{display:"flex", gap:5, justifyContent:"flex-end"}}>
                  <button onClick={()=>startEdit(u)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                    onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
                  <button onClick={()=>deleteUser(u.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                    onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
                </div>
              </div>

              {/* Expanded allocation panel */}
              {isExpanded && (
                <div style={{padding:"16px 20px 20px 20px", background:T.blueL,
                  borderBottom:i<apprentices.length-1?`1px solid ${T.border}44`:"none"}}>
                  <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:20}}>

                    {/* Approvers column */}
                    <div>
                      <div style={{fontSize:12,fontWeight:700,color:T.warn,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                        <span>▲</span> Approvers
                        <span style={{fontSize:11,fontWeight:400,color:T.sub}}>— can approve / decline this apprentice's timesheets</span>
                      </div>
                      {approvers.length===0
                        ? <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>No Approver accounts exist yet.</div>
                        : approvers.map(ap=>{
                            const isAllocd = (ap.allocatedTo||[]).includes(u.id);
                            return (
                              <button key={ap.id} onClick={()=>toggleAlloc(ap.id, u.id)} style={{
                                display:"flex",alignItems:"center",gap:10,width:"100%",
                                padding:"9px 12px",marginBottom:6,borderRadius:8,textAlign:"left",
                                background:isAllocd?T.warnL:T.surface,
                                border:`1.5px solid ${isAllocd?T.warn:T.border}`,
                                cursor:"pointer",transition:"all .14s"}}>
                                <div style={{width:20,height:20,borderRadius:5,
                                  background:isAllocd?T.warn:"transparent",
                                  border:`2px solid ${isAllocd?T.warn:T.muted}`,
                                  display:"flex",alignItems:"center",justifyContent:"center",
                                  fontSize:11,color:"#fff",flexShrink:0}}>
                                  {isAllocd?"✓":""}
                                </div>
                                <div>
                                  <div style={{fontSize:13,fontWeight:600,color:T.ink}}>{ap.name}</div>
                                  <div style={{fontSize:11,color:T.sub}}>{ap.email}</div>
                                </div>
                              </button>
                            );
                          })
                      }
                    </div>

                    {/* Viewers column */}
                    <div>
                      <div style={{fontSize:12,fontWeight:700,color:T.teal,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                        <span>◆</span> Viewers
                        <span style={{fontSize:11,fontWeight:400,color:T.sub}}>— can view all timesheet stages, read only</span>
                      </div>
                      {viewers.length===0
                        ? <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>No Viewer accounts exist yet.</div>
                        : viewers.map(vw=>{
                            const isAllocd = (vw.allocatedTo||[]).includes(u.id);
                            return (
                              <button key={vw.id} onClick={()=>toggleAlloc(vw.id, u.id)} style={{
                                display:"flex",alignItems:"center",gap:10,width:"100%",
                                padding:"9px 12px",marginBottom:6,borderRadius:8,textAlign:"left",
                                background:isAllocd?T.tealL:T.surface,
                                border:`1.5px solid ${isAllocd?T.teal:T.border}`,
                                cursor:"pointer",transition:"all .14s"}}>
                                <div style={{width:20,height:20,borderRadius:5,
                                  background:isAllocd?T.teal:"transparent",
                                  border:`2px solid ${isAllocd?T.teal:T.muted}`,
                                  display:"flex",alignItems:"center",justifyContent:"center",
                                  fontSize:11,color:"#fff",flexShrink:0}}>
                                  {isAllocd?"✓":""}
                                </div>
                                <div>
                                  <div style={{fontSize:13,fontWeight:600,color:T.ink}}>{vw.name}</div>
                                  <div style={{fontSize:11,color:T.sub}}>{vw.email}</div>
                                </div>
                              </button>
                            );
                          })
                      }
                    </div>

                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS LIST  (business/other contacts, not system users)
// ─────────────────────────────────────────────────────────────────────────────
function ContactsList() {
  const [items, setItems] = useState([]);
  const [dashLoading_dash_contacts, setDashLoading_dash_contacts] = useState(true);
  useEffect(()=>{
    loadTable('dash_contacts').then(rows=>{
      setItems(rows);
      setDashLoading_dash_contacts(false);
    }).catch(e=>{console.error('dash_contacts load',e);setDashLoading_dash_contacts(false);});
  },[]);
  const blank = {name:"",company:"",email:"",phone:"",type:"General",notes:""};
  const CTYPES = ["General","Government","Industry","Training","Other"];
  const CTYPE_C = {General:T.slate,Government:T.blue,Industry:T.teal,Training:T.hol,Other:T.muted};
  const [form, setForm] = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const sf = (k,v)=>setForm(f=>({...f,[k]:v}));

  const submit = () => {
    if(!form.name.trim()) return;
    const row = editId ? {id:editId,...form} : {id:uid(),...form};
    if(editId){ setItems(prev=>prev.map(x=>x.id===editId?row:x)); setEditId(null); }
    else setItems(prev=>[row,...prev]);
    upsertRow('dash_contacts',row).catch(console.error);
    setForm(blank); setShowForm(false);
  };
  const startEdit = (x)=>{setForm({name:x.name,company:x.company||"",email:x.email||"",phone:x.phone||"",type:x.type||"General",notes:x.notes||""});setEditId(x.id);setShowForm(true);};
  const del = (id)=>{ if(window.confirm("Remove this contact?")){ setItems(prev=>prev.filter(x=>x.id!==id)); deleteRow('dash_contacts',id).catch(console.error); } };

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>Contacts</div>
          <div style={{fontSize:12,color:T.sub,marginTop:3}}>Business and other contacts — not system users.</div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setShowForm(s=>!s);}}>
          {showForm?"✕ Cancel":"+ Add Contact"}
        </Btn>
      </div>
      {showForm&&(
        <Card style={{marginBottom:20,border:`1.5px solid ${T.slate}44`}}>
          <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:T.slate}}>{editId?"✎ Edit Contact":"+ New Contact"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Name</FL><input placeholder="Jane Smith" value={form.name} onChange={e=>sf("name",e.target.value)}/></div>
            <div><FL>Organisation</FL><input placeholder="Company / Agency" value={form.company} onChange={e=>sf("company",e.target.value)}/></div>
            <div><FL>Type</FL>
              <select value={form.type} onChange={e=>sf("type",e.target.value)}>
                {CTYPES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div><FL>Email</FL><input type="email" placeholder="jane@org.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+61…" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Save Contact"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancel</Btn>
          </div>
        </Card>
      )}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 160px 100px 160px 160px 68px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <span>Name</span><span>Organisation</span><span>Type</span><span>Email</span><span>Phone</span><span/>
        </div>
        {items.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No contacts yet.</div>}
        {[...items].sort((a,b)=>a.name.localeCompare(b.name)).map((x,i)=>(
          <div key={x.id} className="ri" style={{display:"grid",gridTemplateColumns:"1fr 160px 100px 160px 160px 68px",
            padding:"12px 16px",borderBottom:i<items.length-1?`1px solid ${T.border}44`:"none",
            background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
            <div>
              <div style={{fontWeight:700,fontSize:13}}>{x.name}</div>
              {x.notes&&<div style={{fontSize:11,color:T.muted,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.notes}</div>}
            </div>
            <div style={{fontSize:12,color:T.sub}}>{x.company||"—"}</div>
            <Pill label={x.type||"General"} size="sm" color={CTYPE_C[x.type]||T.slate} bg={(CTYPE_C[x.type]||T.slate)+"1a"}/>
            <div style={{fontSize:12,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.email||"—"}</div>
            <div style={{fontSize:12,color:T.sub}}>{x.phone||"—"}</div>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
              <button onClick={()=>startEdit(x)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
              <button onClick={()=>del(x.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HOST BUSINESS LIST  (companies that host apprentices)
// ─────────────────────────────────────────────────────────────────────────────
function HostBusinessList() {
  const [items, setItems] = useState([]);
  const [dashLoading_dash_hosts, setDashLoading_dash_hosts] = useState(true);
  useEffect(()=>{
    loadTable('dash_hosts').then(rows=>{
      setItems(rows);
      setDashLoading_dash_hosts(false);
    }).catch(e=>{console.error('dash_hosts load',e);setDashLoading_dash_hosts(false);});
  },[]);
  const blank = {name:"",industry:"",contact:"",phone:"",email:"",capacity:"",status:"Active",notes:""};
  const INDUSTRIES = ["Construction","Electrical","Plumbing","Carpentry","HVAC","Civil","Other"];
  const [form, setForm] = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const sf = (k,v)=>setForm(f=>({...f,[k]:v}));

  const submit = () => {
    if(!form.name.trim()) return;
    const row = editId ? {id:editId,...form} : {id:uid(),...form};
    if(editId){ setItems(prev=>prev.map(x=>x.id===editId?row:x)); setEditId(null); }
    else setItems(prev=>[row,...prev]);
    upsertRow('dash_hosts',{...row,capacity:parseInt(row.capacity)||0}).catch(console.error);
    setForm(blank); setShowForm(false);
  };
  const startEdit = (x)=>{setForm({name:x.name,industry:x.industry||"",contact:x.contact||"",phone:x.phone||"",email:x.email||"",capacity:x.capacity||"",status:x.status||"Active",notes:x.notes||""});setEditId(x.id);setShowForm(true);};
  const del = (id)=>{ if(window.confirm("Remove this host business?")){ setItems(prev=>prev.filter(x=>x.id!==id)); deleteRow('dash_hosts',id).catch(console.error); } };

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>Host Businesses</div>
          <div style={{fontSize:12,color:T.sub,marginTop:3}}>Companies that host apprentices for on-the-job training.</div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setShowForm(s=>!s);}}>
          {showForm?"✕ Cancel":"+ Add Host Business"}
        </Btn>
      </div>
      {showForm&&(
        <Card style={{marginBottom:20,border:`1.5px solid ${T.teal}44`}}>
          <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:T.teal}}>{editId?"✎ Edit Host Business":"+ New Host Business"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Business Name</FL><input placeholder="Acme Constructions" value={form.name} onChange={e=>sf("name",e.target.value)}/></div>
            <div><FL>Industry</FL>
              <select value={form.industry} onChange={e=>sf("industry",e.target.value)}>
                <option value="">Select…</option>
                {INDUSTRIES.map(i=><option key={i}>{i}</option>)}
              </select>
            </div>
            <div><FL>Status</FL>
              <select value={form.status} onChange={e=>sf("status",e.target.value)}>
                {["Active","Inactive","Pending"].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div><FL>Primary Contact</FL><input placeholder="Name" value={form.contact} onChange={e=>sf("contact",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+61…" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
            <div><FL>Email</FL><input type="email" placeholder="contact@biz.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Apprentice Capacity</FL><input type="number" min="0" placeholder="0" value={form.capacity} onChange={e=>sf("capacity",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Save Host Business"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancel</Btn>
          </div>
        </Card>
      )}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 120px 140px 140px 60px 80px 68px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <span>Business</span><span>Industry</span><span>Contact</span><span>Email</span><span style={{textAlign:"center"}}>Cap.</span><span>Status</span><span/>
        </div>
        {items.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No host businesses yet.</div>}
        {[...items].sort((a,b)=>a.name.localeCompare(b.name)).map((x,i)=>(
          <div key={x.id} className="ri" style={{display:"grid",gridTemplateColumns:"1fr 120px 140px 140px 60px 80px 68px",
            padding:"12px 16px",borderBottom:i<items.length-1?`1px solid ${T.border}44`:"none",
            background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
            <div>
              <div style={{fontWeight:700,fontSize:13}}>{x.name}</div>
              {x.notes&&<div style={{fontSize:11,color:T.muted,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.notes}</div>}
            </div>
            <div style={{fontSize:12,color:T.sub}}>{x.industry||"—"}</div>
            <div style={{fontSize:12,color:T.sub}}>{x.contact||"—"}</div>
            <div style={{fontSize:12,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.email||"—"}</div>
            <div style={{textAlign:"center",fontSize:13,fontWeight:700,color:T.teal}}>{x.capacity||"—"}</div>
            <Pill label={x.status||"Active"} size="sm"
              color={x.status==="Active"?T.accent:x.status==="Pending"?T.warn:T.muted}
              bg={x.status==="Active"?T.accentL:x.status==="Pending"?T.warnL:T.slateL}/>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
              <button onClick={()=>startEdit(x)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
              <button onClick={()=>del(x.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TARGET DEALS LIST  (deals / opportunities being pursued)
// ─────────────────────────────────────────────────────────────────────────────
function TargetDealsList() {
  const DEAL_STAGES = ["Prospecting","Outreach","Meeting","Proposal","Negotiation","Won","Lost"];
  const DEAL_C = {Prospecting:T.muted,Outreach:T.blue,Meeting:T.hol,Proposal:T.warn,Negotiation:T.gold,Won:T.accent,Lost:T.red};
  const [items, setItems] = useState([]);
  const [dashLoading_dash_deals, setDashLoading_dash_deals] = useState(true);
  useEffect(()=>{
    loadTable('dash_deals').then(rows=>{
      setItems(rows);
      setDashLoading_dash_deals(false);
    }).catch(e=>{console.error('dash_deals load',e);setDashLoading_dash_deals(false);});
  },[]);
  const blank = {title:"",contact:"",org:"",value:"",stage:"Prospecting",dueDate:"",priority:"Medium",notes:""};
  const [form, setForm] = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const sf = (k,v)=>setForm(f=>({...f,[k]:v}));

  const submit = () => {
    if(!form.title.trim()) return;
    const row = editId ? {id:editId,...form} : {id:uid(),...form};
    if(editId){ setItems(prev=>prev.map(x=>x.id===editId?row:x)); setEditId(null); }
    else setItems(prev=>[row,...prev]);
    upsertRow('dash_deals',{id:row.id,title:row.title,contact:row.contact||"",org:row.org||"",value:row.value||"",stage:row.stage||"Prospecting",due_date:row.dueDate||null,priority:row.priority||"Medium",notes:row.notes||""}).catch(console.error);
    setForm(blank); setShowForm(false);
  };
  const startEdit = (x)=>{setForm({title:x.title,contact:x.contact||"",org:x.org||"",value:x.value||"",stage:x.stage||"Prospecting",dueDate:x.due_date||x.dueDate||"",priority:x.priority||"Medium",notes:x.notes||""});setEditId(x.id);setShowForm(true);};
  const del = (id)=>{ if(window.confirm("Remove this deal?")){ setItems(prev=>prev.filter(x=>x.id!==id)); deleteRow('dash_deals',id).catch(console.error); } };
  const move = (id,stage)=>{ setItems(prev=>prev.map(x=>x.id===id?{...x,stage}:x)); upsertRow('dash_deals',{id,stage}).catch(console.error); };

  const totalValue = items.filter(x=>!["Won","Lost"].includes(x.stage)).reduce((a,x)=>a+(parseFloat(x.value)||0),0);
  const PRIORITY_C = {High:T.red,Medium:T.warn,Low:T.muted};

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>Target Deals</div>
          <div style={{fontSize:12,color:T.sub,marginTop:3}}>{items.filter(x=>!["Won","Lost"].includes(x.stage)).length} active deals · pipeline value <strong style={{color:T.accent}}>${totalValue.toLocaleString()}</strong></div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setShowForm(s=>!s);}}>
          {showForm?"✕ Cancel":"+ Add Deal"}
        </Btn>
      </div>
      {showForm&&(
        <Card style={{marginBottom:20,border:`1.5px solid ${T.gold}44`}}>
          <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:T.gold}}>{editId?"✎ Edit Deal":"+ New Deal"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Deal Title</FL><input placeholder="e.g. Funding Round 2025" value={form.title} onChange={e=>sf("title",e.target.value)}/></div>
            <div><FL>Contact Person</FL><input placeholder="Name" value={form.contact} onChange={e=>sf("contact",e.target.value)}/></div>
            <div><FL>Organisation</FL><input placeholder="Company / Agency" value={form.org} onChange={e=>sf("org",e.target.value)}/></div>
            <div><FL>Value ($)</FL><input type="number" placeholder="0" value={form.value} onChange={e=>sf("value",e.target.value)}/></div>
            <div><FL>Stage</FL>
              <select value={form.stage} onChange={e=>sf("stage",e.target.value)}>
                {DEAL_STAGES.map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div><FL>Priority</FL>
              <select value={form.priority} onChange={e=>sf("priority",e.target.value)}>
                {["High","Medium","Low"].map(p=><option key={p}>{p}</option>)}
              </select>
            </div>
            <div><FL>Due Date</FL><input type="date" value={form.dueDate} onChange={e=>sf("dueDate",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Save Deal"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancel</Btn>
          </div>
        </Card>
      )}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"8px 1fr 130px 130px 90px 80px 80px 68px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <span/><span>Deal</span><span>Organisation</span><span>Contact</span><span style={{textAlign:"right"}}>Value</span><span>Stage</span><span>Priority</span><span/>
        </div>
        {items.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No deals yet.</div>}
        {[...items].sort((a,b)=>{
          const order=["Proposal","Negotiation","Meeting","Outreach","Prospecting","Won","Lost"];
          return (order.indexOf(a.stage)||99)-(order.indexOf(b.stage)||99);
        }).map((x,i,arr)=>(
          <div key={x.id} className="ri" style={{display:"grid",gridTemplateColumns:"8px 1fr 130px 130px 90px 80px 80px 68px",
            padding:"12px 16px",borderBottom:i<arr.length-1?`1px solid ${T.border}44`:"none",
            background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
            <div style={{width:8,height:36,borderRadius:3,background:DEAL_C[x.stage]||T.muted}}/>
            <div>
              <div style={{fontWeight:700,fontSize:13}}>{x.title}</div>
              {x.notes&&<div style={{fontSize:11,color:T.muted,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.notes}</div>}
            </div>
            <div style={{fontSize:12,color:T.sub}}>{x.org||"—"}</div>
            <div style={{fontSize:12,color:T.sub}}>{x.contact||"—"}</div>
            <div style={{textAlign:"right",fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:14,color:DEAL_C[x.stage]||T.muted}}>
              {x.value?`$${parseFloat(x.value).toLocaleString()}`:"—"}
            </div>
            <Pill label={x.stage} size="sm" color={DEAL_C[x.stage]||T.muted} bg={(DEAL_C[x.stage]||T.muted)+"1a"}/>
            <Pill label={x.priority||"Medium"} size="sm" color={PRIORITY_C[x.priority||"Medium"]} bg={PRIORITY_C[x.priority||"Medium"]+"1a"}/>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
              <button onClick={()=>startEdit(x)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
              <button onClick={()=>del(x.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAGGABLE CARD ORDER — persists per user in localStorage
// ─────────────────────────────────────────────────────────────────────────────
function useDraggableOrder(userId, defaultOrder) {
  const key = `kta_card_order_${userId}`;
  const [order, setOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      // Merge saved with defaults to handle new cards added later
      if(saved && Array.isArray(saved)) {
        const merged = [...saved.filter(id => defaultOrder.includes(id)),
          ...defaultOrder.filter(id => !saved.includes(id))];
        return merged;
      }
    } catch {}
    return defaultOrder;
  });
  const dragging = useRef(null);
  const dragOver = useRef(null);

  const save = (newOrder) => {
    setOrder(newOrder);
    try { localStorage.setItem(key, JSON.stringify(newOrder)); } catch {}
  };

  const onDragStart = (id) => { dragging.current = id; };
  const onDragEnter = (id) => { dragOver.current = id; };
  const onDragEnd   = () => {
    if(!dragging.current || !dragOver.current || dragging.current === dragOver.current) return;
    const next = [...order];
    const from = next.indexOf(dragging.current);
    const to   = next.indexOf(dragOver.current);
    next.splice(from, 1);
    next.splice(to, 0, dragging.current);
    save(next);
    dragging.current = null;
    dragOver.current = null;
  };

  const dragProps = (id) => ({
    draggable: true,
    onDragStart: () => onDragStart(id),
    onDragEnter: () => onDragEnter(id),
    onDragEnd,
    onDragOver: (e) => e.preventDefault(),
  });

  return { order, dragProps };
}

// Wrapper for a draggable dashboard section
function DraggableSection({ id, dragProps, children, style = {} }) {
  const [isDragOver, setIsDragOver] = useState(false);
  const props = dragProps(id);
  return (
    <div
      {...props}
      onDragEnter={(e) => { props.onDragEnter(e); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={() => setIsDragOver(false)}
      style={{
        marginBottom: 20,
        borderRadius: 14,
        transition: "all .18s",
        outline: isDragOver ? `2px dashed ${T.accent}` : "2px dashed transparent",
        outlineOffset: 4,
        opacity: 1,
        cursor: "grab",
        ...style,
      }}
    >
      {/* Drag handle */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        marginBottom: 6, paddingLeft: 2, userSelect: "none",
      }}>
        <div style={{
          display: "flex", flexDirection: "column", gap: 3,
          cursor: "grab", padding: "2px 4px", borderRadius: 4,
          opacity: 0.3,
        }}
          title="Drag to reorder"
        >
          {[0,1].map(i=>(
            <div key={i} style={{display:"flex",gap:3}}>
              {[0,1,2].map(j=>(
                <div key={j} style={{width:3,height:3,borderRadius:"50%",background:T.ink}}/>
              ))}
            </div>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}

function AdminDashboard({allUsers, entries, onViewApprentice, onViewApprenticeList, onViewList, onViewTimesheets, onViewLeave, currentUser}) {
  const apprentices = allUsers.filter(u=>u.role==="Apprentice");
  const wsStart = ()=>{ const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };
  const ws = wsStart();

  // Global stats
  const totalSubmitted    = entries.filter(e=>e.approval==="submitted").length;
  const totalApproved     = entries.filter(e=>e.approval==="approved").length;
  const totalNotApproved  = entries.filter(e=>e.approval==="declined").length;
  const totalHrsWeek      = entries.filter(e=>e.date>=ws).reduce((a,e)=>a+e.netHours,0).toFixed(1);

  // Section order (top-level)
  const DEFAULT_ORDER = ["stats", "crm"];
  const { order, dragProps } = useDraggableOrder(currentUser?.id || "admin", DEFAULT_ORDER);

  // Card order within Stats section
  const STATS_DEFAULT = ["apprentices","hours","submitted","approved","declined","timesheets","leave"];
  const { order: statsOrder, dragProps: statsDrag } = useDraggableOrder((currentUser?.id||"admin") + "_stats", STATS_DEFAULT);

  // Card order within CRM section
  const CRM_DEFAULT = ["contacts","hosts","deals"];
  const { order: crmOrder, dragProps: crmDrag } = useDraggableOrder((currentUser?.id||"admin") + "_crm", CRM_DEFAULT);

  // Timesheet summary for stat card
  const pendingCount  = entries.filter(e=>e.approval==="submitted").length;
  const activeApps    = apprentices.filter(a=>entries.some(e=>e.userId===a.id)).length;
  const [leaveStats, setLeaveStats] = useState({total:0, pending:0, approver_approved:0, kta_approved:0, declined:0});
  useEffect(()=>{
    loadTable("leave_requests").then(rows=>{
      const r = rows||[];
      setLeaveStats({
        total:             r.length,
        pending:           r.filter(x=>x.status==="pending").length,
        approver_approved: r.filter(x=>x.status==="approver_approved").length,
        kta_approved:      r.filter(x=>x.status==="kta_approved").length,
        declined:          r.filter(x=>x.status==="declined").length,
      });
    }).catch(()=>{});
  },[]);

  const statsData = {
    apprentices: (
      <button onClick={onViewApprenticeList} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
        onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
        <Card style={{paddingBlock:18,border:`1.5px solid ${T.blue}44`,height:"100%"}}>
          <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Apprentices</div>
          <div style={{fontSize:24,fontWeight:700,color:T.blue,fontFamily:"'Libre Baskerville'"}}>{apprentices.length}</div>
          <div style={{fontSize:11,color:T.sub,marginTop:2}}>active workforce</div>
          <div style={{fontSize:11,color:T.blue,marginTop:6,fontWeight:600}}>View & manage →</div>
        </Card>
      </button>
    ),
    hours:     <button onClick={()=>onViewList("hours")}     style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}} onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}><Card style={{paddingBlock:18,border:`1.5px solid ${T.accent}44`,height:"100%"}}><div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Hours This Week</div><div style={{fontSize:24,fontWeight:700,color:T.accent,fontFamily:"'Libre Baskerville'"}}>{totalHrsWeek}h</div><div style={{fontSize:11,color:T.sub,marginTop:2}}>all apprentices</div><div style={{fontSize:11,color:T.accent,marginTop:6,fontWeight:600}}>View list →</div></Card></button>,
    submitted: <button onClick={()=>onViewList("submitted")} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}} onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}><Card style={{paddingBlock:18,border:`1.5px solid ${totalSubmitted>0?T.warn:T.muted}44`,height:"100%"}}><div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Pending</div><div style={{fontSize:24,fontWeight:700,color:totalSubmitted>0?T.warn:T.muted,fontFamily:"'Libre Baskerville'"}}>{totalSubmitted}</div><div style={{fontSize:11,color:T.sub,marginTop:2}}>submitted, awaiting review</div><div style={{fontSize:11,color:totalSubmitted>0?T.warn:T.muted,marginTop:6,fontWeight:600}}>View list →</div></Card></button>,
    approved:  <button onClick={()=>onViewList("approved")}  style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}} onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}><Card style={{paddingBlock:18,border:`1.5px solid ${T.teal}44`,height:"100%"}}><div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Submitted — Approved</div><div style={{fontSize:24,fontWeight:700,color:T.teal,fontFamily:"'Libre Baskerville'"}}>{totalApproved}</div><div style={{fontSize:11,color:T.sub,marginTop:2}}>approved by approver</div><div style={{fontSize:11,color:T.teal,marginTop:6,fontWeight:600}}>View list →</div></Card></button>,
    declined:  <button onClick={()=>onViewList("declined")}  style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}} onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}><Card style={{paddingBlock:18,border:`1.5px solid ${totalNotApproved>0?T.red:T.muted}44`,height:"100%"}}><div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Submitted — Not Approved</div><div style={{fontSize:24,fontWeight:700,color:totalNotApproved>0?T.red:T.muted,fontFamily:"'Libre Baskerville'"}}>{totalNotApproved}</div><div style={{fontSize:11,color:T.sub,marginTop:2}}>declined by approver</div><div style={{fontSize:11,color:totalNotApproved>0?T.red:T.muted,marginTop:6,fontWeight:600}}>View list →</div></Card></button>,
    timesheets: (
      <button onClick={onViewTimesheets} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
        onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
        <Card style={{paddingBlock:18,border:`1.5px solid ${T.teal}44`,height:"100%"}}>
          <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Timesheets</div>
          <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:2}}>
            <div style={{fontSize:24,fontWeight:700,color:T.teal,fontFamily:"'Libre Baskerville'"}}>{activeApps}</div>
            <div style={{fontSize:11,color:T.muted}}>/ {apprentices.length}</div>
          </div>
          <div style={{fontSize:11,color:T.sub,marginTop:2}}>apprentices with entries</div>
          {pendingCount>0
            ? <div style={{fontSize:11,color:T.warn,marginTop:6,fontWeight:600}}>⚠ {pendingCount} pending review</div>
            : <div style={{fontSize:11,color:T.teal,marginTop:6,fontWeight:600}}>View timesheets →</div>
          }
        </Card>
      </button>
    ),
    leave: (
      <button onClick={onViewLeave} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
        onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
        <Card style={{paddingBlock:18,border:`1.5px solid ${leaveStats.pending>0||leaveStats.approver_approved>0?T.warn:T.hol}44`,height:"100%"}}>
          <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Leave Requests</div>
          <div style={{fontSize:24,fontWeight:700,color:leaveStats.pending>0||leaveStats.approver_approved>0?T.warn:T.hol,fontFamily:"'Libre Baskerville'",marginBottom:4}}>{leaveStats.total}</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}}>
            {leaveStats.pending>0           && <span style={{fontSize:10,fontWeight:700,color:"#b86e1a",background:"#faebd7",borderRadius:99,padding:"2px 7px"}}>{leaveStats.pending} approver</span>}
            {leaveStats.approver_approved>0 && <span style={{fontSize:10,fontWeight:700,color:"#1b4f8c",background:"#dce8f7",borderRadius:99,padding:"2px 7px"}}>{leaveStats.approver_approved} KTA</span>}
            {leaveStats.kta_approved>0      && <span style={{fontSize:10,fontWeight:700,color:"#1a6b3a",background:"#d4f0e0",borderRadius:99,padding:"2px 7px"}}>{leaveStats.kta_approved} approved</span>}
            {leaveStats.declined>0          && <span style={{fontSize:10,fontWeight:700,color:"#bf2b2b",background:"#fde8e8",borderRadius:99,padding:"2px 7px"}}>{leaveStats.declined} declined</span>}
            {leaveStats.total===0           && <span style={{fontSize:11,color:T.muted}}>no requests</span>}
          </div>
          <div style={{fontSize:11,color:T.hol,marginTop:6,fontWeight:600}}>View & manage →</div>
        </Card>
      </button>
    ),
  };

  const crmData = {
    contacts: {label:"Contacts",        sub:"business & other contacts",    color:T.slate, icon:"◉"},
    hosts:    {label:"Host Businesses",  sub:"companies hosting apprentices", color:T.teal,  icon:"◆"},
    deals:    {label:"Target Deals",     sub:"opportunities & pipeline",      color:T.gold,  icon:"◈"},
  };

  const sections = {
    stats: (
      <DraggableSection id="stats" dragProps={dragProps}>
        <div className="stat-grid-4">
          {statsOrder.map(id => (
            <div key={id} {...statsDrag(id)} style={{borderRadius:14, cursor:"grab"}}>
              {statsData[id]}
            </div>
          ))}
        </div>
      </DraggableSection>
    ),
    crm: (
      <DraggableSection id="crm" dragProps={dragProps}>
        <div className="stat-grid-3">
          {crmOrder.map(id => {
            const {label,sub,color,icon} = crmData[id];
            return (
              <div key={id} {...crmDrag(id)} style={{borderRadius:14, cursor:"grab"}}>
                <button onClick={()=>onViewList(id)} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
                  onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                  <Card style={{paddingBlock:18,border:`1.5px solid ${color}44`}}>
                    <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>{label}</div>
                    <div style={{fontSize:28,marginBottom:4,color}}>{icon}</div>
                    <div style={{fontSize:11,color:T.sub}}>{sub}</div>
                    <div style={{fontSize:11,color,marginTop:6,fontWeight:600}}>View & manage →</div>
                  </Card>
                </button>
              </div>
            );
          })}
        </div>
      </DraggableSection>
    ),
  };

  return (
    <div className="fu">
      {order.map(id => sections[id] || null)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION BELL
// ─────────────────────────────────────────────────────────────────────────────
function NotificationBell({notifs, onRead, onReadAll, onDelete, canDelete=true, show, setShow, onReply}) {
  const unread = notifs.filter(n=>!n.read).length;
  const typeIcon = t => t==="licence_expiry"?"⚠":t==="approval"?"✓":t==="decline"?"✕":t==="broadcast"?"📢":t==="reply"?"↩":"◈";
  const typeColor = t => t==="licence_expiry"?T.warn:t==="approval"?T.accent:t==="decline"?T.red:t==="broadcast"?T.blue:t==="reply"?T.teal:T.sub;
  const [replyId, setReplyId] = useState(null);
  const [replyText, setReplyText] = useState("");

  const handleReply = (n) => {
    if(!replyText.trim()) return;
    onReply(n, replyText.trim());
    setReplyText("");
    setReplyId(null);
  };

  return (
    <div style={{position:"relative"}}>
      <button onClick={()=>setShow(s=>!s)} style={{
        position:"relative",background:"none",border:"none",cursor:"pointer",
        color:"#ffffff99",fontSize:20,padding:"4px 8px",borderRadius:8,
        transition:"color .15s"}}
        onMouseEnter={e=>e.currentTarget.style.color="#fff"}
        onMouseLeave={e=>e.currentTarget.style.color="#ffffff99"}>
        🔔
        {unread>0&&(
          <span style={{position:"absolute",top:0,right:2,background:T.red,color:"#fff",
            borderRadius:99,fontSize:10,fontWeight:700,padding:"1px 5px",lineHeight:"14px",
            minWidth:16,textAlign:"center"}}>
            {unread>9?"9+":unread}
          </span>
        )}
      </button>
      {show&&(
        <div className="notif-dropdown" style={{position:"absolute",top:"calc(100% + 8px)",right:0,width:380,
          background:T.surface,borderRadius:12,boxShadow:"0 8px 32px #00000033",
          border:`1px solid ${T.border}`,zIndex:200,overflow:"hidden"}}>
          {/* Header */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
            padding:"12px 16px",borderBottom:`1px solid ${T.border}`,background:T.bg}}>
            <div style={{fontWeight:700,fontSize:13}}>Notifications {unread>0&&<span style={{color:T.red}}>({unread})</span>}</div>
            {unread>0&&(
              <button onClick={onReadAll} style={{fontSize:11,color:T.blue,background:"none",
                border:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontWeight:600}}>
                Mark all read
              </button>
            )}
          </div>
          {/* List */}
          <div style={{maxHeight:"min(460px, 70vh)",overflowY:"auto"}}>
            {notifs.length===0&&(
              <div style={{padding:24,textAlign:"center",color:T.muted,fontSize:13}}>No notifications</div>
            )}
            {notifs.map(n=>(
              <div key={n.id} style={{borderBottom:`1px solid ${T.border}44`,
                background:n.read?T.surface:T.blueL+"55"}}>
                <div style={{padding:"12px 16px",display:"flex",gap:10,alignItems:"flex-start",cursor:"pointer"}}
                  onClick={()=>{ if(!n.read) onRead(n.id); }}>
                  <span style={{fontSize:16,marginTop:2,color:typeColor(n.type),flexShrink:0}}>{typeIcon(n.type)}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div className="notif-title" style={{fontWeight:n.read?500:700,fontSize:13,color:typeColor(n.type),
                      wordBreak:"break-word",lineHeight:1.35}}>{n.title}</div>
                    <div className="notif-msg" style={{fontSize:12,color:T.sub,marginTop:3,lineHeight:1.5,
                      wordBreak:"break-word",whiteSpace:"pre-wrap"}}>{n.message}</div>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:6,flexWrap:"wrap",gap:4}}>
                      <div style={{fontSize:10,color:T.muted}}>
                        {n.created_at ? new Date(n.created_at).toLocaleString("en-AU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "Just now"}
                      </div>
                      {n.created_by&&n.type!=="reply"&&(
                        <button onClick={e=>{e.stopPropagation();setReplyId(replyId===n.id?null:n.id);setReplyText("");}}
                          style={{fontSize:11,color:T.teal,background:replyId===n.id?T.tealL:"none",border:"none",cursor:"pointer",
                            fontFamily:"DM Sans,sans-serif",fontWeight:600,padding:"2px 6px",borderRadius:4}}>
                          ↩ Reply
                        </button>
                      )}
                    </div>
                  </div>
                  {canDelete&&(
                    <button onClick={e=>{e.stopPropagation();onDelete(n.id);setReplyId(null);}} style={{
                      background:"none",border:"none",color:T.muted,cursor:"pointer",
                      fontSize:14,padding:"0 2px",flexShrink:0,marginLeft:2}}
                      onMouseEnter={e=>e.currentTarget.style.color=T.red}
                      onMouseLeave={e=>e.currentTarget.style.color=T.muted}>✕</button>
                  )}
                </div>
                {replyId===n.id&&(
                  <div style={{padding:"0 12px 12px 12px"}}>
                    <textarea
                      placeholder="Write a reply…"
                      value={replyText}
                      onChange={e=>setReplyText(e.target.value)}
                      rows={2}
                      style={{width:"100%",fontSize:13,padding:"8px 10px",borderRadius:7,
                        border:`1.5px solid ${T.teal}66`,fontFamily:"DM Sans,sans-serif",
                        background:T.bg,resize:"none",outline:"none",color:T.ink,boxSizing:"border-box"}}
                      onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleReply(n);}}}
                      autoFocus
                    />
                    <div style={{display:"flex",gap:6,marginTop:6}}>
                      <button onClick={()=>handleReply(n)} disabled={!replyText.trim()} style={{
                        fontSize:12,fontWeight:600,padding:"6px 14px",borderRadius:6,
                        background:replyText.trim()?T.teal:"#ccc",color:"#fff",border:"none",
                        cursor:replyText.trim()?"pointer":"default",fontFamily:"DM Sans,sans-serif"}}>
                        Send Reply
                      </button>
                      <button onClick={()=>setReplyId(null)} style={{
                        fontSize:12,padding:"6px 10px",borderRadius:6,background:"none",
                        border:`1px solid ${T.border}`,color:T.sub,cursor:"pointer",
                        fontFamily:"DM Sans,sans-serif"}}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE REQUESTS
// ─────────────────────────────────────────────────────────────────────────────

const LEAVE_TYPES = ["Annual Leave","Sick Leave","Leave Without Pay","Bereavement Leave","Other"];

const LEAVE_STATUS_META = {
  pending:           { label:"Pending Approver Review",    color:"#b86e1a", bg:"#faebd7", sym:"⏳", step:1, steps:3 },
  approver_approved: { label:"Approved — Awaiting KTA",   color:"#1a8a7a", bg:"#d4f0ec", sym:"✓", step:2, steps:3 },
  kta_approved:      { label:"Fully Approved by KTA",     color:"#1b4f8c", bg:"#dce8f7", sym:"★", step:3, steps:3 },
  declined:          { label:"Declined",                  color:"#bf2b2b", bg:"#fde8e8", sym:"✕", step:0, steps:3 },
};

// Progress stepper for leave requests — shown in all views
const LeaveStatusStepper = ({ status }) => {
  const steps = [
    { key:"pending",           label:"Submitted",       sym:"📤" },
    { key:"approver_approved", label:"Approver OK",     sym:"✓"  },
    { key:"kta_approved",      label:"KTA Approved",    sym:"★"  },
  ];
  const declined = status === "declined";
  const currentStep = status==="pending" ? 0 : status==="approver_approved" ? 1 : status==="kta_approved" ? 2 : -1;
  return (
    <div style={{display:"flex",alignItems:"center",gap:0,margin:"8px 0 4px"}}>
      {steps.map((s, i) => {
        const done    = !declined && currentStep >= i;
        const current = !declined && currentStep === i;
        const color   = done ? (i===2?"#1b4f8c":i===1?"#1a8a7a":"#b86e1a") : "#d0daea";
        const textCol = done ? "#fff" : "#aaa";
        return (
          <div key={s.key} style={{display:"flex",alignItems:"center",flex:1,minWidth:0}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",flex:1}}>
              <div style={{width:26,height:26,borderRadius:"50%",
                background: declined && i===0 ? "#fde8e8" : done ? color : "#f0f4f9",
                border:`2px solid ${declined&&i===0?"#bf2b2b":done?color:"#d0daea"}`,
                display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:11,fontWeight:700,color:declined&&i===0?"#bf2b2b":textCol,
                boxShadow:current?"0 0 0 3px "+color+"33":"none",
                transition:"all .2s",
              }}>
                {declined && i===0 ? "✕" : done ? (i===currentStep ? s.sym : "✓") : i+1}
              </div>
              <div style={{fontSize:9,color:done?color:"#aaa",marginTop:3,textAlign:"center",fontWeight:done?700:400,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:64}}>
                {declined && i===0 ? "Declined" : s.label}
              </div>
            </div>
            {i < steps.length-1 && (
              <div style={{height:2,flex:1,background:!declined&&currentStep>i?color:"#e5e7eb",margin:"0 2px",marginBottom:16,transition:"background .3s"}}/>
            )}
          </div>
        );
      })}
    </div>
  );
};

const sendLeaveEmail = async ({ to, toName, subject, html }) => {
  try {
    await sendKTAEmail({ to, subject, html });
  } catch(e) {
    console.error(`Leave email to ${to} failed:`, e);
  }
};

const leaveEmailHtml = (title, body) => `
<div style="font-family:DM Sans,sans-serif;max-width:600px;margin:0 auto;background:#f0f4f9;padding:24px">
  <div style="background:#1b4f8c;borderRadius:10px;padding:18px 24px;margin-bottom:0;border-radius:10px 10px 0 0">
    <div style="color:#fff;font-size:18px;font-weight:700">KTA Leave Request</div>
    <div style="color:#dce8f7;font-size:12px;margin-top:4px">Kiwi Trade Apprentices</div>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 10px 10px;border:1px solid #d0daea">
    <p style="font-size:15px;color:#0d1b2e;margin-top:0">${title}</p>
    ${body}
    <hr style="border:none;border-top:1px solid #d0daea;margin:20px 0">
    <p style="font-size:11px;color:#8fa0b8">KTA Workforce Management · timesheet@kta.org.nz</p>
  </div>
</div>`;

const leaveDetailTable = (req, apprenticeName, approverName) => `
<table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0">
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700;width:40%">Apprentice</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${apprenticeName}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">Leave Type</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${req.leave_type}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">From</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${fmtDateNZ(req.date_from)}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">To</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${fmtDateNZ(req.date_to)}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">Approver</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${approverName}</td></tr>
  ${req.notes ? `<tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">Notes</td><td style="padding:8px 12px">${req.notes}</td></tr>` : ""}
</table>`;

// Async — call with await, embed result in email HTML
const leaveActionButtons = async (leaveId, actorId, actorRole) => {
  const appUrl = await leaveActionUrl(leaveId, "approve", actorId, actorRole);
  const decUrl = await leaveActionUrl(leaveId, "decline", actorId, actorRole);
  return `
<div style="margin:24px 0;display:flex;gap:12px;flex-wrap:wrap">
  <a href="${appUrl}" style="display:inline-block;background:#1a8a7a;color:#fff;border-radius:8px;padding:12px 28px;font-size:14px;font-weight:700;text-decoration:none;font-family:DM Sans,Arial,sans-serif">✓ Approve Leave</a>
  <a href="${decUrl}" style="display:inline-block;background:#bf2b2b;color:#fff;border-radius:8px;padding:12px 28px;font-size:14px;font-weight:700;text-decoration:none;font-family:DM Sans,Arial,sans-serif">✕ Decline Leave</a>
</div>
<p style="font-size:11px;color:#8fa0b8;margin-top:4px">These buttons record your response immediately — no login required. Links expire in 7 days.</p>`;
};

const fmtDateNZ = (iso) => {
  if(!iso) return "—";
  const [y,m,d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

// ── Leave Application Form (Apprentice) ──────────────────────────────────────
function LeaveRequestForm({ currentUser, allUsers, onSubmitted }) {
  const approver = allUsers.find(u =>
    u.id === currentUser.approverUserId ||
    (u.role === "Approver" && (u.allocatedTo||[]).includes(currentUser.id))
  );
  const [form, setForm] = useState({
    dateFrom: "", dateTo: "", leaveType: "Annual Leave", notes: "",
  });
  const [saving, setSaving]   = useState(false);
  const [done, setDone]       = useState(false);
  const [error, setError]     = useState("");
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));

  const handleSubmit = async () => {
    if(!form.dateFrom || !form.dateTo) { setError("Please select start and end dates."); return; }
    if(form.dateTo < form.dateFrom)    { setError("End date must be after start date."); return; }
    setError(""); setSaving(true);
    const req = {
      id: uid(),
      apprentice_id:  currentUser.id,
      approver_id:    approver?.id || null,
      date_from:      form.dateFrom,
      date_to:        form.dateTo,
      leave_type:     form.leaveType,
      notes:          form.notes.trim(),
      status:         "pending",
      created_at:     new Date().toISOString(),
    };
    await upsertRow("leave_requests", req).catch(console.error);

    // Email to approver (with one-click approve/decline buttons)
    if(approver?.email) {
      const buttons = await leaveActionButtons(req.id, approver.id, "approver");
      await sendLeaveEmail({
        to: approver.email,
        subject: `Leave Request — ${currentUser.name} (${form.leaveType})`,
        html: leaveEmailHtml(
          `<strong>${currentUser.name}</strong> has submitted a leave request requiring your approval.`,
          leaveDetailTable(req, currentUser.name, approver.name) + buttons
        ),
      });
    }
    // Confirmation email to apprentice
    if(currentUser.email) {
      await sendLeaveEmail({
        to: currentUser.email,
        subject: `Leave Request Submitted — ${form.leaveType}`,
        html: leaveEmailHtml(
          `Your leave request has been submitted and is awaiting approval from <strong>${approver?.name || "your approver"}</strong>.`,
          leaveDetailTable(req, currentUser.name, approver?.name || "Not assigned")
        ),
      });
    }

    setSaving(false); setDone(true);
    setTimeout(() => onSubmitted(req), 1500);
  };

  if(done) return (
    <div style={{textAlign:"center",padding:"32px 16px"}}>
      <div style={{fontSize:36,marginBottom:12}}>✅</div>
      <div style={{fontWeight:700,fontSize:16,color:T.teal}}>Leave request submitted!</div>
      <div style={{fontSize:13,color:T.sub,marginTop:6}}>
        {approver?.email ? `An email has been sent to ${approver.name}.` : "No approver email found — please notify your approver directly."}
      </div>
    </div>
  );

  return (
    <div>
      {/* Read-only info */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
        <div style={{background:T.bg,borderRadius:8,padding:"10px 14px"}}>
          <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:3}}>Apprentice</div>
          <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{currentUser.name}</div>
        </div>
        <div style={{background:T.bg,borderRadius:8,padding:"10px 14px"}}>
          <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:3}}>Approver</div>
          <div style={{fontWeight:700,fontSize:14,color:approver?T.ink:T.warn}}>
            {approver ? approver.name : "⚠ No approver assigned"}
          </div>
        </div>
      </div>

      {/* Dates */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <div>
          <label style={{fontSize:12,fontWeight:600,color:T.sub,display:"block",marginBottom:5}}>Leave Starting *</label>
          <input type="date" value={form.dateFrom} onChange={e=>sf("dateFrom",e.target.value)}
            style={{width:"100%",border:`1.5px solid ${T.border}`,borderRadius:8,padding:"9px 12px",fontSize:13,fontFamily:"DM Sans,sans-serif",color:T.ink,outline:"none",boxSizing:"border-box"}}/>
        </div>
        <div>
          <label style={{fontSize:12,fontWeight:600,color:T.sub,display:"block",marginBottom:5}}>Leave Finishing *</label>
          <input type="date" value={form.dateTo} onChange={e=>sf("dateTo",e.target.value)}
            style={{width:"100%",border:`1.5px solid ${T.border}`,borderRadius:8,padding:"9px 12px",fontSize:13,fontFamily:"DM Sans,sans-serif",color:T.ink,outline:"none",boxSizing:"border-box"}}/>
        </div>
      </div>

      {/* Leave type */}
      <div style={{marginBottom:14}}>
        <label style={{fontSize:12,fontWeight:600,color:T.sub,display:"block",marginBottom:5}}>Type of Leave *</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
          {LEAVE_TYPES.map(t=>(
            <button key={t} onClick={()=>sf("leaveType",t)}
              style={{padding:"7px 14px",borderRadius:8,border:`1.5px solid ${form.leaveType===t?T.accent:T.border}`,
                background:form.leaveType===t?T.accentL:T.surface,
                color:form.leaveType===t?T.accent:T.ink,
                fontWeight:form.leaveType===t?700:400,
                fontSize:12,cursor:"pointer",fontFamily:"DM Sans,sans-serif",transition:"all .12s"}}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Notes */}
      <div style={{marginBottom:16}}>
        <label style={{fontSize:12,fontWeight:600,color:T.sub,display:"block",marginBottom:5}}>Additional Notes</label>
        <textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} rows={3}
          placeholder="Any additional details about your leave request…"
          style={{width:"100%",border:`1.5px solid ${T.border}`,borderRadius:8,padding:"9px 12px",fontSize:13,fontFamily:"DM Sans,sans-serif",color:T.ink,outline:"none",resize:"vertical",boxSizing:"border-box",lineHeight:1.6}}/>
      </div>

      {error && <div style={{background:T.redL,border:`1px solid ${T.red}33`,borderRadius:7,padding:"8px 12px",fontSize:12,color:T.red,marginBottom:12}}>{error}</div>}

      <div style={{display:"flex",gap:8}}>
        <Btn onClick={handleSubmit} disabled={saving}>{saving?"Submitting…":"📨 Submit Leave Request"}</Btn>
      </div>
    </div>
  );
}

// ── Leave Request Card (single) ───────────────────────────────────────────────
function LeaveRequestCard({ req: reqProp, allUsers, currentUser, isAdmin, isApprover, onUpdate, onDelete, entries=[], setEntries=null }) {
  const [req, setReq]           = useState(reqProp);
  const [acting, setActing]     = useState(false);
  const [declineMode, setDeclineMode] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [reasonErr, setReasonErr]  = useState("");
  const [fillMsg, setFillMsg]   = useState("");

  // Keep local req in sync if parent re-renders with new data
  useEffect(()=>{ setReq(reqProp); }, [reqProp.status, reqProp.id]);

  const isAdmin1 = isAdmin && (currentUser?.adminLevel||1) === 1;

  const apprentice = allUsers.find(u=>u.id===req.apprentice_id) || { name:"Unknown" };
  const approver   = allUsers.find(u=>u.id===req.approver_id)   || { name:"No approver" };
  const meta       = LEAVE_STATUS_META[req.status] || LEAVE_STATUS_META.pending;

  // KTA approval emails go to admin@kta.org.nz only
  const ktaAdminEmails = ["admin@kta.org.nz"];

  const approve = async () => {
    setActing(true);
    const newStatus = isApprover ? "approver_approved" : "kta_approved";
    const updated   = { ...req, status: newStatus };
    await updateRow("leave_requests", req.id, { status: newStatus }).catch(console.error);

    if(isApprover) {
      // 1. Notify apprentice their request moved forward
      if(apprentice.email) {
        await sendLeaveEmail({
          to: apprentice.email,
          subject: `Leave Request Approved by Approver — ${req.leave_type}`,
          html: leaveEmailHtml(
            `Your leave request has been approved by <strong>${currentUser.name}</strong> and forwarded to KTA for final approval.`,
            leaveDetailTable(req, apprentice.name, approver.name) +
            `<div style="background:#d4f0ec;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #1a8a7a">
              <div style="font-weight:700;font-size:12px;color:#1a8a7a;margin-bottom:4px">✓ Stage 1 of 2 Complete</div>
              <div style="font-size:12px;color:#0d1b2e">Approver approved. Awaiting KTA final approval.</div>
            </div>`
          ),
        });
      }
      // 2. Email KTA admin(s) with approve/decline buttons
      for(const adminEmail of ktaAdminEmails) {
        // Find admin user id for token (use placeholder if just the static email)
        const adminUser = allUsers.find(u => u.email === adminEmail && u.role==="Admin");
        const actorId   = adminUser?.id || "kta-admin";
        const buttons   = await leaveActionButtons(req.id, actorId, "admin");
        await sendLeaveEmail({
          to: adminEmail,
          subject: `Leave Request for KTA Approval — ${apprentice.name} (${req.leave_type})`,
          html: leaveEmailHtml(
            `A leave request from <strong>${apprentice.name}</strong> has been approved by their approver (<strong>${currentUser.name}</strong>) and requires KTA final approval.`,
            leaveDetailTable(req, apprentice.name, approver.name) + buttons
          ),
        });
      }
    } else {
      // Admin giving final KTA approval — notify apprentice + add to team calendar
      if(apprentice.email) {
        await sendLeaveEmail({
          to: apprentice.email,
          subject: `Leave Fully Approved by KTA — ${req.leave_type}`,
          html: leaveEmailHtml(
            `Your leave request has been <strong>fully approved by KTA</strong>. Enjoy your time off! 🎉`,
            leaveDetailTable(req, apprentice.name, approver.name) +
            `<div style="background:#dce8f7;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #1b4f8c">
              <div style="font-weight:700;font-size:12px;color:#1b4f8c;margin-bottom:4px">★ Fully Approved</div>
              <div style="font-size:12px;color:#0d1b2e">Both approver and KTA have approved your leave.</div>
            </div>`
          ),
        });
      }
      // Add to KTA team calendar
      await addLeaveToCalendar(apprentice.name, req.leave_type, req.date_from, req.date_to);
      // Auto-fill timesheet entries for each working day
      const filled = await autoFillLeaveEntries(apprentice.id, req.leave_type, req.date_from, req.date_to, entries, setEntries);
      if(filled > 0) setFillMsg(`✓ ${filled} timesheet ${filled===1?"entry":"entries"} auto-filled`);
    }
    setReq(updated);
    onUpdate(updated);
    setActing(false);
  };

  const submitDecline = async () => {
    if(!declineReason.trim()) { setReasonErr("Please enter a reason."); return; }
    setReasonErr("");
    setActing(true);
    const updated = { ...req, status: "declined", decline_reason: declineReason.trim() };
    await updateRow("leave_requests", req.id, { status: "declined", decline_reason: declineReason.trim() }).catch(console.error);
    if(apprentice.email) {
      await sendLeaveEmail({
        to: apprentice.email,
        subject: `Leave Request Declined — ${req.leave_type}`,
        html: leaveEmailHtml(
          `Your leave request for <strong>${req.leave_type}</strong> (${fmtDateNZ(req.date_from)} – ${fmtDateNZ(req.date_to)}) has been <strong>declined</strong> by <strong>${currentUser.name}</strong>.`,
          leaveDetailTable(req, apprentice.name, approver.name) +
          `<div style="background:#fde8e8;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #bf2b2b">
            <div style="font-weight:700;font-size:12px;color:#bf2b2b;margin-bottom:4px">Reason for Decline</div>
            <div style="font-size:12px;color:#0d1b2e">${declineReason.trim()}</div>
          </div>
          <p style="font-size:12px;color:#4a5a72">Please contact <strong>${currentUser.name}</strong> for further information.</p>`
        ),
      });
    }
    setReq(updated);
    onUpdate(updated);
    setActing(false);
    setDeclineMode(false);
  };

  const canApprove = (isApprover && req.status==="pending") ||
                     (isAdmin   && req.status==="approver_approved");
  const canDecline = (isApprover && req.status==="pending") ||
                     (isAdmin   && (req.status==="pending" || req.status==="approver_approved"));

  const borderCol = req.status==="declined" ? T.red :
                    req.status==="kta_approved" ? T.accent :
                    req.status==="approver_approved" ? T.teal : T.warn;

  return (
    <div style={{background:T.surface,border:`1.5px solid ${borderCol}33`,borderLeft:`3px solid ${borderCol}`,borderRadius:12,padding:"14px 16px",marginBottom:10}}>
      {/* Top row: name + type + action buttons */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
            <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{apprentice.name}</div>
            <span style={{background:T.bg,color:T.sub,borderRadius:99,padding:"2px 10px",fontSize:11,fontWeight:600}}>
              {req.leave_type}
            </span>
          </div>
          <div style={{fontSize:12,color:T.sub}}>
            📅 {fmtDateNZ(req.date_from)} → {fmtDateNZ(req.date_to)}
            <span style={{marginLeft:12,color:T.muted}}>Approver: {approver.name}</span>
          </div>
          {req.notes && <div style={{fontSize:12,color:T.sub,marginTop:4,fontStyle:"italic"}}>"{req.notes}"</div>}
          {req.decline_reason && req.status==="declined" && (
            <div style={{fontSize:11,color:T.red,marginTop:4,background:T.redL,borderRadius:6,padding:"4px 8px",display:"inline-block"}}>
              Reason: {req.decline_reason}
            </div>
          )}
        </div>
        {!declineMode && (
          <div style={{display:"flex",gap:6,flexShrink:0}}>
            {canApprove && (
              <button onClick={approve} disabled={acting}
                style={{background:T.teal,color:"#fff",border:"none",borderRadius:7,padding:"7px 16px",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"DM Sans,sans-serif",opacity:acting?.6:1}}>
                {acting?"…":"✓ Approve"}
              </button>
            )}
            {canDecline && !acting && (
              <button onClick={()=>{setDeclineMode(true);setDeclineReason("");setReasonErr("");}}
                style={{background:T.redL,color:T.red,border:`1.5px solid ${T.red}44`,borderRadius:7,padding:"7px 14px",fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                ✕ Decline
              </button>
            )}
            {isAdmin1 && onDelete && !acting && (
              <button onClick={async ()=>{
                if(!window.confirm(`Delete this leave request from ${apprentice.name}? This cannot be undone.`)) return;
                await deleteRow("leave_requests", req.id).catch(console.error);
                onDelete(req.id);
              }}
                title="Delete leave request"
                style={{background:"none",border:`1.5px solid ${T.red}44`,color:T.red,borderRadius:7,padding:"7px 10px",fontSize:13,cursor:"pointer",lineHeight:1}}>
                🗑
              </button>
            )}
          </div>
        )}
      </div>

      {/* Progress stepper — always visible */}
      <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
        <LeaveStatusStepper status={req.status}/>
        {fillMsg && (
          <div style={{marginTop:6,fontSize:11,color:T.teal,fontWeight:600}}>{fillMsg}</div>
        )}
      </div>

      {/* Inline decline reason form */}
      {declineMode && (
        <div style={{marginTop:12,padding:"12px 14px",background:T.redL,borderRadius:9,border:`1px solid ${T.red}33`}}>
          <div style={{fontWeight:700,fontSize:12,color:T.red,marginBottom:8}}>✕ Decline — Reason Required</div>
          <textarea
            value={declineReason}
            onChange={e=>{setDeclineReason(e.target.value);setReasonErr("");}}
            placeholder="Enter reason for declining this leave request…"
            rows={2}
            style={{width:"100%",border:`1.5px solid ${reasonErr?T.red:T.border}`,borderRadius:7,padding:"8px 10px",fontSize:12,fontFamily:"DM Sans,sans-serif",resize:"vertical",boxSizing:"border-box",color:T.ink}}
          />
          {reasonErr && <div style={{fontSize:11,color:T.red,marginBottom:6}}>{reasonErr}</div>}
          <div style={{display:"flex",gap:8,marginTop:6}}>
            <button onClick={submitDecline} disabled={acting}
              style={{background:T.red,color:"#fff",border:"none",borderRadius:7,padding:"7px 16px",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"DM Sans,sans-serif",opacity:acting?.6:1}}>
              {acting?"…":"Confirm Decline"}
            </button>
            <button onClick={()=>setDeclineMode(false)} disabled={acting}
              style={{background:T.bg,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:"7px 14px",fontSize:12,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Leave Toggle Card — compact, same style as ContactUs, expands to form ────
function LeaveToggleCard({ currentUser, allUsers }) {
  const [open, setOpen]       = useState(false);
  const [submitted, setSubmitted] = useState(false);

  return (
    <Card style={{marginTop:20, border:`1.5px solid ${T.border}`}} className="fu">
      {/* Header row — always visible, matches ContactUs style */}
      <button onClick={()=>{ setOpen(s=>!s); setSubmitted(false); }}
        style={{width:"100%", background:"none", border:"none", padding:0, cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif"}}>
        <div style={{display:"flex", alignItems:"center", gap:10}}>
          <div style={{width:36, height:36, borderRadius:10, background:T.accentL,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:18}}>🏖️</div>
          <div style={{flex:1}}>
            <div style={{fontWeight:700, fontSize:15}}>Apply for Leave</div>
            <div style={{fontSize:12, color:T.sub}}>Submit a leave request to your approver</div>
          </div>
          <div style={{fontSize:13, color:T.muted, marginLeft:"auto"}}>{open ? "▲" : "▼"}</div>
        </div>
      </button>

      {/* Expandable form */}
      {open && !submitted && (
        <div style={{marginTop:18, borderTop:`1px solid ${T.border}`, paddingTop:18}}>
          <LeaveRequestForm
            currentUser={currentUser}
            allUsers={allUsers}
            onSubmitted={()=>{ setSubmitted(true); setTimeout(()=>setOpen(false), 2000); }}
          />
        </div>
      )}
      {open && submitted && (
        <div style={{marginTop:18, borderTop:`1px solid ${T.border}`, paddingTop:18, textAlign:"center", padding:"24px 16px"}}>
          <div style={{fontSize:32, marginBottom:10}}>✅</div>
          <div style={{fontWeight:700, color:T.teal, fontSize:15}}>Leave request submitted!</div>
        </div>
      )}
    </Card>
  );
}



// ── Leave Requests List Page (full-page admin view, opened from stat card) ────
function LeaveRequestsListPage({ currentUser, allUsers, entries, setEntries }) {
  const [requests, setRequests] = useState([]);
  const [loading,  setLoading]  = useState(true);

  const load = () => {
    loadTable("leave_requests")
      .then(rows => {
        const sorted = (rows||[]).sort((a,b) => {
          // Sort order: awaiting_kta first, then pending, then approved, then declined, then by date desc
          const rank = { approver_approved:0, pending:1, kta_approved:2, declined:3 };
          const ra = rank[a.status]??2, rb = rank[b.status]??2;
          if(ra !== rb) return ra - rb;
          return b.created_at.localeCompare(a.created_at);
        });
        setRequests(sorted);
      })
      .catch(()=>setRequests([]))
      .finally(()=>setLoading(false));
  };

  useEffect(()=>{ load(); },[]);
  useEffect(()=>{ const t=setInterval(load,30000); return()=>clearInterval(t); },[]);

  const handleUpdate = (updated) => setRequests(prev=>prev.map(r=>r.id===updated.id?updated:r));

  if(loading) return <div style={{textAlign:"center",padding:40,color:T.muted,fontSize:13}}>Loading leave requests…</div>;
  if(requests.length===0) return (
    <Card style={{textAlign:"center",padding:"52px 24px"}}>
      <div style={{fontSize:36,marginBottom:10}}>🏖️</div>
      <div style={{fontWeight:600,fontSize:15}}>No leave requests yet</div>
      <div style={{fontSize:13,color:T.sub,marginTop:6}}>Approved leave requests will appear here.</div>
    </Card>
  );

  return (
    <div>
      {requests.map(r=>(
        <LeaveRequestCard key={r.id} req={r} allUsers={allUsers} currentUser={currentUser}
          isAdmin={true} isApprover={false} onUpdate={handleUpdate}
          entries={entries} setEntries={setEntries}
          onDelete={(id)=>setRequests(prev=>prev.filter(x=>x.id!==id))}/>
      ))}
    </div>
  );
}

// ── Leave Overview Card (Admin Dashboard — compact table in timesheets section) ──
function LeaveOverviewCard({ allUsers }) {
  const [requests, setRequests] = useState([]);
  const [loading,  setLoading]  = useState(true);

  const load = () => {
    loadTable("leave_requests")
      .then(rows => setRequests((rows||[]).sort((a,b)=>b.created_at.localeCompare(a.created_at))))
      .catch(()=>setRequests([]))
      .finally(()=>setLoading(false));
  };
  useEffect(()=>{ load(); },[]);
  useEffect(()=>{ const t=setInterval(load,30000); return()=>clearInterval(t); },[]);

  const STATUS = {
    pending:           { label:"Awaiting Approver", color:"#b86e1a", bg:"#faebd7", dot:"🟠" },
    approver_approved: { label:"Awaiting KTA",      color:"#1b4f8c", bg:"#dce8f7", dot:"🔵" },
    kta_approved:      { label:"Approved",           color:"#1a6b3a", bg:"#d4f0e0", dot:"🟢" },
    declined:          { label:"Declined",           color:"#bf2b2b", bg:"#fde8e8", dot:"🔴" },
  };

  const getName = (id) => allUsers.find(u=>u.id===id)?.name || "—";
  const fmt = (d) => { if(!d) return "—"; const[y,m,dy]=d.split("-"); return `${dy}/${m}/${y}`; };

  if(loading) return (
    <Card style={{marginBottom:16,padding:"18px 20px"}}>
      <div style={{fontSize:12,color:T.muted}}>Loading leave requests…</div>
    </Card>
  );
  if(requests.length===0) return null;

  return (
    <Card style={{marginBottom:16,border:`1.5px solid ${T.border}`}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <div style={{width:36,height:36,borderRadius:10,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🏖️</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:16}}>Leave Requests</div>
          <div style={{fontSize:12,color:T.sub,marginTop:2}}>{requests.length} request{requests.length!==1?"s":""} — click a row to manage in the panel below</div>
        </div>
        <button onClick={load} title="Refresh" style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:T.muted,padding:4}}>↻</button>
      </div>

      {/* Legend */}
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:12}}>
        {Object.entries(STATUS).map(([k,v])=>(
          <span key={k} style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:11,
            color:v.color,background:v.bg,borderRadius:99,padding:"3px 10px",fontWeight:600,
            border:`1px solid ${v.color}33`}}>
            <span style={{width:7,height:7,borderRadius:"50%",background:v.color,display:"inline-block"}}/>
            {v.label}
          </span>
        ))}
      </div>

      {/* Table */}
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{background:T.bg}}>
              {["Apprentice","Leave Type","Start","End","Status"].map(h=>(
                <th key={h} style={{padding:"8px 12px",textAlign:"left",fontSize:10,fontWeight:700,
                  color:T.muted,textTransform:"uppercase",letterSpacing:".6px",
                  borderBottom:`1.5px solid ${T.border}`,whiteSpace:"nowrap"}}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {requests.map((r,i)=>{
              const s = STATUS[r.status] || STATUS.pending;
              return (
                <tr key={r.id}
                  style={{borderBottom:`1px solid ${T.border}44`,
                    background:i%2===0?T.surface:T.bg,
                    transition:"background .12s"}}
                  onMouseEnter={e=>e.currentTarget.style.background=s.bg}
                  onMouseLeave={e=>e.currentTarget.style.background=i%2===0?T.surface:T.bg}>
                  {/* Apprentice */}
                  <td style={{padding:"10px 12px",fontWeight:600,color:T.ink,whiteSpace:"nowrap"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <Avatar name={getName(r.apprentice_id)} role="Apprentice" size={26}/>
                      {getName(r.apprentice_id)}
                    </div>
                  </td>
                  {/* Leave Type */}
                  <td style={{padding:"10px 12px",color:T.sub,whiteSpace:"nowrap"}}>{r.leave_type}</td>
                  {/* Start */}
                  <td style={{padding:"10px 12px",color:T.sub,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"}}>{fmt(r.date_from)}</td>
                  {/* End */}
                  <td style={{padding:"10px 12px",color:T.sub,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"}}>{fmt(r.date_to)}</td>
                  {/* Status pill */}
                  <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}>
                    <span style={{display:"inline-flex",alignItems:"center",gap:5,
                      background:s.bg,color:s.color,border:`1px solid ${s.color}44`,
                      borderRadius:99,padding:"3px 10px",fontSize:11,fontWeight:700}}>
                      <span style={{width:7,height:7,borderRadius:"50%",background:s.color,display:"inline-block"}}/>
                      {s.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Leave Requests Panel (Admin / Approver / Mentor) ─────────────────────────
function LeaveRequestsPanel({ currentUser, allUsers, entries=[], setEntries=null }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState("pending");

  const role       = currentUser.role;
  const isAdmin    = role === "Admin";
  const isApprover = role === "Approver";
  const isMentor   = role === "Mentor";

  const load = () => {
    setLoading(true);
    loadTable("leave_requests")
      .then(rows => {
        let visible = rows || [];
        if(isApprover) {
          const myIds = allUsers
            .filter(u => u.role==="Apprentice" && (
              u.approverUserId === currentUser.id ||
              (u.allocatedTo||[]).includes(currentUser.id)
            ))
            .map(u=>u.id);
          visible = visible.filter(r => myIds.includes(r.apprentice_id));
        }
        if(isMentor) {
          const myIds = allUsers
            .filter(u => u.role==="Apprentice" && (
              u.allocatedTo === currentUser.id ||
              u.mentorUserId === currentUser.id
            ))
            .map(u=>u.id);
          visible = visible.filter(r => myIds.includes(r.apprentice_id));
        }
        setRequests(visible.sort((a,b)=>b.created_at.localeCompare(a.created_at)));
      })
      .catch(()=>setRequests([]))
      .finally(()=>setLoading(false));
  };

  useEffect(()=>{ load(); },[currentUser.id]);

  // Poll every 30s so status updates from email actions appear automatically
  useEffect(()=>{ const t = setInterval(load, 30000); return ()=>clearInterval(t); },[currentUser.id]);

  const handleUpdate = (updated) => {
    setRequests(prev => prev.map(r => r.id===updated.id ? updated : r));
  };

  // Separate tabs: Pending approver, Awaiting KTA, Fully Approved, Declined
  const tabPending   = requests.filter(r => r.status==="pending");
  const tabAwaitKTA  = requests.filter(r => r.status==="approver_approved");
  const tabApproved  = requests.filter(r => r.status==="kta_approved");
  const tabDeclined  = requests.filter(r => r.status==="declined");

  const TAB_CONFIG = [
    { id:"pending",      label:"⏳ Pending Approver",  list:tabPending,   color:"#b86e1a" },
    { id:"awaiting_kta", label:"✓ Awaiting KTA",      list:tabAwaitKTA,  color:"#1a8a7a" },
    { id:"approved",     label:"★ Fully Approved",    list:tabApproved,  color:T.accent  },
    { id:"declined",     label:"✕ Declined",          list:tabDeclined,  color:T.red     },
  ];

  const shown = TAB_CONFIG.find(t=>t.id===tab)?.list || [];

  if(loading) return <div style={{textAlign:"center",padding:20,color:T.muted,fontSize:13}}>Loading leave requests…</div>;
  if(requests.length === 0) return null;

  return (
    <Card style={{marginBottom:16,border:`1.5px solid ${T.border}`}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <div style={{width:36,height:36,borderRadius:10,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🏖️</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:16}}>Leave Requests</div>
          <div style={{fontSize:12,color:T.sub,marginTop:2}}>Review and approve apprentice leave applications</div>
        </div>
        <button onClick={load} title="Refresh" style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:T.muted,padding:4}}>↻</button>
      </div>
      {/* Status tabs — all 4 stages clearly separated */}
      <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
        {TAB_CONFIG.map(tc => (
          <button key={tc.id} onClick={()=>setTab(tc.id)}
            style={{padding:"5px 12px",borderRadius:8,border:`1.5px solid ${tab===tc.id?tc.color:T.border}`,
              cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontSize:11,fontWeight:600,
              background:tab===tc.id?tc.color:T.surface,
              color:tab===tc.id?"#fff":tc.list.length>0?tc.color:T.muted,
              transition:"all .12s"}}>
            {tc.label}
            {tc.list.length>0 && <span style={{marginLeft:5,background:tab===tc.id?"rgba(255,255,255,.25)":tc.color+"22",borderRadius:99,padding:"1px 7px",fontSize:10,fontWeight:700}}>{tc.list.length}</span>}
          </button>
        ))}
      </div>
      {shown.length===0
        ? <div style={{textAlign:"center",padding:"20px",color:T.muted,fontSize:13,fontStyle:"italic"}}>No leave requests in this category.</div>
        : shown.map(r => (
            <LeaveRequestCard key={r.id} req={r} allUsers={allUsers} currentUser={currentUser}
              isAdmin={isAdmin} isApprover={isApprover} onUpdate={handleUpdate}
              entries={entries} setEntries={setEntries}
              onDelete={(id)=>setRequests(prev=>prev.filter(r=>r.id!==id))}/>
          ))
      }
    </Card>
  );
}

// ── My Leave Requests (Apprentice view of own requests) ───────────────────────
function MyLeaveRequests({ currentUser }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading]   = useState(true);

  const load = () => {
    loadTable("leave_requests")
      .then(rows => setRequests((rows||[]).filter(r=>r.apprentice_id===currentUser.id).sort((a,b)=>b.created_at.localeCompare(a.created_at))))
      .catch(()=>setRequests([]))
      .finally(()=>setLoading(false));
  };

  useEffect(()=>{ load(); },[currentUser.id]);
  // Poll every 20s — apprentice sees status update automatically when admin approves via email
  useEffect(()=>{ const t = setInterval(load, 20000); return ()=>clearInterval(t); },[currentUser.id]);

  if(loading) return null;
  if(requests.length===0) return null;

  return (
    <Card style={{marginBottom:16,border:`1.5px solid ${T.border}`}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>📋</div>
          <div style={{fontWeight:700,fontSize:15}}>My Leave Requests</div>
        </div>
        <button onClick={load} title="Refresh" style={{background:"none",border:"none",cursor:"pointer",fontSize:14,color:T.muted}}>↻</button>
      </div>
      {requests.map(r => {
        const meta = LEAVE_STATUS_META[r.status] || LEAVE_STATUS_META.pending;
        const borderCol = r.status==="declined" ? T.red :
                          r.status==="kta_approved" ? T.accent :
                          r.status==="approver_approved" ? T.teal : T.warn;
        return (
          <div key={r.id} style={{marginBottom:12,padding:"12px 14px",borderRadius:10,
            border:`1.5px solid ${borderCol}33`,borderLeft:`3px solid ${borderCol}`,background:T.surface}}>
            {/* Header row */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap",marginBottom:6}}>
              <div>
                <div style={{fontWeight:700,fontSize:13,color:T.ink}}>{r.leave_type}</div>
                <div style={{fontSize:12,color:T.sub,marginTop:2}}>
                  📅 {fmtDateNZ(r.date_from)} → {fmtDateNZ(r.date_to)}
                </div>
                {r.notes && <div style={{fontSize:11,color:T.muted,marginTop:2,fontStyle:"italic"}}>"{r.notes}"</div>}
              </div>
              <span style={{background:meta.bg,color:meta.color,borderRadius:99,padding:"3px 12px",fontSize:11,fontWeight:700,flexShrink:0,whiteSpace:"nowrap"}}>
                {meta.sym} {meta.label}
              </span>
            </div>
            {/* Decline reason — shown if declined */}
            {r.status==="declined" && r.decline_reason && (
              <div style={{background:T.redL,border:`1px solid ${T.red}22`,borderRadius:7,padding:"7px 10px",fontSize:12,color:T.red,marginBottom:6}}>
                <span style={{fontWeight:700}}>Reason: </span>{r.decline_reason}
              </div>
            )}
            {/* Progress stepper */}
            <div style={{paddingTop:8,borderTop:`1px solid ${T.border}`}}>
              <LeaveStatusStepper status={r.status}/>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT US — Apprentice view
// ─────────────────────────────────────────────────────────────────────────────
function ContactUs({currentUser, allUsers, onSend}) {
  const [selectedId, setSelectedId] = useState(null);
  const [msgMode, setMsgMode] = useState(false);
  const [msgText, setMsgText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // Show Admin and Mentor users as contactable staff (excluding the current user)
  const staffColors = [T.accent, T.teal, T.warn, T.gold, T.blue];
  const staff = allUsers
    .filter(u => ["Admin","Mentor"].includes(u.role) && u.id !== currentUser.id)
    .sort((a, b) => {
      const isMentorA = a.role === "Mentor";
      const isMentorB = b.role === "Mentor";
      const isKristeenaA = a.email?.toLowerCase() === "kristeena@kta.org.nz";
      const isKristeenaB = b.email?.toLowerCase() === "kristeena@kta.org.nz";
      // Mentors first
      if(isMentorA && !isMentorB) return -1;
      if(!isMentorA && isMentorB) return 1;
      // Among non-mentors: Kristeena immediately after last mentor
      if(!isMentorA && !isMentorB) {
        if(isKristeenaA) return -1;
        if(isKristeenaB) return 1;
      }
      // Otherwise alphabetical
      return a.name.localeCompare(b.name);
    })
    .map((u, i) => ({
      ...u,
      color: staffColors[i % staffColors.length],
      avatar: u.name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(),
    }));

  const selected = staff.find(u => u.id === selectedId) || null;

  const handleSendMsg = async () => {
    if(!msgText.trim() || !selected) return;
    setSending(true);
    await onSend(selected, msgText.trim());
    setSending(false);
    setSent(true);
    setTimeout(()=>{ setSent(false); setMsgText(""); setMsgMode(false); }, 2500);
  };

  if(staff.length === 0) return null;

  return (
    <Card style={{marginTop:20,border:`1.5px solid ${T.border}`}} className="fu">
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
        <div style={{width:36,height:36,borderRadius:10,background:T.accentL,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📞</div>
        <div>
          <div style={{fontWeight:700,fontSize:15}}>Contact Us</div>
          <div style={{fontSize:12,color:T.sub}}>Get in touch with your KTA team</div>
        </div>
      </div>

      {/* Staff cards */}
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:selectedId?16:0}}>
        {staff.map(person=>(
          <button key={person.id}
            onClick={()=>{setSelectedId(selectedId===person.id?null:person.id);setMsgMode(false);setSent(false);setMsgText("");}}
            style={{padding:"12px 14px",borderRadius:12,textAlign:"left",cursor:"pointer",
              border:`2px solid ${selectedId===person.id?person.color:T.border}`,
              background:selectedId===person.id?person.color+"11":T.surface,
              transition:"all .15s",fontFamily:"DM Sans,sans-serif",width:"100%",
              display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:44,height:44,borderRadius:99,background:person.color,
              display:"flex",alignItems:"center",justifyContent:"center",
              color:"#fff",fontWeight:700,fontSize:14,flexShrink:0}}>
              {person.avatar}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{person.name}</div>
              <div style={{marginTop:3}}><RolePill role={person.role} size="sm"/></div>
            </div>
            {selectedId===person.id
              ? <span style={{fontSize:16,color:person.color,flexShrink:0}}>✓</span>
              : <span style={{fontSize:14,color:T.muted,flexShrink:0}}>›</span>
            }
          </button>
        ))}
      </div>

      {/* Contact options */}
      {selected&&!msgMode&&!sent&&(
        <div className="fu" style={{background:T.bg,borderRadius:10,padding:14}}>
          <div style={{fontSize:12,fontWeight:600,color:T.sub,marginBottom:10,textTransform:"uppercase",letterSpacing:".5px"}}>
            How would you like to reach {selected.name.split(" ")[0]}?
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {selected.phone&&(
              <a href={`tel:${selected.phone.replace(/\s/g,"")}`}
                style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
                  borderRadius:9,background:T.surface,border:`1.5px solid ${T.border}`,
                  textDecoration:"none",color:T.ink,transition:"all .14s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=T.accent}
                onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
                <span style={{fontSize:20}}>📱</span>
                <div>
                  <div style={{fontSize:13,fontWeight:600}}>Call</div>
                  <div style={{fontSize:12,color:T.sub}}>{selected.phone}</div>
                </div>
              </a>
            )}
            {selected.email&&(
              <a href={`mailto:${selected.email}`}
                style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
                  borderRadius:9,background:T.surface,border:`1.5px solid ${T.border}`,
                  textDecoration:"none",color:T.ink,transition:"all .14s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=T.accent}
                onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
                <span style={{fontSize:20}}>✉️</span>
                <div>
                  <div style={{fontSize:13,fontWeight:600}}>Email</div>
                  <div style={{fontSize:12,color:T.sub}}>{selected.email}</div>
                </div>
              </a>
            )}
            {!selected.phone&&!selected.email&&(
              <div style={{fontSize:12,color:T.muted,fontStyle:"italic",padding:"8px 0"}}>
                No phone or email on file — use the in-app message below.
              </div>
            )}
            <button onClick={()=>setMsgMode(true)}
              style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
                borderRadius:9,background:T.surface,border:`1.5px solid ${T.border}`,
                textAlign:"left",cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                color:T.ink,transition:"all .14s",width:"100%"}}
              onMouseEnter={e=>e.currentTarget.style.borderColor=selected.color}
              onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
              <span style={{fontSize:20}}>💬</span>
              <div>
                <div style={{fontSize:13,fontWeight:600}}>Message in App</div>
                <div style={{fontSize:12,color:T.sub}}>Send a message via the KTA app</div>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* In-app message composer */}
      {selected&&msgMode&&!sent&&(
        <div className="fu" style={{background:T.bg,borderRadius:10,padding:14}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:8}}>
            Message to {selected.name}
          </div>
          <textarea
            placeholder={`Hi ${selected.name.split(" ")[0]}, I wanted to reach out about…`}
            value={msgText}
            onChange={e=>setMsgText(e.target.value)}
            rows={4}
            style={{width:"100%",fontSize:13,padding:"10px 12px",borderRadius:8,
              border:`1.5px solid ${T.border}`,fontFamily:"DM Sans,sans-serif",
              background:T.surface,resize:"none",color:T.ink,outline:"none",
              boxSizing:"border-box"}}
          />
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <Btn onClick={handleSendMsg} disabled={sending||!msgText.trim()}>
              {sending?"Sending…":"Send Message"}
            </Btn>
            <Btn v="ghost" onClick={()=>{setMsgMode(false);setMsgText("");}}>Cancel</Btn>
          </div>
        </div>
      )}

      {/* Sent confirmation */}
      {sent&&(
        <div className="fu" style={{background:T.accentL,borderRadius:10,padding:16,textAlign:"center"}}>
          <div style={{fontSize:20,marginBottom:4}}>✓</div>
          <div style={{fontWeight:700,color:T.accent,fontSize:14}}>Message sent!</div>
          <div style={{fontSize:12,color:T.sub,marginTop:2}}>{selected?.name} will get back to you soon.</div>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MENTOR MODULE
// ─────────────────────────────────────────────────────────────────────────────

// ── Meeting Report — Email sender ─────────────────────────────────────────────
const sendMeetingReportEmail = async (report, apprentice, mentor, approver) => {
  const fD = (iso) => { if(!iso) return "TBC"; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };

  // HTML body (existing plain-text format)
  const lines = [
    `APPRENTICE CHECK IN REPORT`,
    `Kiwi Trade Apprentices`,
    `════════════════════════════════════════════`,
    ``,
    `Trainee Name:       ${apprentice.name}`,
    `Trade:              ${apprentice.trade||"Not specified"}`,
    `Location:           ${report.location||"Not specified"}`,
    `Date:               ${fD(report.date)}`,
    `KTA Representative: ${mentor.name}`,
    `Licence Expiry:     ${apprentice.licenceExpiry ? fD(apprentice.licenceExpiry) : "Not set"}`,
    `Date of Next Visit: ${fD(report.next_visit_date)}`,
    ``,
    `────────────────────────────────────────────`,
    `OFF JOB PROGRESS SINCE LAST VISIT`,
    `────────────────────────────────────────────`,
    report.off_job_progress || "N/a",
    ``,
    `────────────────────────────────────────────`,
    `ON JOB PROGRESS SINCE LAST VISIT`,
    `────────────────────────────────────────────`,
    report.on_job_progress || "N/a",
    ``,
    `────────────────────────────────────────────`,
    `PREVIOUS GOALS`,
    `────────────────────────────────────────────`,
    report.previous_goals || "N/a",
    ``,
    `────────────────────────────────────────────`,
    `GOALS BEFORE NEXT VISIT`,
    `────────────────────────────────────────────`,
    report.goals_this_meeting || "N/a",
    ``,
    `────────────────────────────────────────────`,
    `COMMENTS AND FEEDBACK`,
    `────────────────────────────────────────────`,
    report.comments_feedback || "N/a",
    ``,
    `════════════════════════════════════════════`,
    `This report was generated by the KTA Workforce Management System`,
    `kta.org.nz`,
  ].join("\n");

  const recipients = [
    { email: apprentice.email, name: apprentice.name },
    approver ? { email: approver.email, name: approver.name } : null,
  ].filter(r => r && r.email && r.email.trim());

  if(recipients.length === 0) {
    throw new Error("No valid email addresses found — check that the apprentice and approver both have email addresses set in their profiles.");
  }

  // Generate PDF attachment (pure JS — synchronous, no library)
  let pdfBase64 = null;
  try {
    pdfBase64 = generateReportPDF(report, apprentice, mentor);
    if(!pdfBase64 || pdfBase64.length < 100) throw new Error("PDF output was empty");
  } catch(e) {
    console.error("PDF generation failed:", e);
    // Don't throw — still send email without attachment
  }

  const pdfFilename = `KTA_Report_${apprentice.name.replace(/\s+/g,"_")}_${report.date}.pdf`;
  const attachments = pdfBase64 ? [{
    name: pdfFilename,
    contentType: "application/pdf",
    contentBytes: pdfBase64,
  }] : [];

  for(const r of recipients) {
    await sendKTAEmail({
      to: r.email.trim(),
      subject: `Apprentice Check In Report — ${apprentice.name}`,
      html: `<p>Hi ${r.name},</p>
<p>Please find attached the apprentice check in report for <strong>${apprentice.name}</strong>.</p>
<hr>
<pre style="font-family:monospace;font-size:13px;line-height:1.6">${lines}</pre>
<p style="color:#888;font-size:12px">KTA Workforce Management · timesheet@kta.org.nz</p>`,
      attachments,
    });
  }
};

// ─── Fullscreen New Report Modal ────────────────────────────────────────────
// Renders MeetingReportForm full-screen with a collapsible Past Reports panel
function ReportFullscreenModal({apprentice, mentor, allUsers, meetingKey, onSave, onClose}) {
  const [showPast, setShowPast] = useState(false);

  // Prevent body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:2000,
      background:"rgba(13,27,46,0.55)", backdropFilter:"blur(3px)",
      display:"flex", alignItems:"stretch",
    }}>
      {/* Main form panel */}
      <div style={{
        flex:1, overflowY:"auto", background:T.bg,
        display:"flex", flexDirection:"column",
        transition:"margin-right .25s",
        marginRight: showPast ? 400 : 0,
      }}>
        {/* Top bar */}
        <div style={{
          position:"sticky", top:0, zIndex:10,
          background:T.dark, padding:"0 20px",
          display:"flex", alignItems:"center", justifyContent:"space-between",
          height:52, flexShrink:0, boxShadow:"0 2px 8px rgba(0,0,0,.18)",
        }}>
          <div style={{display:"flex", alignItems:"center", gap:12}}>
            <div style={{fontSize:20}}>📋</div>
            <div>
              <div style={{fontWeight:700, fontSize:15, color:"#fff"}}>New Meeting Report</div>
              <div style={{fontSize:11, color:"rgba(255,255,255,.65)"}}>{apprentice.name}</div>
            </div>
          </div>
          <div style={{display:"flex", alignItems:"center", gap:10}}>
            {/* Past Reports toggle */}
            <button
              onClick={() => setShowPast(s => !s)}
              style={{
                display:"flex", alignItems:"center", gap:7,
                background: showPast ? T.gold : "rgba(255,255,255,.12)",
                border: `1.5px solid ${showPast ? T.gold : "rgba(255,255,255,.25)"}`,
                borderRadius:8, padding:"6px 14px", cursor:"pointer",
                color: showPast ? T.dark : "#fff", fontSize:12, fontWeight:600,
                fontFamily:"DM Sans,sans-serif", transition:"all .15s",
              }}
            >
              <span>📁</span>
              <span>Past Reports</span>
              <span style={{fontSize:10, opacity:.7}}>{showPast ? "▶" : "◀"}</span>
            </button>
            {/* Close */}
            <button
              onClick={onClose}
              style={{
                background:"rgba(255,255,255,.12)", border:"1.5px solid rgba(255,255,255,.25)",
                borderRadius:8, padding:"6px 12px", cursor:"pointer",
                color:"#fff", fontSize:13, fontWeight:600,
                fontFamily:"DM Sans,sans-serif", transition:"all .15s",
              }}
            >✕ Cancel</button>
          </div>
        </div>

        {/* Form body */}
        <div style={{flex:1, padding:"24px 20px", maxWidth:860, margin:"0 auto", width:"100%", boxSizing:"border-box"}}>
          <MeetingReportForm
            apprentice={apprentice}
            mentor={mentor}
            allUsers={allUsers}
            onSave={onSave}
            onCancel={onClose}
          />
        </div>
      </div>

      {/* Past Reports side panel */}
      <div style={{
        position:"fixed", top:0, right:0, bottom:0, width:400,
        background:"#fff", borderLeft:`1.5px solid ${T.border}`,
        overflowY:"auto", transform: showPast ? "translateX(0)" : "translateX(100%)",
        transition:"transform .25s ease", zIndex:2001, boxShadow:"-4px 0 20px rgba(0,0,0,.1)",
        display:"flex", flexDirection:"column",
      }}>
        <div style={{
          position:"sticky", top:0, zIndex:1,
          background:T.goldL, borderBottom:`1px solid ${T.gold}`,
          padding:"14px 16px", display:"flex", alignItems:"center", justifyContent:"space-between",
        }}>
          <div style={{display:"flex", alignItems:"center", gap:8}}>
            <span style={{fontSize:16}}>📁</span>
            <div style={{fontWeight:700, fontSize:14, color:T.gold}}>Past Reports</div>
          </div>
          <button onClick={() => setShowPast(false)} style={{
            background:"none", border:"none", cursor:"pointer", fontSize:16, color:T.gold, padding:4,
          }}>✕</button>
        </div>
        <div style={{padding:"16px", flex:1}}>
          <PastMeetingReports key={meetingKey} apprentice={apprentice} allUsers={allUsers} canEdit={false}/>
        </div>
      </div>
    </div>
  );
}

// Stable textarea + section-header components for MeetingReportForm
// MUST live outside MeetingReportForm — if defined inside, every keystroke
// recreates them as new component types, unmounting/remounting and losing focus.
const ReportTA = ({rows=4, value, onChange, placeholder}) => (
  <textarea rows={rows} value={value} onChange={onChange} placeholder={placeholder||""}
    style={{width:"100%",fontSize:13,padding:"10px 12px",border:`1px solid ${T.border}`,
      borderTop:"none",borderRadius:0,fontFamily:"DM Sans,sans-serif",background:"#fff",
      resize:"vertical",color:T.ink,outline:"none",boxSizing:"border-box",minHeight:90}}/>
);
const ReportSH = ({children, req}) => (
  <div style={{background:"#f5f7fa",border:`1px solid ${T.border}`,borderBottom:"none",
    padding:"9px 12px",fontWeight:700,fontSize:13,color:T.ink,display:"flex",alignItems:"center",gap:5}}>
    {children}{req&&<span style={{color:T.red,fontSize:11,marginLeft:2}}>*</span>}
  </div>
);

// ── Meeting Report Form — KTA "Apprentice Check In Report" template ───────────
function MeetingReportForm({apprentice, mentor, allUsers, onSave, onCancel}) {
  const today = new Date().toISOString().slice(0,10);
  const approver = allUsers.find(u=>
    u.id === apprentice.approverUserId ||
    (u.role==="Approver" && (u.allocatedTo||[]).includes(apprentice.id))
  );
  const [form, setForm] = useState({
    date: today, location: "",
    offJobProgress: "", onJobProgress: "",
    previousGoals: "", goalsNextVisit: "",
    commentsFeedback: "", nextVisitDate: "",
  });
  const [saving, setSaving]           = useState(false);
  const [emailStatus, setEmailStatus] = useState(null);
  const [prevGoalsSource, setPrevGoalsSource] = useState(null);
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));
  const fD = (iso) => { if(!iso) return "—"; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };

  // On mount: fetch the most recent past report and pre-fill Previous Goals from its goals_this_meeting
  useEffect(() => {
    loadTable('meeting_reports').then(reports => {
      const past = (reports || [])
        .filter(r => r.apprentice_id === apprentice.id && r.goals_this_meeting?.trim())
        .sort((a,b) => (b.date||b.created_at||"").localeCompare(a.date||a.created_at||""));
      if(past.length > 0) {
        const last = past[0];
        setForm(f => ({ ...f, previousGoals: last.goals_this_meeting.trim() }));
        setPrevGoalsSource(last.date || last.created_at?.slice(0,10));
      }
    }).catch(() => {});
  }, [apprentice.id]);

  const handleSave = async () => {
    if(!form.commentsFeedback.trim() && !form.onJobProgress.trim()) {
      alert("Please fill in at least On Job Progress or Comments & Feedback."); return;
    }
    setSaving(true);
    const report = {
      id: uid(), apprentice_id: apprentice.id, mentor_id: mentor.id,
      date: form.date, location: form.location.trim(),
      off_job_progress:  form.offJobProgress.trim(),
      on_job_progress:   form.onJobProgress.trim(),
      previous_goals:    form.previousGoals.trim(),
      goals_this_meeting: form.goalsNextVisit.trim(),
      comments_feedback: form.commentsFeedback.trim(),
      next_visit_date:   form.nextVisitDate || null,
      created_at:        new Date().toISOString(),
    };
    try {
      await upsertRow('meeting_reports', report);
      setEmailStatus("sending");
      await sendMeetingReportEmail(report, apprentice, mentor, approver);
      setEmailStatus("sent");
      setTimeout(()=>onSave(report), 1200);
    } catch(e) {
      console.error("Report save/email error:", e);
      setEmailStatus("error");
      const msg = e.message || "";
      if(msg.includes("No valid email")) {
        alert(`Report saved ✓\n\nEmail could not be sent:\n${msg}`);
      } else if(msg.includes("Email send failed") || msg.includes("Failed to fetch") || msg.includes("fetch")) {
        alert(`Report saved ✓\n\nEmail failed — the email-proxy Edge Function may not be deployed yet.\n\nTo fix: run\n  node kta-deploy-functions.cjs email-proxy\n\nError: ${msg}`);
      } else {
        alert(`Report saved ✓\n\nEmail error: ${msg}`);
      }
      setTimeout(()=>onSave(report), 500);
      setSaving(false);
    }
  };

  return (
    <div style={{border:`1.5px solid ${T.border}`,borderRadius:10,overflow:"hidden",background:"#fff"}}>
      {/* KTA Header */}
      <div style={{background:T.dark,padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:16,color:"#fff"}}>Apprentice Check In Report</div>
          <div style={{fontSize:11,color:"#ffffff88",marginTop:2}}>Kiwi Trade Apprentices</div>
        </div>
        <img src={KTA_LOGO} alt="KTA" style={{height:36,objectFit:"contain",filter:"brightness(0) invert(1)"}}
          onError={e=>e.target.style.display="none"}/>
      </div>

      {/* Top table — Trainee Name / Location / Date */}
      <div style={{border:`1px solid ${T.border}`,borderTop:"none"}}>
        {[
          {label:"Trainee Name", content:<div style={{padding:"4px 6px",fontSize:13,fontWeight:600}}>{apprentice.name}</div>},
          {label:"Location",     content:<input value={form.location} onChange={e=>sf("location",e.target.value)}
            placeholder="e.g. Worksite, Zoom, Head Office"
            onKeyDown={e=>e.stopPropagation()}
            style={{border:"none",fontSize:13,width:"100%",outline:"none",padding:"6px",fontFamily:"DM Sans,sans-serif",background:"transparent"}}/>},
          {label:"Date",         content:<input type="date" value={form.date} onChange={e=>sf("date",e.target.value)}
            style={{border:"none",fontSize:13,width:"100%",outline:"none",padding:"6px",fontFamily:"DM Sans,sans-serif",background:"transparent"}}/>},
        ].map(({label,content})=>(
          <div key={label} style={{display:"grid",gridTemplateColumns:"160px 1fr",borderBottom:`1px solid ${T.border}`}}>
            <div style={{padding:"10px 12px",fontWeight:700,fontSize:13,borderRight:`1px solid ${T.border}`,background:"#f5f7fa"}}>{label}</div>
            <div>{content}</div>
          </div>
        ))}
      </div>

      {/* Main sections */}
      <div style={{border:`1px solid ${T.border}`,borderTop:"none"}}>
        <ReportSH>Off Job Progress Since Last Visit</ReportSH>
        <ReportTA rows={4} value={form.offJobProgress} onChange={e=>sf("offJobProgress",e.target.value)}
          placeholder="Training courses, assessments, NZQA unit standards, classroom learning…"/>
        <ReportSH>On Job Progress Since Last Visit</ReportSH>
        <ReportTA rows={4} value={form.onJobProgress} onChange={e=>sf("onJobProgress",e.target.value)}
          placeholder="Practical skills, site work, tasks completed, employer feedback…"/>
        <ReportSH>Previous Goals</ReportSH>
        {prevGoalsSource && (
          <div style={{fontSize:11,color:T.teal,marginBottom:4,paddingLeft:2}}>
            ✓ Auto-filled from report dated {prevGoalsSource.split('-').reverse().join('/')} — edit as needed
          </div>
        )}
        <ReportTA rows={4} value={form.previousGoals} onChange={e=>sf("previousGoals",e.target.value)}
          placeholder="Goals set at the last visit — have they been met?"/>
        <ReportSH req>Goals Before Next Visit</ReportSH>
        <ReportTA rows={4} value={form.goalsNextVisit} onChange={e=>sf("goalsNextVisit",e.target.value)}
          placeholder="Specific goals for the apprentice to work toward before the next visit…"/>
        <ReportSH req>Comments and Feedback</ReportSH>
        <ReportTA rows={5} value={form.commentsFeedback} onChange={e=>sf("commentsFeedback",e.target.value)}
          placeholder="Overall summary, observations, any concerns or positive feedback…"/>
      </div>

      {/* Bottom table — Licence Expiry / Next Visit / KTA Rep */}
      <div style={{border:`1px solid ${T.border}`,borderTop:"none"}}>
        {[
          {label:"Licence Expiry",      content:<div style={{padding:"6px",fontSize:13,fontWeight:600,
            color: apprentice.licenceExpiry && new Date(apprentice.licenceExpiry+"T00:00:00")<new Date() ? T.red : T.ink}}>
            {apprentice.licenceExpiry ? fD(apprentice.licenceExpiry) : "Not set"}</div>},
          {label:"Date of Next Visit",  content:<input type="date" value={form.nextVisitDate} onChange={e=>sf("nextVisitDate",e.target.value)}
            style={{border:"none",fontSize:13,width:"100%",outline:"none",padding:"6px",fontFamily:"DM Sans,sans-serif",background:"transparent"}}/>},
          {label:"KTA Representative",  content:<div style={{padding:"6px",fontSize:13,fontWeight:600}}>{mentor.name}</div>},
        ].map(({label,content})=>(
          <div key={label} style={{display:"grid",gridTemplateColumns:"180px 1fr",borderBottom:`1px solid ${T.border}`}}>
            <div style={{padding:"10px 12px",fontWeight:700,fontSize:13,borderRight:`1px solid ${T.border}`,background:"#f5f7fa"}}>{label}</div>
            <div>{content}</div>
          </div>
        ))}
      </div>

      {/* Email notice + save */}
      <div style={{padding:"14px 16px",background:T.bg,borderTop:`1px solid ${T.border}`}}>
        <div style={{fontSize:12,color:T.accent,marginBottom:12,padding:"8px 12px",
          background:T.accentL,borderRadius:7,border:`1px solid ${T.accent}33`}}>
          📧 On save this report will be emailed to:
          <strong> {apprentice.name}</strong>{apprentice.email?` (${apprentice.email})`:` — ⚠ no email set`}
          {approver&&<>, <strong>{approver.name}</strong>{approver.email?` (${approver.email})`:` — ⚠ no email set`}</>}
          {!approver&&<span style={{color:T.warn}}> — ⚠ no approver linked to this apprentice</span>}
        </div>
        {emailStatus==="sending"&&<div style={{background:T.warnL,border:`1px solid ${T.warn}44`,borderRadius:7,padding:"8px 12px",marginBottom:10,fontSize:12,color:T.warn}}>⏳ Sending emails…</div>}
        {emailStatus==="sent"&&<div style={{background:T.tealL,border:`1px solid ${T.teal}44`,borderRadius:7,padding:"8px 12px",marginBottom:10,fontSize:12,color:T.teal}}>✓ Saved and emailed!</div>}
        {emailStatus==="error"&&<div style={{background:T.redL,border:`1px solid ${T.red}44`,borderRadius:7,padding:"8px 12px",marginBottom:10,fontSize:12,color:T.red}}>⚠ Report saved but email failed — check Edge Function deployment.</div>}
        <div style={{display:"flex",gap:8}}>
          <Btn onClick={handleSave} disabled={saving}>{saving?"Saving…":"💾 Save & Email Report"}</Btn>
          <Btn v="ghost" onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Past Meeting Reports ──────────────────────────────────────────────────────
function PastMeetingReports({apprentice, allUsers, canEdit=false}) {
  const [reports, setReports]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [expandId, setExpandId] = useState(null);

  useEffect(()=>{
    loadTable('meeting_reports')
      .then(rows=>setReports(rows.filter(r=>r.apprentice_id===apprentice.id).sort((a,b)=>b.date.localeCompare(a.date))))
      .catch(()=>setReports([]))
      .finally(()=>setLoading(false));
  },[apprentice.id]);

  const handleDelete = async (id) => {
    if(!window.confirm("Delete this meeting report?")) return;
    await deleteRow('meeting_reports', id).catch(console.error);
    setReports(prev=>prev.filter(r=>r.id!==id));
  };

  const fD = (iso) => { if(!iso) return "—"; try{ const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }catch{ return iso; } };

  const Section = ({label,value}) => value ? (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:11,fontWeight:700,color:T.dark,textTransform:"uppercase",
        letterSpacing:".6px",marginBottom:3,paddingBottom:3,borderBottom:`1px solid ${T.border}`}}>{label}</div>
      <div style={{fontSize:13,color:T.ink,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{value}</div>
    </div>
  ) : null;

  if(loading) return <div style={{padding:24,textAlign:"center",color:T.muted,fontSize:13}}>Loading reports…</div>;

  return (
    <div>
      {reports.length===0&&(
        <div style={{padding:"24px 0",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>No check in reports yet</div>
      )}
      {reports.map(r=>{
        const mentorUser = allUsers.find(u=>u.id===r.mentor_id);
        const isOpen = expandId===r.id;
        return (
          <div key={r.id} style={{border:`1.5px solid ${T.border}`,borderRadius:10,marginBottom:10,overflow:"hidden"}}>
            <div onClick={()=>setExpandId(isOpen?null:r.id)} style={{
              display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
              background:isOpen?T.dark:T.surface,cursor:"pointer",
              borderBottom:isOpen?`1px solid ${T.border}`:"none",transition:"background .15s"}}>
              <div style={{width:34,height:34,borderRadius:8,
                background:isOpen?"#ffffff20":T.accentL,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>📋</div>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14,color:isOpen?"#fff":T.ink}}>
                  {fD(r.date)}{r.location?` — ${r.location}`:""}
                </div>
                <div style={{fontSize:12,color:isOpen?"#ffffff88":T.sub,marginTop:1}}>
                  {mentorUser?.name||"Unknown"} · KTA Representative
                  {r.next_visit_date&&<span style={{marginLeft:8}}>Next visit: {fD(r.next_visit_date)}</span>}
                </div>
              </div>
              <div style={{fontSize:11,color:isOpen?"#ffffff66":T.muted}}>{isOpen?"▲ collapse":"▼ view"}</div>
            </div>
            {isOpen&&(
              <div style={{padding:"16px",background:"#fff"}}>
                <Section label="Off Job Progress Since Last Visit" value={r.off_job_progress}/>
                <Section label="On Job Progress Since Last Visit"  value={r.on_job_progress}/>
                <Section label="Previous Goals"                    value={r.previous_goals}/>
                <Section label="Goals Before Next Visit"           value={r.goals_this_meeting}/>
                <Section label="Comments and Feedback"             value={r.comments_feedback}/>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginTop:12,
                  padding:"10px 12px",background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>
                  {[
                    {label:"Licence Expiry",      value: apprentice.licenceExpiry ? fD(apprentice.licenceExpiry) : "Not set"},
                    {label:"Date of Next Visit",  value: r.next_visit_date ? fD(r.next_visit_date) : "TBC"},
                    {label:"KTA Representative",  value: mentorUser?.name||"—"},
                  ].map(({label,value})=>(
                    <div key={label}>
                      <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>{label}</div>
                      <div style={{fontSize:13,fontWeight:600,color:T.ink}}>{value}</div>
                    </div>
                  ))}
                </div>
                {canEdit&&(
                  <button onClick={()=>handleDelete(r.id)} style={{
                    marginTop:12,fontSize:12,color:T.red,background:"none",
                    border:`1px solid ${T.red}44`,borderRadius:6,padding:"4px 12px",
                    cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>🗑 Delete Report</button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── PPE Allocation ────────────────────────────────────────────────────────────
const PPE_ITEMS = ["Hard Hat","High-Vis Vest","Safety Boots","Safety Glasses","Gloves","Ear Protection","Dust Mask / P2 Respirator","Harness","Knee Pads","Face Shield","First Aid Kit","Other"];

function PPEAllocation({apprentice, mentor, canEdit=false}) {
  const [allocations, setAllocations] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm] = useState({item:"Hard Hat", quantity:"1", issuedDate: new Date().toISOString().slice(0,10), notes:""});
  const [saving, setSaving] = useState(false);
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));

  useEffect(()=>{
    loadTable('ppe_allocations')
      .then(rows=>setAllocations(rows.filter(r=>r.apprentice_id===apprentice.id).sort((a,b)=>b.issued_date.localeCompare(a.issued_date))))
      .catch(()=>setAllocations([]))
      .finally(()=>setLoading(false));
  },[apprentice.id]);

  const handleAdd = async () => {
    if(!form.item) return;
    setSaving(true);
    const row = {
      id: uid(),
      apprentice_id: apprentice.id,
      mentor_id: mentor.id,
      item: form.item,
      quantity: parseInt(form.quantity)||1,
      issued_date: form.issuedDate,
      notes: form.notes.trim(),
      created_at: new Date().toISOString(),
    };
    try {
      await upsertRow('ppe_allocations', row);
      setAllocations(prev=>[row,...prev]);
      setShowForm(false);
      setForm({item:"Hard Hat",quantity:"1",issuedDate:new Date().toISOString().slice(0,10),notes:""});
    } catch(e) { alert("Failed: "+e.message); }
    setSaving(false);
  };

  const handleDelete = async (id) => {
    if(!window.confirm("Remove this PPE record?")) return;
    await deleteRow('ppe_allocations', id).catch(console.error);
    setAllocations(prev=>prev.filter(r=>r.id!==id));
  };

  const fmtDate = (iso) => { if(!iso) return "—"; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };

  if(loading) return <div style={{padding:16,textAlign:"center",color:T.muted,fontSize:13}}>Loading…</div>;

  return (
    <div>
      {canEdit&&(
        <div style={{marginBottom:14}}>
          {!showForm
            ? <Btn sm onClick={()=>setShowForm(true)}>+ Issue PPE Item</Btn>
            : (
              <Card style={{border:`1.5px solid ${T.accent}44`,marginBottom:0}}>
                <div style={{fontWeight:700,fontSize:13,marginBottom:12}}>Issue PPE to {apprentice.name}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 80px",gap:10,marginBottom:10}}>
                  <div>
                    <FL req>Item</FL>
                    <select value={form.item} onChange={e=>sf("item",e.target.value)}>
                      {PPE_ITEMS.map(i=><option key={i}>{i}</option>)}
                    </select>
                  </div>
                  <div><FL>Qty</FL><input type="number" min="1" value={form.quantity} onChange={e=>sf("quantity",e.target.value)}/></div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                  <div><FL>Date Issued</FL><input type="date" value={form.issuedDate} onChange={e=>sf("issuedDate",e.target.value)}/></div>
                  <div><FL>Notes</FL><input placeholder="Size, colour, condition…" value={form.notes} onChange={e=>sf("notes",e.target.value)}/></div>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <Btn sm onClick={handleAdd} disabled={saving}>{saving?"Saving…":"Save"}</Btn>
                  <Btn sm v="ghost" onClick={()=>setShowForm(false)}>Cancel</Btn>
                </div>
              </Card>
            )
          }
        </div>
      )}

      {allocations.length===0&&!showForm&&(
        <div style={{padding:"16px 0",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>No PPE issued yet</div>
      )}

      {allocations.length>0&&(
        <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 50px 110px 1fr 36px",
            padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
            fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
            <span>Item</span><span style={{textAlign:"center"}}>Qty</span><span>Date Issued</span><span>Notes</span><span/>
          </div>
          {allocations.map((r,i)=>(
            <div key={r.id} style={{display:"grid",gridTemplateColumns:"1fr 50px 110px 1fr 36px",
              padding:"9px 14px",gap:8,alignItems:"center",fontSize:13,
              borderBottom:i<allocations.length-1?`1px solid ${T.border}44`:"none",
              background:i%2===0?T.surface:T.bg}}>
              <div style={{fontWeight:600}}>{r.item}</div>
              <div style={{textAlign:"center",color:T.accent,fontWeight:700}}>{r.quantity}</div>
              <div style={{color:T.sub}}>{fmtDate(r.issued_date)}</div>
              <div style={{color:r.notes?T.ink:T.muted,fontStyle:r.notes?"normal":"italic",fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.notes||"—"}</div>
              <div>
                {canEdit&&(
                  <button onClick={()=>handleDelete(r.id)} style={{
                    width:28,height:28,borderRadius:6,background:"none",color:T.muted,
                    border:`1px solid ${T.border}`,cursor:"pointer",display:"flex",
                    alignItems:"center",justifyContent:"center",fontSize:13}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;}}
                    onMouseLeave={e=>{e.currentTarget.style.background="none";e.currentTarget.style.color=T.muted;}}>✕</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Apprentice Detail Page (used by both Mentor and Admin) ────────────────────
function ApprenticeDetailView({apprentice, viewer, allUsers, entries, onBack, isAdmin=false}) {
  const [showMeetingForm, setShowMeetingForm] = useState(false);
  const [showPastReports, setShowPastReports] = useState(false);
  const [showPPE, setShowPPE]                 = useState(false);
  const [showActivity, setShowActivity]       = useState(false);
  const [meetingKey, setMeetingKey]           = useState(0);
  const [lastVisit, setLastVisit]             = useState(null);
  const [loadingVisit, setLoadingVisit]       = useState(true);
  const [reports, setReports]                 = useState([]);
  const [showPersonal, setShowPersonal]       = useState(false);

  useEffect(()=>{
    loadTable('meeting_reports')
      .then(rows=>{
        const sorted = rows.filter(r=>r.apprentice_id===apprentice.id).sort((a,b)=>b.date.localeCompare(a.date));
        setReports(sorted);
        setLastVisit(sorted[0]?.date||null);
      })
      .catch(()=>{ setReports([]); setLastVisit(null); })
      .finally(()=>setLoadingVisit(false));
  },[apprentice.id, meetingKey]);

  const fmtDate = (iso) => { if(!iso) return null; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };
  const daysUntil = (iso) => { if(!iso) return null; const today=new Date(); today.setHours(0,0,0,0); const exp=new Date(iso+"T00:00:00"); return Math.round((exp-today)/86400000); };

  const licDays = daysUntil(apprentice.licenceExpiry);
  const licColor = licDays===null?T.muted:licDays<0?T.red:licDays<=7?T.red:licDays<=30?T.warn:T.teal;

  const lastReport    = reports[0] || null;
  const prevReport    = reports[1] || null;

  // Timesheet entries for this apprentice (admin view)
  const appEntries = (entries||[]).filter(e=>e.userId===apprentice.id).sort((a,b)=>b.date.localeCompare(a.date));
  const approvedH  = appEntries.filter(e=>e.approval==="approved").reduce((s,e)=>s+e.netHours,0).toFixed(1);
  const submittedH = appEntries.filter(e=>e.approval==="submitted").reduce((s,e)=>s+e.netHours,0).toFixed(1);

  // Approver for this apprentice
  const approver = allUsers.find(u=>
    u.id===apprentice.approverUserId ||
    (u.role==="Approver"&&(u.allocatedTo||[]).includes(apprentice.id))
  );

  const ratingColor = (r) => r==="Excellent"?T.teal:r==="Good"?T.accent:r==="Satisfactory"?T.gold:r==="Needs Improvement"?T.warn:r==="Concerning"?T.red:T.muted;

  return (
    <div className="fu">
      <button onClick={onBack} style={{
        display:"inline-flex",alignItems:"center",gap:6,background:"none",border:"none",
        color:T.sub,fontSize:13,fontFamily:"DM Sans,sans-serif",cursor:"pointer",
        marginBottom:16,padding:0,fontWeight:500}}
        onMouseEnter={e=>e.currentTarget.style.color=T.ink}
        onMouseLeave={e=>e.currentTarget.style.color=T.sub}>
        ← {isAdmin?"Back to Dashboard":"Back to My Apprentices"}
      </button>

      {/* ── Card 1: Apprentice Summary ── */}
      <Card style={{marginBottom:16,border:`2px solid ${T.dark}33`}}>
        <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:16,
          paddingBottom:16,borderBottom:`1px solid ${T.border}`}}>
          <div style={{width:54,height:54,borderRadius:"50%",flexShrink:0,
            background:T.dark,display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:22,fontWeight:700,color:"#fff",fontFamily:"'Libre Baskerville'"}}>
            {apprentice.name?.[0]?.toUpperCase()||"?"}
          </div>
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Libre Baskerville'",fontSize:22,fontWeight:700,color:T.ink}}>{apprentice.name}</div>
            <div style={{display:"flex",gap:8,marginTop:4,flexWrap:"wrap"}}>
              <RolePill role="Apprentice" size="sm"/>
              {approver&&<Pill label={`Approver: ${approver.name}`} size="sm" color={T.warn} bg={T.warnL}/>}
            </div>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10}}>
          {[
            {label:"Trade",            value:apprentice.trade||"Not set",   icon:"🔧", bg:T.accentL,  valColor:T.accent},
            {label:"Licence Expiry",
              value:apprentice.licenceExpiry
                ?(licDays!==null?`${fmtDate(apprentice.licenceExpiry)} (${licDays<0?"Expired":licDays===0?"Today":`${licDays}d`})`:fmtDate(apprentice.licenceExpiry))
                :"Not set",
              icon:"📄",
              bg:licDays===null?T.bg:licDays<=7?T.redL:licDays<=30?T.warnL:T.tealL,
              valColor:licColor},
            {label:"Last Mentor Visit",value:loadingVisit?"…":lastVisit?fmtDate(lastVisit):"No visits yet",icon:"📅",bg:T.tealL,valColor:T.teal},
          ].map(({label,value,icon,bg,valColor})=>(
            <div key={label} style={{background:bg,borderRadius:10,padding:"10px 14px",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:4}}>{icon} {label}</div>
              <div style={{fontSize:13,fontWeight:700,color:valColor,wordBreak:"break-all",lineHeight:1.4}}>{value}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Personal Details card ── */}
      <Card style={{marginBottom:16,cursor:"pointer"}} onClick={()=>setShowPersonal(s=>!s)}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontWeight:700,fontSize:14,display:"flex",alignItems:"center",gap:8}}>
            <span>👤</span> Personal Details
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.muted} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{transition:"transform .2s",transform:showPersonal?"rotate(180deg)":"rotate(0deg)"}}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        {showPersonal && (
          <div onClick={e=>e.stopPropagation()} style={{marginTop:14}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:0}}>
              {[
                {label:"Email",        value:apprentice.email,        icon:"✉"},
                {label:"Phone",        value:apprentice.phone,        icon:"📞"},
                {label:"Start Date",   value:apprentice.startDate   ? fmtDate(apprentice.startDate)   : null, icon:"📅"},
                {label:"Date of Birth",value:apprentice.dateOfBirth ? fmtDate(apprentice.dateOfBirth) : null, icon:"🎂"},
                {label:"Gender",       value:apprentice.gender,       icon:"⚧"},
                {label:"Host Business",value:apprentice.hostBusiness, icon:"🏢"},
              ].map(({label,value,icon})=>(
                <div key={label} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"9px 0",
                  borderBottom:`1px solid ${T.border}`}}>
                  <span style={{fontSize:15,marginTop:1,width:20,textAlign:"center",flexShrink:0}}>{icon}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>{label}</div>
                    <div style={{fontSize:13,color:value?T.ink:T.muted,fontStyle:value?"normal":"italic"}}>{value||"Not set"}</div>
                  </div>
                </div>
              ))}
            </div>
            {(apprentice.address||apprentice.city||apprentice.suburb||apprentice.postcode) && (
              <div style={{display:"flex",alignItems:"flex-start",gap:10,paddingTop:9}}>
                <span style={{fontSize:15,marginTop:1,width:20,textAlign:"center",flexShrink:0}}>📍</span>
                <div>
                  <div style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>Address</div>
                  <div style={{fontSize:13,color:T.ink,lineHeight:1.6}}>
                    {[apprentice.address, apprentice.addressLine2, apprentice.suburb, apprentice.city, apprentice.postcode].filter(Boolean).join(", ")}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── Goals cards (side by side if both exist) ── */}
      <div style={{display:"grid",gridTemplateColumns:prevReport?"1fr 1fr":"1fr",gap:12,marginBottom:16}}>
        {/* Goals from last meeting */}
        <Card style={{border:`1.5px solid ${T.accent}33`}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
            <div style={{width:32,height:32,borderRadius:8,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>🎯</div>
            <div>
              <div style={{fontWeight:700,fontSize:14}}>Goals from Last Meeting</div>
              {lastReport&&<div style={{fontSize:11,color:T.sub}}>{fmtDate(lastReport.date)}</div>}
            </div>
          </div>
          {lastReport?.goals_this_meeting
            ? <div style={{fontSize:13,color:T.ink,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{lastReport.goals_this_meeting}</div>
            : <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>{lastReport?"No goals recorded for this visit":"No meeting reports yet"}</div>
          }
          {lastReport?.rating&&(
            <div style={{marginTop:10,display:"inline-flex",alignItems:"center",gap:6,
              background:ratingColor(lastReport.rating)+"15",borderRadius:6,padding:"3px 10px"}}>
              <span style={{fontSize:12,fontWeight:700,color:ratingColor(lastReport.rating)}}>{lastReport.rating}</span>
            </div>
          )}
        </Card>

        {/* Goals from meeting before */}
        {prevReport&&(
          <Card style={{border:`1.5px solid ${T.gold}33`}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <div style={{width:32,height:32,borderRadius:8,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>📌</div>
              <div>
                <div style={{fontWeight:700,fontSize:14}}>Goals from Previous Meeting</div>
                <div style={{fontSize:11,color:T.sub}}>{fmtDate(prevReport.date)}</div>
              </div>
            </div>
            {prevReport.goals_this_meeting
              ? <div style={{fontSize:13,color:T.ink,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{prevReport.goals_this_meeting}</div>
              : <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>No goals recorded for this visit</div>
            }
            {prevReport.rating&&(
              <div style={{marginTop:10,display:"inline-flex",alignItems:"center",gap:6,
                background:ratingColor(prevReport.rating)+"15",borderRadius:6,padding:"3px 10px"}}>
                <span style={{fontSize:12,fontWeight:700,color:ratingColor(prevReport.rating)}}>{prevReport.rating}</span>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* ── Timesheet Summary (Admin only) ── */}
      {isAdmin && (
        <Card style={{marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
            <div style={{width:36,height:36,borderRadius:10,background:T.blueL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⏱</div>
            <div>
              <div style={{fontWeight:700,fontSize:15}}>Timesheet Summary</div>
              <div style={{fontSize:12,color:T.sub}}>All entries for {apprentice.name}</div>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:10,marginBottom:16}}>
            {[
              {label:"Total Entries",   value: appEntries.length,                                           color:T.accent},
              {label:"Approved Hours",  value: `${approvedH}h`,                                             color:T.teal},
              {label:"Pending (hrs)",   value: `${submittedH}h`,                                            color:T.warn},
              {label:"Drafts",          value: appEntries.filter(e=>e.approval==="draft").length,            color:T.muted},
              {label:"Declined",        value: appEntries.filter(e=>e.approval==="declined").length,         color:T.red},
            ].map(({label,value,color})=>(
              <div key={label} style={{background:T.bg,borderRadius:10,padding:"10px 14px",border:`1px solid ${T.border}`,textAlign:"center"}}>
                <div style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:4}}>{label}</div>
                <div style={{fontSize:20,fontWeight:700,color,fontFamily:"'Libre Baskerville'"}}>{value}</div>
              </div>
            ))}
          </div>
          {/* Recent entries list */}
          {appEntries.length>0&&(
            <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 70px 90px",
                padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
                <span>Date</span><span>Type / Note</span><span style={{textAlign:"center"}}>Hours</span><span>Status</span><span>Start–End</span>
              </div>
              {appEntries.slice(0,20).map((e,i)=>{
                const am = APPROVAL_META[e.approval]||APPROVAL_META.draft;
                const tm = TYPE_META[e.type]||TYPE_META["Normal Hours"];
                return (
                  <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 70px 90px",
                    padding:"9px 14px",gap:8,alignItems:"center",fontSize:13,
                    borderBottom:i<Math.min(appEntries.length,20)-1?`1px solid ${T.border}44`:"none",
                    background:i%2===0?T.surface:T.bg}}>
                    <div style={{fontWeight:600,fontSize:12}}>{fmtD(e.date)}</div>
                    <div>
                      <Pill label={e.type} size="sm" color={tm.color} bg={tm.bg}/>
                      {e.note&&<div style={{fontSize:11,color:T.muted,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note}</div>}
                    </div>
                    <div style={{textAlign:"center",fontWeight:700,color:T.accent}}>{e.netHours}h</div>
                    <Pill label={am.label} size="sm" color={am.color} bg={am.bg}/>
                    <div style={{fontSize:11,color:T.sub}}>{e.start}–{e.end}</div>
                  </div>
                );
              })}
              {appEntries.length>20&&<div style={{padding:"8px 14px",fontSize:12,color:T.muted,textAlign:"center"}}>Showing 20 of {appEntries.length} entries</div>}
            </div>
          )}
          {appEntries.length===0&&<div style={{padding:"20px 0",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>No timesheet entries yet</div>}
        </Card>
      )}

      {/* ── Meeting Reports + PPE + Activity — compact row for admin ── */}
      {isAdmin ? (
        <>
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:10, marginBottom:12}}>
            {/* New Meeting Report */}
            <button onClick={()=>{setShowMeetingForm(s=>!s); setShowPastReports(false); setShowPPE(false); setShowActivity(false);}}
              style={{width:"100%", background:showMeetingForm?T.accentL:T.surface, border:`1.5px solid ${showMeetingForm?T.accent:T.border}`, borderRadius:10, padding:"10px 12px", cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif", transition:"all .15s"}}>
              <div style={{display:"flex", alignItems:"center", gap:8}}>
                <div style={{width:28,height:28,borderRadius:7,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>📋</div>
                <div style={{minWidth:0}}>
                  <div style={{fontWeight:700, fontSize:12, color:showMeetingForm?T.accent:T.ink, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>New Report</div>
                  <div style={{fontSize:10, color:T.sub, marginTop:1}}>Record a visit</div>
                </div>
                <div style={{marginLeft:"auto", fontSize:11, color:T.muted, flexShrink:0}}>↗</div>
              </div>
            </button>
            {/* Past Reports */}
            <button onClick={()=>{setShowPastReports(s=>!s); setShowMeetingForm(false); setShowPPE(false); setShowActivity(false);}}
              style={{width:"100%", background:showPastReports?T.goldL:T.surface, border:`1.5px solid ${showPastReports?T.gold:T.border}`, borderRadius:10, padding:"10px 12px", cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif", transition:"all .15s"}}>
              <div style={{display:"flex", alignItems:"center", gap:8}}>
                <div style={{width:28,height:28,borderRadius:7,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>📁</div>
                <div style={{minWidth:0}}>
                  <div style={{fontWeight:700, fontSize:12, color:showPastReports?T.gold:T.ink, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>Past Reports</div>
                  <div style={{fontSize:10, color:T.sub, marginTop:1}}>Visit history</div>
                </div>
                <div style={{marginLeft:"auto", fontSize:11, color:T.muted, flexShrink:0}}>{showPastReports?"▲":"▼"}</div>
              </div>
            </button>
            {/* PPE */}
            <button onClick={()=>{setShowPPE(s=>!s); setShowMeetingForm(false); setShowPastReports(false); setShowActivity(false);}}
              style={{width:"100%", background:showPPE?T.tealL:T.surface, border:`1.5px solid ${showPPE?T.teal:T.border}`, borderRadius:10, padding:"10px 12px", cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif", transition:"all .15s"}}>
              <div style={{display:"flex", alignItems:"center", gap:8}}>
                <div style={{width:28,height:28,borderRadius:7,background:T.tealL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>🦺</div>
                <div style={{minWidth:0}}>
                  <div style={{fontWeight:700, fontSize:12, color:showPPE?T.teal:T.ink, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>PPE</div>
                  <div style={{fontSize:10, color:T.sub, marginTop:1}}>Equipment issued</div>
                </div>
                <div style={{marginLeft:"auto", fontSize:11, color:T.muted, flexShrink:0}}>{showPPE?"▲":"▼"}</div>
              </div>
            </button>
            {/* Activity */}
            <button onClick={()=>{setShowActivity(s=>!s); setShowMeetingForm(false); setShowPastReports(false); setShowPPE(false);}}
              style={{width:"100%", background:showActivity?T.slateL:T.surface, border:`1.5px solid ${showActivity?T.slate:T.border}`, borderRadius:10, padding:"10px 12px", cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif", transition:"all .15s"}}>
              <div style={{display:"flex", alignItems:"center", gap:8}}>
                <div style={{width:28,height:28,borderRadius:7,background:T.slateL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>📬</div>
                <div style={{minWidth:0}}>
                  <div style={{fontWeight:700, fontSize:12, color:showActivity?T.slate:T.ink, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>Activity</div>
                  <div style={{fontSize:10, color:T.sub, marginTop:1}}>Emails & notes</div>
                </div>
                <div style={{marginLeft:"auto", fontSize:11, color:T.muted, flexShrink:0}}>{showActivity?"▲":"▼"}</div>
              </div>
            </button>
          </div>

          {/* Expanded panels */}
          {showMeetingForm && (
            <ReportFullscreenModal
              apprentice={apprentice}
              mentor={viewer}
              allUsers={allUsers}
              meetingKey={meetingKey}
              onSave={()=>{ setShowMeetingForm(false); setMeetingKey(k=>k+1); }}
              onClose={()=>setShowMeetingForm(false)}
            />
          )}
          {showPastReports && (
            <Card style={{marginBottom:16}}>
              <PastMeetingReports key={meetingKey} apprentice={apprentice} allUsers={allUsers} canEdit={true}/>
            </Card>
          )}
          {showPPE && (
            <Card style={{marginBottom:16}}>
              <PPEAllocation apprentice={apprentice} mentor={viewer} canEdit={true}/>
            </Card>
          )}
          {showActivity && apprentice.email && (
            <Card style={{marginBottom:16}}>
              <EmailActivityFeed
                personEmail={apprentice.email}
                personName={apprentice.name}
                personId={apprentice.id}
                canEdit={true}
                extraItems={reports.map(r=>({
                  id: r.id,
                  created_at: r.created_at||r.date+"T12:00:00",
                  date: r.date,
                  label: `Meeting Report — ${r.date ? (()=>{const [y,m,d]=r.date.split('-');return`${d}/${m}/${y}`;})() : ""}`,
                  detail: r.goals_this_meeting ? `Goals: ${r.goals_this_meeting}` : r.comments_feedback||"",
                }))}
              />
            </Card>
          )}
        </>
      ) : null}

      {/* Full cards for mentor view */}
      {!isAdmin && (
        <>
          <Card style={{marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:showMeetingForm?16:0}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:36,height:36,borderRadius:10,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📋</div>
                <div>
                  <div style={{fontWeight:700,fontSize:15}}>New Meeting Report</div>
                  <div style={{fontSize:12,color:T.sub}}>Record a visit or check-in with {apprentice.name}</div>
                </div>
              </div>
              {!showMeetingForm&&<Btn onClick={()=>setShowMeetingForm(true)}>+ New Report</Btn>}
            </div>
            {showMeetingForm&&(
              <ReportFullscreenModal
                apprentice={apprentice}
                mentor={viewer}
                allUsers={allUsers}
                meetingKey={meetingKey}
                onSave={()=>{ setShowMeetingForm(false); setMeetingKey(k=>k+1); }}
                onClose={()=>setShowMeetingForm(false)}
              />
            )}
          </Card>
          <Card style={{marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
              <div style={{width:36,height:36,borderRadius:10,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📁</div>
              <div>
                <div style={{fontWeight:700,fontSize:15}}>Past Meeting Reports</div>
                <div style={{fontSize:12,color:T.sub}}>History of all visits with {apprentice.name}</div>
              </div>
            </div>
            <PastMeetingReports key={meetingKey} apprentice={apprentice} allUsers={allUsers} canEdit={true}/>
          </Card>
          <Card style={{marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
              <div style={{width:36,height:36,borderRadius:10,background:T.tealL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🦺</div>
              <div>
                <div style={{fontWeight:700,fontSize:15}}>PPE Allocation</div>
                <div style={{fontSize:12,color:T.sub}}>Personal protective equipment issued to {apprentice.name}</div>
              </div>
            </div>
            <PPEAllocation apprentice={apprentice} mentor={viewer} canEdit={true}/>
          </Card>
        </>
      )}

    </div>
  );
}

// Legacy wrapper for Mentor
function MentorApprenticeDetail({apprentice, mentor, allUsers, onBack}) {
  return <ApprenticeDetailView apprentice={apprentice} viewer={mentor} allUsers={allUsers} onBack={onBack} isAdmin={false} entries={[]}/>;
}

// ── Mentor Dashboard (home screen) ───────────────────────────────────────────
function MentorDashboard({currentUser, allUsers}) {
  const [selectedApprentice, setSelectedApprentice] = useState(null);
  const [apprenticeSummaries, setApprenticeSummaries] = useState({}); // id -> {lastVisit, reportCount}
  const [loadingMeta, setLoadingMeta] = useState(true);

  // Mentor's allocated apprentices — check both allocatedTo (legacy) and mentorUserId (new)
  const myApprentices = allUsers.filter(u=>
    u.role==="Apprentice" && (
      (currentUser.allocatedTo||[]).includes(u.id) ||
      u.mentorUserId===currentUser.id
    )
  ).sort((a,b)=>a.name.localeCompare(b.name));

  // Load meeting report meta for each apprentice
  useEffect(()=>{
    loadTable('meeting_reports')
      .then(rows=>{
        const map = {};
        myApprentices.forEach(app=>{
          const appRows = rows.filter(r=>r.apprentice_id===app.id).sort((a,b)=>b.date.localeCompare(a.date));
          map[app.id] = { lastVisit: appRows[0]?.date||null, reportCount: appRows.length };
        });
        setApprenticeSummaries(map);
      })
      .catch(()=>{})
      .finally(()=>setLoadingMeta(false));
  },[allUsers, currentUser.id]);

  const fmtDate = (iso) => { if(!iso) return null; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };
  const daysUntil = (iso) => { if(!iso) return null; const today=new Date(); today.setHours(0,0,0,0); const exp=new Date(iso+"T00:00:00"); return Math.round((exp-today)/86400000); };

  if(selectedApprentice) {
    return (
      <ApprenticeDetailView
        apprentice={selectedApprentice}
        viewer={currentUser}
        allUsers={allUsers}
        entries={[]}
        isAdmin={false}
        onBack={()=>setSelectedApprentice(null)}
      />
    );
  }

  const MENTOR_DEFAULT_ORDER = ["apprentices", ...(currentUser.email?.toLowerCase()===CONF_OWNER_EMAIL ? ["confidential"] : []), "resources"];
  const { order: mentorOrder, dragProps: mentorDragProps } = useDraggableOrder(currentUser.id + "_mentor", MENTOR_DEFAULT_ORDER);

  const mentorSections = {
    apprentices: (
      <DraggableSection id="apprentices" dragProps={mentorDragProps}>
        <Card>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
            <div style={{width:38,height:38,borderRadius:11,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>👷</div>
            <div>
              <div style={{fontWeight:700,fontSize:16}}>My Apprentices</div>
              <div style={{fontSize:12,color:T.sub}}>{myApprentices.length} apprentice{myApprentices.length!==1?"s":""} allocated to you</div>
            </div>
          </div>
          {myApprentices.length===0&&(
            <div style={{padding:"24px 0",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>
              No apprentices allocated to you yet — contact an Admin.
            </div>
          )}
          {myApprentices.map((app,i)=>{
            const meta   = apprenticeSummaries[app.id]||{};
            const licDays = daysUntil(app.licenceExpiry);
            const licWarn = licDays!==null && licDays<=30;
            return (
              <div key={app.id} onClick={()=>setSelectedApprentice(app)}
                className="ri"
                style={{display:"flex",alignItems:"center",gap:14,padding:"12px 4px",
                  borderBottom:i<myApprentices.length-1?`1px solid ${T.border}44`:"none",
                  cursor:"pointer",borderRadius:8,animationDelay:`${i*.04}s`}}
                onMouseEnter={e=>e.currentTarget.style.background=T.accentL+"66"}
                onMouseLeave={e=>e.currentTarget.style.background="none"}>
                <Avatar name={app.name} role="Apprentice" size={42}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:14,color:T.accent}}>{app.name}</div>
                  <div style={{fontSize:12,color:T.sub,marginTop:1,display:"flex",gap:10,flexWrap:"wrap"}}>
                    {app.trade&&<span>🔧 {app.trade}</span>}
                    {app.hostBusiness&&<span>🏢 {app.hostBusiness}</span>}
                    {meta.lastVisit&&<span>📅 Last visit {fmtDate(meta.lastVisit)}</span>}
                    {!meta.lastVisit&&!loadingMeta&&<span style={{color:T.muted,fontStyle:"italic"}}>No visits yet</span>}
                    {meta.reportCount>0&&<span>📋 {meta.reportCount} report{meta.reportCount!==1?"s":""}</span>}
                    {app.licenceExpiry&&(()=>{
                      const days = daysUntil(app.licenceExpiry);
                      const color = days<0?T.red:days<=30?T.warn:T.sub;
                      const label = days<0?"Licence expired":days===0?"Expires today":`Licence ${new Date(app.licenceExpiry+"T00:00:00").toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"})}`;
                      return <span style={{color,fontWeight:days<=30?700:400}}>🪪 {label}</span>;
                    })()}
                  </div>
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4,flexShrink:0}}>
                  {licWarn&&(
                    <div style={{fontSize:11,fontWeight:700,color:licDays<0?T.red:licDays<=7?T.red:T.warn,
                      background:licDays<=7?T.redL:T.warnL,borderRadius:6,padding:"2px 8px"}}>
                      {licDays<0?"Licence expired":licDays===0?"Expires today":`Licence: ${licDays}d`}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      </DraggableSection>
    ),
    confidential: (
      <DraggableSection id="confidential" dragProps={mentorDragProps}>
        <ConfidentialNotesCard currentUser={currentUser} allUsers={allUsers}/>
      </DraggableSection>
    ),
    resources: (
      <DraggableSection id="resources" dragProps={mentorDragProps}>
        <Card>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
            <div style={{width:38,height:38,borderRadius:11,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>📂</div>
            <div>
              <div style={{fontWeight:700,fontSize:16}}>Resources</div>
              <div style={{fontSize:12,color:T.sub}}>Guides, templates, and reference materials</div>
            </div>
          </div>
          <div style={{background:T.bg,borderRadius:10,padding:"14px 16px",border:`1px dashed ${T.border}`,textAlign:"center"}}>
            <div style={{fontSize:28,marginBottom:8}}>📁</div>
            <div style={{fontWeight:600,fontSize:14,color:T.sub,marginBottom:4}}>Resource Folder Coming Soon</div>
            <div style={{fontSize:12,color:T.muted,lineHeight:1.6}}>
              This section will link to shared files, templates, and training resources.<br/>
              Contact your Admin to set up the resource folder.
            </div>
          </div>
        </Card>
      </DraggableSection>
    ),
  };

  return (
    <div className="fu">
      <div style={{marginBottom:20}}>
        <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:26,fontWeight:700,letterSpacing:"-.4px",marginBottom:4}}>
          Welcome, {currentUser.name.split(" ")[0]}
        </h1>
        <p style={{fontSize:13,color:T.sub}}>Your apprentice overview and mentor tools</p>
      </div>
      {mentorOrder.map(id => mentorSections[id] || null)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENTIAL NOTES — PIN-protected card, only visible to Kristeena

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

function ConfidentialNotesCard({ currentUser, allUsers = [] }) {
  // SHA-256 of "4444" — pre-set temporary PIN
  const TEMP_PIN_HASH = "79f06f8fde333461739f220090a23cb2a79f6d714bee100d0e4b4af249294619";
  const AUTO_LOCK_MS  = 5 * 60 * 1000;
  const LOCKOUT_MS    = 15 * 60 * 1000;

  // ALL hooks must be declared before any conditional return (React rules)
  const [phase, setPhase]           = useState("locked");
  const [pin, setPin]               = useState("");
  const [pinError, setPinError]     = useState("");
  const [wrongCount, setWrongCount] = useState(0);
  const [lockUntil, setLockUntil]   = useState(null);
  const [now, setNow]               = useState(Date.now());
  const [notes, setNotes]           = useState([]);
  const [loading, setLoading]       = useState(false);
  const [newTitle, setNewTitle]     = useState("");
  const [newBody, setNewBody]       = useState("");
  const [adding, setAdding]         = useState(false);
  const [saving, setSaving]         = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [activeTab, setActiveTab]         = useState("general"); // "general" | apprentice id
  const lockTimer  = useRef(null);
  const pinInputRef = useRef(null);

  // ── HARD IDENTITY GUARD — after hooks, returns nothing for non-Kristeena ──
  const isOwner = currentUser?.email?.toLowerCase() === CONF_OWNER_EMAIL;

  // Load PIN hash from Supabase on mount (persists across devices/browsers)
  const [pinHash,      setPinHash]      = useState(null);  // null = still loading
  const [mustChange,   setMustChange]   = useState(false);
  const [pinLoading,   setPinLoading]   = useState(true);

  useEffect(()=>{
    if(!isOwner) return;
    sb.from("users").select("conf_pin_hash,conf_pin_must_change").eq("id", currentUser.id).single()
      .then(({data})=>{
        if(!data?.conf_pin_hash) {
          // No PIN set yet — write temp PIN and must-change flag
          sb.from("users").update({conf_pin_hash: TEMP_PIN_HASH, conf_pin_must_change: true}).eq("id", currentUser.id).then(()=>{});
          setPinHash(TEMP_PIN_HASH);
          setMustChange(true);
        } else {
          setPinHash(data.conf_pin_hash);
          setMustChange(!!data.conf_pin_must_change);
          // If still using temp PIN, ensure must-change is set
          if(data.conf_pin_hash === TEMP_PIN_HASH && !data.conf_pin_must_change) {
            sb.from("users").update({conf_pin_must_change: true}).eq("id", currentUser.id).then(()=>{});
            setMustChange(true);
          }
        }
      })
      .catch(()=>{ setPinHash(TEMP_PIN_HASH); setMustChange(true); })
      .finally(()=>setPinLoading(false));
  },[isOwner]);

  useEffect(()=>{
    if(!isOwner) return;
    const t = setInterval(()=>setNow(Date.now()), 1000);
    return ()=>clearInterval(t);
  },[isOwner]);

  const resetLockTimer = useCallback(()=>{
    if(lockTimer.current) clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(()=>{ setPhase("locked"); setPin(""); }, AUTO_LOCK_MS);
  },[]);

  useEffect(()=>{ if(phase==="unlocked") resetLockTimer(); return ()=>{ if(lockTimer.current) clearTimeout(lockTimer.current); }; },[phase,resetLockTimer]);

  useEffect(()=>{
    if(phase!=="unlocked" || !isOwner) return;
    setLoading(true);
    loadTable("confidential_notes")
      .then(rows=>setNotes((rows||[]).sort((a,b)=>b.created_at?.localeCompare(a.created_at||"")||0)))
      .catch(()=>setNotes([]))
      .finally(()=>setLoading(false));
  },[phase, isOwner]);

  const apprentices = allUsers.filter(u=>u.role==="Apprentice").sort((a,b)=>a.name.localeCompare(b.name));

  // ── GUARD: render nothing for anyone other than Kristeena ──────────────────
  if(!isOwner) return null;
  if(pinLoading) return (
    <Card style={{padding:"24px 20px",textAlign:"center",color:T.muted,fontSize:13}}>
      Loading secure notes…
    </Card>
  );

  const handlePinKey = (digit) => {
    if(lockUntil && lockUntil > Date.now()) return;
    const next = (pin + digit).slice(0, 4);
    setPin(next);
    setPinError("");
    if(next.length === 4) setTimeout(()=>verifyPin(next), 80);
  };

  const verifyPin = async (attempt) => {
    const hash = await sha256hex(attempt);
    if(hash === pinHash) {
      if(mustChange) {
        setPhase("change"); setPin(""); setPinError("");
      } else {
        setPhase("unlocked"); setPin(""); setWrongCount(0); setPinError("");
      }
    } else {
      const wc = wrongCount + 1;
      setWrongCount(wc);
      setPin("");
      if(wc >= 3) {
        const lu = Date.now() + LOCKOUT_MS;
        setLockUntil(lu);
        setPinError("Too many attempts — locked for 15 minutes.");
        setWrongCount(0);
      } else {
        setPinError(`Incorrect PIN (${3-wc} attempt${3-wc===1?"":"s"} remaining)`);
      }
    }
  };

  const [newPin, setNewPin]         = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [changingStep, setChangingStep] = useState("new"); // "new" | "confirm"

  const handleChangePinKey = (digit) => {
    if(changingStep === "new") {
      const next = (newPin + digit).slice(0, 4);
      setNewPin(next); setPinError("");
      if(next.length === 4) { setTimeout(()=>setChangingStep("confirm"), 150); }
    } else {
      const next = (confirmPin + digit).slice(0, 4);
      setConfirmPin(next); setPinError("");
      if(next.length === 4) { setTimeout(()=>confirmChangePin(next), 80); }
    }
  };

  const confirmChangePin = async (attempt) => {
    if(attempt !== newPin) {
      setPinError("PINs don't match — try again.");
      setNewPin(""); setConfirmPin(""); setChangingStep("new");
      return;
    }
    if(attempt === "4444") {
      setPinError("You must choose a different PIN from the temporary one.");
      setNewPin(""); setConfirmPin(""); setChangingStep("new");
      return;
    }
    const hash = await sha256hex(attempt);
    await sb.from("users").update({conf_pin_hash: hash, conf_pin_must_change: false}).eq("id", currentUser.id);
    setPinHash(hash); setMustChange(false);
    setPhase("unlocked"); setNewPin(""); setConfirmPin(""); setChangingStep("new"); setPinError("");
  };

  const setupPin = async () => {
    if(pin.length < 4) return;
    const hash = await sha256hex(pin);
    await sb.from("users").update({conf_pin_hash: hash, conf_pin_must_change: false}).eq("id", currentUser.id);
    setPinHash(hash); setMustChange(false);
    setPhase("locked"); setPin(""); setPinError("PIN set — please enter it to unlock.");
  };

  const addNote = async () => {
    if(!newTitle.trim() && !newBody.trim()) return;
    setSaving(true);
    const row = {
      id: uid(),
      owner_id: currentUser.id,
      apprentice_id: activeTab === "general" ? null : activeTab,
      title: newTitle.trim()||"Untitled",
      body: newBody.trim(),
      created_at: new Date().toISOString()
    };
    await upsertRow("confidential_notes", row).catch(console.error);
    setNotes(prev=>[row,...prev]);
    setNewTitle(""); setNewBody(""); setAdding(false);
    setSaving(false); resetLockTimer();
  };

  const deleteNote = async (id) => {
    await deleteRow("confidential_notes", id).catch(console.error);
    setNotes(prev=>prev.filter(n=>n.id!==id));
    setDeleteConfirm(null); resetLockTimer();
  };

  const lockedSecs = lockUntil ? Math.max(0, Math.ceil((lockUntil - now)/1000)) : 0;
  const isLockedOut = lockUntil && lockUntil > now;

  // ── Styles ──
  const cardStyle = { background:"#fff", borderRadius:14, border:`1.5px solid #c084fc55`,
    boxShadow:"0 2px 18px #a855f711", padding:24, marginBottom:16 };
  const headerStyle = { display:"flex", alignItems:"center", gap:12, marginBottom:20 };
  const iconBox = { width:42, height:42, borderRadius:12, background:"#f3e8ff",
    display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 };
  const pinBtn = (d) => ({
    width:64, height:64, borderRadius:12, border:`1.5px solid #d8b4fe`,
    background:"#faf5ff", color:"#6b21a8", fontSize:22, fontWeight:700,
    cursor: isLockedOut?"not-allowed":"pointer", fontFamily:"DM Sans,sans-serif",
    transition:"all .1s", opacity: isLockedOut ? 0.4 : 1,
  });
  const dotStyle = (filled) => ({
    width:14, height:14, borderRadius:"50%",
    background: filled ? "#9333ea" : "#e9d5ff",
    transition:"background .15s",
  });

  // ── Locked / Setup view ──
  const renderPinScreen = () => {
    if(phase === "change") {
      const activePin = changingStep === "new" ? newPin : confirmPin;
      return (
        <div style={{textAlign:"center", padding:"8px 0 4px"}}>
          <div style={{background:"#fef3c7", border:"1.5px solid #f59e0b", borderRadius:10, padding:"10px 16px", marginBottom:18}}>
            <div style={{fontSize:13, fontWeight:700, color:"#92400e"}}>🔐 Please set a new personal PIN</div>
            <div style={{fontSize:12, color:"#78350f", marginTop:3}}>The temporary PIN must be changed before you can access your notes.</div>
          </div>
          <div style={{fontSize:13, color:"#7e22ce", marginBottom:18, fontWeight:600}}>
            {changingStep === "new" ? "Enter your new PIN" : "Confirm your new PIN"}
          </div>
          <div style={{display:"flex", gap:12, justifyContent:"center", marginBottom:20}}>
            {[0,1,2,3].map(i=><div key={i} style={dotStyle(activePin.length>i)}/>)}
          </div>
          <div style={{display:"inline-grid", gridTemplateColumns:"repeat(3,64px)", gap:10, marginBottom:16}}>
            {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d,i)=>(
              d===""
                ? <div key={i}/>
                : <button key={i} style={pinBtn(d)}
                    onClick={()=>d==="⌫"
                      ? (changingStep==="new" ? setNewPin(p=>p.slice(0,-1)) : setConfirmPin(p=>p.slice(0,-1)))
                      : handleChangePinKey(d)}>
                    {d}
                  </button>
            ))}
          </div>
          {changingStep === "confirm" && (
            <div style={{fontSize:12, color:"#6b7280", marginBottom:8}}>Re-enter the same PIN to confirm</div>
          )}
          {pinError && <div style={{fontSize:12, color:"#b91c1c", marginTop:10, fontWeight:600}}>{pinError}</div>}
        </div>
      );
    }

    return (
      <div style={{textAlign:"center", padding:"8px 0 4px"}}>
        <div style={{fontSize:13, color:"#7e22ce", marginBottom:18, fontWeight:500}}>
          Enter your 4-digit PIN
        </div>
        <div style={{display:"flex", gap:12, justifyContent:"center", marginBottom:20}}>
          {[0,1,2,3].map(i=><div key={i} style={dotStyle(pin.length>i)}/>)}
        </div>
        <div style={{display:"inline-grid", gridTemplateColumns:"repeat(3,64px)", gap:10, marginBottom:16}}>
          {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d,i)=>(
            d===""
              ? <div key={i}/>
              : <button key={i} style={pinBtn(d)}
                  onClick={()=>d==="⌫" ? setPin(p=>p.slice(0,-1)) : handlePinKey(d)}>
                  {d}
                </button>
          ))}
        </div>
        {pinError && <div style={{fontSize:12, color: isLockedOut?"#991b1b":"#b91c1c", marginTop:10, fontWeight:600}}>{pinError}</div>}
        {isLockedOut && <div style={{fontSize:12, color:"#6b7280", marginTop:6}}>Try again in {Math.floor(lockedSecs/60)}:{String(lockedSecs%60).padStart(2,"0")}</div>}
      </div>
    );
  };

  // ── Unlocked view ──
  const renderNotes = () => {
    const tabNotes = notes.filter(n =>
      activeTab === "general" ? !n.apprentice_id : n.apprentice_id === activeTab
    );
    const activeApprentice = activeTab !== "general"
      ? apprentices.find(a => a.id === activeTab) : null;

    return (
      <div onClick={resetLockTimer}>
        {/* Top bar */}
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14}}>
          <div style={{fontSize:12, color:"#9333ea", fontWeight:600}}>🔓 Unlocked · auto-locks after 5 min</div>
          <button onClick={()=>{setPhase("locked"); setPin(""); if(lockTimer.current)clearTimeout(lockTimer.current);}}
            style={{background:"#f3e8ff", color:"#6b21a8", border:"1.5px solid #d8b4fe", borderRadius:7, padding:"6px 14px", fontWeight:600, fontSize:12, cursor:"pointer", fontFamily:"DM Sans,sans-serif"}}>
            🔒 Lock
          </button>
        </div>

        {/* Tab bar */}
        <div style={{display:"flex", gap:6, flexWrap:"wrap", marginBottom:16, borderBottom:"1.5px solid #f3e8ff", paddingBottom:12}}>
          {/* General tab */}
          <button onClick={()=>{setActiveTab("general"); setAdding(false); resetLockTimer();}}
            style={{padding:"6px 14px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"DM Sans,sans-serif", border:"none",
              background: activeTab==="general" ? "#9333ea" : "#f3e8ff",
              color: activeTab==="general" ? "#fff" : "#7e22ce",
            }}>
            📋 General
            {notes.filter(n=>!n.apprentice_id).length > 0 &&
              <span style={{marginLeft:5, background: activeTab==="general"?"#ffffff33":"#e9d5ff", borderRadius:99, padding:"1px 6px", fontSize:10}}>
                {notes.filter(n=>!n.apprentice_id).length}
              </span>
            }
          </button>
          {/* One tab per apprentice */}
          {apprentices.map(app => {
            const count = notes.filter(n=>n.apprentice_id===app.id).length;
            const isActive = activeTab === app.id;
            return (
              <button key={app.id} onClick={()=>{setActiveTab(app.id); setAdding(false); resetLockTimer();}}
                style={{padding:"6px 14px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"DM Sans,sans-serif", border:"none",
                  background: isActive ? "#9333ea" : "#f3e8ff",
                  color: isActive ? "#fff" : "#7e22ce",
                  display:"flex", alignItems:"center", gap:6,
                }}>
                <span style={{width:20, height:20, borderRadius:"50%", background: isActive?"#ffffff33":"#e9d5ff",
                  display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, flexShrink:0}}>
                  {(app.firstName||app.name||"?")[0]}
                </span>
                {app.firstName||app.name.split(" ")[0]}
                {count > 0 &&
                  <span style={{background: isActive?"#ffffff33":"#e9d5ff", borderRadius:99, padding:"1px 6px", fontSize:10}}>
                    {count}
                  </span>
                }
              </button>
            );
          })}
        </div>

        {/* Tab heading */}
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14}}>
          <div>
            {activeApprentice && (
              <div style={{fontSize:13, fontWeight:700, color:"#581c87"}}>
                🔒 Private notes — {activeApprentice.name}
                <span style={{fontSize:11, color:"#9333ea", fontWeight:400, marginLeft:8}}>
                  Hidden from all other users
                </span>
              </div>
            )}
            {!activeApprentice && (
              <div style={{fontSize:13, fontWeight:700, color:"#581c87"}}>
                📋 General confidential notes
              </div>
            )}
          </div>
          <button onClick={()=>{setAdding(s=>!s); resetLockTimer();}}
            style={{background:"#9333ea", color:"#fff", border:"none", borderRadius:7, padding:"6px 14px", fontWeight:600, fontSize:12, cursor:"pointer", fontFamily:"DM Sans,sans-serif"}}>
            {adding?"✕ Cancel":"+ Add Note"}
          </button>
        </div>

        {/* Add note form */}
        {adding && (
          <div style={{background:"#faf5ff", borderRadius:10, padding:16, marginBottom:16, border:"1.5px solid #d8b4fe"}}>
            <input placeholder="Note title…" value={newTitle} onChange={e=>{setNewTitle(e.target.value);resetLockTimer();}}
              style={{width:"100%", fontWeight:700, fontSize:14, border:"none", background:"transparent", outline:"none", marginBottom:8, fontFamily:"DM Sans,sans-serif", color:"#1e1b4b"}}/>
            <textarea placeholder={`Enter confidential note${activeApprentice?` about ${activeApprentice.firstName||activeApprentice.name.split(" ")[0]}`:""}…`}
              value={newBody} onChange={e=>{setNewBody(e.target.value);resetLockTimer();}}
              rows={5} style={{width:"100%", border:"none", background:"transparent", outline:"none", fontSize:13, fontFamily:"DM Sans,sans-serif", color:"#374151", resize:"vertical", lineHeight:1.6}}/>
            <div style={{display:"flex", justifyContent:"flex-end", marginTop:8}}>
              <button onClick={addNote} disabled={saving}
                style={{background:"#9333ea", color:"#fff", border:"none", borderRadius:7, padding:"7px 18px", fontWeight:700, fontSize:13, cursor:"pointer", fontFamily:"DM Sans,sans-serif"}}>
                {saving?"Saving…":"Save Note"}
              </button>
            </div>
          </div>
        )}

        {loading && <div style={{textAlign:"center", padding:24, color:"#9ca3af", fontSize:13}}>Loading…</div>}
        {!loading && tabNotes.length===0 && !adding && (
          <div style={{textAlign:"center", padding:24, color:"#c084fc", fontSize:13, fontStyle:"italic"}}>
            {activeApprentice
              ? `No private notes for ${activeApprentice.firstName||activeApprentice.name.split(" ")[0]} yet.`
              : "No general notes yet."}
          </div>
        )}

        {tabNotes.map(n=>(
          <div key={n.id} style={{borderBottom:"1px solid #f3e8ff", padding:"14px 0"}}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start"}}>
              <div style={{fontWeight:700, fontSize:13, color:"#1e1b4b", marginBottom:4}}>{n.title}</div>
              <div style={{display:"flex", gap:6, alignItems:"center", flexShrink:0, marginLeft:12}}>
                <div style={{fontSize:11, color:"#9ca3af"}}>
                  {n.created_at ? new Date(n.created_at).toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"}) : ""}
                </div>
                {deleteConfirm===n.id
                  ? <>
                      <button onClick={()=>deleteNote(n.id)} style={{background:"#fde8e8",color:"#b91c1c",border:"1.5px solid #f87171",borderRadius:6,padding:"3px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>Confirm delete</button>
                      <button onClick={()=>setDeleteConfirm(null)} style={{background:"#f3e8ff",color:"#6b21a8",border:"1.5px solid #d8b4fe",borderRadius:6,padding:"3px 10px",fontSize:11,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>Cancel</button>
                    </>
                  : <button onClick={()=>setDeleteConfirm(n.id)} style={{background:"none",border:"none",color:"#d8b4fe",cursor:"pointer",fontSize:14,padding:"0 4px"}}>✕</button>
                }
              </div>
            </div>
            <div style={{fontSize:13, color:"#374151", lineHeight:1.7, whiteSpace:"pre-wrap"}}>{n.body}</div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <div style={iconBox}>🔐</div>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'", fontSize:16, fontWeight:700, color:"#581c87"}}>Kristeena Confidential Notes</div>
          <div style={{fontSize:12, color:"#9333ea", marginTop:2}}>PIN-protected · not visible to any other user · auto-locks</div>
        </div>
      </div>
      {phase==="unlocked" ? renderNotes() : renderPinScreen()}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BROADCAST COMPOSER — Admin + Mentor send messages to users
// ─────────────────────────────────────────────────────────────────────────────
function BroadcastComposer({users, currentUser, onSend, onClose}) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState("everyone");  // everyone | role:X | user:id
  const [sending, setSending] = useState(false);

  const roleOptions = ["Apprentice","Approver","Viewer","Mentor","Admin"];

  const getRecipients = () => {
    if(target==="everyone") return users.filter(u=>u.id!==currentUser.id).map(u=>u.id);
    if(target.startsWith("role:")) return users.filter(u=>u.role===target.slice(5)&&u.id!==currentUser.id).map(u=>u.id);
    if(target.startsWith("user:")) return [target.slice(5)];
    return [];
  };

  const send = async () => {
    if(!title.trim()||!message.trim()) return;
    setSending(true);
    const recipients = getRecipients();
    await onSend(recipients, "broadcast", title.trim(), message.trim(), currentUser.id, {});
    setSending(false);
    onClose();
  };

  const recipCount = getRecipients().length;

  return (
    <div style={{position:"fixed",inset:0,background:"#00000066",zIndex:300,
      display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
      <Card style={{width:"100%",maxWidth:480,padding:28}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>📢 Send Notification</div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:20,
            color:T.muted,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{marginBottom:14}}>
          <FL>Send to</FL>
          <select value={target} onChange={e=>setTarget(e.target.value)}>
            <option value="everyone">Everyone ({users.filter(u=>u.id!==currentUser.id).length} users)</option>
            {roleOptions.map(r=>{
              const count=users.filter(u=>u.role===r&&u.id!==currentUser.id).length;
              return count>0?<option key={r} value={`role:${r}`}>All {r}s ({count})</option>:null;
            })}
            <optgroup label="Individual">
              {users.filter(u=>u.id!==currentUser.id).map(u=>(
                <option key={u.id} value={`user:${u.id}`}>{u.name} ({u.role})</option>
              ))}
            </optgroup>
          </select>
          <div style={{fontSize:11,color:T.muted,marginTop:4}}>
            Will notify {recipCount} recipient{recipCount!==1?"s":""}
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <FL req>Title</FL>
          <input placeholder="e.g. Site closure Friday" value={title} onChange={e=>setTitle(e.target.value)} maxLength={80}/>
        </div>
        <div style={{marginBottom:20}}>
          <FL req>Message</FL>
          <textarea placeholder="Write your message here…" value={message} onChange={e=>setMessage(e.target.value)}
            rows={4} style={{width:"100%",resize:"vertical",padding:"9px 12px",
              border:`1.5px solid ${T.border}`,borderRadius:8,fontFamily:"DM Sans,sans-serif",
              fontSize:13,background:T.bg,color:T.ink,boxSizing:"border-box"}}/>
        </div>
        <div style={{display:"flex",gap:8}}>
          <Btn onClick={send} disabled={sending||!title.trim()||!message.trim()}>
            {sending?"Sending…":"📢 Send Notification"}
          </Btn>
          <Btn v="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APPRENTICE CONVERSATION HISTORY
// ─────────────────────────────────────────────────────────────────────────────
function ApprenticeConversation({apprentice, allUsers, currentUser, canManageMessages=false, onNotify}) {
  const [messages, setMessages] = useState([]);
  const [msgText, setMsgText]   = useState("");
  const [sending, setSending]   = useState(false);
  const [loadErr, setLoadErr]   = useState(null);
  const [hoverMsg, setHoverMsg] = useState(null);

  // Load messages whenever the apprentice changes
  useEffect(()=>{
    if(!apprentice?.id) return;
    setMessages([]);
    setLoadErr(null);
    loadMessages(apprentice.id)
      .then(setMessages)
      .catch(e=>setLoadErr(e.message));
  },[apprentice?.id]);

  const handleSend = async () => {
    if(!msgText.trim()||!currentUser) return;
    setSending(true);
    const msg = {
      id: uid(),
      apprentice_id: apprentice.id,
      sender_id: currentUser.id,
      body: msgText.trim(),
      created_at: new Date().toISOString(),
    };
    try {
      await insertMessage(msg);
      setMessages(prev=>[...prev, msg]);
      setMsgText("");
      if(onNotify) {
        await onNotify(
          [apprentice.id],
          "broadcast",
          `💬 Message from ${currentUser.name}`,
          msgText.trim(),
          currentUser.id,
          { messageId: msg.id }
        );
      }
    } catch(e) {
      alert("Failed to send: "+e.message);
    }
    setSending(false);
  };

  const handleDelete = async (msgId) => {
    if(!window.confirm("Permanently delete this message?")) return;
    await deleteMessage(msgId).catch(console.error);
    setMessages(prev=>prev.filter(m=>m.id!==msgId));
  };

  // Group messages by date
  const grouped = {};
  messages.forEach(m=>{
    const day = m.created_at ? m.created_at.slice(0,10) : "unknown";
    if(!grouped[day]) grouped[day]=[];
    grouped[day].push(m);
  });

  const fmtDay = (iso) => {
    if(iso==="unknown") return "Unknown date";
    const [y,m,d] = iso.split('-');
    return new Date(Date.UTC(+y,+m-1,+d)).toLocaleDateString("en-NZ",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
  };
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString("en-NZ",{hour:"2-digit",minute:"2-digit"}) : "";
  const getSender = (m) => allUsers.find(u=>u.id===m.sender_id);
  const isFromApprentice = (m) => m.sender_id === apprentice.id;

  return (
    <Card style={{marginTop:20,border:`1.5px solid ${T.border}`}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <div style={{width:34,height:34,borderRadius:10,background:T.accentL,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>💬</div>
        <div>
          <div style={{fontWeight:700,fontSize:14}}>Conversation</div>
          <div style={{fontSize:12,color:T.sub}}>
            Permanent message history with {apprentice.name}
            {canManageMessages&&<span style={{marginLeft:8,fontSize:11,color:T.muted}}>(hover a message to delete)</span>}
          </div>
        </div>
      </div>

      {loadErr&&<div style={{fontSize:12,color:T.red,marginBottom:12}}>⚠ Could not load messages: {loadErr}</div>}

      {Object.keys(grouped).length===0&&!loadErr&&(
        <div style={{padding:"24px 0",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>
          No messages yet
        </div>
      )}

      {Object.entries(grouped).map(([day, dayMsgs])=>(
        <div key={day} style={{marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{flex:1,height:1,background:T.border}}/>
            <div style={{fontSize:11,color:T.muted,fontWeight:600,whiteSpace:"nowrap"}}>{fmtDay(day)}</div>
            <div style={{flex:1,height:1,background:T.border}}/>
          </div>
          {dayMsgs.map(m=>{
            const fromApp = isFromApprentice(m);
            const sender  = getSender(m);
            return (
              <div key={m.id}
                onMouseEnter={()=>setHoverMsg(m.id)}
                onMouseLeave={()=>setHoverMsg(null)}
                style={{display:"flex",flexDirection:"column",
                  alignItems:fromApp?"flex-start":"flex-end",marginBottom:8,position:"relative"}}>
                <div style={{maxWidth:"80%",padding:"9px 13px",
                  borderRadius:fromApp?"4px 12px 12px 12px":"12px 4px 12px 12px",
                  background:fromApp?T.bg:T.accentL,
                  border:`1px solid ${fromApp?T.border:T.accent+"44"}`,position:"relative"}}>
                  <div style={{fontSize:12,color:T.ink,lineHeight:1.5,wordBreak:"break-word"}}>{m.body}</div>
                  {/* Delete button — Admin 1 only, shown on hover */}
                  {canManageMessages&&hoverMsg===m.id&&(
                    <button onClick={()=>handleDelete(m.id)} title="Delete message" style={{
                      position:"absolute",top:-8,right:-8,width:20,height:20,borderRadius:"50%",
                      background:T.red,color:"#fff",border:"none",cursor:"pointer",
                      fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",
                      lineHeight:1,fontWeight:700}}>✕</button>
                  )}
                </div>
                <div style={{fontSize:10,color:T.muted,marginTop:3,display:"flex",gap:6}}>
                  <span>{sender?.name||"Unknown"}</span>
                  {m.created_at&&<span>· {fmtTime(m.created_at)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {/* Reply box */}
      <div style={{borderTop:`1px solid ${T.border}`,paddingTop:12,marginTop:4}}>
        <textarea
          placeholder={`Message ${apprentice.name}…`}
          value={msgText}
          onChange={e=>setMsgText(e.target.value)}
          rows={2}
          style={{width:"100%",fontSize:13,padding:"9px 12px",borderRadius:8,
            border:`1.5px solid ${T.border}`,fontFamily:"DM Sans,sans-serif",
            background:T.surface,resize:"none",color:T.ink,outline:"none",boxSizing:"border-box"}}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleSend();}}}
        />
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <Btn onClick={handleSend} disabled={sending||!msgText.trim()}>
            {sending?"Sending…":"Send"}
          </Btn>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// XERO INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

// Xero Payroll NZ earnings rate IDs — these must be configured per organisation
// Admins set their own IDs in the Xero module settings
const XERO_DEFAULT_RATES = {
  "Normal Hours":   null,
  "Annual Leave":   null,
  "Sick Leave":     null,
  "Public Holiday": null,
  "Overtime":       null,
  "Block Course":   null,
  "Other":          null,
};

// Submit a single approved entry to Xero via a Supabase Edge Function proxy
// The edge function handles OAuth token management and CORS
// Calculate overtime split for an entry given apprentice settings + all entries this week
const calcOvertimeSplit = (entry, apprentice, allEntries) => {
  const { overtimeType, overtimeThreshold, overtimeRateId } = apprentice;
  if(!overtimeType || !overtimeThreshold || !overtimeRateId || entry.type !== "Normal Hours") {
    return [{ hours: entry.netHours, isOvertime: false }];
  }

  if(overtimeType === "daily") {
    const threshold = parseFloat(overtimeThreshold);
    const normal = Math.min(entry.netHours, threshold);
    const overtime = Math.max(0, entry.netHours - threshold);
    const splits = [{ hours: normal, isOvertime: false }];
    if(overtime > 0) splits.push({ hours: overtime, isOvertime: true });
    return splits;
  }

  if(overtimeType === "weekly") {
    const threshold = parseFloat(overtimeThreshold);
    // Get Mon of entry's week
    const d = new Date(entry.date + "T00:00:00");
    const day = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const monStr = mon.toISOString().slice(0,10);
    const sunStr = sun.toISOString().slice(0,10);

    // Sum all approved/submitted entries this week for this apprentice BEFORE this entry
    const weekEntries = allEntries.filter(e =>
      e.userId === apprentice.id &&
      e.date >= monStr && e.date <= sunStr &&
      e.date < entry.date && // entries before this one
      (e.approval === "approved" || e.xeroStatus === "submitted")
    );
    const hoursBeforeThis = weekEntries.reduce((s, e) => s + e.netHours, 0);
    const hoursAfterThreshold = Math.max(0, hoursBeforeThis - threshold);
    const remainingNormal = Math.max(0, threshold - hoursBeforeThis);

    if(hoursAfterThreshold >= entry.netHours) {
      // Entirely overtime
      return [{ hours: entry.netHours, isOvertime: true }];
    }
    const normal = Math.min(entry.netHours, remainingNormal);
    const overtime = Math.max(0, entry.netHours - normal);
    const splits = [];
    if(normal > 0)   splits.push({ hours: normal,   isOvertime: false });
    if(overtime > 0) splits.push({ hours: overtime, isOvertime: true  });
    return splits;
  }

  return [{ hours: entry.netHours, isOvertime: false }];
};

const submitEntryToXero = async (entry, apprentice, allEntries=[]) => {
  let xeroSettings = {};
  try {
    const {data} = await sb.from("app_settings").select("value").eq("key","xero_settings").single();
    if(data?.value) xeroSettings = JSON.parse(data.value);
  } catch {}
  const { edgeFunctionUrl, tenantId, earningsRates = {} } = xeroSettings;

  if(!edgeFunctionUrl) return { ok: false, error: "Xero not configured. Set up in the Xero module." };
  if(!tenantId)         return { ok: false, error: "Xero Tenant ID not configured." };
  if(!apprentice.xeroEmployeeId) return { ok: false, error: `No Xero Employee ID for ${apprentice.name}` };

  const normalRateId = earningsRates[entry.type];
  if(!normalRateId) return { ok: false, error: `No Xero Earnings Rate mapped for "${entry.type}"` };

  // Calculate overtime split
  const splits = calcOvertimeSplit(entry, apprentice, allEntries);
  const lines = splits.map(s => ({
    earningsRateId: s.isOvertime ? apprentice.overtimeRateId : normalRateId,
    hours: s.hours,
    isOvertime: s.isOvertime,
  }));

  const payload = {
    action:      "upsertTimesheet",
    tenantId,
    employeeId:  apprentice.xeroEmployeeId,
    date:        entry.date,
    lines,
    note:        entry.note || "",
  };

  try {
    const res = await fetch(edgeFunctionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if(!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, timesheetId: data.timesheetId };
  } catch(e) {
    return { ok: false, error: e.message };
  }
};

// ── Xero Module — Admin 1 only ────────────────────────────────────────────────
function XeroModule({allUsers, entries, currentUser, onUpdateEntries, showToast, onImportUser}) {
  const [tab, setTab]             = useState("setup");     // "setup"|"employees"|"pending"|"history"
  const [settings, setSettings]   = useState({});
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [saved, setSaved]         = useState(false);

  // Load Xero settings from Supabase on mount
  useEffect(()=>{
    sb.from("app_settings").select("value").eq("key","xero_settings").single()
      .then(({data})=>{ if(data?.value) setSettings(JSON.parse(data.value)); })
      .catch(()=>{})
      .finally(()=>setSettingsLoaded(true));
  },[]);
  const [empMap, setEmpMap]               = useState({}); // userId -> xeroEmployeeId (local edits)
  const [xeroEmployees, setXeroEmployees] = useState([]); // loaded from Xero
  const [xeroRates, setXeroRates]         = useState([]); // earnings rates loaded from Xero
  const [savingMap, setSavingMap] = useState({});


  const apprentices = allUsers.filter(u=>u.role==="Apprentice").sort((a,b)=>a.name.localeCompare(b.name));
  const approvedEntries = entries.filter(e=>e.approval==="approved")
    .sort((a,b)=>b.date.localeCompare(a.date));
  const pendingXero = approvedEntries.filter(e=>!e.xeroStatus);
  const submittedXero = approvedEntries.filter(e=>e.xeroStatus==="submitted");

  const ss = (k,v) => setSettings(s=>({...s,[k]:v}));
  const saveSettings = async () => {
    await sb.from("app_settings").upsert({key:"xero_settings", value: JSON.stringify(settings)}, {onConflict:"key"});
    setSaved(true); setTimeout(()=>setSaved(false), 2000);
  };

  const fD = (iso) => { if(!iso) return "—"; try{ const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }catch{ return iso; } };
  const xeroBlue = "#13b5ea";
  const xeroBlueDark = "#0d7bb5";

  const ENTRY_TYPE_NAMES = ["Normal Hours","Annual Leave","Sick Leave","Bereavement Leave","Leave Without Pay","Public Holiday","Overtime","Block Course","Other"];

  const TabBtn = ({id,label,count}) => (
    <button onClick={()=>setTab(id)} style={{
      padding:"8px 16px",borderRadius:8,fontSize:13,fontWeight:600,
      background: tab===id ? xeroBlue : T.bg,
      color: tab===id ? "#fff" : T.sub,
      border: tab===id ? `1.5px solid ${xeroBlueDark}` : `1.5px solid ${T.border}`,
      cursor:"pointer",fontFamily:"DM Sans,sans-serif",display:"flex",alignItems:"center",gap:6,
      transition:"all .14s"}}>
      {label}
      {count!==undefined&&<span style={{
        background: tab===id?"#ffffff33":T.border,
        color: tab===id?"#fff":T.sub,
        borderRadius:99,padding:"1px 7px",fontSize:11,fontWeight:700}}>{count}</span>}
    </button>
  );

  return (
    <div className="fu">
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:24,
        padding:"20px 24px",background:"#fff",borderRadius:14,border:`1.5px solid ${xeroBlue}33`,
        boxShadow:"0 2px 12px #13b5ea11"}}>
        <div style={{width:52,height:52,borderRadius:12,background:"#e6f7fd",
          display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:28,fontWeight:900,color:xeroBlue,fontFamily:"Georgia,serif",flexShrink:0}}>𝕏</div>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:20,fontWeight:700,color:T.ink}}>Xero Payroll Integration</div>
          <div style={{fontSize:13,color:T.sub,marginTop:2}}>
            Submit approved timesheets to Xero Payroll NZ · Admin Level 1 only
          </div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap"}}>
          <div style={{textAlign:"center",padding:"8px 16px",background:T.accentL,borderRadius:8}}>
            <div style={{fontSize:20,fontWeight:700,color:T.accent,fontFamily:"'Libre Baskerville'"}}>{pendingXero.length}</div>
            <div style={{fontSize:11,color:T.sub,fontWeight:600}}>Awaiting Xero</div>
          </div>
          <div style={{textAlign:"center",padding:"8px 16px",background:"#e6f7fd",borderRadius:8}}>
            <div style={{fontSize:20,fontWeight:700,color:xeroBlue,fontFamily:"'Libre Baskerville'"}}>{submittedXero.length}</div>
            <div style={{fontSize:11,color:T.sub,fontWeight:600}}>Submitted</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
        <TabBtn id="setup"     label="⚙ Setup & Auth"/>
        <TabBtn id="employees" label="👤 Employee Mapping" count={apprentices.filter(a=>!a.xeroEmployeeId).length||undefined}/>
        <TabBtn id="pending"   label="📤 Pending Xero Submission" count={pendingXero.length}/>
        <TabBtn id="history"   label="✓ Submission History"       count={submittedXero.length}/>
      </div>

      {/* ── Setup Tab ── */}
      {tab==="setup"&&(
        <div>
          {/* Custom connection status */}
          <div style={{background:T.tealL,border:`1.5px solid ${T.teal}55`,borderRadius:12,
            padding:"14px 18px",marginBottom:20,display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:20}}>✓</span>
            <div>
              <div style={{fontWeight:700,fontSize:13,color:T.teal}}>Xero Custom Connection</div>
              <div style={{fontSize:12,color:T.sub,marginTop:2}}>
                Using client credentials — no OAuth flow required. Save your Edge Function URL and Tenant ID below, then load earnings rates.
              </div>
            </div>
          </div>

          <Card style={{marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:16,color:T.ink}}>Connection Settings</div>
            <div style={{marginBottom:12}}>
              <FL>Supabase Edge Function URL</FL>
              <input value={settings.edgeFunctionUrl||""} onChange={e=>ss("edgeFunctionUrl",e.target.value)}
                placeholder="https://your-project.supabase.co/functions/v1/xero-proxy"/>
              <div style={{fontSize:11,color:T.muted,marginTop:3}}>The URL of your deployed xero-proxy Supabase Edge Function</div>
            </div>
            <div style={{marginBottom:16}}>
              <FL>Xero Tenant / Organisation ID</FL>
              <input value={settings.tenantId||""} onChange={e=>ss("tenantId",e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
              <div style={{fontSize:11,color:T.muted,marginTop:3}}>Found in Xero under My Xero → Connections, or via GET /connections</div>
            </div>

            <div style={{fontWeight:700,fontSize:14,marginBottom:12,marginTop:4,color:T.ink,borderTop:`1px solid ${T.border}`,paddingTop:16}}>
              Earnings Rate Mapping
            </div>
            <div style={{fontSize:12,color:T.sub,marginBottom:12,lineHeight:1.6}}>
              Map each KTA entry type to a Xero Earnings Rate. Click <strong>Load from Xero</strong> to pull your rates automatically.
            </div>
            <div style={{marginBottom:12,display:"flex",alignItems:"center",gap:10}}>
              <Btn sm onClick={async()=>{
                if(!settings.edgeFunctionUrl||!settings.tenantId){
                  alert("Save your Edge Function URL and Tenant ID first."); return;
                }
                try{
                  const res  = await fetch(settings.edgeFunctionUrl,{
                    method:"POST", headers:{"Content-Type":"application/json"},
                    body: JSON.stringify({action:"getEarningsRates",tenantId:settings.tenantId}),
                  });
                  const text = await res.text();
                  let data; try{ data=JSON.parse(text); }catch{ alert("Non-JSON response: "+text.slice(0,300)); return; }
                  if(data.ok && data.earningsRates){
                    setXeroRates(data.earningsRates);
                    showToast(`✓ Loaded ${data.earningsRates.length} earnings rates from Xero`);
                  } else { alert("Error: "+(data.error||JSON.stringify(data))); }
                }catch(e){ alert("Failed: "+e.message); }
              }}>🔄 Load Earnings Rates from Xero</Btn>
              {xeroRates.length>0&&<span style={{fontSize:12,color:T.teal,fontWeight:600}}>✓ {xeroRates.length} rates loaded</span>}
            </div>
            {ENTRY_TYPE_NAMES.map(type=>(
              <div key={type} style={{display:"grid",gridTemplateColumns:"180px 1fr",gap:10,alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:13,fontWeight:600,color:T.ink}}>{type}</div>
                {xeroRates.length > 0 ? (
                  <select value={settings.earningsRates?.[type]||""}
                    onChange={e=>ss("earningsRates",{...settings.earningsRates,[type]:e.target.value})}
                    style={{fontSize:12,padding:"5px 8px",border:`1px solid ${T.border}`,borderRadius:6,background:"#fff"}}>
                    <option value="">— Select rate —</option>
                    {xeroRates.map(r=>(
                      <option key={r.earningsRateID||r.EarningsRateID} value={r.earningsRateID||r.EarningsRateID}>{r.name||r.Name}</option>
                    ))}
                  </select>
                ) : (
                  <input value={settings.earningsRates?.[type]||""}
                    onChange={e=>ss("earningsRates",{...settings.earningsRates,[type]:e.target.value})}
                    placeholder="Load from Xero above, or paste rate ID manually"/>
                )}
              </div>
            ))}

            <div style={{marginTop:16}}>
              {saved
                ? <div style={{display:"inline-flex",alignItems:"center",gap:6,color:T.teal,fontWeight:600,fontSize:13}}>✓ Settings saved</div>
                : <Btn onClick={saveSettings}>Save Settings</Btn>
              }
            </div>
          </Card>

          {/* Edge function download */}
          <Card>
            <div style={{fontWeight:700,fontSize:15,marginBottom:12,color:T.ink}}>📦 Supabase Edge Function</div>
            <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.6}}>
              Deploy this function to Supabase to act as your Xero API proxy. It securely holds your Xero OAuth token and handles token refresh.
            </div>
            <div style={{background:"#1a1a2e",borderRadius:10,padding:"14px 16px",fontFamily:"monospace",fontSize:11,color:"#e2e8f0",lineHeight:1.6,overflowX:"auto",marginBottom:12}}>
              <div style={{color:"#64748b",marginBottom:4}}>{`// supabase/functions/xero-proxy/index.ts`}</div>
              <div style={{color:"#94a3b8"}}>{`// Deploy with: supabase functions deploy xero-proxy`}</div>
              <div>{`// Set secrets: supabase secrets set XERO_CLIENT_ID=... XERO_CLIENT_SECRET=... XERO_REFRESH_TOKEN=...`}</div>
            </div>
            <Btn v="ghost" onClick={()=>{
              const code = `// KTA Xero Proxy — Supabase Edge Function
// Deploy: supabase functions deploy xero-proxy
// Secrets: XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REFRESH_TOKEN

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE  = "https://api.xero.com/payroll.xro/2.0";

async function getAccessToken() {
  const clientId     = Deno.env.get("XERO_CLIENT_ID")!;
  const clientSecret = Deno.env.get("XERO_CLIENT_SECRET")!;
  const refreshToken = Deno.env.get("XERO_REFRESH_TOKEN")!;
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: clientId, client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed: " + await res.text());
  const data = await res.json();
  return data.access_token as string;
}

serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const { action, tenantId, employeeId, date, earningsRateId, hours } = await req.json();
    const token = await getAccessToken();
    const headers = {
      Authorization: \`Bearer \${token}\`,
      "Xero-Tenant-Id": tenantId,
      "Content-Type": "application/json",
    };

    if (action === "createTimesheet") {
      // Determine pay period (week Mon-Sun)
      const d   = new Date(date + "T00:00:00");
      const day = d.getDay(); // 0=Sun
      const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const fmt = (dt: Date) => dt.toISOString().slice(0, 10);

      // Create or update timesheet
      const tsBody = {
        EmployeeID: employeeId,
        StartDate:  "/Date(" + mon.getTime() + ")/",
        EndDate:    "/Date(" + sun.getTime() + ")/",
        Status: "DRAFT",
        TimesheetLines: [{
          EarningsRateID: earningsRateId,
          NumberOfUnits: [
            0, // Sun (index 0)
            day === 1 ? hours : 0,
            day === 2 ? hours : 0,
            day === 3 ? hours : 0,
            day === 4 ? hours : 0,
            day === 5 ? hours : 0,
            day === 6 ? hours : 0, // Sat
          ],
        }],
      };

      const res = await fetch(\`\${XERO_API_BASE}/Timesheets\`, {
        method: "POST",
        headers,
        body: JSON.stringify({ Timesheets: [tsBody] }),
      });
      const data = await res.json();
      if (!res.ok) return new Response(JSON.stringify({ error: JSON.stringify(data) }), { status: 400, headers: cors });
      const timesheetId = data.Timesheets?.[0]?.TimesheetID;
      return new Response(JSON.stringify({ ok: true, timesheetId }), { headers: cors });
    }

    if (action === "getEmployees") {
      const res = await fetch(\`\${XERO_API_BASE}/Employees\`, { headers });
      const data = await res.json();
      return new Response(JSON.stringify({ ok: true, employees: data.Employees }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
});`;
              const blob = new Blob([code],{type:"text/typescript"});
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href=url; a.download="index.ts"; a.click();
            }}>⬇ Download Edge Function (index.ts)</Btn>
          </Card>
        </div>
      )}

      {/* ── Employees Tab ── */}
      {tab==="employees"&&(
        <Card>
          {!settings.edgeFunctionUrl&&(
            <div style={{background:T.warnL,border:`1px solid ${T.warn}44`,borderRadius:8,
              padding:"10px 14px",marginBottom:16,fontSize:12,color:T.warn}}>
              ⚠ Set up your Edge Function URL and Tenant ID in the <strong>Setup</strong> tab first.
            </div>
          )}

          {/* Load from Xero button */}
          <div style={{marginBottom:20,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <Btn sm onClick={async()=>{
              if(!settings.edgeFunctionUrl||!settings.tenantId){
                alert("Please set up your Edge Function URL and Tenant ID in the Setup tab first.");
                return;
              }
              try{
                const res  = await fetch(settings.edgeFunctionUrl,{
                  method:"POST", headers:{"Content-Type":"application/json"},
                  body: JSON.stringify({action:"getEmployees",tenantId:settings.tenantId}),
                });
                const text = await res.text();
                let data; try{ data=JSON.parse(text); }catch{ alert("Non-JSON response: "+text.slice(0,300)); return; }
                if(data.ok && data.employees){
                  setXeroEmployees(data.employees);
                  showToast(`✓ Loaded ${data.employees.length} employees from Xero`);
                } else { alert("Error: " + (data.error||JSON.stringify(data))); }
              }catch(e){ alert("Failed: "+e.message); }
            }}>🔄 Load Employees from Xero</Btn>
            {xeroEmployees.length>0&&(
              <span style={{fontSize:12,color:T.teal,fontWeight:600}}>
                ✓ {xeroEmployees.length} Xero employees loaded
              </span>
            )}
          </div>

          {/* ── Section 1: Import / Merge Xero employees ── */}
          {(()=>{
            const existingXeroIds = apprentices.map(a=>a.xeroEmployeeId).filter(Boolean);
            const unlinked = xeroEmployees.filter(xe=>!existingXeroIds.includes(xe.employeeID||xe.EmployeeID));
            if(!xeroEmployees.length || !unlinked.length) return null;

            // For each unlinked Xero employee, check if an existing KTA user matches on email
            const withMatch = unlinked.map(xe => ({
              xe,
              match: allUsers.find(u =>
                xe.Email && u.email &&
                u.email.trim().toLowerCase() === xe.Email.trim().toLowerCase()
              ) || null,
            }));

            const mergeCount  = withMatch.filter(x=>x.match).length;
            const importCount = withMatch.filter(x=>!x.match).length;

            return (
              <div style={{marginBottom:24}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>⬇ Import / Merge from Xero</div>
                <div style={{fontSize:12,color:T.sub,marginBottom:12,lineHeight:1.6}}>
                  These Xero employees are not yet linked to KTA.
                  {mergeCount>0 && <> <span style={{color:T.teal,fontWeight:600}}>{mergeCount} email match{mergeCount>1?"es":""}</span> found — merging will link their Xero ID and fill any missing fields.</>}
                  {importCount>0 && <> <span style={{color:xeroBlue,fontWeight:600}}>{importCount} new</span> will be created as Apprentices.</>}
                </div>
                <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 110px",
                    padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                    fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:10}}>
                    <span>Xero Employee</span><span>Email</span><span>KTA Match</span><span></span>
                  </div>
                  {withMatch.map(({xe,match},i)=>(
                    <div key={xe.employeeID||xe.EmployeeID} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 110px",
                      padding:"10px 14px",gap:10,alignItems:"center",fontSize:13,
                      borderBottom:i<withMatch.length-1?`1px solid ${T.border}44`:"none",
                      background:match?`${T.tealL}55`:i%2===0?T.surface:T.bg}}>
                      <div style={{fontWeight:600}}>{xe.firstName||xe.FirstName} {xe.lastName||xe.LastName}</div>
                      <div style={{fontSize:11,color:T.sub,wordBreak:"break-all"}}>{xe.Email||<span style={{color:T.muted}}>—</span>}</div>
                      <div style={{fontSize:11}}>
                        {match
                          ? <span style={{color:T.teal,fontWeight:600,display:"flex",alignItems:"center",gap:4}}>
                              <span style={{width:6,height:6,borderRadius:"50%",background:T.teal,display:"inline-block"}}/>
                              {match.name}
                            </span>
                          : <span style={{color:T.muted}}>No match — new</span>
                        }
                      </div>
                      <button onClick={async()=>{
                        const phone = (xe.PhoneNumber && !xe.PhoneNumber.includes('@')) ? xe.PhoneNumber : "";
                        try {
                          if(match) {
                            // ── MERGE: link Xero ID + fill empty fields on existing user ──
                            const updates = { xero_employee_id: xe.employeeID||xe.EmployeeID };
                            if(!match.email    && xe.Email)      updates.email    = xe.Email;
                            if(!match.phone    && phone)         updates.phone    = phone;
                            if(!match.trade    && xe.JobTitle)   updates.trade    = xe.JobTitle;
                            if(!match.address  && xe.Address1)   updates.address  = xe.Address1;
                            if(!match.suburb   && xe.Suburb)     updates.suburb   = xe.Suburb;
                            if(!match.city     && xe.City)       updates.city     = xe.City;
                            if(!match.postcode && xe.PostCode)   updates.postcode = xe.PostCode;
                            await updateRow('users', match.id, updates);
                            onImportUser({...match, xeroEmployeeId: xe.employeeID||xe.EmployeeID, ...Object.fromEntries(
                              Object.entries(updates).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v])
                            )});
                            setXeroEmployees(prev=>prev.filter(e=>e.EmployeeID!==xe.employeeID||xe.EmployeeID));
                            showToast(`✓ Merged Xero data into ${match.name}`);
                          } else {
                            // ── IMPORT: create new Apprentice ──
                            const newId = uid();
                            const xeEmail = xe.Email||"";
                            const xePhone = (xe.PhoneNumber||"").includes('@') ? "" : (xe.PhoneNumber||"");
                            const xeFirst = xe.FirstName||"";
                            const xeLast  = xe.LastName||"";
                            const xeXid   = xe.EmployeeID;
                            const xeDob   = xe.DateOfBirth ? xe.DateOfBirth.slice(0,10) : "";
                            const newUser = {
                              id: newId, name: `${xeFirst} ${xeLast}`.trim(),
                              firstName: xeFirst, lastName: xeLast,
                              email: xeEmail, phone: xePhone,
                              trade: xe.JobTitle||"", hostBusiness: "",
                              address: xe.AddressLine1||"",
                              addressLine2: xe.AddressLine2||"",
                              suburb: xe.Suburb||"", city: xe.City||"",
                              postcode: xe.PostCode||"",
                              dateOfBirth: xeDob, gender: xe.Gender||"",
                              startDate: xe.StartDate ? xe.StartDate.slice(0,10) : "",
                              licenceExpiry:"", xeroEmployeeId: xeXid,
                              role:"Apprentice", password:"changeme123", allocatedTo:[], adminLevel:1,
                            };
                            await upsertRow('users', {
                              id: newId, name: newUser.name,
                              first_name: xeFirst, last_name: xeLast,
                              email: xeEmail || null, phone: xePhone || null, role:"Apprentice",
                              password:"changeme123", allocated_to:[],
                              trade: xe.JobTitle||null, host_business: null,
                              address: xe.AddressLine1||null,
                              address_line2: xe.AddressLine2||null,
                              suburb: xe.Suburb||null, city: xe.City||null,
                              postcode: xe.PostCode||null,
                              date_of_birth: xeDob||null,
                              gender: xe.Gender||null,
                              start_date: xe.StartDate ? xe.StartDate.slice(0,10) : null,
                              licence_expiry: null,
                              xero_employee_id: xeXid, admin_level:1,
                            });
                            onImportUser(newUser);
                            setXeroEmployees(prev=>prev.filter(e=>e.EmployeeID!==xeXid));
                            showToast(`✓ ${xeFirst} ${xeLast} imported as Apprentice`);
                          }
                        } catch(e) { alert((match?"Merge":"Import")+" failed: "+e.message); }
                      }} style={{fontSize:12,padding:"5px 10px",borderRadius:6,fontWeight:600,
                        background: match ? T.teal : xeroBlue,
                        color:"#fff",
                        border:`1px solid ${match ? T.teal : xeroBlueDark}`,
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif",whiteSpace:"nowrap"}}>
                        {match ? "🔗 Merge" : "⬇ Import"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* ── Section 2: Link existing KTA apprentices to Xero ── */}
          <div style={{fontWeight:700,fontSize:14,marginBottom:6}}>🔗 Link Existing Apprentices</div>
          <div style={{fontSize:12,color:T.sub,marginBottom:12}}>
            Match each KTA apprentice to their Xero payroll record.
          </div>
          <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 120px",
              padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
              fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:10}}>
              <span>KTA Apprentice</span><span>Xero Employee</span><span>Status</span>
            </div>
            {apprentices.map((a,i)=>(
              <div key={a.id} style={{display:"grid",gridTemplateColumns:"1fr 1fr 120px",
                padding:"10px 14px",gap:10,alignItems:"center",fontSize:13,
                borderBottom:i<apprentices.length-1?`1px solid ${T.border}44`:"none",
                background:i%2===0?T.surface:T.bg}}>
                <div>
                  <div style={{fontWeight:700}}>{a.name}</div>
                  <div style={{fontSize:11,color:T.sub}}>{a.trade||"No trade set"}</div>
                </div>
                {xeroEmployees.length > 0 ? (
                  <select
                    value={empMap[a.id]!==undefined ? empMap[a.id] : (a.xeroEmployeeId||"")}
                    onChange={e=>setEmpMap(m=>({...m,[a.id]:e.target.value}))}
                    style={{fontSize:12,padding:"5px 8px",border:`1px solid ${T.border}`,
                      borderRadius:6,width:"100%",boxSizing:"border-box",background:"#fff"}}>
                    <option value="">— Select Xero employee —</option>
                    {xeroEmployees.map(xe=>(
                      <option key={xe.employeeID||xe.EmployeeID} value={xe.employeeID||xe.EmployeeID}>
                        {xe.firstName||xe.FirstName} {xe.lastName||xe.LastName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={empMap[a.id]!==undefined ? empMap[a.id] : (a.xeroEmployeeId||"")}
                    onChange={e=>setEmpMap(m=>({...m,[a.id]:e.target.value}))}
                    placeholder="Click Load from Xero above, or paste ID manually"
                    style={{fontSize:12,padding:"5px 8px",border:`1px solid ${T.border}`,
                      borderRadius:6,fontFamily:"monospace",width:"100%",boxSizing:"border-box"}}
                  />
                )}
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  {savingMap[a.id]==="saved"
                    ? <span style={{fontSize:12,color:T.teal,fontWeight:600}}>✓ Saved</span>
                    : (
                      <button onClick={async()=>{
                        const newId = empMap[a.id];
                        if(newId===undefined) return;
                        setSavingMap(m=>({...m,[a.id]:"saving"}));
                        try {
                          await upsertRow('users',{...a,xero_employee_id:newId});
                          setSavingMap(m=>({...m,[a.id]:"saved"}));
                          setTimeout(()=>setSavingMap(m=>({...m,[a.id]:null})),2000);
                        } catch(e) { alert("Save failed: "+e.message); setSavingMap(m=>({...m,[a.id]:null})); }
                      }} disabled={empMap[a.id]===undefined||savingMap[a.id]==="saving"}
                        style={{fontSize:12,padding:"4px 10px",borderRadius:6,
                          background: empMap[a.id]!==undefined ? xeroBlue : T.bg,
                          color: empMap[a.id]!==undefined ? "#fff" : T.muted,
                          border:`1px solid ${empMap[a.id]!==undefined?xeroBlueDark:T.border}`,
                          cursor: empMap[a.id]!==undefined ? "pointer" : "default",
                          fontFamily:"DM Sans,sans-serif",fontWeight:600}}>
                        {savingMap[a.id]==="saving"?"…":"Save"}
                      </button>
                    )
                  }
                  {a.xeroEmployeeId && !empMap[a.id]
                    ? <span style={{fontSize:11,color:T.teal}}>✓ Linked</span>
                    : !a.xeroEmployeeId && empMap[a.id]===undefined
                    ? <span style={{fontSize:11,color:T.warn}}>⚠ Not set</span>
                    : null
                  }
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Pending Tab ── */}
      {tab==="pending"&&(
        <div>
          {pendingXero.length===0
            ? <Card><div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontStyle:"italic"}}>
                No approved entries awaiting Xero submission
              </div></Card>
            : (
              <>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                  <div style={{fontSize:13,color:T.sub}}>{pendingXero.length} approved {pendingXero.length===1?"entry":"entries"} ready to submit</div>
                </div>
                <Card style={{padding:0,overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 80px 90px",
                    padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                    fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
                    <span>Date</span><span>Apprentice</span><span style={{textAlign:"center"}}>Hours</span>
                    <span>Type</span><span>Status</span><span style={{textAlign:"right"}}>Action</span>
                  </div>
                  {pendingXero.map((e,i)=>{
                    const app = allUsers.find(u=>u.id===e.userId);
                    const tm = TYPE_META[e.type]||TYPE_META["Normal Hours"];
                    const hasXeroId = !!app?.xeroEmployeeId;
                    const hasRate   = !!(settings.earningsRates?.[e.type]);
                    const canSubmit = hasXeroId && hasRate && settings.edgeFunctionUrl && settings.tenantId;
                    return (
                      <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 80px 90px",
                        padding:"10px 14px",gap:8,alignItems:"center",fontSize:13,
                        borderBottom:i<pendingXero.length-1?`1px solid ${T.border}44`:"none",
                        background:i%2===0?T.surface:T.bg}}>
                        <div style={{fontWeight:600,fontSize:12}}>{fD(e.date)}</div>
                        <div>
                          <div style={{fontWeight:700,fontSize:13}}>{app?.name||"Unknown"}</div>
                          {!hasXeroId&&<div style={{fontSize:11,color:T.warn}}>⚠ No Xero ID</div>}
                          {!hasRate&&<div style={{fontSize:11,color:T.warn}}>⚠ Rate not mapped</div>}
                        </div>
                        <div style={{textAlign:"center",fontWeight:700,color:T.accent,fontFamily:"'Libre Baskerville'"}}>{e.netHours}h</div>
                        <Pill label={e.type} size="sm" color={tm.color} bg={tm.bg}/>
                        <div>
                          {e.xeroStatus==="submitting"
                            ? <span style={{fontSize:11,color:T.muted}}>Sending…</span>
                            : e.xeroStatus==="error"
                            ? <span style={{fontSize:11,color:T.red}} title={e.xeroError}>✕ Error</span>
                            : <span style={{fontSize:11,color:T.muted}}>Pending</span>
                          }
                        </div>
                        <div style={{display:"flex",justifyContent:"flex-end"}}>
                          <button disabled={!canSubmit||e.xeroStatus==="submitting"}
                            onClick={async()=>{
                              if(!canSubmit) return;
                              onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"submitting"}:x));
                              const res = await submitEntryToXero(e, app, entries);
                              if(res.ok){
                                await updateRow("entries", e.id, { xero_status: "submitted", xero_timesheet_id: res.timesheetId||null }).catch(console.error);
                                onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"submitted",xeroTimesheetId:res.timesheetId}:x));
                              } else {
                                await updateRow("entries", e.id, { xero_status: "error" }).catch(console.error);
                                onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"error",xeroError:res.error}:x));
                              }
                            }}
                            style={{fontSize:12,fontWeight:700,padding:"4px 12px",borderRadius:7,
                              background: canSubmit?"#e6f7fd":T.bg,
                              color: canSubmit?xeroBlueDark:T.muted,
                              border:`1.5px solid ${canSubmit?xeroBlue:T.border}`,
                              cursor: canSubmit?"pointer":"not-allowed",
                              fontFamily:"DM Sans,sans-serif"}}>
                            𝕏 Submit
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </Card>
              </>
            )
          }
        </div>
      )}

      {/* ── History Tab ── */}
      {tab==="history"&&(
        <Card style={{padding:0,overflow:"hidden"}}>
          {submittedXero.length===0
            ? <div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontStyle:"italic"}}>No entries submitted to Xero yet</div>
            : <>
                <div style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 1fr",
                  padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                  fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
                  <span>Date</span><span>Apprentice</span><span style={{textAlign:"center"}}>Hours</span>
                  <span>Type</span><span>Xero Timesheet ID</span>
                </div>
                {submittedXero.map((e,i)=>{
                  const app = allUsers.find(u=>u.id===e.userId);
                  const tm = TYPE_META[e.type]||TYPE_META["Normal Hours"];
                  return (
                    <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 1fr",
                      padding:"10px 14px",gap:8,alignItems:"center",fontSize:13,
                      borderBottom:i<submittedXero.length-1?`1px solid ${T.border}44`:"none",
                      background:i%2===0?T.surface:T.bg}}>
                      <div style={{fontWeight:600,fontSize:12}}>{fD(e.date)}</div>
                      <div style={{fontWeight:700}}>{app?.name||"Unknown"}</div>
                      <div style={{textAlign:"center",fontWeight:700,color:T.accent,fontFamily:"'Libre Baskerville'"}}>{e.netHours}h</div>
                      <Pill label={e.type} size="sm" color={tm.color} bg={tm.bg}/>
                      <div style={{fontSize:11,color:xeroBlue,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {e.xeroTimesheetId||"—"}
                      </div>
                    </div>
                  );
                })}
              </>
          }
        </Card>
      )}
    </div>
  );
}


// =============================================================================
// EMAIL ACTIVITY TRACKING — Microsoft 365 / Graph API via Supabase Edge Function
// =============================================================================
//
// Architecture:
//   Browser → Supabase Edge Function (holds M365 OAuth token) → Microsoft Graph API
//   Activity notes are stored in Supabase `activity_notes` table.
//   Timeline merges: emails (live from M365) + pinned emails + manual notes + meeting reports
//
// Edge Function env vars: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REFRESH_TOKEN, MS_TENANT_ID
// Deploy: supabase functions deploy email-proxy

const EMAIL_PROXY_KEY = "kta_email_proxy_url";
const getEmailProxyUrl = () => { try{ return localStorage.getItem(EMAIL_PROXY_KEY)||""; }catch{ return ""; } };

// Call the M365 edge function proxy
const callEmailProxy = async (payload) => {
  const url = getEmailProxyUrl();
  if(!url) return { ok:false, error:"Email proxy not configured. Set up in Settings." };
  try {
    const res = await fetch(url, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if(!res.ok) return { ok:false, error: data.error||`HTTP ${res.status}` };
    return { ok:true, ...data };
  } catch(e) { return { ok:false, error: e.message }; }
};

// Search emails for a specific email address (inbound + outbound)
const fetchEmailsForPerson = async (emailAddress, maxResults=30) => {
  if(!emailAddress) return { ok:false, emails:[], error:"No email address" };
  return callEmailProxy({ action:"searchByAddress", emailAddress, maxResults });
};

// Fetch all recent org emails for the global inbox view
const fetchOrgInbox = async (folder="inbox", maxResults=50) => {
  return callEmailProxy({ action:"listFolder", folder, maxResults });
};

// ── Stable sub-components (defined outside to preserve focus) ────────────────
const NoteTextarea = ({value, onChange, placeholder}) => (
  <textarea value={value} onChange={onChange} placeholder={placeholder}
    rows={3}
    style={{width:"100%",fontSize:13,padding:"10px 12px",border:`1.5px solid ${T.border}`,
      borderRadius:8,fontFamily:"DM Sans,sans-serif",background:"#fff",resize:"vertical",
      color:T.ink,outline:"none",boxSizing:"border-box",minHeight:72}}/>
);

// ── EmailActivityFeed ─────────────────────────────────────────────────────────
// HubSpot-style activity timeline for any person record.
// Props:
//   personEmail — the email address to search
//   personName  — display name
//   personId    — Supabase user id (nullable for CRM contacts)
//   extraItems  — pre-loaded items to merge (e.g. meeting reports as {_kind,_ts,label,detail})
//   canEdit     — whether notes/pins are allowed
function EmailActivityFeed({personEmail, personName, personId=null, extraItems=[], canEdit=true}) {
  const [emails, setEmails]             = useState([]);
  const [notes, setNotes]               = useState([]);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [loadingNotes, setLoadingNotes]   = useState(true);
  const [emailError, setEmailError]     = useState(null);
  const [expanded, setExpanded]         = useState({});
  const [noteText, setNoteText]         = useState("");
  const [addingNote, setAddingNote]     = useState(false);
  const [savingNote, setSavingNote]     = useState(false);
  const [pinning, setPinning]           = useState({});
  const proxyOk = !!getEmailProxyUrl();

  // Load saved activity notes from Supabase
  useEffect(()=>{
    if(!personEmail && !personId) { setLoadingNotes(false); return; }
    loadTable('activity_notes')
      .then(rows => setNotes(
        rows.filter(r=> (personEmail && r.person_email===personEmail) || (personId && r.person_id===personId))
            .sort((a,b)=>b.created_at.localeCompare(a.created_at))
      ))
      .catch(()=>setNotes([]))
      .finally(()=>setLoadingNotes(false));
  },[personEmail, personId]);

  // Load live emails from M365
  const loadEmails = async () => {
    if(!personEmail||!proxyOk) return;
    setLoadingEmails(true); setEmailError(null);
    const result = await fetchEmailsForPerson(personEmail);
    if(result.ok) setEmails(result.emails||[]);
    else setEmailError(result.error);
    setLoadingEmails(false);
  };
  useEffect(()=>{ loadEmails(); },[personEmail]);

  const saveNote = async () => {
    if(!noteText.trim()) return;
    setSavingNote(true);
    const note = {
      id: uid(), person_email: personEmail||null, person_id: personId||null,
      person_name: personName||null, type:"note", subject:"Note",
      body: noteText.trim(), direction:"note",
      created_at: new Date().toISOString(),
    };
    try {
      await upsertRow('activity_notes', note);
      setNotes(prev=>[note,...prev]);
      setNoteText(""); setAddingNote(false);
    } catch(e) { alert("Failed to save: "+e.message); }
    setSavingNote(false);
  };

  const pinEmail = async (email) => {
    const already = notes.some(n=>n.email_id===email.id);
    if(already) return;
    setPinning(p=>({...p,[email.id]:true}));
    const note = {
      id: uid(), person_email: personEmail||null, person_id: personId||null,
      person_name: personName||null, type:"email",
      subject: email.subject||"(no subject)", body: email.bodyPreview||email.snippet||"",
      direction: email.direction||"inbound", email_id: email.id,
      from_address: email.from||"", to_address: email.to||"",
      email_date: email.date||null,
      created_at: new Date().toISOString(),
    };
    try {
      await upsertRow('activity_notes', note);
      setNotes(prev=>[note,...prev]);
    } catch(e) { alert("Failed to pin: "+e.message); }
    setPinning(p=>({...p,[email.id]:false}));
  };

  const deleteNote = async (id) => {
    if(!window.confirm("Remove this activity?")) return;
    await deleteRow('activity_notes', id).catch(console.error);
    setNotes(prev=>prev.filter(n=>n.id!==id));
  };

  // Merge notes + extraItems into a single timeline
  const timeline = [
    ...notes.map(n=>({...n, _src:"note"})),
    ...extraItems.map(x=>({...x, _src:"extra"})),
  ].sort((a,b)=>{
    const ta = a.created_at||a.date+"T00:00:00";
    const tb = b.created_at||b.date+"T00:00:00";
    return tb.localeCompare(ta);
  });

  const fmtTs = (iso) => {
    if(!iso) return "—";
    try{
      const d = new Date(iso);
      return d.toLocaleDateString("en-NZ",{day:"2-digit",month:"short",year:"numeric"})
        +" · "+d.toLocaleTimeString("en-NZ",{hour:"2-digit",minute:"2-digit",hour12:true});
    }catch{ return iso; }
  };

  const dirMeta = (dir) => ({
    inbound:  {label:"↓ Received", color:T.teal,  bg:T.tealL},
    outbound: {label:"↑ Sent",     color:T.accent, bg:T.accentL},
    note:     {label:"📝 Note",    color:T.gold,   bg:T.goldL},
    report:   {label:"📋 Report",  color:T.blue,   bg:T.blueL},
  })[dir||"note"]||{label:"◈ Activity", color:T.sub, bg:T.bg};

  const pinnedIds = new Set(notes.map(n=>n.email_id).filter(Boolean));

  return (
    <div>
      {/* Toolbar */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:"#f0f7ff",
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>✉</div>
          <div>
            <div style={{fontWeight:700,fontSize:14,color:T.ink}}>Activity & Email Timeline</div>
            <div style={{fontSize:11,color:T.sub}}>{personEmail||"No email set"}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {canEdit&&(
            <Btn sm onClick={()=>setAddingNote(s=>!s)} v={addingNote?"ghost":"primary"}>
              {addingNote?"✕ Cancel":"+ Log Activity"}
            </Btn>
          )}
          {proxyOk&&personEmail&&(
            <Btn sm v="ghost" onClick={loadEmails} disabled={loadingEmails}>
              {loadingEmails?"Loading…":"↻ Refresh Emails"}
            </Btn>
          )}
        </div>
      </div>

      {/* Add note box */}
      {addingNote&&(
        <div style={{background:T.goldL,border:`1.5px solid ${T.gold}44`,borderRadius:10,
          padding:14,marginBottom:14}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:8,color:T.gold}}>
            📝 Log Activity Note
          </div>
          <NoteTextarea
            value={noteText}
            onChange={e=>setNoteText(e.target.value)}
            placeholder={`Log a call, meeting, email summary, or any interaction with ${personName||"this contact"}…`}
          />
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <Btn sm onClick={saveNote} disabled={savingNote||!noteText.trim()}>
              {savingNote?"Saving…":"💾 Save Note"}
            </Btn>
            <Btn sm v="ghost" onClick={()=>{setAddingNote(false);setNoteText("");}}>Cancel</Btn>
          </div>
        </div>
      )}

      {/* Not configured banner */}
      {!proxyOk&&(
        <div style={{background:T.warnL,border:`1px solid ${T.warn}44`,borderRadius:8,
          padding:"10px 14px",marginBottom:14,fontSize:12,color:T.warn,lineHeight:1.6}}>
          ⚠ <strong>Email tracking not configured.</strong> Set up the M365 Email Proxy URL in Admin → Settings to enable live email sync. Activity notes can still be logged manually.
        </div>
      )}
      {emailError&&(
        <div style={{background:T.redL,border:`1px solid ${T.red}44`,borderRadius:8,
          padding:"10px 14px",marginBottom:14,fontSize:12,color:T.red}}>
          ✕ Email sync error: {emailError}
        </div>
      )}

      {/* Live emails from M365 (unpinned) */}
      {proxyOk&&emails.length>0&&(
        <div style={{marginBottom:16}}>
          <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",
            letterSpacing:".6px",marginBottom:8}}>
            📬 Emails from Microsoft 365 — {emails.length} found
          </div>
          {emails.map(em=>{
            const isOpen = expanded[em.id];
            const isPinned = pinnedIds.has(em.id);
            const dm = dirMeta(em.direction);
            return (
              <div key={em.id} style={{border:`1.5px solid ${T.border}`,borderRadius:10,
                marginBottom:6,overflow:"hidden",opacity:isPinned?.7:1}}>
                <div onClick={()=>setExpanded(x=>({...x,[em.id]:!x[em.id]}))}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",
                    cursor:"pointer",background:isOpen?T.bg:T.surface,
                    borderBottom:isOpen?`1px solid ${T.border}`:"none"}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:dm.color,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:13,color:T.ink,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {em.subject||"(no subject)"}
                    </div>
                    <div style={{fontSize:11,color:T.sub,marginTop:1}}>
                      <span style={{color:dm.color,fontWeight:600}}>{dm.label}</span>
                      {" · "}{em.from||em.to||""}
                      {" · "}{fmtTs(em.date)}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                    {canEdit&&!isPinned&&(
                      <button onClick={e=>{e.stopPropagation();pinEmail(em);}}
                        disabled={pinning[em.id]}
                        title="Pin to activity log"
                        style={{fontSize:11,fontWeight:600,padding:"3px 9px",borderRadius:6,
                          background:T.accentL,color:T.accent,border:`1px solid ${T.accent}44`,
                          cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                        {pinning[em.id]?"…":"📌 Pin"}
                      </button>
                    )}
                    {isPinned&&<span style={{fontSize:11,color:T.teal,fontWeight:600}}>✓ Pinned</span>}
                    <span style={{fontSize:11,color:T.muted}}>{isOpen?"▲":"▼"}</span>
                  </div>
                </div>
                {isOpen&&(
                  <div style={{padding:"12px 14px",background:"#fff",fontSize:13,
                    color:T.ink,lineHeight:1.7,whiteSpace:"pre-wrap",borderTop:`1px solid ${T.border}`}}>
                    <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                      {em.from&&<span style={{fontSize:11,color:T.sub}}><strong>From:</strong> {em.from}</span>}
                      {em.to&&<span style={{fontSize:11,color:T.sub}}><strong>To:</strong> {em.to}</span>}
                    </div>
                    {em.bodyPreview||em.snippet||"(no preview available)"}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Activity timeline (notes + pinned emails + reports) */}
      {(loadingNotes)
        ? <div style={{textAlign:"center",padding:"24px 0",color:T.muted,fontSize:13}}>Loading activity…</div>
        : timeline.length===0
        ? <div style={{textAlign:"center",padding:"24px 0",color:T.muted,fontSize:13,fontStyle:"italic"}}>
            No activity logged yet. Use "+ Log Activity" to add a note.
          </div>
        : (
          <div>
            <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",
              letterSpacing:".6px",marginBottom:8}}>Activity Log</div>
            {timeline.map((item,i)=>{
              if(item._src==="extra") {
                // Meeting report or other injected item
                return (
                  <div key={item.id||i} style={{display:"flex",gap:12,marginBottom:10}}>
                    <div style={{width:2,background:T.blueL,borderRadius:2,flexShrink:0,marginTop:4,marginBottom:4}}/>
                    <div style={{flex:1,background:T.blueL,border:`1px solid ${T.blue}33`,
                      borderRadius:8,padding:"10px 13px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <span style={{fontSize:13}}>📋</span>
                        <span style={{fontWeight:600,fontSize:13,color:T.blue}}>{item.label||"Meeting Report"}</span>
                        <span style={{fontSize:11,color:T.sub,marginLeft:"auto"}}>{fmtTs(item.created_at||item.date)}</span>
                      </div>
                      {item.detail&&<div style={{fontSize:12,color:T.ink,lineHeight:1.6}}>{item.detail}</div>}
                    </div>
                  </div>
                );
              }
              const dm = dirMeta(item.direction);
              return (
                <div key={item.id} style={{display:"flex",gap:12,marginBottom:10}}>
                  <div style={{width:2,background:dm.bg,borderRadius:2,flexShrink:0,marginTop:4,marginBottom:4}}/>
                  <div style={{flex:1,background:dm.bg,border:`1px solid ${dm.color}33`,
                    borderRadius:8,padding:"10px 13px"}}>
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3,flexWrap:"wrap"}}>
                          <span style={{fontSize:11,fontWeight:700,color:dm.color,
                            background:"#ffffff55",borderRadius:4,padding:"1px 6px",
                            border:`1px solid ${dm.color}33`}}>{dm.label}</span>
                          <span style={{fontWeight:600,fontSize:13,color:T.ink,
                            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {item.subject||"Note"}
                          </span>
                        </div>
                        {item.from_address&&<div style={{fontSize:11,color:T.sub,marginBottom:3}}>
                          {item.direction==="inbound"?"From":"To"}: {item.from_address||item.to_address}
                        </div>}
                        <div style={{fontSize:13,color:T.ink,lineHeight:1.65,
                          whiteSpace:"pre-wrap",marginTop:4}}>{item.body}</div>
                        <div style={{fontSize:11,color:T.muted,marginTop:6}}>{fmtTs(item.email_date||item.created_at)}</div>
                      </div>
                      {canEdit&&(
                        <button onClick={()=>deleteNote(item.id)}
                          title="Remove activity"
                          style={{flexShrink:0,background:"none",border:"none",
                            color:T.muted,fontSize:14,cursor:"pointer",padding:"0 4px",lineHeight:1}}
                          onMouseEnter={e=>e.currentTarget.style.color=T.red}
                          onMouseLeave={e=>e.currentTarget.style.color=T.muted}>✕</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      }
    </div>
  );
}

// ── EmailsModule — Global org inbox/sent view (Admin only) ────────────────────
function EmailsModule({allUsers, currentUser}) {
  const [tab, setTab]           = useState("inbox");
  const [emails, setEmails]     = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [expanded, setExpanded] = useState({});
  const [proxyUrl, setProxyUrl] = useState(()=>getEmailProxyUrl());
  const [savedUrl, setSavedUrl] = useState(false);
  const [search, setSearch]     = useState("");

  const saveProxyUrl = () => {
    try{ localStorage.setItem(EMAIL_PROXY_KEY, proxyUrl.trim()); }catch{}
    setSavedUrl(true); setTimeout(()=>setSavedUrl(false),2000);
  };

  const loadEmails = async (folder) => {
    setLoading(true); setError(null); setEmails([]);
    const result = await fetchOrgInbox(folder);
    if(result.ok) setEmails(result.emails||[]);
    else setError(result.error);
    setLoading(false);
  };

  useEffect(()=>{ if(getEmailProxyUrl()) loadEmails(tab); },[tab]);

  const fmtTs = (iso) => {
    if(!iso) return "—";
    try{
      const d = new Date(iso);
      const today = new Date(); today.setHours(0,0,0,0);
      const isToday = d >= today;
      return isToday
        ? d.toLocaleTimeString("en-NZ",{hour:"2-digit",minute:"2-digit",hour12:true})
        : d.toLocaleDateString("en-NZ",{day:"2-digit",month:"short",year:"numeric"});
    }catch{ return iso; }
  };

  // Try to match an email address to a known user or CRM contact
  const matchPerson = (address) => {
    if(!address) return null;
    const clean = address.toLowerCase().replace(/.*<(.+)>.*/, "$1").trim();
    return allUsers.find(u=>u.email&&u.email.toLowerCase()===clean);
  };

  const filtered = emails.filter(em=>{
    if(!search.trim()) return true;
    const q = search.toLowerCase();
    return (em.subject||"").toLowerCase().includes(q)
      || (em.from||"").toLowerCase().includes(q)
      || (em.to||"").toLowerCase().includes(q)
      || (em.bodyPreview||"").toLowerCase().includes(q);
  });

  const TabBtn = ({id,label,icon}) => (
    <button onClick={()=>setTab(id)} style={{
      padding:"8px 18px",borderRadius:8,fontSize:13,fontWeight:700,
      background: tab===id ? T.accent : T.bg,
      color: tab===id ? "#fff" : T.sub,
      border:`1.5px solid ${tab===id?T.accentD:T.border}`,
      cursor:"pointer",fontFamily:"DM Sans,sans-serif",
      display:"flex",alignItems:"center",gap:6,transition:"all .14s"}}>
      <span>{icon}</span>{label}
    </button>
  );

  const proxyConfigured = !!getEmailProxyUrl();

  return (
    <div className="fu">
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:20,
        padding:"18px 22px",background:"#fff",borderRadius:14,
        border:`1.5px solid ${T.border}`,boxShadow:"0 2px 12px #00000008"}}>
        <div style={{width:48,height:48,borderRadius:12,background:T.accentL,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>✉</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700,color:T.ink}}>
            Email Tracking
          </div>
          <div style={{fontSize:13,color:T.sub,marginTop:2}}>
            Microsoft 365 inbox & sent mail · All contacts matched to KTA records
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <div style={{textAlign:"center",padding:"8px 14px",background:T.accentL,borderRadius:8}}>
            <div style={{fontSize:18,fontWeight:700,color:T.accent,fontFamily:"'Libre Baskerville'"}}>{emails.length}</div>
            <div style={{fontSize:10,color:T.sub,fontWeight:600,textTransform:"uppercase"}}>Emails</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        <TabBtn id="inbox"  label="Inbox"    icon="↓"/>
        <TabBtn id="sent"   label="Sent"     icon="↑"/>
        <TabBtn id="setup"  label="⚙ Setup"  icon=""/>
      </div>

      {/* Setup tab */}
      {tab==="setup"&&(
        <div>
          <Card style={{marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:14}}>Microsoft 365 Connection</div>

            <div style={{background:T.accentL,border:`1px solid ${T.accent}33`,borderRadius:8,
              padding:"12px 16px",marginBottom:16,fontSize:13,color:T.ink,lineHeight:1.7}}>
              <strong>How it works:</strong> A Supabase Edge Function acts as a proxy between KTA and the Microsoft Graph API.
              It uses your M365 organisation credentials to read your inbox and sent mail, then returns emails matching any contact in the system.
              <br/><br/>
              <strong>Setup steps:</strong><br/>
              1. Register an app in <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer" style={{color:T.accent}}>Azure Active Directory</a> with <code>Mail.Read</code> and <code>Mail.Send</code> permissions<br/>
              2. Download and deploy the Edge Function below to Supabase<br/>
              3. Set the secrets: <code>MS_CLIENT_ID</code>, <code>MS_CLIENT_SECRET</code>, <code>MS_TENANT_ID</code>, <code>MS_REFRESH_TOKEN</code><br/>
              4. Paste your Edge Function URL here and save
            </div>

            <div style={{marginBottom:14}}>
              <FL>Supabase Edge Function URL</FL>
              <input value={proxyUrl} onChange={e=>setProxyUrl(e.target.value)}
                placeholder="https://your-project.supabase.co/functions/v1/email-proxy"/>
              <div style={{fontSize:11,color:T.muted,marginTop:3}}>
                The deployed email-proxy Edge Function URL
              </div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <Btn onClick={saveProxyUrl}>Save URL</Btn>
              {savedUrl&&<span style={{fontSize:12,color:T.teal,fontWeight:600}}>✓ Saved</span>}
              {proxyConfigured&&<Btn v="ghost" sm onClick={()=>loadEmails("inbox")}>Test Connection</Btn>}
            </div>
          </Card>

          <Card>
            <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>📦 Supabase Edge Function</div>
            <div style={{fontSize:13,color:T.sub,marginBottom:14,lineHeight:1.6}}>
              Download and deploy this Edge Function to Supabase. It handles M365 OAuth token refresh and proxies Microsoft Graph API calls.
            </div>
            <Btn v="ghost" onClick={()=>{
              const code = `// KTA Email Proxy — Supabase Edge Function
// Deploy: supabase functions deploy email-proxy
// Secrets: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REFRESH_TOKEN

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const TOKEN_URL = (tenantId) =>
  \`https://login.microsoftonline.com/\${tenantId}/oauth2/v2.0/token\`;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function getAccessToken() {
  const tenantId     = Deno.env.get("MS_TENANT_ID")!;
  const clientId     = Deno.env.get("MS_CLIENT_ID")!;
  const clientSecret = Deno.env.get("MS_CLIENT_SECRET")!;
  const refreshToken = Deno.env.get("MS_REFRESH_TOKEN")!;

  const res = await fetch(TOKEN_URL(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/Mail.Read offline_access",
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed: " + await res.text());
  const data = await res.json();
  return data.access_token as string;
}

function formatEmail(msg: any, folder: string) {
  const from = msg.from?.emailAddress;
  const toList = msg.toRecipients?.map((r: any) => r.emailAddress?.address).join(", ");
  return {
    id:          msg.id,
    subject:     msg.subject,
    from:        from ? \`\${from.name} <\${from.address}>\` : "",
    to:          toList || "",
    date:        msg.receivedDateTime || msg.sentDateTime,
    bodyPreview: msg.bodyPreview,
    direction:   folder === "sentItems" ? "outbound" : "inbound",
    isRead:      msg.isRead,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const body = await req.json();
    const { action, emailAddress, folder = "inbox", maxResults = 50 } = body;
    const token = await getAccessToken();
    const headers = { Authorization: \`Bearer \${token}\` };

    if (action === "searchByAddress") {
      // Search both inbox and sent for this address
      const [inboundRes, outboundRes] = await Promise.all([
        fetch(\`\${GRAPH_BASE}/me/mailFolders/inbox/messages?\$filter=from/emailAddress/address eq '\${emailAddress}'&\$top=\${maxResults}&\$orderby=receivedDateTime desc\`, { headers }),
        fetch(\`\${GRAPH_BASE}/me/mailFolders/sentItems/messages?\$filter=toRecipients/any(r:r/emailAddress/address eq '\${emailAddress}')&\$top=\${maxResults}&\$orderby=sentDateTime desc\`, { headers }),
      ]);
      const [inbox, sent] = await Promise.all([inboundRes.json(), outboundRes.json()]);
      const emails = [
        ...(inbox.value||[]).map((m: any) => formatEmail(m, "inbox")),
        ...(sent.value||[]).map((m: any) => formatEmail(m, "sentItems")),
      ].sort((a, b) => b.date.localeCompare(a.date));
      return new Response(JSON.stringify({ ok: true, emails }), { headers: cors });
    }

    if (action === "listFolder") {
      const folderPath = folder === "sent" ? "sentItems" : "inbox";
      const res = await fetch(
        \`\${GRAPH_BASE}/me/mailFolders/\${folderPath}/messages?\$top=\${maxResults}&\$orderby=receivedDateTime desc\`,
        { headers }
      );
      const data = await res.json();
      const emails = (data.value||[]).map((m: any) => formatEmail(m, folderPath));
      return new Response(JSON.stringify({ ok: true, emails }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
});`;
              const blob = new Blob([code],{type:"text/typescript"});
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href=url; a.download="index.ts"; a.click();
            }}>⬇ Download Edge Function (index.ts)</Btn>
          </Card>
        </div>
      )}

      {/* Inbox / Sent tabs */}
      {(tab==="inbox"||tab==="sent")&&(
        <div>
          {!proxyConfigured?(
            <Card>
              <div style={{textAlign:"center",padding:"32px 0",color:T.muted}}>
                <div style={{fontSize:32,marginBottom:12}}>✉</div>
                <div style={{fontWeight:700,fontSize:15,marginBottom:6}}>Email proxy not configured</div>
                <div style={{fontSize:13}}>Go to the Setup tab to connect Microsoft 365.</div>
              </div>
            </Card>
          ) : (
            <>
              {/* Search */}
              <div style={{marginBottom:12}}>
                <input value={search} onChange={e=>setSearch(e.target.value)}
                  placeholder="Search subject, sender, recipient…"
                  style={{width:"100%",boxSizing:"border-box"}}/>
              </div>

              {loading&&<div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontSize:13}}>Loading emails…</div>}
              {error&&<div style={{background:T.redL,border:`1px solid ${T.red}44`,borderRadius:8,padding:"10px 14px",fontSize:12,color:T.red,marginBottom:12}}>✕ {error}</div>}

              {!loading&&!error&&(
                <Card style={{padding:0,overflow:"hidden"}}>
                  {filtered.length===0
                    ? <div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontStyle:"italic",fontSize:13}}>No emails found</div>
                    : filtered.map((em,i)=>{
                        const isOpen = expanded[em.id];
                        const matched = matchPerson(em.from)||matchPerson(em.to);
                        return (
                          <div key={em.id} style={{borderBottom:i<filtered.length-1?`1px solid ${T.border}44`:"none"}}>
                            <div onClick={()=>setExpanded(x=>({...x,[em.id]:!x[em.id]}))}
                              style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
                                cursor:"pointer",background:isOpen?T.bg:em.isRead===false?"#f0f7ff":T.surface,
                                borderBottom:isOpen?`1px solid ${T.border}`:"none"}}>
                              {/* Unread dot */}
                              <div style={{width:7,height:7,borderRadius:"50%",flexShrink:0,
                                background:em.isRead===false?T.accent:"transparent",
                                border:`1.5px solid ${em.isRead===false?T.accent:T.border}`}}/>
                              <div style={{flex:1,minWidth:0}}>
                                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                                  <span style={{fontWeight:em.isRead===false?700:500,fontSize:13,color:T.ink,
                                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:300}}>
                                    {em.subject||"(no subject)"}
                                  </span>
                                  {matched&&(
                                    <RolePill role={matched.role} size="sm"/>
                                  )}
                                  <span style={{fontSize:11,padding:"1px 7px",borderRadius:4,fontWeight:600,
                                    background:em.direction==="outbound"?T.accentL:T.tealL,
                                    color:em.direction==="outbound"?T.accent:T.teal}}>
                                    {em.direction==="outbound"?"↑ Sent":"↓ Received"}
                                  </span>
                                </div>
                                <div style={{fontSize:11,color:T.sub,marginTop:2,
                                  overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                                  {em.direction==="outbound"?`To: ${em.to}`:`From: ${em.from}`}
                                </div>
                              </div>
                              <div style={{fontSize:11,color:T.muted,flexShrink:0,textAlign:"right"}}>
                                <div>{fmtTs(em.date)}</div>
                                {matched&&<div style={{fontSize:10,color:T.accent,marginTop:2}}>{matched.name}</div>}
                              </div>
                            </div>
                            {isOpen&&(
                              <div style={{padding:"14px 16px",background:"#fff",
                                borderTop:`1px solid ${T.border}`}}>
                                <div style={{display:"flex",gap:16,marginBottom:10,flexWrap:"wrap",fontSize:12,color:T.sub}}>
                                  <span><strong>From:</strong> {em.from}</span>
                                  <span><strong>To:</strong> {em.to}</span>
                                  <span><strong>Date:</strong> {new Date(em.date).toLocaleString("en-NZ")}</span>
                                </div>
                                <div style={{fontSize:13,color:T.ink,lineHeight:1.7,
                                  whiteSpace:"pre-wrap",padding:"10px 12px",
                                  background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>
                                  {em.bodyPreview||"(no preview)"}
                                </div>
                                {matched&&(
                                  <div style={{marginTop:10,fontSize:12,color:T.sub,fontStyle:"italic"}}>
                                    ↗ This email is linked to <strong style={{color:T.ink}}>{matched.name}</strong> ({matched.role}) and will appear in their activity timeline.
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                  }
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [users,setUsers]         = useState([]);
  const [entries,setEntries]     = useState([]);
  const [sessionId,setSessionId] = useState(()=>{ try{return localStorage.getItem("wos_session_sb")||null;}catch{return null;} });
  const [module,setModule]       = useState("dashboard");
  const [viewingAppId,setViewingAppId] = useState(null);
  const [showAppList,setShowAppList] = useState(false);
  const [loggingOut,setLoggingOut] = useState(false);
  const [loading,setLoading]     = useState(true);
  const [dbError,setDbError]     = useState(null);
  const [notifications,setNotifications] = useState([]);
  const [showNotifs,setShowNotifs] = useState(false);
  const [showBroadcast,setShowBroadcast] = useState(false);
  const [appToast,setAppToast]   = useState(null);

  const showToast = (msg, ok=true) => {
    setAppToast({msg,ok});
    setTimeout(()=>setAppToast(null), 4000);
  };

  // ── Initial load from Supabase ──────────────────────────────────────────
  useEffect(()=>{
    (async()=>{
      try {
        const [u, e] = await Promise.all([loadUsers(), loadEntries()]);
        setUsers(u);
        setEntries(e);
      } catch(err) {
        console.error("Supabase load error:", err);
        setDbError(err.message);
      } finally {
        setLoading(false);
      }
    })();

    // Realtime: re-fetch users whenever the users table changes
    const channel = sb.channel('users-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, async () => {
        const u = await loadUsers();
        setUsers(u);
      })
      .subscribe();

    return () => { sb.removeChannel(channel); };
  },[]);

  // ── Load notifications when session changes ──────────────────────────────
  useEffect(()=>{
    if(!sessionId) return;
    loadNotifications(sessionId).then(setNotifications).catch(console.error);
    // Poll every 30s for new notifications
    const interval = setInterval(()=>{
      loadNotifications(sessionId).then(rows=>{
        setNotifications(prev=>{
          // Browser push for any new unread ones
          const prevIds = new Set(prev.map(n=>n.id));
          rows.filter(n=>!n.read&&!prevIds.has(n.id)).forEach(n=>{
            sendBrowserPush(n.title, n.body||"", n.type||"info");
          });
          return rows;
        });
      }).catch(console.error);
    }, 30000);
    return ()=>clearInterval(interval);
  },[sessionId]);

  // ── Request push permission on login ────────────────────────────────────
  useEffect(()=>{ if(sessionId) requestPushPermission(); },[sessionId]);

  // ── Block spacebar page-scroll when typing in any input/textarea ────────────
  useEffect(()=>{
    const onKeyDown = (e) => {
      if(e.key !== " ") return;
      const tag = document.activeElement?.tagName;
      if(tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") {
        // Stop the event reaching the window scroll handler
        // but do NOT preventDefault — that would eat the space character
        e.stopPropagation();
      }
    };
    // Use capture:false so React's own synthetic events fire first, undisturbed
    document.addEventListener("keydown", onKeyDown, false);
    return () => document.removeEventListener("keydown", onKeyDown, false);
  }, []);

  // ── Licence expiry check — runs for Admin + Mentor on load & daily ────────
  useEffect(()=>{
    if(!sessionId||!users.length) return;
    const currentU = users.find(u=>u.id===sessionId);
    if(!["Admin","Mentor"].includes(currentU?.role)) return;

    const checkLicences = async () => {
      const today = new Date(); today.setHours(0,0,0,0);
      const apprentices = users.filter(u=>u.role==="Apprentice"&&u.licenceExpiry);
      for(const app of apprentices) {
        const expiry = new Date(app.licenceExpiry+"T00:00:00");
        const daysUntil = Math.round((expiry-today)/86400000);
        for(const threshold of [30,7]) {
          if(daysUntil>threshold || daysUntil<0) continue;
          // Recipients: mentors allocated to this apprentice + the apprentice
          const mentors = users.filter(u=>u.role==="Mentor"&&(u.allocatedTo||[]).includes(app.id));
          const recipients = [...new Set([...mentors.map(m=>m.id), app.id])];
          for(const recipId of recipients) {
            const already = await licenceReminderExists(recipId, app.id, threshold);
            if(already) continue;
            const isSelf = recipId===app.id;
            const title = `⚠ Licence Expiry — ${app.name}`;
            const message = isSelf
              ? `Your ${app.trade||"trade"} licence expires in ${daysUntil} day${daysUntil!==1?"s":""} (${app.licenceExpiry}). Please renew it soon.`
              : `${app.name}'s ${app.trade||"trade"} licence expires in ${daysUntil} day${daysUntil!==1?"s":""} (${app.licenceExpiry}).`;
            const notif = { id:uid(), user_id:recipId, type:"licence_expiry", title, message, read:false, created_by:null, meta:{ apprenticeId:app.id, daysUntil:threshold, expiry:app.licenceExpiry } };
            await insertNotification(notif).catch(console.error);
            if(recipId===sessionId) {
              setNotifications(prev=>[notif,...prev]);
              sendBrowserPush(title, message, "licence");
            }
          }
        }
      }
    };
    checkLicences();
    const daily = setInterval(checkLicences, 24*60*60*1000);
    return ()=>clearInterval(daily);
  },[sessionId, users.length]);

  // ── Persist session to localStorage (just the id, not data) ────────────
  useEffect(()=>{ try{localStorage.setItem("wos_session_sb",sessionId||"");}catch{} },[sessionId]);

  // ── Supabase-aware state updaters ────────────────────────────────────────
  const stableJson = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
  const updateUsers = useCallback((updater) => {
    setUsers(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      const nextIds = new Set(next.map(u=>u.id));
      const prevMap = Object.fromEntries(prev.map(u=>[u.id,u]));
      // Sync to Supabase outside the render cycle
      setTimeout(() => {
        next.forEach(u => {
          const old = prevMap[u.id];
          // Always upsert if new user, or if any field changed (stable key-sorted comparison)
          if(!old || stableJson(old) !== stableJson(u)) {
            upsertUser(u).catch(e=>console.error('upsertUser',e));
          }
        });
        prev.forEach(u => {
          if(!nextIds.has(u.id)) sbDeleteUser(u.id).catch(e=>console.error('deleteUser',e));
        });
      }, 0);
      return next;
    });
  }, []);

  const updateEntries = useCallback((updater) => {
    setEntries(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      const prevMap = Object.fromEntries(prev.map(e=>[e.id,e]));
      const nextIds = new Set(next.map(e=>e.id));
      const stableJ = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
      // Sync to Supabase outside the render cycle
      setTimeout(() => {
        next.forEach(e => {
          const old = prevMap[e.id];
          if(!old || stableJ(old) !== stableJ(e)) {
            upsertEntry(e).catch(err=>console.error('upsertEntry',err));
          }
        });
        prev.forEach(e => {
          if(!nextIds.has(e.id)) deleteEntry(e.id).catch(err=>console.error('deleteEntry',err));
        });
      }, 0);
      return next;
    });
  }, []);

  // ── Send in-app notification + browser push ─────────────────────────────
  const pushNotif = useCallback(async (userIds, type, title, message, createdBy=null, meta={}) => {
    for(const uid_ of [...new Set(userIds)]) {
      const notif = { id:uid(), user_id:uid_, type, title, message, read:false, created_by:createdBy, meta };
      await insertNotification(notif).catch(console.error);
      if(uid_===sessionId) {
        setNotifications(prev=>[notif,...prev]);
        sendBrowserPush(title, message, type);
      }
    }
  }, [sessionId]);

  const currentUser = users.find(u=>u.id===sessionId);
  const role = currentUser?.role;
  // Admin level helpers — Admin 1 = full superadmin, Admin 2 = limited (no message delete/edit)
  const isAdmin1 = role==="Admin" && (currentUser?.adminLevel||1) === 1;
  const isAdmin2 = role==="Admin" && (currentUser?.adminLevel||1) === 2;

  const handleLogin  = (userId) => {
    const u = users.find(x=>x.id===userId);
    // Admin lands on dashboard, others on timesheet
    setModule(u?.role==="Admin"?"dashboard":u?.role==="Mentor"?"mentor":"timesheet");
    setSessionId(userId);
    setViewingAppId(null);
  };
  const handleLogout = () => {
    setLoggingOut(true);
    setTimeout(()=>{ setSessionId(null); setLoggingOut(false); setViewingAppId(null); setShowAppList(false); try{localStorage.removeItem('wos_session_sb');}catch{} },400);
  };

  if(loading) return (
    <>
      <style>{CSS}</style>
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",
        background:`linear-gradient(135deg,${T.dark},${T.dark2},#2060a0)`}}>
        <div style={{textAlign:"center",color:"#fff"}}>
          <img src={KTA_LOGO} alt="KTA" style={{height:60,objectFit:"contain",filter:"brightness(0) invert(1)",marginBottom:20}} onError={e=>{e.target.style.display="none";}}/>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:20,fontWeight:700,marginBottom:8}}>Kiwi Trade Apprentices</div>
          <div style={{fontSize:13,color:"#ffffff66"}}>Connecting to database…</div>
          {dbError&&<div style={{fontSize:12,color:"#ff8888",marginTop:12,maxWidth:300}}>⚠ {dbError}</div>}
        </div>
      </div>
    </>
  );

  if(!currentUser) return (
    <>
      <style>{CSS}</style>
      <LoginScreen users={users} onLogin={handleLogin}/>
    </>
  );

  // ── Apprentice notification gate — must read all notifications before proceeding ──
  const unreadNotifs = notifications.filter(n=>!n.read);
  if(role==="Apprentice" && unreadNotifs.length > 0 && !showNotifs) {
    return (
      <>
        <style>{CSS}</style>
        <div style={{minHeight:"100vh",background:T.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{maxWidth:480,width:"100%"}}>
            <div style={{textAlign:"center",marginBottom:28}}>
              <img src={KTA_LOGO} alt="KTA" style={{height:50,objectFit:"contain",marginBottom:16}}
                onError={e=>e.target.style.display="none"}/>
              <div style={{width:64,height:64,borderRadius:"50%",background:T.warnL,border:`3px solid ${T.warn}`,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 16px"}}>
                🔔
              </div>
              <h2 style={{fontFamily:"'Libre Baskerville'",fontSize:22,fontWeight:700,color:T.ink,marginBottom:8}}>
                You have unread notifications
              </h2>
              <p style={{fontSize:13,color:T.sub,lineHeight:1.6}}>
                Please read and acknowledge your notifications before continuing.<br/>
                You have <strong style={{color:T.warn}}>{unreadNotifs.length}</strong> unread message{unreadNotifs.length!==1?"s":""}.
              </p>
            </div>

            <Card style={{marginBottom:16}}>
              {unreadNotifs.map((n,i)=>{
                const typeIcons={approval:"✓",decline:"✕",licence:"⚠",broadcast:"📢",reply:"↩",info:"◈"};
                const typeColors={approval:T.teal,decline:T.red,licence:T.warn,broadcast:T.accent,reply:T.blue,info:T.sub};
                return (
                  <div key={n.id} style={{
                    padding:"14px 16px",
                    borderBottom:i<unreadNotifs.length-1?`1px solid ${T.border}`:"none",
                    background:T.warnL+"44",borderRadius:i===0?`10px 10px 0 0`:i===unreadNotifs.length-1?"0 0 10px 10px":"0"
                  }}>
                    <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                      <span style={{fontSize:16,color:typeColors[n.type]||T.sub,flexShrink:0,marginTop:1}}>{typeIcons[n.type]||"◈"}</span>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,fontSize:13,marginBottom:2}}>{n.title}</div>
                        <div style={{fontSize:12,color:T.sub,lineHeight:1.5}}>{n.message}</div>
                      </div>
                      <button onClick={()=>{
                        markNotifRead(n.id).catch(console.error);
                        setNotifications(prev=>prev.map(x=>x.id===n.id?{...x,read:true}:x));
                      }} style={{
                        background:T.accentL,border:`1px solid ${T.accent}44`,color:T.accent,
                        borderRadius:6,padding:"4px 12px",fontSize:12,fontWeight:600,
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif",flexShrink:0
                      }}>✓ Read</button>
                    </div>
                  </div>
                );
              })}
            </Card>

            <Btn full onClick={()=>{
              markAllNotifsRead(sessionId).catch(console.error);
              setNotifications(prev=>prev.map(n=>({...n,read:true})));
            }}>✓ Mark All as Read &amp; Continue</Btn>

            <div style={{textAlign:"center",marginTop:12}}>
              <button onClick={handleLogout} style={{
                background:"none",border:"none",color:T.muted,fontSize:12,
                cursor:"pointer",fontFamily:"DM Sans,sans-serif"
              }}>Sign out</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Nav items per role
  const navItems=[
    {id:"dashboard", label:"⊞ Dashboard",  roles:["Admin"]},
    {id:"mentor",    label:"👷 Apprentices", roles:["Mentor"]},
    {id:"timesheet", label:"⏱ Timesheet",  roles:["Apprentice","Approver","Viewer"]},
    {id:"crm",       label:"◈ CRM",         roles:["Mentor","Admin"]},
    {id:"users",     label:"★ Users",       roles:["Admin"]},
    // {id:"emails",    label:"✉ Emails",      roles:["Admin","Mentor"]}, // DISABLED — uncomment to re-enable
  ].filter(n=>n.roles.includes(role));

  const validMods=navItems.map(n=>n.id);
  const activeMod=validMods.includes(module)?module:validMods[0];

  // When admin drills into an apprentice — use the full ApprenticeDetailView
  const viewingApp = viewingAppId ? users.find(u=>u.id===viewingAppId) : null;
  const adminViewingApprentice = role==="Admin" && activeMod==="dashboard" && viewingApp && !showAppList;
  const adminViewingTimesheet  = adminViewingApprentice; // alias for breadcrumb logic
  const adminAppList = role==="Admin" && activeMod==="dashboard" && !!showAppList && !viewingAppId;

  return (
    <>
      <style>{CSS}</style>
      <div style={{minHeight:"100vh",background:T.bg,opacity:loggingOut?0:1,transition:"opacity .35s"}}>

        {/* HEADER */}
        <header style={{background:T.dark,height:66,padding:"0 20px",
          display:"flex",alignItems:"center",justifyContent:"space-between",
          position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 16px #00000033"}}>
          <div style={{display:"flex",alignItems:"center",gap:16}}>
            <img src={KTA_LOGO} alt="KTA"
              style={{height:44,objectFit:"contain",filter:"brightness(0) invert(1)",flexShrink:0}}
              onError={e=>{e.target.style.display="none";}}
            />
            <div style={{width:1,height:28,background:"#ffffff25",flexShrink:0}} className="desktop-nav"/>
            <nav className="desktop-nav" style={{gap:6}}>
              {navItems.map(n=>{
                const isActive = activeMod===n.id;
                const navIcons={dashboard:"⊞",mentor:"👷",timesheet:"⏱",crm:"◈",users:"★",emails:"✉"};
                const navLabels={dashboard:"Dashboard",mentor:"Apprentices",timesheet:"Timesheet",crm:"CRM",users:"Users",emails:"Emails"};
                return (
                  <button key={n.id}
                    onClick={()=>{setModule(n.id);setViewingAppId(null);setShowAppList(false);}}
                    style={{
                      padding:"8px 18px",borderRadius:9,fontSize:13,fontWeight:700,
                      letterSpacing:"-.1px",
                      background: isActive ? "#ffffff" : "#ffffff15",
                      color: isActive ? T.dark : "#ffffffcc",
                      border: isActive ? `1.5px solid #ffffff44` : "1.5px solid #ffffff18",
                      fontFamily:"DM Sans,sans-serif",cursor:"pointer",
                      transition:"all .14s",
                      boxShadow: isActive ? "0 2px 8px #00000022" : "none",
                      display:"flex",alignItems:"center",gap:6,
                    }}
                    onMouseEnter={e=>{ if(!isActive){ e.currentTarget.style.background="#ffffff25"; e.currentTarget.style.color="#fff"; } }}
                    onMouseLeave={e=>{ if(!isActive){ e.currentTarget.style.background="#ffffff15"; e.currentTarget.style.color="#ffffffcc"; } }}>
                    <span style={{fontSize:14}}>{navIcons[n.id]||"◈"}</span>
                    <span>{navLabels[n.id]||n.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <NotificationBell
              notifs={notifications}
              show={showNotifs}
              setShow={(v)=>{setShowNotifs(v);if(v)setShowBroadcast(false);}}
              onRead={id=>{ markNotifRead(id).catch(console.error); setNotifications(prev=>prev.map(n=>n.id===id?{...n,read:true}:n)); }}
              onReadAll={()=>{ markAllNotifsRead(sessionId).catch(console.error); setNotifications(prev=>prev.map(n=>({...n,read:true}))); }}
              canDelete={isAdmin1||role!=="Admin"}
              onDelete={id=>{ deleteNotif(id).catch(console.error); setNotifications(prev=>prev.filter(n=>n.id!==id)); }}
              onReply={async(origNotif, text)=>{
                const senderId = origNotif.created_by;
                if(!senderId) return;
                const sender = users.find(u=>u.id===senderId);
                if(!sender) return;
                const participants = [currentUser.id, senderId];
                const apprenticeId = participants.find(id=>{
                  const u = users.find(x=>x.id===id);
                  return u?.role==="Apprentice";
                }) || currentUser.id;
                await insertMessage({
                  id: uid(), apprentice_id: apprenticeId, sender_id: currentUser.id,
                  body: text, created_at: new Date().toISOString(),
                }).catch(console.error);
                await pushNotif([senderId],"reply",`↩ Reply from ${currentUser.name}`,text,currentUser.id,{replyToId:origNotif.id});
              }}
            />
            {["Admin","Mentor"].includes(role)&&(
              <button onClick={()=>{setShowBroadcast(s=>!s);setShowNotifs(false);}}
                title="Broadcast message"
                style={{background:"#ffffff18",border:"1.5px solid #ffffff28",color:"#fff",
                  borderRadius:9,padding:"7px 10px",fontSize:16,cursor:"pointer",
                  display:"flex",alignItems:"center",justifyContent:"center",transition:"all .14s"}}
                onMouseEnter={e=>{e.currentTarget.style.background="#ffffff30";}}
                onMouseLeave={e=>{e.currentTarget.style.background="#ffffff18";}}>📢</button>
            )}
            {isAdmin1&&(
              <button onClick={()=>setModule("xero")}
                title="Xero Integration"
                style={{background: module==="xero"?"#13b5ea22":"#ffffff18",
                  border: module==="xero"?"1.5px solid #13b5ea88":"1.5px solid #ffffff28",
                  color: module==="xero"?"#13b5ea":"#ffffffcc",
                  borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                  display:"flex",alignItems:"center",gap:5,transition:"all .14s"}}
                onMouseEnter={e=>{e.currentTarget.style.background="#13b5ea22";e.currentTarget.style.color="#13b5ea";}}
                onMouseLeave={e=>{if(module!=="xero"){e.currentTarget.style.background="#ffffff18";e.currentTarget.style.color="#ffffffcc";}}}>
                <span style={{fontSize:14}}>𝕏</span> Xero
              </button>
            )}
            <div className="desktop-user-name" style={{textAlign:"right",marginLeft:4}}>
              <div style={{fontSize:13,fontWeight:700,color:"#fff",letterSpacing:"-.1px"}}>{currentUser.name}</div>
              <div style={{marginTop:2}}><RolePill role={role} adminLevel={role==="Admin"?(currentUser?.adminLevel||1):null} size="sm"/></div>
            </div>
            <Avatar name={currentUser.name} role={role} size={34}/>
            <button className="desktop-signout" onClick={handleLogout}
              style={{background:"#ffffff15",border:"1.5px solid #ffffff28",borderRadius:9,
                padding:"8px 14px",fontSize:12,color:"#ffffffbb",fontWeight:700,
                fontFamily:"DM Sans,sans-serif",cursor:"pointer",letterSpacing:"-.1px",transition:"all .14s"}}
              onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
              onMouseLeave={e=>{e.currentTarget.style.background="#ffffff15";e.currentTarget.style.color="#ffffffbb";e.currentTarget.style.borderColor="#ffffff28";}}>
              ⏏ Sign out
            </button>
          </div>
        </header>

        {/* BOTTOM NAV — mobile only */}
        <nav className="bottom-nav">
          {navItems.map(n=>{
            const icons={dashboard:"⊞",timesheet:"⏱",crm:"◈",users:"★"};
            const labels={dashboard:"Dashboard",timesheet:"Timesheet",crm:"CRM",users:"Users"};
            return (
              <button key={n.id}
                className={`bottom-nav-btn${activeMod===n.id?" active":""}`}
                onClick={()=>{setModule(n.id);setViewingAppId(null);setShowAppList(false);}}>
                <span className="bottom-nav-icon">{icons[n.id]||"◈"}</span>
                <span className="bottom-nav-label">{labels[n.id]||n.id}</span>
              </button>
            );
          })}
          {/* Sign out as last tab on mobile */}
          <button className="bottom-nav-btn" onClick={handleLogout}>
            <span className="bottom-nav-icon">⏏</span>
            <span className="bottom-nav-label">Sign out</span>
          </button>
        </nav>

        {/* BROADCAST MODAL */}
        {showBroadcast&&["Admin","Mentor"].includes(role)&&(
          <BroadcastComposer
            users={users}
            currentUser={currentUser}
            onSend={pushNotif}
            onClose={()=>setShowBroadcast(false)}
          />
        )}

        {/* MAIN */}
        <main className="main-content">

          {/* Breadcrumb / page title */}
          <div style={{marginBottom:22}}>
            {adminViewingTimesheet ? (
              <div>
                <button onClick={()=>setViewingAppId(null)} style={{
                  display:"inline-flex",alignItems:"center",gap:6,
                  background:"none",border:"none",color:T.sub,fontSize:13,
                  fontFamily:"DM Sans,sans-serif",cursor:"pointer",marginBottom:10,padding:0,
                  fontWeight:500
                }}
                  onMouseEnter={e=>e.currentTarget.style.color=T.ink}
                  onMouseLeave={e=>e.currentTarget.style.color=T.sub}>
                  ← Back to Dashboard
                </button>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <Avatar name={viewingApp.name} role="Apprentice" size={40}/>
                  <div>
                    <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:24,fontWeight:700,letterSpacing:"-.4px"}}>
                      {viewingApp.name}
                    </h1>
                    <p style={{fontSize:13,color:T.sub,marginTop:2}}>Apprentice Timesheet — Admin view</p>
                  </div>
                </div>
              </div>
            ) : adminAppList ? (
              <div>
                <button onClick={()=>setShowAppList(false)} style={{
                  display:"inline-flex",alignItems:"center",gap:6,
                  background:"none",border:"none",color:T.sub,fontSize:13,
                  fontFamily:"DM Sans,sans-serif",cursor:"pointer",marginBottom:10,padding:0,
                  fontWeight:500
                }}
                  onMouseEnter={e=>e.currentTarget.style.color=T.ink}
                  onMouseLeave={e=>e.currentTarget.style.color=T.sub}>
                  ← Back to Dashboard
                </button>
                <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:26,fontWeight:700,letterSpacing:"-.4px"}}>
                  {showAppList==="apprentices"?"Apprentices"
                  :showAppList==="hours"?"Hours This Week"
                  :showAppList==="submitted"?"Pending"
                  :showAppList==="approved"?"Submitted — Approved"
                  :showAppList==="declined"?"Submitted — Not Approved"
                  :showAppList==="contacts"?"Contacts"
                  :showAppList==="hosts"?"Host Businesses"
                  :showAppList==="leave"?"Leave Requests"
                  :"Target Deals"}
                </h1>
                <p style={{fontSize:13,color:T.sub,marginTop:4}}>
                  {showAppList==="apprentices"&&"Manage apprentice accounts — click a row to view their timesheet"}
                  {showAppList==="hours"&&"All entries this week, grouped by apprentice A–Z"}
                  {showAppList==="submitted"&&"Submitted timesheets awaiting approval, grouped by apprentice A–Z"}
                  {showAppList==="approved"&&"Approved entries, grouped by apprentice A–Z"}
                  {showAppList==="declined"&&"Declined entries, grouped by apprentice A–Z"}
                  {showAppList==="contacts"&&"Business and other contacts — not system users"}
                  {showAppList==="hosts"&&"Companies that host apprentices for on-the-job training"}
                  {showAppList==="deals"&&"Target deals, opportunities and pipeline"}
                  {showAppList==="leave"&&"All leave requests — awaiting KTA approval listed first"}
                </p>
              </div>
            ) : (
              <div>
                <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:26,fontWeight:700,letterSpacing:"-.4px"}}>
                  {activeMod==="dashboard"?"Dashboard":activeMod==="timesheet"?"Timesheet":activeMod==="crm"?"CRM":activeMod==="mentor"?"My Apprentices":"User Management"}
                </h1>
                <p style={{fontSize:13,color:T.sub,marginTop:4}}>
                  {activeMod==="dashboard"&&"Overview of all apprentice timesheets"}
                  {activeMod==="timesheet"&&"Time entries — access enforced by role"}
                  {activeMod==="mentor"&&"Your apprentices, meeting reports and PPE records"}
                  {activeMod==="users"&&"Manage all users, roles and allocations"}
                </p>
              </div>
            )}
          </div>

          {/* Module routing */}
          {adminViewingApprentice && (
            <ApprenticeDetailView
              apprentice={viewingApp}
              viewer={currentUser}
              allUsers={users}
              entries={entries}
              isAdmin={true}
              onBack={()=>setViewingAppId(null)}
            />
          )}
          {adminAppList && showAppList==="apprentices" && (
            <ApprenticeList
              allUsers={users}
              setUsers={updateUsers}
              onViewTimesheet={(id)=>{setViewingAppId(id);setShowAppList(false);}}
            />
          )}
          {adminAppList && showAppList==="hours" && (
            <WeeklyHoursList allUsers={users} entries={entries}/>
          )}
          {adminAppList && showAppList==="submitted" && (
            <ApprovalList
              allUsers={users} entries={entries} status="submitted"
              onApprove={(id)=>updateEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"approved"}:e))}
              onDecline={(id)=>updateEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"declined"}:e))}
            />
          )}
          {adminAppList && showAppList==="approved" && (
            <ApprovalList allUsers={users} entries={entries} status="approved"
              onApprove={()=>{}} onDecline={()=>{}}
            />
          )}
          {adminAppList && showAppList==="declined" && (
            <ApprovalList allUsers={users} entries={entries} status="declined"
              onApprove={(id)=>updateEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"approved"}:e))}
              onDecline={()=>{}}
            />
          )}
          {adminAppList && showAppList==="contacts" && <ContactsList/>}
          {adminAppList && showAppList==="hosts"    && <HostBusinessList/>}
          {adminAppList && showAppList==="deals"    && <TargetDealsList/>}
          {adminAppList && showAppList==="leave"    && <LeaveRequestsListPage currentUser={currentUser} allUsers={users} entries={entries} setEntries={updateEntries}/>}
          {module!=="xero" && <>
          {!adminViewingApprentice && !adminAppList && activeMod==="dashboard" && role==="Admin" && (
            <>
              <AdminDashboard
                allUsers={users}
                entries={entries}
                currentUser={currentUser}
                onViewApprentice={(id)=>setViewingAppId(id)}
                onViewApprenticeList={()=>{setShowAppList('apprentices');setViewingAppId(null);}}
                onViewList={(key)=>{setShowAppList(key);setViewingAppId(null);}}
                onViewTimesheets={()=>setModule("timesheet")}
                onViewLeave={()=>{ setShowAppList("leave"); setViewingAppId(null); }}
              />

              {currentUser.email?.toLowerCase() === CONF_OWNER_EMAIL && (
                <ConfidentialNotesCard currentUser={currentUser} allUsers={users}/>
              )}
            </>
          )}
          {activeMod==="timesheet" && (
            <>
              {role==="Approver" && (
                <LeaveRequestsPanel currentUser={currentUser} allUsers={users} entries={entries} setEntries={updateEntries}/>
              )}
              <TimesheetModule currentUser={currentUser} allUsers={users} entries={entries} setEntries={updateEntries}/>
              {role==="Apprentice" && (
                <MyLeaveRequests currentUser={currentUser}/>
              )}
              {role==="Apprentice" && (
                <LeaveToggleCard currentUser={currentUser} allUsers={users}/>
              )}
              {["Apprentice","Approver","Viewer"].includes(role) && (
                <ContactUs
                  currentUser={currentUser}
                  allUsers={users}
                  onSend={async(selectedUser, message)=>{
                    const apprenticeId = role==="Apprentice" ? currentUser.id
                      : allUsers.find(u=>u.id===selectedUser.id&&u.role==="Apprentice")?.id || currentUser.id;
                    await insertMessage({
                      id: uid(),
                      apprentice_id: apprenticeId,
                      sender_id: currentUser.id,
                      body: message,
                      created_at: new Date().toISOString(),
                    }).catch(console.error);
                    await pushNotif(
                      [selectedUser.id],
                      "broadcast",
                      `💬 Message from ${currentUser.name}`,
                      message,
                      currentUser.id,
                      {}
                    );
                  }}
                />
              )}
            </>
          )}
          {activeMod==="mentor" && role==="Mentor" && (
            <>
              <LeaveRequestsPanel currentUser={currentUser} allUsers={users} entries={entries} setEntries={updateEntries}/>
              <MentorDashboard currentUser={currentUser} allUsers={users}/>
            </>
          )}
          {activeMod==="crm" && (
            <CRMModule currentUser={currentUser} allUsers={users}/>
          )}
          {activeMod==="users" && role==="Admin" && (
            <UserManagement users={users} setUsers={updateUsers} currentUser={currentUser}/>
          )}
          {activeMod==="emails" && (
            <EmailsModule allUsers={users} currentUser={currentUser}/>
          )}
          </>}
          {module==="xero" && isAdmin1 && (
            <XeroModule
              allUsers={users}
              entries={entries}
              currentUser={currentUser}
              onUpdateEntries={updateEntries}
              showToast={showToast}
              onImportUser={u=>setUsers(prev=>[...prev, u])}
            />
          )}
        </main>
      </div>
      {appToast&&(
        <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",
          background:appToast.ok?"#1a8a7a":"#bf2b2b",color:"#fff",
          padding:"10px 20px",borderRadius:10,fontWeight:600,fontSize:13,
          boxShadow:"0 4px 16px #0004",zIndex:9999,fontFamily:"DM Sans,sans-serif",
          animation:"fadeIn .2s"}}>
          {appToast.msg}
        </div>
      )}
    </>
  );
}
