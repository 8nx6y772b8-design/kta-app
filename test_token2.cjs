const crypto = require('crypto');
const https  = require('https');

const secret = 'f995e3421766cf9b0a89808d07e63fb0bbde9f1678875b74950c347c8597eb5e';

const toB64url   = (b64) => b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const fromB64url = (s)   => { const b = s.replace(/-/g,'+').replace(/_/g,'/'); return b + '='.repeat((4-b.length%4)%4); };

const payload    = { id: 'abcdef1', action: 'approve', actorId: 'xxxx', actorRole: 'approver', exp: Date.now() + 600000 };
const payloadB64 = toB64url(Buffer.from(JSON.stringify(payload)).toString('base64'));
console.log('payloadB64:', payloadB64);

// Sign using Node crypto.subtle (same as browser SubtleCrypto / Deno)
async function run() {
  const secretBytes = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = toB64url(Buffer.from(sig).toString('base64'));
  const token = payloadB64 + '.' + sigB64;
  
  console.log('Token URL-safe:', /^[A-Za-z0-9\-_.]+$/.test(token));
  console.log('payloadB64 len:', payloadB64.length, 'sig len:', sigB64.length);

  // Verify locally first (same as Deno)
  const verifyKey = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes  = Uint8Array.from(Buffer.from(fromB64url(sigB64), 'base64'));
  const valid     = await crypto.subtle.verify('HMAC', verifyKey, sigBytes, new TextEncoder().encode(payloadB64));
  console.log('Local verify:', valid, '← should be true');
  
  if (!valid) { console.error('LOCAL VERIFY FAILED — algorithm bug'); return; }

  // Call edge function
  const edgeUrl = `https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/leave-action?token=${token}`;
  console.log('\nCalling edge function...');
  https.get(edgeUrl, { headers: {'User-Agent':'test'} }, (res) => {
    console.log('HTTP Status:', res.statusCode);
    const loc = res.headers.location || '';
    console.log('Location:', loc);
    const params = new URLSearchParams(loc.split('?')[1] || '');
    console.log('status param:', params.get('status'));
    console.log('msg param:', params.get('msg'));
  }).on('error', e => console.error('Error:', e.message));
}
run();
