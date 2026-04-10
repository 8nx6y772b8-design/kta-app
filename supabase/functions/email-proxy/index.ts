// KTA Email Proxy — Supabase Edge Function
// Deploy:  supabase functions deploy email-proxy --project-ref sprlcvxlcjwhfzspkrww
// Secrets: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SEND_MAILBOX (optional, defaults to payroll@kta.org.nz)
//
// Uses application-level permissions (client credentials flow) so one set of
// credentials covers ALL @kta.org.nz mailboxes — no per-user refresh tokens.
//
// Required Azure AD app permissions (Application, not Delegated):
//   Mail.Read, Mail.ReadWrite, Mail.Send

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Token cache — reuse within the same isolate invocation ───────────────────
let _cachedToken: string | null = null;
let _tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 2-min buffer)
  if (_cachedToken && Date.now() < _tokenExpiry - 120_000) return _cachedToken;

  const tenantId     = Deno.env.get("MS_TENANT_ID")!;
  const clientId     = Deno.env.get("MS_CLIENT_ID")!;
  const clientSecret = Deno.env.get("MS_CLIENT_SECRET")!;

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        grant_type:    "client_credentials",
        client_id:     clientId,
        client_secret: clientSecret,
        scope:         "https://graph.microsoft.com/.default",
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token fetch failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token as string;
  _tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  return _cachedToken;
}

// ── Format a Graph message into what the app expects ─────────────────────────
function formatEmail(msg: any, direction: "inbound" | "outbound") {
  const from   = msg.from?.emailAddress;
  const toList = (msg.toRecipients ?? [])
    .map((r: any) => r.emailAddress?.address)
    .filter(Boolean)
    .join(", ");
  return {
    id:          msg.id,
    subject:     msg.subject ?? "(no subject)",
    from:        from ? `${from.name} <${from.address}>` : "",
    to:          toList,
    date:        msg.receivedDateTime ?? msg.sentDateTime ?? "",
    bodyPreview: msg.bodyPreview ?? "",
    direction,
    isRead:      msg.isRead ?? true,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function graphUrl(path: string) {
  return `${GRAPH_BASE}${path}`;
}

async function graphGet(token: string, path: string) {
  const res = await fetch(graphUrl(path), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const body = await req.json();
    const { action, emailAddress, folder = "inbox", maxResults = 50 } = body;

    const token = await getAccessToken();

    // ── searchByAddress ──────────────────────────────────────────────────────
    // Called by EmailActivityFeed to show email history for a contact/user.
    // Searches ALL @kta.org.nz mailboxes for emails to/from this address.
    if (action === "searchByAddress") {
      if (!emailAddress) {
        return new Response(
          JSON.stringify({ ok: false, error: "emailAddress is required" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      const clean = emailAddress.toLowerCase().trim();

      // Get all KTA users from the org directory
      // ConsistencyLevel:eventual required for endsWith filter queries
      const usersRes = await fetch(
        graphUrl(`/users?$filter=endswith(mail,'@kta.org.nz')&$select=mail,displayName&$top=100&$count=true`),
        { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" } }
      );
      const usersData = usersRes.ok ? await usersRes.json() : { value: [] };
      const ktaMailboxes: string[] = (usersData.value ?? [])
        .map((u: any) => u.mail?.toLowerCase())
        .filter(Boolean);

      // For each KTA mailbox, search inbox (received from target) and sent (sent to target)
      // Both filter types require ConsistencyLevel:eventual header
      const authHeaders = {
        Authorization: `Bearer ${token}`,
        ConsistencyLevel: "eventual",
      };

      const searches = ktaMailboxes.flatMap((mailbox) => [
        fetch(
          graphUrl(
            `/users/${mailbox}/mailFolders/inbox/messages` +
            `?$filter=from/emailAddress/address eq '${clean}'` +
            `&$top=${maxResults}&$orderby=receivedDateTime desc` +
            `&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead&$count=true`
          ),
          { headers: authHeaders }
        ).then((r) => r.json()).then((d) =>
          (d.value ?? []).map((m: any) => formatEmail(m, "inbound"))
        ).catch(() => []),

        fetch(
          graphUrl(
            `/users/${mailbox}/mailFolders/sentItems/messages` +
            `?$filter=toRecipients/any(r:r/emailAddress/address eq '${clean}')` +
            `&$top=${maxResults}&$orderby=sentDateTime desc` +
            `&$select=id,subject,from,toRecipients,sentDateTime,bodyPreview,isRead&$count=true`
          ),
          { headers: authHeaders }
        ).then((r) => r.json()).then((d) =>
          (d.value ?? []).map((m: any) => formatEmail(m, "outbound"))
        ).catch(() => []),
      ]);

      const results = await Promise.all(searches);
      const emails  = results
        .flat()
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, maxResults);

      return new Response(
        JSON.stringify({ ok: true, emails }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // ── listFolder ───────────────────────────────────────────────────────────
    // Called by the global Inbox / Sent tabs in EmailsModule.
    // Uses MS_INBOX_MAILBOX secret — set to whichever mailbox you want shown
    // in the global inbox view, e.g. admin@kta.org.nz or mike@kta.org.nz
    if (action === "listFolder") {
      const folderPath  = folder === "sent" ? "sentItems" : "inbox";
      const orderField  = folder === "sent" ? "sentDateTime" : "receivedDateTime";

      const mailbox = Deno.env.get("MS_INBOX_MAILBOX") ?? "";

      if (!mailbox) {
        return new Response(
          JSON.stringify({ ok: false, error: "MS_INBOX_MAILBOX secret not set. Run: supabase secrets set MS_INBOX_MAILBOX=mike@kta.org.nz --project-ref sprlcvxlcjwhfzspkrww" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      const data = await graphGet(
        token,
        `/users/${mailbox}/mailFolders/${folderPath}/messages` +
        `?$top=${maxResults}&$orderby=${orderField} desc` +
        `&$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead`
      );

      const emails = (data.value ?? []).map((m: any) =>
        formatEmail(m, folder === "sent" ? "outbound" : "inbound")
      );

      return new Response(
        JSON.stringify({ ok: true, emails }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // ── sendEmail ──────────────────────────────────────────────────────────
    // Sends an email via Microsoft Graph on behalf of a KTA mailbox.
    // Required Azure AD permission: Mail.Send (Application)
    if (action === "sendEmail") {
      const { to, subject, html, from: fromAddr, attachments } = body;
      if (!to || !subject) {
        return new Response(
          JSON.stringify({ ok: false, error: "to and subject are required" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      // Use explicit from, env secret, or default KTA mailbox
      const sender = fromAddr ?? Deno.env.get("MS_SEND_MAILBOX") ?? "payroll@kta.org.nz";

      const message: any = {
        subject,
        body: { contentType: "HTML", content: html ?? "" },
        toRecipients: String(to).split(",").map((addr: string) => ({
          emailAddress: { address: addr.trim() },
        })),
      };

      if (attachments?.length) {
        message.attachments = attachments.map((a: any) => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: a.name,
          contentType: a.contentType ?? "application/octet-stream",
          contentBytes: a.contentBytes,
        }));
      }

      const sendRes = await fetch(graphUrl(`/users/${sender}/sendMail`), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message, saveToSentItems: true }),
      });

      if (!sendRes.ok) {
        const errText = await sendRes.text();
        throw new Error(`sendMail failed (${sendRes.status}): ${errText}`);
      }

      return new Response(
        JSON.stringify({ ok: true }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ ok: false, error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
    );

  } catch (e: any) {
    console.error("email-proxy error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e.message ?? String(e) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
