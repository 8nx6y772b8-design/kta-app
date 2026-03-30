// graph-mail-capture — Supabase Edge Function
// Receives MS Graph change notifications for sent emails across all KTA staff mailboxes
// Logs them to activity_notes, flags unknown contacts for review

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MS_TENANT_ID    = Deno.env.get("CAPTURE_TENANT_ID") || Deno.env.get("MS_TENANT_ID")!;
const MS_CLIENT_ID    = Deno.env.get("CAPTURE_CLIENT_ID") || Deno.env.get("MS_CLIENT_ID")!;
const MS_CLIENT_SECRET = Deno.env.get("CAPTURE_CLIENT_SECRET") || Deno.env.get("MS_CLIENT_SECRET")!;

// Validation token for Graph subscription setup
const VALIDATION_TOKEN = Deno.env.get("GRAPH_VALIDATION_TOKEN") || "kta-graph-capture-2024";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Get app-only access token (client credentials flow — no user needed) ──────
async function getAppToken(): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "client_credentials",
        client_id:     MS_CLIENT_ID,
        client_secret: MS_CLIENT_SECRET,
        scope:         "https://graph.microsoft.com/.default",
      }),
    }
  );
  if (!res.ok) throw new Error("Token failed: " + await res.text());
  const data = await res.json();
  return data.access_token;
}

// ── Fetch full message details from Graph ─────────────────────────────────────
async function fetchMessage(userId: string, messageId: string, token: string) {
  const res = await fetch(
    `${GRAPH_BASE}/users/${userId}/messages/${messageId}?$select=id,subject,from,toRecipients,ccRecipients,bodyPreview,body,sentDateTime,internetMessageId`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  return await res.json();
}

// ── Extract clean email address ───────────────────────────────────────────────
function cleanEmail(addr: any): string {
  if (!addr) return "";
  if (typeof addr === "string") return addr.toLowerCase().trim();
  return (addr.address || addr.emailAddress?.address || "").toLowerCase().trim();
}

// ── Check if email already logged ────────────────────────────────────────────
async function alreadyLogged(internetMessageId: string): Promise<boolean> {
  const { data } = await sb
    .from("activity_notes")
    .select("id")
    .eq("ms_message_id", internetMessageId)
    .limit(1);
  return (data?.length || 0) > 0;
}

// ── Load all CRM contacts + KTA users for matching ───────────────────────────
async function loadAllContacts() {
  const [{ data: contacts }, { data: users }] = await Promise.all([
    sb.from("crm_contacts").select("id,name,email,company"),
    sb.from("users").select("id,name,email,role"),
  ]);
  return {
    contacts: contacts || [],
    users: users || [],
  };
}

// ── Match an email address to a CRM contact or KTA user ──────────────────────
function matchContact(email: string, contacts: any[], users: any[]) {
  if (!email) return null;
  const e = email.toLowerCase();
  const contact = contacts.find((c: any) => c.email && c.email.toLowerCase() === e);
  if (contact) return { type: "contact", ...contact };
  const user = users.find((u: any) => u.email && u.email.toLowerCase() === e);
  if (user) return { type: "user", ...user };
  return null;
}

// ── Save email to activity_notes ──────────────────────────────────────────────
async function saveEmail(msg: any, senderUserId: string, match: any | null, recipientEmail: string, recipientName: string) {
  const row = {
    id:               crypto.randomUUID(),
    type:             "email",
    direction:        "outbound",
    subject:          msg.subject || "(no subject)",
    body:             msg.bodyPreview || "",
    person_id:        match?.id || null,
    person_name:      match?.name || recipientName || recipientEmail,
    person_email:     recipientEmail,
    ms_message_id:    msg.internetMessageId || msg.id,
    ms_sender_id:     senderUserId,
    created_at:       msg.sentDateTime || new Date().toISOString(),
    is_locked:        false,
    hubspot_engagement_id: null,
  };
  await sb.from("activity_notes").insert(row);
  return row;
}

// ── Save to unknown_email_contacts queue for review ───────────────────────────
async function queueUnknown(email: string, name: string, subject: string, senderName: string) {
  // Check not already queued
  const { data: existing } = await sb
    .from("unknown_email_contacts")
    .select("id")
    .eq("email", email)
    .limit(1);
  if (existing && existing.length > 0) {
    // Just increment encounter count
    await sb.from("unknown_email_contacts")
      .update({ 
        last_seen: new Date().toISOString(),
        encounter_count: sb.rpc("increment", { row_id: existing[0].id }) 
      })
      .eq("email", email);
    return;
  }
  await sb.from("unknown_email_contacts").insert({
    id:             crypto.randomUUID(),
    email:          email,
    name:           name || email,
    last_subject:   subject,
    last_sender:    senderName,
    first_seen:     new Date().toISOString(),
    last_seen:      new Date().toISOString(),
    encounter_count: 1,
    dismissed:      false,
  });
}

// ── Process a single notification ─────────────────────────────────────────────
async function processNotification(notification: any, token: string) {
  try {
    const userId    = notification.clientState; // we store userId in clientState
    const resourceUrl = notification.resource;  // users/{id}/messages/{msgId}
    
    // Extract message ID from resource URL
    const msgMatch = resourceUrl.match(/messages\/([^\/]+)$/);
    if (!msgMatch) return;
    const messageId = msgMatch[1];

    // Fetch full message
    const msg = await fetchMessage(userId, messageId, token);
    if (!msg) return;

    // Only process sent items (sentDateTime present, not just receivedDateTime)
    if (!msg.sentDateTime) return;

    // Skip if already logged
    if (msg.internetMessageId && await alreadyLogged(msg.internetMessageId)) return;

    // Get sender info
    const senderEmail = cleanEmail(msg.from?.emailAddress);
    const senderName  = msg.from?.emailAddress?.name || senderEmail;

    // Skip if [private] in subject
    if ((msg.subject || "").toLowerCase().includes("[private]")) return;

    // Load contacts for matching
    const { contacts, users } = await loadAllContacts();

    // Process each recipient
    const allRecipients = [
      ...(msg.toRecipients || []),
      ...(msg.ccRecipients || []),
    ];

    for (const recipient of allRecipients) {
      const recipientEmail = cleanEmail(recipient.emailAddress);
      const recipientName  = recipient.emailAddress?.name || "";

      // Skip internal kta.org.nz → kta.org.nz emails
      if (recipientEmail.endsWith("@kta.org.nz")) continue;
      // Skip empty
      if (!recipientEmail) continue;

      // Match to CRM contact or user
      const match = matchContact(recipientEmail, contacts, users);

      if (match) {
        // Known contact — log directly
        await saveEmail(msg, userId, match, recipientEmail, recipientName);
      } else {
        // Unknown — log anyway with null person_id, queue for review
        await saveEmail(msg, userId, null, recipientEmail, recipientName);
        await queueUnknown(recipientEmail, recipientName, msg.subject, senderName);
      }
    }
  } catch (e) {
    console.error("processNotification error:", e);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);

  // ── Graph sends a validation request when creating a subscription ──────────
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { ...cors, "Content-Type": "text/plain" },
    });
  }

  // ── Internal: create/renew subscriptions for all KTA staff ────────────────
  if (url.pathname.endsWith("/manage-subscriptions")) {
    try {
      const token = await getAppToken();
      const body  = await req.json().catch(() => ({}));
      const action = body.action || "list";

      if (action === "list") {
        const res = await fetch(`${GRAPH_BASE}/subscriptions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        return new Response(JSON.stringify({ ok: true, subscriptions: data.value || [] }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      if (action === "create") {
        // Create subscription for a specific user's sent items
        const { userEmail, notificationUrl } = body;
        if (!userEmail || !notificationUrl) {
          return new Response(JSON.stringify({ ok: false, error: "userEmail and notificationUrl required" }), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }

        // Get user ID from email
        const userRes = await fetch(`${GRAPH_BASE}/users/${userEmail}?$select=id,displayName`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!userRes.ok) throw new Error("User not found: " + userEmail);
        const user = await userRes.json();

        const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days
        const subRes = await fetch(`${GRAPH_BASE}/subscriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            changeType:         "created",
            notificationUrl:    notificationUrl,
            resource:           `users/${user.id}/mailFolders/SentItems/messages`,
            expirationDateTime: expiry,
            clientState:        user.id, // store userId so we know whose email it is
          }),
        });
        const sub = await subRes.json();
        if (!subRes.ok) throw new Error(JSON.stringify(sub));

        // Save subscription to DB for renewal tracking
        await sb.from("graph_subscriptions").upsert({
          id:             sub.id,
          user_email:     userEmail,
          user_id:        user.id,
          user_name:      user.displayName,
          expires_at:     expiry,
          notification_url: notificationUrl,
          active:         true,
        }, { onConflict: "user_email" });

        return new Response(JSON.stringify({ ok: true, subscription: sub, userId: user.id }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      if (action === "delete") {
        const { subscriptionId } = body;
        await fetch(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        await sb.from("graph_subscriptions").delete().eq("id", subscriptionId);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      if (action === "renew-all") {
        // Renew all subscriptions expiring within 24h
        const { data: subs } = await sb.from("graph_subscriptions").select("*").eq("active", true);
        const results = [];
        for (const sub of (subs || [])) {
          const newExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
          const res = await fetch(`${GRAPH_BASE}/subscriptions/${sub.id}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ expirationDateTime: newExpiry }),
          });
          const updated = await res.json();
          if (res.ok) {
            await sb.from("graph_subscriptions").update({ expires_at: newExpiry }).eq("id", sub.id);
            results.push({ email: sub.user_email, ok: true });
          } else {
            results.push({ email: sub.user_email, ok: false, error: updated.error?.message });
          }
        }
        return new Response(JSON.stringify({ ok: true, results }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 500, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }

  // ── Main webhook — Graph sends notifications here ──────────────────────────
  try {
    const body = await req.json();
    const notifications = body.value || [];

    if (notifications.length === 0) {
      return new Response("ok", { headers: cors });
    }

    // Respond immediately to Graph (must respond within 3s)
    // Process in background
    const token = await getAppToken();

    // Process all notifications (Graph batches them)
    await Promise.allSettled(
      notifications.map((n: any) => processNotification(n, token))
    );

    return new Response(JSON.stringify({ ok: true, processed: notifications.length }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });

  } catch (e: any) {
    console.error("Webhook error:", e);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
