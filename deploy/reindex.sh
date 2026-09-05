#!/bin/sh
# クロール後に呼ぶ: 監視対象 PDF に新しい fid があれば 抽出 → 索引再構築 → サーバー再起動。
# systemd の ExecStartPost（mhlw-kb.service）から git-commit.sh の後に実行する想定。
set -e
cd "$(dirname "$0")/.."
before=$(ls data/text 2>/dev/null | wc -l)
node bin/extract.js --watch >/dev/null
after=$(ls data/text | wc -l)
if [ "$before" != "$after" ] || [ ! -f data/kb.sqlite ]; then
  node bin/build-index.js
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet mhlw-kb-server; then
    sudo -n systemctl restart mhlw-kb-server 2>/dev/null || systemctl --user restart mhlw-kb-server 2>/dev/null || true
  fi
fi
