// KTA Timesheet Action &mdash; Supabase Edge Function
// One-click approve or decline a single timesheet entry from email link
// Deploy: supabase functions deploy timesheet-action
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LEAVE_TOKEN_SECRET (reused)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const APP_URL = "https://crmkta.com";
const SECRET_KEY = "LEAVE_TOKEN_SECRET"; // env var name &mdash; reuses same secret

// ── Shared CSS ────────────────────────────────────────────────────────────────
const CSS = `
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:Arial,sans-serif; background:#f0f4f9; min-height:100vh;
         display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { background:#fff; border-radius:16px; border:1.5px solid #d0daea;
          max-width:480px; width:100%; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,.08); }
  .hdr  { padding:24px 28px; }
  .ico  { font-size:40px; margin-bottom:12px; }
  .hdr h1   { color:#fff; font-size:20px; font-weight:700; margin-bottom:4px; }
  .hdr .sub { color:rgba(255,255,255,.72); font-size:12px; }
  .bod  { padding:24px 28px; }
  .bod p { font-size:14px; color:#0d1b2e; line-height:1.6; margin-bottom:12px; }
  .detail { background:#f0f4f9; border-radius:10px; padding:14px 16px; font-size:12px;
            color:#4a5a72; margin:12px 0 16px; line-height:2.1; }
  .detail b { color:#0d1b2e; }
  .btn { display:inline-block; background:#1b4f8c; color:#fff; border-radius:8px;
         padding:10px 22px; font-size:13px; font-weight:600; text-decoration:none; margin-top:6px; }
  .footer { font-size:11px; color:#8fa0b8; margin-top:16px; }
  textarea { width:100%; border:1.5px solid #d0daea; border-radius:8px; padding:10px;
             font-size:14px; font-family:inherit; resize:vertical; margin:10px 0 14px; color:#0d1b2e; }
  textarea:focus { outline:none; border-color:#1b4f8c; }
  .btn-red { background:#bf2b2b; color:#fff; border:none; border-radius:8px;
             padding:11px 24px; font-size:14px; font-weight:700; cursor:pointer;
             font-family:inherit; width:100%; margin-top:4px; }
  .err { color:#bf2b2b; font-size:12px; margin-bottom:8px; display:none; }`;

const wrap = (color: string, ico: string, title: string, body: string) =>
  `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} &mdash; KTA</title><style>${CSS}</style></head><body>
<div class="card">
  <div class="hdr" style="background:${color}">
    <div class="ico">${ico}</div><h1>${title}</h1>
    <div class="sub">Kiwi Trade Apprentices &middot; timesheet@kta.org.nz</div>
  </div>
  <div class="bod">${body}<p class="footer">KTA Timesheet Management &middot; Action recorded.</p></div>
</div></body></html>`;

const errPage = (msg: string) => wrap("#bf2b2b","⚠️","Something Went Wrong",
  `<p>${msg}</p><a href="${APP_URL}" class="btn">Open KTA System</a>`);

const declineFormHtml = (token: string, apprenticeName: string, date: string, hours: string, postUrl: string) =>
  `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Decline Timesheet Entry &mdash; KTA</title><style>${CSS}</style></head><body>
<div class="card">
  <div class="hdr" style="background:#bf2b2b">
    <div class="ico">&#10005;</div><h1>Decline Timesheet Entry</h1>
    <div class="sub">Kiwi Trade Apprentices &middot; timesheet@kta.org.nz</div>
  </div>
  <div class="bod">
    <div class="detail">
      <b>Apprentice:</b> ${apprenticeName}<br>
      <b>Date:</b> ${date}<br>
      <b>Hours:</b> ${hours}
    </div>
    <p>Please provide a reason for declining (this will be visible to the apprentice).</p>
    <div class="err" id="err">Please enter a reason.</div>
    <form method="POST" action="${postUrl}"
      onsubmit="var r=document.querySelector('textarea').value.trim();if(!r){document.getElementById('err').style.display='block';return false;}return true;">
      <input type="hidden" name="token" value="${token}">
      <textarea name="reason" rows="3" placeholder="e.g. Missing start/end times, incorrect hours…"></textarea>
      <button type="submit" class="btn-red">&#10005; Confirm Decline</button>
    </form>
  </div>
</div></body></html>`;

// ── HMAC token helpers ────────────────────────────────────────────────────────
async function getKey(s: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(s),
    {name:"HMAC",hash:"SHA-256"}, false, ["sign","verify"]);
}
async function verifyToken(token: string, secret: string): Promise<any|null> {
  try {
    const [pb, sb] = token.split(".");
    if(!pb||!sb) return null;
    const payload = JSON.parse(atob(pb));
    if(payload.exp && Date.now() > payload.exp) return null;
    const key  = await getKey(secret);
    const data = new TextEncoder().encode(JSON.stringify(payload));
    const pad  = sb.replace(/-/g,"+").replace(/_/g,"/") + "==".slice(0,(4-sb.length%4)%4);
    const buf  = Uint8Array.from(atob(pad), c => c.charCodeAt(0));
    return await crypto.subtle.verify("HMAC", key, buf, data) ? payload : null;
  } catch { return null; }
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
const SB = () => ({
  "apikey":        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
});

async function sbGet(table: string, qs: string): Promise<any[]> {
  // Note: entry IDs are short base36 strings (e.g. "nini9xp"), not UUIDs &mdash; no UUID guard here
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?${qs}`, {headers:SB()});
  if(!r.ok) throw new Error(`sbGet ${table}: ${await r.text()}`);
  return r.json();
}

async function sbPatch(table: string, id: string, body: object) {
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?id=eq.${id}`,
    {method:"PATCH", headers:SB(), body:JSON.stringify(body)});
  if(!r.ok) throw new Error(`sbPatch ${table}: ${await r.text()}`);
}

const fmtDate = (iso: string) => {
  if(!iso) return "&mdash;";
  const [y,m,d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

// ── Email helper ──────────────────────────────────────────────────────────────
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SENDER     = "timesheet@kta.org.nz";

async function getAppToken(): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${Deno.env.get("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({ grant_type:"client_credentials",
      client_id:Deno.env.get("MS_CLIENT_ID")!, client_secret:Deno.env.get("MS_CLIENT_SECRET")!,
      scope:"https://graph.microsoft.com/.default" })
  });
  if(!res.ok) throw new Error("Token: " + await res.text());
  return (await res.json()).access_token;
}

async function sendMail(to: string, subject: string, htmlBody: string) {
  const t = await getAppToken();
  await fetch(`${GRAPH_BASE}/users/${SENDER}/sendMail`, {
    method:"POST", headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},
    body:JSON.stringify({message:{subject,body:{contentType:"HTML",content:htmlBody},
      toRecipients:[{emailAddress:{address:to}}],
      from:{emailAddress:{address:SENDER,name:"KTA Timesheets"}}},saveToSentItems:true})
  });
}

// ── HTML response helper (proper UTF-8) ───────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

const html = (body: string, status = 200) =>
  new Response(body, {status, headers: {
    ...CORS,
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  }});

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if(req.method === "OPTIONS") return new Response(null, {headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  }});

  const sec = Deno.env.get(SECRET_KEY);
  if(!sec) return html(errPage("Server not configured. Contact KTA admin."), 500);

  const url = new URL(req.url);

  // ── POST: decline reason form submission ───────────────────────────────────
  if(req.method === "POST") {
    let fd: FormData;
    try { fd = await req.formData(); } catch { return html(errPage("Could not read form."), 400); }
    const token  = fd.get("token") as string;
    const reason = (fd.get("reason") as string || "").trim();
    if(!token)  return html(errPage("Missing token."), 400);
    if(!reason) return html(errPage("A reason is required."), 400);

    const payload = await verifyToken(token, sec);
    if(!payload) return html(wrap("#b86e1a","⏰","Link Expired",
      `<p>This link has expired. Please log in to <a href="${APP_URL}">the KTA system</a>.</p>`), 200);

    const { entryId, entryIds, approverId } = payload;
    const postEntryId = entryId || (entryIds && entryIds[0]);
    if(!postEntryId) return html(errPage("Invalid token &mdash; no entry ID."), 400);
    const [entryRows, approvers] = await Promise.all([
      sbGet("entries", `id=eq.${postEntryId}`),
      sbGet("users", `id=eq.${approverId}`),
    ]);
    if(!entryRows.length) return html(errPage("Timesheet entry not found."), 404);
    const entry    = entryRows[0];
    const approver = approvers[0] || { name:"Approver" };

    if(entry.approval === "declined") return html(
      wrap("#4a5a72","ℹ️","Already Declined",
        `<p>This entry has already been declined.</p><a href="${APP_URL}" class="btn">Open KTA System</a>`), 200);

    await sbPatch("entries", postEntryId, { approval:"declined", decline_reason:reason });

    // Notify apprentice
    const [apps] = [await sbGet("users", `id=eq.${entry.user_id}`)];
    const app = apps[0];
    if(app?.email) {
      await sendMail(app.email,
        `Timesheet Entry Declined &mdash; ${fmtDate(entry.date)}`,
        `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <div style="background:#bf2b2b;border-radius:10px 10px 0 0;padding:16px 22px">
            <div style="color:#fff;font-size:16px;font-weight:700">Timesheet Entry Declined</div>
            <div style="color:rgba(255,255,255,.7);font-size:12px">Kiwi Trade Apprentices</div>
          </div>
          <div style="background:#fff;padding:22px;border-radius:0 0 10px 10px;border:1px solid #d0daea">
            <p style="font-size:14px;color:#0d1b2e">Hi ${app.name},</p>
            <p style="font-size:14px;color:#4a5a72">Your timesheet entry for <strong>${fmtDate(entry.date)}</strong> has been declined by <strong>${approver.name}</strong>.</p>
            <div style="background:#fde8e8;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #bf2b2b">
              <div style="font-size:12px;font-weight:700;color:#bf2b2b;margin-bottom:4px">Reason</div>
              <div style="font-size:13px;color:#0d1b2e">${reason}</div>
            </div>
            <p style="font-size:13px;color:#4a5a72">Please correct and resubmit, or contact <strong>${approver.name}</strong> for more information.</p>
            <a href="${APP_URL}" style="display:inline-block;background:#1b4f8c;color:#fff;border-radius:8px;padding:10px 22px;font-size:13px;font-weight:600;text-decoration:none;margin-top:10px">Open KTA System &rarr;</a>
            <hr style="border:none;border-top:1px solid #d0daea;margin:18px 0">
            <p style="font-size:11px;color:#8fa0b8">KTA Workforce Management &middot; timesheet@kta.org.nz</p>
          </div>
        </div>`
      ).catch(console.error);
    }

    return html(wrap("#bf2b2b","&#10005;","Entry Declined",
      `<p>You have declined the timesheet entry for <strong>${fmtDate(entry.date)}</strong>.</p>
       <div class="detail">
         <b>Date:</b> ${fmtDate(entry.date)}<br>
         <b>Hours:</b> ${entry.net_hours}h<br>
         <b>Reason:</b> ${reason}
       </div>
       <p>${app?.name||"The apprentice"} has been notified.</p>
       <a href="${APP_URL}" class="btn">Open KTA System</a>`), 200);
  }

  // ── GET: approve or show decline form ─────────────────────────────────────
  const token = url.searchParams.get("token");
  if(!token) return html(errPage("No token provided."), 400);

  const payload = await verifyToken(token, sec);
  if(!payload) return html(wrap("#b86e1a","⏰","Link Expired",
    `<p>This link has expired or is no longer valid. Please log in to <a href="${APP_URL}">the KTA system</a>.</p>
     <a href="${APP_URL}" class="btn">Open KTA System</a>`), 200);

  // Support both single entryId and array entryIds (approve week)
  const { entryId, entryIds, action, approverId } = payload;
  const ids: string[] = entryIds || (entryId ? [entryId] : []);
  if(!ids.length || !["approve","decline"].includes(action))
    return html(errPage("Invalid request."), 400);

  const [approvers] = await Promise.all([
    sbGet("users", `id=eq.${approverId}`),
  ]);
  const approver = approvers[0] || { name:"Approver" };

  // For multi-entry (approve week), handle all at once
  // Use week page if entryIds array was used (even with 1 entry) OR multiple ids
  const isWeekAction = Array.isArray(payload.entryIds);
  if(ids.length > 1 || (isWeekAction && ids.length >= 1)) {
    if(action === "decline") {
      // For week decline, show form using first entry date as reference
      const firstEntries = await sbGet("entries", `id=eq.${ids[0]}`);
      const first = firstEntries[0];
      const apps = first ? await sbGet("users", `id=eq.${first.user_id}`) : [];
      const app = apps[0] || { name:"Apprentice" };
      const postUrl = req.url.split("?")[0];
      return html(declineFormHtml(token, app.name, `Week (${ids.length} entries)`, `${ids.length} entries`, postUrl), 200);
    }
    // Approve all entries
    let approved = 0;
    let apprenticeName = "Apprentice";
    let apprenticeEmail: string|null = null;
    for(const id of ids) {
      const entRows = await sbGet("entries", `id=eq.${id}`);
      if(!entRows.length) continue;
      const ent = entRows[0];
      if(ent.approval === "approved") { approved++; continue; }
      await sbPatch("entries", id, { approval:"approved" });
      approved++;
      if(!apprenticeEmail) {
        const apps = await sbGet("users", `id=eq.${ent.user_id}`);
        if(apps[0]) { apprenticeName = apps[0].name; apprenticeEmail = apps[0].email; }
      }
    }
    if(apprenticeEmail) {
      await sendMail(apprenticeEmail,
        `Timesheet Week Approved &mdash; ${approver.name}`,
        `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <div style="background:#1a8a7a;border-radius:10px 10px 0 0;padding:16px 22px">
            <div style="color:#fff;font-size:16px;font-weight:700">&#10003; Timesheet Week Approved</div>
          </div>
          <div style="background:#fff;padding:22px;border-radius:0 0 10px 10px;border:1px solid #d0daea">
            <p style="font-size:14px;color:#0d1b2e">Hi ${apprenticeName},</p>
            <p style="font-size:14px;color:#4a5a72">Your timesheet week (${approved} entries) has been <strong style="color:#1a8a7a">approved</strong> by <strong>${approver.name}</strong>.</p>
            <a href="${APP_URL}" style="display:inline-block;background:#1b4f8c;color:#fff;border-radius:8px;padding:10px 22px;font-size:13px;font-weight:600;text-decoration:none;margin-top:10px">Open KTA System &rarr;</a>
          </div>
        </div>`
      ).catch(console.error);
    }
    // Calculate week start and end from the entry dates
    const allDates = [];
    for(const id of ids) {
      const rows = await sbGet("entries", `id=eq.${id}`);
      if(rows[0]?.date) allDates.push(rows[0].date);
    }
    allDates.sort();
    const fmtD = (d:string) => {
      const dt = new Date(d + "T00:00:00");
      return dt.toLocaleDateString("en-NZ", {weekday:"short", day:"numeric", month:"long", year:"numeric"});
    };
    const weekStart = allDates.length ? fmtD(allDates[0]) : "";
    const weekEnd   = allDates.length ? fmtD(allDates[allDates.length-1]) : "";

    return new Response(null, {
      status: 302,
      headers: {
        ...CORS,
        "Location": `${APP_URL}/approved.html`,
      }
    });
  }

  // Single entry
  const entryId0 = ids[0];
  const [entryRows, ] = await Promise.all([
    sbGet("entries", `id=eq.${entryId0}`),
  ]);
  if(!entryRows.length) return html(errPage("Timesheet entry not found."), 404);
  const entry    = entryRows[0];
  const [apps]   = [await sbGet("users", `id=eq.${entry.user_id}`)];
  const app      = apps[0] || { name:"Apprentice" };

  // Already actioned?
  if(entry.approval === "approved" || entry.approval === "declined") {
    const msg = entry.approval === "approved"
      ? "This entry has already been approved."
      : "This entry has already been declined.";
    return html(wrap("#4a5a72","ℹ️","Already Actioned",
      `<p>${msg}</p><a href="${APP_URL}" class="btn">Open KTA System</a>`), 200);
  }

  // Show decline form
  if(action === "decline") {
    const postUrl = req.url.split("?")[0];
    return html(declineFormHtml(token, app.name, fmtDate(entry.date), `${entry.net_hours}h`, postUrl), 200);
  }

  // Approve single
  await sbPatch("entries", entryId0, { approval:"approved" });

  // Notify apprentice
  if(app?.email) {
    await sendMail(app.email,
      `Timesheet Entry Approved &mdash; ${fmtDate(entry.date)}`,
      `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#1a8a7a;border-radius:10px 10px 0 0;padding:16px 22px">
          <div style="color:#fff;font-size:16px;font-weight:700">&#10003; Timesheet Entry Approved</div>
          <div style="color:rgba(255,255,255,.7);font-size:12px">Kiwi Trade Apprentices</div>
        </div>
        <div style="background:#fff;padding:22px;border-radius:0 0 10px 10px;border:1px solid #d0daea">
          <p style="font-size:14px;color:#0d1b2e">Hi ${app.name},</p>
          <p style="font-size:14px;color:#4a5a72">Your timesheet entry for <strong>${fmtDate(entry.date)}</strong> has been <strong style="color:#1a8a7a">approved</strong> by <strong>${approver.name}</strong>.</p>
          <div style="background:#d4f0ec;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #1a8a7a">
            <div style="font-size:13px;font-weight:700;color:#1a8a7a">&#10003; ${entry.net_hours}h approved &middot; ${fmtDate(entry.date)}</div>
          </div>
          <a href="${APP_URL}" style="display:inline-block;background:#1b4f8c;color:#fff;border-radius:8px;padding:10px 22px;font-size:13px;font-weight:600;text-decoration:none;margin-top:10px">Open KTA System &rarr;</a>
          <hr style="border:none;border-top:1px solid #d0daea;margin:18px 0">
          <p style="font-size:11px;color:#8fa0b8">KTA Workforce Management &middot; timesheet@kta.org.nz</p>
        </div>
      </div>`
    ).catch(console.error);
  }

  return html(wrap("#1a8a7a","&#10003;","Entry Approved",
    `<p>You have approved the timesheet entry for <strong>${fmtDate(entry.date)}</strong>.</p>
     <div class="detail">
       <b>Apprentice:</b> ${app.name}<br>
       <b>Date:</b> ${fmtDate(entry.date)}<br>
       <b>Hours:</b> ${entry.net_hours}h<br>
       <b>Approved by:</b> ${approver.name}
     </div>
     <a href="${APP_URL}" class="btn">Open KTA System</a>`), 200);
});
