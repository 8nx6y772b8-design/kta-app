// KTA Calendar Proxy — Supabase Edge Function
// Creates an all-day leave event on the KTA team M365 calendar when leave is fully approved.
// Deploy: supabase functions deploy calendar-proxy
//
// Required Supabase secrets (shared with email-proxy):
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
//
// Required Azure App Registration permissions (Application, admin consented):
//   Calendars.ReadWrite
//
// TEAM_CALENDAR_ADDRESS — the M365 mailbox that owns the shared team calendar.
// Set this to the shared mailbox or user whose calendar acts as the team calendar,
// e.g. "timesheet@kta.org.nz" or "teamcalendar@kta.org.nz"

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GRAPH_BASE       = "https://graph.microsoft.com/v1.0";
const TEAM_MAILBOX     = "timesheet@kta.org.nz"; // mailbox that owns the calendar
const TEAM_CALENDAR_NAME = "KTA Team New";          // display name of the calendar

const CORS = {
  "Access-Control-Allow-Origin":  "https://crmkta.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Get app-only access token ─────────────────────────────────────────────────
async function getAppToken(): Promise<string> {
  const tenantId    = Deno.env.get("MS_TENANT_ID");
  const clientId    = Deno.env.get("MS_CLIENT_ID");
  const clientSecret = Deno.env.get("MS_CLIENT_SECRET");

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      `Missing M365 secrets — present: tenant=${!!tenantId} client=${!!clientId} secret=${!!clientSecret}. ` +
      `Add MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET in Supabase Dashboard → Project Settings → Edge Functions → Secrets.`
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

  const json = await res.json();
  if (!res.ok) throw new Error(`Token request failed ${res.status}: ${JSON.stringify(json)}`);
  if (!json.access_token) throw new Error(`Token response missing access_token: ${JSON.stringify(json)}`);
  return json.access_token;
}

// ── Create all-day calendar event ─────────────────────────────────────────────
// Look up the calendar ID by display name
async function getCalendarId(token: string): Promise<string> {
  const res = await fetch(
    `${GRAPH_BASE}/users/${TEAM_MAILBOX}/calendars?$select=id,name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("Could not list calendars: " + await res.text());
  const data = await res.json();
  const cal = (data.value || []).find((c: any) => c.name === TEAM_CALENDAR_NAME);
  if (!cal) throw new Error(`Calendar "${TEAM_CALENDAR_NAME}" not found on ${TEAM_MAILBOX}. Available: ${(data.value||[]).map((c:any)=>c.name).join(", ")}`);
  return cal.id;
}

async function createLeaveEvent(token: string, event: {
  subject:     string;
  bodyText:    string;
  dateFrom:    string; // YYYY-MM-DD
  dateTo:      string; // YYYY-MM-DD  (inclusive — Graph end date is exclusive so we add 1 day)
  categories?: string[];
}) {
  // Graph all-day events: end date must be the day AFTER the last day
  const endDate = new Date(event.dateTo);
  endDate.setDate(endDate.getDate() + 1);
  const endDateStr = endDate.toISOString().split("T")[0];

  // Try named calendar first, fall back to default calendar if not found
  let calendarPath: string;
  try {
    const calendarId = await getCalendarId(token);
    calendarPath = `${GRAPH_BASE}/users/${TEAM_MAILBOX}/calendars/${calendarId}/events`;
  } catch(e: any) {
    console.warn("Named calendar not found, using default calendar:", e.message);
    calendarPath = `${GRAPH_BASE}/users/${TEAM_MAILBOX}/events`;
  }

  const body = {
    subject: event.subject,
    body: {
      contentType: "text",
      content:     event.bodyText,
    },
    start: {
      dateTime: `${event.dateFrom}T00:00:00`,
      timeZone: "New Zealand Standard Time",
    },
    end: {
      dateTime: `${endDateStr}T00:00:00`,
      timeZone: "New Zealand Standard Time",
    },
    isAllDay:      true,
    showAs:        "oof",
    categories:    event.categories || ["KTA Leave"],
    isReminderOn:  false,
    sensitivity:   "normal",
    transactionId: `kta-leave-${event.dateFrom}-${event.subject.replace(/\s+/g, "-").toLowerCase().slice(0, 40)}`,
  };

  const res = await fetch(calendarPath, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph calendar error ${res.status}: ${err}`);
  }

  return await res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { apprenticeName, leaveType, dateFrom, dateTo } = payload;

  if (!apprenticeName || !leaveType || !dateFrom || !dateTo) {
    return new Response(JSON.stringify({ error: "Missing required fields: apprenticeName, leaveType, dateFrom, dateTo" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return new Response(JSON.stringify({ error: "Dates must be YYYY-MM-DD" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const token = await getAppToken();

    // Format NZ dates for display in body
    const fmtNZ = (iso: string) => {
      const [y, m, d] = iso.split("-");
      return `${d}/${m}/${y}`;
    };

    const event = await createLeaveEvent(token, {
      subject:  `${apprenticeName} — ${leaveType}`,
      bodyText: `Leave approved by KTA.\nApprenticeName: ${apprenticeName}\nLeave Type: ${leaveType}\nFrom: ${fmtNZ(dateFrom)}\nTo: ${fmtNZ(dateTo)}\n\nAdded automatically by KTA Workforce Management.`,
      dateFrom,
      dateTo,
      categories: ["KTA Leave"],
    });

    return new Response(JSON.stringify({ success: true, eventId: event.id }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("calendar-proxy error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
