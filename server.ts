import { configFromEnv, handleLineWebhook } from "./src/line_webhook.ts";
import { sendDailyDigest } from "./src/digest.ts";
import { Store } from "./src/store.ts";

const ALLOWED_ORIGIN = "*";
const lineConfig = configFromEnv();
lineConfig.store = await Store.open();

// 1日1回、問い合わせのまとめを担当者のLINEに送る
// デフォルトは毎日 9:00（日本時間）。DIGEST_CRON は UTC の cron 式（例: "0 0 * * *" = 日本時間 9:00）
Deno.cron("line-inquiry-digest", Deno.env.get("DIGEST_CRON") ?? "0 0 * * *", async () => {
  const token = lineConfig.channelAccessToken;
  if (!token || !lineConfig.store) return;
  const result = await sendDailyDigest(lineConfig.store, token, lineConfig.adminUserIds);
  console.log("digest:", JSON.stringify(result));
});

Deno.serve(async (req) => {
  // LINE公式アカウントの Webhook（メッセージの自動仕分け）
  if (new URL(req.url).pathname === "/line/webhook") {
    if (req.method !== "POST") return new Response("OK"); // 疎通確認用
    return await handleLineWebhook(req, lineConfig);
  }

  // それ以外は従来どおり Claude API の中継
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: "API key not configured" } }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN } }
      );
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: String(e) } }),
      { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN } }
    );
  }
});
