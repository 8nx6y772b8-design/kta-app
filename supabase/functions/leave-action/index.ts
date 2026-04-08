// KTA Leave Action — Supabase Edge Function
// Handles one-click approve/decline from leave request emails.
//
// URL params: ?lid=<leaveId>&a=<action>&uid=<actorId>&role=<actorRole>&exp=<ms>&tok=<64hexchars>
// HMAC-SHA256 over "${lid}|${a}|${uid}|${role}|${exp}" — lowercase hex, zero encoding issues.
//
// Flow:
//   GET ?a=approve → verify HMAC → update DB → send emails → redirect to result screen
//   GET ?a=decline → verify HMAC → show reason form (HTML page)
//   POST           → verify HMAC + reason → update DB → send decline emails → redirect
//
// Deploy: supabase functions deploy leave-action --no-verify-jwt
// Secrets: HMAC_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//          MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL         = "https://crmkta.com";
const KTA_ADMIN_EMAIL = "admin@kta.org.nz";
const SENDER          = "leaverequests@kta.org.nz";
const GRAPH_BASE      = "https://graph.microsoft.com/v1.0";
const CALENDAR_PROXY  = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/calendar-proxy";
const LEAVE_ACTION_BASE = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/leave-action";

// ── Redirects ─────────────────────────────────────────────────────────────────
const redirectTo = (url: string) =>
  new Response(null, { status: 302, headers: { Location: url } });

const errorRedirect = (msg: string) =>
  redirectTo(`${APP_URL}?leave_result=1&status=error&msg=${encodeURIComponent(msg)}`);

const successRedirect = (status: string, type: string, name: string, approver: string, dateFrom: string, dateTo: string) =>
  redirectTo(`${APP_URL}?${new URLSearchParams({ leave_result:"1", status, type, name, approver, date_from:dateFrom, date_to:dateTo })}`);

// ── HTML response (decline form / error pages) ─────────────────────────────────
const htmlResp = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

const wrapPage = (title: string, icon: string, color: string, body: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — KTA</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f0f4f9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border-radius:16px;max-width:480px;width:100%;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}.hdr{padding:24px 28px}.hdr h1{color:#fff;font-size:20px;font-weight:700}.bod{padding:24px 28px;font-size:14px;color:#0d1b2e;line-height:1.6}.btn{display:inline-block;background:#1b4f8c;color:#fff;border-radius:8px;padding:10px 22px;font-size:13px;font-weight:600;text-decoration:none;margin-top:12px}</style>
</head><body><div class="card">
<div class="hdr" style="background:${color}">
  <div style="font-size:36px;margin-bottom:8px">${icon}</div><h1>${title}</h1>
</div>
<div class="bod">${body}</div>
</div></body></html>`;

// ── HMAC ──────────────────────────────────────────────────────────────────────
async function verifyHmac(msg: string, tok: string, secret: string): Promise<boolean> {
  try {
    // Normalise to lowercase — some email clients uppercase hex in URLs
    const tokLower = (tok || "").toLowerCase();
    if (!tokLower || tokLower.length !== 64 || !/^[0-9a-f]+$/.test(tokLower)) return false;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig      = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
    const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    if (expected.length !== tokLower.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ tokLower.charCodeAt(i);
    return diff === 0;
  } catch (e) {
    console.error("verifyHmac error:", e);
    return false;
  }
}

async function signHex(msg: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function makeActionUrl(lid: string, a: string, uid: string, role: string, secret: string): Promise<string> {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const tok = await signHex(`${lid}|${a}|${uid}|${role}|${exp}`, secret);
  return `${LEAVE_ACTION_BASE}?lid=${lid}&a=${a}&uid=${uid}&role=${role}&exp=${exp}&tok=${tok}`;
}

// ── M365 Email ────────────────────────────────────────────────────────────────
let _msToken: string | null = null;
let _msExpiry = 0;
async function getMsToken(): Promise<string> {
  if (_msToken && Date.now() < _msExpiry - 60_000) return _msToken;
  const res = await fetch(
    `https://login.microsoftonline.com/${Deno.env.get("MS_TENANT_ID")}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id:     Deno.env.get("MS_CLIENT_ID")!,
        client_secret: Deno.env.get("MS_CLIENT_SECRET")!,
        scope: "https://graph.microsoft.com/.default",
      }),
    }
  );
  if (!res.ok) throw new Error("MS token failed: " + await res.text());
  const data = await res.json();
  _msToken  = data.access_token;
  _msExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  return _msToken!;
}

async function sendMail(to: string, subject: string, htmlBody: string, attachments: any[] = []) {
  try {
    const t = await getMsToken();
    const message: any = {
      subject,
      body: { contentType: "HTML", content: htmlBody },
      toRecipients: [{ emailAddress: { address: to } }],
      from: { emailAddress: { address: SENDER, name: "KTA Leave" } },
    };
    if (attachments.length > 0) {
      message.attachments = attachments.map(a => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name:         a.filename,
        contentType:  a.contentType || "text/calendar; method=REQUEST",
        contentBytes: a.content,
      }));
    }
    const r = await fetch(`${GRAPH_BASE}/users/${SENDER}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
    if (!r.ok) console.error(`sendMail to ${to} failed (${r.status}):`, await r.text());
  } catch (e) {
    console.error(`sendMail to ${to} threw:`, e);
  }
}

// ── iCal / calendar invite ────────────────────────────────────────────────────
function makeIcalBase64(apprenticeName: string, leaveType: string, dateFrom: string, dateTo: string, email: string, name: string): string {
  const uid      = `kta-leave-${dateFrom}-${apprenticeName.replace(/\s+/g,"-").toLowerCase()}@kta.org.nz`;
  const startStr = dateFrom.replace(/-/g, "");
  const endDt    = new Date(dateTo + "T00:00:00");
  endDt.setDate(endDt.getDate() + 1);
  const endStr   = endDt.toISOString().slice(0, 10).replace(/-/g, "");
  const now      = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//KTA Workforce//EN",
    "CALSCALE:GREGORIAN", "METHOD:REQUEST", "BEGIN:VEVENT",
    `UID:${uid}`, `DTSTAMP:${now}`,
    `DTSTART;VALUE=DATE:${startStr}`, `DTEND;VALUE=DATE:${endStr}`,
    `SUMMARY:${apprenticeName} — ${leaveType}`,
    `DESCRIPTION:Leave approved by KTA for ${apprenticeName}.\\nType: ${leaveType}\\nFrom: ${dateFrom}\\nTo: ${dateTo}`,
    "STATUS:CONFIRMED", "TRANSP:TRANSPARENT",
    `ATTENDEE;CN=${name};ROLE=REQ-PARTICIPANT:mailto:${email}`,
    "ORGANIZER;CN=KTA Workforce:mailto:payroll@kta.org.nz",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const bytes = new TextEncoder().encode(ics);
  let binary = "";
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

// ── Email HTML helpers ────────────────────────────────────────────────────────
const fmtNZ = (iso: string) => { const [y,m,d]=(iso||"").split("-"); return d&&m&&y ? `${d}/${m}/${y}` : iso||"—"; };

const emailWrap = (title: string, body: string) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f0f4f9;padding:24px">
  <div style="background:#1b4f8c;border-radius:10px 10px 0 0;padding:18px 24px">
    <div style="color:#fff;font-size:20px;font-weight:700">KTA Leave Request</div>
    <div style="color:#dce8f7;font-size:13px;margin-top:4px">Kiwi Trade Apprentices</div>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 10px 10px;border:1px solid #d0daea">
    <p style="font-size:16px;color:#0d1b2e;margin-top:0">${title}</p>
    ${body}
    <hr style="border:none;border-top:1px solid #d0daea;margin:20px 0">
    <p style="font-size:12px;color:#8fa0b8">KTA Workforce Management · leaverequests@kta.org.nz</p>
  </div>
</div>`;

const detailTable = (appName: string, leaveType: string, dateFrom: string, dateTo: string, approverName = "", notes = "") => `
<table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700;width:40%">Apprentice</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${appName}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">Leave Type</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${leaveType}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">From</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${fmtNZ(dateFrom)}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">To</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${fmtNZ(dateTo)}</td></tr>
  ${approverName ? `<tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">Approver</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${approverName}</td></tr>` : ""}
  ${notes ? `<tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">Notes</td><td style="padding:8px 12px">${notes}</td></tr>` : ""}
</table>`;

const actionBtns = (appUrl: string, decUrl: string) => `
<div style="margin:24px 0">
  <a href="${appUrl}" style="display:inline-block;background:#1a8a7a;color:#fff;border-radius:8px;padding:12px 28px;font-size:15px;font-weight:700;text-decoration:none;margin-right:12px">✓ Approve Leave</a>
  <a href="${decUrl}" style="display:inline-block;background:#bf2b2b;color:#fff;border-radius:8px;padding:12px 28px;font-size:15px;font-weight:700;text-decoration:none">✕ Decline Leave</a>
</div>
<p style="font-size:12px;color:#8fa0b8;margin-top:4px">These buttons record your response immediately — no login required. Links expire in 7 days.</p>`;

const reasonBox = (color: string, label: string, reason: string) => `
<div style="background:${color}22;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid ${color}">
  <div style="font-weight:700;font-size:13px;color:${color};margin-bottom:4px">${label}</div>
  <div style="font-size:13px;color:#0d1b2e">${reason}</div>
</div>`;

// ── Decline form (shown in browser when approver/admin clicks Decline) ─────────
const declineForm = (packed: string, appName: string, leaveType: string, dateFrom: string, dateTo: string, postUrl: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Decline Leave — KTA</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f0f4f9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border-radius:16px;border:1.5px solid #d0daea;max-width:480px;width:100%;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}.hdr{padding:24px 28px;background:#bf2b2b}.hdr h1{color:#fff;font-size:20px;font-weight:700}.hdr .sub{color:rgba(255,255,255,.72);font-size:12px;margin-top:4px}.bod{padding:24px 28px}.detail{background:#f0f4f9;border-radius:10px;padding:14px 16px;font-size:13px;color:#4a5a72;margin:12px 0 16px;line-height:2.2}.detail b{color:#0d1b2e}textarea{width:100%;border:1.5px solid #d0daea;border-radius:8px;padding:10px;font-size:14px;font-family:inherit;resize:vertical;margin:10px 0 14px;color:#0d1b2e}textarea:focus{outline:none;border-color:#1b4f8c}.btn-red{background:#bf2b2b;color:#fff;border:none;border-radius:8px;padding:11px 24px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;width:100%;margin-top:4px}.err{color:#bf2b2b;font-size:12px;margin-bottom:8px;display:none}.footer{font-size:11px;color:#8fa0b8;margin-top:16px}</style>
</head><body><div class="card">
<div class="hdr">
  <div style="font-size:36px;margin-bottom:8px">✕</div>
  <h1>Decline Leave Request</h1>
  <div class="sub">Kiwi Trade Apprentices · leaverequests@kta.org.nz</div>
</div>
<div class="bod">
  <div class="detail">
    <b>Apprentice:</b> ${appName}<br>
    <b>Leave Type:</b> ${leaveType}<br>
    <b>From:</b> ${fmtNZ(dateFrom)}<br>
    <b>To:</b> ${fmtNZ(dateTo)}
  </div>
  <p style="font-size:14px;color:#0d1b2e;margin-bottom:8px">Please provide a reason for declining. This will be emailed to the apprentice.</p>
  <div class="err" id="err">Please enter a reason.</div>
  <form method="POST" action="${postUrl}"
    onsubmit="var r=document.querySelector('textarea').value.trim();if(!r){document.getElementById('err').style.display='block';return false;}return true;">
    <input type="hidden" name="token" value="${packed}">
    <textarea name="reason" rows="3" placeholder="e.g. Busy period, clashes with other approved leave…"></textarea>
    <button type="submit" class="btn-red">✕ Confirm Decline</button>
  </form>
  <p class="footer">KTA Workforce Management · leaverequests@kta.org.nz</p>
</div>
</div></body></html>`;

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  const url    = new URL(req.url);
  const secret = Deno.env.get("HMAC_SECRET");
  if (!secret) return errorRedirect("Server misconfiguration");

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── POST: decline reason form submitted ──────────────────────────────────────
  if (req.method === "POST") {
    let fd: FormData;
    try { fd = await req.formData(); } catch { return htmlResp("Could not read form.", 400); }
    const reason = (fd.get("reason") as string || "").trim();
    if (!reason) return htmlResp("A reason is required.", 400);

    // Unpack params from the hidden `token` field (packed as URLSearchParams string)
    const packed = fd.get("token") as string | null;
    if (!packed) return htmlResp("Missing form data.", 400);
    const up   = new URLSearchParams(packed);
    const lid  = up.get("lid");
    const a    = up.get("a");
    const uid  = up.get("uid");
    const role = up.get("role");
    const exp  = up.get("exp");
    const tok  = up.get("tok");

    if (!lid || !a || !uid || !role || !exp || !tok)
      return htmlResp(wrapPage("Invalid Form", "⚠️", "#bf2b2b", "<p>Missing form data. Please try your link again.</p>"), 400);

    if (Date.now() > parseInt(exp, 10))
      return htmlResp(wrapPage("Link Expired", "⏰", "#b86e1a",
        `<p>This link has expired. Please log in to <a href="${APP_URL}">the KTA system</a> to action this request.</p>`), 200);

    const valid = await verifyHmac(`${lid}|${a}|${uid}|${role}|${exp}`, tok, secret);
    if (!valid) {
      // Diagnostic — remove after confirming fix
      const diag = `tok_len=${(tok||"").length},lid_len=${(lid||"").length},uid_len=${(uid||"").length},sec_len=${secret.length},tok0=${(tok||"").slice(0,4)}`;
      return htmlResp(wrapPage("Invalid Link", "⚠️", "#bf2b2b",
        `<p>This link could not be verified. [${diag}]<br>Please contact KTA admin if this keeps happening.</p>`), 200);
    }

    // Fetch leave request
    const { data: leaveReq } = await sb.from("leave_requests").select("*").eq("id", lid).single();
    if (!leaveReq)
      return htmlResp(wrapPage("Not Found", "⚠️", "#bf2b2b", "<p>Leave request not found.</p>"), 404);

    if (leaveReq.status === "declined" || leaveReq.status === "kta_approved")
      return htmlResp(wrapPage("Already Actioned", "ℹ️", "#4a5a72",
        `<p>This request has already been ${leaveReq.status === "declined" ? "declined" : "fully approved"}.</p>
         <a href="${APP_URL}" class="btn" style="display:inline-block;background:#1b4f8c;color:#fff;border-radius:8px;padding:10px 22px;font-size:13px;font-weight:600;text-decoration:none;margin-top:12px">Open KTA System</a>`), 200);

    // Update DB
    await sb.from("leave_requests")
      .update({ status: "declined", decline_reason: reason })
      .eq("id", lid);

    // Fetch names
    const { data: app }  = await sb.from("users").select("name,email").eq("id", leaveReq.apprentice_id).single();
    const { data: appr } = await sb.from("users").select("name,email").eq("id", leaveReq.approver_id).single();
    const { data: act }  = await sb.from("users").select("name").eq("id", uid).single();
    const appName   = app?.name  || "Apprentice";
    const apprName  = appr?.name || "Approver";
    const actorName = act?.name  || (role === "admin" ? "KTA Admin" : apprName);

    // Email apprentice: decline + reason
    if (app?.email) {
      await sendMail(app.email,
        `Leave Request Declined — ${leaveReq.leave_type}`,
        emailWrap(
          `Your leave request for <strong>${leaveReq.leave_type}</strong> (${fmtNZ(leaveReq.date_from)} – ${fmtNZ(leaveReq.date_to)}) has been <strong>declined</strong> by <strong>${actorName}</strong>.`,
          detailTable(appName, leaveReq.leave_type, leaveReq.date_from, leaveReq.date_to, apprName, leaveReq.notes) +
          reasonBox("#bf2b2b", "Reason for Decline", reason) +
          `<p style="font-size:13px;color:#4a5a72;margin-top:8px">Please contact <strong>${actorName}</strong> for further information.</p>`
        )
      );
    }

    if (role === "approver") {
      // Notify admin@kta.org.nz so KTA is aware
      await sendMail(KTA_ADMIN_EMAIL,
        `Leave Request Declined by Approver — ${appName} (${leaveReq.leave_type})`,
        emailWrap(
          `A leave request from <strong>${appName}</strong> has been <strong>declined</strong> by their approver, <strong>${actorName}</strong>.`,
          detailTable(appName, leaveReq.leave_type, leaveReq.date_from, leaveReq.date_to, apprName, leaveReq.notes) +
          reasonBox("#bf2b2b", "Reason", reason) +
          `<p style="font-size:13px;color:#4a5a72">The apprentice has been notified. No further action required.</p>`
        )
      );
    } else {
      // Admin declined — notify approver
      if (appr?.email) {
        await sendMail(appr.email,
          `Leave Request Declined by KTA — ${appName} (${leaveReq.leave_type})`,
          emailWrap(
            `The leave request from <strong>${appName}</strong> has been <strong>declined by KTA</strong> (<strong>${actorName}</strong>).`,
            detailTable(appName, leaveReq.leave_type, leaveReq.date_from, leaveReq.date_to, apprName, leaveReq.notes) +
            reasonBox("#bf2b2b", "Reason", reason) +
            `<p style="font-size:13px;color:#4a5a72">The apprentice has also been notified.</p>`
          )
        );
      }
    }

    return successRedirect("declined", leaveReq.leave_type, appName, actorName, leaveReq.date_from, leaveReq.date_to);
  }

  // ── GET: sendLeaveEmail — generate signed URLs in edge fn and send approver email ──
  const p    = url.searchParams;
  const getAction = p.get("action");

  if (getAction === "sendLeaveEmail" || getAction === "sendAdminEmail") {
    const lid = p.get("lid");
    if (!lid) return new Response(JSON.stringify({ ok: false, error: "Missing lid" }), { status: 400, headers: { "Content-Type": "application/json" } });

    const { data: leave } = await sb.from("leave_requests").select("*").eq("id", lid).single();
    if (!leave) return new Response(JSON.stringify({ ok: false, error: "Leave not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

    const { data: appUser }  = await sb.from("users").select("id,name,email").eq("id", leave.apprentice_id).single();
    const { data: apprUser } = await sb.from("users").select("id,name,email").eq("id", leave.approver_id).single();
    const appName  = appUser?.name  || "Apprentice";
    const apprName = apprUser?.name || "Approver";
    const SICK_TYPES = ["Sick Leave", "Leave Without Pay"];

    if (getAction === "sendLeaveEmail") {
      // Email 1: approver with one-click approve/decline buttons — signed HERE with HMAC_SECRET
      if (apprUser?.email && apprUser?.id) {
        const appUrl = await makeActionUrl(lid, "approve", apprUser.id, "approver", secret);
        const decUrl = await makeActionUrl(lid, "decline", apprUser.id, "approver", secret);
        const btns = actionBtns(appUrl, decUrl);
        await sendMail(apprUser.email,
          `Leave Request — ${appName} (${leave.leave_type})`,
          emailWrap(
            `<strong>${appName}</strong> has submitted a leave request requiring your approval.`,
            detailTable(appName, leave.leave_type, leave.date_from, leave.date_to, apprName, leave.notes || "") + btns
          )
        ).catch(e => console.error("Approver email failed:", e));
      }
      // Email 2: apprentice confirmation
      if (appUser?.email) {
        await sendMail(appUser.email,
          `Leave Request Submitted — ${leave.leave_type}`,
          emailWrap(
            `Your leave request has been submitted and is awaiting approval from <strong>${apprName}</strong>.`,
            detailTable(appName, leave.leave_type, leave.date_from, leave.date_to, apprName, leave.notes || "")
          )
        ).catch(e => console.error("Apprentice confirmation email failed:", e));
      }
      // Email 3: sick leave — notify absence@kta.org.nz
      if (SICK_TYPES.includes(leave.leave_type)) {
        await sendMail("absence@kta.org.nz",
          `Sick Leave Notification — ${appName}`,
          emailWrap(
            `<strong>${appName}</strong> is off work sick today and has submitted a leave application.`,
            detailTable(appName, leave.leave_type, leave.date_from, leave.date_to, apprName, leave.notes || "")
          )
        ).catch(e => console.error("Sick leave absence email failed:", e));
      }
    } else {
      // sendAdminEmail — approver has approved, now notify KTA admin with action buttons
      // Find a real admin user for the uid, fall back to fixed "ktaadm" placeholder
      const { data: adminUser } = await sb.from("users").select("id,name,email").eq("role", "Admin").order("admin_level", { ascending: true }).limit(1).maybeSingle();
      const adminId   = adminUser?.id || "ktaadm";
      const appUrl = await makeActionUrl(lid, "approve", adminId, "admin", secret);
      const decUrl = await makeActionUrl(lid, "decline", adminId, "admin", secret);
      const btns   = actionBtns(appUrl, decUrl);
      await sendMail(KTA_ADMIN_EMAIL,
        `Leave Request for KTA Approval — ${appName} (${leave.leave_type})`,
        emailWrap(
          `A leave request from <strong>${appName}</strong> has been approved by their approver (<strong>${apprName}</strong>) and requires KTA final approval.`,
          detailTable(appName, leave.leave_type, leave.date_from, leave.date_to, apprName, leave.notes || "") + btns
        )
      ).catch(e => console.error("Admin email failed:", e));
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  // ── GET: approve / decline (one-click from email links) ──────────────────────
  const lid  = p.get("lid");
  const a    = p.get("a");
  const uid  = p.get("uid");
  const role = p.get("role");
  const exp  = p.get("exp");
  const tok  = p.get("tok");

  if (!lid || !a || !uid || !role || !exp || !tok) return errorRedirect("Missing parameters");
  if (!["approve", "decline"].includes(a))         return errorRedirect("Invalid action");
  if (Date.now() > parseInt(exp, 10))              return errorRedirect("Link has expired");

  const valid = await verifyHmac(`${lid}|${a}|${uid}|${role}|${exp}`, tok, secret);
  if (!valid) {
    // Full diagnostic — compute expected and compare
    let expTok = "err";
    try { expTok = await signHex(`${lid}|${a}|${uid}|${role}|${exp}`, secret); } catch {}
    const msg = `${lid}|${a}|${uid}|${role}|${exp}`;
    const diag = `msg=${msg},tok=${(tok||"").slice(0,8)},exp=${expTok.slice(0,8)}`;
    return errorRedirect(`HMAC fail [${diag}]`);
  }

  // Fetch leave request
  const { data: leaveReq, error: fetchErr } = await sb.from("leave_requests").select("*").eq("id", lid).single();
  if (fetchErr || !leaveReq) return errorRedirect("Leave request not found");

  // Already actioned
  if (leaveReq.status !== "pending" && leaveReq.status !== "approver_approved") {
    return successRedirect("already_actioned", leaveReq.leave_type || "Leave", "", "", leaveReq.date_from, leaveReq.date_to);
  }

  // Fetch user records
  const { data: app }  = await sb.from("users").select("name,email").eq("id", leaveReq.apprentice_id).single();
  const { data: appr } = await sb.from("users").select("name,email").eq("id", leaveReq.approver_id).single();
  const appName  = app?.name  || "Apprentice";
  const apprName = appr?.name || "Approver";

  // ── Decline: show reason form ────────────────────────────────────────────────
  if (a === "decline") {
    const packed  = `lid=${lid}&a=${a}&uid=${uid}&role=${role}&exp=${exp}&tok=${tok}`;
    const postUrl = `${url.origin}${url.pathname}`;
    return htmlResp(declineForm(packed, appName, leaveReq.leave_type, leaveReq.date_from, leaveReq.date_to, postUrl));
  }

  // ── Approve ─────────────────────────────────────────────────────────────────
  const newStatus = role === "admin" ? "kta_approved" : "approver_approved";
  const { error: updateErr } = await sb.from("leave_requests")
    .update({ status: newStatus })
    .eq("id", lid);
  if (updateErr) {
    console.error("DB update error:", updateErr);
    return errorRedirect(`DB error: ${updateErr.code} ${updateErr.message}`);
  }

  const { data: act } = await sb.from("users").select("name").eq("id", uid).single();
  const actorName = act?.name || (role === "admin" ? "KTA Admin" : apprName);

  if (role === "approver") {
    // ── Approver approved: notify apprentice + forward to admin ─────────────
    if (app?.email) {
      await sendMail(app.email,
        `Leave Request Approved by Approver — ${leaveReq.leave_type}`,
        emailWrap(
          `Your leave request has been approved by <strong>${actorName}</strong> and forwarded to KTA for final approval.`,
          detailTable(appName, leaveReq.leave_type, leaveReq.date_from, leaveReq.date_to, apprName, leaveReq.notes) +
          `<div style="background:#d4f0ec;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #1a8a7a">
            <div style="font-weight:700;font-size:13px;color:#1a8a7a;margin-bottom:4px">✓ Stage 1 of 2 Complete</div>
            <div style="font-size:13px;color:#0d1b2e">Approver approved. Awaiting KTA final approval.</div>
          </div>`
        )
      );
    }

    // Find admin user to generate correct action URLs
    const { data: adminUser } = await sb.from("users").select("id").eq("email", KTA_ADMIN_EMAIL).maybeSingle();
    const adminId = adminUser?.id || uid; // fallback: use approver's ID (still works, name will show as approver)
    const adminAppUrl = await makeActionUrl(lid, "approve", adminId, "admin", secret);
    const adminDecUrl = await makeActionUrl(lid, "decline", adminId, "admin", secret);

    await sendMail(KTA_ADMIN_EMAIL,
      `Leave Request for KTA Approval — ${appName} (${leaveReq.leave_type})`,
      emailWrap(
        `A leave request from <strong>${appName}</strong> has been approved by their approver (<strong>${actorName}</strong>) and requires KTA final approval.`,
        detailTable(appName, leaveReq.leave_type, leaveReq.date_from, leaveReq.date_to, apprName, leaveReq.notes) +
        actionBtns(adminAppUrl, adminDecUrl)
      )
    );

  } else {
    // ── Admin (KTA) approved: full approval — notify everyone + send calendar invites
    if (app?.email) {
      await sendMail(app.email,
        `Leave Fully Approved by KTA — ${leaveReq.leave_type}`,
        emailWrap(
          `Your leave request has been <strong>fully approved by KTA</strong>. Enjoy your time off! 🎉`,
          detailTable(appName, leaveReq.leave_type, leaveReq.date_from, leaveReq.date_to, apprName, leaveReq.notes) +
          `<div style="background:#dce8f7;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #1b4f8c">
            <div style="font-weight:700;font-size:13px;color:#1b4f8c;margin-bottom:4px">★ Fully Approved</div>
            <div style="font-size:13px;color:#0d1b2e">Both approver and KTA have approved your leave.</div>
          </div>`
        )
      );
    }
    if (appr?.email) {
      await sendMail(appr.email,
        `Leave Fully Approved by KTA — ${appName} (${leaveReq.leave_type})`,
        emailWrap(
          `The leave request from <strong>${appName}</strong> has been <strong>fully approved by KTA</strong>.`,
          detailTable(appName, leaveReq.leave_type, leaveReq.date_from, leaveReq.date_to, apprName, leaveReq.notes) +
          `<div style="background:#dce8f7;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #1b4f8c">
            <div style="font-weight:700;font-size:13px;color:#1b4f8c;margin-bottom:4px">★ KTA Final Approval Granted</div>
            <div style="font-size:13px;color:#0d1b2e">${appName}'s leave has been fully approved. A calendar invite is attached.</div>
          </div>`
        )
      );
    }

    // Send .ics calendar invites to apprentice, approver, admin
    const icsJobs: Promise<void>[] = [];
    const sendIcs = async (toEmail: string, toName: string) => {
      const b64 = makeIcalBase64(appName, leaveReq.leave_type, leaveReq.date_from, leaveReq.date_to, toEmail, toName);
      await sendMail(
        toEmail,
        `Calendar: ${appName} — ${leaveReq.leave_type} (${fmtNZ(leaveReq.date_from)}–${fmtNZ(leaveReq.date_to)})`,
        emailWrap(
          "Leave Calendar Reminder",
          detailTable(appName, leaveReq.leave_type, leaveReq.date_from, leaveReq.date_to, apprName) +
          `<div style="background:#dce8f7;border-radius:8px;padding:12px 16px;font-size:13px;color:#1b4f8c;font-weight:700;margin-top:12px">
            ★ Fully approved by KTA — open the attached .ics file to add to your calendar.
          </div>`
        ),
        [{ filename: `kta-leave-${leaveReq.date_from}.ics`, content: b64, contentType: "text/calendar; method=REQUEST" }]
      );
    };
    if (app?.email)  icsJobs.push(sendIcs(app.email, appName));
    if (appr?.email) icsJobs.push(sendIcs(appr.email, apprName));
    icsJobs.push(sendIcs(KTA_ADMIN_EMAIL, "KTA Admin"));
    await Promise.all(icsJobs);

    // Add to team calendar (calendar-proxy)
    await fetch(CALENDAR_PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apprenticeName: appName,
        leaveType:      leaveReq.leave_type,
        dateFrom:       leaveReq.date_from,
        dateTo:         leaveReq.date_to,
      }),
    }).catch(e => console.error("Calendar proxy failed:", e));
  }

  return successRedirect(newStatus, leaveReq.leave_type, appName, actorName, leaveReq.date_from, leaveReq.date_to);
});
