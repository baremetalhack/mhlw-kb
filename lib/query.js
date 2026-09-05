'use strict';
// 問い合わせロジック（CLI の bin/ask.js と HTTP の bin/server.js が共用）
//
//   const q = new Query(dbPath)
//   q.parseCode('B001-10')  → '医:B001-10' | null
//   q.card('医:B001-10')    → { code, chunks:[...], qas:[...], teisei:[...] }
//   q.search(['在宅自己注射','導入初期'], { table, limit }) → { total, results:[{type:'chunk'|'qa'|'teisei', ..., snip}] }
//   q.docs()                → 索引に入っている文書一覧
//   q.shisetsuKey(words)    → 検索語全体が施設基準の名称に一致するなら '施:…'

const kb = require('./db');

const toAscii = s => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
const CODE_RE = /^(?:([医歯調訪])[:：])?([A-Z][0-9]{3}(?:-[0-9]+)*|[0-9]{2}(?:-[0-9]+)*)$/;

class Query {
  constructor(dbPath) {
    this.db = kb.open(dbPath);
    this._docs = new Map();
  }
  close() { this.db.close(); }

  parseCode(s) {
    const t = toAscii(String(s).trim()).replace(/[－‐―の]/g, '-').toUpperCase();
    const m = t.match(CODE_RE);
    if (!m) return null;
    const tbl = m[1] || (/^[0-9]/.test(m[2]) ? '調' : '医');
    return `${tbl}:${m[2]}`;
  }

  doc(fid) {
    if (!this._docs.has(fid)) this._docs.set(fid, this.db.prepare('SELECT * FROM docs WHERE fid = ?').get(fid) || null);
    return this._docs.get(fid);
  }
  docLabel(fid) {
    const d = this.doc(fid);
    if (!d) return fid;
    const kind = d.kind === 'kokuji' ? '告示' : d.kind === 'tsuchi' ? '通知' : d.kind === 'teisei' ? '訂正事務連絡' : '疑義解釈';
    return `${kind}${d.note ? ' ' + d.note : ''} [fid ${fid.slice(0, 8)}]`;
  }
  docs() {
    return this.db.prepare('SELECT fid, category, tbl, kind, aname, note, revision, url, observed_at, pages FROM docs ORDER BY category').all();
  }

  shisetsuKey(words) {
    const key = '施:' + kb.norm(words.join(''));
    const hit = this.db.prepare("SELECT 1 FROM chunks WHERE kind='shisetsu' AND (code = ? OR code LIKE ?) LIMIT 1").get(key, `施:%${key.slice(2)}%`);
    return hit ? key : null;
  }

  card(code) {
    const db = this.db;
    const [tbl] = code.split(':');
    const like = `施:%${code.slice(2)}%`;
    const chunks = tbl === '施'
      ? db.prepare("SELECT * FROM chunks WHERE kind='shisetsu' AND (code = ? OR code LIKE ?) ORDER BY tbl, CASE WHEN fid IN (SELECT fid FROM docs WHERE kind='kokuji') THEN 0 ELSE 1 END, p_start").all(code, like)
      : db.prepare("SELECT * FROM chunks WHERE tbl = ? AND (code = ? OR codes LIKE ?) ORDER BY CASE WHEN fid IN (SELECT fid FROM docs WHERE kind='kokuji') THEN 0 ELSE 1 END").all(tbl, code, `%"${code}"%`);
    const qas = tbl === '施'
      ? db.prepare('SELECT DISTINCT q.* FROM refs r JOIN qa q ON q.id = r.owner WHERE r.code = ? OR r.code LIKE ? ORDER BY q.doc, q.no').all(code, like)
      : db.prepare('SELECT q.* FROM refs r JOIN qa q ON q.id = r.owner WHERE r.code = ? ORDER BY q.doc, q.no').all(code);
    const teisei = tbl === '施'
      ? db.prepare('SELECT * FROM teisei WHERE code = ? OR code LIKE ? ORDER BY date, besshi, p_start').all(code, like)
      : db.prepare('SELECT * FROM teisei WHERE code = ? ORDER BY date, besshi, p_start').all(code);
    const strip = r => { const { norm, ...rest } = r; return rest; };
    return {
      code,
      chunks: chunks.map(c => ({ ...strip(c), path: JSON.parse(c.path || '[]'), codes: JSON.parse(c.codes || '[]'), doc: this.docLabel(c.fid) })),
      qas: qas.map(q => ({ ...strip(q), codes: JSON.parse(q.codes || '[]'), docLabel: this.docLabel(q.fid) })),
      teisei: teisei.map(t => ({ ...strip(t), docLabel: this.docLabel(t.fid) })),
    };
  }

  search(terms, { table = null, limit = 10 } = {}) {
    const db = this.db;
    const normTerms = terms.map(kb.norm).filter(Boolean);
    const long = normTerms.filter(t => t.length >= 3), short = normTerms.filter(t => t.length < 3);
    const match = long.map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ');
    const results = [];
    const okShort = r => short.every(s => r.norm.includes(s));
    if (match) {
      const rows = db.prepare(`SELECT c.*, bm25(chunks_fts) AS rank FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.id WHERE chunks_fts MATCH ?${table ? ' AND c.tbl = ?' : ''} ORDER BY rank LIMIT ?`).all(...(table ? [match, table, limit * 3] : [match, limit * 3]));
      for (const r of rows) if (okShort(r)) results.push({ type: 'chunk', ...r, snip: kb.snippetOf(r.text, normTerms) });
      const qrows = db.prepare(`SELECT q.*, bm25(qa_fts) AS rank FROM qa_fts JOIN qa q ON q.id = qa_fts.id WHERE qa_fts MATCH ?${table ? ' AND q.tbl = ?' : ''} ORDER BY rank LIMIT ?`).all(...(table ? [match, table, limit * 3] : [match, limit * 3]));
      for (const r of qrows) if (okShort(r)) results.push({ type: 'qa', ...r, snip: kb.snippetOf(r.q + ' ／ ' + r.a, normTerms) });
      const trows = db.prepare('SELECT t.*, bm25(teisei_fts) AS rank FROM teisei_fts JOIN teisei t ON t.id = teisei_fts.id WHERE teisei_fts MATCH ? ORDER BY rank LIMIT ?').all(match, limit * 2);
      for (const r of trows) if (okShort(r)) results.push({ type: 'teisei', ...r, snip: kb.snippetOf(r.text, normTerms) });
    } else if (normTerms.length) {
      const like = normTerms.map(() => 'norm LIKE ?').join(' AND ');
      const params = normTerms.map(t => `%${t}%`);
      for (const r of db.prepare(`SELECT * FROM chunks WHERE ${like}${table ? ' AND tbl = ?' : ''} LIMIT ?`).all(...params, ...(table ? [table] : []), limit)) results.push({ type: 'chunk', ...r, rank: 0, snip: kb.snippetOf(r.text, normTerms) });
      for (const r of db.prepare(`SELECT * FROM qa WHERE ${like} LIMIT ?`).all(...params, limit)) results.push({ type: 'qa', ...r, rank: 0, snip: kb.snippetOf(r.q + ' ／ ' + r.a, normTerms) });
      for (const r of db.prepare(`SELECT * FROM teisei WHERE ${like} LIMIT ?`).all(...params, limit)) results.push({ type: 'teisei', ...r, rank: 0, snip: kb.snippetOf(r.text, normTerms) });
    }
    results.sort((a, b) => a.rank - b.rank);
    const top = results.slice(0, limit).map(r => {
      const { norm, text, ...rest } = r; // 一覧では本文全文を返さない
      const o = { ...rest, docLabel: this.docLabel(r.fid) };
      if (r.type === 'chunk') o.path = JSON.parse(r.path || '[]');
      return o;
    });
    return { terms, total: results.length, results: top };
  }
}

module.exports = { Query };
