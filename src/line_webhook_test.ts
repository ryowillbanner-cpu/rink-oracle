import { assert, assertEquals } from "jsr:@std/assert@1";
import { classify, parsePatterns } from "./classify.ts";
import { computeSignature, verifySignature } from "./line_signature.ts";
import { handleLineWebhook, type WebhookConfig } from "./line_webhook.ts";

const SECRET = "test-secret";

Deno.test("signature: valid and invalid", async () => {
  const body = '{"events":[]}';
  const sig = await computeSignature(SECRET, body);
  assert(await verifySignature(SECRET, body, sig));
  assert(!(await verifySignature(SECRET, body + " ", sig)));
  assert(!(await verifySignature(SECRET, body, null)));
});

Deno.test("classify: pattern / type / fallback", async () => {
  const opts = { patterns: parsePatterns(undefined), anthropic: null };
  assertEquals((await classify({ type: "text", text: "【予約リクエスト】11/20 14:00" }, opts)).category, "reservation");
  assertEquals((await classify({ type: "text", text: "ぽちこで予約しました" }, opts)).category, "reservation");
  assertEquals((await classify({ type: "text", text: "恋愛の相談をしたいです" }, opts)).category, "inquiry");
  for (const t of [
    "予約したいものを選択してください☟",
    "現在予約はありません。",
    "ご指定いただいた時間は、既に満席となっております。別の時間帯をご指定ください。",
    "予約する",
    " 予約確認 ",
    "[予約を希望]",
    "[予約を確認]",
    "『オラクルカード占い　　(福岡市内)』を選択",
    "『オラクルカード占い　　(久留米)』を選択",
    "11/16(月)",
    "10:15",
    "予約可能な日がありません",
    "09:00",
    "予約を確定する",
  ]) {
    assertEquals((await classify({ type: "text", text: t }, opts)).category, "reservation", t);
  }
  // キーワードの後に文章があれば人が見るべき問い合わせ
  assertEquals((await classify({ type: "text", text: "予約したいのですが空きはありますか？" }, opts)).category, "inquiry");
  assertEquals((await classify({ type: "text", text: "11/16(月)の10:15は空いていますか？" }, opts)).category, "inquiry");
  assertEquals((await classify({ type: "text", text: "[予約を希望] ですが、時間を変えたいです" }, opts)).category, "inquiry");
  assertEquals((await classify({ type: "text", text: "山田花子です。紹介者は佐藤さんです" }, opts)).category, "inquiry");
  assertEquals((await classify({ type: "sticker" }, opts)).category, "other");
  assertEquals((await classify({ type: "image" }, opts)).category, "inquiry");
});

Deno.test("classify: custom patterns from env string", async () => {
  const opts = { patterns: parsePatterns("^予約番号:\\d+\n鑑定メニュー："), anthropic: null };
  assertEquals((await classify({ type: "text", text: "予約番号:1234" }, opts)).category, "reservation");
  assertEquals((await classify({ type: "text", text: "ぽちこ" }, opts)).category, "inquiry");
});

Deno.test("webhook: forwards to pochico and notifies only inquiries", async () => {
  const calls: { url: string; body: string; sig: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, body: String(init?.body ?? ""), sig: headers.get("x-line-signature") });
    return new Response("ok");
  }) as typeof fetch;

  try {
    const config: WebhookConfig = {
      channelSecret: SECRET,
      pochicoWebhookUrl: "https://pochico.example/webhook",
      notifyWebhookUrl: "https://hooks.slack.com/services/x",
      adminUserIds: [],
      classifier: { patterns: parsePatterns(undefined), anthropic: null },
    };
    const event = (id: string, text: string) => ({
      type: "message",
      timestamp: 1_700_000_000_000,
      source: { type: "user", userId: "U" + id },
      message: { id, type: "text", text },
    });
    const body = JSON.stringify({
      events: [event("1", "【予約リクエスト】12/1 10:00"), event("2", "支払い方法を教えてください")],
    });
    const sig = await computeSignature(SECRET, body);

    const res = await handleLineWebhook(
      new Request("http://localhost/line/webhook", {
        method: "POST",
        headers: { "x-line-signature": sig },
        body,
      }),
      config,
    );
    assertEquals(res.status, 200);

    const forwarded = calls.filter((c) => c.url.startsWith("https://pochico.example"));
    assertEquals(forwarded.length, 1);
    assertEquals(forwarded[0].body, body);
    assertEquals(forwarded[0].sig, sig);

    const notified = calls.filter((c) => c.url.startsWith("https://hooks.slack.com"));
    assertEquals(notified.length, 1);
    assert(JSON.parse(notified[0].body).text.includes("支払い方法"));

    const bad = await handleLineWebhook(
      new Request("http://localhost/line/webhook", {
        method: "POST",
        headers: { "x-line-signature": "wrong" },
        body,
      }),
      config,
    );
    assertEquals(bad.status, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});
