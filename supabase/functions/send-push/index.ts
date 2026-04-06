// ─── Supabase Edge Function: send-push ───────────────────────────────────────
// Deploy path: supabase/functions/send-push/index.ts
//
// HOW TO DEPLOY:
//   1. Install Supabase CLI:  npm install -g supabase
//   2. Login:                 supabase login
//   3. Link your project:     supabase link --project-ref YOUR_PROJECT_REF
//   4. Set secrets:
//        supabase secrets set VAPID_PUBLIC_KEY=your_public_key
//        supabase secrets set VAPID_PRIVATE_KEY=your_private_key
//        supabase secrets set VAPID_SUBJECT=mailto:you@yourdomain.com
//        supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
//   5. Deploy:                supabase functions deploy send-push
//
// The function URL will be:
//   https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-push

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin':  'https://crmkta.com',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const VAPID_PUBLIC_KEY  = Deno.env.get('VAPID_PUBLIC_KEY')!;
    const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
    const VAPID_SUBJECT     = Deno.env.get('VAPID_SUBJECT')!;
    const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    // Admin-auth Supabase client (bypasses RLS to read subscriptions)
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { userIds, title, body, type = 'broadcast', url = '/' } = await req.json() as {
      userIds: string[];
      title:   string;
      body:    string;
      type?:   string;
      url?:    string;
    };

    if (!userIds?.length || !title || !body) {
      return new Response(JSON.stringify({ error: 'Missing userIds, title or body' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch push subscriptions for the target users
    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .in('user_id', userIds);

    if (error) throw error;
    if (!subs?.length) {
      return new Response(JSON.stringify({ sent: 0, message: 'No subscriptions found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const payload = JSON.stringify({ title, body, type, url });
    const results = await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        ).catch(async (err) => {
          // 410 Gone = subscription expired — clean it up
          if (err.statusCode === 410) {
            await supabase.from('push_subscriptions').delete().eq('id', sub.id);
          }
          throw err;
        })
      )
    );

    const sent   = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    return new Response(JSON.stringify({ sent, failed, total: subs.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('send-push error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
