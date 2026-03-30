import { useState } from "react";
import { T } from "../constants.js";
import { isConfOwner } from "../utils.js";
import { RolePill, Btn, Card, Avatar } from "../shared.jsx";

function ContactUs({currentUser, allUsers, onSend}) {
  const [selectedId, setSelectedId] = useState(null);
  const [msgMode, setMsgMode] = useState(false);
  const [msgText, setMsgText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // Show Admin and Mentor users as contactable staff (excluding the current user)
  const staffColors = [T.accent, T.teal, T.warn, T.gold, T.blue];
  const staff = allUsers
    .filter(u => ["Admin","Mentor"].includes(u.role) && u.id !== currentUser.id)
    .sort((a, b) => {
      const isMentorA = a.role === "Mentor";
      const isMentorB = b.role === "Mentor";
      const isKristeenaA = isConfOwner(a);
      const isKristeenaB = isConfOwner(b);
      // Mentors first
      if(isMentorA && !isMentorB) return -1;
      if(!isMentorA && isMentorB) return 1;
      // Among non-mentors: Kristeena immediately after last mentor
      if(!isMentorA && !isMentorB) {
        if(isKristeenaA) return -1;
        if(isKristeenaB) return 1;
      }
      // Otherwise alphabetical
      return a.name.localeCompare(b.name);
    })
    .map((u, i) => ({
      ...u,
      color: staffColors[i % staffColors.length],
      avatar: u.name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(),
    }));

  const selected = staff.find(u => u.id === selectedId) || null;

  const handleSendMsg = async () => {
    if(!msgText.trim() || !selected) return;
    setSending(true);
    await onSend(selected, msgText.trim());
    setSending(false);
    setSent(true);
    setTimeout(()=>{ setSent(false); setMsgText(""); setMsgMode(false); }, 2500);
  };

  if(staff.length === 0) return null;

  return (
    <Card style={{marginTop:20,border:`1.5px solid ${T.border}`}} className="fu">
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
        <div style={{width:36,height:36,borderRadius:10,background:T.accentL,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:19}}>📞</div>
        <div>
          <div style={{fontWeight:700,fontSize:17}}>Contact Us</div>
          <div style={{fontSize:13,color:T.sub}}>Get in touch with your KTA team</div>
        </div>
      </div>

      {/* Staff cards */}
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:selectedId?16:0}}>
        {staff.map(person=>(
          <button key={person.id}
            onClick={()=>{setSelectedId(selectedId===person.id?null:person.id);setMsgMode(false);setSent(false);setMsgText("");}}
            style={{padding:"12px 14px",borderRadius:12,textAlign:"left",cursor:"pointer",
              border:`2px solid ${selectedId===person.id?person.color:T.border}`,
              background:selectedId===person.id?person.color+"11":T.surface,
              transition:"all .15s",fontFamily:"DM Sans,sans-serif",width:"100%",
              display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:44,height:44,borderRadius:99,background:person.color,
              display:"flex",alignItems:"center",justifyContent:"center",
              color:"#fff",fontWeight:700,fontSize:16,flexShrink:0}}>
              {person.avatar}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:16,color:T.ink}}>{person.name}</div>
              <div style={{marginTop:3}}><RolePill role={person.role} size="sm"/></div>
            </div>
            {selectedId===person.id
              ? <span style={{fontSize:18,color:person.color,flexShrink:0}}>✓</span>
              : <span style={{fontSize:16,color:T.muted,flexShrink:0}}>›</span>
            }
          </button>
        ))}
      </div>

      {/* Contact options */}
      {selected&&!msgMode&&!sent&&(
        <div className="fu" style={{background:T.bg,borderRadius:10,padding:14}}>
          <div style={{fontSize:13,fontWeight:700,color:T.sub,marginBottom:10,textTransform:"uppercase",letterSpacing:".5px"}}>
            How would you like to reach {selected.name.split(" ")[0]}?
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {selected.phone&&(
              <a href={`tel:${selected.phone.replace(/\s/g,"")}`}
                style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
                  borderRadius:9,background:T.surface,border:`1.5px solid ${T.border}`,
                  textDecoration:"none",color:T.ink,transition:"all .14s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=T.accent}
                onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
                <span style={{fontSize:22}}>📱</span>
                <div>
                  <div style={{fontSize:14,fontWeight:700}}>Call</div>
                  <div style={{fontSize:13,color:T.sub}}>{selected.phone}</div>
                </div>
              </a>
            )}
            {selected.email&&(
              <a href={`mailto:${selected.email}`}
                style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
                  borderRadius:9,background:T.surface,border:`1.5px solid ${T.border}`,
                  textDecoration:"none",color:T.ink,transition:"all .14s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=T.accent}
                onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
                <span style={{fontSize:22}}>✉️</span>
                <div>
                  <div style={{fontSize:14,fontWeight:700}}>Email</div>
                  <div style={{fontSize:13,color:T.sub}}>{selected.email}</div>
                </div>
              </a>
            )}
            {!selected.phone&&!selected.email&&(
              <div style={{fontSize:13,color:T.muted,fontStyle:"italic",padding:"8px 0"}}>
                No phone or email on file — use the in-app message below.
              </div>
            )}
            <button onClick={()=>setMsgMode(true)}
              style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",
                borderRadius:9,background:T.surface,border:`1.5px solid ${T.border}`,
                textAlign:"left",cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                color:T.ink,transition:"all .14s",width:"100%"}}
              onMouseEnter={e=>e.currentTarget.style.borderColor=selected.color}
              onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
              <span style={{fontSize:22}}>💬</span>
              <div>
                <div style={{fontSize:14,fontWeight:700}}>Message in App</div>
                <div style={{fontSize:13,color:T.sub}}>Send a message via the KTA app</div>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* In-app message composer */}
      {selected&&msgMode&&!sent&&(
        <div className="fu" style={{background:T.bg,borderRadius:10,padding:14}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:8}}>
            Message to {selected.name}
          </div>
          <textarea
            placeholder={`Hi ${selected.name.split(" ")[0]}, I wanted to reach out about…`}
            value={msgText}
            onChange={e=>setMsgText(e.target.value)}
            rows={4}
            style={{width:"100%",fontSize:14,padding:"10px 12px",borderRadius:8,
              border:`1.5px solid ${T.border}`,fontFamily:"DM Sans,sans-serif",
              background:T.surface,resize:"none",color:T.ink,outline:"none",
              boxSizing:"border-box"}}
          />
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <Btn onClick={handleSendMsg} disabled={sending||!msgText.trim()}>
              {sending?"Sending…":"Send Message"}
            </Btn>
            <Btn v="ghost" onClick={()=>{setMsgMode(false);setMsgText("");}}>Cancel</Btn>
          </div>
        </div>
      )}

      {/* Sent confirmation */}
      {sent&&(
        <div className="fu" style={{background:T.accentL,borderRadius:10,padding:16,textAlign:"center"}}>
          <div style={{fontSize:22,marginBottom:4}}>✓</div>
          <div style={{fontWeight:700,color:T.accent,fontSize:16}}>Message sent!</div>
          <div style={{fontSize:13,color:T.sub,marginTop:2}}>{selected?.name} will get back to you soon.</div>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MENTOR MODULE
// ─────────────────────────────────────────────────────────────────────────────

// ── Meeting Report — Email sender ─────────────────────────────────────────────
const sendMeetingReportEmail = async (report, apprentice, mentor, approver, ccEmails=[], senderEmail=null, snapshots=[]) => {
  const fD = (iso) => { if(!iso) return "TBC"; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };

  // HTML body (existing plain-text format)
  const lines = [
    `APPRENTICE CHECK IN REPORT`,
    `Kiwi Trade Apprentices`,
    `════════════════════════════════════════════`,
    ``,
    `Trainee Name:       ${apprentice.name}`,
    `Trade:              ${apprentice.trade||"Not specified"}`,
    `Location:           ${report.location||"Not specified"}`,
    `Date:               ${fD(report.date)}`,
    `KTA Representative: ${mentor?.name||"—"}`,
    `Licence Expiry:     ${apprentice.licenceExpiry ? fD(apprentice.licenceExpiry) : "Not set"}`,
    `Date of Next Visit: ${fD(report.next_visit_date)}`,
    ``,
    `────────────────────────────────────────────`,
    `OFF JOB PROGRESS SINCE LAST VISIT`,
    `────────────────────────────────────────────`,
    report.off_job_progress || "N/a",
    ``,
    `────────────────────────────────────────────`,
    `ON JOB PROGRESS SINCE LAST VISIT`,
    `────────────────────────────────────────────`,
    report.on_job_progress || "N/a",
    ``,
    `────────────────────────────────────────────`,
    `PREVIOUS GOALS`,
    `────────────────────────────────────────────`,
    report.previous_goals || "N/a",
    ``,
    `────────────────────────────────────────────`,
    `GOALS BEFORE NEXT VISIT`,
    `────────────────────────────────────────────`,
    report.goals_this_meeting || "N/a",
    ``,
    `────────────────────────────────────────────`,
    `COMMENTS AND FEEDBACK`,
    `────────────────────────────────────────────`,
    report.comments_feedback || "N/a",
    ``,
    `════════════════════════════════════════════`,
    `This report was generated by the KTA Workforce Management System`,
    `kta.org.nz`,
  ].join("\n");

  // If "Reports Go To" emails are set, send ONLY to those addresses.
  // Otherwise fall back to the approver. Apprentice is never auto-included.
  const reportsEmailList = apprentice.reportsEmail
    ? apprentice.reportsEmail.split(",").map(e=>e.trim()).filter(Boolean)
        .map(email=>({ email, name: "KTA Reports" }))
    : (approver ? [{ email: approver.email, name: approver.name }] : []);

  const recipients = [
    ...reportsEmailList,
    ...(ccEmails||[]),
  ].filter(r => r && r.email && r.email.trim())
   .filter((r,i,arr)=>arr.findIndex(x=>x.email===r.email)===i); // dedupe

  if(recipients.length === 0) {
    throw new Error("No valid email addresses found — check that the apprentice and approver both have email addresses set in their profiles.");
  }

  // Generate PDF attachment (pure JS — synchronous, no library)
  let pdfBase64 = null;
  try {
    pdfBase64 = generateReportPDF(report, apprentice, mentor, snapshots);
    if(!pdfBase64 || pdfBase64.length < 100) throw new Error("PDF output was empty");
  } catch(e) {
    console.error("PDF generation failed:", e);
    // Don't throw — still send email without attachment
  }

  const pdfFilename = `KTA_Report_${apprentice.name.replace(/\s+/g,"_")}_${report.date}.pdf`;
  const attachments = pdfBase64 ? [{
    name: pdfFilename,
    contentType: "application/pdf",
    contentBytes: pdfBase64,
  }] : [];

  const fmtD2 = iso => { if(!iso) return "—"; const [y,m,d]=(iso||"").split("-"); return `${d}/${m}/${y}`; };
  for(const r of recipients) {
    await sendKTAEmail({
      to: r.email.trim(),
      subject: `Apprentice Check In Report — ${apprentice.name}`,
      html: `
<div style="font-family:DM Sans,Arial,sans-serif;max-width:600px;margin:0 auto;background:#f0f4f9;padding:20px">
  <!-- Header: navy + teal accent strip -->
  <div style="background:#1b4f8c;border-radius:10px 10px 0 0;padding:0">
    <div style="padding:16px 24px 14px">
      <div style="display:inline-block;color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px;margin-right:10px">KTA</div>
      <div style="display:inline-block;color:#fff;font-size:17px;font-weight:700;vertical-align:bottom">Apprentice Check In Report</div>
      <div style="color:#a0c4e8;font-size:12px;margin-top:3px">Kiwi Trade Apprentices  ·  kta.org.nz</div>
    </div>
    <div style="height:4px;background:#1a8a7a;border-radius:0"></div>
  </div>
  <!-- Body -->
  <div style="background:#fff;padding:22px 24px;border-radius:0 0 10px 10px;border:1px solid #d0daea;border-top:none">
    <p style="font-size:14px;color:#0d1b2e;margin:0 0 16px">
      Hi <strong>${r.name}</strong>,<br><br>
      Please find the check in report for <strong>${apprentice.name}</strong> attached as a PDF.
    </p>
    <!-- Detail table -->
    <table style="width:100%;border-collapse:collapse;font-size:13.5px;margin:0 0 18px;border-radius:8px;overflow:hidden">
      <tr>
        <td style="padding:9px 12px;background:#f0f4f9;font-weight:700;color:#4a5a72;width:38%;border-bottom:1px solid #d0daea;border-left:3px solid #1a8a7a">Apprentice</td>
        <td style="padding:9px 12px;color:#0d1b2e;border-bottom:1px solid #d0daea">${apprentice.name}</td>
      </tr>
      <tr>
        <td style="padding:9px 12px;background:#f8fafc;font-weight:700;color:#4a5a72;border-bottom:1px solid #d0daea;border-left:3px solid #1a8a7a">Trade</td>
        <td style="padding:9px 12px;color:#0d1b2e;border-bottom:1px solid #d0daea">${apprentice.trade||"—"}</td>
      </tr>
      <tr>
        <td style="padding:9px 12px;background:#f0f4f9;font-weight:700;color:#4a5a72;border-bottom:1px solid #d0daea;border-left:3px solid #1a8a7a">Host Business</td>
        <td style="padding:9px 12px;color:#0d1b2e;border-bottom:1px solid #d0daea">${apprentice.hostBusiness||"—"}</td>
      </tr>
      <tr>
        <td style="padding:9px 12px;background:#f8fafc;font-weight:700;color:#4a5a72;border-bottom:1px solid #d0daea;border-left:3px solid #1a8a7a">Date of Visit</td>
        <td style="padding:9px 12px;color:#0d1b2e;border-bottom:1px solid #d0daea">${fmtD2(report.date)}</td>
      </tr>
      <tr>
        <td style="padding:9px 12px;background:#f0f4f9;font-weight:700;color:#4a5a72;border-bottom:1px solid #d0daea;border-left:3px solid #1a8a7a">KTA Representative</td>
        <td style="padding:9px 12px;color:#0d1b2e;border-bottom:1px solid #d0daea">${mentor?.name||"—"}</td>
      </tr>
      ${report.next_visit_date?`
      <tr>
        <td style="padding:9px 12px;background:#f8fafc;font-weight:700;color:#4a5a72;border-left:3px solid #1a8a7a">Next Visit</td>
        <td style="padding:9px 12px;color:#0d1b2e">${fmtD2(report.next_visit_date)}</td>
      </tr>`:""}
    </table>
    <hr style="border:none;border-top:1px solid #d0daea;margin:0 0 14px">
    <p style="font-size:11.5px;color:#8fa0b8;margin:0">KTA Workforce Management &nbsp;·&nbsp; kta.org.nz</p>
  </div>
</div>`,
      attachments,
    });
  }
};

// ─── Fullscreen New Report Modal ────────────────────────────────────────────
// Renders MeetingReportForm full-screen with a collapsible Past Reports panel


export default ContactUs;
