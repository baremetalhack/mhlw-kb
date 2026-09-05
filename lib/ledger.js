'use strict';
// 追記専用の JSON Lines 台帳。
//   crawls.jsonl        : クロール1回ごとに1行
//   observations.jsonl  : クロールごと・リンクごとに1行（そのときページに何がどう載っていたか）
//   files.jsonl         : fid（内容ハッシュ）ごとに初回観測時1行
// 「上書き」は一切行わない。現在の状態は最新クロールの observations から再構成する。

const fs = require('fs');
const path = require('path');

class Ledger {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.paths = {
      crawls: path.join(dir, 'crawls.jsonl'),
      observations: path.join(dir, 'observations.jsonl'),
      files: path.join(dir, 'files.jsonl'),
    };
  }

  _readAll(p) {
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  append(kind, rec) {
    fs.appendFileSync(this.paths[kind], JSON.stringify(rec) + '\n');
  }

  crawls() { return this._readAll(this.paths.crawls); }
  observations() { return this._readAll(this.paths.observations); }
  files() { return this._readAll(this.paths.files); }

  // fid → file record
  fileIndex() {
    const m = new Map();
    for (const f of this.files()) m.set(f.fid, f);
    return m;
  }

  // 直近の「成功した」クロールとその観測
  lastSuccessfulCrawl(pageId) {
    const cs = this.crawls().filter(c => c.page_id === pageId && c.status === 'ok');
    return cs.length ? cs[cs.length - 1] : null;
  }

  observationsOf(crawlId) {
    return this.observations().filter(o => o.crawl_id === crawlId);
  }

  // URL → { fid, etags:Set } 直近観測の fid と同じ内容で過去に観測された ETag の集合
  knownEtagsByUrl(pageId) {
    const last = this.lastObservationByUrl(pageId);
    const m = new Map();
    for (const o of this.observations()) {
      if (o.page_id !== pageId || !o.fid || !o.etag) continue;
      const l = last.get(o.url);
      if (!l || l.fid !== o.fid) continue;
      if (!m.has(o.url)) m.set(o.url, { fid: o.fid, etags: new Set() });
      m.get(o.url).etags.add(o.etag);
      // HEAD が不一致だったが直後の GET で同じ fid が得られた → その HEAD の ETag も同一内容と検証済み
      if (o.head_miss && o.head_miss.etag) m.get(o.url).etags.add(o.head_miss.etag);
    }
    return m;
  }

  // Apache 形式 ETag "size-mtime"（16進, mtime はマイクロ秒）を分解
  static parseApacheEtag(etag) {
    const m = (etag || '').match(/^W\/?"?([0-9a-f]+)-([0-9a-f]+)"?$/i) || (etag || '').match(/^"?([0-9a-f]+)-([0-9a-f]+)"?$/i);
    return m ? { size: parseInt(m[1], 16), mtimeUs: parseInt(m[2], 16) } : null;
  }

  // 厚労省は複数サーバーで同一ファイルを配信しており、ミラー間で mtime が数百ms〜1s ずれるため
  // ETag（size-mtime）が応答サーバーごとに異なる。size が一致し mtime の差が toleranceSec 以内なら同一とみなす。
  // 差替えは必ず数日〜数か月後の mtime になるので、この許容で誤判定する現実的リスクはない。
  static etagEquivalent(a, b, toleranceSec = 5) {
    const pa = Ledger.parseApacheEtag(a), pb = Ledger.parseApacheEtag(b);
    if (!pa || !pb) return false;
    return pa.size === pb.size && Math.abs(pa.mtimeUs - pb.mtimeUs) <= toleranceSec * 1e6;
  }

  // URL → 直近観測（HEAD比較用に etag / bytes / fid を引く）
  lastObservationByUrl(pageId) {
    const m = new Map();
    for (const o of this.observations()) if (o.page_id === pageId) m.set(o.url, o);
    return m;
  }
}

module.exports = { Ledger };
