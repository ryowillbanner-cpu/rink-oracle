// 仕分け結果の通知・記録

import type { Classification } from "./classify.ts";

export interface MessageRecord {
  timestamp: string;
  userId: string;
  displayName: string;
  messageType: string;
  text: string;
  classification: Classification;
}

const CATEGORY_LABEL: Record<Classification["category"], string> = {
  reservation: "予約（ぽちこ）",
  inquiry: "問い合わせ",
  other: "その他",
};

export function formatInquiry(r: MessageRecord): string {
  const body = r.text || `（${r.messageType} メッセージ）`;
  return [
    `📩 LINEに問い合わせが届きました`,
    `👤 ${r.displayName}`,
    `🕒 ${formatJst(r.timestamp)}`,
    `💬 ${body}`,
    r.classification.reason ? `（判定: ${r.classification.reason}）` : "",
    `→ LINE公式アカウントのチャットで返信してください`,
  ].filter(Boolean).join("\n");
}

function formatJst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

/** Slack / Discord の Incoming Webhook に通知 */
export async function sendChatNotification(url: string, text: string): Promise<void> {
  const payload = /discord(app)?\.com/.test(url) ? { content: text } : { text };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`notification failed: ${res.status} ${await res.text()}`);
}

/** スタッフのLINEへプッシュ通知（LINEの無料メッセージ数を消費する点に注意） */
export async function sendLinePush(
  accessToken: string,
  to: string,
  text: string,
): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`LINE push failed: ${res.status} ${await res.text()}`);
}

/** Googleスプレッドシート（Apps Script のウェブアプリ）などに全件を記録 */
export async function sendLog(url: string, record: MessageRecord): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...record,
      category: record.classification.category,
      categoryLabel: CATEGORY_LABEL[record.classification.category],
      method: record.classification.method,
      reason: record.classification.reason ?? "",
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`log failed: ${res.status}`);
}
