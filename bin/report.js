#!/usr/bin/env node
'use strict';
// 台帳の閲覧ツール
//   node bin/report.js                 現在の監視対象ファイル一覧（最新クロール）
//   node bin/report.js --all           全ファイル一覧
//   node bin/report.js --history       監視対象ごとの版履歴（fid が変わった時点を列挙）
//   node bin/report.js --crawls        クロール履歴
//   node bin/report.js --category=gigi カテゴリで絞り込み

const fs = require('fs');
const path = require('path');
const { Ledger } = require('../lib/ledger');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const config = JSON.parse(fs.readFileSync(path.resolve(val('config', path.join(ROOT, 'config.json'))), 'utf8'));
const dataDirRaw = val('data', config.dataDir || 'data');
const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(ROOT, dataDirRaw);
const ledger = new Ledger(path.join(dataDir, 'ledger'));
const cat = val('category', null);

function fmtBytes(n) { return n == null ? '?' : n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB'; }

if (has('--crawls')) {
  for (const c of ledger.crawls()) console.log(`${c.crawl_id} ${c.page_id} status=${c.status} links=${c.n_links} dl=${c.downloaded} reuse=${c.reused} fail=${c.failed} events=${c.n_events} page_changed=${c.page_changed}`);
  process.exit(0);
}

for (const page of config.pages) {
  const last = ledger.lastSuccessfulCrawl(page.id);
  if (!last) { console.log(`${page.id}: クロール記録なし`); continue; }
  if (has('--history')) {
    // key ごとに fid の推移を並べる
    const byKey = new Map();
    for (const o of ledger.observations()) {
      if (o.page_id !== page.id || !o.fid) continue;
      if (!o.watch && !has('--all')) continue;
      if (cat && o.category !== cat) continue;
      if (!byKey.has(o.key)) byKey.set(o.key, []);
      const arr = byKey.get(o.key);
      const prev = arr[arr.length - 1];
      if (!prev || prev.fid !== o.fid || prev.url !== o.url || prev.note !== o.note) arr.push(o);
    }
    console.log(`== ${page.title} 版履歴（${last.crawl_id} 時点）`);
    for (const [key, arr] of byKey) {
      const o = arr[arr.length - 1];
      console.log(`\n[${o.category}] ${o.aname}  (key ${key})`);
      for (const v of arr) console.log(`  ${v.ts.slice(0, 16)}  fid=${v.fid} ${fmtBytes(v.bytes).padStart(7)}  ${v.note || ''}  ${v.url}`);
    }
    continue;
  }
  const obs = ledger.observationsOf(last.crawl_id).filter(o => (has('--all') || o.watch) && (!cat || o.category === cat));
  console.log(`== ${page.title}  最新クロール ${last.crawl_id}  (${obs.length} 件)`);
  for (const o of obs) console.log(`${o.watch ? '*' : ' '} ${o.category.padEnd(15)} fid=${o.fid || '-'} ${fmtBytes(o.bytes).padStart(7)}  ${o.aname} ${o.note || ''}`);
}
