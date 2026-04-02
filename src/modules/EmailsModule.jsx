import { useState, useEffect } from "react";
import { T } from "../constants.js";
import { uid, fmtD } from "../utils.js";
import { loadTable, upsertRow, deleteRow, insertMessage } from "../supabaseClient.js";
import { Btn, Card } from "../shared.jsx";
import { ktaConfirm } from "./LeaveResultScreen.jsx";

const EMAIL_PROXY_KEY = "kta_email_proxy_url";
const getEmailProxyUrl = () => { try{ return localStorage.getItem(EMAIL_PROXY_KEY)||""; }catch{ return ""; } };
const callEmailProxy = async (payload) => {
  const url = getEmailProxyUrl();
  if(!url) return { ok:false, error:"Email proxy not configured. Set up in Settings." };
  try {
    const res = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
    const data = await res.json();
    if(!res.ok) return { ok:false, error: data.error||`HTTP ${res.status}` };
    return { ok:true, ...data };
  } catch(e) { return { ok:false, error: e.message }; }
};
const fetchEmailsForPerson = async (emailAddress, maxResults=30) => {
  if(!emailAddress) return { ok:false, emails:[], error:"No email address" };
  return callEmailProxy({ action:"searchByAddress", emailAddress, maxResults });
};

const NoteTextarea = ({value, onChange, placeholder}) => (
  <textarea value={value} onChange={onChange} placeholder={placeholder}
    rows={3}
    style={{width:"100%",fontSize:14,padding:"10px 12px",border:`1.5px solid ${T.border}`,
      borderRadius:8,fontFamily:"DM Sans,sans-serif",background:"#fff",resize:"vertical",
      color:T.ink,outline:"none",boxSizing:"border-box",minHeight:72}}/>
);

// ── EmailActivityFeed ─────────────────────────────────────────────────────────
// HubSpot-style activity timeline for any person record.
// Props:
//   personEmail — the email address to search
//   personName  — display name
//   personId    — Supabase user id (nullable for CRM contacts)
//   extraItems  — pre-loaded items to merge (e.g. meeting reports as {_kind,_ts,label,detail})
//   canEdit     — whether notes/pins are allowed
function EmailActivityFeed({personEmail, personName, personId=null, extraItems=[], canEdit=true, isKristeena=false, isAdmin1=false}) {
  const [emails, setEmails]             = useState([]);
  const [notes, setNotes]               = useState([]);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [loadingNotes, setLoadingNotes]   = useState(true);
  const [emailError, setEmailError]     = useState(null);
  const [expanded, setExpanded]         = useState({});
  const [noteText, setNoteText]         = useState("");
  const [addingNote, setAddingNote]     = useState(false);
  const [activityType, setActivityType] = useState(""); // set when dropdown item clicked
  const [savingNote, setSavingNote]     = useState(false);
  const [pinPrompt, setPinPrompt]       = useState(null);  // null | "lock" | noteId (unlock)
  const [pendingNote, setPendingNote]   = useState(null);  // note object waiting for PIN confirm
  const [unlockedIds, setUnlockedIds]   = useState(new Set()); // IDs unlocked this session
  const [pinning, setPinning]           = useState({});
  const proxyOk = !!getEmailProxyUrl();

  // Load saved activity notes from Supabase
  useEffect(()=>{
    if(!personEmail && !personId) { setLoadingNotes(false); return; }
    loadTable('activity_notes')
      .then(rows => setNotes(
        rows.filter(r=> (personEmail && r.person_email===personEmail) || (personId && r.person_id===personId))
            .sort((a,b)=>b.created_at.localeCompare(a.created_at))
      ))
      .catch(()=>setNotes([]))
      .finally(()=>setLoadingNotes(false));
  },[personEmail, personId]);

  // Load live emails from M365
  const loadEmails = async () => {
    if(!personEmail||!proxyOk) return;
    setLoadingEmails(true); setEmailError(null);
    const result = await fetchEmailsForPerson(personEmail);
    if(result.ok) setEmails(result.emails||[]);
    else setEmailError(result.error);
    setLoadingEmails(false);
  };
  useEffect(()=>{ loadEmails(); },[personEmail]);

  const saveNote = async () => {
    if(!noteText.trim()) return;
    const note = {
      id: uid(), person_email: personEmail||null, person_id: personId||null,
      person_name: personName||null, type:"note",
      subject: activityType||"Note",
      activity_type: activityType||"Note",
      body: noteText.trim(), direction:"note",
      created_at: new Date().toISOString(),
      is_locked: false,
    };
    if(isKristeena) {
      // Ask if she wants to lock it
      setPendingNote(note);
      setPinPrompt("asklock");
      return;
    }
    setSavingNote(true);
    try {
      await upsertRow('activity_notes', note);
      setNotes(prev=>[note,...prev]);
      setNoteText(""); setAddingNote(false); setActivityType("");
    } catch(e) { alert("Failed to save: "+e.message); }
    setSavingNote(false);
  };

  const commitNote = async (note) => {
    setSavingNote(true);
    try {
      await upsertRow('activity_notes', note);
      setNotes(prev=>[note,...prev]);
      setNoteText(""); setAddingNote(false); setActivityType("");
      if(note.is_locked) setUnlockedIds(prev=>new Set([...prev, note.id]));
    } catch(e) { alert("Failed to save: "+e.message); }
    setSavingNote(false);
    setPinPrompt(null); setPendingNote(null);
  };

  const toggleLock = async (note) => {
    if(note.is_locked) {
      // Already locked — prompt PIN to unlock (session only, no DB change needed)
      setPinPrompt(note.id);
    } else {
      // Not locked — prompt PIN to lock it
      setPendingNote({...note, is_locked:true});
      setPinPrompt("lockexisting");
    }
  };

  const lockExistingNote = async (note) => {
    const updated = {...note, is_locked:true};
    try {
      await upsertRow('activity_notes', updated);
      setNotes(prev=>prev.map(n=>n.id===note.id?updated:n));
    } catch(e) { alert("Failed to lock note: "+e.message); }
    setPinPrompt(null); setPendingNote(null);
  };

  const pinEmail = async (email) => {
    const already = notes.some(n=>n.email_id===email.id);
    if(already) return;
    setPinning(p=>({...p,[email.id]:true}));
    const note = {
      id: uid(), person_email: personEmail||null, person_id: personId||null,
      person_name: personName||null, type:"email",
      subject: email.subject||"(no subject)", body: email.bodyPreview||email.snippet||"",
      direction: email.direction||"inbound", email_id: email.id,
      from_address: email.from||"", to_address: email.to||"",
      email_date: email.date||null,
      created_at: new Date().toISOString(),
    };
    try {
      await upsertRow('activity_notes', note);
      setNotes(prev=>[note,...prev]);
    } catch(e) { alert("Failed to pin: "+e.message); }
    setPinning(p=>({...p,[email.id]:false}));
  };

  const deleteNote = async (id) => {
    if(!await ktaConfirm("Remove this activity?")) return;
    await deleteRow('activity_notes', id).catch(console.error);
    setNotes(prev=>prev.filter(n=>n.id!==id));
  };

  // Merge notes + extraItems into a single timeline
  const timeline = [
    ...notes.map(n=>({...n, _src:"note"})),
    ...extraItems.map(x=>({...x, _src:"extra"})),
  ].sort((a,b)=>{
    const ta = a.created_at||a.date+"T00:00:00";
    const tb = b.created_at||b.date+"T00:00:00";
    return tb.localeCompare(ta);
  });

  const fmtTs = (iso) => {
    if(!iso) return "—";
    try{
      const d = new Date(iso);
      return d.toLocaleDateString("en-NZ",{day:"2-digit",month:"short",year:"numeric"})
        +" · "+d.toLocaleTimeString("en-NZ",{hour:"2-digit",minute:"2-digit",hour12:true});
    }catch{ return iso; }
  };

  const activityMeta = (item) => {
    const t = item.activity_type||item.subject||"";
    const nt = item.notif_type||"";
    if(t==="Phone Call")        return {label:"📞 Phone Call",      color:T.teal,   bg:T.tealL};
    if(t==="Email")             return {label:"✉ Email",           color:T.accent, bg:T.accentL};
    if(t==="Text Message")      return {label:"💬 Text Message",    color:T.blue,   bg:T.blueL};
    if(t==="In Person Meeting") return {label:"🤝 In Person",      color:T.hol,    bg:T.holL};
    if(t==="Notification") {
      if(nt==="licence_expiry") return {label:"⚠ Licence Expiry",  color:T.warn,   bg:T.warnL};
      if(nt==="approval")       return {label:"✓ Approved",         color:T.teal,   bg:T.tealL};
      if(nt==="decline")        return {label:"✕ Declined",         color:T.red,    bg:T.redL};
      if(nt==="broadcast")      return {label:"Contact Via App",       color:T.blue,   bg:T.blueL};
      if(nt==="reply")          return {label:"↩ Reply",            color:T.teal,   bg:T.tealL};
      return {label:"🔔 Notification", color:T.sub, bg:T.slateL};
    }
    if(t==="Other")             return {label:"📝 Note",            color:T.gold,   bg:T.goldL};
    // fallback to direction-based
    return ({
      inbound:  {label:"↓ Received", color:T.teal,  bg:T.tealL},
      outbound: {label:"↑ Sent",     color:T.accent, bg:T.accentL},
      note:     {label:"📝 Note",    color:T.gold,   bg:T.goldL},
      report:   {label:"📋 Report",  color:T.blue,   bg:T.blueL},
    })[item.direction||"note"]||{label:"◈ Activity", color:T.sub, bg:T.bg};
  };
  const dirMeta = (dir) => ({
    inbound:  {label:"↓ Received", color:T.teal,  bg:T.tealL},
    outbound: {label:"↑ Sent",     color:T.accent, bg:T.accentL},
    note:     {label:"📝 Note",    color:T.gold,   bg:T.goldL},
    report:   {label:"📋 Report",  color:T.blue,   bg:T.blueL},
  })[dir||"note"]||{label:"◈ Activity", color:T.sub, bg:T.bg};

  const isNoteVisible = (n) => {
    if(!n.is_locked) return true;
    if(isKristeena) return unlockedIds.has(n.id); // locked — only show if unlocked this session
    return false; // other users never see locked content
  };

  const pinnedIds = new Set(notes.map(n=>n.email_id).filter(Boolean));

  return (
    <div>
      {/* PIN prompt modals */}
      {pinPrompt==="asklock"&&pendingNote&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:T.surface,borderRadius:16,padding:"28px 28px 24px",maxWidth:340,width:"100%",border:`1.5px solid ${T.border}`}}>
            <div style={{fontWeight:700,fontSize:18,marginBottom:8}}>Save Note</div>
            <div style={{fontSize:14,color:T.sub,marginBottom:20}}>Would you like to lock this note with your PIN? Locked notes are only visible to you.</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>commitNote({...pendingNote,is_locked:false})}
                style={{flex:1,padding:"10px",borderRadius:8,border:`1.5px solid ${T.border}`,background:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontSize:14}}>
                💾 Save unlocked
              </button>
              <button onClick={()=>{ setPinPrompt("lockpin"); }}
                style={{flex:1,padding:"10px",borderRadius:8,border:"none",background:T.accent,color:"#fff",cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontSize:14,fontWeight:700}}>
                🔒 Lock with PIN
              </button>
            </div>
          </div>
        </div>
      )}
      {(pinPrompt==="lockpin"||pinPrompt==="lockexisting"||typeof pinPrompt==="string"&&pinPrompt.length>10)&&(
        <PinPromptModal
          title={typeof pinPrompt==="string"&&pinPrompt.length>10?"Unlock Note":"Lock Note"}
          onConfirm={()=>{
            if(pinPrompt==="lockpin"&&pendingNote) { commitNote({...pendingNote,is_locked:true}); }
            else if(pinPrompt==="lockexisting"&&pendingNote) {
              lockExistingNote(pendingNote);
            } else {
              // Unlocking by note id
              setUnlockedIds(prev=>new Set([...prev, pinPrompt]));
              setPinPrompt(null);
            }
          }}
          onCancel={()=>{ setPinPrompt(null); setPendingNote(null); }}
        />
      )}
      {/* Toolbar */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:"#f0f7ff",
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>✉</div>
          <div>
            <div style={{fontWeight:700,fontSize:16,color:T.ink}}>Activity & Email Timeline</div>
            <div style={{fontSize:12,color:T.sub}}>{personEmail||"No email set"}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {canEdit&&(
            addingNote ? (
              <Btn sm onClick={()=>{setAddingNote(false);setNoteText("");setActivityType("");}} v="ghost">✕ Cancel</Btn>
            ) : (
              <div style={{position:"relative",display:"inline-block"}}>
                <Btn sm onClick={e=>{
                  const d=e.currentTarget.nextSibling;
                  d.style.display=d.style.display==="block"?"none":"block";
                  const close=()=>{d.style.display="none";document.removeEventListener("click",close);};
                  setTimeout(()=>document.addEventListener("click",close),0);
                }}>+ Log Activity ▾</Btn>
                <div style={{display:"none",position:"absolute",top:"calc(100% + 4px)",right:0,
                  background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:10,
                  boxShadow:"0 4px 20px rgba(0,0,0,.12)",zIndex:200,minWidth:190,overflow:"hidden"}}>
                  {[["📞","Phone Call"],["✉","Email"],["💬","Text Message"],["🤝","In Person Meeting"],["📝","Other"]].map(([icon,label])=>(
                    <button key={label}
                      onClick={()=>{setActivityType(label);setAddingNote(true);}}
                      style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"9px 14px",
                        background:"none",border:"none",cursor:"pointer",fontSize:14,
                        color:T.ink,fontFamily:"DM Sans,sans-serif",textAlign:"left"}}
                      onMouseEnter={e=>e.currentTarget.style.background=T.accentL}
                      onMouseLeave={e=>e.currentTarget.style.background="none"}>
                      <span style={{fontSize:17}}>{icon}</span>{label}
                    </button>
                  ))}
                </div>
              </div>
            )
          )}
          {proxyOk&&personEmail&&(
            <Btn sm v="ghost" onClick={loadEmails} disabled={loadingEmails}>
              {loadingEmails?"Loading…":"↻ Refresh Emails"}
            </Btn>
          )}
        </div>
      </div>

      {/* Add note box */}
      {addingNote&&(
        <div style={{background:T.goldL,border:`1.5px solid ${T.gold}44`,borderRadius:10,
          padding:14,marginBottom:14}}>
          <div style={{fontWeight:700,fontSize:14,marginBottom:8,color:T.gold}}>
            {activityType==="Phone Call"?"📞":activityType==="Email"?"✉":activityType==="Text Message"?"💬":activityType==="In Person Meeting"?"🤝":"📝"} Log {activityType||"Activity Note"}
          </div>
          <NoteTextarea
            value={noteText}
            onChange={e=>setNoteText(e.target.value)}
            placeholder={`Log a call, meeting, email summary, or any interaction with ${personName||"this contact"}…`}
          />
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <Btn sm onClick={saveNote} disabled={savingNote||!noteText.trim()}>
              {savingNote?"Saving…":"💾 Save Note"}
            </Btn>
            <Btn sm v="ghost" onClick={()=>{setAddingNote(false);setNoteText("");setActivityType("");}}>Cancel</Btn>
          </div>
        </div>
      )}

      {/* Not configured banner */}
      {!proxyOk&&(
        <div style={{background:T.warnL,border:`1px solid ${T.warn}44`,borderRadius:8,
          padding:"10px 14px",marginBottom:14,fontSize:13,color:T.warn,lineHeight:1.6}}>
          ⚠ <strong>Email tracking not configured.</strong> Set up the M365 Email Proxy URL in Admin → Settings to enable live email sync. Activity notes can still be logged manually.
        </div>
      )}
      {emailError&&(
        <div style={{background:T.redL,border:`1px solid ${T.red}44`,borderRadius:8,
          padding:"10px 14px",marginBottom:14,fontSize:13,color:T.red}}>
          ✕ Email sync error: {emailError}
        </div>
      )}

      {/* Live emails from M365 (unpinned) */}
      {proxyOk&&emails.length>0&&(
        <div style={{marginBottom:16}}>
          <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",
            letterSpacing:".6px",marginBottom:8}}>
            📬 Emails from Microsoft 365 — {emails.length} found
          </div>
          {emails.map(em=>{
            const isOpen = expanded[em.id];
            const isPinned = pinnedIds.has(em.id);
            const dm = dirMeta(em.direction);
            return (
              <div key={em.id} style={{border:`1.5px solid ${T.border}`,borderRadius:10,
                marginBottom:6,overflow:"hidden",opacity:isPinned?0.7:1}}>
                <div onClick={()=>setExpanded(x=>({...x,[em.id]:!x[em.id]}))}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",
                    cursor:"pointer",background:isOpen?T.bg:T.surface,
                    borderBottom:isOpen?`1px solid ${T.border}`:"none"}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:dm.color,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:14,color:T.ink,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {em.subject||"(no subject)"}
                    </div>
                    <div style={{fontSize:12,color:T.sub,marginTop:1}}>
                      <span style={{color:dm.color,fontWeight:700}}>{dm.label}</span>
                      {" · "}{em.from||em.to||""}
                      {" · "}{fmtTs(em.date)}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                    {canEdit&&!isPinned&&(
                      <button onClick={e=>{e.stopPropagation();pinEmail(em);}}
                        disabled={pinning[em.id]}
                        title="Pin to activity log"
                        style={{fontSize:12,fontWeight:700,padding:"3px 9px",borderRadius:6,
                          background:T.accentL,color:T.accent,border:`1px solid ${T.accent}44`,
                          cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                        {pinning[em.id]?"…":"📌 Pin"}
                      </button>
                    )}
                    {isPinned&&<span style={{fontSize:12,color:T.teal,fontWeight:700}}>✓ Pinned</span>}
                    <span style={{fontSize:12,color:T.muted}}>{isOpen?"▲":"▼"}</span>
                  </div>
                </div>
                {isOpen&&(
                  <div style={{padding:"12px 14px",background:"#fff",fontSize:14,
                    color:T.ink,lineHeight:1.7,whiteSpace:"pre-wrap",borderTop:`1px solid ${T.border}`}}>
                    <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                      {em.from&&<span style={{fontSize:12,color:T.sub}}><strong>From:</strong> {em.from}</span>}
                      {em.to&&<span style={{fontSize:12,color:T.sub}}><strong>To:</strong> {em.to}</span>}
                    </div>
                    {em.bodyPreview||em.snippet||"(no preview available)"}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Activity timeline (notes + pinned emails + reports) */}
      {(loadingNotes)
        ? <div style={{textAlign:"center",padding:"24px 0",color:T.muted,fontSize:14}}>Loading activity…</div>
        : timeline.length===0
        ? <div style={{textAlign:"center",padding:"24px 0",color:T.muted,fontSize:14,fontStyle:"italic"}}>
            No activity logged yet. Use "+ Log Activity" to add a note.
          </div>
        : (
          <div>
            <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",
              letterSpacing:".6px",marginBottom:8}}>Activity Log</div>
            {timeline.map((item,i)=>{
              if(item._src==="extra") {
                // Meeting report, PPE, or other injected item
                const isPPE = (item.label||"").startsWith("PPE");
                const extraIcon = isPPE ? "🦺" : "📋";
                const extraColor = isPPE ? T.teal : T.blue;
                const extraBg = isPPE ? T.tealL : T.blueL;
                return (
                  <div key={item.id||i} style={{display:"flex",gap:12,marginBottom:10}}>
                    <div style={{width:2,background:extraBg,borderRadius:2,flexShrink:0,marginTop:4,marginBottom:4}}/>
                    <div style={{flex:1,background:extraBg,border:`1px solid ${extraColor}33`,
                      borderRadius:8,padding:"10px 13px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <span style={{fontSize:14}}>{extraIcon}</span>
                        <span style={{fontWeight:700,fontSize:14,color:extraColor}}>{item.label||"Meeting Report"}</span>
                        <span style={{fontSize:12,color:T.sub,marginLeft:"auto"}}>{fmtTs(item.created_at||item.date)}</span>
                      </div>
                      {item.detail&&<div style={{fontSize:13,color:T.ink,lineHeight:1.6}}>{item.detail}</div>}
                    </div>
                  </div>
                );
              }
              const dm = item._src==="note" ? activityMeta(item) : dirMeta(item.direction);
              return (
                <div key={item.id} style={{display:"flex",gap:12,marginBottom:10}}>
                  <div style={{width:2,background:dm.bg,borderRadius:2,flexShrink:0,marginTop:4,marginBottom:4}}/>
                  <div style={{flex:1,background:dm.bg,border:`1px solid ${dm.color}33`,
                    borderRadius:8,padding:"10px 13px"}}>
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3,flexWrap:"wrap"}}>
                          <span style={{fontSize:12,fontWeight:700,color:dm.color,
                            background:"#ffffff55",borderRadius:4,padding:"1px 6px",
                            border:`1px solid ${dm.color}33`}}>{dm.label}</span>
                          <span style={{fontWeight:700,fontSize:14,color:T.ink,
                            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {item.subject||"Note"}
                          </span>
                        </div>
                        {item.from_address&&<div style={{fontSize:12,color:T.sub,marginBottom:3}}>
                          {item.direction==="inbound"?"From":"To"}: {item.from_address||item.to_address}
                        </div>}
                        {/* Locked note display */}
                        {item.is_locked && !isNoteVisible(item) ? (
                          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6,
                            background:T.bg,borderRadius:7,padding:"8px 12px",border:`1px solid ${T.border}`}}>
                            <span style={{fontSize:18}}>🔒</span>
                            <span style={{fontSize:13,color:T.muted,fontStyle:"italic"}}>This note is locked</span>
                            {isKristeena&&(
                              <button onClick={()=>setPinPrompt(item.id)}
                                style={{marginLeft:"auto",background:"none",border:`1px solid ${T.border}`,
                                  borderRadius:6,padding:"3px 9px",fontSize:12,cursor:"pointer",
                                  color:T.accent,fontFamily:"DM Sans,sans-serif"}}>
                                🔓 Unlock
                              </button>
                            )}
                          </div>
                        ) : (
                          <div style={{fontSize:14,color:T.ink,lineHeight:1.65,whiteSpace:"pre-wrap",marginTop:4}}>
                            {item.body}
                            {item.is_locked&&isNoteVisible(item)&&(
                              <span style={{display:"inline-flex",alignItems:"center",gap:4,marginLeft:8,
                                fontSize:12,color:T.teal,fontWeight:700}}>
                                🔓 Unlocked this session
                              </span>
                            )}
                          </div>
                        )}
                        <div style={{fontSize:12,color:T.muted,marginTop:6,display:"flex",alignItems:"center",gap:8}}>
                          {fmtTs(item.email_date||item.created_at)}
                          {isKristeena&&item.direction==="note"&&(
                            <button onClick={()=>toggleLock(item)}
                              style={{background:"none",border:`1px solid ${T.border}`,borderRadius:5,
                                padding:"1px 7px",fontSize:11,cursor:"pointer",
                                color:item.is_locked?T.warn:T.muted,fontFamily:"DM Sans,sans-serif"}}>
                              {item.is_locked?"🔒 Locked":"🔓 Lock"}
                            </button>
                          )}
                        </div>
                      </div>
                      {canEdit && isAdmin1 && (
                        <button onClick={()=>deleteNote(item.id)}
                          title="Remove activity"
                          style={{flexShrink:0,background:"none",border:"none",
                            color:T.muted,fontSize:16,cursor:"pointer",padding:"0 4px",lineHeight:1}}
                          onMouseEnter={e=>e.currentTarget.style.color=T.red}
                          onMouseLeave={e=>e.currentTarget.style.color=T.muted}>✕</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      }
    </div>
  );
}

// ── EmailsModule — Global org inbox/sent view (Admin only) ────────────────────
function EmailsModule({allUsers, currentUser}) {
  const [tab, setTab]           = useState("inbox");
  const [emails, setEmails]     = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [expanded, setExpanded] = useState({});
  const [proxyUrl, setProxyUrl] = useState(()=>getEmailProxyUrl());
  const [savedUrl, setSavedUrl] = useState(false);
  const [search, setSearch]     = useState("");
  const [captureSubs, setCaptureSubs]         = useState([]);
  const [captureUnknown, setCaptureUnknown]   = useState([]);
  const [captureLoading, setCaptureLoading]   = useState(false);
  const [captureMsg, setCaptureMsg]           = useState("");
  const [addingEmail, setAddingEmail]         = useState("");
  const [captureUrl, setCaptureUrl]           = useState("");

  const CAPTURE_FN_KEY = "kta_graph_capture_url";
  const getCaptureUrl  = () => { try{ return localStorage.getItem(CAPTURE_FN_KEY)||""; }catch{ return ""; } };
  const saveCaptureUrl = (url) => { try{ localStorage.setItem(CAPTURE_FN_KEY, url); }catch{} };

  const loadCapture = async () => {
    setCaptureLoading(true);
    try {
      const capUrl = getCaptureUrl();
      if(capUrl) {
        const res = await fetch(capUrl+"/manage-subscriptions", {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({action:"list"})
        });
        if(res.ok) { const d = await res.json(); setCaptureSubs(d.subscriptions||[]); }
      }
      const { data } = await sb.from("unknown_email_contacts")
        .select("*").eq("dismissed",false).order("last_seen",{ascending:false});
      setCaptureUnknown(data||[]);
    } catch(e) { console.error(e); }
    setCaptureLoading(false);
  };

  // Auto-renew subscriptions silently — runs every time the app loads
  // Renews anything expiring within 36h so there's always a buffer
  const autoRenew = async () => {
    try {
      const capUrl = getCaptureUrl();
      if(!capUrl) return;
      // Get current subscriptions
      const listRes = await fetch(capUrl+"/manage-subscriptions", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({action:"list"})
      });
      if(!listRes.ok) return;
      const { subscriptions=[] } = await listRes.json();
      // Check if any expire within 36 hours
      const expiringSoon = subscriptions.filter(s => {
        if(!s.expirationDateTime) return true;
        const hoursLeft = (new Date(s.expirationDateTime) - Date.now()) / 3600000;
        return hoursLeft < 36;
      });
      if(expiringSoon.length === 0) return;
      // Renew them all
      await fetch(capUrl+"/manage-subscriptions", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({action:"renew-all"})
      });
    } catch(e) { /* silent — don't bother the user */ }
  };

  // Run auto-renew on mount (every time the Emails module loads)
  useEffect(()=>{ autoRenew(); },[]);

  useEffect(()=>{ if(tab==="capture") loadCapture(); },[tab]);

  const saveProxyUrl = () => {
    try{ localStorage.setItem(EMAIL_PROXY_KEY, proxyUrl.trim()); }catch{}
    setSavedUrl(true); setTimeout(()=>setSavedUrl(false),2000);
  };

  const loadEmails = async (folder) => {
    setLoading(true); setError(null); setEmails([]);
    const result = await fetchOrgInbox(folder);
    if(result.ok) setEmails(result.emails||[]);
    else setError(result.error);
    setLoading(false);
  };

  useEffect(()=>{ if(getEmailProxyUrl()) loadEmails(tab); },[tab]);

  const fmtTs = (iso) => {
    if(!iso) return "—";
    try{
      const d = new Date(iso);
      const today = new Date(); today.setHours(0,0,0,0);
      const isToday = d >= today;
      return isToday
        ? d.toLocaleTimeString("en-NZ",{hour:"2-digit",minute:"2-digit",hour12:true})
        : d.toLocaleDateString("en-NZ",{day:"2-digit",month:"short",year:"numeric"});
    }catch{ return iso; }
  };

  // Try to match an email address to a known user or CRM contact
  const matchPerson = (address) => {
    if(!address) return null;
    const clean = address.toLowerCase().replace(/.*<(.+)>.*/, "$1").trim();
    return allUsers.find(u=>u.email&&u.email.toLowerCase()===clean);
  };

  const filtered = emails.filter(em=>{
    if(!search.trim()) return true;
    const q = search.toLowerCase();
    return (em.subject||"").toLowerCase().includes(q)
      || (em.from||"").toLowerCase().includes(q)
      || (em.to||"").toLowerCase().includes(q)
      || (em.bodyPreview||"").toLowerCase().includes(q);
  });

  const TabBtn = ({id,label,icon}) => (
    <button onClick={()=>setTab(id)} style={{
      padding:"8px 18px",borderRadius:8,fontSize:14,fontWeight:700,
      background: tab===id ? T.accent : T.bg,
      color: tab===id ? "#fff" : T.sub,
      border:`1.5px solid ${tab===id?T.accentD:T.border}`,
      cursor:"pointer",fontFamily:"DM Sans,sans-serif",
      display:"flex",alignItems:"center",gap:6,transition:"all .14s"}}>
      <span>{icon}</span>{label}
    </button>
  );

  const proxyConfigured = !!getEmailProxyUrl();

  return (
    <div className="fu">
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:20,
        padding:"18px 22px",background:"#fff",borderRadius:14,
        border:`1.5px solid ${T.border}`,boxShadow:"0 2px 12px #00000008"}}>
        <div style={{width:48,height:48,borderRadius:12,background:T.accentL,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,flexShrink:0}}>✉</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"DM Sans",fontSize:19,fontWeight:700,color:T.ink}}>
            Email Tracking
          </div>
          <div style={{fontSize:14,color:T.sub,marginTop:2}}>
            Microsoft 365 inbox & sent mail · All contacts matched to KTA records
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <div style={{textAlign:"center",padding:"8px 14px",background:T.accentL,borderRadius:8}}>
            <div style={{fontSize:19,fontWeight:700,color:T.accent,fontFamily:"DM Sans"}}>{emails.length}</div>
            <div style={{fontSize:11,color:T.sub,fontWeight:700,textTransform:"uppercase"}}>Emails</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        <TabBtn id="inbox"   label="Inbox"         icon="↓"/>
        <TabBtn id="sent"    label="Sent"          icon="↑"/>
        <TabBtn id="capture" label="📧 Email Capture" icon=""/>
        <TabBtn id="setup"   label="⚙ Setup"        icon=""/>
      </div>

      {/* Setup tab */}
      {tab==="setup"&&(
        <div>
          <Card style={{marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:17,marginBottom:14}}>Microsoft 365 Connection</div>

            <div style={{background:T.accentL,border:`1px solid ${T.accent}33`,borderRadius:8,
              padding:"12px 16px",marginBottom:16,fontSize:14,color:T.ink,lineHeight:1.7}}>
              <strong>How it works:</strong> A Supabase Edge Function acts as a proxy between KTA and the Microsoft Graph API.
              It uses your M365 organisation credentials to read your inbox and sent mail, then returns emails matching any contact in the system.
              <br/><br/>
              <strong>Setup steps:</strong><br/>
              1. Register an app in <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer" style={{color:T.accent}}>Azure Active Directory</a> with <code>Mail.Read</code> and <code>Mail.Send</code> permissions<br/>
              2. Download and deploy the Edge Function below to Supabase<br/>
              3. Set the secrets: <code>MS_CLIENT_ID</code>, <code>MS_CLIENT_SECRET</code>, <code>MS_TENANT_ID</code>, <code>MS_REFRESH_TOKEN</code><br/>
              4. Paste your Edge Function URL here and save
            </div>

            <div style={{marginBottom:14}}>
              <FL>Supabase Edge Function URL</FL>
              <input value={proxyUrl} onChange={e=>setProxyUrl(e.target.value)}
                placeholder="https://your-project.supabase.co/functions/v1/email-proxy"/>
              <div style={{fontSize:12,color:T.muted,marginTop:3}}>
                The deployed email-proxy Edge Function URL
              </div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <Btn onClick={saveProxyUrl}>Save URL</Btn>
              {savedUrl&&<span style={{fontSize:13,color:T.teal,fontWeight:700}}>✓ Saved</span>}
              {proxyConfigured&&<Btn v="ghost" sm onClick={()=>loadEmails("inbox")}>Test Connection</Btn>}
            </div>
          </Card>

          <Card>
            <div style={{fontWeight:700,fontSize:17,marginBottom:12}}>📦 Supabase Edge Function</div>
            <div style={{fontSize:14,color:T.sub,marginBottom:14,lineHeight:1.6}}>
              Download and deploy this Edge Function to Supabase. It handles M365 OAuth token refresh and proxies Microsoft Graph API calls.
            </div>
            <Btn v="ghost" onClick={()=>{
              const code = `// KTA Email Proxy — Supabase Edge Function
// Deploy: supabase functions deploy email-proxy
// Secrets: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REFRESH_TOKEN

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const TOKEN_URL = (tenantId) =>
  \`https://login.microsoftonline.com/\${tenantId}/oauth2/v2.0/token\`;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function getAccessToken() {
  const tenantId     = Deno.env.get("MS_TENANT_ID")!;
  const clientId     = Deno.env.get("MS_CLIENT_ID")!;
  const clientSecret = Deno.env.get("MS_CLIENT_SECRET")!;
  const refreshToken = Deno.env.get("MS_REFRESH_TOKEN")!;

  const res = await fetch(TOKEN_URL(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/Mail.Read offline_access",
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed: " + await res.text());
  const data = await res.json();
  return data.access_token as string;
}

function formatEmail(msg: any, folder: string) {
  const from = msg.from?.emailAddress;
  const toList = msg.toRecipients?.map((r: any) => r.emailAddress?.address).join(", ");
  return {
    id:          msg.id,
    subject:     msg.subject,
    from:        from ? \`\${from.name} <\${from.address}>\` : "",
    to:          toList || "",
    date:        msg.receivedDateTime || msg.sentDateTime,
    bodyPreview: msg.bodyPreview,
    direction:   folder === "sentItems" ? "outbound" : "inbound",
    isRead:      msg.isRead,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const body = await req.json();
    const { action, emailAddress, folder = "inbox", maxResults = 50 } = body;
    const token = await getAccessToken();
    const headers = { Authorization: \`Bearer \${token}\` };

    if (action === "searchByAddress") {
      // Search both inbox and sent for this address
      const [inboundRes, outboundRes] = await Promise.all([
        fetch(\`\${GRAPH_BASE}/me/mailFolders/inbox/messages?\$filter=from/emailAddress/address eq '\${emailAddress}'&\$top=\${maxResults}&\$orderby=receivedDateTime desc\`, { headers }),
        fetch(\`\${GRAPH_BASE}/me/mailFolders/sentItems/messages?\$filter=toRecipients/any(r:r/emailAddress/address eq '\${emailAddress}')&\$top=\${maxResults}&\$orderby=sentDateTime desc\`, { headers }),
      ]);
      const [inbox, sent] = await Promise.all([inboundRes.json(), outboundRes.json()]);
      const emails = [
        ...(inbox.value||[]).map((m: any) => formatEmail(m, "inbox")),
        ...(sent.value||[]).map((m: any) => formatEmail(m, "sentItems")),
      ].sort((a, b) => b.date.localeCompare(a.date));
      return new Response(JSON.stringify({ ok: true, emails }), { headers: cors });
    }

    if (action === "listFolder") {
      const folderPath = folder === "sent" ? "sentItems" : "inbox";
      const res = await fetch(
        \`\${GRAPH_BASE}/me/mailFolders/\${folderPath}/messages?\$top=\${maxResults}&\$orderby=receivedDateTime desc\`,
        { headers }
      );
      const data = await res.json();
      const emails = (data.value||[]).map((m: any) => formatEmail(m, folderPath));
      return new Response(JSON.stringify({ ok: true, emails }), { headers: cors });
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

      {/* ── Email Capture Tab ─────────────────────────────────────────────── */}
      {tab==="capture"&&(
        <div>
          {/* Info banner */}
          <div style={{background:"#e6f7fd",border:"1.5px solid #1b7ab8",borderRadius:10,padding:"14px 18px",marginBottom:18,display:"flex",gap:12,alignItems:"flex-start"}}>
            <span style={{fontSize:24,flexShrink:0}}>📧</span>
            <div>
              <div style={{fontWeight:700,fontSize:15,color:"#1b4f8c",marginBottom:3}}>Automatic Email Capture</div>
              <div style={{fontSize:13,color:"#4a5a72",lineHeight:1.6}}>
                Monitors the Sent Items of each KTA staff mailbox and automatically logs emails to the CRM contact timeline.
                Staff can add <strong>[private]</strong> to any email subject to skip logging.
                Internal kta.org.nz → kta.org.nz emails are never captured.
              </div>
            </div>
          </div>

          {/* Edge function URL */}
          <Card style={{marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:10}}>⚙ Edge Function URL</div>
            <div style={{fontSize:13,color:T.sub,marginBottom:8}}>
              Deploy the <strong>graph-mail-capture</strong> edge function to Supabase, then paste its URL here.
            </div>
            <div style={{display:"flex",gap:8}}>
              <input placeholder="https://xxx.supabase.co/functions/v1/graph-mail-capture"
                value={captureUrl||getCaptureUrl()}
                onChange={e=>setCaptureUrl(e.target.value)}
                style={{flex:1,fontSize:13}}/>
              <Btn sm onClick={()=>{saveCaptureUrl(captureUrl);setCaptureMsg("✓ Saved");setTimeout(()=>setCaptureMsg(""),2000);}}>
                Save
              </Btn>
            </div>
            {captureMsg&&<div style={{fontSize:13,color:T.teal,marginTop:6,fontWeight:700}}>{captureMsg}</div>}
          </Card>

          {/* Monitored mailboxes */}
          <Card style={{marginBottom:16,padding:0,overflow:"hidden"}}>
            <div style={{padding:"14px 18px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontWeight:700,fontSize:15}}>👤 Monitored Mailboxes</div>
              <Btn sm onClick={loadCapture} disabled={captureLoading}>{captureLoading?"Loading…":"↺ Refresh"}</Btn>
            </div>
            <div style={{padding:"12px 18px"}}>
              {/* Add mailbox */}
              <div style={{display:"flex",gap:8,marginBottom:14}}>
                <select value={addingEmail} onChange={e=>setAddingEmail(e.target.value)} style={{flex:1,fontSize:13}}>
                  <option value="">— Select staff member to monitor —</option>
                  {allUsers.filter(u=>u.email&&u.email.toLowerCase().endsWith("@kta.org.nz")&&!captureSubs.some(s=>s.resource?.includes(u.email))).map(u=>(
                    <option key={u.id} value={u.email}>{u.name} ({u.email})</option>
                  ))}
                </select>
                <Btn sm onClick={async()=>{
                  if(!addingEmail){setCaptureMsg("Select a staff member first");return;}
                  const capUrl = getCaptureUrl()||captureUrl;
                  if(!capUrl){setCaptureMsg("Save the edge function URL first");return;}
                  setCaptureLoading(true);
                  try {
                    const res = await fetch(capUrl+"/manage-subscriptions",{
                      method:"POST",headers:{"Content-Type":"application/json"},
                      body:JSON.stringify({action:"create",userEmail:addingEmail,notificationUrl:capUrl})
                    });
                    const d = await res.json();
                    if(d.ok){ setCaptureMsg(`✓ Monitoring ${addingEmail}`); setAddingEmail(""); await loadCapture(); }
                    else setCaptureMsg("Error: "+(d.error||"Unknown"));
                  } catch(e){ setCaptureMsg("Error: "+e.message); }
                  setCaptureLoading(false);
                }}>+ Add</Btn>
                <Btn sm onClick={async()=>{
                  const capUrl = getCaptureUrl()||captureUrl;
                  if(!capUrl){setCaptureMsg("Save the edge function URL first");return;}
                  const unmonitored = allUsers.filter(u=>
                    u.email&&u.email.toLowerCase().endsWith("@kta.org.nz")&&
                    !captureSubs.some(s=>s.resource?.includes(u.email))
                  );
                  if(!unmonitored.length){setCaptureMsg("All KTA staff are already being monitored");return;}
                  setCaptureLoading(true);
                  let added=0, failed=0;
                  for(const u of unmonitored){
                    try{
                      const res = await fetch(capUrl+"/manage-subscriptions",{
                        method:"POST",headers:{"Content-Type":"application/json"},
                        body:JSON.stringify({action:"create",userEmail:u.email,notificationUrl:capUrl})
                      });
                      const d = await res.json();
                      if(d.ok) added++;
                      else { failed++; console.error("Failed:",u.email,d.error); }
                    }catch(e){ failed++; console.error("Error:",u.email,e.message); }
                  }
                  setCaptureMsg(`✓ Added ${added} mailbox${added!==1?"es":""} ${failed>0?`(${failed} failed — check console)`:"— all KTA staff now monitored"}`);
                  await loadCapture();
                  setCaptureLoading(false);
                }} style={{whiteSpace:"nowrap"}}>⚡ Add All KTA Staff</Btn>
              </div>

              {/* Active subscriptions */}
              {captureSubs.length===0
                ? <div style={{textAlign:"center",padding:"20px 0",color:T.muted,fontSize:13,fontStyle:"italic"}}>
                    No mailboxes being monitored yet
                  </div>
                : captureSubs.map(sub=>{
                    const expiresAt = sub.expirationDateTime ? new Date(sub.expirationDateTime) : null;
                    const daysLeft  = expiresAt ? Math.round((expiresAt-Date.now())/86400000) : null;
                    const expColor  = daysLeft!==null&&daysLeft<1 ? T.red : daysLeft<2 ? T.warn : T.teal;
                    return (
                      <div key={sub.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:`1px solid ${T.border}44`}}>
                        <div style={{width:36,height:36,borderRadius:"50%",background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>👤</div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontWeight:700,fontSize:14}}>{sub.clientState||sub.resource?.split("/")[1]||"Unknown"}</div>
                          <div style={{fontSize:12,color:T.muted,marginTop:1}}>
                            Sent Items · 
                            {daysLeft!==null
                              ? <span style={{color:expColor,fontWeight:700}}> Renews in {daysLeft}d</span>
                              : " Active"}
                          </div>
                        </div>
                        <div style={{display:"flex",gap:6}}>
                          <button onClick={async()=>{
                            const capUrl=getCaptureUrl()||captureUrl;
                            if(!capUrl) return;
                            await fetch(capUrl+"/manage-subscriptions",{
                              method:"POST",headers:{"Content-Type":"application/json"},
                              body:JSON.stringify({action:"delete",subscriptionId:sub.id})
                            });
                            await loadCapture();
                          }} style={{fontSize:12,padding:"4px 10px",borderRadius:6,cursor:"pointer",background:T.redL,color:T.red,border:`1px solid ${T.red}44`,fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })
              }

              {/* Renew all button */}
              {captureSubs.length>0&&(
                <div style={{marginTop:14,display:"flex",justifyContent:"flex-end"}}>
                  <Btn sm onClick={async()=>{
                    const capUrl=getCaptureUrl()||captureUrl;
                    if(!capUrl) return;
                    setCaptureLoading(true);
                    const res = await fetch(capUrl+"/manage-subscriptions",{
                      method:"POST",headers:{"Content-Type":"application/json"},
                      body:JSON.stringify({action:"renew-all"})
                    });
                    const d = await res.json();
                    setCaptureMsg(d.ok?`✓ Renewed ${d.results?.length||0} subscriptions`:"Renew failed");
                    await loadCapture();
                    setCaptureLoading(false);
                  }}>↺ Renew All Subscriptions</Btn>
                </div>
              )}
            </div>
          </Card>

          {/* Unknown contacts queue */}
          {captureUnknown.length>0&&(
            <Card style={{padding:0,overflow:"hidden",border:`1.5px solid ${T.warn}44`}}>
              <div style={{padding:"14px 18px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:32,height:32,borderRadius:8,background:T.warnL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>❓</div>
                <div>
                  <div style={{fontWeight:700,fontSize:15,color:T.warn}}>Unknown Email Addresses</div>
                  <div style={{fontSize:12,color:T.muted,marginTop:1}}>{captureUnknown.length} email{captureUnknown.length!==1?"s":""} sent to addresses not in CRM — add them or dismiss</div>
                </div>
              </div>
              {captureUnknown.map((u,i)=>(
                <div key={u.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 18px",
                  borderBottom:i<captureUnknown.length-1?`1px solid ${T.border}44`:"none",
                  background:i%2===0?T.surface:T.bg}}>
                  <div style={{width:36,height:36,borderRadius:"50%",background:T.warnL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>✉</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:14}}>{u.name||u.email}</div>
                    <div style={{fontSize:13,color:T.muted}}>{u.email}</div>
                    <div style={{fontSize:12,color:T.sub,marginTop:2}}>
                      Last email: <em>{u.last_subject||"(no subject)"}</em> · {u.encounter_count} email{u.encounter_count!==1?"s":""} captured
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6,flexShrink:0}}>
                    <button onClick={async()=>{
                      // Dismiss
                      await sb.from("unknown_email_contacts").update({dismissed:true}).eq("id",u.id);
                      setCaptureUnknown(prev=>prev.filter(x=>x.id!==u.id));
                    }} style={{fontSize:12,padding:"5px 10px",borderRadius:6,cursor:"pointer",
                      background:T.bg,color:T.muted,border:`1px solid ${T.border}`,
                      fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
                      Dismiss
                    </button>
                    <button onClick={()=>{
                      // Navigate to CRM Add Contact with email pre-filled
                      // Store pending contact in sessionStorage for CRM to pick up
                      try{ sessionStorage.setItem("kta_prefill_contact", JSON.stringify({
                        name: u.name||u.email, email: u.email, status:"Active"
                      })); }catch{}
                      // Also mark as dismissed so it doesn't keep appearing
                      sb.from("unknown_email_contacts").update({dismissed:true}).eq("id",u.id);
                      setCaptureUnknown(prev=>prev.filter(x=>x.id!==u.id));
                      // Navigate to CRM contacts tab
                      window.dispatchEvent(new CustomEvent("kta-navigate",{detail:{module:"crm",tab:"contacts",action:"add"}}));
                    }} style={{fontSize:12,padding:"5px 12px",borderRadius:6,cursor:"pointer",
                      background:T.accentL,color:T.accent,border:`1px solid ${T.accent}44`,
                      fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
                      + Add to CRM →
                    </button>
                  </div>
                </div>
              ))}
            </Card>
          )}
          {captureUnknown.length===0&&!captureLoading&&(
            <Card>
              <div style={{textAlign:"center",padding:"20px 0",color:T.teal,fontWeight:700,fontSize:14}}>
                ✓ No unknown contacts — all captured emails are matched to CRM records
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Inbox / Sent tabs */}
      {(tab==="inbox"||tab==="sent")&&(
        <div>
          {!proxyConfigured?(
            <Card>
              <div style={{textAlign:"center",padding:"32px 0",color:T.muted}}>
                <div style={{fontSize:35,marginBottom:12}}>✉</div>
                <div style={{fontWeight:700,fontSize:17,marginBottom:6}}>Email proxy not configured</div>
                <div style={{fontSize:14}}>Go to the Setup tab to connect Microsoft 365.</div>
              </div>
            </Card>
          ) : (
            <>
              {/* Search */}
              <div style={{marginBottom:12}}>
                <input value={search} onChange={e=>setSearch(e.target.value)}
                  placeholder="Search subject, sender, recipient…"
                  style={{width:"100%",boxSizing:"border-box"}}/>
              </div>

              {loading&&<div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontSize:14}}>Loading emails…</div>}
              {error&&<div style={{background:T.redL,border:`1px solid ${T.red}44`,borderRadius:8,padding:"10px 14px",fontSize:13,color:T.red,marginBottom:12}}>✕ {error}</div>}

              {!loading&&!error&&(
                <Card style={{padding:0,overflow:"hidden"}}>
                  {filtered.length===0
                    ? <div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontStyle:"italic",fontSize:14}}>No emails found</div>
                    : filtered.map((em,i)=>{
                        const isOpen = expanded[em.id];
                        const matched = matchPerson(em.from)||matchPerson(em.to);
                        return (
                          <div key={em.id} style={{borderBottom:i<filtered.length-1?`1px solid ${T.border}44`:"none"}}>
                            <div onClick={()=>setExpanded(x=>({...x,[em.id]:!x[em.id]}))}
                              style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
                                cursor:"pointer",background:isOpen?T.bg:em.isRead===false?"#f0f7ff":T.surface,
                                borderBottom:isOpen?`1px solid ${T.border}`:"none"}}>
                              {/* Unread dot */}
                              <div style={{width:7,height:7,borderRadius:"50%",flexShrink:0,
                                background:em.isRead===false?T.accent:"transparent",
                                border:`1.5px solid ${em.isRead===false?T.accent:T.border}`}}/>
                              <div style={{flex:1,minWidth:0}}>
                                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                                  <span style={{fontWeight:em.isRead===false?700:500,fontSize:14,color:T.ink,
                                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:300}}>
                                    {em.subject||"(no subject)"}
                                  </span>
                                  {matched&&(
                                    <RolePill role={matched.role} size="sm"/>
                                  )}
                                  <span style={{fontSize:12,padding:"1px 7px",borderRadius:4,fontWeight:700,
                                    background:em.direction==="outbound"?T.accentL:T.tealL,
                                    color:em.direction==="outbound"?T.accent:T.teal}}>
                                    {em.direction==="outbound"?"↑ Sent":"↓ Received"}
                                  </span>
                                </div>
                                <div style={{fontSize:12,color:T.sub,marginTop:2,
                                  overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                                  {em.direction==="outbound"?`To: ${em.to}`:`From: ${em.from}`}
                                </div>
                              </div>
                              <div style={{fontSize:12,color:T.muted,flexShrink:0,textAlign:"right"}}>
                                <div>{fmtTs(em.date)}</div>
                                {matched&&<div style={{fontSize:11,color:T.accent,marginTop:2}}>{matched.name}</div>}
                              </div>
                            </div>
                            {isOpen&&(
                              <div style={{padding:"14px 16px",background:"#fff",
                                borderTop:`1px solid ${T.border}`}}>
                                <div style={{display:"flex",gap:16,marginBottom:10,flexWrap:"wrap",fontSize:13,color:T.sub}}>
                                  <span><strong>From:</strong> {em.from}</span>
                                  <span><strong>To:</strong> {em.to}</span>
                                  <span><strong>Date:</strong> {new Date(em.date).toLocaleString("en-NZ")}</span>
                                </div>
                                <div style={{fontSize:14,color:T.ink,lineHeight:1.7,
                                  whiteSpace:"pre-wrap",padding:"10px 12px",
                                  background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>
                                  {em.bodyPreview||"(no preview)"}
                                </div>
                                {matched&&(
                                  <div style={{marginTop:10,fontSize:13,color:T.sub,fontStyle:"italic"}}>
                                    ↗ This email is linked to <strong style={{color:T.ink}}>{matched.name}</strong> ({matched.role}) and will appear in their activity timeline.
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                  }
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}


// ── Apprentice Dashboard ──────────────────────────────────────────────────────
// Card-grid home screen for apprentices. Each card either navigates to another
// module or expands inline to show a form / history section.

export { EmailActivityFeed, EmailsModule };
