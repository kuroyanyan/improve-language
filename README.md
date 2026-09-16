# Bizmates Log

Bizmates のレッスンを「受けっぱなし」にしない、自分用の学習ログ。v1 からは **自分の話を英語で言えるようにする** ことを軸にしている。

毎日の流れは画面上部に出ていて、開くとその日にやる場所から始まる。

**① カンペ**（レッスン中に開く） → **② 記録**（終わってから30秒） → **③ 5分予習**（次のレッスンの分）

- レッスン直後に **30秒で記録**: 手応え・フリートークに使えた分数・詰まったこと・単語
- 次のレッスン前に **5分だけ予習**: 前回の詰まり → Key Phrases → **今日のピースを宣言** → 単語カード
- **自分の話ピース**: 3文＋投げ返し1問。予習で宣言し、レッスンのフリートークで見ずに言えたら回収。別の日に3回で卒業
- **60秒サンプル**: 月1回、毎回同じ3問に答えて録音。語数/分と固定ルーブリックで自己ベストを更新（合否は無い）
- **実戦**: レッスン外で英語を使ったら1行だけ残す。これが北極星
- **AI フィードバック**（任意）: 録音 → 文字起こし → Claude が詰まり・言い換え・宣言ピースの判定・聞かれた質問・質問の往復数を返す

ゴールは、世界のどこでも仕事ができる英語。テストの正解より、明日そのまま口から出る短い英語を優先する。英語は「大山スタイル」（基本語・広い動詞・1文12語以下）に縛る。

## 使い方

アプリと、その裏方（小さな Node サーバー）を Railway 1つで動かす。API キーと GitHub トークンはサーバーの環境変数にあり、ブラウザには一切渡らない。設定画面は無い。

### ローカルで動かす

```bash
npm start
```

http://localhost:8080 で開く。環境変数（下記）が無くても画面は動き、AI とカンペだけが使えない。

### 環境変数（Railway の Variables）

| 変数 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | フィードバック・ピースの英語化・サンプル採点（`claude-opus-5`） |
| `OPENAI_API_KEY` | 録音の文字起こし（`gpt-4o-transcribe`） |
| `GITHUB_TOKEN` | private リポジトリ（カンペと記録）の読み書き |
| `APP_PASSCODE` | 本人だけが入れるようにする合言葉。未設定だと誰でも開ける |
| `SESSION_SALT` | 任意。ログイン状態の署名に使う。未設定だと再起動のたびに入れ直しになる |
| `DATA_REPO` | 任意。既定は `kuroyanyan/improve-language-data` |

### テスト

```bash
npm install && npx playwright install chromium
npm run check        # 構文と JSON
npm test             # Playwright スモーク（Pixel 7 幅・API はモック）
```

## 画面

| タブ | 何をする |
|---|---|
| 記録 | 録音／文字起こし貼り付け → AI が詰まったこと・単語・宣言ピースの判定を自動で記録に入れる（要らないものは ✕）。レッスン番号・手応え・フリートーク分数・メモ。手入力は畳んだ任意項目。レッスン外の実戦を1行 |
| 5分予習 | 次のレッスンに連動。60s 前回の詰まり → 60s 今日の型と Key Phrases（カンペから） → 120s **Act の想定問答**（日本語で答える → 簡単な英語にする → 次回これを言うと決める） → 60s 単語カード。読むものは最初から全部出ていて、タイマーは任意 |
| カンペ | レッスンごとの「今日の型・Key Phrases・See・Try・準備の質問・Act・追撃質問・細かい注意」。裏方が private リポジトリから返し、端末に保存（2回目からはオフラインで開ける） |
| 自分の話 | ピースの作成（日本語 → 簡単な英語に）と一覧、60秒サンプル、単語カードのレビュー |
| 履歴 | 今週の日数・言えるピース・実戦、今月の記録証、レッスン履歴。設定は無い |

右上の Rank で教材を切り替える（Rank C・D）。

## AI

ブラウザは AI を直接呼ばない。裏方の `/api/transcribe`・`/api/ai/feedback`・`/api/ai/piece`・`/api/ai/sample` に頼み、サーバーが `gpt-4o-transcribe` と `claude-opus-5`（構造化出力・拒否時はサーバー側フォールバック）を呼ぶ。プロンプトとスキーマもサーバー側（`server/claude.js`）にある。

## 記録の置き場

記録は端末の `localStorage` と、裏方経由で private リポジトリ `kuroyanyan/improve-language-data` の `state.json` の両方に自動で残る。週1の改善ループが読む集計は同じく `latest.json`。書き出し・移行・削除の画面は持たず、Claude に頼む運用。

## 改善ループ

このアプリは週1回のループで育てる。目的・指標・ガードレール・上方修正の規則は [docs/LOOP.md](docs/LOOP.md)。変更ゼロが既定で、挙動を変える PR には [docs/hypotheses/](docs/hypotheses/) の仮説ファイルが必要（CI が確認する）。

## カンペ

全レッスンのカンペ（教材の See 原文を含む）は公開リポジトリに置かず、private の `kuroyanyan/improve-language-data` の `kanpe/{rank}/NN.html` にある。アプリはデータ同期のトークンでこれを読み、端末の localStorage に保存する。Rank が進んだら教材 HTML からカンペを生成して同じ場所に足す（保守）。

## 教材データ

`assets/data/lessons.json` に Bizmates Program Level 1 Rank C・D（各 Lesson 1–20）のトピックと Key Phrases が入っている。教材本文は入れない。

```json
{ "lesson": 14, "rank": "D", "level": "1", "topic": "Talking About Motivation",
  "type": "regular", "keyPhrases": ["I feel motivated when", "The other day"] }
```

## 構成

```
index.html                   画面
assets/styles.css            見た目
assets/app.js                記録・予習・履歴・ランク切替・配線
assets/pieces.js             自分史ピース
assets/sample.js             60秒サンプル
assets/sync.js               データ同期・private リポジトリの読み取り
assets/kanpe.js              カンペの取得・表示
assets/ai.js                 録音・文字起こし・Claude
assets/data/lessons.json     教材データ
docs/                        改善ループの規約・仮説・ルーティン
tests/                       Playwright スモークテスト
.github/workflows/           Pages デプロイと CI
```

依存ライブラリなし（テストの Playwright を除く）。フォントだけ Google Fonts。

## ライセンス

MIT
