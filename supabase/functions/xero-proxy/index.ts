// KTA Xero Proxy — Supabase Edge Function v7
// Deploy: supabase functions deploy xero-proxy
// Secrets needed: XERO_CLIENT_ID, XERO_CLIENT_SECRET

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE  = "https://api.xero.com/payroll.xro/2.0";

async function getAccessToken(): Promise<string> {
  const clientId     = Deno.env.get("XERO_CLIENT_ID")!;
  const clientSecret = Deno.env.get("XERO_CLIENT_SECRET")!;
  const credentials  = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Token failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token: " + JSON.stringify(data));
  return data.access_token as string;
}

// Parse UTC date string YYYY-MM-DD safely
function parseUTCDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// Xero /Date(ms)/ format using UTC midnight
function toXeroDate(d: Date): string {
  return `/Date(${Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())})/`;
}

// Extract human-readable ValidationErrors from Xero response
function extractError(data: any): string | null {
  const ts = data?.timesheets?.[0] ?? data?.Timesheets?.[0];
  if (!ts) {
    // Top-level error
    if (data?.detail) return data.detail;
    if (data?.title) return data.title;
    return null;
  }
  const errs: string[] = [];
  const ve = ts.validationErrors ?? ts.ValidationErrors ?? [];
  if (Array.isArray(ve)) ve.forEach((e: any) => { if (e?.message || e?.Message) errs.push(e.message ?? e.Message); });
  return errs.length > 0 ? errs.join("; ") : null;
}

serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const body   = await req.json();
    const { action, tenantId, employeeId, date } = body;

    const token = await getAccessToken();
    const hdrs = {
      Authorization:    `Bearer ${token}`,
      "Xero-Tenant-Id": tenantId,
      "Content-Type":   "application/json",
      "Accept":         "application/json",
    };

    // ── upsertTimesheet ──────────────────────────────────────────────────────
    if (action === "upsertTimesheet") {
      const { lines, toolAllowanceId, toolAllowanceHours } = body;

      const d   = parseUTCDate(date);
      const day = d.getUTCDay(); // 0=Sun…6=Sat

      const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
      const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
      const monStr = mon.toISOString().slice(0, 10);
      const sunStr = sun.toISOString().slice(0, 10);

      console.log(`[upsert] employee=${employeeId} date=${date} week=${monStr}..${sunStr}`);

      // Xero Payroll NZ: one NumberOfUnits value per day (not a 7-element array)
      // Format: { date: "YYYY-MM-DD", numberOfUnits: N, earningsRateID: "..." }
      // Build timesheet lines per day
      const tsLines: Record<string, unknown>[] = [];
      for (const l of (lines || [])) {
        if (!l.hours || l.hours <= 0) continue;
        if (l.earningsRateId) {
          tsLines.push({
            earningsRateID: l.earningsRateId,
            date:           date,
            numberOfUnits:  l.hours,
          });
        } else if (l.leaveTypeId) {
          tsLines.push({
            leaveTypeID:   l.leaveTypeId,
            date:          date,
            numberOfUnits: l.hours,
          });
        }
      }
      if (toolAllowanceId && toolAllowanceHours > 0) {
        tsLines.push({
          earningsRateID: toolAllowanceId,
          date:           date,
          numberOfUnits:  toolAllowanceHours,
        });
      }
      console.log(`[upsert] tsLines=${JSON.stringify(tsLines)}`);

      // Step 1: Find the employee's payroll calendar
      const empRes  = await fetch(`${XERO_API_BASE}/Employees/${employeeId}`, { headers: hdrs });
      const empData = await empRes.json();
      if (!empRes.ok) {
        console.error("[step1] Employee fetch failed:", empRes.status, JSON.stringify(empData));
        const fwdStatus = empRes.status >= 500 ? 502 : 400;
        return new Response(JSON.stringify({ error: `Employee lookup failed (${empRes.status}): ${JSON.stringify(empData)}`, step: "employee-lookup" }), { status: fwdStatus, headers: cors });
      }
      const payrollCalendarId = empData.employee?.payrollCalendarID
                             ?? empData.Employee?.PayrollCalendarID
                             ?? null;
      console.log(`[step1] payrollCalendarId=${payrollCalendarId}`);

      // Step 2: Find existing timesheet using correct Xero filter syntax
      const filter  = `employeeId==${employeeId}${payrollCalendarId ? `,payrollCalendarId==${payrollCalendarId}` : ""}`;
      const getUrl  = `${XERO_API_BASE}/Timesheets?filter=${encodeURIComponent(filter)}&startDate=${monStr}&endDate=${sunStr}`;
      console.log(`[step2] GET ${getUrl}`);
      const getRes  = await fetch(getUrl, { headers: hdrs });
      const getData    = await getRes.json();
      if (!getRes.ok) {
        console.error("[step2] Timesheet search failed:", getRes.status, JSON.stringify(getData));
        const fwdStatus = getRes.status >= 500 ? 502 : 400;
        return new Response(JSON.stringify({ error: `Timesheet search failed (${getRes.status}): ${JSON.stringify(getData)}`, step: "timesheet-search" }), { status: fwdStatus, headers: cors });
      }
      const timesheets = getData.timesheets ?? getData.Timesheets ?? [];
      console.log(`[step2] found ${timesheets.length} timesheets`);
      // Find one whose period covers our date exactly
      const existing   = timesheets.find((ts: any) => {
        const tsStart = (ts.startDate ?? ts.StartDate ?? "").slice(0, 10);
        const tsEnd   = (ts.endDate   ?? ts.EndDate   ?? "").slice(0, 10);
        return tsStart <= date && tsEnd >= date;
      });

      let timesheetId: string | undefined;

      if (existing) {
        const existId = existing.timesheetID ?? existing.TimesheetID;
        const existStatus = existing.status ?? existing.Status;
        console.log(`[step3] EXISTING timesheet ${existId} status=${existStatus} — merging lines via PUT`);

        // GET the full timesheet to retrieve existing lines
        const getFullRes = await fetch(`${XERO_API_BASE}/Timesheets/${existId}`, { headers: hdrs });
        const getFullData = await getFullRes.json();
        if (!getFullRes.ok) {
          console.error("[step3] GET full timesheet failed:", getFullRes.status, JSON.stringify(getFullData));
          const fwdStatus = getFullRes.status >= 500 ? 502 : 400;
          return new Response(JSON.stringify({ error: `GET timesheet failed (${getFullRes.status})`, xeroStatus: getFullRes.status, step: "get-existing" }), { status: fwdStatus, headers: cors });
        }
        const fullTs = getFullData.timesheet ?? getFullData.Timesheet ?? getFullData;
        const existingLines: Record<string, unknown>[] = fullTs.timesheetLines ?? fullTs.TimesheetLines ?? [];
        console.log(`[step3] existing lines count: ${existingLines.length}`);

        // Remove any existing lines for the same date + earningsRateID/leaveTypeID to avoid duplicates
        const mergedLines = existingLines.filter((el: any) => {
          const elDate = (el.date ?? el.Date ?? "").slice(0, 10);
          if (elDate !== date) return true; // keep lines for other dates
          // Remove lines that match any of our new earningsRate/leaveType IDs
          const elEarn  = el.earningsRateID ?? el.EarningsRateID ?? "";
          const elLeave = el.leaveTypeID    ?? el.LeaveTypeID    ?? "";
          return !tsLines.some((nl: any) =>
            (nl.earningsRateID && nl.earningsRateID === elEarn) ||
            (nl.leaveTypeID    && nl.leaveTypeID    === elLeave)
          );
        });
        // Add our new lines
        mergedLines.push(...tsLines);
        console.log(`[step3] merged lines count: ${mergedLines.length}`);

        // PUT the full timesheet with merged lines
        const putBody = {
          employeeID: fullTs.employeeID ?? fullTs.EmployeeID,
          startDate:  (fullTs.startDate ?? fullTs.StartDate ?? "").slice(0, 10),
          endDate:    (fullTs.endDate   ?? fullTs.EndDate   ?? "").slice(0, 10),
          timesheetLines: mergedLines,
        };
        const pcId = fullTs.payrollCalendarID ?? fullTs.PayrollCalendarID;
        if (pcId) (putBody as any).payrollCalendarID = pcId;

        console.log(`[step3] PUT body: ${JSON.stringify({ timesheet: putBody })}`);
        const putRes = await fetch(`${XERO_API_BASE}/Timesheets/${existId}`, {
          method:  "PUT",
          headers: hdrs,
          body:    JSON.stringify({ timesheet: putBody }),
        });
        const putData = await putRes.json();
        if (!putRes.ok) {
          console.error("[step3] PUT timesheet failed:", putRes.status, JSON.stringify(putData));
          const err = extractError(putData);
          const fwdStatus = putRes.status >= 500 ? 502 : 400;
          return new Response(JSON.stringify({ error: err ?? JSON.stringify(putData), xeroStatus: putRes.status, step: "put-timesheet", timesheetStatus: existStatus }), { status: fwdStatus, headers: cors });
        }
        const valErr = extractError(putData);
        if (valErr) return new Response(JSON.stringify({ error: valErr, step: "put-validation" }), { status: 400, headers: cors });
        timesheetId = existId;

      } else {
        // No timesheet — POST to create with payrollCalendarID
        const tsBody: Record<string, unknown> = {
          employeeID: employeeId,
          startDate:  monStr,
          endDate:    sunStr,
          status:     "Draft",
          timesheetLines: tsLines,
        };
        if (payrollCalendarId) tsBody.payrollCalendarID = payrollCalendarId;

        console.log(`[step3] CREATE new timesheet: ${JSON.stringify({ timesheet: tsBody })}`);
        const postRes  = await fetch(`${XERO_API_BASE}/Timesheets`, {
          method:  "POST",
          headers: hdrs,
          body:    JSON.stringify({ timesheet: tsBody }),
        });
        const postData = await postRes.json();
        if (!postRes.ok) {
          console.error("[step3] Timesheet POST failed:", postRes.status, JSON.stringify(postData));
          const err = extractError(postData);
          const fwdStatus = postRes.status >= 500 ? 502 : 400;
          return new Response(JSON.stringify({ error: err ?? JSON.stringify(postData), xeroStatus: postRes.status, step: "create-timesheet" }), { status: fwdStatus, headers: cors });
        }
        const valErr = extractError(postData);
        if (valErr) return new Response(JSON.stringify({ error: valErr, step: "create-validation" }), { status: 400, headers: cors });
        timesheetId = postData.timesheet?.timesheetID ?? postData.Timesheet?.TimesheetID;
      }

      if (!timesheetId) {
        return new Response(JSON.stringify({ error: "No timesheetID returned — check Xero dashboard" }), { status: 400, headers: cors });
      }
      return new Response(JSON.stringify({ ok: true, timesheetId }), { headers: cors });
    }

    // ── upsertTimesheetBatch — multiple days for one employee in one call ────
    if (action === "upsertTimesheetBatch") {
      const { entries: batchEntries } = body; // [{ date, lines, toolAllowanceId, toolAllowanceHours }]
      if (!Array.isArray(batchEntries) || batchEntries.length === 0) {
        return new Response(JSON.stringify({ error: "No entries in batch" }), { status: 400, headers: cors });
      }
      console.log(`[batch] employee=${employeeId} entries=${batchEntries.length}`);

      // Build ALL timesheet lines from all entries
      const allTsLines: Record<string, unknown>[] = [];
      for (const be of batchEntries) {
        const entryDate = be.date;
        for (const l of (be.lines || [])) {
          if (!l.hours || l.hours <= 0) continue;
          if (l.earningsRateId) {
            allTsLines.push({ earningsRateID: l.earningsRateId, date: entryDate, numberOfUnits: l.hours });
          } else if (l.leaveTypeId) {
            allTsLines.push({ leaveTypeID: l.leaveTypeId, date: entryDate, numberOfUnits: l.hours });
          }
        }
        if (be.toolAllowanceId && be.toolAllowanceHours > 0) {
          const totalHrs = (be.lines || []).reduce((s: number, l: any) => s + (l.hours || 0), 0);
          allTsLines.push({ earningsRateID: be.toolAllowanceId, date: entryDate, numberOfUnits: totalHrs });
        }
      }
      console.log(`[batch] total lines: ${allTsLines.length}`);

      // Group lines by week (Mon-Sun)
      const weekGroups: Record<string, { monStr: string; sunStr: string; lines: Record<string, unknown>[] }> = {};
      for (const line of allTsLines) {
        const lineDate = String(line.date);
        const d = parseUTCDate(lineDate);
        const day = d.getUTCDay();
        const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
        const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
        const monStr = mon.toISOString().slice(0, 10);
        const sunStr = sun.toISOString().slice(0, 10);
        if (!weekGroups[monStr]) weekGroups[monStr] = { monStr, sunStr, lines: [] };
        weekGroups[monStr].lines.push(line);
      }

      // Step 1: Get employee payroll calendar
      const empRes = await fetch(`${XERO_API_BASE}/Employees/${employeeId}`, { headers: hdrs });
      const empData = await empRes.json();
      if (!empRes.ok) {
        console.error("[batch] Employee fetch failed:", empRes.status, JSON.stringify(empData));
        const fwdStatus = empRes.status >= 500 ? 502 : 400;
        return new Response(JSON.stringify({ error: `Employee lookup failed (${empRes.status})` }), { status: fwdStatus, headers: cors });
      }
      const payrollCalendarId = empData.employee?.payrollCalendarID ?? empData.Employee?.PayrollCalendarID ?? null;

      const results: Record<string, unknown>[] = [];

      for (const [weekKey, wg] of Object.entries(weekGroups)) {
        console.log(`[batch] week ${wg.monStr}..${wg.sunStr} — ${wg.lines.length} lines`);
        // Find existing timesheet for this week
        const filter = `employeeId==${employeeId}${payrollCalendarId ? `,payrollCalendarId==${payrollCalendarId}` : ""}`;
        const getRes = await fetch(
          `${XERO_API_BASE}/Timesheets?filter=${encodeURIComponent(filter)}&startDate=${wg.monStr}&endDate=${wg.sunStr}`,
          { headers: hdrs }
        );
        const getData = await getRes.json();
        if (!getRes.ok) {
          console.error("[batch] Timesheet search failed:", getRes.status, JSON.stringify(getData));
          results.push({ week: weekKey, ok: false, error: `Search failed (${getRes.status})` });
          continue;
        }
        const timesheets = getData.timesheets ?? getData.Timesheets ?? [];
        // Find covering timesheet
        const existing = timesheets.find((ts: any) => {
          const tsStart = (ts.startDate ?? ts.StartDate ?? "").slice(0, 10);
          const tsEnd   = (ts.endDate   ?? ts.EndDate   ?? "").slice(0, 10);
          return tsStart <= wg.monStr && tsEnd >= wg.sunStr;
        }) ?? (timesheets.length > 0 ? timesheets[0] : null);

        let timesheetId: string | undefined;

        if (existing) {
          const existId = existing.timesheetID ?? existing.TimesheetID;
          console.log(`[batch] EXISTING timesheet ${existId} — GET + merge + PUT`);

          // GET full timesheet
          const getFullRes = await fetch(`${XERO_API_BASE}/Timesheets/${existId}`, { headers: hdrs });
          const getFullData = await getFullRes.json();
          if (!getFullRes.ok) {
            results.push({ week: weekKey, ok: false, error: `GET failed (${getFullRes.status})` });
            continue;
          }
          const fullTs = getFullData.timesheet ?? getFullData.Timesheet ?? getFullData;
          const existingLines: Record<string, unknown>[] = fullTs.timesheetLines ?? fullTs.TimesheetLines ?? [];

          // Merge: remove existing lines for dates+rates we're updating, then add ours
          const newDatesAndRates = new Set(wg.lines.map((l: any) =>
            `${l.date}|${l.earningsRateID || ""}|${l.leaveTypeID || ""}`
          ));
          const kept = existingLines.filter((el: any) => {
            const elDate  = (el.date ?? el.Date ?? "").slice(0, 10);
            const elEarn  = el.earningsRateID ?? el.EarningsRateID ?? "";
            const elLeave = el.leaveTypeID    ?? el.LeaveTypeID    ?? "";
            return !newDatesAndRates.has(`${elDate}|${elEarn}|${elLeave}`);
          });
          const merged = [...kept, ...wg.lines];

          const putBody = {
            employeeID: fullTs.employeeID ?? fullTs.EmployeeID,
            startDate:  (fullTs.startDate ?? fullTs.StartDate ?? "").slice(0, 10),
            endDate:    (fullTs.endDate   ?? fullTs.EndDate   ?? "").slice(0, 10),
            timesheetLines: merged,
          };
          const pcId = fullTs.payrollCalendarID ?? fullTs.PayrollCalendarID;
          if (pcId) (putBody as any).payrollCalendarID = pcId;

          const putRes = await fetch(`${XERO_API_BASE}/Timesheets/${existId}`, {
            method: "PUT", headers: hdrs, body: JSON.stringify({ timesheet: putBody }),
          });
          const putData = await putRes.json();
          if (!putRes.ok) {
            const err = extractError(putData);
            console.error("[batch] PUT failed:", putRes.status, JSON.stringify(putData));
            results.push({ week: weekKey, ok: false, error: err ?? `PUT failed (${putRes.status})` });
            continue;
          }
          timesheetId = existId;
        } else {
          // Create new timesheet with all lines for this week
          const tsBody: Record<string, unknown> = {
            employeeID: employeeId,
            startDate: wg.monStr,
            endDate: wg.sunStr,
            status: "Draft",
            timesheetLines: wg.lines,
          };
          if (payrollCalendarId) tsBody.payrollCalendarID = payrollCalendarId;

          console.log(`[batch] CREATE timesheet for week ${wg.monStr}`);
          const postRes = await fetch(`${XERO_API_BASE}/Timesheets`, {
            method: "POST", headers: hdrs, body: JSON.stringify({ timesheet: tsBody }),
          });
          const postData = await postRes.json();
          if (!postRes.ok) {
            const err = extractError(postData);
            console.error("[batch] POST failed:", postRes.status, JSON.stringify(postData));
            results.push({ week: weekKey, ok: false, error: err ?? `POST failed (${postRes.status})` });
            continue;
          }
          timesheetId = postData.timesheet?.timesheetID ?? postData.Timesheet?.TimesheetID;
        }
        results.push({ week: weekKey, ok: true, timesheetId });
      }

      const allOk = results.every((r: any) => r.ok);
      const firstId = (results.find((r: any) => r.ok) as any)?.timesheetId;
      console.log(`[batch] done — ${results.filter((r:any)=>r.ok).length}/${results.length} weeks OK`);
      return new Response(JSON.stringify({
        ok: allOk,
        timesheetId: firstId,
        results,
        error: allOk ? undefined : results.filter((r:any) => !r.ok).map((r:any) => r.error).join("; "),
      }), { status: allOk ? 200 : 502, headers: cors });
    }

    // ── getEmployees ─────────────────────────────────────────────────────────
    if (action === "getEmployees") {
      const res  = await fetch(`${XERO_API_BASE}/Employees`, { headers: hdrs });
      const data = await res.json();
      const emps = data.employees ?? data.Employees ?? [];
      return new Response(JSON.stringify({ ok: true, employees: emps }), { headers: cors });
    }

    // ── getEarningsRates ─────────────────────────────────────────────────────
    if (action === "getEarningsRates") {
      const [r1, r2, r3] = await Promise.all([
        fetch(`${XERO_API_BASE}/EarningsRates`,      { headers: hdrs }),
        fetch(`${XERO_API_BASE}/LeaveTypes`,         { headers: hdrs }),
        fetch(`${XERO_API_BASE}/ReimbursementTypes`, { headers: hdrs }),
      ]);
      const [d1, d2, d3] = await Promise.all([r1.json(), r2.json(), r3.json()]);
      return new Response(JSON.stringify({
        ok:             true,
        earningsRates:  d1.earningsRates  ?? d1.EarningsRates      ?? [],
        leaveTypes:     d2.leaveTypes     ?? d2.LeaveTypes          ?? [],
        reimbursements: d3.reimbursements ?? d3.ReimbursementTypes  ?? [],
      }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: "Unknown action: " + action }), { status: 400, headers: cors });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
});
