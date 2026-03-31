import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const XERO_TOKEN_URL  = "https://identity.xero.com/connect/token";
const XERO_API_BASE   = "https://api.xero.com/payroll.xro/2.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function getAccessToken(): Promise<string> {
  const clientId     = Deno.env.get("XERO_CLIENT_ID")!;
  const clientSecret = Deno.env.get("XERO_CLIENT_SECRET")!;
  const credentials  = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "payroll.timesheets payroll.employees payroll.settings",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${text}`);
  return JSON.parse(text).access_token;
}

function getWeekBounds(dateStr: string) {
  // Use UTC explicitly to avoid timezone shifts
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (dt: Date) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  return { monStr: fmt(mon), sunStr: fmt(sun) };
}

async function xeroGet(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Xero API error (${res.status}) ${url}: ${text}`);
  try { return JSON.parse(text); } catch { throw new Error(`Non-JSON from ${url}: ${text.slice(0, 200)}`); }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const body = await req.json();
    const { action, tenantId } = body;
    const token = await getAccessToken();
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Xero-Tenant-Id": tenantId,
      "Content-Type": "application/json",
    };

    // ── Debug: verify token + tenant + API base ───────────────────────────
    if (action === "debug") {
      // Get connections to verify tenant ID
      const connRes = await fetch("https://api.xero.com/connections", { headers });
      const connText = await connRes.text();
      // Test Settings endpoint (simple read, payroll.settings scope)
      const settRes = await fetch(`${XERO_API_BASE}/Settings`, { headers });
      const settText = await settRes.text();
      // Test Employees endpoint
      const empRes = await fetch(`${XERO_API_BASE}/Employees`, { headers });
      const empText = await empRes.text();
      return new Response(JSON.stringify({
        ok: true,
        apiBase: XERO_API_BASE,
        tenantIdUsed: tenantId,
        connections: connText.slice(0, 500),
        settingsStatus: settRes.status,
        settingsBody: settText.slice(0, 300),
        employeesStatus: empRes.status,
        employeesBody: empText.slice(0, 300),
      }), { headers: cors });
    }

    // ── Get current employees ──────────────────────────────────────────────
    if (action === "getEmployees") {
      const empData = await xeroGet(`${XERO_API_BASE}/Employees`, headers);
      const allEmps: any[] = empData.employees ?? empData.Employees ?? [];
      const active = allEmps
        .filter((e: any) => {
          const status = (e.employmentStatus ?? e.EmploymentStatus ?? e.status ?? "").toString().toUpperCase();
          const terminated = e.terminationDate ?? e.TerminationDate ?? e.endDate ?? e.EndDate ?? null;
          // Exclude terminated employees
          if (terminated) return false;
          // Exclude if status explicitly says terminated/inactive
          if (status === "TERMINATED" || status === "INACTIVE") return false;
          // Must have an ID
          return !!(e.employeeID ?? e.EmployeeID);
        })
        .map((e: any) => {
          const addr = e.address ?? {};
          return {
            EmployeeID:   e.employeeID   ?? e.EmployeeID   ?? "",
            FirstName:    e.firstName    ?? e.FirstName    ?? "",
            LastName:     e.lastName     ?? e.LastName     ?? "",
            Email:        e.email        ?? e.Email        ?? "",
            PhoneNumber:  e.phoneNumber  ?? e.PhoneNumber  ?? "",
            JobTitle:     e.jobTitle     ?? e.JobTitle     ?? "",
            DateOfBirth:  e.dateOfBirth  ?? e.DateOfBirth  ?? "",
            StartDate:    e.startDate    ?? e.StartDate    ?? "",
            Gender:       e.gender       ?? e.Gender       ?? "",
            AddressLine1: addr.addressLine1 ?? addr.AddressLine1 ?? "",
            AddressLine2: addr.addressLine2 ?? addr.AddressLine2 ?? "",
            City:         addr.city      ?? addr.City      ?? "",
            Suburb:       addr.suburb    ?? addr.Suburb    ?? "",
            PostCode:     addr.postCode  ?? addr.PostCode  ?? "",
          };
        });
      return new Response(JSON.stringify({ ok: true, employees: active }), { headers: cors });
    }

    // ── Get earnings rates + leave types + reimbursements ─────────────────
    if (action === "getEarningsRates") {
      const rateData  = await xeroGet(`${XERO_API_BASE}/EarningsRates`, headers);
      const rateItems: any[] = rateData.earningsRates ?? rateData.EarningsRates ?? [];
      const normRates = rateItems.map((r: any) => ({
        id:   r.earningsRateID ?? r.EarningsRateID ?? "",
        name: r.name ?? r.Name ?? "",
        kind: "earnings",
      }));

      const leaveData  = await xeroGet(`${XERO_API_BASE}/LeaveTypes`, headers);
      const leaveItems: any[] = leaveData.leaveTypes ?? leaveData.LeaveTypes ?? [];
      const normLeave = leaveItems.map((l: any) => ({
        id:   l.leaveTypeID ?? l.LeaveTypeID ?? "",
        name: l.name ?? l.Name ?? "",
        kind: "leave",
      }));

      // Also fetch reimbursements — Tool Allowance lives here
      let normReimbursements: any[] = [];
      try {
        const reimbData = await xeroGet(`${XERO_API_BASE}/Reimbursements`, headers);
        const reimbItems: any[] = reimbData.reimbursements ?? reimbData.Reimbursements ?? [];
        normReimbursements = reimbItems.map((r: any) => ({
          id:   r.reimbursementID ?? r.ReimbursementID ?? "",
          name: r.name ?? r.Name ?? "",
          kind: "reimbursement",
        }));
      } catch(_e) { /* non-fatal */ }

      return new Response(JSON.stringify({
        ok: true,
        earningsRates: normRates,
        leaveTypes: normLeave,
        reimbursements: normReimbursements,
      }), { headers: cors });
    }

    // ── Upsert timesheet entry ─────────────────────────────────────────────
    if (action === "upsertTimesheet") {
      const { employeeId, date, lines, toolAllowanceId, toolAllowanceHours } = body;

      // Validate required fields
      if (!employeeId) return new Response(JSON.stringify({ ok: false, error: "Missing employeeId" }), { status: 400, headers: cors });
      if (!date)       return new Response(JSON.stringify({ ok: false, error: "Missing date" }), { status: 400, headers: cors });
      if (!lines || !Array.isArray(lines) || lines.length === 0)
        return new Response(JSON.stringify({ ok: false, error: "Missing or empty lines array" }), { status: 400, headers: cors });

      console.log("upsertTimesheet request:", JSON.stringify({ employeeId, date, lines, toolAllowanceId, toolAllowanceHours }));

      const { monStr, sunStr } = getWeekBounds(date);

      const earningsLines = (lines as any[]).filter((l: any) => l.earningsRateId);
      const leaveLines    = (lines as any[]).filter((l: any) => l.leaveTypeId);

      let timesheetId: string | undefined;

      // ── Create or find timesheet for earnings lines ──
      if (earningsLines.length > 0) {
        // Get employee's payroll calendar ID
        const empListData = await xeroGet(`${XERO_API_BASE}/Employees`, headers);
        const empList: any[] = empListData.employees ?? empListData.Employees ?? [];
        const empRecord = empList.find((e: any) => (e.employeeID ?? e.EmployeeID) === employeeId);
        const payrollCalendarID = empRecord?.payrollCalendarID ?? empRecord?.payrollCalendarId ?? empRecord?.PayrollCalendarID;
        if (!payrollCalendarID) {
          return new Response(JSON.stringify({
            ok: false,
            error: `Employee has no payroll calendar set in Xero (employeeId: ${employeeId})`,
          }), { status: 400, headers: cors });
        }

        // Try to create timesheet — if already exists, find it
        const createRes = await fetch(`${XERO_API_BASE}/Timesheets`, {
          method: "POST", headers,
          body: JSON.stringify({
            employeeID: employeeId,
            payrollCalendarID,
            startDate: monStr,
            endDate: sunStr,
          }),
        });
        const createText = await createRes.text();
        let createData: any = {};
        try { createData = JSON.parse(createText); } catch {}

        if (createRes.ok) {
          timesheetId = createData.timesheet?.timesheetID ?? createData.Timesheet?.TimesheetID;
        } else {
          // Already exists — try to extract the timesheetID from the error body
          const existingIdFromError = createData?.problem?.invalidObjects?.[0]?.timesheetID
            ?? createData?.detail?.invalidObjects?.[0]?.timesheetID
            ?? createData?.invalidObjects?.[0]?.timesheetID
            ?? null;

          if (existingIdFromError) {
            timesheetId = existingIdFromError;
            // Revert to draft so we can add lines
            await fetch(`${XERO_API_BASE}/Timesheets/${timesheetId}/RevertToDraft`, {
              method: "POST", headers, body: JSON.stringify({}),
            });
          } else {
          // Fallback — search by employeeId using NZ Payroll API query param, then filter by date
          let allSheets: any[] = [];
          try {
            const listData = await xeroGet(`${XERO_API_BASE}/Timesheets?employeeId=${employeeId}`, headers);
            allSheets = listData.timesheets ?? listData.Timesheets ?? [];
          } catch {}

          // If employee-specific query returned nothing, try getting all (paginated)
          if (allSheets.length === 0) {
            let page = 1;
            while (page <= 10) { // safety limit
              const pageData = await xeroGet(`${XERO_API_BASE}/Timesheets?page=${page}`, headers);
              const pageSheets: any[] = pageData.timesheets ?? pageData.Timesheets ?? [];
              if (pageSheets.length === 0) break;
              allSheets.push(...pageSheets);
              // Check if we already found the one we need
              const found = allSheets.find((ts: any) =>
                (ts.employeeID === employeeId || ts.EmployeeID === employeeId) &&
                ((ts.startDate ?? ts.StartDate ?? "").startsWith(monStr))
              );
              if (found) break;
              if (pageSheets.length < 100) break; // last page
              page++;
            }
          }

          const existing = allSheets.find((ts: any) =>
            (ts.employeeID === employeeId || ts.EmployeeID === employeeId) &&
            ((ts.startDate ?? ts.StartDate ?? "").startsWith(monStr)) &&
            ts.status !== "Deleted" && ts.Status !== "DELETED"
          );
          if (!existing) {
            return new Response(JSON.stringify({
              ok: false,
              error: `Could not create or find timesheet for employee ${employeeId} week ${monStr}`,
            }), { status: 400, headers: cors });
          }
          timesheetId = existing.timesheetID ?? existing.TimesheetID;
          // Revert to draft if needed so we can edit it
          const currentStatus = existing.status ?? existing.Status ?? "";
          if (currentStatus !== "Draft") {
            await fetch(`${XERO_API_BASE}/Timesheets/${timesheetId}/RevertToDraft`, {
              method: "POST", headers, body: JSON.stringify({}),
            });
          }
          } // end fallback else
        }

        // Add lines using POST /Timesheets/{id}/Lines (NZ API)
        // Body: date (YYYY-MM-DD), earningsRateID (UUID), numberOfUnits (number)
        for (const l of earningsLines) {
          const lineRes = await fetch(`${XERO_API_BASE}/Timesheets/${timesheetId}/Lines`, {
            method: "POST", headers,
            body: JSON.stringify({
              date,
              earningsRateID: l.earningsRateId,
              numberOfUnits: l.hours,
            }),
          });
          const lineText = await lineRes.text();
          if (!lineRes.ok) {
            let reason = `Timesheet line failed (${lineRes.status})`;
            try {
              const errData = JSON.parse(lineText);
              const fields = errData?.problem?.invalidFields ?? [];
              if (fields.length > 0) reason = fields.map((f: any) => `${f.name}: ${f.reason}`).join("; ");
            } catch {}
            return new Response(JSON.stringify({
              ok: false,
              error: reason,
            }), { status: 400, headers: cors });
          }
        }
      }

      // ── Handle leave lines via EmployeeLeave ──
      for (const l of leaveLines) {
        const leaveRes = await fetch(`${XERO_API_BASE}/Employees/${employeeId}/Leave`, {
          method: "POST", headers,
          body: JSON.stringify({
            leaveTypeID: l.leaveTypeId,
            startDate: date,
            endDate: date,
            description: `Leave - ${date}`,
          }),
        });
        const leaveText = await leaveRes.text();
        if (!leaveRes.ok) {
          // Extract human-readable reason from Xero error
          let reason = `Leave application failed (${leaveRes.status})`;
          try {
            const errData = JSON.parse(leaveText);
            const fields = errData?.problem?.invalidFields ?? [];
            if (fields.length > 0) reason = fields.map((f: any) => f.reason).join("; ");
          } catch {}
          return new Response(JSON.stringify({
            ok: false,
            error: reason,
          }), { status: 400, headers: cors });
        }
      }

      // ── Handle Tool Allowance ──
      // Added as an earnings line on the same timesheet using PUT /Lines
      // toolAllowanceHours = (Normal + Overtime hours) × $0.50 — calculated in App.jsx
      if (toolAllowanceId && toolAllowanceHours > 0 && timesheetId) {
        const taRes = await fetch(`${XERO_API_BASE}/Timesheets/${timesheetId}/Lines`, {
          method: "POST", headers,
          body: JSON.stringify({
            date,
            earningsRateID: toolAllowanceId,
            numberOfUnits: toolAllowanceHours,
          }),
        });
        const taText = await taRes.text();
        if (!taRes.ok) {
          // Non-fatal — log but don't fail the whole submission
          console.error(`Tool allowance line failed (${taRes.status}): ${taText}`);
        }
      }

      return new Response(JSON.stringify({ ok: true, timesheetId }), { headers: cors });
    }

    return new Response(JSON.stringify({ ok: false, error: "Unknown action" }), { status: 400, headers: cors });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
  }
});
