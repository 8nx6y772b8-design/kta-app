// ─────────────────────────────────────────────────────────────────────────────
// CHANGES TO App.jsx
// Apply these diffs to wire up real Web Push alongside your existing in-app notifs.
// ─────────────────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════════════
// 1. ADD THESE TWO IMPORTS at the top of App.jsx  (after the existing imports)
// ═══════════════════════════════════════════════════════════════════════════════

import { initWebPush, sendWebPush, unsubscribeFromPush } from './webPush';


// ═══════════════════════════════════════════════════════════════════════════════
// 2. REPLACE the BroadcastComposer component (find the existing one and swap it)
// ═══════════════════════════════════════════════════════════════════════════════

function BroadcastComposer({ users, currentUser, onSend, onClose }) {
  const [title,   setTitle]   = useState('');
  const [message, setMessage] = useState('');
  // Target options now explicitly match your three groups + individual
  const [target,  setTarget]  = useState('role:Apprentice');
  const [sending, setSending] = useState(false);
  const [result,  setResult]  = useState(null); // { sent, failed }

  // Groups you requested: Apprentices, Approvers, Viewers + individual
  const GROUP_OPTIONS = [
    { value: 'role:Apprentice', label: 'All Apprentices' },
    { value: 'role:Approver',   label: 'All Approvers'   },
    { value: 'role:Viewer',     label: 'All Viewers'     },
    { value: 'everyone',        label: 'Everyone'         },
  ];

  const getRecipientIds = () => {
    if (target === 'everyone')          return users.filter(u => u.id !== currentUser.id).map(u => u.id);
    if (target.startsWith('role:'))     return users.filter(u => u.role === target.slice(5) && u.id !== currentUser.id).map(u => u.id);
    if (target.startsWith('user:'))     return [target.slice(5)];
    return [];
  };

  const recipientIds  = getRecipientIds();
  const recipientCount = recipientIds.length;

  const send = async () => {
    if (!title.trim() || !message.trim() || !recipientIds.length) return;
    setSending(true);
    setResult(null);

    // 1. In-app notifications (your existing system — stored in Supabase)
    await onSend(recipientIds, 'broadcast', title.trim(), message.trim(), currentUser.id, {});

    // 2. Web Push — delivered even if the user's tab is closed
    const pushResult = await sendWebPush({
      userIds: recipientIds,
      title:   title.trim(),
      body:    message.trim(),
      type:    'broadcast',
      url:     '/',
    });

    setSending(false);
    setResult(pushResult);

    // Auto-close after a short success display
    if (!pushResult.error) {
      setTimeout(onClose, 1800);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#00000066', zIndex: 300,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <Card style={{ width: '100%', maxWidth: 500, padding: 28 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontFamily: "'Libre Baskerville'", fontSize: 18, fontWeight: 700 }}>
            📢 Send Push Notification
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: T.muted, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Group / recipient selector */}
        <div style={{ marginBottom: 14 }}>
          <FL>Send to</FL>
          <select value={target} onChange={e => setTarget(e.target.value)}>
            <optgroup label="Groups">
              {GROUP_OPTIONS.map(o => {
                const count = o.value === 'everyone'
                  ? users.filter(u => u.id !== currentUser.id).length
                  : users.filter(u => u.role === o.value.slice(5) && u.id !== currentUser.id).length;
                return (
                  <option key={o.value} value={o.value}>
                    {o.label} ({count} {count === 1 ? 'user' : 'users'})
                  </option>
                );
              })}
            </optgroup>
            <optgroup label="Individual">
              {users
                .filter(u => u.id !== currentUser.id)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(u => (
                  <option key={u.id} value={`user:${u.id}`}>
                    {u.name} ({u.role})
                  </option>
                ))
              }
            </optgroup>
          </select>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>
            Will notify <strong>{recipientCount}</strong> recipient{recipientCount !== 1 ? 's' : ''} — in-app &amp; browser push
          </div>
        </div>

        {/* Title */}
        <div style={{ marginBottom: 14 }}>
          <FL req>Title</FL>
          <input
            placeholder="e.g. Site closure Friday"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={80}
          />
        </div>

        {/* Message */}
        <div style={{ marginBottom: 20 }}>
          <FL req>Message</FL>
          <textarea
            placeholder="Write your message here…"
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={4}
            style={{
              width: '100%', resize: 'vertical', padding: '9px 12px',
              border: `1.5px solid ${T.border}`, borderRadius: 8,
              fontFamily: 'DM Sans,sans-serif', fontSize: 13,
              background: T.bg, color: T.ink, boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Result banner */}
        {result && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: 8, fontSize: 13,
            background: result.error ? T.redL : T.accentL,
            color:      result.error ? T.red  : T.accent,
            border:     `1px solid ${result.error ? T.red : T.accent}44`,
          }}>
            {result.error
              ? `⚠ Push failed: ${result.error}`
              : `✓ Delivered — ${result.sent ?? 0} push${result.sent !== 1 ? 'es' : ''} sent${result.failed ? `, ${result.failed} failed` : ''}`
            }
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn
            onClick={send}
            disabled={sending || !title.trim() || !message.trim() || recipientCount === 0}
          >
            {sending ? 'Sending…' : '📢 Send Notification'}
          </Btn>
          <Btn v="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </Card>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// 3. UPDATE handleLogin — call initWebPush after login
// ═══════════════════════════════════════════════════════════════════════════════

// FIND this in App():
//   const handleLogin = (userId) => {
//     const u = users.find(x => x.id === userId);
//     setModule(u?.role === "Admin" ? "dashboard" : u?.role === "Mentor" ? "crm" : "timesheet");
//     setSessionId(userId);
//     setViewingAppId(null);
//   };

// REPLACE WITH:
const handleLogin = (userId) => {
  const u = users.find(x => x.id === userId);
  setModule(u?.role === 'Admin' ? 'dashboard' : u?.role === 'Mentor' ? 'crm' : 'timesheet');
  setSessionId(userId);
  setViewingAppId(null);
  // Register service worker + subscribe to Web Push for this user
  initWebPush(userId);
};


// ═══════════════════════════════════════════════════════════════════════════════
// 4. UPDATE handleLogout — unsubscribe from push on sign out
// ═══════════════════════════════════════════════════════════════════════════════

// FIND this in App():
//   const handleLogout = () => {
//     setLoggingOut(true);
//     setTimeout(() => { setSessionId(null); ... }, 400);
//   };

// REPLACE WITH:
const handleLogout = () => {
  setLoggingOut(true);
  if (sessionId) unsubscribeFromPush(sessionId).catch(console.error);
  setTimeout(() => {
    setSessionId(null);
    setLoggingOut(false);
    setViewingAppId(null);
    setShowAppList(false);
    try { localStorage.removeItem('wos_session_sb'); } catch {}
  }, 400);
};
