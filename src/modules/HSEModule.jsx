import { useState, useEffect } from "react";
import { T } from "../constants.js";
import { uid, fmtD } from "../utils.js";
import { upsertRow, loadTable } from "../supabaseClient.js";
import { Btn, Card } from "../shared.jsx";

function HSE_YN({field, label, detailField, detailLabel, showDetailOn="No", form, sf}) {
  return (
    <div style={{marginBottom:16}}>
      <div style={{fontSize:14, fontWeight:700, color:T.ink, marginBottom:6}}>{label} <span style={{color:T.red}}>*</span></div>
      <div style={{display:"flex", gap:10, marginBottom:6}}>
        {["Yes","No"].map(opt=>(
          <button key={opt} onClick={()=>sf(field, opt)}
            style={{padding:"6px 22px", borderRadius:8, border:`1.5px solid ${form[field]===opt?(opt==="Yes"?T.teal:T.red):T.border}`,
              background:form[field]===opt?(opt==="Yes"?T.tealL:"#fff0f0"):T.surface,
              color:form[field]===opt?(opt==="Yes"?T.teal:"#c0392b"):T.ink,
              fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:"DM Sans,sans-serif", transition:"all .14s"}}>
            {opt}
          </button>
        ))}
      </div>
      {detailField && form[field]===showDetailOn && (
        <textarea value={form[detailField]} onChange={e=>sf(detailField,e.target.value)}
          placeholder={detailLabel||"Please provide details…"}
          rows={2}
          style={{width:"100%", border:`1px solid ${T.border}`, borderRadius:8, padding:"8px 10px",
            fontSize:14, fontFamily:"DM Sans,sans-serif", resize:"vertical", outline:"none",
            background:T.surface, color:T.ink, boxSizing:"border-box"}}/>
      )}
    </div>
  );
}
function HSE_TextInput({field, label, required, placeholder, rows=1, form, sf}) {
  return (
    <div style={{marginBottom:16}}>
      <div style={{fontSize:14, fontWeight:700, color:T.ink, marginBottom:6}}>{label}{required&&<span style={{color:T.red}}> *</span>}</div>
      {rows>1
        ? <textarea value={form[field]} onChange={e=>sf(field,e.target.value)} placeholder={placeholder||""} rows={rows}
            style={{width:"100%", border:`1px solid ${T.border}`, borderRadius:8, padding:"8px 10px",
              fontSize:14, fontFamily:"DM Sans,sans-serif", resize:"vertical", outline:"none",
              background:T.surface, color:T.ink, boxSizing:"border-box"}}/>
        : <input value={form[field]} onChange={e=>sf(field,e.target.value)} placeholder={placeholder||""}
            style={{width:"100%", border:`1px solid ${T.border}`, borderRadius:8, padding:"8px 10px",
              fontSize:14, fontFamily:"DM Sans,sans-serif", outline:"none",
              background:T.surface, color:T.ink, boxSizing:"border-box"}}/>
      }
    </div>
  );
}
function HSE_SectionHead({label}) {
  return (
    <div style={{fontSize:12, fontWeight:700, color:T.dark, textTransform:"uppercase",
      letterSpacing:".7px", marginBottom:14, paddingBottom:6,
      borderBottom:`2px solid ${T.border}`, marginTop:8}}>{label}</div>
  );
}

function HSECheckinForm({apprentice, viewer, onSave, onCancel}) {
  const today = (()=>{ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
  const [form, setForm] = useState({
    apprentice_name: apprentice?.name||"",
    date: today,
    host_business_name: apprentice?.hostBusiness||"",
    supervisor_name: "",
    site_address: "",
    ppe_correct_ppe: "",
    ppe_suitable_condition: "",
    ppe_items_attention: "",
    ppe_replacing: [],
    hard_hat_expiry: "",
    site_induction_toolbox: "",
    site_induction_details: "",
    hazard_register_location: "",
    allocated_breaks_facilities: "",
    breaks_facilities_details: "",
    near_miss_process_aware: "",
    near_miss_involved: "",
    near_miss_details: "",
    jsa_training: "",
    jsa_training_details: "",
    work_within_capabilities: "",
    capabilities_details: "",
    host_business_issues: "",
    host_business_issues_details: "",
    anything_else: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const sf = (k, v) => setForm(f=>({...f, [k]:v}));

  const handleSave = async () => {
    const required = ["apprentice_name","date","host_business_name","supervisor_name","site_address",
      "ppe_correct_ppe","ppe_suitable_condition","site_induction_toolbox","hazard_register_location",
      "allocated_breaks_facilities","near_miss_process_aware","near_miss_involved","jsa_training",
      "work_within_capabilities","host_business_issues"];
    const missing = required.find(k=>!form[k]);
    if(missing){ setErr("Please complete all required fields."); return; }
    setSaving(true); setErr("");
    try {
      const { ppe_replacing, hard_hat_expiry, ...formRest } = form;
      const row = {
        id: uid(),
        apprentice_id: apprentice.id,
        created_by: viewer?.id||null,
        created_at: new Date().toISOString(),
        ...formRest,
        ppe_items_replacing: JSON.stringify(ppe_replacing||[]),
        hard_hat_expiry: hard_hat_expiry||null,
      };
      await upsertRow("hse_checkins", row);

      // Auto-create PPE order if items need replacing
      const replacingItems = form.ppe_replacing||[];
      if(replacingItems.length > 0) {
        // Build items array matching PPE request format
        const ppeOrderItems = replacingItems.map(r=>({
          item: r.item,
          size: r.size||"",
          qtyReq: "1",
          qtyIssued: "",
          notes: "From HSE Check In " + form.date,
          approved: "Pending",
        }));
        const ppeRecord = {
          id: uid(),
          apprentice_id: apprentice.id,
          apprentice_name: apprentice.name,
          staff_id: viewer?.id||"",
          staff_name: viewer?.name||"",
          date_requested: form.date,
          date_issued: null,
          items: JSON.stringify(ppeOrderItems),
          created_at: new Date().toISOString(),
          notes: "Auto-created from HSE Check In",
        };
        await upsertRow("ppe_requests", ppeRecord).catch(e=>console.error("PPE order failed:", e));
      }

      onSave && onSave();
    } catch(e) {
      setErr("Save failed: "+e.message);
    }
    setSaving(false);
  };

  return (
    <div style={{padding:"20px 24px"}}>
      {/* Header */}
      <div style={{background:T.dark, borderRadius:"10px 10px 0 0", padding:"14px 20px", margin:"-20px -24px 20px",
        display:"flex", alignItems:"center", justifyContent:"space-between"}}>
        <div>
          <div style={{fontWeight:700, fontSize:17, color:"#fff"}}>Apprentice HSE Check In</div>
          <div style={{fontSize:12, color:"#ffffff88", marginTop:2}}>Kiwi Trade Apprentices · {apprentice?.name}</div>
        </div>
        <div style={{fontSize:22}}>🦺</div>
      </div>

      <HSE_SectionHead label="Apprentice / Host Details"/>
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12}}>
        <HSE_TextInput form={form} sf={sf} field="apprentice_name" label="Apprentice Name" required placeholder="Full name"/>
        <div style={{marginBottom:16}}>
          <div style={{fontSize:14, fontWeight:700, color:T.ink, marginBottom:6}}>Date <span style={{color:T.red}}>*</span></div>
          <input type="date" value={form.date} onChange={e=>sf("date",e.target.value)}
            style={{width:"100%", border:`1px solid ${T.border}`, borderRadius:8, padding:"8px 10px",
              fontSize:14, fontFamily:"DM Sans,sans-serif", outline:"none", background:T.surface, color:T.ink, boxSizing:"border-box"}}/>
        </div>
      </div>
      <HSE_TextInput form={form} sf={sf} field="host_business_name" label="Host Business Name" required placeholder="e.g. Wairarapa Electrical"/>
      <HSE_TextInput form={form} sf={sf} field="supervisor_name" label="Supervisor Name" required placeholder="On-site supervisor"/>
      <HSE_TextInput form={form} sf={sf} field="site_address" label="Site Address" required placeholder="Street address or location"/>

      <HSE_SectionHead label="PPE"/>
      <HSE_YN form={form} sf={sf} field="ppe_correct_ppe" label="Is the Apprentice wearing the correct PPE?"/>
      <HSE_YN form={form} sf={sf} field="ppe_suitable_condition" label="Is all PPE suitable for the tasks/site and in good condition?"/>
      {/* PPE Items Needing Replacing — compact picker */}
      <div style={{marginBottom:16}}>
        <div style={{fontSize:14, fontWeight:700, color:T.ink, marginBottom:8}}>Which item(s) need replacing?</div>
        <div style={{display:"flex", flexWrap:"wrap", gap:6, marginBottom:8}}>
          {PPE_CATALOGUE.filter((p,i,a)=>(p.item!=="Other"||i===a.findIndex(x=>x.item==="Other"))&&p.item!=="GMAX Respirator").map((cat,ci)=>{
            const selected = (form.ppe_replacing||[]).find(x=>x.item===cat.item);
            const isActive = !!selected;
            return (
              <div key={ci} style={{position:"relative", display:"inline-flex", alignItems:"center", gap:0}}>
                <button
                  onClick={()=>{
                    const cur = form.ppe_replacing||[];
                    if(isActive) sf("ppe_replacing", cur.filter(x=>x.item!==cat.item));
                    else sf("ppe_replacing", [...cur, {item:cat.item, size:""}]);
                  }}
                  style={{padding:"5px 12px", borderRadius:cat.sizes.length>0&&isActive?"6px 0 0 6px":"6px",
                    border:`1.5px solid ${isActive?"#e05c5c":T.border}`,
                    background:isActive?"#fff0f0":T.surface,
                    color:isActive?"#c0392b":T.ink,
                    fontSize:13, fontWeight:isActive?700:400, cursor:"pointer",
                    fontFamily:"DM Sans,sans-serif", transition:"all .14s",
                    borderRight:cat.sizes.length>0&&isActive?"none":undefined}}>
                  {cat.item}
                </button>
                {cat.sizes.length>0 && isActive && (
                  <select value={selected.size} onChange={e=>{
                    sf("ppe_replacing", (form.ppe_replacing||[]).map(x=>x.item===cat.item?{...x,size:e.target.value}:x));
                  }}
                  style={{padding:"5px 8px", borderRadius:"0 6px 6px 0",
                    border:`1.5px solid #e05c5c`, borderLeft:"none",
                    background:"#fff0f0", color:"#c0392b",
                    fontSize:13, fontWeight:700, cursor:"pointer",
                    fontFamily:"DM Sans,sans-serif", outline:"none", height:"100%"}}>
                    <option value="">Size</option>
                    {cat.sizes.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </div>
        {(form.ppe_replacing||[]).length>0 && (
          <div style={{fontSize:12, color:T.sub, marginTop:4}}>
            Selected: {(form.ppe_replacing||[]).map(x=>x.item+(x.size?` (${x.size})`:"")).join(", ")}
          </div>
        )}
      </div>
      {/* Hard Hat Expiry */}
      <div style={{marginBottom:16}}>
        <div style={{fontSize:14, fontWeight:700, color:T.ink, marginBottom:6}}>Hard Hat Expiry Date</div>
        <input type="date" value={form.hard_hat_expiry} onChange={e=>sf("hard_hat_expiry",e.target.value)}
          style={{border:`1px solid ${T.border}`, borderRadius:8, padding:"8px 10px",
            fontSize:14, fontFamily:"DM Sans,sans-serif", outline:"none",
            background:T.surface, color:T.ink}}/>
      </div>
      <HSE_YN form={form} sf={sf} field="site_induction_toolbox" label="Have you completed a Site Induction and are involved in Toolbox Meetings?" detailField="site_induction_details" detailLabel="Please provide details…"/>
      <HSE_YN form={form} sf={sf} field="hazard_register_location" label="Do you know the location of the Hazard Register / Board?"/>
      <HSE_YN form={form} sf={sf} field="allocated_breaks_facilities" label="Are you taking allocated breaks and have access to facilities? (e.g. Toilet, Kitchen, Water, Shelter)" detailField="breaks_facilities_details" detailLabel="Please provide details…"/>

      <HSE_SectionHead label="Near Miss / Incidents"/>
      <HSE_YN form={form} sf={sf} field="near_miss_process_aware" label="Are you aware of the process for reporting a Near Miss or Incident?"/>
      <HSE_YN form={form} sf={sf} field="near_miss_involved" label="Since our last Check In, have you been involved in or witnessed any Near Misses or Incidents?" detailField="near_miss_details" detailLabel="Details of Near Miss or Incident (not to be used in place of Incident / Near Miss Forms)" showDetailOn="Yes"/>
      <HSE_YN form={form} sf={sf} field="jsa_training" label="Have you undergone any training that required Task or Job Safety Analysis?" detailField="jsa_training_details" detailLabel="Please explain…" showDetailOn="Yes"/>
      <HSE_YN form={form} sf={sf} field="work_within_capabilities" label="Is the work you are doing within your capabilities?" detailField="capabilities_details" detailLabel="Please explain…" showDetailOn="No"/>

      <HSE_SectionHead label="Workplace"/>
      <HSE_YN form={form} sf={sf} field="host_business_issues" label="Any issues with the Host Business, Supervisor or Team that we need to be aware of?" detailField="host_business_issues_details" detailLabel="Please explain…" showDetailOn="Yes"/>
      <HSE_TextInput form={form} sf={sf} field="anything_else" label="Is there anything else you would like to add?" placeholder="Any additional comments…" rows={3}/>

      {err && <div style={{color:T.red, fontSize:13, marginBottom:12, fontWeight:600}}>{err}</div>}

      <div style={{display:"flex", gap:10, marginTop:8}}>
        <Btn onClick={handleSave} disabled={saving}>{saving?"Saving…":"Save HSE Check In"}</Btn>
        <Btn onClick={onCancel} style={{background:T.surface, color:T.ink, border:`1px solid ${T.border}`}}>Cancel</Btn>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAST HSE CHECK INS
// ─────────────────────────────────────────────────────────────────────────────
function PastHSECheckins({apprentice, allUsers, canEdit=false}) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandId, setExpandId] = useState(null);

  useEffect(()=>{
    loadTable("hse_checkins")
      .then(rows=>setRecords(rows.filter(r=>r.apprentice_id===apprentice.id).sort((a,b)=>(b.date||b.created_at||"").localeCompare(a.date||a.created_at||""))))
      .catch(()=>setRecords([]))
      .finally(()=>setLoading(false));
  },[apprentice.id]);

  const handleDelete = async (id) => {
    if(!await ktaConfirm("Delete this HSE check in?")) return;
    await deleteRow("hse_checkins", id).catch(console.error);
    setRecords(prev=>prev.filter(r=>r.id!==id));
  };

  const fD = iso => { if(!iso) return "—"; try{ const[y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; }catch{ return iso; } };

  const Row = ({label, value, yn}) => {
    if(!value && value!==0) return null;
    const isYes = value==="Yes";
    const isNo  = value==="No";
    return (
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:4, padding:"7px 0",
        borderBottom:`1px solid ${T.border}`}}>
        <div style={{fontSize:13, color:T.sub}}>{label}</div>
        <div style={{fontSize:13, fontWeight:600,
          color: yn ? (isYes?T.teal:isNo?"#c0392b":T.ink) : T.ink}}>
          {yn && <span style={{marginRight:4}}>{isYes?"✓":isNo?"✕":"—"}</span>}{value}
        </div>
      </div>
    );
  };

  if(loading) return <div style={{padding:24, textAlign:"center", color:T.muted, fontSize:14}}>Loading…</div>;

  return (
    <div>
      <div style={{fontWeight:700, fontSize:15, color:T.ink, padding:"12px 16px 8px",
        borderBottom:`1px solid ${T.border}`, display:"flex", alignItems:"center", gap:8}}>
        <span>🦺</span> HSE Check In History
        <span style={{marginLeft:"auto", fontSize:12, color:T.muted, fontWeight:400}}>{records.length} record{records.length!==1?"s":""}</span>
      </div>
      {records.length===0 && (
        <div style={{padding:"24px 0", textAlign:"center", color:T.muted, fontSize:14, fontStyle:"italic"}}>No HSE check ins yet</div>
      )}
      {records.map(r=>{
        const isOpen = expandId===r.id;
        const createdBy = allUsers.find(u=>u.id===r.created_by);
        return (
          <div key={r.id} style={{border:`1.5px solid ${T.border}`, borderRadius:10, marginBottom:10, overflow:"hidden"}}>
            <div onClick={()=>setExpandId(isOpen?null:r.id)} style={{
              display:"flex", alignItems:"center", gap:12, padding:"12px 16px",
              background:isOpen?"#c0392b":T.surface, cursor:"pointer",
              borderBottom:isOpen?`1px solid ${T.border}`:"none", transition:"background .15s"}}>
              <div style={{width:34,height:34,borderRadius:8,
                background:isOpen?"#ffffff20":"#fff0f0",
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>🦺</div>
              <div style={{flex:1}}>
                <div style={{fontWeight:700, fontSize:15, color:isOpen?"#fff":T.ink}}>
                  {fD(r.date)}{r.site_address?` — ${r.site_address}`:""}
                </div>
                <div style={{fontSize:12, color:isOpen?"#ffffff88":T.sub, marginTop:1}}>
                  {r.host_business_name||"—"}{createdBy?` · By ${createdBy.name}`:""}
                </div>
              </div>
              {canEdit && <button onClick={e=>{e.stopPropagation();handleDelete(r.id);}}
                style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:isOpen?"#ffffff88":T.muted,padding:"2px 6px"}}>🗑</button>}
              <div style={{fontSize:12, color:isOpen?"#ffffff66":T.muted}}>{isOpen?"▲ collapse":"▼ view"}</div>
            </div>
            {isOpen && (
              <div style={{padding:"16px", background:"#fff"}}>
                <div style={{fontSize:12,fontWeight:700,color:T.dark,textTransform:"uppercase",letterSpacing:".6px",marginBottom:8}}>Apprentice / Host Details</div>
                <Row label="Apprentice" value={r.apprentice_name}/>
                <Row label="Host Business" value={r.host_business_name}/>
                <Row label="Supervisor" value={r.supervisor_name}/>
                <Row label="Site Address" value={r.site_address}/>

                <div style={{fontSize:12,fontWeight:700,color:T.dark,textTransform:"uppercase",letterSpacing:".6px",margin:"14px 0 8px"}}>PPE</div>
                <Row label="Correct PPE worn?" value={r.ppe_correct_ppe} yn/>
                <Row label="PPE suitable & in good condition?" value={r.ppe_suitable_condition} yn/>
                <Row label="Items needing attention" value={r.ppe_items_attention}/>
                {r.ppe_items_replacing && (() => { try { const items=JSON.parse(r.ppe_items_replacing); return items.length>0?<Row label="Items to replace" value={items.map(x=>x.item+(x.size?` (${x.size})`:"")).join(", ")}/>:null; } catch{ return null; } })()}
                {r.hard_hat_expiry && <Row label="Hard Hat Expiry" value={fD(r.hard_hat_expiry)}/>}
                <Row label="Site induction & toolbox meetings?" value={r.site_induction_toolbox} yn/>
                <Row label="Site induction details" value={r.site_induction_details}/>
                <Row label="Knows hazard register location?" value={r.hazard_register_location} yn/>
                <Row label="Taking allocated breaks & has facilities access?" value={r.allocated_breaks_facilities} yn/>
                <Row label="Breaks/facilities details" value={r.breaks_facilities_details}/>

                <div style={{fontSize:12,fontWeight:700,color:T.dark,textTransform:"uppercase",letterSpacing:".6px",margin:"14px 0 8px"}}>Near Miss / Incidents</div>
                <Row label="Aware of Near Miss reporting process?" value={r.near_miss_process_aware} yn/>
                <Row label="Involved in/witnessed Near Misses?" value={r.near_miss_involved} yn/>
                <Row label="Near Miss details" value={r.near_miss_details}/>
                <Row label="JSA training completed?" value={r.jsa_training} yn/>
                <Row label="JSA training details" value={r.jsa_training_details}/>
                <Row label="Work within capabilities?" value={r.work_within_capabilities} yn/>
                <Row label="Capabilities details" value={r.capabilities_details}/>

                <div style={{fontSize:12,fontWeight:700,color:T.dark,textTransform:"uppercase",letterSpacing:".6px",margin:"14px 0 8px"}}>Workplace</div>
                <Row label="Host Business/Supervisor issues?" value={r.host_business_issues} yn/>
                <Row label="Issues details" value={r.host_business_issues_details}/>
                <Row label="Anything else" value={r.anything_else}/>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


// ── EarnLearn Progress Snapshot ───────────────────────────────────────────────
// Parses an EarnLearn PDF report using Claude API, stores a monthly snapshot
// in Supabase (progress_snapshots table), and renders a line graph of
// overall completion % vs months in training over time.


export { HSECheckinForm, PastHSECheckins };
