import { useState, useCallback } from "react";
import { T, ENTRY_TYPES, TYPE_META, APPROVAL_META, BREAK_OPTIONS, TIME_OPTIONS } from "../constants.js";
import { uid, tod, toMin, calcNet, fmtD, daysAgoStr, weekStart, withinWeek, timesheetActionUrl, timesheetAllUrl, notifyApprovers, notifyApprentice, sendKTAEmail } from "../utils.js";
import { upsertEntry, deleteEntry, upsertRow } from "../supabaseClient.js";
import { Pill, Btn, Card } from "../shared.jsx";

function EntryForm({onSave,onCancel,initial=null,minDate=null,maxDate=null,usedDates=[]}) {
  const blank = {date:tod(),type:"Normal Hours",start:"09:00",end:"17:00",breakMins:30,note:""};
  const [f,setF] = useState(initial||blank);
  const [err,setErr] = useState({});
  const sf=(k,v)=>setF(p=>({...p,[k]:v}));
  const dateConflict = !initial && usedDates.includes(f.date);
  const netH = calcNet(f.start,f.end,Number(f.breakMins));
  const gross = toMin(f.end)-toMin(f.start);

  const submit = () => {
    const e={};
    if(gross<=0) e.time="End must be after start";
    else if(netH<=0) e.time="Net hours must be > 0 after break";
    if(Object.keys(e).length){setErr(e);return;}
    if(dateConflict) return;
    onSave({...f,breakMins:Number(f.breakMins),netHours:netH,approval:initial?f.approval:"draft"});
  };

  return (
    <Card style={{border:`1.5px solid ${T.accent}44`}} className="fu">
      <div className="fg-entry" style={{display:"grid",gap:12,marginBottom:12}}>
        <div><FL>Date</FL>
              <div style={{position:"relative"}}>
                <input type="date" value={f.date} onChange={e=>sf("date",e.target.value)} min={minDate||undefined} max={maxDate||undefined}
                  className="ts-date-input"
                  style={{borderColor:dateConflict?T.red:undefined,width:"100%",boxSizing:"border-box"}}/>
              </div>
              {dateConflict&&<div style={{fontSize:12,color:T.red,marginTop:3}}>You already have an entry for this date</div>}</div>
        <div>
          <FL>Entry Type</FL>
          <select value={f.type} onChange={e=>sf("type",e.target.value)}>
            {ENTRY_TYPES.map(t=><option key={t}>{t}</option>)}
          </select>
          <div style={{marginTop:6}}><TypePill type={f.type}/></div>
        </div>
        <div><FL>Start Time</FL>
          <select value={f.start} onChange={e=>sf("start",e.target.value)}>
            {TIME_OPTIONS.map(t=><option key={t}>{t}</option>)}
          </select>
        </div>
        <div><FL>End Time</FL>
          <select value={f.end} onChange={e=>sf("end",e.target.value)}>
            {TIME_OPTIONS.map(t=><option key={t}>{t}</option>)}
          </select>
        </div>
      </div>
      {err.time&&<div style={{color:T.red,fontSize:12,marginBottom:10}}>{err.time}</div>}
      <div style={{marginBottom:12}}>
        <FL>Break Duration</FL>
        <select value={f.breakMins} onChange={e=>sf("breakMins",e.target.value)}>
          {BREAK_OPTIONS.map(m=><option key={m} value={m}>{m===0?"No break":`${m} minutes`}</option>)}
        </select>
      </div>
      <div style={{background:netH>0?T.accentL:T.redL,border:`1.5px solid ${netH>0?T.accent+"44":T.red+"44"}`,
        borderRadius:9,padding:"10px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:12,color:T.sub,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px"}}>Net Hours</div>
          <div style={{fontSize:12,color:T.muted,marginTop:1}}>{gross>0?`${f.start}–${f.end} minus ${f.breakMins}m`:"—"}</div>
        </div>
        <div style={{fontFamily:"'Libre Baskerville'",fontSize:28,fontWeight:700,color:netH>0?T.accent:T.red}}>
          {netH>0?`${netH}h`:"—"}
        </div>
      </div>
      <div style={{marginBottom:16}}>
        <FL>Note</FL>
        <textarea placeholder="Optional note…" value={f.note} onChange={e=>sf("note",e.target.value)}/>
      </div>
      <div style={{display:"flex",gap:8}}>
        <Btn onClick={submit}>{initial?"Update Entry":"Save Entry"}</Btn>
        {onCancel&&<Btn v="ghost" onClick={onCancel}>Cancel</Btn>}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY ROW
// ─────────────────────────────────────────────────────────────────────────────
function EntryRow({entry,canEdit,canDelete,canApprove,canSubmitXero,onDelete,onApprove,onDecline,onEdit,onSubmit,onSubmitXero,idx,showUser,users}) {
  const user=users?.find(u=>u.id===entry.userId);
  const tcols=showUser
    ?"130px 130px 1fr 130px 64px 64px 64px 60px 70px 100px 100px"
    :"130px 1fr 130px 64px 64px 64px 60px 70px 100px 100px";
  const isLocked = !canEdit && (entry.approval==="submitted"||entry.approval==="approved");
  return (
    <div className="ri" style={{display:"grid",gridTemplateColumns:tcols,
      padding:"12px 16px",borderBottom:`1px solid ${T.border}44`,
      background:idx%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${idx*.03}s`}}>
      <div>
        <div style={{fontSize:14,fontWeight:700}}>{fmtD(entry.date)}</div>
      </div>
      {showUser&&(
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          <Avatar name={user?.name} role={user?.role} size={26}/>
          <span style={{fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user?.name||"—"}</span>
        </div>
      )}
      <div style={{fontSize:13,color:entry.note?T.ink:T.muted,fontStyle:entry.note?"normal":"italic",
        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.note||"No note"}</div>
      <TypePill type={entry.type} size="sm"/>
      {(()=>{
        const u = users?.find(u=>u.id===entry.userId);
        let normalH = entry.netHours, overtimeH = 0;
        if(u?.overtimeType && u?.overtimeThreshold && entry.type==="Normal Hours") {
          const threshold = parseFloat(u.overtimeThreshold);
          if(u.overtimeType==="daily") {
            normalH   = Math.min(entry.netHours, threshold);
            overtimeH = Math.max(0, entry.netHours - threshold);
          }
        }
        return (<>
          <div style={{textAlign:"center",fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:16,color:"#1b4f8c"}}>{normalH}h</div>
          <div style={{textAlign:"center",fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:16,color:overtimeH>0?"#b86e1a":T.muted}}>{overtimeH>0?`${overtimeH}h`:"—"}</div>
          <div style={{textAlign:"center",fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:16,color:TYPE_META[entry.type]?.color||T.accent}}>{entry.netHours}h</div>
        </>);
      })()}
      <div style={{textAlign:"center",fontSize:12,color:T.sub}}>{entry.breakMins>0?`${entry.breakMins}m`:"—"}</div>
      <div style={{textAlign:"center",fontSize:12,color:T.muted,fontFamily:"monospace"}}>{entry.start}–{entry.end}</div>
      <AppvPill status={entry.approval}/>
      <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
        {canApprove&&entry.approval==="submitted"&&(<>
          <button onClick={()=>onApprove(entry.id)} title="Approve" style={{
            width:26,height:26,borderRadius:6,fontSize:13,background:T.accentL,color:T.accent,
            border:`1px solid ${T.accent}44`,display:"flex",alignItems:"center",justifyContent:"center"}}>✓</button>
          <button onClick={()=>onDecline(entry.id)} title="Decline" style={{
            width:26,height:26,borderRadius:6,fontSize:13,background:T.redL,color:T.red,
            border:`1px solid ${T.red}44`,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </>)}
        {canSubmitXero && entry.approval==="approved" && !entry.xeroStatus && (
          <button onClick={()=>onSubmitXero&&onSubmitXero(entry.id)}
            title="Submit to Xero Payroll"
            style={{height:26,borderRadius:6,fontSize:12,fontWeight:700,
              background:"#e6f7fd",color:"#0d7bb5",padding:"0 7px",
              border:"1px solid #13b5ea55",display:"flex",alignItems:"center",gap:3,
              cursor:"pointer",whiteSpace:"nowrap"}}
            onMouseEnter={e=>{e.currentTarget.style.background="#13b5ea";e.currentTarget.style.color="#fff";}}
            onMouseLeave={e=>{e.currentTarget.style.background="#e6f7fd";e.currentTarget.style.color="#0d7bb5";}}>
            𝕏 Xero
          </button>
        )}
        {entry.xeroStatus==="submitted" && (
          <div title="Submitted to Xero"
            style={{height:26,borderRadius:6,fontSize:12,fontWeight:700,
              background:"#e6f7fd",color:"#0d7bb5",padding:"0 7px",
              border:"1px solid #13b5ea55",display:"flex",alignItems:"center",gap:3}}>
            𝕏 ✓
          </div>
        )}
        {entry.xeroStatus==="error" && (
          <div title={entry.xeroError||"Xero error"}
            style={{height:26,borderRadius:6,fontSize:12,fontWeight:700,
              background:T.redL,color:T.red,padding:"0 7px",
              border:`1px solid ${T.red}44`,display:"flex",alignItems:"center",gap:3}}>
            𝕏 ✕
          </div>
        )}
        {isLocked&&(
          <div title={entry.approval==="approved"?"Approved — contact admin to edit":"Submitted — wait for approval or decline"}
            style={{width:26,height:26,borderRadius:6,fontSize:14,background:T.bg,color:T.muted,
              border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}>🔒</div>
        )}
        {canEdit&&(
          <button onClick={()=>onEdit(entry)} style={{width:26,height:26,borderRadius:6,fontSize:13,
            background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
            display:"flex",alignItems:"center",justifyContent:"center"}}
            onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
        )}
        {(canDelete===undefined?canEdit:canDelete)&&(
          <button onClick={()=>onDelete(entry.id)} title="Delete entry" style={{width:26,height:26,borderRadius:6,fontSize:13,
            background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
            display:"flex",alignItems:"center",justifyContent:"center"}}
            onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMESHEET MODULE
// ─────────────────────────────────────────────────────────────────────────────
function WeekCard2({title, weekEntries, accent, canEdit, canDelete, handleEdit, handleDelete}) {
  const fmtD2 = (iso) => { const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };
  const sColor = (s) => s==="approved"?T.teal:s==="submitted"?T.warn:s==="declined"?T.red:T.muted;
  const sLabel = (s) => s==="approved"?"✓ Approved":s==="submitted"?"⏳ Pending":s==="declined"?"✕ Declined":"Draft";
  return (
    <Card style={{marginBottom:14,border:`1.5px solid ${accent}33`}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
        <div>
          <div style={{fontWeight:700,fontSize:17,color:T.ink}}>{title}</div>
          <div style={{fontSize:13,color:T.sub,marginTop:1}}>
            {weekEntries.length===0?"No entries":`${weekEntries.length} entr${weekEntries.length===1?"y":"ies"} · ${weekEntries.reduce((a,e)=>a+e.netHours,0).toFixed(1)}h total`}
          </div>
        </div>
        {weekEntries.length>0&&<div style={{fontSize:22,fontWeight:700,color:accent}}>{weekEntries.reduce((a,e)=>a+e.netHours,0).toFixed(1)}h</div>}
      </div>
      {weekEntries.length===0
        ? <div style={{fontSize:14,color:T.muted,fontStyle:"italic",padding:"4px 0"}}>No entries for this week yet.</div>
        : <div style={{display:"flex",flexDirection:"column",gap:0}}>
            {[...weekEntries].sort((a,b)=>b.date.localeCompare(a.date)).map((e,i)=>(
              <div key={e.id} style={{display:"grid",gridTemplateColumns:"86px 1fr auto auto",alignItems:"center",gap:8,padding:"8px 2px",borderBottom:i<weekEntries.length-1?`1px solid ${T.border}44`:"none"}}>
                <div style={{fontSize:14,fontWeight:700,color:T.ink}}>{fmtD2(e.date)}</div>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:13,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.type}{e.note?` · ${e.note}`:""}</div>
                  <div style={{fontSize:12,color:T.muted}}>{e.start&&e.end?`${e.start}–${e.end}`:""}</div>
                </div>
                <div style={{fontSize:14,fontWeight:700,color:accent,whiteSpace:"nowrap"}}>{e.netHours.toFixed(1)}h</div>
                <div style={{display:"flex",alignItems:"center",gap:4}}>
                  <span style={{fontSize:12,fontWeight:700,color:sColor(e.approval),whiteSpace:"nowrap"}}>{sLabel(e.approval)}</span>
                  {canEdit&&canEdit(e)&&<button onClick={()=>handleEdit(e)} style={{width:22,height:22,borderRadius:5,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}} onMouseEnter={ev=>{ev.currentTarget.style.background=T.blueL;ev.currentTarget.style.color=T.blue;}} onMouseLeave={ev=>{ev.currentTarget.style.background="transparent";ev.currentTarget.style.color=T.muted;}}>✎</button>}
                  {canDelete&&canDelete(e)&&<button onClick={()=>handleDelete(e.id)} style={{width:22,height:22,borderRadius:5,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}} onMouseEnter={ev=>{ev.currentTarget.style.background=T.redL;ev.currentTarget.style.color=T.red;}} onMouseLeave={ev=>{ev.currentTarget.style.background="transparent";ev.currentTarget.style.color=T.muted;}}>✕</button>}
                </div>
              </div>
            ))}
          </div>}
    </Card>
  );
}

function TimesheetModule({currentUser,allUsers,entries,setEntries,forcedApprenticeId=null}) {
  const [showForm,setShowForm] = useState(false);
  const [editEntry,setEditEntry] = useState(null);
  const [filterUid,setFilterUid] = useState(forcedApprenticeId||"all");
  const [toast,setToast] = useState(null); // {msg, ok}
  const [weekPickerDrafts, setWeekPickerDrafts] = useState(null); // null | {weeks:[...], draftsPerWeek:{}}
  const [weekPickerSelected, setWeekPickerSelected] = useState(null);
  const role=currentUser.role;

  const showToast = (msg, ok=true) => {
    setToast({msg,ok});
    setTimeout(()=>setToast(null), 4000);
  };

  const visibleIds = useCallback(()=>{
    if(forcedApprenticeId) return [forcedApprenticeId];
    if(role==="Admin") return allUsers.map(u=>u.id);
    if(["Viewer","Approver"].includes(role)) {
      // Legacy: allocatedTo on the viewer/approver record
      const fromAlloc = currentUser.allocatedTo||[];
      // New: apprentices who have this user set as their approver/viewer
      const fromApprentice = allUsers
        .filter(u=>u.role==="Apprentice"&&(u.approverUserId===currentUser.id||u.viewerUserId===currentUser.id))
        .map(u=>u.id);
      return [...new Set([currentUser.id,...fromAlloc,...fromApprentice])];
    }
    if(role==="Supervisor") {
      return allUsers
        .filter(u=>u.role==="Apprentice"&&(u.supervisorIds||[]).includes(currentUser.id))
        .map(u=>u.id);
    }
    if(role==="Mentor") {
      // Legacy: allocatedTo on the mentor record
      const fromAlloc = currentUser.allocatedTo||[];
      // New: apprentices who have this user set as their mentor
      const fromApprentice = allUsers
        .filter(u=>u.role==="Apprentice"&&(u.mentorUserId===currentUser.id||(u.supervisorIds||[]).includes(currentUser.id)))
        .map(u=>u.id);
      return [...new Set([...fromAlloc,...fromApprentice])];
    }
    return [currentUser.id];
  },[role,currentUser,allUsers,forcedApprenticeId]);

  // Helper: effective roles this user has (Admin may also have a secondaryRole)
  const hasRole = (r) => role===r || (role==="Admin" && currentUser.secondaryRole===r);

  const canEdit=(entry)=>{
    if(role==="Admin") return true;
    // Apprentice: only draft entries within 21 days are editable
    // Submitted entries are locked until declined, approved entries are permanently locked
    if(role==="Apprentice"&&entry.userId===currentUser.id&&entry.approval==="draft"&&entry.date>=daysAgoStr(21)) return true;
    return false;
  };
  const isAdmin1ts = role==="Admin" && Number(currentUser?.adminLevel ?? 1)===1;
  const canDelete=(entry)=>{
    // Only Admin L1 can delete any entry
    if(isAdmin1ts) return true;
    // Apprentice can delete own draft entries only
    if(role==="Apprentice"&&entry.userId===currentUser.id&&entry.approval==="draft") return true;
    return false;
  };
  const canApprove=(entry)=>{
    if(entry.approval!=="submitted") return false;
    if(role==="Admin") return true;
    if(role==="Approver") {
      const apprentice = allUsers.find(u=>u.id===entry.userId);
      if((currentUser.allocatedTo||[]).includes(entry.userId)) return true;
      if(apprentice?.approverUserId===currentUser.id) return true;
    if(role==="Supervisor" && apprentice?.approverUserId===currentUser.id) return true;
    }
    return false;
  };
  const canAdd = forcedApprenticeId
    ? (role==="Admin")          // Admin can add on behalf of apprentice
    : (role==="Admin"||role==="Apprentice");

  const vids=visibleIds();
  let shown=entries.filter(e=>vids.includes(e.userId));
  if(!forcedApprenticeId && filterUid!=="all") shown=shown.filter(e=>e.userId===filterUid);
  if(role==="Apprentice") shown=shown.filter(e=>e.date>=daysAgoStr(60)||e.approval!=="draft");
  shown=[...shown].sort((a,b)=>b.date.localeCompare(a.date));

  const myE=entries.filter(e=>e.userId===currentUser.id);
  const todayEntries=myE.filter(e=>e.date===tod());
  const todayH=todayEntries.length>0?todayEntries.reduce((a,e)=>a+e.netHours,0).toFixed(2):null;
  const ws=()=>{const d=new Date();d.setDate(d.getDate()-d.getDay());return d.toISOString().slice(0,10);};
  const weekH=myE.filter(e=>e.date>=ws()).reduce((a,e)=>a+e.netHours,0).toFixed(2);
  const pending=entries.filter(e=>vids.includes(e.userId)&&e.approval==="submitted").length;

  const handleSave=(data)=>{
    // When admin adds on behalf of an apprentice, use the apprentice's ID not the admin's
    const targetUserId = forcedApprenticeId || currentUser.id;
    if(editEntry){
      const updated = {...editEntry,...data};
      setEntries(prev=>prev.map(e=>e.id===editEntry.id?updated:e));
      upsertEntry(updated).catch(err=>alert('Save failed: '+err.message));
    } else {
      // Block duplicate date for apprentices
      if(role==="Apprentice"){
        const already=entries.some(e=>e.userId===currentUser.id&&e.date===data.date);
        if(already){ showToast("You already have an entry for this date. Edit the existing one instead.",false); return; }
      }
      const newEntry = {id:uid(),userId:targetUserId,...data,createdAt:new Date().toISOString()};
      setEntries(prev=>[newEntry,...prev]);
      upsertEntry(newEntry).catch(err=>alert('Save failed: '+err.message));
    }
    setShowForm(false); setEditEntry(null);
  };
  const handleApprove=async(id)=>{
    const entry=entries.find(e=>e.id===id);
    setEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"approved"}:e));
    if(entry){
      const apprentice=allUsers.find(u=>u.id===entry.userId);
      // Check if all submitted entries for that week are now approved (including this one)
      const getWk=d=>{const dt=new Date(d+"T00:00:00");dt.setDate(dt.getDate()-((dt.getDay()+6)%7));return dt.toISOString().slice(0,10);};
      const weekKey=getWk(entry.date);
      const weekEntries=entries.filter(e=>e.userId===entry.userId&&getWk(e.date)===weekKey);
      const nowAllApproved=weekEntries.every(e=>e.id===id?true:e.approval==="approved");
      if(nowAllApproved && weekEntries.length>1){
        // Full week approved — send week summary
        await notifyApprentice(apprentice, currentUser, weekEntries.map(e=>e.id===id?{...e,approval:"approved"}:e), true);
        showToast(`✓ Week approved — emailed ${apprentice?.name}`);
      } else {
        // Single day approved
        await notifyApprentice(apprentice, currentUser, [entry], true);
        showToast(`✓ Entry approved — emailed ${apprentice?.name}`);
      }
    }
  };
  const handleDecline=async(id)=>{
    const entry=entries.find(e=>e.id===id);
    setEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"declined"}:e));
    if(entry){
      const apprentice=allUsers.find(u=>u.id===entry.userId);
      await notifyApprentice(apprentice, currentUser, [entry], false);
      showToast(`Entry declined — emailed ${apprentice?.name}`, false);
    }
  };
  const handleDelete=(id)=>{
    const e=entries.find(x=>x.id===id);
    if(e && !canDelete(e)) return; // safety guard
    setEntries(prev=>prev.filter(e=>e.id!==id));
    deleteEntry(id).catch(err=>console.error('deleteEntry failed:',err));
  };
  const handleEdit=(entry)=>{setEditEntry(entry);setShowForm(true);};

  const filterableUsers=allUsers.filter(u=>vids.includes(u.id));
  const showUserCol=role!=="Apprentice";
  const tcols=showUserCol
    ?"130px 130px 1fr 130px 64px 64px 64px 60px 70px 100px 100px"
    :"130px 1fr 130px 64px 64px 64px 60px 70px 100px 100px";

  return (
    <div className="fu">
      {toast&&(
        <div style={{position:"fixed",bottom:24,right:24,zIndex:999,
          background:toast.ok?T.accentL:T.warnL,
          border:`1.5px solid ${toast.ok?T.accent:T.warn}`,
          borderRadius:10,padding:"12px 20px",fontSize:14,fontWeight:700,
          color:toast.ok?T.accent:T.warn,boxShadow:"0 4px 20px #00000022",
          maxWidth:360,lineHeight:1.4}}>
          {toast.msg}
        </div>
      )}
      <div style={{background:ROLE_META[role].bg,border:`1.5px solid ${ROLE_META[role].color}44`,
        borderRadius:10,padding:"10px 16px",marginBottom:20,display:"flex",gap:10,alignItems:"center"}}>
        <span style={{fontSize:18}}>{ROLE_META[role].symbol}</span>
        <span style={{fontWeight:700,color:ROLE_META[role].color,fontSize:14}}>{role} View — </span>
        <span style={{fontSize:14,color:T.sub}}>{ROLE_META[role]?.desc||""}</span>
      </div>
      <div className="stat-grid-4">
        <StatCard label="Today (mine)" value={todayH?`${todayH}h`:"—"} color={todayH?T.accent:T.muted}/>
        <StatCard label="This Week (mine)" value={`${weekH}h`} color={T.warn}/>
        <StatCard label="Visible Entries" value={shown.length} color={T.blue}/>
        <StatCard label="Pending Approval" value={pending} sub="in your scope" color={pending>0?T.warn:T.muted}/>
      </div>
      {canAdd&&(
        <div style={{marginBottom:16,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <Btn onClick={()=>{setShowForm(s=>!s);setEditEntry(null);}} v={showForm?"ghost":"primary"}>
            {showForm?"✕ Cancel":"+ Log Entry"}
          </Btn>
          {role==="Apprentice"&&(()=>{
            const myDrafts=shown.filter(e=>e.approval==="draft"&&e.userId===currentUser.id);
            if(!myDrafts.length) return null;

            // Group drafts by week-ending Sunday
            const getWeekEnding = (dateStr) => {
              const [y,m,d] = dateStr.split('-').map(Number);
              // Use UTC to avoid timezone shifts
              const date = new Date(Date.UTC(y,m-1,d));
              const day = date.getUTCDay(); // 0=Sun
              const diff = day===0 ? 0 : 7-day;
              date.setUTCDate(date.getUTCDate()+diff);
              return date.toISOString().slice(0,10);
            };
            const draftsPerWeek = {};
            myDrafts.forEach(e=>{
              const we = getWeekEnding(e.date);
              if(!draftsPerWeek[we]) draftsPerWeek[we]=[];
              draftsPerWeek[we].push(e);
            });
            const weeks = Object.keys(draftsPerWeek).sort();

            const doSubmit = async (weekEnding) => {
              const toSubmit = weekEnding ? draftsPerWeek[weekEnding] : myDrafts;
              const ids = toSubmit.map(e=>e.id);
              setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"submitted"}:e));
              setWeekPickerDrafts(null);
              setWeekPickerSelected(null);
              const approvers = allUsers.filter(u=>
                (u.role==="Approver"||u.role==="Admin")&&(
                  (u.allocatedTo||[]).includes(currentUser.id) || currentUser.approverUserId===u.id
                )
              );
              if(!approvers.length){
                showToast("Submitted — no approver assigned yet, no email sent",false);
              } else {
                try {
                  await notifyApprovers(currentUser, approvers, toSubmit);
                  showToast(`✓ Submitted & emailed ${approvers.map(a=>a.name).join(", ")}`);
                } catch(err) {
                  showToast(`Submitted but email failed: ${err.message}`,false);
                }
              }
            };

            return (
              <>
                <Btn v="blue" onClick={()=>{
                  if(weeks.length>1) {
                    setWeekPickerDrafts({weeks, draftsPerWeek});
                    setWeekPickerSelected(null);
                  } else {
                    doSubmit(weeks[0]);
                  }
                }}>
                  ↑ Submit {myDrafts.length} Draft{myDrafts.length!==1?"s":""}
                </Btn>

                {/* Week picker modal */}
                {weekPickerDrafts&&(
                  <div style={{position:"fixed",inset:0,background:"#00000066",zIndex:300,
                    display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
                    <Card style={{width:"100%",maxWidth:420,padding:24}}>
                      <div style={{fontWeight:700,fontSize:18,marginBottom:6}}>Which week to submit?</div>
                      <div style={{fontSize:14,color:T.sub,marginBottom:18}}>
                        Your drafts span multiple weeks. Choose which week to submit for approval.
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
                        {weekPickerDrafts.weeks.map(we=>{
                          const cnt = weekPickerDrafts.draftsPerWeek[we].length;
                          const hrs = weekPickerDrafts.draftsPerWeek[we].reduce((a,e)=>a+e.netHours,0).toFixed(2);
                          const [wy,wm,wd] = we.split('-');
                          const label = `${wd}/${wm}/${wy}`;
                          const selected = weekPickerSelected===we;
                          return (
                            <button key={we} onClick={()=>setWeekPickerSelected(we)} style={{
                              padding:"12px 14px",borderRadius:10,textAlign:"left",cursor:"pointer",
                              border:`2px solid ${selected?T.accent:T.border}`,
                              background:selected?T.accentL:T.surface,
                              fontFamily:"DM Sans,sans-serif",transition:"all .14s"}}>
                              <div style={{fontWeight:700,fontSize:16,color:selected?T.accent:T.ink}}>
                                Week ending {label}
                              </div>
                              <div style={{fontSize:13,color:T.sub,marginTop:3}}>
                                {cnt} entr{cnt===1?"y":"ies"} · {hrs}h total
                              </div>
                            </button>
                          );
                        })}
                        <button onClick={()=>setWeekPickerSelected("all")} style={{
                          padding:"12px 14px",borderRadius:10,textAlign:"left",cursor:"pointer",
                          border:`2px solid ${weekPickerSelected==="all"?T.blue:T.border}`,
                          background:weekPickerSelected==="all"?T.blueL:T.surface,
                          fontFamily:"DM Sans,sans-serif",transition:"all .14s"}}>
                          <div style={{fontWeight:700,fontSize:16,color:weekPickerSelected==="all"?T.blue:T.ink}}>
                            Submit all weeks at once
                          </div>
                          <div style={{fontSize:13,color:T.sub,marginTop:3}}>
                            {myDrafts.length} entries · {myDrafts.reduce((a,e)=>a+e.netHours,0).toFixed(2)}h total
                          </div>
                        </button>
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <Btn onClick={()=>{ if(weekPickerSelected) doSubmit(weekPickerSelected==="all"?null:weekPickerSelected); }}
                          disabled={!weekPickerSelected}>
                          Submit
                        </Btn>
                        <Btn v="ghost" onClick={()=>{setWeekPickerDrafts(null);setWeekPickerSelected(null);}}>Cancel</Btn>
                      </div>
                    </Card>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
      {showForm&&<div style={{marginBottom:20}}>
        <EntryForm onSave={handleSave} onCancel={()=>{setShowForm(false);setEditEntry(null);}} initial={editEntry}
          minDate={role==="Apprentice"?daysAgoStr(21):null}
          maxDate={role==="Apprentice"?tod():null}
          usedDates={role==="Apprentice"?entries.filter(e=>e.userId===currentUser.id).map(e=>e.date):[]}/>
      </div>}
      {filterableUsers.length>1&&(
        <div style={{display:"flex",gap:10,marginBottom:14}}>
          <select value={filterUid} onChange={e=>setFilterUid(e.target.value)}
            style={{width:220,fontSize:13,padding:"7px 28px 7px 11px"}}>
            <option value="all">All Visible Users</option>
            {filterableUsers.map(u=><option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
          </select>
        </div>
      )}
      {/* ── Approver view: grouped by apprentice with per-day + approve-week actions ── */}
      {/* ── Entry list — split by role ── */}
      {(()=>{
        const isApprover = role==="Approver"||(role==="Admin"&&currentUser.secondaryRole==="Approver");
        if(isApprover) {
          const myApprentices = allUsers.filter(u=>
            u.role==="Apprentice"&&(
              (currentUser.allocatedTo||[]).includes(u.id)||
              u.approverUserId===currentUser.id
            )
          );
          if(!myApprentices.length) return (
            <Card><div style={{padding:32,textAlign:"center",color:T.muted}}>No apprentices allocated to you yet.</div></Card>
          );

        // Week-ending Sunday, UTC-safe
        const getWeekEnding = (dateStr) => {
          const [y,m,d] = dateStr.split('-').map(Number);
          const date = new Date(Date.UTC(y,m-1,d));
          const day = date.getUTCDay();
          date.setUTCDate(date.getUTCDate() + (day===0 ? 0 : 7-day));
          return date.toISOString().slice(0,10);
        };
        const fmtWeekEnd = (we) => { const [y,m,d]=we.split('-'); return `${d}/${m}/${y}`; };

        return myApprentices.map(app=>{
          // Only include completed (approved/submitted) entries from the current week
          const ws = ()=>{const d=new Date();d.setDate(d.getDate()-d.getDay());return d.toISOString().slice(0,10);};
          const weekStart = ws();
          const appEntries = shown.filter(e=>e.userId===app.id && e.date >= weekStart && (e.approval === "approved" || e.approval === "submitted" || e.xeroStatus === "submitted")).sort((a,b)=>b.date.localeCompare(a.date));
          const submitted  = appEntries.filter(e=>e.approval==="submitted");
          const weeks      = [...new Set(appEntries.map(e=>getWeekEnding(e.date)))].sort((a,b)=>b.localeCompare(a));

          // Use calcOvertimeSplit logic for each entry to ensure correct split
          let normalHrs = 0, overtimeHrs = 0;
          // Find apprentice object for overtime settings
          const apprenticeObj = allUsers.find(u => u.id === app.id);
          appEntries.forEach(entry => {
            // Use the same logic as in calcOvertimeSplit (App.jsx/ApprenticeConversation.jsx)
            if (!apprenticeObj?.overtimeType || !apprenticeObj?.overtimeThreshold || entry.type !== "Normal Hours") {
              if (entry.type === "Overtime") overtimeHrs += entry.netHours;
              else normalHrs += entry.netHours;
            } else {
              const overtimeType = apprenticeObj.overtimeType;
              const overtimeThreshold = parseFloat(apprenticeObj.overtimeThreshold);
              if (overtimeType === "daily") {
                const normal = Math.min(entry.netHours, overtimeThreshold);
                const overtime = Math.max(0, entry.netHours - overtimeThreshold);
                normalHrs += normal;
                overtimeHrs += overtime;
              } else if (overtimeType === "weekly") {
                // Get Mon of entry's week
                const d = new Date(entry.date + "T00:00:00");
                const day = d.getDay();
                const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7));
                const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
                const monStr = mon.toISOString().slice(0,10);
                const sunStr = sun.toISOString().slice(0,10);
                // Sum all approved/submitted entries this week for this apprentice BEFORE this entry
                const weekEntries = appEntries.filter(e =>
                  e.date >= monStr && e.date <= sunStr && e.date < entry.date
                );
                const hoursBeforeThis = weekEntries.reduce((s, e) => s + e.netHours, 0);
                const hoursAfterThreshold = Math.max(0, hoursBeforeThis - overtimeThreshold);
                const remainingNormal = Math.max(0, overtimeThreshold - hoursBeforeThis);
                if (hoursAfterThreshold >= entry.netHours) {
                  // Entirely overtime
                  overtimeHrs += entry.netHours;
                } else {
                  const normal = Math.min(entry.netHours, remainingNormal);
                  const overtime = Math.max(0, entry.netHours - remainingNormal);
                  normalHrs += normal;
                  overtimeHrs += overtime;
                }
              } else {
                // Unknown overtime type, just sum as normal
                normalHrs += entry.netHours;
              }
            }
          });
          const totalHours = normalHrs + overtimeHrs;

          const approveWeek = async (weekEnding)=>{
            const toApprove = submitted.filter(e=>getWeekEnding(e.date)===weekEnding);
            const ids = toApprove.map(e=>e.id);
            if(!ids.length) return;
            setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"approved"}:e));
            await notifyApprentice(app, currentUser, toApprove, true);
            showToast(`✓ Week approved — emailed ${app.name}`);
          };

          const approveAllWeeks = async ()=>{
            if(!submitted.length) return;
            const ids = submitted.map(e=>e.id);
            setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"approved"}:e));
            await notifyApprentice(app, currentUser, submitted, true);
            showToast(`✓ All pending entries approved — emailed ${app.name}`);
          };

          return (
            <Card key={app.id} style={{marginBottom:16,padding:0,overflow:"hidden"}}>
              {/* Apprentice header */}
              <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
                background:T.bg,borderBottom:`1.5px solid ${T.border}`,flexWrap:"wrap"}}>
                <Avatar name={app.name} role="Apprentice" size={34}/>
                <div style={{flex:1,minWidth:120}}>
                  <div style={{fontWeight:700,fontSize:16}}>{app.name}</div>
                  <div style={{fontSize:13,color:T.sub}}>
                    {appEntries.length} completed entries this week · {submitted.length} awaiting approval<br/>
                    <span style={{fontWeight:400, color:T.muted, fontSize:14}}>
                      Total: {totalHours}h (Normal: {normalHrs}h, Overtime: {overtimeHrs}h)
                    </span>
                  </div>
                </div>
              </div>

              {/* Week approve buttons — one per week with pending entries */}
              {submitted.length>0&&(
                <div style={{padding:"10px 16px",background:T.warnL+"44",borderBottom:`1px solid ${T.border}`,
                  display:"flex",flexDirection:"column",gap:8}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.warn,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>
                    Pending approval
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                    {weeks.filter(we=>submitted.some(e=>getWeekEnding(e.date)===we)).map(we=>{
                      const cnt = submitted.filter(e=>getWeekEnding(e.date)===we).length;
                      const hrs = submitted.filter(e=>getWeekEnding(e.date)===we).reduce((a,e)=>a+e.netHours,0).toFixed(2);
                      return (
                        <button key={we} onClick={async ()=>{
                          if(await ktaConfirm(`Approve week ending ${fmtWeekEnd(we)} for ${app.name}?\n${cnt} ${cnt===1?"entry":"entries"} · ${hrs}h total`))
                            approveWeek(we);
                        }} style={{
                          padding:"9px 16px",borderRadius:8,fontSize:14,fontWeight:700,
                          background:T.accent,color:"#fff",border:"none",
                          cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                          display:"flex",alignItems:"center",gap:7,transition:"opacity .14s"}}
                          onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
                          onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                          ✓ Approve week ending {fmtWeekEnd(we)}
                          <span style={{fontWeight:700,opacity:.8,fontSize:13}}>({cnt} {cnt===1?"entry":"entries"} · {hrs}h)</span>
                        </button>
                      );
                    })}
                    {weeks.filter(we=>submitted.some(e=>getWeekEnding(e.date)===we)).length > 1 && (
                      <button onClick={async ()=>{
                        if(await ktaConfirm(`Approve ALL ${submitted.length} pending entries for ${app.name}?`))
                          approveAllWeeks();
                      }} style={{
                        padding:"9px 16px",borderRadius:8,fontSize:14,fontWeight:700,
                        background:T.accentD,color:"#fff",border:"none",
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif",transition:"opacity .14s"}}
                        onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
                        onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                        ✓✓ Approve all pending
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Column headers */}
              <div style={{display:"grid",
                gridTemplateColumns:"100px 1fr 110px 56px 80px 70px 80px",
                padding:"8px 16px",background:T.bg,
                fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
                <span>Date</span><span>Note</span><span>Type</span>
                <span style={{textAlign:"center"}}>Hours</span>
                <span style={{textAlign:"center"}}>Start–End</span>
                <span style={{textAlign:"center"}}>Break</span>
                <span>Status / Action</span>
              </div>

              {appEntries.length===0&&(
                <div style={{padding:"24px",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>No entries yet.</div>
              )}
              {appEntries.map((e,i)=>(
                <div key={e.id} style={{display:"grid",
                  gridTemplateColumns:"100px 1fr 110px 56px 80px 70px 80px",
                  padding:"9px 16px",gap:8,alignItems:"center",fontSize:13,
                  borderBottom:i<appEntries.length-1?`1px solid ${T.border}44`:"none",
                  background:e.approval==="submitted"?T.warnL+"55":i%2===0?T.surface:T.bg}}>
                  <div style={{fontWeight:700,fontSize:13}}>{fmtD(e.date)}</div>
                  <div style={{color:e.note?T.ink:T.muted,fontStyle:e.note?"normal":"italic",
                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:13}}>{e.note||"No note"}</div>
                  <TypePill type={e.type} size="sm"/>
                  <div style={{textAlign:"center",fontWeight:700,color:TYPE_META[e.type]?.color||T.accent,
                    fontFamily:"DM Sans",fontSize:16}}>{e.netHours}h</div>
                  <div style={{textAlign:"center",fontSize:12,color:T.muted,fontFamily:"monospace"}}>{e.start}–{e.end}</div>
                  <div style={{textAlign:"center",fontSize:12,color:T.sub}}>{e.breakMins>0?`${e.breakMins}m`:"—"}</div>
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>
                    {e.approval==="submitted"&&(<>
                      <button onClick={()=>handleApprove(e.id)} title="Approve" style={{
                        width:26,height:26,borderRadius:6,fontSize:13,background:T.accentL,color:T.accent,
                        border:`1px solid ${T.accent}44`,cursor:"pointer",flexShrink:0,
                        display:"flex",alignItems:"center",justifyContent:"center"}}>✓</button>
                      <button onClick={()=>handleDecline(e.id)} title="Decline" style={{
                        width:26,height:26,borderRadius:6,fontSize:13,background:T.redL,color:T.red,
                        border:`1px solid ${T.red}44`,cursor:"pointer",flexShrink:0,
                        display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                    </>)}
                    {e.approval==="approved"&&<AppvPill status="approved"/>}
                    {e.approval==="declined"&&(<>
                      <AppvPill status="declined"/>
                      <button onClick={()=>handleApprove(e.id)} title="Re-approve" style={{
                        width:26,height:26,borderRadius:6,fontSize:12,background:T.accentL,color:T.accent,
                        border:`1px solid ${T.accent}44`,cursor:"pointer",flexShrink:0,
                        display:"flex",alignItems:"center",justifyContent:"center"}}>↺</button>
                    </>)}
                    {e.approval==="draft"&&<AppvPill status="draft"/>}
                  </div>
                </div>
              ))}
            </Card>
          );
        });
        }

        if(role==="Apprentice") {
          const today = tod();
          const getMonday = (ds) => { const d=new Date(ds+"T00:00:00"); d.setDate(d.getDate()-((d.getDay()+6)%7)); return d.toISOString().slice(0,10); };
          const thisMon = getMonday(today);
          const d1=new Date(thisMon+"T00:00:00"); d1.setDate(d1.getDate()-7); const lastMon=d1.toISOString().slice(0,10);
          const d2=new Date(thisMon+"T00:00:00"); d2.setDate(d2.getDate()-1); const lastSun=d2.toISOString().slice(0,10);
          const myEntries = shown.filter(e=>e.userId===currentUser.id);
          const thisWeekE = myEntries.filter(e=>e.date>=thisMon);
          const lastWeekE = myEntries.filter(e=>e.date>=lastMon&&e.date<=lastSun);
          const olderE    = myEntries.filter(e=>e.date<lastMon);


          return (<>
            <WeekCard2 title="This Week" weekEntries={thisWeekE} accent={T.accent} canEdit={canEdit} canDelete={canDelete} handleEdit={handleEdit} handleDelete={handleDelete}/>
            <WeekCard2 title="Last Week" weekEntries={lastWeekE} accent={T.blue} canEdit={canEdit} canDelete={canDelete} handleEdit={handleEdit} handleDelete={handleDelete}/>
            {olderE.length>0&&(
              <Card style={{marginBottom:14}}>
                <div style={{fontWeight:700,fontSize:16,marginBottom:8,color:T.sub}}>Older Entries</div>
                <div style={{display:"flex",flexDirection:"column",gap:0}}>
                  {[...olderE].sort((a,b)=>b.date.localeCompare(a.date)).map((e,i)=>(
                    <div key={e.id} style={{display:"grid",gridTemplateColumns:"86px 1fr auto auto",alignItems:"center",gap:8,padding:"8px 2px",borderBottom:i<olderE.length-1?`1px solid ${T.border}44`:"none"}}>
                      <div style={{fontSize:14,fontWeight:700,color:T.ink}}>{fmtD2(e.date)}</div>
                      <div style={{minWidth:0}}><div style={{fontSize:13,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.type}{e.note?` · ${e.note}`:""}</div></div>
                      <div style={{fontSize:14,fontWeight:700,color:T.muted}}>{e.netHours.toFixed(1)}h</div>
                      <span style={{fontSize:12,fontWeight:700,color:sColor(e.approval)}}>{sLabel(e.approval)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            {myEntries.length===0&&(
              <Card><div style={{padding:"40px 24px",textAlign:"center",color:T.muted}}>
                <div style={{fontSize:35,marginBottom:8}}>◈</div>
                <div style={{fontWeight:700}}>No entries to display</div>
                <div style={{fontSize:13,marginTop:4}}>Use the button above to log your first entry.</div>
              </div></Card>
            )}
          </>);
        }

        // ── Default: flat table for Admin, Viewer, Mentor ──
        return (<>
          <Card style={{padding:0,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:tcols,padding:"10px 16px",
              background:T.bg,borderBottom:`1.5px solid ${T.border}`,
              fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
              <span>Date</span>{showUserCol&&<span>Person</span>}<span>Note</span><span>Type</span>
              <span style={{textAlign:"center"}}>Normal</span><span style={{textAlign:"center",color:"#b86e1a"}}>OT</span><span style={{textAlign:"center"}}>Total Hours Worked</span><span style={{textAlign:"center"}}>Break</span>
              <span style={{textAlign:"center"}}>Time</span><span>Status</span>
              <span style={{textAlign:"right"}}>Actions</span>
            </div>
            {shown.length===0&&(
              <div style={{padding:"48px 24px",textAlign:"center",color:T.muted}}>
                <div style={{fontSize:35,marginBottom:8}}>◈</div>
                <div style={{fontWeight:700}}>No entries to display</div>
                <div style={{fontSize:13,marginTop:4}}>{canAdd?"Use the button above to log your first entry.":"No entries in your scope yet."}</div>
              </div>
            )}
            {shown.map((e,i)=>(
              <EntryRow key={e.id} entry={e} idx={i}
                canEdit={canEdit(e)} canApprove={canApprove(e)}
                onDelete={handleDelete} onApprove={handleApprove}
                onDecline={handleDecline} onEdit={handleEdit}
                canDelete={canDelete(e)}
                canSubmitXero={role==="Admin" && Number(currentUser?.adminLevel ?? 1)===1}
                onSubmitXero={async(id)=>{
                  const en = entries.find(x=>x.id===id);
                  if(!en) return;
                  setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"submitting"}:x));
                  try{
                    const res = await submitEntryToXero(en, allUsers.find(u=>u.id===en.userId));
                    if(res.ok) setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"submitted",xeroTimesheetId:res.timesheetId}:x));
                    else setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"error",xeroError:res.error}:x));
                  } catch(e2){
                    setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"error",xeroError:e2.message}:x));
                  }
                }}
                onSubmit={role==="Apprentice"?async(id)=>{
                  setEntries(prev=>prev.map(x=>x.id===id?{...x,approval:"submitted"}:x));
                  const entry=entries.find(x=>x.id===id);
                  if(entry){
                    const approvers=allUsers.filter(u=>
                      (u.role==="Approver"||(u.role==="Admin"&&u.secondaryRole==="Approver"))&&(
                        (u.allocatedTo||[]).includes(currentUser.id)||
                        currentUser.approverUserId===u.id
                      ));
                    if(!approvers.length){
                      showToast("Submitted — no approver assigned yet, no email sent",false);
                    } else {
                      try{
                        await notifyApprovers(currentUser, approvers, [entry]);
                        showToast(`✓ Submitted & emailed ${approvers.map(a=>a.name).join(", ")}`);
                      } catch(er){
                        showToast(`Submitted but email failed: ${er.message}`,false);
                      }
                    }
                  }
                }:null}
                showUser={showUserCol} users={allUsers}/>
            ))}
          </Card>
          {shown.length>0&&(
            <div style={{textAlign:"right",fontSize:13,color:T.sub,marginTop:10}}>
              {shown.length} entr{shown.length===1?"y":"ies"} · <strong style={{color:T.accent}}>{shown.reduce((a,e)=>a+e.netHours,0).toFixed(2)}h</strong> net
            </div>
          )}
        </>);
      })()}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
// ── Reusable sort hook ────────────────────────────────────────────────────────

export default TimesheetModule;
export { EntryForm, EntryRow, WeekCard2 };
