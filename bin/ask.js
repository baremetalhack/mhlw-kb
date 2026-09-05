#!/usr/bin/env node
'use strict';
// 告示通知 お尋ね（CLI 版）。ロジックは lib/query.js（HTTP 版 bin/server.js と共用）
//
//   node bin/ask.js A000                 区分番号カード: 告示本文 + 通知（留意事項）+ 訂正履歴 + 関連する疑義解釈
//   node bin/ask.js 歯:M017              歯科の区分（名前空間: 医 / 歯 / 調 / 訪、省略時は 医）
//   node bin/ask.js 調:10-2
//   node bin/ask.js 施:機能強化加算        施設基準カード: 告示（基本/特掲）+ 通知 + 訂正履歴 + 話題が一致する疑義解釈
//   node bin/ask.js 在宅自己注射 導入初期   全文検索（空白区切りの語をすべて含むもの。trigram なので3文字以上）
//   オプション: --table=医|歯|調|訪  --limit=N(既定10)  --full(本文を省略しない)  --json
//
// 出力には必ず出典（fid・ページ・訂正版）を付ける。

const fs = require('fs');
const path = require('path');
const kb = require('../lib/db');
const { Query } = require('../lib/query');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opts = {}; const words = [];
for (const a of args) { const m = a.match(/^--([a-z]+)(?:=(.*))?$/); if (m) opts[m[1]] = m[2] ?? true; else words.push(a); }
const config = JSON.parse(fs.readFileSync(path.resolve(opts.config || path.join(ROOT, 'config.json')), 'utf8'));
const dataDirRaw = opts.data || config.dataDir || 'data';
const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(ROOT, dataDirRaw);
const dbPath = path.resolve(opts.db || path.join(dataDir, 'kb.sqlite'));
if (!fs.existsSync(dbPath)) { console.error(`索引がありません: ${dbPath}（node bin/build-index.js を先に実行）`); process.exit(1); }
const q = new Query(dbPath);
const limit = Number(opts.limit || 10);
const FULL = !!opts.full;

function clip(s, n) { return FULL || s.length <= n ? s : s.slice(0, n) + `…（以下 ${s.length - n} 文字省略、--full で全文）`; }
function hr(t) { console.log('\n' + '━'.repeat(8) + ' ' + t + ' ' + '━'.repeat(Math.max(0, 60 - t.length))); }

function printCard(code) {
  const c = q.card(code);
  if (opts.json) { console.log(JSON.stringify(c, null, 1)); return; }
  if (!c.chunks.length && !c.qas.length && !c.teisei.length) { console.log(`${code}: 該当なし`); return; }
  for (const ch of c.chunks) {
    hr(`${ch.kind === 'shisetsu' ? `${ch.tbl}診療料 施設基準` : (ch.code || '通則')} ${ch.title}  ― ${ch.doc} p${ch.p_start}${ch.p_end !== ch.p_start ? '-' + ch.p_end : ''}`);
    console.log(ch.path.join(' > '));
    console.log(clip(ch.text, 1500));
  }
  if (c.teisei.length) {
    hr(`訂正履歴 ${c.teisei.length} 件（訂正事務連絡に載った訂正後の該当箇所）`);
    for (const r of c.teisei) {
      console.log(`\n[${r.date}] 別添${r.besshi} ${r.target.slice(0, 40)}  (${r.docLabel} p${r.p_start})`);
      console.log(clip(r.text, 500));
    }
  }
  if (c.qas.length) {
    hr(`関連する疑義解釈 ${c.qas.length} 件`);
    for (const x of c.qas) {
      console.log(`\n[${x.doc} ${x.no}]${x.topic ? ' 【' + x.topic + '】' : ''}  (${x.docLabel} p${x.p_start})`);
      console.log('問: ' + clip(x.q, 400));
      console.log('答: ' + clip(x.a, 600));
    }
  }
}

function printSearch(terms) {
  const res = q.search(terms, { table: opts.table || null, limit });
  if (opts.json) { console.log(JSON.stringify(res, null, 1)); return; }
  console.log(`検索: ${terms.join(' ')}  → ${res.total} 件（上位 ${res.results.length} 件を表示）`);
  for (const r of res.results) {
    if (r.type === 'chunk') {
      console.log(`\n■ ${r.kind === 'shisetsu' ? `[${r.tbl} 施設基準]` : (r.code || '通則')} ${r.title}  ― ${r.docLabel} p${r.p_start}`);
      console.log(`  ${r.path.join(' > ')}`);
      console.log(`  ${r.snip}`);
    } else if (r.type === 'teisei') {
      console.log(`\n■ 訂正 [${r.date}] ${r.code || r.target.slice(0, 30)} ${r.title || ''}  ― 訂正事務連絡 別添${r.besshi} [fid ${r.fid.slice(0, 8)}] p${r.p_start}`);
      console.log(`  ${r.snip}`);
    } else {
      console.log(`\n■ [${r.doc} ${r.no}]${r.topic ? ' 【' + r.topic + '】' : ''}  ― ${r.docLabel} p${r.p_start}`);
      console.log(`  ${r.snip}`);
      console.log(`  問: ${r.q.slice(0, 120)}`);
      console.log(`  答: ${r.a.slice(0, 160)}`);
    }
  }
}

if (!words.length) { console.error('使い方: node bin/ask.js <区分番号 | 施:施設基準の名称 | 検索語 ...>'); process.exit(1); }
const code = words.length === 1 ? q.parseCode(words[0]) : null;
if (code) printCard(code);
else if (words.length === 1 && /^施[:：]/.test(words[0])) printCard('施:' + kb.norm(words[0].replace(/^施[:：]/, '')));
else {
  const key = q.shisetsuKey(words);
  if (key) { printCard(key); console.log(); }
  printSearch(words);
}
