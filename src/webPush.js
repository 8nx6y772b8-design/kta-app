// ─── src/webPush.js ───────────────────────────────────────────────────────────
// Handles service worker registration and push subscription management.
// Import this into App.jsx and call initWebPush(userId) after login.

import { sb } from './supabaseClient';

// ─── Replace with your actual VAPID public key ───────────────────────────────
// Generate with:  npx web-push generate-vapid-keys
// Then also set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY as Supabase Edge Function secrets.
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

// URL of your deployed Supabase Edge Function
const PUSH_FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-push`;

// ─── Convert VAPID public key from base64 to Uint8Array ─────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// ─── Register the service worker ─────────────────────────────────────────────
async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    return reg;
  } catch (err) {
    console.warn('SW registration failed:', err);
    return null;
  }
}

// ─── Subscribe browser to Web Push + persist to Supabase ─────────────────────
async function subscribeToPush(userId, registration) {
  if (!VAPID_PUBLIC_KEY) {
    console.warn('VITE_VAPID_PUBLIC_KEY not set — skipping push subscription');
    return;
  }
  try {
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const { endpoint, keys } = sub.toJSON();

    // Upsert into Supabase push_subscriptions table
    await sb.from('push_subscriptions').upsert(
      {
        user_id:  userId,
        endpoint,
        p256dh:   keys.p256dh,
        auth:     keys.auth,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,endpoint' }
    );
  } catch (err) {
    console.warn('Push subscription failed:', err);
  }
}

// ─── Remove subscription from Supabase on logout ─────────────────────────────
export async function unsubscribeFromPush(userId) {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const { endpoint } = sub.toJSON();
      await sb.from('push_subscriptions').delete()
        .eq('user_id', userId)
        .eq('endpoint', endpoint);
      await sub.unsubscribe();
    }
  } catch (err) {
    console.warn('Push unsubscribe failed:', err);
  }
}

// ─── Main init — call after login ─────────────────────────────────────────────
export async function initWebPush(userId) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'denied') return;

  let permission = Notification.permission;
  if (permission !== 'granted') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') return;

  const reg = await registerSW();
  if (!reg) return;

  await subscribeToPush(userId, reg);
}

// ─── Send Web Push via Edge Function ─────────────────────────────────────────
// userIds: string[]  — list of user IDs to notify
// type:    string    — 'broadcast' | 'approval' | 'decline' | 'licence_expiry'
export async function sendWebPush({ userIds, title, body, type = 'broadcast', url = '/' }) {
  if (!userIds?.length) return { sent: 0 };
  try {
    const res = await fetch(PUSH_FUNCTION_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userIds, title, body, type, url }),
    });
    return await res.json();
  } catch (err) {
    console.error('sendWebPush error:', err);
    return { sent: 0, error: String(err) };
  }
}
