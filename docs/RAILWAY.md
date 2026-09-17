# Railway（裏方）の設定

アプリと裏方は Railway のサービス1つで動く。API キーと GitHub トークンはここの環境変数にあり、ブラウザには一切渡らない。

| 項目 | 値 |
|---|---|
| Workspace | JTCC（個人ワークスペースはトライアル期限切れのため。リポジトリは `kuroyanyan` 個人のまま） |
| Project | `bizmates-log` — `ba2ae31e-3d2e-4693-927f-77da6603df55` |
| Service | `app` — `81064729-5824-4b2e-8303-ad8875b4d5d8` |
| Environment | production — `b2cb1ba0-9f62-4d88-833f-724795827a0b` |
| URL | https://app-production-cbe53.up.railway.app |
| Source | GitHub `kuroyanyan/improve-language` の `main`（2026-09-17 に PR ブランチから切り替え）。merge すると、そのまま本番にデプロイされる |

## 環境変数

黒川さんが Railway の画面（Service → Variables）で入れるもの。**Claude はキーを扱わない。**

| 変数 | 入れるもの |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic の API キー。フィードバック・ピースの英語化・サンプル採点（`claude-opus-5`） |
| `OPENAI_API_KEY` | OpenAI の API キー。録音の文字起こし（`gpt-4o-transcribe`） |
| `GITHUB_TOKEN` | `improve-language-data`（private）の Contents: Read and write に絞った fine-grained トークン。カンペと記録の読み書き |
| `APP_PASSCODE` | 本人だけが入れる合言葉。**未設定だと URL を知る誰でも開ける**ので必ず入れる |

設定済み（触らなくてよい）: `DATA_REPO` / `SESSION_SALT` / `NODE_ENV` / `NPM_CONFIG_OMIT` / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`

`SESSION_SALT` を変えると、全端末でログインし直しになる。

## 落とし穴

- **ビルダーを固定する。** ルートに `index.html` があるため、指定が無いと Railway が「静的サイト」と誤検出し、Node サーバーではなく Caddy でファイル配信してしまう（全 API が 404、ログに `fileserver.notFound` と `Server: Caddy`）。`railway.json` の `build.builder = NIXPACKS` と `nixpacks.toml` の `providers = ["node"]` の両方で明示している。
- `railway.json` に `buildCommand` を書かない。Nixpacks の install 段階の `npm ci` と衝突し、`node_modules/.cache` の EBUSY でビルドが落ちる（2026-09-16 実測）。ビルド工程は不要。
- push で自動デプロイされないときは、Railway 側でソースを繋ぎ直すと最新コミットでビルドが走る。
- **main への merge は、そのまま本番デプロイになる。** レッスンの直前（目安30分前から）は merge しない。ビルド中や失敗時にカンペが開けなくなるため。
- 使いすぎ防止として、AI 呼び出しは 1 時間あたり 60 回まで。超えると 429 を返す。
