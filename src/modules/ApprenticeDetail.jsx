import { useState, useEffect } from "react";
import { T, TRADES } from "../constants.js";
import { uid, fmtD, daysAgoStr, isConfOwner } from "../utils.js";
import { upsertUser, upsertRow, updateRow, loadTable, insertMessage } from "../supabaseClient.js";
import { Pill, RolePill, Avatar, Btn, Card } from "../shared.jsx";
import { MeetingReportForm, PastMeetingReports, ReportFullscreenModal } from "./ReportsModule.jsx";
import { PPEAllocation } from "./PPEModule.jsx";
import { HSECheckinForm, PastHSECheckins } from "./HSEModule.jsx";
import { EmailActivityFeed } from "./EmailsModule.jsx";
import TimesheetModule from "./TimesheetModule.jsx";

function ApprenticeDetailView({apprentice:apprenticeProp, viewer, allUsers, entries, setEntries, onBack, isAdmin=false, canEditExpiry=false, onUserUpdated=null}) {
  if(!apprenticeProp) return null;
  const [apprentice, setApprentice]           = useState(apprenticeProp);

  // Keep local apprentice in sync with parent — prevents stale reportsEmail/email
  // reaching sendMeetingReportEmail if allUsers updated after component mounted
  useEffect(() => {
    setApprentice(prev => ({ ...prev, ...apprenticeProp }));
  }, [apprenticeProp?.id, apprenticeProp?.reportsEmail, apprenticeProp?.email,
      apprenticeProp?.approverUserId, apprenticeProp?.hostBusiness]);
  const [showMeetingForm, setShowMeetingForm] = useState(false);
  const [showPastReports, setShowPastReports] = useState(false);
  const [showPPE, setShowPPE]                 = useState(false);
  const [showActivity, setShowActivity]       = useState(false);
  const [showHSEForm, setShowHSEForm]         = useState(false);
  const [showPastHSE, setShowPastHSE]         = useState(false);
  const [showTimesheetAdd, setShowTimesheetAdd] = useState(false);
  const [meetingKey, setMeetingKey]           = useState(0);
  const [lastVisit, setLastVisit]             = useState(null);
  const [loadingVisit, setLoadingVisit]       = useState(true);
  const [reports, setReports]                 = useState([]);
  const [showPersonal, setShowPersonal]       = useState(false);
  const [advLeave, setAdvLeave]               = useState([]);
  const [advLeaveLoading, setAdvLeaveLoading] = useState(true);
  const [pdEdit, setPdEdit]                   = useState(false);
  const [showEditForm, setShowEditForm]       = useState(false);
  const [pdSaving, setPdSaving]               = useState(false);
  const [pdForm, setPdForm]                   = useState({
    email:"", phone:"", startDate:"", dateOfBirth:"",
    gender:"", hostBusiness:"", address:"", addressLine2:"", suburb:"", city:"", postcode:"",
    emergencyContactName:"", emergencyContactPhone:"", emergencyContactRelationship:"",
  });
  const [editingExpiry, setEditingExpiry]     = useState(null); // "licence"|"siteSafe"|"firstAid"|"licenceNum"|"siteSafeNum"
  const [expiryVal, setExpiryVal]             = useState("");
  const [savingExpiry, setSavingExpiry]       = useState(false);
  const [licNumVal, setLicNumVal]             = useState("");
  const [siteSafeNumVal, setSiteSafeNumVal]   = useState("");
  const [editingHostBiz, setEditingHostBiz]   = useState(false);
  const [hostBizVal, setHostBizVal]           = useState("");
  const [savingHostBiz, setSavingHostBiz]     = useState(false);
  const [hostCosAdv, setHostCosAdv]           = useState([]);
  useEffect(()=>{ loadTable('crm_companies').then(rows=>setHostCosAdv(rows.filter(r=>r.name).map(r=>({id:r.id,name:r.name,isHostBusiness:r.is_host_business})).sort((a,b)=>(a.name||"").localeCompare(b.name||"")))).catch(()=>{}); },[]);

  const saveHostBiz = async () => {
    setSavingHostBiz(true);
    const updated = {...apprentice, hostBusiness: hostBizVal};
    await upsertUser(updated).catch(console.error);
    setApprentice(prev=>({...prev, hostBusiness: hostBizVal}));
    if(onUserUpdated) onUserUpdated(updated);
    if(hostBizVal.trim()) {
      const match = hostCosAdv.find(c=>c.name.toLowerCase().trim()===hostBizVal.toLowerCase().trim());
      if(match && !match.isHostBusiness) {
        await upsertRow('crm_companies', {id:match.id, is_host_business:true}).catch(console.error);
        setHostCosAdv(prev=>prev.map(c=>c.id===match.id?{...c,isHostBusiness:true}:c));
      }
    }
    setEditingHostBiz(false);
    setSavingHostBiz(false);
  };

  // Draggable section order — default: actions bar first
  const ADV_SECTION_DEFAULT = ["actions","personal","goals","leave","timesheet"];
  const { order: sectionOrder, dragProps: sectionDrag } = useDraggableOrder(
    (viewer?.id||"admin") + "_appdetail_" + apprenticeProp.id,
    ADV_SECTION_DEFAULT
  );

  const saveExpiry = async (field, val) => {
    setSavingExpiry(true);
    const dbField = field==="licence"?"licence_expiry":field==="siteSafe"?"site_safe_expiry":field==="firstAid"?"first_aid_expiry":field==="licenceNum"?"licence_number":"site_safe_number";
    const stateField = field==="licence"?"licenceExpiry":field==="siteSafe"?"siteSafeExpiry":field==="firstAid"?"firstAidExpiry":field==="licenceNum"?"licenceNumber":"siteSafeNumber";
    const updated = {...apprentice, [stateField]: val||null};
    await upsertUser(updated).catch(console.error);
    setApprentice(prev=>({...prev,[stateField]:val||null}));
    if(onUserUpdated) onUserUpdated(updated);
    setEditingExpiry(null);
    setSavingExpiry(false);
  };

  useEffect(()=>{
    loadTable('meeting_reports')
      .then(rows=>{
        const sorted = rows.filter(r=>r.apprentice_id===apprentice.id).sort((a,b)=>b.date.localeCompare(a.date));
        setReports(sorted);
        setLastVisit(sorted[0]?.date||null);
      })
      .catch(()=>{ setReports([]); setLastVisit(null); })
      .finally(()=>setLoadingVisit(false));
  },[apprentice.id, meetingKey]);

  const fmtDate = (iso) => { if(!iso) return null; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };
  const daysUntil = (iso) => { if(!iso) return null; const today=new Date(); today.setHours(0,0,0,0); const exp=new Date(iso+"T00:00:00"); return Math.round((exp-today)/86400000); };

  const licDays = daysUntil(apprentice.licenceExpiry);
  const licColor = licDays===null?T.muted:licDays<0?T.red:licDays<=7?T.red:licDays<=30?T.warn:T.teal;

  const lastReport    = reports[0] || null;
  const prevReport    = reports[1] || null;

  // Timesheet entries for this apprentice (admin view)
  const appEntries = (entries||[]).filter(e=>e.userId===apprentice.id).sort((a,b)=>b.date.localeCompare(a.date));
  const approvedH  = appEntries.filter(e=>e.approval==="approved").reduce((s,e)=>s+e.netHours,0).toFixed(1);
  const submittedH = appEntries.filter(e=>e.approval==="submitted").reduce((s,e)=>s+e.netHours,0).toFixed(1);

  // Approver for this apprentice
  const approver = allUsers.find(u=>
    u.id===apprentice.approverUserId ||
    (u.role==="Approver"&&(u.allocatedTo||[]).includes(apprentice.id))
  );
  // Viewer for this apprentice
  const allocatedViewer = allUsers.find(u=>
    u.id===apprentice.viewerUserId ||
    (u.role==="Viewer"&&(u.allocatedTo||[]).includes(apprentice.id))
  );
  // Mentor for this apprentice
  const mentor = allUsers.find(u=>
    u.id===apprentice.mentorUserId ||
    (u.role==="Mentor"&&(u.allocatedTo||[]).includes(apprentice.id))
  );
  // Supervisors for this apprentice (multiple, stored as supervisorIds array)
  const supervisors = allUsers.filter(u=>
    u.role==="Supervisor" && (apprentice.supervisorIds||[]).includes(u.id)
  );

  const isSupervisor = (apprentice.supervisorIds||[]).includes(viewer?.id||"");
  const ratingColor = (r) => r==="Excellent"?T.teal:r==="Good"?T.accent:r==="Satisfactory"?T.gold:r==="Needs Improvement"?T.warn:r==="Concerning"?T.red:T.muted;

  return (
    <div className="fu">
      <button onClick={onBack} style={{
        display:"inline-flex",alignItems:"center",gap:6,background:"none",border:"none",
        color:T.sub,fontSize:14,fontFamily:"DM Sans,sans-serif",cursor:"pointer",
        marginBottom:16,padding:0,fontWeight:700}}
        onMouseEnter={e=>e.currentTarget.style.color=T.ink}
        onMouseLeave={e=>e.currentTarget.style.color=T.sub}>
        ← {isAdmin?"Back to Dashboard":"Back to My Apprentices"}
      </button>

      {/* ── Card 1: Apprentice Summary ── */}
      <Card style={{marginBottom:16,border:`2px solid ${T.dark}33`}}>
        <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:16,
          paddingBottom:16,borderBottom:`1px solid ${T.border}`}}>
          <div style={{width:54,height:54,borderRadius:"50%",flexShrink:0,
            background:T.dark,display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:25,fontWeight:700,color:"#fff",fontFamily:"DM Sans"}}>
            {apprentice.name?.[0]?.toUpperCase()||"?"}
          </div>
          <div style={{flex:1}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{fontFamily:"DM Sans",fontSize:25,fontWeight:700,color:T.ink}}>{apprentice.name}</div>
              {canEditExpiry&&<button onClick={()=>setShowEditForm(true)}
                style={{background:T.accentL,border:`1px solid ${T.accent}44`,borderRadius:7,
                  padding:"4px 10px",fontSize:12,fontWeight:700,color:T.accent,cursor:"pointer",
                  fontFamily:"DM Sans,sans-serif",display:"flex",alignItems:"center",gap:4}}>
                ✏️ Edit
              </button>}
            </div>
            <div style={{display:"flex",gap:8,marginTop:4,flexWrap:"wrap"}}>
              <RolePill role="Apprentice" size="sm"/>
              {approver&&<Pill label={`Approver: ${approver.name}`} size="sm" color={T.warn} bg={T.warnL}/>}
              {mentor&&<Pill label={`Mentor: ${mentor.name}`} size="sm" color={T.teal} bg={T.tealL}/>}
              {supervisors.map(s=><Pill key={s.id} label={`Supervisor: ${s.name}`} size="sm" color={T.teal} bg={T.tealL}/>)}
            </div>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,alignItems:"stretch"}}>
          {/* Trade + Licence combined card */}
          {(()=>{
            const d=licDays; const c=licColor;
            const licBg=d===null?T.accentL:d<=7?T.redL:d<=30?T.warnL:T.tealL;
            const licVal=apprentice.licenceExpiry?(d!==null?`${fmtDate(apprentice.licenceExpiry)} (${d<0?"Expired":d===0?"Today":`${d}d`})`:fmtDate(apprentice.licenceExpiry)):"Not set";
            const borderCol=editingExpiry==="licence"||editingExpiry==="licenceNum"?T.accent:T.border;
            return (
              <div style={{background:licBg,borderRadius:10,padding:"10px 14px",border:`1px solid ${borderCol}`,height:"100%",boxSizing:"border-box"}}>
                {/* Trade row */}
                <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:2}}>🔧 Trade</div>
                <div style={{fontSize:14,fontWeight:700,color:T.accent,marginBottom:10,paddingBottom:10,borderBottom:`1px solid ${T.border}44`}}>{apprentice.trade||"Not set"}</div>
                {/* Licence expiry row */}
                <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:3,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span>📄 Licence Expiry</span>
                  {canEditExpiry&&editingExpiry!=="licence"&&<button onClick={()=>{setEditingExpiry("licence");setExpiryVal(apprentice.licenceExpiry||"");}} style={{background:"none",border:"none",cursor:"pointer",fontSize:12,color:T.accent,padding:0,fontFamily:"DM Sans,sans-serif"}}>✏️</button>}
                </div>
                {editingExpiry==="licence"?(
                  <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap",marginBottom:8}}>
                    <input type="date" value={expiryVal} onChange={e=>setExpiryVal(e.target.value)} style={{fontSize:13,padding:"3px 6px",borderRadius:5,border:`1px solid ${T.border}`,fontFamily:"DM Sans,sans-serif"}}/>
                    <button onClick={()=>saveExpiry("licence",expiryVal)} disabled={savingExpiry} style={{fontSize:12,padding:"3px 8px",borderRadius:5,background:T.accent,color:"#fff",border:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>{savingExpiry?"…":"Save"}</button>
                    <button onClick={()=>setEditingExpiry(null)} style={{fontSize:12,padding:"3px 6px",borderRadius:5,background:"none",border:`1px solid ${T.border}`,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>✕</button>
                  </div>
                ):<div style={{fontSize:14,fontWeight:700,color:c,marginBottom:8}}>{licVal}</div>}
                {/* Licence number row */}
                <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:3,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span>Licence #</span>
                  {canEditExpiry&&editingExpiry!=="licenceNum"&&<button onClick={()=>{setEditingExpiry("licenceNum");setLicNumVal(apprentice.licenceNumber||"");}} style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:T.accent,padding:0,fontFamily:"DM Sans,sans-serif"}}>✏️</button>}
                </div>
                {editingExpiry==="licenceNum"?(
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>
                    <input value={licNumVal} onChange={e=>setLicNumVal(e.target.value)} placeholder="e.g. LBP123456"
                      style={{fontSize:13,padding:"3px 6px",borderRadius:5,border:`1px solid ${T.border}`,fontFamily:"DM Sans,sans-serif",flex:1}}/>
                    <button onClick={()=>saveExpiry("licenceNum",licNumVal)} disabled={savingExpiry} style={{fontSize:12,padding:"3px 8px",borderRadius:5,background:T.accent,color:"#fff",border:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>{savingExpiry?"…":"Save"}</button>
                    <button onClick={()=>setEditingExpiry(null)} style={{fontSize:12,padding:"3px 6px",borderRadius:5,background:"none",border:`1px solid ${T.border}`,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>✕</button>
                  </div>
                ):<div style={{fontSize:13,fontWeight:700,color:apprentice.licenceNumber?T.ink:T.muted,fontStyle:apprentice.licenceNumber?"normal":"italic"}}>{apprentice.licenceNumber||"Not set"}</div>}
              </div>
            );
          })()}
          {/* Last Mentor Visit — static */}
          <div style={{background:T.tealL,borderRadius:10,padding:"10px 14px",border:`1px solid ${T.border}`,height:"100%",boxSizing:"border-box"}}>
            <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:4}}>📅 Last Mentor Visit</div>
            <div style={{fontSize:14,fontWeight:700,color:T.teal}}>{loadingVisit?"…":lastVisit?fmtDate(lastVisit):"No visits yet"}</div>
          </div>
          {/* Site Safe Expiry — editable */}
          {(()=>{
            const d=daysUntil(apprentice.siteSafeExpiry); const c=d===null?T.muted:d<0?T.red:d<=30?T.warn:T.teal;
            const bg=d===null?T.bg:d<0?T.redL:d<=30?T.warnL:T.tealL;
            const val=apprentice.siteSafeExpiry?(d!==null?`${fmtDate(apprentice.siteSafeExpiry)} (${d<0?"Expired":d===0?"Today":`${d}d`})`:fmtDate(apprentice.siteSafeExpiry)):"Not set";
            return (
              <div style={{background:bg,borderRadius:10,padding:"10px 14px",border:`1px solid ${editingExpiry==="siteSafe"||editingExpiry==="siteSafeNum"?T.teal:T.border}`,position:"relative",height:"100%",boxSizing:"border-box"}}>
                <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:4,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span>🦺 Site Safe Expiry</span>
                  {canEditExpiry&&editingExpiry!=="siteSafe"&&<button onClick={()=>{setEditingExpiry("siteSafe");setExpiryVal(apprentice.siteSafeExpiry||"");}} style={{background:"none",border:"none",cursor:"pointer",fontSize:12,color:T.accent,padding:0,fontFamily:"DM Sans,sans-serif"}}>✏️</button>}
                </div>
                {editingExpiry==="siteSafe"?(
                  <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
                    <input type="date" value={expiryVal} onChange={e=>setExpiryVal(e.target.value)} style={{fontSize:13,padding:"3px 6px",borderRadius:5,border:`1px solid ${T.border}`,fontFamily:"DM Sans,sans-serif"}}/>
                    <button onClick={()=>saveExpiry("siteSafe",expiryVal)} disabled={savingExpiry} style={{fontSize:12,padding:"3px 8px",borderRadius:5,background:T.accent,color:"#fff",border:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>{savingExpiry?"…":"Save"}</button>
                    <button onClick={()=>setEditingExpiry(null)} style={{fontSize:12,padding:"3px 6px",borderRadius:5,background:"none",border:`1px solid ${T.border}`,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>✕</button>
                  </div>
                ):<div style={{fontSize:14,fontWeight:700,color:c}}>{val}</div>}
                {/* Site Safe Number */}
                <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${T.border}44`}}>
                  <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:3,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <span>Site Safe #</span>
                    {canEditExpiry&&editingExpiry!=="siteSafeNum"&&<button onClick={()=>{setEditingExpiry("siteSafeNum");setSiteSafeNumVal(apprentice.siteSafeNumber||"");}} style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:T.teal,padding:0,fontFamily:"DM Sans,sans-serif"}}>✏️</button>}
                  </div>
                  {editingExpiry==="siteSafeNum"?(
                    <div style={{display:"flex",gap:4,alignItems:"center"}}>
                      <input value={siteSafeNumVal} onChange={e=>setSiteSafeNumVal(e.target.value)} placeholder="e.g. SS789012"
                        style={{fontSize:13,padding:"3px 6px",borderRadius:5,border:`1px solid ${T.border}`,fontFamily:"DM Sans,sans-serif",flex:1}}/>
                      <button onClick={()=>saveExpiry("siteSafeNum",siteSafeNumVal)} disabled={savingExpiry} style={{fontSize:12,padding:"3px 8px",borderRadius:5,background:T.teal,color:"#fff",border:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>{savingExpiry?"…":"Save"}</button>
                      <button onClick={()=>setEditingExpiry(null)} style={{fontSize:12,padding:"3px 6px",borderRadius:5,background:"none",border:`1px solid ${T.border}`,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>✕</button>
                    </div>
                  ):<div style={{fontSize:13,fontWeight:700,color:apprentice.siteSafeNumber?T.ink:T.muted,fontStyle:apprentice.siteSafeNumber?"normal":"italic"}}>{apprentice.siteSafeNumber||"Not set"}</div>}
                </div>
              </div>
            );
          })()}
          {/* First Aid Expiry — editable */}
          {(()=>{
            const d=daysUntil(apprentice.firstAidExpiry); const c=d===null?T.muted:d<0?T.red:d<=30?T.warn:T.teal;
            const bg=d===null?T.bg:d<0?T.redL:d<=30?T.warnL:T.tealL;
            const val=apprentice.firstAidExpiry?(d!==null?`${fmtDate(apprentice.firstAidExpiry)} (${d<0?"Expired":d===0?"Today":`${d}d`})`:fmtDate(apprentice.firstAidExpiry)):"Not set";
            return (
              <div style={{background:bg,borderRadius:10,padding:"10px 14px",border:`1px solid ${editingExpiry==="firstAid"?T.teal:T.border}`,position:"relative",height:"100%",boxSizing:"border-box"}}>
                <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:4,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span>🩹 First Aid Expiry</span>
                  {canEditExpiry&&editingExpiry!=="firstAid"&&<button onClick={()=>{setEditingExpiry("firstAid");setExpiryVal(apprentice.firstAidExpiry||"");}} style={{background:"none",border:"none",cursor:"pointer",fontSize:12,color:T.accent,padding:0,fontFamily:"DM Sans,sans-serif"}}>✏️</button>}
                </div>
                {editingExpiry==="firstAid"?(
                  <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
                    <input type="date" value={expiryVal} onChange={e=>setExpiryVal(e.target.value)} style={{fontSize:13,padding:"3px 6px",borderRadius:5,border:`1px solid ${T.border}`,fontFamily:"DM Sans,sans-serif"}}/>
                    <button onClick={()=>saveExpiry("firstAid",expiryVal)} disabled={savingExpiry} style={{fontSize:12,padding:"3px 8px",borderRadius:5,background:T.accent,color:"#fff",border:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>{savingExpiry?"…":"Save"}</button>
                    <button onClick={()=>setEditingExpiry(null)} style={{fontSize:12,padding:"3px 6px",borderRadius:5,background:"none",border:`1px solid ${T.border}`,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>✕</button>
                  </div>
                ):<div style={{fontSize:14,fontWeight:700,color:c}}>{val}</div>}
              </div>
            );
          })()}
          {/* Host Business — editable for Admin/Mentor */}
          <div style={{background:T.slateL,borderRadius:10,padding:"10px 14px",border:`1px solid ${T.border}`,height:"100%",boxSizing:"border-box"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
              <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px"}}>🏢 Host Business</div>
              {canEditExpiry&&!editingHostBiz&&(
                <button onClick={()=>{setEditingHostBiz(true);setHostBizVal(apprentice.hostBusiness||"");}}
                  style={{background:"none",border:"none",cursor:"pointer",fontSize:12,color:T.slate,padding:0,fontFamily:"DM Sans,sans-serif"}}>✏️</button>
              )}
            </div>
            {editingHostBiz?(
              <div style={{display:"flex",gap:5,alignItems:"center",marginTop:4,flexWrap:"wrap"}}>
                {hostCosAdv.length>0?(()=>{
                  const listed=hostCosAdv.some(c=>c.name===hostBizVal);
                  const hostOnes = hostCosAdv.filter(c=>c.isHostBusiness);
                  const otherOnes = hostCosAdv.filter(c=>!c.isHostBusiness);
                  return(<div style={{flex:1,display:"flex",flexDirection:"column",gap:4}}>
                    <select value={listed?hostBizVal:"__custom__"} onChange={e=>{if(e.target.value!=="__custom__")setHostBizVal(e.target.value);}}
                      style={{fontSize:13,padding:"4px 8px",borderRadius:5,border:`1px solid ${T.border}`,fontFamily:"DM Sans,sans-serif",width:"100%"}}>
                      <option value="">— Select host business —</option>
                      {hostOnes.length>0&&<optgroup label="🏢 Host Businesses">
                        {hostOnes.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}
                      </optgroup>}
                      {otherOnes.length>0&&<optgroup label="All Companies">
                        {otherOnes.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}
                      </optgroup>}
                      <option value="__custom__">Other (type below)…</option>
                    </select>
                    {!listed&&<input value={hostBizVal} onChange={e=>setHostBizVal(e.target.value)}
                      placeholder="Type host business name…"
                      style={{fontSize:13,padding:"4px 8px",borderRadius:5,border:`1px solid ${T.border}`,fontFamily:"DM Sans,sans-serif",width:"100%"}}/>}
                    {listed&&!hostCosAdv.find(c=>c.name===hostBizVal)?.isHostBusiness&&hostBizVal&&(
                      <div style={{fontSize:12,color:T.teal}}>✓ Will be flagged as a Host Business in CRM on save</div>
                    )}
                  </div>);
                })():<input value={hostBizVal} onChange={e=>setHostBizVal(e.target.value)}
                  placeholder="e.g. Sparks Electrical Ltd"
                  style={{fontSize:13,padding:"4px 8px",borderRadius:5,border:`1px solid ${T.border}`,fontFamily:"DM Sans,sans-serif",flex:1}}/>}
                <button onClick={saveHostBiz} disabled={savingHostBiz}
                  style={{fontSize:12,padding:"4px 8px",borderRadius:5,background:T.slate,color:"#fff",border:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>{savingHostBiz?"…":"Save"}</button>
                <button onClick={()=>setEditingHostBiz(false)}
                  style={{fontSize:12,padding:"4px 6px",borderRadius:5,background:"none",border:`1px solid ${T.border}`,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>✕</button>
              </div>
            ):( 
              <div>
                <div style={{fontSize:14,fontWeight:700,color:T.slate}}>{apprentice.hostBusiness||"Not set"}</div>
                {(approver||allocatedViewer||supervisors.length>0)&&apprentice.hostBusiness&&(
                  <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:8}}>
                    {approver&&(
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:11,fontWeight:700,color:T.warn,textTransform:"uppercase",letterSpacing:".5px",minWidth:52}}>Approver</span>
                        <span style={{fontSize:13,fontWeight:700,color:T.ink,background:T.warnL,
                          padding:"2px 8px",borderRadius:10,border:`1px solid ${T.warn}33`}}>
                          {approver.name}
                        </span>
                      </div>
                    )}
                    {allocatedViewer&&(
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:11,fontWeight:700,color:T.blue,textTransform:"uppercase",letterSpacing:".5px",minWidth:52}}>Viewer</span>
                        <span style={{fontSize:13,fontWeight:700,color:T.ink,background:T.blueL,
                          padding:"2px 8px",borderRadius:10,border:`1px solid ${T.blue}33`}}>
                          {allocatedViewer.name}
                        </span>
                      </div>
                    )}
                    {supervisors.map(s=>(
                      <div key={s.id} style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:11,fontWeight:700,color:T.teal,textTransform:"uppercase",letterSpacing:".5px",minWidth:52}}>Supervisor</span>
                        <span style={{fontSize:13,fontWeight:700,color:T.ink,background:T.tealL,
                          padding:"2px 8px",borderRadius:10,border:`1px solid ${T.teal}33`}}>
                          {s.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Reports Go To */}
          {(apprentice.reportsEmail || isAdmin) && (
            <div style={{background:T.accentL,borderRadius:10,padding:"10px 14px",border:`1px solid ${T.accent}33`,height:"100%",boxSizing:"border-box"}}>
              <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:4}}>📧 Reports Go To</div>
              {apprentice.reportsEmail
                ? <div style={{fontSize:13,fontWeight:700,color:T.accent}}>
                    {apprentice.reportsEmail.split(",").map(e=>e.trim()).filter(Boolean).map((e,i)=>(
                      <div key={e}>{e}</div>
                    ))}
                  </div>
                : <div style={{fontSize:13,color:T.muted,fontStyle:"italic"}}>Not set — reports go to approver</div>
              }
            </div>
          )}
        </div>
      </Card>

      {/* ── Draggable sections — admin view ── */}
      {sectionOrder.map(sectionId => {
        if(sectionId==="actions") return (
          <DraggableSection key="actions" id="actions" dragProps={sectionDrag}>
            {(isAdmin||isSupervisor) ? (
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr 1fr", gap:10, marginBottom:12}}>
                <button onClick={()=>{setShowMeetingForm(s=>!s); setShowPastReports(false); setShowPPE(false); setShowActivity(false); setShowHSEForm(false); setShowPastHSE(false);}}
                  style={{width:"100%", background:showMeetingForm?T.accentL:T.surface, border:`1.5px solid ${showMeetingForm?T.accent:T.border}`, borderRadius:10, padding:"10px 12px", cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif", transition:"all .15s", display:isAdmin?"":"none"}}>
                  <div style={{display:"flex", alignItems:"center", gap:8}}>
                    <div style={{width:28,height:28,borderRadius:7,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>📋</div>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:700, fontSize:13, color:showMeetingForm?T.accent:T.ink}}>New Report</div>
                      <div style={{fontSize:11, color:T.sub, marginTop:1}}>Record a visit</div>
                    </div>
                    <div style={{marginLeft:"auto", fontSize:12, color:T.muted}}>↗</div>
                  </div>
                </button>
                <button onClick={()=>{setShowPastReports(s=>!s); setShowMeetingForm(false); setShowPPE(false); setShowActivity(false); setShowHSEForm(false); setShowPastHSE(false);}}
                  style={{width:"100%", background:showPastReports?T.goldL:T.surface, border:`1.5px solid ${showPastReports?T.gold:T.border}`, borderRadius:10, padding:"10px 12px", cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif", transition:"all .15s"}}>
                  <div style={{display:"flex", alignItems:"center", gap:8}}>
                    <div style={{width:28,height:28,borderRadius:7,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>📁</div>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:700, fontSize:13, color:showPastReports?T.gold:T.ink}}>Past Reports</div>
                      <div style={{fontSize:11, color:T.sub, marginTop:1}}>Visit history</div>
                    </div>
                    <div style={{marginLeft:"auto", fontSize:12, color:T.muted}}>{showPastReports?"▲":"▼"}</div>
                  </div>
                </button>
                <button onClick={()=>{setShowPPE(s=>!s); setShowMeetingForm(false); setShowPastReports(false); setShowActivity(false); setShowHSEForm(false); setShowPastHSE(false);}}
                  style={{width:"100%", background:showPPE?T.tealL:T.surface, border:`1.5px solid ${showPPE?T.teal:T.border}`, borderRadius:10, padding:"10px 12px", cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif", transition:"all .15s", display:isAdmin?"":"none"}}>
                  <div style={{display:"flex", alignItems:"center", gap:8}}>
                    <div style={{width:28,height:28,borderRadius:7,background:T.tealL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>🦺</div>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:700, fontSize:13, color:showPPE?T.teal:T.ink}}>PPE</div>
                      <div style={{fontSize:11, color:T.sub, marginTop:1}}>Equipment issued</div>
                    </div>
                    <div style={{marginLeft:"auto", fontSize:12, color:T.muted}}>{showPPE?"▲":"▼"}</div>
                  </div>
                </button>
                <button onClick={()=>{setShowActivity(s=>!s); setShowMeetingForm(false); setShowPastReports(false); setShowPPE(false); setShowHSEForm(false); setShowPastHSE(false);}}
                  style={{width:"100%", background:showActivity?T.slateL:T.surface, border:`1.5px solid ${showActivity?T.slate:T.border}`, borderRadius:10, padding:"10px 12px", cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif", transition:"all .15s", display:isAdmin?"":"none"}}>
                  <div style={{display:"flex", alignItems:"center", gap:8}}>
                    <div style={{width:28,height:28,borderRadius:7,background:T.slateL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>📬</div>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:700, fontSize:13, color:showActivity?T.slate:T.ink}}>Activity</div>
                      <div style={{fontSize:11, color:T.sub, marginTop:1}}>Emails & notes</div>
                    </div>
                    <div style={{marginLeft:"auto", fontSize:12, color:T.muted}}>{showActivity?"▲":"▼"}</div>
                  </div>
                </button>
                <button onClick={()=>{setShowHSEForm(s=>!s); setShowPastHSE(false); setShowMeetingForm(false); setShowPastReports(false); setShowPPE(false); setShowActivity(false);}}
                  style={{width:"100%", background:showHSEForm?"#fff0f0":T.surface, border:`1.5px solid ${showHSEForm?"#e05c5c":T.border}`, borderRadius:10, padding:"10px 12px", cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif", transition:"all .15s"}}>
                  <div style={{display:"flex", alignItems:"center", gap:8}}>
                    <div style={{width:28,height:28,borderRadius:7,background:"#fff0f0",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>🦺</div>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:700, fontSize:13, color:showHSEForm?"#c0392b":T.ink}}>HSE Check In</div>
                      <div style={{fontSize:11, color:T.sub, marginTop:1}}>New check in</div>
                    </div>
                    <div style={{marginLeft:"auto", fontSize:12, color:T.muted}}>↗</div>
                  </div>
                </button>
                <button onClick={()=>{setShowPastHSE(s=>!s); setShowHSEForm(false); setShowMeetingForm(false); setShowPastReports(false); setShowPPE(false); setShowActivity(false);}}
                  style={{width:"100%", background:showPastHSE?"#fff0f0":T.surface, border:`1.5px solid ${showPastHSE?"#e05c5c":T.border}`, borderRadius:10, padding:"10px 12px", cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif", transition:"all .15s"}}>
                  <div style={{display:"flex", alignItems:"center", gap:8}}>
                    <div style={{width:28,height:28,borderRadius:7,background:"#fff0f0",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>📋</div>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:700, fontSize:13, color:showPastHSE?"#c0392b":T.ink}}>Past HSE</div>
                      <div style={{fontSize:11, color:T.sub, marginTop:1}}>HSE history</div>
                    </div>
                    <div style={{marginLeft:"auto", fontSize:12, color:T.muted}}>{showPastHSE?"▲":"▼"}</div>
                  </div>
                </button>
              </div>
            ) : null}
            {/* Expanded panels */}
            {showHSEForm && (
              <Card style={{marginBottom:16}}>
                <HSECheckinForm apprentice={apprentice} viewer={viewer} onSave={()=>{setShowHSEForm(false);}} onCancel={()=>setShowHSEForm(false)}/>
              </Card>
            )}
            {showPastHSE && (
              <Card style={{marginBottom:16}}>
                <PastHSECheckins apprentice={apprentice} allUsers={allUsers} canEdit={isAdmin&&!isSupervisor}/>
              </Card>
            )}
            {showPastReports && (isAdmin||isSupervisor) && (
              <Card style={{marginBottom:16}}><PastMeetingReports key={meetingKey} apprentice={apprentice} allUsers={allUsers} canEdit={true} isAdmin1={Number(viewer?.adminLevel ?? 1)===1&&viewer?.role==="Admin"}/></Card>
            )}
            {showPPE && isAdmin && (
              <Card style={{marginBottom:16}}><PPEAllocation apprentice={apprentice} mentor={viewer} canEdit={true}/></Card>
            )}
            {showActivity && isAdmin && apprentice.email && (
              <Card style={{marginBottom:16}}>
                <EmailActivityFeed personEmail={apprentice.email} personName={apprentice.name} personId={apprentice.id} canEdit={true} isKristeena={isConfOwner(viewer)} isAdmin1={Number(viewer?.adminLevel ?? 1)===1&&viewer?.role==="Admin"}
                  extraItems={reports.map(r=>({id:r.id,created_at:r.created_at||r.date+"T12:00:00",date:r.date,
                    label:`Meeting Report — ${r.date?(()=>{const[y,m,d]=r.date.split('-');return`${d}/${m}/${y}`;})():""}`,
                    detail:r.goals_this_meeting?`Goals: ${r.goals_this_meeting}`:r.comments_feedback||""}))}/>
              </Card>
            )}
          </DraggableSection>
        );
        if(sectionId==="personal") return (
          <DraggableSection key="personal" id="personal" dragProps={sectionDrag}>
            {/* ── Personal Details card ── */}
            {(()=>{
              const savePd = async () => {
                setPdSaving(true);
                const updated = {...apprentice, ...pdForm,
                  startDate: pdForm.startDate||null,
                  dateOfBirth: pdForm.dateOfBirth||null,
                  emergencyContactName: pdForm.emergencyContactName||"",
                  emergencyContactPhone: pdForm.emergencyContactPhone||"",
                  emergencyContactRelationship: pdForm.emergencyContactRelationship||"",
                };
                await upsertUser(updated).catch(console.error);
                setApprentice(updated);
                if(onUserUpdated) onUserUpdated(updated);
                setPdEdit(false);
                setPdSaving(false);
              };
              const inp = (field, label, type="text", opts=null) => (
                <div key={field} style={{display:"flex",flexDirection:"column",gap:4}}>
                  <label style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px"}}>{label}</label>
                  {opts ? (
                    <select value={pdForm[field]} onChange={e=>setPdForm(p=>({...p,[field]:e.target.value}))}
                      style={{fontSize:14,padding:"7px 10px",borderRadius:7,border:`1.5px solid ${T.border}`,
                        background:T.surface,color:T.ink,fontFamily:"DM Sans,sans-serif"}}>
                      <option value="">Not set</option>
                      {opts.map(o=><option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input type={type} value={pdForm[field]}
                      onChange={e=>setPdForm(p=>({...p,[field]:e.target.value}))}
                      style={{fontSize:14,padding:"7px 10px",borderRadius:7,border:`1.5px solid ${T.border}`,
                        background:T.surface,color:T.ink,fontFamily:"DM Sans,sans-serif"}}/>
                  )}
                </div>
              );
              const readRow = (label, value, icon) => (
                <div key={label} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"9px 0",
                  borderBottom:`1px solid ${T.border}`}}>
                  <span style={{fontSize:17,marginTop:1,width:20,textAlign:"center",flexShrink:0}}>{icon}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>{label}</div>
                    <div style={{fontSize:14,color:value?T.ink:T.muted,fontStyle:value?"normal":"italic"}}>{value||"Not set"}</div>
                  </div>
                </div>
              );
              const addrDisplay = [apprentice.address,apprentice.addressLine2,apprentice.suburb,apprentice.city,apprentice.postcode].filter(Boolean).join(", ");
              return (
                <Card style={{marginBottom:16,cursor:pdEdit?"default":"pointer"}}
                  onClick={()=>{ if(!pdEdit) setShowPersonal(s=>!s); }}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div style={{fontWeight:700,fontSize:16,display:"flex",alignItems:"center",gap:8}}>
                      <span>👤</span> Personal Details
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8}} onClick={e=>e.stopPropagation()}>
                      {showPersonal&&isAdmin&&!pdEdit&&(
                        <button onClick={()=>{
                          setPdForm({
                            email:apprentice.email||"",phone:apprentice.phone||"",
                            startDate:apprentice.startDate||"",dateOfBirth:apprentice.dateOfBirth||"",
                            gender:apprentice.gender||"",hostBusiness:apprentice.hostBusiness||"",
                            address:apprentice.address||"",addressLine2:apprentice.addressLine2||"",
                            suburb:apprentice.suburb||"",city:apprentice.city||"",postcode:apprentice.postcode||"",
                            emergencyContactName:apprentice.emergencyContactName||"",
                            emergencyContactPhone:apprentice.emergencyContactPhone||"",
                            emergencyContactRelationship:apprentice.emergencyContactRelationship||"",
                          });
                          setPdEdit(true);
                        }} style={{fontSize:13,color:T.accent,background:T.accentL,border:"none",
                          borderRadius:6,padding:"4px 12px",cursor:"pointer",fontWeight:700,fontFamily:"DM Sans,sans-serif"}}>
                          ✏ Edit
                        </button>
                      )}
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.muted} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                        style={{transition:"transform .2s",transform:showPersonal?"rotate(180deg)":"rotate(0deg)",cursor:"pointer"}}
                        onClick={e=>{e.stopPropagation();setShowPersonal(s=>!s);}}>
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                    </div>
                  </div>
                  {showPersonal&&(
                    <div onClick={e=>e.stopPropagation()} style={{marginTop:14}}>
                      {pdEdit ? (
                        <>
                          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12,marginBottom:12}}>
                            {inp("email","Email","email")}
                            {inp("phone","Phone","tel")}
                            {inp("mobile","Mobile","tel")}
                            {inp("startDate","Start Date","date")}
                            {inp("dateOfBirth","Date of Birth","date")}
                            {inp("gender","Gender","text",["Male","Female","Non-binary","Prefer not to say"])}
                            {inp("hostBusiness","Host Business")}
                          </div>
                          <div style={{borderTop:`1px solid ${T.border}`,paddingTop:12,marginBottom:12}}>
                            <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:10}}>📍 Address</div>
                            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12}}>
                              {inp("address","Street Address")}
                              {inp("addressLine2","Address Line 2")}
                              {inp("suburb","Suburb")}
                              {inp("city","City")}
                              {inp("postcode","Postcode")}
                            </div>
                          </div>
                          <div style={{borderTop:`1px solid ${T.border}`,paddingTop:12,marginBottom:12}}>
                            <div style={{fontSize:12,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:".5px",marginBottom:10}}>🚨 Emergency Contact</div>
                            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12}}>
                              {inp("emergencyContactName","Name")}
                              {inp("emergencyContactPhone","Phone","tel")}
                              {inp("emergencyContactRelationship","Relationship")}
                            </div>
                          </div>
                          <div style={{display:"flex",gap:8}}>
                            <button onClick={savePd} disabled={pdSaving}
                              style={{background:T.accent,color:"#fff",border:"none",borderRadius:8,
                                padding:"8px 20px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                              {pdSaving?"Saving…":"💾 Save"}
                            </button>
                            <button onClick={()=>setPdEdit(false)} disabled={pdSaving}
                              style={{background:T.bg,color:T.sub,border:`1.5px solid ${T.border}`,borderRadius:8,
                                padding:"8px 16px",fontSize:14,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 24px"}}>
                            {readRow("Email", apprentice.email, "✉")}
                            {readRow("Phone", apprentice.phone, "📞")}
                            {readRow("Mobile", apprentice.mobile, "📱")}
                            {readRow("Start Date", apprentice.startDate?fmtDate(apprentice.startDate):null, "📅")}
                            {readRow("Date of Birth", apprentice.dateOfBirth?fmtDate(apprentice.dateOfBirth):null, "🎂")}
                            {readRow("Gender", apprentice.gender, "⚧")}
                            {readRow("Host Business", apprentice.hostBusiness, "🏢")}
                          </div>
                          <div style={{display:"flex",alignItems:"flex-start",gap:10,paddingTop:9}}>
                            <span style={{fontSize:17,marginTop:1,width:20,textAlign:"center",flexShrink:0}}>📍</span>
                            <div>
                              <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>Address</div>
                              <div style={{fontSize:14,color:addrDisplay?T.ink:T.muted,fontStyle:addrDisplay?"normal":"italic",lineHeight:1.6}}>
                                {addrDisplay||"Not set"}
                              </div>
                            </div>
                          </div>
                          {(apprentice.emergencyContactName||apprentice.emergencyContactPhone)&&(
                            <div style={{marginTop:12,padding:"10px 14px",borderRadius:8,
                              background:T.redL+"66",border:`1px solid ${T.red}33`}}>
                              <div style={{fontSize:12,fontWeight:700,color:T.red,textTransform:"uppercase",
                                letterSpacing:".5px",marginBottom:8}}>🚨 Emergency Contact</div>
                              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:"6px 16px"}}>
                                {apprentice.emergencyContactName&&(
                                  <div>
                                    <div style={{fontSize:11,color:T.muted,fontWeight:700,marginBottom:1}}>Name</div>
                                    <div style={{fontSize:14,fontWeight:700,color:T.ink}}>{apprentice.emergencyContactName}</div>
                                  </div>
                                )}
                                {apprentice.emergencyContactRelationship&&(
                                  <div>
                                    <div style={{fontSize:11,color:T.muted,fontWeight:700,marginBottom:1}}>Relationship</div>
                                    <div style={{fontSize:14,color:T.ink}}>{apprentice.emergencyContactRelationship}</div>
                                  </div>
                                )}
                                {apprentice.emergencyContactPhone&&(
                                  <div>
                                    <div style={{fontSize:11,color:T.muted,fontWeight:700,marginBottom:1}}>Phone</div>
                                    <a href={`tel:${apprentice.emergencyContactPhone}`}
                                      style={{fontSize:14,color:T.accent,fontWeight:700,textDecoration:"none"}}>
                                      {apprentice.emergencyContactPhone}
                                    </a>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </Card>
              );
            })()}
          </DraggableSection>
        );
        if(sectionId==="goals") return (
          <DraggableSection key="goals" id="goals" dragProps={sectionDrag}>
            {/* ── Goals cards ── */}
      <div style={{display:"grid",gridTemplateColumns:prevReport?"1fr 1fr":"1fr",gap:12,marginBottom:16}}>
        {/* Goals from last meeting */}
        <Card style={{border:`1.5px solid ${T.accent}33`}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
            <div style={{width:32,height:32,borderRadius:8,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🎯</div>
            <div>
              <div style={{fontWeight:700,fontSize:16}}>Goals from Last Meeting</div>
              {lastReport&&<div style={{fontSize:12,color:T.sub}}>{fmtDate(lastReport.date)}</div>}
            </div>
          </div>
          {lastReport?.goals_this_meeting
            ? <div style={{fontSize:14,color:T.ink,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{lastReport.goals_this_meeting}</div>
            : <div style={{fontSize:13,color:T.muted,fontStyle:"italic"}}>{lastReport?"No goals recorded for this visit":"No meeting reports yet"}</div>
          }
          {lastReport?.rating&&(
            <div style={{marginTop:10,display:"inline-flex",alignItems:"center",gap:6,
              background:ratingColor(lastReport.rating)+"15",borderRadius:6,padding:"3px 10px"}}>
              <span style={{fontSize:13,fontWeight:700,color:ratingColor(lastReport.rating)}}>{lastReport.rating}</span>
            </div>
          )}
        </Card>

        {/* Goals from meeting before */}
        {prevReport&&(
          <Card style={{border:`1.5px solid ${T.gold}33`}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <div style={{width:32,height:32,borderRadius:8,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📌</div>
              <div>
                <div style={{fontWeight:700,fontSize:16}}>Goals from Previous Meeting</div>
                <div style={{fontSize:12,color:T.sub}}>{fmtDate(prevReport.date)}</div>
              </div>
            </div>
            {prevReport.goals_this_meeting
              ? <div style={{fontSize:14,color:T.ink,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{prevReport.goals_this_meeting}</div>
              : <div style={{fontSize:13,color:T.muted,fontStyle:"italic"}}>No goals recorded for this visit</div>
            }
            {prevReport.rating&&(
              <div style={{marginTop:10,display:"inline-flex",alignItems:"center",gap:6,
                background:ratingColor(prevReport.rating)+"15",borderRadius:6,padding:"3px 10px"}}>
                <span style={{fontSize:13,fontWeight:700,color:ratingColor(prevReport.rating)}}>{prevReport.rating}</span>
              </div>
            )}
          </Card>
        )}
          </div>
          </DraggableSection>
        );
        if(sectionId==="timesheet") return (
          <DraggableSection key="timesheet" id="timesheet" dragProps={sectionDrag}>
            {isAdmin && (
              <Card style={{marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
            <div style={{width:36,height:36,borderRadius:10,background:T.blueL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:19}}>⏱</div>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:17}}>Timesheet Summary</div>
              <div style={{fontSize:13,color:T.sub}}>All entries for {apprentice.name}</div>
            </div>
            {Number(viewer?.adminLevel ?? 1)===1 && viewer?.role==="Admin" && setEntries && (
              <button
                onClick={()=>setShowTimesheetAdd(s=>!s)}
                style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",
                  background:showTimesheetAdd?"#e8f0fe":T.accentL,
                  border:`1.5px solid ${showTimesheetAdd?"#3b5bdb":T.accent}`,
                  borderRadius:8,cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                  fontWeight:700,fontSize:13,color:showTimesheetAdd?"#3b5bdb":T.accent,
                  transition:"all .15s"}}>
                {showTimesheetAdd ? "▲ Close" : "+ Add Entry"}
              </button>
            )}
          </div>
          {showTimesheetAdd && Number(viewer?.adminLevel ?? 1)===1 && viewer?.role==="Admin" && setEntries && (
            <div style={{marginBottom:16,borderBottom:`1px solid ${T.border}`,paddingBottom:16}}>
              <TimesheetModule
                currentUser={viewer}
                allUsers={allUsers}
                entries={entries}
                setEntries={setEntries}
                forcedApprenticeId={apprentice.id}
              />
            </div>
          )}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:10,marginBottom:16}}>
            {[
              {label:"Total Entries",   value: appEntries.length,                                           color:T.accent},
              {label:"Approved Hours",  value: `${approvedH}h`,                                             color:T.teal},
              {label:"Pending (hrs)",   value: `${submittedH}h`,                                            color:T.warn},
              {label:"Drafts",          value: appEntries.filter(e=>e.approval==="draft").length,            color:T.muted},
              {label:"Declined",        value: appEntries.filter(e=>e.approval==="declined").length,         color:T.red},
            ].map(({label,value,color})=>(
              <div key={label} style={{background:T.bg,borderRadius:10,padding:"10px 14px",border:`1px solid ${T.border}`,textAlign:"center"}}>
                <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:4}}>{label}</div>
                <div style={{fontSize:22,fontWeight:700,color,fontFamily:"'Libre Baskerville'"}}>{value}</div>
              </div>
            ))}
          </div>
          {/* Recent entries list */}
          {appEntries.length>0&&(
            <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 70px 90px",
                padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
                <span>Date</span><span>Type / Note</span><span style={{textAlign:"center"}}>Hours</span><span>Status</span><span>Start–End</span>
              </div>
              {appEntries.slice(0,20).map((e,i)=>{
                const am = APPROVAL_META[e.approval]||APPROVAL_META.draft;
                const tm = TYPE_META[e.type]||TYPE_META["Normal Hours"];
                return (
                  <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 70px 90px",
                    padding:"9px 14px",gap:8,alignItems:"center",fontSize:14,
                    borderBottom:i<Math.min(appEntries.length,20)-1?`1px solid ${T.border}44`:"none",
                    background:i%2===0?T.surface:T.bg}}>
                    <div style={{fontWeight:700,fontSize:13}}>{fmtD(e.date)}</div>
                    <div>
                      <Pill label={e.type} size="sm" color={tm.color} bg={tm.bg}/>
                      {e.note&&<div style={{fontSize:12,color:T.muted,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note}</div>}
                    </div>
                    <div style={{textAlign:"center",fontWeight:700,color:T.accent}}>{e.netHours}h</div>
                    <Pill label={am.label} size="sm" color={am.color} bg={am.bg}/>
                    <div style={{fontSize:12,color:T.sub}}>{e.start}–{e.end}</div>
                  </div>
                );
              })}
              {appEntries.length>20&&<div style={{padding:"8px 14px",fontSize:13,color:T.muted,textAlign:"center"}}>Showing 20 of {appEntries.length} entries</div>}
            </div>
          )}
              {appEntries.length===0&&<div style={{padding:"20px 0",textAlign:"center",color:T.muted,fontSize:14,fontStyle:"italic"}}>No timesheet entries yet</div>}
            </Card>
          )}
          </DraggableSection>
        );
        if(sectionId==="leave") return (
          <DraggableSection key="leave" id="leave" dragProps={sectionDrag}>
            {(isAdmin||isSupervisor) && (
              <Card style={{marginBottom:16}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
                  <div style={{width:36,height:36,borderRadius:10,background:T.holL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:19}}>🏖</div>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:17}}>Leave Requests</div>
                    <div style={{fontSize:13,color:T.sub}}>All leave for {apprentice.name}</div>
                  </div>
                  <button onClick={()=>{
                    setAdvLeaveLoading(true);
                    loadTable("leave_requests").then(rows=>{
                      setAdvLeave(rows.filter(r=>r.apprentice_id===apprentice.id)
                        .sort((a,b)=>b.created_at.localeCompare(a.created_at)));
                    }).catch(()=>{}).finally(()=>setAdvLeaveLoading(false));
                  }} style={{background:"none",border:`1px solid ${T.border}`,borderRadius:6,padding:"4px 10px",
                    fontSize:12,color:T.muted,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}
                    title="Refresh leave data">↻ Refresh</button>
                </div>
                {advLeaveLoading ? (
                  <div style={{padding:"16px 0",textAlign:"center",color:T.muted,fontSize:14}}>Loading…</div>
                ) : advLeave.length === 0 ? (
                  <div style={{padding:"16px 0",textAlign:"center",color:T.muted,fontSize:14,fontStyle:"italic"}}>No leave requests yet</div>
                ) : (
                  <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
                    {advLeave.map((r,i)=>{
                      const statusMeta = {
                        pending:           {label:"Pending Approver",    bg:T.goldL,  color:T.gold,  icon:"⏳"},
                        approver_approved: {label:"Awaiting KTA",        bg:T.blueL,  color:T.blue,  icon:"✓"},
                        kta_approved:      {label:"Fully Approved",       bg:T.tealL,  color:T.teal,  icon:"✅"},
                        declined:          {label:"Declined",             bg:T.redL,   color:T.red,   icon:"✕"},
                      }[r.status] || {label:r.status, bg:T.bg, color:T.muted, icon:"•"};
                      const fmtD = iso => { if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };
                      return (
                        <div key={r.id} style={{display:"grid",gridTemplateColumns:"1fr 140px 120px 160px",
                          gap:8,padding:"11px 14px",alignItems:"center",
                          borderBottom:i<advLeave.length-1?`1px solid ${T.border}44`:"none",
                          background:i%2===0?T.surface:T.bg}}>
                          <div>
                            <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{r.leave_type}</div>
                            {r.notes&&<div style={{fontSize:12,color:T.muted,marginTop:2,fontStyle:"italic"}}>{r.notes}</div>}
                          </div>
                          <div style={{fontSize:13,color:T.sub}}>
                            {fmtD(r.date_from)}{r.date_to&&r.date_to!==r.date_from?` – ${fmtD(r.date_to)}`:""}</div>
                          <div style={{fontSize:12,color:T.muted}}>{fmtD(r.created_at?.slice(0,10))}</div>
                          <div>
                            <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"3px 10px",
                              borderRadius:99,fontSize:12,fontWeight:700,
                              background:statusMeta.bg,color:statusMeta.color}}>
                              {statusMeta.icon} {statusMeta.label}
                            </span>
                            {r.status==="declined"&&r.decline_reason&&(
                              <div style={{fontSize:12,color:T.red,marginTop:3,fontStyle:"italic"}}>
                                Reason: {r.decline_reason}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            )}
          </DraggableSection>
        );
        return null;
      })}

      {/* Edit apprentice modal */}
      {showEditForm && createPortal(
        <div style={{position:"fixed",inset:0,zIndex:3000,background:"rgba(13,27,46,0.55)",
          display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"40px 20px",overflowY:"auto"}}>
          <div style={{background:"#fff",borderRadius:14,padding:24,maxWidth:760,width:"100%",
            boxShadow:"0 8px 40px rgba(0,0,0,.18)"}}>
            <ApprenticeEditForm
              user={apprentice}
              allUsers={allUsers}
              viewer={viewer}
              title={`✎ Editing — ${apprentice.name}`}
              onSave={(updated) => {
                setApprentice(updated);
                if(onUserUpdated) onUserUpdated(updated);
                setShowEditForm(false);
              }}
              onCancel={()=>setShowEditForm(false)}
            />
          </div>
        </div>,
        document.body
      )}

      {/* Report modal — top-level fixed overlay for both admin and mentor */}
      {showMeetingForm && isAdmin && (
        <ReportFullscreenModal apprentice={apprentice} mentor={viewer} allUsers={allUsers} meetingKey={meetingKey}
          onSave={()=>{ setShowMeetingForm(false); setMeetingKey(k=>k+1); }} onClose={()=>setShowMeetingForm(false)}/>
      )}

      {/* Full cards for mentor view */}
      {!isAdmin && (
        <>
          {showMeetingForm && (
            <ReportFullscreenModal
              apprentice={apprentice}
              mentor={viewer}
              allUsers={allUsers}
              meetingKey={meetingKey}
              onSave={()=>{ setShowMeetingForm(false); setMeetingKey(k=>k+1); }}
              onClose={()=>setShowMeetingForm(false)}
            />
          )}
          <Card style={{marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:36,height:36,borderRadius:10,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:19}}>📋</div>
                <div>
                  <div style={{fontWeight:700,fontSize:17}}>New Meeting Report</div>
                  <div style={{fontSize:13,color:T.sub}}>Record a visit or check-in with {apprentice.name}</div>
                </div>
              </div>
              <Btn onClick={()=>setShowMeetingForm(true)}>+ New Report</Btn>
            </div>
          </Card>
          <Card style={{marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
              <div style={{width:36,height:36,borderRadius:10,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:19}}>📁</div>
              <div>
                <div style={{fontWeight:700,fontSize:17}}>Past Meeting Reports</div>
                <div style={{fontSize:13,color:T.sub}}>History of all visits with {apprentice.name}</div>
              </div>
            </div>
            <PastMeetingReports key={meetingKey} apprentice={apprentice} allUsers={allUsers} canEdit={true} isAdmin1={Number(viewer?.adminLevel ?? 1)===1&&viewer?.role==="Admin"}/>
          </Card>
          <Card style={{marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
              <div style={{width:36,height:36,borderRadius:10,background:T.tealL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:19}}>🦺</div>
              <div>
                <div style={{fontWeight:700,fontSize:17}}>PPE Allocation</div>
                <div style={{fontSize:13,color:T.sub}}>Personal protective equipment issued to {apprentice.name}</div>
              </div>
            </div>
            <PPEAllocation apprentice={apprentice} mentor={viewer} canEdit={true}/>
          </Card>
        </>
      )}

    </div>
  );
}

// Legacy wrapper for Mentor

export default ApprenticeDetailView;
export { ApprenticeConversation };
