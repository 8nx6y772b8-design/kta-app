import { useState, useEffect } from "react";
import { T } from "../constants.js";
import { uid, fmtD } from "../utils.js";
import { insertMessage, loadMessages, deleteMessage } from "../supabaseClient.js";
import { Avatar, Btn, Card } from "../shared.jsx";
import { ktaConfirm } from "./LeaveResultScreen.jsx";

function ApprenticeConversation({apprentice, allUsers, currentUser, canManageMessages=false, onNotify}) {
  const [messages, setMessages] = useState([]);
  const [msgText, setMsgText]   = useState("");
  const [sending, setSending]   = useState(false);
  const [loadErr, setLoadErr]   = useState(null);
  const [hoverMsg, setHoverMsg] = useState(null);

  // Load messages whenever the apprentice changes
  useEffect(()=>{
    if(!apprentice?.id) return;
    setMessages([]);
    setLoadErr(null);
    loadMessages(apprentice.id)
      .then(setMessages)
      .catch(e=>setLoadErr(e.message));
  },[apprentice?.id]);

  const handleSend = async () => {
    if(!msgText.trim()||!currentUser) return;
    setSending(true);
    const msg = {
      id: uid(),
      apprentice_id: apprentice.id,
      sender_id: currentUser.id,
      body: msgText.trim(),
      created_at: new Date().toISOString(),
    };
    try {
      await insertMessage(msg);
      setMessages(prev=>[...prev, msg]);
      setMsgText("");
      if(onNotify) {
        await onNotify(
          [apprentice.id],
          "broadcast",
          `💬 Message from ${currentUser.name}`,
          msgText.trim(),
          currentUser.id,
          { messageId: msg.id }
        );
      }
    } catch(e) {
      alert("Failed to send: "+e.message);
    }
    setSending(false);
  };

  const handleDelete = async (msgId) => {
    if(!await ktaConfirm("Permanently delete this message?")) return;
    await deleteMessage(msgId).catch(console.error);
    setMessages(prev=>prev.filter(m=>m.id!==msgId));
  };

  // Group messages by date
  const grouped = {};
  messages.forEach(m=>{
    const day = m.created_at ? m.created_at.slice(0,10) : "unknown";
    if(!grouped[day]) grouped[day]=[];
    grouped[day].push(m);
  });

  const fmtDay = (iso) => {
    if(iso==="unknown") return "Unknown date";
    const [y,m,d] = iso.split('-');
    return new Date(Date.UTC(+y,+m-1,+d)).toLocaleDateString("en-NZ",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
  };
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString("en-NZ",{hour:"2-digit",minute:"2-digit"}) : "";
  const getSender = (m) => allUsers.find(u=>u.id===m.sender_id);
  const isFromApprentice = (m) => m.sender_id === apprentice.id;

  return (
    <Card style={{marginTop:20,border:`1.5px solid ${T.border}`}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <div style={{width:34,height:34,borderRadius:10,background:T.accentL,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>💬</div>
        <div>
          <div style={{fontWeight:700,fontSize:16}}>Conversation</div>
          <div style={{fontSize:13,color:T.sub}}>
            Permanent message history with {apprentice.name}
            {canManageMessages&&<span style={{marginLeft:8,fontSize:12,color:T.muted}}>(hover a message to delete)</span>}
          </div>
        </div>
      </div>

      {loadErr&&<div style={{fontSize:13,color:T.red,marginBottom:12}}>⚠ Could not load messages: {loadErr}</div>}

      {Object.keys(grouped).length===0&&!loadErr&&(
        <div style={{padding:"24px 0",textAlign:"center",color:T.muted,fontSize:14,fontStyle:"italic"}}>
          No messages yet
        </div>
      )}

      {Object.entries(grouped).map(([day, dayMsgs])=>(
        <div key={day} style={{marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{flex:1,height:1,background:T.border}}/>
            <div style={{fontSize:12,color:T.muted,fontWeight:700,whiteSpace:"nowrap"}}>{fmtDay(day)}</div>
            <div style={{flex:1,height:1,background:T.border}}/>
          </div>
          {dayMsgs.map(m=>{
            const fromApp = isFromApprentice(m);
            const sender  = getSender(m);
            return (
              <div key={m.id}
                onMouseEnter={()=>setHoverMsg(m.id)}
                onMouseLeave={()=>setHoverMsg(null)}
                style={{display:"flex",flexDirection:"column",
                  alignItems:fromApp?"flex-start":"flex-end",marginBottom:8,position:"relative"}}>
                <div style={{maxWidth:"80%",padding:"9px 13px",
                  borderRadius:fromApp?"4px 12px 12px 12px":"12px 4px 12px 12px",
                  background:fromApp?T.bg:T.accentL,
                  border:`1px solid ${fromApp?T.border:T.accent+"44"}`,position:"relative"}}>
                  <div style={{fontSize:13,color:T.ink,lineHeight:1.5,wordBreak:"break-word"}}>{m.body}</div>
                  {/* Delete button — Admin 1 only, shown on hover */}
                  {canManageMessages&&hoverMsg===m.id&&(
                    <button onClick={()=>handleDelete(m.id)} title="Delete message" style={{
                      position:"absolute",top:-8,right:-8,width:20,height:20,borderRadius:"50%",
                      background:T.red,color:"#fff",border:"none",cursor:"pointer",
                      fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",
                      lineHeight:1,fontWeight:700}}>✕</button>
                  )}
                </div>
                <div style={{fontSize:11,color:T.muted,marginTop:3,display:"flex",gap:6}}>
                  <span>{sender?.name||"Unknown"}</span>
                  {m.created_at&&<span>· {fmtTime(m.created_at)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {/* Reply box */}
      <div style={{borderTop:`1px solid ${T.border}`,paddingTop:12,marginTop:4}}>
        <textarea
          placeholder={`Message ${apprentice.name}…`}
          value={msgText}
          onChange={e=>setMsgText(e.target.value)}
          rows={2}
          style={{width:"100%",fontSize:14,padding:"9px 12px",borderRadius:8,
            border:`1.5px solid ${T.border}`,fontFamily:"DM Sans,sans-serif",
            background:T.surface,resize:"none",color:T.ink,outline:"none",boxSizing:"border-box"}}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleSend();}}}
        />
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <Btn onClick={handleSend} disabled={sending||!msgText.trim()}>
            {sending?"Sending…":"Send"}
          </Btn>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// XERO INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

// Xero Payroll NZ earnings rate IDs — these must be configured per organisation
// Admins set their own IDs in the Xero module settings
const XERO_DEFAULT_RATES = {
  "Normal Hours":   null,
  "Annual Leave":   null,
  "Sick Leave":     null,
  "Public Holiday": null,
  "Overtime":       null,
  "Block Course":   null,
  "Other":          null,
};

// Submit a single approved entry to Xero via a Supabase Edge Function proxy
// The edge function handles OAuth token management and CORS
// Calculate overtime split for an entry given apprentice settings + all entries this week
const calcOvertimeSplit = (entry, apprentice, allEntries, displayOnly=false) => {
  const { overtimeType, overtimeThreshold, overtimeRateId } = apprentice;
  // For display purposes we don't need a rateId — only Xero submission does
  if(!overtimeType || !overtimeThreshold || (!displayOnly && !overtimeRateId) || entry.type !== "Normal Hours") {
    return [{ hours: entry.netHours, isOvertime: false }];
  }

  if(overtimeType === "daily") {
    const threshold = parseFloat(overtimeThreshold);
    const normal = Math.min(entry.netHours, threshold);
    const overtime = Math.max(0, entry.netHours - threshold);
    const splits = [{ hours: normal, isOvertime: false }];
    if(overtime > 0) splits.push({ hours: overtime, isOvertime: true });
    return splits;
  }

  if(overtimeType === "weekly") {
    const threshold = parseFloat(overtimeThreshold);
    // Get Mon of entry's week
    const d = new Date(entry.date + "T00:00:00");
    const day = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const monStr = mon.toISOString().slice(0,10);
    const sunStr = sun.toISOString().slice(0,10);

    // Sum all approved/submitted entries this week for this apprentice BEFORE this entry
    const weekEntries = allEntries.filter(e =>
      e.userId === apprentice.id &&
      e.date >= monStr && e.date <= sunStr &&
      e.date < entry.date && // entries before this one
      (e.approval === "approved" || e.xeroStatus === "submitted")
    );
    const hoursBeforeThis = weekEntries.reduce((s, e) => s + e.netHours, 0);
    const hoursAfterThreshold = Math.max(0, hoursBeforeThis - threshold);
    const remainingNormal = Math.max(0, threshold - hoursBeforeThis);

    if(hoursAfterThreshold >= entry.netHours) {
      // Entirely overtime
      return [{ hours: entry.netHours, isOvertime: true }];
    }
    const normal = Math.min(entry.netHours, remainingNormal);
    const overtime = Math.max(0, entry.netHours - normal);
    const splits = [];
    if(normal > 0)   splits.push({ hours: normal,   isOvertime: false });
    if(overtime > 0) splits.push({ hours: overtime, isOvertime: true  });
    return splits;
  }

  return [{ hours: entry.netHours, isOvertime: false }];
};

const submitEntryToXero = async (entry, apprentice, allEntries=[]) => {
  let xeroSettings = {};
  try {
    const {data} = await sb.from("app_settings").select("value").eq("key","xero_settings").single();
    if(data?.value) xeroSettings = JSON.parse(data.value);
  } catch {}
  const { edgeFunctionUrl, tenantId, earningsRates = {} } = xeroSettings;

  if(!edgeFunctionUrl) return { ok: false, error: "Xero not configured. Set up in the Xero module." };
  if(!tenantId)         return { ok: false, error: "Xero Tenant ID not configured." };
  if(!apprentice.xeroEmployeeId) return { ok: false, error: `No Xero Employee ID for ${apprentice.name}` };

  const mappedValue = earningsRates[entry.type]; // e.g. "rate:abc123" or "leave:def456" or bare ID
  if(!mappedValue) return { ok: false, error: `No Xero rate/leave type mapped for "${entry.type}"` };

  const isLeaveMapping = mappedValue.startsWith("leave:");
  const mappedId = mappedValue.startsWith("rate:") || mappedValue.startsWith("leave:")
    ? mappedValue.split(":")[1]
    : mappedValue; // bare ID (legacy)

  // Calculate overtime split
  const splits = calcOvertimeSplit(entry, apprentice, allEntries);
  const lines = splits.map(s => ({
    earningsRateId: s.isOvertime ? apprentice.overtimeRateId : (isLeaveMapping ? null : mappedId),
    leaveTypeId:    (!s.isOvertime && isLeaveMapping) ? mappedId : null,
    hours: s.hours,
    isOvertime: s.isOvertime,
  }));

  // Tool allowance: submit total hours as numberOfUnits — Xero multiplies by $0.50/hr rate
  const totalHours = lines.reduce((s, l) => s + l.hours, 0);
  const toolAllowanceId    = xeroSettings.toolAllowanceReimbursementId || null;
  const toolAllowanceHours = toolAllowanceId ? totalHours : 0;

  const payload = {
    action:      "upsertTimesheet",
    tenantId,
    employeeId:  apprentice.xeroEmployeeId,
    date:        entry.date,
    lines,
    note:        entry.note || "",
    toolAllowanceId,
    toolAllowanceHours,
  };

  try {
    const res = await fetch(edgeFunctionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if(!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, timesheetId: data.timesheetId };
  } catch(e) {
    return { ok: false, error: e.message };
  }
};

// ── Xero Module — Admin 1 only ────────────────────────────────────────────────

export default ApprenticeConversation;
