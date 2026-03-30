// supabase/functions/hubspot-proxy/index.ts
// Deployed via: node kta-deploy-functions.cjs hubspot-proxy
//
// Supported actions:
//   getCompanies          — paginated list of all companies
//   searchContacts        — paginated list of all contacts
//   getCompanyContacts    — contacts associated with a company  {companyId}
//   getNotes              — paginated notes with contact/company associations
//   getCalls              — paginated calls with contact/company associations
//   getMeetings           — paginated meetings with contact/company associations
//   getEngagementEmails   — paginated emails (HubSpot-logged) with associations
//   getTasks              — paginated tasks with contact/company associations

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const BASE = "https://api.hubapi.com";

// Properties to fetch for each object type
const CONTACT_PROPS = [
  // Core identity
  "firstname","lastname","email","phone","mobilephone","company",
  "industry","jobtitle","description","salutation","date_of_birth",
  "address","city","zip","country","hs_lead_status",
  "notes_last_contacted","createdate",
  // Licence / compliance — try every common naming variant
  // Electrical worker licence
  "ew_licence_expiry","electrical_worker_licence_expiry",
  "ew_licence_expiry_date","electrician_licence_expiry",
  "licence_expiry","licence_expiry_date","trade_licence_expiry",
  "ew_licence_number","licence_number","electrical_licence_number",
  // Site Safe
  "site_safe_expiry","sitesafe_expiry","site_safe_expiry_date",
  "sitesafe_expiry_date","site_safe_card_expiry","sitesafe",
  "site_safe_number","sitesafe_number","site_safe_card_number",
  // First Aid
  "first_aid_expiry","firstaid_expiry","first_aid_expiry_date",
  "firstaid_expiry_date","first_aid_certificate_expiry",
  "first_aid_number","firstaid_number","first_aid_certificate_number",
  // Emergency contact
  "emergency_contact_name","emergency_contact","next_of_kin",
  "nok_name","emergency_name","emergency_contact_firstname",
  "emergency_contact_phone","emergency_phone","nok_phone",
  "emergency_contact_relationship","nok_relationship","emergency_relationship",
].join(",");

const COMPANY_PROPS = [
  "name","industry","phone","website","address","city","zip","country",
  "description","hs_lead_status","annualrevenue","createdate",
].join(",");

const NOTE_PROPS    = "hs_note_body,hs_timestamp,createdate,hubspot_owner_id";
const CALL_PROPS    = "hs_call_body,hs_call_title,hs_call_duration,hs_call_direction,hs_call_disposition,hs_timestamp,createdate";
const MEETING_PROPS = "hs_meeting_title,hs_meeting_body,hs_meeting_start_time,hs_meeting_end_time,hs_meeting_outcome,hs_timestamp,createdate";
const EMAIL_PROPS   = "hs_email_subject,hs_email_text,hs_email_html,hs_email_direction,hs_email_from_email,hs_email_to_email,hs_timestamp,createdate";
const TASK_PROPS    = "hs_task_subject,hs_task_body,hs_task_status,hs_task_type,hs_task_completion_date,hs_timestamp,createdate";

// Standard associations to include with engagements
const ENGAGEMENT_ASSOC = "contact,company";

async function hsGet(token: string, path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    },
  });
}

async function hsPost(token: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(body),
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { action, token, after, companyId } = await req.json();

    if (!token) {
      return new Response(JSON.stringify({ ok: false, error: "No token provided" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
        status: 400,
      });
    }

    let result: unknown;

    // ── Contacts ─────────────────────────────────────────────────────────────
    if (action === "searchContacts") {
      const body = {
        filterGroups: [],
        properties:   CONTACT_PROPS.split(","),
        limit:        100,
        ...(after ? { after } : {}),
      };
      // Use the list endpoint with associations instead of search, so we get company links
      const qs = new URLSearchParams({
        limit:        "100",
        properties:   CONTACT_PROPS,
        associations: "company",
        ...(after ? { after } : {}),
      });
      const r = await hsGet(token, `/crm/v3/objects/contacts?${qs}`);
      result = await r.json();

    // ── Companies ────────────────────────────────────────────────────────────
    } else if (action === "getCompanies") {
      const qs = new URLSearchParams({
        limit:      "100",
        properties: COMPANY_PROPS,
        ...(after ? { after } : {}),
      });
      const r = await hsGet(token, `/crm/v3/objects/companies?${qs}`);
      result = await r.json();

    // ── Company → Contacts associations ──────────────────────────────────────
    } else if (action === "getCompanyContacts") {
      if (!companyId) throw new Error("companyId required");
      const r = await hsGet(
        token,
        `/crm/v3/objects/companies/${companyId}/associations/contacts?limit=500`
      );
      result = await r.json();

    // ── Notes ─────────────────────────────────────────────────────────────────
    } else if (action === "getNotes") {
      const qs = new URLSearchParams({
        limit:        "100",
        properties:   NOTE_PROPS,
        associations: ENGAGEMENT_ASSOC,
        ...(after ? { after } : {}),
      });
      const r = await hsGet(token, `/crm/v3/objects/notes?${qs}`);
      result = await r.json();

    // ── Calls ─────────────────────────────────────────────────────────────────
    } else if (action === "getCalls") {
      const qs = new URLSearchParams({
        limit:        "100",
        properties:   CALL_PROPS,
        associations: ENGAGEMENT_ASSOC,
        ...(after ? { after } : {}),
      });
      const r = await hsGet(token, `/crm/v3/objects/calls?${qs}`);
      result = await r.json();

    // ── Meetings ──────────────────────────────────────────────────────────────
    } else if (action === "getMeetings") {
      const qs = new URLSearchParams({
        limit:        "100",
        properties:   MEETING_PROPS,
        associations: ENGAGEMENT_ASSOC,
        ...(after ? { after } : {}),
      });
      const r = await hsGet(token, `/crm/v3/objects/meetings?${qs}`);
      result = await r.json();

    // ── Emails (HubSpot-logged) ───────────────────────────────────────────────
    } else if (action === "getEngagementEmails") {
      const qs = new URLSearchParams({
        limit:        "100",
        properties:   EMAIL_PROPS,
        associations: ENGAGEMENT_ASSOC,
        ...(after ? { after } : {}),
      });
      const r = await hsGet(token, `/crm/v3/objects/emails?${qs}`);
      result = await r.json();

    // ── Tasks ─────────────────────────────────────────────────────────────────
    } else if (action === "getTasks") {
      const qs = new URLSearchParams({
        limit:        "100",
        properties:   TASK_PROPS,
        associations: ENGAGEMENT_ASSOC,
        ...(after ? { after } : {}),
      });
      const r = await hsGet(token, `/crm/v3/objects/tasks?${qs}`);
      result = await r.json();

    // ── Diagnostic: get ALL properties for first contact ──────────────────────
    } else if (action === "inspectContact") {
      // Fetch first contact with ALL properties to reveal exact field names
      const r = await hsGet(token, `/crm/v3/objects/contacts?limit=1&properties=*`);
      result = await r.json();

    // ── Diagnostic: list ALL contact property definitions ────────────────────
    } else if (action === "getContactProperties") {
      // Returns every property defined in this HubSpot account for contacts
      const r = await hsGet(token, `/crm/v3/properties/contacts?archived=false`);
      result = await r.json();

    } else {
      return new Response(
        JSON.stringify({ ok: false, error: `Unknown action: ${action}` }),
        { headers: { ...CORS, "Content-Type": "application/json" }, status: 400 }
      );
    }

    return new Response(JSON.stringify(result), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { headers: { ...CORS, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
