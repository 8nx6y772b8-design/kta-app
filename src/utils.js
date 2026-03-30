// KTA utility functions, auth helpers, email/push/token helpers
import { T, EMAIL_PROXY, LEAVE_ACTION_URL, CALENDAR_PROXY, TIMESHEET_ACTION_URL } from "./constants.js";
import { upsertUser, insertNotification, sb } from "./supabaseClient.js";
import { sendWebPush } from "./webPush.js";

const getNZHolidays = (year) => {
  const h = new Set();
  // Helper: add a date, mondayising if it falls on weekend
  const add = (y, m, d) => {
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay();
    if(dow === 0) dt.setDate(d + 1);      // Sun → Mon
    else if(dow === 6) dt.setDate(d + 2); // Sat → Mon
    h.add(dt.toISOString().slice(0, 10));
  };
  // Waitangi Day & Anzac Day: if on Sat/Sun move to following Monday (since 2015)
  const addWaitanziAnzac = (y, m, d) => {
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay();
    if(dow === 0) dt.setDate(d + 1);
    else if(dow === 6) dt.setDate(d + 2);
    h.add(dt.toISOString().slice(0, 10));
  };
  // Fixed-date holidays
  add(year, 1, 1);   // New Year's Day
  add(year, 1, 2);   // Day after New Year's
  addWaitanziAnzac(year, 2, 6);  // Waitangi Day
  addWaitanziAnzac(year, 4, 25); // Anzac Day
  add(year, 12, 25); // Christmas Day
  add(year, 12, 26); // Boxing Day
  // Easter (Good Friday + Easter Monday) — Butcher's algorithm
  const a=year%19, b=Math.floor(year/100), c=year%100;
  const d2=Math.floor(b/4), e=b%4, f=Math.floor((b+8)/25);
  const g=Math.floor((b-f+1)/3), hh=(19*a+b-d2-g+15)%30;
  const i=Math.floor(c/4), k=c%4, l=(32+2*e+2*i-hh-k)%7;
  const m2=Math.floor((a+11*hh+22*l)/451);
  const month=Math.floor((hh+l-7*m2+114)/31);
  const day=((hh+l-7*m2+114)%31)+1;
  const easter = new Date(year, month-1, day); // Easter Sunday
  const gf = new Date(easter); gf.setDate(gf.getDate()-2);
  const em = new Date(easter); em.setDate(em.getDate()+1);
  h.add(gf.toISOString().slice(0,10)); // Good Friday
  h.add(em.toISOString().slice(0,10)); // Easter Monday
  // Queen's/King's Birthday — 1st Monday of June
  const kb = new Date(year, 5, 1);
  kb.setDate(1 + (8 - kb.getDay()) % 7);
  h.add(kb.toISOString().slice(0,10));
  // Matariki — legislated dates (2022–2034)
  const matariki = {
    2022:"2022-06-24",2023:"2023-07-14",2024:"2024-06-28",
    2025:"2025-06-20",2026:"2026-07-10",2027:"2027-06-25",
    2028:"2028-07-14",2029:"2029-07-06",2030:"2030-06-21",
    2031:"2031-07-11",2032:"2032-07-02",2033:"2033-06-24",2034:"2034-07-12",
  };
  if(matariki[year]) h.add(matariki[year]);
  // Labour Day — 4th Monday of October
  const ld = new Date(year, 9, 1);
  const firstMon = (8 - ld.getDay()) % 7;
  ld.setDate(1 + firstMon + 21);
  h.add(ld.toISOString().slice(0,10));
  return h;
};

const autoFillLeaveEntries = async (apprenticeId, leaveType, dateFrom, dateTo, existingEntries, setEntries) => {
  const entryType = LEAVE_TO_ENTRY_TYPE[leaveType] || "Other";
  const start = "08:00", end = "16:30", breakMins = 30;
  const netHours = calcNet(start, end, breakMins); // 8.0

  // Build NZ holiday sets for all years spanned
  const yearFrom = parseInt(dateFrom.slice(0,4));
  const yearTo   = parseInt(dateTo.slice(0,4));
  const nzHolidays = new Set();
  for(let y = yearFrom; y <= yearTo; y++) {
    for(const d of getNZHolidays(y)) nzHolidays.add(d);
  }

  const days = [];
  const cur = new Date(dateFrom + "T00:00:00");
  const last = new Date(dateTo   + "T00:00:00");

  while (cur <= last) {
    const dow = cur.getDay(); // 0=Sun, 6=Sat
    const dateStr = cur.toISOString().slice(0, 10);
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = nzHolidays.has(dateStr);
    if (!isWeekend && !isHoliday) {
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
// Generate an iCal (.ics) calendar invite as a base64 attachment
const makeIcalAttachment = (apprenticeName, leaveType, dateFrom, dateTo, attendeeEmail, attendeeName) => {
  // Build UID
  const icalUid = `kta-leave-${dateFrom}-${apprenticeName.replace(/\s+/g,"-").toLowerCase()}@kta.org.nz`;
  // End date for all-day events in iCal is exclusive (day after last day)
  const endDt = new Date(dateTo + "T00:00:00");
  endDt.setDate(endDt.getDate() + 1);
  const endStr = endDt.toISOString().slice(0,10).replace(/-/g,"");
  const startStr = dateFrom.replace(/-/g,"");
  const now = new Date().toISOString().replace(/[-:]/g,"").slice(0,15) + "Z";

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KTA Workforce//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${icalUid}`,
    `DTSTAMP:${now}`,
    `DTSTART;VALUE=DATE:${startStr}`,
    `DTEND;VALUE=DATE:${endStr}`,
    `SUMMARY:${apprenticeName} — ${leaveType}`,
    `DESCRIPTION:Leave approved by KTA for ${apprenticeName}.\nType: ${leaveType}\nFrom: ${dateFrom}\nTo: ${dateTo}`,
    "STATUS:CONFIRMED",
    "TRANSP:TRANSPARENT",
    `ATTENDEE;CN=${attendeeName};ROLE=REQ-PARTICIPANT:mailto:${attendeeEmail}`,
    "ORGANIZER;CN=KTA Workforce:mailto:payroll@kta.org.nz",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  // Base64 encode
  const b64 = btoa(unescape(encodeURIComponent(ics)));
  return {
    filename: `kta-leave-${dateFrom}.ics`,
    content: b64,
    encoding: "base64",
    contentType: "text/calendar; method=REQUEST",
  };
};

// Send iCal invite email to a single recipient
const sendCalendarInvite = async (toEmail, toName, apprenticeName, leaveType, dateFrom, dateTo) => {
  const attach = makeIcalAttachment(apprenticeName, leaveType, dateFrom, dateTo, toEmail, toName);
  const fmtNZ = iso => { const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };
  await sendKTAEmail({
    to: toEmail,
    subject: `Calendar: ${apprenticeName} — ${leaveType} (${fmtNZ(dateFrom)}–${fmtNZ(dateTo)})`,
    html: leaveEmailHtml(
      `<strong>Leave Calendar Reminder</strong>`,
      `<p style="font-size:14.3px;color:#0d1b2e">A calendar invite has been attached for the approved leave period below. Please add it to your calendar.</p>
       <table style="width:100%;border-collapse:collapse;font-size:14.3px;margin:12px 0">
         <tr><td style="padding:7px 12px;background:#f0f4f9;font-weight:700;width:40%">Apprentice</td><td style="padding:7px 12px">${apprenticeName}</td></tr>
         <tr><td style="padding:7px 12px;background:#f0f4f9;font-weight:700">Leave Type</td><td style="padding:7px 12px">${leaveType}</td></tr>
         <tr><td style="padding:7px 12px;background:#f0f4f9;font-weight:700">From</td><td style="padding:7px 12px">${fmtNZ(dateFrom)}</td></tr>
         <tr><td style="padding:7px 12px;background:#f0f4f9;font-weight:700">To</td><td style="padding:7px 12px">${fmtNZ(dateTo)}</td></tr>
       </table>
       <div style="background:#dce8f7;border-radius:8px;padding:12px 16px;font-size:13.2px;color:#1b4f8c;font-weight:700">
         ★ Fully approved by KTA — please open the attached .ics file to add to your calendar.
       </div>`
    ),
    attachments: [attach],
  }).catch(e => console.error("Calendar invite failed for", toEmail, e));
};

const LEAVE_TOKEN_SECRET = import.meta.env.VITE_HMAC_SECRET || "kta-leave-action-secret-v1";

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

export const leaveActionUrl = async (leaveId, action, actorId, actorRole) => {
  const exp     = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const token   = await signLeaveToken({ id: leaveId, action, actorId, actorRole, exp });
  return `${LEAVE_ACTION_URL}?token=${token}`;
};
export const sendKTAEmail = async ({ to, subject, html, attachments, from }) => {
  const res = await fetch(EMAIL_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sendEmail", to, subject, html, attachments, ...(from ? { from } : {}) }),
  });
  if (!res.ok) throw new Error("Email send failed: " + await res.text());
};


export const generateReportPDF = (report, apprentice, mentor, snapshots=[]) => {
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

  // App theme colours in PDF operator format (r g b)
  const NAVY   = "0.106 0.310 0.549";  // #1b4f8c
  const TEAL   = "0.102 0.541 0.478";  // #1a8a7a
  const INK    = "0.051 0.106 0.180";  // #0d1b2e
  const SUB    = "0.290 0.353 0.443";  // #4a5a72
  const MUTED  = "0.561 0.627 0.722";  // #8fa0b8
  const BGROW1 = "0.941 0.957 0.976";  // #f0f4f9
  const BGROW2 = "0.969 0.980 0.992";  // #f8fafc
  const WHITE  = "1 1 1";
  const BORDER = "0.816 0.855 0.918";  // #d0daea

  // NZ local date
  const _nzNow = new Date(Date.now() + (13 * 60 * 60 * 1000));
  const dateStr = _nzNow.toISOString().slice(0,10).split('-').reverse().join('/');

  // Shared page header helper — navy banner + KTA wordmark top-left
  const pageHeader = (S, title, sub) => {
    // Full-width navy banner
    S.push(`${NAVY} rg 0 ${H - 68} ${W} 68 re f`);
    // KTA wordmark (white, large, top-left)
    S.push(`${WHITE} rg BT /F1 20 Tf ${margin} ${H - 36} Td (KTA) Tj ET`);
    // Title and subtitle
    S.push(`${WHITE} rg BT /F1 13 Tf ${margin + 46} ${H - 30} Td (${esc(title)}) Tj ET`);
    S.push(`BT /F2 8 Tf ${NAVY} rg`);  // reset color for sub (will be overridden)
    S.push(`0.753 0.859 0.965 rg BT /F2 8 Tf ${margin + 46} ${H - 44} Td (${esc(sub)}) Tj ET`);
    // Teal accent strip below banner
    S.push(`${TEAL} rg 0 ${H - 72} ${W} 4 re f`);
  };

  // Page footer helper
  const pageFooter = (S, left, right) => {
    S.push(`${NAVY} rg 0 0 ${W} 28 re f`);
    S.push(`${WHITE} rg BT /F2 7 Tf ${margin} 10 Td (${esc(left)}) Tj ET`);
    S.push(`${WHITE} rg BT /F2 7 Tf ${W - margin - 60} 10 Td (${esc(right)}) Tj ET`);
  };

  const S = [];

  // Page 1 header
  pageHeader(S, "Apprentice Check In Report", "Kiwi Trade Apprentices  ·  kta.org.nz");
  let y = H - 88;

  // ── Meta table (2-column grid, compact) ─────────────────────────────────
  // Left column: Trainee / Trade / Host / Location   Right column: Date / KTA rep / Licence / Next visit
  const metaL = [
    ["Trainee",      apprentice.name],
    ["Trade",        apprentice.trade || "Not specified"],
    ["Host Business",apprentice.hostBusiness || "Not specified"],
    ["Location",     report.location || "Not specified"],
  ];
  const metaR = [
    ["Date of Visit",      fD(report.date)],
    ["KTA Representative", mentor?.name||"—"],
    ["Licence Expiry",     apprentice.licenceExpiry ? fD(apprentice.licenceExpiry) : "Not set"],
    ["Next Visit",         fD(report.next_visit_date)],
  ];
  const COL = contentW / 2 - 4;
  const ROW_H = 14;
  metaL.forEach(([label, val], i) => {
    const bg = i % 2 === 0 ? BGROW1 : BGROW2;
    const lx = margin, rx = margin + COL + 8;
    const ry = y - 2;
    // Left cell
    S.push(`${bg} rg ${lx} ${ry} ${COL} ${ROW_H} re f`);
    S.push(`${TEAL} rg ${lx} ${ry} 2 ${ROW_H} re f`);
    S.push(`${SUB} rg BT /F1 7 Tf ${lx + 5} ${ry + 4} Td (${esc(label)}) Tj ET`);
    S.push(`${INK} rg BT /F2 7 Tf ${lx + 80} ${ry + 4} Td (${esc(String(metaL[i][1]||""))}) Tj ET`);
    // Right cell
    S.push(`${bg} rg ${rx} ${ry} ${COL} ${ROW_H} re f`);
    S.push(`${TEAL} rg ${rx} ${ry} 2 ${ROW_H} re f`);
    S.push(`${SUB} rg BT /F1 7 Tf ${rx + 5} ${ry + 4} Td (${esc(metaR[i][0])}) Tj ET`);
    S.push(`${INK} rg BT /F2 7 Tf ${rx + 80} ${ry + 4} Td (${esc(String(metaR[i][1]||""))}) Tj ET`);
    y -= (ROW_H + 2);
  });
  y -= 8;

  // ── Sections — compact, app-style ──────────────────────────────────────
  // Estimate height needed for a section before rendering
  const estimateH = (body) => {
    const lines = wrap(body, 95);
    return 14 + lines.length * 11 + 6; // header + lines + gap
  };

  // Check if all remaining sections fit; if not, start new page
  let pages = [S];
  let curPage = S;
  let overflowed = false;

  const section = (title, body) => {
    if(!body || !body.trim()) return; // skip empty sections
    const needed = estimateH(body);
    if(y - needed < 44 && !overflowed) {
      // Overflow — write footer on current page and start page 2
      pageFooter(curPage, "KTA Workforce Management  ·  kta.org.nz", "Generated " + dateStr);
      const S2c = [];
      pages.push(S2c);
      curPage = S2c;
      pageHeader(curPage, "Apprentice Check In Report (cont.)", "Kiwi Trade Apprentices  ·  kta.org.nz");
      y = H - 88;
      overflowed = true;
    }
    // Teal section header pill
    curPage.push(`${TEAL} rg ${margin} ${y - 1} ${contentW} 13 re f`);
    curPage.push(`${WHITE} rg BT /F1 8 Tf ${margin + 4} ${y + 4} Td (${esc(title)}) Tj ET`);
    y -= 15;
    const wrapped = wrap(body, 95);
    for(const line of wrapped) {
      curPage.push(`${INK} rg BT /F2 8 Tf ${margin + 4} ${y + 1} Td (${esc(line)}) Tj ET`);
      y -= 11;
    }
    y -= 6;
    // Subtle teal rule
    curPage.push(`0.863 0.949 0.941 rg ${margin} ${y + 3} ${contentW} 1 re f`);
  };

  section("Off Job Progress Since Last Visit",  report.off_job_progress);
  section("On Job Progress Since Last Visit",   report.on_job_progress);
  section("Previous Goals",                     report.previous_goals);
  section("Goals Before Next Visit",            report.goals_this_meeting);
  section("Comments and Feedback",              report.comments_feedback);

  // Footer on last content page
  pageFooter(curPage, "KTA Workforce Management  ·  kta.org.nz", "Generated " + dateStr);

  const f1Id = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`);
  const f2Id = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  // Reserve the pagesId slot NOW so page objects can reference it correctly
  const pagesSlot = ++id; objs.push({ id: pagesSlot, c: "PLACEHOLDER" });

  // Render each content page (1 or 2 if overflow)
  const contentPageIds = pages.map(pg => {
    const stream = pg.join("\n");
    const cId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesSlot} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${cId} 0 R /Resources << /Font << /F1 ${f1Id} 0 R /F2 ${f2Id} 0 R >> >> >>`);
  });
  const pageId = contentPageIds[0];

  // ── Page 2: Programme Progress graph (only if snapshots available) ────────
  let page2Id = null;
  if(snapshots && snapshots.length > 0) {
    const sorted = [...snapshots].sort((a,b) => a.months_in_training - b.months_in_training);
    const S2 = [];

    // Page 2 header — reuse same helper
    pageHeader(S2, "Programme Progress — " + apprentice.name, "Kiwi Trade Apprentices  ·  EarnLearn Progress Report");

    // Graph area
    const GX = margin, GY = 280, GW = contentW, GH = 340;
    const maxMo = Math.max(...sorted.map(s => s.months_in_training), sorted[0]?.programme_duration || 42);
    const xS = (m) => GX + (m / maxMo) * GW;
    const yS = (p) => GY + (p / 100) * GH;

    // Grid background
    S2.push("0.953 0.961 0.976 rg");
    S2.push(`${GX} ${GY} ${GW} ${GH} re f`);

    // Gridlines + Y labels
    [0,25,50,75,100].forEach(t => {
      S2.push("0.843 0.863 0.894 rg");
      S2.push(`${GX} ${yS(t) - 0.5} ${GW} 0.5 re f`);
      S2.push(`0.565 0.627 0.710 rg BT /F2 7 Tf ${GX - 25} ${yS(t) - 3} Td (${esc(t + "%")}) Tj ET`);
    });

    // X axis labels (every 6 months)
    for(let m = 0; m <= maxMo; m += 6) {
      S2.push("0.843 0.863 0.894 rg");
      S2.push(`${xS(m) - 0.25} ${GY} 0.5 ${GH} re f`);
      S2.push(`0.565 0.627 0.710 rg BT /F2 7 Tf ${xS(m) - 6} ${GY - 14} Td (${esc(m + "m")}) Tj ET`);
    }

    // Programme end dashed line
    if(sorted[0]?.programme_duration) {
      const ex = xS(sorted[0].programme_duration);
      S2.push("0.749 0.169 0.169 rg");
      for(let yy = GY; yy < GY + GH; yy += 8) {
        S2.push(`${ex - 0.5} ${yy} 1 4 re f`);
      }
      S2.push(`0.749 0.169 0.169 rg BT /F2 6 Tf ${ex - 10} ${GY + GH + 6} Td (${esc("End")}) Tj ET`);
    }

    // Lines and dots for each metric
    const LINES = [
      { key:"overall_percent",     label:"Overall",     r:0.106, g:0.310, b:0.549 },
      { key:"off_job_l3_percent",  label:"Off-Job L3",  r:0.102, g:0.541, b:0.478 },
      { key:"off_job_l4_percent",  label:"Off-Job L4",  r:0.627, g:0.471, b:0.125 },
      { key:"on_job_core_percent", label:"On-Job Core", r:0.420, g:0.310, b:0.627 },
      { key:"on_job_spec_percent", label:"On-Job Spec", r:0.749, g:0.169, b:0.169 },
    ];

    LINES.forEach(({ key, label, r, g, b }) => {
      const pts = sorted.filter(s => s[key] != null);
      if(pts.length === 0) return;
      S2.push(`${r} ${g} ${b} RG`);
      S2.push("1.5 w");
      // Line
      pts.forEach((s, i) => {
        const px = xS(s.months_in_training), py = yS(s[key]);
        S2.push(i === 0 ? `${px} ${py} m` : `${px} ${py} l`);
      });
      S2.push("S");
      // Dots
      pts.forEach(s => {
        const px = xS(s.months_in_training), py = yS(s[key]);
        // Filled circle approximation using 4 bezier arcs
        const r2 = 3;
        S2.push(`${r} ${g} ${b} rg`);
        S2.push(`${px - r2} ${py} m ${px - r2} ${py + r2 * 0.552} ${px - r2 * 0.552} ${py + r2} ${px} ${py + r2} c`);
        S2.push(`${px + r2 * 0.552} ${py + r2} ${px + r2} ${py + r2 * 0.552} ${px + r2} ${py} c`);
        S2.push(`${px + r2} ${py - r2 * 0.552} ${px + r2 * 0.552} ${py - r2} ${px} ${py - r2} c`);
        S2.push(`${px - r2 * 0.552} ${py - r2} ${px - r2} ${py - r2 * 0.552} ${px - r2} ${py} c f`);
        // Value label
        S2.push(`0.051 0.106 0.180 rg BT /F2 6 Tf ${px - 4} ${py + 5} Td (${esc(Math.round(s[key]) + "%")}) Tj ET`);
      });
    });

    // Axes border
    S2.push("0.565 0.627 0.710 RG 0.5 w");
    S2.push(`${GX} ${GY} m ${GX + GW} ${GY} l ${GX + GW} ${GY + GH} l ${GX} ${GY + GH} l ${GX} ${GY} l S`);

    // Axis labels
    S2.push(`0.290 0.353 0.443 rg BT /F2 8 Tf ${GX + GW/2 - 40} ${GY - 26} Td (${esc("Months in Training")}) Tj ET`);

    // Legend
    let lx = margin, ly = GY + GH + 36;
    S2.push(`0.290 0.353 0.443 rg BT /F1 8 Tf ${lx} ${ly} Td (${esc("Legend:")}) Tj ET`);
    lx += 40;
    LINES.forEach(({ label, r, g, b }) => {
      if(!sorted.some(s => s[label.toLowerCase().replace(/-/g,"_")+"_percent"] != null)) {
        // check by key
      }
      S2.push(`${r} ${g} ${b} rg ${lx} ${ly + 1} 16 4 re f`);
      S2.push(`0.051 0.106 0.180 rg BT /F2 7 Tf ${lx + 19} ${ly} Td (${esc(label)}) Tj ET`);
      lx += 65;
    });

    // Section summary bars (latest snapshot)
    const latest = sorted[sorted.length - 1];
    const bars = [
      { label:"Skills Week",  val:latest.skills_week_percent,  r:0.102, g:0.541, b:0.478 },
      { label:"Off-Job L3",   val:latest.off_job_l3_percent,   r:0.102, g:0.541, b:0.478 },
      { label:"Off-Job L4",   val:latest.off_job_l4_percent,   r:0.627, g:0.471, b:0.125 },
      { label:"On-Job Core",  val:latest.on_job_core_percent,  r:0.420, g:0.310, b:0.627 },
      { label:"On-Job Spec",  val:latest.on_job_spec_percent,  r:0.749, g:0.169, b:0.169 },
      { label:"On Job Books", val:latest.booklets_percent,      r:0.106, g:0.310, b:0.549 },
    ].filter(b => b.val != null);

    if(bars.length > 0) {
      let by = GY - 60;
      S2.push(`0.102 0.541 0.478 rg ${margin} ${by + 4} ${contentW} 14 re f`);
      S2.push(`1 1 1 rg BT /F1 9 Tf ${margin + 2} ${by + 8} Td (${esc("Latest Progress Snapshot — " + (latest.report_date||""))}) Tj ET`);
      by -= 18;

      const BW = (contentW - (bars.length - 1) * 8) / bars.length;
      bars.forEach((bar, i) => {
        const bx = margin + i * (BW + 8);
        const fillH = Math.max(2, ((bar.val || 0) / 100) * 40);
        // Background
        S2.push(`0.902 0.914 0.933 rg ${bx} ${by - 40} ${BW} 40 re f`);
        // Fill
        S2.push(`${bar.r} ${bar.g} ${bar.b} rg ${bx} ${by - 40} ${BW} ${fillH} re f`);
        // Label
        S2.push(`0.290 0.353 0.443 rg BT /F2 6 Tf ${bx + 2} ${by - 48} Td (${esc(bar.label)}) Tj ET`);
        S2.push(`0.051 0.106 0.180 rg BT /F1 7 Tf ${bx + BW/2 - 8} ${by - 35 + fillH} Td (${esc(Math.round(bar.val) + "%")}) Tj ET`);
      });
    }

    pageFooter(S2, "KTA Workforce Management  ·  Programme Progress", "Generated " + dateStr);

    const s2 = S2.join("\n");
    const c2Id = add(`<< /Length ${s2.length} >>\nstream\n${s2}\nendstream`);
    page2Id    = add(`<< /Type /Page /Parent ${pagesSlot} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${c2Id} 0 R /Resources << /Font << /F1 ${f1Id} 0 R /F2 ${f2Id} 0 R >> >> >>`);
  }

  // Fill in the reserved pagesId slot with all page IDs
  const allPageIds = [...contentPageIds, ...(page2Id ? [page2Id] : [])];
  const kidsList   = allPageIds.map(pid => `${pid} 0 R`).join(" ");
  const pagesId    = pagesSlot;
  objs[objs.findIndex(o => o.id === pagesSlot)].c = `<< /Type /Pages /Kids [${kidsList}] /Count ${allPageIds.length} >>`;
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

export const _sha256hex = async (str) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
};
export const hashPw = async (pw) => {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b=>b.toString(16).padStart(2,"0")).join("");
  const hash = await _sha256hex(salt + pw);
  return `${salt}:${hash}`;
};
export const checkPw = async (pw, stored) => {
  if(!stored) return false;
  if(stored.includes(":")) {
    // SHA-256 path
    const [salt, hash] = stored.split(":");
    return (await _sha256hex(salt + pw)) === hash;
  }
  // Legacy XOR path — accept but caller should upgrade
  const legacy = btoa([...pw].map((c,i)=>String.fromCharCode(c.charCodeAt(0)^(42+i%7))).join(""));
  return legacy === stored;
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
export const uid      = () => Math.random().toString(36).slice(2,9);
export const tod      = () => new Date().toISOString().slice(0,10);
export const toMin    = t => { const[h,m]=t.split(":").map(Number); return h*60+m; };
export const calcNet  = (s,e,b) => { const d=toMin(e)-toMin(s)-b; return d>0?+(d/60).toFixed(2):0; };
export const fmtD     = d => new Date(d+"T00:00:00").toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short"});
const within14  = d => { const diff=(new Date(tod())-new Date(d+"T00:00:00"))/(86400000); return diff>=0&&diff<14; };
export const weekStart = () => { const d=new Date(); d.setDate(d.getDate()-((d.getDay()+6)%7)); d.setHours(0,0,0,0); return d.toISOString().slice(0,10); };
export const withinWeek = d => d >= weekStart();
export const daysAgoStr = n => { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };

// Send email notification to approvers when apprentice submits timesheets
// Sign a timesheet action token
const TIMESHEET_ACTION_URL = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/timesheet-action";
const TIMESHEET_TOKEN_SECRET = import.meta.env.VITE_HMAC_SECRET || "kta-leave-action-secret-v1"; // same secret, same env var

export const signTimesheetToken = async (payload) => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(TIMESHEET_TOKEN_SECRET),
    { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const data = enc.encode(JSON.stringify(payload));
  const sig  = await crypto.subtle.sign("HMAC", key, data);
  const b64  = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  return btoa(JSON.stringify(payload)) + "." + b64;
};

export const timesheetActionUrl = async (entryId, action, approverId) => {
  const exp   = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const token = await signTimesheetToken({ entryId, action, approverId, exp });
  return `${TIMESHEET_ACTION_URL}?token=${token}`;
};

// Generate a token that approves/declines ALL entries in one click
export const timesheetAllUrl = async (entryIds, action, approverId) => {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const token = await signTimesheetToken({ entryIds, action, approverId, exp });
  return `${TIMESHEET_ACTION_URL}?token=${token}`;
};

export const notifyApprovers = async (apprentice, approvers, entries) => {
  if(!approvers.length) return;
  // Compute hours summary — apply overtime split using apprentice settings
  // Note: we skip the overtimeRateId check here since this is display-only (not Xero submission)
  let normalHrs = 0;
  let overtimeHrs = 0;
  for(const e of entries) {
    const { overtimeType, overtimeThreshold } = apprentice;
    if(overtimeType && overtimeThreshold && e.type === "Normal Hours") {
      const threshold = parseFloat(overtimeThreshold);
      if(overtimeType === "daily") {
        normalHrs   += Math.min(e.netHours, threshold);
        overtimeHrs += Math.max(0, e.netHours - threshold);
      } else if(overtimeType === "weekly") {
        // Sum hours before this entry in the week
        const d = new Date(e.date + "T00:00:00");
        const day = d.getDay();
        const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7));
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        const monStr = mon.toISOString().slice(0,10);
        const sunStr = sun.toISOString().slice(0,10);
        const hoursBefore = entries
          .filter(x => x.date >= monStr && x.date <= sunStr && x.date < e.date)
          .reduce((s,x) => s + x.netHours, 0);
        const remainingNormal = Math.max(0, threshold - hoursBefore);
        normalHrs   += Math.min(e.netHours, remainingNormal);
        overtimeHrs += Math.max(0, e.netHours - remainingNormal);
      } else {
        normalHrs += e.netHours;
      }
    } else {
      if(e.type === "Normal Hours") normalHrs += e.netHours;
      else if(e.type === "Overtime") overtimeHrs += e.netHours;
      else normalHrs += e.netHours;
    }
  }
  const totalHrs = entries.reduce((a,e)=>a+e.netHours,0);
  const fmtH = h => h%1===0 ? h+"h" : h.toFixed(1)+"h";
  const toolAllowanceAmt = ((normalHrs + overtimeHrs) * 0.50).toFixed(2);

  for(const approver of approvers) {
    const isAdminL1 = approver.role === "Admin" && Number(approver.adminLevel ?? 1) === 1;
    const toolAllowanceBox = isAdminL1 ? `
  <div style="border-left:2px solid #d0daea;padding-left:20px"><div style="font-size:12.1px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Tool Allowance</div><div style="font-size:22px;font-weight:700;color:#6b46c1">$${toolAllowanceAmt}</div><div style="font-size:11px;color:#8fa0b8;margin-top:2px">Add manually in Xero</div></div>` : "";
    const summaryBox = `
<div style="background:#f0f4f9;border-radius:10px;padding:14px 18px;margin:16px 0;display:flex;gap:24px;flex-wrap:wrap">
  ${normalHrs>0?`<div><div style="font-size:12.1px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Normal Hours</div><div style="font-size:22px;font-weight:700;color:#1b4f8c">${fmtH(normalHrs)}</div></div>`:""}
  ${overtimeHrs>0?`<div><div style="font-size:12.1px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Overtime</div><div style="font-size:22px;font-weight:700;color:#b86e1a">${fmtH(overtimeHrs)}</div></div>`:""}
  <div><div style="font-size:12.1px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Total Hours</div><div style="font-size:22px;font-weight:700;color:#1a8a7a">${fmtH(totalHrs)}</div></div>
  ${toolAllowanceBox}
</div>`;
    if(!approver.email) continue;
    try {
      // Build per-entry rows with approve/decline buttons
      const entryRowsHtml = await Promise.all(entries.map(async (e) => {
        const appUrl = await timesheetActionUrl(e.id, "approve", approver.id);
        const decUrl = await timesheetActionUrl(e.id, "decline", approver.id);
        const isNormal   = e.type==="Normal Hours";
        const isOvertime = e.type==="Overtime";
        const typeColor  = isOvertime?"#b86e1a":isNormal?"#1b4f8c":"#4a5a72";

        // Calculate overtime split for this entry (display only — no rateId needed)
        let hoursCell = `<td style="padding:10px 12px;border-bottom:1px solid #e8edf3;font-size:14.3px;font-weight:700;color:#1b4f8c;text-align:right">${fmtH(e.netHours)}</td>`;
        let typeCell  = `<td style="padding:10px 12px;border-bottom:1px solid #e8edf3;font-size:13.2px;color:${typeColor}">${isNormal?"Normal":isOvertime?"Overtime":e.type}</td>`;
        if(isNormal && apprentice.overtimeType && apprentice.overtimeThreshold) {
          const threshold = parseFloat(apprentice.overtimeThreshold);
          let normalH = e.netHours, overtimeH = 0;
          if(apprentice.overtimeType === "daily") {
            normalH   = Math.min(e.netHours, threshold);
            overtimeH = Math.max(0, e.netHours - threshold);
          }
          if(overtimeH > 0) {
            typeCell  = `<td style="padding:10px 12px;border-bottom:1px solid #e8edf3;font-size:13.2px;color:#4a5a72">Normal + OT</td>`;
            hoursCell = `<td style="padding:10px 12px;border-bottom:1px solid #e8edf3;text-align:right">
              <span style="font-size:14.3px;font-weight:700;color:#1b4f8c">${fmtH(normalH)}</span>
              <span style="font-size:12.1px;color:#b86e1a;margin-left:4px">+${fmtH(overtimeH)} OT</span>
            </td>`;
          }
        }

        return `
<tr>
  <td style="padding:10px 12px;border-bottom:1px solid #e8edf3;font-size:14.3px;color:#0d1b2e;font-weight:700">${fmtD(e.date)}</td>
  ${typeCell}
  ${hoursCell}
  <td style="padding:10px 12px;border-bottom:1px solid #e8edf3;font-size:12.1px;color:#8fa0b8">${e.start||""}${e.end?" – "+e.end:""}</td>
  <td style="padding:10px 12px;border-bottom:1px solid #e8edf3;font-size:12.1px;color:#4a5a72;font-style:italic">${e.note||""}</td>
  <td style="padding:10px 12px;border-bottom:1px solid #e8edf3;white-space:nowrap">
    <a href="${appUrl}" style="display:inline-block;background:#1a8a7a;color:#fff;border-radius:5px;padding:4px 12px;font-size:12.1px;font-weight:700;text-decoration:none;margin-right:4px">&#10003;</a>
    <a href="${decUrl}" style="display:inline-block;background:#bf2b2b;color:#fff;border-radius:5px;padding:4px 12px;font-size:12.1px;font-weight:700;text-decoration:none">&#10005;</a>
  </td>
</tr>`;
      }));

      // Generate approve-all and decline-all URLs covering every entry
      const allEntryIds   = entries.map(e=>e.id);
      const approveAllUrl = await timesheetAllUrl(allEntryIds, "approve", approver.id);
      const declineAllUrl = await timesheetAllUrl(allEntryIds, "decline", approver.id);

      await sendKTAEmail({
        to: approver.email,
        subject: `Timesheet submitted — ${apprentice.name} (${fmtH(totalHrs)})`,
        html: `
<div style="font-family:DM Sans,Arial,sans-serif;max-width:620px;margin:0 auto;background:#f0f4f9;padding:24px">
  <div style="background:#1b4f8c;border-radius:10px 10px 0 0;padding:18px 24px">
    <div style="color:#fff;font-size:19.8px;font-weight:700">Timesheet Submitted</div>
    <div style="color:#dce8f7;font-size:13.2px;margin-top:4px">Kiwi Trade Apprentices · ${apprentice.name}</div>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 10px 10px;border:1px solid #d0daea">
    <p style="font-size:16.5px;color:#0d1b2e;margin-top:0">Hi ${approver.name},</p>
    <p style="font-size:15.4px;color:#4a5a72"><strong>${apprentice.name}</strong> has submitted ${entries.length} timesheet entr${entries.length===1?"y":"ies"} for your approval.</p>
    ${summaryBox}
    <div style="background:#e8f5f3;border:1.5px solid #1a8a7a;border-radius:10px;padding:16px 20px;margin:0 0 20px;text-align:center">
      <div style="font-size:14.3px;color:#4a5a72;margin-bottom:12px">Approve or decline all ${entries.length} ${entries.length===1?"entry":"entries"} at once:</div>
      <a href="${approveAllUrl}" style="display:inline-block;background:#1a8a7a;color:#fff;border-radius:8px;padding:12px 32px;font-size:16.5px;font-weight:700;text-decoration:none;margin-right:8px">✓ Approve Week</a>
      <a href="${declineAllUrl}" style="display:inline-block;background:#bf2b2b;color:#fff;border-radius:8px;padding:12px 32px;font-size:16.5px;font-weight:700;text-decoration:none">✕ Decline Week</a>
    </div>
    <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
      <thead>
        <tr style="background:#f0f4f9">
          <th style="padding:8px 12px;font-size:12.1px;color:#8fa0b8;text-align:left;text-transform:uppercase;letter-spacing:.5px;font-weight:700">Date</th>
          <th style="padding:8px 12px;font-size:12.1px;color:#8fa0b8;text-align:left;text-transform:uppercase;letter-spacing:.5px;font-weight:700">Type</th>
          <th style="padding:8px 12px;font-size:12.1px;color:#8fa0b8;text-align:right;text-transform:uppercase;letter-spacing:.5px;font-weight:700">Hours</th>
          <th style="padding:8px 12px;font-size:12.1px;color:#8fa0b8;text-align:left;text-transform:uppercase;letter-spacing:.5px;font-weight:700">Time</th>
          <th style="padding:8px 12px;font-size:12.1px;color:#8fa0b8;text-align:left;text-transform:uppercase;letter-spacing:.5px;font-weight:700">Note</th>
          <th style="padding:8px 12px;font-size:12.1px;color:#8fa0b8;text-align:left;text-transform:uppercase;letter-spacing:.5px;font-weight:700">Action</th>
        </tr>
      </thead>
      <tbody>${entryRowsHtml.join("")}</tbody>
    </table>
    <p style="font-size:13.2px;color:#8fa0b8">✓ = Approve that day &nbsp;|&nbsp; ✕ = Decline that day &nbsp;|&nbsp; Links expire in 7 days. No login required.</p>
    <p style="margin-top:16px"><a href="https://crmkta.com" style="display:inline-block;background:#1b4f8c;color:#fff;border-radius:8px;padding:10px 22px;font-size:14.3px;font-weight:700;text-decoration:none">Open KTA System →</a></p>
    <hr style="border:none;border-top:1px solid #d0daea;margin:20px 0">
    <p style="font-size:12.1px;color:#8fa0b8">KTA Workforce Management · payroll@kta.org.nz</p>
  </div>
</div>`,
      });
    } catch(err) {
      console.error("notifyApprovers error:", err);
    }
  }
};

// Notify apprentice of approval or decline
export const notifyApprentice = async (apprentice, approver, entries, approved) => {
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
<p style="color:#888;font-size:13.2px">KTA Workforce Management · payroll@kta.org.nz</p>`,
    });
  } catch(err) {
    console.error("notifyApprentice error:", err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STYLES
// ─────────────────────────────────────────────────────────────────────────────

// ─── Confidential notes access ──────────────────────────────────────────────
export const isConfOwner = (user) => !!user?.isConfOwner;

// ─── HubSpot lookup (via hubspot-proxy Edge Function) ────────────────────────
export const lookupHubspot = async (value) => {
  const isPhone = /^[+\d\s\-()]{6,}$/.test(value) && !/[@.]/.test(value);
  try {
    const res = await fetch(HUBSPOT_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "lookup", value: value.trim(), type: isPhone ? "phone" : "email" }),
    });
    if(!res.ok) return null;
    const data = await res.json();
    if(!data.result) return null;
    return data.result;
  } catch(e) {
    console.warn("HubSpot lookup failed:", e);
    return null;
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const ROLES = ["Apprentice","Approver","Viewer","Mentor","Supervisor","Admin"];
const ROLE_META = {
  Apprentice: { color: T.blue,   bg: T.blueL,  symbol: "◑", desc: "View & edit own timesheets (last 14 days)" },
  Approver:   { color: T.warn,   bg: T.warnL,  symbol: "▲", desc: "Approve or decline submitted timesheets for allocated apprentices" },
  Viewer:     { color: T.teal,   bg: T.tealL,  symbol: "◆", desc: "View all timesheet stages for allocated apprentices — read only" },
  Mentor:     { color: T.gold,   bg: T.goldL,  symbol: "✦", desc: "View allocated apprentice timesheets (read-only) and full CRM access" },
  Supervisor: { color: T.teal,   bg: T.tealL,  symbol: "⚙", desc: "View meeting reports, HSE check ins and leave requests. Timesheet access only if set as approver." },
  Admin:      { color: T.accent, bg: T.accentL,symbol: "★", desc: "Full access — manage all users, timesheets & CRM" },
  "Admin 1":  { color: T.accent, bg: T.accentL,symbol: "★", desc: "Full access including message history management" },
  "Admin 2":  { color: "#6d5fc7", bg: "#ede9ff",symbol: "☆", desc: "User management, timesheet view — cannot edit or delete messages" },
};

const ENTRY_TYPES = ["Normal Hours","Annual Leave","Sick Leave","Bereavement Leave","Leave Without Pay","Public Holiday","Overtime","Block Course","Other"];
const TYPE_META = {
  "Normal Hours":   { color: T.accent, bg: T.accentL, sym: "◈" },
  "Annual Leave":   { color: T.warn,   bg: T.warnL,   sym: "☀" },
  "Sick Leave":     { color: T.red,    bg: T.redL,    sym: "✚" },
