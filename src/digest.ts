// 1日1回、たまった問い合わせを担当者のLINEにまとめて送る。
// 1回の送信（最大5吹き出し）は、1人につき1通としてカウントされる。

import type { MessageRecord } from "./notify.ts";
import { sendLinePushMessages } from "./notify.ts";
import type { Store } from "./store.ts";

const MAX_BUBBLES = 5;
const MAX_CHARS = 4800; // LINEの上限は5000文字。少し余裕を持たせる

function formatJst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatItem(r: MessageRecord, index: number): string {
  const body = r.text ? r.text : `（${r.messageType}）`;
  const short = body.length > 300 ? body.slice(0, 300) + "…" : body;
  return `${index}. ${r.displayName}（${formatJst(r.timestamp)}）\n${short}`;
}

/** 問い合わせ一覧を、LINEの吹き出し（最大5つ）に収まるように組み立てる */
export function buildDigestMessages(records: MessageRecord[]): string[] {
  const header = `📩 問い合わせのまとめ（${records.length}件）\nLINE公式アカウントのチャットで返信してください。`;
  const bubbles: string[] = [header];
  let shown = 0;

  for (const [i, r] of records.entries()) {
    const item = formatItem(r, i + 1);
    const last = bubbles.length - 1;
    if ((bubbles[last] + "\n\n" + item).length <= MAX_CHARS) {
      bubbles[last] += "\n\n" + item;
    } else if (bubbles.length < MAX_BUBBLES) {
      bubbles.push(item);
    } else {
      break;
    }
    shown++;
  }

  if (shown < records.length) {
    const note = `\n\n…ほか${records.length - shown}件はチャットで確認してください。`;
    const last = bubbles.length - 1;
    bubbles[last] = bubbles[last].slice(0, MAX_CHARS - note.length) + note;
  }
  return bubbles;
}

export interface DigestResult {
  inquiries: number;
  recipients: number;
  sent: number;
}

export async function sendDailyDigest(
  store: Store,
  accessToken: string,
  extraRecipients: string[] = [],
): Promise<DigestResult> {
  const pending = await store.listPending();
  const staff = (await store.listStaff()).map((s) => s.userId);
  const recipients = [...new Set([...staff, ...extraRecipients])];

  // 問い合わせが0件の日は送らない（無料メッセージ数を節約）
  if (pending.length === 0 || recipients.length === 0) {
    return { inquiries: pending.length, recipients: recipients.length, sent: 0 };
  }

  const messages = buildDigestMessages(pending.map((p) => p.record));
  let sent = 0;
  for (const to of recipients) {
    try {
      await sendLinePushMessages(accessToken, to, messages);
      sent++;
    } catch (e) {
      console.error(`digest push to ${to} failed:`, e);
    }
  }

  // 1人にでも届いたら送信済みとして消す（全員失敗なら翌日に再送）
  if (sent > 0) await store.deleteKeys(pending.map((p) => p.key));
  return { inquiries: pending.length, recipients: recipients.length, sent };
}
