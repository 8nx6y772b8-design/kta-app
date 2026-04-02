// KTA Xero Proxy — Supabase Edge Function v8
// Deploy: supabase functions deploy xero-proxy
// Secrets needed: XERO_CLIENT_ID, XERO_CLIENT_SECRET
// Uses Xero NZ Payroll v2 API — POST/PUT/DELETE per-line endpoints

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

// Extract human-readable error from Xero response
function extractError(data: any): string | null {
  // NZ Payroll v2 problem format
  if (data?.problem) {
    const p = data.problem;
    const fields = (p.invalidFields ?? []).map((f: any) => `${f.name}: ${f.reason}`).join("; ");
    return fields || p.detail || p.title || null;
  }
  // Legacy format
  if (data?.detail) return data.detail;
  if (data?.title) return data.title;
  const ts = data?.timesheets?.[0] ?? data?.Timesheets?.[0];
  if (!ts) return null;
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

    // ── Shared helpers ───────────────────────────────────────────────────────

    // Calculate Mon-Sun week boundaries for a given date
    function getWeekBounds(dateStr: string) {
      const d   = parseUTCDate(dateStr);
      const day = d.getUTCDay(); // 0=Sun…6=Sat
      const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
      const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
      return { monStr: mon.toISOString().slice(0, 10), sunStr: sun.toISOString().slice(0, 10) };
    }

    // Search for timesheets around a date range, return the best match
    async function findTimesheetForDates(empId: string, monStr: string, sunStr: string, targetDates: string[]) {
      const searchStart = new Date(parseUTCDate(monStr)); searchStart.setUTCDate(searchStart.getUTCDate() - 7);
      const searchEnd   = new Date(parseUTCDate(sunStr)); searchEnd.setUTCDate(searchEnd.getUTCDate() + 7);
      const filter = `employeeId==${empId}`;
      const url = `${XERO_API_BASE}/Timesheets?filter=${encodeURIComponent(filter)}&startDate=${searchStart.toISOString().slice(0,10)}&endDate=${searchEnd.toISOString().slice(0,10)}`;
      console.log(`[search] GET ${url}`);
      const res = await fetch(url, { headers: hdrs });
      const data = await res.json();
      if (!res.ok) { console.error("[search] failed:", res.status); return null; }
      const tsList = data.timesheets ?? data.Timesheets ?? [];
      console.log(`[search] found ${tsList.length} timesheets`);
      for (const ts of tsList) {
        const s  = (ts.startDate ?? ts.StartDate ?? "");
        const e  = (ts.endDate   ?? ts.EndDate   ?? "");
        const id = ts.timesheetID ?? ts.TimesheetID;
        const st = ts.status ?? ts.Status;
        console.log(`[search]   ts ${id} period=${s}..${e} status=${st}`);
      }
      // Exact match: find timesheet whose period covers any of our target dates
      for (const ts of tsList) {
        const tsStart = (ts.startDate ?? ts.StartDate ?? "").slice(0, 10);
        const tsEnd   = (ts.endDate   ?? ts.EndDate   ?? "").slice(0, 10);
        for (const td of targetDates) {
          if (td >= tsStart && td <= tsEnd) {
            console.log(`[search] exact match: ${ts.timesheetID ?? ts.TimesheetID} covers ${td}`);
            return ts;
          }
        }
      }
      // Fallback: use any Draft timesheet
      if (tsList.length > 0) {
        const draft = tsList.find((ts: any) => (ts.status ?? ts.Status) === "Draft");
        if (draft) {
          console.log(`[search] no exact match — using Draft ${draft.timesheetID ?? draft.TimesheetID} as fallback`);
          return draft;
        }
      }
      return null;
    }

    // POST /Timesheets to create an empty timesheet (Xero NZ v2: body is raw object, no wrapper)
    async function createEmptyTimesheet(empId: string, calId: string | null, startDate: string, endDate: string) {
      const postBody: Record<string, unknown> = {
        payrollCalendarID: calId,
        employeeID: empId,
        startDate,
        endDate,
      };
      console.log(`[create] POST /Timesheets: ${JSON.stringify(postBody)}`);
      const res = await fetch(`${XERO_API_BASE}/Timesheets`, {
        method: "POST", headers: hdrs, body: JSON.stringify(postBody),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`[create] POST failed (${res.status}):`, JSON.stringify(data));
        return { ok: false as const, status: res.status, error: extractError(data) ?? JSON.stringify(data) };
      }
      const tsId = data.timesheet?.timesheetID ?? data.Timesheet?.TimesheetID;
      console.log(`[create] created timesheet ${tsId}`);
      return { ok: true as const, timesheetId: tsId };
    }

    // POST /Timesheets/{id}/lines to add a single line
    async function addTimesheetLine(tsId: string, line: Record<string, unknown>) {
      const lineBody: Record<string, unknown> = {
        date:           line.date,
        earningsRateID: line.earningsRateID,
        numberOfUnits:  line.numberOfUnits,
      };
      // If it's a leave type instead
      if (line.leaveTypeID) {
        delete lineBody.earningsRateID;
        (lineBody as any).leaveTypeID = line.leaveTypeID;
      }
      const res = await fetch(`${XERO_API_BASE}/Timesheets/${tsId}/lines`, {
        method: "POST", headers: hdrs, body: JSON.stringify(lineBody),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`[addLine] POST failed (${res.status}):`, JSON.stringify(data));
        return { ok: false, error: extractError(data) ?? `Add line failed (${res.status})` };
      }
      const lineId = data.timesheetLine?.timesheetLineID ?? data.TimesheetLine?.TimesheetLineID;
      return { ok: true, lineId };
    }

    // DELETE /Timesheets/{tsId}/lines/{lineId}
    async function deleteTimesheetLine(tsId: string, lineId: string) {
      const res = await fetch(`${XERO_API_BASE}/Timesheets/${tsId}/lines/${lineId}`, {
        method: "DELETE", headers: hdrs,
      });
      if (!res.ok) console.error(`[deleteLine] DELETE failed (${res.status})`);
      return res.ok;
    }

    // Add lines to a timesheet, deleting conflicting existing lines first
    async function upsertLines(tsId: string, newLines: Record<string, unknown>[]) {
      // GET full timesheet to see existing lines
      const getRes = await fetch(`${XERO_API_BASE}/Timesheets/${tsId}`, { headers: hdrs });
      const getData = await getRes.json();
      if (!getRes.ok) {
        console.error(`[upsertLines] GET failed (${getRes.status})`);
        return { ok: false, error: `GET timesheet failed (${getRes.status})` };
      }
      const fullTs = getData.timesheet ?? getData.Timesheet ?? getData;
      const existingLines: any[] = fullTs.timesheetLines ?? fullTs.TimesheetLines ?? [];
      console.log(`[upsertLines] timesheet ${tsId} has ${existingLines.length} existing lines`);

      // Build set of date+rate keys we're adding
      const newKeys = new Set(newLines.map((l: any) => {
        const d = String(l.date).slice(0, 10);
        const r = l.earningsRateID || l.leaveTypeID || "";
        return `${d}|${r}`;
      }));

      // Delete conflicting existing lines (same date + same rate)
      for (const el of existingLines) {
        const elDate = (el.date ?? el.Date ?? "").slice(0, 10);
        const elRate = el.earningsRateID ?? el.EarningsRateID ?? el.leaveTypeID ?? el.LeaveTypeID ?? "";
        const elId   = el.timesheetLineID ?? el.TimesheetLineID;
        if (newKeys.has(`${elDate}|${elRate}`) && elId) {
          console.log(`[upsertLines] deleting conflicting line ${elId} (${elDate} ${elRate})`);
          await deleteTimesheetLine(tsId, elId);
        }
      }

      // Add new lines
      const errors: string[] = [];
      for (const line of newLines) {
        const result = await addTimesheetLine(tsId, line);
        if (!result.ok) errors.push(result.error ?? "unknown");
        else console.log(`[upsertLines] added line ${result.lineId}`);
      }
      if (errors.length > 0) return { ok: false, error: errors.join("; ") };
      return { ok: true };
    }

    // ── upsertTimesheet ──────────────────────────────────────────────────────
    if (action === "upsertTimesheet") {
      const { lines, toolAllowanceId, toolAllowanceHours } = body;

      const { monStr, sunStr } = getWeekBounds(date);
      console.log(`[upsert] employee=${employeeId} date=${date} week=${monStr}..${sunStr}`);

      // Build timesheet lines
      const tsLines: Record<string, unknown>[] = [];
      for (const l of (lines || [])) {
        if (!l.hours || l.hours <= 0) continue;
        if (l.earningsRateId) {
          tsLines.push({ earningsRateID: l.earningsRateId, date, numberOfUnits: l.hours });
        } else if (l.leaveTypeId) {
          tsLines.push({ leaveTypeID: l.leaveTypeId, date, numberOfUnits: l.hours });
        }
      }
      // toolAllowanceId is a Reimbursement Type — not valid in timesheet lines
      if (toolAllowanceId && toolAllowanceHours > 0) {
        console.log(`[upsert] skipping toolAllowance reimbursement ${toolAllowanceId} (${toolAllowanceHours}h)`);
      }
      console.log(`[upsert] ${tsLines.length} lines to submit`);

      if (tsLines.length === 0) {
        return new Response(JSON.stringify({ error: "No valid lines to submit" }), { status: 400, headers: cors });
      }

      // Step 1: Get employee's payroll calendar
      const empRes  = await fetch(`${XERO_API_BASE}/Employees/${employeeId}`, { headers: hdrs });
      const empData = await empRes.json();
      if (!empRes.ok) {
        const fwdStatus = empRes.status >= 500 ? 502 : 400;
        return new Response(JSON.stringify({ error: `Employee lookup failed (${empRes.status})`, step: "employee-lookup" }), { status: fwdStatus, headers: cors });
      }
      const payrollCalendarId = empData.employee?.payrollCalendarID
                             ?? empData.Employee?.PayrollCalendarID ?? null;
      console.log(`[step1] payrollCalendarId=${payrollCalendarId}`);

      // Step 2: Find existing timesheet
      let existing = await findTimesheetForDates(employeeId, monStr, sunStr, [date]);
      let timesheetId: string;

      if (existing) {
        timesheetId = existing.timesheetID ?? existing.TimesheetID;
        const existStatus = existing.status ?? existing.Status;
        console.log(`[step3] EXISTING timesheet ${timesheetId} status=${existStatus}`);
      } else {
        // Step 3a: Create empty timesheet
        console.log(`[step3] No existing timesheet — creating new for ${monStr}..${sunStr}`);
        const createResult = await createEmptyTimesheet(employeeId, payrollCalendarId, monStr, sunStr);
        if (!createResult.ok) {
          const fwdStatus = createResult.status >= 500 ? 502 : 400;
          return new Response(JSON.stringify({ error: createResult.error, xeroStatus: createResult.status, step: "create-timesheet" }), { status: fwdStatus, headers: cors });
        }
        timesheetId = createResult.timesheetId;
      }

      // Step 4: Add lines (delete conflicting ones first)
      const lineResult = await upsertLines(timesheetId, tsLines);
      if (!lineResult.ok) {
        return new Response(JSON.stringify({ error: lineResult.error, step: "add-lines" }), { status: 400, headers: cors });
      }

      return new Response(JSON.stringify({ ok: true, timesheetId }), { headers: cors });
    }

    // ── upsertTimesheetBatch — multiple days for one employee in one call ────
    if (action === "upsertTimesheetBatch") {
      const { entries: batchEntries } = body;
      if (!Array.isArray(batchEntries) || batchEntries.length === 0) {
        return new Response(JSON.stringify({ error: "No entries in batch" }), { status: 400, headers: cors });
      }
      console.log(`[batch] employee=${employeeId} entries=${batchEntries.length}`);

      // Build all timesheet lines from all entries
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
          console.log(`[batch] skipping toolAllowance reimbursement ${be.toolAllowanceId}`);
        }
      }
      console.log(`[batch] total lines: ${allTsLines.length}`);

      if (allTsLines.length === 0) {
        return new Response(JSON.stringify({ error: "No valid lines in batch" }), { status: 400, headers: cors });
      }

      // Group lines by week (Mon-Sun)
      const weekGroups: Record<string, { monStr: string; sunStr: string; lines: Record<string, unknown>[] }> = {};
      for (const line of allTsLines) {
        const { monStr, sunStr } = getWeekBounds(String(line.date));
        if (!weekGroups[monStr]) weekGroups[monStr] = { monStr, sunStr, lines: [] };
        weekGroups[monStr].lines.push(line);
      }

      // Get employee payroll calendar
      const empRes = await fetch(`${XERO_API_BASE}/Employees/${employeeId}`, { headers: hdrs });
      const empData = await empRes.json();
      if (!empRes.ok) {
        const fwdStatus = empRes.status >= 500 ? 502 : 400;
        return new Response(JSON.stringify({ error: `Employee lookup failed (${empRes.status})` }), { status: fwdStatus, headers: cors });
      }
      const payrollCalendarId = empData.employee?.payrollCalendarID ?? empData.Employee?.PayrollCalendarID ?? null;

      const results: Record<string, unknown>[] = [];

      for (const [weekKey, wg] of Object.entries(weekGroups)) {
        console.log(`[batch] week ${wg.monStr}..${wg.sunStr} — ${wg.lines.length} lines`);

        const targetDates = [...new Set(wg.lines.map((l: any) => String(l.date).slice(0, 10)))];
        let existing = await findTimesheetForDates(employeeId, wg.monStr, wg.sunStr, targetDates);
        let timesheetId: string | undefined;

        if (existing) {
          timesheetId = existing.timesheetID ?? existing.TimesheetID;
          console.log(`[batch] using existing timesheet ${timesheetId}`);
        } else {
          // Create empty timesheet
          console.log(`[batch] creating new timesheet for ${wg.monStr}..${wg.sunStr}`);
          const createResult = await createEmptyTimesheet(employeeId, payrollCalendarId, wg.monStr, wg.sunStr);
          if (!createResult.ok) {
            results.push({ week: weekKey, ok: false, error: createResult.error });
            continue;
          }
          timesheetId = createResult.timesheetId;
        }

        // Add lines
        const lineResult = await upsertLines(timesheetId!, wg.lines);
        if (!lineResult.ok) {
          results.push({ week: weekKey, ok: false, error: lineResult.error });
          continue;
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
      // Filter out terminated employees — only return active staff
      const active = emps.filter((e: any) => (e.Status || e.status || "").toUpperCase() !== "TERMINATED");
      return new Response(JSON.stringify({ ok: true, employees: active }), { headers: cors });
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
