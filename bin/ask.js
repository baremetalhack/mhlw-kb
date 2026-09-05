#!/usr/bin/env node
'use strict';
// 告示通知 お尋ね（CLI 版）
//
//   node bin/ask.js A000                 区分番号カード: 告示本文 + 通知（留意事項）+ 関連する疑義解釈
//   node bin/ask.js 歯:M017              歯科の区分（名前空間: 医 / 歯 / 調 / 訪、省略時は 医）
//   node bin/ask.js 調:10-2
//   node bin/ask.js 施:機能強化加算        施設基準カード: 告示（基本/特掲）+ 通知 + 話題が一致する疑義解釈
//   node bin/ask.js 在宅自己注射 導入初期   全文検索（空白区切りの語をすべて含むもの。trigram なので3文字以上）
//   オプション: --table=医|歯|調|訪  --limit=N(既定10)  --full(本文を省略しない)  --json
//
// 出力には必ず出典（fid・ページ・訂正版）を付ける。

const fs = require('fs');
const path = require('path');
const kb = require('../lib/db');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opts = {}; const words = [];
for (const a of args) { const m = a.match(/^--([a-z]+)(?:=(.*))?$/); if (m) opts[m[1]] = m[2] ?? true; else words.push(a); }
const config = JSON.parse(fs.readFileSync(path.resolve(opts.config || path.join(ROOT, 'config.json')), 'utf8'));
const dataDirRaw = opts.data || config.dataDir || 'data';
const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(ROOT, dataDirRaw);
const dbPath = path.resolve(opts.db || path.join(dataDir, 'kb.sqlite'));
if (!fs.existsSync(dbPath)) { console.error(`索引がありません: ${dbPath}（node bin/build-index.js を先に実行）`); process.exit(1); }
const db = kb.open(dbPath);
const limit = Number(opts.limit || 10);
const FULL = !!opts.full;

const toAscii = s => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
const CODE_RE = /^(?:([医歯調訪])[:：])?([A-Z][0-9]{3}(?:-[0-9]+)*|[0-9]{2}(?:-[0-9]+)*)$/;
function parseCode(s) {
  const t = toAscii(s).replace(/[－‐―の]/g, '-').toUpperCase();
  const m = t.match(CODE_RE);
  if (!m) return null;
  const tbl = m[1] || (/^[0-9]/.test(m[2]) ? '調' : '医');
  return `${tbl}:${m[2]}`;
}

function docLabel(fid) {
  const d = db.prepare('SELECT * FROM docs WHERE fid = ?').get(fid);
  if (!d) return fid;
  const kind = d.kind === 'kokuji' ? '告示' : d.kind === 'tsuchi' ? '通知' : '疑義解釈';
  return `${kind}${d.note ? ' ' + d.note : ''} [fid ${fid.slice(0, 8)}]`;
}
function clip(s, n) { return FULL || s.length <= n ? s : s.slice(0, n) + `…（以下 ${s.length - n} 文字省略、--full で全文）`; }
function hr(t) { console.log('\n' + '━'.repeat(8) + ' ' + t + ' ' + '━'.repeat(Math.max(0, 60 - t.length))); }

function card(code) {
  const [tbl] = code.split(':');
  // 施設基準: 名称が一致する項目に加え、告示側の長い題（「医科初診料の機能強化加算の施設基準」）も名称を含めば拾う
  const chunks = tbl === '施'
    ? db.prepare("SELECT * FROM chunks WHERE kind='shisetsu' AND (code = ? OR code LIKE ?) ORDER BY tbl, CASE WHEN fid IN (SELECT fid FROM docs WHERE kind='kokuji') THEN 0 ELSE 1 END, p_start").all(code, `施:%${code.slice(2)}%`)
    : db.prepare("SELECT * FROM chunks WHERE tbl = ? AND (code = ? OR codes LIKE ?) ORDER BY CASE WHEN fid IN (SELECT fid FROM docs WHERE kind='kokuji') THEN 0 ELSE 1 END").all(tbl, code, `%"${code}"%`);
  const qas = tbl === '施'
    ? db.prepare('SELECT DISTINCT q.* FROM refs r JOIN qa q ON q.id = r.owner WHERE r.code = ? OR r.code LIKE ? ORDER BY q.doc, q.no').all(code, `施:%${code.slice(2)}%`)
    : db.prepare('SELECT q.* FROM refs r JOIN qa q ON q.id = r.owner WHERE r.code = ? ORDER BY q.doc, q.no').all(code);
  if (opts.json) { console.log(JSON.stringify({ code, chunks, qas }, null, 1)); return; }
  if (!chunks.length && !qas.length) { console.log(`${code}: 該当なし`); return; }
  for (const c of chunks) {
    hr(`${c.kind === 'shisetsu' ? `${c.tbl}診療料 施設基準` : (c.code || '通則')} ${c.title}  ― ${docLabel(c.fid)} p${c.p_start}${c.p_end !== c.p_start ? '-' + c.p_end : ''}`);
    console.log(JSON.parse(c.path).join(' > '));
    console.log(clip(c.text, 1500));
  }
  if (qas.length) {
    hr(`関連する疑義解釈 ${qas.length} 件`);
    for (const q of qas) {
      console.log(`\n[${q.doc} ${q.no}]${q.topic ? ' 【' + q.topic + '】' : ''}  (${docLabel(q.fid)} p${q.p_start})`);
      console.log('問: ' + clip(q.q, 400));
      console.log('答: ' + clip(q.a, 600));
    }
  }
}

function ftsQuery(terms) {
  // trigram は3文字未満の語を検索できないので、短い語は LIKE で後段フィルタする
  const long = terms.filter(t => t.length >= 3), short = terms.filter(t => t.length < 3);
  return { match: long.map(t => `"${t.replace(/"/g, '""')}"`).join(' AND '), short };
}

function search(terms) {
  const normTerms = terms.map(kb.norm).filter(Boolean);
  const { match, short } = ftsQuery(normTerms);
  const tblFilter = opts.table ? ` AND c.tbl = '${opts.table}'` : '';
  const results = [];
  if (match) {
    const rows = db.prepare(`SELECT c.*, bm25(chunks_fts) AS rank
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.id WHERE chunks_fts MATCH ?${tblFilter} ORDER BY rank LIMIT ?`).all(match, limit * 3);
    for (const r of rows) if (short.every(s => r.norm.includes(s))) results.push({ type: 'chunk', ...r, snip: kb.snippetOf(r.text, normTerms) });
    const qrows = db.prepare(`SELECT q.*, bm25(qa_fts) AS rank
      FROM qa_fts JOIN qa q ON q.id = qa_fts.id WHERE qa_fts MATCH ?${opts.table ? ` AND q.tbl = '${opts.table}'` : ''} ORDER BY rank LIMIT ?`).all(match, limit * 3);
    for (const r of qrows) if (short.every(s => r.norm.includes(s))) results.push({ type: 'qa', ...r, snip: kb.snippetOf(r.q + ' ／ ' + r.a, normTerms) });
  } else {
    // 全部短い語: LIKE のみ
    const like = normTerms.map(() => 'norm LIKE ?').join(' AND ');
    for (const r of db.prepare(`SELECT * FROM chunks c WHERE ${like}${tblFilter} LIMIT ?`).all(...normTerms.map(t => `%${t}%`), limit)) results.push({ type: 'chunk', ...r, rank: 0, snip: kb.snippetOf(r.text, normTerms) });
    for (const r of db.prepare(`SELECT * FROM qa q WHERE ${like} LIMIT ?`).all(...normTerms.map(t => `%${t}%`), limit)) results.push({ type: 'qa', ...r, rank: 0, snip: kb.snippetOf(r.q + ' ／ ' + r.a, normTerms) });
  }
  results.sort((a, b) => a.rank - b.rank);
  const top = results.slice(0, limit);
  if (opts.json) { console.log(JSON.stringify(top, null, 1)); return; }
  console.log(`検索: ${terms.join(' ')}  → ${results.length} 件（上位 ${top.length} 件を表示）`);
  for (const r of top) {
    if (r.type === 'chunk') {
      console.log(`\n■ ${r.kind === 'shisetsu' ? `[${r.tbl} 施設基準]` : (r.code || '通則')} ${r.title}  ― ${docLabel(r.fid)} p${r.p_start}`);
      console.log(`  ${JSON.parse(r.path).join(' > ')}`);
      console.log(`  ${r.snip}`);
    } else {
      console.log(`\n■ [${r.doc} ${r.no}]${r.topic ? ' 【' + r.topic + '】' : ''}  ― ${docLabel(r.fid)} p${r.p_start}`);
      console.log(`  ${r.snip}`);
      console.log(`  問: ${r.q.slice(0, 120)}`);
      console.log(`  答: ${r.a.slice(0, 160)}`);
    }
  }
}

if (!words.length) { console.error('使い方: node bin/ask.js <区分番号 | 施:施設基準の名称 | 検索語 ...>'); process.exit(1); }
const code = words.length === 1 ? parseCode(words[0]) : null;
if (code) card(code);
else if (words.length === 1 && /^施[:：]/.test(words[0])) card('施:' + kb.norm(words[0].replace(/^施[:：]/, '')));
else {
  // 検索語全体が施設基準項目の題と一致するならカードを先に出す（例: 機能強化加算）
  const key = '施:' + kb.norm(words.join(''));
  if (db.prepare("SELECT 1 FROM chunks WHERE kind='shisetsu' AND (code = ? OR code LIKE ?) LIMIT 1").get(key, `施:%${key.slice(2)}%`)) { card(key); console.log(); }
  search(words);
}
