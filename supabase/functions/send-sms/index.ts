// Supabase Edge Function — send-sms
// Provider: SMS Everyone NZ (smseveryone.co.nz)
// Deploy: supabase functions deploy send-sms
// Secrets: SMS_EVERYONE_USERNAME, SMS_EVERYONE_PASSWORD, SMS_EVERYONE_ORIGINATOR

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { to, message } = await req.json();

    if (!to || !message) {
      return new Response(
        JSON.stringify({ error: "Missing 'to' or 'message'" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const username   = Deno.env.get("SMS_EVERYONE_USERNAME");
    const password   = Deno.env.get("SMS_EVERYONE_PASSWORD");
    const originator = Deno.env.get("SMS_EVERYONE_ORIGINATOR"); // assigned by SMS Everyone on signup

    if (!username || !password) {
      console.error("SMS credentials not set");
      return new Response(
        JSON.stringify({ error: "SMS provider credentials not configured" }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Format NZ number to international format without +
    // e.g. 021 123 4567 → 6421123456, +64 21 123 4567 → 6421123456
    const formatNZ = (num) => {
      const cleaned = num.replace(/[\s\-().+]/g, "");
      if (cleaned.startsWith("64")) return cleaned;
      if (cleaned.startsWith("0"))  return "64" + cleaned.slice(1);
      return "64" + cleaned;
    };

    const destination = formatNZ(to);
    const credentials = btoa(`${username}:${password}`);

    const payload = {
      Message:      message,
      Originator: "2310",       // KTA shortcode — enabled for API by SMS Everyone
      Destinations: [destination],
      Action:       "create",
    };

    console.log(`Sending SMS to ${destination} via account default originator (2310)`);

    const response = await fetch("https://smseveryone.com/api/campaign", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    console.log("SMS Everyone response:", JSON.stringify(result));

    if (result.Code !== 0) {
      console.error(`SMS Everyone error code ${result.Code}: ${result.Message}`);
      return new Response(
        JSON.stringify({ error: result.Message || "SMS send failed", code: result.Code }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    console.log(`SMS sent successfully — CampaignId: ${result.CampaignId}, Credits used: ${result.Credits}`);

    return new Response(
      JSON.stringify({ success: true, campaignId: result.CampaignId, credits: result.Credits }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("send-sms error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
