import { useState, useEffect } from "react";
import { T } from "../constants.js";
import { fmtD, sendKTAEmail } from "../utils.js";
import { loadTable, upsertRow, updateRow, deleteRow, upsertEntry, upsertUser, sb } from "../supabaseClient.js";
import { Btn, Card, FL } from "../shared.jsx";

function XeroModule({allUsers, entries, currentUser, onUpdateEntries, showToast, onImportUser}) {
  const [tab, setTab]             = useState("pending");   // "setup"|"employees"|"pending"|"history"
  const [settings, setSettings]   = useState({});
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [saved, setSaved]         = useState(false);

  // Load Xero settings from Supabase on mount
  useEffect(()=>{
    sb.from("app_settings").select("value").eq("key","xero_settings").single()
      .then(({data})=>{ if(data?.value) setSettings(JSON.parse(data.value)); })
      .catch(()=>{})
      .finally(()=>setSettingsLoaded(true));
  },[]);
  const [empMap, setEmpMap]               = useState({}); // userId -> xeroEmployeeId (local edits)
  const [xeroEmployees, setXeroEmployees] = useState([]); // loaded from Xero
  const [xeroRates, setXeroRates]         = useState([]); // earnings rates loaded from Xero
  const [xeroLeaveTypes, setXeroLeaveTypes] = useState([]); // leave types loaded from Xero
  const [xeroReimbursements, setXeroReimbursements] = useState([]); // reimbursements (Tool Allowance etc)
  const [savingMap, setSavingMap] = useState({});
  const [submittingAll, setSubmittingAll] = useState(false);


  const apprentices = allUsers.filter(u=>u.role==="Apprentice").sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const approvedEntries = entries.filter(e=>e.approval==="approved")
    .sort((a,b)=>b.date.localeCompare(a.date));
  const pendingXero = approvedEntries.filter(e=>!e.xeroStatus||e.xeroStatus==="error");
  const submittedXero = approvedEntries.filter(e=>e.xeroStatus==="submitted");

  const ss = (k,v) => setSettings(s=>({...s,[k]:v}));
  const saveSettings = async () => {
    await sb.from("app_settings").upsert({key:"xero_settings", value: JSON.stringify(settings)}, {onConflict:"key"});
    setSaved(true); setTimeout(()=>setSaved(false), 2000);
  };

  const fD = (iso) => { if(!iso) return "—"; try{ const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }catch{ return iso; } };
  const xeroBlue = "#13b5ea";
  const xeroBlueDark = "#0d7bb5";

  const ENTRY_TYPE_NAMES = ["Normal Hours","Annual Leave","Sick Leave","Bereavement Leave","Leave Without Pay","Public Holiday","Overtime","Block Course","Other"];

  const TabBtn = ({id,label,count}) => (
    <button onClick={()=>setTab(id)} style={{
      padding:"8px 16px",borderRadius:8,fontSize:14,fontWeight:700,
      background: tab===id ? xeroBlue : T.bg,
      color: tab===id ? "#fff" : T.sub,
      border: tab===id ? `1.5px solid ${xeroBlueDark}` : `1.5px solid ${T.border}`,
      cursor:"pointer",fontFamily:"DM Sans,sans-serif",display:"flex",alignItems:"center",gap:6,
      transition:"all .14s"}}>
      {label}
      {count!==undefined&&<span style={{
        background: tab===id?"#ffffff33":T.border,
        color: tab===id?"#fff":T.sub,
        borderRadius:99,padding:"1px 7px",fontSize:12,fontWeight:700}}>{count}</span>}
    </button>
  );

  return (
    <div className="fu">
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:24,
        padding:"20px 24px",background:"#fff",borderRadius:14,border:`1.5px solid ${xeroBlue}33`,
        boxShadow:"0 2px 12px #13b5ea11"}}>
        <div style={{width:52,height:52,borderRadius:12,background:"#e6f7fd",
          display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:31,fontWeight:700,color:xeroBlue,fontFamily:"Georgia,serif",flexShrink:0}}>𝕏</div>
        <div>
          <div style={{fontFamily:"DM Sans",fontSize:22,fontWeight:700,color:T.ink}}>Xero Payroll Integration</div>
          <div style={{fontSize:14,color:T.sub,marginTop:2}}>
            Submit approved timesheets to Xero Payroll NZ · Admin Level 1 only
          </div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap"}}>
          <div style={{textAlign:"center",padding:"8px 16px",background:T.accentL,borderRadius:8}}>
            <div style={{fontSize:22,fontWeight:700,color:T.accent,fontFamily:"DM Sans"}}>{pendingXero.length}</div>
            <div style={{fontSize:12,color:T.sub,fontWeight:700}}>Awaiting Xero</div>
          </div>
          <div style={{textAlign:"center",padding:"8px 16px",background:"#e6f7fd",borderRadius:8}}>
            <div style={{fontSize:22,fontWeight:700,color:xeroBlue,fontFamily:"DM Sans"}}>{submittedXero.length}</div>
            <div style={{fontSize:12,color:T.sub,fontWeight:700}}>Submitted</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
        <TabBtn id="setup"     label="⚙ Setup & Auth"/>
        <TabBtn id="employees" label="👤 Employee Mapping" count={apprentices.filter(a=>!a.xeroEmployeeId).length||undefined}/>
        <TabBtn id="pending"   label="📤 Pending Xero Submission" count={pendingXero.length}/>
        <TabBtn id="history"   label="✓ Submission History"       count={submittedXero.length}/>
      </div>

      {/* ── Setup Tab ── */}
      {tab==="setup"&&(
        <div>
          {/* Custom connection status */}
          <div style={{background:T.tealL,border:`1.5px solid ${T.teal}55`,borderRadius:12,
            padding:"14px 18px",marginBottom:20,display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:22}}>✓</span>
            <div>
              <div style={{fontWeight:700,fontSize:14,color:T.teal}}>Xero Custom Connection</div>
              <div style={{fontSize:13,color:T.sub,marginTop:2}}>
                Using client credentials — no OAuth flow required. Save your Edge Function URL and Tenant ID below, then load earnings rates.
              </div>
            </div>
          </div>

          <Card style={{marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:17,marginBottom:16,color:T.ink}}>Connection Settings</div>
            <div style={{marginBottom:12}}>
              <FL>Supabase Edge Function URL</FL>
              <input value={settings.edgeFunctionUrl||""} onChange={e=>ss("edgeFunctionUrl",e.target.value)}
                placeholder="https://your-project.supabase.co/functions/v1/xero-proxy"/>
              <div style={{fontSize:12,color:T.muted,marginTop:3}}>The URL of your deployed xero-proxy Supabase Edge Function</div>
            </div>
            <div style={{marginBottom:16}}>
              <FL>Xero Tenant / Organisation ID</FL>
              <input value={settings.tenantId||""} onChange={e=>ss("tenantId",e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
              <div style={{fontSize:12,color:T.muted,marginTop:3}}>Found in Xero under My Xero → Connections, or via GET /connections</div>
            </div>

            <div style={{fontWeight:700,fontSize:16,marginBottom:12,marginTop:4,color:T.ink,borderTop:`1px solid ${T.border}`,paddingTop:16}}>
              Payroll Mapping
            </div>
            <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.6}}>
              Map each KTA entry type to a Xero <strong>Earnings Rate</strong> or <strong>Leave Type</strong>. Click Load to pull both from Xero.
            </div>
            <div style={{marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
              <Btn sm onClick={async()=>{
                if(!settings.edgeFunctionUrl||!settings.tenantId){
                  alert("Save your Edge Function URL and Tenant ID first."); return;
                }
                try{
                  const res  = await fetch(settings.edgeFunctionUrl,{
                    method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`},
                    body: JSON.stringify({action:"getEarningsRates",tenantId:settings.tenantId}),
                  });
                  const text = await res.text();
                  let data; try{ data=JSON.parse(text); }catch{ alert("Non-JSON response: "+text.slice(0,300)); return; }
                  if(data.ok){
                    setXeroRates(data.earningsRates||[]);
                    setXeroLeaveTypes(data.leaveTypes||[]);
                    setXeroReimbursements(data.reimbursements||[]);
                    showToast(`✓ Loaded ${(data.earningsRates||[]).length} rates · ${(data.leaveTypes||[]).length} leave types · ${(data.reimbursements||[]).length} reimbursements`);
                  } else { alert("Error: "+(data.error||JSON.stringify(data))); }
                }catch(e){ alert("Failed: "+e.message); }
              }}>🔄 Load from Xero</Btn>
              {(xeroRates.length>0||xeroLeaveTypes.length>0||xeroReimbursements.length>0)&&(
                <span style={{fontSize:13,color:T.teal,fontWeight:700}}>
                  ✓ {xeroRates.length} rates · {xeroLeaveTypes.length} leave · {xeroReimbursements.length} reimbursements
                </span>
              )}
            </div>
            {ENTRY_TYPE_NAMES.map(type=>{
              const val = settings.earningsRates?.[type]||"";
              const hasOptions = xeroRates.length>0||xeroLeaveTypes.length>0||xeroReimbursements.length>0;
              // Which group does this entry type naturally belong to?
              const isLeaveType = ["Annual Leave","Sick Leave","Bereavement Leave","Leave Without Pay"].includes(type);
              return (
                <div key={type} style={{display:"grid",gridTemplateColumns:"180px 1fr 28px",gap:8,alignItems:"center",marginBottom:6}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontSize:12,padding:"1px 6px",borderRadius:4,fontWeight:700,
                      background:isLeaveType?T.tealL:T.accentL,
                      color:isLeaveType?T.teal:T.accent}}>
                      {isLeaveType?"Leave":"Pay"}
                    </span>
                    <span style={{fontSize:14,fontWeight:700,color:T.ink}}>{type}</span>
                  </div>
                  {hasOptions ? (
                    <select value={val}
                      onChange={e=>ss("earningsRates",{...settings.earningsRates,[type]:e.target.value})}
                      style={{fontSize:13,padding:"5px 8px",border:`1px solid ${val?T.teal:T.border}`,borderRadius:6,background:"#fff",
                        color:val?T.ink:T.muted}}>
                      <option value="">— Not mapped —</option>
                      {xeroRates.length>0&&<optgroup label="── Earnings Rates ──">
                        {xeroRates.map(r=><option key={r.id} value={"rate:"+r.id}>{r.name}</option>)}
                      </optgroup>}
                      {xeroLeaveTypes.length>0&&<optgroup label="── Leave Types ──">
                        {xeroLeaveTypes.map(l=><option key={l.id} value={"leave:"+l.id}>{l.name}</option>)}
                      </optgroup>}
                      {xeroReimbursements.length>0&&<optgroup label="── Reimbursements ──">
                        {xeroReimbursements.map(r=><option key={r.id} value={"reimb:"+r.id}>{r.name}</option>)}
                      </optgroup>}
                    </select>
                  ) : (
                    <input value={val}
                      onChange={e=>ss("earningsRates",{...settings.earningsRates,[type]:e.target.value})}
                      placeholder="Load from Xero above, or paste ID manually"/>
                  )}
                  {val
                    ? <span style={{fontSize:16,color:T.teal}}>✓</span>
                    : <span style={{fontSize:16,color:T.muted}}>—</span>
                  }
                </div>
              );
            })}

            <div style={{marginTop:16,padding:"14px 16px",background:T.warnL,borderRadius:8,border:`1px solid ${T.warn}44`,marginBottom:12}}>
              <div style={{fontWeight:700,fontSize:14,color:T.warn,marginBottom:8}}>🔧 Tool Allowance Reimbursement</div>
              <div style={{fontSize:13,color:T.sub,marginBottom:10,lineHeight:1.5}}>Automatically submits Tool Allowance = (Normal Hours + Overtime) × /bin/zsh.50 per hour when you submit a timesheet to Xero. Paste the Xero Reimbursement ID for Tool Allowance below.</div>
              <div style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:8,alignItems:"center"}}>
                <span style={{fontSize:14,fontWeight:700,color:T.ink}}>Tool Allowance ID</span>
                {xeroReimbursements.length>0
                  ? <select value={settings.toolAllowanceReimbursementId||""} onChange={e=>ss("toolAllowanceReimbursementId",e.target.value)}
                      style={{fontSize:13,padding:"6px 8px",border:`1px solid ${settings.toolAllowanceReimbursementId?T.teal:T.border}`,borderRadius:6,background:"#fff",flex:1}}>
                      <option value="">— Select reimbursement type —</option>
                      {xeroReimbursements.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  : <input value={settings.toolAllowanceReimbursementId||""} onChange={e=>ss("toolAllowanceReimbursementId",e.target.value)} placeholder="Load from Xero above, or paste ID" style={{fontSize:13,padding:"6px 8px",border:`1px solid ${settings.toolAllowanceReimbursementId?T.teal:T.border}`,borderRadius:6,flex:1}}/>
                }
              </div>
              <div style={{fontSize:12,color:T.muted,marginTop:6}}>To find this: Xero → Payroll → Pay Items → Reimbursements → Tool Allowance → copy the ID from the URL</div>
            </div>
            <div style={{marginTop:4}}>
              {saved
                ? <div style={{display:"inline-flex",alignItems:"center",gap:6,color:T.teal,fontWeight:700,fontSize:14}}>✓ Settings saved</div>
                : <Btn onClick={saveSettings}>Save Settings</Btn>
              }
            </div>
          </Card>

          {/* Edge function download */}
          <Card>
            <div style={{fontWeight:700,fontSize:17,marginBottom:12,color:T.ink}}>📦 Supabase Edge Function</div>
            <div style={{fontSize:14,color:T.sub,marginBottom:12,lineHeight:1.6}}>
              Deploy this function to Supabase to act as your Xero API proxy. It securely holds your Xero OAuth token and handles token refresh.
            </div>
            <div style={{background:"#1a1a2e",borderRadius:10,padding:"14px 16px",fontFamily:"monospace",fontSize:12,color:"#e2e8f0",lineHeight:1.6,overflowX:"auto",marginBottom:12}}>
              <div style={{color:"#64748b",marginBottom:4}}>{`// supabase/functions/xero-proxy/index.ts`}</div>
              <div style={{color:"#94a3b8"}}>{`// Deploy with: supabase functions deploy xero-proxy`}</div>
              <div>{`// Set secrets: supabase secrets set XERO_CLIENT_ID=... XERO_CLIENT_SECRET=... XERO_REFRESH_TOKEN=...`}</div>
            </div>
            <Btn v="ghost" onClick={()=>{
              const code = `// KTA Xero Proxy — Supabase Edge Function
// Deploy: supabase functions deploy xero-proxy
// Secrets: XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REFRESH_TOKEN

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE  = "https://api.xero.com/payroll.xro/2.0";

async function getAccessToken() {
  const clientId     = Deno.env.get("XERO_CLIENT_ID")!;
  const clientSecret = Deno.env.get("XERO_CLIENT_SECRET")!;
  const refreshToken = Deno.env.get("XERO_REFRESH_TOKEN")!;
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: clientId, client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed: " + await res.text());
  const data = await res.json();
  return data.access_token as string;
}

serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const { action, tenantId, employeeId, date, earningsRateId, hours } = await req.json();
    const token = await getAccessToken();
    const headers = {
      Authorization: \`Bearer \${token}\`,
      "Xero-Tenant-Id": tenantId,
      "Content-Type": "application/json",
    };

    if (action === "createTimesheet") {
      // Determine pay period (week Mon-Sun)
      const d   = new Date(date + "T00:00:00");
      const day = d.getDay(); // 0=Sun
      const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const fmt = (dt: Date) => dt.toISOString().slice(0, 10);

      // Create or update timesheet
      const tsBody = {
        EmployeeID: employeeId,
        StartDate:  "/Date(" + mon.getTime() + ")/",
        EndDate:    "/Date(" + sun.getTime() + ")/",
        Status: "DRAFT",
        TimesheetLines: [{
          EarningsRateID: earningsRateId,
          NumberOfUnits: [
            0, // Sun (index 0)
            day === 1 ? hours : 0,
            day === 2 ? hours : 0,
            day === 3 ? hours : 0,
            day === 4 ? hours : 0,
            day === 5 ? hours : 0,
            day === 6 ? hours : 0, // Sat
          ],
        }],
      };

      const res = await fetch(\`\${XERO_API_BASE}/Timesheets\`, {
        method: "POST",
        headers,
        body: JSON.stringify({ Timesheets: [tsBody] }),
      });
      const data = await res.json();
      if (!res.ok) return new Response(JSON.stringify({ error: JSON.stringify(data) }), { status: 400, headers: cors });
      const timesheetId = data.Timesheets?.[0]?.TimesheetID;
      return new Response(JSON.stringify({ ok: true, timesheetId }), { headers: cors });
    }

    if (action === "getEmployees") {
      const res = await fetch(\`\${XERO_API_BASE}/Employees\`, { headers });
      const data = await res.json();
      return new Response(JSON.stringify({ ok: true, employees: data.Employees }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
});`;
              const blob = new Blob([code],{type:"text/typescript"});
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href=url; a.download="index.ts"; a.click();
            }}>⬇ Download Edge Function (index.ts)</Btn>
          </Card>
        </div>
      )}

      {/* ── Employees Tab ── */}
      {tab==="employees"&&(
        <Card>
          {!settings.edgeFunctionUrl&&(
            <div style={{background:T.warnL,border:`1px solid ${T.warn}44`,borderRadius:8,
              padding:"10px 14px",marginBottom:16,fontSize:13,color:T.warn}}>
              ⚠ Set up your Edge Function URL and Tenant ID in the <strong>Setup</strong> tab first.
            </div>
          )}

          {/* Load from Xero button */}
          <div style={{marginBottom:20,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <Btn sm onClick={async()=>{
              if(!settings.edgeFunctionUrl||!settings.tenantId){
                alert("Please set up your Edge Function URL and Tenant ID in the Setup tab first.");
                return;
              }
              try{
                const res  = await fetch(settings.edgeFunctionUrl,{
                  method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`},
                  body: JSON.stringify({action:"getEmployees",tenantId:settings.tenantId}),
                });
                const text = await res.text();
                let data; try{ data=JSON.parse(text); }catch{ alert("Non-JSON response: "+text.slice(0,300)); return; }
                if(data.ok && data.employees){
                  setXeroEmployees(data.employees);
                  showToast(`✓ Loaded ${data.employees.length} employees from Xero`);
                } else { alert("Error: " + (data.error||JSON.stringify(data))); }
              }catch(e){ alert("Failed: "+e.message); }
            }}>🔄 Load Employees from Xero</Btn>
            {xeroEmployees.length>0&&(
              <span style={{fontSize:13,color:T.teal,fontWeight:700}}>
                ✓ {xeroEmployees.length} Xero employees loaded
              </span>
            )}
          </div>

          {/* ── Section 1: Import / Merge Xero employees ── */}
          {(()=>{
            const existingXeroIds = apprentices.map(a=>a.xeroEmployeeId).filter(Boolean);
            const unlinked = xeroEmployees.filter(xe=>!existingXeroIds.includes(xe.employeeID||xe.EmployeeID));
            if(!xeroEmployees.length || !unlinked.length) return null;

            // For each unlinked Xero employee, check if an existing KTA user matches on email
            const withMatch = unlinked.map(xe => ({
              xe,
              match: allUsers.find(u =>
                xe.Email && u.email &&
                u.email.trim().toLowerCase() === xe.Email.trim().toLowerCase()
              ) || null,
            }));

            const mergeCount  = withMatch.filter(x=>x.match).length;
            const importCount = withMatch.filter(x=>!x.match).length;

            return (
              <div style={{marginBottom:24}}>
                <div style={{fontWeight:700,fontSize:16,marginBottom:4}}>⬇ Import / Merge from Xero</div>
                <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.6}}>
                  These Xero employees are not yet linked to KTA.
                  {mergeCount>0 && <> <span style={{color:T.teal,fontWeight:700}}>{mergeCount} email match{mergeCount>1?"es":""}</span> found — merging will link their Xero ID and fill any missing fields.</>}
                  {importCount>0 && <> <span style={{color:xeroBlue,fontWeight:700}}>{importCount} new</span> will be created as Apprentices.</>}
                </div>
                <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 110px",
                    padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                    fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:10}}>
                    <span>Xero Employee</span><span>Email</span><span>KTA Match</span><span></span>
                  </div>
                  {withMatch.map(({xe,match},i)=>(
                    <div key={xe.employeeID||xe.EmployeeID} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 110px",
                      padding:"10px 14px",gap:10,alignItems:"center",fontSize:14,
                      borderBottom:i<withMatch.length-1?`1px solid ${T.border}44`:"none",
                      background:match?`${T.tealL}55`:i%2===0?T.surface:T.bg}}>
                      <div style={{fontWeight:700}}>{xe.firstName||xe.FirstName} {xe.lastName||xe.LastName}</div>
                      <div style={{fontSize:12,color:T.sub,wordBreak:"break-all"}}>{xe.Email||<span style={{color:T.muted}}>—</span>}</div>
                      <div style={{fontSize:12}}>
                        {match
                          ? <span style={{color:T.teal,fontWeight:700,display:"flex",alignItems:"center",gap:4}}>
                              <span style={{width:6,height:6,borderRadius:"50%",background:T.teal,display:"inline-block"}}/>
                              {match.name}
                            </span>
                          : <span style={{color:T.muted}}>No match — new</span>
                        }
                      </div>
                      <button onClick={async()=>{
                        const phone = (xe.PhoneNumber && !xe.PhoneNumber.includes('@')) ? xe.PhoneNumber : "";
                        try {
                          if(match) {
                            // ── MERGE: link Xero ID + fill empty fields on existing user ──
                            const updates = { xero_employee_id: xe.employeeID||xe.EmployeeID };
                            if(!match.email    && xe.Email)                              updates.email    = xe.Email;
                            if(!match.phone    && phone)                                 updates.phone    = phone;
                            if(!match.trade    && xe.JobTitle)                           updates.trade    = xe.JobTitle;
                            if(!match.address  && (xe.AddressLine1||xe.Address1))        updates.address  = xe.AddressLine1||xe.Address1;
                            if(!match.addressLine2 && xe.AddressLine2)                   updates.address_line2 = xe.AddressLine2;
                            if(!match.suburb   && xe.Suburb)                             updates.suburb   = xe.Suburb;
                            if(!match.city     && xe.City)                               updates.city     = xe.City;
                            if(!match.postcode && xe.PostCode)                           updates.postcode = xe.PostCode;
                            if(!match.dateOfBirth && xe.DateOfBirth)                     updates.date_of_birth = xe.DateOfBirth.slice(0,10);
                            if(!match.gender   && xe.Gender)                             updates.gender   = xe.Gender;
                            if(!match.startDate && xe.StartDate)                         updates.start_date = xe.StartDate.slice(0,10);
                            await updateRow('users', match.id, updates);
                            onImportUser({...match, xeroEmployeeId: xe.employeeID||xe.EmployeeID, ...Object.fromEntries(
                              Object.entries(updates).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v])
                            )});
                            setXeroEmployees(prev=>prev.filter(e=>e.EmployeeID!==xe.employeeID||xe.EmployeeID));
                            showToast(`✓ Merged Xero data into ${match.name}`);
                          } else {
                            // ── IMPORT: create new Apprentice ──
                            const newId = uid();
                            const xeEmail = xe.Email||"";
                            const xePhone = (xe.PhoneNumber||"").includes('@') ? "" : (xe.PhoneNumber||"");
                            const xeFirst = xe.FirstName||"";
                            const xeLast  = xe.LastName||"";
                            const xeXid   = xe.EmployeeID;
                            const xeDob   = xe.DateOfBirth ? xe.DateOfBirth.slice(0,10) : "";
                            const newUser = {
                              id: newId, name: `${xeFirst} ${xeLast}`.trim(),
                              firstName: xeFirst, lastName: xeLast,
                              email: xeEmail, phone: xePhone,
                              trade: xe.JobTitle||"", hostBusiness: "",
                              address: xe.AddressLine1||"",
                              addressLine2: xe.AddressLine2||"",
                              suburb: xe.Suburb||"", city: xe.City||"",
                              postcode: xe.PostCode||"",
                              dateOfBirth: xeDob, gender: xe.Gender||"",
                              startDate: xe.StartDate ? xe.StartDate.slice(0,10) : "",
                              licenceExpiry:"", siteSafeExpiry:"", firstAidExpiry:"", xeroEmployeeId: xeXid,
                              role:"Apprentice", password:"changeme123", allocatedTo:[], adminLevel:1,
                            };
                            await upsertRow('users', {
                              id: newId, name: newUser.name,
                              first_name: xeFirst, last_name: xeLast,
                              email: xeEmail || null, phone: xePhone || null, role:"Apprentice",
                              password:"changeme123", allocated_to:[],
                              trade: xe.JobTitle||null, host_business: null,
                              address: xe.AddressLine1||null,
                              address_line2: xe.AddressLine2||null,
                              suburb: xe.Suburb||null, city: xe.City||null,
                              postcode: xe.PostCode||null,
                              date_of_birth: xeDob||null,
                              gender: xe.Gender||null,
                              start_date: xe.StartDate ? xe.StartDate.slice(0,10) : null,
                              licence_expiry: null, site_safe_expiry: null, first_aid_expiry: null,
                              xero_employee_id: xeXid, admin_level:1,
                            });
                            onImportUser(newUser);
                            setXeroEmployees(prev=>prev.filter(e=>e.EmployeeID!==xeXid));
                            showToast(`✓ ${xeFirst} ${xeLast} imported as Apprentice`);
                          }
                        } catch(e) { alert((match?"Merge":"Import")+" failed: "+e.message); }
                      }} style={{fontSize:13,padding:"5px 10px",borderRadius:6,fontWeight:700,
                        background: match ? T.teal : xeroBlue,
                        color:"#fff",
                        border:`1px solid ${match ? T.teal : xeroBlueDark}`,
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif",whiteSpace:"nowrap"}}>
                        {match ? "🔗 Merge" : "⬇ Import"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* ── Section 2b: Sync data for already-linked apprentices ── */}
          {(()=>{
            const linked = apprentices.filter(a=>a.xeroEmployeeId && xeroEmployees.length>0);
            if(!linked.length || !xeroEmployees.length) return null;

            // For each linked apprentice find their Xero record and compute missing fields
            const syncItems = linked.map(a => {
              const xe = xeroEmployees.find(e=>(e.EmployeeID||e.employeeID)===a.xeroEmployeeId);
              if(!xe) return null;
              const phone = (xe.PhoneNumber && !xe.PhoneNumber.includes('@')) ? xe.PhoneNumber : "";
              const missing = [];
              if(!a.email    && xe.Email)                                    missing.push({label:"Email",      field:"email",         dbField:"email",         value:xe.Email});
              if(!a.phone    && phone)                                        missing.push({label:"Phone",      field:"phone",         dbField:"phone",         value:phone});
              if(!a.trade    && xe.JobTitle)                                  missing.push({label:"Trade",      field:"trade",         dbField:"trade",         value:xe.JobTitle});
              if(!a.address  && (xe.AddressLine1||xe.Address1))              missing.push({label:"Address",    field:"address",       dbField:"address",       value:xe.AddressLine1||xe.Address1});
              if(!a.addressLine2 && xe.AddressLine2)                          missing.push({label:"Addr Line 2",field:"addressLine2",  dbField:"address_line2", value:xe.AddressLine2});
              if(!a.suburb   && xe.Suburb)                                    missing.push({label:"Suburb",     field:"suburb",        dbField:"suburb",        value:xe.Suburb});
              if(!a.city     && xe.City)                                      missing.push({label:"City",       field:"city",          dbField:"city",          value:xe.City});
              if(!a.postcode && xe.PostCode)                                  missing.push({label:"Postcode",   field:"postcode",      dbField:"postcode",      value:xe.PostCode});
              if(!a.dateOfBirth && xe.DateOfBirth)                            missing.push({label:"Date of Birth",field:"dateOfBirth",dbField:"date_of_birth", value:xe.DateOfBirth.slice(0,10)});
              if(!a.gender   && xe.Gender)                                    missing.push({label:"Gender",     field:"gender",        dbField:"gender",        value:xe.Gender});
              if(!a.startDate && xe.StartDate)                                missing.push({label:"Start Date", field:"startDate",     dbField:"start_date",    value:xe.StartDate.slice(0,10)});
              return missing.length ? {a, xe, missing} : null;
            }).filter(Boolean);

            if(!syncItems.length) return (
              <div style={{marginBottom:24,padding:"10px 14px",background:T.tealL,borderRadius:8,
                fontSize:13,color:T.teal,fontWeight:700}}>
                ✓ All linked apprentices are up to date with Xero data.
              </div>
            );

            return (
              <div style={{marginBottom:24}}>
                <div style={{fontWeight:700,fontSize:16,marginBottom:4}}>🔄 Xero Data Available to Fill</div>
                <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.6}}>
                  These linked apprentices have <strong>blank fields</strong> that Xero can fill in.
                  Existing KTA data is never overwritten — only blank fields are filled.
                </div>
                <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"160px 1fr 120px",
                    padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                    fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:10}}>
                    <span>Apprentice</span><span>Missing Fields Xero Can Fill</span><span></span>
                  </div>
                  {syncItems.map(({a,xe,missing},i)=>(
                    <div key={a.id} style={{display:"grid",gridTemplateColumns:"160px 1fr 120px",
                      padding:"10px 14px",gap:10,alignItems:"center",
                      borderBottom:i<syncItems.length-1?`1px solid ${T.border}44`:"none",
                      background:i%2===0?T.surface:T.bg}}>
                      <div style={{fontWeight:700,fontSize:14}}>{a.name}</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                        {missing.map(m=>(
                          <span key={m.field} style={{fontSize:12,background:T.accentL,color:T.accent,
                            borderRadius:5,padding:"2px 7px",fontWeight:700}}>
                            {m.label}: {m.value}
                          </span>
                        ))}
                      </div>
                      <button onClick={async()=>{
                        if(!await ktaConfirm(`Fill ${missing.length} missing field${missing.length>1?"s":""} for ${a.name} from Xero?`)) return;
                        const updates = {};
                        missing.forEach(m=>{ updates[m.dbField]=m.value; });
                        try {
                          await updateRow('users', a.id, updates);
                          // Update local state
                          const stateUpdates = {};
                          missing.forEach(m=>{ stateUpdates[m.field]=m.value; });
                          onImportUser({...a, ...stateUpdates});
                          showToast(`✓ Filled ${missing.length} fields for ${a.name}`);
                        } catch(e){ alert("Sync failed: "+e.message); }
                      }} style={{fontSize:13,padding:"6px 12px",borderRadius:7,fontWeight:700,
                        background:T.teal,color:"#fff",border:`1px solid ${T.teal}`,
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif",whiteSpace:"nowrap"}}>
                        ✓ Fill {missing.length} field{missing.length>1?"s":""}
                      </button>
                    </div>
                  ))}
                  {syncItems.length>1&&(
                    <div style={{padding:"10px 14px",background:T.bg,borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"flex-end"}}>
                      <button onClick={async()=>{
                        if(!await ktaConfirm(`Fill missing fields for ALL ${syncItems.length} apprentices from Xero?`)) return;
                        for(const {a,missing} of syncItems){
                          const updates = {};
                          missing.forEach(m=>{ updates[m.dbField]=m.value; });
                          await updateRow('users', a.id, updates).catch(()=>{});
                          const stateUpdates = {};
                          missing.forEach(m=>{ stateUpdates[m.field]=m.value; });
                          onImportUser({...a, ...stateUpdates});
                        }
                        showToast(`✓ Synced Xero data for ${syncItems.length} apprentices`);
                      }} style={{fontSize:13,padding:"6px 14px",borderRadius:7,fontWeight:700,
                        background:T.accent,color:"#fff",border:"none",
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                        ⬇ Fill All Missing Fields
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ── Section 2: Link existing KTA apprentices to Xero ── */}
          <div style={{fontWeight:700,fontSize:16,marginBottom:6}}>🔗 Link Existing Apprentices</div>
          <div style={{fontSize:13,color:T.sub,marginBottom:12}}>
            Match each KTA apprentice to their Xero payroll record.
          </div>
          <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 120px",
              padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
              fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:10}}>
              <span>KTA Apprentice</span><span>Xero Employee</span><span>Status</span>
            </div>
            {apprentices.map((a,i)=>(
              <div key={a.id} style={{display:"grid",gridTemplateColumns:"1fr 1fr 120px",
                padding:"10px 14px",gap:10,alignItems:"center",fontSize:14,
                borderBottom:i<apprentices.length-1?`1px solid ${T.border}44`:"none",
                background:i%2===0?T.surface:T.bg}}>
                <div>
                  <div style={{fontWeight:700}}>{a.name}</div>
                  <div style={{fontSize:12,color:T.sub}}>{a.trade||"No trade set"}</div>
                </div>
                {xeroEmployees.length > 0 ? (
                  <select
                    value={empMap[a.id]!==undefined ? empMap[a.id] : (a.xeroEmployeeId||"")}
                    onChange={e=>setEmpMap(m=>({...m,[a.id]:e.target.value}))}
                    style={{fontSize:13,padding:"5px 8px",border:`1px solid ${T.border}`,
                      borderRadius:6,width:"100%",boxSizing:"border-box",background:"#fff"}}>
                    <option value="">— Select Xero employee —</option>
                    {xeroEmployees.map(xe=>(
                      <option key={xe.employeeID||xe.EmployeeID} value={xe.employeeID||xe.EmployeeID}>
                        {xe.firstName||xe.FirstName} {xe.lastName||xe.LastName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={empMap[a.id]!==undefined ? empMap[a.id] : (a.xeroEmployeeId||"")}
                    onChange={e=>setEmpMap(m=>({...m,[a.id]:e.target.value}))}
                    placeholder="Click Load from Xero above, or paste ID manually"
                    style={{fontSize:13,padding:"5px 8px",border:`1px solid ${T.border}`,
                      borderRadius:6,fontFamily:"monospace",width:"100%",boxSizing:"border-box"}}
                  />
                )}
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  {savingMap[a.id]==="saved"
                    ? <span style={{fontSize:13,color:T.teal,fontWeight:700}}>✓ Saved</span>
                    : (
                      <button onClick={async()=>{
                        const newId = empMap[a.id];
                        if(newId===undefined) return;
                        setSavingMap(m=>({...m,[a.id]:"saving"}));
                        try {
                          await upsertRow('users',{...a,xero_employee_id:newId});
                          setSavingMap(m=>({...m,[a.id]:"saved"}));
                          setTimeout(()=>setSavingMap(m=>({...m,[a.id]:null})),2000);
                        } catch(e) { alert("Save failed: "+e.message); setSavingMap(m=>({...m,[a.id]:null})); }
                      }} disabled={empMap[a.id]===undefined||savingMap[a.id]==="saving"}
                        style={{fontSize:13,padding:"4px 10px",borderRadius:6,
                          background: empMap[a.id]!==undefined ? xeroBlue : T.bg,
                          color: empMap[a.id]!==undefined ? "#fff" : T.muted,
                          border:`1px solid ${empMap[a.id]!==undefined?xeroBlueDark:T.border}`,
                          cursor: empMap[a.id]!==undefined ? "pointer" : "default",
                          fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
                        {savingMap[a.id]==="saving"?"…":"Save"}
                      </button>
                    )
                  }
                  {a.xeroEmployeeId && !empMap[a.id]
                    ? <span style={{fontSize:12,color:T.teal}}>✓ Linked</span>
                    : !a.xeroEmployeeId && empMap[a.id]===undefined
                    ? <span style={{fontSize:12,color:T.warn}}>⚠ Not set</span>
                    : null
                  }
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Pending Tab ── */}
      {tab==="pending"&&(
        <div>
          {pendingXero.length===0
            ? <Card><div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontStyle:"italic"}}>
                No approved entries awaiting Xero submission
              </div></Card>
            : (
              <>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                  <div style={{fontSize:14,color:T.sub}}>{pendingXero.length} approved {pendingXero.length===1?"entry":"entries"} ready to submit</div>
                  <button
                    disabled={submittingAll || pendingXero.filter(e=>{
                      const a=allUsers.find(u=>u.id===e.userId);
                      return !!a?.xeroEmployeeId && !!(settings.earningsRates?.[e.type]) && settings.edgeFunctionUrl && settings.tenantId;
                    }).length===0}
                    onClick={async()=>{
                      setSubmittingAll(true);
                      const submittable = pendingXero.filter(e=>{
                        const a=allUsers.find(u=>u.id===e.userId);
                        return !!a?.xeroEmployeeId && !!(settings.earningsRates?.[e.type]) && settings.edgeFunctionUrl && settings.tenantId && e.xeroStatus!=="submitting";
                      });
                      for(const e of submittable) {
                        const app = allUsers.find(u=>u.id===e.userId);
                        onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"submitting"}:x));
                        const res = await submitEntryToXero(e, app, entries);
                        if(res.ok){
                          await updateRow("entries", e.id, { xero_status:"submitted", xero_timesheet_id:res.timesheetId||null }).catch(console.error);
                          onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"submitted",xeroTimesheetId:res.timesheetId}:x));
                        } else {
                          await updateRow("entries", e.id, { xero_status:"error" }).catch(console.error);
                          onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"error",xeroError:res.error}:x));
                        }
                      }
                      setSubmittingAll(false);
                    }}
                    style={{fontSize:14,fontWeight:700,padding:"8px 18px",borderRadius:8,
                      background: submittingAll?"#e6f7fd":xeroBlue,
                      color: submittingAll?xeroBlueDark:"#fff",
                      border:`1.5px solid ${xeroBlueDark}`,
                      cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                      display:"flex",alignItems:"center",gap:6,
                      opacity: submittingAll?0.7:1}}>
                    {submittingAll
                      ? <><span style={{fontSize:16}}>⏳</span> Submitting…</>
                      : <><span style={{fontSize:16}}>𝕏</span> Submit All</>
                    }
                  </button>
                </div>
                <Card style={{padding:0,overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 80px 90px",
                    padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                    fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
                    <span>Date</span><span>Apprentice</span><span style={{textAlign:"center"}}>Hours</span>
                    <span>Type</span><span>Status</span><span style={{textAlign:"right"}}>Action</span>
                  </div>
                  {pendingXero.map((e,i)=>{
                    const app = allUsers.find(u=>u.id===e.userId);
                    const tm = TYPE_META[e.type]||TYPE_META["Normal Hours"];
                    const hasXeroId = !!app?.xeroEmployeeId;
                    const hasRate   = !!(settings.earningsRates?.[e.type]);
                    const canSubmit = hasXeroId && hasRate && settings.edgeFunctionUrl && settings.tenantId;
                    return (
                      <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 80px 90px",
                        padding:"10px 14px",gap:8,alignItems:"center",fontSize:14,
                        borderBottom:i<pendingXero.length-1?`1px solid ${T.border}44`:"none",
                        background:i%2===0?T.surface:T.bg}}>
                        <div style={{fontWeight:700,fontSize:13}}>{fD(e.date)}</div>
                        <div>
                          <div style={{fontWeight:700,fontSize:14}}>{app?.name||"Unknown"}</div>
                          {!hasXeroId&&<div style={{fontSize:12,color:T.warn}}>⚠ No Xero ID</div>}
                          {!hasRate&&<div style={{fontSize:12,color:T.warn}}>⚠ Rate not mapped</div>}
                        </div>
                        <div style={{textAlign:"center",fontWeight:700,color:T.accent,fontFamily:"DM Sans"}}>{e.netHours}h</div>
                        <Pill label={e.type} size="sm" color={tm.color} bg={tm.bg}/>
                        <div>
                          {e.xeroStatus==="submitting"
                            ? <span style={{fontSize:12,color:T.muted}}>Sending…</span>
                            : e.xeroStatus==="error"
                            ? <span style={{fontSize:12,color:T.red}} title={e.xeroError}>✕ Error</span>
                            : <span style={{fontSize:12,color:T.muted}}>Pending</span>
                          }
                        </div>
                        <div style={{display:"flex",justifyContent:"flex-end"}}>
                          <button disabled={!canSubmit||e.xeroStatus==="submitting"}
                            onClick={async()=>{
                              if(!canSubmit) return;
                              onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"submitting"}:x));
                              const res = await submitEntryToXero(e, app, entries);
                              if(res.ok){
                                await updateRow("entries", e.id, { xero_status: "submitted", xero_timesheet_id: res.timesheetId||null }).catch(console.error);
                                onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"submitted",xeroTimesheetId:res.timesheetId}:x));
                              } else {
                                await updateRow("entries", e.id, { xero_status: "error" }).catch(console.error);
                                onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"error",xeroError:res.error}:x));
                              }
                            }}
                            style={{fontSize:13,fontWeight:700,padding:"4px 12px",borderRadius:7,
                              background: canSubmit?"#e6f7fd":T.bg,
                              color: canSubmit?xeroBlueDark:T.muted,
                              border:`1.5px solid ${canSubmit?xeroBlue:T.border}`,
                              cursor: canSubmit?"pointer":"not-allowed",
                              fontFamily:"DM Sans,sans-serif"}}>
                            𝕏 Submit
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </Card>
              </>
            )
          }
        </div>
      )}

      {/* ── History Tab ── */}
      {tab==="history"&&(
        <Card style={{padding:0,overflow:"hidden"}}>
          {submittedXero.length===0
            ? <div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontStyle:"italic"}}>No entries submitted to Xero yet</div>
            : <>
                <div style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 1fr",
                  padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                  fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
                  <span>Date</span><span>Apprentice</span><span style={{textAlign:"center"}}>Hours</span>
                  <span>Type</span><span>Xero Timesheet ID</span>
                </div>
                {submittedXero.map((e,i)=>{
                  const app = allUsers.find(u=>u.id===e.userId);
                  const tm = TYPE_META[e.type]||TYPE_META["Normal Hours"];
                  return (
                    <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 1fr",
                      padding:"10px 14px",gap:8,alignItems:"center",fontSize:14,
                      borderBottom:i<submittedXero.length-1?`1px solid ${T.border}44`:"none",
                      background:i%2===0?T.surface:T.bg}}>
                      <div style={{fontWeight:700,fontSize:13}}>{fD(e.date)}</div>
                      <div style={{fontWeight:700}}>{app?.name||"Unknown"}</div>
                      <div style={{textAlign:"center",fontWeight:700,color:T.accent,fontFamily:"DM Sans"}}>{e.netHours}h</div>
                      <Pill label={e.type} size="sm" color={tm.color} bg={tm.bg}/>
                      <div style={{fontSize:12,color:xeroBlue,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {e.xeroTimesheetId||"—"}
                      </div>
                    </div>
                  );
                })}
              </>
          }
        </Card>
      )}
    </div>
  );
}


// =============================================================================
// EMAIL ACTIVITY TRACKING — Microsoft 365 / Graph API via Supabase Edge Function
// =============================================================================
//
// Architecture:
//   Browser → Supabase Edge Function (holds M365 OAuth token) → Microsoft Graph API
//   Activity notes are stored in Supabase `activity_notes` table.
//   Timeline merges: emails (live from M365) + pinned emails + manual notes + meeting reports
//
// Edge Function env vars: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REFRESH_TOKEN, MS_TENANT_ID
// Deploy: supabase functions deploy email-proxy

const EMAIL_PROXY_KEY = "kta_email_proxy_url";
const getEmailProxyUrl = () => { try{ return localStorage.getItem(EMAIL_PROXY_KEY)||""; }catch{ return ""; } };

// Call the M365 edge function proxy
const callEmailProxy = async (payload) => {
  const url = getEmailProxyUrl();
  if(!url) return { ok:false, error:"Email proxy not configured. Set up in Settings." };
  try {
    const res = await fetch(url, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if(!res.ok) return { ok:false, error: data.error||`HTTP ${res.status}` };
    return { ok:true, ...data };
  } catch(e) { return { ok:false, error: e.message }; }
};

// Search emails for a specific email address (inbound + outbound)
const fetchEmailsForPerson = async (emailAddress, maxResults=30) => {
  if(!emailAddress) return { ok:false, emails:[], error:"No email address" };
  return callEmailProxy({ action:"searchByAddress", emailAddress, maxResults });
};

// Fetch all recent org emails for the global inbox view
const fetchOrgInbox = async (folder="inbox", maxResults=50) => {
  return callEmailProxy({ action:"listFolder", folder, maxResults });
};

// ── Stable sub-components (defined outside to preserve focus) ────────────────

export default XeroModule;
