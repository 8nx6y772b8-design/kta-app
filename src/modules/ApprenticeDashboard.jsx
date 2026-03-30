import { useState } from "react";
import { T } from "../constants.js";
import { getSharePointUrl } from "../constants.js";
import { LeaveRequestForm, MyLeaveRequests } from "./LeaveModule.jsx";
import { PPEAllocation } from "./PPEModule.jsx";
import { PastHSECheckins } from "./HSEModule.jsx";
import { PastMeetingReports } from "./ReportsModule.jsx";
import ContactUs from "./ContactUs.jsx";

function ApprenticeDashboard({ currentUser, allUsers, entries, setEntries, navigateTo, onSendMessage }) {
  const [panel, setPanel] = useState(null); // which panel is open

  const togglePanel = (id) => setPanel(p => p === id ? null : id);

  // Action cards config
  const CARDS = [
    {
      id: "timesheet",
      icon: "⏱",
      color: "#1b4f8c",
      bg: "#dce8f7",
      title: "Fill in Timesheet",
      sub: "Log your hours for the week",
      action: "navigate",
    },
    {
      id: "sick",
      icon: "🤒",
      color: "#bf2b2b",
      bg: "#fde8e8",
      title: "Tell Us You're Sick",
      sub: "Submit a sick leave request",
      action: "panel",
    },
    {
      id: "leave",
      icon: "🏖️",
      color: "#6b4fa0",
      bg: "#ece5f7",
      title: "Request Leave",
      sub: "Annual, bereavement & other leave",
      action: "panel",
    },
    {
      id: "contact",
      icon: "📞",
      color: "#1a8a7a",
      bg: "#d4f0ec",
      title: "Contact Us",
      sub: "Get in touch with your KTA team",
      action: "panel",
    },
    {
      id: "reports",
      icon: "📋",
      color: "#a07820",
      bg: "#fdf3d4",
      title: "Past Reports",
      sub: "View your visit check-in history",
      action: "panel",
    },
    {
      id: "ppe",
      icon: "🦺",
      color: "#4a5568",
      bg: "#edf2f7",
      title: "Past PPE Issued",
      sub: "Review equipment issued to you",
      action: "panel",
    },
    {
      id: "hse",
      icon: "✅",
      color: "#1a8a7a",
      bg: "#d4f0ec",
      title: "Past HSE Check-Ins",
      sub: "View your health & safety history",
      action: "panel",
    },
    ...(getSharePointUrl(currentUser) ? [{
      id: "documents",
      icon: "📁",
      color: "#0078d4",
      bg: "#dceeff",
      title: "My Documents",
      sub: "Open your SharePoint folder",
      action: "link",
    }] : []),
  ];

  const handleCard = (card) => {
    if(card.action === "navigate") {
      navigateTo("timesheet");
    } else if(card.action === "link") {
      const url = getSharePointUrl(currentUser);
      if(url) window.open(url, "_blank", "noopener");
    } else {
      togglePanel(card.id);
    }
  };

  return (
    <div style={{maxWidth: 720, margin: "0 auto"}}>
      {/* Greeting */}
      <div style={{marginBottom: 24}}>
        <div style={{fontWeight: 700, fontSize: 22, color: T.ink}}>
          Hi {currentUser.firstName || currentUser.name.split(" ")[0]} 👋
        </div>
        <div style={{fontSize: 14, color: T.sub, marginTop: 3}}>
          What would you like to do today?
        </div>
      </div>

      {/* Card grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: 12,
        marginBottom: 8,
      }}>
        {CARDS.map(card => (
          <div key={card.id}>
            <button
              onClick={() => handleCard(card)}
              style={{
                width: "100%",
                background: (panel === card.id && card.action === "panel") ? card.bg : T.surface,
                border: `2px solid ${(panel === card.id && card.action === "panel") ? card.color : T.border}`,
                borderRadius: 14,
                padding: "16px 14px",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "DM Sans,sans-serif",
                transition: "all .15s",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
              onMouseEnter={e => { if(panel !== card.id) e.currentTarget.style.borderColor = card.color + "88"; }}
              onMouseLeave={e => { if(panel !== card.id) e.currentTarget.style.borderColor = T.border; }}
            >
              <div style={{
                width: 44, height: 44, borderRadius: 12,
                background: card.bg,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 22, flexShrink: 0,
                border: `1.5px solid ${card.color}22`,
              }}>
                {card.icon}
              </div>
              <div>
                <div style={{fontWeight: 700, fontSize: 14, color: panel === card.id ? card.color : T.ink, lineHeight: 1.3}}>
                  {card.title}
                </div>
                <div style={{fontSize: 12, color: T.muted, marginTop: 3, lineHeight: 1.4}}>
                  {card.sub}
                </div>
              </div>
              <div style={{fontSize: 11, fontWeight: 700, color: card.color, marginTop: "auto"}}>
                {card.action === "navigate" || card.action === "link" ? "Open →" : (panel === card.id ? "▲ Close" : "▼ Open")}
              </div>
            </button>

            {/* Inline panel — renders below the card, full-width via grid trick */}
            {panel === card.id && (
              <div style={{
                gridColumn: "1 / -1",
                marginTop: 4,
              }}/>
            )}
          </div>
        ))}
      </div>

      {/* Expanded panels — full width below the grid */}
      {panel && (CARDS.find(c=>c.id===panel)||{}).action === "panel" && (
        <div style={{
          marginTop: 16,
          background: T.surface,
          border: `1.5px solid ${(CARDS.find(c=>c.id===panel)||{}).color || T.border}44`,
          borderLeft: `3px solid ${(CARDS.find(c=>c.id===panel)||{}).color || T.accent}`,
          borderRadius: 14,
          overflow: "hidden",
        }}>
          {/* Panel header */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: `1px solid ${T.border}`,
            background: T.bg,
          }}>
            <div style={{display: "flex", alignItems: "center", gap: 10}}>
              <span style={{fontSize: 20}}>{(CARDS.find(c=>c.id===panel)||{}).icon}</span>
              <span style={{fontWeight: 700, fontSize: 16, color: T.ink}}>
                {(CARDS.find(c=>c.id===panel)||{}).title}
              </span>
            </div>
            <button onClick={() => setPanel(null)}
              style={{background: "none", border: "none", cursor: "pointer", fontSize: 18,
                color: T.muted, padding: "0 4px", fontFamily: "DM Sans,sans-serif", lineHeight: 1}}>
              ✕
            </button>
          </div>

          {/* Panel content */}
          <div style={{padding: "18px 18px 24px"}}>

            {panel === "sick" && (
              <LeaveRequestForm
                currentUser={currentUser}
                allUsers={allUsers}
                defaultLeaveType="Sick Leave"
                onSubmitted={() => setPanel(null)}
              />
            )}

            {panel === "leave" && (
              <LeaveRequestForm
                currentUser={currentUser}
                allUsers={allUsers}
                defaultLeaveType="Annual Leave"
                onSubmitted={() => setPanel(null)}
              />
            )}

            {panel === "contact" && (
              <ContactUs
                currentUser={currentUser}
                allUsers={allUsers}
                onSend={onSendMessage}
              />
            )}

            {panel === "reports" && (
              <PastMeetingReports
                apprentice={currentUser}
                allUsers={allUsers}
                canEdit={false}
              />
            )}

            {panel === "ppe" && (
              <PPEAllocation
                apprentice={currentUser}
                mentor={null}
                canEdit={false}
              />
            )}

            {panel === "hse" && (
              <PastHSECheckins
                apprentice={currentUser}
                allUsers={allUsers}
                canEdit={false}
              />
            )}

          </div>
        </div>
      )}

      {/* My current leave requests — always visible at bottom */}
      <div style={{marginTop: 24}}>
        <MyLeaveRequests currentUser={currentUser}/>
      </div>
    </div>
  );
}



// ── Leave Action Result Screen ────────────────────────────────────────────────
// Shown when the user lands on crmkta.com?leave_result=1 after clicking
// an approve/decline link in an email. Reads params from the URL, shows a
// styled result card, then clears the URL after 8 seconds.

export default ApprenticeDashboard;
