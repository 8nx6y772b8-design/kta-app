// KTA Graph Mail Capture — Supabase Edge Function
// Deploy:  supabase functions deploy graph-mail-capture --project-ref sprlcvxlcjwhfzspkrww
// Secrets: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// This function has two responsibilities:
//
//   1. /manage-subscriptions  — called by the KTA app to create/list/delete/renew
//                               Microsoft Graph change notification subscriptions
//                               (one per KTA staff mailbox sentItems folder)
//
//   2. /  (root POST)         — called by Microsoft Graph when a new email is sent
//                               by a monitored mailbox. Fetches the email, writes
//                               it to the Supabase activity_notes table, and queues
//                               unknown recipients in unknown_email_contacts.
//
// Rules:
//   - Internal kta.org.nz → kta.org.nz emails are NEVER logged
//   - Emails with [private] anywhere in the subject are NEVER logged
//   - Each email is written once (idempotent on message ID)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GRAPH_BASE    = "https://graph.microsoft.com/v1.0";
const SUB_LIFETIME  = 4230 * 60 * 1000; // ~3 days in ms (Graph max for Mail is 4230 min)

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// ── Token (application credentials flow) ─────────────────────────────────────
let _token: string | null = null;
let _tokenExpiry = 0;

async function getToken(): Promise<string> {
  if (_token && Date.now() < _tokenExpiry - 120_000) return _token;
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
  if (!res.ok) throw new Error("Token failed: " + await res.text());
  const d = await res.json();
  _token = d.access_token;
  _tokenExpiry = Date.now() + (d.expires_in ?? 3600) * 1000;
  return _token!;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
function sbHeaders() {
  return {
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    "apikey":        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  };
}

async function sbSelect(table: string, query: string): Promise<any[]> {
  const url = `${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return [];
  return res.json();
}

async function sbInsert(table: string, row: Record<string, any>): Promise<boolean> {
  const url = `${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { ...sbHeaders(), "Prefer": "resolution=ignore-duplicates" },
    body:    JSON.stringify(row),
  });
  return res.ok || res.status === 409; // 409 = already exists (ignore)
}

async function sbUpsert(table: string, row: Record<string, any>, onConflict: string): Promise<boolean> {
  const url = `${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?on_conflict=${onConflict}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { ...sbHeaders(), "Prefer": "resolution=merge-duplicates" },
    body:    JSON.stringify(row),
  });
  return res.ok;
}

async function sbUpdate(table: string, id: string, changes: Record<string, any>): Promise<boolean> {
  const url = `${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?id=eq.${id}`;
  const res = await fetch(url, {
    method:  "PATCH",
    headers: sbHeaders(),
    body:    JSON.stringify(changes),
  });
  return res.ok;
}

// ── Resolve an email address to a KTA user id ─────────────────────────────────
// Returns the user's UUID from the users table, or null if not found.
async function resolveUserByEmail(email: string): Promise<string | null> {
  if (!email) return null;
  const rows = await sbSelect("users", `email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
  return rows[0]?.id ?? null;
}

// ── Fetch a full message from Graph ──────────────────────────────────────────
async function fetchMessage(token: string, userEmail: string, messageId: string) {
  const res = await fetch(
    `${GRAPH_BASE}/users/${userEmail}/messages/${messageId}` +
    `?$select=id,subject,from,toRecipients,ccRecipients,sentDateTime,bodyPreview`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

// ── Write a captured email to activity_notes ──────────────────────────────────
async function writeActivityNote(
  msg:          any,
  senderEmail:  string,
  recipientEmail: string,
  recipientName:  string,
) {
  const personId = await resolveUserByEmail(recipientEmail);

  const note = {
    id:            msg.id,           // use Graph message ID as PK — idempotent
    person_email:  recipientEmail,
    person_id:     personId,
    person_name:   recipientName || recipientEmail,
    type:          "email",
    subject:       msg.subject ?? "(no subject)",
    activity_type: "Email",
    body:          `From: ${senderEmail}\nTo: ${recipientEmail}\n\n${msg.bodyPreview ?? ""}`,
    direction:     "outbound",
    is_locked:     false,
    created_at:    msg.sentDateTime ?? new Date().toISOString(),
  };

  return sbInsert("activity_notes", note);
}

// ── Log an unknown recipient ───────────────────────────────────────────────────
async function logUnknownContact(email: string, name: string, subject: string) {
  // Check if already logged (not dismissed)
  const existing = await sbSelect(
    "unknown_email_contacts",
    `email=eq.${encodeURIComponent(email)}&dismissed=eq.false&limit=1`
  );

  if (existing.length > 0) {
    // Update encounter count and last seen
    await sbUpdate("unknown_email_contacts", existing[0].id, {
      encounter_count: (existing[0].encounter_count ?? 1) + 1,
      last_seen:       new Date().toISOString(),
      last_subject:    subject,
      name:            name || existing[0].name,
    });
  } else {
    await sbInsert("unknown_email_contacts", {
      email,
      name:            name || email,
      last_subject:    subject,
      encounter_count: 1,
      last_seen:       new Date().toISOString(),
      dismissed:       false,
    });
  }
}

// ── Process a notification from Graph (new sent email) ────────────────────────
async function processNotification(notification: any) {
  try {
    const resource: string = notification.resource ?? "";
    // resource = "Users/{userId}/Messages/{messageId}"
    const parts     = resource.split("/");
    const userId    = parts[1];   // could be UPN or object ID
    const messageId = parts[3];
    if (!userId || !messageId) return;

    const token      = await getToken();
    const msg        = await fetchMessage(token, userId, messageId);
    if (!msg) return;

    const subject: string = msg.subject ?? "";

    // Skip [private] emails
    if (subject.toLowerCase().includes("[private]")) return;

    const senderEmail = msg.from?.emailAddress?.address?.toLowerCase() ?? "";

    // Process each non-KTA recipient
    const allRecipients = [
      ...(msg.toRecipients  ?? []),
      ...(msg.ccRecipients  ?? []),
    ];

    for (const r of allRecipients) {
      const addr = r.emailAddress?.address?.toLowerCase() ?? "";
      const name = r.emailAddress?.name ?? "";
      if (!addr) continue;

      // Skip internal kta.org.nz → kta.org.nz emails
      if (addr.endsWith("@kta.org.nz")) continue;

      // Check if this recipient is a known CRM contact or user
      const knownUser = await resolveUserByEmail(addr);
      const crmRows   = await sbSelect(
        "crm_contacts",
        `email=eq.${encodeURIComponent(addr)}&limit=1`
      );
      const isKnown = !!knownUser || crmRows.length > 0;

      if (isKnown) {
        await writeActivityNote(msg, senderEmail, addr, name);
      } else {
        await logUnknownContact(addr, name, subject);
      }
    }
  } catch (e) {
    console.error("processNotification error:", e);
  }
}

// ── Subscription helpers ──────────────────────────────────────────────────────
async function listSubscriptions(token: string): Promise<any[]> {
  const res = await fetch(`${GRAPH_BASE}/subscriptions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const d = await res.json();
  return d.value ?? [];
}

async function createSubscription(
  token:           string,
  userEmail:       string,
  notificationUrl: string,
): Promise<{ ok: boolean; subscription?: any; error?: string }> {
  const expiry = new Date(Date.now() + SUB_LIFETIME).toISOString();
  const body = {
    changeType:         "created",
    notificationUrl,
    resource:           `users/${userEmail}/mailFolders/sentItems/messages`,
    expirationDateTime: expiry,
    clientState:        userEmail,   // stored so we know which mailbox this sub is for
  };
  const res = await fetch(`${GRAPH_BASE}/subscriptions`, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Graph subscription failed (${res.status}): ${text}` };
  }
  const subscription = await res.json();
  return { ok: true, subscription };
}

async function deleteSubscription(token: string, subscriptionId: string): Promise<boolean> {
  const res = await fetch(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
    method:  "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok || res.status === 404;
}

async function renewSubscription(
  token:          string,
  subscriptionId: string,
): Promise<boolean> {
  const expiry = new Date(Date.now() + SUB_LIFETIME).toISOString();
  const res = await fetch(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
    method:  "PATCH",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expirationDateTime: expiry }),
  });
  return res.ok;
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const url     = new URL(req.url);
  const subpath = url.pathname.split("/").pop() ?? "";

  // ── /manage-subscriptions ──────────────────────────────────────────────────
  // Called by the KTA app UI to manage which mailboxes are monitored.
  if (subpath === "manage-subscriptions") {
    try {
      const body = await req.json();
      const { action, userEmail, subscriptionId, notificationUrl } = body;
      const token = await getToken();

      if (action === "list") {
        const subs = await listSubscriptions(token);
        return new Response(
          JSON.stringify({ ok: true, subscriptions: subs }),
          { headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      if (action === "create") {
        if (!userEmail || !notificationUrl) {
          return new Response(
            JSON.stringify({ ok: false, error: "userEmail and notificationUrl required" }),
            { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
          );
        }
        // Remove any existing subscription for this mailbox first (avoid duplicates)
        const existing = await listSubscriptions(token);
        for (const s of existing) {
          if (s.clientState === userEmail || s.resource?.includes(userEmail)) {
            await deleteSubscription(token, s.id);
          }
        }
        const result = await createSubscription(token, userEmail, notificationUrl);
        return new Response(
          JSON.stringify(result),
          { headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      if (action === "delete") {
        if (!subscriptionId) {
          return new Response(
            JSON.stringify({ ok: false, error: "subscriptionId required" }),
            { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
          );
        }
        const ok = await deleteSubscription(token, subscriptionId);
        return new Response(
          JSON.stringify({ ok }),
          { headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      if (action === "renew-all") {
        const subs    = await listSubscriptions(token);
        const results = await Promise.all(subs.map((s) => renewSubscription(token, s.id)));
        return new Response(
          JSON.stringify({ ok: true, results }),
          { headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      // ── sync-all ────────────────────────────────────────────────────────────
      // Discovers ALL @kta.org.nz mailboxes and ensures each has an active
      // subscription. Tries Azure AD directory first (requires User.Read.All
      // Application permission); falls back to the Supabase users table.
      if (action === "sync-all") {
        if (!notificationUrl) {
          return new Response(
            JSON.stringify({ ok: false, error: "notificationUrl required" }),
            { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
          );
        }

        // 1. Try to get all @kta.org.nz users from Azure AD directory
        let allMailboxes: string[] = [];
        let source = "azure_ad";

        try {
          const usersRes = await fetch(
            `${GRAPH_BASE}/users?$filter=endswith(mail,'@kta.org.nz')&$select=mail,displayName&$top=999&$count=true`,
            { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" } }
          );
          if (usersRes.ok) {
            const usersData = await usersRes.json();
            allMailboxes = (usersData.value ?? [])
              .map((u: any) => u.mail?.toLowerCase())
              .filter(Boolean);
          }
        } catch { /* fall through to DB lookup */ }

        // 2. Fall back to Supabase users table if Azure AD listing failed or returned nothing
        if (allMailboxes.length === 0) {
          source = "supabase_db";
          const dbUsers = await sbSelect("users", "email=not.is.null&select=email");
          allMailboxes = dbUsers
            .map((u: any) => u.email?.toLowerCase())
            .filter((e: string) => e && e.endsWith("@kta.org.nz"));
        }

        if (allMailboxes.length === 0) {
          return new Response(
            JSON.stringify({ ok: false, error: "No @kta.org.nz mailboxes found" }),
            { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
          );
        }

        // 3. Get current subscriptions
        const existing = await listSubscriptions(token);

        const subsByMailbox = new Map<string, any>();
        for (const sub of existing) {
          const mailbox = sub.clientState?.toLowerCase() ||
            sub.resource?.match(/users\/([^\/]+)\//)?.[1]?.toLowerCase();
          if (mailbox) subsByMailbox.set(mailbox, sub);
        }

        const created: string[]  = [];
        const renewed: string[]  = [];
        const skipped: string[]  = [];
        const failed:  string[]  = [];

        for (const mailbox of allMailboxes) {
          const existingSub = subsByMailbox.get(mailbox);

          if (existingSub) {
            const hoursLeft = (new Date(existingSub.expirationDateTime).getTime() - Date.now()) / 3600000;
            if (hoursLeft < 36) {
              const ok = await renewSubscription(token, existingSub.id);
              if (ok) renewed.push(mailbox); else failed.push(mailbox);
            } else {
              skipped.push(mailbox);
            }
          } else {
            const result = await createSubscription(token, mailbox, notificationUrl);
            if (result.ok) created.push(mailbox); else failed.push(mailbox + ": " + (result.error ?? ""));
          }
        }

        return new Response(
          JSON.stringify({ ok: true, source, mailboxes: allMailboxes.length, created, renewed, skipped, failed }),
          { headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ ok: false, error: `Unknown action: ${action}` }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    } catch (e: any) {
      return new Response(
        JSON.stringify({ ok: false, error: e.message }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }
  }

  // ── Root POST — webhook from Microsoft Graph ───────────────────────────────
  // Graph sends a validationToken query param when first creating the subscription.
  // We must echo it back as text/plain to confirm the endpoint.
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new Response(validationToken, {
      headers: { ...CORS, "Content-Type": "text/plain" },
    });
  }

  // Otherwise it's a real notification payload
  try {
    const body = await req.json();
    const notifications: any[] = body.value ?? [];

    // Process all notifications concurrently but don't block the response —
    // Microsoft expects a 202 within a few seconds or it retries.
    const processAll = Promise.all(notifications.map(processNotification));

    // Return 202 immediately
    const response = new Response(null, { status: 202, headers: CORS });

    // Let processing run in background (Deno EdgeRuntime allows this)
    processAll.catch((e) => console.error("Background processing error:", e));

    return response;
  } catch (e: any) {
    console.error("Webhook handler error:", e);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
