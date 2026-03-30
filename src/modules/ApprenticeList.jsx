import { useState, useEffect, useCallback } from "react";
import { T, TRADES, ROLES } from "../constants.js";
import { uid, hashPw, fmtD, daysAgoStr } from "../utils.js";
import { upsertUser, deleteUser as sbDeleteUser, loadTable, deleteRow } from "../supabaseClient.js";
import { Pill, RolePill, FL, Avatar, Btn, Card } from "../shared.jsx";
import ApprenticeEditForm from "./ApprenticeEditForm.jsx";
import { ktaConfirm } from "./LeaveResultScreen.jsx";

function useSort(defaultField="name", defaultDir="asc") {
  const [sortField, setSortField] = useState(defaultField);
  const [sortDir,   setSortDir]   = useState(defaultDir);
  const toggle = useCallback((field) => {
    setSortField(prev => {
      if(prev === field) { setSortDir(d => d==="asc" ? "desc" : "asc"); return prev; }
      setSortDir("asc"); return field;
    });
  }, []);
  const sortFn = useCallback((a,b) => {
    const av = (a[sortField]||"").toString().toLowerCase();
    const bv = (b[sortField]||"").toString().toLowerCase();
    return sortDir==="asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  }, [sortField, sortDir]);
  const SortColHeader = useCallback(({field, children, style={}}) => {
    const active = sortField===field;
    return (
      <span onClick={()=>toggle(field)}
        style={{cursor:"pointer",userSelect:"none",display:"inline-flex",alignItems:"center",gap:2,
          whiteSpace:"nowrap",...style}}>
        {children}
        <span style={{marginLeft:3,fontSize:10,color:"inherit",
          opacity:active?1:0.35,fontWeight:active?700:400}}>
          {active ? (sortDir==="asc" ? "▲" : "▼") : "▲"}
        </span>
      </span>
    );
  }, [sortField, sortDir, toggle]);
  return {sortField, sortDir, toggle, sortFn, ColHeader: SortColHeader};
}

function ApprenticeList({allUsers, setUsers, onViewTimesheet, currentUser=null}) {
  const {sortFn:alSort, ColHeader:ALCol} = useSort("name","asc");
  const apprenticesRaw = [...allUsers.filter(u => u.role === "Apprentice")];
  const apprentices = apprenticesRaw.sort(alSort);
  const approvers   = allUsers.filter(u => u.role === "Approver" || u.role === "Admin");
  const viewers     = allUsers.filter(u => u.role === "Viewer"   || u.role === "Admin");
  const mentors     = allUsers.filter(u => u.role === "Mentor"   || u.role === "Admin");
  const getSupervisorsForApprenticee = (hostBiz) => allUsers.filter(u => ["Supervisor","Approver","Viewer"].includes(u.role) && (!hostBiz || (u.company||"").toLowerCase().trim()===(hostBiz||"").toLowerCase().trim()));

  const blank = {firstName:"", lastName:"", email:"", phone:"", trade:"", licenceExpiry:"", siteSafeExpiry:"", firstAidExpiry:"", hostBusiness:"", role:"Apprentice", allocatedTo:[], password:"", overtimeType:null, overtimeThreshold:"", overtimeRateId:"", reportsEmail:""};
  const [form, setForm]         = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState(null);
  const [pwField, setPwField]   = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [expandId, setExpandId] = useState(null);
  const [formApproverId,    setFormApproverId]    = useState("");
  const [formViewerId,      setFormViewerId]      = useState("");
  const [formMentorId,      setFormMentorId]      = useState("");
  const [formSupervisorIds, setFormSupervisorIds] = useState([]);
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));
  const [hostCos, setHostCos] = useState([]);
  useEffect(()=>{ loadTable('crm_companies').then(rows=>setHostCos(rows.filter(r=>r.name).map(r=>({id:r.id,name:r.name,isHostBusiness:r.is_host_business})).sort((a,b)=>(a.name||"").localeCompare(b.name||"")))).catch(()=>{}); },[]);

  const getAllocated = (role, appId) =>
    allUsers.filter(u => (u.role===role || u.role==="Admin") && (u.allocatedTo||[]).includes(appId));

  // Get approver/viewer/mentor using direct fields (source of truth) with allocatedTo fallback
  const getApprover = (apprentice) => {
    if(apprentice.approverUserId) return allUsers.find(u=>u.id===apprentice.approverUserId);
    return allUsers.find(u=>(u.role==="Approver"||u.role==="Admin")&&(u.allocatedTo||[]).includes(apprentice.id));
  };
  const getViewer = (apprentice) => {
    if(apprentice.viewerUserId) return allUsers.find(u=>u.id===apprentice.viewerUserId);
    return allUsers.find(u=>(u.role==="Viewer"||u.role==="Admin")&&(u.allocatedTo||[]).includes(apprentice.id));
  };
  const getMentor = (apprentice) => {
    if(apprentice.mentorUserId) return allUsers.find(u=>u.id===apprentice.mentorUserId);
    return null;
  };

  const toggleAlloc = (staffId, appId) => {
    setUsers(prev => prev.map(u => {
      if(u.id !== staffId) return u;
      if(u.role === "Supervisor") return u; // Supervisors use supervisorIds not allocatedTo
      const has = (u.allocatedTo||[]).includes(appId);
      return {...u, allocatedTo: has
        ? (u.allocatedTo||[]).filter(x=>x!==appId)
        : [...(u.allocatedTo||[]), appId]};
    }));
  };

  const submit = async () => {
    const firstName = form.firstName.trim();
    const lastName  = form.lastName.trim();
    if(!firstName||!form.email.trim()) return;
    const fullName = `${firstName} ${lastName}`.trim();
    const finalForm = {...form, name: fullName, firstName, lastName,
      approverUserId: formApproverId||null,
      viewerUserId:   formViewerId||null,
      mentorUserId:   formMentorId||null,
      supervisorIds:  formSupervisorIds,
    };
    if(pwField.trim()) {
      finalForm.password = await hashPw(pwField.trim());
    } else if(editId) {
      const existing = users.find(u=>u.id===editId);
      finalForm.password = existing?.password || "";
    }
    let appId = editId;
    if(editId) {
      // Preserve existing role — never overwrite with hardcoded "Apprentice" from blank form
      setUsers(prev => prev.map(u => u.id===editId ? {...u,...finalForm, role: u.role} : u));
      setEditId(null);
    } else {
      appId = uid();
      setUsers(prev => [...prev, {id:appId, ...finalForm}]);
    }
    // Sync allocatedTo on approver/viewer/admin users
    setUsers(prev => prev.map(u => {
      if(!["Approver","Viewer","Admin"].includes(u.role)) return u;
      if(u.role==="Supervisor") return u; // Supervisors use supervisorIds not allocatedTo
      const isApprover = u.id === formApproverId;
      const isViewer   = u.id === formViewerId;
      const shouldHave = isApprover || isViewer;
      const has        = (u.allocatedTo||[]).includes(appId);
      if(shouldHave && !has) return {...u, allocatedTo:[...(u.allocatedTo||[]), appId]};
      if(!shouldHave && has) return {...u, allocatedTo:(u.allocatedTo||[]).filter(x=>x!==appId)};
      return u;
    }));
    setForm(blank); setPwField(""); setFormApproverId(""); setFormViewerId(""); setFormMentorId(""); setFormSupervisorIds([]);
    setShowForm(false); setEditId(null); setExpandId(null);
  };

  const startEdit = (u) => {
    const parts = u.name.split(" ");
    setForm({
      firstName: u.firstName || parts[0] || "",
      lastName:  u.lastName  || parts.slice(1).join(" ") || "",
      email: u.email||"", phone: u.phone||"",
      trade: u.trade||"", licenceExpiry: u.licenceExpiry||"", siteSafeExpiry: u.siteSafeExpiry||"", firstAidExpiry: u.firstAidExpiry||"", hostBusiness: u.hostBusiness||"",
      role:"Apprentice", allocatedTo:[], password:"",
      overtimeType: u.overtimeType||null, overtimeThreshold: u.overtimeThreshold||"", overtimeRateId: u.overtimeRateId||"",
      reportsEmail: u.reportsEmail||"",
    });
    // Pre-select from approverUserId/viewerUserId/mentorUserId (new) or fall back to allocatedTo (legacy)
    const curApprover = u.approverUserId || allUsers.find(x=>(x.role==="Approver"||x.role==="Admin")&&(x.allocatedTo||[]).includes(u.id))?.id || "";
    const curViewer   = u.viewerUserId   || allUsers.find(x=>(x.role==="Viewer"  ||x.role==="Admin")&&(x.allocatedTo||[]).includes(u.id)&&x.id!==curApprover)?.id || "";
    const curMentor   = u.mentorUserId   || "";
    setFormApproverId(curApprover);
    setFormViewerId(curViewer);
    setFormMentorId(curMentor);
    setFormSupervisorIds(u.supervisorIds||[]);
    setPwField(""); setEditId(u.id); setExpandId(u.id); setShowForm(false);
  };

  const deleteUser = async (id) => {
    if(await ktaConfirm("Remove this apprentice?")) setUsers(prev => prev.filter(u => u.id !== id));
  };

  // licence expiry colour
  const licColour = (expiry) => {
    if(!expiry) return T.muted;
    const days = (new Date(expiry) - new Date()) / 86400000;
    if(days < 0)   return T.red;
    if(days < 60)  return T.warn;
    if(days < 180) return T.gold;
    return T.accent;
  };

  return (
    <div className="fu">
      {/* Header */}
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:18}}>
        <div>
          <div style={{fontFamily:"DM Sans", fontSize:19, fontWeight:700}}>Apprentices</div>
          <div style={{fontSize:13, color:T.sub, marginTop:3}}>{apprentices.length} apprentice{apprentices.length!==1?"s":""} — click a row to view their timesheet, or expand to manage allocations.</div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setPwField("");setExpandId(null);setFormApproverId("");setFormViewerId("");setShowForm(s=>!s);}}>
          {showForm ? "✕ Cancel" : "+ Add Apprentice"}
        </Btn>
      </div>

      {/* Add form — top of page for new apprentices only */}
      {showForm && !editId && (
        <Card style={{marginBottom:20, border:`1.5px solid ${T.blue}44`}}>
          <div style={{fontWeight:700, fontSize:16, marginBottom:16, color:T.blue}}>{editId?"✎ Edit Apprentice":"+ New Apprentice"}</div>
          {/* Hidden honeypot inputs — absorb Chrome autofill before it hits real fields */}
          <div style={{display:"none"}} aria-hidden="true">
            <input type="text" name="username" tabIndex={-1}/>
            <input type="email" name="email" tabIndex={-1}/>
            <input type="tel" name="phone" tabIndex={-1}/>
            <input type="password" name="password" tabIndex={-1}/>
          </div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>First Name</FL><input autoComplete="nope" name="kta-firstname" placeholder="Jamie" value={form.firstName} onChange={e=>sf("firstName",e.target.value)}/></div>
            <div><FL req>Last Name</FL><input autoComplete="nope" name="kta-lastname" placeholder="Smith" value={form.lastName} onChange={e=>sf("lastName",e.target.value)}/></div>
            <div><FL req>Email</FL><input autoComplete="nope" name="kta-email" type="text" placeholder="jamie@work.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Phone</FL><input autoComplete="nope" name="kta-phone" type="text" placeholder="+64 2x xxx xxxx" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
            <div><FL>Mobile</FL><input autoComplete="nope" type="text" placeholder="+64 2x xxx xxxx" value={form.mobile||""} onChange={e=>sf("mobile",e.target.value)}/></div>
            <div><FL>Trade</FL>
              <select value={form.trade} onChange={e=>sf("trade",e.target.value)}>
                <option value="">Select trade…</option>
                {TRADES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div><FL>Licence Expiry</FL><input type="date" value={form.licenceExpiry} onChange={e=>sf("licenceExpiry",e.target.value)}/></div>
            <div><FL>Site Safe Expiry</FL><input type="date" value={form.siteSafeExpiry||""} onChange={e=>sf("siteSafeExpiry",e.target.value)}/></div>
            <div><FL>First Aid Expiry</FL><input type="date" value={form.firstAidExpiry||""} onChange={e=>sf("firstAidExpiry",e.target.value)}/></div>
            <div><FL>Host Business</FL>
              {hostCos.length>0?(()=>{
                const listed=hostCos.some(c=>c.name===(form.hostBusiness||""));
                const hostOnes=hostCos.filter(c=>c.isHostBusiness);
                const otherOnes=hostCos.filter(c=>!c.isHostBusiness);
                return(<div>
                  <select value={listed?(form.hostBusiness||""):"__custom__"} onChange={e=>{if(e.target.value!=="__custom__")sf("hostBusiness",e.target.value);}}>
                    <option value="">— Select host business —</option>
                    {hostOnes.length>0&&<optgroup label="🏢 Host Businesses">{hostOnes.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}</optgroup>}
                    {otherOnes.length>0&&<optgroup label="All Companies">{otherOnes.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}</optgroup>}
                    <option value="__custom__">Other (type below)…</option>
                  </select>
                  {!listed&&<input style={{marginTop:6}} placeholder="Type host business name…" value={form.hostBusiness||""} onChange={e=>sf("hostBusiness",e.target.value)}/>}
                </div>);
              })():<input placeholder="e.g. Sparks Electrical Ltd" value={form.hostBusiness||""} onChange={e=>sf("hostBusiness",e.target.value)}/>}
            </div>
            {/* ── Reports Email ── */}
            <div style={{gridColumn:"1/-1"}}>
              <FL>Reports Go To (email)</FL>
              <input type="email" placeholder="e.g. manager@company.co.nz"
                value={form.reportsEmail||""}
                onChange={e=>sf("reportsEmail",e.target.value)}/>
              <div style={{fontSize:11,color:T.muted,marginTop:2}}>Reports will be sent ONLY to these addresses. Leave blank to send to the approver.</div>
            </div>
            {/* ── Overtime Settings ── */}
            <div style={{gridColumn:"1/-1"}}>
              <div style={{fontWeight:700,fontSize:13,color:T.sub,textTransform:"uppercase",letterSpacing:".6px",marginBottom:8,marginTop:4,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
                Overtime Settings
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                <div>
                  <FL>Overtime Type</FL>
                  <select value={form.overtimeType||""} onChange={e=>sf("overtimeType",e.target.value||null)}>
                    <option value="">— No overtime —</option>
                    <option value="daily">Daily threshold</option>
                    <option value="weekly">Weekly threshold</option>
                  </select>
                </div>
                {form.overtimeType&&<div>
                  <FL>Threshold Hours</FL>
                  <input type="number" min="1" max={form.overtimeType==="weekly"?"168":"24"} step="0.5"
                    placeholder={form.overtimeType==="daily"?"e.g. 8":"e.g. 40"}
                    value={form.overtimeThreshold}
                    onChange={e=>sf("overtimeThreshold",parseFloat(e.target.value)||"")}/>
                  <div style={{fontSize:11,color:T.muted,marginTop:2}}>
                    {form.overtimeType==="daily"?"Hours per day before overtime":"Hours per week before overtime"}
                  </div>
                </div>}
                {form.overtimeType&&<div>
                  <FL>Xero Overtime Rate ID</FL>
                  <input placeholder="Xero earnings rate UUID"
                    value={form.overtimeRateId||""}
                    onChange={e=>sf("overtimeRateId",e.target.value)}/>
                  <div style={{fontSize:11,color:T.muted,marginTop:2}}>Find in Xero → Payroll → Pay Items</div>
                </div>}
              </div>
              {form.overtimeType&&(
                <div style={{marginTop:8,padding:"8px 12px",background:T.accentL,borderRadius:7,fontSize:13,color:T.accent}}>
                  {form.overtimeType==="daily"
                    ? `Any hours beyond ${form.overtimeThreshold||"?"}h in a single day will submit to Xero as overtime`
                    : `Any hours beyond ${form.overtimeThreshold||"?"}h in a week will submit to Xero as overtime`}
                </div>
              )}
            </div>
            <div>
              <FL>Approver <span style={{fontWeight:700,color:T.muted}}>(can approve timesheets)</span></FL>
              <select value={formApproverId} onChange={e=>setFormApproverId(e.target.value)}>
                <option value="">— None —</option>
                {approvers.map(a=><option key={a.id} value={a.id}>{a.name}{a.role==="Admin"?" (Admin)":""}</option>)}
              </select>
            </div>
            <div>
              <FL>Viewer <span style={{fontWeight:700,color:T.muted}}>(read-only access)</span></FL>
              <select value={formViewerId} onChange={e=>setFormViewerId(e.target.value)}>
                <option value="">— None —</option>
                {viewers.map(v=><option key={v.id} value={v.id}>{v.name}{v.role==="Admin"?" (Admin)":""}</option>)}
              </select>
            </div>
            <div>
              <FL>Mentor <span style={{fontWeight:700,color:T.muted}}>(assigned KTA mentor)</span></FL>
              <select value={formMentorId} onChange={e=>setFormMentorId(e.target.value)}>
                <option value="">— None —</option>
                {mentors.map(m=><option key={m.id} value={m.id}>{m.name}{m.role==="Admin"?" (Admin)":""}</option>)}
              </select>
            </div>
            <div style={{gridColumn:"1/-1"}}>
                <FL>Supervisors <span style={{fontWeight:700,color:T.muted}}>(host business supervisors, multiple allowed)</span></FL>
                {(()=>{
                  const filteredSups = getSupervisorsForApprenticee(form.hostBusiness);
                  if(!form.hostBusiness) return <div style={{fontSize:13,color:T.muted,fontStyle:"italic",marginTop:4}}>Select a host business first</div>;
                  if(filteredSups.length===0) return <div style={{fontSize:13,color:T.muted,fontStyle:"italic",marginTop:4}}>No users linked to this company yet</div>;
                  return <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
                    {filteredSups.map(u=>{
                      const sel = formSupervisorIds.includes(u.id);
                      return (
                        <button key={u.id} type="button"
                          onClick={()=>setFormSupervisorIds(prev=>sel?prev.filter(id=>id!==u.id):[...prev,u.id])}
                          style={{padding:"6px 14px",borderRadius:8,fontSize:13,fontWeight:sel?700:400,
                            border:`1.5px solid ${sel?T.teal:T.border}`,
                            background:sel?T.tealL:T.surface,color:sel?T.teal:T.ink,
                            cursor:"pointer",fontFamily:"DM Sans,sans-serif",transition:"all .14s"}}>
                          {u.name}
                        </button>
                      );
                    })}
                  </div>;
                })()}
              </div>
            <div>
              <FL>{editId?"New Password (blank = keep)":"Password"}</FL>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} autoComplete="new-password" placeholder={editId?"Leave blank to keep":"Set password"}
                  value={pwField} onChange={e=>setPwField(e.target.value)} style={{paddingRight:60}}/>
                <button onClick={()=>setShowPw(s=>!s)} type="button" style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:13,fontFamily:"DM Sans,sans-serif"}}>{showPw?"Hide":"Show"}</button>
              </div>
              {!editId && <div style={{fontSize:12,color:T.muted,marginTop:3}}>Required for new users</div>}
            </div>
          </div>
          <div style={{display:"flex", gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Add Apprentice"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);setFormApproverId("");setFormViewerId("");setFormMentorId("");setFormSupervisorIds([]);}}>Cancel</Btn>
          </div>
        </Card>
      )}

      {/* Table header */}
      <Card style={{padding:0, overflow:"hidden"}}>
        <div style={{display:"grid",
          gridTemplateColumns:"36px 1fr 140px 130px 120px 110px 110px 72px",
          padding:"10px 16px", background:T.bg, borderBottom:`1.5px solid ${T.border}`,
          fontSize:12, fontWeight:700, color:T.muted, textTransform:"uppercase", letterSpacing:".6px", gap:8}}>
          <span/><ALCol field="name">Name</ALCol><ALCol field="email">Email</ALCol><ALCol field="phone">Phone</ALCol>
          <span>Trade</span><span>Licence Exp.</span><span>Allocations</span>
          <span style={{textAlign:"right"}}>Actions</span>
        </div>

        {apprentices.length === 0 && (
          <div style={{padding:"48px 24px", textAlign:"center", color:T.muted}}>
            <div style={{fontSize:35, marginBottom:8}}>◑</div>
            <div style={{fontWeight:700}}>No apprentices yet</div>
            <div style={{fontSize:13, marginTop:4}}>Add your first apprentice above.</div>
          </div>
        )}

        {apprentices.map((u,i) => {
          const approver   = getApprover(u);
          const viewer     = getViewer(u);
          const mentor     = getMentor(u);
          const isExpanded = expandId === u.id;
          const lc         = licColour(u.licenceExpiry);

          return (
            <div key={u.id}>
              {/* Main row */}
              <div className="ri" style={{
                display:"grid",
                gridTemplateColumns:"36px 1fr 140px 130px 120px 110px 110px 72px",
                padding:"12px 16px",
                borderBottom:(!isExpanded&&i<apprentices.length-1)?`1px solid ${T.border}44`:"none",
                background:isExpanded?T.blueL:i%2===0?T.surface:T.bg,
                alignItems:"center", gap:8, animationDelay:`${i*.03}s`}}>

                {/* Avatar — click → timesheet */}
                <div onClick={()=>onViewTimesheet(u.id)} style={{cursor:"pointer"}}>
                  <Avatar name={u.name} role="Apprentice"/>
                </div>

                {/* Name — click → timesheet */}
                <div onClick={()=>onViewTimesheet(u.id)} style={{cursor:"pointer"}}>
                  <div style={{fontWeight:700, fontSize:14, color:T.accent}}>{u.firstName||u.name.split(" ")[0]} <span style={{color:T.sub}}>{u.lastName||u.name.split(" ").slice(1).join(" ")}</span></div>
                </div>

                <div style={{fontSize:13, color:T.sub, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{u.email||"—"}</div>
                <div style={{fontSize:13, color:T.sub}}>{u.phone||"—"}</div>

                {/* Trade */}
                <div>{u.trade
                  ? <Pill label={u.trade} size="sm" color={T.teal} bg={T.tealL}/>
                  : <span style={{fontSize:13,color:T.muted}}>—</span>}
                </div>

                {/* Licence / Site Safe / First Aid expiry */}
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  {[
                    {label:"Lic",  val:u.licenceExpiry},
                    {label:"SS",   val:u.siteSafeExpiry},
                    {label:"FA",   val:u.firstAidExpiry},
                  ].map(({label,val})=>{
                    if(!val) return null;
                    const c = licColour(val);
                    return (
                      <div key={label} style={{display:"flex",alignItems:"center",gap:4}}>
                        <span style={{fontSize:11,fontWeight:700,color:T.muted,width:22,flexShrink:0}}>{label}</span>
                        <span style={{fontSize:12,fontWeight:700,color:c}}>
                          {new Date(val+"T00:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}
                          {c===T.red&&<span style={{marginLeft:3}}>⚠</span>}
                        </span>
                      </div>
                    );
                  })}
                  {!u.licenceExpiry&&!u.siteSafeExpiry&&!u.firstAidExpiry&&<span style={{fontSize:13,color:T.muted}}>—</span>}
                </div>

                {/* Allocation summary — click to expand */}
                <button onClick={()=>setExpandId(isExpanded?null:u.id)} style={{
                  background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left"}}>
                  <div style={{fontSize:12}}>
                    <div style={{color:approver?T.warn:T.muted, fontWeight:approver?600:400}}>
                      ▲ {approver?approver.name.split(" ")[0]:"No approver"}
                    </div>
                    <div style={{color:viewer?T.teal:T.muted, fontWeight:viewer?600:400, marginTop:2}}>
                      ◆ {viewer?viewer.name.split(" ")[0]:"No viewer"}
                    </div>
                    {mentor&&<div style={{color:T.accent, fontWeight:700, marginTop:2}}>
                      ✦ {mentor?.name?.split(" ")[0]||""}
                    </div>}
                  </div>
                  <div style={{fontSize:11,color:T.blue,marginTop:3}}>{isExpanded?"▲ collapse":"✎ manage"}</div>
                </button>

                {/* Actions */}
                <div style={{display:"flex", gap:5, justifyContent:"flex-end"}}>
                  <button onClick={()=>{if(editId===u.id){setEditId(null);setExpandId(null);}else{startEdit(u);}}} style={{width:26,height:26,borderRadius:6,fontSize:13,background:editId===u.id?T.blueL:"transparent",color:editId===u.id?T.blue:T.muted,border:`1px solid ${editId===u.id?T.blue+"66":T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                    onMouseLeave={e=>{e.currentTarget.style.background=editId===u.id?T.blueL:"transparent";e.currentTarget.style.color=editId===u.id?T.blue:T.muted;}}>✎</button>
                  <button onClick={()=>deleteUser(u.id)} style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                    onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
                </div>
              </div>

              {/* Expanded: inline edit form OR allocation panel */}
              {isExpanded && (
                <div style={{background:editId===u.id?T.bg:T.blueL,
                  borderBottom:i<apprentices.length-1?`1px solid ${T.border}44`:"none",
                  borderTop:`1.5px solid ${editId===u.id?T.blue+"44":T.border+"44"}`}}>
                {editId===u.id ? (
                  /* ── INLINE EDIT FORM — uses shared ApprenticeEditForm ── */
                  <div style={{padding:"16px 20px 20px"}}>
                    <ApprenticeEditForm
                      user={u}
                      allUsers={allUsers}
                      viewer={currentUser}
                      title={`✎ Editing — ${u.name}`}
                      onSave={(updated) => {
                        setUsers(prev=>prev.map(x=>x.id===updated.id?updated:x));
                        setEditId(null); setExpandId(null);
                      }}
                      onCancel={()=>{setEditId(null);setExpandId(null);}}
                    />
                  </div>
                ) : (
                /* ── ALLOCATION PANEL ── */
                <div style={{padding:"16px 20px 20px 20px"}}>
                  <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:20}}>

                    {/* Approvers column */}
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:T.warn,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                        <span>▲</span> Approvers
                        <span style={{fontSize:12,fontWeight:700,color:T.sub}}>— can approve / decline this apprentice's timesheets</span>
                      </div>
                      {approvers.length===0
                        ? <div style={{fontSize:13,color:T.muted,fontStyle:"italic"}}>No Approver accounts exist yet.</div>
                        : approvers.map(ap=>{
                            const isAllocd = (ap.allocatedTo||[]).includes(u.id);
                            return (
                              <button key={ap.id} onClick={()=>toggleAlloc(ap.id, u.id)} style={{
                                display:"flex",alignItems:"center",gap:10,width:"100%",
                                padding:"9px 12px",marginBottom:6,borderRadius:8,textAlign:"left",
                                background:isAllocd?T.warnL:T.surface,
                                border:`1.5px solid ${isAllocd?T.warn:T.border}`,
                                cursor:"pointer",transition:"all .14s"}}>
                                <div style={{width:20,height:20,borderRadius:5,
                                  background:isAllocd?T.warn:"transparent",
                                  border:`2px solid ${isAllocd?T.warn:T.muted}`,
                                  display:"flex",alignItems:"center",justifyContent:"center",
                                  fontSize:12,color:"#fff",flexShrink:0}}>
                                  {isAllocd?"✓":""}
                                </div>
                                <div>
                                  <div style={{fontSize:14,fontWeight:700,color:T.ink}}>{ap.name}</div>
                                  <div style={{fontSize:12,color:T.sub}}>{ap.email}</div>
                                </div>
                              </button>
                            );
                          })
                      }
                    </div>

                    {/* Viewers column */}
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:T.teal,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                        <span>◆</span> Viewers
                        <span style={{fontSize:12,fontWeight:700,color:T.sub}}>— can view all timesheet stages, read only</span>
                      </div>
                      {viewers.length===0
                        ? <div style={{fontSize:13,color:T.muted,fontStyle:"italic"}}>No Viewer accounts exist yet.</div>
                        : viewers.map(vw=>{
                            const isAllocd = (vw.allocatedTo||[]).includes(u.id);
                            return (
                              <button key={vw.id} onClick={()=>toggleAlloc(vw.id, u.id)} style={{
                                display:"flex",alignItems:"center",gap:10,width:"100%",
                                padding:"9px 12px",marginBottom:6,borderRadius:8,textAlign:"left",
                                background:isAllocd?T.tealL:T.surface,
                                border:`1.5px solid ${isAllocd?T.teal:T.border}`,
                                cursor:"pointer",transition:"all .14s"}}>
                                <div style={{width:20,height:20,borderRadius:5,
                                  background:isAllocd?T.teal:"transparent",
                                  border:`2px solid ${isAllocd?T.teal:T.muted}`,
                                  display:"flex",alignItems:"center",justifyContent:"center",
                                  fontSize:12,color:"#fff",flexShrink:0}}>
                                  {isAllocd?"✓":""}
                                </div>
                                <div>
                                  <div style={{fontSize:14,fontWeight:700,color:T.ink}}>{vw.name}</div>
                                  <div style={{fontSize:12,color:T.sub}}>{vw.email}</div>
                                </div>
                              </button>
                            );
                          })
                      }
                    </div>

                  </div>
                </div>
                )}
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS LIST  (business/other contacts, not system users)
// ─────────────────────────────────────────────────────────────────────────────
function ContactsList() {
  const {sortFn:clSort, ColHeader:CLCol} = useSort("name","asc");
  const [items, setItems] = useState([]);
  const [dashLoading_dash_contacts, setDashLoading_dash_contacts] = useState(true);
  useEffect(()=>{
    loadTable('dash_contacts').then(rows=>{
      setItems(rows);
      setDashLoading_dash_contacts(false);
    }).catch(e=>{console.error('dash_contacts load',e);setDashLoading_dash_contacts(false);});
  },[]);
  const blank = {name:"",company:"",email:"",phone:"",type:"General",notes:""};
  const CTYPES = ["General","Government","Industry","Training","Other"];
  const CTYPE_C = {General:T.slate,Government:T.blue,Industry:T.teal,Training:T.hol,Other:T.muted};
  const [form, setForm] = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const sf = (k,v)=>setForm(f=>({...f,[k]:v}));

  const submit = () => {
    if(!form.name.trim()) return;
    const row = editId ? {id:editId,...form} : {id:uid(),...form};
    if(editId){ setItems(prev=>prev.map(x=>x.id===editId?row:x)); setEditId(null); }
    else setItems(prev=>[row,...prev]);
    upsertRow('dash_contacts',row).catch(console.error);
    setForm(blank); setShowForm(false);
  };
  const startEdit = (x)=>{setForm({name:x.name,company:x.company||"",email:x.email||"",phone:x.phone||"",type:x.type||"General",notes:x.notes||""});setEditId(x.id);setShowForm(true);};
  const del = async (id)=>{ if(await ktaConfirm("Remove this contact?")){ setItems(prev=>prev.filter(x=>x.id!==id)); deleteRow('dash_contacts',id).catch(console.error); } };

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
        <div>
          <div style={{fontFamily:"DM Sans",fontSize:19,fontWeight:700}}>Contacts</div>
          <div style={{fontSize:13,color:T.sub,marginTop:3}}>Business and other contacts — not system users.</div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setShowForm(s=>!s);}}>
          {showForm?"✕ Cancel":"+ Add Contact"}
        </Btn>
      </div>
      {showForm&&(
        <Card style={{marginBottom:20,border:`1.5px solid ${T.slate}44`}}>
          <div style={{fontWeight:700,fontSize:16,marginBottom:16,color:T.slate}}>{editId?"✎ Edit Contact":"+ New Contact"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Name</FL><input placeholder="Jane Smith" value={form.name} onChange={e=>sf("name",e.target.value)}/></div>
            <div><FL>Organisation</FL><input placeholder="Company / Agency" value={form.company} onChange={e=>sf("company",e.target.value)}/></div>
            <div><FL>Type</FL>
              <select value={form.type} onChange={e=>sf("type",e.target.value)}>
                {CTYPES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div><FL>Email</FL><input type="email" placeholder="jane@org.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+61…" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Save Contact"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancel</Btn>
          </div>
        </Card>
      )}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 160px 100px 160px 160px 68px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <CLCol field="name">Name</CLCol><CLCol field="company">Organisation</CLCol><span>Type</span><CLCol field="email">Email</CLCol><span>Phone</span><span/>
        </div>
        {items.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No contacts yet.</div>}
        {[...items].sort(clSort).map((x,i)=>(
          <div key={x.id} className="ri" style={{display:"grid",gridTemplateColumns:"1fr 160px 100px 160px 160px 68px",
            padding:"12px 16px",borderBottom:i<items.length-1?`1px solid ${T.border}44`:"none",
            background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
            <div>
              <div style={{fontWeight:700,fontSize:14}}>{x.name}</div>
              {x.notes&&<div style={{fontSize:12,color:T.muted,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.notes}</div>}
            </div>
            <div style={{fontSize:13,color:T.sub}}>{x.company||"—"}</div>
            <Pill label={x.type||"General"} size="sm" color={CTYPE_C[x.type]||T.slate} bg={(CTYPE_C[x.type]||T.slate)+"1a"}/>
            <div style={{fontSize:13,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.email||"—"}</div>
            <div style={{fontSize:13,color:T.sub}}>{x.phone||"—"}</div>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
              <button onClick={()=>startEdit(x)} style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
              <button onClick={()=>del(x.id)} style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HOST BUSINESS LIST  (companies that host apprentices)
// ─────────────────────────────────────────────────────────────────────────────
function HostBusinessList() {
  const {sortFn:hlSort, ColHeader:HLCol} = useSort("name","asc");
  const [items, setItems] = useState([]);
  const [dashLoading_dash_hosts, setDashLoading_dash_hosts] = useState(true);
  useEffect(()=>{
    loadTable('dash_hosts').then(rows=>{
      setItems(rows);
      setDashLoading_dash_hosts(false);
    }).catch(e=>{console.error('dash_hosts load',e);setDashLoading_dash_hosts(false);});
  },[]);
  const blank = {name:"",industry:"",contact:"",phone:"",email:"",capacity:"",status:"Active",notes:""};
  const INDUSTRIES = ["Construction","Electrical","Plumbing","Carpentry","HVAC","Civil","Other"];
  const [form, setForm] = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const sf = (k,v)=>setForm(f=>({...f,[k]:v}));

  const submit = () => {
    if(!form.name.trim()) return;
    const row = editId ? {id:editId,...form} : {id:uid(),...form};
    if(editId){ setItems(prev=>prev.map(x=>x.id===editId?row:x)); setEditId(null); }
    else setItems(prev=>[row,...prev]);
    upsertRow('dash_hosts',{...row,capacity:parseInt(row.capacity)||0}).catch(console.error);
    setForm(blank); setShowForm(false);
  };
  const startEdit = (x)=>{setForm({name:x.name,industry:x.industry||"",contact:x.contact||"",phone:x.phone||"",email:x.email||"",capacity:x.capacity||"",status:x.status||"Active",notes:x.notes||""});setEditId(x.id);setShowForm(true);};
  const del = async (id)=>{ if(await ktaConfirm("Remove this host business?")){ setItems(prev=>prev.filter(x=>x.id!==id)); deleteRow('dash_hosts',id).catch(console.error); } };

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
        <div>
          <div style={{fontFamily:"DM Sans",fontSize:19,fontWeight:700}}>Host Businesses</div>
          <div style={{fontSize:13,color:T.sub,marginTop:3}}>Companies that host apprentices for on-the-job training.</div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setShowForm(s=>!s);}}>
          {showForm?"✕ Cancel":"+ Add Host Business"}
        </Btn>
      </div>
      {showForm&&(
        <Card style={{marginBottom:20,border:`1.5px solid ${T.teal}44`}}>
          <div style={{fontWeight:700,fontSize:16,marginBottom:16,color:T.teal}}>{editId?"✎ Edit Host Business":"+ New Host Business"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Business Name</FL><input placeholder="Acme Constructions" value={form.name} onChange={e=>sf("name",e.target.value)}/></div>
            <div><FL>Industry</FL>
              <select value={form.industry} onChange={e=>sf("industry",e.target.value)}>
                <option value="">Select…</option>
                {INDUSTRIES.map(i=><option key={i}>{i}</option>)}
              </select>
            </div>
            <div><FL>Status</FL>
              <select value={form.status} onChange={e=>sf("status",e.target.value)}>
                {["Active","Inactive","Pending"].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div><FL>Primary Contact</FL><input placeholder="Name" value={form.contact} onChange={e=>sf("contact",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+61…" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
            <div><FL>Email</FL><input type="email" placeholder="contact@biz.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Apprentice Capacity</FL><input type="number" min="0" placeholder="0" value={form.capacity} onChange={e=>sf("capacity",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Save Host Business"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancel</Btn>
          </div>
        </Card>
      )}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 120px 140px 140px 60px 80px 68px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <HLCol field="name">Business</HLCol><HLCol field="industry">Industry</HLCol><span>Contact</span><span>Email</span><span style={{textAlign:"center"}}>Cap.</span><HLCol field="status">Status</HLCol><span/>
        </div>
        {items.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No host businesses yet.</div>}
        {[...items].sort(hlSort).map((x,i)=>(
          <div key={x.id} className="ri" style={{display:"grid",gridTemplateColumns:"1fr 120px 140px 140px 60px 80px 68px",
            padding:"12px 16px",borderBottom:i<items.length-1?`1px solid ${T.border}44`:"none",
            background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
            <div>
              <div style={{fontWeight:700,fontSize:14}}>{x.name}</div>
              {x.notes&&<div style={{fontSize:12,color:T.muted,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.notes}</div>}
            </div>
            <div style={{fontSize:13,color:T.sub}}>{x.industry||"—"}</div>
            <div style={{fontSize:13,color:T.sub}}>{x.contact||"—"}</div>
            <div style={{fontSize:13,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.email||"—"}</div>
            <div style={{textAlign:"center",fontSize:14,fontWeight:700,color:T.teal}}>{x.capacity||"—"}</div>
            <Pill label={x.status||"Active"} size="sm"
              color={x.status==="Active"?T.accent:x.status==="Pending"?T.warn:T.muted}
              bg={x.status==="Active"?T.accentL:x.status==="Pending"?T.warnL:T.slateL}/>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
              <button onClick={()=>startEdit(x)} style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
              <button onClick={()=>del(x.id)} style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TARGET DEALS LIST  (deals / opportunities being pursued)
// ─────────────────────────────────────────────────────────────────────────────
function TargetDealsList() {
  const DEAL_STAGES = ["Prospecting","Outreach","Meeting","Proposal","Negotiation","Won","Lost"];
  const DEAL_C = {Prospecting:T.muted,Outreach:T.blue,Meeting:T.hol,Proposal:T.warn,Negotiation:T.gold,Won:T.accent,Lost:T.red};
  const [items, setItems] = useState([]);
  const [dashLoading_dash_deals, setDashLoading_dash_deals] = useState(true);
  useEffect(()=>{
    loadTable('dash_deals').then(rows=>{
      setItems(rows);
      setDashLoading_dash_deals(false);
    }).catch(e=>{console.error('dash_deals load',e);setDashLoading_dash_deals(false);});
  },[]);
  const blank = {title:"",contact:"",org:"",value:"",stage:"Prospecting",dueDate:"",priority:"Medium",notes:""};
  const [form, setForm] = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const sf = (k,v)=>setForm(f=>({...f,[k]:v}));

  const submit = () => {
    if(!form.title.trim()) return;
    const row = editId ? {id:editId,...form} : {id:uid(),...form};
    if(editId){ setItems(prev=>prev.map(x=>x.id===editId?row:x)); setEditId(null); }
    else setItems(prev=>[row,...prev]);
    upsertRow('dash_deals',{id:row.id,title:row.title,contact:row.contact||"",org:row.org||"",value:row.value||"",stage:row.stage||"Prospecting",due_date:row.dueDate||null,priority:row.priority||"Medium",notes:row.notes||""}).catch(console.error);
    setForm(blank); setShowForm(false);
  };
  const startEdit = (x)=>{setForm({title:x.title,contact:x.contact||"",org:x.org||"",value:x.value||"",stage:x.stage||"Prospecting",dueDate:x.due_date||x.dueDate||"",priority:x.priority||"Medium",notes:x.notes||""});setEditId(x.id);setShowForm(true);};
  const del = async (id)=>{ if(await ktaConfirm("Remove this deal?")){ setItems(prev=>prev.filter(x=>x.id!==id)); deleteRow('dash_deals',id).catch(console.error); } };
  const move = (id,stage)=>{ setItems(prev=>prev.map(x=>x.id===id?{...x,stage}:x)); upsertRow('dash_deals',{id,stage}).catch(console.error); };

  const totalValue = items.filter(x=>!["Won","Lost"].includes(x.stage)).reduce((a,x)=>a+(parseFloat(x.value)||0),0);
  const PRIORITY_C = {High:T.red,Medium:T.warn,Low:T.muted};

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
        <div>
          <div style={{fontFamily:"DM Sans",fontSize:19,fontWeight:700}}>Target Deals</div>
          <div style={{fontSize:13,color:T.sub,marginTop:3}}>{items.filter(x=>!["Won","Lost"].includes(x.stage)).length} active deals · pipeline value <strong style={{color:T.accent}}>${totalValue.toLocaleString()}</strong></div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setShowForm(s=>!s);}}>
          {showForm?"✕ Cancel":"+ Add Deal"}
        </Btn>
      </div>
      {showForm&&(
        <Card style={{marginBottom:20,border:`1.5px solid ${T.gold}44`}}>
          <div style={{fontWeight:700,fontSize:16,marginBottom:16,color:T.gold}}>{editId?"✎ Edit Deal":"+ New Deal"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Deal Title</FL><input placeholder="e.g. Funding Round 2025" value={form.title} onChange={e=>sf("title",e.target.value)}/></div>
            <div><FL>Contact Person</FL><input placeholder="Name" value={form.contact} onChange={e=>sf("contact",e.target.value)}/></div>
            <div><FL>Organisation</FL><input placeholder="Company / Agency" value={form.org} onChange={e=>sf("org",e.target.value)}/></div>
            <div><FL>Value ($)</FL><input type="number" placeholder="0" value={form.value} onChange={e=>sf("value",e.target.value)}/></div>
            <div><FL>Stage</FL>
              <select value={form.stage} onChange={e=>sf("stage",e.target.value)}>
                {DEAL_STAGES.map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div><FL>Priority</FL>
              <select value={form.priority} onChange={e=>sf("priority",e.target.value)}>
                {["High","Medium","Low"].map(p=><option key={p}>{p}</option>)}
              </select>
            </div>
            <div><FL>Due Date</FL><input type="date" value={form.dueDate} onChange={e=>sf("dueDate",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Save Deal"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancel</Btn>
          </div>
        </Card>
      )}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"8px 1fr 130px 130px 90px 80px 80px 68px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <span/><span>Deal</span><span>Organisation</span><span>Contact</span><span style={{textAlign:"right"}}>Value</span><span>Stage</span><span>Priority</span><span/>
        </div>
        {items.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No deals yet.</div>}
        {[...items].sort((a,b)=>{
          const order=["Proposal","Negotiation","Meeting","Outreach","Prospecting","Won","Lost"];
          return (order.indexOf(a.stage)||99)-(order.indexOf(b.stage)||99);
        }).map((x,i,arr)=>(
          <div key={x.id} className="ri" style={{display:"grid",gridTemplateColumns:"8px 1fr 130px 130px 90px 80px 80px 68px",
            padding:"12px 16px",borderBottom:i<arr.length-1?`1px solid ${T.border}44`:"none",
            background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
            <div style={{width:8,height:36,borderRadius:3,background:DEAL_C[x.stage]||T.muted}}/>
            <div>
              <div style={{fontWeight:700,fontSize:14}}>{x.title}</div>
              {x.notes&&<div style={{fontSize:12,color:T.muted,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.notes}</div>}
            </div>
            <div style={{fontSize:13,color:T.sub}}>{x.org||"—"}</div>
            <div style={{fontSize:13,color:T.sub}}>{x.contact||"—"}</div>
            <div style={{textAlign:"right",fontFamily:"DM Sans",fontWeight:700,fontSize:16,color:DEAL_C[x.stage]||T.muted}}>
              {x.value?`$${parseFloat(x.value).toLocaleString()}`:"—"}
            </div>
            <Pill label={x.stage} size="sm" color={DEAL_C[x.stage]||T.muted} bg={(DEAL_C[x.stage]||T.muted)+"1a"}/>
            <Pill label={x.priority||"Medium"} size="sm" color={PRIORITY_C[x.priority||"Medium"]} bg={PRIORITY_C[x.priority||"Medium"]+"1a"}/>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
              <button onClick={()=>startEdit(x)} style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
              <button onClick={()=>del(x.id)} style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAGGABLE CARD ORDER — persists per user in localStorage
// ─────────────────────────────────────────────────────────────────────────────

export default ApprenticeList;
