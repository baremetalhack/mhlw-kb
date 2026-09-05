#!/usr/bin/env node
'use strict';
// 厚労省 診療報酬改定ページ クローラ
//
//   node bin/crawl.js            通常クロール（変更があればメール）
//   node bin/crawl.js --init     初期化（全件取得。差分は出さず取得サマリをメール）
//   node bin/crawl.js --full     HEAD比較を省略し全ファイルを再取得してハッシュ検証
//   node bin/crawl.js --dry-run  ページ解析と差分計算のみ（ダウンロード・台帳追記・メールなし）
//   node bin/crawl.js --no-mail  メールを送らない
//   node bin/crawl.js --print    解析したリンク一覧を表示して終了
//   node bin/crawl.js --verbose  HEAD 比較の不一致理由を表示
//   node bin/crawl.js --test-mail  .env のメール設定でテストメールを1通送る
//
// 環境変数は .env（プロジェクト直下）または実行環境から読む。

const fs = require('fs');
const path = require('path');
const { parsePage } = require('../lib/parse');
const { compile, classify } = require('../lib/classify');
const { Ledger } = require('../lib/ledger');
const http = require('../lib/fetch');
const { diffObservations, sortEvents } = require('../lib/diff');
const mail = require('../lib/mail');

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

const args = new Set(process.argv.slice(2));
const OPT = {
  init: args.has('--init'), full: args.has('--full'), dryRun: args.has('--dry-run'),
  noMail: args.has('--no-mail'), print: args.has('--print'), verbose: args.has('--verbose'),
};

function argValue(name, dflt) { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; }
const configPath = path.resolve(argValue('config', path.join(ROOT, 'config.json')));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const dataDirRaw = argValue('data', config.dataDir || 'data');
const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(ROOT, dataDirRaw);
const rules = compile(config.rules);
const UA = process.env.USER_AGENT || config.userAgent;

function loadDotEnv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function nowIso() { return new Date().toISOString(); }
function crawlId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function fidOf(sha256) { return sha256.slice(0, 16); }
function log(...a) { console.log(`[${nowIso()}]`, ...a); }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function crawlPage(page, ledger) {
  const id = crawlId();
  const ts = nowIso();
  log(`== ${page.id} ${page.url} (crawl ${id})`);

  // 1. ページ取得・解析
  const res = await http.get(page.url, { userAgent: UA, timeoutMs: 60000, retries: config.download.retries });
  const html = res.buf.toString('utf8');
  const { links: rawLinks, headings, canonical } = parsePage(html, { baseUrl: page.url, contentSelector: page.contentSelector });
  const pageHash = http.sha256(Buffer.from(canonical, 'utf8'));
  const links = rawLinks.map(l => ({ ...l, ...classify(l, rules) }));
  log(`links: ${links.length} (watch: ${links.filter(l => l.watch).length}), page_hash ${pageHash.slice(0, 16)}`);

  if (OPT.print) {
    for (const l of links) console.log(`${l.watch ? '*' : ' '} [${l.category}] ${l.aname} ${l.note} | ${l.h3 || l.h2} | ${l.label.slice(0, 40)} | ${l.url}`);
    return null;
  }

  // 2. HTMLスナップショット（本文ハッシュが前回と異なるときだけ保存）
  const prevCrawl = ledger.lastSuccessfulCrawl(page.id);
  const snapDir = path.join(dataDir, 'snapshots', page.id);
  let snapshot = prevCrawl ? prevCrawl.snapshot : null;
  const pageChanged = !prevCrawl || prevCrawl.page_hash !== pageHash;
  if (pageChanged && !OPT.dryRun) {
    fs.mkdirSync(snapDir, { recursive: true });
    snapshot = path.relative(dataDir, path.join(snapDir, `${id}_${pageHash.slice(0, 12)}.html`));
    fs.writeFileSync(path.join(dataDir, snapshot), html);
    log(`page changed -> snapshot ${snapshot}`);
  }

  // 3. 各ファイルの取得と fid 決定
  const lastByUrl = ledger.lastObservationByUrl(page.id);
  // 同じ URL・同じ fid で過去に観測した ETag をすべて集める。
  // 厚労省側は複数サーバーで配信しているらしく、同一内容でも HEAD の ETag（mtime 由来）が
  // 応答サーバーごとに異なることがあるため、「過去に同じ内容と確認済みの ETag のどれか」に一致すれば再利用する。
  const knownEtags = ledger.knownEtagsByUrl(page.id);
  const fileIndex = ledger.fileIndex();
  const filesDir = path.join(dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  let downloaded = 0, reused = 0, failed = 0;

  const observations = await mapLimit(links, config.download.concurrency, async (l) => {
    const obs = {
      crawl_id: id, ts, page_id: page.id, key: l.key, url: l.url, ext: l.ext,
      category: l.category, watch: l.watch, aname: l.aname, note: l.note, prefix: l.prefix,
      label: l.label, h2: l.h2, h3: l.h3, revision: l.revision,
      fid: null, bytes: null, etag: null, last_modified: null, error: null,
    };
    if (OPT.dryRun) { const p = lastByUrl.get(l.url); if (p) Object.assign(obs, { fid: p.fid, bytes: p.bytes, etag: p.etag }); return obs; }
    try {
      const prev = lastByUrl.get(l.url);
      if (prev && prev.fid && !OPT.full) {
        const h = await http.head(l.url, { userAgent: UA, retries: config.download.retries });
        const known = knownEtags.get(l.url);
        const etagOk = h.etag && known && known.fid === prev.fid &&
          (known.etags.has(h.etag) || [...known.etags].some(e => Ledger.etagEquivalent(e, h.etag)));
        const same = etagOk && h.content_length === prev.bytes;
        const f = fileIndex.get(prev.fid);
        if (same && f && fs.existsSync(path.join(dataDir, f.path))) {
          Object.assign(obs, { fid: prev.fid, bytes: prev.bytes, etag: h.etag, last_modified: h.last_modified, via: 'head' });
          reused++;
          return obs;
        }
        obs.head_miss = { etag: h.etag, content_length: h.content_length, last_modified: h.last_modified };
        if (OPT.verbose) log(`  head-miss ${l.url.slice(-13)} etag ${h.etag} len ${h.content_length} (known: ${known ? [...known.etags].join(',') : '-'} len ${prev.bytes})`);
      }
      await http.sleep(config.download.delayMs);
      const r = await http.get(l.url, { userAgent: UA, timeoutMs: config.download.timeoutMs, retries: config.download.retries });
      const fid = fidOf(r.sha256);
      const rel = path.join('files', `${fid}.${l.ext || 'bin'}`);
      if (!fileIndex.has(fid)) {
        fs.writeFileSync(path.join(dataDir, rel), r.buf);
        const frec = { fid, sha256: r.sha256, bytes: r.buf.length, ext: l.ext, path: rel, first_seen: ts, first_url: l.url, first_aname: l.aname, first_crawl: id };
        fileIndex.set(fid, frec); ledger.append('files', frec);
      }
      Object.assign(obs, { fid, bytes: r.buf.length, etag: r.etag, last_modified: r.last_modified, via: 'get' });
      downloaded++;
      log(`  get ${fid} ${String(r.buf.length).padStart(9)} ${l.aname.slice(0, 50)}`);
    } catch (e) {
      failed++; obs.error = String(e.message || e);
      log(`  FAIL ${l.url}: ${obs.error}`);
    }
    return obs;
  });

  // 4. 差分（前回成功クロールの観測と比較）。取得失敗リンクは比較対象から除く。
  const prevObs = prevCrawl ? ledger.observationsOf(prevCrawl.crawl_id).filter(o => o.fid) : [];
  const currOk = observations.filter(o => o.fid);
  const events = prevCrawl ? sortEvents(diffObservations(prevObs, currOk)) : [];

  const crawl = {
    crawl_id: id, ts, page_id: page.id, page_url: page.url, page_hash: pageHash, page_changed: pageChanged,
    snapshot, n_links: links.length, n_watch: links.filter(l => l.watch).length,
    downloaded, reused, failed, n_events: events.length, headings, status: failed === links.length && links.length ? 'error' : 'ok',
    dry_run: OPT.dryRun, init: OPT.init,
  };

  if (!OPT.dryRun) {
    for (const o of observations) ledger.append('observations', o);
    ledger.append('crawls', crawl);
    writeCurrentState(page, crawl, observations);
  }

  const stats = { links: links.length, downloaded, reused, failed };
  return { page, crawl, observations, events, stats };
}

// 派生ファイル: 現在の状態を1ファイルで見られるようにする（台帳から再生成可能）
function writeCurrentState(page, crawl, observations) {
  const dir = path.join(dataDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const out = {
    page_id: page.id, url: page.url, crawl_id: crawl.crawl_id, ts: crawl.ts, page_hash: crawl.page_hash, snapshot: crawl.snapshot,
    files: observations.map(o => ({ date: o.ts, fid: o.fid, fname: o.fid ? `${o.fid}.${o.ext}` : null, aname: o.aname, note: o.note, category: o.category, watch: o.watch, url: o.url, bytes: o.bytes, h2: o.h2, h3: o.h3, label: o.label, key: o.key, error: o.error })),
  };
  fs.writeFileSync(path.join(dir, `${page.id}.current.json`), JSON.stringify(out, null, 1));
}

async function main() {
  if (args.has('--test-mail')) {
    // .env の設定確認用: テストメールを1通送る
    if (!mail.configured()) { console.error('MAIL_USER / MAIL_PASS / MAIL_TO が未設定です（.env を確認）'); process.exit(1); }
    const r = await mail.send({ subject: '[mhlw-kb] テストメール', text: `mhlw-kb からのテスト送信です。\n${nowIso()}\nMAIL_USER=${process.env.MAIL_USER}\nMAIL_TO=${process.env.MAIL_TO}` });
    console.log('送信しました:', r.id);
    return;
  }
  const ledger = new Ledger(path.join(dataDir, 'ledger'));
  const results = [];
  const errors = [];
  for (const page of config.pages) {
    try {
      const r = await crawlPage(page, ledger);
      if (r) results.push(r);
    } catch (e) {
      errors.push({ page, error: String(e.stack || e) });
      log(`!! ${page.id} failed: ${e.message}`);
    }
  }
  if (OPT.print) return;

  // メール
  const subjectParts = [];
  const bodies = [];
  for (const r of results) {
    const { page, crawl, events, stats } = r;
    if (OPT.init || !ledger.crawls().some(c => c.page_id === page.id && c.crawl_id !== crawl.crawl_id)) {
      subjectParts.push(`初期化 ${page.id}: ${stats.links}件`);
      bodies.push(`${page.title}\n${page.url}\n初期化クロール ${crawl.crawl_id}: リンク ${stats.links} 件, 取得 ${stats.downloaded}, 失敗 ${stats.failed}\n` +
        r.observations.filter(o => o.watch).map(o => `  [${o.category}] ${o.aname} ${o.note}  fid=${o.fid}`).join('\n'));
    } else if (events.length) {
      const watched = events.filter(e => (e.curr || e.prev).watch).length;
      subjectParts.push(`${page.id}: 変更 ${events.length}件${watched ? `（監視対象 ${watched}件）` : ''}`);
      bodies.push(mail.renderReport({ page, crawl, events, stats }));
    }
    if (stats.failed) { subjectParts.push(`取得失敗 ${stats.failed}`); bodies.push(`取得失敗:\n` + r.observations.filter(o => o.error).map(o => `  ${o.url}\n    ${o.error}`).join('\n')); }
    log(`${page.id}: events ${events.length}, downloaded ${stats.downloaded}, reused ${stats.reused}, failed ${stats.failed}`);
  }
  for (const e of errors) { subjectParts.push(`エラー ${e.page.id}`); bodies.push(`クロール失敗 ${e.page.url}\n${e.error}`); }

  if (subjectParts.length && !OPT.noMail && !OPT.dryRun) {
    const subject = `[mhlw-kb] ${subjectParts.join(' / ')}`;
    const r = await mail.send({ subject, text: bodies.join('\n\n' + '-'.repeat(60) + '\n\n') });
    log(`mail: ${r.sent ? 'sent ' + r.id : 'not sent'}`);
  } else if (bodies.length) {
    console.log(bodies.join('\n\n'));
  }
  if (errors.length) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(2); });
