'use strict';
// ナリッジベース本体（SQLite + FTS5 trigram）。Node 22 組み込みの node:sqlite を使い、ネイティブ依存を持たない。
//
//   docs      取り込んだ文書（fid ごと）
//   chunks    告示・通知の区分番号/通則チャンク
//   qa        疑義解釈の問／答
//   refs      チャンク/QA が言及する区分番号（名前空間付き: 医:A000 / 歯:A000 / 調:10-2 / 訪:06）
//   chunks_fts, qa_fts  全文索引（trigram: 日本語をトークナイザなしで部分一致検索できる）
//
// 検索用正規化 (norm): 全角英数→半角、空白除去。PDF 由来の「0305 第６号」「令和８年３月31 日」のような
// 空白の揺れと、全角半角の揺れを吸収する。

// node:sqlite の ExperimentalWarning（Node 22）だけを抑止する
process.on('warning', w => { if (w.name !== 'ExperimentalWarning' || !/sqlite/i.test(w.message)) console.error(w); });
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (/SQLite/.test(msg)) return;
  return origEmit.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

// 正規化: 全角英数→半角、小文字化、空白は除去。ただし英数字同士の間の空白は1つ残す
// （「充実管理加算１ 30点」を「加算130点」にしないため。「令和８年３月31 日」は「31日」になる）。
function normWithMap(s) {
  const src = s || '';
  const out = []; const map = [];
  let pendingSpace = false;
  for (let i = 0; i < src.length; i++) {
    let ch = src[i];
    if (/[\s　]/.test(ch)) { pendingSpace = true; continue; }
    if (/[Ａ-Ｚａ-ｚ０-９]/.test(ch)) ch = String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    else if (/[－‐―]/.test(ch)) ch = '-'; // 区分番号の枝番区切り（全角・U+2015）を半角に
    ch = ch.toLowerCase();
    if (pendingSpace) {
      const prev = out.length ? out[out.length - 1] : '';
      if (/[0-9a-z]/.test(prev) && /[0-9a-z]/.test(ch)) { out.push(' '); map.push(i); }
      pendingSpace = false;
    }
    out.push(ch); map.push(i);
  }
  return { s: out.join(''), map };
}
function norm(s) { return normWithMap(s).s; }

// 検索語（正規化済み）を原文中で探し、原文の抜粋（前後 ctx 文字）を [ ] 付きで返す
function snippetOf(text, normTerms, ctx = 40) {
  const { s, map } = normWithMap(text);
  let best = -1, bestLen = 0;
  for (const t of normTerms) { const i = s.indexOf(t); if (i >= 0 && (best < 0 || i < best)) { best = i; bestLen = t.length; } }
  if (best < 0) return text.slice(0, ctx * 2).replace(/\n/g, ' ');
  const from = map[Math.max(0, best - ctx)], to = map[Math.min(s.length - 1, best + bestLen + ctx)] + 1;
  let frag = text.slice(from, to);
  // 語の強調（原文側の表記ゆれを吸収するため、正規化して一致する範囲を [ ] で囲む）
  for (const t of normTerms) {
    const { s: fs, map: fm } = normWithMap(frag);
    const i = fs.indexOf(t); if (i < 0) continue;
    const a = fm[i], b = fm[i + t.length - 1] + 1;
    frag = frag.slice(0, a) + '[' + frag.slice(a, b) + ']' + frag.slice(b);
  }
  return (from > 0 ? '…' : '') + frag.replace(/\n/g, ' ') + (to < text.length ? '…' : '');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  fid TEXT PRIMARY KEY, category TEXT, tbl TEXT, kind TEXT, aname TEXT, note TEXT, revision TEXT,
  url TEXT, crawl_id TEXT, observed_at TEXT, pages INTEGER
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY, fid TEXT, tbl TEXT, kind TEXT, code TEXT, codes TEXT, title TEXT, path TEXT,
  p_start INTEGER, p_end INTEGER, text TEXT, norm TEXT
);
CREATE INDEX IF NOT EXISTS chunks_code ON chunks(tbl, code);
CREATE TABLE IF NOT EXISTS qa (
  id TEXT PRIMARY KEY, fid TEXT, doc TEXT, section TEXT, tbl TEXT, topic TEXT, no TEXT, q TEXT, a TEXT, codes TEXT,
  p_start INTEGER, p_end INTEGER, norm TEXT
);
CREATE TABLE IF NOT EXISTS teisei (
  id TEXT PRIMARY KEY, fid TEXT, date TEXT, besshi INTEGER, target TEXT, target_ref TEXT, tbl TEXT, kind TEXT, code TEXT,
  title TEXT, text TEXT, norm TEXT, p_start INTEGER, p_end INTEGER
);
CREATE INDEX IF NOT EXISTS teisei_code ON teisei(code);
CREATE TABLE IF NOT EXISTS refs (owner TEXT, owner_kind TEXT, code TEXT);
CREATE INDEX IF NOT EXISTS refs_code ON refs(code);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, title, norm, tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS qa_fts USING fts5(id UNINDEXED, topic, norm, tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS teisei_fts USING fts5(id UNINDEXED, title, norm, tokenize='trigram');
`;

function open(file) {
  const db = new DatabaseSync(file);
  // WAL はネットワーク/FUSE マウント上では失敗することがあるので、使えなければ既定のジャーナルで続行
  try { db.exec('PRAGMA journal_mode=WAL'); } catch (e) { /* ignore */ }
  db.exec(SCHEMA);
  return db;
}

function reset(db) {
  db.exec('DELETE FROM docs; DELETE FROM chunks; DELETE FROM qa; DELETE FROM teisei; DELETE FROM refs; DELETE FROM chunks_fts; DELETE FROM qa_fts; DELETE FROM teisei_fts;');
}

module.exports = { open, reset, norm, normWithMap, snippetOf };
