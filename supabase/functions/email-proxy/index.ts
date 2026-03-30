// KTA Email Proxy — Supabase Edge Function
// Sends email via Microsoft Graph using CLIENT CREDENTIALS (no refresh token needed — never expires).
//
// Deploy:
//   supabase functions deploy email-proxy --project-ref sprlcvxlcjwhfzspkrww --no-verify-jwt
//
// Required Supabase secrets (set once, never rotate):
//   supabase secrets set MS_TENANT_ID=<your-tenant-id>
//   supabase secrets set MS_CLIENT_ID=<your-app-client-id>
//   supabase secrets set MS_CLIENT_SECRET=<your-app-client-secret>
//   supabase secrets set MS_SENDER_EMAIL=payroll@kta.org.nz
//
// Azure AD app registration requirements:
//   - API Permissions → Microsoft Graph → Application permissions (NOT delegated):
//       Mail.Send          (required — to send email as payroll@kta.org.nz)
//       Mail.ReadBasic.All (optional — only needed for CRM email reading)
//   - Grant admin consent for your organisation
//   - No redirect URI needed (this is a daemon/service app)
//
// Handles these actions from the KTA app:
//   sendEmail       — send an email (leave notifications, reports, PPE, etc.)
//   searchByAddress — CRM: find emails to/from a contact
//   listFolder      — CRM: list inbox or sent items

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// ── Config ────────────────────────────────────────────────────────────────────
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Token cache (in-memory, valid for the lifetime of the function instance) ──
let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 2-minute buffer)
  if (cachedToken && Date.now() < tokenExpiry - 120_000) {
    return cachedToken;
  }

  const tenantId     = Deno.env.get("MS_TENANT_ID");
  const clientId     = Deno.env.get("MS_CLIENT_ID");
  const clientSecret = Deno.env.get("MS_CLIENT_SECRET");

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Missing secrets. Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET in Supabase."
    );
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "client_credentials",
        client_id:     clientId,
        client_secret: clientSecret,
        scope:         "https://graph.microsoft.com/.default",
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error("No access_token in response: " + JSON.stringify(data));
  }

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
}

// ── sendEmail ─────────────────────────────────────────────────────────────────
async function sendEmail(body: any): Promise<Response> {
  const { to, subject, html, attachments = [], from } = body;

  if (!to || !subject || !html) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: to, subject, html" }),
      { status: 400, headers: { "Content-Type": "application/json", ...cors } }
    );
  }

  // Allow caller to override the sender (e.g. leaverequests@kta.org.nz for leave emails)
  // Falls back to the MS_SENDER_EMAIL secret (payroll@kta.org.nz)
  const senderEmail = from || Deno.env.get("MS_SENDER_EMAIL") || "payroll@kta.org.nz";
  const token = await getAccessToken();

  // Build attachment list — supports both naming conventions from the app
  // App sends: { filename/name, content/contentBytes, contentType, encoding }
  const graphAttachments = attachments.map((a: any) => ({
    "@odata.type":  "#microsoft.graph.fileAttachment",
    name:           a.filename || a.name || "attachment",
    contentType:    a.contentType || "application/octet-stream",
    contentBytes:   a.content || a.contentBytes || "",
  })).filter((a: any) => a.contentBytes);

  const message: any = {
    subject,
    body: {
      contentType: "HTML",
      content:     html,
    },
    toRecipients: [
      {
        emailAddress: {
          address: typeof to === "string" ? to : to.address || to,
        },
      },
    ],
  };

  if (graphAttachments.length > 0) {
    message.attachments = graphAttachments;
  }

  const res = await fetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(senderEmail)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    }
  );

  // Graph returns 202 Accepted on success — no body
  if (res.status === 202 || res.status === 200) {
    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "Content-Type": "application/json", ...cors } }
    );
  }

  const errText = await res.text();
  let errMsg = `Graph sendMail failed (${res.status})`;
  try {
    const parsed = JSON.parse(errText);
    errMsg = parsed?.error?.message || errMsg;
  } catch (_) { /* use raw text */ }

  throw new Error(errMsg + (errText ? ": " + errText : ""));
}

// ── CRM: searchByAddress ──────────────────────────────────────────────────────
async function searchByAddress(body: any): Promise<Response> {
  const { emailAddress, maxResults = 30 } = body;
  if (!emailAddress) {
    return new Response(
      JSON.stringify({ error: "emailAddress required" }),
      { status: 400, headers: { "Content-Type": "application/json", ...cors } }
    );
  }

  const senderEmail = Deno.env.get("MS_SENDER_EMAIL") || "payroll@kta.org.nz";
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  const top = Math.min(maxResults, 50);

  const enc = encodeURIComponent;

  const [inboundRes, outboundRes] = await Promise.all([
    fetch(
      `${GRAPH_BASE}/users/${enc(senderEmail)}/mailFolders/inbox/messages` +
      `?$filter=from/emailAddress/address eq '${emailAddress}'` +
      `&$top=${top}&$orderby=receivedDateTime desc` +
      `&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead`,
      { headers }
    ),
    fetch(
      `${GRAPH_BASE}/users/${enc(senderEmail)}/mailFolders/sentItems/messages` +
      `?$filter=toRecipients/any(r:r/emailAddress/address eq '${emailAddress}')` +
      `&$top=${top}&$orderby=sentDateTime desc` +
      `&$select=id,subject,from,toRecipients,sentDateTime,bodyPreview,isRead`,
      { headers }
    ),
  ]);

  const [inbox, sent] = await Promise.all([inboundRes.json(), outboundRes.json()]);

  const emails = [
    ...(inbox.value  || []).map((m: any) => formatEmail(m, "inbox")),
    ...(sent.value   || []).map((m: any) => formatEmail(m, "sentItems")),
  ].sort((a, b) => b.date.localeCompare(a.date));

  return new Response(
    JSON.stringify({ ok: true, emails }),
    { status: 200, headers: { "Content-Type": "application/json", ...cors } }
  );
}

// ── CRM: listFolder ───────────────────────────────────────────────────────────
async function listFolder(body: any): Promise<Response> {
  const { folder = "inbox", maxResults = 50 } = body;

  const senderEmail = Deno.env.get("MS_SENDER_EMAIL") || "payroll@kta.org.nz";
  const token = await getAccessToken();
  const folderPath = folder === "sent" ? "sentItems" : "inbox";
  const top = Math.min(maxResults, 100);
  const enc = encodeURIComponent;

  const res = await fetch(
    `${GRAPH_BASE}/users/${enc(senderEmail)}/mailFolders/${folderPath}/messages` +
    `?$top=${top}&$orderby=receivedDateTime desc` +
    `&$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead`,
    { Authorization: `Bearer ${token}` }
  );

  const data = await res.json();
  const emails = (data.value || []).map((m: any) => formatEmail(m, folderPath));

  return new Response(
    JSON.stringify({ ok: true, emails }),
    { status: 200, headers: { "Content-Type": "application/json", ...cors } }
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatEmail(msg: any, folder: string) {
  const from   = msg.from?.emailAddress;
  const toList = (msg.toRecipients || [])
    .map((r: any) => r.emailAddress?.address)
    .filter(Boolean)
    .join(", ");

  return {
    id:          msg.id,
    subject:     msg.subject || "(no subject)",
    from:        from ? `${from.name || ""} <${from.address}>`.trim() : "",
    to:          toList,
    date:        msg.receivedDateTime || msg.sentDateTime || "",
    bodyPreview: msg.bodyPreview || "",
    direction:   folder === "sentItems" ? "outbound" : "inbound",
    isRead:      msg.isRead ?? true,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

// ── EarnLearn PDF parser ───────────────────────────────────────────────────────
// Calls Anthropic Claude API server-side (avoids browser CORS restriction)
async function parseEarnLearn(body: any): Promise<Response> {
  const { pdfBase64 } = body;
  if (!pdfBase64) {
    return new Response(
      JSON.stringify({ error: "pdfBase64 required" }),
      { status: 400, headers: { "Content-Type": "application/json", ...cors } }
    );
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY secret not set on edge function" }),
      { status: 500, headers: { "Content-Type": "application/json", ...cors } }
    );
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
          },
          {
            type: "text",
            text: `Extract the following numbers from this EarnLearn progress report PDF and return ONLY a JSON object with no extra text or markdown:
{
  "months_in_training": <number from "Months in Training" column>,
  "programme_duration": <number from "Programme Duration" column>,
  "report_date": "<YYYY-MM-DD from 'Booklet Data as at' date>",
  "skills_week_percent": <Credits Achieved / Credits Required * 100 for Skills Week/Trade Start section, or null>,
  "off_job_l3_percent": <Credits Achieved / Credits Required * 100 for Off Job Unit Standards Level 3, or null>,
  "off_job_l4_percent": <Credits Achieved / Credits Required * 100 for Off Job Unit Standards Level 4, or null>,
  "on_job_core_percent": <Booklets Completed / Total Core Booklets * 100 for On Job Core section, or null>,
  "on_job_spec_percent": <Booklets Completed / Total Speciality Booklets * 100 for On Job Speciality section, or null>,
  "booklets_percent": <Booklets Completed / Total Booklets * 100 from the Booklet Achievement Summary, or null>,
  "overall_percent": <overall % complete from the Unit Standard Achievement Summary totals row (Credits Achieved / Credits Required * 100)>
}
Return only the JSON object, nothing else.`,
          },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return new Response(
      JSON.stringify({ error: `Anthropic API error (${res.status}): ${errText}` }),
      { status: 502, headers: { "Content-Type": "application/json", ...cors } }
    );
  }

  const data = await res.json();
  const raw   = (data.content || []).map((c: any) => c.text || "").join("").trim();
  const clean = raw.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(clean);
    return new Response(
      JSON.stringify({ ok: true, data: parsed }),
      { status: 200, headers: { "Content-Type": "application/json", ...cors } }
    );
  } catch {
    return new Response(
      JSON.stringify({ error: "Could not parse Claude response as JSON", raw }),
      { status: 502, headers: { "Content-Type": "application/json", ...cors } }
    );
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "POST only" }),
      { status: 405, headers: { "Content-Type": "application/json", ...cors } }
    );
  }

  try {
    const body = await req.json();
    const { action } = body;

    switch (action) {
      case "sendEmail":        return await sendEmail(body);
      case "searchByAddress":  return await searchByAddress(body);
      case "listFolder":       return await listFolder(body);
      case "parseEarnLearn":  return await parseEarnLearn(body);
      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: "${action}"` }),
          { status: 400, headers: { "Content-Type": "application/json", ...cors } }
        );
    }
  } catch (e: any) {
    console.error("email-proxy error:", e);
    return new Response(
      JSON.stringify({ error: e.message || "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...cors } }
    );
  }
});
