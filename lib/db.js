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

function norm(s) {
  return (s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　]+/g, '')
    .toLowerCase();
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
CREATE TABLE IF NOT EXISTS refs (owner TEXT, owner_kind TEXT, code TEXT);
CREATE INDEX IF NOT EXISTS refs_code ON refs(code);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, title, norm, tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS qa_fts USING fts5(id UNINDEXED, topic, norm, tokenize='trigram');
`;

function open(file) {
  const db = new DatabaseSync(file);
  // WAL はネットワーク/FUSE マウント上では失敗することがあるので、使えなければ既定のジャーナルで続行
  try { db.exec('PRAGMA journal_mode=WAL'); } catch (e) { /* ignore */ }
  db.exec(SCHEMA);
  return db;
}

function reset(db) {
  db.exec('DELETE FROM docs; DELETE FROM chunks; DELETE FROM qa; DELETE FROM refs; DELETE FROM chunks_fts; DELETE FROM qa_fts;');
}

module.exports = { open, reset, norm };
