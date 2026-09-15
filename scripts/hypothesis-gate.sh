#!/usr/bin/env bash
# アプリの挙動を変える PR には、仮説ファイル（docs/hypotheses/H-*.md）の追加か更新が必要（docs/LOOP.md G1）。
# 保守 PR は title の接頭辞（fix:/chore:/data:/docs:/test:/ci:/revert:）か label "maintenance" で通す。
set -euo pipefail
: "${BASE:?}" "${HEAD:?}"
TITLE="${TITLE:-}"
LABELS="${LABELS:-}"
changed=$(git diff --name-only "$BASE" "$HEAD")
echo "changed files:"; echo "$changed"
if ! echo "$changed" | grep -Eq '^(assets/(app|ai|pieces|sample|sync)\.js|assets/styles\.css|index\.html)$'; then
  echo "挙動の変更なし → ゲート不要"; exit 0
fi
if echo "$changed" | grep -Eq '^docs/hypotheses/H-.*\.md$'; then
  echo "仮説ファイルあり → OK"; exit 0
fi
if echo "$TITLE" | grep -Eq '^(fix|chore|data|docs|test|ci|revert)(\([^)]*\))?:' || echo ",$LABELS," | grep -q ',maintenance,'; then
  echo "保守 PR（title/label）→ OK"; exit 0
fi
echo "::error::アプリの挙動を変える PR には docs/hypotheses/H-*.md の追加か更新が必要です（docs/LOOP.md G1）。保守なら title を fix:/chore:/data: で始めるか、label maintenance を付けてください。"
exit 1
