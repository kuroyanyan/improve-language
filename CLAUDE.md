# improve-language（Bizmates Log）— Claude Code ガードレール

## これは何
黒川広貴（kuroyanyan）個人の英語学習ログ Web アプリ。Bizmates のレッスンを「自分の話を英語で言えるようにする練習」に変える。
静的サイト・依存なし・データは端末の localStorage。公開先は GitHub Pages（https://kuroyanyan.github.io/improve-language/）。

## 絶対遵守
- **GitHub は kuroyanyan 個人アカウントのみ。** japantradingcardcenter には絶対に push しない。日本トレカセンター（JTCC）とは無関係。「JTC」という略称は使わない。
- **このリポジトリは public。** 個人データ（文字起こし・メモ・ピースの日本語・実戦の内容）と Bizmates の教材本文を入れない。lessons.json はトピック名と Key Phrases だけ。
- **規約は `docs/LOOP.md`。** 目的・指標・ガードレール G0〜G11・週次サイクルはそこが唯一のソース。
- **変更ゼロが既定。1サイクル1変更。** アプリの挙動を変える PR は `docs/hypotheses/H-*.md` を追加か更新する（CI が確認する）。保守は title を `fix:` `chore:` `data:` `docs:` `test:` `ci:` で始める。
- **merge は黒川さん。** Claude は PR を出すまで。main に直接 push しない。
- **時間予算**: 1日6分（記録30秒＋予習5分）、月1回3分。超える変更は出さない。
- ビルドを増やさない。ランタイム依存を足さない（devDependencies の Playwright だけ）。

## 開発
```bash
npm install                 # 初回のみ（Playwright）
npx playwright install chromium
npm run serve               # http://127.0.0.1:8787
npm run check               # 構文と JSON
npm test                    # Playwright スモーク（Pixel 7 幅）
```
`file://` では ES module と fetch が動かないので、必ずサーブする。

## データの所在
- 記録の本体: 端末の localStorage `bizmates-log/v1`（書き出し JSON）
- API キー・同期トークン: localStorage `bizmates-log/keys`（書き出しに含めない）
- 集計の同期先: `kuroyanyan/improve-language-data`（private）。週次ループが読む。
- カンペ: 同じ private リポジトリの `kanpe/{rank}/NN.html`（教材の See 原文を含むので公開側には置かない）。アプリが同期トークンで読む。新 Rank は教材 HTML → digest → 生成 → 追加（保守 `data:`）。

## 構成
```
index.html                画面（記録 / 5分予習 / 自分の話 / 履歴）
assets/app.js             状態・記録・予習・履歴・ランク切替・モジュール配線
assets/pieces.js          自分史ピース（3文＋質問、宣言→回収、卒業）
assets/sample.js          月1の60秒サンプル（録音→文字起こし→固定ルーブリック採点）
assets/sync.js            集計スナップショットと GitHub への同期・private ファイルの読み取り
assets/kanpe.js           カンペタブ（private リポジトリから取得・端末に保存・表示）
assets/ai.js              Claude / OpenAI 呼び出し、録音、AI フィードバック
assets/data/lessons.json  Rank C・D のトピックと Key Phrases
docs/LOOP.md              改善ループの規約（目的・指標・ガードレール）
docs/hypotheses/          仮説ファイル（判定基準を先に固定）
docs/routine/             週次ルーティンのプロンプト
tests/smoke.spec.js       Playwright スモークテスト
```
