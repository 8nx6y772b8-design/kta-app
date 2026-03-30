// Shared micro-components used across all modules
import { useState } from "react";
import { T, ROLE_META, TYPE_META, APPROVAL_META } from "./constants.js";

`;

// ─────────────────────────────────────────────────────────────────────────────
// MICRO COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
export const Pill = ({label,color,bg,sym,size="md"}) => (
  <span style={{display:"inline-flex",alignItems:"center",gap:4,background:bg,color,
    padding:size==="sm"?"2px 8px":"4px 10px",borderRadius:99,
    fontSize:size==="sm"?11:12,fontWeight:700,whiteSpace:"nowrap"}}>
    {sym&&<span style={{fontSize:size==="sm"?9:10}}>{sym}</span>}{label}
  </span>
);
export const RolePill = ({role, size="md", adminLevel=null}) => {
  const displayRole = role==="Admin" && adminLevel ? `Admin ${adminLevel}` : role;
  const m = ROLE_META[displayRole] || ROLE_META[role] || ROLE_META.Apprentice;
  return <Pill label={displayRole} color={m.color} bg={m.bg} sym={m.symbol} size={size}/>;
};
const TypePill = ({type,size="md"}) => { const m=TYPE_META[type]||TYPE_META["Other"]; return <Pill label={type} color={m.color} bg={m.bg} sym={m.sym} size={size}/> };
const AppvPill = ({status}) => { const m=APPROVAL_META[status]||APPROVAL_META.draft; return <Pill label={m.label} color={m.color} bg={m.bg} sym={m.sym} size="sm"/> };

export const FL = ({children,req}) => (
  <div style={{fontSize:12,fontWeight:700,color:T.sub,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>
    {children}{req&&<span style={{color:T.red}}> *</span>}
  </div>
);

export const Btn = ({children,onClick,v="primary",sm=false,disabled=false,full=false,style:sx={}}) => {
  const vs = {
    primary: {background:T.accent,color:"#fff",border:`1.5px solid ${T.accentD}`},
    ghost:   {background:T.surface,color:T.sub,border:`1.5px solid ${T.border}`},
    danger:  {background:T.redL,color:T.red,border:`1.5px solid ${T.red}44`},
    approve: {background:T.accentL,color:T.accent,border:`1.5px solid ${T.accent}55`},
    decline: {background:T.redL,color:T.red,border:`1.5px solid ${T.red}55`},
    blue:    {background:T.blueL,color:T.blue,border:`1.5px solid ${T.blue}55`},
    loginbtn:{background:T.accent,color:"#fff",border:`1.5px solid ${T.accentD}`,fontSize:17,padding:"13px 20px",borderRadius:10,fontWeight:700},
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...vs[v]||vs.primary,borderRadius:8,
      padding:sm?"5px 12px":"9px 16px",fontSize:sm?12:13,fontWeight:700,
      display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,
      opacity:disabled?0.45:1,width:full?"100%":undefined,...sx
    }}
      onMouseEnter={e=>{if(!disabled)e.currentTarget.style.filter="brightness(.93)";}}
      onMouseLeave={e=>{e.currentTarget.style.filter="none";}}>
      {children}
    </button>
  );
};

export const Card = ({children,style:sx={},onClick}) => (
  <div onClick={onClick} style={{background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:14,padding:20,...sx}}>
    {children}
  </div>
);
const StatCard = ({label,value,sub,color=T.accent}) => (
  <Card style={{paddingBlock:18}}>
    <div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:".7px",marginBottom:4}}>{label}</div>
    <div style={{fontSize:26,fontWeight:700,color,fontFamily:"'Libre Baskerville'"}}>{value}</div>
    {sub&&<div style={{fontSize:12,color:T.sub,marginTop:2}}>{sub}</div>}
  </Card>
);
export const Avatar = ({name,role,size=36}) => {
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
