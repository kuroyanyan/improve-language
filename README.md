# Bizmates Log

Bizmates のレッスンを「受けっぱなし」にしない、自分用の学習ログ。v1 からは **自分の話を英語で言えるようにする** ことを軸にしている。

- レッスン直後に **30秒で記録**: 手応え・フリートークに使えた分数・詰まったこと・単語
- 次のレッスン前に **5分だけ予習**: 前回の詰まり → Key Phrases → **今日のピースを宣言** → 単語カード
- **自分の話ピース**: 3文＋投げ返し1問。予習で宣言し、レッスンのフリートークで見ずに言えたら回収。別の日に3回で卒業
- **60秒サンプル**: 月1回、毎回同じ3問に答えて録音。語数/分と固定ルーブリックで自己ベストを更新（合否は無い）
- **実戦**: レッスン外で英語を使ったら1行だけ残す。これが北極星
- **AI フィードバック**（任意）: 録音 → 文字起こし → Claude が詰まり・言い換え・宣言ピースの判定・聞かれた質問・質問の往復数を返す

ゴールは、世界のどこでも仕事ができる英語。テストの正解より、明日そのまま口から出る短い英語を優先する。英語は「大山スタイル」（基本語・広い動詞・1文12語以下）に縛る。

## 使い方

静的サイトなので、ビルドもサーバーも要らない。公開版: https://kuroyanyan.github.io/improve-language/

### ローカルで動かす

```bash
npm run serve        # python3 -m http.server 8787
```

`file://` で直接開くと `lessons.json` の読み込みと ES module が動かないので、必ず何かでサーブする。

### テスト

```bash
npm install && npx playwright install chromium
npm run check        # 構文と JSON
npm test             # Playwright スモーク（Pixel 7 幅・API はモック）
```

## 画面

| タブ | 何をする |
|---|---|
| 記録 | レッスン番号・手応え・フリートーク分数・宣言したピースの回収（見ずに言えた／まだ）・詰まったこと・単語・メモ。録音／文字起こし貼り付け → AI フィードバック。レッスン外の実戦を1行 |
| 5分予習 | 60s 前回の詰まり → 60s Key Phrases → 120s 今日のピースを宣言 → 60s 単語カード |
| 自分の話 | ピースの作成（日本語 → 簡単な英語に）と一覧、60秒サンプル、単語カードのレビュー |
| 履歴 | 今週の日数・言えるピース・実戦、今月の記録証、レッスン履歴、AI 設定、データ同期、JSON の書き出し／読み込み |

右上の Rank で教材を切り替える（Rank C・D）。

## AI（任意）

「履歴」タブの **AI 設定** に API キーを入れると使える。

- **Anthropic API キー**: フィードバック・ピースの英語化・サンプルの採点。モデルは `claude-opus-5`、構造化出力
- **OpenAI API キー**: 録音からの文字起こし（`gpt-4o-transcribe`）。貼り付け運用なら不要

キーは `localStorage` の `bizmates-log/keys` にだけ保存され、JSON の書き出しには含まれない。ブラウザから API を直接呼ぶので、自分だけが使う端末で使うこと。

## データ同期（任意）

集計だけを private リポジトリ `kuroyanyan/improve-language-data` に送り、週1の改善ループが読む。送るのは週ごとの集計・ピースの英文と回数・サンプルの数値・実戦の1行。文字起こし・音声・メモ・キーは送らない。認証はそのリポジトリだけに絞った fine-grained トークン（Contents: Read and write）。

## 改善ループ

このアプリは週1回のループで育てる。目的・指標・ガードレール・上方修正の規則は [docs/LOOP.md](docs/LOOP.md)。変更ゼロが既定で、挙動を変える PR には [docs/hypotheses/](docs/hypotheses/) の仮説ファイルが必要（CI が確認する）。

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
assets/sync.js               データ同期
assets/ai.js                 録音・文字起こし・Claude
assets/data/lessons.json     教材データ
docs/                        改善ループの規約・仮説・ルーティン
tests/                       Playwright スモークテスト
.github/workflows/           Pages デプロイと CI
```

依存ライブラリなし（テストの Playwright を除く）。フォントだけ Google Fonts。

## ライセンス

MIT
