# mhlw-kb — 厚労省 診療報酬改定ページ 一次資料クローラ

厚生労働省「令和８年度診療報酬改定について」ページ
（https://www.mhlw.go.jp/stf/newpage_67729.html）に掲載される告示・通知・疑義解釈等の
PDF/Excel を、**内容ハッシュによる一意ID（fid）** で版管理しながら自動収集し、
変更があればメールで通知する。将来の「告示通知 お尋ねサーバー」の土台。

## 設計の要点

- **fid は内容の SHA-256（先頭16桁）**。ファイル名や URL ではなく中身で同一性を判定する。
  厚労省の訂正は (a) 同じ URL のまま差替え、(b) URL が新連番に変更、(c) リンク文言だけ変更
  の3パターンが混在するため、この三層すべてを検知する。
- **台帳は追記専用 JSON Lines**（`data/ledger/`）。上書きしない。
  - `crawls.jsonl` クロール1回1行 / `observations.jsonl` クロール×リンク1行 / `files.jsonl` fid 初出1行
  - 「いつ・どの文言で・どの中身が載っていたか」を後から完全に再構成できる。
- **論理文書キー (`key`)**: 見出し(h2/h3) + 項目ラベル + 前置き + アンカー文言 + 注記 から算出。
  訂正ラベル「（0730訂正後）」やサイズ「［4.7MB］」は除いて計算するので、訂正で URL が変わっても
  同じ文書として追跡できる（→ `content_changed` として検知）。
- **ページ上の全ファイルを保存**し、告示・通知・疑義解釈など指定カテゴリを `watch=true` として
  通知の主対象にする（`config.json` の `rules`）。分類不能なものも `other:<見出し>` で保存する。
- **HTML スナップショット**は本文のハッシュが変わったときだけ保存（`data/snapshots/`）。
- 2回目以降は `HEAD` の ETag / Content-Length が前回と一致すればダウンロードを省略
  （厚労省サーバーは Apache で ETag を返す）。`--full` で全件再取得・ハッシュ再検証。

## 使い方

```sh
npm install
cp .env.example .env   # Gmail アプリパスワード等を設定
node bin/crawl.js --print      # 解析結果の確認だけ（ダウンロードしない）
node bin/crawl.js --test-mail  # メール設定の確認（テストメール送信）
node bin/crawl.js --init       # 初期化: 全件取得 + 取得サマリをメール
node bin/crawl.js              # 通常クロール: 変更があればメール
node bin/report.js             # 監視対象の現在の版
node bin/report.js --history   # 版履歴
node bin/report.js --crawls    # クロール履歴
npm test
```

`data/state/<page>.current.json` に現在の一覧を `{date, fid, fname, aname, ...}` 形式で出力する（台帳から再生成可能な派生物）。

## 運用（Linode）

```sh
sudo useradd -r -m -d /opt/mhlw-kb mhlwkb
sudo -u mhlwkb git clone <repo> /opt/mhlw-kb && cd /opt/mhlw-kb && sudo -u mhlwkb npm ci --omit=dev
sudo -u mhlwkb cp .env.example .env && sudo -u mhlwkb vi .env
sudo cp deploy/mhlw-kb.service deploy/mhlw-kb.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mhlw-kb.timer
systemctl list-timers mhlw-kb.timer ; journalctl -u mhlw-kb.service -n 50
```

- 9:00 / 21:00 JST に実行（`Persistent=true` で停止中の取りこぼしも起動後に補完）。
- 成功後 `deploy/git-commit.sh` が台帳・スナップショット・state を自動コミット（`GIT_PUSH=1` で push）。
  PDF 本体（`data/files/`）は git 対象外。サーバーのバックアップで保持する。
- Linode は既定で送信 25 番ポートを塞いでいるため、メールは SMTP 587（Gmail アプリパスワード）を使う。

## ディレクトリ

```
bin/crawl.js      クローラ本体        lib/parse.js     HTML → リンクレコード
bin/report.js     台帳閲覧            lib/classify.js  カテゴリ付与
config.json       対象ページ・分類規則  lib/ledger.js    JSONL 台帳
deploy/           systemd / launchd   lib/diff.js      差分検知
test/             node --test         lib/fetch.js     HTTP（UA・リトライ・HEAD）
data/             台帳・スナップショット・ファイル本体   lib/mail.js  Gmail 通知
```

## 今後（お尋ねサーバー）

1. PDF → テキスト抽出（区分番号・施設基準項番単位のチャンク化、告示/通知/疑義解釈の紐付け）
2. SQLite FTS5（日本語トークナイズ）+ 埋め込みのハイブリッド検索
3. 回答には必ず fid・ページ・版（訂正ラベル）を引用
4. 令和10年度改定以降は `config.json` の `pages` にページを追加するだけで同じ台帳に蓄積される
