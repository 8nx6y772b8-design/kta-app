import { useState, useEffect } from "react";
import { T, TRADES } from "../constants.js";
import { uid, fmtD, isConfOwner, hashPw } from "../utils.js";
import { loadTable, upsertUser } from "../supabaseClient.js";
import { FL, Btn, Card } from "../shared.jsx";

function ApprenticeEditForm({user, allUsers, onSave, onCancel, title=null, viewer=null}) {
  const TRADES = ["Electrical Apprentice","Electrical","Plumbing & Gasfitting","Plumbing","Gasfitting","Drain Laying","Roofing","Carpentry","Joinery","Painting & Decorating","Mechanical Engineering","Refrigeration & Air Conditioning","Bricklaying","Plastering","Tiling","Other"];
  const approvers = allUsers.filter(u=>u.role==="Approver"||u.role==="Admin").sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const viewers   = allUsers.filter(u=>u.role==="Viewer"  ||u.role==="Admin").sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const mentors      = allUsers.filter(u=>u.role==="Mentor"  ||u.role==="Admin").sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  // supervisors filtered by host business - computed at render via useMemo equivalent below
  const [hostCos, setHostCos] = useState([]);
  useEffect(()=>{ loadTable('crm_companies').then(rows=>setHostCos(rows.filter(r=>r.name).map(r=>({id:r.id,name:r.name,isHostBusiness:r.is_host_business})).sort((a,b)=>(a.name||"").localeCompare(b.name||"")))).catch(()=>{}); },[]);
  const nameParts = (user.name||"").split(" ");
  const [form, setForm] = useState({
    firstName:         user.firstName  || nameParts[0] || "",
    lastName:          user.lastName   || nameParts.slice(1).join(" ") || "",
    email:             user.email      || "",
    phone:             user.phone      || "",
    mobile:            user.mobile     || "",
    trade:             user.trade      || "",
    licenceExpiry:     user.licenceExpiry    || "",
    siteSafeExpiry:    user.siteSafeExpiry   || "",
    firstAidExpiry:    user.firstAidExpiry   || "",
    hostBusiness:      user.hostBusiness     || "",
    reportsEmail:      user.reportsEmail     || "",
    overtimeType:      user.overtimeType     || null,
    overtimeThreshold: user.overtimeThreshold|| "",
    overtimeRateId:    user.overtimeRateId   || "",
  });
  const [approverId, setApproverId] = useState(
    user.approverUserId || allUsers.find(x=>(x.role==="Approver"||x.role==="Admin")&&(x.allocatedTo||[]).includes(user.id))?.id || ""
  );
  const [viewerId,   setViewerId]   = useState(
    user.viewerUserId   || allUsers.find(x=>(x.role==="Viewer"  ||x.role==="Admin")&&(x.allocatedTo||[]).includes(user.id))?.id || ""
  );
  const [mentorId,      setMentorId]      = useState(user.mentorUserId || "");
  const [supervisorIds, setSupervisorIds] = useState(user.supervisorIds || []);
  const [pwField,    setPwField]    = useState("");
  const [showPw,     setShowPw]     = useState(false);
  const [saving,     setSaving]     = useState(false);

  const sf = (k,v) => setForm(f=>({...f,[k]:v}));
  const [companyContacts, setCompanyContacts] = useState([]);
  useEffect(()=>{
    const biz = (form.hostBusiness||"").toLowerCase().trim();
    if(!biz || biz.length < 3) { setCompanyContacts([]); return; }
    loadTable('crm_contacts').then(rows=>{
      const matched = rows.filter(r=>{
        if(!r.email||!r.name) return false;
        const rc = (r.company||"").toLowerCase().trim();
        if(!rc || rc.length < 3) return false;
        // Exact match only — no partial/includes to avoid false positives
        return rc === biz;
      });
      setCompanyContacts(matched.map(r=>({id:r.id,name:r.name,email:r.email,jobTitle:r.job_title||""})));
    }).catch(()=>{});
  },[form.hostBusiness]);
  const isAdminL1 = viewer?.role==="Admin" && Number(viewer?.adminLevel ?? 1)===1;
  const isAdmin   = viewer?.role==="Admin";
  const isMentor  = viewer?.role==="Mentor";
  const canEditPassword = isAdminL1 || isAdmin;
  const canEditXero     = isAdminL1;
  const canEditAllocs   = isAdminL1 || isAdmin;

  const handleSave = async () => {
    if(!form.firstName.trim()||!form.lastName.trim()||!form.email.trim()) {
      alert("First name, last name and email are required."); return;
    }
    setSaving(true);
    const updated = {
      ...user,
      name:              `${form.firstName.trim()} ${form.lastName.trim()}`,
      firstName:         form.firstName.trim(),
      lastName:          form.lastName.trim(),
      email:             form.email.trim(),
      phone:             form.phone.trim(),
      mobile:            form.mobile.trim(),
      trade:             form.trade,
      licenceExpiry:     form.licenceExpiry  || null,
      siteSafeExpiry:    form.siteSafeExpiry || null,
      firstAidExpiry:    form.firstAidExpiry || null,
      hostBusiness:      form.hostBusiness,
      reportsEmail:      (form.reportsEmail||'').trim() || null,
      overtimeType:      form.overtimeType   || null,
      overtimeThreshold: form.overtimeThreshold || null,
      overtimeRateId:    form.overtimeRateId || null,
      approverUserId:    approverId || null,
      viewerUserId:      viewerId   || null,
      mentorUserId:      mentorId   || null,
      supervisorIds:     supervisorIds,
      ...(pwField.trim() ? {password: await hashPw(pwField.trim())} : {}),
    };
    try {
      await upsertUser(updated);
      onSave(updated);
    } catch(e) {
      alert("Save failed: "+e.message);
    }
    setSaving(false);
  };

  const listed = hostCos.some(c=>c.name===(form.hostBusiness||""));
  const hostOnes  = hostCos.filter(c=>c.isHostBusiness);
  const otherOnes = hostCos.filter(c=>!c.isHostBusiness);

  return (
    <div>
      {title && <div style={{fontWeight:700,fontSize:16,color:T.blue,marginBottom:14}}>{title}</div>}
      <div style={{display:"none"}} aria-hidden="true">
        <input type="text" name="username" tabIndex={-1}/>
        <input type="email" name="email" tabIndex={-1}/>
        <input type="password" name="password" tabIndex={-1}/>
      </div>
      <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
        <div><FL req>First Name</FL><input autoComplete="nope" placeholder="Jamie" value={form.firstName} onChange={e=>sf("firstName",e.target.value)}/></div>
        <div><FL req>Last Name</FL><input autoComplete="nope" placeholder="Smith" value={form.lastName} onChange={e=>sf("lastName",e.target.value)}/></div>
        <div><FL req>Email</FL><input autoComplete="nope" type="text" placeholder="jamie@work.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
        <div><FL>Phone</FL><input autoComplete="nope" type="text" placeholder="+64 2x xxx xxxx" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
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
          {hostCos.length>0?(
            <div>
              <select value={listed?(form.hostBusiness||""):"__custom__"} onChange={e=>{if(e.target.value!=="__custom__")sf("hostBusiness",e.target.value);}}>
                <option value="">— Select host business —</option>
                {hostOnes.length>0&&<optgroup label="🏢 Host Businesses">{hostOnes.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}</optgroup>}
                {otherOnes.length>0&&<optgroup label="All Companies">{otherOnes.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}</optgroup>}
                <option value="__custom__">Other (type below)…</option>
              </select>
              {!listed&&<input style={{marginTop:6}} placeholder="Type host business name…" value={form.hostBusiness||""} onChange={e=>sf("hostBusiness",e.target.value)}/>}
            </div>
          ):<input placeholder="e.g. Sparks Electrical Ltd" value={form.hostBusiness||""} onChange={e=>sf("hostBusiness",e.target.value)}/>}
        </div>
        <div style={{gridColumn:"1/-1"}}>
          <FL>Reports Go To (email)</FL>
          {(()=>{
            // Parse comma-separated emails into array
            const selectedEmails = (form.reportsEmail||"").split(",").map(e=>e.trim()).filter(Boolean);
            const addEmail = (email) => {
              if(!email||selectedEmails.includes(email)) return;
              sf("reportsEmail", [...selectedEmails, email].join(","));
            };
            const removeEmail = (email) => {
              sf("reportsEmail", selectedEmails.filter(e=>e!==email).join(","));
            };
            return (
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {/* Selected email tags */}
                {selectedEmails.length>0&&(
                  <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                    {selectedEmails.map(email=>{
                      const contact = companyContacts.find(c=>c.email===email);
                      return (
                        <div key={email} style={{display:"flex",alignItems:"center",gap:5,
                          padding:"3px 10px",borderRadius:20,background:T.accentL,
                          border:`1px solid ${T.accent}44`,fontSize:12,fontWeight:700,color:T.accent}}>
                          <span>{contact?contact.name:email}</span>
                          {contact&&<span style={{fontWeight:700,opacity:0.6,fontSize:11}}>({email})</span>}
                          <button onClick={()=>removeEmail(email)} style={{background:"none",border:"none",
                            cursor:"pointer",color:T.accent,fontSize:13,lineHeight:1,padding:0,marginLeft:2}}>✕</button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Dropdown to add from company contacts */}
                {companyContacts.length>0&&(
                  <select value="" onChange={e=>{if(e.target.value){addEmail(e.target.value);e.target.value="";}}}
                    style={{fontSize:13}}>
                    <option value="">
                      {selectedEmails.length===0?"+ Select from company contacts…":"+ Add another contact…"}
                    </option>
                    {companyContacts.filter(c=>!selectedEmails.includes(c.email)).map(c=>(
                      <option key={c.id} value={c.email}>
                        {c.name}{c.jobTitle?` · ${c.jobTitle}`:""} — {c.email}
                      </option>
                    ))}
                  </select>
                )}
                {/* Manual email entry */}
                <div style={{display:"flex",gap:6}}>
                  <input type="email" placeholder="Or type any email address…"
                    id="reportsEmailInput"
                    style={{flex:1,fontSize:13}}
                    onKeyDown={e=>{
                      if(e.key==="Enter"||e.key===","){
                        e.preventDefault();
                        const val=e.target.value.trim();
                        if(val&&val.includes("@")){addEmail(val);e.target.value="";}
                      }
                    }}
                  />
                  <button type="button" onClick={()=>{
                    const inp=document.getElementById("reportsEmailInput");
                    if(inp&&inp.value.includes("@")){addEmail(inp.value.trim());inp.value="";}
                  }} style={{padding:"6px 12px",borderRadius:7,border:`1px solid ${T.border}`,
                    background:T.surface,color:T.sub,fontSize:12,fontWeight:700,cursor:"pointer",
                    fontFamily:"DM Sans,sans-serif",whiteSpace:"nowrap"}}>
                    + Add
                  </button>
                </div>
              </div>
            );
          })()}
          <div style={{fontSize:11,color:T.muted,marginTop:2}}>
            Reports emailed to all selected addresses + apprentice. Leave empty to use approver.
          </div>
        </div>
        <div style={{gridColumn:"1/-1"}}>
          <div style={{fontWeight:700,fontSize:13,color:T.sub,textTransform:"uppercase",letterSpacing:".6px",marginBottom:8,marginTop:4,paddingTop:8,borderTop:`1px solid ${T.border}`}}>Overtime Settings</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
            <div><FL>Overtime Type</FL>
              <select value={form.overtimeType||""} onChange={e=>sf("overtimeType",e.target.value||null)}>
                <option value="">— No overtime —</option>
                <option value="daily">Daily threshold</option>
                <option value="weekly">Weekly threshold</option>
              </select>
            </div>
            {form.overtimeType&&<div><FL>Threshold Hours</FL>
              <input type="number" min="1" max={form.overtimeType==="weekly"?"168":"24"} step="0.5"
                placeholder={form.overtimeType==="daily"?"e.g. 8":"e.g. 40"}
                value={form.overtimeThreshold} onChange={e=>sf("overtimeThreshold",parseFloat(e.target.value)||"")}/>
            </div>}
            {form.overtimeType&&canEditXero&&<div><FL>Xero Overtime Rate ID</FL>
              <input placeholder="Xero earnings rate UUID" value={form.overtimeRateId||""} onChange={e=>sf("overtimeRateId",e.target.value)}/>
            </div>}
          </div>
        </div>
        {canEditAllocs&&<div><FL>Approver</FL>
          <select value={approverId} onChange={e=>setApproverId(e.target.value)}>
            <option value="">— None —</option>
            {approvers.map(a=><option key={a.id} value={a.id}>{a.name}{a.role==="Admin"?" (Admin)":""}</option>)}
          </select>
        </div>}
        {canEditAllocs&&<div><FL>Viewer</FL>
          <select value={viewerId} onChange={e=>setViewerId(e.target.value)}>
            <option value="">— None —</option>
            {viewers.map(v=><option key={v.id} value={v.id}>{v.name}{v.role==="Admin"?" (Admin)":""}</option>)}
          </select>
        </div>}
        {canEditAllocs&&<div><FL>Mentor</FL>
          <select value={mentorId} onChange={e=>setMentorId(e.target.value)}>
            <option value="">— None —</option>
            {mentors.map(m=><option key={m.id} value={m.id}>{m.name}{m.role==="Admin"?" (Admin)":""}</option>)}
          </select>
        </div>}
        {canEditAllocs&&<div style={{gridColumn:"1/-1"}}>
          <FL>Supervisors <span style={{fontWeight:700,color:T.muted}}>(host business supervisors)</span></FL>
          {(()=>{
            const hb = (form.hostBusiness||"").toLowerCase().trim();
            const filteredSups = allUsers.filter(u=>
              ["Supervisor","Approver","Viewer"].includes(u.role) &&
              (!hb || (u.company||"").toLowerCase().trim()===hb)
            ).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
            if(!hb) return <div style={{fontSize:13,color:T.muted,fontStyle:"italic",marginTop:4}}>Select a host business first</div>;
            if(filteredSups.length===0) return <div style={{fontSize:13,color:T.muted,fontStyle:"italic",marginTop:4}}>No users linked to this company yet</div>;
            return <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
                {filteredSups.map(u=>{
                  const sel = supervisorIds.includes(u.id);
                  return (
                    <button key={u.id} type="button"
                      onClick={()=>setSupervisorIds(prev=>sel?prev.filter(id=>id!==u.id):[...prev,u.id])}
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
        </div>}
        {canEditPassword&&<div><FL>New Password <span style={{fontWeight:700,color:T.muted}}>(blank = keep)</span></FL>
          <div style={{position:"relative"}}>
            <input type={showPw?"text":"password"} autoComplete="new-password" placeholder="Leave blank to keep"
              value={pwField} onChange={e=>setPwField(e.target.value)} style={{paddingRight:60}}/>
            <button onClick={()=>setShowPw(s=>!s)} type="button"
              style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
                background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:13}}>
              {showPw?"Hide":"Show"}
            </button>
          </div>
        </div>}
      </div>
      <div style={{display:"flex",gap:8}}>
        <Btn onClick={handleSave} disabled={saving}>{saving?"Saving…":"Update Apprentice"}</Btn>
        <Btn v="ghost" onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}


export default ApprenticeEditForm;
