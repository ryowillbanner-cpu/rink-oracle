// LINE Messaging API の Webhook を受け取り、
//  - ぽちこへそのまま転送（ぽちこの予約機能を壊さないため）
//  - メッセージを仕分けて、問い合わせだけを保存（1日1回、担当者のLINEにまとめて通知）
//  - 「担当者登録 <コード>」で担当者のLINEを通知先に登録
// する。

import Anthropic from "npm:@anthropic-ai/sdk@^1.5.0";
import { classify, type ClassifierOptions, type LineMessage, parsePatterns } from "./classify.ts";
import { verifySignature } from "./line_signature.ts";
import { formatInquiry, type MessageRecord, sendChatNotification, sendLineReply, sendLog } from "./notify.ts";
import type { Store } from "./store.ts";

export interface WebhookConfig {
  channelSecret: string;
  channelAccessToken?: string;
  /** ぽちこの Webhook URL（ぽちこが Webhook を使っている場合に設定） */
  pochicoWebhookUrl?: string;
  /** Slack / Discord の Incoming Webhook URL */
  notifyWebhookUrl?: string;
  /** 環境変数で固定する通知先の LINE ユーザーID（任意。普段は「担当者登録」で登録する） */
  adminUserIds: string[];
  /** 担当者登録用の合言葉。未設定なら登録できない */
  staffRegisterCode?: string;
  /** 担当者と通知待ちの問い合わせの保存先 */
  store: Store | null;
  /** 全メッセージの記録先（Google Apps Script など） */
  logWebhookUrl?: string;
  classifier: ClassifierOptions;
}

export function configFromEnv(): WebhookConfig {
  const env = (k: string) => Deno.env.get(k)?.trim() || undefined;
  const aiEnabled = env("AI_CLASSIFY") !== "off";
  const apiKey = env("ANTHROPIC_API_KEY");
  return {
    channelSecret: env("LINE_CHANNEL_SECRET") ?? "",
    channelAccessToken: env("LINE_CHANNEL_ACCESS_TOKEN"),
    pochicoWebhookUrl: env("POCHICO_WEBHOOK_URL"),
    notifyWebhookUrl: env("NOTIFY_WEBHOOK_URL"),
    adminUserIds: (env("LINE_ADMIN_USER_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    logWebhookUrl: env("LOG_WEBHOOK_URL"),
    staffRegisterCode: env("STAFF_REGISTER_CODE"),
    store: null,
    classifier: {
      patterns: parsePatterns(Deno.env.get("POCHICO_PATTERNS")),
      anthropic: aiEnabled && apiKey ? new Anthropic({ apiKey }) : null,
      model: env("CLASSIFY_MODEL"),
    },
  };
}

interface LineEvent {
  type: string;
  timestamp: number;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: LineMessage & { id: string };
  deliveryContext?: { isRedelivery: boolean };
}

export async function handleLineWebhook(req: Request, config: WebhookConfig): Promise<Response> {
  if (!config.channelSecret) {
    console.error("LINE_CHANNEL_SECRET is not set");
    return new Response("Server not configured", { status: 500 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature");
  if (!(await verifySignature(config.channelSecret, rawBody, signature))) {
    return new Response("Invalid signature", { status: 401 });
  }

  // 1. ぽちこへ転送（同じボディ・同じ署名なので、ぽちこ側の署名検証もそのまま通る）
  if (config.pochicoWebhookUrl) {
    await forwardToPochico(config.pochicoWebhookUrl, rawBody, signature!);
  }

  // 2. 仕分けと通知
  let events: LineEvent[] = [];
  try {
    events = (JSON.parse(rawBody).events ?? []) as LineEvent[];
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  await Promise.all(
    events
      .filter((e) => e.type === "message" && e.message)
      .map((e) => processMessageEvent(e, config).catch((err) => console.error("process failed:", err))),
  );

  return new Response("OK");
}

async function forwardToPochico(url: string, body: string, signature: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-line-signature": signature },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) console.error(`forward to pochico failed: ${res.status}`);
  } catch (e) {
    console.error("forward to pochico error:", e);
  }
}

async function processMessageEvent(event: LineEvent, config: WebhookConfig): Promise<void> {
  const message = event.message!;
  const userId = event.source?.userId ?? "";

  if (message.type === "text" && message.text && userId && (await handleStaffCommand(event, message.text, userId, config))) {
    return;
  }

  const classification = await classify(message, config.classifier);
  const displayName = await getDisplayName(userId, config.channelAccessToken);

  const record: MessageRecord = {
    timestamp: new Date(event.timestamp).toISOString(),
    userId,
    displayName,
    messageType: message.type,
    text: message.text ?? "",
    classification,
  };
  console.log(JSON.stringify({ category: classification.category, method: classification.method, userId }));

  const tasks: Promise<void>[] = [];
  if (config.logWebhookUrl) tasks.push(sendLog(config.logWebhookUrl, record));

  if (classification.category === "inquiry") {
    const text = formatInquiry(record);
    if (config.notifyWebhookUrl) tasks.push(sendChatNotification(config.notifyWebhookUrl, text));
    // LINEへの通知は1日1回まとめて送る（digest.ts）
    if (config.store) tasks.push(config.store.addPending(message.id, record));
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === "rejected") console.error(r.reason);
}

/** 担当者登録・解除のコマンドなら処理して true を返す */
async function handleStaffCommand(
  event: LineEvent,
  text: string,
  userId: string,
  config: WebhookConfig,
): Promise<boolean> {
  const { store, staffRegisterCode, channelAccessToken } = config;
  if (!store || !staffRegisterCode) return false;
  const t = text.trim().replace(/\s+/g, " ");

  let reply: string | null = null;
  if (t === `担当者登録 ${staffRegisterCode}`) {
    const displayName = await getDisplayName(userId, channelAccessToken);
    await store.addStaff({ userId, displayName, registeredAt: new Date().toISOString() });
    reply = `✅ ${displayName}さんを担当者として登録しました。\n毎日1回、問い合わせのまとめをこのトークに送ります。\n（解除するときは「担当者解除」と送ってください）`;
  } else if (t === "担当者解除" && (await store.isStaff(userId))) {
    await store.removeStaff(userId);
    reply = "担当者の登録を解除しました。";
  } else {
    return false;
  }

  if (channelAccessToken && event.replyToken) {
    await sendLineReply(channelAccessToken, event.replyToken, [reply]).catch((e) => console.error(e));
  }
  return true;
}

async function getDisplayName(userId: string, token?: string): Promise<string> {
  if (!userId || !token) return userId || "（不明）";
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return userId;
    const profile = await res.json() as { displayName?: string };
    return profile.displayName ?? userId;
  } catch {
    return userId;
  }
}
