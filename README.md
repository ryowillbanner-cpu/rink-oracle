# rink-oracle

## LINE公式アカウントのメッセージ自動仕分け

予約枠を開放したときに届く「ぽちこ」経由の予約メッセージと、普通の問い合わせを自動で仕分けます。
**人が返信すべき問い合わせだけ**を Slack / Discord / スタッフのLINE に通知するので、全件を確認する必要がなくなります。

```
LINE ──Webhook──▶ /line/webhook（このサーバー）
                      ├─ そのまま ぽちこ に転送（予約機能はこれまでどおり動く）
                      └─ 仕分け
                           ├─ 予約（ぽちこ）→ 通知しない
                           ├─ その他（スタンプ・「ありがとう」など）→ 通知しない
                           └─ 問い合わせ → Slack / Discord / LINE に通知
```

### 仕分けのしくみ

1. **パターン一致**：ぽちこの定型文に当てはまれば「予約」と判定します（無料）。
2. **AI分類**：パターンに当てはまらないテキストだけ Claude で分類します（`ANTHROPIC_API_KEY` を設定した場合）。
3. **迷ったら「問い合わせ」**：AIがエラーになったときや判断がつかないときは、見落とさないように通知します。
4. 画像・ファイルなどは「問い合わせ」、スタンプだけのものは「その他」として扱います。

> ⚠️ LINE公式アカウントのチャット画面には、これまでどおり全てのメッセージが表示されます（既読やタグはつけられません）。
> 「通知が来たものにだけ返信すればいい」という運用になります。

### セットアップ

#### 1. 今のWebhook URLを控える

[LINE Developers](https://developers.line.biz/console/) →（チャネル）→「Messaging API設定」→「Webhook URL」を見てください。

- **ぽちこのURLが入っている場合**：そのURLを控えて、`POCHICO_WEBHOOK_URL` に設定します（とても大事です。設定しないとぽちこが動かなくなります）。
- **空欄の場合**：`POCHICO_WEBHOOK_URL` は設定しなくて大丈夫です。

#### 2. 環境変数を設定してデプロイ（Deno Deploy など）

| 変数 | 必須 | 内容 |
|---|---|---|
| `LINE_CHANNEL_SECRET` | ✅ | 「チャネル基本設定」のチャネルシークレット |
| `LINE_CHANNEL_ACCESS_TOKEN` | おすすめ | 「Messaging API設定」のチャネルアクセストークン（長期）。通知にお客様の表示名を出すため、またLINE通知に使います |
| `POCHICO_WEBHOOK_URL` | 条件付き | 手順1で控えたぽちこのWebhook URL |
| `NOTIFY_WEBHOOK_URL` | どれか1つ | Slack または Discord の Incoming Webhook URL |
| `LINE_ADMIN_USER_IDS` | どれか1つ | 通知を受け取るスタッフのLINEユーザーID（カンマ区切り）。※LINEの無料メッセージ数を消費します |
| `ANTHROPIC_API_KEY` | おすすめ | AI分類に使います。未設定ならパターン不一致はすべて「問い合わせ」として通知します |
| `POCHICO_PATTERNS` | 任意 | ぽちこの予約メッセージを見分ける正規表現（1行に1つ）。下の「パターンの調整」を参照 |
| `LOG_WEBHOOK_URL` | 任意 | 全メッセージの仕分け結果を記録する先（Googleスプレッドシート用。下を参照） |
| `CLASSIFY_MODEL` | 任意 | AI分類に使うモデル（デフォルト: `claude-opus-5-5`） |
| `AI_CLASSIFY` | 任意 | `off` にするとAI分類を止めます |

#### 3. LINEのWebhook URLを差し替える

LINE Developers の「Webhook URL」を `https://<デプロイ先>/line/webhook` に変更し、「検証」ボタンで成功することを確認します。
そのあと、テスト用のアカウントから **ぽちこで実際に予約してみて、ぽちこが今までどおり動くこと**を必ず確認してください。

### LINEに通知する

問い合わせが来ると、公式アカウントからスタッフ本人のLINEに通知が届きます。

1. スタッフのLINEで、この公式アカウントを友だち追加しておく
2. [LINE Developers](https://developers.line.biz/console/) →（チャネル）→「チャネル基本設定」の一番下にある **「あなたのユーザーID」**（`U` で始まる33文字）をコピー
3. 環境変数を設定
   - `LINE_ADMIN_USER_IDS` = コピーしたユーザーID（複数人ならカンマ区切り）
   - `LINE_CHANNEL_ACCESS_TOKEN` = 「Messaging API設定」→「チャネルアクセストークン（長期）」で発行したもの

> ⚠️ この通知は、公式アカウントの「月の無料メッセージ数」を1件ずつ使います（通知する人数 × 問い合わせ件数）。
> 残りの数は LINE Official Account Manager の「利用状況」で確認できます。

### パターンの調整（大事）

最初から入っているパターンは仮のものです。ぽちこから実際に届くメッセージの文面に合わせて `POCHICO_PATTERNS` を設定すると、AIを使わずに確実・無料で仕分けられます。

例：ぽちこのメッセージが「【予約リクエスト】」で始まり、「鑑定メニュー：」を含む場合

```
^【予約リクエスト】
鑑定メニュー：
```

### Googleスプレッドシートに記録する（任意）

仕分けがうまくいっているか確認したり、月ごとの件数を数えたりできます。

1. スプレッドシートを作り、「拡張機能」→「Apps Script」に次を貼り付けます。

```js
function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  SpreadsheetApp.getActiveSheet().appendRow([
    d.timestamp, d.categoryLabel, d.displayName, d.text, d.method, d.reason, d.userId,
  ]);
  return ContentService.createTextOutput("ok");
}
```

2. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」、アクセスできるユーザー「全員」でデプロイします。
3. 表示されたURLを `LOG_WEBHOOK_URL` に設定します。

### 開発

```bash
deno test --allow-env src/   # テスト
deno run --allow-net --allow-env server.ts
```

`/line/webhook` 以外のパスは、これまでどおり Claude API の中継として動きます。
