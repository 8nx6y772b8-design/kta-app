import { useState, useEffect } from "react";
import { T } from "../constants.js";
import { fmtD, isConfOwner } from "../utils.js";
import { loadTable, upsertRow, deleteRow, sb } from "../supabaseClient.js";
import { Btn, Card, Avatar } from "../shared.jsx";

const BatSignal = ({size=18}) => (
  <svg width={size} height={Math.round(size*0.64)} viewBox="0 0 110 70" style={{display:"inline-block",verticalAlign:"middle",flexShrink:0}}>
    <ellipse cx="55" cy="35" rx="53" ry="32" fill="#000" stroke="#f5c500" strokeWidth="4"/>
    <path d="M55 12 C51 14 46 18 42 22 C36 17 27 15 18 18 C23 22 24 27 22 31 C17 28 11 29 8 33 C12 34 17 33 19 36 C17 41 18 47 21 50 C25 47 29 44 34 45 C37 49 39 54 42 56 C44 52 44 47 47 46 C49 50 49 54 51 56 C53 52 54 48 55 45 C56 48 57 52 59 56 C61 54 61 50 63 46 C66 47 66 52 68 56 C71 54 73 49 76 45 C81 44 85 47 89 50 C92 47 93 41 91 36 C93 33 98 34 102 33 C99 29 93 28 88 31 C86 27 87 22 92 18 C83 15 74 17 68 22 C64 18 59 14 55 12Z" fill="#f5c500"/>
    <ellipse cx="55" cy="36" rx="8" ry="7" fill="#000"/>
  </svg>
);

function NotificationBell({notifs, onRead, onReadAll, onDelete, canDelete=true, show, setShow, onReply}) {
  const unread = notifs.filter(n=>!n.read).length;
  const typeIcon = t => t==="licence_expiry"?"⚠":t==="approval"?"✓":t==="decline"?"✕":t==="broadcast"?<BatSignal size={15}/>:t==="reply"?"↩":"◈";
  const typeColor = t => t==="licence_expiry"?T.warn:t==="approval"?T.accent:t==="decline"?T.red:t==="broadcast"?T.blue:t==="reply"?T.teal:T.sub;
  const [replyId, setReplyId] = useState(null);
  const [replyText, setReplyText] = useState("");

  const handleReply = (n) => {
    if(!replyText.trim()) return;
    onReply(n, replyText.trim());
    setReplyText("");
    setReplyId(null);
  };

  return (
    <div style={{position:"relative"}}>
      <button onClick={()=>setShow(s=>!s)} style={{
        position:"relative",background:"none",border:"none",cursor:"pointer",
        color:"#ffffff99",fontSize:22,padding:"4px 8px",borderRadius:8,
        transition:"color .15s"}}
        onMouseEnter={e=>e.currentTarget.style.color="#fff"}
        onMouseLeave={e=>e.currentTarget.style.color="#ffffff99"}>
        🔔
        {unread>0&&(
          <span style={{position:"absolute",top:0,right:2,background:T.red,color:"#fff",
            borderRadius:99,fontSize:11,fontWeight:700,padding:"1px 5px",lineHeight:"14px",
            minWidth:16,textAlign:"center"}}>
            {unread>9?"9+":unread}
          </span>
        )}
      </button>
      {show&&(
        <div className="notif-dropdown" style={{position:"absolute",top:"calc(100% + 8px)",right:0,width:380,
          background:T.surface,borderRadius:12,boxShadow:"0 8px 32px #00000033",
          border:`1px solid ${T.border}`,zIndex:200,overflow:"hidden"}}>
          {/* Header */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
            padding:"12px 16px",borderBottom:`1px solid ${T.border}`,background:T.bg}}>
            <div style={{fontWeight:700,fontSize:14}}>Notifications {unread>0&&<span style={{color:T.red}}>({unread})</span>}</div>
            {unread>0&&(
              <button onClick={onReadAll} style={{fontSize:12,color:T.blue,background:"none",
                border:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
                Mark all read
              </button>
            )}
          </div>
          {/* List */}
          <div style={{maxHeight:"min(460px, 70vh)",overflowY:"auto"}}>
            {notifs.length===0&&(
              <div style={{padding:24,textAlign:"center",color:T.muted,fontSize:14}}>No notifications</div>
            )}
            {notifs.map(n=>(
              <div key={n.id} style={{borderBottom:`1px solid ${T.border}44`,
                background:n.read?T.surface:T.blueL+"55"}}>
                <div style={{padding:"12px 16px",display:"flex",gap:10,alignItems:"flex-start",cursor:"pointer"}}
                  onClick={()=>{ if(!n.read) onRead(n.id); }}>
                  <span style={{fontSize:18,marginTop:2,color:typeColor(n.type),flexShrink:0}}>{typeIcon(n.type)}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div className="notif-title" style={{fontWeight:n.read?500:700,fontSize:14,color:typeColor(n.type),
                      wordBreak:"break-word",lineHeight:1.35}}>{n.title}</div>
                    <div className="notif-msg" style={{fontSize:13,color:T.sub,marginTop:3,lineHeight:1.5,
                      wordBreak:"break-word",whiteSpace:"pre-wrap"}}>{n.message}</div>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:6,flexWrap:"wrap",gap:4}}>
                      <div style={{fontSize:11,color:T.muted}}>
                        {n.created_at ? new Date(n.created_at).toLocaleString("en-AU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "Just now"}
                      </div>
                      {n.created_by&&n.type!=="reply"&&(
                        <button onClick={e=>{e.stopPropagation();setReplyId(replyId===n.id?null:n.id);setReplyText("");}}
                          style={{fontSize:12,color:T.teal,background:replyId===n.id?T.tealL:"none",border:"none",cursor:"pointer",
                            fontFamily:"DM Sans,sans-serif",fontWeight:700,padding:"2px 6px",borderRadius:4}}>
                          ↩ Reply
                        </button>
                      )}
                    </div>
                  </div>
                  {canDelete&&(
                    <button onClick={e=>{e.stopPropagation();onDelete(n.id);setReplyId(null);}} style={{
                      background:"none",border:"none",color:T.muted,cursor:"pointer",
                      fontSize:16,padding:"0 2px",flexShrink:0,marginLeft:2}}
                      onMouseEnter={e=>e.currentTarget.style.color=T.red}
                      onMouseLeave={e=>e.currentTarget.style.color=T.muted}>✕</button>
                  )}
                </div>
                {replyId===n.id&&(
                  <div style={{padding:"0 12px 12px 12px"}}>
                    <textarea
                      placeholder="Write a reply…"
                      value={replyText}
                      onChange={e=>setReplyText(e.target.value)}
                      rows={2}
                      style={{width:"100%",fontSize:14,padding:"8px 10px",borderRadius:7,
                        border:`1.5px solid ${T.teal}66`,fontFamily:"DM Sans,sans-serif",
                        background:T.bg,resize:"none",outline:"none",color:T.ink,boxSizing:"border-box"}}
                      onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleReply(n);}}}
                      autoFocus
                    />
                    <div style={{display:"flex",gap:6,marginTop:6}}>
                      <button onClick={()=>handleReply(n)} disabled={!replyText.trim()} style={{
                        fontSize:13,fontWeight:700,padding:"6px 14px",borderRadius:6,
                        background:replyText.trim()?T.teal:"#ccc",color:"#fff",border:"none",
                        cursor:replyText.trim()?"pointer":"default",fontFamily:"DM Sans,sans-serif"}}>
                        Send Reply
                      </button>
                      <button onClick={()=>setReplyId(null)} style={{
                        fontSize:13,padding:"6px 10px",borderRadius:6,background:"none",
                        border:`1px solid ${T.border}`,color:T.sub,cursor:"pointer",
                        fontFamily:"DM Sans,sans-serif"}}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE REQUESTS
// ─────────────────────────────────────────────────────────────────────────────

const LEAVE_TYPES = ["Annual Leave","Sick Leave","Leave Without Pay","Bereavement Leave","Other"];

const LEAVE_STATUS_META = {
  pending:           { label:"Pending Approver Review",    color:"#b86e1a", bg:"#faebd7", sym:"⏳", step:1, steps:3 },
  approver_approved: { label:"Approved — Awaiting KTA",   color:"#1a8a7a", bg:"#d4f0ec", sym:"✓", step:2, steps:3 },
  kta_approved:      { label:"Fully Approved by KTA",     color:"#1b4f8c", bg:"#dce8f7", sym:"★", step:3, steps:3 },
  declined:          { label:"Declined",                  color:"#bf2b2b", bg:"#fde8e8", sym:"✕", step:0, steps:3 },
};

// Progress stepper for leave requests — shown in all views
function PinPromptModal({ title, onConfirm, onCancel }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    if(pin.length !== 4) { setErr("Enter your 4-digit PIN"); return; }
    setChecking(true);
    const h = await sha256hex(pin);
    if(h === CONF_PIN_HASH) {
      onConfirm();
    } else {
      setErr("Incorrect PIN");
      setPin("");
    }
    setChecking(false);
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:T.surface,borderRadius:16,padding:"28px 28px 24px",maxWidth:320,width:"100%",border:`1.5px solid ${T.border}`,boxShadow:"0 8px 32px rgba(0,0,0,.18)"}}>
        <div style={{fontWeight:700,fontSize:18,marginBottom:6}}>🔒 {title}</div>
        <div style={{fontSize:14,color:T.sub,marginBottom:18}}>Enter your 4-digit PIN to continue.</div>
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          placeholder="····"
          value={pin}
          onChange={e=>{ setPin(e.target.value.replace(/\D/g,"")); setErr(""); }}
          onKeyDown={e=>e.key==="Enter"&&submit()}
          autoFocus
          style={{textAlign:"center",fontSize:31,letterSpacing:12,marginBottom:8,width:"100%"}}
        />
        {err&&<div style={{color:T.red,fontSize:13,marginBottom:8,textAlign:"center"}}>{err}</div>}
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <button onClick={onCancel} style={{flex:1,padding:"10px",borderRadius:8,border:`1.5px solid ${T.border}`,background:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontSize:14}}>Cancel</button>
          <button onClick={submit} disabled={checking} style={{flex:1,padding:"10px",borderRadius:8,border:"none",background:T.accent,color:"#fff",cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontSize:14,fontWeight:700}}>
            {checking?"…":"Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENTIAL NOTES CARD — only rendered for Kristeena (kristeena@kta.org.nz)
// Wraps EmailActivityFeed with PIN-lock enabled and pre-scoped to her own account
// ─────────────────────────────────────────────────────────────────────────────
function ConfidentialNotesCard({ currentUser, allUsers }) {
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: T.accentL, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 18,
        }}>🔒</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Confidential Notes</div>
          <div style={{ fontSize: 12, color: T.sub }}>Private notes — PIN-lockable, visible only to you</div>
        </div>
      </div>
      <EmailActivityFeed
        personEmail={currentUser.email}
        personName={currentUser.name}
        personId={currentUser.id}
        canEdit={true}
        isKristeena={true}
        isAdmin1={Number(currentUser?.adminLevel ?? 1)===1&&currentUser?.role==="Admin"}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BROADCAST COMPOSER — Admin + Mentor send messages to users
// ─────────────────────────────────────────────────────────────────────────────
function BroadcastComposer({users, currentUser, onSend, onClose}) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState("everyone");  // everyone | role:X | user:id
  const [sending, setSending] = useState(false);

  const roleOptions = ["Apprentice","Approver","Viewer","Mentor","Admin"];

  const getRecipients = () => {
    if(target==="everyone") return users.filter(u=>u.id!==currentUser.id).map(u=>u.id);
    if(target.startsWith("role:")) return users.filter(u=>u.role===target.slice(5)&&u.id!==currentUser.id).map(u=>u.id);
    if(target.startsWith("user:")) return [target.slice(5)];
    return [];
  };

  const send = async () => {
    if(!title.trim()||!message.trim()) return;
    setSending(true);
    const recipients = getRecipients();
    await onSend(recipients, "broadcast", title.trim(), message.trim(), currentUser.id, {});
    setSending(false);
    onClose();
  };

  const recipCount = getRecipients().length;

  return (
    <div style={{position:"fixed",inset:0,background:"#00000066",zIndex:300,
      display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
      <Card style={{width:"100%",maxWidth:480,padding:28}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div style={{fontFamily:"DM Sans",fontSize:19,fontWeight:700}}><span style={{display:"flex",alignItems:"center",gap:8}}><BatSignal size={22}/> Contact Via App</span></div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:22,
            color:T.muted,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{marginBottom:14}}>
          <FL>Send to</FL>
          <select value={target} onChange={e=>setTarget(e.target.value)}>
            <option value="everyone">Everyone ({users.filter(u=>u.id!==currentUser.id).length} users)</option>
            {roleOptions.map(r=>{
              const count=users.filter(u=>u.role===r&&u.id!==currentUser.id).length;
              return count>0?<option key={r} value={`role:${r}`}>All {r}s ({count})</option>:null;
            })}
            <optgroup label="Individual">
              {users.filter(u=>u.id!==currentUser.id).map(u=>(
                <option key={u.id} value={`user:${u.id}`}>{u.name} ({u.role})</option>
              ))}
            </optgroup>
          </select>
          <div style={{fontSize:12,color:T.muted,marginTop:4}}>
            Will notify {recipCount} recipient{recipCount!==1?"s":""}
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <FL req>Title</FL>
          <input placeholder="e.g. Site closure Friday" value={title} onChange={e=>setTitle(e.target.value)} maxLength={80}/>
        </div>
        <div style={{marginBottom:20}}>
          <FL req>Message</FL>
          <textarea placeholder="Write your message here…" value={message} onChange={e=>setMessage(e.target.value)}
            rows={4} style={{width:"100%",resize:"vertical",padding:"9px 12px",
              border:`1.5px solid ${T.border}`,borderRadius:8,fontFamily:"DM Sans,sans-serif",
              fontSize:14,background:T.bg,color:T.ink,boxSizing:"border-box"}}/>
        </div>
        <div style={{display:"flex",gap:8}}>
          <Btn onClick={send} disabled={sending||!title.trim()||!message.trim()}>
            {sending?"Sending…":<><BatSignal size={14} color="#fff"/> Contact Via App</>}
          </Btn>
          <Btn v="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APPRENTICE CONVERSATION HISTORY
// ─────────────────────────────────────────────────────────────────────────────

export { NotificationBell, PinPromptModal, ConfidentialNotesCard, BroadcastComposer };
