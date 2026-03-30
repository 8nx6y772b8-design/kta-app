import { useState } from "react";
import { T, KTA_LOGO } from "../constants.js";
import { checkPw, hashPw, sendKTAEmail } from "../utils.js";
import { upsertUser } from "../supabaseClient.js";

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
<p style="color:#888;font-size:13.2px">KTA Workforce Management · payroll@kta.org.nz</p>`,
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
    const user = users.find(u=>u.email.toLowerCase()===email.trim().toLowerCase());
    if(!user) { setErr("No account found with that email address."); setLoading(false); trigShake(); return; }
    checkPw(pw, user.password).then(async (ok) => {
      if(!ok) { setErr("Incorrect password. Please try again."); setLoading(false); trigShake(); return; }
      // Transparently upgrade legacy XOR hash to SHA-256 on successful login
      if(user.password && !user.password.includes(":")) {
        const newHash = await hashPw(pw);
        upsertUser({...user, password: newHash}).catch(()=>{});
      }
      onLogin(user.id);
    }).catch(()=>{ setErr("Login error. Please try again."); setLoading(false); });
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
          <h1 style={{fontFamily:"'Libre Baskerville'",fontSize:40,fontWeight:700,color:"#fff",lineHeight:1.25,marginBottom:20,letterSpacing:"-.5px"}}>
            Timesheet management, approvals, and CRM
          </h1>
          <p style={{fontSize:18,color:"#ffffffaa",lineHeight:1.7}}>
            Built around your team and their training needs.
          </p>
        </div>
      </div>

      {/* RIGHT — login form */}
      <div className="login-right">
        <div style={{marginBottom:36}}>
          <h2 style={{fontFamily:"'Libre Baskerville'",fontSize:28,fontWeight:700,color:T.ink,marginBottom:8}}>
            Welcome back
          </h2>
          <p style={{fontSize:14,color:T.sub}}>Sign in to your account to continue.</p>
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
              padding:"9px 13px",marginBottom:14,fontSize:14,color:T.red,display:"flex",gap:8,alignItems:"center"}}>
              <span>⚠</span>{err}
            </div>
          )}

          {/* Submit */}
          <button onClick={attempt} disabled={loading} style={{
            width:"100%",padding:"13px",marginTop:err?0:6,marginBottom:20,
            background:loading?T.accentL:T.accent,
            color:loading?T.accent:"#fff",
            border:`1.5px solid ${T.accentD}`,
            borderRadius:10,fontSize:17,fontWeight:700,
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
              background:"none",border:"none",color:T.accent,fontSize:14,
              fontWeight:700,cursor:"pointer",fontFamily:"DM Sans,sans-serif",
              padding:0,display:"block",margin:"0 auto"
            }}>Forgot your password?</button>
          ) : (
            <div className="fi">
              <div style={{fontSize:14,fontWeight:700,color:T.ink,marginBottom:8}}>Reset Password</div>
              <div style={{fontSize:13,color:T.sub,marginBottom:12,lineHeight:1.5}}>
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
                  borderRadius:8,padding:"9px 13px",marginBottom:10,fontSize:13,
                  color:forgotMsg.ok?T.accent:T.red}}>
                  {forgotMsg.text}
                </div>
              )}
              <div style={{display:"flex",gap:8}}>
                <button onClick={sendReset} disabled={forgotSending} style={{
                  flex:1,padding:"10px",background:T.accent,color:"#fff",
                  border:`1.5px solid ${T.accentD}`,borderRadius:9,fontSize:14,fontWeight:700,
                  cursor:forgotSending?"default":"pointer",fontFamily:"DM Sans,sans-serif",
                  opacity:forgotSending?0.6:1,transition:"all .15s"
                }}>{forgotSending?"Sending…":"Send Reset Link"}</button>
                <button onClick={()=>{setForgotMode(false);setForgotEmail("");setForgotMsg("");}} style={{
                  padding:"10px 16px",background:"none",color:T.sub,
                  border:`1.5px solid ${T.border}`,borderRadius:9,fontSize:14,fontWeight:700,
                  cursor:"pointer",fontFamily:"DM Sans,sans-serif"
                }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        {/* Version */}
        <div style={{marginTop:24,textAlign:"center",fontSize:13,color:T.muted,fontFamily:"DM Sans,sans-serif",letterSpacing:".5px"}}>
          v3.2.3
        </div>
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

export default LoginScreen;
