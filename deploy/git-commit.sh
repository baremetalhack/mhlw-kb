#!/bin/sh
# クロール後、台帳とHTMLスナップショットのみを git にコミットする（変更がなければ何もしない）。
# push は GIT_PUSH=1 のときだけ行う（deploy key などの設定後に有効化）。
set -e
cd "$(dirname "$0")/.."
git add -A data/ledger data/snapshots data/state 2>/dev/null || exit 0
if git diff --cached --quiet; then exit 0; fi
git -c user.name="mhlw-kb bot" -c user.email="mhlw-kb@localhost" commit -q -m "crawl: $(date '+%Y-%m-%d %H:%M %Z')"
if [ "$GIT_PUSH" = "1" ]; then git push -q origin HEAD || echo "git push failed" >&2; fi
