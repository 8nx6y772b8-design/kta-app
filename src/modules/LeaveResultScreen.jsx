import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { T } from "../constants.js";

function LeaveResultScreen({ onDismiss }) {
  const params = new URLSearchParams(window.location.search);
  const status   = params.get("status")   || "";
  const type     = params.get("type")     || "Leave";
  const name     = params.get("name")     || "";
  const approver = params.get("approver") || "";
  const dateFrom = params.get("date_from") || "";
  const dateTo   = params.get("date_to")   || "";
  const msg      = params.get("msg")       || "";

  const fmtD = (iso) => { if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };

  const CONFIG = {
    approver_approved: {
      icon: "✅", color: T.teal,   bg: T.tealL,
      title: `${type} Approved`,
      sub:   `Forwarded to KTA for final approval`,
    },
    kta_approved: {
      icon: "🎉", color: T.accent, bg: T.accentL,
      title: `${type} Fully Approved`,
      sub:   "Both approver and KTA have approved this leave",
    },
    declined: {
      icon: "❌", color: T.red,    bg: T.redL,
      title: `${type} Declined`,
      sub:   "Please log into KTA to add a reason for the apprentice",
    },
    fully_approved: {
      icon: "⭐", color: T.accent, bg: T.accentL,
      title: `Already Fully Approved`,
      sub:   "This leave request has already been fully approved",
    },
    already_declined: {
      icon: "ℹ️", color: T.muted,  bg: T.bg,
      title: `Already Declined`,
      sub:   "This leave request has already been declined",
    },
    unavailable: {
      icon: "⚠️", color: T.warn,   bg: T.warnL,
      title: "Action No Longer Available",
      sub:   msg || "This request has already been actioned",
    },
    expired: {
      icon: "⏰", color: T.warn,   bg: T.warnL,
      title: "Link Expired",
      sub:   "Leave approval links are valid for 7 days",
    },
    notfound: {
      icon: "🔍", color: T.muted,  bg: T.bg,
      title: "Request Not Found",
      sub:   "This leave request may have been deleted",
    },
    error: {
      icon: "⚠️", color: T.red,    bg: T.redL,
      title: "Something Went Wrong",
      sub:   msg || "An unexpected error occurred",
    },
  };

  const cfg = CONFIG[status] || CONFIG.error;

  useEffect(() => {
    // Clean the URL without reloading
    const clean = window.location.pathname;
    window.history.replaceState({}, "", clean);
    // Auto-dismiss after 10s
    const t = setTimeout(onDismiss, 10000);
    return () => clearTimeout(t);
  }, []);

  return createPortal(
    <div style={{
      position:"fixed", inset:0, zIndex:99998,
      background:"rgba(13,27,46,0.6)",
      display:"flex", alignItems:"center", justifyContent:"center",
      padding:16,
    }}>
      <div style={{
        background:T.surface, borderRadius:16,
        boxShadow:"0 8px 48px rgba(0,0,0,.18)",
        maxWidth:480, width:"100%", overflow:"hidden",
        fontFamily:"DM Sans,Arial,sans-serif",
      }}>
        {/* Header */}
        <div style={{background:cfg.color, padding:"28px 28px 22px", textAlign:"center"}}>
          <div style={{fontSize:48, marginBottom:12}}>{cfg.icon}</div>
          <div style={{fontWeight:700, fontSize:20, color:"#fff", lineHeight:1.3}}>{cfg.title}</div>
          <div style={{fontSize:13, color:"rgba(255,255,255,.8)", marginTop:6}}>{cfg.sub}</div>
        </div>

        {/* Details */}
        <div style={{padding:"20px 28px"}}>
          {name && (
            <div style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:`1px solid ${T.border}`,fontSize:14}}>
              <span style={{color:T.muted, fontWeight:600}}>Apprentice</span>
              <span style={{color:T.ink,  fontWeight:600}}>{name}</span>
            </div>
          )}
          {type && (
            <div style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:`1px solid ${T.border}`,fontSize:14}}>
              <span style={{color:T.muted, fontWeight:600}}>Leave Type</span>
              <span style={{color:T.ink,  fontWeight:600}}>{type}</span>
            </div>
          )}
          {dateFrom && (
            <div style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:`1px solid ${T.border}`,fontSize:14}}>
              <span style={{color:T.muted, fontWeight:600}}>From</span>
              <span style={{color:T.ink,  fontWeight:600}}>{fmtD(dateFrom)}</span>
            </div>
          )}
          {dateTo && (
            <div style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:`1px solid ${T.border}`,fontSize:14}}>
              <span style={{color:T.muted, fontWeight:600}}>To</span>
              <span style={{color:T.ink,  fontWeight:600}}>{fmtD(dateTo)}</span>
            </div>
          )}
          {approver && (
            <div style={{display:"flex",justifyContent:"space-between",padding:"9px 0",fontSize:14}}>
              <span style={{color:T.muted, fontWeight:600}}>Approver</span>
              <span style={{color:T.ink,  fontWeight:600}}>{approver}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{padding:"0 28px 24px"}}>
          <button onClick={onDismiss}
            style={{width:"100%", padding:"12px", background:cfg.color, color:"#fff",
              border:"none", borderRadius:10, fontWeight:700, fontSize:15,
              cursor:"pointer", fontFamily:"DM Sans,Arial,sans-serif"}}>
            Continue to KTA →
          </button>
          <div style={{textAlign:"center", fontSize:12, color:T.muted, marginTop:10}}>
            This screen will close automatically in a few seconds
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Global confirm dialog (replaces window.confirm which Chrome PWA blocks) ───
// Usage anywhere: await ktaConfirm("Are you sure?")  → true / false
// The dialog mounts inside App via <KTAConfirmRoot/>.

let _ktaConfirmResolve = null;
let _ktaConfirmSetState = null;

const ktaConfirm = (message) => new Promise((resolve) => {
  if (!_ktaConfirmSetState) {
    // Fallback if component not mounted yet
    resolve(window.confirm(message));
    return;
  }
  _ktaConfirmResolve = resolve;
  _ktaConfirmSetState({ open: true, message });
});

function KTAConfirmRoot() {
  const [state, setState] = useState({ open: false, message: "" });

  useEffect(() => {
    _ktaConfirmSetState = setState;
    return () => { _ktaConfirmSetState = null; };
  }, []);

  const answer = (yes) => {
    setState({ open: false, message: "" });
    if (_ktaConfirmResolve) { _ktaConfirmResolve(yes); _ktaConfirmResolve = null; }
  };

  if (!state.open) return null;

  return createPortal(
    <div style={{
      position: "fixed", inset: 0, zIndex: 99999,
      background: "rgba(13,27,46,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "16px",
    }} onClick={() => answer(false)}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#fff", borderRadius: 14, boxShadow: "0 8px 40px rgba(0,0,0,.22)",
        maxWidth: 420, width: "100%", padding: "28px 28px 22px",
        fontFamily: "DM Sans, Arial, sans-serif",
      }}>
        <div style={{ fontSize: 22, marginBottom: 14 }}>⚠️</div>
        <div style={{ fontSize: 15.5, color: "#0d1b2e", lineHeight: 1.55, marginBottom: 24, fontWeight: 500 }}>
          {state.message}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={() => answer(false)}
            style={{ padding: "9px 20px", borderRadius: 8, border: "1.5px solid #d0daea",
              background: "#f0f4f9", color: "#4a5a72", fontWeight: 700, fontSize: 14,
              cursor: "pointer", fontFamily: "DM Sans, Arial, sans-serif" }}>
            Cancel
          </button>
          <button onClick={() => answer(true)}
            style={{ padding: "9px 20px", borderRadius: 8, border: "none",
              background: "#bf2b2b", color: "#fff", fontWeight: 700, fontSize: 14,
              cursor: "pointer", fontFamily: "DM Sans, Arial, sans-serif" }}>
            Confirm
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// PROGRESS REPORTS MODULE
// Central admin page: drop EarnLearn PDFs for any apprentice.
// Matches by trainee name, queues to progress_report_queue table.
// Supabase pg_cron runs process-progress-queue edge fn on 1st of each month.
// ─────────────────────────────────────────────────────────────────────────────

export { LeaveResultScreen, KTAConfirmRoot, ktaConfirm };
