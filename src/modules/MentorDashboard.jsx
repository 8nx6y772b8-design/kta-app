import { useState, useEffect } from "react";
import { T } from "../constants.js";
import { fmtD, daysAgoStr } from "../utils.js";
import { loadTable } from "../supabaseClient.js";
import { Avatar, Card } from "../shared.jsx";
import ApprenticeDetailView from "./ApprenticeDetail.jsx";

function MentorApprenticeDetail({apprentice, mentor, allUsers, onBack}) {
  if(!apprentice) return null;
  return <ApprenticeDetailView apprentice={apprentice} viewer={mentor} allUsers={allUsers} onBack={onBack} isAdmin={false} canEditExpiry={true} entries={[]}/>;
}

// ── Mentor Dashboard (home screen) ───────────────────────────────────────────
function MentorDashboard({currentUser, allUsers}) {
  const [selectedApprentice, setSelectedApprentice] = useState(()=>{
    try{
      const id=localStorage.getItem("wos_mentor_app");
      return null; // will be resolved after allUsers loads — see useEffect below
    }catch{return null;}
  });
  const [apprenticeSummaries, setApprenticeSummaries] = useState({}); // id -> {lastVisit, reportCount}
  const [loadingMeta, setLoadingMeta] = useState(true);

  // Restore selected apprentice from localStorage once allUsers is loaded
  useEffect(()=>{
    if(!selectedApprentice && allUsers.length>0){
      try{
        const id=localStorage.getItem("wos_mentor_app");
        if(id){ const u=allUsers.find(x=>x.id===id); if(u) setSelectedApprentice(u); }
      }catch{}
    }
  },[allUsers]);

  const selectMentorApp=(u)=>{
    if(u) {
      if(!window.__ktaBackHandlers) window.__ktaBackHandlers=[];
      window.__ktaBackHandlers.push(()=>selectMentorApp(null));
      window.history.pushState({ktaNav:true},"");
    }
    setSelectedApprentice(u);
    try{if(u) localStorage.setItem("wos_mentor_app",u.id); else localStorage.removeItem("wos_mentor_app");}catch{};
  };

  // Mentor's allocated apprentices — check both allocatedTo (legacy) and mentorUserId (new)
  const myApprentices = allUsers.filter(u=>
    u.role==="Apprentice" && (
      (currentUser.allocatedTo||[]).includes(u.id) ||
      u.mentorUserId===currentUser.id
    )
  ).sort((a,b)=>(a.name||"").localeCompare(b.name||""));

  // Load meeting report meta for each apprentice
  useEffect(()=>{
    loadTable('meeting_reports')
      .then(rows=>{
        const map = {};
        myApprentices.forEach(app=>{
          const appRows = rows.filter(r=>r.apprentice_id===app.id).sort((a,b)=>b.date.localeCompare(a.date));
          map[app.id] = { lastVisit: appRows[0]?.date||null, reportCount: appRows.length };
        });
        setApprenticeSummaries(map);
      })
      .catch(()=>{})
      .finally(()=>setLoadingMeta(false));
  },[allUsers, currentUser.id]);

  const fmtDate = (iso) => { if(!iso) return null; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };
  const daysUntil = (iso) => { if(!iso) return null; const today=new Date(); today.setHours(0,0,0,0); const exp=new Date(iso+"T00:00:00"); return Math.round((exp-today)/86400000); };

  const MENTOR_DEFAULT_ORDER = ["apprentices", "resources"];
  const { order: mentorOrder, dragProps: mentorDragProps } = useDraggableOrder(currentUser.id + "_mentor", MENTOR_DEFAULT_ORDER);

  if(selectedApprentice) {
    return (
      <ApprenticeDetailView
        apprentice={selectedApprentice}
        viewer={currentUser}
        allUsers={allUsers}
        entries={[]}
        isAdmin={false}
        canEditExpiry={true}
        onBack={()=>selectMentorApp(null)}
      />
    );
  }

  const mentorSections = {
    apprentices: (
      <DraggableSection id="apprentices" dragProps={mentorDragProps}>
        <Card>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
            <div style={{width:38,height:38,borderRadius:11,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>👷</div>
            <div>
              <div style={{fontWeight:700,fontSize:18}}>My Apprentices</div>
              <div style={{fontSize:13,color:T.sub}}>{myApprentices.length} apprentice{myApprentices.length!==1?"s":""} allocated to you</div>
            </div>
          </div>
          {myApprentices.length===0&&(
            <div style={{padding:"24px 0",textAlign:"center",color:T.muted,fontSize:14,fontStyle:"italic"}}>
              No apprentices allocated to you yet — contact an Admin.
            </div>
          )}
          {myApprentices.map((app,i)=>{
            const meta   = apprenticeSummaries[app.id]||{};
            const licDays = daysUntil(app.licenceExpiry);
            const licWarn = licDays!==null && licDays<=30;
            return (
              <div key={app.id} onClick={()=>selectMentorApp(app)}
                className="ri"
                style={{display:"flex",alignItems:"center",gap:14,padding:"12px 4px",
                  borderBottom:i<myApprentices.length-1?`1px solid ${T.border}44`:"none",
                  cursor:"pointer",borderRadius:8,animationDelay:`${i*.04}s`}}
                onMouseEnter={e=>e.currentTarget.style.background=T.accentL+"66"}
                onMouseLeave={e=>e.currentTarget.style.background="none"}>
                <Avatar name={app.name} role="Apprentice" size={42}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:16,color:T.accent}}>{app.name}</div>
                  <div style={{fontSize:13,color:T.sub,marginTop:1,display:"flex",gap:10,flexWrap:"wrap"}}>
                    {app.trade&&<span>🔧 {app.trade}</span>}
                    {app.hostBusiness&&<span>🏢 {app.hostBusiness}</span>}
                    {meta.lastVisit&&<span>📅 Last visit {fmtDate(meta.lastVisit)}</span>}
                    {!meta.lastVisit&&!loadingMeta&&<span style={{color:T.muted,fontStyle:"italic"}}>No visits yet</span>}
                    {meta.reportCount>0&&<span>📋 {meta.reportCount} report{meta.reportCount!==1?"s":""}</span>}
                    {app.licenceExpiry&&(()=>{
                      const days = daysUntil(app.licenceExpiry);
                      const color = days<0?T.red:days<=30?T.warn:T.sub;
                      const label = days<0?"Licence expired":days===0?"Expires today":`Licence ${new Date(app.licenceExpiry+"T00:00:00").toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"})}`;
                      return <span style={{color,fontWeight:days<=30?700:400}}>🪪 {label}</span>;
                    })()}
                  </div>
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4,flexShrink:0}}>
                  {licWarn&&(
                    <div style={{fontSize:12,fontWeight:700,color:licDays<0?T.red:licDays<=7?T.red:T.warn,
                      background:licDays<=7?T.redL:T.warnL,borderRadius:6,padding:"2px 8px"}}>
                      {licDays<0?"Licence expired":licDays===0?"Expires today":`Licence: ${licDays}d`}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      </DraggableSection>
    ),

    resources: (
      <DraggableSection id="resources" dragProps={mentorDragProps}>
        <Card>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
            <div style={{width:38,height:38,borderRadius:11,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>📂</div>
            <div>
              <div style={{fontWeight:700,fontSize:18}}>Resources</div>
              <div style={{fontSize:13,color:T.sub}}>Guides, templates, and reference materials</div>
            </div>
          </div>
          <div style={{background:T.bg,borderRadius:10,padding:"14px 16px",border:`1px dashed ${T.border}`,textAlign:"center"}}>
            <div style={{fontSize:31,marginBottom:8}}>📁</div>
            <div style={{fontWeight:700,fontSize:16,color:T.sub,marginBottom:4}}>Resource Folder Coming Soon</div>
            <div style={{fontSize:13,color:T.muted,lineHeight:1.6}}>
              This section will link to shared files, templates, and training resources.<br/>
              Contact your Admin to set up the resource folder.
            </div>
          </div>
        </Card>
      </DraggableSection>
    ),
  };

  return (
    <div className="fu">
      <div style={{marginBottom:20}}>
        <h1 style={{fontFamily:"DM Sans",fontSize:28,fontWeight:700,letterSpacing:"-.4px",marginBottom:4}}>
          Welcome, {currentUser.name.split(" ")[0]}
        </h1>
        <p style={{fontSize:14,color:T.sub}}>Your apprentice overview and mentor tools</p>
      </div>
      {mentorOrder.map(id => mentorSections[id] || null)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENTIAL NOTES — per-note PIN lock, only Kristeena can lock/unlock
// ─────────────────────────────────────────────────────────────────────────────
// PIN "1002" hash
const CONF_PIN_HASH = "b281bc2c616cb3c3a097215fdc9397ae87e6e06b156cc34e656be7a1a9ce8839";

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

// PinPromptModal — shown when locking or unlocking a note

export default MentorDashboard;
