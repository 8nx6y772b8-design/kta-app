// Supabase Edge Function — leave-action
// Handles one-click approve/decline from leave request emails
// Verifies HMAC token, updates DB, redirects to crmkta.com result screen
//
// Deploy: supabase functions deploy leave-action
// Secrets: HMAC_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = "https://crmkta.com";

// Verify HMAC-SHA256 token (same algorithm as App.jsx signLeaveToken)
// Verifies against the raw payloadB64 string — no JSON re-serialisation needed.
const verifyToken = async (token, secret) => {
  try {
    const dotIdx = token.indexOf(".");
    if (dotIdx === -1) return null;
    const payloadB64 = token.slice(0, dotIdx);
    const sig        = token.slice(dotIdx + 1);
    if (!payloadB64 || !sig) return null;

    const payload = JSON.parse(atob(payloadB64));

    // Check expiry
    if (payload.exp && Date.now() > payload.exp) return null;

    // Verify signature against the raw payloadB64 bytes
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );

    // Decode URL-safe base64 signature
    const b64 = sig.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    const sigBytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));

    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(payloadB64));
    if (!valid) return null;

    return payload;
  } catch(e) {
    console.error("Token verify error:", e);
    return null;
  }
};

const redirectTo = (url) =>
  new Response(null, { status: 302, headers: { Location: url } });

const errorRedirect = (msg) =>
  redirectTo(`${APP_URL}?leave_result=1&status=error&msg=${encodeURIComponent(msg)}`);

serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (!token) return errorRedirect("Missing token");

  const secret = Deno.env.get("HMAC_SECRET");
  if (!secret) return errorRedirect("Server misconfiguration");
  const payload = await verifyToken(token, secret);

  if (!payload) return errorRedirect("Invalid or expired link");

  const { id: leaveId, action, actorId, actorRole } = payload;

  if (!leaveId || !action || !["approve", "decline"].includes(action)) {
    return errorRedirect("Invalid action");
  }

  // Connect to Supabase with service role key
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sb = createClient(supabaseUrl, serviceKey);

  // Fetch the leave request
  const { data: leaveReq, error: fetchErr } = await sb
    .from("leave_requests")
    .select("*")
    .eq("id", leaveId)
    .single();

  if (fetchErr || !leaveReq) return errorRedirect("Leave request not found");

  // Already actioned — just show result
  if (leaveReq.status !== "pending" && leaveReq.status !== "approver_approved") {
    return redirectTo(
      `${APP_URL}?leave_result=1&status=already_actioned&type=${encodeURIComponent(leaveReq.leave_type || "Leave")}`
    );
  }

  // Determine new status
  let newStatus;
  if (action === "decline") {
    newStatus = "declined";
  } else if (actorRole === "admin") {
    newStatus = "kta_approved";
  } else {
    newStatus = "approver_approved";
  }

  // Fetch apprentice and actor names for result screen
  const { data: apprentice } = await sb.from("users").select("name").eq("id", leaveReq.apprentice_id).single();
  const { data: actor }      = await sb.from("users").select("name").eq("id", actorId).single();

  // Update leave request
  const { error: updateErr } = await sb
    .from("leave_requests")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", leaveId);

  if (updateErr) {
    console.error("Update error:", updateErr);
    return errorRedirect("Failed to update leave request");
  }

  // Redirect to KTA app result screen
  const params = new URLSearchParams({
    leave_result:  "1",
    status:        newStatus,
    type:          leaveReq.leave_type || "Leave",
    name:          apprentice?.name   || "",
    approver:      actor?.name        || "",
    date_from:     leaveReq.date_from || "",
    date_to:       leaveReq.date_to   || "",
  });

  return redirectTo(`${APP_URL}?${params.toString()}`);
});
