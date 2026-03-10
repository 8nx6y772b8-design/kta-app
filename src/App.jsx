import { useState, useEffect, useCallback } from "react";
import { loadUsers, loadEntries, loadTable, upsertUser, upsertEntry, deleteEntry, deleteUser as sbDeleteUser, upsertRow, deleteRow, loadNotifications, insertNotification, markNotifRead, markAllNotifsRead, deleteNotif, licenceReminderExists, insertMessage, loadMessages, deleteMessage, sb } from "./supabaseClient";
// Email via Microsoft Graph (timesheet@kta.org.nz)

const EMAIL_PROXY = "https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/email-proxy";
const sendKTAEmail = async ({ to, subject, html }) => {
  const res = await fetch(EMAIL_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sendEmail", to, subject, html }),
  });
  if (!res.ok) throw new Error("Email send failed: " + await res.text());
};

// ─── Browser push notifications ─────────────────────────────────────────────
const requestPushPermission = async () => {
  if(!("Notification" in window)) return false;
  if(Notification.permission === "granted") return true;
  if(Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
};

const sendBrowserPush = (title, body, type="info") => {
  if(!("Notification" in window)||Notification.permission!=="granted") return;
  const icons = { approval:"✓", decline:"✕", licence:"⚠", info:"◈" };
  new Notification(`${icons[type]||"◈"} ${title}`, { body, icon:"/favicon.ico" });
};

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────
const T = {
  bg: "#f0f4f9", surface: "#ffffff", border: "#d0daea",
  ink: "#0d1b2e", sub: "#4a5a72", muted: "#8fa0b8",
  accent: "#1b4f8c", accentL: "#dce8f7", accentD: "#113570",
  warn: "#b86e1a", warnL: "#faebd7",
  red: "#bf2b2b", redL: "#fde8e8",
  hol: "#6b4fa0", holL: "#ece5f7",
  blue: "#1b6bbf", blueL: "#dceeff",
  teal: "#1a8a7a", tealL: "#d4f0ec",
  gold: "#a07820", goldL: "#fdf3d4",
  slate: "#4a5568", slateL: "#edf2f7",
  dark: "#2980B9", dark2: "#2472a4",
};

// KTA logo (from kta.org.nz)
const KTA_LOGO = "https://images.squarespace-cdn.com/content/v1/682fe0a84dcaf578b10d7882/cca16351-c2c6-4895-be1c-24f4a540ee3c/Copy+of+KTA+LOGO+BLUE+No+Background.png?format=300w";

// ─── HubSpot lookup ──────────────────────────────────────────────────────────
const lookupHubspot = async (value) => {
  const token = import.meta.env.VITE_HUBSPOT_TOKEN;
  if(!token) return null;
  const isPhone = /^[+\d\s\-()]{6,}$/.test(value) && !/[@.]/.test(value);
  const property = isPhone ? "phone" : "email";
  try {
    // HubSpot search — try exact match first
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value: value.trim() }] }],
        properties: ["firstname","lastname","email","phone","company","jobtitle"],
        limit: 1,
      }),
    });
    if(!res.ok) return null;
    const data = await res.json();
    // If phone search returned nothing, try searching all and matching
    if(!data.results?.length && isPhone) {
      const res2 = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "phone", operator: "CONTAINS_TOKEN", value: value.replace(/\D/g,"").slice(-8) }] }],
          properties: ["firstname","lastname","email","phone","company","jobtitle"],
          limit: 1,
        }),
      });
      if(res2.ok) {
        const data2 = await res2.json();
        if(data2.results?.length) {
          const p = data2.results[0].properties;
          return {
            name:    [p.firstname, p.lastname].filter(Boolean).join(" ") || "",
            email:   p.email || "",
            phone:   p.phone || value,
            company: p.company || "",
            notes:   p.jobtitle ? `Job title: ${p.jobtitle}` : "",
            status:  "Active",
          };
        }
      }
      return null;
    }
    if(!data.results?.length) return null;
    const p = data.results[0].properties;
    return {
      name:    [p.firstname, p.lastname].filter(Boolean).join(" ") || "",
      email:   p.email || (isPhone ? "" : value),
      phone:   p.phone || (isPhone ? value : ""),
      company: p.company || "",
      notes:   p.jobtitle ? `Job title: ${p.jobtitle}` : "",
      status:  "Active",
    };
  } catch(e) {
    console.warn("HubSpot lookup failed:", e);
    return null;
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const ROLES = ["Apprentice","Approver","Viewer","Mentor","Admin"];
const ROLE_META = {
  Apprentice: { color: T.blue,   bg: T.blueL,  symbol: "◑", desc: "View & edit own timesheets (last 14 days)" },
  Approver:   { color: T.warn,   bg: T.warnL,  symbol: "▲", desc: "Approve or decline submitted timesheets for allocated apprentices" },
  Viewer:     { color: T.teal,   bg: T.tealL,  symbol: "◆", desc: "View all timesheet stages for allocated apprentices — read only" },
  Mentor:     { color: T.gold,   bg: T.goldL,  symbol: "✦", desc: "View allocated apprentice timesheets (read-only) and full CRM access" },
  Admin:      { color: T.accent, bg: T.accentL,symbol: "★", desc: "Full access — manage all users, timesheets & CRM" },
  "Admin 1":  { color: T.accent, bg: T.accentL,symbol: "★", desc: "Full access including message history management" },
  "Admin 2":  { color: "#6d5fc7", bg: "#ede9ff",symbol: "☆", desc: "User management, timesheet view — cannot edit or delete messages" },
};

const ENTRY_TYPES = ["Normal Hours","Annual Leave","Sick Leave","Public Holiday","Overtime","Block Course","Other"];
const TYPE_META = {
  "Normal Hours":   { color: T.accent, bg: T.accentL, sym: "◈" },
  "Annual Leave":   { color: T.warn,   bg: T.warnL,   sym: "☀" },
  "Sick Leave":     { color: T.red,    bg: T.redL,    sym: "✚" },
  "Public Holiday": { color: T.hol,    bg: T.holL,    sym: "★" },
  "Overtime":       { color: T.gold,   bg: T.goldL,   sym: "⚡" },
  "Block Course":   { color: T.teal,   bg: T.tealL,   sym: "🎓" },
  "Other":          { color: T.slate,  bg: T.slateL,  sym: "◉" },
};
const APPROVAL_META = {
  draft:     { color: T.muted,  bg: T.slateL, label: "Draft",      sym: "✎" },
  submitted: { color: T.warn,   bg: T.warnL,  label: "Submitted",  sym: "○" },
  approved:  { color: T.accent, bg: T.accentL,label: "Approved",   sym: "✓" },
  declined:  { color: T.red,    bg: T.redL,   label: "Declined",   sym: "✕" },
};

const BREAK_OPTIONS = Array.from({length:9},(_,i)=>i*15);
const TIME_OPTIONS = [];
for(let h=0;h<24;h++) for(let m=0;m<60;m+=15)
  TIME_OPTIONS.push(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`);

const TRADES = ["Electrical","Plumbing","Construction","Carpentry","HVAC","Civil","Other"];
const STAGES = ["Lead","Qualified","Proposal","Negotiation","Won","Lost"];
const STAGE_C = { Lead:T.muted, Qualified:T.blue, Proposal:T.warn, Negotiation:T.hol, Won:T.accent, Lost:T.red };

// ─────────────────────────────────────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────────────────────────────────────
// Simple hash: XOR + encode so passwords aren't plaintext in storage
const hashPw = (pw) => btoa([...pw].map((c,i)=>String.fromCharCode(c.charCodeAt(0)^(42+i%7))).join(""));
const checkPw = (pw, hash) => hashPw(pw) === hash;

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
const uid      = () => Math.random().toString(36).slice(2,9);
const tod      = () => new Date().toISOString().slice(0,10);
const toMin    = t => { const[h,m]=t.split(":").map(Number); return h*60+m; };
const calcNet  = (s,e,b) => { const d=toMin(e)-toMin(s)-b; return d>0?+(d/60).toFixed(2):0; };
const fmtD     = d => new Date(d+"T00:00:00").toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short"});
const within14  = d => { const diff=(new Date(tod())-new Date(d+"T00:00:00"))/(86400000); return diff>=0&&diff<14; };
const weekStart = () => { const d=new Date(); d.setDate(d.getDate()-((d.getDay()+6)%7)); d.setHours(0,0,0,0); return d.toISOString().slice(0,10); };
const withinWeek = d => d >= weekStart();
const daysAgoStr = n => { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };

// Send email notification to approvers when apprentice submits timesheets
const notifyApprovers = async (apprentice, approvers, entries) => {
  if(!approvers.length) return;
  const entryList = entries.map(e=>
    `<li>${fmtD(e.date)} — ${e.type} — ${e.netHours}h${e.note?" ("+e.note+")":""}</li>`
  ).join("");
  for(const approver of approvers) {
    try {
      await sendKTAEmail({
        to: approver.email,
        subject: `Timesheet submitted — ${apprentice.name}`,
        html: `<p>Hi ${approver.name},</p>
<p><strong>${apprentice.name}</strong> has submitted ${entries.length} timesheet entr${entries.length===1?"y":"ies"} for approval:</p>
<ul>${entryList}</ul>
<p>Please log in to <a href="https://crmkta.com">crmkta.com</a> to review.</p>
<p style="color:#888;font-size:12px">KTA Workforce Management · timesheet@kta.org.nz</p>`,
      });
    } catch(err) {
      console.error("notifyApprovers error:", err);
    }
  }
};

// Notify apprentice of approval or decline
const notifyApprentice = async (apprentice, approver, entries, approved) => {
  if(!apprentice?.email) return;
  const entryList = entries.map(e=>
    `<li>${fmtD(e.date)} — ${e.type} — ${e.netHours}h${e.note?" ("+e.note+")":""}</li>`
  ).join("");
  const statusColor = approved ? "#1a8a7a" : "#bf2b2b";
  const statusText  = approved ? "APPROVED ✓" : "DECLINED ✕";
  const message     = approved
    ? `Your timesheet entr${entries.length===1?"y has":"ies have"} been approved.`
    : `Your timesheet entr${entries.length===1?"y has":"ies have"} been declined. Please check with your approver.`;
  try {
    await sendKTAEmail({
      to: apprentice.email,
      subject: `Timesheet ${approved?"approved":"declined"} — ${approver?.name||"KTA"}`,
      html: `<p>Hi ${apprentice.name},</p>
<p><strong style="color:${statusColor}">${statusText}</strong></p>
<p>${message}</p>
<ul>${entryList}</ul>
<p style="color:#888;font-size:12px">KTA Workforce Management · timesheet@kta.org.nz</p>`,
    });
  } catch(err) {
    console.error("notifyApprentice error:", err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STYLES
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  html,body{background:${T.bg};font-family:"DM Sans",sans-serif;color:${T.ink};font-size:14px;-webkit-tap-highlight-color:transparent;}
  ::-webkit-scrollbar{width:5px;height:5px;}
  ::-webkit-scrollbar-track{background:${T.border};}
  ::-webkit-scrollbar-thumb{background:${T.muted};border-radius:3px;}
  select,input,textarea{
    font-family:"DM Sans",sans-serif;background:${T.surface};
    border:1.5px solid ${T.border};color:${T.ink};border-radius:9px;
    padding:9px 12px;font-size:16px;outline:none;width:100%;
    transition:border-color .15s,box-shadow .15s;
    appearance:none;-webkit-appearance:none;
  }
  select{
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='6'%3E%3Cpath d='M1 1l4.5 4 4.5-4' stroke='%23b0a898' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat:no-repeat;background-position:right 11px center;padding-right:30px;
  }
  select option{background:white;}
  input:focus,select:focus,textarea:focus{border-color:${T.accent};box-shadow:0 0 0 3px ${T.accentL};}
  input[type=date]::-webkit-calendar-picker-indicator{opacity:.4;cursor:pointer;}
  button{cursor:pointer;font-family:"DM Sans",sans-serif;border:none;transition:all .14s;}
  textarea{resize:vertical;min-height:64px;line-height:1.55;font-size:16px;}

  @keyframes fadeUp  {from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
  @keyframes fadeIn  {from{opacity:0;}to{opacity:1;}}
  @keyframes rowIn   {from{opacity:0;transform:translateX(-5px);}to{opacity:1;transform:translateX(0);}}
  @keyframes shake   {0%,100%{transform:translateX(0);}20%,60%{transform:translateX(-6px);}40%,80%{transform:translateX(6px);}}
  @keyframes spin    {to{transform:rotate(360deg);}}
  .fu{animation:fadeUp .3s ease both;}
  .fi{animation:fadeIn .25s ease both;}
  .ri{animation:rowIn .22s ease both;}
  .shake{animation:shake .35s ease;}

  /* Login page */
  .login-wrap{min-height:100vh;display:flex;background:linear-gradient(135deg,${T.dark} 0%,${T.dark2} 50%,#2060a0 100%);}
  .login-left{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:60px;position:relative;overflow:hidden;}
  .login-left::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 30% 50%,${T.accent}22 0%,transparent 60%),radial-gradient(ellipse at 80% 20%,${T.blue}14 0%,transparent 50%);}
  .login-right{width:440px;flex-shrink:0;background:${T.surface};display:flex;flex-direction:column;justify-content:center;padding:56px 48px;box-shadow:-20px 0 60px #00000033;overflow-y:auto;}
  .login-input-wrap{position:relative;margin-bottom:14px;}
  .login-input-wrap input{padding:13px 16px 13px 44px;background:#f9f8f5;border:1.5px solid ${T.border};font-size:16px;border-radius:10px;}
  .login-input-wrap input:focus{background:white;}
  .login-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:16px;color:${T.muted};pointer-events:none;}
  .pw-toggle{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:${T.muted};cursor:pointer;font-size:13px;padding:2px 6px;border-radius:4px;font-family:"DM Sans",sans-serif;}
  .pw-toggle:hover{color:${T.sub};}

  /* App shell */
  .desktop-nav{display:flex;}
  .desktop-user-name{display:block;}
  .desktop-signout{display:flex;}
  .bottom-nav{display:none;}
  .main-content{max-width:1300px;margin:0 auto;padding:28px 24px;}
  .stat-grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px;}
  .stat-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:22px;}
  .table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}

  /* Form grid defaults (desktop) */
  .fg3{grid-template-columns:1fr 1fr 1fr;}
  .fg2{grid-template-columns:1fr 1fr;}
  .fg-entry{grid-template-columns:1fr 1fr;}
  .fg-addr{grid-template-columns:2fr 1fr 1fr 1fr;}

  /* ── MOBILE ──────────────────────────────────────────── */
  @media(max-width:768px){
    /* Login — stack vertically */
    .login-wrap{flex-direction:column;}
    .login-left{flex:none;padding:32px 24px 24px;align-items:flex-start;}
    .login-left h1{font-size:26px !important;margin-bottom:12px !important;}
    .login-left p,.login-left .role-badges{display:none;}
    .login-right{width:100%;flex:1;padding:28px 20px max(32px,env(safe-area-inset-bottom));box-shadow:none;border-radius:22px 22px 0 0;margin-top:-16px;z-index:2;position:relative;}

    /* Header — compact */
    .desktop-nav{display:none !important;}
    .desktop-user-name{display:none !important;}
    .desktop-signout{display:none !important;}

    /* Bottom tab bar */
    .bottom-nav{
      display:flex;position:fixed;bottom:0;left:0;right:0;z-index:200;
      background:${T.dark};border-top:1px solid #ffffff15;
      padding:6px 0 max(6px,env(safe-area-inset-bottom));
      box-shadow:0 -4px 24px #00000044;
    }
    .bottom-nav-btn{
      flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:2px;background:none;border:none;padding:4px 2px;cursor:pointer;
      font-family:"DM Sans",sans-serif;transition:all .14s;min-height:52px;
    }
    .bottom-nav-icon{font-size:22px;line-height:1;display:block;}
    .bottom-nav-label{font-size:10px;font-weight:600;letter-spacing:.2px;display:block;}
    .bottom-nav-btn.active .bottom-nav-icon,
    .bottom-nav-btn.active .bottom-nav-label{color:${T.accentL};}
    .bottom-nav-btn:not(.active) .bottom-nav-icon,
    .bottom-nav-btn:not(.active) .bottom-nav-label{color:#ffffff40;}
    .bottom-nav-btn.active{position:relative;}
    .bottom-nav-btn.active::before{content:"";position:absolute;top:0;left:20%;right:20%;height:2px;background:${T.accentL};border-radius:0 0 3px 3px;}

    /* Main */
    .main-content{padding:14px 12px 86px;}

    /* Stat grids */
    .stat-grid-4{grid-template-columns:repeat(2,1fr);gap:10px;}
    .stat-grid-3{grid-template-columns:repeat(2,1fr);gap:10px;}

    /* Page heading */
    .page-heading{font-size:20px !important;}

    /* Form grids collapse to 1 or 2 col */
    .fg3{grid-template-columns:1fr !important;}
    .fg2{grid-template-columns:1fr !important;}
    .fg-addr{grid-template-columns:1fr 1fr !important;}
    .fg-entry{grid-template-columns:1fr 1fr !important;}

    /* Table horizontal scroll */
    .table-scroll{margin:0 -12px;border-radius:0 !important;}

    /* Hide less-important table columns on mobile via utility class */
    .hide-mobile{display:none !important;}

    /* Notification bell dropdown — full width on mobile */
    .notif-dropdown{
      position:fixed !important;
      top:58px !important;
      left:8px !important;
      right:8px !important;
      width:auto !important;
      max-width:100vw !important;
    }
    .notif-dropdown .notif-title{white-space:normal !important;word-break:break-word;}
    .notif-dropdown .notif-msg{white-space:pre-wrap !important;word-break:break-word;}
  }

  @media(max-width:400px){
    .login-right{padding:22px 16px max(28px,env(safe-area-inset-bottom));}
    .main-content{padding:12px 10px 84px;}
    .stat-grid-4,.stat-grid-3{grid-template-columns:repeat(2,1fr);gap:8px;}
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// MICRO COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
const Pill = ({label,color,bg,sym,size="md"}) => (
  <span style={{display:"inline-flex",alignItems:"center",gap:4,background:bg,color,
    padding:size==="sm"?"2px 8px":"4px 10px",borderRadius:99,
    fontSize:size==="sm"?11:12,fontWeight:600,whiteSpace:"nowrap"}}>
    {sym&&<span style={{fontSize:size==="sm"?9:10}}>{sym}</span>}{label}
  </span>
);
const RolePill = ({role, size="md", adminLevel=null}) => {
  const displayRole = role==="Admin" && adminLevel ? `Admin ${adminLevel}` : role;
  const m = ROLE_META[displayRole] || ROLE_META[role] || ROLE_META.Apprentice;
  return <Pill label={displayRole} color={m.color} bg={m.bg} sym={m.symbol} size={size}/>;
};
const TypePill = ({type,size="md"}) => { const m=TYPE_META[type]||TYPE_META["Other"]; return <Pill label={type} color={m.color} bg={m.bg} sym={m.sym} size={size}/> };
const AppvPill = ({status}) => { const m=APPROVAL_META[status]||APPROVAL_META.draft; return <Pill label={m.label} color={m.color} bg={m.bg} sym={m.sym} size="sm"/> };

const FL = ({children,req}) => (
  <div style={{fontSize:11,fontWeight:600,color:T.sub,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>
    {children}{req&&<span style={{color:T.red}}> *</span>}
  </div>
);

const Btn = ({children,onClick,v="primary",sm=false,disabled=false,full=false,style:sx={}}) => {
  const vs = {
    primary: {background:T.accent,color:"#fff",border:`1.5px solid ${T.accentD}`},
    ghost:   {background:T.surface,color:T.sub,border:`1.5px solid ${T.border}`},
    danger:  {background:T.redL,color:T.red,border:`1.5px solid ${T.red}44`},
    approve: {background:T.accentL,color:T.accent,border:`1.5px solid ${T.accent}55`},
    decline: {background:T.redL,color:T.red,border:`1.5px solid ${T.red}55`},
    blue:    {background:T.blueL,color:T.blue,border:`1.5px solid ${T.blue}55`},
    loginbtn:{background:T.accent,color:"#fff",border:`1.5px solid ${T.accentD}`,fontSize:15,padding:"13px 20px",borderRadius:10,fontWeight:700},
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...vs[v]||vs.primary,borderRadius:8,
      padding:sm?"5px 12px":"9px 16px",fontSize:sm?12:13,fontWeight:600,
      display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,
      opacity:disabled?.45:1,width:full?"100%":undefined,...sx
    }}
      onMouseEnter={e=>{if(!disabled)e.currentTarget.style.filter="brightness(.93)";}}
      onMouseLeave={e=>{e.currentTarget.style.filter="none";}}>
      {children}
    </button>
  );
};

const Card = ({children,style:sx={}}) => (
  <div style={{background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:14,padding:20,...sx}}>
    {children}
  </div>
);
const StatCard = ({label,value,sub,color=T.accent}) => (
  <Card style={{paddingBlock:18}}>
    <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>{label}</div>
    <div style={{fontSize:24,fontWeight:700,color,fontFamily:"'Libre Baskerville'"}}>{value}</div>
    {sub&&<div style={{fontSize:11,color:T.sub,marginTop:2}}>{sub}</div>}
  </Card>
);
const Avatar = ({name,role,size=36}) => {
  const m=ROLE_META[role]||ROLE_META.Apprentice;
  return (
    <div style={{width:size,height:size,borderRadius:"50%",flexShrink:0,
      background:m.bg,border:`2px solid ${m.color}44`,
      display:"flex",alignItems:"center",justifyContent:"center",
      fontWeight:700,fontSize:size*.38,color:m.color}}>
      {name?.[0]?.toUpperCase()||"?"}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────
function LoginScreen({users, onLogin}) {
  const [email, setEmail]   = useState("");
  const [pw, setPw]         = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr]       = useState("");
  const [loading, setLoading] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [forgotMode, setForgotMode]   = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg]     = useState(null); // {ok, text}
  const [forgotSending, setForgotSending] = useState(false);

  const sendReset = async () => {
    if(!forgotEmail.trim()) { setForgotMsg({ok:false,text:"Please enter your email address."}); return; }
    const user = users.find(u=>u.email.toLowerCase()===forgotEmail.trim().toLowerCase());
    setForgotSending(true);
    // Small delay so it feels like something is happening regardless
    await new Promise(r=>setTimeout(r,800));
    setForgotSending(false);
    if(!user) {
      // Don't reveal whether email exists — always show success for security
      setForgotMsg({ok:true,text:"If that email is registered, a reset link has been sent."});
      return;
    }
    // Send reset email via Graph API
    try {
      await sendKTAEmail({
        to: user.email,
        subject: "KTA Password Reset Request",
        html: `<p>Hi ${user.name},</p>
<p>A password reset was requested for your KTA account.</p>
<p>Please contact your administrator to have your password reset.</p>
<p>If you did not request this, please ignore this email.</p>
<p style="color:#888;font-size:12px">KTA Workforce Management · timesheet@kta.org.nz</p>`,
      });
      setForgotMsg({ok:true,text:"Reset instructions have been sent to your email."});
    } catch(e) {
      setForgotMsg({ok:true,text:"If that email is registered, a reset link has been sent."});
    }
  };

  const attempt = () => {
    setErr("");
    if(!email.trim()||!pw) { setErr("Please enter your email and password."); return; }
    setLoading(true);
    setTimeout(() => {
      const user = users.find(u=>u.email.toLowerCase()===email.trim().toLowerCase());
      if(!user) { setErr("No account found with that email address."); setLoading(false); trigShake(); return; }
      if(!checkPw(pw, user.password)) { setErr("Incorrect password. Please try again."); setLoading(false); trigShake(); return; }
      onLogin(user.id);
    }, 600);
  };

  const trigShake = () => { setShaking(true); setTimeout(()=>setShaking(false),400); };

  return (
    <div className="login-wrap">
      {/* LEFT — branding */}
      <div className="login-left fi">
        <div style={{position:"relative",zIndex:1,maxWidth:420}}>
          {/* KTA Logo */}
          <div style={{marginBottom:52}}>
            <img src={KTA_LOGO} alt="Kiwi Trade Apprentices"
              style={{height:60,objectFit:"contain",filter:"brightness(0) invert(1)"}}
              onError={e=>{e.target.style.display="none";}}
            />
          </div>

          {/* Tagline */}
          <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:36,fontWeight:700,color:"#fff",lineHeight:1.25,marginBottom:20,letterSpacing:"-.5px"}}>
            Timesheet management, approvals, and CRM
          </h1>
          <p style={{fontSize:16,color:"#ffffffaa",lineHeight:1.7}}>
            Built around your team and their training needs.
          </p>
        </div>
      </div>

      {/* RIGHT — login form */}
      <div className="login-right">
        <div style={{marginBottom:36}}>
          <h2 style={{fontFamily:"'Libre Baskerville'",fontSize:26,fontWeight:700,color:T.ink,marginBottom:8}}>
            Welcome back
          </h2>
          <p style={{fontSize:13,color:T.sub}}>Sign in to your account to continue.</p>
        </div>

        <div className={shaking?"shake":""}>
          {/* Email */}
          <div style={{marginBottom:4}}>
            <FL>Email Address</FL>
          </div>
          <div className="login-input-wrap">
            <span className="login-icon">✉</span>
            <input
              type="email" placeholder="you@work.com"
              value={email} onChange={e=>{setEmail(e.target.value);setErr("");}}
              onKeyDown={e=>e.key==="Enter"&&attempt()}
              style={{borderColor:err?T.red:undefined}}
            />
          </div>

          {/* Password */}
          <div style={{marginBottom:4}}>
            <FL>Password</FL>
          </div>
          <div className="login-input-wrap">
            <span className="login-icon">🔒</span>
            <input
              type={showPw?"text":"password"} placeholder="Enter your password"
              value={pw} onChange={e=>{setPw(e.target.value);setErr("");}}
              onKeyDown={e=>e.key==="Enter"&&attempt()}
              style={{borderColor:err?T.red:undefined}}
            />
            <button className="pw-toggle" onClick={()=>setShowPw(s=>!s)} type="button">
              {showPw?"Hide":"Show"}
            </button>
          </div>

          {/* Error */}
          {err&&(
            <div style={{background:T.redL,border:`1px solid ${T.red}44`,borderRadius:8,
              padding:"9px 13px",marginBottom:14,fontSize:13,color:T.red,display:"flex",gap:8,alignItems:"center"}}>
              <span>⚠</span>{err}
            </div>
          )}

          {/* Submit */}
          <button onClick={attempt} disabled={loading} style={{
            width:"100%",padding:"13px",marginTop:err?0:6,marginBottom:20,
            background:loading?T.accentL:T.accent,
            color:loading?T.accent:"#fff",
            border:`1.5px solid ${T.accentD}`,
            borderRadius:10,fontSize:15,fontWeight:700,
            display:"flex",alignItems:"center",justifyContent:"center",gap:10,
            cursor:loading?"default":"pointer",fontFamily:"DM Sans,sans-serif",transition:"all .15s"
          }}>
            {loading
              ? <><span style={{width:16,height:16,border:`2px solid ${T.accent}`,borderTopColor:"transparent",borderRadius:"50%",display:"inline-block",animation:"spin .7s linear infinite"}}/>Signing in…</>
              : "Sign In →"
            }
          </button>
        </div>

        {/* Forgot Password */}
        <div style={{borderTop:`1px solid ${T.border}`,paddingTop:20}}>
          {!forgotMode ? (
            <button onClick={()=>{setForgotMode(true);setErr("");setForgotMsg("");}} style={{
              background:"none",border:"none",color:T.accent,fontSize:13,
              fontWeight:600,cursor:"pointer",fontFamily:"DM Sans,sans-serif",
              padding:0,display:"block",margin:"0 auto"
            }}>Forgot your password?</button>
          ) : (
            <div className="fi">
              <div style={{fontSize:13,fontWeight:600,color:T.ink,marginBottom:8}}>Reset Password</div>
              <div style={{fontSize:12,color:T.sub,marginBottom:12,lineHeight:1.5}}>
                Enter your email and we'll send a reset link to your inbox.
              </div>
              <div className="login-input-wrap" style={{marginBottom:10}}>
                <span className="login-icon">✉</span>
                <input type="email" placeholder="your@email.com"
                  value={forgotEmail} onChange={e=>{setForgotEmail(e.target.value);setForgotMsg("");}}
                  onKeyDown={e=>e.key==="Enter"&&sendReset()}
                />
              </div>
              {forgotMsg&&(
                <div style={{background:forgotMsg.ok?T.accentL:T.redL,border:`1px solid ${forgotMsg.ok?T.accent:T.red}44`,
                  borderRadius:8,padding:"9px 13px",marginBottom:10,fontSize:12,
                  color:forgotMsg.ok?T.accent:T.red}}>
                  {forgotMsg.text}
                </div>
              )}
              <div style={{display:"flex",gap:8}}>
                <button onClick={sendReset} disabled={forgotSending} style={{
                  flex:1,padding:"10px",background:T.accent,color:"#fff",
                  border:`1.5px solid ${T.accentD}`,borderRadius:9,fontSize:13,fontWeight:700,
                  cursor:forgotSending?"default":"pointer",fontFamily:"DM Sans,sans-serif",
                  opacity:forgotSending?0.6:1,transition:"all .15s"
                }}>{forgotSending?"Sending…":"Send Reset Link"}</button>
                <button onClick={()=>{setForgotMode(false);setForgotEmail("");setForgotMsg("");}} style={{
                  padding:"10px 16px",background:"none",color:T.sub,
                  border:`1.5px solid ${T.border}`,borderRadius:9,fontSize:13,fontWeight:600,
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif"
                }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        {/* Version */}
        <div style={{marginTop:24,textAlign:"center",fontSize:11,color:T.muted,fontFamily:"DM Sans,sans-serif"}}>
          v1.4.3
        </div>
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────
function EntryForm({onSave,onCancel,initial=null,minDate=null,maxDate=null,usedDates=[]}) {
  const blank = {date:tod(),type:"Normal Hours",start:"09:00",end:"17:00",breakMins:30,note:""};
  const [f,setF] = useState(initial||blank);
  const [err,setErr] = useState({});
  const sf=(k,v)=>setF(p=>({...p,[k]:v}));
  const dateConflict = !initial && usedDates.includes(f.date);
  const netH = calcNet(f.start,f.end,Number(f.breakMins));
  const gross = toMin(f.end)-toMin(f.start);

  const submit = () => {
    const e={};
    if(gross<=0) e.time="End must be after start";
    else if(netH<=0) e.time="Net hours must be > 0 after break";
    if(Object.keys(e).length){setErr(e);return;}
    if(dateConflict) return;
    onSave({...f,breakMins:Number(f.breakMins),netHours:netH,approval:initial?f.approval:"draft"});
  };

  return (
    <Card style={{border:`1.5px solid ${T.accent}44`}} className="fu">
      <div className="fg-entry" style={{display:"grid",gap:12,marginBottom:12}}>
        <div><FL>Date</FL><input type="date" value={f.date} onChange={e=>sf("date",e.target.value)} min={minDate||undefined} max={maxDate||undefined}
                style={{borderColor:dateConflict?T.red:undefined}}/>
              {dateConflict&&<div style={{fontSize:11,color:T.red,marginTop:3}}>You already have an entry for this date</div>}</div>
        <div>
          <FL>Entry Type</FL>
          <select value={f.type} onChange={e=>sf("type",e.target.value)}>
            {ENTRY_TYPES.map(t=><option key={t}>{t}</option>)}
          </select>
          <div style={{marginTop:6}}><TypePill type={f.type}/></div>
        </div>
        <div><FL>Start Time</FL>
          <select value={f.start} onChange={e=>sf("start",e.target.value)}>
            {TIME_OPTIONS.map(t=><option key={t}>{t}</option>)}
          </select>
        </div>
        <div><FL>End Time</FL>
          <select value={f.end} onChange={e=>sf("end",e.target.value)}>
            {TIME_OPTIONS.map(t=><option key={t}>{t}</option>)}
          </select>
        </div>
      </div>
      {err.time&&<div style={{color:T.red,fontSize:11,marginBottom:10}}>{err.time}</div>}
      <div style={{marginBottom:12}}>
        <FL>Break Duration</FL>
        <select value={f.breakMins} onChange={e=>sf("breakMins",e.target.value)}>
          {BREAK_OPTIONS.map(m=><option key={m} value={m}>{m===0?"No break":`${m} minutes`}</option>)}
        </select>
      </div>
      <div style={{background:netH>0?T.accentL:T.redL,border:`1.5px solid ${netH>0?T.accent+"44":T.red+"44"}`,
        borderRadius:9,padding:"10px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:11,color:T.sub,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px"}}>Net Hours</div>
          <div style={{fontSize:11,color:T.muted,marginTop:1}}>{gross>0?`${f.start}–${f.end} minus ${f.breakMins}m`:"—"}</div>
        </div>
        <div style={{fontFamily:"'Libre Baskerville'",fontSize:26,fontWeight:700,color:netH>0?T.accent:T.red}}>
          {netH>0?`${netH}h`:"—"}
        </div>
      </div>
      <div style={{marginBottom:16}}>
        <FL>Note</FL>
        <textarea placeholder="Optional note…" value={f.note} onChange={e=>sf("note",e.target.value)}/>
      </div>
      <div style={{display:"flex",gap:8}}>
        <Btn onClick={submit}>{initial?"Update Entry":"Save Entry"}</Btn>
        {onCancel&&<Btn v="ghost" onClick={onCancel}>Cancel</Btn>}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY ROW
// ─────────────────────────────────────────────────────────────────────────────
function EntryRow({entry,canEdit,canDelete,canApprove,canSubmitXero,onDelete,onApprove,onDecline,onEdit,onSubmit,onSubmitXero,idx,showUser,users}) {
  const user=users?.find(u=>u.id===entry.userId);
  const tcols=showUser
    ?"130px 130px 1fr 130px 64px 60px 70px 100px 68px"
    :"130px 1fr 130px 64px 60px 70px 100px 68px";
  const isLocked = !canEdit && (entry.approval==="submitted"||entry.approval==="approved");
  return (
    <div className="ri" style={{display:"grid",gridTemplateColumns:tcols,
      padding:"12px 16px",borderBottom:`1px solid ${T.border}44`,
      background:idx%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${idx*.03}s`}}>
      <div>
        <div style={{fontSize:13,fontWeight:600}}>{fmtD(entry.date)}</div>
      </div>
      {showUser&&(
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          <Avatar name={user?.name} role={user?.role} size={26}/>
          <span style={{fontSize:12,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user?.name||"—"}</span>
        </div>
      )}
      <div style={{fontSize:12,color:entry.note?T.ink:T.muted,fontStyle:entry.note?"normal":"italic",
        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.note||"No note"}</div>
      <TypePill type={entry.type} size="sm"/>
      <div style={{textAlign:"center",fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:15,
        color:TYPE_META[entry.type]?.color||T.accent}}>{entry.netHours}h</div>
      <div style={{textAlign:"center",fontSize:11,color:T.sub}}>{entry.breakMins>0?`${entry.breakMins}m`:"—"}</div>
      <div style={{textAlign:"center",fontSize:11,color:T.muted,fontFamily:"monospace"}}>{entry.start}–{entry.end}</div>
      <AppvPill status={entry.approval}/>
      <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
        {canApprove&&entry.approval==="submitted"&&(<>
          <button onClick={()=>onApprove(entry.id)} title="Approve" style={{
            width:26,height:26,borderRadius:6,fontSize:12,background:T.accentL,color:T.accent,
            border:`1px solid ${T.accent}44`,display:"flex",alignItems:"center",justifyContent:"center"}}>✓</button>
          <button onClick={()=>onDecline(entry.id)} title="Decline" style={{
            width:26,height:26,borderRadius:6,fontSize:12,background:T.redL,color:T.red,
            border:`1px solid ${T.red}44`,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </>)}
        {canSubmitXero && entry.approval==="approved" && !entry.xeroStatus && (
          <button onClick={()=>onSubmitXero&&onSubmitXero(entry.id)}
            title="Submit to Xero Payroll"
            style={{height:26,borderRadius:6,fontSize:11,fontWeight:700,
              background:"#e6f7fd",color:"#0d7bb5",padding:"0 7px",
              border:"1px solid #13b5ea55",display:"flex",alignItems:"center",gap:3,
              cursor:"pointer",whiteSpace:"nowrap"}}
            onMouseEnter={e=>{e.currentTarget.style.background="#13b5ea";e.currentTarget.style.color="#fff";}}
            onMouseLeave={e=>{e.currentTarget.style.background="#e6f7fd";e.currentTarget.style.color="#0d7bb5";}}>
            𝕏 Xero
          </button>
        )}
        {entry.xeroStatus==="submitted" && (
          <div title="Submitted to Xero"
            style={{height:26,borderRadius:6,fontSize:11,fontWeight:700,
              background:"#e6f7fd",color:"#0d7bb5",padding:"0 7px",
              border:"1px solid #13b5ea55",display:"flex",alignItems:"center",gap:3}}>
            𝕏 ✓
          </div>
        )}
        {entry.xeroStatus==="error" && (
          <div title={entry.xeroError||"Xero error"}
            style={{height:26,borderRadius:6,fontSize:11,fontWeight:700,
              background:T.redL,color:T.red,padding:"0 7px",
              border:`1px solid ${T.red}44`,display:"flex",alignItems:"center",gap:3}}>
            𝕏 ✕
          </div>
        )}
        {isLocked&&(
          <div title={entry.approval==="approved"?"Approved — contact admin to edit":"Submitted — wait for approval or decline"}
            style={{width:26,height:26,borderRadius:6,fontSize:13,background:T.bg,color:T.muted,
              border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}>🔒</div>
        )}
        {canEdit&&(<>
          <button onClick={()=>onEdit(entry)} style={{width:26,height:26,borderRadius:6,fontSize:12,
            background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
            display:"flex",alignItems:"center",justifyContent:"center"}}
            onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
          {(canDelete===undefined?canEdit:canDelete)&&(
            <button onClick={()=>onDelete(entry.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,
              background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
              display:"flex",alignItems:"center",justifyContent:"center"}}
              onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
          )}
        </>)}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMESHEET MODULE
// ─────────────────────────────────────────────────────────────────────────────
function TimesheetModule({currentUser,allUsers,entries,setEntries,forcedApprenticeId=null}) {
  const [showForm,setShowForm] = useState(false);
  const [editEntry,setEditEntry] = useState(null);
  const [filterUid,setFilterUid] = useState(forcedApprenticeId||"all");
  const [toast,setToast] = useState(null); // {msg, ok}
  const [weekPickerDrafts, setWeekPickerDrafts] = useState(null); // null | {weeks:[...], draftsPerWeek:{}}
  const [weekPickerSelected, setWeekPickerSelected] = useState(null);
  const role=currentUser.role;

  const showToast = (msg, ok=true) => {
    setToast({msg,ok});
    setTimeout(()=>setToast(null), 4000);
  };

  const visibleIds = useCallback(()=>{
    if(forcedApprenticeId) return [forcedApprenticeId];
    if(role==="Admin") return allUsers.map(u=>u.id);
    if(["Viewer","Approver"].includes(role)) {
      // Legacy: allocatedTo on the viewer/approver record
      const fromAlloc = currentUser.allocatedTo||[];
      // New: apprentices who have this user set as their approver/viewer
      const fromApprentice = allUsers
        .filter(u=>u.role==="Apprentice"&&(u.approverUserId===currentUser.id||u.viewerUserId===currentUser.id))
        .map(u=>u.id);
      return [...new Set([currentUser.id,...fromAlloc,...fromApprentice])];
    }
    if(role==="Mentor") {
      // Legacy: allocatedTo on the mentor record
      const fromAlloc = currentUser.allocatedTo||[];
      // New: apprentices who have this user set as their mentor
      const fromApprentice = allUsers
        .filter(u=>u.role==="Apprentice"&&u.mentorUserId===currentUser.id)
        .map(u=>u.id);
      return [...new Set([...fromAlloc,...fromApprentice])];
    }
    return [currentUser.id];
  },[role,currentUser,allUsers,forcedApprenticeId]);

  // Helper: effective roles this user has (Admin may also have a secondaryRole)
  const hasRole = (r) => role===r || (role==="Admin" && currentUser.secondaryRole===r);

  const canEdit=(entry)=>{
    if(role==="Admin") return true;
    // Apprentice: only draft entries within 21 days are editable
    // Submitted entries are locked until declined, approved entries are permanently locked
    if(role==="Apprentice"&&entry.userId===currentUser.id&&entry.approval==="draft"&&entry.date>=daysAgoStr(21)) return true;
    return false;
  };
  const canDelete=(entry)=>{
    if(role==="Admin") return true;
    // Apprentice can delete own draft entries only
    if(role==="Apprentice"&&entry.userId===currentUser.id&&entry.approval==="draft") return true;
    return false;
  };
  const canApprove=(entry)=>{
    if(entry.approval!=="submitted") return false;
    if(role==="Admin") return true;
    if(role==="Approver") {
      const apprentice = allUsers.find(u=>u.id===entry.userId);
      if((currentUser.allocatedTo||[]).includes(entry.userId)) return true;
      if(apprentice?.approverUserId===currentUser.id) return true;
    }
    return false;
  };
  const canAdd=forcedApprenticeId ? false : (role==="Admin"||role==="Apprentice");

  const vids=visibleIds();
  let shown=entries.filter(e=>vids.includes(e.userId));
  if(!forcedApprenticeId && filterUid!=="all") shown=shown.filter(e=>e.userId===filterUid);
  if(role==="Apprentice") shown=shown.filter(e=>e.date>=daysAgoStr(21)||e.approval!=="draft");
  shown=[...shown].sort((a,b)=>b.date.localeCompare(a.date));

  const myE=entries.filter(e=>e.userId===currentUser.id);
  const todayEntries=myE.filter(e=>e.date===tod());
  const todayH=todayEntries.length>0?todayEntries.reduce((a,e)=>a+e.netHours,0).toFixed(2):null;
  const ws=()=>{const d=new Date();d.setDate(d.getDate()-d.getDay());return d.toISOString().slice(0,10);};
  const weekH=myE.filter(e=>e.date>=ws()).reduce((a,e)=>a+e.netHours,0).toFixed(2);
  const pending=entries.filter(e=>vids.includes(e.userId)&&e.approval==="submitted").length;

  const handleSave=(data)=>{
    if(editEntry){
      setEntries(prev=>prev.map(e=>e.id===editEntry.id?{...e,...data}:e));
    } else {
      // Block duplicate date for apprentices
      if(role==="Apprentice"){
        const already=entries.some(e=>e.userId===currentUser.id&&e.date===data.date);
        if(already){ showToast("You already have an entry for this date. Edit the existing one instead.",false); return; }
      }
      setEntries(prev=>[{id:uid(),userId:currentUser.id,...data},...prev]);
    }
    setShowForm(false); setEditEntry(null);
  };
  const handleApprove=async(id)=>{
    const entry=entries.find(e=>e.id===id);
    setEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"approved"}:e));
    if(entry){
      const apprentice=allUsers.find(u=>u.id===entry.userId);
      // Check if all submitted entries for that week are now approved (including this one)
      const getWk=d=>{const dt=new Date(d+"T00:00:00");dt.setDate(dt.getDate()-((dt.getDay()+6)%7));return dt.toISOString().slice(0,10);};
      const weekKey=getWk(entry.date);
      const weekEntries=entries.filter(e=>e.userId===entry.userId&&getWk(e.date)===weekKey);
      const nowAllApproved=weekEntries.every(e=>e.id===id?true:e.approval==="approved");
      if(nowAllApproved && weekEntries.length>1){
        // Full week approved — send week summary
        await notifyApprentice(apprentice, currentUser, weekEntries.map(e=>e.id===id?{...e,approval:"approved"}:e), true);
        showToast(`✓ Week approved — emailed ${apprentice?.name}`);
      } else {
        // Single day approved
        await notifyApprentice(apprentice, currentUser, [entry], true);
        showToast(`✓ Entry approved — emailed ${apprentice?.name}`);
      }
    }
  };
  const handleDecline=async(id)=>{
    const entry=entries.find(e=>e.id===id);
    setEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"declined"}:e));
    if(entry){
      const apprentice=allUsers.find(u=>u.id===entry.userId);
      await notifyApprentice(apprentice, currentUser, [entry], false);
      showToast(`Entry declined — emailed ${apprentice?.name}`, false);
    }
  };
  const handleDelete=(id)=>{
    const e=entries.find(x=>x.id===id);
    if(e && !canDelete(e)) return; // safety guard
    setEntries(prev=>prev.filter(e=>e.id!==id));
  };
  const handleEdit=(entry)=>{setEditEntry(entry);setShowForm(true);};

  const filterableUsers=allUsers.filter(u=>vids.includes(u.id));
  const showUserCol=role!=="Apprentice";
  const tcols=showUserCol
    ?"130px 130px 1fr 130px 64px 60px 70px 100px 68px"
    :"130px 1fr 130px 64px 60px 70px 100px 68px";

  return (
    <div className="fu">
      {toast&&(
        <div style={{position:"fixed",bottom:24,right:24,zIndex:999,
          background:toast.ok?T.accentL:T.warnL,
          border:`1.5px solid ${toast.ok?T.accent:T.warn}`,
          borderRadius:10,padding:"12px 20px",fontSize:13,fontWeight:600,
          color:toast.ok?T.accent:T.warn,boxShadow:"0 4px 20px #00000022",
          maxWidth:360,lineHeight:1.4}}>
          {toast.msg}
        </div>
      )}
      <div style={{background:ROLE_META[role].bg,border:`1.5px solid ${ROLE_META[role].color}44`,
        borderRadius:10,padding:"10px 16px",marginBottom:20,display:"flex",gap:10,alignItems:"center"}}>
        <span style={{fontSize:16}}>{ROLE_META[role].symbol}</span>
        <span style={{fontWeight:700,color:ROLE_META[role].color,fontSize:13}}>{role} View — </span>
        <span style={{fontSize:13,color:T.sub}}>{ROLE_META[role]?.desc||""}</span>
      </div>
      <div className="stat-grid-4">
        <StatCard label="Today (mine)" value={todayH?`${todayH}h`:"—"} color={todayH?T.accent:T.muted}/>
        <StatCard label="This Week (mine)" value={`${weekH}h`} color={T.warn}/>
        <StatCard label="Visible Entries" value={shown.length} color={T.blue}/>
        <StatCard label="Pending Approval" value={pending} sub="in your scope" color={pending>0?T.warn:T.muted}/>
      </div>
      {canAdd&&(
        <div style={{marginBottom:16,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <Btn onClick={()=>{setShowForm(s=>!s);setEditEntry(null);}} v={showForm?"ghost":"primary"}>
            {showForm?"✕ Cancel":"+ Log Entry"}
          </Btn>
          {role==="Apprentice"&&(()=>{
            const myDrafts=shown.filter(e=>e.approval==="draft"&&e.userId===currentUser.id);
            if(!myDrafts.length) return null;

            // Group drafts by week-ending Sunday
            const getWeekEnding = (dateStr) => {
              const [y,m,d] = dateStr.split('-').map(Number);
              // Use UTC to avoid timezone shifts
              const date = new Date(Date.UTC(y,m-1,d));
              const day = date.getUTCDay(); // 0=Sun
              const diff = day===0 ? 0 : 7-day;
              date.setUTCDate(date.getUTCDate()+diff);
              return date.toISOString().slice(0,10);
            };
            const draftsPerWeek = {};
            myDrafts.forEach(e=>{
              const we = getWeekEnding(e.date);
              if(!draftsPerWeek[we]) draftsPerWeek[we]=[];
              draftsPerWeek[we].push(e);
            });
            const weeks = Object.keys(draftsPerWeek).sort();

            const doSubmit = async (weekEnding) => {
              const toSubmit = weekEnding ? draftsPerWeek[weekEnding] : myDrafts;
              const ids = toSubmit.map(e=>e.id);
              setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"submitted"}:e));
              setWeekPickerDrafts(null);
              setWeekPickerSelected(null);
              const approvers = allUsers.filter(u=>
                (u.allocatedTo||[]).includes(currentUser.id) || currentUser.approverUserId===u.id
              );
              if(!approvers.length){
                showToast("Submitted — no approver assigned yet, no email sent",false);
              } else {
                try {
                  await notifyApprovers(currentUser, approvers, toSubmit);
                  showToast(`✓ Submitted & emailed ${approvers.map(a=>a.name).join(", ")}`);
                } catch(err) {
                  showToast(`Submitted but email failed: ${err.message}`,false);
                }
              }
            };

            return (
              <>
                <Btn v="blue" onClick={()=>{
                  if(weeks.length>1) {
                    setWeekPickerDrafts({weeks, draftsPerWeek});
                    setWeekPickerSelected(null);
                  } else {
                    doSubmit(weeks[0]);
                  }
                }}>
                  ↑ Submit {myDrafts.length} Draft{myDrafts.length!==1?"s":""}
                </Btn>

                {/* Week picker modal */}
                {weekPickerDrafts&&(
                  <div style={{position:"fixed",inset:0,background:"#00000066",zIndex:300,
                    display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
                    <Card style={{width:"100%",maxWidth:420,padding:24}}>
                      <div style={{fontWeight:700,fontSize:16,marginBottom:6}}>Which week to submit?</div>
                      <div style={{fontSize:13,color:T.sub,marginBottom:18}}>
                        Your drafts span multiple weeks. Choose which week to submit for approval.
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
                        {weekPickerDrafts.weeks.map(we=>{
                          const cnt = weekPickerDrafts.draftsPerWeek[we].length;
                          const hrs = weekPickerDrafts.draftsPerWeek[we].reduce((a,e)=>a+e.netHours,0).toFixed(2);
                          const [wy,wm,wd] = we.split('-');
                          const label = `${wd}/${wm}/${wy}`;
                          const selected = weekPickerSelected===we;
                          return (
                            <button key={we} onClick={()=>setWeekPickerSelected(we)} style={{
                              padding:"12px 14px",borderRadius:10,textAlign:"left",cursor:"pointer",
                              border:`2px solid ${selected?T.accent:T.border}`,
                              background:selected?T.accentL:T.surface,
                              fontFamily:"DM Sans,sans-serif",transition:"all .14s"}}>
                              <div style={{fontWeight:700,fontSize:14,color:selected?T.accent:T.ink}}>
                                Week ending {label}
                              </div>
                              <div style={{fontSize:12,color:T.sub,marginTop:3}}>
                                {cnt} entr{cnt===1?"y":"ies"} · {hrs}h total
                              </div>
                            </button>
                          );
                        })}
                        <button onClick={()=>setWeekPickerSelected("all")} style={{
                          padding:"12px 14px",borderRadius:10,textAlign:"left",cursor:"pointer",
                          border:`2px solid ${weekPickerSelected==="all"?T.blue:T.border}`,
                          background:weekPickerSelected==="all"?T.blueL:T.surface,
                          fontFamily:"DM Sans,sans-serif",transition:"all .14s"}}>
                          <div style={{fontWeight:700,fontSize:14,color:weekPickerSelected==="all"?T.blue:T.ink}}>
                            Submit all weeks at once
                          </div>
                          <div style={{fontSize:12,color:T.sub,marginTop:3}}>
                            {myDrafts.length} entries · {myDrafts.reduce((a,e)=>a+e.netHours,0).toFixed(2)}h total
                          </div>
                        </button>
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <Btn onClick={()=>{ if(weekPickerSelected) doSubmit(weekPickerSelected==="all"?null:weekPickerSelected); }}
                          disabled={!weekPickerSelected}>
                          Submit
                        </Btn>
                        <Btn v="ghost" onClick={()=>{setWeekPickerDrafts(null);setWeekPickerSelected(null);}}>Cancel</Btn>
                      </div>
                    </Card>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
      {showForm&&<div style={{marginBottom:20}}>
        <EntryForm onSave={handleSave} onCancel={()=>{setShowForm(false);setEditEntry(null);}} initial={editEntry}
          minDate={role==="Apprentice"?daysAgoStr(21):null}
          maxDate={role==="Apprentice"?tod():null}
          usedDates={role==="Apprentice"?entries.filter(e=>e.userId===currentUser.id).map(e=>e.date):[]}/>
      </div>}
      {filterableUsers.length>1&&(
        <div style={{display:"flex",gap:10,marginBottom:14}}>
          <select value={filterUid} onChange={e=>setFilterUid(e.target.value)}
            style={{width:220,fontSize:12,padding:"7px 28px 7px 11px"}}>
            <option value="all">All Visible Users</option>
            {filterableUsers.map(u=><option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
          </select>
        </div>
      )}
      {/* ── Approver view: grouped by apprentice with per-day + approve-week actions ── */}
      {(role==="Approver"||(role==="Admin"&&currentUser.secondaryRole==="Approver")) ? (()=>{
        const myApprentices = allUsers.filter(u=>
          u.role==="Apprentice" && (
            (currentUser.allocatedTo||[]).includes(u.id) ||
            u.approverUserId===currentUser.id
          )
        );
        if(myApprentices.length===0) return (
          <Card><div style={{padding:32,textAlign:"center",color:T.muted}}>No apprentices allocated to you yet.</div></Card>
        );

        // Week-ending Sunday, UTC-safe
        const getWeekEnding = (dateStr) => {
          const [y,m,d] = dateStr.split('-').map(Number);
          const date = new Date(Date.UTC(y,m-1,d));
          const day = date.getUTCDay();
          date.setUTCDate(date.getUTCDate() + (day===0 ? 0 : 7-day));
          return date.toISOString().slice(0,10);
        };
        const fmtWeekEnd = (we) => { const [y,m,d]=we.split('-'); return `${d}/${m}/${y}`; };

        return myApprentices.map(app=>{
          const appEntries = shown.filter(e=>e.userId===app.id).sort((a,b)=>b.date.localeCompare(a.date));
          const submitted  = appEntries.filter(e=>e.approval==="submitted");
          const weeks      = [...new Set(appEntries.map(e=>getWeekEnding(e.date)))].sort((a,b)=>b.localeCompare(a));

          const approveWeek = async (weekEnding)=>{
            const toApprove = submitted.filter(e=>getWeekEnding(e.date)===weekEnding);
            const ids = toApprove.map(e=>e.id);
            if(!ids.length) return;
            setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"approved"}:e));
            await notifyApprentice(app, currentUser, toApprove, true);
            showToast(`✓ Week approved — emailed ${app.name}`);
          };

          const approveAllWeeks = async ()=>{
            if(!submitted.length) return;
            const ids = submitted.map(e=>e.id);
            setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"approved"}:e));
            await notifyApprentice(app, currentUser, submitted, true);
            showToast(`✓ All pending entries approved — emailed ${app.name}`);
          };

          return (
            <Card key={app.id} style={{marginBottom:16,padding:0,overflow:"hidden"}}>
              {/* Apprentice header */}
              <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
                background:T.bg,borderBottom:`1.5px solid ${T.border}`,flexWrap:"wrap"}}>
                <Avatar name={app.name} role="Apprentice" size={34}/>
                <div style={{flex:1,minWidth:120}}>
                  <div style={{fontWeight:700,fontSize:14}}>{app.name}</div>
                  <div style={{fontSize:12,color:T.sub}}>{appEntries.length} entries · {submitted.length} awaiting approval</div>
                </div>
              </div>

              {/* Week approve buttons — one per week with pending entries */}
              {submitted.length>0&&(
                <div style={{padding:"10px 16px",background:T.warnL+"44",borderBottom:`1px solid ${T.border}`,
                  display:"flex",flexDirection:"column",gap:8}}>
                  <div style={{fontSize:11,fontWeight:600,color:T.warn,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>
                    Pending approval
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                    {weeks.filter(we=>submitted.some(e=>getWeekEnding(e.date)===we)).map(we=>{
                      const cnt = submitted.filter(e=>getWeekEnding(e.date)===we).length;
                      const hrs = submitted.filter(e=>getWeekEnding(e.date)===we).reduce((a,e)=>a+e.netHours,0).toFixed(2);
                      return (
                        <button key={we} onClick={()=>{
                          if(window.confirm(`Approve week ending ${fmtWeekEnd(we)} for ${app.name}?\n${cnt} ${cnt===1?"entry":"entries"} · ${hrs}h total`))
                            approveWeek(we);
                        }} style={{
                          padding:"9px 16px",borderRadius:8,fontSize:13,fontWeight:700,
                          background:T.accent,color:"#fff",border:"none",
                          cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                          display:"flex",alignItems:"center",gap:7,transition:"opacity .14s"}}
                          onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
                          onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                          ✓ Approve week ending {fmtWeekEnd(we)}
                          <span style={{fontWeight:400,opacity:.8,fontSize:12}}>({cnt} {cnt===1?"entry":"entries"} · {hrs}h)</span>
                        </button>
                      );
                    })}
                    {weeks.filter(we=>submitted.some(e=>getWeekEnding(e.date)===we)).length > 1 && (
                      <button onClick={()=>{
                        if(window.confirm(`Approve ALL ${submitted.length} pending entries for ${app.name}?`))
                          approveAllWeeks();
                      }} style={{
                        padding:"9px 16px",borderRadius:8,fontSize:13,fontWeight:700,
                        background:T.accentD,color:"#fff",border:"none",
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif",transition:"opacity .14s"}}
                        onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
                        onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                        ✓✓ Approve all pending
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Column headers */}
              <div style={{display:"grid",
                gridTemplateColumns:"100px 1fr 110px 56px 80px 70px 80px",
                padding:"8px 16px",background:T.bg,
                fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
                <span>Date</span><span>Note</span><span>Type</span>
                <span style={{textAlign:"center"}}>Hours</span>
                <span style={{textAlign:"center"}}>Start–End</span>
                <span style={{textAlign:"center"}}>Break</span>
                <span>Status / Action</span>
              </div>

              {appEntries.length===0&&(
                <div style={{padding:"24px",textAlign:"center",color:T.muted,fontSize:12,fontStyle:"italic"}}>No entries yet.</div>
              )}
              {appEntries.map((e,i)=>(
                <div key={e.id} style={{display:"grid",
                  gridTemplateColumns:"100px 1fr 110px 56px 80px 70px 80px",
                  padding:"9px 16px",gap:8,alignItems:"center",fontSize:12,
                  borderBottom:i<appEntries.length-1?`1px solid ${T.border}44`:"none",
                  background:e.approval==="submitted"?T.warnL+"55":i%2===0?T.surface:T.bg}}>
                  <div style={{fontWeight:600,fontSize:12}}>{fmtD(e.date)}</div>
                  <div style={{color:e.note?T.ink:T.muted,fontStyle:e.note?"normal":"italic",
                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12}}>{e.note||"No note"}</div>
                  <TypePill type={e.type} size="sm"/>
                  <div style={{textAlign:"center",fontWeight:700,color:TYPE_META[e.type]?.color||T.accent,
                    fontFamily:"'Libre Baskerville'",fontSize:14}}>{e.netHours}h</div>
                  <div style={{textAlign:"center",fontSize:11,color:T.muted,fontFamily:"monospace"}}>{e.start}–{e.end}</div>
                  <div style={{textAlign:"center",fontSize:11,color:T.sub}}>{e.breakMins>0?`${e.breakMins}m`:"—"}</div>
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>
                    {e.approval==="submitted"&&(<>
                      <button onClick={()=>handleApprove(e.id)} title="Approve" style={{
                        width:26,height:26,borderRadius:6,fontSize:12,background:T.accentL,color:T.accent,
                        border:`1px solid ${T.accent}44`,cursor:"pointer",flexShrink:0,
                        display:"flex",alignItems:"center",justifyContent:"center"}}>✓</button>
                      <button onClick={()=>handleDecline(e.id)} title="Decline" style={{
                        width:26,height:26,borderRadius:6,fontSize:12,background:T.redL,color:T.red,
                        border:`1px solid ${T.red}44`,cursor:"pointer",flexShrink:0,
                        display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                    </>)}
                    {e.approval==="approved"&&<AppvPill status="approved"/>}
                    {e.approval==="declined"&&(<>
                      <AppvPill status="declined"/>
                      <button onClick={()=>handleApprove(e.id)} title="Re-approve" style={{
                        width:26,height:26,borderRadius:6,fontSize:11,background:T.accentL,color:T.accent,
                        border:`1px solid ${T.accent}44`,cursor:"pointer",flexShrink:0,
                        display:"flex",alignItems:"center",justifyContent:"center"}}>↺</button>
                    </>)}
                    {e.approval==="draft"&&<AppvPill status="draft"/>}
                  </div>
                </div>
              ))}
            </Card>
          );
        });
      })() : (<>
        <Card style={{padding:0,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:tcols,padding:"10px 16px",
            background:T.bg,borderBottom:`1.5px solid ${T.border}`,
            fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
            <span>Date</span>{showUserCol&&<span>Person</span>}<span>Note</span><span>Type</span>
            <span style={{textAlign:"center"}}>Hours</span><span style={{textAlign:"center"}}>Break</span>
            <span style={{textAlign:"center"}}>Time</span><span>Status</span>
            <span style={{textAlign:"right"}}>Actions</span>
          </div>
          {shown.length===0&&(
            <div style={{padding:"48px 24px",textAlign:"center",color:T.muted}}>
              <div style={{fontSize:32,marginBottom:8}}>◈</div>
              <div style={{fontWeight:600}}>No entries to display</div>
              <div style={{fontSize:12,marginTop:4}}>{canAdd?"Use the button above to log your first entry.":"No entries in your scope yet."}</div>
            </div>
          )}
          {shown.map((e,i)=>(
            <EntryRow key={e.id} entry={e} idx={i}
              canEdit={canEdit(e)} canApprove={canApprove(e)}
              onDelete={handleDelete} onApprove={handleApprove}
              onDecline={handleDecline} onEdit={handleEdit}
              canDelete={canDelete(e)}
              canSubmitXero={role==="Admin" && (currentUser?.adminLevel||1)===1}
              onSubmitXero={async(id)=>{
                const en = entries.find(x=>x.id===id);
                if(!en) return;
                const app = allUsers.find(u=>u.id===en.userId);
                if(!app?.xeroEmployeeId) {
                  showToast(`No Xero Employee ID set for ${app?.name||"this apprentice"} — map them in the Xero module first.`, false);
                  return;
                }
                setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"submitting"}:x));
                try {
                  const res = await submitEntryToXero(en, app, entries);
                  if(res.ok) {
                    setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"submitted",xeroTimesheetId:res.timesheetId}:x));
                    showToast(`✓ Submitted to Xero for ${app.name}`);
                  } else {
                    setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"error",xeroError:res.error}:x));
                    showToast(`Xero error: ${res.error}`, false);
                  }
                } catch(e) {
                  setEntries(prev=>prev.map(x=>x.id===id?{...x,xeroStatus:"error",xeroError:e.message}:x));
                  showToast(`Xero error: ${e.message}`, false);
                }
              }}
              onSubmit={role==="Apprentice"?async(id)=>{
                setEntries(prev=>prev.map(x=>x.id===id?{...x,approval:"submitted"}:x));
                const entry=shown.find(e=>e.id===id);
                if(entry){
                  const approvers=allUsers.filter(u=>
                    (u.allocatedTo||[]).includes(currentUser.id) ||
                    currentUser.approverUserId===u.id
                  );
                  if(!approvers.length){
                    showToast("Submitted — no approver assigned yet, no email sent",false);
                  } else {
                    try {
                      await notifyApprovers(currentUser, approvers, [entry]);
                      showToast(`✓ Submitted & emailed ${approvers.map(a=>a.name).join(", ")}`);
                    } catch(e) {
                      showToast(`Submitted but email failed: ${e.message}`,false);
                    }
                  }
                }
              }:null}
              showUser={showUserCol} users={allUsers}/>
          ))}
        </Card>
        {shown.length>0&&(
          <div style={{textAlign:"right",fontSize:12,color:T.sub,marginTop:10}}>
            {shown.length} entr{shown.length===1?"y":"ies"} · <strong style={{color:T.accent}}>{shown.reduce((a,e)=>a+e.netHours,0).toFixed(2)}h</strong> net
          </div>
        )}
      </>)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
function UserManagement({users, setUsers, currentUser}) {
  const myLevel = currentUser?.adminLevel || 1; // 1 = superadmin, 2 = limited admin

  // Roles this admin level is allowed to create/edit
  // Admin 1: all roles. Admin 2: all except Admin 1.
  const creatableRoles = myLevel===1
    ? ["Apprentice","Approver","Viewer","Mentor","Admin"]
    : ["Apprentice","Approver","Viewer","Mentor","Admin"]; // same list — Admin 2 can create Admin 2 but not Admin 1 (enforced below)

  // Can this admin edit a given user?
  const canEditUser = (u) => {
    if(myLevel===1) return true;
    // Admin 2 cannot edit Admin 1 users
    if(u.role==="Admin" && (u.adminLevel||1)===1) return false;
    return true;
  };
  const canDeleteUser = (u) => canEditUser(u);
  const canCreateUsers = true; // both admin levels can create users

  const blank={name:"",role:"Apprentice",email:"",phone:"",password:"",allocatedTo:[],
    address:"",suburb:"",city:"",postcode:"",approverUserId:null,viewerUserId:null,secondaryRole:null,adminLevel:1};
  const [form,setForm]=useState(blank);
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [pwField,setPwField]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [appApprover, setAppApprover] = useState("");
  const [appViewer,   setAppViewer]   = useState("");
  const [appMentor,   setAppMentor]   = useState("");
  const sf=(k,v)=>setForm(f=>({...f,[k]:v}));

  const toggleAlloc=(uid)=>setForm(f=>({...f,allocatedTo:f.allocatedTo.includes(uid)?f.allocatedTo.filter(x=>x!==uid):[...f.allocatedTo,uid]}));

  const submit=()=>{
    if(!form.name.trim()||!form.email.trim()) return;
    const finalForm={...form};
    if(pwField.trim()) finalForm.password=hashPw(pwField.trim());
    const targetId = editId || uid();

    // Always bake approver/viewer into finalForm for apprentices
    if(finalForm.role==="Apprentice") {
      finalForm.approverUserId = appApprover||null;
      finalForm.viewerUserId   = appViewer||null;
      finalForm.mentorUserId   = appMentor||null;
    }
    // Clear secondaryRole if not Admin; default adminLevel to 1 for non-admins
    if(finalForm.role!=="Admin") { finalForm.secondaryRole = null; finalForm.adminLevel = null; }
    // Admin 2 cannot create/promote to Admin 1
    if(finalForm.role==="Admin" && myLevel===2) finalForm.adminLevel = 2;

    setUsers(prev=>{
      let next = editId
        ? prev.map(u=>u.id===editId?{...u,...finalForm}:u)
        : [...prev,{id:targetId,...finalForm}];

      if(finalForm.role==="Apprentice") {
        // Sync allocatedTo on approver/viewer users (legacy support)
        next = next.map(u => {
          if(u.id === targetId) return u;
          if(!["Approver","Viewer","Admin"].includes(u.role)) return u;
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
    setAppApprover("");setAppViewer("");setAppMentor("");
  };

  const startEdit=(u)=>{
    setForm({name:u.name,role:u.role,email:u.email||"",phone:u.phone||"",password:u.password,
      allocatedTo:u.allocatedTo||[],address:u.address||"",suburb:u.suburb||"",
      city:u.city||"",postcode:u.postcode||"",
      approverUserId:u.approverUserId||null,viewerUserId:u.viewerUserId||null,
      secondaryRole:u.secondaryRole||null,adminLevel:u.adminLevel||1});
    setPwField(""); setEditId(u.id); setShowForm(true);
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
    }
    setTimeout(()=>document.getElementById("um-form")?.scrollIntoView({behavior:"smooth",block:"start"}),50);
  };
  const deleteUser=(id)=>{if(window.confirm("Remove this user?"))setUsers(prev=>prev.filter(u=>u.id!==id));};

  // For Approver/Viewer/Mentor: allocatable = apprentices (or apprentices+viewers for mentor)
  const allocatable=users.filter(u=>u.id!==(editId||"__")&&
    (["Approver","Viewer"].includes(form.role)?u.role==="Apprentice":
     form.role==="Mentor"?["Apprentice","Viewer"].includes(u.role):false));

  // For Apprentice approver/viewer dropdowns: include Admins with matching secondary role too
  const approverOptions = users.filter(u=>u.role==="Approver"||u.role==="Admin");
  const viewerOptions   = users.filter(u=>u.role==="Viewer"  ||u.role==="Admin");

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:18}}>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setPwField("");setShowForm(s=>!s);setAppApprover("");setAppViewer("");}}>
          {showForm?"✕ Cancel":"+ Add User"}
        </Btn>
      </div>

      {showForm&&(
        <Card id="um-form" style={{marginBottom:20,border:`1.5px solid ${T.blue}44`}}>
          <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:T.blue}}>
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
            {form.role==="Admin"&&(
              <div>
                <FL>Secondary Role <span style={{fontWeight:400,color:T.muted}}>(optional — grants additional access)</span></FL>
                <select value={form.secondaryRole||""} onChange={e=>sf("secondaryRole",e.target.value||null)}>
                  <option value="">— None —</option>
                  <option value="Approver">Approver — can approve timesheets for allocated apprentices</option>
                  <option value="Viewer">Viewer — read-only access to allocated apprentices' timesheets</option>
                </select>
                {form.secondaryRole&&(
                  <div style={{marginTop:6,display:"flex",alignItems:"center",gap:8}}>
                    <RolePill role="Admin"/>
                    <span style={{fontSize:12,color:T.muted}}>+</span>
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
                          flex:1,padding:"10px 12px",borderRadius:9,fontSize:13,fontWeight:600,
                          border:`2px solid ${locked?T.border:(form.adminLevel||1)===lvl?T.accent:T.border}`,
                          background:locked?T.bg:(form.adminLevel||1)===lvl?T.accentL:T.surface,
                          color:locked?T.muted:(form.adminLevel||1)===lvl?T.accent:T.sub,
                          cursor:locked?"not-allowed":"pointer",textAlign:"left",
                          fontFamily:"DM Sans,sans-serif",transition:"all .15s",opacity:locked?.5:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                          <span style={{fontSize:16}}>{lvl===1?"★":"☆"}</span>
                          <span>Admin Level {lvl}{locked?" (requires Admin 1)":""}</span>
                        </div>
                        <div style={{fontSize:11,fontWeight:400,lineHeight:1.4,
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
            <div>
              <FL>{editId?"New Password (leave blank to keep)":"Password"}</FL>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} placeholder={editId?"Leave blank to keep current":"Set password"}
                  value={pwField} onChange={e=>setPwField(e.target.value)}
                  style={{paddingRight:60}}/>
                <button onClick={()=>setShowPw(s=>!s)} type="button" style={{
                  position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
                  background:"none",border:"none",color:T.muted,cursor:"pointer",
                  fontSize:12,fontFamily:"DM Sans,sans-serif"}}>
                  {showPw?"Hide":"Show"}
                </button>
              </div>
              {!editId&&<div style={{fontSize:11,color:T.muted,marginTop:4}}>Required for new users</div>}
            </div>
          </div>

          {/* Address fields — optional */}
          <div style={{borderTop:`1px dashed ${T.border}`,paddingTop:12,marginBottom:12}}>
            <div style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:10}}>
              Address <span style={{fontWeight:400,textTransform:"none",letterSpacing:0}}>(optional)</span>
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
                ? <div style={{fontSize:12,color:T.muted,fontStyle:"italic",marginTop:4}}>
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
                              padding:"4px 10px",borderRadius:99,fontSize:12,fontWeight:600,
                              background:T.accentL,color:T.accent,
                              border:`1.5px solid ${T.accent}44`}}>
                              {u.name}
                              <button onClick={()=>toggleAlloc(id)} style={{
                                background:"none",border:"none",color:T.accent,
                                cursor:"pointer",padding:0,fontSize:13,lineHeight:1,
                                fontFamily:"DM Sans,sans-serif"}}>×</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {form.allocatedTo.length===0&&(
                      <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>None selected yet</div>
                    )}
                  </>
              }
            </div>
          )}

          {/* Apprentice: pick which Approver and Viewer are assigned to them */}
          {form.role==="Apprentice"&&(
            <div className="fg2" style={{display:"grid",gap:16,marginBottom:16}}>
              <div>
                <FL>Approver <span style={{fontWeight:400,color:T.muted}}>(approves timesheets)</span></FL>
                <select value={appApprover} onChange={e=>setAppApprover(e.target.value)}>
                  <option value="">— None —</option>
                  {approverOptions.map(u=>(
                    <option key={u.id} value={u.id}>
                      {u.name}{u.role==="Admin"?` (Admin${u.secondaryRole?` + ${u.secondaryRole}`:""})`:""}</option>
                  ))}
                </select>
              </div>
              <div>
                <FL>Viewer <span style={{fontWeight:400,color:T.muted}}>(read-only access)</span></FL>
                <select value={appViewer} onChange={e=>setAppViewer(e.target.value)}>
                  <option value="">— None —</option>
                  {viewerOptions.map(u=>(
                    <option key={u.id} value={u.id}>
                      {u.name}{u.role==="Admin"?` (Admin${u.secondaryRole?` + ${u.secondaryRole}`:""})`:""}</option>
                  ))}
                </select>
              </div>
              <div>
                <FL>Mentor <span style={{fontWeight:400,color:T.muted}}>(assigned KTA mentor)</span></FL>
                <select value={appMentor} onChange={e=>setAppMentor(e.target.value)}>
                  <option value="">— None —</option>
                  {users.filter(u=>u.role==="Mentor"||(u.role==="Admin")).map(u=>(
                    <option key={u.id} value={u.id}>{u.name}{u.role==="Admin"?" (Admin)":""}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update User":"Create User"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);setAppApprover("");setAppViewer("");setAppMentor("");}}>Cancel</Btn>
          </div>
        </Card>
      )}

      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"44px 1fr 130px 170px 1fr 72px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <span/><span>Name</span><span>Role</span><span>Email</span><span>Allocated To</span><span/>
        </div>
        {users.map((u,i)=>{
          const isEditing = editId===u.id && showForm;
          return (
          <div key={u.id} className="ri" style={{
            display:"grid",gridTemplateColumns:"44px 1fr 130px 170px 1fr 72px",
            padding:"12px 16px",borderBottom:i<users.length-1?`1px solid ${T.border}44`:"none",
            background:isEditing?T.blueL:i%2===0?T.surface:T.bg,
            alignItems:"center",gap:8,animationDelay:`${i*.03}s`,
            cursor:canEditUser(u)?"pointer":"default"}}
            onClick={()=>canEditUser(u)&&startEdit(u)}
            onMouseEnter={e=>{if(!isEditing&&canEditUser(u))e.currentTarget.style.background=T.blueL+"99";}}
            onMouseLeave={e=>{e.currentTarget.style.background=isEditing?T.blueL:i%2===0?T.surface:T.bg;}}>
            <Avatar name={u.name} role={u.role}/>
            <div>
              <div style={{fontWeight:700,fontSize:13}}>{u.name}</div>
              {u.phone&&<div style={{fontSize:11,color:T.muted}}>{u.phone}</div>}
              <div style={{fontSize:11,color:canEditUser(u)?T.blue:T.muted,marginTop:1}}>
                {isEditing?"editing…":canEditUser(u)?"click to edit":"view only"}
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
              <RolePill role={u.role} adminLevel={u.adminLevel||null} size="sm"/>
              {u.role==="Admin"&&u.secondaryRole&&(
                <><span style={{fontSize:10,color:T.muted}}>+</span><RolePill role={u.secondaryRole} size="sm"/></>
              )}
            </div>
            <div style={{fontSize:12,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.email||"—"}</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center"}}>
              {(u.allocatedTo||[]).length===0&&<span style={{fontSize:11,color:T.muted,fontStyle:"italic"}}>—</span>}
              {(u.allocatedTo||[]).map(aid=>{
                const a=users.find(x=>x.id===aid);
                return a?<span key={aid} style={{fontSize:12,color:T.sub,display:"flex",alignItems:"center",gap:4}}>
                  <RolePill role={a.role} size="sm"/>{a.name}
                </span>:null;
              })}
            </div>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}} onClick={e=>e.stopPropagation()}>
              {canEditUser(u)&&(
                <button onClick={()=>startEdit(u)} style={{width:26,height:26,borderRadius:6,fontSize:12,
                  background:isEditing?T.blueL:"transparent",color:isEditing?T.blue:T.muted,
                  border:`1px solid ${isEditing?T.blue+"66":T.border}`,
                  display:"flex",alignItems:"center",justifyContent:"center"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                  onMouseLeave={e=>{e.currentTarget.style.background=isEditing?T.blueL:"transparent";e.currentTarget.style.color=isEditing?T.blue:T.muted;}}>✎</button>
              )}
              {canDeleteUser(u)&&(
                <button onClick={()=>deleteUser(u.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,
                  background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
                  display:"flex",alignItems:"center",justifyContent:"center"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                  onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
              )}
              {!canEditUser(u)&&(
                <span style={{fontSize:11,color:T.muted,fontStyle:"italic",padding:"0 4px"}}>🔒</span>
              )}
            </div>
          </div>
          );
        })}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CRM MODULE
// ─────────────────────────────────────────────────────────────────────────────
function CRMModule({currentUser,allUsers}) {
  const [contacts,setContacts]=useState([]);
  const [deals,setDeals]=useState([]);
  const [crmLoading,setCrmLoading]=useState(true);
  const [tab,setTab]=useState("contacts");
  const [showCF,setShowCF]=useState(false);
  const [showDF,setShowDF]=useState(false);
  const [cForm,setCForm]=useState({name:"",company:"",email:"",phone:"",status:"Active",notes:""});
  const [dForm,setDForm]=useState({title:"",contact:"",value:"",stage:"Lead",closeDate:"",notes:""});
  const [editCId,setEditCId]=useState(null);
  const [hsEmail,setHsEmail]=useState("");
  const [hsStatus,setHsStatus]=useState(null); // null | "searching" | "found" | "notfound" | "error"
  const [hsSource,setHsSource]=useState(false); // true if form was populated from HubSpot

  useEffect(()=>{
    (async()=>{
      try{
        const [c,d]=await Promise.all([loadTable('crm_contacts'),loadTable('crm_deals')]);
        setContacts(c.map(x=>({id:x.id,name:x.name,company:x.company||"",email:x.email||"",phone:x.phone||"",status:x.status||"Active",notes:x.notes||""})));
        setDeals(d.map(x=>({id:x.id,title:x.title,contact:x.contact||"",value:x.value||"",stage:x.stage||"Lead",closeDate:x.close_date||"",notes:x.notes||""})));
      }catch(e){console.error('CRM load',e);}
      finally{setCrmLoading(false);}
    })();
  },[]);

  const role=currentUser.role;
  const fullAccess=role==="Admin"||role==="Mentor";
  const canEdit=role==="Admin"||role==="Mentor"; // Both Admins (all levels) and Mentors can create/edit contacts & deals

  const sc=(k,v)=>setCForm(f=>({...f,[k]:v}));
  const sd=(k,v)=>setDForm(f=>({...f,[k]:v}));

  const resetContactForm = () => {
    setCForm({name:"",company:"",email:"",phone:"",status:"Active",notes:""});
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
    if(editCId){
      const updated={id:editCId,...row};
      setContacts(prev=>prev.map(c=>c.id===editCId?{...c,...row}:c));
      upsertRow('crm_contacts',{id:editCId,name:row.name,company:row.company||"",email:row.email||"",phone:row.phone||"",status:row.status||"Active",notes:row.notes||""}).catch(console.error);
      setEditCId(null);
    } else {
      const id=uid();
      setContacts(prev=>[{id,...row},...prev]);
      upsertRow('crm_contacts',{id,name:row.name,company:row.company||"",email:row.email||"",phone:row.phone||"",status:row.status||"Active",notes:row.notes||""}).catch(console.error);
    }
    setCForm({name:"",company:"",email:"",phone:"",status:"Active",notes:""});resetContactForm();setShowCF(false);
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
  const startEditC=(c)=>{setCForm({name:c.name,company:c.company||"",email:c.email||"",phone:c.phone||"",status:c.status,notes:c.notes||""});setEditCId(c.id);setHsStatus(null);setHsSource(false);setHsEmail("");setShowCF(true);};

  const pipeline=STAGES.map(s=>({stage:s,color:STAGE_C[s],
    items:deals.filter(d=>d.stage===s),
    value:deals.filter(d=>d.stage===s).reduce((a,d)=>a+(parseFloat(d.value)||0),0)}));
  const totalOpen=deals.filter(d=>!["Won","Lost"].includes(d.stage)).reduce((a,d)=>a+(parseFloat(d.value)||0),0);
  const totalWon=deals.filter(d=>d.stage==="Won").reduce((a,d)=>a+(parseFloat(d.value)||0),0);

  if(!fullAccess) return (
    <div className="fu">
      <div style={{background:T.warnL,border:`1.5px solid ${T.warn}44`,borderRadius:10,padding:"16px 20px",display:"flex",gap:12,alignItems:"center"}}>
        <span style={{fontSize:22}}>🔒</span>
        <div>
          <strong style={{color:T.warn,fontSize:14}}>Restricted Access</strong>
          <div style={{fontSize:13,color:T.sub,marginTop:3}}>CRM is available to Admins and Mentors only.</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fu">
      <div style={{background:ROLE_META[role].bg,border:`1.5px solid ${ROLE_META[role].color}44`,
        borderRadius:10,padding:"10px 16px",marginBottom:20,display:"flex",gap:10,alignItems:"center"}}>
        <span style={{fontSize:16}}>{ROLE_META[role].symbol}</span>
        <span style={{fontWeight:700,color:ROLE_META[role].color,fontSize:13}}>{role} View — </span>
        <span style={{fontSize:13,color:T.sub}}>{canEdit?"Full CRM access — edit contacts and deals":"Read-only CRM view"}</span>
      </div>
      <div className="stat-grid-4">
        <StatCard label="Contacts" value={contacts.length} color={T.blue}/>
        <StatCard label="Active Deals" value={deals.filter(d=>!["Won","Lost"].includes(d.stage)).length} color={T.warn}/>
        <StatCard label="Pipeline" value={`$${(totalOpen/1000).toFixed(1)}k`} color={T.accent}/>
        <StatCard label="Won" value={`$${(totalWon/1000).toFixed(1)}k`} color={T.hol}/>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        {["contacts","pipeline","deals"].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{
            padding:"7px 16px",borderRadius:8,fontSize:13,fontWeight:600,
            background:tab===t?T.accent:T.surface,color:tab===t?"#fff":T.sub,
            border:`1.5px solid ${tab===t?T.accentD:T.border}`,
            fontFamily:"DM Sans,sans-serif",cursor:"pointer",transition:"all .14s"
          }}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>
        ))}
      </div>
      {tab==="contacts"&&(<>
        {canEdit&&<div style={{marginBottom:14}}>
          <Btn sm onClick={()=>{ resetContactForm(); setEditCId(null); setShowCF(s=>!s); }}>
            {showCF?"✕ Cancel":"+ Add Contact"}
          </Btn>
        </div>}

        {showCF&&<Card style={{marginBottom:16,border:`1.5px solid ${T.blue}44`}}>
          {/* ── Step 1: HubSpot lookup (only shown for new contacts) ── */}
          {!editCId&&hsStatus!=="found"&&hsStatus!=="notfound"&&(
            <div style={{marginBottom:16}}>
              <div style={{fontWeight:700,fontSize:13,color:T.ink,marginBottom:4,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:16}}>🔍</span> Look up in HubSpot
              </div>
              <div style={{fontSize:12,color:T.sub,marginBottom:10}}>Enter an email or phone number to auto-fill from HubSpot.</div>
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
                  borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",
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
                  background:"none",border:"none",color:T.muted,fontSize:12,
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif",textDecoration:"underline"
                }}>Skip — enter manually</button>
              </div>
            </div>
          )}

          {/* ── HubSpot result banner ── */}
          {hsStatus==="found"&&(
            <div style={{background:T.accentL,border:`1.5px solid ${T.accent}44`,borderRadius:9,
              padding:"9px 14px",marginBottom:14,display:"flex",gap:10,alignItems:"center",fontSize:13}}>
              <span style={{fontSize:16}}>✓</span>
              <div style={{flex:1}}>
                <strong style={{color:T.accent}}>Found in HubSpot</strong>
                <span style={{color:T.sub,marginLeft:8}}>Fields auto-filled — review and save.</span>
              </div>
              <button onClick={()=>{setHsStatus(null);setHsSource(false);resetContactForm();}} style={{
                background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:13,fontFamily:"DM Sans,sans-serif"
              }}>✕ Clear</button>
            </div>
          )}
          {hsStatus==="notfound"&&!editCId&&(
            <div style={{background:T.warnL,border:`1.5px solid ${T.warn}44`,borderRadius:9,
              padding:"9px 14px",marginBottom:14,display:"flex",gap:10,alignItems:"center",fontSize:13}}>
              <span>⚠</span>
              <span style={{color:T.warn,flex:1}}>Not found in HubSpot — fill in manually below.</span>
              <button onClick={()=>{setHsStatus(null);setHsEmail("");}} style={{
                background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:13,fontFamily:"DM Sans,sans-serif"
              }}>← Try again</button>
            </div>
          )}

          {/* ── Contact fields (shown after lookup result or skip) ── */}
          {(editCId||hsStatus==="found"||hsStatus==="notfound")&&(<>
            <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
              <div><FL req>Name</FL><input value={cForm.name} onChange={e=>sc("name",e.target.value)} placeholder="Contact name"/></div>
              <div><FL>Company</FL><input value={cForm.company} onChange={e=>sc("company",e.target.value)} placeholder="Company"/></div>
              <div><FL>Email</FL><input value={cForm.email} onChange={e=>sc("email",e.target.value)} placeholder="email@co.com"/></div>
              <div><FL>Phone</FL><input value={cForm.phone} onChange={e=>sc("phone",e.target.value)} placeholder="+64…"/></div>
              <div><FL>Status</FL>
                <select value={cForm.status} onChange={e=>sc("status",e.target.value)}>
                  {["Active","Prospect","Inactive"].map(s=><option key={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={cForm.notes} onChange={e=>sc("notes",e.target.value)} placeholder="Notes…"/></div>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={saveContact}>{editCId?"Update":"Save Contact"}</Btn>
              <Btn v="ghost" onClick={()=>{setShowCF(false);setEditCId(null);resetContactForm();}}>Cancel</Btn>
            </div>
          </>)}
        </Card>}
        <Card style={{padding:0,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 140px 160px 100px 60px",
            padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
            fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
            <span>Name</span><span>Email</span><span>Phone</span><span>Status</span><span/>
          </div>
          {contacts.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No contacts yet.</div>}
          {contacts.map((c,i)=>(
            <div key={c.id} className="ri" style={{display:"grid",gridTemplateColumns:"1fr 140px 160px 100px 60px",
              padding:"12px 16px",borderBottom:i<contacts.length-1?`1px solid ${T.border}44`:"none",
              background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
              <div>
                <div style={{fontWeight:700,fontSize:13}}>{c.name}</div>
                {c.company&&<div style={{fontSize:11,color:T.muted}}>{c.company}</div>}
              </div>
              <div style={{fontSize:12,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.email||"—"}</div>
              <div style={{fontSize:12,color:T.sub}}>{c.phone||"—"}</div>
              <Pill label={c.status} size="sm"
                color={c.status==="Active"?T.accent:c.status==="Prospect"?T.warn:T.muted}
                bg={c.status==="Active"?T.accentL:c.status==="Prospect"?T.warnL:T.slateL}/>
              {canEdit&&<div style={{display:"flex",gap:5}}>
                <button onClick={()=>startEditC(c)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                  onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
                <button onClick={()=>setContacts(prev=>prev.filter(x=>x.id!==c.id))} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                  onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
              </div>}
            </div>
          ))}
        </Card>
      </>)}
      {tab==="pipeline"&&<div style={{overflowX:"auto"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,minWidth:900}}>
          {pipeline.map(({stage,color,items,value})=>(
            <div key={stage}>
              <div style={{padding:"8px 11px",borderRadius:"9px 9px 0 0",background:color+"18",borderBottom:`2px solid ${color}`,marginBottom:8}}>
                <div style={{fontWeight:700,fontSize:12,color}}>{stage}</div>
                <div style={{fontSize:11,color:T.muted,marginTop:2}}>{items.length} · ${value.toLocaleString()}</div>
              </div>
              {items.map(d=>(
                <div key={d.id} style={{background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:9,padding:"10px 12px",marginBottom:8}}>
                  <div style={{fontWeight:700,fontSize:13}}>{d.title}</div>
                  {d.contact&&<div style={{color:T.muted,fontSize:11,marginTop:2}}>{d.contact}</div>}
                  {d.value&&<div style={{color,fontWeight:700,fontSize:14,marginTop:5}}>${parseFloat(d.value).toLocaleString()}</div>}
                  {canEdit&&<div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:9}}>
                    {STAGES.filter(s=>s!==stage).map(s=>(
                      <button key={s} onClick={()=>moveDeal(d.id,s)} style={{
                        fontSize:9,padding:"2px 6px",borderRadius:4,
                        background:STAGE_C[s]+"22",color:STAGE_C[s],border:"none",
                        fontWeight:700,cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>→{s}</button>
                    ))}
                  </div>}
                </div>
              ))}
              {items.length===0&&<div style={{color:T.muted,fontSize:11,textAlign:"center",paddingTop:12}}>Empty</div>}
            </div>
          ))}
        </div>
      </div>}
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
            fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:10}}>
            <span/><span>Deal</span><span>Contact</span><span style={{textAlign:"right"}}>Value</span>
            <span>Stage</span><span>Close</span><span/>
          </div>
          {deals.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No deals yet.</div>}
          {deals.map((d,i)=>(
            <div key={d.id} className="ri" style={{display:"grid",gridTemplateColumns:"8px 1fr 140px 100px 120px 100px 40px",
              padding:"12px 16px",borderBottom:i<deals.length-1?`1px solid ${T.border}44`:"none",
              background:i%2===0?T.surface:T.bg,alignItems:"center",gap:10,animationDelay:`${i*.03}s`}}>
              <div style={{width:8,height:34,borderRadius:3,background:STAGE_C[d.stage]||T.muted}}/>
              <div><div style={{fontWeight:700,fontSize:13}}>{d.title}</div>
                {d.notes&&<div style={{fontSize:11,color:T.muted,marginTop:1}}>{d.notes}</div>}</div>
              <div style={{fontSize:12,color:T.sub}}>{d.contact||"—"}</div>
              <div style={{textAlign:"right",fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:14,color:STAGE_C[d.stage]||T.muted}}>
                {d.value?`$${parseFloat(d.value).toLocaleString()}`:"—"}</div>
              <Pill label={d.stage} size="sm" color={STAGE_C[d.stage]||T.muted} bg={(STAGE_C[d.stage]||T.muted)+"1a"}/>
              <div style={{fontSize:11,color:T.muted}}>{d.closeDate?new Date(d.closeDate+"T00:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}):"—"}</div>
              {canEdit&&<button onClick={()=>{ setDeals(prev=>prev.filter(x=>x.id!==d.id)); deleteRow("crm_deals",d.id).catch(console.error); }} style={{
                width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,
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
function WeeklyHoursList({allUsers, entries}) {
  const ws = ()=>{ const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };
  const wsDate = ws();
  const apprentices = [...allUsers.filter(u=>u.role==="Apprentice")].sort((a,b)=>a.name.localeCompare(b.name));
  const weekEntries = entries.filter(e=>e.date>=wsDate);

  // Total hours by type across all apprentices this week
  const globalTypeHrs = ENTRY_TYPES.map(t=>({
    type:t,
    hrs:weekEntries.reduce((a,e)=>e.type===t?a+e.netHours:a,0)
  })).filter(x=>x.hrs>0);
  const globalTotal = weekEntries.reduce((a,e)=>a+e.netHours,0).toFixed(1);

  return (
    <div className="fu">
      <div style={{marginBottom:18}}>
        <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>Hours This Week</div>
        <div style={{fontSize:12,color:T.sub,marginTop:3}}>All timesheet entries from this week, grouped by apprentice.</div>
      </div>

      {/* Global type summary bar */}
      {weekEntries.length>0 && (
        <Card style={{marginBottom:20,padding:"16px 20px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700}}>All Apprentices — Week Total</div>
            <div style={{fontFamily:"'Libre Baskerville'",fontSize:22,fontWeight:700,color:T.accent}}>{globalTotal}h</div>
          </div>
          {/* Type breakdown pills */}
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:12}}>
            {globalTypeHrs.map(({type,hrs})=>{
              const m = TYPE_META[type]||TYPE_META["Other"];
              return (
                <div key={type} style={{display:"flex",alignItems:"center",gap:6,
                  background:m.bg,border:`1px solid ${m.color}44`,
                  borderRadius:8,padding:"5px 10px"}}>
                  <span style={{fontSize:13}}>{m.sym}</span>
                  <span style={{fontSize:12,color:m.color,fontWeight:600}}>{type}</span>
                  <span style={{fontSize:13,fontWeight:700,color:m.color,fontFamily:"'Libre Baskerville'"}}>{hrs.toFixed(1)}h</span>
                </div>
              );
            })}
          </div>
          {/* Stacked bar */}
          <div style={{display:"flex",height:8,borderRadius:4,overflow:"hidden",gap:1}}>
            {globalTypeHrs.map(({type,hrs})=>{
              const m = TYPE_META[type]||TYPE_META["Other"];
              const pct = (hrs/parseFloat(globalTotal))*100;
              return <div key={type} style={{width:`${pct}%`,background:m.color,transition:"width .3s"}} title={`${type}: ${hrs.toFixed(1)}h`}/>;
            })}
          </div>
        </Card>
      )}

      {apprentices.length===0 && <Card><div style={{color:T.muted,textAlign:"center",padding:24}}>No apprentices found.</div></Card>}
      {apprentices.map(app=>{
        const appEntries = weekEntries.filter(e=>e.userId===app.id).sort((a,b)=>b.date.localeCompare(a.date));
        const totalHrs = appEntries.reduce((a,e)=>a+e.netHours,0);
        // Per-apprentice type breakdown
        const typeHrs = ENTRY_TYPES.map(t=>({
          type:t,
          hrs:appEntries.reduce((a,e)=>e.type===t?a+e.netHours:a,0)
        })).filter(x=>x.hrs>0);

        return (
          <Card key={app.id} style={{marginBottom:14}}>
            {/* Header row */}
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:appEntries.length>0?12:0}}>
              <Avatar name={app.name} role="Apprentice" size={36}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14}}>{app.name}</div>
                <div style={{fontSize:12,color:T.sub}}>{appEntries.length} entr{appEntries.length===1?"y":"ies"} this week</div>
              </div>
              <div style={{fontFamily:"'Libre Baskerville'",fontSize:22,fontWeight:700,color:T.accent}}>{totalHrs.toFixed(1)}h</div>
            </div>

            {appEntries.length===0 && <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>No entries this week.</div>}

            {appEntries.length>0 && (<>
              {/* Type breakdown pills for this apprentice */}
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
                {typeHrs.map(({type,hrs})=>{
                  const m = TYPE_META[type]||TYPE_META["Other"];
                  return (
                    <div key={type} style={{display:"flex",alignItems:"center",gap:5,
                      background:m.bg,border:`1px solid ${m.color}33`,
                      borderRadius:6,padding:"3px 8px"}}>
                      <span style={{fontSize:11}}>{m.sym}</span>
                      <span style={{fontSize:11,color:m.color,fontWeight:600}}>{type}</span>
                      <span style={{fontSize:12,fontWeight:700,color:m.color}}>{hrs.toFixed(1)}h</span>
                    </div>
                  );
                })}
              </div>
              {/* Mini stacked bar */}
              {totalHrs>0 && (
                <div style={{display:"flex",height:5,borderRadius:3,overflow:"hidden",gap:1,marginBottom:10}}>
                  {typeHrs.map(({type,hrs})=>{
                    const m = TYPE_META[type]||TYPE_META["Other"];
                    return <div key={type} style={{width:`${(hrs/totalHrs)*100}%`,background:m.color}} title={`${type}: ${hrs.toFixed(1)}h`}/>;
                  })}
                </div>
              )}
              {/* Entry rows */}
              <div style={{borderTop:`1px solid ${T.border}`,paddingTop:10}}>
                {appEntries.map((e,i)=>(
                  <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 120px 60px 90px",
                    gap:8,padding:"7px 4px",borderBottom:i<appEntries.length-1?`1px solid ${T.border}44`:"none",
                    alignItems:"center",fontSize:12}}>
                    <div style={{fontWeight:600}}>{fmtD(e.date)}</div>
                    <div style={{color:e.note?T.ink:T.muted,fontStyle:e.note?"normal":"italic",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note||"No note"}</div>
                    <TypePill type={e.type} size="sm"/>
                    <div style={{fontWeight:700,color:TYPE_META[e.type]?.color||T.accent,textAlign:"center"}}>{e.netHours}h</div>
                    <AppvPill status={e.approval}/>
                  </div>
                ))}
              </div>
            </>)}
          </Card>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING / APPROVED ENTRIES LIST  — grouped by apprentice A-Z
// ─────────────────────────────────────────────────────────────────────────────
function ApprovalList({allUsers, entries, status, onApprove, onDecline}) {
  const apprentices = [...allUsers.filter(u=>u.role==="Apprentice")].sort((a,b)=>a.name.localeCompare(b.name));
  const filtered = entries.filter(e=>e.approval===status);
  const isPending = status==="submitted";

  return (
    <div className="fu">
      <div style={{marginBottom:18}}>
        <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>
          {status==="submitted"?"Pending":status==="approved"?"Submitted — Approved":"Submitted — Not Approved"}
        </div>
        <div style={{fontSize:12,color:T.sub,marginTop:3}}>
          {filtered.length} entr{filtered.length===1?"y":"ies"} — grouped by apprentice A–Z.
        </div>
      </div>
      {filtered.length===0 && (
        <Card style={{textAlign:"center",padding:"48px 24px"}}>
          <div style={{fontSize:32,marginBottom:8}}>{isPending?"✓":"◈"}</div>
          <div style={{fontWeight:600,fontSize:15}}>{status==="submitted"?"All caught up!":status==="approved"?"No approved entries yet.":"No declined entries."}</div>
          <div style={{fontSize:12,color:T.sub,marginTop:6}}>{status==="submitted"?"No timesheets are waiting for approval.":""}</div>
        </Card>
      )}
      {apprentices.map(app=>{
        const appEntries = filtered.filter(e=>e.userId===app.id).sort((a,b)=>b.date.localeCompare(a.date));
        if(appEntries.length===0) return null;
        return (
          <Card key={app.id} style={{marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
              <Avatar name={app.name} role="Apprentice" size={36}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14}}>{app.name}</div>
                <div style={{fontSize:12,color:T.sub}}>{appEntries.length} {status} entr{appEntries.length===1?"y":"ies"}</div>
              </div>
            </div>
            <div style={{borderTop:`1px solid ${T.border}`,paddingTop:10}}>
              {appEntries.map((e,i)=>(
                <div key={e.id} style={{display:"grid",
                  gridTemplateColumns:isPending?"110px 1fr 120px 60px 80px":"110px 1fr 120px 60px",
                  gap:8,padding:"8px 4px",borderBottom:i<appEntries.length-1?`1px solid ${T.border}44`:"none",
                  alignItems:"center",fontSize:12}}>
                  <div style={{fontWeight:600}}>{fmtD(e.date)}</div>
                  <div style={{color:e.note?T.ink:T.muted,fontStyle:e.note?"normal":"italic",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note||"No note"}</div>
                  <TypePill type={e.type} size="sm"/>
                  <div style={{fontWeight:700,color:TYPE_META[e.type]?.color||T.accent,textAlign:"center"}}>{e.netHours}h</div>
                  {isPending && (
                    <div style={{display:"flex",gap:4}}>
                      <button onClick={()=>onApprove(e.id)} style={{width:28,height:28,borderRadius:6,fontSize:13,background:T.accentL,color:T.accent,border:`1px solid ${T.accent}44`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}} title="Approve">✓</button>
                      <button onClick={()=>onDecline(e.id)} style={{width:28,height:28,borderRadius:6,fontSize:13,background:T.redL,color:T.red,border:`1px solid ${T.red}44`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}} title="Decline">✕</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APPRENTICE LIST
// ─────────────────────────────────────────────────────────────────────────────
function ApprenticeList({allUsers, setUsers, onViewTimesheet}) {
  const apprentices = [...allUsers.filter(u => u.role === "Apprentice")].sort((a,b)=>a.name.localeCompare(b.name));
  const approvers   = allUsers.filter(u => u.role === "Approver" || u.role === "Admin");
  const viewers     = allUsers.filter(u => u.role === "Viewer"   || u.role === "Admin");
  const mentors     = allUsers.filter(u => u.role === "Mentor"   || u.role === "Admin");

  const blank = {firstName:"", lastName:"", email:"", phone:"", trade:"", licenceExpiry:"", hostBusiness:"", role:"Apprentice", allocatedTo:[], password:"", overtimeType:null, overtimeThreshold:"", overtimeRateId:""};
  const [form, setForm]         = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState(null);
  const [pwField, setPwField]   = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [expandId, setExpandId] = useState(null);
  const [formApproverId, setFormApproverId] = useState("");
  const [formViewerId,   setFormViewerId]   = useState("");
  const [formMentorId,   setFormMentorId]   = useState("");
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));

  const getAllocated = (role, appId) =>
    allUsers.filter(u => (u.role===role || u.role==="Admin") && (u.allocatedTo||[]).includes(appId));

  // Get approver/viewer/mentor using direct fields (source of truth) with allocatedTo fallback
  const getApprover = (apprentice) => {
    if(apprentice.approverUserId) return allUsers.find(u=>u.id===apprentice.approverUserId);
    return allUsers.find(u=>(u.role==="Approver"||u.role==="Admin")&&(u.allocatedTo||[]).includes(apprentice.id));
  };
  const getViewer = (apprentice) => {
    if(apprentice.viewerUserId) return allUsers.find(u=>u.id===apprentice.viewerUserId);
    return allUsers.find(u=>(u.role==="Viewer"||u.role==="Admin")&&(u.allocatedTo||[]).includes(apprentice.id));
  };
  const getMentor = (apprentice) => {
    if(apprentice.mentorUserId) return allUsers.find(u=>u.id===apprentice.mentorUserId);
    return null;
  };

  const toggleAlloc = (staffId, appId) => {
    setUsers(prev => prev.map(u => {
      if(u.id !== staffId) return u;
      const has = (u.allocatedTo||[]).includes(appId);
      return {...u, allocatedTo: has
        ? (u.allocatedTo||[]).filter(x=>x!==appId)
        : [...(u.allocatedTo||[]), appId]};
    }));
  };

  const submit = () => {
    const firstName = form.firstName.trim();
    const lastName  = form.lastName.trim();
    if(!firstName||!form.email.trim()) return;
    const fullName = `${firstName} ${lastName}`.trim();
    const finalForm = {...form, name: fullName, firstName, lastName,
      approverUserId: formApproverId||null,
      viewerUserId:   formViewerId||null,
      mentorUserId:   formMentorId||null,
    };
    if(pwField.trim()) finalForm.password = hashPw(pwField.trim());
    let appId = editId;
    if(editId) {
      setUsers(prev => prev.map(u => u.id===editId ? {...u,...finalForm} : u));
      setEditId(null);
    } else {
      appId = uid();
      setUsers(prev => [...prev, {id:appId, ...finalForm}]);
    }
    // Sync allocatedTo on approver/viewer/admin users
    setUsers(prev => prev.map(u => {
      if(!["Approver","Viewer","Admin"].includes(u.role)) return u;
      const isApprover = u.id === formApproverId;
      const isViewer   = u.id === formViewerId;
      const shouldHave = isApprover || isViewer;
      const has        = (u.allocatedTo||[]).includes(appId);
      if(shouldHave && !has) return {...u, allocatedTo:[...(u.allocatedTo||[]), appId]};
      if(!shouldHave && has) return {...u, allocatedTo:(u.allocatedTo||[]).filter(x=>x!==appId)};
      return u;
    }));
    setForm(blank); setPwField(""); setFormApproverId(""); setFormViewerId(""); setFormMentorId(""); setShowForm(false);
  };

  const startEdit = (u) => {
    const parts = u.name.split(" ");
    setForm({
      firstName: u.firstName || parts[0] || "",
      lastName:  u.lastName  || parts.slice(1).join(" ") || "",
      email: u.email||"", phone: u.phone||"",
      trade: u.trade||"", licenceExpiry: u.licenceExpiry||"", hostBusiness: u.hostBusiness||"",
      role:"Apprentice", allocatedTo:[], password:u.password,
      overtimeType: u.overtimeType||null, overtimeThreshold: u.overtimeThreshold||"", overtimeRateId: u.overtimeRateId||"",
    });
    // Pre-select from approverUserId/viewerUserId/mentorUserId (new) or fall back to allocatedTo (legacy)
    const curApprover = u.approverUserId || allUsers.find(x=>(x.role==="Approver"||x.role==="Admin")&&(x.allocatedTo||[]).includes(u.id))?.id || "";
    const curViewer   = u.viewerUserId   || allUsers.find(x=>(x.role==="Viewer"  ||x.role==="Admin")&&(x.allocatedTo||[]).includes(u.id)&&x.id!==curApprover)?.id || "";
    const curMentor   = u.mentorUserId   || "";
    setFormApproverId(curApprover);
    setFormViewerId(curViewer);
    setFormMentorId(curMentor);
    setPwField(""); setEditId(u.id); setShowForm(true);
    setExpandId(null);
  };

  const deleteUser = (id) => {
    if(window.confirm("Remove this apprentice?")) setUsers(prev => prev.filter(u => u.id !== id));
  };

  // licence expiry colour
  const licColour = (expiry) => {
    if(!expiry) return T.muted;
    const days = (new Date(expiry) - new Date()) / 86400000;
    if(days < 0)   return T.red;
    if(days < 60)  return T.warn;
    if(days < 180) return T.gold;
    return T.accent;
  };

  return (
    <div className="fu">
      {/* Header */}
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:18}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'", fontSize:18, fontWeight:700}}>Apprentices</div>
          <div style={{fontSize:12, color:T.sub, marginTop:3}}>{apprentices.length} apprentice{apprentices.length!==1?"s":""} — click a row to view their timesheet, or expand to manage allocations.</div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setPwField("");setExpandId(null);setFormApproverId("");setFormViewerId("");setShowForm(s=>!s);}}>
          {showForm ? "✕ Cancel" : "+ Add Apprentice"}
        </Btn>
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <Card style={{marginBottom:20, border:`1.5px solid ${T.blue}44`}}>
          <div style={{fontWeight:700, fontSize:14, marginBottom:16, color:T.blue}}>{editId?"✎ Edit Apprentice":"+ New Apprentice"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>First Name</FL><input placeholder="Jamie" value={form.firstName} onChange={e=>sf("firstName",e.target.value)}/></div>
            <div><FL req>Last Name</FL><input placeholder="Smith" value={form.lastName} onChange={e=>sf("lastName",e.target.value)}/></div>
            <div><FL req>Email</FL><input type="email" placeholder="jamie@work.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+61 4xx xxx xxx" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
            <div><FL>Trade</FL>
              <select value={form.trade} onChange={e=>sf("trade",e.target.value)}>
                <option value="">Select trade…</option>
                {TRADES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div><FL>Licence Expiry</FL><input type="date" value={form.licenceExpiry} onChange={e=>sf("licenceExpiry",e.target.value)}/></div>
            <div><FL>Host Business</FL><input placeholder="e.g. Sparks Electrical Ltd" value={form.hostBusiness||""} onChange={e=>sf("hostBusiness",e.target.value)}/></div>
            {/* ── Overtime Settings ── */}
            <div style={{gridColumn:"1/-1"}}>
              <div style={{fontWeight:700,fontSize:12,color:T.sub,textTransform:"uppercase",letterSpacing:".6px",marginBottom:8,marginTop:4,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
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
                    value={form.overtimeThreshold}
                    onChange={e=>sf("overtimeThreshold",parseFloat(e.target.value)||"")}/>
                  <div style={{fontSize:10,color:T.muted,marginTop:2}}>
                    {form.overtimeType==="daily"?"Hours per day before overtime":"Hours per week before overtime"}
                  </div>
                </div>}
                {form.overtimeType&&<div>
                  <FL>Xero Overtime Rate ID</FL>
                  <input placeholder="Xero earnings rate UUID"
                    value={form.overtimeRateId||""}
                    onChange={e=>sf("overtimeRateId",e.target.value)}/>
                  <div style={{fontSize:10,color:T.muted,marginTop:2}}>Find in Xero → Payroll → Pay Items</div>
                </div>}
              </div>
              {form.overtimeType&&(
                <div style={{marginTop:8,padding:"8px 12px",background:T.accentL,borderRadius:7,fontSize:12,color:T.accent}}>
                  {form.overtimeType==="daily"
                    ? `Any hours beyond ${form.overtimeThreshold||"?"}h in a single day will submit to Xero as overtime`
                    : `Any hours beyond ${form.overtimeThreshold||"?"}h in a week will submit to Xero as overtime`}
                </div>
              )}
            </div>
            <div>
              <FL>Approver <span style={{fontWeight:400,color:T.muted}}>(can approve timesheets)</span></FL>
              <select value={formApproverId} onChange={e=>setFormApproverId(e.target.value)}>
                <option value="">— None —</option>
                {approvers.map(a=><option key={a.id} value={a.id}>{a.name}{a.role==="Admin"?" (Admin)":""}</option>)}
              </select>
            </div>
            <div>
              <FL>Viewer <span style={{fontWeight:400,color:T.muted}}>(read-only access)</span></FL>
              <select value={formViewerId} onChange={e=>setFormViewerId(e.target.value)}>
                <option value="">— None —</option>
                {viewers.map(v=><option key={v.id} value={v.id}>{v.name}{v.role==="Admin"?" (Admin)":""}</option>)}
              </select>
            </div>
            <div>
              <FL>Mentor <span style={{fontWeight:400,color:T.muted}}>(assigned KTA mentor)</span></FL>
              <select value={formMentorId} onChange={e=>setFormMentorId(e.target.value)}>
                <option value="">— None —</option>
                {mentors.map(m=><option key={m.id} value={m.id}>{m.name}{m.role==="Admin"?" (Admin)":""}</option>)}
              </select>
            </div>
            <div>
              <FL>{editId?"New Password (blank = keep)":"Password"}</FL>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} placeholder={editId?"Leave blank to keep":"Set password"}
                  value={pwField} onChange={e=>setPwField(e.target.value)} style={{paddingRight:60}}/>
                <button onClick={()=>setShowPw(s=>!s)} type="button" style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:12,fontFamily:"DM Sans,sans-serif"}}>{showPw?"Hide":"Show"}</button>
              </div>
              {!editId && <div style={{fontSize:11,color:T.muted,marginTop:3}}>Required for new users</div>}
            </div>
          </div>
          <div style={{display:"flex", gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Add Apprentice"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);setFormApproverId("");setFormViewerId("");setFormMentorId("");}}>Cancel</Btn>
          </div>
        </Card>
      )}

      {/* Table header */}
      <Card style={{padding:0, overflow:"hidden"}}>
        <div style={{display:"grid",
          gridTemplateColumns:"36px 1fr 140px 130px 120px 110px 110px 72px",
          padding:"10px 16px", background:T.bg, borderBottom:`1.5px solid ${T.border}`,
          fontSize:11, fontWeight:600, color:T.muted, textTransform:"uppercase", letterSpacing:".6px", gap:8}}>
          <span/><span>Name</span><span>Email</span><span>Phone</span>
          <span>Trade</span><span>Licence Exp.</span><span>Allocations</span>
          <span style={{textAlign:"right"}}>Actions</span>
        </div>

        {apprentices.length === 0 && (
          <div style={{padding:"48px 24px", textAlign:"center", color:T.muted}}>
            <div style={{fontSize:32, marginBottom:8}}>◑</div>
            <div style={{fontWeight:600}}>No apprentices yet</div>
            <div style={{fontSize:12, marginTop:4}}>Add your first apprentice above.</div>
          </div>
        )}

        {apprentices.map((u,i) => {
          const approver   = getApprover(u);
          const viewer     = getViewer(u);
          const mentor     = getMentor(u);
          const isExpanded = expandId === u.id;
          const lc         = licColour(u.licenceExpiry);

          return (
            <div key={u.id}>
              {/* Main row */}
              <div className="ri" style={{
                display:"grid",
                gridTemplateColumns:"36px 1fr 140px 130px 120px 110px 110px 72px",
                padding:"12px 16px",
                borderBottom:(!isExpanded&&i<apprentices.length-1)?`1px solid ${T.border}44`:"none",
                background:isExpanded?T.blueL:i%2===0?T.surface:T.bg,
                alignItems:"center", gap:8, animationDelay:`${i*.03}s`}}>

                {/* Avatar — click → timesheet */}
                <div onClick={()=>onViewTimesheet(u.id)} style={{cursor:"pointer"}}>
                  <Avatar name={u.name} role="Apprentice"/>
                </div>

                {/* Name — click → timesheet */}
                <div onClick={()=>onViewTimesheet(u.id)} style={{cursor:"pointer"}}>
                  <div style={{fontWeight:700, fontSize:13, color:T.accent}}>{u.firstName||u.name.split(" ")[0]} <span style={{color:T.sub}}>{u.lastName||u.name.split(" ").slice(1).join(" ")}</span></div>
                </div>

                <div style={{fontSize:12, color:T.sub, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{u.email||"—"}</div>
                <div style={{fontSize:12, color:T.sub}}>{u.phone||"—"}</div>

                {/* Trade */}
                <div>{u.trade
                  ? <Pill label={u.trade} size="sm" color={T.teal} bg={T.tealL}/>
                  : <span style={{fontSize:12,color:T.muted}}>—</span>}
                </div>

                {/* Licence expiry */}
                <div>
                  {u.licenceExpiry
                    ? <div style={{fontSize:12,fontWeight:600,color:lc}}>
                        {new Date(u.licenceExpiry+"T00:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}
                        {licColour(u.licenceExpiry)===T.red&&<div style={{fontSize:10,color:T.red}}>EXPIRED</div>}
                        {licColour(u.licenceExpiry)===T.warn&&<div style={{fontSize:10,color:T.warn}}>Expiring soon</div>}
                      </div>
                    : <span style={{fontSize:12,color:T.muted}}>—</span>}
                </div>

                {/* Allocation summary — click to expand */}
                <button onClick={()=>setExpandId(isExpanded?null:u.id)} style={{
                  background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left"}}>
                  <div style={{fontSize:11}}>
                    <div style={{color:approver?T.warn:T.muted, fontWeight:approver?600:400}}>
                      ▲ {approver?approver.name.split(" ")[0]:"No approver"}
                    </div>
                    <div style={{color:viewer?T.teal:T.muted, fontWeight:viewer?600:400, marginTop:2}}>
                      ◆ {viewer?viewer.name.split(" ")[0]:"No viewer"}
                    </div>
                    {mentor&&<div style={{color:T.accent, fontWeight:600, marginTop:2}}>
                      ✦ {mentor.name.split(" ")[0]}
                    </div>}
                  </div>
                  <div style={{fontSize:10,color:T.blue,marginTop:3}}>{isExpanded?"▲ collapse":"✎ manage"}</div>
                </button>

                {/* Actions */}
                <div style={{display:"flex", gap:5, justifyContent:"flex-end"}}>
                  <button onClick={()=>startEdit(u)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                    onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
                  <button onClick={()=>deleteUser(u.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                    onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
                </div>
              </div>

              {/* Expanded allocation panel */}
              {isExpanded && (
                <div style={{padding:"16px 20px 20px 20px", background:T.blueL,
                  borderBottom:i<apprentices.length-1?`1px solid ${T.border}44`:"none"}}>
                  <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:20}}>

                    {/* Approvers column */}
                    <div>
                      <div style={{fontSize:12,fontWeight:700,color:T.warn,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                        <span>▲</span> Approvers
                        <span style={{fontSize:11,fontWeight:400,color:T.sub}}>— can approve / decline this apprentice's timesheets</span>
                      </div>
                      {approvers.length===0
                        ? <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>No Approver accounts exist yet.</div>
                        : approvers.map(ap=>{
                            const isAllocd = (ap.allocatedTo||[]).includes(u.id);
                            return (
                              <button key={ap.id} onClick={()=>toggleAlloc(ap.id, u.id)} style={{
                                display:"flex",alignItems:"center",gap:10,width:"100%",
                                padding:"9px 12px",marginBottom:6,borderRadius:8,textAlign:"left",
                                background:isAllocd?T.warnL:T.surface,
                                border:`1.5px solid ${isAllocd?T.warn:T.border}`,
                                cursor:"pointer",transition:"all .14s"}}>
                                <div style={{width:20,height:20,borderRadius:5,
                                  background:isAllocd?T.warn:"transparent",
                                  border:`2px solid ${isAllocd?T.warn:T.muted}`,
                                  display:"flex",alignItems:"center",justifyContent:"center",
                                  fontSize:11,color:"#fff",flexShrink:0}}>
                                  {isAllocd?"✓":""}
                                </div>
                                <div>
                                  <div style={{fontSize:13,fontWeight:600,color:T.ink}}>{ap.name}</div>
                                  <div style={{fontSize:11,color:T.sub}}>{ap.email}</div>
                                </div>
                              </button>
                            );
                          })
                      }
                    </div>

                    {/* Viewers column */}
                    <div>
                      <div style={{fontSize:12,fontWeight:700,color:T.teal,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                        <span>◆</span> Viewers
                        <span style={{fontSize:11,fontWeight:400,color:T.sub}}>— can view all timesheet stages, read only</span>
                      </div>
                      {viewers.length===0
                        ? <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>No Viewer accounts exist yet.</div>
                        : viewers.map(vw=>{
                            const isAllocd = (vw.allocatedTo||[]).includes(u.id);
                            return (
                              <button key={vw.id} onClick={()=>toggleAlloc(vw.id, u.id)} style={{
                                display:"flex",alignItems:"center",gap:10,width:"100%",
                                padding:"9px 12px",marginBottom:6,borderRadius:8,textAlign:"left",
                                background:isAllocd?T.tealL:T.surface,
                                border:`1.5px solid ${isAllocd?T.teal:T.border}`,
                                cursor:"pointer",transition:"all .14s"}}>
                                <div style={{width:20,height:20,borderRadius:5,
                                  background:isAllocd?T.teal:"transparent",
                                  border:`2px solid ${isAllocd?T.teal:T.muted}`,
                                  display:"flex",alignItems:"center",justifyContent:"center",
                                  fontSize:11,color:"#fff",flexShrink:0}}>
                                  {isAllocd?"✓":""}
                                </div>
                                <div>
                                  <div style={{fontSize:13,fontWeight:600,color:T.ink}}>{vw.name}</div>
                                  <div style={{fontSize:11,color:T.sub}}>{vw.email}</div>
                                </div>
                              </button>
                            );
                          })
                      }
                    </div>

                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS LIST  (business/other contacts, not system users)
// ─────────────────────────────────────────────────────────────────────────────
function ContactsList() {
  const [items, setItems] = useState([]);
  const [dashLoading_dash_contacts, setDashLoading_dash_contacts] = useState(true);
  useEffect(()=>{
    loadTable('dash_contacts').then(rows=>{
      setItems(rows);
      setDashLoading_dash_contacts(false);
    }).catch(e=>{console.error('dash_contacts load',e);setDashLoading_dash_contacts(false);});
  },[]);
  const blank = {name:"",company:"",email:"",phone:"",type:"General",notes:""};
  const CTYPES = ["General","Government","Industry","Training","Other"];
  const CTYPE_C = {General:T.slate,Government:T.blue,Industry:T.teal,Training:T.hol,Other:T.muted};
  const [form, setForm] = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const sf = (k,v)=>setForm(f=>({...f,[k]:v}));

  const submit = () => {
    if(!form.name.trim()) return;
    const row = editId ? {id:editId,...form} : {id:uid(),...form};
    if(editId){ setItems(prev=>prev.map(x=>x.id===editId?row:x)); setEditId(null); }
    else setItems(prev=>[row,...prev]);
    upsertRow('dash_contacts',row).catch(console.error);
    setForm(blank); setShowForm(false);
  };
  const startEdit = (x)=>{setForm({name:x.name,company:x.company||"",email:x.email||"",phone:x.phone||"",type:x.type||"General",notes:x.notes||""});setEditId(x.id);setShowForm(true);};
  const del = (id)=>{ if(window.confirm("Remove this contact?")){ setItems(prev=>prev.filter(x=>x.id!==id)); deleteRow('dash_contacts',id).catch(console.error); } };

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>Contacts</div>
          <div style={{fontSize:12,color:T.sub,marginTop:3}}>Business and other contacts — not system users.</div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setShowForm(s=>!s);}}>
          {showForm?"✕ Cancel":"+ Add Contact"}
        </Btn>
      </div>
      {showForm&&(
        <Card style={{marginBottom:20,border:`1.5px solid ${T.slate}44`}}>
          <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:T.slate}}>{editId?"✎ Edit Contact":"+ New Contact"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Name</FL><input placeholder="Jane Smith" value={form.name} onChange={e=>sf("name",e.target.value)}/></div>
            <div><FL>Organisation</FL><input placeholder="Company / Agency" value={form.company} onChange={e=>sf("company",e.target.value)}/></div>
            <div><FL>Type</FL>
              <select value={form.type} onChange={e=>sf("type",e.target.value)}>
                {CTYPES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div><FL>Email</FL><input type="email" placeholder="jane@org.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+61…" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Save Contact"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancel</Btn>
          </div>
        </Card>
      )}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 160px 100px 160px 160px 68px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <span>Name</span><span>Organisation</span><span>Type</span><span>Email</span><span>Phone</span><span/>
        </div>
        {items.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No contacts yet.</div>}
        {[...items].sort((a,b)=>a.name.localeCompare(b.name)).map((x,i)=>(
          <div key={x.id} className="ri" style={{display:"grid",gridTemplateColumns:"1fr 160px 100px 160px 160px 68px",
            padding:"12px 16px",borderBottom:i<items.length-1?`1px solid ${T.border}44`:"none",
            background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
            <div>
              <div style={{fontWeight:700,fontSize:13}}>{x.name}</div>
              {x.notes&&<div style={{fontSize:11,color:T.muted,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.notes}</div>}
            </div>
            <div style={{fontSize:12,color:T.sub}}>{x.company||"—"}</div>
            <Pill label={x.type||"General"} size="sm" color={CTYPE_C[x.type]||T.slate} bg={(CTYPE_C[x.type]||T.slate)+"1a"}/>
            <div style={{fontSize:12,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.email||"—"}</div>
            <div style={{fontSize:12,color:T.sub}}>{x.phone||"—"}</div>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
              <button onClick={()=>startEdit(x)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
              <button onClick={()=>del(x.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HOST BUSINESS LIST  (companies that host apprentices)
// ─────────────────────────────────────────────────────────────────────────────
function HostBusinessList() {
  const [items, setItems] = useState([]);
  const [dashLoading_dash_hosts, setDashLoading_dash_hosts] = useState(true);
  useEffect(()=>{
    loadTable('dash_hosts').then(rows=>{
      setItems(rows);
      setDashLoading_dash_hosts(false);
    }).catch(e=>{console.error('dash_hosts load',e);setDashLoading_dash_hosts(false);});
  },[]);
  const blank = {name:"",industry:"",contact:"",phone:"",email:"",capacity:"",status:"Active",notes:""};
  const INDUSTRIES = ["Construction","Electrical","Plumbing","Carpentry","HVAC","Civil","Other"];
  const [form, setForm] = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const sf = (k,v)=>setForm(f=>({...f,[k]:v}));

  const submit = () => {
    if(!form.name.trim()) return;
    const row = editId ? {id:editId,...form} : {id:uid(),...form};
    if(editId){ setItems(prev=>prev.map(x=>x.id===editId?row:x)); setEditId(null); }
    else setItems(prev=>[row,...prev]);
    upsertRow('dash_hosts',{...row,capacity:parseInt(row.capacity)||0}).catch(console.error);
    setForm(blank); setShowForm(false);
  };
  const startEdit = (x)=>{setForm({name:x.name,industry:x.industry||"",contact:x.contact||"",phone:x.phone||"",email:x.email||"",capacity:x.capacity||"",status:x.status||"Active",notes:x.notes||""});setEditId(x.id);setShowForm(true);};
  const del = (id)=>{ if(window.confirm("Remove this host business?")){ setItems(prev=>prev.filter(x=>x.id!==id)); deleteRow('dash_hosts',id).catch(console.error); } };

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>Host Businesses</div>
          <div style={{fontSize:12,color:T.sub,marginTop:3}}>Companies that host apprentices for on-the-job training.</div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setShowForm(s=>!s);}}>
          {showForm?"✕ Cancel":"+ Add Host Business"}
        </Btn>
      </div>
      {showForm&&(
        <Card style={{marginBottom:20,border:`1.5px solid ${T.teal}44`}}>
          <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:T.teal}}>{editId?"✎ Edit Host Business":"+ New Host Business"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Business Name</FL><input placeholder="Acme Constructions" value={form.name} onChange={e=>sf("name",e.target.value)}/></div>
            <div><FL>Industry</FL>
              <select value={form.industry} onChange={e=>sf("industry",e.target.value)}>
                <option value="">Select…</option>
                {INDUSTRIES.map(i=><option key={i}>{i}</option>)}
              </select>
            </div>
            <div><FL>Status</FL>
              <select value={form.status} onChange={e=>sf("status",e.target.value)}>
                {["Active","Inactive","Pending"].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div><FL>Primary Contact</FL><input placeholder="Name" value={form.contact} onChange={e=>sf("contact",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+61…" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
            <div><FL>Email</FL><input type="email" placeholder="contact@biz.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Apprentice Capacity</FL><input type="number" min="0" placeholder="0" value={form.capacity} onChange={e=>sf("capacity",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Save Host Business"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancel</Btn>
          </div>
        </Card>
      )}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 120px 140px 140px 60px 80px 68px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <span>Business</span><span>Industry</span><span>Contact</span><span>Email</span><span style={{textAlign:"center"}}>Cap.</span><span>Status</span><span/>
        </div>
        {items.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No host businesses yet.</div>}
        {[...items].sort((a,b)=>a.name.localeCompare(b.name)).map((x,i)=>(
          <div key={x.id} className="ri" style={{display:"grid",gridTemplateColumns:"1fr 120px 140px 140px 60px 80px 68px",
            padding:"12px 16px",borderBottom:i<items.length-1?`1px solid ${T.border}44`:"none",
            background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
            <div>
              <div style={{fontWeight:700,fontSize:13}}>{x.name}</div>
              {x.notes&&<div style={{fontSize:11,color:T.muted,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.notes}</div>}
            </div>
            <div style={{fontSize:12,color:T.sub}}>{x.industry||"—"}</div>
            <div style={{fontSize:12,color:T.sub}}>{x.contact||"—"}</div>
            <div style={{fontSize:12,color:T.sub,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.email||"—"}</div>
            <div style={{textAlign:"center",fontSize:13,fontWeight:700,color:T.teal}}>{x.capacity||"—"}</div>
            <Pill label={x.status||"Active"} size="sm"
              color={x.status==="Active"?T.accent:x.status==="Pending"?T.warn:T.muted}
              bg={x.status==="Active"?T.accentL:x.status==="Pending"?T.warnL:T.slateL}/>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
              <button onClick={()=>startEdit(x)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
              <button onClick={()=>del(x.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TARGET DEALS LIST  (deals / opportunities being pursued)
// ─────────────────────────────────────────────────────────────────────────────
function TargetDealsList() {
  const DEAL_STAGES = ["Prospecting","Outreach","Meeting","Proposal","Negotiation","Won","Lost"];
  const DEAL_C = {Prospecting:T.muted,Outreach:T.blue,Meeting:T.hol,Proposal:T.warn,Negotiation:T.gold,Won:T.accent,Lost:T.red};
  const [items, setItems] = useState([]);
  const [dashLoading_dash_deals, setDashLoading_dash_deals] = useState(true);
  useEffect(()=>{
    loadTable('dash_deals').then(rows=>{
      setItems(rows);
      setDashLoading_dash_deals(false);
    }).catch(e=>{console.error('dash_deals load',e);setDashLoading_dash_deals(false);});
  },[]);
  const blank = {title:"",contact:"",org:"",value:"",stage:"Prospecting",dueDate:"",priority:"Medium",notes:""};
  const [form, setForm] = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const sf = (k,v)=>setForm(f=>({...f,[k]:v}));

  const submit = () => {
    if(!form.title.trim()) return;
    const row = editId ? {id:editId,...form} : {id:uid(),...form};
    if(editId){ setItems(prev=>prev.map(x=>x.id===editId?row:x)); setEditId(null); }
    else setItems(prev=>[row,...prev]);
    upsertRow('dash_deals',{id:row.id,title:row.title,contact:row.contact||"",org:row.org||"",value:row.value||"",stage:row.stage||"Prospecting",due_date:row.dueDate||null,priority:row.priority||"Medium",notes:row.notes||""}).catch(console.error);
    setForm(blank); setShowForm(false);
  };
  const startEdit = (x)=>{setForm({title:x.title,contact:x.contact||"",org:x.org||"",value:x.value||"",stage:x.stage||"Prospecting",dueDate:x.due_date||x.dueDate||"",priority:x.priority||"Medium",notes:x.notes||""});setEditId(x.id);setShowForm(true);};
  const del = (id)=>{ if(window.confirm("Remove this deal?")){ setItems(prev=>prev.filter(x=>x.id!==id)); deleteRow('dash_deals',id).catch(console.error); } };
  const move = (id,stage)=>{ setItems(prev=>prev.map(x=>x.id===id?{...x,stage}:x)); upsertRow('dash_deals',{id,stage}).catch(console.error); };

  const totalValue = items.filter(x=>!["Won","Lost"].includes(x.stage)).reduce((a,x)=>a+(parseFloat(x.value)||0),0);
  const PRIORITY_C = {High:T.red,Medium:T.warn,Low:T.muted};

  return (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>Target Deals</div>
          <div style={{fontSize:12,color:T.sub,marginTop:3}}>{items.filter(x=>!["Won","Lost"].includes(x.stage)).length} active deals · pipeline value <strong style={{color:T.accent}}>${totalValue.toLocaleString()}</strong></div>
        </div>
        <Btn onClick={()=>{setForm(blank);setEditId(null);setShowForm(s=>!s);}}>
          {showForm?"✕ Cancel":"+ Add Deal"}
        </Btn>
      </div>
      {showForm&&(
        <Card style={{marginBottom:20,border:`1.5px solid ${T.gold}44`}}>
          <div style={{fontWeight:700,fontSize:14,marginBottom:16,color:T.gold}}>{editId?"✎ Edit Deal":"+ New Deal"}</div>
          <div className="fg3" style={{display:"grid",gap:12,marginBottom:12}}>
            <div><FL req>Deal Title</FL><input placeholder="e.g. Funding Round 2025" value={form.title} onChange={e=>sf("title",e.target.value)}/></div>
            <div><FL>Contact Person</FL><input placeholder="Name" value={form.contact} onChange={e=>sf("contact",e.target.value)}/></div>
            <div><FL>Organisation</FL><input placeholder="Company / Agency" value={form.org} onChange={e=>sf("org",e.target.value)}/></div>
            <div><FL>Value ($)</FL><input type="number" placeholder="0" value={form.value} onChange={e=>sf("value",e.target.value)}/></div>
            <div><FL>Stage</FL>
              <select value={form.stage} onChange={e=>sf("stage",e.target.value)}>
                {DEAL_STAGES.map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div><FL>Priority</FL>
              <select value={form.priority} onChange={e=>sf("priority",e.target.value)}>
                {["High","Medium","Low"].map(p=><option key={p}>{p}</option>)}
              </select>
            </div>
            <div><FL>Due Date</FL><input type="date" value={form.dueDate} onChange={e=>sf("dueDate",e.target.value)}/></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={form.notes} onChange={e=>sf("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Save Deal"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancel</Btn>
          </div>
        </Card>
      )}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"8px 1fr 130px 130px 90px 80px 80px 68px",
          padding:"10px 16px",background:T.bg,borderBottom:`1.5px solid ${T.border}`,
          fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
          <span/><span>Deal</span><span>Organisation</span><span>Contact</span><span style={{textAlign:"right"}}>Value</span><span>Stage</span><span>Priority</span><span/>
        </div>
        {items.length===0&&<div style={{padding:"40px",textAlign:"center",color:T.muted}}>No deals yet.</div>}
        {[...items].sort((a,b)=>{
          const order=["Proposal","Negotiation","Meeting","Outreach","Prospecting","Won","Lost"];
          return (order.indexOf(a.stage)||99)-(order.indexOf(b.stage)||99);
        }).map((x,i,arr)=>(
          <div key={x.id} className="ri" style={{display:"grid",gridTemplateColumns:"8px 1fr 130px 130px 90px 80px 80px 68px",
            padding:"12px 16px",borderBottom:i<arr.length-1?`1px solid ${T.border}44`:"none",
            background:i%2===0?T.surface:T.bg,alignItems:"center",gap:8,animationDelay:`${i*.03}s`}}>
            <div style={{width:8,height:36,borderRadius:3,background:DEAL_C[x.stage]||T.muted}}/>
            <div>
              <div style={{fontWeight:700,fontSize:13}}>{x.title}</div>
              {x.notes&&<div style={{fontSize:11,color:T.muted,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.notes}</div>}
            </div>
            <div style={{fontSize:12,color:T.sub}}>{x.org||"—"}</div>
            <div style={{fontSize:12,color:T.sub}}>{x.contact||"—"}</div>
            <div style={{textAlign:"right",fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:14,color:DEAL_C[x.stage]||T.muted}}>
              {x.value?`$${parseFloat(x.value).toLocaleString()}`:"—"}
            </div>
            <Pill label={x.stage} size="sm" color={DEAL_C[x.stage]||T.muted} bg={(DEAL_C[x.stage]||T.muted)+"1a"}/>
            <Pill label={x.priority||"Medium"} size="sm" color={PRIORITY_C[x.priority||"Medium"]} bg={PRIORITY_C[x.priority||"Medium"]+"1a"}/>
            <div style={{display:"flex",gap:5,justifyContent:"flex-end"}}>
              <button onClick={()=>startEdit(x)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
              <button onClick={()=>del(x.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function AdminDashboard({allUsers, entries, onViewApprentice, onViewApprenticeList, onViewList}) {
  const apprentices = allUsers.filter(u=>u.role==="Apprentice");
  const wsStart = ()=>{ const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };
  const ws = wsStart();

  // Global stats
  const totalSubmitted    = entries.filter(e=>e.approval==="submitted").length;
  const totalApproved     = entries.filter(e=>e.approval==="approved").length;
  const totalNotApproved  = entries.filter(e=>e.approval==="declined").length;
  const totalHrsWeek      = entries.filter(e=>e.date>=ws).reduce((a,e)=>a+e.netHours,0).toFixed(1);

  return (
    <div className="fu">
      {/* Top summary strip */}
      <div className="stat-grid-4">
        <button onClick={onViewApprenticeList} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
          onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
          onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
          <Card style={{paddingBlock:18,border:`1.5px solid ${T.blue}44`}}>
            <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Apprentices</div>
            <div style={{fontSize:24,fontWeight:700,color:T.blue,fontFamily:"'Libre Baskerville'"}}>{apprentices.length}</div>
            <div style={{fontSize:11,color:T.sub,marginTop:2}}>active workforce</div>
            <div style={{fontSize:11,color:T.blue,marginTop:6,fontWeight:600}}>View & manage →</div>
          </Card>
        </button>
        {[
          {label:"Hours This Week",        value:`${totalHrsWeek}h`,  sub:"all apprentices",       color:T.accent, key:"hours"},
          {label:"Pending",                  value:totalSubmitted,      sub:"submitted, awaiting review", color:totalSubmitted>0?T.warn:T.muted, key:"submitted"},
          {label:"Submitted — Approved",     value:totalApproved,       sub:"approved by approver",   color:T.teal,   key:"approved"},
          {label:"Submitted — Not Approved", value:totalNotApproved,    sub:"declined by approver",   color:totalNotApproved>0?T.red:T.muted, key:"declined"},
        ].map(({label,value,sub,color,key})=>(
          <button key={key} onClick={()=>onViewList(key)} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
            onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            <Card style={{paddingBlock:18,border:`1.5px solid ${color}44`,height:"100%"}}>
              <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>{label}</div>
              <div style={{fontSize:24,fontWeight:700,color,fontFamily:"'Libre Baskerville'"}}>{value}</div>
              <div style={{fontSize:11,color:T.sub,marginTop:2}}>{sub}</div>
              <div style={{fontSize:11,color,marginTop:6,fontWeight:600}}>View list →</div>
            </Card>
          </button>
        ))}
      </div>

      {/* Second row — CRM-style quick access */}
      <div className="stat-grid-3">
        {[
          {label:"Contacts",       sub:"business & other contacts", color:T.slate, key:"contacts",  icon:"◉"},
          {label:"Host Businesses",sub:"companies hosting apprentices",color:T.teal, key:"hosts",    icon:"◆"},
          {label:"Target Deals",   sub:"opportunities & pipeline",   color:T.gold, key:"deals",     icon:"◈"},
        ].map(({label,sub,color,key,icon})=>(
          <button key={key} onClick={()=>onViewList(key)} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
            onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            <Card style={{paddingBlock:18,border:`1.5px solid ${color}44`}}>
              <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>{label}</div>
              <div style={{fontSize:28,marginBottom:4,color}}>{icon}</div>
              <div style={{fontSize:11,color:T.sub}}>{sub}</div>
              <div style={{fontSize:11,color,marginTop:6,fontWeight:600}}>View & manage →</div>
            </Card>
          </button>
        ))}
      </div>

      {/* Section heading */}
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'", fontSize:18, fontWeight:700}}>Apprentice Timesheets</div>
          <div style={{fontSize:12, color:T.sub, marginTop:3}}>Click any card to view and manage that apprentice's timesheet entries.</div>
        </div>
      </div>

      {apprentices.length===0 && (
        <Card style={{textAlign:"center", padding:"52px 24px"}}>
          <div style={{fontSize:36, marginBottom:10}}>◑</div>
          <div style={{fontWeight:600, fontSize:15}}>No apprentices yet</div>
          <div style={{fontSize:13, color:T.sub, marginTop:6}}>Add apprentices in User Management to see their timesheets here.</div>
        </Card>
      )}

      <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(300px,1fr))", gap:16}}>
        {apprentices.map(app=>{
          const appEntries    = entries.filter(e=>e.userId===app.id);
          const weekEntries   = appEntries.filter(e=>e.date>=ws);
          const weekHrs       = weekEntries.reduce((a,e)=>a+e.netHours,0).toFixed(1);
          const pendingCount  = appEntries.filter(e=>e.approval==="submitted").length;
          const lastEntry     = [...appEntries].sort((a,b)=>b.date.localeCompare(a.date))[0];
          const totalEntries  = appEntries.length;

          // Entry type breakdown for mini bar
          const typeHrs = ENTRY_TYPES.map(t=>({
            type:t,
            hrs:appEntries.reduce((a,e)=>e.type===t?a+e.netHours:a,0)
          })).filter(x=>x.hrs>0);
          const totalTypeHrs = typeHrs.reduce((a,x)=>a+x.hrs,0)||1;

          return (
            <button key={app.id} onClick={()=>onViewApprentice(app.id)}
              style={{
                background:T.surface, border:`1.5px solid ${T.border}`,
                borderRadius:16, padding:0, textAlign:"left", cursor:"pointer",
                fontFamily:"DM Sans,sans-serif", transition:"all .18s",
                overflow:"hidden", display:"flex", flexDirection:"column"
              }}
              onMouseEnter={e=>{
                e.currentTarget.style.borderColor=T.blue+"88";
                e.currentTarget.style.boxShadow=`0 6px 24px ${T.blue}18`;
                e.currentTarget.style.transform="translateY(-2px)";
              }}
              onMouseLeave={e=>{
                e.currentTarget.style.borderColor=T.border;
                e.currentTarget.style.boxShadow="none";
                e.currentTarget.style.transform="translateY(0)";
              }}>

              {/* Card header */}
              <div style={{padding:"18px 20px 14px", borderBottom:`1px solid ${T.border}55`}}>
                <div style={{display:"flex", alignItems:"center", gap:12, marginBottom:12}}>
                  <Avatar name={app.name} role="Apprentice" size={44}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700, fontSize:15, color:T.ink}}>{app.name}</div>
                    <div style={{fontSize:12, color:T.muted, marginTop:1}}>{app.email}</div>
                  </div>
                  {pendingCount>0 && (
                    <div style={{
                      background:T.warnL, color:T.warn, border:`1px solid ${T.warn}44`,
                      borderRadius:99, padding:"3px 10px", fontSize:11, fontWeight:700,
                      whiteSpace:"nowrap"
                    }}>
                      {pendingCount} pending
                    </div>
                  )}
                </div>

                {/* Stats row */}
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8}}>
                  {[
                    {label:"This Week", value:`${weekHrs}h`, color:T.accent},
                    {label:"Total Entries", value:totalEntries, color:T.blue},
                    {label:"Last Entry", value:lastEntry?fmtD(lastEntry.date):"—", color:T.sub},
                  ].map(s=>(
                    <div key={s.label} style={{background:T.bg, borderRadius:8, padding:"8px 10px"}}>
                      <div style={{fontSize:10, color:T.muted, textTransform:"uppercase", letterSpacing:".6px", marginBottom:2}}>{s.label}</div>
                      <div style={{fontSize:13, fontWeight:700, color:s.color, fontFamily:"'Libre Baskerville'"}}>{s.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Entry type mini-bar */}
              {typeHrs.length>0 && (
                <div style={{padding:"12px 20px 14px"}}>
                  <div style={{fontSize:10, color:T.muted, textTransform:"uppercase", letterSpacing:".6px", marginBottom:7}}>Hours by type</div>
                  <div style={{display:"flex", height:7, borderRadius:99, overflow:"hidden", gap:1, marginBottom:8}}>
                    {typeHrs.map(x=>(
                      <div key={x.type} style={{
                        flex:x.hrs/totalTypeHrs,
                        background:TYPE_META[x.type]?.color||T.muted,
                        minWidth:4
                      }}/>
                    ))}
                  </div>
                  <div style={{display:"flex", flexWrap:"wrap", gap:6}}>
                    {typeHrs.map(x=>(
                      <span key={x.type} style={{display:"inline-flex", alignItems:"center", gap:4,
                        fontSize:10, color:TYPE_META[x.type]?.color||T.muted, fontWeight:600}}>
                        <span style={{width:7,height:7,borderRadius:"50%",background:TYPE_META[x.type]?.color||T.muted,display:"inline-block"}}/>
                        {x.type} {x.hrs}h
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {typeHrs.length===0 && (
                <div style={{padding:"14px 20px", color:T.muted, fontSize:12, fontStyle:"italic"}}>
                  No timesheet entries yet
                </div>
              )}

              {/* CTA footer */}
              <div style={{marginTop:"auto", padding:"11px 20px", background:T.bg,
                borderTop:`1px solid ${T.border}55`,
                display:"flex", alignItems:"center", justifyContent:"space-between"}}>
                <span style={{fontSize:12, color:T.blue, fontWeight:600}}>View Timesheet →</span>
                {pendingCount>0
                  ? <span style={{fontSize:11, color:T.warn}}>⚠ Needs attention</span>
                  : <span style={{fontSize:11, color:T.muted}}>All up to date</span>
                }
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION BELL
// ─────────────────────────────────────────────────────────────────────────────
function NotificationBell({notifs, onRead, onReadAll, onDelete, canDelete=true, show, setShow, onReply}) {
  const unread = notifs.filter(n=>!n.read).length;
  const typeIcon = t => t==="licence_expiry"?"⚠":t==="approval"?"✓":t==="decline"?"✕":t==="broadcast"?"📢":t==="reply"?"↩":"◈";
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
        color:"#ffffff99",fontSize:20,padding:"4px 8px",borderRadius:8,
        transition:"color .15s"}}
        onMouseEnter={e=>e.currentTarget.style.color="#fff"}
        onMouseLeave={e=>e.currentTarget.style.color="#ffffff99"}>
        🔔
        {unread>0&&(
          <span style={{position:"absolute",top:0,right:2,background:T.red,color:"#fff",
            borderRadius:99,fontSize:10,fontWeight:700,padding:"1px 5px",lineHeight:"14px",
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
            <div style={{fontWeight:700,fontSize:13}}>Notifications {unread>0&&<span style={{color:T.red}}>({unread})</span>}</div>
            {unread>0&&(
              <button onClick={onReadAll} style={{fontSize:11,color:T.blue,background:"none",
                border:"none",cursor:"pointer",fontFamily:"DM Sans,sans-serif",fontWeight:600}}>
                Mark all read
              </button>
            )}
          </div>
          {/* List */}
          <div style={{maxHeight:"min(460px, 70vh)",overflowY:"auto"}}>
            {notifs.length===0&&(
              <div style={{padding:24,textAlign:"center",color:T.muted,fontSize:13}}>No notifications</div>
            )}
            {notifs.map(n=>(
              <div key={n.id} style={{borderBottom:`1px solid ${T.border}44`,
                background:n.read?T.surface:T.blueL+"55"}}>
                <div style={{padding:"12px 16px",display:"flex",gap:10,alignItems:"flex-start",cursor:"pointer"}}
                  onClick={()=>{ if(!n.read) onRead(n.id); }}>
                  <span style={{fontSize:16,marginTop:2,color:typeColor(n.type),flexShrink:0}}>{typeIcon(n.type)}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div className="notif-title" style={{fontWeight:n.read?500:700,fontSize:13,color:typeColor(n.type),
                      wordBreak:"break-word",lineHeight:1.35}}>{n.title}</div>
                    <div className="notif-msg" style={{fontSize:12,color:T.sub,marginTop:3,lineHeight:1.5,
                      wordBreak:"break-word",whiteSpace:"pre-wrap"}}>{n.message}</div>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:6,flexWrap:"wrap",gap:4}}>
                      <div style={{fontSize:10,color:T.muted}}>
                        {n.created_at ? new Date(n.created_at).toLocaleString("en-AU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "Just now"}
                      </div>
                      {n.created_by&&n.type!=="reply"&&(
                        <button onClick={e=>{e.stopPropagation();setReplyId(replyId===n.id?null:n.id);setReplyText("");}}
                          style={{fontSize:11,color:T.teal,background:replyId===n.id?T.tealL:"none",border:"none",cursor:"pointer",
                            fontFamily:"DM Sans,sans-serif",fontWeight:600,padding:"2px 6px",borderRadius:4}}>
                          ↩ Reply
                        </button>
                      )}
                    </div>
                  </div>
                  {canDelete&&(
                    <button onClick={e=>{e.stopPropagation();onDelete(n.id);setReplyId(null);}} style={{
                      background:"none",border:"none",color:T.muted,cursor:"pointer",
                      fontSize:14,padding:"0 2px",flexShrink:0,marginLeft:2}}
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
                      style={{width:"100%",fontSize:13,padding:"8px 10px",borderRadius:7,
                        border:`1.5px solid ${T.teal}66`,fontFamily:"DM Sans,sans-serif",
                        background:T.bg,resize:"none",outline:"none",color:T.ink,boxSizing:"border-box"}}
                      onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleReply(n);}}}
                      autoFocus
                    />
                    <div style={{display:"flex",gap:6,marginTop:6}}>
                      <button onClick={()=>handleReply(n)} disabled={!replyText.trim()} style={{
                        fontSize:12,fontWeight:600,padding:"6px 14px",borderRadius:6,
                        background:replyText.trim()?T.teal:"#ccc",color:"#fff",border:"none",
                        cursor:replyText.trim()?"pointer":"default",fontFamily:"DM Sans,sans-serif"}}>
                        Send Reply
                      </button>
                      <button onClick={()=>setReplyId(null)} style={{
                        fontSize:12,padding:"6px 10px",borderRadius:6,background:"none",
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
// CONTACT US — Apprentice view
// ─────────────────────────────────────────────────────────────────────────────
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
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📞</div>
        <div>
          <div style={{fontWeight:700,fontSize:15}}>Contact Us</div>
          <div style={{fontSize:12,color:T.sub}}>Get in touch with your KTA team</div>
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
              color:"#fff",fontWeight:700,fontSize:14,flexShrink:0}}>
              {person.avatar}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:14,color:T.ink}}>{person.name}</div>
              <div style={{marginTop:3}}><RolePill role={person.role} size="sm"/></div>
            </div>
            {selectedId===person.id
              ? <span style={{fontSize:16,color:person.color,flexShrink:0}}>✓</span>
              : <span style={{fontSize:14,color:T.muted,flexShrink:0}}>›</span>
            }
          </button>
        ))}
      </div>

      {/* Contact options */}
      {selected&&!msgMode&&!sent&&(
        <div className="fu" style={{background:T.bg,borderRadius:10,padding:14}}>
          <div style={{fontSize:12,fontWeight:600,color:T.sub,marginBottom:10,textTransform:"uppercase",letterSpacing:".5px"}}>
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
                <span style={{fontSize:20}}>📱</span>
                <div>
                  <div style={{fontSize:13,fontWeight:600}}>Call</div>
                  <div style={{fontSize:12,color:T.sub}}>{selected.phone}</div>
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
                <span style={{fontSize:20}}>✉️</span>
                <div>
                  <div style={{fontSize:13,fontWeight:600}}>Email</div>
                  <div style={{fontSize:12,color:T.sub}}>{selected.email}</div>
                </div>
              </a>
            )}
            {!selected.phone&&!selected.email&&(
              <div style={{fontSize:12,color:T.muted,fontStyle:"italic",padding:"8px 0"}}>
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
              <span style={{fontSize:20}}>💬</span>
              <div>
                <div style={{fontSize:13,fontWeight:600}}>Message in App</div>
                <div style={{fontSize:12,color:T.sub}}>Send a message via the KTA app</div>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* In-app message composer */}
      {selected&&msgMode&&!sent&&(
        <div className="fu" style={{background:T.bg,borderRadius:10,padding:14}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:8}}>
            Message to {selected.name}
          </div>
          <textarea
            placeholder={`Hi ${selected.name.split(" ")[0]}, I wanted to reach out about…`}
            value={msgText}
            onChange={e=>setMsgText(e.target.value)}
            rows={4}
            style={{width:"100%",fontSize:13,padding:"10px 12px",borderRadius:8,
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
          <div style={{fontSize:20,marginBottom:4}}>✓</div>
          <div style={{fontWeight:700,color:T.accent,fontSize:14}}>Message sent!</div>
          <div style={{fontSize:12,color:T.sub,marginTop:2}}>{selected?.name} will get back to you soon.</div>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MENTOR MODULE
// ─────────────────────────────────────────────────────────────────────────────

// ── Meeting Report — Email sender ─────────────────────────────────────────────
const sendMeetingReportEmail = async (report, apprentice, mentor, approver) => {
  const fD = (iso) => { if(!iso) return "TBC"; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };
  const lines = [
    `APPRENTICE CHECK IN REPORT`,
    `Kiwi Trade Apprentices`,
    `════════════════════════════════════════════`,
    ``,
    `Trainee Name:       ${apprentice.name}`,
    `Trade:              ${apprentice.trade||"Not specified"}`,
    `Location:           ${report.location||"Not specified"}`,
    `Date:               ${fD(report.date)}`,
    `KTA Representative: ${mentor.name}`,
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
  const recipients = [
    { email: apprentice.email, name: apprentice.name },
    approver ? { email: approver.email, name: approver.name } : null,
  ].filter(r=>r&&r.email);
  const htmlLines = lines.replace(/\n/g, "<br>");
  for(const r of recipients) {
    try {
      await sendKTAEmail({
        to: r.email,
        subject: `Apprentice Check In Report — ${apprentice.name}`,
        html: `<p>Hi ${r.name},</p>
<p>Please find below the apprentice check in report for <strong>${apprentice.name}</strong>.</p>
<hr>
<pre style="font-family:monospace;font-size:13px;line-height:1.6">${lines}</pre>
<p style="color:#888;font-size:12px">KTA Workforce Management · timesheet@kta.org.nz</p>`,
      });
    } catch(e) { console.error("Meeting report email failed:", e); }
  }
};

// Stable textarea + section-header components for MeetingReportForm
// MUST live outside MeetingReportForm — if defined inside, every keystroke
// recreates them as new component types, unmounting/remounting and losing focus.
const ReportTA = ({rows=4, value, onChange, placeholder}) => (
  <textarea rows={rows} value={value} onChange={onChange} placeholder={placeholder||""}
    style={{width:"100%",fontSize:13,padding:"10px 12px",border:`1px solid ${T.border}`,
      borderTop:"none",borderRadius:0,fontFamily:"DM Sans,sans-serif",background:"#fff",
      resize:"vertical",color:T.ink,outline:"none",boxSizing:"border-box",minHeight:90}}/>
);
const ReportSH = ({children, req}) => (
  <div style={{background:"#f5f7fa",border:`1px solid ${T.border}`,borderBottom:"none",
    padding:"9px 12px",fontWeight:700,fontSize:13,color:T.ink,display:"flex",alignItems:"center",gap:5}}>
    {children}{req&&<span style={{color:T.red,fontSize:11,marginLeft:2}}>*</span>}
  </div>
);

// ── Meeting Report Form — KTA "Apprentice Check In Report" template ───────────
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
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));
  const fD = (iso) => { if(!iso) return "—"; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };

  const handleSave = async () => {
    if(!form.commentsFeedback.trim() && !form.onJobProgress.trim()) {
      alert("Please fill in at least On Job Progress or Comments & Feedback."); return;
    }
    setSaving(true);
    const report = {
      id: uid(), apprentice_id: apprentice.id, mentor_id: mentor.id,
      date: form.date, location: form.location.trim(),
      off_job_progress:  form.offJobProgress.trim(),
      on_job_progress:   form.onJobProgress.trim(),
      previous_goals:    form.previousGoals.trim(),
      goals_this_meeting: form.goalsNextVisit.trim(),
      comments_feedback: form.commentsFeedback.trim(),
      next_visit_date:   form.nextVisitDate || null,
      created_at:        new Date().toISOString(),
    };
    try {
      await upsertRow('meeting_reports', report);
      setEmailStatus("sending");
      await sendMeetingReportEmail(report, apprentice, mentor, approver);
      setEmailStatus("sent");
      setTimeout(()=>onSave(report), 900);
    } catch(e) { alert("Failed to save: " + e.message); setSaving(false); }
  };

  return (
    <div style={{border:`1.5px solid ${T.border}`,borderRadius:10,overflow:"hidden",background:"#fff"}}>
      {/* KTA Header */}
      <div style={{background:T.dark,padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'",fontWeight:700,fontSize:16,color:"#fff"}}>Apprentice Check In Report</div>
          <div style={{fontSize:11,color:"#ffffff88",marginTop:2}}>Kiwi Trade Apprentices</div>
        </div>
        <img src={KTA_LOGO} alt="KTA" style={{height:36,objectFit:"contain",filter:"brightness(0) invert(1)"}}
          onError={e=>e.target.style.display="none"}/>
      </div>

      {/* Top table — Trainee Name / Location / Date */}
      <div style={{border:`1px solid ${T.border}`,borderTop:"none"}}>
        {[
          {label:"Trainee Name", content:<div style={{padding:"4px 6px",fontSize:13,fontWeight:600}}>{apprentice.name}</div>},
          {label:"Location",     content:<input value={form.location} onChange={e=>sf("location",e.target.value)}
            placeholder="e.g. Worksite, Zoom, Head Office"
            onKeyDown={e=>e.stopPropagation()}
            style={{border:"none",fontSize:13,width:"100%",outline:"none",padding:"6px",fontFamily:"DM Sans,sans-serif",background:"transparent"}}/>},
          {label:"Date",         content:<input type="date" value={form.date} onChange={e=>sf("date",e.target.value)}
            style={{border:"none",fontSize:13,width:"100%",outline:"none",padding:"6px",fontFamily:"DM Sans,sans-serif",background:"transparent"}}/>},
        ].map(({label,content})=>(
          <div key={label} style={{display:"grid",gridTemplateColumns:"160px 1fr",borderBottom:`1px solid ${T.border}`}}>
            <div style={{padding:"10px 12px",fontWeight:700,fontSize:13,borderRight:`1px solid ${T.border}`,background:"#f5f7fa"}}>{label}</div>
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
        <ReportTA rows={4} value={form.previousGoals} onChange={e=>sf("previousGoals",e.target.value)}
          placeholder="Goals set at the last visit — have they been met?"/>
        <ReportSH req>Goals Before Next Visit</ReportSH>
        <ReportTA rows={4} value={form.goalsNextVisit} onChange={e=>sf("goalsNextVisit",e.target.value)}
          placeholder="Specific goals for the apprentice to work toward before the next visit…"/>
        <ReportSH req>Comments and Feedback</ReportSH>
        <ReportTA rows={5} value={form.commentsFeedback} onChange={e=>sf("commentsFeedback",e.target.value)}
          placeholder="Overall summary, observations, any concerns or positive feedback…"/>
      </div>

      {/* Bottom table — Licence Expiry / Next Visit / KTA Rep */}
      <div style={{border:`1px solid ${T.border}`,borderTop:"none"}}>
        {[
          {label:"Licence Expiry",      content:<div style={{padding:"6px",fontSize:13,fontWeight:600,
            color: apprentice.licenceExpiry && new Date(apprentice.licenceExpiry+"T00:00:00")<new Date() ? T.red : T.ink}}>
            {apprentice.licenceExpiry ? fD(apprentice.licenceExpiry) : "Not set"}</div>},
          {label:"Date of Next Visit",  content:<input type="date" value={form.nextVisitDate} onChange={e=>sf("nextVisitDate",e.target.value)}
            style={{border:"none",fontSize:13,width:"100%",outline:"none",padding:"6px",fontFamily:"DM Sans,sans-serif",background:"transparent"}}/>},
          {label:"KTA Representative",  content:<div style={{padding:"6px",fontSize:13,fontWeight:600}}>{mentor.name}</div>},
        ].map(({label,content})=>(
          <div key={label} style={{display:"grid",gridTemplateColumns:"180px 1fr",borderBottom:`1px solid ${T.border}`}}>
            <div style={{padding:"10px 12px",fontWeight:700,fontSize:13,borderRight:`1px solid ${T.border}`,background:"#f5f7fa"}}>{label}</div>
            <div>{content}</div>
          </div>
        ))}
      </div>

      {/* Email notice + save */}
      <div style={{padding:"14px 16px",background:T.bg,borderTop:`1px solid ${T.border}`}}>
        <div style={{fontSize:12,color:T.accent,marginBottom:12,padding:"8px 12px",
          background:T.accentL,borderRadius:7,border:`1px solid ${T.accent}33`}}>
          📧 On save this report will be emailed to:
          <strong> {apprentice.name}</strong>{apprentice.email?` (${apprentice.email})`:` — no email set`}
          {approver&&<>, <strong>{approver.name}</strong>{approver.email?` (${approver.email})`:""}</>}
        </div>
        {emailStatus==="sending"&&<div style={{background:T.warnL,border:`1px solid ${T.warn}44`,borderRadius:7,padding:"8px 12px",marginBottom:10,fontSize:12,color:T.warn}}>⏳ Sending emails…</div>}
        {emailStatus==="sent"&&<div style={{background:T.tealL,border:`1px solid ${T.teal}44`,borderRadius:7,padding:"8px 12px",marginBottom:10,fontSize:12,color:T.teal}}>✓ Saved and emailed!</div>}
        <div style={{display:"flex",gap:8}}>
          <Btn onClick={handleSave} disabled={saving}>{saving?"Saving…":"💾 Save & Email Report"}</Btn>
          <Btn v="ghost" onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Past Meeting Reports ──────────────────────────────────────────────────────
function PastMeetingReports({apprentice, allUsers, canEdit=false}) {
  const [reports, setReports]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [expandId, setExpandId] = useState(null);

  useEffect(()=>{
    loadTable('meeting_reports')
      .then(rows=>setReports(rows.filter(r=>r.apprentice_id===apprentice.id).sort((a,b)=>b.date.localeCompare(a.date))))
      .catch(()=>setReports([]))
      .finally(()=>setLoading(false));
  },[apprentice.id]);

  const handleDelete = async (id) => {
    if(!window.confirm("Delete this meeting report?")) return;
    await deleteRow('meeting_reports', id).catch(console.error);
    setReports(prev=>prev.filter(r=>r.id!==id));
  };

  const fD = (iso) => { if(!iso) return "—"; try{ const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }catch{ return iso; } };

  const Section = ({label,value}) => value ? (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:11,fontWeight:700,color:T.dark,textTransform:"uppercase",
        letterSpacing:".6px",marginBottom:3,paddingBottom:3,borderBottom:`1px solid ${T.border}`}}>{label}</div>
      <div style={{fontSize:13,color:T.ink,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{value}</div>
    </div>
  ) : null;

  if(loading) return <div style={{padding:24,textAlign:"center",color:T.muted,fontSize:13}}>Loading reports…</div>;

  return (
    <div>
      {reports.length===0&&(
        <div style={{padding:"24px 0",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>No check in reports yet</div>
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
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>📋</div>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14,color:isOpen?"#fff":T.ink}}>
                  {fD(r.date)}{r.location?` — ${r.location}`:""}
                </div>
                <div style={{fontSize:12,color:isOpen?"#ffffff88":T.sub,marginTop:1}}>
                  {mentorUser?.name||"Unknown"} · KTA Representative
                  {r.next_visit_date&&<span style={{marginLeft:8}}>Next visit: {fD(r.next_visit_date)}</span>}
                </div>
              </div>
              <div style={{fontSize:11,color:isOpen?"#ffffff66":T.muted}}>{isOpen?"▲ collapse":"▼ view"}</div>
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
                      <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>{label}</div>
                      <div style={{fontSize:13,fontWeight:600,color:T.ink}}>{value}</div>
                    </div>
                  ))}
                </div>
                {canEdit&&(
                  <button onClick={()=>handleDelete(r.id)} style={{
                    marginTop:12,fontSize:12,color:T.red,background:"none",
                    border:`1px solid ${T.red}44`,borderRadius:6,padding:"4px 12px",
                    cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>🗑 Delete Report</button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── PPE Allocation ────────────────────────────────────────────────────────────
const PPE_ITEMS = ["Hard Hat","High-Vis Vest","Safety Boots","Safety Glasses","Gloves","Ear Protection","Dust Mask / P2 Respirator","Harness","Knee Pads","Face Shield","First Aid Kit","Other"];

function PPEAllocation({apprentice, mentor, canEdit=false}) {
  const [allocations, setAllocations] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm] = useState({item:"Hard Hat", quantity:"1", issuedDate: new Date().toISOString().slice(0,10), notes:""});
  const [saving, setSaving] = useState(false);
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));

  useEffect(()=>{
    loadTable('ppe_allocations')
      .then(rows=>setAllocations(rows.filter(r=>r.apprentice_id===apprentice.id).sort((a,b)=>b.issued_date.localeCompare(a.issued_date))))
      .catch(()=>setAllocations([]))
      .finally(()=>setLoading(false));
  },[apprentice.id]);

  const handleAdd = async () => {
    if(!form.item) return;
    setSaving(true);
    const row = {
      id: uid(),
      apprentice_id: apprentice.id,
      mentor_id: mentor.id,
      item: form.item,
      quantity: parseInt(form.quantity)||1,
      issued_date: form.issuedDate,
      notes: form.notes.trim(),
      created_at: new Date().toISOString(),
    };
    try {
      await upsertRow('ppe_allocations', row);
      setAllocations(prev=>[row,...prev]);
      setShowForm(false);
      setForm({item:"Hard Hat",quantity:"1",issuedDate:new Date().toISOString().slice(0,10),notes:""});
    } catch(e) { alert("Failed: "+e.message); }
    setSaving(false);
  };

  const handleDelete = async (id) => {
    if(!window.confirm("Remove this PPE record?")) return;
    await deleteRow('ppe_allocations', id).catch(console.error);
    setAllocations(prev=>prev.filter(r=>r.id!==id));
  };

  const fmtDate = (iso) => { if(!iso) return "—"; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };

  if(loading) return <div style={{padding:16,textAlign:"center",color:T.muted,fontSize:13}}>Loading…</div>;

  return (
    <div>
      {canEdit&&(
        <div style={{marginBottom:14}}>
          {!showForm
            ? <Btn sm onClick={()=>setShowForm(true)}>+ Issue PPE Item</Btn>
            : (
              <Card style={{border:`1.5px solid ${T.accent}44`,marginBottom:0}}>
                <div style={{fontWeight:700,fontSize:13,marginBottom:12}}>Issue PPE to {apprentice.name}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 80px",gap:10,marginBottom:10}}>
                  <div>
                    <FL req>Item</FL>
                    <select value={form.item} onChange={e=>sf("item",e.target.value)}>
                      {PPE_ITEMS.map(i=><option key={i}>{i}</option>)}
                    </select>
                  </div>
                  <div><FL>Qty</FL><input type="number" min="1" value={form.quantity} onChange={e=>sf("quantity",e.target.value)}/></div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                  <div><FL>Date Issued</FL><input type="date" value={form.issuedDate} onChange={e=>sf("issuedDate",e.target.value)}/></div>
                  <div><FL>Notes</FL><input placeholder="Size, colour, condition…" value={form.notes} onChange={e=>sf("notes",e.target.value)}/></div>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <Btn sm onClick={handleAdd} disabled={saving}>{saving?"Saving…":"Save"}</Btn>
                  <Btn sm v="ghost" onClick={()=>setShowForm(false)}>Cancel</Btn>
                </div>
              </Card>
            )
          }
        </div>
      )}

      {allocations.length===0&&!showForm&&(
        <div style={{padding:"16px 0",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>No PPE issued yet</div>
      )}

      {allocations.length>0&&(
        <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 50px 110px 1fr 36px",
            padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
            fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
            <span>Item</span><span style={{textAlign:"center"}}>Qty</span><span>Date Issued</span><span>Notes</span><span/>
          </div>
          {allocations.map((r,i)=>(
            <div key={r.id} style={{display:"grid",gridTemplateColumns:"1fr 50px 110px 1fr 36px",
              padding:"9px 14px",gap:8,alignItems:"center",fontSize:13,
              borderBottom:i<allocations.length-1?`1px solid ${T.border}44`:"none",
              background:i%2===0?T.surface:T.bg}}>
              <div style={{fontWeight:600}}>{r.item}</div>
              <div style={{textAlign:"center",color:T.accent,fontWeight:700}}>{r.quantity}</div>
              <div style={{color:T.sub}}>{fmtDate(r.issued_date)}</div>
              <div style={{color:r.notes?T.ink:T.muted,fontStyle:r.notes?"normal":"italic",fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.notes||"—"}</div>
              <div>
                {canEdit&&(
                  <button onClick={()=>handleDelete(r.id)} style={{
                    width:28,height:28,borderRadius:6,background:"none",color:T.muted,
                    border:`1px solid ${T.border}`,cursor:"pointer",display:"flex",
                    alignItems:"center",justifyContent:"center",fontSize:13}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;}}
                    onMouseLeave={e=>{e.currentTarget.style.background="none";e.currentTarget.style.color=T.muted;}}>✕</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Apprentice Detail Page (used by both Mentor and Admin) ────────────────────
function ApprenticeDetailView({apprentice, viewer, allUsers, entries, onBack, isAdmin=false}) {
  const [showMeetingForm, setShowMeetingForm] = useState(false);
  const [meetingKey, setMeetingKey]           = useState(0);
  const [lastVisit, setLastVisit]             = useState(null);
  const [loadingVisit, setLoadingVisit]       = useState(true);
  const [reports, setReports]                 = useState([]);

  useEffect(()=>{
    loadTable('meeting_reports')
      .then(rows=>{
        const sorted = rows.filter(r=>r.apprentice_id===apprentice.id).sort((a,b)=>b.date.localeCompare(a.date));
        setReports(sorted);
        setLastVisit(sorted[0]?.date||null);
      })
      .catch(()=>{ setReports([]); setLastVisit(null); })
      .finally(()=>setLoadingVisit(false));
  },[apprentice.id, meetingKey]);

  const fmtDate = (iso) => { if(!iso) return null; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; };
  const daysUntil = (iso) => { if(!iso) return null; const today=new Date(); today.setHours(0,0,0,0); const exp=new Date(iso+"T00:00:00"); return Math.round((exp-today)/86400000); };

  const licDays = daysUntil(apprentice.licenceExpiry);
  const licColor = licDays===null?T.muted:licDays<0?T.red:licDays<=7?T.red:licDays<=30?T.warn:T.teal;

  const lastReport    = reports[0] || null;
  const prevReport    = reports[1] || null;

  // Timesheet entries for this apprentice (admin view)
  const appEntries = (entries||[]).filter(e=>e.userId===apprentice.id).sort((a,b)=>b.date.localeCompare(a.date));
  const approvedH  = appEntries.filter(e=>e.approval==="approved").reduce((s,e)=>s+e.netHours,0).toFixed(1);
  const submittedH = appEntries.filter(e=>e.approval==="submitted").reduce((s,e)=>s+e.netHours,0).toFixed(1);

  // Approver for this apprentice
  const approver = allUsers.find(u=>
    u.id===apprentice.approverUserId ||
    (u.role==="Approver"&&(u.allocatedTo||[]).includes(apprentice.id))
  );

  const ratingColor = (r) => r==="Excellent"?T.teal:r==="Good"?T.accent:r==="Satisfactory"?T.gold:r==="Needs Improvement"?T.warn:r==="Concerning"?T.red:T.muted;

  return (
    <div className="fu">
      <button onClick={onBack} style={{
        display:"inline-flex",alignItems:"center",gap:6,background:"none",border:"none",
        color:T.sub,fontSize:13,fontFamily:"DM Sans,sans-serif",cursor:"pointer",
        marginBottom:16,padding:0,fontWeight:500}}
        onMouseEnter={e=>e.currentTarget.style.color=T.ink}
        onMouseLeave={e=>e.currentTarget.style.color=T.sub}>
        ← {isAdmin?"Back to Dashboard":"Back to My Apprentices"}
      </button>

      {/* ── Card 1: Apprentice Summary ── */}
      <Card style={{marginBottom:16,border:`2px solid ${T.dark}33`}}>
        <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:16,
          paddingBottom:16,borderBottom:`1px solid ${T.border}`}}>
          <div style={{width:54,height:54,borderRadius:"50%",flexShrink:0,
            background:T.dark,display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:22,fontWeight:700,color:"#fff",fontFamily:"'Libre Baskerville'"}}>
            {apprentice.name?.[0]?.toUpperCase()||"?"}
          </div>
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Libre Baskerville'",fontSize:22,fontWeight:700,color:T.ink}}>{apprentice.name}</div>
            <div style={{display:"flex",gap:8,marginTop:4,flexWrap:"wrap"}}>
              <RolePill role="Apprentice" size="sm"/>
              {approver&&<Pill label={`Approver: ${approver.name}`} size="sm" color={T.warn} bg={T.warnL}/>}
            </div>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10}}>
          {[
            {label:"Trade",            value:apprentice.trade||"Not set",   icon:"🔧", bg:T.accentL,  valColor:T.accent},
            {label:"Licence Expiry",
              value:apprentice.licenceExpiry
                ?(licDays!==null?`${fmtDate(apprentice.licenceExpiry)} (${licDays<0?"Expired":licDays===0?"Today":`${licDays}d`})`:fmtDate(apprentice.licenceExpiry))
                :"Not set",
              icon:"📄",
              bg:licDays===null?T.bg:licDays<=7?T.redL:licDays<=30?T.warnL:T.tealL,
              valColor:licColor},
            {label:"Last Mentor Visit",value:loadingVisit?"…":lastVisit?fmtDate(lastVisit):"No visits yet",icon:"📅",bg:T.tealL,valColor:T.teal},
            {label:"Email",            value:apprentice.email||"Not set",   icon:"✉",  bg:T.bg,       valColor:T.sub},
            {label:"Phone",            value:apprentice.phone||"Not set",   icon:"📞", bg:T.bg,       valColor:T.sub},
          ].map(({label,value,icon,bg,valColor})=>(
            <div key={label} style={{background:bg,borderRadius:10,padding:"10px 14px",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",marginBottom:4}}>{icon} {label}</div>
              <div style={{fontSize:13,fontWeight:700,color:valColor,wordBreak:"break-all",lineHeight:1.4}}>{value}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Goals cards (side by side if both exist) ── */}
      <div style={{display:"grid",gridTemplateColumns:prevReport?"1fr 1fr":"1fr",gap:12,marginBottom:16}}>
        {/* Goals from last meeting */}
        <Card style={{border:`1.5px solid ${T.accent}33`}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
            <div style={{width:32,height:32,borderRadius:8,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>🎯</div>
            <div>
              <div style={{fontWeight:700,fontSize:14}}>Goals from Last Meeting</div>
              {lastReport&&<div style={{fontSize:11,color:T.sub}}>{fmtDate(lastReport.date)}</div>}
            </div>
          </div>
          {lastReport?.goals_this_meeting
            ? <div style={{fontSize:13,color:T.ink,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{lastReport.goals_this_meeting}</div>
            : <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>{lastReport?"No goals recorded for this visit":"No meeting reports yet"}</div>
          }
          {lastReport?.rating&&(
            <div style={{marginTop:10,display:"inline-flex",alignItems:"center",gap:6,
              background:ratingColor(lastReport.rating)+"15",borderRadius:6,padding:"3px 10px"}}>
              <span style={{fontSize:12,fontWeight:700,color:ratingColor(lastReport.rating)}}>{lastReport.rating}</span>
            </div>
          )}
        </Card>

        {/* Goals from meeting before */}
        {prevReport&&(
          <Card style={{border:`1.5px solid ${T.gold}33`}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <div style={{width:32,height:32,borderRadius:8,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>📌</div>
              <div>
                <div style={{fontWeight:700,fontSize:14}}>Goals from Previous Meeting</div>
                <div style={{fontSize:11,color:T.sub}}>{fmtDate(prevReport.date)}</div>
              </div>
            </div>
            {prevReport.goals_this_meeting
              ? <div style={{fontSize:13,color:T.ink,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{prevReport.goals_this_meeting}</div>
              : <div style={{fontSize:12,color:T.muted,fontStyle:"italic"}}>No goals recorded for this visit</div>
            }
            {prevReport.rating&&(
              <div style={{marginTop:10,display:"inline-flex",alignItems:"center",gap:6,
                background:ratingColor(prevReport.rating)+"15",borderRadius:6,padding:"3px 10px"}}>
                <span style={{fontSize:12,fontWeight:700,color:ratingColor(prevReport.rating)}}>{prevReport.rating}</span>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* ── Timesheet Summary (Admin only) ── */}
      {isAdmin && (
        <Card style={{marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
            <div style={{width:36,height:36,borderRadius:10,background:T.blueL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⏱</div>
            <div>
              <div style={{fontWeight:700,fontSize:15}}>Timesheet Summary</div>
              <div style={{fontSize:12,color:T.sub}}>All entries for {apprentice.name}</div>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:10,marginBottom:16}}>
            {[
              {label:"Total Entries",   value: appEntries.length,                                           color:T.accent},
              {label:"Approved Hours",  value: `${approvedH}h`,                                             color:T.teal},
              {label:"Pending (hrs)",   value: `${submittedH}h`,                                            color:T.warn},
              {label:"Drafts",          value: appEntries.filter(e=>e.approval==="draft").length,            color:T.muted},
              {label:"Declined",        value: appEntries.filter(e=>e.approval==="declined").length,         color:T.red},
            ].map(({label,value,color})=>(
              <div key={label} style={{background:T.bg,borderRadius:10,padding:"10px 14px",border:`1px solid ${T.border}`,textAlign:"center"}}>
                <div style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:4}}>{label}</div>
                <div style={{fontSize:20,fontWeight:700,color,fontFamily:"'Libre Baskerville'"}}>{value}</div>
              </div>
            ))}
          </div>
          {/* Recent entries list */}
          {appEntries.length>0&&(
            <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 70px 90px",
                padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
                <span>Date</span><span>Type / Note</span><span style={{textAlign:"center"}}>Hours</span><span>Status</span><span>Start–End</span>
              </div>
              {appEntries.slice(0,20).map((e,i)=>{
                const am = APPROVAL_META[e.approval]||APPROVAL_META.draft;
                const tm = TYPE_META[e.type]||TYPE_META["Normal Hours"];
                return (
                  <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 70px 90px",
                    padding:"9px 14px",gap:8,alignItems:"center",fontSize:13,
                    borderBottom:i<Math.min(appEntries.length,20)-1?`1px solid ${T.border}44`:"none",
                    background:i%2===0?T.surface:T.bg}}>
                    <div style={{fontWeight:600,fontSize:12}}>{fmtD(e.date)}</div>
                    <div>
                      <Pill label={e.type} size="sm" color={tm.color} bg={tm.bg}/>
                      {e.note&&<div style={{fontSize:11,color:T.muted,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note}</div>}
                    </div>
                    <div style={{textAlign:"center",fontWeight:700,color:T.accent}}>{e.netHours}h</div>
                    <Pill label={am.label} size="sm" color={am.color} bg={am.bg}/>
                    <div style={{fontSize:11,color:T.sub}}>{e.start}–{e.end}</div>
                  </div>
                );
              })}
              {appEntries.length>20&&<div style={{padding:"8px 14px",fontSize:12,color:T.muted,textAlign:"center"}}>Showing 20 of {appEntries.length} entries</div>}
            </div>
          )}
          {appEntries.length===0&&<div style={{padding:"20px 0",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>No timesheet entries yet</div>}
        </Card>
      )}

      {/* ── New Meeting Report ── */}
      <Card style={{marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:showMeetingForm?16:0}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:36,height:36,borderRadius:10,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📋</div>
            <div>
              <div style={{fontWeight:700,fontSize:15}}>New Meeting Report</div>
              <div style={{fontSize:12,color:T.sub}}>Record a visit or check-in with {apprentice.name}</div>
            </div>
          </div>
          {!showMeetingForm&&<Btn onClick={()=>setShowMeetingForm(true)}>+ New Report</Btn>}
        </div>
        {showMeetingForm&&(
          <MeetingReportForm
            apprentice={apprentice}
            mentor={viewer}
            allUsers={allUsers}
            onSave={(report)=>{
              setShowMeetingForm(false);
              setMeetingKey(k=>k+1);
            }}
            onCancel={()=>setShowMeetingForm(false)}
          />
        )}
      </Card>

      {/* ── Past Meeting Reports ── */}
      <Card style={{marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
          <div style={{width:36,height:36,borderRadius:10,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📁</div>
          <div>
            <div style={{fontWeight:700,fontSize:15}}>Past Meeting Reports</div>
            <div style={{fontSize:12,color:T.sub}}>History of all visits with {apprentice.name}</div>
          </div>
        </div>
        <PastMeetingReports key={meetingKey} apprentice={apprentice} allUsers={allUsers} canEdit={true}/>
      </Card>

      {/* ── PPE Allocation ── */}
      <Card style={{marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
          <div style={{width:36,height:36,borderRadius:10,background:T.tealL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🦺</div>
          <div>
            <div style={{fontWeight:700,fontSize:15}}>PPE Allocation</div>
            <div style={{fontSize:12,color:T.sub}}>Personal protective equipment issued to {apprentice.name}</div>
          </div>
        </div>
        <PPEAllocation apprentice={apprentice} mentor={viewer} canEdit={true}/>
      </Card>

      {/* ── Activity & Email Timeline ── */}
      {apprentice.email && (
        <Card style={{marginBottom:16}}>
          <EmailActivityFeed
            personEmail={apprentice.email}
            personName={apprentice.name}
            personId={apprentice.id}
            canEdit={true}
            extraItems={reports.map(r=>({
              id: r.id,
              created_at: r.created_at||r.date+"T12:00:00",
              date: r.date,
              label: `Meeting Report — ${r.date ? (()=>{const [y,m,d]=r.date.split('-');return`${d}/${m}/${y}`;})() : ""}`,
              detail: r.goals_this_meeting ? `Goals: ${r.goals_this_meeting}` : r.comments_feedback||"",
            }))}
          />
        </Card>
      )}
    </div>
  );
}

// Legacy wrapper for Mentor
function MentorApprenticeDetail({apprentice, mentor, allUsers, onBack}) {
  return <ApprenticeDetailView apprentice={apprentice} viewer={mentor} allUsers={allUsers} onBack={onBack} isAdmin={false} entries={[]}/>;
}

// ── Mentor Dashboard (home screen) ───────────────────────────────────────────
function MentorDashboard({currentUser, allUsers}) {
  const [selectedApprentice, setSelectedApprentice] = useState(null);
  const [apprenticeSummaries, setApprenticeSummaries] = useState({}); // id -> {lastVisit, reportCount}
  const [loadingMeta, setLoadingMeta] = useState(true);

  // Mentor's allocated apprentices — check both allocatedTo (legacy) and mentorUserId (new)
  const myApprentices = allUsers.filter(u=>
    u.role==="Apprentice" && (
      (currentUser.allocatedTo||[]).includes(u.id) ||
      u.mentorUserId===currentUser.id
    )
  ).sort((a,b)=>a.name.localeCompare(b.name));

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

  if(selectedApprentice) {
    return (
      <ApprenticeDetailView
        apprentice={selectedApprentice}
        viewer={currentUser}
        allUsers={allUsers}
        entries={[]}
        isAdmin={false}
        onBack={()=>setSelectedApprentice(null)}
      />
    );
  }

  return (
    <div className="fu">
      <div style={{marginBottom:20}}>
        <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:26,fontWeight:700,letterSpacing:"-.4px",marginBottom:4}}>
          Welcome, {currentUser.name.split(" ")[0]}
        </h1>
        <p style={{fontSize:13,color:T.sub}}>Your apprentice overview and mentor tools</p>
      </div>

      {/* ── Apprentices Card ── */}
      <Card style={{marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
          <div style={{width:38,height:38,borderRadius:11,background:T.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>👷</div>
          <div>
            <div style={{fontWeight:700,fontSize:16}}>My Apprentices</div>
            <div style={{fontSize:12,color:T.sub}}>{myApprentices.length} apprentice{myApprentices.length!==1?"s":""} allocated to you</div>
          </div>
        </div>

        {myApprentices.length===0&&(
          <div style={{padding:"24px 0",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>
            No apprentices allocated to you yet — contact an Admin.
          </div>
        )}

        {myApprentices.map((app,i)=>{
          const meta   = apprenticeSummaries[app.id]||{};
          const licDays = daysUntil(app.licenceExpiry);
          const licWarn = licDays!==null && licDays<=30;
          return (
            <div key={app.id} onClick={()=>setSelectedApprentice(app)}
              className="ri"
              style={{display:"flex",alignItems:"center",gap:14,padding:"12px 4px",
                borderBottom:i<myApprentices.length-1?`1px solid ${T.border}44`:"none",
                cursor:"pointer",borderRadius:8,animationDelay:`${i*.04}s`}}
              onMouseEnter={e=>e.currentTarget.style.background=T.accentL+"66"}
              onMouseLeave={e=>e.currentTarget.style.background="none"}>
              <Avatar name={app.name} role="Apprentice" size={42}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14,color:T.accent}}>{app.name}</div>
                <div style={{fontSize:12,color:T.sub,marginTop:1,display:"flex",gap:10,flexWrap:"wrap"}}>
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
                  <div style={{fontSize:11,fontWeight:700,color:licDays<0?T.red:licDays<=7?T.red:T.warn,
                    background:licDays<=7?T.redL:T.warnL,borderRadius:6,padding:"2px 8px"}}>
                    {licDays<0?"Licence expired":licDays===0?"Expires today":`Licence: ${licDays}d`}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </Card>

      {/* ── Resources Card ── */}
      <Card style={{marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
          <div style={{width:38,height:38,borderRadius:11,background:T.goldL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>📂</div>
          <div>
            <div style={{fontWeight:700,fontSize:16}}>Resources</div>
            <div style={{fontSize:12,color:T.sub}}>Guides, templates, and reference materials</div>
          </div>
        </div>
        <div style={{background:T.bg,borderRadius:10,padding:"14px 16px",
          border:`1px dashed ${T.border}`,textAlign:"center"}}>
          <div style={{fontSize:28,marginBottom:8}}>📁</div>
          <div style={{fontWeight:600,fontSize:14,color:T.sub,marginBottom:4}}>Resource Folder Coming Soon</div>
          <div style={{fontSize:12,color:T.muted,lineHeight:1.6}}>
            This section will link to shared files, templates, and training resources.<br/>
            Contact your Admin to set up the resource folder.
          </div>
        </div>
      </Card>
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
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700}}>📢 Send Notification</div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:20,
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
          <div style={{fontSize:11,color:T.muted,marginTop:4}}>
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
              fontSize:13,background:T.bg,color:T.ink,boxSizing:"border-box"}}/>
        </div>
        <div style={{display:"flex",gap:8}}>
          <Btn onClick={send} disabled={sending||!title.trim()||!message.trim()}>
            {sending?"Sending…":"📢 Send Notification"}
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
    if(!window.confirm("Permanently delete this message?")) return;
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
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>💬</div>
        <div>
          <div style={{fontWeight:700,fontSize:14}}>Conversation</div>
          <div style={{fontSize:12,color:T.sub}}>
            Permanent message history with {apprentice.name}
            {canManageMessages&&<span style={{marginLeft:8,fontSize:11,color:T.muted}}>(hover a message to delete)</span>}
          </div>
        </div>
      </div>

      {loadErr&&<div style={{fontSize:12,color:T.red,marginBottom:12}}>⚠ Could not load messages: {loadErr}</div>}

      {Object.keys(grouped).length===0&&!loadErr&&(
        <div style={{padding:"24px 0",textAlign:"center",color:T.muted,fontSize:13,fontStyle:"italic"}}>
          No messages yet
        </div>
      )}

      {Object.entries(grouped).map(([day, dayMsgs])=>(
        <div key={day} style={{marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{flex:1,height:1,background:T.border}}/>
            <div style={{fontSize:11,color:T.muted,fontWeight:600,whiteSpace:"nowrap"}}>{fmtDay(day)}</div>
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
                  <div style={{fontSize:12,color:T.ink,lineHeight:1.5,wordBreak:"break-word"}}>{m.body}</div>
                  {/* Delete button — Admin 1 only, shown on hover */}
                  {canManageMessages&&hoverMsg===m.id&&(
                    <button onClick={()=>handleDelete(m.id)} title="Delete message" style={{
                      position:"absolute",top:-8,right:-8,width:20,height:20,borderRadius:"50%",
                      background:T.red,color:"#fff",border:"none",cursor:"pointer",
                      fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",
                      lineHeight:1,fontWeight:700}}>✕</button>
                  )}
                </div>
                <div style={{fontSize:10,color:T.muted,marginTop:3,display:"flex",gap:6}}>
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
          style={{width:"100%",fontSize:13,padding:"9px 12px",borderRadius:8,
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
const calcOvertimeSplit = (entry, apprentice, allEntries) => {
  const { overtimeType, overtimeThreshold, overtimeRateId } = apprentice;
  if(!overtimeType || !overtimeThreshold || !overtimeRateId || entry.type !== "Normal Hours") {
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
  const xeroSettings = JSON.parse(localStorage.getItem("kta_xero_settings")||"{}");
  const { edgeFunctionUrl, tenantId, earningsRates = {} } = xeroSettings;

  if(!edgeFunctionUrl) return { ok: false, error: "Xero not configured. Set up in the Xero module." };
  if(!tenantId)         return { ok: false, error: "Xero Tenant ID not configured." };
  if(!apprentice.xeroEmployeeId) return { ok: false, error: `No Xero Employee ID for ${apprentice.name}` };

  const normalRateId = earningsRates[entry.type];
  if(!normalRateId) return { ok: false, error: `No Xero Earnings Rate mapped for "${entry.type}"` };

  // Calculate overtime split
  const splits = calcOvertimeSplit(entry, apprentice, allEntries);
  const lines = splits.map(s => ({
    earningsRateId: s.isOvertime ? apprentice.overtimeRateId : normalRateId,
    hours: s.hours,
    isOvertime: s.isOvertime,
  }));

  const payload = {
    action:      "upsertTimesheet",
    tenantId,
    employeeId:  apprentice.xeroEmployeeId,
    date:        entry.date,
    lines,
    note:        entry.note || "",
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
function XeroModule({allUsers, entries, currentUser, onUpdateEntries, showToast, onImportUser}) {
  const [tab, setTab]             = useState("setup");     // "setup"|"employees"|"pending"|"history"
  const [settings, setSettings]   = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("kta_xero_settings")||"{}"); }catch{ return {}; }
  });
  const [saved, setSaved]         = useState(false);
  const [empMap, setEmpMap]               = useState({}); // userId -> xeroEmployeeId (local edits)
  const [xeroEmployees, setXeroEmployees] = useState([]); // loaded from Xero
  const [xeroRates, setXeroRates]         = useState([]); // earnings rates loaded from Xero
  const [savingMap, setSavingMap] = useState({});

  const apprentices = allUsers.filter(u=>u.role==="Apprentice").sort((a,b)=>a.name.localeCompare(b.name));
  const approvedEntries = entries.filter(e=>e.approval==="approved")
    .sort((a,b)=>b.date.localeCompare(a.date));
  const pendingXero = approvedEntries.filter(e=>!e.xeroStatus);
  const submittedXero = approvedEntries.filter(e=>e.xeroStatus==="submitted");

  const ss = (k,v) => setSettings(s=>({...s,[k]:v}));
  const saveSettings = () => {
    localStorage.setItem("kta_xero_settings", JSON.stringify(settings));
    setSaved(true); setTimeout(()=>setSaved(false), 2000);
  };

  const fD = (iso) => { if(!iso) return "—"; try{ const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }catch{ return iso; } };
  const xeroBlue = "#13b5ea";
  const xeroBlueDark = "#0d7bb5";

  const ENTRY_TYPE_NAMES = ["Normal Hours","Annual Leave","Sick Leave","Public Holiday","Overtime","Block Course","Other"];

  const TabBtn = ({id,label,count}) => (
    <button onClick={()=>setTab(id)} style={{
      padding:"8px 16px",borderRadius:8,fontSize:13,fontWeight:600,
      background: tab===id ? xeroBlue : T.bg,
      color: tab===id ? "#fff" : T.sub,
      border: tab===id ? `1.5px solid ${xeroBlueDark}` : `1.5px solid ${T.border}`,
      cursor:"pointer",fontFamily:"DM Sans,sans-serif",display:"flex",alignItems:"center",gap:6,
      transition:"all .14s"}}>
      {label}
      {count!==undefined&&<span style={{
        background: tab===id?"#ffffff33":T.border,
        color: tab===id?"#fff":T.sub,
        borderRadius:99,padding:"1px 7px",fontSize:11,fontWeight:700}}>{count}</span>}
    </button>
  );

  return (
    <div className="fu">
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:24,
        padding:"20px 24px",background:"#fff",borderRadius:14,border:`1.5px solid ${xeroBlue}33`,
        boxShadow:"0 2px 12px #13b5ea11"}}>
        <div style={{width:52,height:52,borderRadius:12,background:"#e6f7fd",
          display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:28,fontWeight:900,color:xeroBlue,fontFamily:"Georgia,serif",flexShrink:0}}>𝕏</div>
        <div>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:20,fontWeight:700,color:T.ink}}>Xero Payroll Integration</div>
          <div style={{fontSize:13,color:T.sub,marginTop:2}}>
            Submit approved timesheets to Xero Payroll NZ · Admin Level 1 only
          </div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap"}}>
          <div style={{textAlign:"center",padding:"8px 16px",background:T.accentL,borderRadius:8}}>
            <div style={{fontSize:20,fontWeight:700,color:T.accent,fontFamily:"'Libre Baskerville'"}}>{pendingXero.length}</div>
            <div style={{fontSize:11,color:T.sub,fontWeight:600}}>Awaiting Xero</div>
          </div>
          <div style={{textAlign:"center",padding:"8px 16px",background:"#e6f7fd",borderRadius:8}}>
            <div style={{fontSize:20,fontWeight:700,color:xeroBlue,fontFamily:"'Libre Baskerville'"}}>{submittedXero.length}</div>
            <div style={{fontSize:11,color:T.sub,fontWeight:600}}>Submitted</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
        <TabBtn id="setup"     label="⚙ Setup & Auth"/>
        <TabBtn id="employees" label="👤 Employee Mapping" count={apprentices.filter(a=>!a.xeroEmployeeId).length||undefined}/>
        <TabBtn id="pending"   label="📤 Pending Xero Submission" count={pendingXero.length}/>
        <TabBtn id="history"   label="✓ Submission History"       count={submittedXero.length}/>
      </div>

      {/* ── Setup Tab ── */}
      {tab==="setup"&&(
        <div>
          {/* Architecture callout */}
          <div style={{background:"#fffbeb",border:`1.5px solid ${T.warn}55`,borderRadius:12,
            padding:"16px 20px",marginBottom:20}}>
            <div style={{fontWeight:700,fontSize:14,color:T.warn,marginBottom:8}}>⚠ How Xero integration works</div>
            <div style={{fontSize:13,color:T.ink,lineHeight:1.7}}>
              Xero requires <strong>OAuth 2.0 authentication</strong> which cannot be done directly from the browser due to CORS restrictions.
              This integration uses a <strong>Supabase Edge Function</strong> as a proxy — the function holds your Xero credentials securely and forwards requests to the Xero API.
            </div>
            <div style={{marginTop:12,fontSize:13,color:T.sub,lineHeight:1.7}}>
              <strong>Setup steps:</strong><br/>
              1. Create a Xero API app at <a href="https://developer.xero.com/app/manage" target="_blank" rel="noreferrer" style={{color:xeroBlue}}>developer.xero.com/app/manage</a><br/>
              2. Deploy the KTA Edge Function to Supabase (file provided below)<br/>
              3. Set the Edge Function URL and your Xero Tenant ID below<br/>
              4. Map each apprentice to their Xero Employee ID<br/>
              5. Map KTA entry types to Xero Earnings Rate IDs
            </div>
          </div>

          <Card style={{marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:16,color:T.ink}}>Connection Settings</div>
            <div style={{marginBottom:12}}>
              <FL>Supabase Edge Function URL</FL>
              <input value={settings.edgeFunctionUrl||""} onChange={e=>ss("edgeFunctionUrl",e.target.value)}
                placeholder="https://your-project.supabase.co/functions/v1/xero-proxy"/>
              <div style={{fontSize:11,color:T.muted,marginTop:3}}>The URL of your deployed xero-proxy Supabase Edge Function</div>
            </div>
            <div style={{marginBottom:16}}>
              <FL>Xero Tenant / Organisation ID</FL>
              <input value={settings.tenantId||""} onChange={e=>ss("tenantId",e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
              <div style={{fontSize:11,color:T.muted,marginTop:3}}>Found in Xero under My Xero → Connections, or via GET /connections</div>
            </div>

            <div style={{fontWeight:700,fontSize:14,marginBottom:12,marginTop:4,color:T.ink,borderTop:`1px solid ${T.border}`,paddingTop:16}}>
              Earnings Rate Mapping
            </div>
            <div style={{fontSize:12,color:T.sub,marginBottom:12,lineHeight:1.6}}>
              Map each KTA entry type to a Xero Earnings Rate. Click <strong>Load from Xero</strong> to pull your rates automatically.
            </div>
            <div style={{marginBottom:12,display:"flex",alignItems:"center",gap:10}}>
              <Btn sm onClick={async()=>{
                if(!settings.edgeFunctionUrl||!settings.tenantId){
                  alert("Save your Edge Function URL and Tenant ID first."); return;
                }
                try{
                  const res = await fetch(settings.edgeFunctionUrl,{
                    method:"POST", headers:{"Content-Type":"application/json"},
                    body: JSON.stringify({action:"getEarningsRates",tenantId:settings.tenantId}),
                  });
                  const data = await res.json();
                  if(data.ok && data.earningsRates){
                    setXeroRates(data.earningsRates);
                    showToast(`✓ Loaded ${data.earningsRates.length} earnings rates from Xero`);
                  } else { alert("Error: "+(data.error||"Unknown")); }
                }catch(e){ alert("Failed: "+e.message); }
              }}>🔄 Load Earnings Rates from Xero</Btn>
              {xeroRates.length>0&&<span style={{fontSize:12,color:T.teal,fontWeight:600}}>✓ {xeroRates.length} rates loaded</span>}
            </div>
            {ENTRY_TYPE_NAMES.map(type=>(
              <div key={type} style={{display:"grid",gridTemplateColumns:"180px 1fr",gap:10,alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:13,fontWeight:600,color:T.ink}}>{type}</div>
                {xeroRates.length > 0 ? (
                  <select value={settings.earningsRates?.[type]||""}
                    onChange={e=>ss("earningsRates",{...settings.earningsRates,[type]:e.target.value})}
                    style={{fontSize:12,padding:"5px 8px",border:`1px solid ${T.border}`,borderRadius:6,background:"#fff"}}>
                    <option value="">— Select rate —</option>
                    {xeroRates.map(r=>(
                      <option key={r.EarningsRateID} value={r.EarningsRateID}>{r.Name}</option>
                    ))}
                  </select>
                ) : (
                  <input value={settings.earningsRates?.[type]||""}
                    onChange={e=>ss("earningsRates",{...settings.earningsRates,[type]:e.target.value})}
                    placeholder="Load from Xero above, or paste rate ID manually"/>
                )}
              </div>
            ))}

            <div style={{marginTop:16}}>
              {saved
                ? <div style={{display:"inline-flex",alignItems:"center",gap:6,color:T.teal,fontWeight:600,fontSize:13}}>✓ Settings saved</div>
                : <Btn onClick={saveSettings}>Save Settings</Btn>
              }
            </div>
          </Card>

          {/* Edge function download */}
          <Card>
            <div style={{fontWeight:700,fontSize:15,marginBottom:12,color:T.ink}}>📦 Supabase Edge Function</div>
            <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.6}}>
              Deploy this function to Supabase to act as your Xero API proxy. It securely holds your Xero OAuth token and handles token refresh.
            </div>
            <div style={{background:"#1a1a2e",borderRadius:10,padding:"14px 16px",fontFamily:"monospace",fontSize:11,color:"#e2e8f0",lineHeight:1.6,overflowX:"auto",marginBottom:12}}>
              <div style={{color:"#64748b",marginBottom:4}}>{`// supabase/functions/xero-proxy/index.ts`}</div>
              <div style={{color:"#94a3b8"}}>{`// Deploy with: supabase functions deploy xero-proxy`}</div>
              <div>{`// Set secrets: supabase secrets set XERO_CLIENT_ID=... XERO_CLIENT_SECRET=... XERO_REFRESH_TOKEN=...`}</div>
            </div>
            <Btn v="ghost" onClick={()=>{
              const code = `// KTA Xero Proxy — Supabase Edge Function
// Deploy: supabase functions deploy xero-proxy
// Secrets: XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REFRESH_TOKEN

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE  = "https://api.xero.com/payroll.xro/2.0";

async function getAccessToken() {
  const clientId     = Deno.env.get("XERO_CLIENT_ID")!;
  const clientSecret = Deno.env.get("XERO_CLIENT_SECRET")!;
  const refreshToken = Deno.env.get("XERO_REFRESH_TOKEN")!;
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: clientId, client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed: " + await res.text());
  const data = await res.json();
  return data.access_token as string;
}

serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const { action, tenantId, employeeId, date, earningsRateId, hours } = await req.json();
    const token = await getAccessToken();
    const headers = {
      Authorization: \`Bearer \${token}\`,
      "Xero-Tenant-Id": tenantId,
      "Content-Type": "application/json",
    };

    if (action === "createTimesheet") {
      // Determine pay period (week Mon-Sun)
      const d   = new Date(date + "T00:00:00");
      const day = d.getDay(); // 0=Sun
      const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const fmt = (dt: Date) => dt.toISOString().slice(0, 10);

      // Create or update timesheet
      const tsBody = {
        EmployeeID: employeeId,
        StartDate:  "/Date(" + mon.getTime() + ")/",
        EndDate:    "/Date(" + sun.getTime() + ")/",
        Status: "DRAFT",
        TimesheetLines: [{
          EarningsRateID: earningsRateId,
          NumberOfUnits: [
            0, // Sun (index 0)
            day === 1 ? hours : 0,
            day === 2 ? hours : 0,
            day === 3 ? hours : 0,
            day === 4 ? hours : 0,
            day === 5 ? hours : 0,
            day === 6 ? hours : 0, // Sat
          ],
        }],
      };

      const res = await fetch(\`\${XERO_API_BASE}/Timesheets\`, {
        method: "POST",
        headers,
        body: JSON.stringify({ Timesheets: [tsBody] }),
      });
      const data = await res.json();
      if (!res.ok) return new Response(JSON.stringify({ error: JSON.stringify(data) }), { status: 400, headers: cors });
      const timesheetId = data.Timesheets?.[0]?.TimesheetID;
      return new Response(JSON.stringify({ ok: true, timesheetId }), { headers: cors });
    }

    if (action === "getEmployees") {
      const res = await fetch(\`\${XERO_API_BASE}/Employees\`, { headers });
      const data = await res.json();
      return new Response(JSON.stringify({ ok: true, employees: data.Employees }), { headers: cors });
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

      {/* ── Employees Tab ── */}
      {tab==="employees"&&(
        <Card>
          {!settings.edgeFunctionUrl&&(
            <div style={{background:T.warnL,border:`1px solid ${T.warn}44`,borderRadius:8,
              padding:"10px 14px",marginBottom:16,fontSize:12,color:T.warn}}>
              ⚠ Set up your Edge Function URL and Tenant ID in the <strong>Setup</strong> tab first.
            </div>
          )}

          {/* Load from Xero button */}
          <div style={{marginBottom:20,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <Btn sm onClick={async()=>{
              if(!settings.edgeFunctionUrl||!settings.tenantId){
                alert("Please set up your Edge Function URL and Tenant ID in the Setup tab first.");
                return;
              }
              try{
                const res = await fetch(settings.edgeFunctionUrl,{
                  method:"POST", headers:{"Content-Type":"application/json"},
                  body: JSON.stringify({action:"getEmployees",tenantId:settings.tenantId}),
                });
                const data = await res.json();
                if(data.ok && data.employees){
                  setXeroEmployees(data.employees);
                  showToast(`✓ Loaded ${data.employees.length} employees from Xero`);
                } else { alert("Error: " + (data.error||"Unknown")); }
              }catch(e){ alert("Failed: "+e.message); }
            }}>🔄 Load Employees from Xero</Btn>
            {xeroEmployees.length>0&&(
              <span style={{fontSize:12,color:T.teal,fontWeight:600}}>
                ✓ {xeroEmployees.length} Xero employees loaded
              </span>
            )}
          </div>

          {/* ── Section 1: Import Xero employees as new KTA apprentices ── */}
          {(()=>{
            const existingXeroIds = apprentices.map(a=>a.xeroEmployeeId).filter(Boolean);
            const unlinked = xeroEmployees.filter(xe=>!existingXeroIds.includes(xe.EmployeeID));
            if(!xeroEmployees.length || !unlinked.length) return null;
            return (
              <div style={{marginBottom:24}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:6}}>⬇ Import from Xero</div>
                <div style={{fontSize:12,color:T.sub,marginBottom:12}}>
                  These Xero employees are not yet in KTA. Click <strong>Import</strong> to create them as Apprentices.
                </div>
                <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 100px",
                    padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                    fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:10}}>
                    <span>Xero Employee</span><span>Employee ID</span><span></span>
                  </div>
                  {unlinked.map((xe,i)=>(
                    <div key={xe.EmployeeID} style={{display:"grid",gridTemplateColumns:"1fr 1fr 100px",
                      padding:"10px 14px",gap:10,alignItems:"center",fontSize:13,
                      borderBottom:i<unlinked.length-1?`1px solid ${T.border}44`:"none",
                      background:i%2===0?T.surface:T.bg}}>
                      <div style={{fontWeight:600}}>{xe.FirstName} {xe.LastName}</div>
                      <div style={{fontSize:11,fontFamily:"monospace",color:T.muted}}>{xe.EmployeeID?.slice(0,18)}…</div>
                      <button onClick={async()=>{
                        const newId = uid();
                        const phone = (xe.PhoneNumber && !xe.PhoneNumber.includes('@')) ? xe.PhoneNumber : "";
                        const newUser = {
                          id: newId,
                          name: `${xe.FirstName} ${xe.LastName}`,
                          firstName: xe.FirstName,
                          lastName: xe.LastName,
                          email: xe.Email || "",
                          phone,
                          trade: xe.JobTitle || "",
                          address: xe.Address1 || "",
                          suburb: xe.Suburb || "",
                          city: xe.City || "",
                          postcode: xe.PostCode || "",
                          licenceExpiry: "",
                          xeroEmployeeId: xe.EmployeeID,
                          role: "Apprentice",
                          password: "changeme123",
                          allocatedTo: [],
                          adminLevel: 1,
                        };
                        try {
                          await upsertRow('users', {
                            id: newId,
                            name: newUser.name,
                            first_name: xe.FirstName,
                            last_name: xe.LastName,
                            email: newUser.email,
                            phone,
                            role: "Apprentice",
                            password: "changeme123",
                            allocated_to: [],
                            trade: xe.JobTitle || null,
                            address: xe.Address1 || null,
                            suburb: xe.Suburb || null,
                            city: xe.City || null,
                            postcode: xe.PostCode || null,
                            licence_expiry: null,
                            xero_employee_id: xe.EmployeeID,
                            admin_level: 1,
                          });
                          onImportUser(newUser);
                          setXeroEmployees(prev=>prev.filter(e=>e.EmployeeID!==xe.EmployeeID));
                          showToast(`✓ ${xe.FirstName} ${xe.LastName} imported as Apprentice`);
                        } catch(e) { alert("Import failed: "+e.message); }
                      }} style={{fontSize:12,padding:"4px 10px",borderRadius:6,fontWeight:600,
                        background:xeroBlue,color:"#fff",border:`1px solid ${xeroBlueDark}`,
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                        ⬇ Import
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* ── Section 2: Link existing KTA apprentices to Xero ── */}
          <div style={{fontWeight:700,fontSize:14,marginBottom:6}}>🔗 Link Existing Apprentices</div>
          <div style={{fontSize:12,color:T.sub,marginBottom:12}}>
            Match each KTA apprentice to their Xero payroll record.
          </div>
          <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 120px",
              padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
              fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:10}}>
              <span>KTA Apprentice</span><span>Xero Employee</span><span>Status</span>
            </div>
            {apprentices.map((a,i)=>(
              <div key={a.id} style={{display:"grid",gridTemplateColumns:"1fr 1fr 120px",
                padding:"10px 14px",gap:10,alignItems:"center",fontSize:13,
                borderBottom:i<apprentices.length-1?`1px solid ${T.border}44`:"none",
                background:i%2===0?T.surface:T.bg}}>
                <div>
                  <div style={{fontWeight:700}}>{a.name}</div>
                  <div style={{fontSize:11,color:T.sub}}>{a.trade||"No trade set"}</div>
                </div>
                {xeroEmployees.length > 0 ? (
                  <select
                    value={empMap[a.id]!==undefined ? empMap[a.id] : (a.xeroEmployeeId||"")}
                    onChange={e=>setEmpMap(m=>({...m,[a.id]:e.target.value}))}
                    style={{fontSize:12,padding:"5px 8px",border:`1px solid ${T.border}`,
                      borderRadius:6,width:"100%",boxSizing:"border-box",background:"#fff"}}>
                    <option value="">— Select Xero employee —</option>
                    {xeroEmployees.map(xe=>(
                      <option key={xe.EmployeeID} value={xe.EmployeeID}>
                        {xe.FirstName} {xe.LastName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={empMap[a.id]!==undefined ? empMap[a.id] : (a.xeroEmployeeId||"")}
                    onChange={e=>setEmpMap(m=>({...m,[a.id]:e.target.value}))}
                    placeholder="Click Load from Xero above, or paste ID manually"
                    style={{fontSize:12,padding:"5px 8px",border:`1px solid ${T.border}`,
                      borderRadius:6,fontFamily:"monospace",width:"100%",boxSizing:"border-box"}}
                  />
                )}
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  {savingMap[a.id]==="saved"
                    ? <span style={{fontSize:12,color:T.teal,fontWeight:600}}>✓ Saved</span>
                    : (
                      <button onClick={async()=>{
                        const newId = empMap[a.id];
                        if(newId===undefined) return;
                        setSavingMap(m=>({...m,[a.id]:"saving"}));
                        try {
                          await upsertRow('users',{...a,xero_employee_id:newId});
                          setSavingMap(m=>({...m,[a.id]:"saved"}));
                          setTimeout(()=>setSavingMap(m=>({...m,[a.id]:null})),2000);
                        } catch(e) { alert("Save failed: "+e.message); setSavingMap(m=>({...m,[a.id]:null})); }
                      }} disabled={empMap[a.id]===undefined||savingMap[a.id]==="saving"}
                        style={{fontSize:12,padding:"4px 10px",borderRadius:6,
                          background: empMap[a.id]!==undefined ? xeroBlue : T.bg,
                          color: empMap[a.id]!==undefined ? "#fff" : T.muted,
                          border:`1px solid ${empMap[a.id]!==undefined?xeroBlueDark:T.border}`,
                          cursor: empMap[a.id]!==undefined ? "pointer" : "default",
                          fontFamily:"DM Sans,sans-serif",fontWeight:600}}>
                        {savingMap[a.id]==="saving"?"…":"Save"}
                      </button>
                    )
                  }
                  {a.xeroEmployeeId && !empMap[a.id]
                    ? <span style={{fontSize:11,color:T.teal}}>✓ Linked</span>
                    : !a.xeroEmployeeId && empMap[a.id]===undefined
                    ? <span style={{fontSize:11,color:T.warn}}>⚠ Not set</span>
                    : null
                  }
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Pending Tab ── */}
      {tab==="pending"&&(
        <div>
          {pendingXero.length===0
            ? <Card><div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontStyle:"italic"}}>
                No approved entries awaiting Xero submission
              </div></Card>
            : (
              <>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                  <div style={{fontSize:13,color:T.sub}}>{pendingXero.length} approved {pendingXero.length===1?"entry":"entries"} ready to submit</div>
                </div>
                <Card style={{padding:0,overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 80px 90px",
                    padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                    fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
                    <span>Date</span><span>Apprentice</span><span style={{textAlign:"center"}}>Hours</span>
                    <span>Type</span><span>Status</span><span style={{textAlign:"right"}}>Action</span>
                  </div>
                  {pendingXero.map((e,i)=>{
                    const app = allUsers.find(u=>u.id===e.userId);
                    const tm = TYPE_META[e.type]||TYPE_META["Normal Hours"];
                    const hasXeroId = !!app?.xeroEmployeeId;
                    const hasRate   = !!(settings.earningsRates?.[e.type]);
                    const canSubmit = hasXeroId && hasRate && settings.edgeFunctionUrl && settings.tenantId;
                    return (
                      <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 80px 90px",
                        padding:"10px 14px",gap:8,alignItems:"center",fontSize:13,
                        borderBottom:i<pendingXero.length-1?`1px solid ${T.border}44`:"none",
                        background:i%2===0?T.surface:T.bg}}>
                        <div style={{fontWeight:600,fontSize:12}}>{fD(e.date)}</div>
                        <div>
                          <div style={{fontWeight:700,fontSize:13}}>{app?.name||"Unknown"}</div>
                          {!hasXeroId&&<div style={{fontSize:11,color:T.warn}}>⚠ No Xero ID</div>}
                          {!hasRate&&<div style={{fontSize:11,color:T.warn}}>⚠ Rate not mapped</div>}
                        </div>
                        <div style={{textAlign:"center",fontWeight:700,color:T.accent,fontFamily:"'Libre Baskerville'"}}>{e.netHours}h</div>
                        <Pill label={e.type} size="sm" color={tm.color} bg={tm.bg}/>
                        <div>
                          {e.xeroStatus==="submitting"
                            ? <span style={{fontSize:11,color:T.muted}}>Sending…</span>
                            : e.xeroStatus==="error"
                            ? <span style={{fontSize:11,color:T.red}} title={e.xeroError}>✕ Error</span>
                            : <span style={{fontSize:11,color:T.muted}}>Pending</span>
                          }
                        </div>
                        <div style={{display:"flex",justifyContent:"flex-end"}}>
                          <button disabled={!canSubmit||e.xeroStatus==="submitting"}
                            onClick={async()=>{
                              if(!canSubmit) return;
                              onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"submitting"}:x));
                              const res = await submitEntryToXero(e, app, entries);
                              if(res.ok){
                                onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"submitted",xeroTimesheetId:res.timesheetId}:x));
                              } else {
                                onUpdateEntries(prev=>prev.map(x=>x.id===e.id?{...x,xeroStatus:"error",xeroError:res.error}:x));
                              }
                            }}
                            style={{fontSize:12,fontWeight:700,padding:"4px 12px",borderRadius:7,
                              background: canSubmit?"#e6f7fd":T.bg,
                              color: canSubmit?xeroBlueDark:T.muted,
                              border:`1.5px solid ${canSubmit?xeroBlue:T.border}`,
                              cursor: canSubmit?"pointer":"not-allowed",
                              fontFamily:"DM Sans,sans-serif"}}>
                            𝕏 Submit
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </Card>
              </>
            )
          }
        </div>
      )}

      {/* ── History Tab ── */}
      {tab==="history"&&(
        <Card style={{padding:0,overflow:"hidden"}}>
          {submittedXero.length===0
            ? <div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontStyle:"italic"}}>No entries submitted to Xero yet</div>
            : <>
                <div style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 1fr",
                  padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,
                  fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".5px",gap:8}}>
                  <span>Date</span><span>Apprentice</span><span style={{textAlign:"center"}}>Hours</span>
                  <span>Type</span><span>Xero Timesheet ID</span>
                </div>
                {submittedXero.map((e,i)=>{
                  const app = allUsers.find(u=>u.id===e.userId);
                  const tm = TYPE_META[e.type]||TYPE_META["Normal Hours"];
                  return (
                    <div key={e.id} style={{display:"grid",gridTemplateColumns:"110px 1fr 80px 90px 1fr",
                      padding:"10px 14px",gap:8,alignItems:"center",fontSize:13,
                      borderBottom:i<submittedXero.length-1?`1px solid ${T.border}44`:"none",
                      background:i%2===0?T.surface:T.bg}}>
                      <div style={{fontWeight:600,fontSize:12}}>{fD(e.date)}</div>
                      <div style={{fontWeight:700}}>{app?.name||"Unknown"}</div>
                      <div style={{textAlign:"center",fontWeight:700,color:T.accent,fontFamily:"'Libre Baskerville'"}}>{e.netHours}h</div>
                      <Pill label={e.type} size="sm" color={tm.color} bg={tm.bg}/>
                      <div style={{fontSize:11,color:xeroBlue,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {e.xeroTimesheetId||"—"}
                      </div>
                    </div>
                  );
                })}
              </>
          }
        </Card>
      )}
    </div>
  );
}


// =============================================================================
// EMAIL ACTIVITY TRACKING — Microsoft 365 / Graph API via Supabase Edge Function
// =============================================================================
//
// Architecture:
//   Browser → Supabase Edge Function (holds M365 OAuth token) → Microsoft Graph API
//   Activity notes are stored in Supabase `activity_notes` table.
//   Timeline merges: emails (live from M365) + pinned emails + manual notes + meeting reports
//
// Edge Function env vars: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REFRESH_TOKEN, MS_TENANT_ID
// Deploy: supabase functions deploy email-proxy

const EMAIL_PROXY_KEY = "kta_email_proxy_url";
const getEmailProxyUrl = () => { try{ return localStorage.getItem(EMAIL_PROXY_KEY)||""; }catch{ return ""; } };

// Call the M365 edge function proxy
const callEmailProxy = async (payload) => {
  const url = getEmailProxyUrl();
  if(!url) return { ok:false, error:"Email proxy not configured. Set up in Settings." };
  try {
    const res = await fetch(url, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if(!res.ok) return { ok:false, error: data.error||`HTTP ${res.status}` };
    return { ok:true, ...data };
  } catch(e) { return { ok:false, error: e.message }; }
};

// Search emails for a specific email address (inbound + outbound)
const fetchEmailsForPerson = async (emailAddress, maxResults=30) => {
  if(!emailAddress) return { ok:false, emails:[], error:"No email address" };
  return callEmailProxy({ action:"searchByAddress", emailAddress, maxResults });
};

// Fetch all recent org emails for the global inbox view
const fetchOrgInbox = async (folder="inbox", maxResults=50) => {
  return callEmailProxy({ action:"listFolder", folder, maxResults });
};

// ── Stable sub-components (defined outside to preserve focus) ────────────────
const NoteTextarea = ({value, onChange, placeholder}) => (
  <textarea value={value} onChange={onChange} placeholder={placeholder}
    rows={3}
    style={{width:"100%",fontSize:13,padding:"10px 12px",border:`1.5px solid ${T.border}`,
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
function EmailActivityFeed({personEmail, personName, personId=null, extraItems=[], canEdit=true}) {
  const [emails, setEmails]             = useState([]);
  const [notes, setNotes]               = useState([]);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [loadingNotes, setLoadingNotes]   = useState(true);
  const [emailError, setEmailError]     = useState(null);
  const [expanded, setExpanded]         = useState({});
  const [noteText, setNoteText]         = useState("");
  const [addingNote, setAddingNote]     = useState(false);
  const [savingNote, setSavingNote]     = useState(false);
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
    setSavingNote(true);
    const note = {
      id: uid(), person_email: personEmail||null, person_id: personId||null,
      person_name: personName||null, type:"note", subject:"Note",
      body: noteText.trim(), direction:"note",
      created_at: new Date().toISOString(),
    };
    try {
      await upsertRow('activity_notes', note);
      setNotes(prev=>[note,...prev]);
      setNoteText(""); setAddingNote(false);
    } catch(e) { alert("Failed to save: "+e.message); }
    setSavingNote(false);
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
    if(!window.confirm("Remove this activity?")) return;
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

  const dirMeta = (dir) => ({
    inbound:  {label:"↓ Received", color:T.teal,  bg:T.tealL},
    outbound: {label:"↑ Sent",     color:T.accent, bg:T.accentL},
    note:     {label:"📝 Note",    color:T.gold,   bg:T.goldL},
    report:   {label:"📋 Report",  color:T.blue,   bg:T.blueL},
  })[dir||"note"]||{label:"◈ Activity", color:T.sub, bg:T.bg};

  const pinnedIds = new Set(notes.map(n=>n.email_id).filter(Boolean));

  return (
    <div>
      {/* Toolbar */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:"#f0f7ff",
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>✉</div>
          <div>
            <div style={{fontWeight:700,fontSize:14,color:T.ink}}>Activity & Email Timeline</div>
            <div style={{fontSize:11,color:T.sub}}>{personEmail||"No email set"}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {canEdit&&(
            <Btn sm onClick={()=>setAddingNote(s=>!s)} v={addingNote?"ghost":"primary"}>
              {addingNote?"✕ Cancel":"+ Log Activity"}
            </Btn>
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
          <div style={{fontWeight:600,fontSize:13,marginBottom:8,color:T.gold}}>
            📝 Log Activity Note
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
            <Btn sm v="ghost" onClick={()=>{setAddingNote(false);setNoteText("");}}>Cancel</Btn>
          </div>
        </div>
      )}

      {/* Not configured banner */}
      {!proxyOk&&(
        <div style={{background:T.warnL,border:`1px solid ${T.warn}44`,borderRadius:8,
          padding:"10px 14px",marginBottom:14,fontSize:12,color:T.warn,lineHeight:1.6}}>
          ⚠ <strong>Email tracking not configured.</strong> Set up the M365 Email Proxy URL in Admin → Settings to enable live email sync. Activity notes can still be logged manually.
        </div>
      )}
      {emailError&&(
        <div style={{background:T.redL,border:`1px solid ${T.red}44`,borderRadius:8,
          padding:"10px 14px",marginBottom:14,fontSize:12,color:T.red}}>
          ✕ Email sync error: {emailError}
        </div>
      )}

      {/* Live emails from M365 (unpinned) */}
      {proxyOk&&emails.length>0&&(
        <div style={{marginBottom:16}}>
          <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",
            letterSpacing:".6px",marginBottom:8}}>
            📬 Emails from Microsoft 365 — {emails.length} found
          </div>
          {emails.map(em=>{
            const isOpen = expanded[em.id];
            const isPinned = pinnedIds.has(em.id);
            const dm = dirMeta(em.direction);
            return (
              <div key={em.id} style={{border:`1.5px solid ${T.border}`,borderRadius:10,
                marginBottom:6,overflow:"hidden",opacity:isPinned?.7:1}}>
                <div onClick={()=>setExpanded(x=>({...x,[em.id]:!x[em.id]}))}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",
                    cursor:"pointer",background:isOpen?T.bg:T.surface,
                    borderBottom:isOpen?`1px solid ${T.border}`:"none"}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:dm.color,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:13,color:T.ink,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {em.subject||"(no subject)"}
                    </div>
                    <div style={{fontSize:11,color:T.sub,marginTop:1}}>
                      <span style={{color:dm.color,fontWeight:600}}>{dm.label}</span>
                      {" · "}{em.from||em.to||""}
                      {" · "}{fmtTs(em.date)}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                    {canEdit&&!isPinned&&(
                      <button onClick={e=>{e.stopPropagation();pinEmail(em);}}
                        disabled={pinning[em.id]}
                        title="Pin to activity log"
                        style={{fontSize:11,fontWeight:600,padding:"3px 9px",borderRadius:6,
                          background:T.accentL,color:T.accent,border:`1px solid ${T.accent}44`,
                          cursor:"pointer",fontFamily:"DM Sans,sans-serif"}}>
                        {pinning[em.id]?"…":"📌 Pin"}
                      </button>
                    )}
                    {isPinned&&<span style={{fontSize:11,color:T.teal,fontWeight:600}}>✓ Pinned</span>}
                    <span style={{fontSize:11,color:T.muted}}>{isOpen?"▲":"▼"}</span>
                  </div>
                </div>
                {isOpen&&(
                  <div style={{padding:"12px 14px",background:"#fff",fontSize:13,
                    color:T.ink,lineHeight:1.7,whiteSpace:"pre-wrap",borderTop:`1px solid ${T.border}`}}>
                    <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                      {em.from&&<span style={{fontSize:11,color:T.sub}}><strong>From:</strong> {em.from}</span>}
                      {em.to&&<span style={{fontSize:11,color:T.sub}}><strong>To:</strong> {em.to}</span>}
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
        ? <div style={{textAlign:"center",padding:"24px 0",color:T.muted,fontSize:13}}>Loading activity…</div>
        : timeline.length===0
        ? <div style={{textAlign:"center",padding:"24px 0",color:T.muted,fontSize:13,fontStyle:"italic"}}>
            No activity logged yet. Use "+ Log Activity" to add a note.
          </div>
        : (
          <div>
            <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",
              letterSpacing:".6px",marginBottom:8}}>Activity Log</div>
            {timeline.map((item,i)=>{
              if(item._src==="extra") {
                // Meeting report or other injected item
                return (
                  <div key={item.id||i} style={{display:"flex",gap:12,marginBottom:10}}>
                    <div style={{width:2,background:T.blueL,borderRadius:2,flexShrink:0,marginTop:4,marginBottom:4}}/>
                    <div style={{flex:1,background:T.blueL,border:`1px solid ${T.blue}33`,
                      borderRadius:8,padding:"10px 13px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <span style={{fontSize:13}}>📋</span>
                        <span style={{fontWeight:600,fontSize:13,color:T.blue}}>{item.label||"Meeting Report"}</span>
                        <span style={{fontSize:11,color:T.sub,marginLeft:"auto"}}>{fmtTs(item.created_at||item.date)}</span>
                      </div>
                      {item.detail&&<div style={{fontSize:12,color:T.ink,lineHeight:1.6}}>{item.detail}</div>}
                    </div>
                  </div>
                );
              }
              const dm = dirMeta(item.direction);
              return (
                <div key={item.id} style={{display:"flex",gap:12,marginBottom:10}}>
                  <div style={{width:2,background:dm.bg,borderRadius:2,flexShrink:0,marginTop:4,marginBottom:4}}/>
                  <div style={{flex:1,background:dm.bg,border:`1px solid ${dm.color}33`,
                    borderRadius:8,padding:"10px 13px"}}>
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3,flexWrap:"wrap"}}>
                          <span style={{fontSize:11,fontWeight:700,color:dm.color,
                            background:"#ffffff55",borderRadius:4,padding:"1px 6px",
                            border:`1px solid ${dm.color}33`}}>{dm.label}</span>
                          <span style={{fontWeight:600,fontSize:13,color:T.ink,
                            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {item.subject||"Note"}
                          </span>
                        </div>
                        {item.from_address&&<div style={{fontSize:11,color:T.sub,marginBottom:3}}>
                          {item.direction==="inbound"?"From":"To"}: {item.from_address||item.to_address}
                        </div>}
                        <div style={{fontSize:13,color:T.ink,lineHeight:1.65,
                          whiteSpace:"pre-wrap",marginTop:4}}>{item.body}</div>
                        <div style={{fontSize:11,color:T.muted,marginTop:6}}>{fmtTs(item.email_date||item.created_at)}</div>
                      </div>
                      {canEdit&&(
                        <button onClick={()=>deleteNote(item.id)}
                          title="Remove activity"
                          style={{flexShrink:0,background:"none",border:"none",
                            color:T.muted,fontSize:14,cursor:"pointer",padding:"0 4px",lineHeight:1}}
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
      padding:"8px 18px",borderRadius:8,fontSize:13,fontWeight:700,
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
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>✉</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:18,fontWeight:700,color:T.ink}}>
            Email Tracking
          </div>
          <div style={{fontSize:13,color:T.sub,marginTop:2}}>
            Microsoft 365 inbox & sent mail · All contacts matched to KTA records
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <div style={{textAlign:"center",padding:"8px 14px",background:T.accentL,borderRadius:8}}>
            <div style={{fontSize:18,fontWeight:700,color:T.accent,fontFamily:"'Libre Baskerville'"}}>{emails.length}</div>
            <div style={{fontSize:10,color:T.sub,fontWeight:600,textTransform:"uppercase"}}>Emails</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        <TabBtn id="inbox"  label="Inbox"    icon="↓"/>
        <TabBtn id="sent"   label="Sent"     icon="↑"/>
        <TabBtn id="setup"  label="⚙ Setup"  icon=""/>
      </div>

      {/* Setup tab */}
      {tab==="setup"&&(
        <div>
          <Card style={{marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:14}}>Microsoft 365 Connection</div>

            <div style={{background:T.accentL,border:`1px solid ${T.accent}33`,borderRadius:8,
              padding:"12px 16px",marginBottom:16,fontSize:13,color:T.ink,lineHeight:1.7}}>
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
              <div style={{fontSize:11,color:T.muted,marginTop:3}}>
                The deployed email-proxy Edge Function URL
              </div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <Btn onClick={saveProxyUrl}>Save URL</Btn>
              {savedUrl&&<span style={{fontSize:12,color:T.teal,fontWeight:600}}>✓ Saved</span>}
              {proxyConfigured&&<Btn v="ghost" sm onClick={()=>loadEmails("inbox")}>Test Connection</Btn>}
            </div>
          </Card>

          <Card>
            <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>📦 Supabase Edge Function</div>
            <div style={{fontSize:13,color:T.sub,marginBottom:14,lineHeight:1.6}}>
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

      {/* Inbox / Sent tabs */}
      {(tab==="inbox"||tab==="sent")&&(
        <div>
          {!proxyConfigured?(
            <Card>
              <div style={{textAlign:"center",padding:"32px 0",color:T.muted}}>
                <div style={{fontSize:32,marginBottom:12}}>✉</div>
                <div style={{fontWeight:700,fontSize:15,marginBottom:6}}>Email proxy not configured</div>
                <div style={{fontSize:13}}>Go to the Setup tab to connect Microsoft 365.</div>
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

              {loading&&<div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontSize:13}}>Loading emails…</div>}
              {error&&<div style={{background:T.redL,border:`1px solid ${T.red}44`,borderRadius:8,padding:"10px 14px",fontSize:12,color:T.red,marginBottom:12}}>✕ {error}</div>}

              {!loading&&!error&&(
                <Card style={{padding:0,overflow:"hidden"}}>
                  {filtered.length===0
                    ? <div style={{textAlign:"center",padding:"32px 0",color:T.muted,fontStyle:"italic",fontSize:13}}>No emails found</div>
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
                                  <span style={{fontWeight:em.isRead===false?700:500,fontSize:13,color:T.ink,
                                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:300}}>
                                    {em.subject||"(no subject)"}
                                  </span>
                                  {matched&&(
                                    <RolePill role={matched.role} size="sm"/>
                                  )}
                                  <span style={{fontSize:11,padding:"1px 7px",borderRadius:4,fontWeight:600,
                                    background:em.direction==="outbound"?T.accentL:T.tealL,
                                    color:em.direction==="outbound"?T.accent:T.teal}}>
                                    {em.direction==="outbound"?"↑ Sent":"↓ Received"}
                                  </span>
                                </div>
                                <div style={{fontSize:11,color:T.sub,marginTop:2,
                                  overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                                  {em.direction==="outbound"?`To: ${em.to}`:`From: ${em.from}`}
                                </div>
                              </div>
                              <div style={{fontSize:11,color:T.muted,flexShrink:0,textAlign:"right"}}>
                                <div>{fmtTs(em.date)}</div>
                                {matched&&<div style={{fontSize:10,color:T.accent,marginTop:2}}>{matched.name}</div>}
                              </div>
                            </div>
                            {isOpen&&(
                              <div style={{padding:"14px 16px",background:"#fff",
                                borderTop:`1px solid ${T.border}`}}>
                                <div style={{display:"flex",gap:16,marginBottom:10,flexWrap:"wrap",fontSize:12,color:T.sub}}>
                                  <span><strong>From:</strong> {em.from}</span>
                                  <span><strong>To:</strong> {em.to}</span>
                                  <span><strong>Date:</strong> {new Date(em.date).toLocaleString("en-NZ")}</span>
                                </div>
                                <div style={{fontSize:13,color:T.ink,lineHeight:1.7,
                                  whiteSpace:"pre-wrap",padding:"10px 12px",
                                  background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>
                                  {em.bodyPreview||"(no preview)"}
                                </div>
                                {matched&&(
                                  <div style={{marginTop:10,fontSize:12,color:T.sub,fontStyle:"italic"}}>
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

export default function App() {
  const [users,setUsers]         = useState([]);
  const [entries,setEntries]     = useState([]);
  const [sessionId,setSessionId] = useState(()=>{ try{return localStorage.getItem("wos_session_sb")||null;}catch{return null;} });
  const [module,setModule]       = useState("dashboard");
  const [viewingAppId,setViewingAppId] = useState(null);
  const [showAppList,setShowAppList] = useState(false);
  const [loggingOut,setLoggingOut] = useState(false);
  const [loading,setLoading]     = useState(true);
  const [dbError,setDbError]     = useState(null);
  const [notifications,setNotifications] = useState([]);
  const [showNotifs,setShowNotifs] = useState(false);
  const [showBroadcast,setShowBroadcast] = useState(false);
  const [appToast,setAppToast]   = useState(null);

  const showToast = (msg, ok=true) => {
    setAppToast({msg,ok});
    setTimeout(()=>setAppToast(null), 4000);
  };

  // ── Initial load from Supabase ──────────────────────────────────────────
  useEffect(()=>{
    (async()=>{
      try {
        const [u, e] = await Promise.all([loadUsers(), loadEntries()]);
        setUsers(u);
        setEntries(e);
      } catch(err) {
        console.error("Supabase load error:", err);
        setDbError(err.message);
      } finally {
        setLoading(false);
      }
    })();

    // Realtime: re-fetch users whenever the users table changes
    const channel = sb.channel('users-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, async () => {
        const u = await loadUsers();
        setUsers(u);
      })
      .subscribe();

    return () => { sb.removeChannel(channel); };
  },[]);

  // ── Load notifications when session changes ──────────────────────────────
  useEffect(()=>{
    if(!sessionId) return;
    loadNotifications(sessionId).then(setNotifications).catch(console.error);
    // Poll every 30s for new notifications
    const interval = setInterval(()=>{
      loadNotifications(sessionId).then(rows=>{
        setNotifications(prev=>{
          // Browser push for any new unread ones
          const prevIds = new Set(prev.map(n=>n.id));
          rows.filter(n=>!n.read&&!prevIds.has(n.id)).forEach(n=>{
            sendBrowserPush(n.title, n.body||"", n.type||"info");
          });
          return rows;
        });
      }).catch(console.error);
    }, 30000);
    return ()=>clearInterval(interval);
  },[sessionId]);

  // ── Request push permission on login ────────────────────────────────────
  useEffect(()=>{ if(sessionId) requestPushPermission(); },[sessionId]);

  // ── Block spacebar page-scroll when typing in any input/textarea ────────────
  useEffect(()=>{
    const onKeyDown = (e) => {
      if(e.key !== " ") return;
      const tag = document.activeElement?.tagName;
      if(tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") {
        // Stop the event reaching the window scroll handler
        // but do NOT preventDefault — that would eat the space character
        e.stopPropagation();
      }
    };
    // Use capture:false so React's own synthetic events fire first, undisturbed
    document.addEventListener("keydown", onKeyDown, false);
    return () => document.removeEventListener("keydown", onKeyDown, false);
  }, []);

  // ── Licence expiry check — runs for Admin + Mentor on load & daily ────────
  useEffect(()=>{
    if(!sessionId||!users.length) return;
    const currentU = users.find(u=>u.id===sessionId);
    if(!["Admin","Mentor"].includes(currentU?.role)) return;

    const checkLicences = async () => {
      const today = new Date(); today.setHours(0,0,0,0);
      const apprentices = users.filter(u=>u.role==="Apprentice"&&u.licenceExpiry);
      for(const app of apprentices) {
        const expiry = new Date(app.licenceExpiry+"T00:00:00");
        const daysUntil = Math.round((expiry-today)/86400000);
        for(const threshold of [30,7]) {
          if(daysUntil>threshold || daysUntil<0) continue;
          // Recipients: mentors allocated to this apprentice + the apprentice
          const mentors = users.filter(u=>u.role==="Mentor"&&(u.allocatedTo||[]).includes(app.id));
          const recipients = [...new Set([...mentors.map(m=>m.id), app.id])];
          for(const recipId of recipients) {
            const already = await licenceReminderExists(recipId, app.id, threshold);
            if(already) continue;
            const isSelf = recipId===app.id;
            const title = `⚠ Licence Expiry — ${app.name}`;
            const message = isSelf
              ? `Your ${app.trade||"trade"} licence expires in ${daysUntil} day${daysUntil!==1?"s":""} (${app.licenceExpiry}). Please renew it soon.`
              : `${app.name}'s ${app.trade||"trade"} licence expires in ${daysUntil} day${daysUntil!==1?"s":""} (${app.licenceExpiry}).`;
            const notif = { id:uid(), user_id:recipId, type:"licence_expiry", title, message, read:false, created_by:null, meta:{ apprenticeId:app.id, daysUntil:threshold, expiry:app.licenceExpiry } };
            await insertNotification(notif).catch(console.error);
            if(recipId===sessionId) {
              setNotifications(prev=>[notif,...prev]);
              sendBrowserPush(title, message, "licence");
            }
          }
        }
      }
    };
    checkLicences();
    const daily = setInterval(checkLicences, 24*60*60*1000);
    return ()=>clearInterval(daily);
  },[sessionId, users.length]);

  // ── Persist session to localStorage (just the id, not data) ────────────
  useEffect(()=>{ try{localStorage.setItem("wos_session_sb",sessionId||"");}catch{} },[sessionId]);

  // ── Supabase-aware state updaters ────────────────────────────────────────
  const stableJson = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
  const updateUsers = useCallback((updater) => {
    setUsers(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      const nextIds = new Set(next.map(u=>u.id));
      const prevMap = Object.fromEntries(prev.map(u=>[u.id,u]));
      // Sync to Supabase outside the render cycle
      setTimeout(() => {
        next.forEach(u => {
          const old = prevMap[u.id];
          // Always upsert if new user, or if any field changed (stable key-sorted comparison)
          if(!old || stableJson(old) !== stableJson(u)) {
            upsertUser(u).catch(e=>console.error('upsertUser',e));
          }
        });
        prev.forEach(u => {
          if(!nextIds.has(u.id)) sbDeleteUser(u.id).catch(e=>console.error('deleteUser',e));
        });
      }, 0);
      return next;
    });
  }, []);

  const updateEntries = useCallback((updater) => {
    setEntries(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      const prevMap = Object.fromEntries(prev.map(e=>[e.id,e]));
      const nextIds = new Set(next.map(e=>e.id));
      const stableJ = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
      // Sync to Supabase outside the render cycle
      setTimeout(() => {
        next.forEach(e => {
          const old = prevMap[e.id];
          if(!old || stableJ(old) !== stableJ(e)) {
            upsertEntry(e).catch(err=>console.error('upsertEntry',err));
          }
        });
        prev.forEach(e => {
          if(!nextIds.has(e.id)) deleteEntry(e.id).catch(err=>console.error('deleteEntry',err));
        });
      }, 0);
      return next;
    });
  }, []);

  // ── Send in-app notification + browser push ─────────────────────────────
  const pushNotif = useCallback(async (userIds, type, title, message, createdBy=null, meta={}) => {
    for(const uid_ of [...new Set(userIds)]) {
      const notif = { id:uid(), user_id:uid_, type, title, message, read:false, created_by:createdBy, meta };
      await insertNotification(notif).catch(console.error);
      if(uid_===sessionId) {
        setNotifications(prev=>[notif,...prev]);
        sendBrowserPush(title, message, type);
      }
    }
  }, [sessionId]);

  const currentUser = users.find(u=>u.id===sessionId);
  const role = currentUser?.role;
  // Admin level helpers — Admin 1 = full superadmin, Admin 2 = limited (no message delete/edit)
  const isAdmin1 = role==="Admin" && (currentUser?.adminLevel||1) === 1;
  const isAdmin2 = role==="Admin" && (currentUser?.adminLevel||1) === 2;

  const handleLogin  = (userId) => {
    const u = users.find(x=>x.id===userId);
    // Admin lands on dashboard, others on timesheet
    setModule(u?.role==="Admin"?"dashboard":u?.role==="Mentor"?"mentor":"timesheet");
    setSessionId(userId);
    setViewingAppId(null);
  };
  const handleLogout = () => {
    setLoggingOut(true);
    setTimeout(()=>{ setSessionId(null); setLoggingOut(false); setViewingAppId(null); setShowAppList(false); try{localStorage.removeItem('wos_session_sb');}catch{} },400);
  };

  if(loading) return (
    <>
      <style>{CSS}</style>
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",
        background:`linear-gradient(135deg,${T.dark},${T.dark2},#2060a0)`}}>
        <div style={{textAlign:"center",color:"#fff"}}>
          <img src={KTA_LOGO} alt="KTA" style={{height:60,objectFit:"contain",filter:"brightness(0) invert(1)",marginBottom:20}} onError={e=>{e.target.style.display="none";}}/>
          <div style={{fontFamily:"'Libre Baskerville'",fontSize:20,fontWeight:700,marginBottom:8}}>Kiwi Trade Apprentices</div>
          <div style={{fontSize:13,color:"#ffffff66"}}>Connecting to database…</div>
          {dbError&&<div style={{fontSize:12,color:"#ff8888",marginTop:12,maxWidth:300}}>⚠ {dbError}</div>}
        </div>
      </div>
    </>
  );

  if(!currentUser) return (
    <>
      <style>{CSS}</style>
      <LoginScreen users={users} onLogin={handleLogin}/>
    </>
  );

  // ── Apprentice notification gate — must read all notifications before proceeding ──
  const unreadNotifs = notifications.filter(n=>!n.read);
  if(role==="Apprentice" && unreadNotifs.length > 0 && !showNotifs) {
    return (
      <>
        <style>{CSS}</style>
        <div style={{minHeight:"100vh",background:T.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{maxWidth:480,width:"100%"}}>
            <div style={{textAlign:"center",marginBottom:28}}>
              <img src={KTA_LOGO} alt="KTA" style={{height:50,objectFit:"contain",marginBottom:16}}
                onError={e=>e.target.style.display="none"}/>
              <div style={{width:64,height:64,borderRadius:"50%",background:T.warnL,border:`3px solid ${T.warn}`,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 16px"}}>
                🔔
              </div>
              <h2 style={{fontFamily:"'Libre Baskerville'",fontSize:22,fontWeight:700,color:T.ink,marginBottom:8}}>
                You have unread notifications
              </h2>
              <p style={{fontSize:13,color:T.sub,lineHeight:1.6}}>
                Please read and acknowledge your notifications before continuing.<br/>
                You have <strong style={{color:T.warn}}>{unreadNotifs.length}</strong> unread message{unreadNotifs.length!==1?"s":""}.
              </p>
            </div>

            <Card style={{marginBottom:16}}>
              {unreadNotifs.map((n,i)=>{
                const typeIcons={approval:"✓",decline:"✕",licence:"⚠",broadcast:"📢",reply:"↩",info:"◈"};
                const typeColors={approval:T.teal,decline:T.red,licence:T.warn,broadcast:T.accent,reply:T.blue,info:T.sub};
                return (
                  <div key={n.id} style={{
                    padding:"14px 16px",
                    borderBottom:i<unreadNotifs.length-1?`1px solid ${T.border}`:"none",
                    background:T.warnL+"44",borderRadius:i===0?`10px 10px 0 0`:i===unreadNotifs.length-1?"0 0 10px 10px":"0"
                  }}>
                    <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                      <span style={{fontSize:16,color:typeColors[n.type]||T.sub,flexShrink:0,marginTop:1}}>{typeIcons[n.type]||"◈"}</span>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,fontSize:13,marginBottom:2}}>{n.title}</div>
                        <div style={{fontSize:12,color:T.sub,lineHeight:1.5}}>{n.message}</div>
                      </div>
                      <button onClick={()=>{
                        markNotifRead(n.id).catch(console.error);
                        setNotifications(prev=>prev.map(x=>x.id===n.id?{...x,read:true}:x));
                      }} style={{
                        background:T.accentL,border:`1px solid ${T.accent}44`,color:T.accent,
                        borderRadius:6,padding:"4px 12px",fontSize:12,fontWeight:600,
                        cursor:"pointer",fontFamily:"DM Sans,sans-serif",flexShrink:0
                      }}>✓ Read</button>
                    </div>
                  </div>
                );
              })}
            </Card>

            <Btn full onClick={()=>{
              markAllNotifsRead(sessionId).catch(console.error);
              setNotifications(prev=>prev.map(n=>({...n,read:true})));
            }}>✓ Mark All as Read &amp; Continue</Btn>

            <div style={{textAlign:"center",marginTop:12}}>
              <button onClick={handleLogout} style={{
                background:"none",border:"none",color:T.muted,fontSize:12,
                cursor:"pointer",fontFamily:"DM Sans,sans-serif"
              }}>Sign out</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Nav items per role
  const navItems=[
    {id:"dashboard", label:"⊞ Dashboard",  roles:["Admin"]},
    {id:"mentor",    label:"👷 Apprentices", roles:["Mentor"]},
    {id:"timesheet", label:"⏱ Timesheet",  roles:["Apprentice","Approver","Viewer"]},
    {id:"crm",       label:"◈ CRM",         roles:["Mentor","Admin"]},
    {id:"users",     label:"★ Users",       roles:["Admin"]},
    // {id:"emails",    label:"✉ Emails",      roles:["Admin","Mentor"]}, // DISABLED — uncomment to re-enable
  ].filter(n=>n.roles.includes(role));

  const validMods=navItems.map(n=>n.id);
  const activeMod=validMods.includes(module)?module:validMods[0];

  // When admin drills into an apprentice — use the full ApprenticeDetailView
  const viewingApp = viewingAppId ? users.find(u=>u.id===viewingAppId) : null;
  const adminViewingApprentice = role==="Admin" && activeMod==="dashboard" && viewingApp && !showAppList;
  const adminViewingTimesheet  = adminViewingApprentice; // alias for breadcrumb logic
  const adminAppList = role==="Admin" && activeMod==="dashboard" && !!showAppList && !viewingAppId;

  return (
    <>
      <style>{CSS}</style>
      <div style={{minHeight:"100vh",background:T.bg,opacity:loggingOut?0:1,transition:"opacity .35s"}}>

        {/* HEADER */}
        <header style={{background:T.dark,height:66,padding:"0 20px",
          display:"flex",alignItems:"center",justifyContent:"space-between",
          position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 16px #00000033"}}>
          <div style={{display:"flex",alignItems:"center",gap:16}}>
            <img src={KTA_LOGO} alt="KTA"
              style={{height:44,objectFit:"contain",filter:"brightness(0) invert(1)",flexShrink:0}}
              onError={e=>{e.target.style.display="none";}}
            />
            <div style={{width:1,height:28,background:"#ffffff25",flexShrink:0}} className="desktop-nav"/>
            <nav className="desktop-nav" style={{gap:6}}>
              {navItems.map(n=>{
                const isActive = activeMod===n.id;
                const navIcons={dashboard:"⊞",mentor:"👷",timesheet:"⏱",crm:"◈",users:"★",emails:"✉"};
                const navLabels={dashboard:"Dashboard",mentor:"Apprentices",timesheet:"Timesheet",crm:"CRM",users:"Users",emails:"Emails"};
                return (
                  <button key={n.id}
                    onClick={()=>{setModule(n.id);setViewingAppId(null);setShowAppList(false);}}
                    style={{
                      padding:"8px 18px",borderRadius:9,fontSize:13,fontWeight:700,
                      letterSpacing:"-.1px",
                      background: isActive ? "#ffffff" : "#ffffff15",
                      color: isActive ? T.dark : "#ffffffcc",
                      border: isActive ? `1.5px solid #ffffff44` : "1.5px solid #ffffff18",
                      fontFamily:"DM Sans,sans-serif",cursor:"pointer",
                      transition:"all .14s",
                      boxShadow: isActive ? "0 2px 8px #00000022" : "none",
                      display:"flex",alignItems:"center",gap:6,
                    }}
                    onMouseEnter={e=>{ if(!isActive){ e.currentTarget.style.background="#ffffff25"; e.currentTarget.style.color="#fff"; } }}
                    onMouseLeave={e=>{ if(!isActive){ e.currentTarget.style.background="#ffffff15"; e.currentTarget.style.color="#ffffffcc"; } }}>
                    <span style={{fontSize:14}}>{navIcons[n.id]||"◈"}</span>
                    <span>{navLabels[n.id]||n.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <NotificationBell
              notifs={notifications}
              show={showNotifs}
              setShow={(v)=>{setShowNotifs(v);if(v)setShowBroadcast(false);}}
              onRead={id=>{ markNotifRead(id).catch(console.error); setNotifications(prev=>prev.map(n=>n.id===id?{...n,read:true}:n)); }}
              onReadAll={()=>{ markAllNotifsRead(sessionId).catch(console.error); setNotifications(prev=>prev.map(n=>({...n,read:true}))); }}
              canDelete={isAdmin1||role!=="Admin"}
              onDelete={id=>{ deleteNotif(id).catch(console.error); setNotifications(prev=>prev.filter(n=>n.id!==id)); }}
              onReply={async(origNotif, text)=>{
                const senderId = origNotif.created_by;
                if(!senderId) return;
                const sender = users.find(u=>u.id===senderId);
                if(!sender) return;
                const participants = [currentUser.id, senderId];
                const apprenticeId = participants.find(id=>{
                  const u = users.find(x=>x.id===id);
                  return u?.role==="Apprentice";
                }) || currentUser.id;
                await insertMessage({
                  id: uid(), apprentice_id: apprenticeId, sender_id: currentUser.id,
                  body: text, created_at: new Date().toISOString(),
                }).catch(console.error);
                await pushNotif([senderId],"reply",`↩ Reply from ${currentUser.name}`,text,currentUser.id,{replyToId:origNotif.id});
              }}
            />
            {["Admin","Mentor"].includes(role)&&(
              <button onClick={()=>{setShowBroadcast(s=>!s);setShowNotifs(false);}}
                title="Broadcast message"
                style={{background:"#ffffff18",border:"1.5px solid #ffffff28",color:"#fff",
                  borderRadius:9,padding:"7px 10px",fontSize:16,cursor:"pointer",
                  display:"flex",alignItems:"center",justifyContent:"center",transition:"all .14s"}}
                onMouseEnter={e=>{e.currentTarget.style.background="#ffffff30";}}
                onMouseLeave={e=>{e.currentTarget.style.background="#ffffff18";}}>📢</button>
            )}
            {isAdmin1&&(
              <button onClick={()=>setModule("xero")}
                title="Xero Integration"
                style={{background: module==="xero"?"#13b5ea22":"#ffffff18",
                  border: module==="xero"?"1.5px solid #13b5ea88":"1.5px solid #ffffff28",
                  color: module==="xero"?"#13b5ea":"#ffffffcc",
                  borderRadius:9,padding:"7px 12px",fontSize:12,fontWeight:700,
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif",
                  display:"flex",alignItems:"center",gap:5,transition:"all .14s"}}
                onMouseEnter={e=>{e.currentTarget.style.background="#13b5ea22";e.currentTarget.style.color="#13b5ea";}}
                onMouseLeave={e=>{if(module!=="xero"){e.currentTarget.style.background="#ffffff18";e.currentTarget.style.color="#ffffffcc";}}}>
                <span style={{fontSize:14}}>𝕏</span> Xero
              </button>
            )}
            <div className="desktop-user-name" style={{textAlign:"right",marginLeft:4}}>
              <div style={{fontSize:13,fontWeight:700,color:"#fff",letterSpacing:"-.1px"}}>{currentUser.name}</div>
              <div style={{marginTop:2}}><RolePill role={role} adminLevel={role==="Admin"?(currentUser?.adminLevel||1):null} size="sm"/></div>
            </div>
            <Avatar name={currentUser.name} role={role} size={34}/>
            <button className="desktop-signout" onClick={handleLogout}
              style={{background:"#ffffff15",border:"1.5px solid #ffffff28",borderRadius:9,
                padding:"8px 14px",fontSize:12,color:"#ffffffbb",fontWeight:700,
                fontFamily:"DM Sans,sans-serif",cursor:"pointer",letterSpacing:"-.1px",transition:"all .14s"}}
              onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
              onMouseLeave={e=>{e.currentTarget.style.background="#ffffff15";e.currentTarget.style.color="#ffffffbb";e.currentTarget.style.borderColor="#ffffff28";}}>
              ⏏ Sign out
            </button>
          </div>
        </header>

        {/* BOTTOM NAV — mobile only */}
        <nav className="bottom-nav">
          {navItems.map(n=>{
            const icons={dashboard:"⊞",timesheet:"⏱",crm:"◈",users:"★"};
            const labels={dashboard:"Dashboard",timesheet:"Timesheet",crm:"CRM",users:"Users"};
            return (
              <button key={n.id}
                className={`bottom-nav-btn${activeMod===n.id?" active":""}`}
                onClick={()=>{setModule(n.id);setViewingAppId(null);setShowAppList(false);}}>
                <span className="bottom-nav-icon">{icons[n.id]||"◈"}</span>
                <span className="bottom-nav-label">{labels[n.id]||n.id}</span>
              </button>
            );
          })}
          {/* Sign out as last tab on mobile */}
          <button className="bottom-nav-btn" onClick={handleLogout}>
            <span className="bottom-nav-icon">⏏</span>
            <span className="bottom-nav-label">Sign out</span>
          </button>
        </nav>

        {/* BROADCAST MODAL */}
        {showBroadcast&&["Admin","Mentor"].includes(role)&&(
          <BroadcastComposer
            users={users}
            currentUser={currentUser}
            onSend={pushNotif}
            onClose={()=>setShowBroadcast(false)}
          />
        )}

        {/* MAIN */}
        <main className="main-content">

          {/* Breadcrumb / page title */}
          <div style={{marginBottom:22}}>
            {adminViewingTimesheet ? (
              <div>
                <button onClick={()=>setViewingAppId(null)} style={{
                  display:"inline-flex",alignItems:"center",gap:6,
                  background:"none",border:"none",color:T.sub,fontSize:13,
                  fontFamily:"DM Sans,sans-serif",cursor:"pointer",marginBottom:10,padding:0,
                  fontWeight:500
                }}
                  onMouseEnter={e=>e.currentTarget.style.color=T.ink}
                  onMouseLeave={e=>e.currentTarget.style.color=T.sub}>
                  ← Back to Dashboard
                </button>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <Avatar name={viewingApp.name} role="Apprentice" size={40}/>
                  <div>
                    <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:24,fontWeight:700,letterSpacing:"-.4px"}}>
                      {viewingApp.name}
                    </h1>
                    <p style={{fontSize:13,color:T.sub,marginTop:2}}>Apprentice Timesheet — Admin view</p>
                  </div>
                </div>
              </div>
            ) : adminAppList ? (
              <div>
                <button onClick={()=>setShowAppList(false)} style={{
                  display:"inline-flex",alignItems:"center",gap:6,
                  background:"none",border:"none",color:T.sub,fontSize:13,
                  fontFamily:"DM Sans,sans-serif",cursor:"pointer",marginBottom:10,padding:0,
                  fontWeight:500
                }}
                  onMouseEnter={e=>e.currentTarget.style.color=T.ink}
                  onMouseLeave={e=>e.currentTarget.style.color=T.sub}>
                  ← Back to Dashboard
                </button>
                <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:26,fontWeight:700,letterSpacing:"-.4px"}}>
                  {showAppList==="apprentices"?"Apprentices"
                  :showAppList==="hours"?"Hours This Week"
                  :showAppList==="submitted"?"Pending"
                  :showAppList==="approved"?"Submitted — Approved"
                  :showAppList==="declined"?"Submitted — Not Approved"
                  :showAppList==="contacts"?"Contacts"
                  :showAppList==="hosts"?"Host Businesses"
                  :"Target Deals"}
                </h1>
                <p style={{fontSize:13,color:T.sub,marginTop:4}}>
                  {showAppList==="apprentices"&&"Manage apprentice accounts — click a row to view their timesheet"}
                  {showAppList==="hours"&&"All entries this week, grouped by apprentice A–Z"}
                  {showAppList==="submitted"&&"Submitted timesheets awaiting approval, grouped by apprentice A–Z"}
                  {showAppList==="approved"&&"Approved entries, grouped by apprentice A–Z"}
                  {showAppList==="declined"&&"Declined entries, grouped by apprentice A–Z"}
                  {showAppList==="contacts"&&"Business and other contacts — not system users"}
                  {showAppList==="hosts"&&"Companies that host apprentices for on-the-job training"}
                  {showAppList==="deals"&&"Target deals, opportunities and pipeline"}
                </p>
              </div>
            ) : (
              <div>
                <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:26,fontWeight:700,letterSpacing:"-.4px"}}>
                  {activeMod==="dashboard"?"Dashboard":activeMod==="timesheet"?"Timesheet":activeMod==="crm"?"CRM":activeMod==="mentor"?"My Apprentices":"User Management"}
                </h1>
                <p style={{fontSize:13,color:T.sub,marginTop:4}}>
                  {activeMod==="dashboard"&&"Overview of all apprentice timesheets"}
                  {activeMod==="timesheet"&&"Time entries — access enforced by role"}
                  {activeMod==="mentor"&&"Your apprentices, meeting reports and PPE records"}
                  {activeMod==="users"&&"Manage all users, roles and allocations"}
                </p>
              </div>
            )}
          </div>

          {/* Module routing */}
          {adminViewingApprentice && (
            <ApprenticeDetailView
              apprentice={viewingApp}
              viewer={currentUser}
              allUsers={users}
              entries={entries}
              isAdmin={true}
              onBack={()=>setViewingAppId(null)}
            />
          )}
          {adminAppList && showAppList==="apprentices" && (
            <ApprenticeList
              allUsers={users}
              setUsers={updateUsers}
              onViewTimesheet={(id)=>{setViewingAppId(id);setShowAppList(false);}}
            />
          )}
          {adminAppList && showAppList==="hours" && (
            <WeeklyHoursList allUsers={users} entries={entries}/>
          )}
          {adminAppList && showAppList==="submitted" && (
            <ApprovalList
              allUsers={users} entries={entries} status="submitted"
              onApprove={(id)=>updateEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"approved"}:e))}
              onDecline={(id)=>updateEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"declined"}:e))}
            />
          )}
          {adminAppList && showAppList==="approved" && (
            <ApprovalList allUsers={users} entries={entries} status="approved"
              onApprove={()=>{}} onDecline={()=>{}}
            />
          )}
          {adminAppList && showAppList==="declined" && (
            <ApprovalList allUsers={users} entries={entries} status="declined"
              onApprove={(id)=>updateEntries(prev=>prev.map(e=>e.id===id?{...e,approval:"approved"}:e))}
              onDecline={()=>{}}
            />
          )}
          {adminAppList && showAppList==="contacts" && <ContactsList/>}
          {adminAppList && showAppList==="hosts"    && <HostBusinessList/>}
          {adminAppList && showAppList==="deals"    && <TargetDealsList/>}
          {module!=="xero" && <>
          {!adminViewingApprentice && !adminAppList && activeMod==="dashboard" && role==="Admin" && (
            <AdminDashboard
              allUsers={users}
              entries={entries}
              onViewApprentice={(id)=>setViewingAppId(id)}
              onViewApprenticeList={()=>{setShowAppList('apprentices');setViewingAppId(null);}}
              onViewList={(key)=>{setShowAppList(key);setViewingAppId(null);}}
            />
          )}
          {activeMod==="timesheet" && (
            <>
              <TimesheetModule currentUser={currentUser} allUsers={users} entries={entries} setEntries={updateEntries}/>
              {["Apprentice","Approver","Viewer"].includes(role) && (
                <ContactUs
                  currentUser={currentUser}
                  allUsers={users}
                  onSend={async(selectedUser, message)=>{
                    const apprenticeId = role==="Apprentice" ? currentUser.id
                      : allUsers.find(u=>u.id===selectedUser.id&&u.role==="Apprentice")?.id || currentUser.id;
                    await insertMessage({
                      id: uid(),
                      apprentice_id: apprenticeId,
                      sender_id: currentUser.id,
                      body: message,
                      created_at: new Date().toISOString(),
                    }).catch(console.error);
                    await pushNotif(
                      [selectedUser.id],
                      "broadcast",
                      `💬 Message from ${currentUser.name}`,
                      message,
                      currentUser.id,
                      {}
                    );
                  }}
                />
              )}
            </>
          )}
          {activeMod==="mentor" && role==="Mentor" && (
            <MentorDashboard currentUser={currentUser} allUsers={users}/>
          )}
          {activeMod==="crm" && (
            <CRMModule currentUser={currentUser} allUsers={users}/>
          )}
          {activeMod==="users" && role==="Admin" && (
            <UserManagement users={users} setUsers={updateUsers} currentUser={currentUser}/>
          )}
          {activeMod==="emails" && (
            <EmailsModule allUsers={users} currentUser={currentUser}/>
          )}
          </>}
          {module==="xero" && isAdmin1 && (
            <XeroModule
              allUsers={users}
              entries={entries}
              currentUser={currentUser}
              onUpdateEntries={updateEntries}
              showToast={showToast}
              onImportUser={u=>setUsers(prev=>[...prev, u])}
            />
          )}
        </main>
      </div>
      {appToast&&(
        <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",
          background:appToast.ok?"#1a8a7a":"#bf2b2b",color:"#fff",
          padding:"10px 20px",borderRadius:10,fontWeight:600,fontSize:13,
          boxShadow:"0 4px 16px #0004",zIndex:9999,fontFamily:"DM Sans,sans-serif",
          animation:"fadeIn .2s"}}>
          {appToast.msg}
        </div>
      )}
    </>
  );
}
