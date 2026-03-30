import { useState, useEffect } from "react";
import { T } from "../constants.js";
import { uid, fmtD, sendKTAEmail, leaveActionUrl } from "../utils.js";
import { upsertRow, updateRow, deleteRow, loadTable } from "../supabaseClient.js";
import { Pill, Btn, Card } from "../shared.jsx";

const LeaveStatusStepper = ({ status }) => {
  const steps = [
    { key:"pending",           label:"Submitted",       sym:"📤" },
    { key:"approver_approved", label:"Approver OK",     sym:"✓"  },
    { key:"kta_approved",      label:"KTA Approved",    sym:"★"  },
  ];
  const declined = status === "declined";
  const currentStep = status==="pending" ? 0 : status==="approver_approved" ? 1 : status==="kta_approved" ? 2 : -1;
  return (
    <div style={{display:"flex",alignItems:"center",gap:0,margin:"8px 0 4px"}}>
      {steps.map((s, i) => {
        const done    = !declined && currentStep >= i;
        const current = !declined && currentStep === i;
        const pending_ahead = !declined && currentStep < i;
        const color   = done ? "#1a8a7a" : pending_ahead ? "#e05c5c" : "#d0daea";
        const textCol = done ? "#fff" : "#aaa";
        return (
          <div key={s.key} style={{display:"flex",alignItems:"center",flex:1,minWidth:0}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",flex:1}}>
              <div style={{width:26,height:26,borderRadius:"50%",
                background: declined && i===0 ? "#fde8e8" : done ? color : pending_ahead ? "#fff0f0" : "#f0f4f9",
                border:`2px solid ${declined&&i===0?"#bf2b2b":done?color:pending_ahead?"#e05c5c":"#d0daea"}`,
                display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:12,fontWeight:700,color:declined&&i===0?"#bf2b2b":pending_ahead?"#e05c5c":textCol,
                boxShadow:current?"0 0 0 3px "+color+"33":"none",
                transition:"all .2s",
              }}>
                {declined && i===0 ? "✕" : done ? (i===currentStep ? s.sym : "✓") : i+1}
              </div>
              <div style={{fontSize:10,color:done?color:pending_ahead?"#e05c5c":"#aaa",marginTop:3,textAlign:"center",fontWeight:done?700:400,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:64}}>
                {declined && i===0 ? "Declined" : s.label}
              </div>
            </div>
            {i < steps.length-1 && (
              <div style={{height:2,flex:1,background:!declined&&currentStep>i?color:(!declined&&currentStep>=0?"#e05c5c":"#e5e7eb"),margin:"0 2px",marginBottom:16,transition:"background .3s"}}/>
            )}
          </div>
        );
      })}
    </div>
  );
};

const sendLeaveEmail = async ({ to, toName, subject, html }) => {
  // Throws on failure — callers should catch individually
  // Leave emails are always sent from leaverequests@kta.org.nz
  await sendKTAEmail({ to, subject, html, from: "leaverequests@kta.org.nz" });
};

const leaveEmailHtml = (title, body) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f0f4f9;padding:24px">
  <div style="background:#1b4f8c;borderRadius:10px;padding:18px 24px;margin-bottom:0;border-radius:10px 10px 0 0">
    <div style="color:#fff;font-size:19.8px;font-weight:700">KTA Leave Request</div>
    <div style="color:#dce8f7;font-size:13.2px;margin-top:4px">Kiwi Trade Apprentices</div>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 10px 10px;border:1px solid #d0daea">
    <p style="font-size:16.5px;color:#0d1b2e;margin-top:0">${title}</p>
    ${body}
    <hr style="border:none;border-top:1px solid #d0daea;margin:20px 0">
    <p style="font-size:12.1px;color:#8fa0b8">KTA Workforce Management · leaverequests@kta.org.nz</p>
  </div>
</div>`;

const leaveDetailTable = (req, apprenticeName, approverName) => `
<table style="width:100%;border-collapse:collapse;font-size:14.3px;margin:16px 0">
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700;width:40%">Apprentice</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${apprenticeName}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">Leave Type</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${req.leave_type}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">From</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${fmtDateNZ(req.date_from)}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">To</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${fmtDateNZ(req.date_to)}</td></tr>
  <tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">Approver</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${approverName}</td></tr>
  ${req.notes ? `<tr><td style="padding:8px 12px;background:#f0f4f9;font-weight:700">Notes</td><td style="padding:8px 12px">${req.notes}</td></tr>` : ""}
</table>`;

// Async — call with await, embed result in email HTML
const leaveActionButtons = async (leaveId, actorId, actorRole) => {
  const appUrl = await leaveActionUrl(leaveId, "approve", actorId, actorRole);
  const decUrl = await leaveActionUrl(leaveId, "decline", actorId, actorRole);
  return `
<div style="margin:24px 0;display:flex;gap:12px;flex-wrap:wrap">
  <a href="${appUrl}" style="display:inline-block;background:#1a8a7a;color:#fff;border-radius:8px;padding:12px 28px;font-size:15.4px;font-weight:700;text-decoration:none;font-family:DM Sans,Arial,sans-serif">✓ Approve Leave</a>
  <a href="${decUrl}" style="display:inline-block;background:#bf2b2b;color:#fff;border-radius:8px;padding:12px 28px;font-size:15.4px;font-weight:700;text-decoration:none;font-family:DM Sans,Arial,sans-serif">✕ Decline Leave</a>
</div>
<p style="font-size:12.1px;color:#8fa0b8;margin-top:4px">These buttons record your response immediately — no login required. Links expire in 7 days.</p>`;
};

const fmtDateNZ = (iso) => {
  if(!iso) return "—";
  const [y,m,d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

// ── Leave Application Form (Apprentice) ──────────────────────────────────────
function LeaveRequestForm({ currentUser, allUsers, onSubmitted, defaultLeaveType="Annual Leave" }) {
  const approver = allUsers.find(u =>
    u.id === currentUser.approverUserId ||
    (u.role === "Approver" && (u.allocatedTo||[]).includes(currentUser.id))
  );
  const [form, setForm] = useState({
    dateFrom: "", dateTo: "", leaveType: defaultLeaveType, notes: "",
  });
  const [saving, setSaving]   = useState(false);
  const [done, setDone]       = useState(false);
  const [error, setError]     = useState("");
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));


  const handleSubmit = async () => {
    if(!form.dateFrom || !form.dateTo) { setError("Please select start and end dates."); return; }
    if(form.dateTo < form.dateFrom)    { setError("End date must be after start date."); return; }
    setError(""); setSaving(true);
    const req = {
      id: uid(),
      apprentice_id:  currentUser.id,
      approver_id:    approver?.id || null,
      date_from:      form.dateFrom,
      date_to:        form.dateTo,
      leave_type:     form.leaveType,
      notes:          form.notes.trim(),
      status:         "pending",
      created_at:     new Date().toISOString(),
    };

    try {
      // 1. Save to database first — this must succeed
      await upsertRow("leave_requests", req);
    } catch(e) {
      setError("Could not save your request. Please check your connection and try again.");
      setSaving(false);
      return;
    }

    // 2. Send emails — failures are logged but do NOT block the submission
    let emailWarning = "";

    // Email to approver (with one-click approve/decline buttons)
    if(approver?.email) {
      try {
        const buttons = await leaveActionButtons(req.id, approver.id, "approver");
        await sendLeaveEmail({
          to: approver.email,
          subject: `Leave Request — ${currentUser.name} (${form.leaveType})`,
          html: leaveEmailHtml(
            `<strong>${currentUser.name}</strong> has submitted a leave request requiring your approval.`,
            leaveDetailTable(req, currentUser.name, approver.name) + buttons
          ),
        });
      } catch(e) {
        console.error("Approver email failed:", e);
        emailWarning = `Request saved, but the notification email to ${approver.name} could not be sent. Please let them know directly.`;
      }
    }

    // Confirmation email to apprentice
    if(currentUser.email) {
      try {
        await sendLeaveEmail({
          to: currentUser.email,
          subject: `Leave Request Submitted — ${form.leaveType}`,
          html: leaveEmailHtml(
            `Your leave request has been submitted and is awaiting approval from <strong>${approver?.name || "your approver"}</strong>.`,
            leaveDetailTable(req, currentUser.name, approver?.name || "Not assigned")
          ),
        });
      } catch(e) {
        console.error("Apprentice confirmation email failed:", e);
      }
    }

    setSaving(false);
    if(emailWarning) setError(emailWarning);
    setDone(true);
    setTimeout(() => onSubmitted(req), emailWarning ? 3000 : 1500);
  };

  if(done) return (
    <div style={{textAlign:"center",padding:"32px 16px"}}>
      <div style={{fontSize:40,marginBottom:12}}>✅</div>
      <div style={{fontWeight:700,fontSize:18,color:T.teal}}>Leave request submitted!</div>
      <div style={{fontSize:14,color:T.sub,marginTop:6}}>
        {approver?.email ? `An email has been sent to ${approver.name}.` : "No approver email found — please notify your approver directly."}
      </div>
    </div>
  );

  return (
    <div>
      {/* Read-only info */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
        <div style={{background:T.bg,borderRadius:8,padding:"10px 14px"}}>
          <div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:3}}>Apprentice</div>
          <div style={{fontWeight:700,fontSize:16,color:T.ink}}>{currentUser.name}</div>
        </div>
        <div style={{background:T.bg,borderRadius:8,padding:"10px 14px"}}>
          <div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:3}}>Approver</div>
          <div style={{fontWeight:700,fontSize:16,color:approver?T.ink:T.warn}}>
            {approver ? approver.name : "⚠ No approver assigned"}
          </div>
        </div>
      </div>

      {/* Dates */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <div>
          <label style={{fontSize:13,fontWeight:700,color:T.sub,display:"block",marginBottom:5}}>Leave Starting *</label>
          <input type="date" value={form.dateFrom} onChange={e=>sf("dateFrom",e.target.value)}
            style={{width:"100%",border:`1.5px solid ${T.border}`,borderRadius:8,padding:"9px 12px",fontSize:14,fontFamily:"DM Sans,sans-serif",color:T.ink,outline:"none",boxSizing:"border-box"}}/>
        </div>
        <div>
          <label style={{fontSize:13,fontWeight:700,color:T.sub,display:"block",marginBottom:5}}>Leave Finishing *</label>
          <input type="date" value={form.dateTo} onChange={e=>sf("dateTo",e.target.value)}
            style={{width:"100%",border:`1.5px solid ${T.border}`,borderRadius:8,padding:"9px 12px",fontSize:14,fontFamily:"DM Sans,sans-serif",color:T.ink,outline:"none",boxSizing:"border-box"}}/>
        </div>
      </div>

      {/* Leave type */}
      <div style={{marginBottom:14}}>
        <label style={{fontSize:13,fontWeight:700,color:T.sub,display:"block",marginBottom:5}}>Type of Leave *</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
          {LEAVE_TYPES.map(t=>(
            <button key={t} onClick={()=>sf("leaveType",t)}
              style={{padding:"7px 14px",borderRadius:8,border:`1.5px solid ${form.leaveType===t?T.accent:T.border}`,
                background:form.leaveType===t?T.accentL:T.surface,
                color:form.leaveType===t?T.accent:T.ink,
                fontWeight:form.leaveType===t?700:400,
                fontSize:13,cursor:"pointer",fontFamily:"DM Sans,sans-serif",transition:"all .12s"}}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Notes */}
      <div style={{marginBottom:16}}>
        <label style={{fontSize:13,fontWeight:700,color:T.sub,display:"block",marginBottom:5}}>Additional Notes</label>
        <textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} rows={3}
          placeholder="Any additional details about your leave request…"
          style={{width:"100%",border:`1.5px solid ${T.border}`,borderRadius:8,padding:"9px 12px",fontSize:14,fontFamily:"DM Sans,sans-serif",color:T.ink,outline:"none",resize:"vertical",boxSizing:"border-box",lineHeight:1.6}}/>
      </div>

      {error && <div style={{background:T.redL,border:`1px solid ${T.red}33`,borderRadius:7,padding:"8px 12px",fontSize:13,color:T.red,marginBottom:12}}>{error}</div>}

      <div style={{display:"flex",gap:8}}>
        <Btn onClick={handleSubmit} disabled={saving}>{saving?"Submitting…":"📨 Submit Leave Request"}</Btn>
      </div>
    </div>
  );
}

// ── Leave Request Card (single) ───────────────────────────────────────────────
function LeaveRequestCard({ req: reqProp, allUsers, currentUser, isAdmin, isApprover, onUpdate, onDelete, entries=[], setEntries=null }) {
  const [req, setReq]           = useState(reqProp);
  const [acting, setActing]     = useState(false);
  const [declineMode, setDeclineMode] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [reasonErr, setReasonErr]  = useState("");
  const [fillMsg, setFillMsg]   = useState("");

  // Keep local req in sync if parent re-renders with new data
  useEffect(()=>{ setReq(reqProp); }, [reqProp.status, reqProp.id]);

  const apprentice = allUsers.find(u=>u.id===req.apprentice_id) || { name:"Unknown" };
  const approver   = allUsers.find(u=>u.id===req.approver_id)   || { name:"No approver" };
  const meta       = LEAVE_STATUS_META[req.status] || LEAVE_STATUS_META.pending;

  // KTA approval emails go to admin@kta.org.nz only
  const ktaAdminEmails = ["admin@kta.org.nz"];

  const approve = async () => {
    setActing(true);
    setFillMsg("");
    const newStatus = isApprover ? "approver_approved" : "kta_approved";
    const updated   = { ...req, status: newStatus };
    try {
      await updateRow("leave_requests", req.id, { status: newStatus });
    } catch(e) {
      console.error("DB update failed:", e);
      setFillMsg("⚠ Could not update status. Please try again.");
      setActing(false); return;
    }

    if(isApprover) {
      // 1. Notify apprentice their request moved forward
      if(apprentice.email) {
        try { await sendLeaveEmail({
          to: apprentice.email,
          subject: `Leave Request Approved by Approver — ${req.leave_type}`,
          html: leaveEmailHtml(
            `Your leave request has been approved by <strong>${currentUser.name}</strong> and forwarded to KTA for final approval.`,
            leaveDetailTable(req, apprentice.name, approver.name) +
            `<div style="background:#d4f0ec;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #1a8a7a">
              <div style="font-weight:700;font-size:13.2px;color:#1a8a7a;margin-bottom:4px">✓ Stage 1 of 2 Complete</div>
              <div style="font-size:13.2px;color:#0d1b2e">Approver approved. Awaiting KTA final approval.</div>
            </div>`
          ),
        }); } catch(e) { console.error("Apprentice notify email failed:", e); }
      }
      // 2. Email KTA admin(s) with approve/decline buttons
      for(const adminEmail of ktaAdminEmails) {
        try {
          const adminUser = allUsers.find(u => u.email === adminEmail && u.role==="Admin")
                         || allUsers.find(u => u.role==="Admin" && (u.adminLevel===1||!u.adminLevel));
          const actorId   = adminUser?.id || currentUser.id; // always a real UUID
          const buttons   = await leaveActionButtons(req.id, actorId, "admin");
          await sendLeaveEmail({
            to: adminEmail,
            subject: `Leave Request for KTA Approval — ${apprentice.name} (${req.leave_type})`,
            html: leaveEmailHtml(
              `A leave request from <strong>${apprentice.name}</strong> has been approved by their approver (<strong>${currentUser.name}</strong>) and requires KTA final approval.`,
              leaveDetailTable(req, apprentice.name, approver.name) + buttons
            ),
          });
        } catch(e) {
          console.error("KTA admin email failed:", e);
          setFillMsg(`⚠ Approved but KTA email failed: ${e.message}`);
        }
      }
    } else {
      // Admin giving final KTA approval — notify apprentice + approver + add to team calendar
      if(apprentice.email) {
        try { await sendLeaveEmail({
          to: apprentice.email,
          subject: `Leave Fully Approved by KTA — ${req.leave_type}`,
          html: leaveEmailHtml(
            `Your leave request has been <strong>fully approved by KTA</strong>. Enjoy your time off! 🎉`,
            leaveDetailTable(req, apprentice.name, approver.name) +
            `<div style="background:#dce8f7;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #1b4f8c">
              <div style="font-weight:700;font-size:13.2px;color:#1b4f8c;margin-bottom:4px">★ Fully Approved</div>
              <div style="font-size:13.2px;color:#0d1b2e">Both approver and KTA have approved your leave.</div>
            </div>`
          ),
        }); } catch(e) { console.error("KTA approval apprentice email failed:", e); }
      }
      // Notify approver that KTA has given final approval
      if(approver.email && approver.id !== "No approver") {
        await sendLeaveEmail({
          to: approver.email,
          subject: `Leave Fully Approved by KTA — ${apprentice.name} (${req.leave_type})`,
          html: leaveEmailHtml(
            `The leave request from <strong>${apprentice.name}</strong> has been <strong>fully approved by KTA</strong>.`,
            leaveDetailTable(req, apprentice.name, approver.name) +
            `<div style="background:#dce8f7;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #1b4f8c">
              <div style="font-weight:700;font-size:13.2px;color:#1b4f8c;margin-bottom:4px">★ KTA Final Approval Granted</div>
              <div style="font-size:13.2px;color:#0d1b2e">${apprentice.name}'s leave has been fully approved. A calendar invite is attached below.</div>
            </div>`
          ),
        }).catch(e => console.error("Approver KTA-approval notification failed:", e));
      }
      // Add to KTA team calendar
      await addLeaveToCalendar(apprentice.name, req.leave_type, req.date_from, req.date_to);
      // Send iCal invites to apprentice, approver and admin
      const invitePromises = [];
      if(apprentice.email) invitePromises.push(
        sendCalendarInvite(apprentice.email, apprentice.name, apprentice.name, req.leave_type, req.date_from, req.date_to)
      );
      if(approver.email && approver.id !== "No approver") invitePromises.push(
        sendCalendarInvite(approver.email, approver.name, apprentice.name, req.leave_type, req.date_from, req.date_to)
      );
      invitePromises.push(
        sendCalendarInvite("admin@kta.org.nz", "KTA Admin", apprentice.name, req.leave_type, req.date_from, req.date_to)
      );
      await Promise.all(invitePromises);
      // Auto-fill timesheet entries for each working day
      const filled = await autoFillLeaveEntries(apprentice.id, req.leave_type, req.date_from, req.date_to, entries, setEntries);
      if(filled > 0) setFillMsg(`✓ ${filled} timesheet ${filled===1?"entry":"entries"} auto-filled`);
    }
    setReq(updated);
    onUpdate(updated);
    setActing(false);
  };

  const submitDecline = async () => {
    if(!declineReason.trim()) { setReasonErr("Please enter a reason."); return; }
    setReasonErr("");
    setActing(true);
    const updated = { ...req, status: "declined", decline_reason: declineReason.trim() };
    try {
      await updateRow("leave_requests", req.id, { status: "declined", decline_reason: declineReason.trim() });
    } catch(e) {
      console.error("DB update failed:", e);
      setReasonErr("Could not save. Please try again.");
      setActing(false); return;
    }
    if(apprentice.email) {
      try { await sendLeaveEmail({
        to: apprentice.email,
        subject: `Leave Request Declined — ${req.leave_type}`,
        html: leaveEmailHtml(
          `Your leave request for <strong>${req.leave_type}</strong> (${fmtDateNZ(req.date_from)} – ${fmtDateNZ(req.date_to)}) has been <strong>declined</strong> by <strong>${currentUser.name}</strong>.`,
          leaveDetailTable(req, apprentice.name, approver.name) +
          `<div style="background:#fde8e8;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #bf2b2b">
            <div style="font-weight:700;font-size:13.2px;color:#bf2b2b;margin-bottom:4px">Reason for Decline</div>
            <div style="font-size:13.2px;color:#0d1b2e">${declineReason.trim()}</div>
          </div>
          <p style="font-size:13.2px;color:#4a5a72">Please contact <strong>${currentUser.name}</strong> for further information.</p>`
        ),
      }); } catch(e) { console.error("Apprentice decline email failed:", e); }
    }
    if(isApprover) {
      // Approver declined — notify admin@kta.org.nz so KTA is aware (CC-style)
      await sendLeaveEmail({
        to: "admin@kta.org.nz",
        subject: `Leave Request Declined by Approver — ${apprentice.name} (${req.leave_type})`,
        html: leaveEmailHtml(
          `A leave request from <strong>${apprentice.name}</strong> has been <strong>declined</strong> by their approver, <strong>${currentUser.name}</strong>.`,
          leaveDetailTable(req, apprentice.name, approver.name) +
          `<div style="background:#fde8e8;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #bf2b2b">
            <div style="font-weight:700;font-size:13.2px;color:#bf2b2b;margin-bottom:4px">Reason for Decline</div>
            <div style="font-size:13.2px;color:#0d1b2e">${declineReason.trim()}</div>
          </div>
          <p style="font-size:13.2px;color:#4a5a72">The apprentice has been notified. No further action required.</p>`
        ),
      }).catch(()=>{});
    } else {
      // Admin (KTA) declined — notify the approver so they are informed
      if(approver.email && approver.id !== "No approver") {
        await sendLeaveEmail({
          to: approver.email,
          subject: `Leave Request Declined by KTA — ${apprentice.name} (${req.leave_type})`,
          html: leaveEmailHtml(
            `The leave request from <strong>${apprentice.name}</strong> has been <strong>declined by KTA</strong> (<strong>${currentUser.name}</strong>).`,
            leaveDetailTable(req, apprentice.name, approver.name) +
            `<div style="background:#fde8e8;border-radius:8px;padding:12px 16px;margin:14px 0;border-left:4px solid #bf2b2b">
              <div style="font-weight:700;font-size:13.2px;color:#bf2b2b;margin-bottom:4px">Reason for Decline</div>
              <div style="font-size:13.2px;color:#0d1b2e">${declineReason.trim()}</div>
            </div>
            <p style="font-size:13.2px;color:#4a5a72">The apprentice has also been notified of this decision.</p>`
          ),
        }).catch(()=>{});
      }
    }
    setReq(updated);
    onUpdate(updated);
    setActing(false);
    setDeclineMode(false);
  };

  const isAdmin1   = isAdmin && Number(currentUser?.adminLevel ?? 1) === 1;
  // Admin can approve/decline from any non-final status (pending OR approver_approved)
  const canApprove = (isApprover && req.status==="pending") ||
                     (isAdmin1  && (req.status==="pending" || req.status==="approver_approved"));
  const canDecline = (isApprover && req.status==="pending") ||
                     (isAdmin1  && (req.status==="pending" || req.status==="approver_approved"));

  const borderCol = req.status==="declined" ? T.red :
                    req.status==="kta_approved" ? T.accent :
                    req.status==="approver_approved" ? T.teal : T.warn;

  return (
    <div style={{background:T.surface,border:`1.5px solid ${borderCol}33`,borderLeft:`3px solid ${borderCol}`,borderRadius:12,padding:"14px 16px",marginBottom:10}}>
      {/* Top row: name + type + action buttons */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
            <div style={{fontWeight:700,fontSize:16,color:T.ink}}>{apprentice.name}</div>
            <span style={{background:T.bg,color:T.sub,borderRadius:99,padding:"2px 10px",fontSize:12,fontWeight:700}}>
              {req.leave_type}
            </span>
          </div>
          <div style={{fontSize:13,color:T.sub}}>
            📅 {fmtDateNZ(req.date_from)} → {fmtDateNZ(req.date_to)}
            <span style={{marginLeft:12,color:T.muted}}>Approver: {approver.name}</span>
          </div>
          {req.notes && <div style={{fontSize:13,color:T.sub,marginTop:4,fontStyle:"italic"}}>"{req.notes}"</div>}
          {req.decline_reason && req.status==="declined" && (
            <div style={{fontSize:12,color:T.red,marginTop:4,background:T.redL,borderRadius:6,padding:"4px 8px",display:"inline-block"}}>
              Reason: {req.decline_reason}
            </div>
          )}
        </div>
        {!declineMode && (
          <div style={{display:"flex",gap:6,flexShrink:0}}>
            {canApprove && (
              <button onClick={approve} disabled={acting}
                style={{background:T.teal,color:"#fff",border:"none",borderRadius:7,padding:"7px 16px",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"DM Sans,sans-serif",opacity:acting?0.6:1}}>
                {acting?"…":"✓ Approve"}
              </button>
            )}
            {canDecline && !acting && (
              <button onClick={()=>{setDeclineMode(true);setDeclineReason("");setReasonErr("");}}
                style={{background:T.redL,color:T.red,border:`1.5px solid ${T.red}44`,borderRadius:7,padding:"7px 14px",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                ✕ Decline
              </button>
            )}
            {isAdmin1 && onDelete && !acting && (
              <button onClick={async ()=>{
                if(!await ktaConfirm(`Delete this leave request from ${apprentice.name}? This cannot be undone.`)) return;
                await deleteRow("leave_requests", req.id).catch(console.error);
                onDelete(req.id);
              }}
                title="Delete leave request"
                style={{background:"none",border:`1.5px solid ${T.red}44`,color:T.red,borderRadius:7,padding:"7px 10px",fontSize:14,cursor:"pointer",lineHeight:1}}>
                🗑
              </button>
            )}
          </div>
        )}
      </div>

      {/* Progress stepper — always visible */}
      <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
        <LeaveStatusStepper status={req.status}/>
        {fillMsg && (
          <div style={{marginTop:6,fontSize:12,color:T.teal,fontWeight:700}}>{fillMsg}</div>
        )}
      </div>

      {/* Inline decline reason form */}
      {declineMode && (
        <div style={{marginTop:12,padding:"12px 14px",background:T.redL,borderRadius:9,border:`1px solid ${T.red}33`}}>
          <div style={{fontWeight:700,fontSize:13,color:T.red,marginBottom:8}}>✕ Decline — Reason Required</div>
          <textarea
            value={declineReason}
            onChange={e=>{setDeclineReason(e.target.value);setReasonErr("");}}
            placeholder="Enter reason for declining this leave request…"
            rows={2}
            style={{width:"100%",border:`1.5px solid ${reasonErr?T.red:T.border}`,borderRadius:7,padding:"8px 10px",fontSize:13,fontFamily:"DM Sans,sans-serif",resize:"vertical",boxSizing:"border-box",color:T.ink}}
          />
          {reasonErr && <div style={{fontSize:12,color:T.red,marginBottom:6}}>{reasonErr}</div>}
          <div style={{display:"flex",gap:8,marginTop:6}}>
            <button onClick={submitDecline} disabled={acting}
              style={{background:T.red,color:"#fff",border:"none",borderRadius:7,padding:"7px 16px",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"DM Sans,sans-serif",opacity:acting?0.6:1}}>
              {acting?"…":"Confirm Decline"}
            </button>
            <button onClick={()=>setDeclineMode(false)} disabled={acting}
              style={{background:T.bg,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:"7px 14px",fontSize:13,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Leave Toggle Card — compact, same style as ContactUs, expands to form ────
function LeaveToggleCard({ currentUser, allUsers }) {
  const [open, setOpen]       = useState(false);
  const [submitted, setSubmitted] = useState(false);

  return (
    <Card style={{marginTop:20, border:`1.5px solid ${T.border}`}} className="fu">
      {/* Header row — always visible, matches ContactUs style */}
      <button onClick={()=>{ setOpen(s=>!s); setSubmitted(false); }}
        style={{width:"100%", background:"none", border:"none", padding:0, cursor:"pointer", textAlign:"left", fontFamily:"DM Sans,sans-serif"}}>
        <div style={{display:"flex", alignItems:"center", gap:10}}>
          <div style={{width:36, height:36, borderRadius:10, background:T.accentL,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:19}}>🏖️</div>
          <div style={{flex:1}}>
            <div style={{fontWeight:700, fontSize:17}}>Apply for Leave</div>
            <div style={{fontSize:13, color:T.sub}}>Submit a leave request to your approver</div>
          </div>
          <div style={{fontSize:14, color:T.muted, marginLeft:"auto"}}>{open ? "▲" : "▼"}</div>
        </div>
      </button>

      {/* Expandable form */}
      {open && !submitted && (
        <div style={{marginTop:18, borderTop:`1px solid ${T.border}`, paddingTop:18}}>
          <LeaveRequestForm
            currentUser={currentUser}
            allUsers={allUsers}
            onSubmitted={()=>{ setSubmitted(true); setTimeout(()=>setOpen(false), 2000); }}
          />
        </div>
      )}
      {open && submitted && (
        <div style={{marginTop:18, borderTop:`1px solid ${T.border}`, paddingTop:18, textAlign:"center", padding:"24px 16px"}}>
          <div style={{fontSize:35, marginBottom:10}}>✅</div>
          <div style={{fontWeight:700, color:T.teal, fontSize:17}}>Leave request submitted!</div>
        </div>
      )}
    </Card>
  );
}



// ── Leave Requests List Page (full-page admin view, opened from stat card) ────
function LeaveRequestsListPage({ currentUser, allUsers, entries, setEntries }) {
  const [requests, setRequests] = useState([]);
  const [loading,  setLoading]  = useState(true);

  const load = () => {
    loadTable("leave_requests")
      .then(rows => {
        const sorted = (rows||[]).sort((a,b) => {
          // Sort order: awaiting_kta first, then pending, then approved, then declined, then by date desc
          const rank = { approver_approved:0, pending:1, kta_approved:2, declined:3 };
          const ra = rank[a.status]??2, rb = rank[b.status]??2;
          if(ra !== rb) return ra - rb;
          return b.created_at.localeCompare(a.created_at);
        });
        setRequests(sorted);
      })
      .catch(()=>setRequests([]))
      .finally(()=>setLoading(false));
  };

  useEffect(()=>{ load(); },[]);
  useEffect(()=>{ const t=setInterval(load,30000); return()=>clearInterval(t); },[]);

  const handleUpdate = (updated) => setRequests(prev=>prev.map(r=>r.id===updated.id?updated:r));

  if(loading) return <div style={{textAlign:"center",padding:40,color:T.muted,fontSize:14}}>Loading leave requests…</div>;
  if(requests.length===0) return (
    <Card style={{textAlign:"center",padding:"52px 24px"}}>
      <div style={{fontSize:40,marginBottom:10}}>🏖️</div>
      <div style={{fontWeight:700,fontSize:17}}>No leave requests yet</div>
      <div style={{fontSize:14,color:T.sub,marginTop:6}}>Approved leave requests will appear here.</div>
    </Card>
  );

  return (
    <div>
      {requests.map(r=>(
        <LeaveRequestCard key={r.id} req={r} allUsers={allUsers} currentUser={currentUser}
          isAdmin={currentUser.role==="Admin"} isApprover={false} onUpdate={handleUpdate}
          entries={entries} setEntries={setEntries}
          onDelete={(id)=>setRequests(prev=>prev.filter(x=>x.id!==id))}/>
      ))}
    </div>
  );
}

// ── Leave Overview Card (Admin Dashboard — compact table in timesheets section) ──
function LeaveOverviewCard({ allUsers }) {
  const [requests, setRequests] = useState([]);
  const [loading,  setLoading]  = useState(true);

  const load = () => {
    loadTable("leave_requests")
      .then(rows => setRequests((rows||[]).sort((a,b)=>b.created_at.localeCompare(a.created_at))))
      .catch(()=>setRequests([]))
      .finally(()=>setLoading(false));
  };
  useEffect(()=>{ load(); },[]);
  useEffect(()=>{ const t=setInterval(load,30000); return()=>clearInterval(t); },[]);

  const STATUS = {
    pending:           { label:"Awaiting Approver", color:"#b86e1a", bg:"#faebd7", dot:"🟠" },
    approver_approved: { label:"Awaiting KTA",      color:"#1b4f8c", bg:"#dce8f7", dot:"🔵" },
    kta_approved:      { label:"Approved",           color:"#1a6b3a", bg:"#d4f0e0", dot:"🟢" },
    declined:          { label:"Declined",           color:"#bf2b2b", bg:"#fde8e8", dot:"🔴" },
  };

  const getName = (id) => allUsers.find(u=>u.id===id)?.name || "—";
  const fmt = (d) => { if(!d) return "—"; const[y,m,dy]=d.split("-"); return `${dy}/${m}/${y}`; };

  if(loading) return (
    <Card style={{marginBottom:16,padding:"18px 20px"}}>
      <div style={{fontSize:13,color:T.muted}}>Loading leave requests…</div>
    </Card>
  );
  if(requests.length===0) return null;

  return (
    <Card style={{marginBottom:16,border:`1.5px solid ${T.border}`}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <div style={{width:36,height:36,borderRadius:10,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:19}}>🏖️</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"DM Sans",fontWeight:700,fontSize:18}}>Leave Requests</div>
          <div style={{fontSize:13,color:T.sub,marginTop:2}}>{requests.length} request{requests.length!==1?"s":""} — click a row to manage in the panel below</div>
        </div>
        <button onClick={load} title="Refresh" style={{background:"none",border:"none",cursor:"pointer",fontSize:18,color:T.muted,padding:4}}>↻</button>
      </div>

      {/* Legend */}
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:12}}>
        {Object.entries(STATUS).map(([k,v])=>(
          <span key={k} style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:12,
            color:v.color,background:v.bg,borderRadius:99,padding:"3px 10px",fontWeight:700,
            border:`1px solid ${v.color}33`}}>
            <span style={{width:7,height:7,borderRadius:"50%",background:v.color,display:"inline-block"}}/>
            {v.label}
          </span>
        ))}
      </div>

      {/* Table */}
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead>
            <tr style={{background:T.bg}}>
              {["Apprentice","Leave Type","Start","End","Status"].map(h=>(
                <th key={h} style={{padding:"8px 12px",textAlign:"left",fontSize:11,fontWeight:700,
                  color:T.muted,textTransform:"uppercase",letterSpacing:".6px",
                  borderBottom:`1.5px solid ${T.border}`,whiteSpace:"nowrap"}}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {requests.map((r,i)=>{
              const s = STATUS[r.status] || STATUS.pending;
              return (
                <tr key={r.id}
                  style={{borderBottom:`1px solid ${T.border}44`,
                    background:i%2===0?T.surface:T.bg,
                    transition:"background .12s"}}
                  onMouseEnter={e=>e.currentTarget.style.background=s.bg}
                  onMouseLeave={e=>e.currentTarget.style.background=i%2===0?T.surface:T.bg}>
                  {/* Apprentice */}
                  <td style={{padding:"10px 12px",fontWeight:700,color:T.ink,whiteSpace:"nowrap"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <Avatar name={getName(r.apprentice_id)} role="Apprentice" size={26}/>
                      {getName(r.apprentice_id)}
                    </div>
                  </td>
                  {/* Leave Type */}
                  <td style={{padding:"10px 12px",color:T.sub,whiteSpace:"nowrap"}}>{r.leave_type}</td>
                  {/* Start */}
                  <td style={{padding:"10px 12px",color:T.sub,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"}}>{fmt(r.date_from)}</td>
                  {/* End */}
                  <td style={{padding:"10px 12px",color:T.sub,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"}}>{fmt(r.date_to)}</td>
                  {/* Status pill */}
                  <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}>
                    <span style={{display:"inline-flex",alignItems:"center",gap:5,
                      background:s.bg,color:s.color,border:`1px solid ${s.color}44`,
                      borderRadius:99,padding:"3px 10px",fontSize:12,fontWeight:700}}>
                      <span style={{width:7,height:7,borderRadius:"50%",background:s.color,display:"inline-block"}}/>
                      {s.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Leave Requests Panel (Admin / Approver / Mentor) ─────────────────────────
function LeaveRequestsPanel({ currentUser, allUsers, entries=[], setEntries=null }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState("pending");

  const role       = currentUser.role;
  const isAdmin    = role === "Admin";
  const isApprover = role === "Approver";
  const isMentor   = role === "Mentor";
  const isViewer   = role === "Viewer";

  const load = () => {
    setLoading(true);
    loadTable("leave_requests")
      .then(rows => {
        let visible = rows || [];
        if(isApprover) {
          const myIds = allUsers
            .filter(u => u.role==="Apprentice" && (
              u.approverUserId === currentUser.id ||
              (u.allocatedTo||[]).includes(currentUser.id)
            ))
            .map(u=>u.id);
          visible = visible.filter(r => myIds.includes(r.apprentice_id));
        }
        if(isViewer) {
          const myIds = allUsers
            .filter(u => u.role==="Apprentice" && (
              u.viewerUserId === currentUser.id ||
              (u.allocatedTo||[]).includes(currentUser.id)
            ))
            .map(u=>u.id);
          visible = visible.filter(r => myIds.includes(r.apprentice_id));
        }
        if(isMentor) {
          const myIds = allUsers
            .filter(u => u.role==="Apprentice" && (
              u.allocatedTo === currentUser.id ||
              u.mentorUserId === currentUser.id
            ))
            .map(u=>u.id);
          visible = visible.filter(r => myIds.includes(r.apprentice_id));
        }
        setRequests(visible.sort((a,b)=>b.created_at.localeCompare(a.created_at)));
      })
      .catch(()=>setRequests([]))
      .finally(()=>setLoading(false));
  };

  useEffect(()=>{ load(); },[currentUser.id]);

  // Poll every 30s so status updates from email actions appear automatically
  useEffect(()=>{ const t = setInterval(load, 30000); return ()=>clearInterval(t); },[currentUser.id]);

  const handleUpdate = (updated) => {
    setRequests(prev => prev.map(r => r.id===updated.id ? updated : r));
  };

  // Separate tabs: Pending approver, Awaiting KTA, Fully Approved, Declined
  const tabPending   = requests.filter(r => r.status==="pending");
  const tabAwaitKTA  = requests.filter(r => r.status==="approver_approved");
  const tabApproved  = requests.filter(r => r.status==="kta_approved");
  const tabDeclined  = requests.filter(r => r.status==="declined");

  const TAB_CONFIG = [
    { id:"pending",      label:"⏳ Pending Approver",  list:tabPending,   color:"#b86e1a" },
    { id:"awaiting_kta", label:"✓ Awaiting KTA",      list:tabAwaitKTA,  color:"#1a8a7a" },
    { id:"approved",     label:"★ Fully Approved",    list:tabApproved,  color:T.accent  },
    { id:"declined",     label:"✕ Declined",          list:tabDeclined,  color:T.red     },
  ];

  const shown = TAB_CONFIG.find(t=>t.id===tab)?.list || [];

  if(loading) return <div style={{textAlign:"center",padding:20,color:T.muted,fontSize:14}}>Loading leave requests…</div>;
  if(requests.length === 0) return null;

  return (
    <Card style={{marginBottom:16,border:`1.5px solid ${T.border}`}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <div style={{width:36,height:36,borderRadius:10,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:19}}>🏖️</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"DM Sans",fontWeight:700,fontSize:18}}>Leave Requests</div>
          <div style={{fontSize:13,color:T.sub,marginTop:2}}>{isViewer?"View apprentice leave applications":"Review and approve apprentice leave applications"}</div>
        </div>
        <button onClick={load} title="Refresh" style={{background:"none",border:"none",cursor:"pointer",fontSize:18,color:T.muted,padding:4}}>↻</button>
      </div>
      {/* Status tabs — all 4 stages clearly separated */}
      <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
        {TAB_CONFIG.map(tc => (
          <button key={tc.id} onClick={()=>setTab(tc.id)}
            style={{padding:"5px 12px",borderRadius:8,border:`1.5px solid ${tab===tc.id?tc.color:T.border}`,
              cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontSize:12,fontWeight:700,
              background:tab===tc.id?tc.color:T.surface,
              color:tab===tc.id?"#fff":tc.list.length>0?tc.color:T.muted,
              transition:"all .12s"}}>
            {tc.label}
            {tc.list.length>0 && <span style={{marginLeft:5,background:tab===tc.id?"rgba(255,255,255,.25)":tc.color+"22",borderRadius:99,padding:"1px 7px",fontSize:11,fontWeight:700}}>{tc.list.length}</span>}
          </button>
        ))}
      </div>
      {shown.length===0
        ? <div style={{textAlign:"center",padding:"20px",color:T.muted,fontSize:14,fontStyle:"italic"}}>No leave requests in this category.</div>
        : shown.map(r => (
            <LeaveRequestCard key={r.id} req={r} allUsers={allUsers} currentUser={currentUser}
              isAdmin={isAdmin} isApprover={isApprover} onUpdate={handleUpdate}
              entries={entries} setEntries={setEntries}
              onDelete={(id)=>setRequests(prev=>prev.filter(r=>r.id!==id))}/>
          ))
      }
    </Card>
  );
}

// ── My Leave Requests (Apprentice view of own requests) ───────────────────────
function MyLeaveRequests({ currentUser }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading]   = useState(true);

  const load = () => {
    loadTable("leave_requests")
      .then(rows => setRequests((rows||[]).filter(r=>r.apprentice_id===currentUser.id).sort((a,b)=>b.created_at.localeCompare(a.created_at))))
      .catch(()=>setRequests([]))
      .finally(()=>setLoading(false));
  };

  useEffect(()=>{ load(); },[currentUser.id]);
  // Poll every 20s — apprentice sees status update automatically when admin approves via email
  useEffect(()=>{ const t = setInterval(load, 20000); return ()=>clearInterval(t); },[currentUser.id]);

  if(loading) return null;
  if(requests.length===0) return null;

  return (
    <Card style={{marginBottom:16,border:`1.5px solid ${T.border}`}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📋</div>
          <div style={{fontWeight:700,fontSize:17}}>My Leave Requests</div>
        </div>
        <button onClick={load} title="Refresh" style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:T.muted}}>↻</button>
      </div>
      {requests.map(r => {
        const meta = LEAVE_STATUS_META[r.status] || LEAVE_STATUS_META.pending;
        const borderCol = r.status==="declined" ? T.red :
                          r.status==="kta_approved" ? T.accent :
                          r.status==="approver_approved" ? T.teal : T.warn;
        return (
          <div key={r.id} style={{marginBottom:12,padding:"12px 14px",borderRadius:10,
            border:`1.5px solid ${borderCol}33`,borderLeft:`3px solid ${borderCol}`,background:T.surface}}>
            {/* Header row */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap",marginBottom:6}}>
              <div>
                <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{r.leave_type}</div>
                <div style={{fontSize:13,color:T.sub,marginTop:2}}>
                  📅 {fmtDateNZ(r.date_from)} → {fmtDateNZ(r.date_to)}
                </div>
                {r.notes && <div style={{fontSize:12,color:T.muted,marginTop:2,fontStyle:"italic"}}>"{r.notes}"</div>}
              </div>
              <span style={{background:meta.bg,color:meta.color,borderRadius:99,padding:"3px 12px",fontSize:12,fontWeight:700,flexShrink:0,whiteSpace:"nowrap"}}>
                {meta.sym} {meta.label}
              </span>
            </div>
            {/* Decline reason — shown if declined */}
            {r.status==="declined" && r.decline_reason && (
              <div style={{background:T.redL,border:`1px solid ${T.red}22`,borderRadius:7,padding:"7px 10px",fontSize:13,color:T.red,marginBottom:6}}>
                <span style={{fontWeight:700}}>Reason: </span>{r.decline_reason}
              </div>
            )}
            {/* Progress stepper */}
            <div style={{paddingTop:8,borderTop:`1px solid ${T.border}`}}>
              <LeaveStatusStepper status={r.status}/>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT US — Apprentice view
// ─────────────────────────────────────────────────────────────────────────────

export { LeaveStatusStepper, LeaveRequestForm, LeaveRequestCard, LeaveToggleCard, LeaveRequestsListPage, LeaveOverviewCard, LeaveRequestsPanel, MyLeaveRequests };
