import { useState, useEffect } from "react";
import { T } from "../constants.js";
import { uid, fmtD, sendKTAEmail } from "../utils.js";
import { upsertRow, loadTable, deleteRow } from "../supabaseClient.js";
import { Btn, Card } from "../shared.jsx";

function PPEAllocation({apprentice, mentor, canEdit=false}) {
  const today = new Date().toISOString().slice(0,10);
  const blankRows = () => PPE_CATALOGUE.map(p=>({item:p.item, size:"", qtyReq:"", qtyIssued:"", notes:"", approved:""}));

  const [requests, setRequests]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [showForm, setShowForm]         = useState(false);
  const [rows, setRows]                 = useState(blankRows());
  const [dateRequested, setDateReq]     = useState(today);
  const [dateIssued, setDateIssued]     = useState("");
  const [saving, setSaving]             = useState(false);
  const [expandId, setExpandId]         = useState(null);
  const [editReqId, setEditReqId]       = useState(null);
  const [editRows, setEditRows]         = useState([]);
  const [editDateIssued, setEditDateIssued] = useState("");
  const [savingEdit, setSavingEdit]     = useState(false);

  const startEditReq = (r) => {
    const items = (() => { try { return JSON.parse(r.items); } catch { return []; } })();
    setEditRows(items.map(it=>({...it})));
    setEditDateIssued(r.date_issued||"");
    setEditReqId(r.id);
    setExpandId(r.id);
  };

  const fmtD = iso => { if(!iso) return "—"; const [y,m,d]=(iso||"").split("-"); return `${d}/${m}/${y}`; };

  // Build and send the "PPE Fully Issued" email to admin@kta.org.nz
  const sendPPEIssuedEmail = async (issuedItems, dateIssuedVal, dateReqVal) => {
    const issuedRows = issuedItems.filter(it => parseFloat(it.qtyIssued||0) > 0);
    const tableRows = issuedRows.map(it => `<tr>
      <td style="padding:9px 12px;font-weight:700;color:#0d1b2e;border-bottom:1px solid #edf2f7">${it.item}</td>
      <td style="padding:9px 12px;color:#4a5a72;border-bottom:1px solid #edf2f7">${it.size||"—"}</td>
      <td style="padding:9px 12px;text-align:center;font-weight:700;font-size:16.5px;color:#1a8a7a;border-bottom:1px solid #edf2f7">${it.qtyIssued}</td>
      <td style="padding:9px 12px;color:#888;font-style:italic;border-bottom:1px solid #edf2f7">${it.notes||""}</td>
    </tr>`).join("");

    const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:20px;background:#f0f4f9;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:#1b4f8c;padding:20px 28px">
    <div style="font-size:12.1px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">KTA Workforce Management</div>
    <div style="font-size:22px;font-weight:700;color:#fff">PPE Fully Issued — ${apprentice.name}</div>
    <div style="font-size:13.2px;color:rgba(255,255,255,.7);margin-top:4px">All requested PPE has been issued</div>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-bottom:2px solid #dce8f7">
    <tr>
      <td style="padding:12px 16px;border-right:1px solid #dce8f7;width:33%">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">Apprentice</div>
        <div style="font-size:14.3px;font-weight:700;color:#0d1b2e">${apprentice.name}</div>
      </td>
      <td style="padding:12px 16px;border-right:1px solid #dce8f7;width:33%">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">Host Business</div>
        <div style="font-size:14.3px;font-weight:700;color:#0d1b2e">${apprentice.hostBusiness||"—"}</div>
      </td>
      <td style="padding:12px 16px;width:33%">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">KTA Staff</div>
        <div style="font-size:14.3px;font-weight:700;color:#0d1b2e">${mentor?.name||"—"}</div>
      </td>
    </tr>
    <tr style="border-top:1px solid #dce8f7">
      <td style="padding:10px 16px;border-right:1px solid #dce8f7">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">Date Requested</div>
        <div style="font-size:14.3px;color:#0d1b2e">${fmtD(dateReqVal)}</div>
      </td>
      <td colspan="2" style="padding:10px 16px">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">Date Issued</div>
        <div style="font-size:14.3px;color:#0d1b2e">${dateIssuedVal ? fmtD(dateIssuedVal) : fmtD(new Date().toISOString().slice(0,10))}</div>
      </td>
    </tr>
  </table>
  <div style="padding:20px 28px 10px">
    <div style="font-size:17.6px;font-weight:700;color:#1a8a7a;margin-bottom:2px">✅ PPE Issued</div>
    <div style="font-size:12.1px;color:#888">All items have been issued to ${apprentice.name}</div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14.3px">
    <thead><tr style="background:#d4f0ec">
      <th style="padding:9px 12px;text-align:left;font-size:11px;color:#1a8a7a;text-transform:uppercase;letter-spacing:.7px">PPE Item</th>
      <th style="padding:9px 12px;text-align:left;font-size:11px;color:#1a8a7a;text-transform:uppercase;letter-spacing:.7px">Size / Spec</th>
      <th style="padding:9px 12px;text-align:center;font-size:11px;color:#1a8a7a;text-transform:uppercase;letter-spacing:.7px">Qty Issued</th>
      <th style="padding:9px 12px;text-align:left;font-size:11px;color:#1a8a7a;text-transform:uppercase;letter-spacing:.7px">Notes</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div style="padding:14px 28px;background:#f8fafc;border-top:1px solid #dce8f7;margin-top:20px">
    <div style="font-size:12.1px;color:#8fa0b8">KTA Workforce Management &nbsp;·&nbsp; payroll@kta.org.nz</div>
  </div>
</div></body></html>`;

    await sendKTAEmail({
      to: "admin@kta.org.nz",
      subject: `PPE Fully Issued — ${apprentice.name} (${fmtD(dateReqVal)})`,
      html: emailHtml,
    }).catch(err => console.warn("PPE issued email failed:", err));
  };

  const saveEditReq = async (r) => {
    setSavingEdit(true);
    try {
      const wasComplete = r.completed;
      const updated = {...r, items: JSON.stringify(editRows), date_issued: editDateIssued||null,
        completed: editRows.filter(it=>parseFloat(it.qtyReq||0)>0).every(it=>it.approved==="Yes") ? true : r.completed};
      await upsertRow("ppe_requests", {id:r.id, items:JSON.stringify(editRows), date_issued:editDateIssued||null, completed:updated.completed});
      setRequests(prev=>prev.map(x=>x.id===r.id?{...x,...updated}:x));
      setEditReqId(null);
      // Send completion email only when transitioning to completed for the first time
      if(!wasComplete && updated.completed) {
        await sendPPEIssuedEmail(editRows, editDateIssued, r.date_requested);
      }
    } catch(e) { alert("Save failed: "+e.message); }
    setSavingEdit(false);
  };

  const markComplete = async (r) => {
    const items = (() => { try { return JSON.parse(r.items); } catch { return []; } })();
    const fullyIssued = items.map(it=>({...it, qtyIssued:it.qtyReq, approved:"Yes"}));
    try {
      await upsertRow("ppe_requests", {id:r.id, items:JSON.stringify(fullyIssued), completed:true});
      setRequests(prev=>prev.map(x=>x.id===r.id?{...x,items:JSON.stringify(fullyIssued),completed:true}:x));
      // Only send if not already completed
      if(!r.completed) {
        await sendPPEIssuedEmail(fullyIssued, r.date_issued, r.date_requested);
      }
    } catch(e) { alert("Failed: "+e.message); }
  };

  const fmtDate = iso => { if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };

  useEffect(()=>{
    loadTable("ppe_requests")
      .then(rows=>setRequests(rows.filter(r=>r.apprentice_id===apprentice.id).sort((a,b)=>b.date_requested.localeCompare(a.date_requested))))
      .catch(()=>setRequests([]))
      .finally(()=>setLoading(false));
  },[apprentice.id]);

  const sr = (idx,k,v) => setRows(prev=>prev.map((r,i)=>i===idx?{...r,[k]:v}:r));

  const handleSubmit = async () => {
    const activeRows = rows.filter(r=>r.qtyReq||r.qtyIssued||r.notes);
    if(!activeRows.length){ alert("Please enter at least one item quantity."); return; }
    setSaving(true);
    const record = {
      id: uid(),
      apprentice_id: apprentice.id,
      apprentice_name: apprentice.name,
      staff_id: mentor?.id||"",
      staff_name: mentor?.name||"",
      date_requested: dateRequested,
      date_issued: dateIssued||null,
      items: JSON.stringify(activeRows),
      created_at: new Date().toISOString(),
    };
    try {
      await upsertRow("ppe_requests", record);
      setRequests(prev=>[record,...prev]);

      // Build email HTML
      const fmtD = iso => { if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };

      // Traffic-light rows: not-issued (red ✗) first, then issued (green ✓)
      const notIssuedRows = activeRows.filter(it => !(parseFloat(it.qtyIssued||0) > 0) && parseFloat(it.qtyReq||0) > 0);
      const issuedRows    = activeRows.filter(it => parseFloat(it.qtyIssued||0) > 0);

      const buildRow = (it, issued) => {
        const rowBg    = issued ? "#f0faf8" : "#fff5f5";
        const badge    = issued
          ? `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700;background:#d4f0ec;color:#1a8a7a">✓ Issued</span>`
          : `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700;background:#fde8e8;color:#c0392b">✗ To Order</span>`;
        const qty      = issued ? it.qtyIssued : parseFloat(it.qtyReq||0) - parseFloat(it.qtyIssued||0);
        const qtyColor = issued ? "#1a8a7a" : "#c0392b";
        return `<tr style="background:${rowBg}">
          <td style="padding:10px 12px;font-weight:700;color:#0d1b2e;border-bottom:1px solid #edf2f7">${it.item}</td>
          <td style="padding:10px 12px;color:#4a5a72;border-bottom:1px solid #edf2f7">${it.size||"—"}</td>
          <td style="padding:10px 12px;text-align:center;font-weight:700;font-size:16px;color:${qtyColor};border-bottom:1px solid #edf2f7">${qty}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #edf2f7">${badge}</td>
          <td style="padding:10px 12px;color:#888;font-style:italic;border-bottom:1px solid #edf2f7">${it.notes||""}</td>
        </tr>`;
      };

      const allTableRows = [
        ...notIssuedRows.map(it => buildRow(it, false)),
        ...issuedRows.map(it => buildRow(it, true)),
      ].join("");

      const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:20px;background:#f0f4f9;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:#1b4f8c;padding:20px 28px">
    <div style="font-size:12.1px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">KTA Workforce Management</div>
    <div style="font-size:22px;font-weight:700;color:#fff">PPE Request — ${apprentice.name}</div>
    <div style="font-size:13.2px;color:rgba(255,255,255,.7);margin-top:4px">All items issued new and non-returnable</div>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-bottom:2px solid #dce8f7">
    <tr>
      <td style="padding:12px 16px;border-right:1px solid #dce8f7;width:25%">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">Apprentice</div>
        <div style="font-size:14.3px;font-weight:700;color:#0d1b2e">${apprentice.name}</div>
      </td>
      <td style="padding:12px 16px;border-right:1px solid #dce8f7;width:25%">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">Host Business</div>
        <div style="font-size:14.3px;font-weight:700;color:#0d1b2e">${apprentice.hostBusiness||"—"}</div>
      </td>
      <td style="padding:12px 16px;border-right:1px solid #dce8f7;width:25%">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">Trade</div>
        <div style="font-size:14.3px;font-weight:700;color:#0d1b2e">${apprentice.trade||"—"}</div>
      </td>
      <td style="padding:12px 16px;width:25%">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">KTA Staff</div>
        <div style="font-size:14.3px;font-weight:700;color:#0d1b2e">${mentor?.name||"—"}</div>
      </td>
    </tr>
    <tr style="border-top:1px solid #dce8f7">
      <td style="padding:10px 16px;border-right:1px solid #dce8f7">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">Date Requested</div>
        <div style="font-size:14.3px;color:#0d1b2e">${fmtD(dateRequested)}</div>
      </td>
      <td colspan="3" style="padding:10px 16px">
        <div style="font-size:11px;color:#8fa0b8;text-transform:uppercase;letter-spacing:.7px;font-weight:700;margin-bottom:3px">Date Issued</div>
        <div style="font-size:14.3px;color:#0d1b2e">${dateIssued?fmtD(dateIssued):"Not yet issued"}</div>
      </td>
    </tr>
  </table>
  <div style="padding:20px 28px 10px">
    <div style="font-size:17.6px;font-weight:700;color:#0d1b2e;margin-bottom:2px">PPE Items</div>
    <div style="font-size:12.1px;color:#888">
      ${notIssuedRows.length > 0 ? `<span style="color:#c0392b;font-weight:700">${notIssuedRows.length} to order</span>` : ""}
      ${notIssuedRows.length > 0 && issuedRows.length > 0 ? " &nbsp;·&nbsp; " : ""}
      ${issuedRows.length > 0 ? `<span style="color:#1a8a7a;font-weight:700">${issuedRows.length} already issued</span>` : ""}
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14.3px">
    <thead><tr style="background:#eef2f8">
      <th style="padding:9px 12px;text-align:left;font-size:11px;color:#4a5a72;text-transform:uppercase;letter-spacing:.7px">PPE Item</th>
      <th style="padding:9px 12px;text-align:left;font-size:11px;color:#4a5a72;text-transform:uppercase;letter-spacing:.7px">Size / Spec</th>
      <th style="padding:9px 12px;text-align:center;font-size:11px;color:#4a5a72;text-transform:uppercase;letter-spacing:.7px">Qty</th>
      <th style="padding:9px 12px;text-align:left;font-size:11px;color:#4a5a72;text-transform:uppercase;letter-spacing:.7px">Status</th>
      <th style="padding:9px 12px;text-align:left;font-size:11px;color:#4a5a72;text-transform:uppercase;letter-spacing:.7px">Notes</th>
    </tr></thead>
    <tbody>${allTableRows}</tbody>
  </table>
  <div style="margin:20px 28px;padding:14px 16px;background:#fdf3d4;border-radius:8px;border-left:3px solid #a07820">
    <div style="font-size:13.2px;color:#4a5a72;font-style:italic;line-height:1.6">I request the PPE items listed above. I understand that all items are provided new and are mine to keep. I agree to use them appropriately and in accordance with health and safety requirements.</div>
  </div>
  <div style="padding:14px 28px;background:#f8fafc;border-top:1px solid #dce8f7">
    <div style="font-size:12.1px;color:#8fa0b8">KTA Workforce Management &nbsp;·&nbsp; payroll@kta.org.nz</div>
  </div>
</div></body></html>`;

      await sendKTAEmail({
        to: "admin@kta.org.nz",
        subject: `PPE Request — ${apprentice.name} (${fmtD(dateRequested)})`,
        html: emailHtml,
      }).catch(err=>console.warn("Email failed:", err));

      setShowForm(false);
      setRows(blankRows());
      setDateReq(today);
      setDateIssued("");
    } catch(e){ alert("Failed to save: "+e.message); }
    setSaving(false);
  };

  const handleDelete = async (id) => {
    if(!await ktaConfirm("Delete this PPE request?")) return;
    await deleteRow("ppe_requests", id).catch(console.error);
    setRequests(prev=>prev.filter(r=>r.id!==id));
  };

  if(loading) return <div style={{padding:16,textAlign:"center",color:T.muted,fontSize:14}}>Loading…</div>;

  return (
    <div>
      {canEdit&&(
        <div style={{marginBottom:14}}>
          <Btn sm onClick={()=>setShowForm(s=>!s)}>{showForm?"✕ Cancel":"+ New PPE Request"}</Btn>
        </div>
      )}

      {showForm&&(
        <Card style={{border:`1.5px solid ${T.teal}44`,marginBottom:16,padding:0,overflow:"hidden"}}>
          {/* Header */}
          <div style={{background:T.teal,padding:"12px 16px"}}>
            <div style={{fontWeight:700,fontSize:16,color:"#fff"}}>PPE Request — {apprentice.name}</div>
            <div style={{fontSize:13,color:"rgba(255,255,255,.8)",marginTop:2}}>All items issued new and non-returnable</div>
          </div>

          {/* Info strip */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:12,padding:"14px 16px",background:T.bg,borderBottom:`1px solid ${T.border}`}}>
            <div>
              <FL>Apprentice</FL>
              <div style={{fontSize:14,fontWeight:700,color:T.ink,padding:"6px 10px",background:T.surface,borderRadius:7,border:`1px solid ${T.border}`}}>{apprentice.name}</div>
            </div>
            <div>
              <FL>KTA Staff</FL>
              <div style={{fontSize:14,fontWeight:700,color:T.ink,padding:"6px 10px",background:T.surface,borderRadius:7,border:`1px solid ${T.border}`}}>{mentor?.name||"—"}</div>
            </div>
            <div>
              <FL req>Date Requested</FL>
              <input type="date" value={dateRequested} onChange={e=>setDateReq(e.target.value)}/>
            </div>
            <div>
              <FL>Date Issued</FL>
              <input type="date" value={dateIssued} onChange={e=>setDateIssued(e.target.value)}/>
            </div>
          </div>

          {/* Items table */}
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
              <thead>
                <tr style={{background:T.accentL}}>
                  {["PPE Item","Size / Spec","Qty Requested","Qty Issued","Notes","Approved"].map(h=>(
                    <th key={h} style={{padding:"8px 10px",textAlign:"left",fontWeight:700,fontSize:12,color:T.accent,borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PPE_CATALOGUE.map((cat,i)=>(
                  <tr key={i} style={{background:i%2===0?T.surface:T.bg}}>
                    <td style={{padding:"6px 10px",fontWeight:700,color:T.ink,whiteSpace:"nowrap",borderBottom:`1px solid ${T.border}44`}}>{cat.item}</td>
                    <td style={{padding:"4px 6px",borderBottom:`1px solid ${T.border}44`}}>
                      {cat.sizes.length>0
                        ? <select value={rows[i].size} onChange={e=>sr(i,"size",e.target.value)} style={{fontSize:12,padding:"3px 6px",minWidth:90}}>
                            <option value="">—</option>
                            {cat.sizes.map(s=><option key={s}>{s}</option>)}
                          </select>
                        : <input value={rows[i].size} onChange={e=>sr(i,"size",e.target.value)} placeholder="Specify…" style={{fontSize:12,padding:"3px 6px",width:90}}/>
                      }
                    </td>
                    <td style={{padding:"4px 6px",borderBottom:`1px solid ${T.border}44`}}>
                      <input type="number" min="0" value={rows[i].qtyReq} onChange={e=>{
                        const req=e.target.value;
                        const issued=rows[i].qtyIssued;
                        const autoApproved=issued&&req?(parseFloat(issued)===parseFloat(req)?"Yes":"Pending"):""; 
                        setRows(prev=>prev.map((r,idx)=>idx===i?{...r,qtyReq:req,...(issued?{approved:autoApproved}:{})}:r));
                      }} style={{fontSize:12,padding:"3px 6px",width:56,textAlign:"center"}}/>
                    </td>
                    <td style={{padding:"4px 6px",borderBottom:`1px solid ${T.border}44`}}>
                      <input type="number" min="0" value={rows[i].qtyIssued} onChange={e=>{
                        const issued=e.target.value;
                        const req=rows[i].qtyReq;
                        const autoApproved=issued&&req?(parseFloat(issued)===parseFloat(req)?"Yes":"Pending"):""; 
                        setRows(prev=>prev.map((r,idx)=>idx===i?{...r,qtyIssued:issued,approved:autoApproved}:r));
                      }} style={{fontSize:12,padding:"3px 6px",width:56,textAlign:"center"}}/>
                    </td>
                    <td style={{padding:"4px 6px",borderBottom:`1px solid ${T.border}44`}}>
                      <input value={rows[i].notes} onChange={e=>sr(i,"notes",e.target.value)} placeholder="Notes…" style={{fontSize:12,padding:"3px 6px",width:"100%",minWidth:120}}/>
                    </td>
                    <td style={{padding:"4px 6px",borderBottom:`1px solid ${T.border}44`}}>
                      <select value={rows[i].approved} onChange={e=>sr(i,"approved",e.target.value)} style={{fontSize:12,padding:"3px 6px"}}>
                        <option value="">—</option>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                        <option value="Pending">Pending</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Acknowledgement */}
          <div style={{margin:"12px 16px",padding:"10px 14px",background:T.warnL,borderRadius:8,border:`1px solid ${T.warn}44`,fontSize:13,color:T.sub,fontStyle:"italic"}}>
            I request the PPE items listed above. I understand that all items are provided new and are mine to keep. I agree to use them appropriately and in accordance with health and safety requirements.
          </div>

          {/* Signatures */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,padding:"0 16px 16px"}}>
            {[{label:"Apprentice Signature", name:apprentice.name},{label:"KTA Staff Signature", name:mentor?.name||""}].map(({label,name})=>(
              <div key={label} style={{border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 14px",background:T.surface}}>
                <div style={{fontSize:12,fontWeight:700,color:T.muted,marginBottom:6}}>{label}</div>
                <div style={{fontSize:14,fontWeight:700,color:T.ink,marginBottom:12}}>{name}</div>
                <div style={{borderBottom:`2px solid ${T.border}`,marginBottom:4,height:28}}/>
                <div style={{fontSize:11,color:T.muted}}>Signature</div>
              </div>
            ))}
          </div>

          <div style={{padding:"0 16px 16px",display:"flex",gap:8}}>
            <Btn onClick={handleSubmit} disabled={saving}>{saving?"Saving…":"Save Request"}</Btn>
            <Btn v="ghost" onClick={()=>{setShowForm(false);setRows(blankRows());}}>Cancel</Btn>
          </div>
        </Card>
      )}

      {/* Past requests */}
      {requests.length===0&&!showForm&&(
        <div style={{padding:"24px 0",textAlign:"center",color:T.muted,fontSize:14,fontStyle:"italic"}}>No PPE requests yet</div>
      )}
      {requests.length>0&&(
        <div style={{border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
          <div style={{padding:"8px 14px",background:T.bg,borderBottom:`1px solid ${T.border}`,fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".5px"}}>
            Past Requests
          </div>
          {requests.map((r,i)=>{
            const items = (() => { try { return JSON.parse(r.items); } catch { return []; } })();
            const isOpen = expandId===r.id;
            return (
              <div key={r.id} style={{borderBottom:i<requests.length-1?`1px solid ${T.border}44`:"none"}}>
                {/* Row header */}
                <div onClick={()=>{if(editReqId===r.id)return;setExpandId(isOpen?null:r.id);}}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",cursor:"pointer",
                    background:r.completed?T.tealL:isOpen?T.accentL:i%2===0?T.surface:T.bg,transition:"background .15s"}}>
                  <div style={{flex:1,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                    <span style={{fontWeight:700,fontSize:14,color:T.ink}}>Requested {fmtDate(r.date_requested)}</span>
                    {r.date_issued&&<span style={{fontSize:13,color:T.teal}}>· Issued {fmtDate(r.date_issued)}</span>}
                    <span style={{fontSize:13,color:T.muted}}>· {items.filter(it=>parseFloat(it.qtyReq||0)>0).length} item{items.filter(it=>parseFloat(it.qtyReq||0)>0).length!==1?"s":""}</span>
                    {r.completed
                      ? <span style={{padding:"2px 10px",borderRadius:99,fontSize:12,fontWeight:700,background:T.tealL,color:T.teal,border:`1px solid ${T.teal}44`}}>✓ Completed</span>
                      : items.some(it=>it.approved==="Pending"&&parseFloat(it.qtyReq||0)>0)
                        ? <span style={{padding:"2px 10px",borderRadius:99,fontSize:12,fontWeight:700,background:T.goldL,color:T.gold,border:`1px solid ${T.gold}44`}}>⏳ Pending Items</span>
                        : null}
                  </div>
                  <div style={{fontSize:13,color:T.muted,whiteSpace:"nowrap"}}>{r.staff_name||"—"}</div>
                  {canEdit&&!r.completed&&<button onClick={e=>{e.stopPropagation();startEditReq(r);}}
                    style={{padding:"3px 9px",borderRadius:5,background:"none",border:`1px solid ${T.accent}44`,color:T.accent,cursor:"pointer",fontSize:12,fontWeight:700}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.accentL;}}
                    onMouseLeave={e=>{e.currentTarget.style.background="none";}}>✎ Edit</button>}
                  {canEdit&&<button onClick={e=>{e.stopPropagation();handleDelete(r.id);}}
                    style={{width:26,height:26,borderRadius:5,background:"none",border:`1px solid ${T.border}`,color:T.muted,cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}
                    onMouseEnter={e=>{e.currentTarget.style.background=T.redL;e.currentTarget.style.color=T.red;}}
                    onMouseLeave={e=>{e.currentTarget.style.background="none";e.currentTarget.style.color=T.muted;}}>✕</button>}
                  <span style={{fontSize:12,color:T.muted}}>{isOpen?"▲":"▼"}</span>
                </div>
                {/* Expand: edit mode or read-only view */}
                {isOpen&&(
                  <div style={{background:T.bg,borderTop:`1px solid ${T.border}44`}}>
                    {editReqId===r.id ? (
                      /* ── EDIT MODE ── */
                      <div style={{padding:"12px 14px"}}>
                        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
                          <div>
                            <FL>Date Issued</FL>
                            <input type="date" value={editDateIssued} onChange={e=>setEditDateIssued(e.target.value)} style={{fontSize:13}}/>
                          </div>
                        </div>
                        <div style={{overflowX:"auto"}}>
                          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                            <thead>
                              <tr style={{background:T.accentL}}>
                                {["PPE Item","Size","Qty Req","Qty Issued","Notes","Approved"].map(h=>(
                                  <th key={h} style={{padding:"6px 8px",textAlign:"left",fontWeight:700,fontSize:12,color:T.accent,borderBottom:`1px solid ${T.border}`}}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {editRows.filter(it=>parseFloat(it.qtyReq||0)>0||it.approved).map((it,j)=>(
                                <tr key={j} style={{background:j%2===0?T.surface:T.bg}}>
                                  <td style={{padding:"5px 8px",fontWeight:700,whiteSpace:"nowrap"}}>{it.item}</td>
                                  <td style={{padding:"5px 8px",color:T.sub}}>{it.size||"—"}</td>
                                  <td style={{padding:"5px 8px",textAlign:"center"}}>{it.qtyReq||"—"}</td>
                                  <td style={{padding:"4px 6px"}}>
                                    <input type="number" min="0" value={it.qtyIssued||""} onChange={e=>{
                                      const issued=e.target.value;
                                      const req=it.qtyReq;
                                      const auto=issued&&req?(parseFloat(issued)>=parseFloat(req)?"Yes":"Pending"):"Pending";
                                      setEditRows(prev=>prev.map((r2,idx)=>r2.item===it.item?{...r2,qtyIssued:issued,approved:auto}:r2));
                                    }} style={{fontSize:12,padding:"3px 6px",width:52,textAlign:"center"}}/>
                                  </td>
                                  <td style={{padding:"4px 6px"}}>
                                    <input value={it.notes||""} onChange={e=>setEditRows(prev=>prev.map(r2=>r2.item===it.item?{...r2,notes:e.target.value}:r2))}
                                      placeholder="Notes…" style={{fontSize:12,padding:"3px 6px",width:120}}/>
                                  </td>
                                  <td style={{padding:"4px 6px"}}>
                                    <select value={it.approved||""} onChange={e=>setEditRows(prev=>prev.map(r2=>r2.item===it.item?{...r2,approved:e.target.value}:r2))}
                                      style={{fontSize:12,padding:"3px 6px",
                                        background:it.approved==="Yes"?T.tealL:it.approved==="Pending"?T.goldL:it.approved==="No"?T.redL:"",
                                        color:it.approved==="Yes"?T.teal:it.approved==="Pending"?T.gold:it.approved==="No"?T.red:T.ink,
                                        fontWeight:700,borderRadius:5}}>
                                      <option value="">—</option>
                                      <option value="Yes">Yes</option>
                                      <option value="Pending">Pending</option>
                                      <option value="No">No</option>
                                    </select>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {editRows.filter(it=>parseFloat(it.qtyReq||0)>0).every(it=>it.approved==="Yes")&&(
                          <div style={{marginTop:10,padding:"8px 12px",background:T.tealL,borderRadius:7,fontSize:13,color:T.teal,fontWeight:700}}>
                            ✓ All items issued — saving will mark this request as Completed
                          </div>
                        )}
                        <div style={{display:"flex",gap:8,marginTop:12}}>
                          <Btn sm onClick={()=>saveEditReq(r)} disabled={savingEdit}>{savingEdit?"Saving…":"Save Changes"}</Btn>
                          {editRows.filter(it=>parseFloat(it.qtyReq||0)>0).some(it=>it.approved==="Pending")&&(
                            <Btn sm v="ghost" onClick={()=>markComplete(r)} style={{background:T.tealL,color:T.teal,border:`1px solid ${T.teal}44`}}>✓ Mark All Complete</Btn>
                          )}
                          <Btn sm v="ghost" onClick={()=>setEditReqId(null)}>Cancel</Btn>
                        </div>
                      </div>
                    ) : (
                      /* ── READ-ONLY VIEW ── */
                      <div style={{padding:"0 14px 12px"}}>
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,marginTop:10}}>
                          <thead>
                            <tr>{["Item","Size","Qty Req","Qty Issued","Notes","Approved"].map(h=>(
                              <th key={h} style={{padding:"6px 8px",textAlign:"left",fontWeight:700,color:T.sub,borderBottom:`1px solid ${T.border}`,fontSize:12}}>{h}</th>
                            ))}</tr>
                          </thead>
                          <tbody>
                            {items.filter(it=>parseFloat(it.qtyReq||0)>0||it.approved).map((it,j)=>(
                              <tr key={j} style={{background:j%2===0?"rgba(255,255,255,.6)":"transparent"}}>
                                <td style={{padding:"5px 8px",fontWeight:700}}>{it.item}</td>
                                <td style={{padding:"5px 8px",color:T.sub}}>{it.size||"—"}</td>
                                <td style={{padding:"5px 8px",textAlign:"center"}}>{it.qtyReq||"—"}</td>
                                <td style={{padding:"5px 8px",textAlign:"center",color:T.teal,fontWeight:700}}>{it.qtyIssued||"—"}</td>
                                <td style={{padding:"5px 8px",color:T.muted,fontStyle:"italic"}}>{it.notes||""}</td>
                                <td style={{padding:"5px 8px"}}>{it.approved
                                  ? <span style={{padding:"2px 8px",borderRadius:99,fontSize:12,fontWeight:700,
                                      background:it.approved==="Yes"?T.tealL:it.approved==="No"?T.redL:T.goldL,
                                      color:it.approved==="Yes"?T.teal:it.approved==="No"?T.red:T.gold}}>{it.approved}</span>
                                  : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div style={{marginTop:10,fontSize:12,color:T.sub}}>
                          Apprentice: <strong>{r.apprentice_name}</strong> · Staff: <strong>{r.staff_name||"—"}</strong>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Apprentice Detail Page (used by both Mentor and Admin) ────────────────────

export default PPEAllocation;
