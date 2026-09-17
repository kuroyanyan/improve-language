# improve-language（Bizmates Log）— Claude Code ガードレール

## これは何
黒川広貴（kuroyanyan）個人の英語学習ログ Web アプリ。Bizmates のレッスンを「自分の話を英語で言えるようにする練習」に変える。
アプリ＋小さな裏方サーバー（Node、依存なし）。Railway 1つで配信と中継をまかなう。API キーと GitHub トークンはサーバーの環境変数にあり、ブラウザには渡さない。設定画面は作らない。

## 絶対遵守
- **GitHub は kuroyanyan 個人アカウントのみ。** japantradingcardcenter には絶対に push しない。日本トレカセンター（JTCC）とは無関係。「JTC」という略称は使わない。
- **このリポジトリは public。** 個人データ（文字起こし・メモ・ピースの日本語・実戦の内容）と Bizmates の教材本文を入れない。lessons.json はトピック名と Key Phrases だけ。
- **デプロイ先と環境変数は `docs/RAILWAY.md`。** キーは Railway の環境変数にあり、Claude は扱わない。
- **規約は `docs/LOOP.md`。** 目的・指標・ガードレール G0〜G11・週次サイクルはそこが唯一のソース。
- **変更ゼロが既定。1サイクル1変更。** アプリの挙動を変える PR は `docs/hypotheses/H-*.md` を追加か更新する（CI が確認する）。保守は title を `fix:` `chore:` `data:` `docs:` `test:` `ci:` で始める。
- **merge は黒川さん。** Claude は PR を出すまで。main に直接 push しない。
- **時間予算**: 1日6分（記録30秒＋予習5分）、月1回3分。超える変更は出さない。
- ビルドを増やさない。ランタイム依存を足さない（devDependencies の Playwright だけ）。

## 開発
```bash
npm install                 # 初回のみ（Playwright）
npx playwright install chromium
npm start                   # http://localhost:8080（裏方ごと起動）
npm run check               # 構文と JSON
npm test                    # Playwright スモーク（/api/* はモック）
```
キーが無くても画面は動く（AI とカンペだけ使えない）。ブラウザから外部 API を直接呼ぶコードを足さないこと。

## データの所在
- 記録の本体: 端末の localStorage `bizmates-log/v1`
- API キー・GitHub トークン・合言葉: Railway の環境変数だけ。端末にも localStorage にも置かない
- 記録の置き場: `kuroyanyan/improve-language-data`（private）の `state.json`（全体）と `latest.json`（集計）。裏方が読み書きする。
- カンペ: 同じ private リポジトリの `kanpe/{rank}/NN.html`（教材の See 原文を含むので公開側には置かない）。アプリは裏方の `/api/kanpe` 経由で読み、端末に保存する。新 Rank は教材 HTML → digest → 生成 → 追加（保守 `data:`）。

## 会話から記録を書き込むとき
書き出し・取り込み・削除の画面は持たず、会話で頼まれて `state.json` を直接書く運用。アプリの同期は「起動時に1回だけ裏方を読み、記録（sessions＋preps）の件数が多いほうで**全置換**、以後は自分の状態を丸ごと PUT」なので、順番を守らないと記録が消える。

1. **先にアプリを開いてもらう。** 端末にだけある記録を裏方に上げてから `state.json` を読む。
2. **アプリがやる副作用も同じ形で書く。** `saveSession()` なら、詰まり・単語からのカード生成（`addCard` と同じ形）、宣言ピースの回収、`profile.lastLogLesson` の繰り上げ。
3. **書いたら、アプリを開き直してもらう。** 開きっぱなしの端末は古い状態を持ったままなので、次に何か操作すると上書きする。消えても private リポジトリの git 履歴から戻せる。
4. `latest.json`（週次ループが読む集計）は、次に端末が保存したときに作り直される。

## 構成
```
index.html                画面（記録 / 5分予習 / 自分の話 / 履歴）
assets/app.js             状態・今日の流れ・記録・予習（Act の想定問答）・履歴・ランク切替・配線
assets/pieces.js          自分史ピース（3文＋質問、宣言→回収、卒業）
assets/sample.js          月1の60秒サンプル（録音→文字起こし→固定ルーブリック採点）
assets/sync.js            集計スナップショットと GitHub への同期・private ファイルの読み取り
assets/kanpe.js           カンペタブ（private リポジトリから取得・端末に保存・表示）
assets/ai.js              録音と、裏方への受け渡し・AI フィードバックの表示
assets/api.js             /api/* の窓口と合言葉ゲート
server/index.js           裏方: 配信・認証・ルーティング
server/claude.js          裏方: プロンプトとスキーマ、Claude / OpenAI 呼び出し
server/store.js           裏方: private リポジトリの読み書き
assets/data/lessons.json  Rank C・D のトピックと Key Phrases
docs/LOOP.md              改善ループの規約（目的・指標・ガードレール）
docs/hypotheses/          仮説ファイル（判定基準を先に固定）
docs/routine/             週次ルーティンのプロンプト
tests/smoke.spec.js       Playwright スモークテスト
```
