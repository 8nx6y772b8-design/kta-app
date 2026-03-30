import { useState, useRef, useEffect } from "react";
import { T, APPROVAL_META, TYPE_META, ENTRY_TYPES } from "../constants.js";
import { fmtD, daysAgoStr, weekStart } from "../utils.js";
import { loadTable } from "../supabaseClient.js";
import { Pill, Avatar, Card } from "../shared.jsx";

function useDraggableOrder(userId, defaultOrder) {
  const key = `kta_card_order_${userId}`;
  const [order, setOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      // Merge saved with defaults to handle new cards added later
      if(saved && Array.isArray(saved)) {
        const merged = [...saved.filter(id => defaultOrder.includes(id)),
          ...defaultOrder.filter(id => !saved.includes(id))];
        return merged;
      }
    } catch {}
    return defaultOrder;
  });
  const dragging = useRef(null);
  const dragOver = useRef(null);

  const save = (newOrder) => {
    setOrder(newOrder);
    try { localStorage.setItem(key, JSON.stringify(newOrder)); } catch {}
  };

  const onDragStart = (id) => { dragging.current = id; };
  const onDragEnter = (id) => { dragOver.current = id; };
  const onDragEnd   = () => {
    if(!dragging.current || !dragOver.current || dragging.current === dragOver.current) return;
    const next = [...order];
    const from = next.indexOf(dragging.current);
    const to   = next.indexOf(dragOver.current);
    next.splice(from, 1);
    next.splice(to, 0, dragging.current);
    save(next);
    dragging.current = null;
    dragOver.current = null;
  };

  const dragProps = (id) => ({
    draggable: true,
    onDragStart: () => onDragStart(id),
    onDragEnter: () => onDragEnter(id),
    onDragEnd,
    onDragOver: (e) => e.preventDefault(),
  });

  return { order, dragProps };
}

// Wrapper for a draggable dashboard section
function DraggableSection({ id, dragProps, children, style = {} }) {
  const [isDragOver, setIsDragOver] = useState(false);
  const props = dragProps(id);
  return (
    <div
      {...props}
      onDragEnter={(e) => { props.onDragEnter(e); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={() => setIsDragOver(false)}
      style={{
        marginBottom: 20,
        borderRadius: 14,
        transition: "all .18s",
        outline: isDragOver ? `2px dashed ${T.accent}` : "2px dashed transparent",
        outlineOffset: 4,
        opacity: 1,
        cursor: "grab",
        ...style,
      }}
    >
      {/* Drag handle */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        marginBottom: 6, paddingLeft: 2, userSelect: "none",
      }}>
        <div style={{
          display: "flex", flexDirection: "column", gap: 3,
          cursor: "grab", padding: "2px 4px", borderRadius: 4,
          opacity: 0.3,
        }}
          title="Drag to reorder"
        >
          {[0,1].map(i=>(
            <div key={i} style={{display:"flex",gap:3}}>
              {[0,1,2].map(j=>(
                <div key={j} style={{width:3,height:3,borderRadius:"50%",background:T.ink}}/>
              ))}
            </div>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}

function AdminDashboard({allUsers, entries, onViewApprentice, onViewApprenticeList, onViewList, onViewTimesheets, onViewLeave, currentUser, navigateTo}) {
  const apprentices = allUsers.filter(u=>u.role==="Apprentice");
  const wsStart = ()=>{ const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };
  const ws = wsStart();

  // Global stats
  const totalSubmitted    = entries.filter(e=>e.approval==="submitted").length;
  const totalApproved     = entries.filter(e=>e.approval==="approved").length;
  const totalNotApproved  = entries.filter(e=>e.approval==="declined").length;
  const totalHrsWeek      = entries.filter(e=>e.date>=ws).reduce((a,e)=>a+e.netHours,0).toFixed(1);
  const weekTypeHrs = ENTRY_TYPES.map(t=>({
    type: t,
    hrs:  entries.filter(e=>e.date>=ws && e.type===t).reduce((a,e)=>a+e.netHours,0)
  })).filter(t=>t.hrs>0);

  // Section order (top-level)
  const DEFAULT_ORDER = ["stats", "crm"];
  const { order, dragProps } = useDraggableOrder(currentUser?.id || "admin", DEFAULT_ORDER);

  // Card order within Stats section
  const STATS_DEFAULT = ["apprentices","hours","submitted","approved","declined","timesheets","leave"];
  const { order: statsOrder, dragProps: statsDrag } = useDraggableOrder((currentUser?.id||"admin") + "_stats", STATS_DEFAULT);

  // Card order within CRM section
  const CRM_DEFAULT = ["contacts","hosts","deals"];
  const { order: crmOrder, dragProps: crmDrag } = useDraggableOrder((currentUser?.id||"admin") + "_crm", CRM_DEFAULT);

  // Timesheet summary for stat card
  const pendingCount  = entries.filter(e=>e.approval==="submitted").length;
  const activeApps    = apprentices.filter(a=>entries.some(e=>e.userId===a.id)).length;
  const [leaveStats, setLeaveStats] = useState({total:0, pending:0, approver_approved:0, kta_approved:0, declined:0});
  useEffect(()=>{
    loadTable("leave_requests").then(rows=>{
      const r = rows||[];
      setLeaveStats({
        total:             r.length,
        pending:           r.filter(x=>x.status==="pending").length,
        approver_approved: r.filter(x=>x.status==="approver_approved").length,
        kta_approved:      r.filter(x=>x.status==="kta_approved").length,
        declined:          r.filter(x=>x.status==="declined").length,
      });
    }).catch(()=>{});
  },[]);

  const statsData = {
    apprentices: (
      <button onClick={onViewApprenticeList} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
        onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
        <Card style={{paddingBlock:18,border:`1.5px solid ${T.blue}44`,height:"100%"}}>
          <div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Apprentices</div>
          <div style={{fontSize:26,fontWeight:700,color:T.blue,fontFamily:"'Libre Baskerville'"}}>{apprentices.length}</div>
          <div style={{fontSize:12,color:T.sub,marginTop:2}}>active workforce</div>
          <div style={{fontSize:12,color:T.blue,marginTop:6,fontWeight:700}}>View & manage →</div>
        </Card>
      </button>
    ),
    hours: (
      <button onClick={()=>onViewList("hours")} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
        onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
        <Card style={{paddingBlock:14,border:`1.5px solid ${T.accent}44`,height:"100%"}}>
          <div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:6}}>Hours This Week</div>
          <div style={{display:"flex",alignItems:"baseline",gap:4,marginBottom:8}}>
            <span style={{fontSize:22,fontWeight:700,color:T.accent,fontFamily:"DM Sans"}}>{totalHrsWeek}</span>
            <span style={{fontSize:14,color:T.sub,fontWeight:700}}>h total</span>
          </div>
          {weekTypeHrs.length>0 ? (
            <div style={{display:"flex",flexDirection:"column",gap:3,marginBottom:8}}>
              {weekTypeHrs.slice(0,5).map(({type,hrs})=>{
                const meta = TYPE_META[type]||{color:T.muted,bg:T.bg};
                const pct  = Math.round((hrs/parseFloat(totalHrsWeek||"1"))*100);
                return (
                  <div key={type}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:T.sub,marginBottom:1}}>
                      <span style={{fontWeight:700,color:meta.color}}>{type}</span>
                      <span style={{fontWeight:700}}>{hrs.toFixed(1)}h</span>
                    </div>
                    <div style={{height:4,borderRadius:99,background:T.bg,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${pct}%`,borderRadius:99,background:meta.color,opacity:.75,transition:"width .3s"}}/>
                    </div>
                  </div>
                );
              })}
              {weekTypeHrs.length>5&&<div style={{fontSize:11,color:T.muted,marginTop:2}}>+{weekTypeHrs.length-5} more types</div>}
            </div>
          ) : (
            <div style={{fontSize:12,color:T.muted,marginBottom:8}}>all apprentices</div>
          )}
          <div style={{fontSize:12,color:T.accent,fontWeight:700}}>View list →</div>
        </Card>
      </button>
    ),
    submitted: <button onClick={()=>onViewList("submitted")} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}} onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}><Card style={{paddingBlock:18,border:`1.5px solid ${totalSubmitted>0?T.warn:T.muted}44`,height:"100%"}}><div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Pending</div><div style={{fontSize:26,fontWeight:700,color:totalSubmitted>0?T.warn:T.muted,fontFamily:"'Libre Baskerville'"}}>{totalSubmitted}</div><div style={{fontSize:12,color:T.sub,marginTop:2}}>submitted, awaiting review</div><div style={{fontSize:12,color:totalSubmitted>0?T.warn:T.muted,marginTop:6,fontWeight:700}}>View list →</div></Card></button>,
    approved:  <button onClick={()=>onViewList("approved")}  style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}} onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}><Card style={{paddingBlock:18,border:`1.5px solid ${T.teal}44`,height:"100%"}}><div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Submitted — Approved</div><div style={{fontSize:26,fontWeight:700,color:T.teal,fontFamily:"'Libre Baskerville'"}}>{totalApproved}</div><div style={{fontSize:12,color:T.sub,marginTop:2}}>approved by approver</div><div style={{fontSize:12,color:T.teal,marginTop:6,fontWeight:700}}>View list →</div></Card></button>,
    declined:  <button onClick={()=>onViewList("declined")}  style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}} onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}><Card style={{paddingBlock:18,border:`1.5px solid ${totalNotApproved>0?T.red:T.muted}44`,height:"100%"}}><div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Submitted — Not Approved</div><div style={{fontSize:26,fontWeight:700,color:totalNotApproved>0?T.red:T.muted,fontFamily:"DM Sans"}}>{totalNotApproved}</div><div style={{fontSize:12,color:T.sub,marginTop:2}}>declined by approver</div><div style={{fontSize:12,color:totalNotApproved>0?T.red:T.muted,marginTop:6,fontWeight:700}}>View list →</div></Card></button>,
    timesheets: (
      <button onClick={onViewTimesheets} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
        onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
        <Card style={{paddingBlock:18,border:`1.5px solid ${T.teal}44`,height:"100%"}}>
          <div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Timesheets</div>
          <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:2}}>
            <div style={{fontSize:26,fontWeight:700,color:T.teal,fontFamily:"'Libre Baskerville'"}}>{activeApps}</div>
            <div style={{fontSize:12,color:T.muted}}>/ {apprentices.length}</div>
          </div>
          <div style={{fontSize:12,color:T.sub,marginTop:2}}>apprentices with entries</div>
          {pendingCount>0
            ? <div style={{fontSize:12,color:T.warn,marginTop:6,fontWeight:700}}>⚠ {pendingCount} pending review</div>
            : <div style={{fontSize:12,color:T.teal,marginTop:6,fontWeight:700}}>View timesheets →</div>
          }
        </Card>
      </button>
    ),
    leave: (
      <button onClick={onViewLeave} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
        onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
        <Card style={{paddingBlock:18,border:`1.5px solid ${leaveStats.pending>0||leaveStats.approver_approved>0?T.warn:T.hol}44`,height:"100%"}}>
          <div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>Leave Requests</div>
          <div style={{fontSize:26,fontWeight:700,color:leaveStats.pending>0||leaveStats.approver_approved>0?T.warn:T.hol,fontFamily:"DM Sans",marginBottom:4}}>{leaveStats.total}</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}}>
            {leaveStats.pending>0           && <span style={{fontSize:11,fontWeight:700,color:"#b86e1a",background:"#faebd7",borderRadius:99,padding:"2px 7px"}}>{leaveStats.pending} approver</span>}
            {leaveStats.approver_approved>0 && <span style={{fontSize:11,fontWeight:700,color:"#1b4f8c",background:"#dce8f7",borderRadius:99,padding:"2px 7px"}}>{leaveStats.approver_approved} KTA</span>}
            {leaveStats.kta_approved>0      && <span style={{fontSize:11,fontWeight:700,color:"#1a6b3a",background:"#d4f0e0",borderRadius:99,padding:"2px 7px"}}>{leaveStats.kta_approved} approved</span>}
            {leaveStats.declined>0          && <span style={{fontSize:11,fontWeight:700,color:"#bf2b2b",background:"#fde8e8",borderRadius:99,padding:"2px 7px"}}>{leaveStats.declined} declined</span>}
            {leaveStats.total===0           && <span style={{fontSize:12,color:T.muted}}>no requests</span>}
          </div>
          <div style={{fontSize:12,color:T.hol,marginTop:6,fontWeight:700}}>View & manage →</div>
        </Card>
      </button>
    ),
  };

  const crmData = {
    contacts: {label:"Contacts",        sub:"business & other contacts",    color:T.slate, icon:"◉", tab:"contacts"},
    hosts:    {label:"Host Businesses",  sub:"companies hosting apprentices", color:T.teal,  icon:"◆", tab:"companies"},
    deals:    {label:"Target Deals",     sub:"opportunities & pipeline",      color:T.gold,  icon:"◈", tab:"deals"},
  };

  const handleCrmCard = (id) => {
    const tabMap = {contacts:"contacts", hosts:"companies", deals:"deals"};
    const crmTab = tabMap[id]||"contacts";
    try { localStorage.setItem("wos_crm_tab", crmTab); } catch {}
    // When Host Businesses card clicked, flag to filter companies to hosts only
    try { localStorage.setItem("wos_crm_hosts_only", id==="hosts"?"1":""); } catch {}
    if(navigateTo) navigateTo("crm");
    else onViewList(id);
  };

  const sections = {
    stats: (
      <DraggableSection id="stats" dragProps={dragProps}>
        <div className="stat-grid-4">
          {statsOrder.map(id => (
            <div key={id} {...statsDrag(id)} style={{borderRadius:14, cursor:"grab"}}>
              {statsData[id]}
            </div>
          ))}
        </div>
      </DraggableSection>
    ),
    crm: (
      <DraggableSection id="crm" dragProps={dragProps}>
        <div className="stat-grid-3">
          {crmOrder.map(id => {
            const {label,sub,color,icon} = crmData[id];
            return (
              <div key={id} {...crmDrag(id)} style={{borderRadius:14, cursor:"grab"}}>
                <button onClick={()=>handleCrmCard(id)} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",borderRadius:14,display:"block",width:"100%"}}
                  onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                  <Card style={{paddingBlock:18,border:`1.5px solid ${color}44`}}>
                    <div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>{label}</div>
                    <div style={{fontSize:31,marginBottom:4,color}}>{icon}</div>
                    <div style={{fontSize:12,color:T.sub}}>{sub}</div>
                    <div style={{fontSize:12,color,marginTop:6,fontWeight:700}}>View & manage →</div>
                  </Card>
                </button>
              </div>
            );
          })}
        </div>
      </DraggableSection>
    ),
  };

  return (
    <div className="fu">
      {order.map(id => sections[id] || null)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION BELL
// ─────────────────────────────────────────────────────────────────────────────
const BatSignal = ({size=18}) => (
  <svg width={size} height={Math.round(size*0.64)} viewBox="0 0 110 70" style={{display:"inline-block",verticalAlign:"middle",flexShrink:0}}>
    <ellipse cx="55" cy="35" rx="53" ry="32" fill="#000" stroke="#f5c500" strokeWidth="4"/>
    <path d="M55 12 C51 14 46 18 42 22 C36 17 27 15 18 18 C23 22 24 27 22 31 C17 28 11 29 8 33 C12 34 17 33 19 36 C17 41 18 47 21 50 C25 47 29 44 34 45 C37 49 39 54 42 56 C44 52 44 47 47 46 C49 50 49 54 51 56 C53 52 54 48 55 45 C56 48 57 52 59 56 C61 54 61 50 63 46 C66 47 66 52 68 56 C71 54 73 49 76 45 C81 44 85 47 89 50 C92 47 93 41 91 36 C93 33 98 34 102 33 C99 29 93 28 88 31 C86 27 87 22 92 18 C83 15 74 17 68 22 C64 18 59 14 55 12Z" fill="#f5c500"/>
    <ellipse cx="55" cy="36" rx="8" ry="7" fill="#000"/>
  </svg>
);


export default AdminDashboard;
export { useDraggableOrder };
