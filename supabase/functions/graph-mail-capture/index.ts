// KTA Graph Mail Capture — Supabase Edge Function
// Deploy:  supabase functions deploy graph-mail-capture --project-ref <project-ref>
// Secrets: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Responsibilities:
//   1. /manage-subscriptions  — manage Graph change-notification subscriptions
//                               (sentItems + inbox per KTA mailbox)
//   2. / (root POST)          — webhook from Graph; writes emails to activity_notes
//
// Rules:
//   - Emails with [private] in subject → NEVER logged
//   - Internal kta.org.nz ↔ kta.org.nz → NEVER logged
//   - mike@kta.org.nz / kristeena@kta.org.nz → logged with is_private=true;
//     visible only to them until they click "Release to timeline"
//   - Each email is idempotent on Graph message ID
//   - Unknown contacts are queued in unknown_email_contacts

// Mailboxes whose emails are private by default (only visible to the owner)
const PRIVATE_MAILBOXES = new Set([
  "mike@kta.org.nz",
  "kristeena@kta.org.nz",
]);

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GRAPH_BASE   = "https://graph.microsoft.com/v1.0";
const SUB_LIFETIME = 4230 * 60 * 1000; // ~3 days in ms (Graph max for Mail)

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

// ── Resolve a Graph user ID (GUID or UPN) to an email address ────────────────
async function resolveUserIdToEmail(token: string, userId: string): Promise<string> {
  if (userId.includes("@")) return userId.toLowerCase();
  try {
    const res = await fetch(`${GRAPH_BASE}/users/${userId}?$select=mail,userPrincipalName`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return userId;
    const u = await res.json();
    return (u.mail || u.userPrincipalName || userId).toLowerCase();
  } catch {
    return userId;
  }
}

// ── Log an unknown external contact ──────────────────────────────────────────
async function logUnknownContact(email: string, name: string, subject: string) {
  const existing = await sbSelect(
    "unknown_email_contacts",
    `email=eq.${encodeURIComponent(email)}&dismissed=eq.false&limit=1`
  );
  if (existing.length > 0) {
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

// ── Fetch a full message from Graph ──────────────────────────────────────────
async function fetchMessage(token: string, userEmail: string, messageId: string) {
  const res = await fetch(
    `${GRAPH_BASE}/users/${userEmail}/messages/${messageId}` +
    `?$select=id,subject,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,bodyPreview,conversationId`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

// ── Write a captured email to activity_notes ──────────────────────────────────
// person_email — the external contact this entry belongs to on the CRM timeline
// ktaEmail     — the KTA staff member who sent/received (for privacy check)
// direction    — "outbound" (KTA→external) or "inbound" (external→KTA)
async function writeActivityNote(
  msg:         any,
  personEmail: string,
  personName:  string,
  ktaEmail:    string,
  direction:   "outbound" | "inbound",
) {
  const personId   = await resolveUserByEmail(personEmail);
  const isPrivate  = PRIVATE_MAILBOXES.has(ktaEmail.toLowerCase());
  const fromAddr   = direction === "outbound" ? ktaEmail    : personEmail;
  const toAddr     = direction === "outbound" ? personEmail : ktaEmail;
  const ts         = msg.sentDateTime ?? msg.receivedDateTime ?? new Date().toISOString();

  const note = {
    id:                  msg.id,           // Graph message ID — idempotent PK
    person_email:        personEmail,
    person_id:           personId,
    person_name:         personName || personEmail,
    type:                "email",
    subject:             msg.subject ?? "(no subject)",
    activity_type:       "Email",
    body:                msg.bodyPreview ?? "",
    direction,
    from_address:        fromAddr,
    to_address:          toAddr,
    ms_sender_id:        ktaEmail,
    ms_message_id:       msg.id,
    ms_conversation_id:  msg.conversationId ?? null,
    is_locked:           false,
    is_private:          isPrivate,
    private_mailbox:     isPrivate ? ktaEmail.toLowerCase() : null,
    email_date:          ts,
    created_at:          ts,
  };

  return sbInsert("activity_notes", note);
}

// ── Process a notification from Graph ────────────────────────────────────────
// Handles both sentItems (outbound) and inbox (inbound) resource paths.
async function processNotification(notification: any) {
  try {
    const resource: string = notification.resource ?? "";
    // resource examples:
    //   Users/{id}/MailFolders/sentItems/Messages/{msgId}
    //   Users/{id}/MailFolders/Inbox/Messages/{msgId}
    //   Users/{id}/Messages/{msgId}  (inbox shorthand used by some subscriptions)
    const parts     = resource.split("/");
    const rawUserId = parts[1];
    const messageId = parts[parts.length - 1];
    if (!rawUserId || !messageId || rawUserId === messageId) return;

    const resourceLower = resource.toLowerCase();
    const isSent  = resourceLower.includes("senditems");
    // Inbox = anything that is NOT sentItems
    const isInbox = !isSent;

    const token    = await getToken();
    const ktaEmail = await resolveUserIdToEmail(token, rawUserId);

    const msg = await fetchMessage(token, ktaEmail, messageId);
    if (!msg) return;

    const subject: string = msg.subject ?? "";

    // Skip [private] emails (staff-controlled opt-out)
    if (subject.toLowerCase().includes("[private]")) return;

    const senderEmail = msg.from?.emailAddress?.address?.toLowerCase() ?? "";

    if (isSent) {
      // ── Outbound: log to each external recipient's timeline ──────────────
      const allRecipients = [
        ...(msg.toRecipients ?? []),
        ...(msg.ccRecipients ?? []),
      ];
      for (const r of allRecipients) {
        const addr = r.emailAddress?.address?.toLowerCase() ?? "";
        const name = r.emailAddress?.name ?? "";
        if (!addr || addr.endsWith("@kta.org.nz")) continue;

        const knownUser = await resolveUserByEmail(addr);
        const crmRows   = await sbSelect("crm_contacts", `email=eq.${encodeURIComponent(addr)}&limit=1`);
        if (!!knownUser || crmRows.length > 0) {
          await writeActivityNote(msg, addr, name, ktaEmail, "outbound");
        } else {
          await logUnknownContact(addr, name, subject);
        }
      }
    } else if (isInbox) {
      // ── Inbound: log to sender's (external contact's) timeline ───────────
      const addr = senderEmail;
      const name = msg.from?.emailAddress?.name ?? "";
      if (!addr || addr.endsWith("@kta.org.nz")) return;

      const knownUser = await resolveUserByEmail(addr);
      const crmRows   = await sbSelect("crm_contacts", `email=eq.${encodeURIComponent(addr)}&limit=1`);
      if (!!knownUser || crmRows.length > 0) {
        await writeActivityNote(msg, addr, name, ktaEmail, "inbound");
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
  const all: any[] = [];
  let url: string | null = `${GRAPH_BASE}/subscriptions`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const d = await res.json();
    all.push(...(d.value ?? []));
    url = d["@odata.nextLink"] ?? null;
  }
  return all;
}

async function createSubscription(
  token:           string,
  userEmail:       string,
  folder:          "sentItems" | "inbox",
  notificationUrl: string,
): Promise<{ ok: boolean; subscription?: any; error?: string }> {
  const expiry = new Date(Date.now() + SUB_LIFETIME).toISOString();
  const body = {
    changeType:         "created",
    notificationUrl,
    resource:           `users/${userEmail}/mailFolders/${folder}/messages`,
    expirationDateTime: expiry,
    clientState:        `${userEmail}:${folder}`,
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
        // Remove any existing subscriptions for this mailbox first (avoid duplicates)
        const existing = await listSubscriptions(token);
        for (const s of existing) {
          const cs = s.clientState ?? "";
          if (cs === userEmail || cs.startsWith(userEmail + ":") || s.resource?.includes(userEmail)) {
            await deleteSubscription(token, s.id);
          }
        }
        // Create sentItems + inbox subscriptions
        const FOLDERS: Array<"sentItems" | "inbox"> = ["sentItems", "inbox"];
        const results = await Promise.all(FOLDERS.map(folder => createSubscription(token, userEmail, folder, notificationUrl)));
        const allOk = results.every(r => r.ok);
        return new Response(
          JSON.stringify({ ok: allOk, results }),
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

      if (action === "delete-all") {
        const subs    = await listSubscriptions(token);
        const results = await Promise.all(subs.map((s) => deleteSubscription(token, s.id)));
        const deleted = results.filter(Boolean).length;
        return new Response(
          JSON.stringify({ ok: true, deleted, total: subs.length }),
          { headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      if (action === "purge-captured") {
        // Delete all activity_notes rows that were auto-captured by graph-mail-capture
        // (identified by ms_message_id being set)
        const url = `${Deno.env.get("SUPABASE_URL")}/rest/v1/activity_notes?ms_message_id=not.is.null`;
        const res = await fetch(url, {
          method: "DELETE",
          headers: { ...sbHeaders(), "Prefer": "return=representation" },
        });
        const body = res.ok ? await res.json() : await res.text();
        const count = Array.isArray(body) ? body.length : "unknown";
        return new Response(
          JSON.stringify({ ok: res.ok, deleted: count, status: res.status }),
          { headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      // ── sync-all ────────────────────────────────────────────────────────────
      // Discovers ALL @kta.org.nz mailboxes and ensures each has both a
      // sentItems AND an inbox subscription. Creates up to 2 per mailbox.
      if (action === "sync-all") {
        if (!notificationUrl) {
          return new Response(
            JSON.stringify({ ok: false, error: "notificationUrl required" }),
            { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
          );
        }

        // 1. Get all @kta.org.nz mailboxes from Azure AD (fallback: Supabase DB)
        let allMailboxes: string[] = [];
        let source = "azure_ad";
        try {
          const usersRes = await fetch(
            `${GRAPH_BASE}/users?$filter=endswith(mail,'@kta.org.nz')&$select=mail&$top=999&$count=true`,
            { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" } }
          );
          if (usersRes.ok) {
            const usersData = await usersRes.json();
            allMailboxes = (usersData.value ?? [])
              .map((u: any) => u.mail?.toLowerCase())
              .filter(Boolean);
          }
        } catch { /* fall through to DB lookup */ }

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

        // 2. Build lookup map of existing subscriptions keyed by "email:folder"
        const existing = await listSubscriptions(token);
        const subMap = new Map<string, any>();
        for (const sub of existing) {
          const cs = sub.clientState ?? "";
          if (cs.includes(":")) {
            subMap.set(cs.toLowerCase(), sub);
          } else {
            // Legacy single-folder format — map to sentItems key
            const mailbox = cs.toLowerCase() ||
              sub.resource?.match(/users\/([^/]+)\//)?.[1]?.toLowerCase();
            if (mailbox) subMap.set(`${mailbox}:senteditems`, sub);
          }
        }

        // 3. Ensure sentItems + inbox subscriptions for every mailbox
        const FOLDERS: Array<"sentItems" | "inbox"> = ["sentItems", "inbox"];
        const results = await Promise.all(
          allMailboxes.flatMap(mailbox =>
            FOLDERS.map(async folder => {
              const key = `${mailbox}:${folder}`;
              const existingSub = subMap.get(key);
              if (existingSub) {
                const hoursLeft = (new Date(existingSub.expirationDateTime).getTime() - Date.now()) / 3600000;
                if (hoursLeft < 36) {
                  const ok = await renewSubscription(token, existingSub.id);
                  return { mailbox, folder, status: ok ? "renewed" : "failed" };
                }
                return { mailbox, folder, status: "skipped" };
              }
              const r = await createSubscription(token, mailbox, folder, notificationUrl);
              return { mailbox, folder, status: r.ok ? "created" : "failed", error: r.error };
            })
          )
        );

        const created = results.filter(r => r.status === "created").map(r => `${r.mailbox}:${r.folder}`);
        const renewed = results.filter(r => r.status === "renewed").map(r => `${r.mailbox}:${r.folder}`);
        const skipped = results.filter(r => r.status === "skipped").length;
        const failed  = results.filter(r => r.status === "failed").map(r => `${r.mailbox}:${r.folder}` + (r.error ? ` — ${r.error}` : ""));

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
