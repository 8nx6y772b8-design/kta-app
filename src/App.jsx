import { useState, useEffect, useCallback } from "react";
import { loadUsers, loadEntries, loadTable, upsertUser, upsertEntry, deleteEntry, deleteUser as sbDeleteUser, upsertRow, deleteRow, loadNotifications, insertNotification, markNotifRead, markAllNotifsRead, deleteNotif, licenceReminderExists } from "./supabaseClient";
import emailjs from "@emailjs/browser";

const EJS_SERVICE  = "service_j3lmexe";
const EJS_TEMPLATE = "template_iu09ubw";
const EJS_KEY      = "ZNIRo4QdPVB2kJJ6m";

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
// DESIGN TOKENS — KTA brand palette (kta.org.nz)
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
  dark: "#0a1628", dark2: "#0d1e36",
};

// KTA logo URL (from kta.org.nz)
const KTA_LOGO = "https://images.squarespace-cdn.com/content/v1/682fe0a84dcaf578b10d7882/cca16351-c2c6-4895-be1c-24f4a540ee3c/Copy+of+KTA+LOGO+BLUE+No+Background.png?format=300w";

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
};

const ENTRY_TYPES = ["Normal Hours","Annual Leave","Sick Leave","Public Holiday","Other"];
const TYPE_META = {
  "Normal Hours":   { color: T.accent, bg: T.accentL, sym: "◈" },
  "Annual Leave":   { color: T.warn,   bg: T.warnL,   sym: "☀" },
  "Sick Leave":     { color: T.red,    bg: T.redL,    sym: "✚" },
  "Public Holiday": { color: T.hol,    bg: T.holL,    sym: "★" },
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
// SEED DATA  — passwords are "password" for all demo accounts
// ─────────────────────────────────────────────────────────────────────────────
// Simple hash: just XOR + encode so passwords aren't plaintext in storage
const hashPw = (pw) => btoa([...pw].map((c,i)=>String.fromCharCode(c.charCodeAt(0)^(42+i%7))).join(""));
const checkPw = (pw, hash) => hashPw(pw) === hash;

const DEFAULT_PW = hashPw("password");

const SEED_USERS = [
  { id:"u1", name:"Alex Admin",       role:"Admin",      email:"admin@work.com",   password:DEFAULT_PW, allocatedTo:[], phone:"+61 400 001 001" },
  { id:"u2", name:"Sam Viewer",       role:"Viewer",     email:"sam@work.com",     password:DEFAULT_PW, allocatedTo:["u5","u6"], phone:"+61 400 001 002" },
  { id:"u3", name:"Ava Approver",     role:"Approver",   email:"ava@work.com",     password:DEFAULT_PW, allocatedTo:["u5","u6"], phone:"+61 400 001 003" },
  { id:"u4", name:"Mike Mentor",      role:"Mentor",     email:"mike@work.com",    password:DEFAULT_PW, allocatedTo:["u5","u6","u2"], phone:"+61 400 001 004" },
  { id:"u5", name:"Jamie Apprentice", firstName:"Jamie", lastName:"Apprentice", role:"Apprentice", email:"jamie@work.com", password:DEFAULT_PW, allocatedTo:[], phone:"+61 400 001 005", trade:"Electrical",  licenceExpiry:"2026-06-30" },
  { id:"u6", name:"Riley Apprentice", firstName:"Riley", lastName:"Apprentice",  role:"Apprentice", email:"riley@work.com",  password:DEFAULT_PW, allocatedTo:[], phone:"+61 400 001 006", trade:"Plumbing",    licenceExpiry:"2025-12-31" },
];

const tod = () => new Date().toISOString().slice(0,10);
const daysAgo = n => { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };

const SEED_ENTRIES = [
  { id:"e1", userId:"u5", date:daysAgo(0), type:"Normal Hours", start:"08:00", end:"16:30", breakMins:30, netHours:8,   note:"Site work",    approval:"submitted"},
  { id:"e2", userId:"u5", date:daysAgo(1), type:"Normal Hours", start:"08:00", end:"16:30", breakMins:30, netHours:8,   note:"Workshop",     approval:"approved" },
  { id:"e3", userId:"u5", date:daysAgo(3), type:"Sick Leave",   start:"08:00", end:"16:00", breakMins:0,  netHours:8,   note:"Unwell",       approval:"approved" },
  { id:"e4", userId:"u6", date:daysAgo(0), type:"Normal Hours", start:"07:30", end:"15:30", breakMins:30, netHours:7.5, note:"Training",     approval:"submitted"},
  { id:"e5", userId:"u6", date:daysAgo(2), type:"Annual Leave", start:"08:00", end:"16:00", breakMins:0,  netHours:8,   note:"Holiday",      approval:"approved" },
];

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
const uid      = () => Math.random().toString(36).slice(2,9);
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
  emailjs.init(EJS_KEY);
  const entryList = entries.map(e=>
    `• ${fmtD(e.date)} — ${e.type} — ${e.netHours}h${e.note?" ("+e.note+")":""}`
  ).join("\n");
  for(const approver of approvers) {
    try {
      await emailjs.send(EJS_SERVICE, EJS_TEMPLATE, {
        to_email: approver.email,
        approver_name: approver.name,
        apprentice_name: apprentice.name,
        entry_count: entries.length,
        entry_list: entryList,
      });
    } catch(err) {
      console.error("EmailJS error:", err);
    }
  }
};

// Notify apprentice of approval or decline
const notifyApprentice = async (apprentice, approver, entries, approved) => {
  if(!apprentice?.email) return;
  emailjs.init(EJS_KEY);
  const entryList = entries.map(e=>
    `• ${fmtD(e.date)} — ${e.type} — ${e.netHours}h${e.note?" ("+e.note+")":""}`
  ).join("\n");
  try {
    await emailjs.send(EJS_SERVICE, EJS_TEMPLATE, {
      to_email:        apprentice.email,
      approver_name:   approver?.name || "Your approver",
      apprentice_name: apprentice.name,
      entry_count:     entries.length,
      entry_list:      entryList,
      status:          approved ? "APPROVED ✓" : "DECLINED ✕",
      message:         approved
        ? `Your timesheet${entries.length>1?" entries have":" entry has"} been approved.`
        : `Your timesheet${entries.length>1?" entries have":" entry has"} been declined. Please check with your approver.`,
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
  html,body{background:${T.bg};font-family:"DM Sans",sans-serif;color:${T.ink};font-size:14px;}
  ::-webkit-scrollbar{width:5px;height:5px;}
  ::-webkit-scrollbar-track{background:${T.border};}
  ::-webkit-scrollbar-thumb{background:${T.muted};border-radius:3px;}
  select,input,textarea{
    font-family:"DM Sans",sans-serif;background:${T.surface};
    border:1.5px solid ${T.border};color:${T.ink};border-radius:9px;
    padding:9px 12px;font-size:13px;outline:none;width:100%;
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
  textarea{resize:vertical;min-height:64px;line-height:1.55;}

  @keyframes fadeUp  {from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
  @keyframes fadeIn  {from{opacity:0;}to{opacity:1;}}
  @keyframes rowIn   {from{opacity:0;transform:translateX(-5px);}to{opacity:1;transform:translateX(0);}}
  @keyframes shake   {0%,100%{transform:translateX(0);}20%,60%{transform:translateX(-6px);}40%,80%{transform:translateX(6px);}}
  @keyframes spin    {to{transform:rotate(360deg);}}
  .fu{animation:fadeUp .3s ease both;}
  .fi{animation:fadeIn .25s ease both;}
  .ri{animation:rowIn .22s ease both;}
  .shake{animation:shake .35s ease;}

  /* Login page styles */
  .login-wrap{
    min-height:100vh;display:flex;
    background: linear-gradient(135deg, ${T.dark} 0%, ${T.dark2} 50%, #0d2d5e 100%);
  }
  .login-left{
    flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;
    padding:60px;position:relative;overflow:hidden;
  }
  .login-left::before{
    content:"";position:absolute;inset:0;
    background:radial-gradient(ellipse at 30% 50%, ${T.accent}22 0%, transparent 60%),
               radial-gradient(ellipse at 80% 20%, ${T.blue}14 0%, transparent 50%);
  }
  .login-right{
    width:440px;flex-shrink:0;background:${T.surface};
    display:flex;flex-direction:column;justify-content:center;padding:56px 48px;
    box-shadow:-20px 0 60px #00000033;
  }
  .login-input-wrap{position:relative;margin-bottom:14px;}
  .login-input-wrap input{
    padding:12px 16px 12px 44px;
    background:#f9f8f5;border:1.5px solid ${T.border};
    font-size:14px;border-radius:10px;
  }
  .login-input-wrap input:focus{background:white;}
  .login-icon{
    position:absolute;left:14px;top:50%;transform:translateY(-50%);
    font-size:16px;color:${T.muted};pointer-events:none;
  }
  .pw-toggle{
    position:absolute;right:12px;top:50%;transform:translateY(-50%);
    background:none;border:none;color:${T.muted};cursor:pointer;
    font-size:13px;padding:2px 6px;border-radius:4px;
    font-family:"DM Sans",sans-serif;
  }
  .pw-toggle:hover{color:${T.sub};}
  .demo-card{
    background:${T.dark2};border:1px solid #ffffff12;border-radius:10px;
    padding:14px 18px;margin-top:6px;
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
const RolePill = ({role,size="md"}) => { const m=ROLE_META[role]||ROLE_META.Apprentice; return <Pill label={role} color={m.color} bg={m.bg} sym={m.symbol} size={size}/> };
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
  const [demoOpen, setDemoOpen] = useState(false);

  const attempt = () => {
    setErr("");
    if(!email.trim()||!pw) { setErr("Please enter your email and password."); return; }
    setLoading(true);
    // Small delay to feel real
    setTimeout(() => {
      const user = users.find(u=>u.email.toLowerCase()===email.trim().toLowerCase());
      if(!user) { setErr("No account found with that email address."); setLoading(false); trigShake(); return; }
      if(!checkPw(pw, user.password)) { setErr("Incorrect password. Please try again."); setLoading(false); trigShake(); return; }
      onLogin(user.id);
    }, 600);
  };

  const trigShake = () => { setShaking(true); setTimeout(()=>setShaking(false),400); };

  const quickLogin = (userId) => {
    const u = users.find(x=>x.id===userId);
    if(u){ setEmail(u.email); setPw("password"); }
  };

  // group demo accounts by role
  const demoByRole = ROLES.map(r=>({role:r, user:users.find(u=>u.role===r)})).filter(x=>x.user);

  return (
    <div className="login-wrap">
      {/* LEFT — branding */}
      <div className="login-left fi">
        <div style={{position:"relative",zIndex:1,maxWidth:420}}>
          {/* Logo mark */}
          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:52}}>
            <img src={KTA_LOGO} alt="Kiwi Trade Apprentices"
              style={{height:56,objectFit:"contain",filter:"brightness(0) invert(1)"}}
              onError={e=>{e.target.style.display="none";}}
            />
          </div>

          {/* Tagline */}
          <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:38,fontWeight:700,color:"#fff",lineHeight:1.2,marginBottom:20,letterSpacing:"-.5px"}}>
            Your workforce,<br/>under control.
          </h1>
          <p style={{fontSize:15,color:"#ffffff66",lineHeight:1.7,marginBottom:48}}>
            Timesheet management, approvals, and CRM — built around your team's role structure.
          </p>

          {/* Role badges */}
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {ROLES.map(r=>(
              <div key={r} style={{
                display:"flex",alignItems:"center",gap:7,
                background:"#ffffff10",border:"1px solid #ffffff18",
                borderRadius:99,padding:"6px 14px"
              }}>
                <span style={{fontSize:11,color:ROLE_META[r].color}}>{ROLE_META[r].symbol}</span>
                <span style={{fontSize:12,color:"#ffffffaa",fontWeight:500}}>{r}</span>
              </div>
            ))}
          </div>
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

        {/* Demo accounts */}
        <div style={{borderTop:`1px solid ${T.border}`,paddingTop:20}}>
          <button onClick={()=>setDemoOpen(s=>!s)} style={{
            width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",
            background:"none",border:`1px solid ${T.border}`,borderRadius:9,
            padding:"9px 14px",fontSize:12,color:T.sub,fontWeight:600,fontFamily:"DM Sans,sans-serif",cursor:"pointer"
          }}>
            <span>🔑 Demo Accounts</span>
            <span style={{transition:"transform .2s",display:"inline-block",transform:demoOpen?"rotate(180deg)":"none"}}>▾</span>
          </button>

          {demoOpen&&(
            <div style={{marginTop:8}} className="fi">
              <div style={{fontSize:11,color:T.muted,marginBottom:8,padding:"0 2px"}}>
                All demo accounts use password: <strong style={{fontFamily:"monospace",color:T.ink}}>password</strong>
              </div>
              {demoByRole.map(({role,user})=>{
                const m=ROLE_META[role];
                return (
                  <button key={role} onClick={()=>quickLogin(user.id)} style={{
                    width:"100%",display:"flex",alignItems:"center",gap:12,
                    background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,
                    padding:"9px 12px",marginBottom:6,cursor:"pointer",
                    fontFamily:"DM Sans,sans-serif",transition:"all .13s",textAlign:"left"
                  }}
                    onMouseEnter={e=>{e.currentTarget.style.background=m.bg;e.currentTarget.style.borderColor=m.color+"44";}}
                    onMouseLeave={e=>{e.currentTarget.style.background=T.bg;e.currentTarget.style.borderColor=T.border;}}>
                    <div style={{width:32,height:32,borderRadius:"50%",background:m.bg,border:`2px solid ${m.color}44`,
                      display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:m.color,fontWeight:700,flexShrink:0}}>
                      {user.name[0]}
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:600,color:T.ink}}>{user.name}</div>
                      <div style={{fontSize:11,color:T.muted}}>{user.email}</div>
                    </div>
                    <RolePill role={role} size="sm"/>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY FORM
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
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
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
function EntryRow({entry,canEdit,canApprove,onDelete,onApprove,onDecline,onEdit,onSubmit,idx,showUser,users}) {
  const user=users?.find(u=>u.id===entry.userId);
  const tcols=showUser
    ?"130px 130px 1fr 130px 64px 60px 70px 100px 68px"
    :"130px 1fr 130px 64px 60px 70px 100px 68px";
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
        {canEdit&&(<>
          <button onClick={()=>onEdit(entry)} style={{width:26,height:26,borderRadius:6,fontSize:12,
            background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
            display:"flex",alignItems:"center",justifyContent:"center"}}
            onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;}}>✎</button>
          <button onClick={()=>onDelete(entry.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,
            background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
            display:"flex",alignItems:"center",justifyContent:"center"}}
            onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
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
  const role=currentUser.role;

  const showToast = (msg, ok=true) => {
    setToast({msg,ok});
    setTimeout(()=>setToast(null), 4000);
  };

  const visibleIds = useCallback(()=>{
    if(forcedApprenticeId) return [forcedApprenticeId];
    if(role==="Admin") return allUsers.map(u=>u.id);
    if(["Viewer","Approver"].includes(role))
      return [currentUser.id,...(currentUser.allocatedTo||[])];
    return [currentUser.id];
  },[role,currentUser,allUsers,forcedApprenticeId]);

  const canEdit=(entry)=>{
    if(role==="Admin") return true;
    // Viewer and Approver are read-only
    if(role==="Apprentice"&&entry.userId===currentUser.id&&entry.date>=daysAgoStr(21)&&entry.approval==="draft") return true;
    return false;
  };
  const canApprove=(entry)=>(role==="Admin"||(role==="Approver"&&(currentUser.allocatedTo||[]).includes(entry.userId)))&&entry.approval==="submitted";
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
  const handleDelete=(id)=>setEntries(prev=>prev.filter(e=>e.id!==id));
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
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:22}}>
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
            return (
              <Btn v="blue" onClick={async()=>{
                const ids=myDrafts.map(e=>e.id);
                setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"submitted"}:e));
                const approvers=allUsers.filter(u=>
                  u.role==="Approver"&&(u.allocatedTo||[]).includes(currentUser.id)
                );
                if(!approvers.length){
                  showToast("Submitted — no approver assigned yet, no email sent",false);
                } else {
                  try {
                    await notifyApprovers(currentUser, approvers, myDrafts);
                    showToast(`✓ Submitted & emailed ${approvers.map(a=>a.name).join(", ")}`);
                  } catch(e) {
                    showToast(`Submitted but email failed: ${e.message}`,false);
                  }
                }
              }}>
                ↑ Submit {myDrafts.length} Draft{myDrafts.length!==1?"s":""}
              </Btn>
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
      {role==="Approver" ? (()=>{
        const myApprentices = allUsers.filter(u=>
          u.role==="Apprentice"&&(currentUser.allocatedTo||[]).includes(u.id)
        );
        if(myApprentices.length===0) return (
          <Card><div style={{padding:32,textAlign:"center",color:T.muted}}>No apprentices allocated to you yet.</div></Card>
        );
        return myApprentices.map(app=>{
          const appEntries = shown.filter(e=>e.userId===app.id).sort((a,b)=>b.date.localeCompare(a.date));
          const submitted  = appEntries.filter(e=>e.approval==="submitted");
          // Group submitted entries by week (Mon–Sun)
          const getWeekKey = d=>{ const dt=new Date(d+"T00:00:00"); dt.setDate(dt.getDate()-((dt.getDay()+6)%7)); return dt.toISOString().slice(0,10); };
          const weeks = [...new Set(appEntries.map(e=>getWeekKey(e.date)))].sort((a,b)=>b.localeCompare(a));
          const approveWeek = async (weekKey)=>{
            const toApprove = submitted.filter(e=>getWeekKey(e.date)===weekKey);
            const ids = toApprove.map(e=>e.id);
            if(!ids.length) return;
            setEntries(prev=>prev.map(e=>ids.includes(e.id)?{...e,approval:"approved"}:e));
            await notifyApprentice(app, currentUser, toApprove, true);
            showToast(`✓ Week approved — emailed ${app.name}`);
          };
          return (
            <Card key={app.id} style={{marginBottom:16,padding:0,overflow:"hidden"}}>
              {/* Apprentice header */}
              <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
                background:T.bg,borderBottom:`1.5px solid ${T.border}`}}>
                <Avatar name={app.name} role="Apprentice" size={34}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14}}>{app.name}</div>
                  <div style={{fontSize:12,color:T.sub}}>{appEntries.length} entries · {submitted.length} awaiting approval</div>
                </div>
                {submitted.length>0&&(
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{fontSize:11,color:T.muted}}>Bulk:</span>
                    {weeks.filter(wk=>submitted.some(e=>getWeekKey(e.date)===wk)).map(wk=>{
                      const wkEnd=new Date(wk+"T00:00:00"); wkEnd.setDate(wkEnd.getDate()+6);
                      const wkLabel=`w/c ${new Date(wk+"T00:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short"})}`;
                      const wkCount=submitted.filter(e=>getWeekKey(e.date)===wk).length;
                      return (
                        <button key={wk} onClick={()=>approveWeek(wk)} style={{
                          padding:"5px 12px",borderRadius:6,fontSize:12,fontWeight:600,
                          background:T.accentL,color:T.accent,border:`1.5px solid ${T.accent}44`,
                          cursor:"pointer",fontFamily:"DM Sans,sans-serif",whiteSpace:"nowrap"
                        }}>✓ Approve {wkLabel} ({wkCount})</button>
                      );
                    })}
                  </div>
                )}
              </div>
              {/* Column headers */}
              <div style={{display:"grid",gridTemplateColumns:"110px 1fr 120px 60px 60px 80px 90px 80px",
                padding:"8px 16px",background:T.bg,
                fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".6px",gap:8}}>
                <span>Date</span><span>Note</span><span>Type</span>
                <span style={{textAlign:"center"}}>Hours</span><span style={{textAlign:"center"}}>Break</span>
                <span style={{textAlign:"center"}}>Time</span><span>Status</span>
                <span style={{textAlign:"right"}}>Actions</span>
              </div>
              {appEntries.length===0&&(
                <div style={{padding:"24px",textAlign:"center",color:T.muted,fontSize:12,fontStyle:"italic"}}>No entries yet.</div>
              )}
              {appEntries.map((e,i)=>(
                <div key={e.id} style={{display:"grid",
                  gridTemplateColumns:"110px 1fr 120px 60px 60px 80px 90px 80px",
                  padding:"9px 16px",gap:8,alignItems:"center",fontSize:12,
                  borderBottom:i<appEntries.length-1?`1px solid ${T.border}44`:"none",
                  background:e.approval==="submitted"?T.warnL+"55":i%2===0?T.surface:T.bg}}>
                  <div style={{fontWeight:600}}>{fmtD(e.date)}</div>
                  <div style={{color:e.note?T.ink:T.muted,fontStyle:e.note?"normal":"italic",
                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.note||"No note"}</div>
                  <TypePill type={e.type} size="sm"/>
                  <div style={{textAlign:"center",fontWeight:700,color:TYPE_META[e.type]?.color||T.accent,
                    fontFamily:"'Libre Baskerville'"}}>{e.netHours}h</div>
                  <div style={{textAlign:"center",fontSize:11,color:T.sub}}>{e.breakMins>0?`${e.breakMins}m`:"—"}</div>
                  <div style={{textAlign:"center",fontSize:11,color:T.muted,fontFamily:"monospace"}}>{e.start}–{e.end}</div>
                  <AppvPill status={e.approval}/>
                  <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                    {e.approval==="submitted"&&(<>
                      <button onClick={()=>handleApprove(e.id)} title="Approve" style={{
                        width:26,height:26,borderRadius:6,fontSize:13,background:T.accentL,color:T.accent,
                        border:`1px solid ${T.accent}44`,cursor:"pointer",
                        display:"flex",alignItems:"center",justifyContent:"center"}}>✓</button>
                      <button onClick={()=>handleDecline(e.id)} title="Decline" style={{
                        width:26,height:26,borderRadius:6,fontSize:13,background:T.redL,color:T.red,
                        border:`1px solid ${T.red}44`,cursor:"pointer",
                        display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                    </>)}
                    {e.approval==="declined"&&(
                      <button onClick={()=>handleApprove(e.id)} title="Re-approve" style={{
                        width:26,height:26,borderRadius:6,fontSize:11,background:T.accentL,color:T.accent,
                        border:`1px solid ${T.accent}44`,cursor:"pointer",
                        display:"flex",alignItems:"center",justifyContent:"center"}}>↺</button>
                    )}
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
              onSubmit={role==="Apprentice"?async(id)=>{
                setEntries(prev=>prev.map(x=>x.id===id?{...x,approval:"submitted"}:x));
                const entry=shown.find(e=>e.id===id);
                if(entry){
                  const approvers=allUsers.filter(u=>
                    u.role==="Approver"&&(u.allocatedTo||[]).includes(currentUser.id)
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
function UserManagement({users,setUsers}) {
  const blank={name:"",role:"Apprentice",email:"",phone:"",password:DEFAULT_PW,allocatedTo:[]};
  const [form,setForm]=useState(blank);
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [pwField,setPwField]=useState("");
  const [showPw,setShowPw]=useState(false);
  const sf=(k,v)=>setForm(f=>({...f,[k]:v}));

  const toggleAlloc=(uid)=>setForm(f=>({...f,allocatedTo:f.allocatedTo.includes(uid)?f.allocatedTo.filter(x=>x!==uid):[...f.allocatedTo,uid]}));

  const submit=()=>{
    if(!form.name.trim()||!form.email.trim()) return;
    const finalForm={...form};
    if(pwField.trim()) finalForm.password=hashPw(pwField.trim());
    const targetId = editId || uid();
    setUsers(prev=>{
      let next = editId
        ? prev.map(u=>u.id===editId?{...u,...finalForm}:u)
        : [...prev,{id:targetId,...finalForm}];
      // If saving an Apprentice, update Approver/Viewer allocatedTo arrays
      if(finalForm.role==="Apprentice") {
        next = next.map(u=>{
          if(u.role==="Approver") {
            const should = appApprovers.includes(u.id);
            const has    = (u.allocatedTo||[]).includes(targetId);
            if(should&&!has) return {...u,allocatedTo:[...(u.allocatedTo||[]),targetId]};
            if(!should&&has) return {...u,allocatedTo:(u.allocatedTo||[]).filter(x=>x!==targetId)};
          }
          if(u.role==="Viewer") {
            const should = appViewers.includes(u.id);
            const has    = (u.allocatedTo||[]).includes(targetId);
            if(should&&!has) return {...u,allocatedTo:[...(u.allocatedTo||[]),targetId]};
            if(!should&&has) return {...u,allocatedTo:(u.allocatedTo||[]).filter(x=>x!==targetId)};
          }
          return u;
        });
      }
      return next;
    });
    setEditId(null);
    setForm(blank);setPwField("");setShowForm(false);
    setAppApprover("");setAppViewer("");
  };

  const startEdit=(u)=>{
    setForm({name:u.name,role:u.role,email:u.email||"",phone:u.phone||"",password:u.password,allocatedTo:u.allocatedTo||[]});
    setPwField(""); setEditId(u.id); setShowForm(true);
    // Pre-populate approver/viewer selections for apprentices
    if(u.role==="Apprentice") {
      setAppApprover(users.find(x=>x.role==="Approver"&&(x.allocatedTo||[]).includes(u.id))?.id||"");
      setAppViewer(  users.find(x=>x.role==="Viewer"  &&(x.allocatedTo||[]).includes(u.id))?.id||"");
    }
    setTimeout(()=>document.getElementById("um-form")?.scrollIntoView({behavior:"smooth",block:"start"}),50);
  };
  const deleteUser=(id)=>{if(window.confirm("Remove this user?"))setUsers(prev=>prev.filter(u=>u.id!==id));};

  // For Approver/Viewer/Mentor: allocatable = apprentices (or apprentices+viewers for mentor)
  const allocatable=users.filter(u=>u.id!==(editId||"__")&&
    (["Approver","Viewer"].includes(form.role)?u.role==="Apprentice":
     form.role==="Mentor"?["Apprentice","Viewer"].includes(u.role):false));

  // For Apprentice: which Approvers/Viewers currently have this apprentice in their allocatedTo
  const [appApprover, setAppApprover] = useState("");
  const [appViewer,   setAppViewer]   = useState("");

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
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
            <div><FL req>Full Name</FL><input placeholder="Jane Smith" value={form.name} onChange={e=>sf("name",e.target.value)}/></div>
            <div>
              <FL req>Role</FL>
              <select value={form.role} onChange={e=>sf("role",e.target.value)}>
                {ROLES.map(r=><option key={r}>{r}</option>)}
              </select>
              <div style={{marginTop:6}}><RolePill role={form.role}/></div>
            </div>
            <div><FL req>Email</FL><input type="email" placeholder="jane@work.com" value={form.email} onChange={e=>sf("email",e.target.value)}/></div>
            <div><FL>Phone</FL><input placeholder="+61 4xx xxx xxx" value={form.phone} onChange={e=>sf("phone",e.target.value)}/></div>
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
              {!editId&&<div style={{fontSize:11,color:T.muted,marginTop:4}}>Default: "password"</div>}
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
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
              <div>
                <FL>Approver <span style={{fontWeight:400,color:T.muted}}>(approves timesheets)</span></FL>
                <select value={appApprover} onChange={e=>setAppApprover(e.target.value)}>
                  <option value="">— None —</option>
                  {users.filter(u=>u.role==="Approver").map(u=>(
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <FL>Viewer <span style={{fontWeight:400,color:T.muted}}>(read-only access)</span></FL>
                <select value={appViewer} onChange={e=>setAppViewer(e.target.value)}>
                  <option value="">— None —</option>
                  {users.filter(u=>u.role==="Viewer").map(u=>(
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div style={{display:"flex",gap:8}}>
            <Btn onClick={submit}>{editId?"Update User":"Create User"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);setAppApprover("");setAppViewer("");}}>Cancel</Btn>
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
            cursor:"pointer"}}
            onClick={()=>startEdit(u)}
            onMouseEnter={e=>{if(!isEditing)e.currentTarget.style.background=T.blueL+"99";}}
            onMouseLeave={e=>{e.currentTarget.style.background=isEditing?T.blueL:i%2===0?T.surface:T.bg;}}>
            <Avatar name={u.name} role={u.role}/>
            <div>
              <div style={{fontWeight:700,fontSize:13}}>{u.name}</div>
              {u.phone&&<div style={{fontSize:11,color:T.muted}}>{u.phone}</div>}
              <div style={{fontSize:11,color:T.blue,marginTop:1}}>{isEditing?"editing…":"click to edit"}</div>
            </div>
            <RolePill role={u.role} size="sm"/>
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
              <button onClick={()=>startEdit(u)} style={{width:26,height:26,borderRadius:6,fontSize:12,
                background:isEditing?T.blueL:"transparent",color:isEditing?T.blue:T.muted,
                border:`1px solid ${isEditing?T.blue+"66":T.border}`,
                display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.blueL;e.currentTarget.style.color=T.blue;}}
                onMouseLeave={e=>{e.currentTarget.style.background=isEditing?T.blueL:"transparent";e.currentTarget.style.color=isEditing?T.blue:T.muted;}}>✎</button>
              <button onClick={()=>deleteUser(u.id)} style={{width:26,height:26,borderRadius:6,fontSize:12,
                background:"transparent",color:T.muted,border:`1px solid ${T.border}`,
                display:"flex",alignItems:"center",justifyContent:"center"}}
                onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"66";}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.muted;e.currentTarget.style.borderColor=T.border;}}>✕</button>
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
  const canEdit=role==="Admin";

  const sc=(k,v)=>setCForm(f=>({...f,[k]:v}));
  const sd=(k,v)=>setDForm(f=>({...f,[k]:v}));

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
    setCForm({name:"",company:"",email:"",phone:"",status:"Active",notes:""});setShowCF(false);
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
  const startEditC=(c)=>{setCForm({name:c.name,company:c.company||"",email:c.email||"",phone:c.phone||"",status:c.status,notes:c.notes||""});setEditCId(c.id);setShowCF(true);};

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
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:22}}>
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
          <Btn sm onClick={()=>{setCForm({name:"",company:"",email:"",phone:"",status:"Active",notes:""});setEditCId(null);setShowCF(s=>!s);}}>
            {showCF?"✕ Cancel":"+ Add Contact"}
          </Btn>
        </div>}
        {showCF&&<Card style={{marginBottom:16,border:`1.5px solid ${T.blue}44`}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
            <div><FL req>Name</FL><input value={cForm.name} onChange={e=>sc("name",e.target.value)} placeholder="Contact name"/></div>
            <div><FL>Company</FL><input value={cForm.company} onChange={e=>sc("company",e.target.value)} placeholder="Company"/></div>
            <div><FL>Email</FL><input value={cForm.email} onChange={e=>sc("email",e.target.value)} placeholder="email@co.com"/></div>
            <div><FL>Phone</FL><input value={cForm.phone} onChange={e=>sc("phone",e.target.value)} placeholder="+61…"/></div>
            <div><FL>Status</FL><select value={cForm.status} onChange={e=>sc("status",e.target.value)}>
              {["Active","Prospect","Inactive"].map(s=><option key={s}>{s}</option>)}
            </select></div>
          </div>
          <div style={{marginBottom:12}}><FL>Notes</FL><textarea value={cForm.notes} onChange={e=>sc("notes",e.target.value)} placeholder="Notes…"/></div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={saveContact}>{editCId?"Update":"Save Contact"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowCF(false);setEditCId(null);}}>Cancel</Btn>
          </div>
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
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
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
  const approvers   = allUsers.filter(u => u.role === "Approver");
  const viewers     = allUsers.filter(u => u.role === "Viewer");

  const blank = {firstName:"", lastName:"", email:"", phone:"", trade:"", licenceExpiry:"", role:"Apprentice", allocatedTo:[], password: hashPw("password")};
  const [form, setForm]         = useState(blank);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState(null);
  const [pwField, setPwField]   = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [expandId, setExpandId] = useState(null); // expanded allocation row
  const [formApproverId, setFormApproverId] = useState(""); // selected approver in form
  const [formViewerId,   setFormViewerId]   = useState(""); // selected viewer in form
  const sf = (k,v) => setForm(f=>({...f,[k]:v}));

  // helpers to get allocated approver/viewer for a given apprentice
  const getAllocated = (role, appId) =>
    allUsers.filter(u => u.role===role && (u.allocatedTo||[]).includes(appId));

  // toggle allocation: add/remove appId from a staff member's allocatedTo
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
    const finalForm = {...form, name: fullName, firstName, lastName};
    if(pwField.trim()) finalForm.password = hashPw(pwField.trim());
    let appId = editId;
    if(editId) {
      setUsers(prev => prev.map(u => u.id===editId ? {...u,...finalForm} : u));
      setEditId(null);
    } else {
      appId = uid();
      setUsers(prev => [...prev, {id:appId, ...finalForm}]);
    }
    // Sync approver/viewer allocations
    setUsers(prev => prev.map(u => {
      if(u.role==="Approver") {
        const has = (u.allocatedTo||[]).includes(appId);
        const want = u.id === formApproverId;
        if(want && !has) return {...u, allocatedTo:[...(u.allocatedTo||[]), appId]};
        if(!want && has) return {...u, allocatedTo:(u.allocatedTo||[]).filter(x=>x!==appId)};
      }
      if(u.role==="Viewer") {
        const has = (u.allocatedTo||[]).includes(appId);
        const want = u.id === formViewerId;
        if(want && !has) return {...u, allocatedTo:[...(u.allocatedTo||[]), appId]};
        if(!want && has) return {...u, allocatedTo:(u.allocatedTo||[]).filter(x=>x!==appId)};
      }
      return u;
    }));
    setForm(blank); setPwField(""); setFormApproverId(""); setFormViewerId(""); setShowForm(false);
  };

  const startEdit = (u) => {
    const parts = u.name.split(" ");
    setForm({
      firstName: u.firstName || parts[0] || "",
      lastName:  u.lastName  || parts.slice(1).join(" ") || "",
      email: u.email||"", phone: u.phone||"",
      trade: u.trade||"", licenceExpiry: u.licenceExpiry||"",
      role:"Apprentice", allocatedTo:[], password:u.password
    });
    // Pre-select current approver/viewer
    const curApprover = allUsers.find(x=>x.role==="Approver"&&(x.allocatedTo||[]).includes(u.id));
    const curViewer   = allUsers.find(x=>x.role==="Viewer"  &&(x.allocatedTo||[]).includes(u.id));
    setFormApproverId(curApprover?.id||"");
    setFormViewerId(curViewer?.id||"");
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
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12}}>
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
            <div>
              <FL>Approver <span style={{fontWeight:400,color:T.muted}}>(can approve timesheets)</span></FL>
              <select value={formApproverId} onChange={e=>setFormApproverId(e.target.value)}>
                <option value="">— None —</option>
                {approvers.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <FL>Viewer <span style={{fontWeight:400,color:T.muted}}>(read-only access)</span></FL>
              <select value={formViewerId} onChange={e=>setFormViewerId(e.target.value)}>
                <option value="">— None —</option>
                {viewers.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div>
              <FL>{editId?"New Password (blank = keep)":"Password"}</FL>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} placeholder={editId?"Leave blank to keep":"Set password"}
                  value={pwField} onChange={e=>setPwField(e.target.value)} style={{paddingRight:60}}/>
                <button onClick={()=>setShowPw(s=>!s)} type="button" style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:12,fontFamily:"DM Sans,sans-serif"}}>{showPw?"Hide":"Show"}</button>
              </div>
              {!editId && <div style={{fontSize:11,color:T.muted,marginTop:3}}>Default: "password"</div>}
            </div>
          </div>
          <div style={{display:"flex", gap:8}}>
            <Btn onClick={submit}>{editId?"Update":"Add Apprentice"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancel</Btn>
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
          const allocApprovers = getAllocated("Approver", u.id);
          const allocViewers   = getAllocated("Viewer",   u.id);
          const isExpanded     = expandId === u.id;
          const lc             = licColour(u.licenceExpiry);

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
                  <div style={{fontWeight:700, fontSize:13}}>{u.firstName||u.name.split(" ")[0]} <span style={{color:T.sub}}>{u.lastName||u.name.split(" ").slice(1).join(" ")}</span></div>
                  <div style={{fontSize:11, color:T.blue, marginTop:1}}>View timesheet →</div>
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
                    <div style={{color:allocApprovers.length?T.warn:T.muted, fontWeight:allocApprovers.length?600:400}}>
                      ▲ {allocApprovers.length?allocApprovers.map(x=>x.name.split(" ")[0]).join(", "):"No approver"}
                    </div>
                    <div style={{color:allocViewers.length?T.teal:T.muted, fontWeight:allocViewers.length?600:400, marginTop:2}}>
                      ◆ {allocViewers.length?allocViewers.map(x=>x.name.split(" ")[0]).join(", "):"No viewer"}
                    </div>
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
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
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
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
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
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
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
      <div style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14, marginBottom:32}}>
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
      <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:14, marginBottom:32}}>
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
function NotificationBell({notifs, onRead, onReadAll, onDelete, show, setShow}) {
  const unread = notifs.filter(n=>!n.read).length;
  const typeIcon = t => t==="licence_expiry"?"⚠":t==="approval"?"✓":t==="decline"?"✕":t==="broadcast"?"📢":"◈";
  const typeColor = t => t==="licence_expiry"?T.warn:t==="approval"?T.accent:t==="decline"?T.red:t==="broadcast"?T.blue:T.sub;

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
        <div style={{position:"absolute",top:"calc(100% + 8px)",right:0,width:360,
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
          <div style={{maxHeight:400,overflowY:"auto"}}>
            {notifs.length===0&&(
              <div style={{padding:24,textAlign:"center",color:T.muted,fontSize:13}}>No notifications</div>
            )}
            {notifs.map(n=>(
              <div key={n.id} style={{
                padding:"12px 16px",borderBottom:`1px solid ${T.border}44`,
                background:n.read?T.surface:T.blueL+"55",
                display:"flex",gap:10,alignItems:"flex-start",cursor:"pointer"}}
                onClick={()=>{ if(!n.read) onRead(n.id); }}>
                <span style={{fontSize:16,marginTop:1,color:typeColor(n.type)}}>{typeIcon(n.type)}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:n.read?500:700,fontSize:13,color:typeColor(n.type)}}>{n.title}</div>
                  <div style={{fontSize:12,color:T.sub,marginTop:2,lineHeight:1.4}}>{n.message}</div>
                  <div style={{fontSize:10,color:T.muted,marginTop:4}}>
                    {new Date(n.created_at).toLocaleString("en-AU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}
                  </div>
                </div>
                <button onClick={e=>{e.stopPropagation();onDelete(n.id);}} style={{
                  background:"none",border:"none",color:T.muted,cursor:"pointer",
                  fontSize:14,padding:"0 2px",flexShrink:0}}
                  onMouseEnter={e=>e.currentTarget.style.color=T.red}
                  onMouseLeave={e=>e.currentTarget.style.color=T.muted}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
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
  const updateUsers = useCallback((updater) => {
    setUsers(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      const nextIds = new Set(next.map(u=>u.id));
      // Sync to Supabase outside the render cycle
      setTimeout(() => {
        next.forEach(u => {
          const old = prev.find(p=>p.id===u.id);
          if(!old || JSON.stringify(old)!==JSON.stringify(u)) {
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
      // Sync to Supabase outside the render cycle
      setTimeout(() => {
        next.forEach(e => {
          const old = prevMap[e.id];
          if(!old || JSON.stringify(old)!==JSON.stringify(e)) {
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

  const handleLogin  = (userId) => {
    const u = users.find(x=>x.id===userId);
    // Admin lands on dashboard, others on timesheet
    setModule(u?.role==="Admin"?"dashboard":u?.role==="Mentor"?"crm":"timesheet");
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
      background:`linear-gradient(135deg,${T.dark},${T.dark2},#0d2d5e)`}}>
        <div style={{textAlign:"center",color:"#fff"}}>
          <img src={KTA_LOGO} alt="KTA"
            style={{height:64,objectFit:"contain",filter:"brightness(0) invert(1)",marginBottom:20}}
            onError={e=>{e.target.style.display="none";}}
          />
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

  // Nav items per role
  const navItems=[
    {id:"dashboard", label:"⊞ Dashboard",  roles:["Admin"]},
    {id:"timesheet", label:"⏱ Timesheet",  roles:["Apprentice","Approver","Viewer"]},
    {id:"crm",       label:"◈ CRM",         roles:["Mentor","Admin"]},
    {id:"users",     label:"★ Users",       roles:["Admin"]},
  ].filter(n=>n.roles.includes(role));

  const validMods=navItems.map(n=>n.id);
  const activeMod=validMods.includes(module)?module:validMods[0];

  // When admin drills into an apprentice's timesheet, show a pseudo-timesheet
  // scoped to that apprentice, with back button
  const viewingApp = viewingAppId ? users.find(u=>u.id===viewingAppId) : null;

  // Admin timesheet view is a scoped read/edit view for one apprentice
  const adminViewingTimesheet = role==="Admin" && activeMod==="dashboard" && viewingApp && !showAppList;
  const adminAppList = role==="Admin" && activeMod==="dashboard" && !!showAppList && !viewingAppId;

  return (
    <>
      <style>{CSS}</style>
      <div style={{minHeight:"100vh",background:T.bg,opacity:loggingOut?0:1,transition:"opacity .35s"}}>

        {/* HEADER */}
        <header style={{background:T.dark,height:62,padding:"0 28px",
          display:"flex",alignItems:"center",justifyContent:"space-between",
          position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 12px #00000022"}}>
          <div style={{display:"flex",alignItems:"center",gap:18}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <img src={KTA_LOGO} alt="KTA"
                style={{height:36,objectFit:"contain",filter:"brightness(0) invert(1)"}}
                onError={e=>{e.target.style.display="none";}}
              />
            </div>
            <div style={{width:1,height:22,background:"#ffffff20"}}/>
            <nav style={{display:"flex",gap:4}}>
              {navItems.map(n=>(
                <button key={n.id} onClick={()=>{setModule(n.id);setViewingAppId(null);setShowAppList(false);}} style={{
                  padding:"6px 15px",borderRadius:8,fontSize:13,fontWeight:600,
                  background:activeMod===n.id?T.accent+"33":"transparent",
                  color:activeMod===n.id?T.accentL:"#ffffff55",
                  border:activeMod===n.id?`1px solid ${T.accent}55`:"1px solid transparent",
                  fontFamily:"DM Sans,sans-serif",cursor:"pointer",transition:"all .14s"
                }}>{n.label}</button>
              ))}
            </nav>
          </div>

          {/* User info + logout */}
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {/* Notification Bell */}
            <NotificationBell
              notifs={notifications}
              show={showNotifs}
              setShow={(v)=>{setShowNotifs(v);if(v)setShowBroadcast(false);}}
              onRead={id=>{ markNotifRead(id).catch(console.error); setNotifications(prev=>prev.map(n=>n.id===id?{...n,read:true}:n)); }}
              onReadAll={()=>{ markAllNotifsRead(sessionId).catch(console.error); setNotifications(prev=>prev.map(n=>({...n,read:true}))); }}
              onDelete={id=>{ deleteNotif(id).catch(console.error); setNotifications(prev=>prev.filter(n=>n.id!==id)); }}
            />
            {/* Broadcast button — Admin + Mentor only */}
            {["Admin","Mentor"].includes(role)&&(
              <button onClick={()=>{setShowBroadcast(s=>!s);setShowNotifs(false);}} title="Send notification to users" style={{
                background:"none",border:"1px solid #ffffff33",color:"#ffffffbb",
                borderRadius:7,padding:"5px 9px",fontSize:15,cursor:"pointer",transition:"all .14s"}}
                onMouseEnter={e=>e.currentTarget.style.background="#ffffff22"}
                onMouseLeave={e=>e.currentTarget.style.background="none"}>
                📢
              </button>
            )}
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:13,fontWeight:600,color:"#fff"}}>{currentUser.name}</div>
              <div style={{marginTop:2}}><RolePill role={role} size="sm"/></div>
            </div>
            <Avatar name={currentUser.name} role={role} size={36}/>
            <button onClick={handleLogout} style={{
              background:"#ffffff10",border:"1px solid #ffffff20",borderRadius:8,
              padding:"7px 14px",fontSize:12,color:"#ffffff77",fontWeight:600,
              fontFamily:"DM Sans,sans-serif",cursor:"pointer",transition:"all .14s"
            }}
              onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;e.currentTarget.style.borderColor=T.red+"44";}}
              onMouseLeave={e=>{e.currentTarget.style.background="#ffffff10";e.currentTarget.style.color="#ffffff77";e.currentTarget.style.borderColor="#ffffff20";}}>
              Sign out
            </button>
          </div>
        </header>

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
        <main style={{maxWidth:1300,margin:"0 auto",padding:"28px 24px"}}>

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
                  {activeMod==="dashboard"?"Dashboard":activeMod==="timesheet"?"Timesheet":activeMod==="crm"?"CRM":"User Management"}
                </h1>
                <p style={{fontSize:13,color:T.sub,marginTop:4}}>
                  {activeMod==="dashboard"&&"Overview of all apprentice timesheets"}
                  {activeMod==="timesheet"&&"Time entries — access enforced by role"}
                  {activeMod==="crm"&&"Contacts, deals & pipeline"}
                  {activeMod==="users"&&"Manage all users, roles and allocations"}
                </p>
              </div>
            )}
          </div>

          {/* Module routing */}
          {adminViewingTimesheet && (
            <TimesheetModule
              currentUser={currentUser}
              allUsers={users}
              entries={entries}
              setEntries={updateEntries}
              forcedApprenticeId={viewingAppId}
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
          {!adminViewingTimesheet && !adminAppList && activeMod==="dashboard" && role==="Admin" && (
            <AdminDashboard
              allUsers={users}
              entries={entries}
              onViewApprentice={(id)=>setViewingAppId(id)}
              onViewApprenticeList={()=>{setShowAppList('apprentices');setViewingAppId(null);}}
              onViewList={(key)=>{setShowAppList(key);setViewingAppId(null);}}
            />
          )}
          {activeMod==="timesheet" && (
            <TimesheetModule currentUser={currentUser} allUsers={users} entries={entries} setEntries={updateEntries}/>
          )}
          {activeMod==="crm" && (
            <CRMModule currentUser={currentUser} allUsers={users}/>
          )}
          {activeMod==="users" && role==="Admin" && (
            <UserManagement users={users} setUsers={updateUsers}/>
          )}
        </main>
      </div>
    </>
  );
}
