const https = require('https');

const secret = 'f995e3421766cf9b0a89808d07e63fb0bbde9f1678875b74950c347c8597eb5e';
const toB64url   = (b64) => b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

async function run() {
  const payload    = { id: 'abcdef1', action: 'approve', actorId: 'xxxx', actorRole: 'approver', exp: Date.now() + 600000 };
  const payloadB64 = toB64url(Buffer.from(JSON.stringify(payload)).toString('base64'));
  const key        = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig        = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64     = toB64url(Buffer.from(sig).toString('base64'));
  const token      = payloadB64 + '.' + sigB64;

  console.log('Sent sig (first 20):', sigB64.slice(0,20));

  const edgeUrl = `https://sprlcvxlcjwhfzspkrww.supabase.co/functions/v1/leave-action?token=${token}`;
  https.get(edgeUrl, {headers:{'User-Agent':'test'}}, (res) => {
    const loc = res.headers.location || '';
    console.log('Location:', loc);
    const params = new URLSearchParams(loc.split('?')[1]||'');
    console.log('msg:', params.get('msg'));
    console.log('expect sig (from Deno):', params.get('expect'));
    console.log('got sig (what Deno received):', params.get('got'));
    console.log('slen:', params.get('slen'));
    if (params.get('expect') && params.get('got')) {
      console.log('\nSIG MATCH?', params.get('expect') === sigB64.slice(0,20));
    }
  }).on('error', e => console.error('Error:', e.message));
}
run();
