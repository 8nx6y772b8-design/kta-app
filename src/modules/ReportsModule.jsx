import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { T } from "../constants.js";
import { uid, fmtD, sendKTAEmail, generateReportPDF } from "../utils.js";
import { upsertRow, loadTable, deleteRow, sb } from "../supabaseClient.js";
import { Btn, Card } from "../shared.jsx";

function ReportFullscreenModal({apprentice, mentor, allUsers, meetingKey, onSave, onClose}) {
  const [showPast, setShowPast] = useState(false);

  // Prevent body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return createPortal(
    <div style={{
      position:"fixed", top:0, left:0, right:0, bottom:0, zIndex:2000,
      background:"rgba(13,27,46,0.6)",
      display:"flex", alignItems:"stretch",
    }}>
      {/* Main form panel */}
      <div style={{
        flex:1, overflowY:"auto", background:T.bg,
        display:"flex", flexDirection:"column",
        transition:"margin-right .25s",
        marginRight: showPast ? 400 : 0,
      }}>
        {/* Top bar */}
        <div style={{
          position:"sticky", top:0, zIndex:10,
          background:T.dark, padding:"0 20px",
          display:"flex", alignItems:"center", justifyContent:"space-between",
          height:52, flexShrink:0, boxShadow:"0 2px 8px rgba(0,0,0,.18)",
        }}>
          <div style={{display:"flex", alignItems:"center", gap:12}}>
            <div style={{fontSize:22}}>📋</div>
            <div>
              <div style={{fontWeight:700, fontSize:17, color:"#fff"}}>New Meeting Report</div>
              <div style={{fontSize:12, color:"rgba(255,255,255,.65)"}}>{apprentice.name}</div>
            </div>
          </div>
          <div style={{display:"flex", alignItems:"center", gap:10}}>
            {/* Past Reports toggle */}
            <button
              onClick={() => setShowPast(s => !s)}
              style={{
                display:"flex", alignItems:"center", gap:7,
                background: showPast ? T.gold : "rgba(255,255,255,.12)",
                border: `1.5px solid ${showPast ? T.gold : "rgba(255,255,255,.25)"}`,
                borderRadius:8, padding:"6px 14px", cursor:"pointer",
                color: showPast ? T.dark : "#fff", fontSize:13, fontWeight:700,
                fontFamily:"DM Sans,sans-serif", transition:"all .15s",
              }}
            >
              <span>📁</span>
              <span>Past Reports</span>
              <span style={{fontSize:11, opacity:.7}}>{showPast ? "▶" : "◀"}</span>
            </button>
            {/* Close */}
            <button
              onClick={onClose}
              style={{
                background:"rgba(255,255,255,.12)", border:"1.5px solid rgba(255,255,255,.25)",
                borderRadius:8, padding:"6px 12px", cursor:"pointer",
                color:"#fff", fontSize:14, fontWeight:700,
                fontFamily:"DM Sans,sans-serif", transition:"all .15s",
              }}
            >✕ Cancel</button>
          </div>
        </div>

        {/* Form body */}
        <div style={{flex:1, padding:"24px 20px 80px 20px", maxWidth:860, margin:"0 auto", width:"100%", boxSizing:"border-box"}}>
          <MeetingReportForm
            apprentice={apprentice}
            mentor={mentor}
            allUsers={allUsers}
            onSave={onSave}
            onCancel={onClose}
          />
        </div>
      </div>

      {/* Past Reports side panel */}
      <div style={{
        position:"fixed", top:0, right:0, bottom:0, width:400,
        background:"#fff", borderLeft:`1.5px solid ${T.border}`,
        overflowY:"auto", transform: showPast ? "translateX(0)" : "translateX(100%)",
        transition:"transform .25s ease", zIndex:2001, boxShadow:"-4px 0 20px rgba(0,0,0,.1)",
        display:"flex", flexDirection:"column",
      }}>
        <div style={{
          position:"sticky", top:0, zIndex:1,
          background:T.goldL, borderBottom:`1px solid ${T.gold}`,
          padding:"14px 16px", display:"flex", alignItems:"center", justifyContent:"space-between",
        }}>
          <div style={{display:"flex", alignItems:"center", gap:8}}>
            <span style={{fontSize:18}}>📁</span>
            <div style={{fontWeight:700, fontSize:16, color:T.gold}}>Past Reports</div>
          </div>
          <button onClick={() => setShowPast(false)} style={{
            background:"none", border:"none", cursor:"pointer", fontSize:18, color:T.gold, padding:4,
          }}>✕</button>
        </div>
        <div style={{padding:"16px", flex:1}}>
          <PastMeetingReports key={meetingKey} apprentice={apprentice} allUsers={allUsers} canEdit={false}/>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Stable textarea + section-header components for MeetingReportForm
// MUST live outside MeetingReportForm — if defined inside, every keystroke
// recreates them as new component types, unmounting/remounting and losing focus.
const ReportTA = ({rows=4, value, onChange, placeholder}) => (
  <textarea rows={rows} value={value} onChange={onChange} placeholder={placeholder||""}
    style={{width:"100%",fontSize:14,padding:"10px 12px",border:`1px solid ${T.border}`,
      borderTop:"none",borderRadius:0,fontFamily:"DM Sans,sans-serif",background:"#fff",
      resize:"vertical",color:T.ink,outline:"none",boxSizing:"border-box",minHeight:90}}/>
);
const ReportSH = ({children, req}) => (
  <div style={{background:"#f5f7fa",border:`1px solid ${T.border}`,borderBottom:"none",
    padding:"9px 12px",fontWeight:700,fontSize:14,color:T.ink,display:"flex",alignItems:"center",gap:5}}>
    {children}{req&&<span style={{color:T.red,fontSize:12,marginLeft:2}}>*</span>}
  </div>
);

// ── Meeting Report Form — KTA "Apprentice Check In Report" template ───────────

// ─────────────────────────────────────────────────────────────────────────────
// HSE CHECK IN FORM
// ─────────────────────────────────────────────────────────────────────────────
const HSE_FORM_FIELDS = {
  ppe_correct_ppe:            "Is the Apprentice wearing the correct PPE?",
  ppe_suitable_condition:     "Is all PPE suitable for tasks/site and in good condition?",
  site_induction_toolbox:     "Have you completed a Site Induction and are involved in Toolbox Meetings?",
  hazard_register_location:   "Do you know the location of the Hazard Register / Board?",
  allocated_breaks_facilities:"Are you taking allocated breaks and have access to facilities?",
  near_miss_process_aware:    "Are you aware of the process for reporting a Near Miss or Incident?",
  near_miss_involved:         "Since our last Check In, have you been involved in or witnessed any Near Misses or Incidents?",
  jsa_training:               "Have you undergone any training that required Task or Job Safety Analysis?",
  work_within_capabilities:   "Is the work you are doing within your capabilities?",
  host_business_issues:       "Any issues with the Host Business, Supervisor or Team we need to be aware of?",
};

// ── HSE Form sub-components (defined outside to prevent remount on keystroke) ──
function ProgressLineGraph({ snapshots }) {
  if (!snapshots || snapshots.length === 0) return null;

  const sorted = [...snapshots].sort((a, b) => a.months_in_training - b.months_in_training);
  const latest  = sorted[sorted.length - 1];
  const duration = latest.programme_duration || 42;

  // ── Status calculation ──────────────────────────────────────────────────────
  const isPastEnd    = latest.months_in_training > duration;
  // Expected % at current point in time = months_in_training / programme_duration * 100
  const expectedPct  = Math.min(100, (latest.months_in_training / duration) * 100);
  const actualPct    = latest.overall_percent || 0;
  const gap          = actualPct - expectedPct; // positive = ahead, negative = behind

  // Colour thresholds: green ≥ 0, yellow -10 to 0, red < -10
  const statusColor  = gap >= 0 ? "#1a8a7a" : gap >= -10 ? "#b86e1a" : "#bf2b2b";
  const statusBg     = gap >= 0 ? "#d4f0ec" : gap >= -10 ? "#faebd7" : "#fde8e8";
  const statusLabel  = isPastEnd
    ? `Past programme end — ${Math.round(actualPct)}% complete (${Math.round(100 - actualPct)}% remaining)`
    : gap >= 0
      ? `On track / ahead (+${Math.round(gap)}%)`
      : gap >= -10
        ? `Slightly behind (${Math.round(gap)}%)`
        : `Well behind (${Math.round(gap)}%)`;
  const statusIcon   = gap >= 0 ? "✅" : gap >= -10 ? "⚠️" : "🔴";

  const LINES = [
    { key: "overall_percent",     label: "Overall",    color: "#1b4f8c", width: 3.5 },
    { key: "off_job_l3_percent",  label: "Off-Job L3", color: "#1a8a7a", width: 2.5 },
    { key: "off_job_l4_percent",  label: "Off-Job L4", color: "#a07820", width: 2.5 },
    { key: "on_job_core_percent", label: "On-Job Core",color: "#6b4fa0", width: 2.5 },
    { key: "on_job_spec_percent", label: "On-Job Spec", color: "#bf2b2b", width: 2.5 },
  ];

  // X = months, Y = % complete
  const W = 560, H = 240, PAD = { top: 20, right: 70, bottom: 36, left: 44 };
  const IW = W - PAD.left - PAD.right;
  const IH = H - PAD.top  - PAD.bottom;

  // X axis ends exactly at the furthest point — dot always inside
  const maxMonths = Math.max(duration, latest.months_in_training);

  // ~5 ticks across the range
  const candidates = [6, 12, 18, 24, 30, 36];
  const tickInterval = candidates.find(c => Math.floor(maxMonths / c) <= 5) || 36;

  const xS = (m) => PAD.left + (Math.min(m, maxMonths) / maxMonths) * IW;
  const yS = (p) => PAD.top + IH - (Math.min(p, 100) / 100) * IH;

  const [hover, setHover] = useState(null);

  const yTicks = [0, 25, 50, 75, 100];
  // X ticks: at interval steps, always include 0 and duration
  const xTickSet = new Set([0, duration]);
  for (let m = tickInterval; m <= maxMonths; m += tickInterval) xTickSet.add(m);
  const xTicks = [...xTickSet].sort((a, b) => a - b);

  // Expected diagonal: (0,0%) → (duration,100%) — stops at programme end
  const expX1 = xS(0),        expY1 = yS(0);
  const expX2 = xS(duration), expY2 = yS(100);

  // Black dot: where apprentice SHOULD be at current month (capped at programme end)
  const expDotM   = Math.min(latest.months_in_training, duration);
  const expDotPct = Math.min(100, (expDotM / duration) * 100);
  const expDotX   = xS(expDotM);
  const expDotY   = yS(expDotPct);

  // Current position
  const curX = xS(latest.months_in_training);
  const curY = yS(actualPct);

  return (
    <div style={{ fontFamily: "DM Sans, Arial, sans-serif" }}>

      {/* ── Status banner ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
        background: statusBg, borderRadius: 10, border: `1.5px solid ${statusColor}44`,
        marginBottom: 12 }}>
        <span style={{ fontSize: 22 }}>{statusIcon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: statusColor }}>{statusLabel}</div>
          <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>
            At month <strong>{latest.months_in_training}</strong> of <strong>{duration}</strong> —
            expected <strong>{Math.round(expectedPct)}%</strong>, actual <strong>{Math.round(actualPct)}%</strong>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: statusColor, lineHeight: 1 }}>
            {Math.round(actualPct)}%
          </div>
          <div style={{ fontSize: 10, color: T.muted }}>overall</div>
        </div>
      </div>

      {/* ── Timeline bar ── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11,
          color: T.muted, marginBottom: 4 }}>
          <span>Start</span>
          <span style={{ color: statusColor, fontWeight: 700 }}>
            ▼ Month {latest.months_in_training} — {Math.round(actualPct)}% complete
          </span>
          <span>End (month {duration})</span>
        </div>
        {/* Duration bar */}
        <div style={{ position: "relative", height: 28, borderRadius: 6,
          background: "#e8edf4", overflow: "visible" }}>
          {/* Expected progress (grey fill) */}
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0,
            width: `${(latest.months_in_training / duration) * 100}%`,
            background: "#c4cdd8", borderRadius: "6px 0 0 6px", transition: "width .4s" }}/>
          {/* Actual progress (coloured fill) */}
          <div style={{ position: "absolute", left: 0, top: 4, bottom: 4,
            width: `${Math.min((actualPct / 100) * (latest.months_in_training / duration) * 100, 100)}%`,
            background: statusColor, borderRadius: 4, transition: "width .4s",
            opacity: 0.9 }}/>
          {/* "You are here" marker */}
          <div style={{ position: "absolute", top: -4, bottom: -4,
            left: `${(latest.months_in_training / duration) * 100}%`,
            width: 3, background: T.ink, borderRadius: 2, transform: "translateX(-50%)" }}/>
          {/* Expected marker */}
          <div style={{ position: "absolute", top: 2, bottom: 2,
            left: `${Math.min((expectedPct / 100) * (latest.months_in_training / duration) * 100, 100)}%`,
            width: 2, background: "#fff", borderRadius: 1,
            opacity: 0.8, transform: "translateX(-50%)" }}/>
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 6, fontSize: 11 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ display: "inline-block", width: 12, height: 3, background: statusColor, borderRadius: 2 }}/>
            <span style={{ color: T.sub }}>Actual progress</span>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ display: "inline-block", width: 12, height: 3, background: "#c4cdd8", borderRadius: 2 }}/>
            <span style={{ color: T.sub }}>Time elapsed</span>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ display: "inline-block", width: 3, height: 12, background: T.ink, borderRadius: 1 }}/>
            <span style={{ color: T.sub }}>Current month</span>
          </span>
        </div>
      </div>

      {/* ── Line graph ── */}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>

        {/* Y gridlines + labels */}
        {yTicks.map(t => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + IW} y1={yS(t)} y2={yS(t)}
              stroke={t===0?"#c4cdd8":"#eef1f6"} strokeWidth={t===0?1.5:1}/>
            <text x={PAD.left - 6} y={yS(t) + 4} textAnchor="end" fontSize="10" fill="#94a3b8">{t}%</text>
          </g>
        ))}

        {/* X tick marks + labels — no vertical grid lines */}
        {xTicks.map(m => {
          const isEnd = m === duration;
          return (
            <g key={m}>
              <line x1={xS(m)} x2={xS(m)} y1={PAD.top + IH} y2={PAD.top + IH + (isEnd ? 6 : 4)}
                stroke={isEnd ? "#1b4f8c" : "#c4cdd8"} strokeWidth={isEnd ? 2 : 1}/>
              <text x={xS(m)} y={PAD.top + IH + 16} textAnchor="middle"
                fontSize={isEnd ? 9.5 : 9.5}
                fill={isEnd ? "#1b4f8c" : "#94a3b8"}
                fontWeight={isEnd ? 700 : 400}>
                {m}m{isEnd ? " ★" : ""}
              </text>
            </g>
          );
        })}

        {/* Expected diagonal */}
        <line x1={expX1} y1={expY1} x2={expX2} y2={expY2}
          stroke="#b0bec8" strokeWidth="1.5" strokeDasharray="5,4"/>
        <text x={expX2 + 5} y={expY2 + 4} textAnchor="start" fontSize="9" fill="#94a3b8">Expected</text>

        {/* Data lines */}
        {LINES.map(({ key, color, width }) => {
          const pts = sorted.filter(s => s[key] != null);
          if (pts.length < 1) return null;
          const points = pts.map(s => `${xS(s.months_in_training)},${yS(s[key])}`).join(" ");
          return (
            <polyline key={key} points={points} fill="none"
              stroke={color} strokeWidth={width}
              strokeLinejoin="round" strokeLinecap="round"/>
          );
        })}

        {/* Data dots + labels */}
        {sorted.map((s, si) =>
          LINES.map(({ key, color }) => {
            if (s[key] == null) return null;
            const dx = xS(s.months_in_training), dy = yS(s[key]);
            const isOverall = key === "overall_percent";
            const lx = dx > PAD.left + IW * 0.78 ? dx - 7 : dx + 7;
            const la = dx > PAD.left + IW * 0.78 ? "end" : "start";
            return (
              <g key={`${si}-${key}`}>
                <circle cx={dx} cy={dy} r={isOverall ? 5 : 3}
                  fill={color} stroke="#fff" strokeWidth={isOverall?2:1.5}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHover({ s, key, color })}
                  onMouseLeave={() => setHover(null)}/>
                {isOverall && (
                  <text x={lx} y={dy - 7} textAnchor={la} fontSize="9" fill={color} fontWeight="700">
                    {Math.round(s[key])}%
                  </text>
                )}
              </g>
            );
          })
        )}

        {/* Expected pace dot — black dot where apprentice should be */}
        <circle cx={expDotX} cy={expDotY} r="5" fill="#0d1b2e" stroke="#fff" strokeWidth="2"/>
        <text x={expDotX + 8} y={expDotY - 8} textAnchor="start" fontSize="9" fill="#0d1b2e" fontWeight="700">
          {Math.round(expDotPct)}%
        </text>

        {/* Current position dot — always label to the left and above */}
        <circle cx={curX} cy={curY} r="7" fill={statusColor} stroke="#fff" strokeWidth="2.5"/>
        <text x={curX - 11} y={curY - 11} textAnchor="end"
          fontSize="9" fill={statusColor} fontWeight="700">
          {Math.round(actualPct)}%{isPastEnd ? " ↑ past end" : ` · m${latest.months_in_training}`}
        </text>

        {/* Hover tooltip */}
        {hover && (() => {
          const dx = xS(hover.s.months_in_training);
          const dy = yS(hover.s[hover.key]);
          const label = LINES.find(l => l.key === hover.key)?.label || "";
          const right = dx > PAD.left + IW * 0.65;
          const ox = right ? -42 : 42;
          return (
            <g>
              <rect x={dx - (right?84:0) + (right?-10:10)} y={dy - 28} width={84} height={38}
                rx="5" fill="#0d1b2e" opacity="0.9"/>
              <text x={dx + ox} y={dy - 15} textAnchor="middle" fontSize="10" fill="#fff" fontWeight="700">{label}</text>
              <text x={dx + ox} y={dy} textAnchor="middle" fontSize="11" fill="#fff">
                {Math.round(hover.s[hover.key])}% · m{hover.s.months_in_training}
              </text>
            </g>
          );
        })()}

        {/* Axes */}
        <line x1={PAD.left} x2={PAD.left + IW} y1={PAD.top + IH} y2={PAD.top + IH} stroke="#c4cdd8" strokeWidth="1.5"/>
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + IH} stroke="#c4cdd8" strokeWidth="1.5"/>
        <text x={PAD.left + IW / 2} y={H - 2} textAnchor="middle" fontSize="10" fill="#94a3b8">Months in Training</text>
        <text x={9} y={PAD.top + IH / 2} textAnchor="middle" fontSize="10" fill="#94a3b8"
          transform={`rotate(-90, 9, ${PAD.top + IH / 2})`}>% Complete</text>
      </svg>

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 6 }}>
        {LINES.map(({ key, label, color }) => {
          if (!snapshots.some(s => s[key] != null)) return null;
          return (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
              <div style={{ width: key==="overall_percent"?22:16, height: key==="overall_percent"?3:2,
                background: color, borderRadius: 2 }}/>
              <span style={{ color: T.sub, fontWeight: key==="overall_percent"?700:400 }}>{label}</span>
            </div>
          );
        })}
        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
          <div style={{ display:"flex", alignItems:"center", gap:3 }}>
            <div style={{ width: 14, height: 2, background: "#b0bec8", borderRadius:1 }}/>
            <div style={{ width:6, height:6, borderRadius:"50%", background:"#0d1b2e", border:"1.5px solid #fff", outline:"1px solid #0d1b2e" }}/>
          </div>
          <span style={{ color: T.muted }}>Expected pace</span>
        </div>
      </div>

      {/* Section summary cards */}
      {(() => {
        const sections = [
          { label: "Skills Week",  val: latest.skills_week_percent },
          { label: "Off-Job L3",   val: latest.off_job_l3_percent },
          { label: "Off-Job L4",   val: latest.off_job_l4_percent },
          { label: "On-Job Core",  val: latest.on_job_core_percent },
          { label: "On-Job Spec",  val: latest.on_job_spec_percent },
          { label: "On Job Books", val: latest.booklets_percent },
        ].filter(s => s.val != null);
        if (sections.length === 0) return null;
        return (
          <div style={{ marginTop: 10, display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(110px,1fr))", gap: 6 }}>
            {sections.map(({ label, val }) => {
              const c = val >= 100 ? T.teal : val >= 75 ? T.accent : val >= 50 ? T.warn : T.red;
              return (
                <div key={label} style={{ background: T.bg, borderRadius: 8, padding: "6px 10px",
                  border: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: T.muted,
                    textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: c }}>{Math.round(val)}%</div>
                  <div style={{ height: 4, background: T.border, borderRadius: 2, marginTop: 4 }}>
                    <div style={{ height: 4, borderRadius: 2, width: `${Math.min(val,100)}%`,
                      background: c, transition: "width .4s" }}/>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

function ProgressSnapshotPanel({ apprenticeId, canDelete=false }) {
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [parsing, setParsing]     = useState(false);
  const [parseMsg, setParseMsg]   = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    loadTable("progress_snapshots")
      .then(rows => setSnapshots((rows||[]).filter(r=>r.apprentice_id===apprenticeId)))
      .catch(() => setSnapshots([]))
      .finally(() => setLoading(false));
  }, [apprenticeId]);

  // Parse EarnLearn PDF text locally using pdf.js — no API calls or credits needed.
  // Extracts credit totals and booklet counts using regex patterns matched to
  // the consistent EarnLearn report format.
  const parseEarnLearnText = (text) => {
    const n = (s) => { const v = parseFloat(s); return isNaN(v) ? null : v; };
    const pct = (achieved, required) => required > 0 ? Math.round((achieved / required) * 100 * 10) / 10 : null;

    // Booklet data date — "Booklet Data as at DD Mon YYYY"
    let report_date = null;
    const dateM = text.match(/Booklet Data as at\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i);
    if (dateM) {
      const months = {jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
                      jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
      const mo = months[dateM[2].toLowerCase().slice(0,3)] || "01";
      report_date = `${dateM[3]}-${mo}-${String(dateM[1]).padStart(2,"0")}`;
    }

    // Programme row: "Active DD/MM/YYYY DD/MM/YYYY  42  22"
    let months_in_training = null, programme_duration = null;
    const progM = text.match(/Active\s+[\d/]+\s+[\d/]+\s+(\d+)\s+(\d+)/);
    if (progM) { programme_duration = n(progM[1]); months_in_training = n(progM[2]); }

    // Summary table: "Section  Credits Required  Credits Achieved  % Complete"
    // Pattern: look for "Totals NNN NNN NN%"
    const totalsM = text.match(/Totals\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)%/i);
    const overall_percent = totalsM ? n(totalsM[3]) : null;

    // Section totals from "Credits required to complete X  NNN" and "Total Credits Achieved  NNN"
    // sectionPct removed — using summarySection instead

    // Use the Unit Standard Achievement Summary table (page 5) which is most reliable
    const summarySection = (label) => {
      const re = new RegExp(label + "\\s+(\\d+)\\s+(\\d+)\\s+([\\d.]+)%", "i");
      const m = text.match(re);
      return m ? n(m[3]) : null;
    };
    const skills_week_percent  = summarySection("Skills Week/Trade Start");
    const off_job_l3_percent   = summarySection("Off Job Unit Standards.*?Level 3");
    const off_job_l4_percent   = summarySection("Off Job Unit Standards.*?Level 4");
    const on_job_core_percent  = summarySection("On Job Unit Standards.*?Core");
    const on_job_spec_percent  = summarySection("On Job Unit Standards.*?(?:Domestic|Speciality|Specialty)");

    // Booklets — "Booklets Completed  N  NN.N%"
    const bookM = text.match(/Booklets Completed\s+(\d+)\s+([\d.]+)%/i);
    const booklets_percent = bookM ? n(bookM[2]) : null;

    return {
      report_date, months_in_training, programme_duration,
      overall_percent, skills_week_percent, off_job_l3_percent,
      off_job_l4_percent, on_job_core_percent, on_job_spec_percent,
      booklets_percent,
    };
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf") { setParseMsg("❌ Please upload a PDF file."); return; }

    setParsing(true);
    setParseMsg("📄 Reading PDF…");

    try {
      // Load pdf.js from CDN
      if (!window.pdfjsLib) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      }

      // Read file as ArrayBuffer
      const arrayBuf = await file.arrayBuffer();
      setParseMsg("📄 Extracting text…");

      const pdf = await window.pdfjsLib.getDocument({ data: arrayBuf }).promise;
      let fullText = "";
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc   = await page.getTextContent();
        fullText += tc.items.map(i => i.str).join(" ") + "\n";
      }

      setParseMsg("🔍 Parsing progress data…");
      const parsed = parseEarnLearnText(fullText);

      if (!parsed.months_in_training) {
        throw new Error("Could not find training data in PDF. Please check this is an EarnLearn progress report.");
      }

      // Check if snapshot for this month already exists
      const thisMonth = parsed.report_date?.slice(0, 7);
      const alreadyExists = snapshots.some(s => s.report_date?.slice(0, 7) === thisMonth);
      if (alreadyExists) {
        setParseMsg("⚠️ A snapshot for this month already exists. Delete it first to replace it.");
        setParsing(false);
        return;
      }

      const snapshot = {
        id:                  uid(),
        apprentice_id:       apprenticeId,
        uploaded_at:         new Date().toISOString(),
        report_date:         parsed.report_date || new Date().toISOString().slice(0, 10),
        months_in_training:  parsed.months_in_training,
        programme_duration:  parsed.programme_duration,
        overall_percent:     parsed.overall_percent,
        skills_week_percent: parsed.skills_week_percent,
        off_job_l3_percent:  parsed.off_job_l3_percent,
        off_job_l4_percent:  parsed.off_job_l4_percent,
        on_job_core_percent: parsed.on_job_core_percent,
        on_job_spec_percent: parsed.on_job_spec_percent,
        booklets_percent:    parsed.booklets_percent,
      };

      await upsertRow("progress_snapshots", snapshot);
      setSnapshots(prev => [...prev, snapshot].sort((a,b)=>a.months_in_training-b.months_in_training));
      setParseMsg(`✅ Snapshot saved — ${parsed.months_in_training} months in training, ${Math.round(parsed.overall_percent)}% complete.`);
    } catch (e) {
      console.error("Snapshot parse error:", e);
      setParseMsg("❌ Failed to parse PDF: " + e.message);
    }

    setParsing(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const deleteSnapshot = async (id) => {
    if (!await ktaConfirm("Delete this progress snapshot?")) return;
    await deleteRow("progress_snapshots", id).catch(console.error);
    setSnapshots(prev => prev.filter(s => s.id !== id));
  };

  const fmtD = iso => { if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };

  return (
    <div>
      {/* Upload strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <input ref={fileRef} type="file" accept="application/pdf" onChange={handleFile}
          style={{ display: "none" }} id="earnlearn-upload"/>
        <label htmlFor="earnlearn-upload"
          style={{ display: "inline-flex", alignItems: "center", gap: 6,
            padding: "7px 14px", background: T.accentL, color: T.accent,
            border: `1.5px solid ${T.accent}44`, borderRadius: 8, cursor: parsing ? "not-allowed" : "pointer",
            fontWeight: 700, fontSize: 13, fontFamily: "DM Sans, sans-serif",
            opacity: parsing ? 0.6 : 1 }}>
          {parsing ? "⏳ Parsing…" : "📄 Upload EarnLearn PDF"}
        </label>
        {parseMsg && (
          <span style={{ fontSize: 13, color: parseMsg.startsWith("✅") ? T.teal :
            parseMsg.startsWith("❌") ? T.red : parseMsg.startsWith("⚠") ? T.warn : T.sub }}>
            {parseMsg}
          </span>
        )}
        <span style={{ fontSize: 12, color: T.muted, marginLeft: "auto" }}>
          Upload once a month to track progress
        </span>
      </div>

      {/* Graph */}
      {!loading && snapshots.length > 0 && (
        <ProgressLineGraph snapshots={snapshots}/>
      )}
      {!loading && snapshots.length === 0 && (
        <div style={{ textAlign: "center", padding: "24px 0", color: T.muted, fontSize: 13,
          border: `1.5px dashed ${T.border}`, borderRadius: 10 }}>
          📈 No progress data yet — upload an EarnLearn PDF to get started
        </div>
      )}

      {/* Snapshot history */}
      {snapshots.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase",
            letterSpacing: ".6px", marginBottom: 6 }}>Snapshots</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {snapshots.map(s => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px",
                background: T.bg, border: `1px solid ${T.border}`, borderRadius: 20, fontSize: 12 }}>
                <span style={{ fontWeight: 700, color: T.ink }}>{fmtD(s.report_date)}</span>
                <span style={{ color: T.teal, fontWeight: 700 }}>{Math.round(s.overall_percent)}%</span>
                <span style={{ color: T.muted }}>· {s.months_in_training}m</span>
                {canDelete && (
                  <button onClick={() => deleteSnapshot(s.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: T.muted,
                      fontSize: 13, lineHeight: 1, padding: 0, marginLeft: 2 }}>✕</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MeetingReportForm({apprentice, mentor, allUsers, onSave, onCancel}) {
  const today = new Date().toISOString().slice(0,10);
  const approver = allUsers.find(u=>
    u.id === apprentice.approverUserId ||
    (u.role==="Approver" && (u.allocatedTo||[]).includes(apprentice.id))
  );
  const [form, setForm] = useState({
    date: today, location: "",
    offJobProgress: "", onJobProgress: "",
    previousGoals: "", goalsNextVisit: "",
    commentsFeedback: "", nextVisitDate: "",
  });
  const [saving, setSaving]           = useState(false);
  const [emailStatus, setEmailStatus] = useState(null);
  const [prevGoalsSource, setPrevGoalsSource] = useState(null);
  const [ccEmails, setCcEmails]       = useState([]); // extra CC recipients
  const [companyContacts, setCompanyContacts] = useState([]); // contacts from apprentice's company
  const [showAddEmail, setShowAddEmail] = useState(false);
  const [customEmail, setCustomEmail]   = useState("");
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));
  const [draftId, setDraftId]         = useState(null);   // id of existing draft if found
  const [draftSaved, setDraftSaved]   = useState(false);  // flash confirmation
  const [savingDraft, setSavingDraft] = useState(false);

  // Load contacts for the apprentice's host business
  useEffect(()=>{
    if(!apprentice.hostBusiness) return;
    loadTable('crm_contacts').then(rows=>{
      loadTable('crm_companies').then(cos=>{
        const co = cos.find(c=>(c.name||"").toLowerCase().trim()===(apprentice.hostBusiness||"").toLowerCase().trim());
        const linked = rows.filter(r=>
          (co && r.company_id===co.id) ||
          (!r.company_id && (r.company||"").toLowerCase().trim()===(apprentice.hostBusiness||"").toLowerCase().trim())
        ).filter(r=>r.email);
        setCompanyContacts(linked.map(r=>({name:r.name,email:r.email})));
      }).catch(()=>{});
    }).catch(()=>{});
  },[apprentice.hostBusiness]);

  const addCc = (email, name) => {
    if(!email || ccEmails.find(x=>x.email===email)) return;
    setCcEmails(prev=>[...prev, {email, name:name||email}]);
  };
  const removeCc = (email) => setCcEmails(prev=>prev.filter(x=>x.email!==email));

  const fD = (iso) => { if(!iso) return "—"; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };

  // On mount: load any existing draft, then pre-fill previousGoals from last completed report
  useEffect(() => {
    loadTable('meeting_reports').then(reports => {
      const all = reports || [];
      // Check for draft first
      const draft = all
        .filter(r => r.apprentice_id === apprentice.id && r.status === 'draft')
        .sort((a,b) => (b.created_at||"").localeCompare(a.created_at||""))[0];
      if(draft) {
        setDraftId(draft.id);
        setForm({
          date:             draft.date || new Date().toISOString().slice(0,10),
          location:         draft.location || "",
          offJobProgress:   draft.off_job_progress || "",
          onJobProgress:    draft.on_job_progress || "",
          previousGoals:    draft.previous_goals || "",
          goalsNextVisit:   draft.goals_this_meeting || "",
          commentsFeedback: draft.comments_feedback || "",
          nextVisitDate:    draft.next_visit_date || "",
        });
        return; // don't overwrite draft with auto-fill
      }
      // No draft — pre-fill Previous Goals from last completed report
      const past = all
        .filter(r => r.apprentice_id === apprentice.id && r.goals_this_meeting?.trim() && r.status !== 'draft')
        .sort((a,b) => (b.date||b.created_at||"").localeCompare(a.date||a.created_at||""));
      if(past.length > 0) {
        const last = past[0];
        setForm(f => ({ ...f, previousGoals: last.goals_this_meeting.trim() }));
        setPrevGoalsSource(last.date || last.created_at?.slice(0,10));
      }
    }).catch(() => {});
  }, [apprentice.id]);

  const handleSaveDraft = async () => {
    setSavingDraft(true);
    const id = draftId || uid();
    const report = {
      id, apprentice_id: apprentice.id, mentor_id: mentor?.id || null,
      date: form.date, location: form.location.trim(),
      off_job_progress:   form.offJobProgress.trim(),
      on_job_progress:    form.onJobProgress.trim(),
      previous_goals:     form.previousGoals.trim(),
      goals_this_meeting: form.goalsNextVisit.trim(),
      comments_feedback:  form.commentsFeedback.trim(),
      next_visit_date:    form.nextVisitDate || null,
      status:             'draft',
      created_at:         new Date().toISOString(),
    };
    try {
      await upsertRow('meeting_reports', report);
      setDraftId(id);
      setDraftSaved(true);
      setTimeout(() => setDraftSaved(false), 2500);
    } catch(e) {
      alert('Draft save failed: ' + e.message);
    }
    setSavingDraft(false);
  };

  const handleSave = async () => {
    if(!form.commentsFeedback.trim() && !form.onJobProgress.trim()) {
      alert("Please fill in at least On Job Progress or Comments & Feedback."); return;
    }
    setSaving(true);
    const report = {
      id: draftId || uid(), apprentice_id: apprentice.id, mentor_id: mentor?.id || null,
      date: form.date, location: form.location.trim(),
      off_job_progress:  form.offJobProgress.trim(),
      on_job_progress:   form.onJobProgress.trim(),
      previous_goals:    form.previousGoals.trim(),
      goals_this_meeting: form.goalsNextVisit.trim(),
      comments_feedback: form.commentsFeedback.trim(),
      next_visit_date:   form.nextVisitDate || null,
      status:            'complete',
      created_at:        new Date().toISOString(),
    };
    try {
      await upsertRow('meeting_reports', report);
      setEmailStatus("sending");
      // Load latest progress snapshots to include graph in PDF
      let reportSnapshots = [];
      try {
        const snaps = await loadTable("progress_snapshots");
        reportSnapshots = (snaps||[]).filter(s=>s.apprentice_id===apprentice.id);
      } catch(e) { console.warn("Could not load snapshots for PDF:", e); }
      await sendMeetingReportEmail(report, apprentice, mentor, approver, ccEmails, mentor?.email || null, reportSnapshots);
      setEmailStatus("sent");
      setTimeout(()=>onSave(report), 1200);
    } catch(e) {
      console.error("Report save/email error:", e);
      setEmailStatus("error");
      const msg = e.message || "";
      if(msg.includes("No valid email")) {
        alert(`Report saved ✓\n\nEmail could not be sent:\n${msg}`);
      } else if(msg.includes("Email send failed") || msg.includes("Failed to fetch") || msg.includes("fetch")) {
        alert(`Report saved ✓\n\nEmail failed — the email-proxy Edge Function may not be deployed yet.\n\nTo fix: run\n  node kta-deploy-functions.cjs email-proxy\n\nError: ${msg}`);
      } else {
        alert(`Report saved ✓\n\nEmail error: ${msg}`);
      }
      setTimeout(()=>onSave(report), 500);
      setSaving(false);
    }
  };

  return (
    <div style={{border:`1.5px solid ${T.border}`,borderRadius:10,background:"#fff"}}>
      {/* KTA Header */}
      <div style={{background:T.dark,padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontFamily:"DM Sans",fontWeight:700,fontSize:18,color:"#fff"}}>Apprentice Check In Report</div>
          <div style={{fontSize:12,color:"#ffffff88",marginTop:2}}>Kiwi Trade Apprentices</div>
        </div>
        <img src={KTA_LOGO} alt="KTA" style={{height:36,objectFit:"contain",filter:"brightness(0) invert(1)"}}
          onError={e=>e.target.style.display="none"}/>
      </div>

      {/* Top table — Trainee Name / Location / Date */}
      <div style={{border:`1px solid ${T.border}`,borderTop:"none"}}>
        {[
          {label:"Trainee Name", content:<div style={{padding:"4px 6px",fontSize:14,fontWeight:700}}>{apprentice.name}</div>},
          {label:"Location",     content:<input value={form.location} onChange={e=>sf("location",e.target.value)}
            placeholder="e.g. Worksite, Zoom, Head Office"
            onKeyDown={e=>e.stopPropagation()}
            style={{border:"none",fontSize:14,width:"100%",outline:"none",padding:"6px",fontFamily:"DM Sans,sans-serif",background:"transparent"}}/>},
          {label:"Date",         content:<div style={{position:"relative"}}><input type="date" value={form.date} onChange={e=>sf("date",e.target.value)}
            className="ts-date-input"
            style={{border:"none",fontSize:14,width:"100%",outline:"none",padding:"6px",fontFamily:"DM Sans,sans-serif",background:"transparent",cursor:"pointer"}}/></div>},
        ].map(({label,content})=>(
          <div key={label} style={{display:"grid",gridTemplateColumns:"160px 1fr",borderBottom:`1px solid ${T.border}`}}>
            <div style={{padding:"10px 12px",fontWeight:700,fontSize:14,borderRight:`1px solid ${T.border}`,background:"#f5f7fa"}}>{label}</div>
            <div>{content}</div>
          </div>
        ))}
      </div>

      {/* Main sections */}
      <div style={{border:`1px solid ${T.border}`,borderTop:"none"}}>
        <ReportSH>Off Job Progress Since Last Visit</ReportSH>
        <ReportTA rows={4} value={form.offJobProgress} onChange={e=>sf("offJobProgress",e.target.value)}
          placeholder="Training courses, assessments, NZQA unit standards, classroom learning…"/>
        <ReportSH>On Job Progress Since Last Visit</ReportSH>
        <ReportTA rows={4} value={form.onJobProgress} onChange={e=>sf("onJobProgress",e.target.value)}
          placeholder="Practical skills, site work, tasks completed, employer feedback…"/>
        <ReportSH>Previous Goals</ReportSH>
        {prevGoalsSource && (
          <div style={{fontSize:12,color:T.teal,marginBottom:4,paddingLeft:2}}>
            ✓ Auto-filled from report dated {prevGoalsSource.split('-').reverse().join('/')} — edit as needed
          </div>
        )}
        <ReportTA rows={4} value={form.previousGoals} onChange={e=>sf("previousGoals",e.target.value)}
          placeholder="Goals set at the last visit — have they been met?"/>
        <ReportSH req>Goals Before Next Visit</ReportSH>
        <ReportTA rows={4} value={form.goalsNextVisit} onChange={e=>sf("goalsNextVisit",e.target.value)}
          placeholder="Specific goals for the apprentice to work toward before the next visit…"/>
        <ReportSH req>Comments and Feedback</ReportSH>
        <ReportTA rows={5} value={form.commentsFeedback} onChange={e=>sf("commentsFeedback",e.target.value)}
          placeholder="Overall summary, observations, any concerns or positive feedback…"/>
      </div>

      {/* EarnLearn Progress Graph */}
      <div style={{border:`1px solid ${T.border}`,borderTop:"none",padding:"14px 16px",background:"#fafbfd"}}>
        <div style={{fontWeight:700,fontSize:13,color:T.dark,textTransform:"uppercase",
          letterSpacing:".6px",marginBottom:10,display:"flex",alignItems:"center",gap:8}}>
          📈 Programme Progress
          <span style={{fontSize:11,fontWeight:400,color:T.muted,textTransform:"none",letterSpacing:0}}>
            Upload the monthly EarnLearn PDF to update the graph
          </span>
        </div>
        <ProgressSnapshotPanel apprenticeId={apprentice.id} canDelete={mentor?.role==="Admin"}/>
      </div>

      {/* Bottom table — Licence Expiry / Next Visit / KTA Rep */}
      <div style={{border:`1px solid ${T.border}`,borderTop:"none"}}>
        {[
          {label:"Licence Expiry",      content:<div style={{padding:"6px",fontSize:14,fontWeight:700,
            color: apprentice.licenceExpiry && new Date(apprentice.licenceExpiry+"T00:00:00")<new Date() ? T.red : T.ink}}>
            {apprentice.licenceExpiry ? fD(apprentice.licenceExpiry) : "Not set"}</div>},
          {label:"Date of Next Visit",  content:<input type="date" value={form.nextVisitDate} onChange={e=>sf("nextVisitDate",e.target.value)}
            style={{border:"none",fontSize:14,width:"100%",outline:"none",padding:"6px",fontFamily:"DM Sans,sans-serif",background:"transparent"}}/>},
          {label:"KTA Representative",  content:<div style={{padding:"6px",fontSize:14,fontWeight:700}}>{mentor?.name||"—"}</div>},
        ].map(({label,content})=>(
          <div key={label} style={{display:"grid",gridTemplateColumns:"180px 1fr",borderBottom:`1px solid ${T.border}`}}>
            <div style={{padding:"10px 12px",fontWeight:700,fontSize:14,borderRight:`1px solid ${T.border}`,background:"#f5f7fa"}}>{label}</div>
            <div>{content}</div>
          </div>
        ))}
      </div>

      {/* Email notice + save */}
      <div style={{padding:"14px 16px 40px 16px",background:T.bg,borderTop:`1px solid ${T.border}`}}>
        <div style={{fontSize:13,color:T.accent,marginBottom:12,padding:"8px 12px",
          background:T.accentL,borderRadius:7,border:`1px solid ${T.accent}33`}}>
          📧 On save this report will be emailed to:
          {apprentice.reportsEmail
            ? <>{apprentice.reportsEmail.split(",").map(e=>e.trim()).filter(Boolean).map((e,i)=>(
                <span key={e}>{i>0?", ":""}<strong>{e}</strong></span>
              ))} <span style={{color:T.muted}}>(Reports Go To)</span></>
            : approver
              ? <><strong>{approver.name}</strong>{approver.email?` (${approver.email})`:` — ⚠ no email set`}</>
              : <span style={{color:T.warn}}> ⚠ no approver linked to this apprentice and no Reports Go To address set</span>
          }
        </div>
        {/* ── Additional CC recipients ── */}
        <div style={{marginBottom:12}}>
          <div style={{marginBottom:6,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
            <button onClick={()=>setShowAddEmail(s=>!s)} style={{fontSize:12,padding:"4px 12px",borderRadius:6,border:`1px solid ${T.border}`,background:T.surface,color:T.sub,cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
              {showAddEmail?"✕ Close":"+ Add recipient"}
            </button>
          </div>

          {/* Existing CC tags */}
          {ccEmails.length>0&&(
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
              {ccEmails.map(r=>(
                <div key={r.email} style={{display:"flex",alignItems:"center",gap:6,padding:"3px 10px",borderRadius:20,background:T.tealL,border:`1px solid ${T.teal}44`,fontSize:13,fontWeight:700,color:T.teal}}>
                  <span>{r.name}</span>
                  <span style={{fontSize:11,fontWeight:700,color:T.muted}}>({r.email})</span>
                  <button onClick={()=>removeCc(r.email)} style={{background:"none",border:"none",cursor:"pointer",color:T.teal,fontSize:14,lineHeight:1,padding:0,fontFamily:"DM Sans,sans-serif"}}>✕</button>
                </div>
              ))}
            </div>
          )}

          {/* Dropdown picker */}
          {showAddEmail&&(
            <div style={{background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:10,padding:"12px 14px"}}>
              {companyContacts.length>0&&(
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:6}}>
                    🏢 {apprentice.hostBusiness} Contacts
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    {companyContacts.map(c=>{
                      const already = !!ccEmails.find(x=>x.email===c.email);
                      return (
                        <button key={c.email} onClick={()=>{if(!already){addCc(c.email,c.name);setShowAddEmail(false);}}}
                          disabled={already}
                          style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 12px",
                            borderRadius:8,border:`1.5px solid ${already?T.teal:T.border}`,
                            background:already?T.tealL:"#fff",cursor:already?"default":"pointer",
                            fontFamily:"DM Sans,sans-serif",textAlign:"left",transition:"all .12s"}}>
                          <div>
                            <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{c.name}</div>
                            <div style={{fontSize:12,color:T.muted}}>{c.email}</div>
                          </div>
                          {already
                            ? <span style={{fontSize:12,fontWeight:700,color:T.teal}}>✓ Added</span>
                            : <span style={{fontSize:12,color:T.accent,fontWeight:700}}>+ Add</span>
                          }
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Type a new address */}
              <div style={{borderTop:companyContacts.length>0?`1px solid ${T.border}`:"none",paddingTop:companyContacts.length>0?10:0}}>
                <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:6}}>
                  ✉ Enter email manually
                </div>
                <div style={{display:"flex",gap:6}}>
                  <input
                    type="email"
                    placeholder="name@company.co.nz"
                    value={customEmail}
                    onChange={e=>setCustomEmail(e.target.value)}
                    onKeyDown={e=>{if(e.key==="Enter"&&customEmail.includes("@")){addCc(customEmail.trim(),customEmail.trim());setCustomEmail("");setShowAddEmail(false);}}}
                    style={{flex:1,fontSize:14}}
                  />
                  <Btn sm onClick={()=>{if(customEmail.includes("@")){addCc(customEmail.trim(),customEmail.trim());setCustomEmail("");setShowAddEmail(false);}else{alert("Enter a valid email address.");}}}>
                    Add
                  </Btn>
                </div>
              </div>
            </div>
          )}
        </div>

        {emailStatus==="sending"&&<div style={{background:T.warnL,border:`1px solid ${T.warn}44`,borderRadius:7,padding:"8px 12px",marginBottom:10,fontSize:13,color:T.warn}}>⏳ Sending emails…</div>}
        {emailStatus==="sent"&&<div style={{background:T.tealL,border:`1px solid ${T.teal}44`,borderRadius:7,padding:"8px 12px",marginBottom:10,fontSize:13,color:T.teal}}>✓ Saved and emailed!</div>}
        {emailStatus==="error"&&<div style={{background:T.redL,border:`1px solid ${T.red}44`,borderRadius:7,padding:"8px 12px",marginBottom:10,fontSize:13,color:T.red}}>⚠ Report saved but email failed — check Edge Function deployment.</div>}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <Btn onClick={handleSave} disabled={saving}>{saving?"Saving…":"💾 Save & Email Report"}</Btn>
          {!emailStatus&&(
            <button onClick={handleSaveDraft} disabled={savingDraft}
              style={{padding:"9px 18px",borderRadius:9,fontSize:14,fontWeight:700,cursor:"pointer",
                background:T.surface,color:T.sub,border:`1.5px solid ${T.border}`,
                fontFamily:"DM Sans,sans-serif",opacity:savingDraft?0.6:1,transition:"all .14s"}}>
              {savingDraft?"Saving…":draftId?"💾 Update Draft":"💾 Save Draft"}
            </button>
          )}
          <Btn v="ghost" onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Past Meeting Reports ──────────────────────────────────────────────────────
function PastMeetingReports({apprentice, allUsers, canEdit=false, isAdmin1=false}) {
  const [reports, setReports]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [expandId, setExpandId] = useState(null);

  useEffect(()=>{
    loadTable('meeting_reports')
      .then(rows=>setReports(rows.filter(r=>r.apprentice_id===apprentice.id && r.status!=='draft').sort((a,b)=>(b.date||"").localeCompare(a.date||""))))
      .catch(()=>setReports([]))
      .finally(()=>setLoading(false));
  },[apprentice.id]);

  const handleDelete = async (id) => {
    if(!await ktaConfirm("Delete this meeting report?")) return;
    await deleteRow('meeting_reports', id).catch(console.error);
    setReports(prev=>prev.filter(r=>r.id!==id));
  };

  const handleRevertDraft = async (id) => {
    if(!await ktaConfirm("Revert this report to draft? It will be removed from the completed list and can be re-edited.")) return;
    await updateRow('meeting_reports', id, { status: 'draft' }).catch(console.error);
    setReports(prev=>prev.filter(r=>r.id!==id));
  };

  const fD = (iso) => { if(!iso) return "—"; try{ const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }catch{ return iso; } };

  const Section = ({label,value}) => value ? (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:12,fontWeight:700,color:T.dark,textTransform:"uppercase",
        letterSpacing:".6px",marginBottom:3,paddingBottom:3,borderBottom:`1px solid ${T.border}`}}>{label}</div>
      <div style={{fontSize:14,color:T.ink,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{value}</div>
    </div>
  ) : null;

  if(loading) return <div style={{padding:24,textAlign:"center",color:T.muted,fontSize:14}}>Loading reports…</div>;

  return (
    <div>
      {reports.length===0&&(
        <div style={{padding:"24px 0",textAlign:"center",color:T.muted,fontSize:14,fontStyle:"italic"}}>No check in reports yet</div>
      )}
      {reports.map(r=>{
        const mentorUser = allUsers.find(u=>u.id===r.mentor_id);
        const isOpen = expandId===r.id;
        return (
          <div key={r.id} style={{border:`1.5px solid ${T.border}`,borderRadius:10,marginBottom:10,overflow:"hidden"}}>
            <div onClick={()=>setExpandId(isOpen?null:r.id)} style={{
              display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
              background:isOpen?T.dark:T.surface,cursor:"pointer",
              borderBottom:isOpen?`1px solid ${T.border}`:"none",transition:"background .15s"}}>
              <div style={{width:34,height:34,borderRadius:8,
                background:isOpen?"#ffffff20":T.accentL,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>📋</div>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:16,color:isOpen?"#fff":T.ink}}>
                  {fD(r.date)}{r.location?` — ${r.location}`:""}
                </div>
                <div style={{fontSize:13,color:isOpen?"#ffffff88":T.sub,marginTop:1}}>
                  {mentorUser?.name||"Unknown"} · KTA Representative
                  {r.next_visit_date&&<span style={{marginLeft:8}}>Next visit: {fD(r.next_visit_date)}</span>}
                </div>
              </div>
              <div style={{fontSize:12,color:isOpen?"#ffffff66":T.muted}}>{isOpen?"▲ collapse":"▼ view"}</div>
            </div>
            {isOpen&&(
              <div style={{padding:"16px",background:"#fff"}}>
                <Section label="Off Job Progress Since Last Visit" value={r.off_job_progress}/>
                <Section label="On Job Progress Since Last Visit"  value={r.on_job_progress}/>
                <Section label="Previous Goals"                    value={r.previous_goals}/>
                <Section label="Goals Before Next Visit"           value={r.goals_this_meeting}/>
                <Section label="Comments and Feedback"             value={r.comments_feedback}/>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginTop:12,
                  padding:"10px 12px",background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>
                  {[
                    {label:"Licence Expiry",      value: apprentice.licenceExpiry ? fD(apprentice.licenceExpiry) : "Not set"},
                    {label:"Date of Next Visit",  value: r.next_visit_date ? fD(r.next_visit_date) : "TBC"},
                    {label:"KTA Representative",  value: mentorUser?.name||"—"},
                  ].map(({label,value})=>(
                    <div key={label}>
                      <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>{label}</div>
                      <div style={{fontSize:14,fontWeight:700,color:T.ink}}>{value}</div>
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
                  <button onClick={async ()=>{
                    try {
                      // Load snapshots for this apprentice for the PDF graph
                      let dlSnaps = [];
                      try { const s = await loadTable("progress_snapshots"); dlSnaps=(s||[]).filter(x=>x.apprentice_id===apprentice.id); } catch(e){}
                      const b64 = generateReportPDF(r, apprentice, mentorUser||{name:"—"}, dlSnaps);
                      const binary = atob(b64);
                      const bytes = new Uint8Array(binary.length);
                      for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
                      const blob = new Blob([bytes],{type:"application/pdf"});
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href=url;
                      a.download=`KTA_Report_${apprentice.name.replace(/\s+/g,"_")}_${r.date}.pdf`;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch(e){ alert("PDF generation failed: "+e.message); }
                  }} style={{
                    fontSize:13,color:T.accent,background:T.accentL,
                    border:`1px solid ${T.accent}44`,borderRadius:6,padding:"4px 12px",
                    cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
                    ⬇ Download PDF
                  </button>
                  {isAdmin1&&(
                    <button onClick={()=>handleRevertDraft(r.id)} style={{
                      fontSize:13,color:T.warn,background:T.warnL,
                      border:`1px solid ${T.warn}44`,borderRadius:6,padding:"4px 12px",
                      cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontWeight:700}}>
                      ↩ Revert to Draft
                    </button>
                  )}
                  {canEdit&&(
                    <button onClick={()=>handleDelete(r.id)} style={{
                      fontSize:13,color:T.red,background:"none",
                      border:`1px solid ${T.red}44`,borderRadius:6,padding:"4px 12px",
                      cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>🗑 Delete Report</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── PPE Allocation ────────────────────────────────────────────────────────────
const PPE_CATALOGUE = [
  {item:"Hi Vis Vest",      sizes:["S","M","L","XL","2XL","3XL"]},
  {item:"Hi Vis Polo",      sizes:["S","M","L","XL","2XL","3XL"]},
  {item:"Jacket",           sizes:["S","M","L","XL","2XL","3XL"]},
  {item:"Polo Shirt",       sizes:["S","M","L","XL","2XL","3XL","4XL"]},
  {item:"Beanie",           sizes:["One Size","S","M","L"]},
  {item:"Hard Hat",         sizes:["One Size","Adjustable"]},
  {item:"Ear Muffs",        sizes:["Clip-on","Over-ear"]},
  {item:"Gloves",           sizes:["Sz 7","Sz 8","Sz 9","Sz 10"]},
  {item:"Safety Glasses",   sizes:["Clear","Dark","Tinted"]},
  {item:"Overalls",         sizes:["82R","84R","87R","92R","97R","102R","107R","112R"]},
  {item:"P2 Mask",          sizes:["S","M","L","One Size"]},
  {item:"GMAX Respirator",  sizes:["S","M","L"]},
  {item:"Knee Pads",        sizes:["One Size","S","M","L"]},
  {item:"Safety Boots",     sizes:["6","7","8","9","10","11","12","13"]},
  {item:"Other",            sizes:[]},
  {item:"Other",            sizes:[]},
];


export { ReportFullscreenModal, ProgressLineGraph, ProgressSnapshotPanel, MeetingReportForm, PastMeetingReports };
