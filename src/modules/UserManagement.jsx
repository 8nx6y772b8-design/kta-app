import { useState, useEffect, useRef } from "react";
import { T, ROLES, ROLE_META, TRADES } from "../constants.js";
import { uid, hashPw, fmtD, daysAgoStr, isConfOwner } from "../utils.js";
import { upsertUser, deleteUser as sbDeleteUser, loadTable, upsertRow } from "../supabaseClient.js";
import { Pill, RolePill, FL, Avatar, Btn, Card } from "../shared.jsx";
import ApprenticeEditForm from "./ApprenticeEditForm.jsx";
import ApprenticeList from "./ApprenticeList.jsx";
import { WeeklyHoursList, ApprovalList } from "./TimesheetHelpers.jsx";

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

  // Stable ColHeader — use a data-field attr + event delegation to avoid recreating component
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

function UserManagement({users, setUsers, currentUser, entries=[]}) {
  const myLevel = currentUser?.adminLevel || 1;
  const [viewingUser, setViewingUser] = useState(null); // full-page user detail
  const [crmHostCompanies,setCrmHostCompanies]=useState([]);
  const {sortFn:umSort, ColHeader:UMCol} = useSort("name","asc");
  useEffect(()=>{ loadTable('crm_companies').then(rows=>setCrmHostCompanies(rows.filter(r=>r.name).map(r=>({id:r.id,name:r.name,isHostBusiness:r.is_host_business})).sort((a,b)=>(a.name||"").localeCompare(b.name||"")))).catch(()=>{}); },[]);

  // Roles this admin level is allowed to create/edit
  // Admin 1: all roles. Admin 2: all except Admin 1.
  const creatableRoles = myLevel===1
    ? ["Apprentice","Approver","Viewer","Mentor","Admin"]
    : ["Apprentice","Approver","Viewer","Mentor","Admin"]; // same list — Admin 2 can create Admin 2 but not Admin 1 (enforced below)

  // Can this admin edit a given user?
  const canEditUser = (u) => {
    if(myLevel===1) return true;
    // Admin 2 cannot edit Admin 1 users
    if(u.role==="Admin" && Number(u.adminLevel ?? 1)===1) return false;
    return true;
  };
  const canDeleteUser = (u) => canEditUser(u);
  const canCreateUsers = true; // both admin levels can create users

  const [umTab, setUmTab] = useState("employees"); // "employees"|"host"|"office"

  const blank={name:"",role:"Apprentice",email:"",phone:"",password:"",allocatedTo:[],
    address:"",suburb:"",city:"",postcode:"",approverUserId:null,viewerUserId:null,secondaryRole:null,adminLevel:1,isSupervisor:false,
    hostBusiness:"",overtimeType:null,overtimeThreshold:"",overtimeRateId:"",reportsEmail:"",company:""};
  const [form,setForm]=useState(blank);
  const [formKey,setFormKey]=useState(0);
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [pwField,setPwField]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [appApprover,   setAppApprover]   = useState("");
  const [appViewer,     setAppViewer]     = useState("");
  const [appMentor,     setAppMentor]     = useState("");
  const [appSupervisors,setAppSupervisors] = useState([]);
  const sf=(k,v)=>setForm(f=>({...f,[k]:v}));

  const toggleAlloc=(uid)=>setForm(f=>({...f,allocatedTo:f.allocatedTo.includes(uid)?f.allocatedTo.filter(x=>x!==uid):[...f.allocatedTo,uid]}));

  const submit=async ()=>{
    if(!form.name.trim()||!form.email.trim()) return;
    const finalForm={...form};
    if(pwField.trim()) {
      finalForm.password=await hashPw(pwField.trim());
    } else if(editId) {
      // No new password typed — preserve the existing hash from the users array
      const existing = users.find(u=>u.id===editId);
      finalForm.password = existing?.password || "";
    }
    const targetId = editId || uid();

    // Always bake approver/viewer into finalForm for apprentices
    if(finalForm.role==="Apprentice") {
      finalForm.approverUserId = appApprover||null;
      finalForm.viewerUserId   = appViewer||null;
      finalForm.mentorUserId   = appMentor||null;
      finalForm.supervisorIds  = appSupervisors;
    }
    // Clear secondaryRole if not Admin; default adminLevel to 1 for non-admins
    if(finalForm.role!=="Admin") { finalForm.secondaryRole = null; finalForm.adminLevel = null; }
    // Admin 2 cannot create/promote to Admin 1
    if(finalForm.role==="Admin" && myLevel===2) finalForm.adminLevel = 2;

    setUsers(prev=>{
      let next = editId
        ? prev.map(u=>u.id===editId?{...u,...finalForm, role: finalForm.role||u.role}:u)
        : [...prev,{id:targetId,...finalForm}];

      if(finalForm.role==="Apprentice") {
        // Sync allocatedTo on approver/viewer users (legacy support)
        next = next.map(u => {
          if(u.id === targetId) return u;
          if(!["Approver","Viewer","Admin","Supervisor"].includes(u.role)) return u;
          if(u.role==="Supervisor") return u; // Supervisors managed via supervisorIds, not allocatedTo
          const isApprover = appApprover === u.id;
          const isViewer   = appViewer   === u.id;
          const shouldHave = isApprover || isViewer;
          const has        = (u.allocatedTo||[]).includes(targetId);
          if(shouldHave && !has) return {...u, allocatedTo:[...(u.allocatedTo||[]), targetId]};
          if(!shouldHave && has) return {...u, allocatedTo:(u.allocatedTo||[]).filter(x=>x!==targetId)};
          return u;
        });
      }
      return next;
    });
    setEditId(null);
    setForm(blank);setPwField("");setShowForm(false);
    setAppApprover("");setAppViewer("");setAppMentor("");setAppSupervisors([]);
  };

  const startEdit=(u)=>{
    // Apprentices use ApprenticeDetailView (full edit experience)
    if(u.role==="Apprentice") {
      if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[];
      window.__ktaBackHandlers.push(()=>setViewingUser(null));
      window.history.pushState({ktaNav:true},"");
      setViewingUser(u); return;
    }
    setForm({name:u.name,role:u.role,email:u.email||"",phone:u.phone||"",password:"",
      allocatedTo:u.allocatedTo||[],address:u.address||"",suburb:u.suburb||"",
      city:u.city||"",postcode:u.postcode||"",
      approverUserId:u.approverUserId||null,viewerUserId:u.viewerUserId||null,
      secondaryRole:u.secondaryRole||null,adminLevel:u.adminLevel||1,
      hostBusiness:u.hostBusiness||"",overtimeType:u.overtimeType||null,
      overtimeThreshold:u.overtimeThreshold||"",overtimeRateId:u.overtimeRateId||"",reportsEmail:u.reportsEmail||"",company:(typeof u.company==="string"?u.company:""),
      isSupervisor:u.isSupervisor||false});
    setPwField(""); setEditId(u.id); setShowForm(true); setFormKey(k=>k+1);
    if(u.role==="Apprentice") {
      // Prefer the value stored directly on the apprentice record (new approach)
      // Fall back to searching allocatedTo on approver/viewer users (legacy + always works without DB migration)
      const approverFromRecord = u.approverUserId||"";
      const viewerFromRecord   = u.viewerUserId||"";
      const approverFromAlloc  = users.find(x=>["Approver","Admin"].includes(x.role)&&(x.allocatedTo||[]).includes(u.id))?.id||"";
      const viewerFromAlloc    = users.find(x=>["Viewer","Admin"].includes(x.role)&&(x.allocatedTo||[]).includes(u.id))?.id||"";
      setAppApprover(approverFromRecord||approverFromAlloc);
      setAppViewer(viewerFromRecord||viewerFromAlloc);
      setAppMentor(u.mentorUserId||"");
      setAppSupervisors(u.supervisorIds||[]);
    }
    setTimeout(()=>document.getElementById("um-form")?.scrollIntoView({behavior:"smooth",block:"start"}),50);
  };
  const deleteUser=async (id)=>{if(await ktaConfirm("Remove this user?"))setUsers(prev=>prev.filter(u=>u.id!==id));};

  // For Approver/Viewer/Mentor: allocatable = apprentices (or apprentices+viewers for mentor)
  const allocatable=users.filter(u=>u.id!==(editId||"__")&&
    (["Approver","Viewer","Supervisor"].includes(form.role)?u.role==="Apprentice":
     form.role==="Mentor"?["Apprentice","Viewer"].includes(u.role):false)&&
    // Filter by same company if the user has a company set
    (!form.company || !u.hostBusiness || 
     u.hostBusiness.toLowerCase().trim()===form.company.toLowerCase().trim() ||
     form.allocatedTo.includes(u.id)) // always show already-allocated
  );

  // For Apprentice approver/viewer dropdowns: include Admins with matching secondary role too
  const approverOptions = users.filter(u=>u.role==="Approver"||u.role==="Admin");
  const viewerOptions      = users.filter(u=>u.role==="Viewer"  ||u.role==="Admin");
  const supervisorOptions  = users.filter(u=>["Supervisor","Approver","Viewer"].includes(u.role));

  if(viewingUser) {
    if(!viewingUser) return null;
    return viewingUser.role==="Apprentice"
      ? <ApprenticeDetailView
          apprentice={viewingUser}
          viewer={currentUser}
          allUsers={users}
          entries={entries||[]}
          isAdmin={true}
          canEditExpiry={true}
          onBack={()=>setViewingUser(null)}
          onUserUpdated={(u)=>setUsers(prev=>prev.map(x=>x.id===u.id?u:x))}
        />
      : <UserDetailView
          user={viewingUser}
          allUsers={users}
          currentUser={currentUser}
          canEdit={canEditUser(viewingUser)}
          onEdit={()=>{
            startEdit(viewingUser);
            setShowForm(true);
            setViewingUser(null);
            setTimeout(()=>document.getElementById("um-form")?.scrollIntoView({behavior:"smooth",block:"start"}),80);
          }}
          onBack={()=>setViewingUser(null)}
          onViewCompany={(companyName)=>{
            setViewingUser(null);
            navigateTo("crm", {openCompany: companyName});
          }}
        />;
  }

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:18}}>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setPwField("");setShowForm(s=>!s);setAppApprover("");setAppViewer("");}}>
          {showForm?"✕ Cancel":"+ Add User"}
        </Btn>
      </div>

      {showForm&&(
        <Card id="um-form" key={formKey} style={{marginBottom:20,border:`1.5px solid ${T.blue}44`}}>
          <div style={{fontWeight:700,fontSize:16,marginBottom:16,color:T.blue}}>
            {editId?"✎ Edit User":"+ New User"}
          </div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Full Name</FL><input placeholder="Jane Smith" value={form.name} onChange={e=>sf("name",e.target.value)}/></div>
            <div>
              <FL req>Role</FL>
              <select value={form.role} onChange={e=>sf("role",e.target.value)}>
                {ROLES.map(r=><option key={r}>{r}</option>)}
              </select>
              <div style={{marginTop:6}}><RolePill role={form.role}/></div>
            </div>
            {["Approver","Viewer","Mentor"].includes(form.role)&&(
              <div style={{marginTop:4}}>
                <label style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer",userSelect:"none"}}>
                  <div onClick={()=>sf("isSupervisor",!form.isSupervisor)}
                    style={{position:"relative",width:44,height:24,borderRadius:12,flexShrink:0,
                      background:form.isSupervisor?T.teal:"#e05c5c",
                      transition:"background .2s",cursor:"pointer"}}>
                    <div style={{position:"absolute",top:3,
                      left:form.isSupervisor?22:3,
                      width:18,height:18,borderRadius:"50%",background:"#fff",
                      transition:"left .2s",boxShadow:"0 1px 3px #0003"}}/>
                  </div>
                  <span style={{fontSize:14,color:T.ink,fontWeight:500}}>
                    Also a <strong>Supervisor</strong>
                    <span style={{fontWeight:400,color:T.muted,marginLeft:6}}>— can be allocated as a site supervisor to apprentices</span>
                  </span>
                </label>
              </div>
            )}
            {form.role==="Admin"&&(
              <div>
                <FL>Secondary Role <span style={{fontWeight:700,color:T.muted}}>(optional — grants additional access)</span></FL>
                <select value={form.secondaryRole||""} onChange={e=>sf("secondaryRole",e.target.value||null)}>
                  <option value="">— None —</option>
                  <option value="Approver">Approver — can approve timesheets for allocated apprentices</option>
                  <option value="Viewer">Viewer — read-only access to allocated apprentices' timesheets</option>
                </select>
                {form.secondaryRole&&(
                  <div style={{marginTop:6,display:"flex",alignItems:"center",gap:8}}>
                    <RolePill role="Admin"/>
                    <span style={{fontSize:13,color:T.muted}}>+</span>
                    <RolePill role={form.secondaryRole}/>
                  </div>
                )}
              </div>
            )}
            {form.role==="Admin"&&(
              <div>
                <FL>Admin Level</FL>
                <div style={{display:"flex",gap:10,marginTop:4}}>
                  {[1,2].map(lvl=>{
                    const locked = myLevel===2 && lvl===1; // Admin 2 cannot create Admin 1
                    return (
                      <button key={lvl} type="button"
                        onClick={()=>!locked&&sf("adminLevel",lvl)}
                        style={{
                          flex:1,padding:"10px 12px",borderRadius:9,fontSize:14,fontWeight:700,
                          border:`2px solid ${locked?T.border:(form.adminLevel||1)===lvl?T.accent:T.border}`,
                          background:locked?T.bg:(form.adminLevel||1)===lvl?T.accentL:T.surface,
                          color:locked?T.muted:(form.adminLevel||1)===lvl?T.accent:T.sub,
                          cursor:locked?"not-allowed":"pointer",textAlign:"left",
                          fontFamily:"DM Sans,sans-serif",transition:"all .15s",opacity:locked?0.5:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                          <span style={{fontSize:18}}>{lvl===1?"★":"☆"}</span>
                          <span>Admin Level {lvl}{locked?" (requires Admin 1)":""}</span>
                        </div>
                        <div style={{fontSize:12,fontWeight:700,lineHeight:1.4,
                          color:locked?T.muted:(form.adminLevel||1)===lvl?T.accent:T.muted}}>
                          {lvl===1
                            ? "Full access — edit, delete & manage all data including message history"
                            : "User management & timesheet viewing — cannot edit or delete messages"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div><FL req>Email</FL><input type="email" placeholder="jane@work.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+64 4xx xxx xxx" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
            <div><FL>Mobile</FL><input placeholder="+64 2x xxx xxxx" value={form.mobile||""} onChange={e=>sf("mobile",e.target.value)}/></div>
            <div>
              <FL>Company / Organisation</FL>
              {crmHostCompanies.length>0?(()=>{
                const listed = crmHostCompanies.some(c=>c.name===(form.company||""));
                const hostOnes  = crmHostCompanies.filter(c=>c.isHostBusiness);
                const otherOnes = crmHostCompanies.filter(c=>!c.isHostBusiness);
                return (
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    <select
                      value={listed?(form.company||""):"__custom__"}
                      onChange={e=>{
                        if(e.target.value==="__none__") sf("company","");
                        else if(e.target.value!=="__custom__") sf("company",e.target.value);
                      }}>
                      <option value="__none__">— No company —</option>
                      {hostOnes.length>0&&<optgroup label="🏢 Host Businesses">{hostOnes.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}</optgroup>}
                      {otherOnes.length>0&&<optgroup label="All Companies">{otherOnes.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}</optgroup>}
                      <option value="__custom__">Other (type below)…</option>
                    </select>
                    {!listed&&<input placeholder="Type company name…" value={form.company||""} onChange={e=>sf("company",e.target.value)}/>}
                  </div>
                );
              })():<input placeholder="e.g. Sparks Electrical Ltd" value={form.company||""} onChange={e=>sf("company",e.target.value)}/>}
            </div>
            <div>
              <FL>{editId?"New Password (leave blank to keep)":"Password"}</FL>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} placeholder={editId?"Leave blank to keep current":"Set password"}
                  value={pwField} onChange={e=>setPwField(e.target.value)}
                  style={{paddingRight:60}}/>
                <button onClick={()=>setShowPw(s=>!s)} type="button" style={{
                  position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
                  background:"none",border:"none",color:T.muted,cursor:"pointer",
                  fontSize:13,fontFamily:"DM Sans,sans-serif"}}>
                  {showPw?"Hide":"Show"}
                </button>
              </div>
              {!editId&&<div style={{fontSize:12,color:T.muted,marginTop:4}}>Required for new users</div>}
            </div>
          </div>

          {/* Address fields — optional */}
          <div style={{borderTop:`1px dashed ${T.border}`,paddingTop:12,marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:10}}>
              Address <span style={{fontWeight:700,textTransform:"none",letterSpacing:0}}>(optional)</span>
            </div>
            <div className="fg-addr" style={{display:"grid",gap:12}}>
              <div><FL>Street Address</FL><input placeholder="123 Main Street" value={form.address} onChange={e=>sf("address",e.target.value)}/></div>
              <div><FL>Suburb</FL><input placeholder="Ponsonby" value={form.suburb} onChange={e=>sf("suburb",e.target.value)}/></div>
              <div><FL>City</FL><input placeholder="Auckland" value={form.city} onChange={e=>sf("city",e.target.value)}/></div>
              <div><FL>Postcode</FL><input placeholder="1011" value={form.postcode} onChange={e=>sf("postcode",e.target.value)}/></div>
            </div>
          </div>

          {/* Approver/Viewer/Mentor: pick which apprentices (or apprentices+viewers for mentor) they cover */}
          {["Approver","Viewer","Mentor"].includes(form.role)&&(
            <div style={{marginBottom:16}}>
              <FL>Allocated {form.role==="Mentor"?"Apprentices & Viewers":"Apprentices"}</FL>
              {allocatable.length===0
                ? <div style={{fontSize:13,color:T.muted,fontStyle:"italic",marginTop:4}}>
                    No {form.role==="Mentor"?"apprentices or viewers":"apprentices"} found
                  </div>
                : <>
                    <select
                      value=""
                      onChange={e=>{if(e.target.value)toggleAlloc(e.target.value);}}
                      style={{marginTop:6,marginBottom:8}}>
                      <option value="">+ Add {form.role==="Mentor"?"person":"apprentice"}…</option>
                      {allocatable.filter(u=>!form.allocatedTo.includes(u.id)).map(u=>(
                        <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                      ))}
                    </select>
                    {form.allocatedTo.length>0&&(
                      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                        {form.allocatedTo.map(id=>{
                          const u=allocatable.find(x=>x.id===id);
                          if(!u) return null;
                          return (
                            <div key={id} style={{
                              display:"inline-flex",alignItems:"center",gap:6,
                              padding:"4px 10px",borderRadius:99,fontSize:13,fontWeight:700,
                              background:T.accentL,color:T.accent,
                              border:`1.5px solid ${T.accent}44`}}>
                              {u.name}
                              <button onClick={()=>toggleAlloc(id)} style={{
                                background:"none",border:"none",color:T.accent,
                                cursor:"pointer",padding:0,fontSize:14,lineHeight:1,
                                fontFamily:"DM Sans,sans-serif"}}>×</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {form.allocatedTo.length===0&&(
                      <div style={{fontSize:13,color:T.muted,fontStyle:"italic"}}>None selected yet</div>
                    )}
                  </>
              }
            </div>
          )}

          {/* Apprentice: Host Business, Overtime + Approver/Viewer/Mentor */}
          {form.role==="Apprentice"&&(
            <div style={{marginBottom:16}}>
              {/* Host Business */}
              <div style={{marginBottom:12}}>
                <FL>Host Business</FL>
                {(()=>{
                  const hostCos = (crmHostCompanies||[]);
                  const isListed = hostCos.some(c=>c.name===(form.hostBusiness||""));
                  const hostOnes = hostCos.filter(c=>c.isHostBusiness);
                  const otherOnes = hostCos.filter(c=>!c.isHostBusiness);
                  return hostCos.length>0?(
                    <div>
                      <select value={isListed?(form.hostBusiness||""):"__custom__"} onChange={e=>{if(e.target.value!=="__custom__")sf("hostBusiness",e.target.value);}}>
                        <option value="">— Select host business —</option>
                        {hostOnes.length>0&&<optgroup label="🏢 Host Businesses">
                          {hostOnes.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}
                        </optgroup>}
                        {otherOnes.length>0&&<optgroup label="All Companies">
                          {otherOnes.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}
                        </optgroup>}
                        <option value="__custom__">Other (type below)…</option>
                      </select>
                      {!isListed&&<input style={{marginTop:6}} placeholder="Type host business name…" value={form.hostBusiness||""} onChange={e=>sf("hostBusiness",e.target.value)}/>}
                    </div>
                  ):(
                    <input placeholder="e.g. Sparks Electrical Ltd" value={form.hostBusiness||""} onChange={e=>sf("hostBusiness",e.target.value)}/>
                  );
                })()}
              </div>
              {/* Overtime Settings */}
              <div style={{borderTop:`1px solid ${T.border}`,paddingTop:12,marginBottom:12}}>
                <div style={{fontWeight:700,fontSize:13,color:T.sub,textTransform:"uppercase",letterSpacing:".6px",marginBottom:8}}>
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
                    <input type="number" min="1" max="24" step="0.5"
                      placeholder={form.overtimeType==="daily"?"e.g. 8":"e.g. 40"}
                      value={form.overtimeThreshold||""} onChange={e=>sf("overtimeThreshold",parseFloat(e.target.value)||"")}/></div>}
                  {form.overtimeType&&<div>
                    <FL>Xero Overtime Rate ID</FL>
                    <input placeholder="Xero earnings rate UUID" value={form.overtimeRateId||""} onChange={e=>sf("overtimeRateId",e.target.value)}/>
                    <div style={{fontSize:11,color:T.muted,marginTop:2}}>Find in Xero → Payroll → Pay Items</div>
                  </div>}
                </div>
                <div style={{marginTop:12}}>
                  <FL>Reports Go To (email)</FL>
                  <input type="email" placeholder="e.g. manager@company.co.nz" value={form.reportsEmail||""} onChange={e=>sf("reportsEmail",e.target.value)}/>
                  <div style={{fontSize:11,color:T.muted,marginTop:2}}>Reports will be sent ONLY to these addresses. Leave blank to send to the approver.</div>
                </div>
                {form.overtimeType&&(
                  <div style={{marginTop:8,padding:"8px 12px",background:T.accentL,borderRadius:7,fontSize:13,color:T.accent}}>
                    {form.overtimeType==="daily"
                      ? `Any hours beyond ${form.overtimeThreshold||"?"}h in a single day will submit to Xero as overtime`
                      : `Any hours beyond ${form.overtimeThreshold||"?"}h in a week will submit to Xero as overtime`}
                  </div>
                )}
              </div>
              {/* Approver / Viewer / Mentor */}
              <div className="fg2" style={{display:"grid",gap:16}}>
              <div>
                <FL>Approver <span style={{fontWeight:700,color:T.muted}}>(approves timesheets)</span></FL>
                <select value={appApprover} onChange={e=>setAppApprover(e.target.value)}>
                  <option value="">— None —</option>
                  {approverOptions.map(u=>(
                    <option key={u.id} value={u.id}>
                      {u.name}{u.role==="Admin"?` (Admin${u.secondaryRole?` + ${u.secondaryRole}`:""})`:""}</option>
                  ))}
                </select>
              </div>
              <div>
                <FL>Viewer <span style={{fontWeight:700,color:T.muted}}>(read-only access)</span></FL>
                <select value={appViewer} onChange={e=>setAppViewer(e.target.value)}>
                  <option value="">— None —</option>
                  {viewerOptions.map(u=>(
                    <option key={u.id} value={u.id}>
                      {u.name}{u.role==="Admin"?` (Admin${u.secondaryRole?` + ${u.secondaryRole}`:""})`:""}</option>
                  ))}
                </select>
              </div>
              <div>
                <FL>Mentor <span style={{fontWeight:700,color:T.muted}}>(assigned KTA mentor)</span></FL>
                <select value={appMentor} onChange={e=>setAppMentor(e.target.value)}>
                  <option value="">— None —</option>
                  {users.filter(u=>u.role==="Mentor"||(u.role==="Admin")).map(u=>(
                    <option key={u.id} value={u.id}>{u.name}{u.role==="Admin"?" (Admin)":""}</option>
                  ))}
                </select>
              </div>
              <div>
                <FL>Supervisors <span style={{fontWeight:700,color:T.muted}}>(from host business, multiple allowed)</span></FL>
                {supervisorOptions.length===0
                  ? <div style={{fontSize:13,color:T.muted,fontStyle:"italic",marginTop:4}}>No Supervisor users yet — create them in Host Management tab</div>
                  : <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
                      {supervisorOptions.map(u=>{
                        const sel = appSupervisors.includes(u.id);
                        return (
                          <button key={u.id} type="button"
                            onClick={()=>setAppSupervisors(prev=>sel?prev.filter(id=>id!==u.id):[...prev,u.id])}
                            style={{padding:"4px 12px",borderRadius:8,fontSize:13,fontWeight:sel?700:400,
                              border:`1.5px solid ${sel?T.teal:T.border}`,
                              background:sel?T.tealL:T.surface,color:sel?T.teal:T.ink,
                              cursor:"pointer",fontFamily:"DM Sans,sans-serif",transition:"all .14s"}}>
                            {u.name}
                          </button>
                        );
                      })}
                    </div>
                }
              </div>
            </div>
            </div>
          )}

          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update User":"Create User"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);setAppApprover("");setAppViewer("");setAppMentor("");}}>Cancel</Btn>
          </div>
        </Card>
      )}

      {/* ── Group tabs ── */}
      {(()=>{
        const groups = {
          employees: { label:"👷 Apprentices",     roles:["Apprentice"],                  desc:"Apprentices enrolled with KTA" },
          host:      { label:"🏢 Host Management", roles:["Approver","Viewer","Supervisor"], desc:"Approvers, Viewers and Supervisors at host businesses" },
          office:    { label:"🏛 KTA Office Staff", roles:["Admin","Mentor"],             desc:"KTA administrators, office staff and mentors" },
        };
        return (
          <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
            {Object.entries(groups).map(([key,g])=>{
              const count = users.filter(u=>g.roles.includes(u.role)).length;
              const active = umTab===key;
              return (
                <button key={key} onClick={()=>setUmTab(key)} style={{
                  padding:"7px 16px",borderRadius:99,fontSize:14,fontWeight:700,
                  border:`1.5px solid ${active?T.accent:T.border}`,
                  background:active?T.accentL:T.surface,
                  color:active?T.accent:T.sub,
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                  display:"flex",alignItems:"center",gap:6,transition:"all .15s"}}>
                  {g.label}
                  <span style={{fontSize:12,fontWeight:700,padding:"1px 7px",borderRadius:99,
                    background:active?T.accent:T.border+"88",color:active?"#fff":T.muted}}>{count}</span>
                </button>
              );
            })}
          </div>
        );
      })()}

      <Card style={{padding:0,overflow:"hidden"}}>
        {(()=>{
          const groupRoles = {
            employees: ["Apprentice"],
            host:      ["Approver","Viewer","Supervisor"],
            office:    ["Admin","Mentor"],
          }[umTab] || [];
          const groupUsers = users.filter(u=>groupRoles.includes(u.role));
          const groupDesc = {
            employees: "Apprentices enrolled with KTA",
            host:      "Approvers, Viewers and Supervisors at host businesses",
            office:    "KTA administrators, office staff and mentors",
          }[umTab];
          return (
            <div>
              <div style={{padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
                fontSize:12,color:T.muted,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{display:"grid",gridTemplateColumns:"44px 1fr 130px 170px 1fr 72px",gap:8,flex:1,
                  fontWeight:700,textTransform:"uppercase",letterSpacing:".6px"}}>
                  <span/><UMCol field="name">Name</UMCol><UMCol field="role">Role</UMCol><UMCol field="email">Email</UMCol><span>Allocated To</span><span/>
                </div>
              </div>
              {groupUsers.length===0 ? (
                <div style={{padding:32,textAlign:"center",color:T.muted,fontSize:14,fontStyle:"italic"}}>
                  No users in this group yet.
                </div>
              ) : [...groupUsers].sort(umSort).map((u,i)=>{
                const isEditing = editId===u.id && showForm;
                return (
                  <div key={u.id} className="ri" style={{
                    display:"grid",gridTemplateColumns:"44px 1fr 130px 170px 1fr 72px",
                    padding:"12px 16px",
                    borderBottom:i<groupUsers.length-1?`1px solid ${T.border}44`:"none",
                    background:isEditing?T.blueL:i%2===0?T.surface:T.bg,
                    alignItems:"center",gap:8,animationDelay:`${i*.03}s`,
                    cursor:"pointer"}}
                    onClick={()=>{
                      if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[];
                      window.__ktaBackHandlers.push(()=>setViewingUser(null));
                      window.history.pushState({ktaNav:true},"");
                      setViewingUser(u);
                    }}
                    onMouseEnter={e=>{if(!isEditing)e.currentTarget.style.background=T.blueL+"99";}}
                    onMouseLeave={e=>{e.currentTarget.style.background=isEditing?T.blueL:i%2===0?T.surface:T.bg;}}>
                    <Avatar name={u.name} role={u.role}/>
                    <div>
                      <div style={{fontWeight:700,fontSize:14}}>{u.name}</div>
                      {u.phone&&<div style={{fontSize:12,color:T.muted}}>{u.phone}</div>}
                      <div style={{fontSize:12,color:T.blue,marginTop:1}}>
                        {isEditing?"editing…":"view details →"}
                      </div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                      <RolePill role={u.role} adminLevel={u.adminLevel||null} size="sm"/>
                      {u.role==="Admin"&&u.secondaryRole&&(
                        <><span style={{fontSize:11,color:T.muted}}>+</span><RolePill role={u.secondaryRole} size="sm"/></>
                      )}
                    </div>
                    <div style={{fontSize:13,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.email||"—"}</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center"}}>
                      {(u.allocatedTo||[]).length===0&&<span style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>—</span>}
                      {(u.allocatedTo||[]).map(aid=>{
                        const a=users.find(x=>x.id===aid);
                        return a?<span key={aid} style={{fontSize:13,color:T.sub,display:"flex",alignItems:"center",gap:4}}>
                          <RolePill role={a.role} size="sm"/>{a.name}
                        </span>:null;
                      })}
                    </div>
                    <div style={{display:"flex",gap:5,justifyContent:"flex-end"}} onClick={e=>e.stopPropagation()}>
                      {canEditUser(u)&&(
                        <button onClick={()=>{
                          if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[];
                          window.__ktaBackHandlers.push(()=>setViewingUser(null));
                          window.history.pushState({ktaNav:true},"");
                          setViewingUser(u);
                        }} style={{width:26,height:26,borderRadius:6,fontSize:13,
                          background:isEditing?T.blueL:"transparent",color:isEditing?T.blue:T.muted,
                          border:`1px solid ${isEditing?T.blue+"66":T.border}`,
                          display:"flex",alignItems:"center",justifyContent:"center"}}
                          onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                          onMouseLeave={e=>{e.currentTarget.style.background=isEditing?T.blueL:"transparent";e.currentTarget.style.color=isEditing?T.blue:T.muted;}}>✎</button>
                      )}
                      {canDeleteUser(u)&&(
                        <button onClick={()=>deleteUser(u.id)} style={{width:26,height:26,borderRadius:6,fontSize:13,
                          background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
                          display:"flex",alignItems:"center",justifyContent:"center"}}
                          onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                          onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
                      )}
                      {!canEditUser(u)&&(
                        <span style={{fontSize:12,color:T.muted,fontStyle:"italic",padding:"0 4px"}}>🔒</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </Card>
    </div>
  );
}




// ─────────────────────────────────────────────────────────────────────────────
// USER DETAIL VIEW — full detail page for non-Apprentice users (Approver, Viewer, Mentor, Admin)
// Apprentices use ApprenticeDetailView instead
// ─────────────────────────────────────────────────────────────────────────────
function UserDetailView({ user, allUsers, currentUser, canEdit, onEdit, onBack, onViewCompany }) {
  const fmtDate = (iso) => { if(!iso) return null; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };
  const daysUntil = (iso) => { if(!iso) return null; const t=new Date(); t.setHours(0,0,0,0); return Math.round((new Date(iso+"T00:00:00")-t)/86400000); };
  const expiryColor = (days) => days===null?T.muted:days<0?T.red:days<=30?T.warn:T.teal;

  const allocatedApprentices = allUsers.filter(u =>
    (user.allocatedTo||[]).includes(u.id) ||
    u.approverUserId===user.id ||
    u.viewerUserId===user.id ||
    u.mentorUserId===user.id
  );

  const roleColor = {Admin:T.accent,Mentor:T.teal,Approver:T.warn,Viewer:T.blue,Apprentice:T.sub,Supervisor:T.teal}[user.role]||T.muted;
  const roleBg    = {Admin:T.accentL,Mentor:T.tealL,Approver:T.warnL,Viewer:T.blueL,Apprentice:T.slateL,Supervisor:T.tealL}[user.role]||T.bg;

  const Field = ({icon, label, value, href, onClick}) => value ? (
    <div style={{display:"flex",alignItems:"flex-start",gap:10,padding:"9px 0",borderBottom:`1px solid ${T.border}`,
      cursor:onClick?"pointer":"default"}} onClick={onClick||undefined}>
      <span style={{fontSize:17,width:20,textAlign:"center",flexShrink:0,marginTop:1}}>{icon}</span>
      <div style={{flex:1}}>
        <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>{label}</div>
        {href
          ? <a href={href} style={{fontSize:14,color:T.accent,fontWeight:700,textDecoration:"none"}}>{value}</a>
          : onClick
            ? <div style={{fontSize:14,color:T.accent,fontWeight:700,lineHeight:1.5,textDecoration:"underline dotted"}}>{value}</div>
            : <div style={{fontSize:14,color:T.ink,lineHeight:1.5}}>{value}</div>}
      </div>
    </div>
  ) : null;

  return (
    <div className="fu">
      {/* Back */}
      <button onClick={onBack} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",
        color:T.accent,fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:16,padding:0,fontFamily:"DM Sans,sans-serif"}}>
        ← Back to Users
      </button>

      {/* Header card */}
      <Card style={{marginBottom:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            <Avatar name={user.name} role={user.role} size={52}/>
            <div>
              <div style={{fontWeight:700,fontSize:25,color:T.ink}}>{user.name}</div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
                <span style={{fontSize:13,fontWeight:700,padding:"3px 12px",borderRadius:20,background:roleBg,color:roleColor}}>
                  {user.role}{user.role==="Admin"&&user.adminLevel?` L${user.adminLevel}`:""}
                </span>
                {user.trade&&<span style={{fontSize:13,color:T.sub}}>🔧 {user.trade}</span>}
              </div>
            </div>
          </div>
          {canEdit&&(
            <Btn sm onClick={onEdit}>✎ Edit</Btn>
          )}
        </div>
      </Card>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:16}}>

        {/* Contact details */}
        <Card>
          <div style={{fontSize:12,fontWeight:700,color:T.accent,textTransform:"uppercase",letterSpacing:".6px",marginBottom:12}}>📋 Details</div>
          <Field icon="✉" label="Email"  value={user.email}  href={user.email?`mailto:${user.email}`:null}/>
          <Field icon="📞" label="Phone"  value={user.phone}  href={user.phone?`tel:${user.phone}`:null}/>
          <Field icon="📱" label="Mobile" value={user.mobile} href={user.mobile?`tel:${user.mobile}`:null}/>
          {user.company&&<Field icon="🏢" label="Company" value={user.company}
            onClick={onViewCompany ? ()=>onViewCompany(user.company) : null}/>}
          <Field icon="📅" label="Start Date"    value={user.startDate?fmtDate(user.startDate):null}/>
          <Field icon="🎂" label="Date of Birth" value={user.dateOfBirth?fmtDate(user.dateOfBirth):null}/>
          <Field icon="⚧"  label="Gender"        value={user.gender}/>
          {(user.address||user.city)&&(
            <Field icon="📍" label="Address"
              value={[user.address,user.addressLine2,user.suburb,user.city,user.postcode].filter(Boolean).join(", ")}/>
          )}
        </Card>

        {/* Compliance */}
        {(user.licenceExpiry||user.siteSafeExpiry||user.firstAidExpiry||user.licenceNumber||user.siteSafeNumber) && (
          <Card>
            <div style={{fontSize:12,fontWeight:700,color:T.accent,textTransform:"uppercase",letterSpacing:".6px",marginBottom:12}}>🪪 Compliance</div>
            {user.licenceExpiry&&(()=>{const d=daysUntil(user.licenceExpiry);return(
              <div style={{display:"flex",alignItems:"flex-start",gap:10,padding:"9px 0",borderBottom:`1px solid ${T.border}`}}>
                <span style={{fontSize:17,width:20,textAlign:"center",flexShrink:0}}>⚡</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>EW Licence Expiry</div>
                  <div style={{fontSize:14,fontWeight:700,color:expiryColor(d)}}>
                    {fmtDate(user.licenceExpiry)}{d!==null?` (${d<0?"Expired":d===0?"Today":`${d}d`})`:""}
                  </div>
                </div>
              </div>
            );})()}
            <Field icon="🪪" label="Licence Number" value={user.licenceNumber}/>
            {user.siteSafeExpiry&&(()=>{const d=daysUntil(user.siteSafeExpiry);return(
              <div style={{display:"flex",alignItems:"flex-start",gap:10,padding:"9px 0",borderBottom:`1px solid ${T.border}`}}>
                <span style={{fontSize:17,width:20,textAlign:"center",flexShrink:0}}>🛡</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>Site Safe Expiry</div>
                  <div style={{fontSize:14,fontWeight:700,color:expiryColor(d)}}>
                    {fmtDate(user.siteSafeExpiry)}{d!==null?` (${d<0?"Expired":d===0?"Today":`${d}d`})`:""}
                  </div>
                </div>
              </div>
            );})()}
            <Field icon="🛡" label="Site Safe Number" value={user.siteSafeNumber}/>
            {user.firstAidExpiry&&(()=>{const d=daysUntil(user.firstAidExpiry);return(
              <div style={{display:"flex",alignItems:"flex-start",gap:10,padding:"9px 0",borderBottom:`1px solid ${T.border}`}}>
                <span style={{fontSize:17,width:20,textAlign:"center",flexShrink:0}}>🏥</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>First Aid Expiry</div>
                  <div style={{fontSize:14,fontWeight:700,color:expiryColor(d)}}>
                    {fmtDate(user.firstAidExpiry)}{d!==null?` (${d<0?"Expired":d===0?"Today":`${d}d`})`:""}
                  </div>
                </div>
              </div>
            );})()}
          </Card>
        )}

        {/* Emergency contact */}
        {(user.emergencyContactName||user.emergencyContactPhone)&&(
          <Card style={{border:`1.5px solid ${T.red}33`,background:T.redL+"44"}}>
            <div style={{fontSize:12,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:".6px",marginBottom:12}}>🚨 Emergency Contact</div>
            <Field icon="👤" label="Name"         value={user.emergencyContactName}/>
            <Field icon="🤝" label="Relationship" value={user.emergencyContactRelationship}/>
            <Field icon="📞" label="Phone"         value={user.emergencyContactPhone} href={user.emergencyContactPhone?`tel:${user.emergencyContactPhone}`:null}/>
          </Card>
        )}

        {/* Allocated apprentices */}
        {allocatedApprentices.length>0&&(
          <Card>
            <div style={{fontSize:12,fontWeight:700,color:T.accent,textTransform:"uppercase",letterSpacing:".6px",marginBottom:12}}>
              👷 Allocated Apprentices ({allocatedApprentices.length})
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {allocatedApprentices.map(app=>(
                <div key={app.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",
                  background:T.accentL,borderRadius:8}}>
                  <Avatar name={app.name} role="Apprentice" size={32}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:14}}>{app.name}</div>
                    <div style={{fontSize:12,color:T.sub}}>{app.trade||"—"}{app.hostBusiness?` · ${app.hostBusiness}`:""}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CRM MODULE
// ─────────────────────────────────────────────────────────────────────────────
function CRMUsersPanel({allUsers, navigateTo}) {
  const [open, setOpen] = useState(false);
  const sorted = [...(allUsers||[])].sort((a,b)=>{
    const rank = {Admin:0,Mentor:1,Approver:2,Viewer:3,Supervisor:3,Apprentice:4};
    const ra = rank[a.role]??5, rb = rank[b.role]??5;
    return ra!==rb ? ra-rb : a.name.localeCompare(b.name);
  });
  const shown = open ? sorted : sorted.slice(0,6);
  return (
    <Card style={{marginBottom:14,border:`1.5px solid ${T.accentL}`}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:28,height:28,borderRadius:8,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>{"👥"}</div>
          <div>
            <div style={{fontWeight:700,fontSize:14}}>KTA Users</div>
            <div style={{fontSize:12,color:T.muted}}>{sorted.length} users</div>
          </div>
        </div>
        <div style={{display:"flex",gap:6}}>
          {sorted.length>6&&<button onClick={()=>setOpen(p=>!p)} style={{background:"none",border:`1px solid ${T.border}`,borderRadius:6,padding:"3px 9px",fontSize:12,color:T.muted,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>{open?"Less":"All "+sorted.length}</button>}
          <Btn sm onClick={()=>navigateTo("users")}>Open Users</Btn>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))",gap:7}}>
        {shown.map(u=>{
          const roleColor = {Admin:T.accent,Mentor:T.teal,Approver:T.warn,Viewer:T.blue,Apprentice:T.sub}[u.role]||T.muted;
          const roleLabel = u.role==="Admin"?`Admin${u.adminLevel?" L"+u.adminLevel:""}`:u.role;
          return (
            <div key={u.id} onClick={()=>navigateTo("users")}
              style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",
                background:T.bg,borderRadius:8,border:`1px solid ${T.border}`,cursor:"pointer"}}
              onMouseEnter={e=>e.currentTarget.style.background=T.accentL}
              onMouseLeave={e=>e.currentTarget.style.background=T.bg}>
              <Avatar name={u.name} role={u.role} size={28}/>
              <div style={{minWidth:0,flex:1}}>
                <div style={{fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.name}</div>
                <div style={{fontSize:11,color:roleColor,fontWeight:700}}>{roleLabel}{u.trade?" - "+u.trade:""}</div>
              </div>
            </div>
          );
        })}
      </div>
      {!open&&sorted.length>6&&<div style={{fontSize:12,color:T.muted,textAlign:"center",marginTop:6}}>+{sorted.length-6} more</div>}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HUBSPOT PROPERTY INSPECTOR — standalone component so hooks are valid
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// COMPANY CONTACT ROW — inline editable contact row inside company detail view
// ─────────────────────────────────────────────────────────────────────────────
function CompanyContactRow({ contact:c, index:i, total, canEdit, canDelete, isApprenticeContact, onView, onEdit, onDelete, onSave }) {
  const [expanded, setExpanded] = useState(false);
  const [editing,  setEditing]  = useState(false);
  const [form, setForm] = useState({
    name:c.name||"", email:c.email||"", phone:c.phone||"", mobile:c.mobile||"",
    job_title:c.job_title||c.jobTitle||"", status:c.status||"Active", notes:c.notes||"",
  });
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await onSave(form);
    setEditing(false);
    setSaving(false);
  };

  return (
    <div style={{borderBottom:i<total-1?`1px solid ${T.border}44`:"none"}}>
      {/* Row summary */}
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 4px",
        borderRadius:8,background:editing?T.blueL+"44":"none"}}
        onMouseEnter={e=>{if(!editing)e.currentTarget.style.background=T.accentL+"55";}}
        onMouseLeave={e=>{if(!editing)e.currentTarget.style.background="none";}}>
        <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={()=>!editing&&setExpanded(s=>!s)}>
          <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{c.name}</div>
          <div style={{fontSize:12,color:T.muted,display:"flex",gap:10,marginTop:1,flexWrap:"wrap"}}>
            {c.email&&<span>✉ {c.email}</span>}
            {c.phone&&<span>📞 {c.phone}</span>}
            {c.mobile&&<span>📱 {c.mobile}</span>}
            {(c.job_title||c.jobTitle)&&<span>💼 {c.job_title||c.jobTitle}</span>}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
          <span style={{fontSize:12,padding:"2px 8px",borderRadius:10,
            background:c.status==="Active"?T.accentL:T.slateL,
            color:c.status==="Active"?T.accent:T.muted}}>{c.status||"Active"}</span>
          {canEdit&&!editing&&(
            <button onClick={()=>{setEditing(true);setExpanded(true);setForm({name:c.name||"",email:c.email||"",phone:c.phone||"",mobile:c.mobile||"",job_title:c.job_title||c.jobTitle||"",status:c.status||"Active",notes:c.notes||""});}}
              style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",
                color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}
              onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
          )}
          <button onClick={()=>!editing&&setExpanded(s=>!s)}
            style={{width:26,height:26,borderRadius:6,fontSize:11,background:"transparent",
              color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
            {expanded?"▲":"▼"}
          </button>
          {canDelete&&!isApprenticeContact&&(
            <button onClick={onDelete}
              style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",
                color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}
              onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
          )}
        </div>
      </div>

      {/* Expanded detail / edit form */}
      {expanded&&(
        <div style={{padding:"0 4px 12px 4px"}}>
          {editing ? (
            <div style={{background:T.blueL+"33",borderRadius:8,padding:"12px 14px",border:`1px solid ${T.blue}33`}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,marginBottom:10}}>
                {[["name","Name"],["email","Email"],["phone","Phone"],["mobile","Mobile"],["job_title","Job Title"]].map(([k,lbl])=>(
                  <div key={k}>
                    <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".4px",marginBottom:3}}>{lbl}</div>
                    <input value={form[k]} onChange={e=>sf(k,e.target.value)}
                      style={{width:"100%",fontSize:14,padding:"6px 10px",borderRadius:6,
                        border:`1.5px solid ${T.border}`,background:T.surface,color:T.ink,
                        fontFamily:"DM Sans,sans-serif",boxSizing:"border-box"}}/>
                  </div>
                ))}
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".4px",marginBottom:3}}>Status</div>
                  <select value={form.status} onChange={e=>sf("status",e.target.value)}
                    style={{width:"100%",fontSize:14,padding:"6px 10px",borderRadius:6,
                      border:`1.5px solid ${T.border}`,background:T.surface,color:T.ink,fontFamily:"DM Sans,sans-serif"}}>
                    {["Active","Prospect","Inactive"].map(s=><option key={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div style={{marginBottom:10}}>
                <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".4px",marginBottom:3}}>Notes</div>
                <textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} rows={2}
                  style={{width:"100%",fontSize:14,padding:"6px 10px",borderRadius:6,
                    border:`1.5px solid ${T.border}`,background:T.surface,color:T.ink,
                    fontFamily:"DM Sans,sans-serif",resize:"vertical",boxSizing:"border-box"}}/>
              </div>
              <div style={{display:"flex",gap:8}}>
                <Btn sm onClick={save} disabled={saving}>{saving?"Saving…":"💾 Save"}</Btn>
                <Btn sm v="ghost" onClick={()=>setEditing(false)}>Cancel</Btn>
                <button onClick={()=>{setEditing(false);onView();}}
                  style={{marginLeft:"auto",fontSize:13,color:T.accent,background:"none",border:"none",
                    cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontWeight:700,textDecoration:"underline"}}>
                  Full profile →
                </button>
              </div>
            </div>
          ) : (
            <div style={{padding:"4px 0 4px 4px",display:"flex",flexWrap:"wrap",gap:"6px 20px"}}>
              {c.notes&&<div style={{width:"100%",fontSize:13,color:T.sub,lineHeight:1.5}}>📝 {c.notes}</div>}
              <button onClick={onView}
                style={{fontSize:13,color:T.accent,background:"none",border:"none",
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontWeight:700,padding:0,textDecoration:"underline"}}>
                View full profile →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE FINDER — finds duplicate contacts or companies by name/email
// ─────────────────────────────────────────────────────────────────────────────
function DuplicateFinder({ items, type, onDelete, onView, canDelete, onMerge }) {
  const [show, setShow]         = useState(false);
  const [matchBy, setMatchBy]   = useState("name"); // "name" | "email"
  const [dismissed, setDismissed] = useState(new Set());
  const [mergeGroup, setMergeGroup] = useState(null); // group being merged
  const [masterId, setMasterId]     = useState(null);  // chosen master record

  // Group items by normalised key
  const groups = (() => {
    const map = {};
    items.forEach(item => {
      let key = "";
      if (matchBy === "name") {
        key = (item.name || "").toLowerCase().trim().replace(/\s+/g, " ");
      } else {
        key = (item.email || "").toLowerCase().trim();
      }
      if (!key) return;
      if (!map[key]) map[key] = [];
      map[key].push(item);
    });
    return Object.values(map)
      .filter(g => g.length > 1)
      .filter(g => !dismissed.has(g.map(i => i.id).sort().join(",")))
      .sort((a, b) => (a[0].name || "").localeCompare(b[0].name || ""));
  })();

  const dismiss = (group) => {
    setDismissed(prev => new Set([...prev, group.map(i => i.id).sort().join(",")]));
  };

  const doMerge = async () => {
    if(!mergeGroup || !masterId || !onMerge) return;
    const master  = mergeGroup.find(i=>i.id===masterId);
    const victims = mergeGroup.filter(i=>i.id!==masterId);
    // Merge: fill any blank fields in master from victims, then delete victims
    const merged = {...master};
    for(const v of victims) {
      for(const k of Object.keys(v)) {
        if(!merged[k] && v[k]) merged[k] = v[k];
      }
    }
    await onMerge(merged, victims.map(v=>v.id));
    setMergeGroup(null);
    setMasterId(null);
    setDismissed(prev => new Set([...prev, mergeGroup.map(i=>i.id).sort().join(",")]));
  };

  return (
    <>
    {/* Merge modal */}
    {mergeGroup && createPortal(
      <div style={{position:"fixed",inset:0,zIndex:3000,background:"rgba(13,27,46,0.55)",
        display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
        <div style={{background:"#fff",borderRadius:14,padding:28,maxWidth:560,width:"100%",
          boxShadow:"0 8px 40px rgba(0,0,0,.18)"}}>
          <div style={{fontFamily:"DM Sans",fontSize:19,fontWeight:700,marginBottom:4}}>Merge Duplicates</div>
          <div style={{fontSize:14,color:T.sub,marginBottom:20}}>
            Select which record becomes the <strong>master</strong>. All contacts/links will be moved to it, missing fields will be filled from the others, then duplicates are deleted.
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
            {mergeGroup.map(item=>(
              <button key={item.id} onClick={()=>setMasterId(item.id)}
                style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
                  borderRadius:10,cursor:"pointer",textAlign:"left",fontFamily:"DM Sans,sans-serif",
                  background:masterId===item.id?T.tealL:T.surface,
                  border:`2px solid ${masterId===item.id?T.teal:T.border}`,
                  transition:"all .14s"}}>
                <div style={{width:36,height:36,borderRadius:"50%",background:masterId===item.id?T.teal:T.border,
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:16,fontWeight:700,color:"#fff",flexShrink:0}}>
                  {masterId===item.id?"★":"○"}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:16,color:T.ink}}>{item.name}</div>
                  <div style={{fontSize:12,color:T.muted,marginTop:2,display:"flex",gap:8,flexWrap:"wrap"}}>
                    {item.email&&<span>✉ {item.email}</span>}
                    {item.phone&&<span>📞 {item.phone}</span>}
                    {item.city&&<span>📍 {item.city}</span>}
                    {item.address&&<span>{item.address}</span>}
                  </div>
                </div>
                {masterId===item.id&&<span style={{fontSize:12,fontWeight:700,color:T.teal,flexShrink:0}}>MASTER</span>}
              </button>
            ))}
          </div>
          <div style={{fontSize:13,color:T.warn,background:T.warnL,borderRadius:8,padding:"8px 12px",marginBottom:16}}>
            ⚠ This will permanently delete {mergeGroup.length-1} record{mergeGroup.length>2?"s":""} after merging.
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={doMerge} disabled={!masterId}>
              🔀 Merge into Master
            </Btn>
            <Btn v="ghost" onClick={()=>{setMergeGroup(null);setMasterId(null);}}>Cancel</Btn>
          </div>
        </div>
      </div>,
      document.body
    )}
    <Card style={{marginBottom:14, border:`1.5px solid ${T.warn}44`}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer"}}
        onClick={()=>setShow(s=>!s)}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:T.warnL,display:"flex",
            alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🔁</div>
          <div>
            <div style={{fontWeight:700,fontSize:14,color:T.warn}}>
              Find Duplicate {type === "contacts" ? "Contacts" : "Companies"}
            </div>
            <div style={{fontSize:12,color:T.muted,marginTop:1}}>
              {show && groups.length > 0
                ? `${groups.length} potential duplicate group${groups.length!==1?"s":""} found`
                : show && groups.length === 0
                ? "No duplicates found"
                : `Scan ${items.length} ${type} for duplicates`}
            </div>
          </div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.muted} strokeWidth="2.5"
          style={{transition:"transform .2s",transform:show?"rotate(180deg)":"rotate(0deg)",flexShrink:0}}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>

      {show && (
        <div style={{marginTop:14}}>
          {/* Match by toggle */}
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
            <span style={{fontSize:13,color:T.muted,fontWeight:700}}>Match by:</span>
            {["name","email"].map(opt => (
              <button key={opt} onClick={()=>{setMatchBy(opt);setDismissed(new Set());}}
                style={{padding:"4px 14px",borderRadius:8,fontSize:13,fontWeight:700,
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                  background:matchBy===opt?T.warn:T.bg,
                  color:matchBy===opt?"#fff":T.sub,
                  border:`1.5px solid ${matchBy===opt?T.warn:T.border}`}}>
                {opt.charAt(0).toUpperCase()+opt.slice(1)}
              </button>
            ))}
            {type === "contacts" && matchBy === "email" && (
              <span style={{fontSize:12,color:T.muted}}>— blank emails are ignored</span>
            )}
          </div>

          {groups.length === 0 ? (
            <div style={{padding:"20px 0",textAlign:"center",color:T.teal,fontSize:14,fontWeight:700}}>
              ✓ No duplicates found by {matchBy}
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {groups.map(group => (
                <div key={group.map(i=>i.id).join(",")}
                  style={{border:`1.5px solid ${T.warn}44`,borderRadius:10,overflow:"hidden"}}>
                  {/* Group header */}
                  <div style={{background:T.warnL,padding:"8px 14px",display:"flex",
                    alignItems:"center",justifyContent:"space-between"}}>
                    <div style={{fontSize:13,fontWeight:700,color:T.warn}}>
                      {group.length} records · {matchBy==="name"
                        ? `"${group[0].name}"`
                        : `"${group[0].email}"`}
                    </div>
                    <button onClick={()=>dismiss(group)}
                      style={{fontSize:12,color:T.muted,background:"none",border:"none",
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                      Dismiss ✕
                    </button>
                  </div>
                  {/* Records in this group */}
                  {group.map((item, i) => (
                    <div key={item.id} style={{
                      display:"flex",alignItems:"center",gap:12,padding:"10px 14px",
                      borderBottom:i<group.length-1?`1px solid ${T.border}44`:"none",
                      background:i%2===0?T.surface:T.bg}}>
                      <Avatar name={item.name} role={type==="contacts"?"Apprentice":"Admin"} size={32}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{item.name||"—"}</div>
                        <div style={{fontSize:12,color:T.muted,display:"flex",gap:10,flexWrap:"wrap",marginTop:1}}>
                          {item.email&&<span>✉ {item.email}</span>}
                          {item.phone&&<span>📞 {item.phone}</span>}
                          {type==="contacts"&&item.company&&<span>🏢 {item.company}</span>}
                          {type==="companies"&&item.city&&<span>📍 {item.city}</span>}
                          {type==="companies"&&item.industry&&<span>🔧 {item.industry}</span>}
                        </div>
                      </div>
                      <div style={{display:"flex",gap:6,flexShrink:0}}>
                        <button onClick={()=>onView(item)}
                          style={{fontSize:12,padding:"4px 10px",borderRadius:6,cursor:"pointer",
                            background:T.accentL,color:T.accent,border:`1px solid ${T.accent}44`,
                            fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
                          View
                        </button>
                        {canDelete&&onMerge&&(
                          <button onClick={()=>{setMergeGroup(group);setMasterId(item.id);}}
                            style={{fontSize:12,padding:"4px 10px",borderRadius:6,cursor:"pointer",
                              background:T.tealL,color:T.teal,border:`1px solid ${T.teal}44`,
                              fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
                            🔀 Merge
                          </button>
                        )}
                        {canDelete&&(
                          <button onClick={async ()=>{
                            if(!await ktaConfirm(`Delete "${item.name}"? This cannot be undone.`)) return;
                            onDelete(item.id);
                          }}
                            style={{fontSize:12,padding:"4px 10px",borderRadius:6,cursor:"pointer",
                              background:T.redL,color:T.red,border:`1px solid ${T.red}44`,
                              fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
    </>
  );
}

function HubSpotPropertyInspector({ hsToken, hsFetch }) {
  const [inspecting, setInspecting]   = useState(false);
  const [propData,   setPropData]     = useState(null);
  const [propFilter, setPropFilter]   = useState("");
  const [showInspector, setShowInspector] = useState(false);

  const runInspect = async () => {
    if(!hsToken.trim()){alert("Enter your HubSpot token first.");return;}
    setInspecting(true); setPropData(null);
    try {
      const propDefs = await hsFetch("getContactProperties");
      const sample   = await hsFetch("inspectContact");
      const sampleProps = sample.results?.[0]?.properties || {};
      const props = (propDefs.results||[])
        .filter(p=>p.name&&!p.hidden)
        .map(p=>({
          name:  p.name,
          label: p.label||p.name,
          value: sampleProps[p.name]||"",
        }))
        .sort((a,b)=>(a.name||"").localeCompare(b.name||""));
      setPropData(props);
    } catch(e){ alert("Inspect failed: "+e.message); }
    setInspecting(false);
  };

  return (
    <Card style={{marginBottom:12,border:`1.5px solid ${T.gold}44`}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer"}}
        onClick={()=>setShowInspector(s=>!s)}>
        <div>
          <div style={{fontWeight:700,fontSize:14,color:T.gold}}>🔍 Property Inspector</div>
          <div style={{fontSize:12,color:T.muted,marginTop:2}}>
            Find exact HubSpot property names for licence expiry, emergency contact etc.
          </div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.muted} strokeWidth="2.5"
          style={{transition:"transform .2s",transform:showInspector?"rotate(180deg)":"rotate(0deg)",flexShrink:0}}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>

      {showInspector&&(
        <div style={{marginTop:14}}>
          <div style={{fontSize:13,color:T.sub,marginBottom:10,lineHeight:1.6}}>
            Fetches all property definitions from your HubSpot account and shows their exact internal names
            alongside a sample value from the first contact. Search for "licence", "safe", "emergency", "expiry" etc.
          </div>
          <Btn sm onClick={runInspect} disabled={inspecting} style={{marginBottom:12}}>
            {inspecting?"⏳ Fetching…":"🔍 Inspect Contact Properties"}
          </Btn>
          {propData&&(
            <>
              <div style={{marginBottom:8,display:"flex",gap:8,alignItems:"center"}}>
                <input placeholder="Filter by name or label…" value={propFilter}
                  onChange={e=>setPropFilter(e.target.value)}
                  style={{flex:1,fontSize:13,padding:"5px 10px"}}/>
                <span style={{fontSize:12,color:T.muted,flexShrink:0}}>{propData.length} properties</span>
              </div>
              <div style={{maxHeight:400,overflowY:"auto",border:`1px solid ${T.border}`,borderRadius:8}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead>
                    <tr style={{background:T.bg,position:"sticky",top:0}}>
                      {["Internal Name","Label","Sample Value"].map(h=>(
                        <th key={h} style={{padding:"8px 10px",textAlign:"left",fontWeight:700,color:T.muted,
                          textTransform:"uppercase",letterSpacing:".5px",borderBottom:`1px solid ${T.border}`}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {propData
                      .filter(p=>!propFilter.trim()||
                        p.name.toLowerCase().includes(propFilter.toLowerCase())||
                        p.label.toLowerCase().includes(propFilter.toLowerCase())||
                        (p.value&&p.value.toLowerCase().includes(propFilter.toLowerCase())))
                      .map((p,i)=>(
                        <tr key={p.name} style={{background:i%2===0?T.surface:T.bg,borderBottom:`1px solid ${T.border}44`}}>
                          <td style={{padding:"6px 10px",fontFamily:"monospace",color:p.value?T.accent:T.muted,
                            fontWeight:p.value?700:400,whiteSpace:"nowrap"}}>{p.name}</td>
                          <td style={{padding:"6px 10px",color:T.sub}}>{p.label}</td>
                          <td style={{padding:"6px 10px",color:p.value?T.ink:T.muted,fontStyle:p.value?"normal":"italic",
                            maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {p.value||"—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div style={{fontSize:12,color:T.muted,marginTop:8}}>
                💡 Properties shown in blue have data in your account. Share the exact names and we'll update the sync.
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function CRMModule({currentUser,allUsers,onSyncTick,navigateTo,onUserCreated}) {
  // Auto-open company if navigated from elsewhere (e.g. UserDetailView)
  const fmtDateNZ = (iso) => { if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };
  const [contacts,setContacts]=useState([]);
  const [companies,setCompanies]=useState([]);
  const [deals,setDeals]=useState([]);
  const [crmLoading,setCrmLoading]=useState(true);
  const [tab,setTab]=useState(()=>{try{return localStorage.getItem("wos_crm_tab")||"contacts";}catch{return "contacts";}});
  const goTab=(t)=>{setTab(t);try{localStorage.setItem("wos_crm_tab",t);}catch{}};
  const [contactSearch,setContactSearch]=useState("");
  const [companySearch,setCompanySearch]=useState("");
  const [contactSort,setContactSort]=useState("az");   // "az" | "za"
  const [companySort,setCompanySort]=useState("az");   // "az" | "za"
  const {sortFn:crmCtSort, ColHeader:CRMCtCol, sortField:crmCtField} = useSort("name","asc");
  const {sortFn:crmCoSort, ColHeader:CRMCoCol, sortField:crmCoField} = useSort("name","asc");
  const [showHostsOnly,setShowHostsOnly]=useState(()=>{
    try{ const v=localStorage.getItem("wos_crm_hosts_only"); localStorage.removeItem("wos_crm_hosts_only"); return v==="1"; }catch{ return false; }
  });
  const [hsToken,setHsToken]=useState("");
  const [hsPreview,setHsPreview]=useState(null);   // {total, contacts:[]}
  const [hsLoading,setHsLoading]=useState(false);
  const [hsImporting,setHsImporting]=useState(false);
  const [hsMsg,setHsMsg]=useState("");
  const [hsSelected,setHsSelected]=useState(new Set());
  const [showCF,setShowCF]=useState(false);
  const [showDF,setShowDF]=useState(false);
  const [expandedContact,setExpandedContact]=useState(null);
  const [expandedCompany,setExpandedCompany]=useState(null);
  const [showCoForm,setShowCoForm]=useState(false);
  const [detailContact,setDetailContact]=useState(null); // contact object for full-page view
  const [detailCompany,setDetailCompany]=useState(null); // company object for full-page view

  // Auto-open company when navigated from another module (e.g. UserDetailView)
  useEffect(()=>{
    try {
      const pending = sessionStorage.getItem("crm_open_company");
      if(pending && companies.length > 0) {
        sessionStorage.removeItem("crm_open_company");
        const co = companies.find(c=>c.name===pending);
        if(co){ if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[]; window.__ktaBackHandlers.push(()=>setDetailCompany(null)); window.history.pushState({ktaNav:true},""); setDetailCompany(co); }
      }
    } catch{}
  },[companies]);
  const [convertContact,setConvertContact]=useState(null);   // contact being converted to user
  const [convertRole,setConvertRole]=useState("Approver");   // selected role for new user
  const [convertAlloc,setConvertAlloc]=useState([]);          // allocated apprentice IDs
  const [convertSaving,setConvertSaving]=useState(false);
  const [convertDone,setConvertDone]=useState(false);
  const [editCoId,setEditCoId]=useState(null);
  const [coForm,setCoForm]=useState({name:"",industry:"",phone:"",website:"",address:"",city:"",postcode:"",country:"New Zealand",notes:"",status:"Active",isHostBusiness:false});
  const [coSaving,setCoSaving]=useState(false);
  const scf=(k,v)=>setCoForm(f=>({...f,[k]:v}));
  const coBlank={name:"",industry:"",phone:"",website:"",address:"",city:"",postcode:"",country:"New Zealand",notes:"",status:"Active",isHostBusiness:false};

  const saveCo=async()=>{
    if(!coForm.name.trim()){alert("Company name is required.");return;}
    setCoSaving(true);
    const id=editCoId||uid();
    const row={id,name:coForm.name.trim(),industry:coForm.industry,phone:coForm.phone,website:coForm.website,
      address:coForm.address,city:coForm.city,postcode:coForm.postcode,country:coForm.country,
      notes:coForm.notes,status:coForm.status,hubspot_id:"",is_host_business:coForm.isHostBusiness?true:false};
    try {
      await upsertRow("crm_companies",row);
      const mapped={id,name:coForm.name.trim(),industry:coForm.industry,phone:coForm.phone,website:coForm.website,
        address:coForm.address,city:coForm.city,postcode:coForm.postcode,country:coForm.country,
        notes:coForm.notes,status:coForm.status,hubspotId:"",isHostBusiness:coForm.isHostBusiness?true:false};
      if(editCoId) setCompanies(prev=>prev.map(c=>c.id===editCoId?mapped:c));
      else setCompanies(prev=>[mapped,...prev]);
      setShowCoForm(false);setEditCoId(null);setCoForm(coBlank);
    } catch(e) {
      alert("Failed to save company: "+e.message);
    }
    setCoSaving(false);
  };
  const [cForm,setCForm]=useState({name:"",company:"",companyId:"",email:"",phone:"",mobile:"",status:"Active",notes:""});
  const [dForm,setDForm]=useState({title:"",contact:"",value:"",stage:"Lead",closeDate:"",notes:""});
  const [editCId,setEditCId]=useState(null);
  const [hsEmail,setHsEmail]=useState("");
  const [hsStatus,setHsStatus]=useState(null); // null | "searching" | "found" | "notfound" | "error"
  const [hsSource,setHsSource]=useState(false); // true if form was populated from HubSpot

  // Listen for navigation events from other modules (e.g. Email Capture "Add to CRM")
  useEffect(()=>{
    const handler = (e) => {
      const {module, tab, action} = e.detail||{};
      if(module==="crm") {
        if(tab) goTab(tab);
        if(action==="add") {
          // Check for prefilled contact from sessionStorage
          try{
            const prefill = sessionStorage.getItem("kta_prefill_contact");
            if(prefill){
              const data = JSON.parse(prefill);
              sessionStorage.removeItem("kta_prefill_contact");
              setCForm({name:data.name||"",company:data.company||"",companyId:"",
                email:data.email||"",phone:data.phone||"",status:"Active",notes:""});
              setEditCId(null);
              setShowCF(true);
            }
          }catch{}
        }
      }
    };
    window.addEventListener("kta-navigate", handler);
    return () => window.removeEventListener("kta-navigate", handler);
  },[]);

  useEffect(()=>{
    (async()=>{
      try{
        const [c,d,co]=await Promise.all([loadTable('crm_contacts'),loadTable('crm_deals'),loadTable('crm_companies').catch(()=>[])]);
        setContacts(c.map(x=>({id:x.id,name:x.name,company:x.company||"",companyId:x.company_id||"",email:x.email||"",phone:x.phone||"",status:x.status||"Active",notes:x.notes||""})));
        setDeals(d.map(x=>({id:x.id,title:x.title,contact:x.contact||"",value:x.value||"",stage:x.stage||"Lead",closeDate:x.close_date||"",notes:x.notes||""})));
        setCompanies(co.map(x=>({id:x.id,name:x.name,industry:x.industry||"",phone:x.phone||"",website:x.website||"",address:x.address||"",city:x.city||"",country:x.country||"",hubspotId:x.hubspot_id||"",notes:x.notes||"",status:x.status||"Active",isHostBusiness:x.is_host_business||false,postcode:x.postcode||""})));
      }catch(e){console.error('CRM load',e);}
      finally{setCrmLoading(false);}
    })();
  },[]);

  const role=currentUser.role;
  const fullAccess=role==="Admin"||role==="Mentor";
  const canEdit=role==="Admin"||role==="Mentor";
  const canDelete=role==="Admin"&&Number(currentUser.adminLevel ?? 1)===1;
  const isAdmin1CRM = role==="Admin"&&Number(currentUser.adminLevel ?? 1)===1;

  const isApprenticeContact = (c) => allUsers && allUsers.some(u=>u.role==="Apprentice"&&u.email&&c.email&&u.email.toLowerCase()===c.email.toLowerCase());
  const isExistingUser = (c) => allUsers && allUsers.some(u=>u.email&&c.email&&u.email.toLowerCase()===c.email.toLowerCase());

  const saveConvertToUser = async () => {
    if(!convertContact) return;
    setConvertSaving(true);
    try {
      const nameParts = (convertContact.name||"").trim().split(" ");
      const newUser = {
        id:            uid(),
        name:          convertContact.name||"",
        firstName:     nameParts[0]||"",
        lastName:      nameParts.slice(1).join(" ")||"",
        email:         convertContact.email||"",
        phone:         convertContact.phone||"",
        role:          convertRole,
        password:      await hashPw(Math.random().toString(36).slice(2,10)),
        allocatedTo:   [...convertAlloc],   // copy the array
        trade:         convertContact.trade||"",
        address:       convertContact.address||"",
        addressLine2:  "",
        suburb:        "",
        city:          convertContact.city||"",
        postcode:      convertContact.postcode||"",
        country:       convertContact.country||"",
        adminLevel:    1,
        secondaryRole: null,
        licenceExpiry: convertContact.ew_licence_expiry||"",
        siteSafeExpiry:convertContact.site_safe_expiry||"",
        firstAidExpiry:convertContact.first_aid_expiry||"",
        licenceNumber: convertContact.licence_number||"",
        siteSafeNumber:convertContact.site_safe_number||"",
        emergencyContactName:         convertContact.emergency_contact_name||"",
        emergencyContactPhone:        convertContact.emergency_contact_phone||"",
        emergencyContactRelationship: convertContact.emergency_contact_relationship||"",
        hostBusiness:"", mentorUserId:null, approverUserId:null, viewerUserId:null,
        overtimeType:null, overtimeThreshold:null, overtimeRateId:null,
        xeroEmployeeId:null, gender:"", startDate:null, dateOfBirth:null,
      };

      // upsertUser handles all snake_case field mapping correctly
      const { upsertUser } = await import("./supabaseClient");
      await upsertUser(newUser);

      // Update App-level users state immediately (don't rely on realtime delay)
      if(onUserCreated) onUserCreated(newUser);

      setConvertDone(true);
      setTimeout(()=>{
        setConvertContact(null);
        setConvertDone(false);
        setConvertRole("Approver");
        setConvertAlloc([]);
      }, 2000);
    } catch(e) {
      alert("Failed to create user: "+e.message);
    }
    setConvertSaving(false);
  };

  const sc=(k,v)=>setCForm(f=>({...f,[k]:v}));
  const sd=(k,v)=>setDForm(f=>({...f,[k]:v}));

  const resetContactForm = () => {
    setCForm({name:"",company:"",companyId:"",email:"",phone:"",status:"Active",notes:""});
    setHsEmail(""); setHsStatus(null); setHsSource(false);
  };

  const handleHsLookup = async () => {
    const val = hsEmail.trim();
    if(!val) return;
    setHsStatus("searching");
    const result = await lookupHubspot(val);
    if(result) {
      setCForm(result);
      setHsStatus("found");
      setHsSource(true);
    } else {
      // Pre-fill whichever field they typed so they don't have to retype
      const isPhone = /^[+\d\s\-()]{6,}$/.test(val) && !/[@.]/.test(val);
      setCForm(f=>({...f, [isPhone?"phone":"email"]: val}));
      setHsStatus("notfound");
      setHsSource(false);
    }
  };

  const saveContact=()=>{
    if(!cForm.name.trim()) return;
    const row={...cForm};

    // If this contact matches a KTA user, sync phone/mobile/company back to their user record
    const syncToUser = (email, phone, mobile, company) => {
      if(!email||!allUsers) return;
      const linkedUser = allUsers.find(u=>u.email&&u.email.toLowerCase()===email.toLowerCase());
      if(!linkedUser) return;
      const updates = {};
      if(phone  && !linkedUser.phone)  updates.phone  = phone;
      if(mobile && !linkedUser.mobile) updates.mobile = mobile;
      if(company && !linkedUser.hostBusiness) updates.hostBusiness = company;
      // Always overwrite phone/mobile if explicitly set
      if(phone)  updates.phone  = phone;
      if(mobile) updates.mobile = mobile;
      if(Object.keys(updates).length === 0) return;
      const updatedUser = {...linkedUser, ...updates};
      updateRow("users", linkedUser.id, updates).catch(console.error);
      // Note: in-memory allUsers will update on next sync tick
    };

    if(editCId){
      setContacts(prev=>prev.map(c=>c.id===editCId?{...c,...row,companyId:row.companyId||c.companyId}:c));
      upsertRow("crm_contacts",{id:editCId,name:row.name,company:row.company||"",company_id:row.companyId||null,email:row.email||"",phone:row.phone||"",mobile:row.mobile||"",status:row.status||"Active",notes:row.notes||""}).catch(console.error);
      syncToUser(row.email, row.phone, row.mobile, row.company);
      setEditCId(null);
    } else {
      const id=uid();
      setContacts(prev=>[{id,...row},...prev]);
      upsertRow("crm_contacts",{id,name:row.name,company:row.company||"",company_id:row.companyId||null,email:row.email||"",phone:row.phone||"",mobile:row.mobile||"",status:row.status||"Active",notes:row.notes||""}).catch(console.error);
    }
    setCForm({name:"",company:"",companyId:"",email:"",phone:"",mobile:"",status:"Active",notes:""});resetContactForm();setShowCF(false);
  };
  const saveDeal=()=>{
    if(!dForm.title.trim()) return;
    const id=uid();
    const row={id,...dForm};
    setDeals(prev=>[row,...prev]);
    upsertRow('crm_deals',{id,title:dForm.title,contact:dForm.contact||"",value:dForm.value||"",stage:dForm.stage||"Lead",close_date:dForm.closeDate||null,notes:dForm.notes||""}).catch(console.error);
    setDForm({title:"",contact:"",value:"",stage:"Lead",closeDate:"",notes:""});setShowDF(false);
  };
  const moveDeal=(id,stage)=>{ setDeals(prev=>prev.map(d=>d.id===id?{...d,stage}:d)); upsertRow("crm_deals",{id,stage}).catch(console.error); };
  const startEditC=(c)=>{setCForm({name:c.name,company:c.company||"",companyId:c.companyId||c.company_id||"",email:c.email||"",phone:c.phone||"",mobile:c.mobile||"",status:c.status,notes:c.notes||""});setEditCId(c.id);setHsStatus(null);setHsSource(false);setHsEmail("");setShowCF(true);};

  const pipeline=STAGES.map(s=>({stage:s,color:STAGE_C[s],
    items:deals.filter(d=>d.stage===s),
    value:deals.filter(d=>d.stage===s).reduce((a,d)=>a+(parseFloat(d.value)||0),0)}));
  const totalOpen=deals.filter(d=>!["Won","Lost"].includes(d.stage)).reduce((a,d)=>a+(parseFloat(d.value)||0),0);
  const totalWon=deals.filter(d=>d.stage==="Won").reduce((a,d)=>a+(parseFloat(d.value)||0),0);

  // ── Contact Detail Page ─────────────────────────────────────────────────────
  if(detailContact) {
    const co = companies.find(x=>x.id===detailContact.companyId);
    const linkedApp = allUsers && allUsers.find(u=>u.role==="Apprentice"&&u.email&&detailContact.email&&u.email.toLowerCase()===detailContact.email.toLowerCase());
    return (
      <div className="fu">
        <button onClick={()=>setDetailContact(null)} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",color:T.accent,fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:16,padding:0,fontFamily:"DM Sans,sans-serif"}}>
          ← Back to Contacts
        </button>
        <Card style={{marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
            <div>
              <div style={{fontWeight:700,fontSize:25,color:T.ink}}>{detailContact.name}</div>
              {co&&<div style={{fontSize:14,color:T.accent,fontWeight:700,marginTop:2,cursor:"pointer"}} onClick={()=>{ if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[]; window.__ktaBackHandlers.push(()=>{setDetailCompany(null);setDetailContact(detailContact);}); window.history.pushState({ktaNav:true},""); setDetailContact(null); setDetailCompany(co); }}>{co.name}</div>}
              {!co&&detailContact.company&&<div style={{fontSize:14,color:T.sub,marginTop:2}}>{detailContact.company}</div>}
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <span style={{padding:"4px 12px",borderRadius:20,fontSize:13,fontWeight:700,background:detailContact.status==="Active"?T.accentL:detailContact.status==="Prospect"?T.warnL:T.slateL,color:detailContact.status==="Active"?T.accent:detailContact.status==="Prospect"?T.warn:T.muted}}>{detailContact.status}</span>
              {canEdit&&<Btn sm onClick={()=>{startEditC(detailContact);setDetailContact(null);goTab("contacts");}}>✎ Edit</Btn>}
            </div>
          </div>
        </Card>

        {/* ── Convert to User toggle — Admin L1 only ── */}
        {isAdmin1CRM && !isExistingUser(detailContact) && (
          <Card style={{marginBottom:16, border:`1.5px solid ${convertContact?T.accent:T.border}`}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div>
                <div style={{fontWeight:700,fontSize:14,color:convertContact?T.accent:T.ink}}>👤 Make this contact a system user</div>
                <div style={{fontSize:12,color:T.muted,marginTop:2}}>Adds them to KTA so they can log in</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
                <span style={{fontSize:13,fontWeight:700,color:convertContact?T.accent:T.muted}}>{convertContact?"Yes":"No"}</span>
                <div onClick={()=>{ setConvertContact(convertContact?null:detailContact); setConvertRole("Approver"); setConvertAlloc([]); setConvertDone(false); }}
                  style={{position:"relative",width:52,height:28,borderRadius:14,cursor:"pointer",
                    background:convertContact?T.accent:T.border,transition:"background .2s",flexShrink:0}}>
                  <div style={{position:"absolute",top:3,left:convertContact?26:3,width:22,height:22,
                    borderRadius:"50%",background:"#fff",boxShadow:"0 1px 4px rgba(0,0,0,.25)",transition:"left .2s"}}/>
                </div>
              </div>
            </div>

            {convertContact && (
              <div style={{marginTop:16,borderTop:`1px solid ${T.border}`,paddingTop:16}}>
                {convertDone ? (
                  <div style={{textAlign:"center",color:T.teal,fontWeight:700,fontSize:16,padding:"8px 0"}}>
                    ✓ User created successfully!
                  </div>
                ) : (
                  <>
                    {/* Role picker */}
                    <div style={{marginBottom:14}}>
                      <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:8}}>Assign Role</div>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        {["Approver","Viewer","Mentor","Admin"].map(r=>(
                          <button key={r} onClick={()=>{setConvertRole(r);setConvertAlloc([]);}}
                            style={{padding:"6px 16px",borderRadius:8,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                              background:convertRole===r?T.accent:T.bg,
                              color:convertRole===r?"#fff":T.sub,
                              border:`1.5px solid ${convertRole===r?T.accent:T.border}`}}>
                            {r}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Apprentice allocation — only for Approver/Viewer */}
                    {["Approver","Viewer"].includes(convertRole) && (
                      <div style={{marginBottom:14}}>
                        <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:8}}>
                          Allocate Apprentices
                        </div>
                        {allUsers.filter(u=>u.role==="Apprentice").length===0
                          ? <div style={{fontSize:13,color:T.muted,fontStyle:"italic"}}>No apprentices in system yet</div>
                          : <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:180,overflowY:"auto"}}>
                            {allUsers.filter(u=>u.role==="Apprentice").sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(u=>{
                              const checked=convertAlloc.includes(u.id);
                              return (
                                <div key={u.id} onClick={()=>setConvertAlloc(prev=>checked?prev.filter(id=>id!==u.id):[...prev,u.id])}
                                  style={{display:"flex",alignItems:"center",gap:10,padding:"7px 10px",borderRadius:7,cursor:"pointer",
                                    background:checked?T.accentL:T.bg,border:`1.5px solid ${checked?T.accent:T.border}`}}>
                                  <div style={{width:16,height:16,borderRadius:4,background:checked?T.accent:T.surface,
                                    border:`2px solid ${checked?T.accent:T.border}`,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                                    {checked&&<span style={{color:"#fff",fontSize:11,fontWeight:700}}>✓</span>}
                                  </div>
                                  <Avatar name={u.name} role="Apprentice" size={24}/>
                                  <div style={{flex:1,minWidth:0}}>
                                    <div style={{fontSize:14,fontWeight:700,color:T.ink}}>{u.name}</div>
                                    {u.trade&&<div style={{fontSize:12,color:T.muted}}>{u.trade}</div>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        }
                      </div>
                    )}

                    {/* Summary & save */}
                    <div style={{background:T.accentL,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:13,color:T.accent}}>
                      Will create: <strong>{detailContact.name}</strong> as <strong>{convertRole}</strong>
                      {["Approver","Viewer"].includes(convertRole)&&convertAlloc.length>0&&` · ${convertAlloc.length} apprentice${convertAlloc.length!==1?"s":""} allocated`}
                      {["Approver","Viewer"].includes(convertRole)&&convertAlloc.length===0&&<span style={{color:T.warn}}> · No apprentices allocated yet</span>}
                      <br/><span style={{color:T.muted}}>A temporary password will be set — remind them to update it on first login.</span>
                    </div>

                    <Btn onClick={saveConvertToUser} disabled={convertSaving}>
                      {convertSaving?"Creating user…":"✓ Create User"}
                    </Btn>
                  </>
                )}
              </div>
            )}
          </Card>
        )}

        {/* Already a user badge */}
        {isExistingUser(detailContact) && (
          <div style={{marginBottom:16,padding:"10px 14px",borderRadius:8,background:T.tealL,
            border:`1px solid ${T.teal}44`,fontSize:13,color:T.teal,fontWeight:700}}>
            ✓ This contact is already a KTA system user
          </div>
        )}

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:14}}>
          {[
            {label:"📧 Email",val:detailContact.email,href:detailContact.email?`mailto:${detailContact.email}`:null},
            {label:"📱 Mobile",val:detailContact.mobile,href:detailContact.mobile?`tel:${detailContact.mobile}`:null},
            {label:"📞 Phone",val:detailContact.phone,href:detailContact.phone?`tel:${detailContact.phone}`:null},
            {label:"💼 Job Title",val:detailContact.job_title||detailContact.jobTitle||""},
            {label:"🏢 Company",val:co?co.name:detailContact.company},
            {label:"🏭 Industry",val:co?.industry},
            {label:"📍 Address",val:[detailContact.address,detailContact.city,detailContact.postcode].filter(Boolean).join(", ")},
            {label:"⚡ Status",val:detailContact.status},
            {label:"🎯 Lead Status",val:detailContact.hs_lead_status||detailContact.hsLeadStatus||""},
            {label:"⚡ EW Licence Expiry",val:(detailContact.ew_licence_expiry||detailContact.ewLicenceExpiry)?fmtDateNZ(detailContact.ew_licence_expiry||detailContact.ewLicenceExpiry):null},
            {label:"🪪 Licence Number",val:detailContact.licence_number||detailContact.licenceNumber||""},
            {label:"🛡 Site Safe Expiry",val:detailContact.site_safe_expiry?fmtDateNZ(detailContact.site_safe_expiry):null},
            {label:"🛡 Site Safe Number",val:detailContact.site_safe_number||detailContact.siteSafeNumber||""},
            {label:"🏥 First Aid Expiry",val:detailContact.first_aid_expiry?fmtDateNZ(detailContact.first_aid_expiry):null},
            {label:"🏥 First Aid Number",val:detailContact.first_aid_number||""},
            {label:"📅 Last Contacted",val:detailContact.notes_last_contacted||""},
            {label:"ℹ Description",val:detailContact.description||""},
            {label:"📝 Notes",val:detailContact.notes},
          ].filter(f=>f.val).map(f=>(
            <Card key={f.label} style={{padding:"14px 16px"}}>
              <div style={{fontSize:11,fontWeight:700,color:T.accent,textTransform:"uppercase",letterSpacing:".6px",marginBottom:6}}>{f.label}</div>
              {f.href
                ? <a href={f.href} style={{fontSize:14,color:T.accent,fontWeight:700,textDecoration:"none"}}>{f.val}</a>
                : <div style={{fontSize:14,color:T.ink,lineHeight:1.5}}>{f.val}</div>}
            </Card>
          ))}
        </div>
        {/* Emergency Contact */}
        {(detailContact.emergency_contact_name||detailContact.emergencyContactName)&&(
          <Card style={{marginTop:14,border:`1.5px solid ${T.red}33`,background:T.redL+"44"}}>
            <div style={{fontSize:12,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:".6px",marginBottom:10}}>🚨 Emergency Contact</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:"8px 20px"}}>
              <div>
                <div style={{fontSize:11,color:T.muted,fontWeight:700,marginBottom:2}}>Name</div>
                <div style={{fontSize:14,fontWeight:700,color:T.ink}}>{detailContact.emergency_contact_name||detailContact.emergencyContactName}</div>
              </div>
              {(detailContact.emergency_contact_relationship||detailContact.emergencyContactRelationship)&&(
                <div>
                  <div style={{fontSize:11,color:T.muted,fontWeight:700,marginBottom:2}}>Relationship</div>
                  <div style={{fontSize:14,color:T.ink}}>{detailContact.emergency_contact_relationship||detailContact.emergencyContactRelationship}</div>
                </div>
              )}
              {(detailContact.emergency_contact_phone||detailContact.emergencyContactPhone)&&(
                <div>
                  <div style={{fontSize:11,color:T.muted,fontWeight:700,marginBottom:2}}>Phone</div>
                  <a href={`tel:${detailContact.emergency_contact_phone||detailContact.emergencyContactPhone}`}
                    style={{fontSize:14,color:T.accent,fontWeight:700,textDecoration:"none"}}>
                    {detailContact.emergency_contact_phone||detailContact.emergencyContactPhone}
                  </a>
                </div>
              )}
            </div>
          </Card>
        )}
        {linkedApp&&(
          <Card style={{marginTop:14}}>
            <div style={{fontSize:12,fontWeight:700,color:T.accent,textTransform:"uppercase",letterSpacing:".6px",marginBottom:10}}>👷 KTA Apprentice</div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <Avatar name={linkedApp.name} role="Apprentice" size={36}/>
              <div>
                <div style={{fontWeight:700,fontSize:16}}>{linkedApp.name}</div>
                <div style={{fontSize:13,color:T.sub}}>{linkedApp.trade} · {linkedApp.hostBusiness}</div>
              </div>
            </div>
          </Card>
        )}
        {co&&(
          <Card style={{marginTop:14}}>
            <div style={{fontSize:12,fontWeight:700,color:T.accent,textTransform:"uppercase",letterSpacing:".6px",marginBottom:10}}>🏢 Company Details</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:"8px 20px"}}>
              {co.phone&&<div><span style={{fontSize:12,color:T.muted}}>Phone: </span><span style={{fontSize:14}}>{co.phone}</span></div>}
              {co.website&&<div><span style={{fontSize:12,color:T.muted}}>Website: </span><a href={co.website.startsWith("http")?co.website:"https://"+co.website} target="_blank" rel="noreferrer" style={{fontSize:14,color:T.accent}}>{co.website}</a></div>}
              {co.city&&<div><span style={{fontSize:12,color:T.muted}}>City: </span><span style={{fontSize:14}}>{co.city}</span></div>}
            </div>
          </Card>
        )}
      </div>
    );
  }

  // ── Company Detail Page ───────────────────────────────────────────────────
  if(detailCompany) {
    const co = detailCompany;
    const linkedContacts = contacts.filter(c=>{
      if(c.companyId===co.id) return true;
      if(!c.companyId && c.company) {
        const cn = (c.company||"").toLowerCase().trim();
        const coN = (co.name||"").toLowerCase().trim();
        if(!cn || !coN || coN.length < 3) return false;
        return cn===coN || (coN.length >= 5 && cn.includes(coN)) || (cn.length >= 5 && coN.includes(cn));
      }
      return false;
    });

    // Auto-link by name
    const unlinkFixed = linkedContacts.filter(c=>!c.companyId&&c.company);
    if(unlinkFixed.length>0){
      unlinkFixed.forEach(c=>{
        upsertRow("crm_contacts",{id:c.id,company_id:co.id}).catch(()=>{});
        setContacts(prev=>prev.map(x=>x.id===c.id?{...x,companyId:co.id}:x));
      });
    }
    const allocatedApprentices = allUsers ? allUsers.filter(u=>u.role==="Apprentice"&&(u.hostBusiness||"").toLowerCase().trim()===(co.name||"").toLowerCase().trim()) : [];
    const wsiteHref = co.website?(co.website.startsWith("http")?co.website:"https://"+co.website):null;

    const toggleHostBusiness = async () => {
      const updated = {...co, isHostBusiness: !co.isHostBusiness};
      await upsertRow("crm_companies", {id:co.id, is_host_business: !co.isHostBusiness}).catch(console.error);
      setCompanies(prev=>prev.map(c=>c.id===co.id?updated:c));
      setDetailCompany(updated);
    };

    return (
      <div className="fu">
        {/* ── Back + header ── */}
        <button onClick={()=>setDetailCompany(null)} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",color:T.accent,fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:16,padding:0,fontFamily:"DM Sans,sans-serif"}}>
          ← Back to Companies
        </button>

        {/* ── Hero card ── */}
        <div style={{background:"#fff",borderRadius:14,border:`1px solid ${T.border}`,marginBottom:16,overflow:"hidden"}}>
          {/* Top bar */}
          <div style={{background:`linear-gradient(135deg,${T.accent}18,${T.teal}12)`,borderBottom:`1px solid ${T.border}`,padding:"20px 24px",display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
            <div style={{display:"flex",alignItems:"center",gap:14}}>
              <div style={{width:52,height:52,borderRadius:12,background:T.accent,display:"flex",alignItems:"center",justifyContent:"center",fontSize:25,fontWeight:700,color:"#fff",flexShrink:0}}>
                {(co.name||"?")[0].toUpperCase()}
              </div>
              <div>
                <div style={{fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:25,color:T.ink}}>{co.name}</div>
                <div style={{display:"flex",gap:8,marginTop:4,flexWrap:"wrap",alignItems:"center"}}>
                  {co.industry&&<span style={{fontSize:13,color:T.sub,fontWeight:700}}>{co.industry}</span>}
                  {co.city&&<span style={{fontSize:13,color:T.muted}}>📍 {co.city}{co.country&&co.country!=="New Zealand"?`, ${co.country}`:""}</span>}
                  {co.isHostBusiness&&<span style={{fontSize:12,fontWeight:700,color:T.teal,background:T.tealL,padding:"2px 10px",borderRadius:20,border:`1px solid ${T.teal}44`}}>🏢 Host Business</span>}
                  {co.status&&co.status!=="Active"&&<span style={{fontSize:12,fontWeight:700,color:T.warn,background:T.warnL,padding:"2px 10px",borderRadius:20}}>{co.status}</span>}
                </div>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              {canEdit&&<Btn sm onClick={()=>{setCoForm({name:co.name,industry:co.industry||"",phone:co.phone||"",website:co.website||"",address:co.address||"",city:co.city||"",postcode:co.postcode||"",country:co.country||"New Zealand",notes:co.notes||"",status:co.status||"Active",isHostBusiness:co.isHostBusiness||false});setEditCoId(co.id);setShowCoForm(true);setDetailCompany(null);goTab("companies");}}>✎ Edit</Btn>}
              {canDelete&&<Btn sm v="danger" onClick={async ()=>{if(!await ktaConfirm(`Delete ${co.name}?`))return;setCompanies(prev=>prev.filter(x=>x.id!==co.id));deleteRow("crm_companies",co.id).catch(console.error);setDetailCompany(null);}}>✕ Delete</Btn>}
            </div>
          </div>

          {/* Properties grid */}
          <div style={{padding:"16px 24px",display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:"16px 32px"}}>
            {[
              {icon:"📱",label:"Phone",     val:co.phone,    href:`tel:${co.phone}`},
              {icon:"🌐",label:"Website",   val:co.website,  href:wsiteHref,  isLink:true},
              {icon:"📍",label:"Address",   val:[co.address,co.city,co.postcode].filter(Boolean).join(", ")},
              {icon:"🏭",label:"Industry",  val:co.industry},
              {icon:"🌏",label:"Country",   val:co.country},
            ].filter(f=>f.val).map(f=>(
              <div key={f.label}>
                <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>{f.icon} {f.label}</div>
                {f.isLink
                  ? <a href={f.href} target="_blank" rel="noreferrer" style={{fontSize:14,color:T.accent,fontWeight:700,textDecoration:"none"}}>{f.val}</a>
                  : f.href
                    ? <a href={f.href} style={{fontSize:14,color:T.accent,fontWeight:700,textDecoration:"none"}}>{f.val}</a>
                    : <div style={{fontSize:14,color:T.ink,fontWeight:700}}>{f.val}</div>
                }
              </div>
            ))}
            {canEdit&&(
              <div>
                <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:6}}>🏢 Host Business</div>
                <div onClick={toggleHostBusiness} style={{display:"inline-flex",alignItems:"center",gap:8,cursor:"pointer"}}>
                  <div style={{position:"relative",width:44,height:24,borderRadius:12,background:co.isHostBusiness?T.teal:T.border,transition:"background .2s",flexShrink:0}}>
                    <div style={{position:"absolute",top:2,left:co.isHostBusiness?22:2,width:20,height:20,borderRadius:"50%",background:"#fff",boxShadow:"0 1px 4px rgba(0,0,0,.2)",transition:"left .2s"}}/>
                  </div>
                  <span style={{fontSize:13,fontWeight:700,color:co.isHostBusiness?T.teal:T.muted}}>{co.isHostBusiness?"Yes":"No"}</span>
                </div>
              </div>
            )}
          </div>

          {co.notes&&(
            <div style={{padding:"0 24px 16px"}}>
              <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:6}}>📝 Notes</div>
              <div style={{fontSize:14,color:T.ink,lineHeight:1.6,background:T.bg,borderRadius:8,padding:"10px 14px",border:`1px solid ${T.border}`}}>{co.notes}</div>
            </div>
          )}
        </div>

        {/* ── Two-column layout ── */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:16,alignItems:"start"}}>

          {/* LEFT — Contacts (main panel) */}
          <div>
            <div style={{background:"#fff",borderRadius:14,border:`1px solid ${T.border}`,overflow:"hidden"}}>
              <div style={{padding:"14px 20px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{fontWeight:700,fontSize:17,color:T.ink}}>👥 Contacts</div>
                  {linkedContacts.length>0&&<span style={{fontSize:12,fontWeight:700,color:"#fff",background:T.accent,borderRadius:20,padding:"1px 8px"}}>{linkedContacts.length}</span>}
                </div>
                {canEdit&&(
                  <Btn sm onClick={()=>{resetContactForm();setEditCId(null);setCForm(f=>({...f,company:co.name,companyId:co.id}));setShowCF(true);setDetailCompany(null);goTab("contacts");}}>
                    + Add Contact
                  </Btn>
                )}
              </div>
              {linkedContacts.length===0?(
                <div style={{padding:"32px 20px",textAlign:"center",color:T.muted,fontSize:14,fontStyle:"italic"}}>
                  No contacts linked to this company yet.<br/>
                  <span style={{fontSize:13}}>Use "+ Add Contact" to create one.</span>
                </div>
              ):(
                <div>
                  {linkedContacts.map((c,i)=>(
                    <div key={c.id}
                      onClick={()=>{ if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[]; window.__ktaBackHandlers.push(()=>{setDetailContact(null);setDetailCompany(co);}); window.history.pushState({ktaNav:true},""); setDetailCompany(null); setDetailContact(c); }}
                      style={{display:"flex",alignItems:"center",gap:12,padding:"12px 20px",
                        borderBottom:i<linkedContacts.length-1?`1px solid ${T.border}44`:"none",
                        cursor:"pointer",transition:"background .12s"}}
                      onMouseEnter={e=>e.currentTarget.style.background=T.accentL+"55"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <Avatar name={c.name} role="Approver" size={36}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:700,fontSize:16,color:T.ink}}>{c.name}</div>
                        <div style={{fontSize:12,color:T.muted,marginTop:2,display:"flex",gap:12,flexWrap:"wrap"}}>
                          {(c.job_title||c.jobTitle)&&<span>💼 {c.job_title||c.jobTitle}</span>}
                          {c.email&&<span>✉ {c.email}</span>}
                          {c.phone&&<span>📞 {c.phone}</span>}
                        </div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                        <span style={{fontSize:12,padding:"2px 8px",borderRadius:10,
                          background:c.status==="Active"?T.accentL:T.slateL,
                          color:c.status==="Active"?T.accent:T.muted}}>{c.status||"Active"}</span>
                        {canEdit&&(
                          <button onClick={e=>{e.stopPropagation();startEditC(c);setDetailCompany(null);goTab("contacts");}}
                            style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}
                            onMouseEnter={e=>{e.stopPropagation();e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
                        )}
                        {canDelete&&(
                          <button onClick={async e=>{e.stopPropagation();if(!await ktaConfirm(`Delete ${c.name}?`))return;setContacts(prev=>prev.filter(x=>x.id!==c.id));deleteRow("crm_contacts",c.id).catch(console.error);}}
                            style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}
                            onMouseEnter={e=>{e.stopPropagation();e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;}}
                            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✕</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT — sidebar */}
          <div style={{display:"flex",flexDirection:"column",gap:12}}>

            {/* KTA Apprentices */}
            {allocatedApprentices.length>0&&(
              <div style={{background:"#fff",borderRadius:14,border:`1px solid ${T.border}`,overflow:"hidden"}}>
                <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,fontWeight:700,fontSize:14,color:T.teal}}>
                  👷 KTA Apprentices ({allocatedApprentices.length})
                </div>
                <div style={{padding:"8px 0"}}>
                  {allocatedApprentices.map(app=>(
                    <div key={app.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 16px"}}>
                      <Avatar name={app.name} role="Apprentice" size={30}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{app.name}</div>
                        <div style={{fontSize:12,color:T.teal}}>{app.trade||"—"}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Quick stats */}
            <div style={{background:"#fff",borderRadius:14,border:`1px solid ${T.border}`,padding:"14px 16px"}}>
              <div style={{fontWeight:700,fontSize:13,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:10}}>Summary</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {[
                  {label:"Contacts",   val:linkedContacts.length,       color:T.accent},
                  {label:"Apprentices",val:allocatedApprentices.length, color:T.teal},
                  {label:"Status",     val:co.status||"Active",          color:T.ink},
                ].map(s=>(
                  <div key={s.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:14}}>
                    <span style={{color:T.muted}}>{s.label}</span>
                    <span style={{fontWeight:700,color:s.color}}>{s.val}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if(!fullAccess) return (
    <div className="fu">
      <div style={{background:T.warnL,border:`1.5px solid ${T.warn}44`,borderRadius:10,padding:"16px 20px",display:"flex",gap:12,alignItems:"center"}}>
        <span style={{fontSize:25}}>🔒</span>
        <div>
          <strong style={{color:T.warn,fontSize:16}}>Restricted Access</strong>
          <div style={{fontSize:14,color:T.sub,marginTop:3}}>CRM is available to Admins and Mentors only.</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fu">
      <div style={{background:ROLE_META[role].bg,border:`1.5px solid ${ROLE_META[role].color}44`,
        borderRadius:10,padding:"10px 16px",marginBottom:20,display:"flex",gap:10,alignItems:"center"}}>
        <span style={{fontSize:18}}>{ROLE_META[role].symbol}</span>
        <span style={{fontWeight:700,color:ROLE_META[role].color,fontSize:14}}>{role} View — </span>
        <span style={{fontSize:14,color:T.sub}}>{canEdit?"Full CRM access — edit contacts and deals":"Read-only CRM view"}</span>
      </div>
      <div className="stat-grid-4">
        <StatCard label="Contacts" value={contacts.length} color={T.blue}/>
        <StatCard label="Active Deals" value={deals.filter(d=>!["Won","Lost"].includes(d.stage)).length} color={T.warn}/>
        <StatCard label="Prospective Placements" value={deals.filter(d=>!["Won","Lost"].includes(d.stage)).length} color={T.accent}/>
        <StatCard label="Placed This Year" value={deals.filter(d=>d.stage==="Won"&&d.close_date&&d.close_date.startsWith(new Date().getFullYear().toString())).length} color={T.hol}/>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        {["contacts","companies","pipeline","deals","import"].map(t=>(
          <button key={t} onClick={()=>goTab(t)} style={{
            padding:"7px 16px",borderRadius:8,fontSize:14,fontWeight:700,
            background:tab===t?T.accent:T.surface,color:tab===t?"#fff":T.sub,
            border:`1.5px solid ${tab===t?T.accentD:T.border}`,
            fontFamily:"DM Sans,sans-serif",cursor:"pointer",transition:"all .14s"
          }}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>
        ))}
      </div>
      {tab==="contacts"&&(<>
        {role==="Admin"&&<CRMUsersPanel allUsers={allUsers} navigateTo={navigateTo}/>}
        {canEdit&&<div style={{marginBottom:14}}>
          <Btn sm onClick={()=>{ resetContactForm(); setEditCId(null); setShowCF(s=>!s); }}>
            {showCF?"✕ Cancel":"+ Add Contact"}
          </Btn>
        </div>}

        <DuplicateFinder
          items={contacts}
          type="contacts"
          canDelete={canDelete}
          onView={(c)=>{ if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[]; window.__ktaBackHandlers.push(()=>setDetailContact(null)); window.history.pushState({ktaNav:true},""); setDetailContact(c); }}
          onDelete={(id)=>{ setContacts(prev=>prev.filter(x=>x.id!==id)); deleteRow("crm_contacts",id).catch(console.error); }}
          onMerge={async(master, victimIds)=>{
            await upsertRow("crm_contacts",{
              id:master.id, name:master.name, company:master.company||null,
              company_id:master.companyId||null, email:master.email||null,
              phone:master.phone||null, status:master.status||"Active", notes:master.notes||null,
            }).catch(console.error);
            for(const vid of victimIds) {
              await deleteRow("crm_contacts",vid).catch(console.error);
            }
            setContacts(prev=>[...prev.filter(x=>x.id!==master.id&&!victimIds.includes(x.id)),master]);
          }}
        />

        {showCF&&<Card style={{marginBottom:16,border:`1.5px solid ${T.blue}44`}}>
          {/* ── Step 1: HubSpot lookup (only shown for new contacts) ── */}
          {!editCId&&hsStatus!=="found"&&hsStatus!=="notfound"&&(
            <div style={{marginBottom:16}}>
              <div style={{fontWeight:700,fontSize:14,color:T.ink,marginBottom:4,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:18}}>🔍</span> Look up in HubSpot
              </div>
              <div style={{fontSize:13,color:T.sub,marginBottom:10}}>Enter an email or phone number to auto-fill from HubSpot.</div>
              <div style={{display:"flex",gap:8}}>
                <input
                  placeholder="Email address or phone number…"
                  value={hsEmail}
                  onChange={e=>setHsEmail(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&handleHsLookup()}
                  style={{flex:1,borderColor:T.border}}
                />
                <button onClick={handleHsLookup} disabled={hsStatus==="searching"||!hsEmail.trim()} style={{
                  padding:"9px 18px",background:T.accent,color:"#fff",border:`1.5px solid ${T.accentD}`,
                  borderRadius:9,fontSize:14,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",
                  fontFamily:"DM Sans,sans-serif",opacity:(!hsEmail.trim()||hsStatus==="searching")?0.5:1,
                  display:"flex",alignItems:"center",gap:7,transition:"all .15s"
                }}>
                  {hsStatus==="searching"
                    ? <><span style={{width:13,height:13,border:"2px solid #ffffff66",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin .7s linear infinite"}}/>Searching…</>
                    : "Search HubSpot"
                  }
                </button>
              </div>
              <div style={{marginTop:10,textAlign:"right"}}>
                <button onClick={()=>setHsStatus("notfound")} style={{
                  background:"none",border:"none",color:T.muted,fontSize:13,
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif",textDecoration:"underline"
                }}>Skip — enter manually</button>
              </div>
            </div>
          )}

          {/* ── HubSpot result banner ── */}
          {hsStatus==="found"&&(
            <div style={{background:T.accentL,border:`1.5px solid ${T.accent}44`,borderRadius:9,
              padding:"9px 14px",marginBottom:14,display:"flex",gap:10,alignItems:"center",fontSize:14}}>
              <span style={{fontSize:18}}>✓</span>
              <div style={{flex:1}}>
                <strong style={{color:T.accent}}>Found in HubSpot</strong>
                <span style={{color:T.sub,marginLeft:8}}>Fields auto-filled — review and save.</span>
              </div>
              <button onClick={()=>{setHsStatus(null);setHsSource(false);resetContactForm();}} style={{
                background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:14,fontFamily:"DM Sans,sans-serif"
              }}>✕ Clear</button>
            </div>
          )}
          {hsStatus==="notfound"&&!editCId&&(
            <div style={{background:T.warnL,border:`1.5px solid ${T.warn}44`,borderRadius:9,
              padding:"9px 14px",marginBottom:14,display:"flex",gap:10,alignItems:"center",fontSize:14}}>
              <span>⚠</span>
              <span style={{color:T.warn,flex:1}}>Not found in HubSpot — fill in manually below.</span>
              <button onClick={()=>{setHsStatus(null);setHsEmail("");}} style={{
                background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:14,fontFamily:"DM Sans,sans-serif"
              }}>← Try again</button>
            </div>
          )}

          {/* ── Contact fields (shown after lookup result or skip) ── */}
          {(editCId||hsStatus==="found"||hsStatus==="notfound")&&(<>
            <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
              <div><FL req>Name</FL><input value={cForm.name} onChange={e=>sc("name",e.target.value)} placeholder="Contact name"/></div>
              <div>
                <FL>Company</FL>
                {companies.length>0?(()=>{
                  const selectedCo = companies.find(co=>co.id===cForm.companyId);
                  const isCustom = cForm.company && !selectedCo && !companies.some(co=>co.name===cForm.company);
                  const hostCos  = companies.filter(co=>co.isHostBusiness).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
                  const otherCos = companies.filter(co=>!co.isHostBusiness).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
                  return (
                    <div style={{display:"flex",flexDirection:"column",gap:4}}>
                      <select
                        value={cForm.companyId||"__custom__"}
                        onChange={e=>{
                          const val=e.target.value;
                          if(val==="__none__"){ sc("company",""); sc("companyId",""); }
                          else if(val==="__custom__"){ sc("companyId",""); }
                          else {
                            const co=companies.find(c=>c.id===val);
                            if(co){ sc("company",co.name); sc("companyId",co.id); }
                          }
                        }}>
                        <option value="__none__">— No company —</option>
                        {hostCos.length>0&&<optgroup label="🏢 Host Businesses">
                          {hostCos.map(co=><option key={co.id} value={co.id}>{co.name}</option>)}
                        </optgroup>}
                        {otherCos.length>0&&<optgroup label="All Companies">
                          {otherCos.map(co=><option key={co.id} value={co.id}>{co.name}</option>)}
                        </optgroup>}
                        <option value="__custom__">Other (type below)…</option>
                      </select>
                      {(!cForm.companyId)&&(
                        <input value={cForm.company} onChange={e=>sc("company",e.target.value)}
                          placeholder="Type company name…"/>
                      )}
                    </div>
                  );
                })():(
                  <input value={cForm.company} onChange={e=>sc("company",e.target.value)} placeholder="Company"/>
                )}
              </div>
              <div><FL>Email</FL><input value={cForm.email} onChange={e=>sc("email",e.target.value)} placeholder="email@co.com"/></div>
              <div><FL>Phone</FL><input value={cForm.phone} onChange={e=>sc("phone",e.target.value)} placeholder="+64…"/></div>
              <div><FL>Mobile</FL><input value={cForm.mobile||""} onChange={e=>sc("mobile",e.target.value)} placeholder="+64 2x xxx xxxx"/></div>
              <div><FL>Status</FL>
                <select value={cForm.status} onChange={e=>sc("status",e.target.value)}>
                  {["Active","Prospect","Inactive"].map(s=><option key={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={cForm.notes} onChange={e=>sc("notes",e.target.value)} placeholder="Notes…"/></div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <Btn onClick={saveContact}>{editCId?"Update":"Save Contact"}</Btn>
              {isAdmin1CRM&&editCId&&!isExistingUser(contacts.find(c=>c.id===editCId)||{})&&(
                <Btn v="ghost" onClick={()=>{
                  const c=contacts.find(x=>x.id===editCId);
                  if(c){setDetailContact(c);setShowCF(false);setEditCId(null);resetContactForm();goTab("contacts");}
                }}>👤 Make KTA User…</Btn>
              )}
              <Btn v="ghost" onClick={()=>{setShowCF(false);setEditCId(null);resetContactForm();}}>Cancel</Btn>
            </div>
          </>)}
        </Card>}
        {contacts.length>0&&(
          <div style={{marginBottom:10,position:"relative"}}>
            <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",fontSize:16,color:T.muted,pointerEvents:"none"}}>🔍</span>
            <input
              value={contactSearch}
              onChange={e=>setContactSearch(e.target.value)}
              placeholder="Search contacts by name, email, phone or company…"
              style={{width:"100%",paddingLeft:34,boxSizing:"border-box"}}
            />
          </div>
        )}
        <Card style={{padding:0,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 140px 160px 100px 60px",
            padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
            fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
            <CRMCtCol field="name">Name</CRMCtCol>
            <CRMCtCol field="email">Email</CRMCtCol><CRMCtCol field="phone">Phone</CRMCtCol><CRMCtCol field="status">Status</CRMCtCol><span/>
          </div>
          {contacts.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No contacts yet.</div>}
          {[...contacts].filter(c=>{
            if(!contactSearch.trim()) return true;
            const q=contactSearch.toLowerCase();
            return (c.name||"").toLowerCase().includes(q)
              ||(c.email||"").toLowerCase().includes(q)
              ||(c.phone||"").toLowerCase().includes(q)
      ||(c.mobile||"").toLowerCase().includes(q)
              ||(c.company||"").toLowerCase().includes(q);
          }).sort(crmCtSort).map((c,i)=>{
            const linkedCo = companies.find(co=>co.id===c.companyId);
            return (
            <div key={c.id}>
              <div className="ri" onClick={()=>{ if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[]; window.__ktaBackHandlers.push(()=>setDetailContact(null)); window.history.pushState({ktaNav:true},""); setDetailContact(c); }}
                style={{display:"grid",gridTemplateColumns:"1fr 140px 160px 100px 60px",
                  padding:"12px 16px",borderBottom:i<contacts.length-1?`1px solid ${T.border}44`:"none",
                  background:i%2===0?T.surface:T.bg,
                  alignItems:"center",gap:8,animationDelay:`${i*.03}s`,cursor:"pointer"}}
                onMouseEnter={e=>e.currentTarget.style.background=T.accentL}
                onMouseLeave={e=>e.currentTarget.style.background=i%2===0?T.surface:T.bg}>
                <div>
                  <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{c.name}</div>
                  {c.company&&<div style={{fontSize:12,color:T.muted}}>{c.company}</div>}
                </div>
                <div style={{fontSize:13,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.email||"—"}</div>
                <div style={{fontSize:13,color:T.sub}}>{c.phone||"—"}</div>
                <Pill label={c.status} size="sm"
                  color={c.status==="Active"?T.accent:c.status==="Prospect"?T.warn:T.muted}
                  bg={c.status==="Active"?T.accentL:c.status==="Prospect"?T.warnL:T.slateL}/>
                {canEdit&&<div style={{display:"flex",gap:5}} onClick={e=>e.stopPropagation()}>
                  <button onClick={()=>startEditC(c)} style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                    onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
                  {isAdmin1CRM&&!isExistingUser(c)&&(
                    <button onClick={()=>{ if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[]; window.__ktaBackHandlers.push(()=>setDetailContact(null)); window.history.pushState({ktaNav:true},""); setDetailContact(c); }} title="Make KTA User"
                      style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                      onMouseEnter={e=>{e.currentTarget.style.background=T.accentL;e.currentTarget.style.color=T.accent;}}
                      onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>👤</button>
                  )}
                  {canDelete&&(()=>{
                    const isApp = isApprenticeContact(c);
                    return (
                      <button
                        onClick={async ()=>{
                          if(isApp){ alert("This contact is linked to an apprentice and cannot be deleted."); return; }
                          if(!await ktaConfirm(`Delete ${c.name}? This cannot be undone.`)) return;
                          setContacts(prev=>prev.filter(x=>x.id!==c.id));
                          deleteRow("crm_contacts",c.id).catch(console.error);
                        }}
                        title={isApp?"Protected — linked to an apprentice":"Delete contact"}
                        style={{width:26,height:26,borderRadius:6,fontSize:13,
                          background:"transparent",color:isApp?T.border:T.muted,
                          border:`1px solid ${isApp?T.border:T.border}`,
                          display:"flex",alignItems:"center",justifyContent:"center",
                          cursor:isApp?"not-allowed":"pointer",opacity:isApp?0.4:1}}
                        onMouseEnter={e=>{if(!isApp){e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}}
                        onMouseLeave={e=>{if(!isApp){e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}}>✕</button>
                    );
                  })()}
                </div>}
              </div>
            </div>
            );
          })}
          {contacts.length>0&&contactSearch.trim()&&contacts.filter(c=>{
            const q=contactSearch.toLowerCase();
            return (c.name||"").toLowerCase().includes(q)||(c.email||"").toLowerCase().includes(q)||(c.phone||"").toLowerCase().includes(q)||(c.company||"").toLowerCase().includes(q);
          }).length===0&&(
            <div style={{padding:"32px",textAlign:"center",color:T.muted,fontSize:14}}>
              No contacts match "<strong>{contactSearch}</strong>"
            </div>
          )}
        </Card>
      </>)}
      {tab==="companies"&&(<>
        <div style={{marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{fontSize:14,color:T.sub}}>
              {showHostsOnly
                ? `${companies.filter(c=>c.isHostBusiness).length} host businesses`
                : `${companies.length} companies`}
            </div>
            {showHostsOnly&&(
              <button onClick={()=>setShowHostsOnly(false)}
                style={{fontSize:12,padding:"2px 10px",borderRadius:20,background:T.tealL,
                  color:T.teal,border:`1px solid ${T.teal}44`,cursor:"pointer",
                  fontFamily:"DM Sans,sans-serif",fontWeight:700,display:"flex",alignItems:"center",gap:5}}>
                🏢 Host Businesses only &nbsp;✕
              </button>
            )}
          </div>
          {canEdit&&<Btn sm onClick={()=>{setShowCoForm(s=>!s);setEditCoId(null);setCoForm(coBlank);}}>{showCoForm?"✕ Cancel":"+ Add Company"}</Btn>}
        </div>

        <DuplicateFinder
          items={companies}
          type="companies"
          canDelete={canDelete}
          onView={(co)=>{ if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[]; window.__ktaBackHandlers.push(()=>setDetailCompany(null)); window.history.pushState({ktaNav:true},""); setDetailCompany(co); }}
          onDelete={(id)=>{ setCompanies(prev=>prev.filter(x=>x.id!==id)); deleteRow("crm_companies",id).catch(console.error); }}
          onMerge={async(master, victimIds)=>{
            // Update master record
            await upsertRow("crm_companies",{
              id:master.id, name:master.name, industry:master.industry||null,
              phone:master.phone||null, website:master.website||null,
              address:master.address||null, city:master.city||null,
              postcode:master.postcode||null, country:master.country||null,
              notes:master.notes||null, status:master.status||"Active",
              is_host_business:master.isHostBusiness||false,
            }).catch(console.error);
            // Re-link contacts from victims to master
            for(const vid of victimIds) {
              const vContacts = contacts.filter(c=>c.companyId===vid);
              for(const c of vContacts) {
                await upsertRow("crm_contacts",{id:c.id,company_id:master.id,company:master.name}).catch(console.error);
              }
              setContacts(prev=>prev.map(c=>c.companyId===vid?{...c,companyId:master.id,company:master.name}:c));
              // Delete victim
              await deleteRow("crm_companies",vid).catch(console.error);
            }
            setCompanies(prev=>[...prev.filter(x=>x.id!==master.id&&!victimIds.includes(x.id)),master]);
          }}
        />

        {showCoForm&&canEdit&&(
          <Card style={{marginBottom:16,border:`1.5px solid ${T.accent}44`}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <div style={{fontWeight:700,fontSize:16,color:T.accent}}>{editCoId?"✎ Edit Company":"+ New Company"}</div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:13,fontWeight:700,color:T.sub}}>🏢 Host Business</span>
                <div onClick={()=>scf("isHostBusiness",!coForm.isHostBusiness)}
                  style={{position:"relative",width:52,height:28,borderRadius:14,cursor:"pointer",
                    background:coForm.isHostBusiness?T.teal:T.border,transition:"background .2s",flexShrink:0}}>
                  <div style={{position:"absolute",top:3,left:coForm.isHostBusiness?26:3,width:22,height:22,
                    borderRadius:"50%",background:"#fff",boxShadow:"0 1px 4px rgba(0,0,0,.25)",transition:"left .2s"}}/>
                </div>
                <span style={{fontSize:13,fontWeight:700,color:coForm.isHostBusiness?T.teal:T.muted,minWidth:24}}>
                  {coForm.isHostBusiness?"Yes":"No"}
                </span>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <div><FL req>Company Name</FL><input placeholder="Sparks Electrical Ltd" value={coForm.name} onChange={e=>scf("name",e.target.value)}/></div>
              <div><FL>Industry</FL><input placeholder="e.g. Electrical" value={coForm.industry} onChange={e=>scf("industry",e.target.value)}/></div>
              <div><FL>Phone</FL><input placeholder="+64 9 xxx xxxx" value={coForm.phone} onChange={e=>scf("phone",e.target.value)}/></div>
              <div><FL>Website</FL><input placeholder="sparkselectrical.co.nz" value={coForm.website} onChange={e=>scf("website",e.target.value)}/></div>
              <div><FL>Address</FL><input placeholder="123 Main Street" value={coForm.address} onChange={e=>scf("address",e.target.value)}/></div>
              <div><FL>City</FL><input placeholder="Auckland" value={coForm.city} onChange={e=>scf("city",e.target.value)}/></div>
              <div><FL>Postcode</FL><input placeholder="1010" value={coForm.postcode} onChange={e=>scf("postcode",e.target.value)}/></div>
              <div><FL>Country</FL><input placeholder="New Zealand" value={coForm.country} onChange={e=>scf("country",e.target.value)}/></div>
            </div>
            <div style={{marginBottom:10}}><FL>Notes</FL><textarea rows={2} placeholder="Any notes about this company…" value={coForm.notes} onChange={e=>scf("notes",e.target.value)} style={{width:"100%",resize:"vertical"}}/></div>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={saveCo} disabled={coSaving}>{coSaving?"Saving…":editCoId?"Update Company":"Save Company"}</Btn>
              <Btn v="ghost" onClick={()=>{setShowCoForm(false);setEditCoId(null);setCoForm(coBlank);}}>Cancel</Btn>
            </div>
          </Card>
        )}

        {companies.length===0&&!showCoForm&&(
          <Card><div style={{textAlign:"center",color:T.muted,padding:24,fontSize:14}}>
            No companies yet. Use <strong>+ Add Company</strong> above or import from HubSpot using the <strong>Import</strong> tab.
          </div></Card>
        )}
        {showHostsOnly&&companies.filter(c=>c.isHostBusiness).length===0&&companies.length>0&&(
          <Card><div style={{textAlign:"center",color:T.muted,padding:24,fontSize:14}}>
            No companies are flagged as Host Businesses yet. Open a company and toggle the <strong>🏢 Host Business</strong> switch to mark it.
          </div></Card>
        )}
        {companies.length>0&&(!showHostsOnly||companies.filter(c=>c.isHostBusiness).length>0)&&(
          <>
          <div style={{marginBottom:10,position:"relative"}}>
            <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",fontSize:16,color:T.muted,pointerEvents:"none"}}>🔍</span>
            <input
              value={companySearch}
              onChange={e=>setCompanySearch(e.target.value)}
              placeholder="Search companies by name, industry, city or phone…"
              style={{width:"100%",paddingLeft:34,boxSizing:"border-box"}}
            />
          </div>
          <Card style={{padding:0,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 120px 150px 150px 60px",
              padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
              fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
              <CRMCoCol field="name">Company</CRMCoCol>
              <CRMCoCol field="industry">Industry</CRMCoCol><span>Phone</span><CRMCoCol field="city">City</CRMCoCol><span/>
            </div>
            {[...companies].filter(co=>showHostsOnly?co.isHostBusiness:true).filter(co=>{
              if(!companySearch.trim()) return true;
              const q=companySearch.toLowerCase();
              return (co.name||"").toLowerCase().includes(q)
                ||(co.industry||"").toLowerCase().includes(q)
                ||(co.city||"").toLowerCase().includes(q)
                ||(co.phone||"").toLowerCase().includes(q);
            }).sort(crmCoSort).map((co,i)=>{
              const linkedContacts = contacts.filter(c=>c.companyId===co.id);
              return (
                <div key={co.id} style={{borderBottom:i<companies.length-1?`1px solid ${T.border}44`:"none"}}>
                  <div onClick={()=>{ if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[]; window.__ktaBackHandlers.push(()=>setDetailCompany(null)); window.history.pushState({ktaNav:true},""); setDetailCompany(co); }}
                    style={{display:"grid",gridTemplateColumns:"1fr 120px 150px 150px 60px",
                      padding:"11px 16px",gap:8,alignItems:"center",cursor:"pointer",
                      background:i%2===0?T.surface:T.bg}}
                    onMouseEnter={e=>e.currentTarget.style.background=T.accentL}
                    onMouseLeave={e=>e.currentTarget.style.background=i%2===0?T.surface:T.bg}>
                    <div>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{co.name}</div>
                        {co.isHostBusiness&&<span style={{fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:10,background:T.tealL,color:T.teal,flexShrink:0}}>Host</span>}
                      </div>
                      {linkedContacts.length>0&&(
                        <div style={{fontSize:12,color:T.muted,marginTop:2}}>
                          {linkedContacts.slice(0,3).map(c=>c.name).join(", ")}
                          {linkedContacts.length>3&&` +${linkedContacts.length-3} more`}
                        </div>
                      )}
                    </div>
                    <div style={{fontSize:13,color:T.sub}}>{co.industry||"—"}</div>
                    <div style={{fontSize:13,color:T.sub}}>{co.phone||"—"}</div>
                    <div style={{fontSize:13,color:T.sub}}>{co.city||"—"}</div>
                    <div style={{display:"flex",gap:5}} onClick={e=>e.stopPropagation()}>
                      {canEdit&&(
                        <button onClick={()=>{setCoForm({name:co.name,industry:co.industry||"",phone:co.phone||"",website:co.website||"",address:co.address||"",city:co.city||"",postcode:co.postcode||"",country:co.country||"New Zealand",notes:co.notes||"",status:co.status||"Active",isHostBusiness:co.isHostBusiness||false});setEditCoId(co.id);setShowCoForm(true);setExpandedCompany(null);window.scrollTo({top:0,behavior:"smooth"});}}
                          style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}
                          onMouseEnter={e=>{e.currentTarget.style.background=T.accentL;e.currentTarget.style.color=T.accent;}}
                          onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
                      )}
                      {canDelete&&(
                        <button onClick={async ()=>{
                          if(!await ktaConfirm(`Delete ${co.name}?`)) return;
                          setCompanies(prev=>prev.filter(x=>x.id!==co.id));
                          deleteRow("crm_companies",co.id).catch(console.error);
                        }} style={{width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",
                          color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}
                          onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                          onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {companySearch.trim()&&companies.filter(co=>{
              const q=companySearch.toLowerCase();
              return (co.name||"").toLowerCase().includes(q)||(co.industry||"").toLowerCase().includes(q)||(co.city||"").toLowerCase().includes(q)||(co.phone||"").toLowerCase().includes(q);
            }).length===0&&(
              <div style={{padding:"32px",textAlign:"center",color:T.muted,fontSize:14}}>
                No companies match "<strong>{companySearch}</strong>"
              </div>
            )}
          </Card>
          </>
        )}
      </>)}

      {tab==="pipeline"&&<div style={{overflowX:"auto"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,minWidth:900}}>
          {pipeline.map(({stage,color,items,value})=>(
            <div key={stage}>
              <div style={{padding:"8px 11px",borderRadius:"9px 9px 0 0",background:color+"18",borderBottom:`2px solid ${color}`,marginBottom:8}}>
                <div style={{fontWeight:700,fontSize:13,color}}>{stage}</div>
                <div style={{fontSize:12,color:T.muted,marginTop:2}}>{items.length} · ${value.toLocaleString()}</div>
              </div>
              {items.map(d=>(
                <div key={d.id} style={{background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:9,padding:"10px 12px",marginBottom:8}}>
                  <div style={{fontWeight:700,fontSize:14}}>{d.title}</div>
                  {d.contact&&<div style={{color:T.muted,fontSize:12,marginTop:2}}>{d.contact}</div>}
                  {d.value&&<div style={{color,fontWeight:700,fontSize:16,marginTop:5}}>${parseFloat(d.value).toLocaleString()}</div>}
                  {canEdit&&<div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:9}}>
                    {STAGES.filter(s=>s!==stage).map(s=>(
                      <button key={s} onClick={()=>moveDeal(d.id,s)} style={{
                        fontSize:10,padding:"2px 6px",borderRadius:4,
                        background:STAGE_C[s]+"22",color:STAGE_C[s],border:"none",
                        fontWeight:700,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>→{s}</button>
                    ))}
                  </div>}
                </div>
              ))}
              {items.length===0&&<div style={{color:T.muted,fontSize:12,textAlign:"center",paddingTop:12}}>Empty</div>}
            </div>
          ))}
        </div>
      </div>}
      {tab==="import"&&(()=>{
        const PROXY_URL = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/hubspot-proxy";

        const hsFetch = async (action, extra={}) => {
          const r = await fetch(PROXY_URL, {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({action, token: hsToken.trim(), ...extra}),
          });
          if(!r.ok){const t=await r.text(); throw new Error(`Proxy ${r.status}: ${t.slice(0,200)}`);}
          const d = await r.json();
          if(d.ok===false) throw new Error(d.error||"Proxy error");
          return d;
        };

        // ── helpers ─────────────────────────────────────────────────────────────
        const fetchAllPages = async (action) => {
          let all=[]; let after=null; let pages=0;
          while(pages<300){
            const d = await hsFetch(action, after?{after}:{});
            all=[...all,...(d.results||[])];
            after = d.paging?.next?.after;
            pages++;
            if(!after) break;
          }
          return all;
        };

        // ── Match HubSpot contact to a KTA user by email and update their compliance fields ──
        // Called after every contact import so users stay in sync with HubSpot data
        const syncUserFromContact = async (row) => {
          if(!row.email) return;
          const matchedUser = allUsers.find(u=>
            u.email && u.email.toLowerCase().trim() === row.email.toLowerCase().trim()
          );
          if(!matchedUser) return;
          // Only update fields that HubSpot actually has a value for — don't blank out existing data
          const updates = {};
          if(row.ew_licence_expiry)     updates.licenceExpiry    = row.ew_licence_expiry;
          if(row.site_safe_expiry)      updates.siteSafeExpiry   = row.site_safe_expiry;
          if(row.first_aid_expiry)      updates.firstAidExpiry   = row.first_aid_expiry;
          if(row.licence_number)        updates.licenceNumber    = row.licence_number;
          if(row.site_safe_number)      updates.siteSafeNumber   = row.site_safe_number;
          if(row.emergency_contact_name)         updates.emergencyContactName         = row.emergency_contact_name;
          if(row.emergency_contact_phone)        updates.emergencyContactPhone        = row.emergency_contact_phone;
          if(row.emergency_contact_relationship) updates.emergencyContactRelationship = row.emergency_contact_relationship;
          if(row.phone && !matchedUser.phone)    updates.phone = row.phone;
          if(Object.keys(updates).length === 0) return;
          const updatedUser = {...matchedUser, ...updates};
          await upsertUser(updatedUser).catch(console.error);
          if(onUserCreated) onUserCreated(updatedUser); // re-uses the callback to update App state
        };

        // ── Full HubSpot Sync ────────────────────────────────────────────────
        const fullSync = async () => {
          if(!hsToken.trim()){setHsMsg("Please enter your HubSpot token."); return;}
          if(!await ktaConfirm("This will DELETE all existing CRM contacts and companies, then re-import everything fresh from HubSpot. Continue?")) return;
          setHsImporting(true);
          const syncMsg = (msg) => {
            setHsMsg(msg);
            window.__ktaSync = { running:true, msg };
            if(onSyncTick) onSyncTick();
          };
          try {
            // 1 — Delete all existing contacts + companies from Supabase
            syncMsg("🗑 Clearing existing contacts and companies…");
            const existingContacts = await loadTable("crm_contacts").catch(()=>[]);
            for(const c of existingContacts){
              await deleteRow("crm_contacts", c.id).catch(()=>{});
            }
            const existingCos = await loadTable("crm_companies").catch(()=>[]);
            for(const co of existingCos){
              await deleteRow("crm_companies", co.id).catch(()=>{});
            }
            setContacts([]); setCompanies([]);

            // 2 — Fetch all companies from HubSpot
            syncMsg("🏢 Fetching companies from HubSpot…");
            const hsCompanies = await fetchAllPages("getCompanies");
            syncMsg(`🏢 Importing ${hsCompanies.length} companies…`);

            const hsCoIdToLocalId = {};
            let coDone=0;
            for(let i=0;i<hsCompanies.length;i++){
              const co = hsCompanies[i];
              const p = co.properties;
              if(!p?.name) continue;
              const id = crypto.randomUUID();
              hsCoIdToLocalId[co.id] = id;
              const row = {
                id, name:p.name, industry:p.industry||"", phone:p.phone||"",
                website:p.website||"", address:p.address||"", city:p.city||"",
                postcode:p.zip||"", country:(p.country&&p.country!=="New Zealand")?p.country:"",
                description:p.description||"",hs_lead_status:p.hs_lead_status||"",
                annual_revenue:p.annualrevenue||"",hs_created:p.createdate||null,
                hubspot_id:co.id, status:"Active", notes:"",
              };
              await upsertRow("crm_companies", row).catch(()=>{});
              setCompanies(prev=>[...prev,{id,name:p.name,industry:p.industry||"",phone:p.phone||"",
                website:p.website||"",address:p.address||"",city:p.city||"",country:p.country||"",
                description:p.description||"",hsLeadStatus:p.hs_lead_status||"",
                hubspotId:co.id,notes:"",status:"Active"}]);
              coDone++;
              if(i%20===0) syncMsg(`🏢 Importing companies… ${i+1}/${hsCompanies.length}`);
            }

            // 3 — Fetch all contacts from HubSpot
            syncMsg("👤 Fetching contacts from HubSpot…");
            const hsContacts = await fetchAllPages("searchContacts");
            syncMsg(`👤 Importing ${hsContacts.length} contacts…`);

            // Build hubspot contact id → local id map for linking
            const hsContactIdToLocalId = {};
            let ctDone=0;
            for(let i=0;i<hsContacts.length;i++){
              const c = hsContacts[i];
              const p = c.properties;
              const name = [p.firstname,p.lastname].filter(Boolean).join(" ")||p.company||"";
              if(!name) continue;
              const id = crypto.randomUUID();
              hsContactIdToLocalId[c.id] = id;
              const pick = (...keys) => keys.map(k=>p[k]).find(v=>v&&String(v).trim())||null;
              const row = {
                id, name, email:p.email||"", phone:p.mobilephone||p.phone||"",
                company:p.company||"", trade:p.industry||"",
                job_title:p.jobtitle||"", description:p.description||"",
                salutation:p.salutation||"", date_of_birth:p.date_of_birth||null,
                address:p.address||"", city:p.city||"",
                postcode:p.zip||"", country:(p.country&&p.country!=="New Zealand")?p.country:"",
                // Compliance expiries — try all known HubSpot property name variants
                ew_licence_expiry: pick("ew_licence_expiry","electrical_worker_licence_expiry","ew_licence_expiry_date","electrician_licence_expiry","licence_expiry","licence_expiry_date","trade_licence_expiry"),
                site_safe_expiry:  pick("site_safe_expiry","sitesafe_expiry","site_safe_expiry_date","sitesafe_expiry_date","site_safe_card_expiry","sitesafe"),
                first_aid_expiry:  pick("first_aid_expiry","firstaid_expiry","first_aid_expiry_date","firstaid_expiry_date","first_aid_certificate_expiry"),
                // Compliance numbers
                licence_number:   pick("ew_licence_number","licence_number","electrical_licence_number"),
                site_safe_number: pick("site_safe_number","sitesafe_number","site_safe_card_number"),
                first_aid_number: pick("first_aid_number","firstaid_number","first_aid_certificate_number"),
                // Emergency / next of kin
                emergency_contact_name:         pick("emergency_contact_name","emergency_contact","next_of_kin","nok_name","emergency_name","emergency_contact_firstname"),
                emergency_contact_phone:        pick("emergency_contact_phone","emergency_phone","nok_phone"),
                emergency_contact_relationship: pick("emergency_contact_relationship","nok_relationship","emergency_relationship"),
                hs_lead_status:p.hs_lead_status||"",
                notes_last_contacted:p.notes_last_contacted||"",
                hs_created:p.createdate||null,
                status:"Active", notes:"", hubspot_id:c.id,
              };
              await upsertRow("crm_contacts", row).catch(()=>{});
              await syncUserFromContact(row);
              setContacts(prev=>[...prev,{id,name,email:row.email,phone:row.phone,
                company:row.company,companyId:"",status:"Active",notes:"",
                jobTitle:row.job_title,ewLicenceExpiry:row.ew_licence_expiry,
                siteSafeExpiry:row.site_safe_expiry, firstAidExpiry:row.first_aid_expiry,
                licenceNumber:row.licence_number, siteSafeNumber:row.site_safe_number,
                emergencyContactName:row.emergency_contact_name,
                emergencyContactPhone:row.emergency_contact_phone,
                emergencyContactRelationship:row.emergency_contact_relationship,
                hsLeadStatus:row.hs_lead_status, hubspot_id:c.id}]);
              ctDone++;
              if(i%50===0) syncMsg(`👤 Importing contacts… ${i+1}/${hsContacts.length}`);
            }

            // 4 — Link contacts to companies
            // First pass: use association data already returned with each contact (faster, no extra API calls)
            syncMsg(`🔗 Linking contacts to companies…`);
            let linked=0;
            for(const c of hsContacts){
              const localContactId = hsContactIdToLocalId[c.id];
              if(!localContactId) continue;
              // HubSpot returns associations.companies.results when associations param is set
              const assocCompanyIds = c.associations?.companies?.results?.map(r=>r.id)||[];
              for(const hsCoId of assocCompanyIds){
                const localCoId = hsCoIdToLocalId[hsCoId];
                if(!localCoId) continue;
                await upsertRow("crm_contacts",{id:localContactId,company_id:localCoId}).catch(()=>{});
                setContacts(prev=>prev.map(ct=>ct.id===localContactId?{...ct,companyId:localCoId}:ct));
                linked++; break; // use first association only
              }
            }
            // Second pass: per-company lookup for any contacts that weren't linked above
            for(let i=0;i<hsCompanies.length;i++){
              const co = hsCompanies[i];
              const localCoId = hsCoIdToLocalId[co.id];
              if(!localCoId) continue;
              try {
                const d = await hsFetch("getCompanyContacts",{companyId:co.id});
                for(const assoc of (d.results||[])){
                  const localContactId = hsContactIdToLocalId[assoc.id];
                  if(!localContactId) continue;
                  // Only link if not already linked in first pass
                  const alreadyLinked = contacts.find(ct=>ct.id===localContactId&&ct.companyId);
                  if(alreadyLinked) continue;
                  await upsertRow("crm_contacts",{id:localContactId,company_id:localCoId}).catch(()=>{});
                  setContacts(prev=>prev.map(ct=>ct.id===localContactId?{...ct,companyId:localCoId}:ct));
                  linked++;
                }
              } catch{}
              if(i%20===0) syncMsg(`🔗 Linking… ${i+1}/${hsCompanies.length} companies`);
            }

            syncMsg(`✓ Sync complete — ${coDone} companies · ${ctDone} contacts · ${linked} links`);
            window.__ktaSync = { running:false, msg:"" };
            if(onSyncTick) onSyncTick();
          } catch(e){
            syncMsg("Error: "+e.message);
            window.__ktaSync = { running:false, msg:"" };
            if(onSyncTick) onSyncTick();
          }
          setHsImporting(false);
        };

        // ── Sync Companies Only ──────────────────────────────────────────────
        // ── Sync New Companies (incremental — skips existing hubspot_ids) ────
        const syncCompaniesOnly = async () => {
          if(!hsToken.trim()){setHsMsg("Please enter your HubSpot token."); return;}
          setHsImporting(true);
          const syncMsg = (msg) => { setHsMsg(msg); if(onSyncTick) onSyncTick(); };
          try {
            // Build a set of HubSpot IDs already in Supabase so we never overwrite local edits
            syncMsg("🏢 Checking existing companies…");
            const existingCos = await loadTable("crm_companies").catch(()=>[]);
            const knownHsIds  = new Set(existingCos.map(c=>c.hubspot_id).filter(Boolean));
            const hsCoIdToLocalId = {};
            existingCos.forEach(c=>{ if(c.hubspot_id) hsCoIdToLocalId[c.hubspot_id]=c.id; });

            syncMsg("🏢 Fetching companies from HubSpot…");
            const hsCompanies = await fetchAllPages("getCompanies");
            let added=0, skipped=0;
            syncMsg(`🏢 Found ${hsCompanies.length} in HubSpot — checking for new ones…`);

            for(let i=0;i<hsCompanies.length;i++){
              const co=hsCompanies[i]; const p=co.properties;
              if(!p?.name){ skipped++; continue; }
              if(knownHsIds.has(co.id)){ skipped++; continue; }
              // New company — add it
              const id=crypto.randomUUID();
              hsCoIdToLocalId[co.id]=id;
              const row={
                id, name:p.name, industry:p.industry||"", phone:p.phone||"",
                website:p.website||"", address:p.address||"", city:p.city||"",
                postcode:p.zip||"", country:(p.country&&p.country!=="New Zealand")?p.country:"",
                description:p.description||"", hs_lead_status:p.hs_lead_status||"",
                annual_revenue:p.annualrevenue||"", hs_created:p.createdate||null,
                hubspot_id:co.id, status:"Active", notes:"",
              };
              await upsertRow("crm_companies",row).catch(()=>{});
              setCompanies(prev=>[...prev,{
                id, name:p.name, industry:p.industry||"", phone:p.phone||"",
                website:p.website||"", address:p.address||"", city:p.city||"",
                country:p.country||"", description:p.description||"",
                hsLeadStatus:p.hs_lead_status||"", hubspotId:co.id,
                notes:"", status:"Active", postcode:p.zip||"",
              }]);
              added++;
              if(i%20===0) syncMsg(`🏢 Checking… ${i+1}/${hsCompanies.length} (${added} new)`);
            }

            // Link contacts to any newly added companies
            syncMsg("🔗 Linking contacts to new companies…");
            let linked=0;
            const freshContacts = await loadTable("crm_contacts").catch(()=>[]);
            const newHsCos = hsCompanies.filter(co=>!knownHsIds.has(co.id)&&co.properties?.name);
            for(let i=0;i<newHsCos.length;i++){
              const co=newHsCos[i]; const localCoId=hsCoIdToLocalId[co.id]; if(!localCoId) continue;
              try {
                const d=await hsFetch("getCompanyContacts",{companyId:co.id});
                for(const assoc of (d.results||[])){
                  const lc=freshContacts.find(c=>c.hubspot_id===assoc.id);
                  if(!lc) continue;
                  await upsertRow("crm_contacts",{...lc,company_id:localCoId}).catch(()=>{});
                  setContacts(prev=>prev.map(c=>c.id===lc.id?{...c,companyId:localCoId}:c));
                  linked++;
                }
              } catch{}
            }
            syncMsg(`✓ Done — ${added} new companies added, ${skipped} already existed (skipped), ${linked} contact links updated`);
          } catch(e){ syncMsg("Error: "+e.message); }
          setHsImporting(false);
        };

        // ── Sync Contacts Only ───────────────────────────────────────────────
        // ── Sync New Contacts (incremental — skips existing hubspot_ids) ────
        const syncContactsOnly = async () => {
          if(!hsToken.trim()){setHsMsg("Please enter your HubSpot token."); return;}
          setHsImporting(true);
          const syncMsg = (msg) => { setHsMsg(msg); if(onSyncTick) onSyncTick(); };
          try {
            // Build a set of HubSpot IDs already in Supabase so we never overwrite local edits
            syncMsg("👥 Checking existing contacts…");
            const existingContacts = await loadTable("crm_contacts").catch(()=>[]);
            const knownHsIds = new Set(existingContacts.map(c=>c.hubspot_id).filter(Boolean));
            const hsContactIdToLocalId = {};
            existingContacts.forEach(c=>{ if(c.hubspot_id) hsContactIdToLocalId[c.hubspot_id]=c.id; });

            syncMsg("👥 Fetching contacts from HubSpot…");
            const hsContacts = await fetchAllPages("searchContacts");
            let added=0, skipped=0;
            syncMsg(`👥 Found ${hsContacts.length} in HubSpot — checking for new ones…`);

            for(let i=0;i<hsContacts.length;i++){
              const c=hsContacts[i]; const p=c.properties;
              const name=[p.firstname,p.lastname].filter(Boolean).join(" ")||p.company||"";
              if(!name){ skipped++; continue; }
              if(knownHsIds.has(c.id)){ skipped++; continue; }
              // New contact — add it
              const id=crypto.randomUUID();
              hsContactIdToLocalId[c.id]=id;
              const pick = (...keys) => keys.map(k=>p[k]).find(v=>v&&String(v).trim())||null;
              const row={
                id, name, email:p.email||"", phone:p.mobilephone||p.phone||"",
                company:p.company||"", trade:p.industry||"",
                job_title:p.jobtitle||"", description:p.description||"",
                salutation:p.salutation||"", date_of_birth:p.date_of_birth||null,
                address:p.address||"", city:p.city||"",
                postcode:p.zip||"", country:(p.country&&p.country!=="New Zealand")?p.country:"",
                ew_licence_expiry: pick("ew_licence_expiry","electrical_worker_licence_expiry","ew_licence_expiry_date","electrician_licence_expiry","licence_expiry","licence_expiry_date","trade_licence_expiry"),
                site_safe_expiry:  pick("site_safe_expiry","sitesafe_expiry","site_safe_expiry_date","sitesafe_expiry_date","site_safe_card_expiry","sitesafe"),
                first_aid_expiry:  pick("first_aid_expiry","firstaid_expiry","first_aid_expiry_date","firstaid_expiry_date","first_aid_certificate_expiry"),
                licence_number:   pick("ew_licence_number","licence_number","electrical_licence_number"),
                site_safe_number: pick("site_safe_number","sitesafe_number","site_safe_card_number"),
                first_aid_number: pick("first_aid_number","firstaid_number","first_aid_certificate_number"),
                emergency_contact_name:         pick("emergency_contact_name","emergency_contact","next_of_kin","nok_name","emergency_name","emergency_contact_firstname"),
                emergency_contact_phone:        pick("emergency_contact_phone","emergency_phone","nok_phone"),
                emergency_contact_relationship: pick("emergency_contact_relationship","nok_relationship","emergency_relationship"),
                hs_lead_status:p.hs_lead_status||"",
                notes_last_contacted:p.notes_last_contacted||"",
                hs_created:p.createdate||null,
                status:"Active", notes:"", hubspot_id:c.id,
              };
              await upsertRow("crm_contacts",row).catch(()=>{});
              await syncUserFromContact(row);
              setContacts(prev=>[...prev,{
                id, name, email:row.email, phone:row.phone,
                company:row.company, companyId:"", status:"Active", notes:"",
                jobTitle:row.job_title, ewLicenceExpiry:row.ew_licence_expiry,
                siteSafeExpiry:row.site_safe_expiry, firstAidExpiry:row.first_aid_expiry,
                licenceNumber:row.licence_number, siteSafeNumber:row.site_safe_number,
                emergencyContactName:row.emergency_contact_name,
                emergencyContactPhone:row.emergency_contact_phone,
                emergencyContactRelationship:row.emergency_contact_relationship,
                hsLeadStatus:row.hs_lead_status, hubspot_id:c.id,
              }]);
              added++;
              if(i%50===0) syncMsg(`👥 Checking… ${i+1}/${hsContacts.length} (${added} new)`);
            }

            // Link only the newly added contacts to their companies
            syncMsg("🔗 Linking new contacts to companies…");
            const existingCos = await loadTable("crm_companies").catch(()=>[]);
            let linked=0;
            for(const co of existingCos){
              if(!co.hubspot_id) continue;
              try {
                const d=await hsFetch("getCompanyContacts",{companyId:co.hubspot_id});
                for(const assoc of (d.results||[])){
                  // Only link if this was a newly added contact (not pre-existing)
                  const localId=hsContactIdToLocalId[assoc.id];
                  if(!localId||knownHsIds.has(assoc.id)) continue;
                  await upsertRow("crm_contacts",{id:localId,company_id:co.id}).catch(()=>{});
                  setContacts(prev=>prev.map(c=>c.id===localId?{...c,companyId:co.id}:c));
                  linked++;
                }
              } catch{}
            }
            syncMsg(`✓ Done — ${added} new contacts added, ${skipped} already existed (skipped), ${linked} company links updated`);
          } catch(e){ syncMsg("Error: "+e.message); }
          setHsImporting(false);
        };

        // ── Sync User Compliance Data from HubSpot ───────────────────────────
        // Matches HubSpot contacts to KTA users by email and updates their
        // compliance fields (licence expiry, site safe, first aid, emergency contact)
        // without touching contacts/companies or wiping any data
        const syncUsersFromHubSpot = async () => {
          if(!hsToken.trim()){setHsMsg("Please enter your HubSpot token."); return;}
          if(!allUsers.length){setHsMsg("No KTA users loaded yet."); return;}
          setHsImporting(true);
          const syncMsg = (msg) => { setHsMsg(msg); if(onSyncTick) onSyncTick(); };
          try {
            syncMsg("📋 Fetching contacts from HubSpot to match against KTA users…");
            const hsContacts = await fetchAllPages("searchContacts");
            syncMsg(`📋 Checking ${hsContacts.length} HubSpot contacts against ${allUsers.length} KTA users…`);

            let updated=0, skipped=0;
            for(let i=0; i<hsContacts.length; i++){
              const c = hsContacts[i];
              const p = c.properties;
              if(!p.email){ skipped++; continue; }
              const matchedUser = allUsers.find(u=>
                u.email && u.email.toLowerCase().trim() === p.email.toLowerCase().trim()
              );
              if(!matchedUser){ skipped++; continue; }

              const pick = (...keys) => keys.map(k=>p[k]).find(v=>v&&String(v).trim())||null;

              const updates = {};
              const ewExp = pick("ew_licence_expiry","electrical_worker_licence_expiry","ew_licence_expiry_date","electrician_licence_expiry","licence_expiry","licence_expiry_date","trade_licence_expiry");
              const ssExp = pick("site_safe_expiry","sitesafe_expiry","site_safe_expiry_date","sitesafe_expiry_date","site_safe_card_expiry");
              const faExp = pick("first_aid_expiry","firstaid_expiry","first_aid_expiry_date","firstaid_expiry_date","first_aid_certificate_expiry");
              const licNo = pick("ew_licence_number","licence_number","electrical_licence_number");
              const ssNo  = pick("site_safe_number","sitesafe_number","site_safe_card_number");
              const emName = pick("emergency_contact_name","emergency_contact","next_of_kin","nok_name","emergency_name","emergency_contact_firstname");
              const emPhone = pick("emergency_contact_phone","emergency_phone","nok_phone");
              const emRel   = pick("emergency_contact_relationship","nok_relationship","emergency_relationship");

              if(ewExp)    updates.licenceExpiry    = ewExp;
              if(ssExp)    updates.siteSafeExpiry   = ssExp;
              if(faExp)    updates.firstAidExpiry   = faExp;
              if(licNo)    updates.licenceNumber    = licNo;
              if(ssNo)     updates.siteSafeNumber   = ssNo;
              if(emName)   updates.emergencyContactName         = emName;
              if(emPhone)  updates.emergencyContactPhone        = emPhone;
              if(emRel)    updates.emergencyContactRelationship = emRel;
              if(p.phone && !matchedUser.phone) updates.phone  = p.mobilephone||p.phone;

              if(Object.keys(updates).length === 0){ skipped++; continue; }

              const updatedUser = {...matchedUser, ...updates};
              await upsertUser(updatedUser).catch(console.error);
              if(onUserCreated) onUserCreated(updatedUser);
              updated++;
              if(i%20===0) syncMsg(`📋 Matched ${updated} users so far…`);
            }
            syncMsg(`✓ User sync complete — ${updated} KTA users updated from HubSpot, ${skipped} contacts had no match or no new data`);
          } catch(e){ syncMsg("Error: "+e.message); }
          setHsImporting(false);
        };

        // ── Sync Activity (Notes, Calls, Meetings, Emails, Tasks) ────────────
        const syncActivity = async () => {
          if(!hsToken.trim()){setHsMsg("Please enter your HubSpot token."); return;}
          if(!await ktaConfirm("This will import all HubSpot activity (notes, calls, meetings, emails, tasks) for all contacts and companies. Existing activity records with the same HubSpot ID will be skipped. Continue?")) return;
          setHsImporting(true);
          const syncMsg = (msg) => { setHsMsg(msg); if(onSyncTick) onSyncTick(); };

          try {
            // Build HubSpot ID → local ID maps from current contacts + companies
            const allLocalContacts  = await loadTable("crm_contacts").catch(()=>[]);
            const allLocalCompanies = await loadTable("crm_companies").catch(()=>[]);
            const hsContactMap  = {}; // hubspot_id → {local_id, name, email}
            const hsCompanyMap  = {}; // hubspot_id → {local_id, name}
            allLocalContacts.forEach(c=>{ if(c.hubspot_id) hsContactMap[c.hubspot_id]={id:c.id,name:c.name,email:c.email||""}; });
            allLocalCompanies.forEach(c=>{ if(c.hubspot_id) hsCompanyMap[c.hubspot_id]={id:c.id,name:c.name}; });

            // Load existing activity_notes to avoid duplicates
            syncMsg("📋 Loading existing activity records…");
            const existingActivity = await loadTable("activity_notes").catch(()=>[]);
            const existingHsIds = new Set(existingActivity.map(a=>a.hubspot_engagement_id).filter(Boolean));

            let totalSaved = 0;
            let totalSkipped = 0;

            // Helper: resolve person from engagement associations
            const resolvePersonFromAssoc = (assocs) => {
              const contactIds = assocs?.contacts?.results?.map(r=>r.id)||[];
              const companyIds = assocs?.companies?.results?.map(r=>r.id)||[];
              for(const hsId of contactIds){
                const local = hsContactMap[hsId];
                if(local) return { person_id: local.id, person_name: local.name, person_email: local.email };
              }
              for(const hsId of companyIds){
                const local = hsCompanyMap[hsId];
                if(local) return { person_id: local.id, person_name: local.name, person_email: "" };
              }
              return null;
            };

            // Helper: save one engagement as an activity_note row
            const saveEngagement = async (engId, person, type, subject, body, direction, createdAt) => {
              if(existingHsIds.has(String(engId))) { totalSkipped++; return; }
              if(!person) { totalSkipped++; return; }
              const row = {
                id: crypto.randomUUID(),
                person_email:            person.person_email || null,
                person_id:               person.person_id   || null,
                person_name:             person.person_name || null,
                type,
                subject:                 subject || type,
                body:                    body    || "",
                direction:               direction || "note",
                hubspot_engagement_id:   String(engId),
                created_at:              createdAt || new Date().toISOString(),
                is_locked:               false,
              };
              await upsertRow("activity_notes", row).catch(()=>{});
              existingHsIds.add(String(engId));
              totalSaved++;
            };

            // ── 1. NOTES ────────────────────────────────────────────────────
            syncMsg("📝 Fetching notes from HubSpot…");
            let notePages=0; let noteAfter=null;
            while(notePages<500){
              const d = await hsFetch("getNotes", noteAfter?{after:noteAfter}:{});
              for(const n of (d.results||[])){
                const person = resolvePersonFromAssoc(n.associations);
                const body   = n.properties?.hs_note_body||"";
                const ts     = n.properties?.hs_timestamp||n.properties?.createdate||null;
                await saveEngagement(n.id, person, "note", "Note", body, "note", ts);
              }
              noteAfter = d.paging?.next?.after;
              notePages++;
              if(!noteAfter) break;
              if(notePages%5===0) syncMsg(`📝 Notes… ${totalSaved} saved so far`);
            }
            syncMsg(`📝 Notes done — ${totalSaved} saved, ${totalSkipped} skipped`);

            // ── 2. CALLS ────────────────────────────────────────────────────
            const callStart = totalSaved;
            syncMsg("📞 Fetching calls from HubSpot…");
            let callPages=0; let callAfter=null;
            while(callPages<500){
              const d = await hsFetch("getCalls", callAfter?{after:callAfter}:{});
              for(const c of (d.results||[])){
                const person   = resolvePersonFromAssoc(c.associations);
                const p        = c.properties||{};
                const subject  = p.hs_call_title||"Call";
                const duration = p.hs_call_duration ? ` (${Math.round(p.hs_call_duration/1000/60)}min)` : "";
                const body     = [p.hs_call_body, p.hs_call_disposition, p.hs_call_direction].filter(Boolean).join(" · ")+duration;
                const ts       = p.hs_timestamp||p.createdate||null;
                await saveEngagement(c.id, person, "call", subject, body, p.hs_call_direction==="INBOUND"?"inbound":"outbound", ts);
              }
              callAfter = d.paging?.next?.after;
              callPages++;
              if(!callAfter) break;
              if(callPages%5===0) syncMsg(`📞 Calls… ${totalSaved-callStart} calls saved`);
            }
            syncMsg(`📞 Calls done — ${totalSaved-callStart} saved`);

            // ── 3. MEETINGS ─────────────────────────────────────────────────
            const meetStart = totalSaved;
            syncMsg("🤝 Fetching meetings from HubSpot…");
            let meetPages=0; let meetAfter=null;
            while(meetPages<500){
              const d = await hsFetch("getMeetings", meetAfter?{after:meetAfter}:{});
              for(const m of (d.results||[])){
                const person  = resolvePersonFromAssoc(m.associations);
                const p       = m.properties||{};
                const subject = p.hs_meeting_title||"Meeting";
                const body    = [p.hs_meeting_body, p.hs_meeting_outcome].filter(Boolean).join("\n\n");
                const ts      = p.hs_meeting_start_time||p.hs_timestamp||p.createdate||null;
                await saveEngagement(m.id, person, "meeting", subject, body, "note", ts);
              }
              meetAfter = d.paging?.next?.after;
              meetPages++;
              if(!meetAfter) break;
              if(meetPages%5===0) syncMsg(`🤝 Meetings… ${totalSaved-meetStart} meetings saved`);
            }
            syncMsg(`🤝 Meetings done — ${totalSaved-meetStart} saved`);

            // ── 4. EMAILS ───────────────────────────────────────────────────
            const emailStart = totalSaved;
            syncMsg("✉ Fetching emails from HubSpot…");
            let emailPages=0; let emailAfter=null;
            while(emailPages<500){
              const d = await hsFetch("getEngagementEmails", emailAfter?{after:emailAfter}:{});
              for(const e of (d.results||[])){
                const person    = resolvePersonFromAssoc(e.associations);
                const p         = e.properties||{};
                const subject   = p.hs_email_subject||"Email";
                const body      = p.hs_email_text||p.hs_email_html||"";
                const direction = p.hs_email_direction==="INBOUND"?"inbound":"outbound";
                const ts        = p.hs_timestamp||p.createdate||null;
                await saveEngagement(e.id, person, "email", subject, body, direction, ts);
              }
              emailAfter = d.paging?.next?.after;
              emailPages++;
              if(!emailAfter) break;
              if(emailPages%5===0) syncMsg(`✉ Emails… ${totalSaved-emailStart} emails saved`);
            }
            syncMsg(`✉ Emails done — ${totalSaved-emailStart} saved`);

            // ── 5. TASKS ────────────────────────────────────────────────────
            const taskStart = totalSaved;
            syncMsg("✅ Fetching tasks from HubSpot…");
            let taskPages=0; let taskAfter=null;
            while(taskPages<500){
              const d = await hsFetch("getTasks", taskAfter?{after:taskAfter}:{});
              for(const t of (d.results||[])){
                const person  = resolvePersonFromAssoc(t.associations);
                const p       = t.properties||{};
                const subject = p.hs_task_subject||"Task";
                const body    = [p.hs_task_body, p.hs_task_status, p.hs_task_type].filter(Boolean).join(" · ");
                const ts      = p.hs_timestamp||p.createdate||null;
                await saveEngagement(t.id, person, "task", subject, body, "note", ts);
              }
              taskAfter = d.paging?.next?.after;
              taskPages++;
              if(!taskAfter) break;
              if(taskPages%5===0) syncMsg(`✅ Tasks… ${totalSaved-taskStart} tasks saved`);
            }
            syncMsg(`✓ Activity sync complete — ${totalSaved} records imported, ${totalSkipped} already existed or unlinked`);
          } catch(e){
            syncMsg("Error: "+e.message);
          }
          setHsImporting(false);
        };

        return (
          <div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:12,marginBottom:12}}>
              <Card style={{border:`1.5px solid ${T.accent}33`}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>🚀 Full Sync</div>
                <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.6}}>
                  Deletes all companies <em>and</em> contacts then re-imports everything fresh including links.
                </div>
                <Btn sm onClick={fullSync} disabled={hsImporting} style={{background:T.accent,color:"#fff",fontWeight:700,width:"100%"}}>
                  {hsImporting?"⏳ Syncing…":"🔄 Full Sync — Companies + Contacts"}
                </Btn>
              </Card>
              <Card style={{border:`1.5px solid ${T.teal}33`}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>🏢 Add New Companies</div>
                <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.6}}>
                  Adds companies from HubSpot that don't exist here yet. Existing companies are <strong>never deleted or overwritten</strong> — only new ones are added.
                </div>
                <Btn sm onClick={syncCompaniesOnly} disabled={hsImporting} style={{background:T.teal,color:"#fff",fontWeight:700,width:"100%"}}>
                  {hsImporting?"⏳ Syncing…":"🏢 Add New Companies from HubSpot"}
                </Btn>
              </Card>
              <Card style={{border:`1.5px solid ${T.blue}33`}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>👥 Add New Contacts</div>
                <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.6}}>
                  Adds contacts from HubSpot that don't exist here yet. Existing contacts are <strong>never deleted or overwritten</strong> — only new ones are added.
                </div>
                <Btn sm onClick={syncContactsOnly} disabled={hsImporting} style={{background:T.blue,color:"#fff",fontWeight:700,width:"100%"}}>
                  {hsImporting?"⏳ Syncing…":"👥 Add New Contacts from HubSpot"}
                </Btn>
              </Card>
              <Card style={{border:`1.5px solid ${T.gold}33`}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>📋 Sync Activity</div>
                <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.6}}>
                  Imports all HubSpot activity — notes, calls, meetings, emails and tasks — linked to your contacts and companies. Safe to re-run; duplicates are skipped.
                </div>
                <Btn sm onClick={syncActivity} disabled={hsImporting} style={{background:T.gold,color:"#fff",fontWeight:700,width:"100%"}}>
                  {hsImporting?"⏳ Syncing…":"📋 Sync Activity (Notes, Calls, Meetings, Emails, Tasks)"}
                </Btn>
              </Card>
              <Card style={{border:`1.5px solid ${T.teal}33`,gridColumn:"1 / -1"}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>👤 Sync User Compliance Data</div>
                <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.6}}>
                  Matches HubSpot contacts to KTA users by email and updates their <strong>EW Licence expiry, Site Safe, First Aid, licence numbers and emergency contact</strong> — without touching any other data. Run this whenever compliance data is updated in HubSpot.
                </div>
                <Btn sm onClick={syncUsersFromHubSpot} disabled={hsImporting} style={{background:T.teal,color:"#fff",fontWeight:700,width:"100%"}}>
                  {hsImporting?"⏳ Syncing…":"👤 Sync User Compliance Data from HubSpot"}
                </Btn>
              </Card>
            </div>
            <Card style={{marginBottom:12}}>
              <div style={{fontSize:13,color:T.sub,marginBottom:8}}>HubSpot API Token (required for all sync options)</div>
              <input type="password" placeholder="pat-ap1-xxxxxxxx…"
                value={hsToken} onChange={e=>setHsToken(e.target.value)}
                style={{width:"100%",fontFamily:"monospace",fontSize:13}}/>
              {hsMsg&&<div style={{marginTop:10,fontSize:13,fontWeight:700,lineHeight:1.7,
                color:hsMsg.startsWith("✓")?T.teal:hsMsg.startsWith("Error")?T.red:T.sub}}>{hsMsg}</div>}
            </Card>

            <HubSpotPropertyInspector hsToken={hsToken} hsFetch={hsFetch}/>

            {canDelete&&(
              <Card style={{border:`1.5px solid ${T.red}44`,marginTop:8}}>
                <div style={{fontWeight:700,fontSize:14,color:T.red,marginBottom:6}}>⚠ Danger Zone</div>
                <div style={{fontSize:13,color:T.sub,marginBottom:12}}>
                  Permanently deletes <strong>all CRM contacts and companies</strong> from the database. This cannot be undone.
                </div>
                <button onClick={async()=>{
                  if(!await ktaConfirm("DELETE ALL contacts and companies? This cannot be undone.")) return;
                  if(!await ktaConfirm("Are you absolutely sure? All CRM data will be lost.")) return;
                  setHsMsg("🗑 Deleting…");
                  try {
                    await deleteAllRows("crm_contacts");
                    await deleteAllRows("crm_companies");
                    setContacts([]); setCompanies([]);
                    setHsMsg("✓ All contacts and companies deleted.");
                  } catch(e){ setHsMsg("Error: "+e.message); }
                }} style={{background:T.red,color:"#fff",border:"none",borderRadius:8,
                  padding:"8px 18px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                  🗑 Delete All Contacts &amp; Companies
                </button>
              </Card>
            )}
          </div>
        );
      })()}

      {tab==="deals"&&(<>
        {canEdit&&<div style={{marginBottom:14}}>
          <Btn sm onClick={()=>setShowDF(s=>!s)}>{showDF?"✕ Cancel":"+ Add Deal"}</Btn>
        </div>}
        {showDF&&<Card style={{marginBottom:16,border:`1.5px solid ${T.warn}44`}}>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Title</FL><input value={dForm.title} onChange={e=>sd("title",e.target.value)} placeholder="Deal name"/></div>
            <div><FL>Contact</FL><input value={dForm.contact} onChange={e=>sd("contact",e.target.value)} placeholder="Name / Company"/></div>
            <div><FL>Value ($)</FL><input type="number" value={dForm.value} onChange={e=>sd("value",e.target.value)} placeholder="10000"/></div>
            <div><FL>Stage</FL><select value={dForm.stage} onChange={e=>sd("stage",e.target.value)}>{STAGES.map(s=><option key={s}>{s}</option>)}</select></div>
            <div><FL>Close Date</FL><input type="date" value={dForm.closeDate} onChange={e=>sd("closeDate",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={dForm.notes} onChange={e=>sd("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={saveDeal}>Save Deal</Btn>
            <Btn v="ghost" onClick={()=>setShowDF(false)}>Cancel</Btn>
          </div>
        </Card>}
        <Card style={{padding:0,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"8px 1fr 140px 100px 120px 100px 40px",
            padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
            fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:10}}>
            <span/><span>Deal</span><span>Contact</span><span style={{textAlign:"right"}}>Value</span>
            <span>Stage</span><span>Close</span><span/>
          </div>
          {deals.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No deals yet.</div>}
          {deals.map((d,i)=>(
            <div key={d.id} className="ri" style={{display:"grid",gridTemplateColumns:"8px 1fr 140px 100px 120px 100px 40px",
              padding:"12px 16px",borderBottom:i<deals.length-1?`1px solid ${T.border}44`:"none",
              background:i%2===0?T.surface:T.bg,alignItems:"center",gap:10,animationDelay:`${i*.03}s`}}>
              <div style={{width:8,height:34,borderRadius:3,background:STAGE_C[d.stage]||T.muted}}/>
              <div><div style={{fontWeight:700,fontSize:14}}>{d.title}</div>
                {d.notes&&<div style={{fontSize:12,color:T.muted,marginTop:1}}>{d.notes}</div>}</div>
              <div style={{fontSize:13,color:T.sub}}>{d.contact||"—"}</div>
              <div style={{textAlign:"right",fontFamily:"DM Sans",fontWeight:700,fontSize:16,color:STAGE_C[d.stage]||T.muted}}>
                {d.value?`$${parseFloat(d.value).toLocaleString()}`:"—"}</div>
              <Pill label={d.stage} size="sm" color={STAGE_C[d.stage]||T.muted} bg={(STAGE_C[d.stage]||T.muted)+"1a"}/>
              <div style={{fontSize:12,color:T.muted}}>{d.closeDate?new Date(d.closeDate+"T00:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}):"—"}</div>
              {canEdit&&<button onClick={()=>{ setDeals(prev=>prev.filter(x=>x.id!==d.id)); deleteRow("crm_deals",d.id).catch(console.error); }} style={{
                width:26,height:26,borderRadius:6,fontSize:13,background:"transparent",color:T.muted,
                border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>}
            </div>
          ))}
        </Card>
      </>)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN DASHBOARD  — overview cards linking to each apprentice's timesheets
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// HOURS THIS WEEK LIST  — all entries this week, grouped by apprentice A-Z
// ─────────────────────────────────────────────────────────────────────────────

export default UserManagement;
export { UserDetailView, CRMUsersPanel };
export { ApprenticeList, ApprenticeEditForm };
