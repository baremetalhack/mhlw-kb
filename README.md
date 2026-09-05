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
bin/crawl.js        クローラ本体          lib/parse.js      HTML → リンクレコード
bin/report.js       台帳閲覧              lib/classify.js   カテゴリ付与
bin/extract.js      PDF → 座標付きテキスト  lib/ledger.js     JSONL 台帳
bin/structure.js    点数表の構造化（検証）  lib/diff.js       差分検知
bin/qa.js           疑義解釈の問／答       lib/fetch.js      HTTP（UA・リトライ・HEAD）
bin/build-index.js  SQLite 索引構築        lib/mail.js       Gmail 通知
bin/ask.js          お尋ね CLI             lib/structure.js  章/部/節/款・区分番号チャンク
                                          lib/shisetsu.js   施設基準（告示=縦書き/通知）の項目チャンク
config.json         対象ページ・分類規則    lib/qa.js         疑義解釈パーサ
deploy/             systemd / launchd     lib/db.js         SQLite スキーマ・正規化
data/               台帳・スナップショット・files（PDF）・text・qa・kb.sqlite
```

## 第2段階: 抽出・構造化・索引（お尋ね機能）

```sh
node bin/extract.js --watch        # PDF → data/text/<fid>.json（MuPDF.js、座標付き行。fid 単位でキャッシュ）
node bin/structure.js --fid=<fid>  # 点数表の章/部/節/款 + 区分番号チャンク（検証表示）  --compare=<a>,<b> で区分集合の比較
node bin/qa.js                     # 疑義解釈 → data/qa/<fid>.json（問／答、区分番号参照）
node bin/build-index.js            # data/kb.sqlite（SQLite FTS5 trigram、node:sqlite 組み込み・ネイティブ依存なし）
node bin/ask.js B001-10            # 区分番号カード: 告示本文 + 通知（留意事項）+ 関連する疑義解釈（出典付き）
node bin/ask.js 歯:M017            # 名前空間: 医 / 歯 / 調 / 訪（省略時 医）
node bin/ask.js 施:機能強化加算        # 施設基準カード: 告示（基本/特掲）+ 通知 + 話題が一致する疑義解釈
node bin/ask.js 在宅自己注射 導入初期  # 全文検索（全語 AND、3文字以上は trigram、短い語は後段フィルタ）
```

- 施設基準の告示（基本診療料・特掲診療料）は官報形式の **縦書き** PDF。MuPDF は1文字ずつ返すので、
  `bin/extract.js` が同じ x の文字を列にまとめ、右→左・上→下の順に再構成する（列の先頭 y を字下げ量として x に入れる）。
  `lib/shisetsu.js` が「第三 …」「一の二 …」（漢数字、番号と題の間に空白なし）を項目に分ける。
  「三一般病棟…」を「三一」と誤読しないよう、直前の番号から妥当な番号だけを採用する。

- `bin/extract.js` だけが MuPDF（AGPL）に触れる。後段は JSON/SQLite しか読まないので、公開サーバーは MuPDF を含まない構成にできる。
- 区分番号は点数表ごとの名前空間付きで扱う（`医:A000` と `歯:A000` は別物、調剤は `調:10-2`、訪問看護は `訪:06`）。
- 実データで確認済みの癖: 枝番10以上は半角（Ｂ００５－10）、歯科は U+2015 のダッシュ混在、
  「ＡからＢまで 削除」「Ａ及びＢ」「Ｋ００３、Ｋ００４」の列挙見出し、調剤通知の「区分００」前置、
  疑義解釈の別添ごとの問番号リセット・ページラベル（医－1 / 看ベ－3 / DPC－12）。

## 今後

1. 通知内の「注」「(1)」「ア」階層の復元（x 座標）、施設基準の告示↔通知の項目対応の精度向上
2. 訂正事務連絡（新旧対照表）を区分番号単位で紐付け、「いつ何が直ったか」の履歴を出す
3. 埋め込みによる意味検索の併用、HTTP API / チャット UI（お尋ねサーバー）
4. 令和10年度改定以降は `config.json` の `pages` にページを追加するだけで同じ台帳・索引に蓄積される
