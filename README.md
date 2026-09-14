# Bizmates Log

Bizmates のレッスンを「受けっぱなし」にしないための、自分用の学習ログ。

- レッスン直後に **30秒で記録**：詰まったこと・出てきた単語・手応え
- 次のレッスン前に **5分だけ予習**：前回の詰まり → Key Phrases 音読 → 自分の1文 → 単語カード
- 記録した詰まり・単語は **単語カード**（Leitner 方式）になって、日本語→英語で復習
- レッスンを **録音 → 文字起こし → Claude のフィードバック**（任意）。Notion などの文字起こしを貼り付けても使える

ゴールは、世界のどこでも仕事ができる英語を身につけること。テストの正解より、明日そのまま口から出る短い英語を優先する設計にしている。

## 使い方

静的サイトなので、ビルドもサーバーも要らない。

### GitHub Pages で使う（おすすめ）

1. このリポジトリを GitHub に push する
2. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
3. `main` に push すると `.github/workflows/pages.yml` が自動でデプロイする
4. `https://<ユーザー名>.github.io/bizmates-log/` をスマホのホーム画面に追加

### ローカルで使う

```bash
npx serve .        # または python3 -m http.server 8080
```

`file://` で直接開くと `lessons.json` の読み込みと ES module が動かないので、必ず何かでサーブする。

## 画面

| タブ | 何をする |
|---|---|
| 記録 | レッスン番号・手応え・詰まったこと・単語・メモを保存。録音／文字起こし貼り付け → AI フィードバックもここ |
| 5分予習 | 次のレッスンに向けた 5 分のガイド付きタイマー（60s / 100s / 80s / 60s） |
| 単語 | 今日ぶんのカードを日本語→英語で。◎なら次は間隔が伸び、△なら今日もう一度 |
| 履歴 | レッスン一覧・連続日数・正答率、AI 設定、JSON の書き出し／読み込み |

## AI フィードバック（任意）

「履歴」タブの **AI 設定** に API キーを入れると使える。

- **Anthropic API キー**（必須）: 文字起こしを読んで、直したい表現・詰まった箇所・覚える語・Key Phrases が使えたか・次回の一点を返す。モデルは `claude-opus-5`
- **OpenAI API キー**（録音から文字起こしする場合のみ）: `gpt-4o-transcribe` で文字起こし。Notion などの文字起こしを貼り付ける運用なら不要

日英が混ざった文字起こしは ASR が苦手で、英語部分と日本語部分の認識精度に差が出やすい。このアプリでは、レッスンのトピックと Key Phrases を文脈として Claude に渡し、**誤認識の復元と話者分離をしてから**フィードバックを作る。自信がない箇所は `[?]` 付きで残す。

### キーの扱い

- キーは `localStorage` の `bizmates-log/keys` にだけ保存され、**JSON の書き出しには含まれない**
- ブラウザから API を直接呼ぶので、**自分だけが使う端末**で使うこと。共有 PC には入れない
- 使用量の上限は各 API の管理画面で設定しておくと安心

## データ

- 記録はすべてブラウザの `localStorage`（キー `bizmates-log/v1`）。サーバーには何も送らない（AI を使うときの文字起こしテキストを除く）
- 端末を変えるときは「履歴 → JSON を書き出す」→ 新しい端末で「読み込む」
- 音声は保存しない。必要なら録音後に「音声を保存」でダウンロード

## 教材データ

`assets/data/lessons.json` に Bizmates Program Level 1 Rank C（Lesson 1–20）のトピックと Key Phrases が入っている。Rank が進んだら同じ形式で追加する。

```json
{ "lesson": 13, "rank": "C", "level": "1", "topic": "Explaining Procedures",
  "type": "regular", "keyPhrases": ["In order to", "First, I need to", "..."] }
```

## 構成

```
index.html              画面
assets/styles.css       見た目（朝プレップのページと同じ配色）
assets/app.js           記録・予習・カード・履歴
assets/ai.js            録音・文字起こし・Claude フィードバック
assets/data/lessons.json 教材データ
.github/workflows/pages.yml  GitHub Pages デプロイ
```

依存ライブラリなし。フォントだけ Google Fonts。

## ライセンス

MIT
