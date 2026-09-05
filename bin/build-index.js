#!/usr/bin/env node
'use strict';
// 台帳の最新クロールにある監視対象文書から、構造化（区分チャンク・QA）→ SQLite 索引（data/kb.sqlite）を構築する。
//
//   node bin/build-index.js          （data/text/<fid>.json が無い文書はスキップ。先に bin/extract.js --watch）
//   node bin/build-index.js --db=path
//
// 対象と名前空間:
//   ika_kokuji/ika_tsuchi → 医  shika_* → 歯  chozai_* → 調   （告示 = kokuji, 通知 = tsuchi）
//   gigi / gigi_teisei / gigi_other → 疑義解釈（section から 医/歯/調/訪 を判定）
// 索引は毎回作り直す（冪等）。

const fs = require('fs');
const path = require('path');
const { Ledger } = require('../lib/ledger');
const { buildStructure } = require('../lib/structure');
const { parseQA } = require('../lib/qa');
const { buildShisetsu, baseName } = require('../lib/shisetsu');
const kb = require('../lib/db');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const val = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const config = JSON.parse(fs.readFileSync(path.resolve(val('config', path.join(ROOT, 'config.json'))), 'utf8'));
const dataDirRaw = val('data', config.dataDir || 'data');
const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(ROOT, dataDirRaw);
const dbPath = path.resolve(val('db', path.join(dataDir, 'kb.sqlite')));

const TABLE_OF = { ika: '医', shika: '歯', chozai: '調', kihon: '基本', tokkei: '特掲' };
function docKind(category) {
  const m = category.match(/^(ika|shika|chozai|kihon|tokkei)_(kokuji|tsuchi)$/);
  if (m) return { tbl: TABLE_OF[m[1]], kind: m[2], shisetsu: m[1] === 'kihon' || m[1] === 'tokkei' };
  if (/^gigi/.test(category)) return { tbl: null, kind: 'qa' };
  return null;
}
function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

function main() {
  const ledger = new Ledger(path.join(dataDir, 'ledger'));
  const fileIndex = ledger.fileIndex();
  const targets = [];
  const seen = new Set();
  for (const page of config.pages) {
    const last = ledger.lastSuccessfulCrawl(page.id);
    if (!last) continue;
    for (const o of ledger.observationsOf(last.crawl_id)) {
      if (!o.fid || o.ext !== 'pdf' || seen.has(o.fid)) continue;
      const dk = docKind(o.category);
      if (!dk) continue;
      seen.add(o.fid);
      targets.push({ ...dk, fid: o.fid, category: o.category, aname: o.aname, note: o.note, revision: o.revision, url: o.url, crawl_id: o.crawl_id, observed_at: o.ts });
    }
  }

  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  for (const suf of ['-wal', '-shm']) if (fs.existsSync(dbPath + suf)) fs.unlinkSync(dbPath + suf);
  const db = kb.open(dbPath);
  const insDoc = db.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insChunk = db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const insChunkFts = db.prepare('INSERT INTO chunks_fts (id, title, norm) VALUES (?,?,?)');
  const insQa = db.prepare('INSERT INTO qa VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insQaFts = db.prepare('INSERT INTO qa_fts (id, topic, norm) VALUES (?,?,?)');
  const insRef = db.prepare('INSERT INTO refs VALUES (?,?,?)');

  let nChunks = 0, nQa = 0, nDocs = 0;
  const shisetsuTitles = []; // { key, title } 施設基準項目の題（QA の話題との紐付け用）
  const qaList = [];
  db.exec('BEGIN');
  for (const t of targets) {
    const tp = path.join(dataDir, 'text', `${t.fid}.json`);
    if (!fs.existsSync(tp)) { log(`skip (no text): ${t.fid} ${t.aname.slice(0, 40)}`); continue; }
    const text = JSON.parse(fs.readFileSync(tp, 'utf8'));
    insDoc.run(t.fid, t.category, t.tbl, t.kind, t.aname, t.note || '', t.revision || null, t.url, t.crawl_id, t.observed_at, text.pages);
    nDocs++;
    if (t.kind === 'qa') {
      const m = t.aname.match(/（その\s*([0-9０-９]+)）/);
      const doc = m ? `その${m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))}` : t.aname.slice(0, 30);
      const res = parseQA(text, { doc });
      for (const q of res.qas) {
        insQa.run(q.id, q.fid, q.doc, q.section, q.table, q.topic, q.no, q.q, q.a, JSON.stringify(q.codes), q.p_start, q.p_end, kb.norm(`${q.topic || ''} ${q.q} ${q.a}`));
        insQaFts.run(q.id, q.topic || '', kb.norm(`${q.topic || ''} ${q.q} ${q.a}`));
        for (const c of q.codes) insRef.run(q.id, 'qa', c);
        qaList.push(q);
        nQa++;
      }
      log(`${t.fid} ${doc.padEnd(6)} QA ${res.qas.length}`);
    } else if (t.shisetsu) {
      const st = buildShisetsu(text, t.kind);
      for (const c of st.chunks) {
        if (!c.path.length && t.kind === 'tsuchi') continue; // 別添の前（届出手続き等）は項目チャンクにしない
        const key = `施:${kb.norm(baseName(c.title))}`;
        insChunk.run(c.id, t.fid, t.tbl, 'shisetsu', key, JSON.stringify([key]), c.title || '', JSON.stringify(c.path), c.p_start, c.p_end, c.text, kb.norm(c.text));
        insChunkFts.run(c.id, c.title || '', kb.norm(c.text));
        insRef.run(c.id, 'chunk', key);
        shisetsuTitles.push({ key, title: c.title, norm: kb.norm(baseName(c.title)) });
        nChunks++;
      }
      log(`${t.fid} ${t.tbl}${t.kind === 'kokuji' ? '告示' : '通知'} 施設基準 items ${st.chunks.length} (sections ${st.sections.length})`);
    } else {
      const st = buildStructure(text);
      for (const c of st.chunks) {
        const code = c.code ? `${t.tbl}:${c.code}` : null;
        const codes = (c.codes || []).map(x => `${t.tbl}:${x}`);
        insChunk.run(c.id, t.fid, t.tbl, c.kind, code, JSON.stringify(codes), c.title || '', JSON.stringify(c.path), c.p_start, c.p_end, c.text, kb.norm(c.text));
        insChunkFts.run(c.id, c.title || '', kb.norm(c.text));
        for (const x of codes) insRef.run(c.id, 'chunk', x);
        nChunks++;
      }
      log(`${t.fid} ${t.tbl}${t.kind === 'kokuji' ? '告示' : '通知'} chunks ${st.chunks.length}`);
    }
  }
  // 疑義解釈の話題【…】と施設基準項目の題を突き合わせる（正規化した題が話題に含まれる／その逆、4文字以上）
  const uniqTitles = new Map(); for (const s of shisetsuTitles) if (!uniqTitles.has(s.key)) uniqTitles.set(s.key, s);
  let nLink = 0;
  for (const q of qaList) {
    if (!q.topic) continue;
    const topics = q.topic.split(/[、,／]/).map(kb.norm).filter(x => x.length >= 4);
    const linked = new Set();
    for (const s of uniqTitles.values()) {
      if (s.norm.length < 4) continue;
      for (const tp of topics) if (tp.includes(s.norm) || s.norm.includes(tp)) linked.add(s.key);
    }
    for (const key of linked) { insRef.run(q.id, 'qa', key); nLink++; }
  }
  db.exec('COMMIT');
  log(`施設基準↔疑義解釈 リンク ${nLink} 件`);
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize'); INSERT INTO qa_fts(qa_fts) VALUES('optimize');");
  db.close();
  log(`done: docs ${nDocs}, chunks ${nChunks}, qa ${nQa} → ${dbPath}`);
}

main();
