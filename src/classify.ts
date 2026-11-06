// メッセージを「予約（ぽちこ）」「問い合わせ」「その他」に仕分ける。
//
// 1. まずパターン一致（無料・確実）でぽちこの予約メッセージを判定
// 2. 当てはまらないテキストだけ Claude で分類（ANTHROPIC_API_KEY がある場合）
// 3. 判定に失敗したら「問い合わせ」扱い（見落としを防ぐため、安全側に倒す）

import Anthropic from "npm:@anthropic-ai/sdk@^1.5.0";

export type Category = "reservation" | "inquiry" | "other";

export interface Classification {
  category: Category;
  /** どの方法で判定したか */
  method: "pattern" | "ai" | "type" | "fallback";
  reason?: string;
}

/** LINE の message イベントの message 部分（必要なところだけ） */
export interface LineMessage {
  type: string;
  text?: string;
}

/**
 * ぽちこ経由の予約メッセージを見分ける正規表現のデフォルト。
 * 実際の文面に合わせて環境変数 POCHICO_PATTERNS（1行に1つ）で上書きしてください。
 */
export const DEFAULT_POCHICO_PATTERNS = [
  "ぽちこ",
  "pochico",
  "^【?予約(リクエスト|申し?込み?|受付|確定|完了|変更|キャンセル)】?",
  "予約(を)?(受け付け|受付|確定|完了)(しました|いたしました)",
  // ぽちこの定型文（実際の文面）
  "予約したいものを選択してください",
  "現在予約はありません",
  "既に満席となっております",
  "予約可能な日がありません",
  // ぽちこ操作でお客様側から自動送信される文面（全体が一致するときだけ）
  "^\\s*[\\[［【][^\\]］】]{1,20}[\\]］】]\\s*$", // [予約を希望] [予約を確認] などメニューのボタン
  "^\\s*『[^』]+』\\s*を選択\\s*$", // 『オラクルカード占い (福岡市内)』を選択
  "^\\s*\\d{1,2}/\\d{1,2}\\s*[(（][日月火水木金土][)）]\\s*$", // 11/16(月)
  "^\\s*\\d{1,2}:\\d{2}\\s*$", // 10:15
  // リッチメニュー等から送られる短いキーワード（完全一致のみ）
  "^\\s*(予約|予約する|予約したい|予約確認|予約の確認|予約を確認|予約キャンセル|予約をキャンセル|予約変更|予約を変更|予約を確定する|確定する|予約をキャンセルする|キャンセルする)\\s*$",
];

export function parsePatterns(raw: string | undefined): RegExp[] {
  const sources = raw && raw.trim()
    ? raw.split("\n").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_POCHICO_PATTERNS;
  return sources.map((s) => new RegExp(s, "i"));
}

export function matchesPochico(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export interface ClassifierOptions {
  patterns: RegExp[];
  /** null なら AI 分類を使わない */
  anthropic: Anthropic | null;
  model?: string;
  timeoutMs?: number;
}

export async function classify(
  message: LineMessage,
  opts: ClassifierOptions,
): Promise<Classification> {
  if (message.type === "sticker") {
    return { category: "other", method: "type", reason: "スタンプのみ" };
  }
  if (message.type !== "text" || !message.text) {
    // 画像・動画・ファイル・位置情報などは人が見るべきなので問い合わせ扱い
    return { category: "inquiry", method: "type", reason: `${message.type} メッセージ` };
  }

  const text = message.text;
  if (matchesPochico(text, opts.patterns)) {
    return { category: "reservation", method: "pattern" };
  }

  if (!opts.anthropic) {
    return { category: "inquiry", method: "fallback", reason: "パターン不一致（AI分類オフ）" };
  }

  try {
    return await classifyWithClaude(text, opts);
  } catch (e) {
    console.error("AI classification failed:", e);
    return { category: "inquiry", method: "fallback", reason: "AI分類エラー" };
  }
}

const SYSTEM_PROMPT = `あなたは占い師のLINE公式アカウントに届いたメッセージを仕分ける担当です。
毎月の予約枠開放時には、予約サービス「ぽちこ」と連携した予約用のメッセージが大量に届きます。
それとは別に、お客様からの普通の問い合わせも届きます。人が返信すべきものを見落とさないことが最優先です。

次の3つのどれかに分類してください。
- reservation: ぽちこ経由の予約操作で自動的に送られた定型メッセージ（予約の申込・確定・変更・キャンセルの通知など）。人が返信する必要がないもの。
- inquiry: 人が読んで返信・対応すべきメッセージ。質問、相談、要望、予約についての質問（例:「空きはありますか？」「予約できません」）、トラブル報告、個別の事情の説明など。
- other: 返信不要な短い反応（「ありがとうございます」「了解です」など）。

予約確定後、お客様にはフルネームと紹介者の名前を送るようお願いしています。名前や紹介者を知らせるメッセージは記録が必要なので inquiry です。
迷ったら必ず inquiry にしてください。定型文の後に質問や個別の文章が付け足されている場合も inquiry です。`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["reservation", "inquiry", "other"] },
    reason: { type: "string", description: "判定理由を日本語で短く" },
  },
  required: ["category", "reason"],
  additionalProperties: false,
} as const;

async function classifyWithClaude(text: string, opts: ClassifierOptions): Promise<Classification> {
  const anthropic = opts.anthropic!;
  const response = await anthropic.messages.create(
    {
      model: opts.model ?? "claude-opus-5-5",
      max_tokens: 2000,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `次のメッセージを分類してください。\n\n<message>\n${text}\n</message>`,
      }],
    },
    { timeout: opts.timeoutMs ?? 15_000, maxRetries: 1 },
  );

  if (response.stop_reason === "refusal") {
    return { category: "inquiry", method: "fallback", reason: "AIが分類を拒否" };
  }
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    return { category: "inquiry", method: "fallback", reason: "AI応答なし" };
  }
  const parsed = JSON.parse(block.text) as { category: Category; reason: string };
  if (!["reservation", "inquiry", "other"].includes(parsed.category)) {
    return { category: "inquiry", method: "fallback", reason: "AI応答が不正" };
  }
  return { category: parsed.category, method: "ai", reason: parsed.reason };
}
