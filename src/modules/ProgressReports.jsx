import { useState, useEffect } from "react";
import { T } from "../constants.js";
import { fmtD } from "../utils.js";
import { loadTable, upsertRow, deleteRow } from "../supabaseClient.js";
import { Btn, Card } from "../shared.jsx";

function ProgressReportsModule({ allUsers, currentUser }) {
  const apprentices = allUsers.filter(u => u.role === "Apprentice")
    .sort((a, b) => (a.name||"").localeCompare(b.name||""));

  const [queue, setQueue]         = useState([]);   // queued but unprocessed PDFs
  const [snapshots, setSnapshots] = useState([]);   // all processed snapshots
  const [loadingQ, setLoadingQ]   = useState(true);
  const [dragging, setDragging]   = useState(false);
  const [processing, setProcessing] = useState({}); // id → status
  const [processAll, setProcessAll] = useState(false);
  const fileRef = useRef(null);

  // Load queue and existing snapshots
  const reload = () => {
    setLoadingQ(true);
    Promise.all([
      loadTable("progress_report_queue").catch(()=>[]),
      loadTable("progress_snapshots").catch(()=>[]),
    ]).then(([q, s]) => {
      setQueue((q||[]).sort((a,b)=>(b.queued_at||"").localeCompare(a.queued_at||"")));
      setSnapshots(s||[]);
    }).finally(()=>setLoadingQ(false));
  };
  useEffect(reload, []);

  const fmtD = iso => { if(!iso) return "—"; const[y,m,d]=(iso||"").split("-"); return `${d}/${m}/${y}`; };

  // Match apprentice by name from PDF text
  const matchApprentice = (pdfText) => {
    // EarnLearn header: "Preferred Name  Shavanah" and trainee's full name top-left
    const nameM = pdfText.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/m);
    const fullName = nameM ? nameM[1].trim() : "";
    if (!fullName) return null;
    // Try exact match first, then partial
    let match = apprentices.find(u =>
      u.name.toLowerCase() === fullName.toLowerCase()
    );
    if (!match) {
      const parts = fullName.toLowerCase().split(/\s+/);
      match = apprentices.find(u => {
        const uParts = u.name.toLowerCase().split(/\s+/);
        return parts.some(p => uParts.some(up => up === p && p.length > 2));
      });
    }
    return match || null;
  };

  // Parse a single PDF file using pdf.js (already loaded by ProgressSnapshotPanel)
  const parsePDF = async (file) => {
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
    const arrayBuf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuf }).promise;
    let text = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      text += tc.items.map(i => i.str).join(" ") + "\n";
    }
    return text;
  };

  // Parse text using same regex as ProgressSnapshotPanel
  const parseEarnLearnText = (text) => {
    const n = s => { const v = parseFloat(s); return isNaN(v) ? null : v; };
    let report_date = null;
    const dateM = text.match(/Booklet Data as at\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i);
    if (dateM) {
      const months = {jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
                      jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
      const mo = months[dateM[2].toLowerCase().slice(0,3)] || "01";
      report_date = `${dateM[3]}-${mo}-${String(dateM[1]).padStart(2,"0")}`;
    }
    let months_in_training = null, programme_duration = null;
    const progM = text.match(/Active\s+[\d/]+\s+[\d/]+\s+(\d+)\s+(\d+)/);
    if (progM) { programme_duration = n(progM[1]); months_in_training = n(progM[2]); }
    const summarySection = (label) => {
      const re = new RegExp(label + "\\s+([\\d]+)\\s+([\\d]+)\\s+([\\d.]+)%", "i");
      const m = text.match(re);
      return m ? n(m[3]) : null;
    };
    const bookM = text.match(/Booklets Completed\s+(\d+)\s+([\d.]+)%/i);
    const totalsM = text.match(/Totals\s+[\d,]+\s+[\d,]+\s+([\d.]+)%/i);
    return {
      report_date, months_in_training, programme_duration,
      overall_percent:     totalsM ? n(totalsM[1]) : null,
      skills_week_percent: summarySection("Skills Week/Trade Start"),
      off_job_l3_percent:  summarySection("Off Job Unit Standards.*?Level 3"),
      off_job_l4_percent:  summarySection("Off Job Unit Standards.*?Level 4"),
      on_job_core_percent: summarySection("On Job Unit Standards.*?Core"),
      on_job_spec_percent: summarySection("On Job Unit Standards.*?(?:Domestic|Speciality|Specialty)"),
      booklets_percent:    bookM ? n(bookM[2]) : null,
    };
  };

  // Handle file drop or selection
  const handleFiles = async (files) => {
    const pdfs = Array.from(files).filter(f => f.type === "application/pdf" || f.name.endsWith(".pdf"));
    if (pdfs.length === 0) return;

    for (const file of pdfs) {
      const tempId = uid();
      setQueue(prev => [{
        id: tempId, filename: file.name, status: "parsing",
        apprentice_name: "Matching…", queued_at: new Date().toISOString(),
      }, ...prev]);

      try {
        const text = await parsePDF(file);
        const parsed = parseEarnLearnText(text);
        const apprentice = matchApprentice(text);

        if (!apprentice) {
          setQueue(prev => prev.map(q => q.id === tempId ? {
            ...q, status: "no_match", apprentice_name: "⚠ Could not match to apprentice",
          } : q));
          continue;
        }
        if (!parsed.months_in_training) {
          setQueue(prev => prev.map(q => q.id === tempId ? {
            ...q, status: "parse_error", apprentice_name: apprentice.name,
            error: "Could not extract training data",
          } : q));
          continue;
        }

        // Check for duplicate
        const existingSnap = snapshots.find(s =>
          s.apprentice_id === apprentice.id &&
          s.report_date?.slice(0,7) === parsed.report_date?.slice(0,7)
        );

        const queueRow = {
          id: tempId,
          apprentice_id:   apprentice.id,
          apprentice_name: apprentice.name,
          filename:        file.name,
          report_date:     parsed.report_date,
          months_in_training:  parsed.months_in_training,
          programme_duration:  parsed.programme_duration,
          overall_percent:     parsed.overall_percent,
          skills_week_percent: parsed.skills_week_percent,
          off_job_l3_percent:  parsed.off_job_l3_percent,
          off_job_l4_percent:  parsed.off_job_l4_percent,
          on_job_core_percent: parsed.on_job_core_percent,
          on_job_spec_percent: parsed.on_job_spec_percent,
          booklets_percent:    parsed.booklets_percent,
          status:          existingSnap ? "duplicate" : "ready",
          queued_at:       new Date().toISOString(),
          queued_by:       currentUser.id,
        };

        await upsertRow("progress_report_queue", queueRow).catch(console.error);
        setQueue(prev => prev.map(q => q.id === tempId ? queueRow : q));

      } catch(e) {
        setQueue(prev => prev.map(q => q.id === tempId ? {
          ...q, status: "parse_error", error: e.message,
        } : q));
      }
    }
  };

  // Process a single queued item → create snapshot
  const processItem = async (item) => {
    if (item.status === "done") return;
    setProcessing(p => ({...p, [item.id]: "processing"}));
    try {
      const snap = {
        id:                  uid(),
        apprentice_id:       item.apprentice_id,
        uploaded_at:         new Date().toISOString(),
        report_date:         item.report_date,
        months_in_training:  item.months_in_training,
        programme_duration:  item.programme_duration,
        overall_percent:     item.overall_percent,
        skills_week_percent: item.skills_week_percent,
        off_job_l3_percent:  item.off_job_l3_percent,
        off_job_l4_percent:  item.off_job_l4_percent,
        on_job_core_percent: item.on_job_core_percent,
        on_job_spec_percent: item.on_job_spec_percent,
        booklets_percent:    item.booklets_percent,
      };
      await upsertRow("progress_snapshots", snap);
      await updateRow("progress_report_queue", item.id, { status: "done" });
      setQueue(prev => prev.map(q => q.id === item.id ? {...q, status: "done"} : q));
      setSnapshots(prev => [...prev.filter(s =>
        !(s.apprentice_id === item.apprentice_id && s.report_date?.slice(0,7) === item.report_date?.slice(0,7))
      ), snap]);
      setProcessing(p => ({...p, [item.id]: "done"}));
    } catch(e) {
      setProcessing(p => ({...p, [item.id]: "error: " + e.message}));
    }
  };

  // Process all ready items
  const processAllReady = async () => {
    setProcessAll(true);
    const ready = queue.filter(q => q.status === "ready");
    for (const item of ready) await processItem(item);
    setProcessAll(false);
  };

  const removeItem = async (id) => {
    await deleteRow("progress_report_queue", id).catch(console.error);
    setQueue(prev => prev.filter(q => q.id !== id));
  };

  const STATUS_META = {
    parsing:    { label: "Parsing…",       color: T.muted,  bg: T.bg },
    ready:      { label: "✓ Ready",        color: T.teal,   bg: T.tealL },
    done:       { label: "✅ Processed",   color: T.teal,   bg: T.tealL },
    duplicate:  { label: "⚠ Duplicate",   color: T.warn,   bg: T.warnL },
    no_match:   { label: "❌ No match",    color: T.red,    bg: T.redL },
    parse_error:{ label: "❌ Parse error", color: T.red,    bg: T.redL },
  };

  const readyCount = queue.filter(q => q.status === "ready").length;
  const doneCount  = queue.filter(q => q.status === "done").length;

  // Group snapshots by apprentice for summary
  const snapByApp = {};
  snapshots.forEach(s => {
    if (!snapByApp[s.apprentice_id]) snapByApp[s.apprentice_id] = [];
    snapByApp[s.apprentice_id].push(s);
  });

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>

      {/* Page header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 22, color: T.ink }}>📈 Progress Reports</div>
        <div style={{ fontSize: 13, color: T.sub, marginTop: 3 }}>
          Drop EarnLearn PDFs here. Ready items can be processed immediately or will auto-process on the 1st of each month.
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => fileRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? T.teal : T.border}`,
          borderRadius: 14,
          background: dragging ? T.tealL : T.bg,
          padding: "36px 24px",
          textAlign: "center",
          cursor: "pointer",
          transition: "all .15s",
          marginBottom: 20,
        }}>
        <input ref={fileRef} type="file" accept="application/pdf" multiple
          style={{ display: "none" }}
          onChange={e => handleFiles(e.target.files)}/>
        <div style={{ fontSize: 36, marginBottom: 10 }}>📂</div>
        <div style={{ fontWeight: 700, fontSize: 16, color: dragging ? T.teal : T.ink }}>
          {dragging ? "Drop to add" : "Drop EarnLearn PDFs here"}
        </div>
        <div style={{ fontSize: 13, color: T.muted, marginTop: 4 }}>
          or click to browse — multiple files supported
        </div>
      </div>

      {/* Queue */}
      {queue.length > 0 && (
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: T.ink }}>Queue</div>
              <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>
                {readyCount} ready · {doneCount} processed · {queue.length} total
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {readyCount > 0 && (
                <button onClick={processAllReady} disabled={processAll}
                  style={{ padding: "8px 16px", background: T.teal, color: "#fff", border: "none",
                    borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer",
                    fontFamily: "DM Sans, sans-serif", opacity: processAll ? 0.6 : 1 }}>
                  {processAll ? "Processing…" : `▶ Process All (${readyCount})`}
                </button>
              )}
              <button onClick={reload}
                style={{ padding: "8px 14px", background: T.bg, color: T.sub, border: `1px solid ${T.border}`,
                  borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "DM Sans, sans-serif" }}>
                ↺ Refresh
              </button>
            </div>
          </div>

          {queue.map(item => {
            const sm = STATUS_META[item.status] || STATUS_META.parsing;
            const procStatus = processing[item.id];
            const apprentice = allUsers.find(u => u.id === item.apprentice_id);
            return (
              <div key={item.id} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 12px", borderRadius: 10, marginBottom: 6,
                background: sm.bg, border: `1px solid ${sm.color}22`,
              }}>
                <div style={{ fontSize: 20 }}>📄</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: T.ink, whiteSpace: "nowrap",
                    overflow: "hidden", textOverflow: "ellipsis" }}>
                    {item.apprentice_name || item.filename}
                  </div>
                  <div style={{ fontSize: 12, color: T.sub, marginTop: 1 }}>
                    {item.filename}
                    {item.report_date && ` · ${fmtD(item.report_date)}`}
                    {item.months_in_training && ` · m${item.months_in_training}`}
                    {item.overall_percent != null && ` · ${Math.round(item.overall_percent)}%`}
                    {item.error && ` — ${item.error}`}
                  </div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: sm.color,
                  background: "#fff", padding: "2px 8px", borderRadius: 99, whiteSpace: "nowrap" }}>
                  {procStatus === "processing" ? "⏳ Processing…" : sm.label}
                </span>
                {item.status === "ready" && !procStatus && (
                  <button onClick={() => processItem(item)}
                    style={{ padding: "4px 10px", background: T.teal, color: "#fff", border: "none",
                      borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: "pointer",
                      fontFamily: "DM Sans, sans-serif" }}>
                    ▶ Now
                  </button>
                )}
                {["no_match","parse_error","done","duplicate"].includes(item.status) && (
                  <button onClick={() => removeItem(item.id)}
                    style={{ background: "none", border: "none", cursor: "pointer",
                      color: T.muted, fontSize: 16, padding: "0 4px" }}>✕</button>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {/* Apprentice snapshot summary */}
      <Card>
        <div style={{ fontWeight: 700, fontSize: 16, color: T.ink, marginBottom: 14 }}>
          Snapshots by Apprentice
        </div>
        {loadingQ ? (
          <div style={{ textAlign: "center", padding: 24, color: T.muted, fontSize: 14 }}>Loading…</div>
        ) : Object.keys(snapByApp).length === 0 ? (
          <div style={{ textAlign: "center", padding: "24px 0", color: T.muted, fontSize: 14, fontStyle: "italic" }}>
            No progress snapshots yet — upload EarnLearn PDFs above
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px,1fr))", gap: 10 }}>
            {apprentices.filter(a => snapByApp[a.id]).map(a => {
              const snaps = (snapByApp[a.id]||[]).sort((x,y)=>x.months_in_training-y.months_in_training);
              const latest = snaps[snaps.length - 1];
              const pct = Math.round(latest.overall_percent || 0);
              const pctColor = pct >= 75 ? T.teal : pct >= 50 ? T.accent : T.warn;
              return (
                <div key={a.id} style={{ background: T.bg, borderRadius: 10, padding: "12px 14px",
                  border: `1px solid ${T.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <Avatar name={a.name} role="Apprentice" size={32}/>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: T.ink,
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
                      <div style={{ fontSize: 11, color: T.muted }}>{snaps.length} snapshot{snaps.length!==1?"s":""}</div>
                    </div>
                    <div style={{ fontWeight: 800, fontSize: 20, color: pctColor }}>{pct}%</div>
                  </div>
                  <div style={{ height: 4, background: T.border, borderRadius: 2 }}>
                    <div style={{ height: 4, borderRadius: 2, width: `${Math.min(pct,100)}%`,
                      background: pctColor, transition: "width .4s" }}/>
                  </div>
                  <div style={{ fontSize: 11, color: T.muted, marginTop: 6 }}>
                    Latest: {fmtD(latest.report_date)} · m{latest.months_in_training}
                    {latest.programme_duration && ` of ${latest.programme_duration}`}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Auto-process info box */}
      <div style={{ marginTop: 16, padding: "12px 16px", background: T.accentL,
        borderRadius: 10, border: `1px solid ${T.accent}33`, fontSize: 13, color: T.ink,
        lineHeight: 1.6 }}>
        <strong>Auto-processing:</strong> To automatically process queued reports on the 1st of each month,
        run the SQL below in your Supabase SQL editor once to set up a scheduled job. Queued reports
        with status "ready" will be processed overnight on the 1st.
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700, color: T.accent }}>
            Show SQL setup
          </summary>
          <pre style={{ marginTop: 8, padding: "10px 12px", background: "#fff", borderRadius: 8,
            fontSize: 11, overflow: "auto", border: `1px solid ${T.border}`, whiteSpace: "pre-wrap" }}>
{`-- Enable pg_cron extension (one-time)
create extension if not exists pg_cron;

-- Run on the 1st of every month at 2am NZ time (UTC+13 → 1:00 UTC previous day)
-- Selects all "ready" rows from progress_report_queue and inserts into progress_snapshots
select cron.schedule(
  'process-progress-queue',
  '0 1 1 * *',
  $$
    insert into progress_snapshots (
      id, apprentice_id, uploaded_at, report_date,
      months_in_training, programme_duration, overall_percent,
      skills_week_percent, off_job_l3_percent, off_job_l4_percent,
      on_job_core_percent, on_job_spec_percent, booklets_percent
    )
    select
      gen_random_uuid(), apprentice_id, now(), report_date,
      months_in_training, programme_duration, overall_percent,
      skills_week_percent, off_job_l3_percent, off_job_l4_percent,
      on_job_core_percent, on_job_spec_percent, booklets_percent
    from progress_report_queue
    where status = 'ready'
    on conflict do nothing;

    update progress_report_queue
    set status = 'done'
    where status = 'ready';
  $$
);`}
          </pre>
        </details>
      </div>
    </div>
  );
}


export default ProgressReportsModule;
