import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

function escapeHtml(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const sharedSecret = Deno.env.get("PICK_WEBHOOK_SECRET");
  if (sharedSecret) {
    const h = req.headers.get("x-webhook-secret");
    if (h !== sharedSecret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: cors });
  }

  let body: { type?: string; table?: string; record?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const rec = body.record;
  if (!rec || typeof rec.song_id !== "string") {
    return new Response(JSON.stringify({ error: "missing record.song_id" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const resendKey = Deno.env.get("RESEND_API_KEY");
  const adminEmail = Deno.env.get("PICK_NOTIFY_EMAIL");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!resendKey || !adminEmail) {
    return new Response(
      JSON.stringify({
        error: "set secrets RESEND_API_KEY and PICK_NOTIFY_EMAIL",
      }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "missing supabase env" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(supabaseUrl, serviceKey);
  const { data: song, error: songErr } = await sb
    .from("songs")
    .select("title, artist")
    .eq("id", rec.song_id as string)
    .maybeSingle();

  if (songErr || !song) {
    return new Response(JSON.stringify({ error: "song not found" }), {
      status: 404,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const title = String(song.title || "");
  const artist = String(song.artist || "");
  const vid = String(rec.visitor_id || "");
  const shortVid = vid.length > 14 ? vid.slice(0, 14) + "…" : vid || "—";
  const when = String(rec.created_at || new Date().toISOString());

  const fromAddr =
    Deno.env.get("RESEND_FROM") || "Ruins <onboarding@resend.dev>";

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + resendKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddr,
      to: [adminEmail],
      subject: "[忽闻宝声] 点歌：" + title + " — " + artist,
      html:
        "<p>有访客在歌单页点击上报了点歌意向。</p><ul>" +
        "<li>曲目：<strong>" +
        escapeHtml(title) +
        "</strong></li>" +
        "<li>演唱者：" +
        escapeHtml(artist) +
        "</li>" +
        "<li>访客标识（截断）：<code>" +
        escapeHtml(shortVid) +
        "</code></li>" +
        "<li>时间：" +
        escapeHtml(when) +
        "</li></ul>" +
        "<p>也可在管理后台「点歌上报」表中查看记录。</p>",
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    return new Response(JSON.stringify({ error: t }), {
      status: 502,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
