import { useState } from "react";
import { T, APPROVAL_META, TYPE_META, ENTRY_TYPES } from "../constants.js";
import { fmtD, daysAgoStr } from "../utils.js";
import { upsertEntry } from "../supabaseClient.js";
import { Pill, Btn, Card } from "../shared.jsx";

function WeeklyHoursList({allUsers, entries}) {
  const {sortFn:whlSort, ColHeader:WHLCol} = useSort("name","asc");
  const ws = ()=>{ const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };
  const wsDate = ws();
  const apprentices = [...allUsers.filter(u=>u.role==="Apprentice")].sort(whlSort);
  const weekEntries = entries.filter(e=>e.date>=wsDate);

  // Total hours by type across all apprentices this week
  const globalTypeHrs = ENTRY_TYPES.map(t=>({
    type:t,
    hrs:weekEntries.reduce((a,e)=>e.type===t?a+e.netHours:a,0)
  })).filter(x=>x.hrs>0);
  const globalTotal = weekEntries.reduce((a,e)=>a+e.netHours,0).toFixed(1);

  return (
    <div className="fu">
      <div style={{marginBottom:18}}>
        <div style={{fontFamily:"DM Sans",fontSize:19,fontWeight:700}}>Hours This Week</div>
        <div style={{fontSize:13,color:T.sub,marginTop:3}}>All timesheet entries from this week, grouped by apprentice.</div>
      </div>

      {/* Global type summary bar */}
      {weekEntries.length>0 && (
        <Card style={{marginBottom:20,padding:"16px 20px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div style={{fontSize:14,fontWeight:700}}>All Apprentices — Week Total</div>
            <div style={{fontFamily:"'Libre Baskerville'",fontSize:25,fontWeight:700,color:T.accent}}>{globalTotal}h</div>
          </div>
          {/* Type breakdown pills */}
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:12}}>
            {globalTypeHrs.map(({type,hrs})=>{
              const m = TYPE_META[type]||TYPE_META["Other"];
              return (
                <div key={type} style={{display:"flex",alignItems:"center",gap:6,
                  background:m.bg,border:`1px solid ${m.color}44`,
                  borderRadius:8,padding:"5px 10px"}}>
                  <span style={{fontSize:14}}>{m.sym}</span>
                  <span style={{fontSize:13,color:m.color,fontWeight:700}}>{type}</span>
                  <span style={{fontSize:14,fontWeight:700,color:m.color,fontFamily:"DM Sans"}}>{hrs.toFixed(1)}h</span>
                </div>
              );
            })}
          </div>
          {/* Stacked bar */}
          <div style={{display:"flex",height:8,borderRadius:4,overflow:"hidden",gap:1}}>
            {globalTypeHrs.map(({type,hrs})=>{
              const m = TYPE_META[type]||TYPE_META["Other"];
              const pct = (hrs/parseFloat(globalTotal))*100;
              return <div key={type} style={{width:`${pct}%`,background:m.color,transition:"width .3s"}} title={`${type}: ${hrs.toFixed(1)}h`}/>;
            })}
          </div>
        </Card>
      )}

      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
        <WHLCol field="name" style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px"}}>Sorted by Name</WHLCol>
      </div>
      {apprentices.length===0 && <Card><div style={{color:T.muted,textAlign:"center",padding:24}}>No apprentices found.</div></Card>}
      {apprentices.map(app=>{
        const appEntries = weekEntries.filter(e=>e.userId===app.id).sort((a,b)=>b.date.localeCompare(a.date));
        const totalHrs = appEntries.reduce((a,e)=>a+e.netHours,0);
        // Per-apprentice type breakdown
        const typeHrs = ENTRY_TYPES.map(t=>({
          type:t,
          hrs:appEntries.reduce((a,e)=>e.type===t?a+e.netHours:a,0)
        })).filter(x=>x.hrs>0);

        return (
          <Card key={app.id} style={{marginBottom:14}}>
            {/* Header row */}
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:appEntries.length>0?12:0}}>
              <Avatar name={app.name} role="Apprentice" size={36}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:16}}>{app.name}</div>
                <div style={{fontSize:13,color:T.sub}}>{appEntries.length} entr{appEntries.length===1?"y":"ies"} this week</div>
              </div>
              <div style={{fontFamily:"'Libre Baskerville'",fontSize:25,fontWeight:700,color:T.accent}}>{totalHrs.toFixed(1)}h</div>
            </div>

            {appEntries.length===0 && <div style={{fontSize:13,color:T.muted,fontStyle:"italic"}}>No entries this week.</div>}

            {appEntries.length>0 && (<>
              {/* Type breakdown pills for this apprentice */}
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
                {typeHrs.map(({type,hrs})=>{
                  const m = TYPE_META[type]||TYPE_META["Other"];
                  return (
                    <div key={type} style={{display:"flex",alignItems:"center",gap:5,
                      background:m.bg,border:`1px solid ${m.color}33`,
                      borderRadius:6,padding:"3px 8px"}}>
                      <span style={{fontSize:12}}>{m.sym}</span>
                      <span style={{fontSize:12,color:m.color,fontWeight:700}}>{type}</span>
                      <span style={{fontSize:13,fontWeight:700,color:m.color}}>{hrs.toFixed(1)}h</span>
                    </div>
                  );
                })}
              </div>
              {/* Mini stacked bar */}
              {totalHrs>0 && (
                <div style={{display:"flex",height:5,borderRadius:3,overflow:"hidden",gap:1,marginBottom:10}}>
                  {typeHrs.map(({type,hrs})=>{
                    const m = TYPE_META[type]||TYPE_META["Other"];
                    return <div key={type} style={{width:`${(hrs/totalHrs)*100}%`,background:m.color}} title={`${type}: ${hrs.toFixed(1)}h`}/>;
                  })}
                </div>
              )}
              {/* Entry rows */}
              <div style={{borderTop:`1px solid ${T.border}`,paddingTop:10}}>
                {appEntries.map((e,i)=>(
                  <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 120px 60px 90px",
                    gap:8,padding:"7px 4px",borderBottom:i<appEntries.length-1?`1px solid ${T.border}44`:"none",
                    alignItems:"center",fontSize:13}}>
                    <div style={{fontWeight:700}}>{fmtD(e.date)}</div>
                    <div style={{color:e.note?T.ink:T.muted,fontStyle:e.note?"normal":"italic",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note||"No note"}</div>
                    <TypePill type={e.type} size="sm"/>
                    <div style={{fontWeight:700,color:TYPE_META[e.type]?.color||T.accent,textAlign:"center"}}>{e.netHours}h</div>
                    <AppvPill status={e.approval}/>
                  </div>
                ))}
              </div>
            </>)}
          </Card>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING / APPROVED ENTRIES LIST  — grouped by apprentice A-Z
// ─────────────────────────────────────────────────────────────────────────────
function ApprovalList({allUsers, entries, status, onApprove, onDecline}) {
  const {sortFn:aplSort, ColHeader:APLCol} = useSort("name","asc");
  const apprentices = [...allUsers.filter(u=>u.role==="Apprentice")].sort(aplSort);
  const filtered = entries.filter(e=>e.approval===status);
  const isPending = status==="submitted";

  return (
    <div className="fu">
      <div style={{marginBottom:18}}>
        <div style={{fontFamily:"DM Sans",fontSize:19,fontWeight:700}}>
          {status==="submitted"?"Pending":status==="approved"?"Submitted — Approved":"Submitted — Not Approved"}
        </div>
        <div style={{fontSize:13,color:T.sub,marginTop:3}}>
          {filtered.length} entr{filtered.length===1?"y":"ies"} — grouped by apprentice A–Z.
        </div>
      </div>
      {filtered.length===0 && (
        <Card style={{textAlign:"center",padding:"48px 24px"}}>
          <div style={{fontSize:35,marginBottom:8}}>{isPending?"✓":"◈"}</div>
          <div style={{fontWeight:700,fontSize:17}}>{status==="submitted"?"All caught up!":status==="approved"?"No approved entries yet.":"No declined entries."}</div>
          <div style={{fontSize:13,color:T.sub,marginTop:6}}>{status==="submitted"?"No timesheets are waiting for approval.":""}</div>
        </Card>
      )}
      {apprentices.map(app=>{
        const appEntries = filtered.filter(e=>e.userId===app.id).sort((a,b)=>b.date.localeCompare(a.date));
        if(appEntries.length===0) return null;
        return (
          <Card key={app.id} style={{marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
              <Avatar name={app.name} role="Apprentice" size={36}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:16}}>{app.name}</div>
                <div style={{fontSize:13,color:T.sub}}>{appEntries.length} {status} entr{appEntries.length===1?"y":"ies"}</div>
              </div>
            </div>
            <div style={{borderTop:`1px solid ${T.border}`,paddingTop:10}}>
              {appEntries.map((e,i)=>(
                <div key={e.id} style={{display:"grid",
                  gridTemplateColumns:isPending?"110px 1fr 120px 60px 80px":"110px 1fr 120px 60px",
                  gap:8,padding:"8px 4px",borderBottom:i<appEntries.length-1?`1px solid ${T.border}44`:"none",
                  alignItems:"center",fontSize:13}}>
                  <div style={{fontWeight:700}}>{fmtD(e.date)}</div>
                  <div style={{color:e.note?T.ink:T.muted,fontStyle:e.note?"normal":"italic",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note||"No note"}</div>
                  <TypePill type={e.type} size="sm"/>
                  <div style={{fontWeight:700,color:TYPE_META[e.type]?.color||T.accent,textAlign:"center"}}>{e.netHours}h</div>
                  {isPending && (
                    <div style={{display:"flex",gap:4}}>
                      <button onClick={()=>onApprove(e.id)} style={{width:28,height:28,borderRadius:6,fontSize:14,background:T.accentL,color:T.accent,border:`1px solid ${T.accent}44`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}} title="Approve">✓</button>
                      <button onClick={()=>onDecline(e.id)} style={{width:28,height:28,borderRadius:6,fontSize:14,background:T.redL,color:T.red,border:`1px solid ${T.red}44`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}} title="Decline">✕</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APPRENTICE LIST
// ─────────────────────────────────────────────────────────────────────────────
// ── Shared Apprentice Edit Form — used by UserManagement, ApprenticeList, ApprenticeDetailView ──

export { WeeklyHoursList, ApprovalList };
