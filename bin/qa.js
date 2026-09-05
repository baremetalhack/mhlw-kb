#!/usr/bin/env node
'use strict';
// 疑義解釈資料（data/text/<fid>.json）→ data/qa/<fid>.json（問／答レコード）
//
//   node bin/qa.js            最新クロールの疑義解釈カテゴリ（gigi / gigi_teisei / gigi_other）をすべて処理
//   node bin/qa.js --fid=...  指定 fid
//   node bin/qa.js --list     問の一覧を表示

const fs = require('fs');
const path = require('path');
const { Ledger } = require('../lib/ledger');
const { parseQA, validateQA } = require('../lib/qa');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const config = JSON.parse(fs.readFileSync(path.resolve(val('config', path.join(ROOT, 'config.json'))), 'utf8'));
const dataDirRaw = val('data', config.dataDir || 'data');
const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(ROOT, dataDirRaw);
const outDir = path.join(dataDir, 'qa');
fs.mkdirSync(outDir, { recursive: true });

const ledger = new Ledger(path.join(dataDir, 'ledger'));
let targets = [];
if (val('fid')) {
  targets = val('fid').split(',').map(f => ({ fid: f.trim(), aname: '' }));
} else {
  const seen = new Set();
  for (const page of config.pages) {
    const last = ledger.lastSuccessfulCrawl(page.id);
    if (!last) continue;
    for (const o of ledger.observationsOf(last.crawl_id)) {
      if (!o.fid || o.ext !== 'pdf' || seen.has(o.fid) || !/^gigi/.test(o.category)) continue;
      seen.add(o.fid); targets.push({ fid: o.fid, aname: o.aname, category: o.category });
    }
  }
}

let total = 0;
for (const t of targets) {
  const tp = path.join(dataDir, 'text', `${t.fid}.json`);
  if (!fs.existsSync(tp)) { console.log(`skip (no text): ${t.fid} ${t.aname}`); continue; }
  const m = (t.aname || '').match(/（その\s*([0-9０-９]+)）/);
  const doc = m ? `その${m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))}` : (t.aname || t.fid).slice(0, 30);
  const res = parseQA(JSON.parse(fs.readFileSync(tp, 'utf8')), { doc, aname: t.aname, category: t.category });
  fs.writeFileSync(path.join(outDir, `${t.fid}.json`), JSON.stringify(res));
  const v = validateQA(res);
  total += v.n;
  console.log(`${t.fid} ${doc.padEnd(8)} ${JSON.stringify(v)}`);
  if (has('--list')) for (const q of res.qas) console.log(`   ${(q.section || '').slice(0, 4)} ${q.no.padEnd(5)} [${q.codes.join(',')}] ${q.topic || ''} | ${q.q.slice(0, 50)} → ${q.a.slice(0, 40)}`);
}
console.log(`total QA: ${total}`);
