#!/usr/bin/env node
'use strict';
// 告示通知 お尋ねサーバー（HTTP）。Node 組み込みの http だけで動く（外部依存なし）。
//
//   node bin/server.js                    http://127.0.0.1:8080/
//   node bin/server.js --port=8080 --host=0.0.0.0
//   環境変数: PORT, HOST, AUTH_TOKEN（設定すると API と画面にトークンが必要。画面は初回にトークンを聞く）
//
// API（すべて GET, JSON）:
//   /api/health                          稼働確認・索引の文書数
//   /api/docs                            索引に入っている文書一覧（fid・カテゴリ・訂正版・URL）
//   /api/card?code=B001-10               区分番号カード（医:/歯:/調:/訪: 名前空間、施:名称 も可）
//   /api/search?q=在宅自己注射 導入初期&table=医&limit=10   全文検索
//   /                                    ブラウザ画面（web/index.html）
//
// 索引（data/kb.sqlite）は読み取り専用で開く。bin/build-index.js で作り直したら再起動する。

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const kb = require('../lib/db');
const { Query } = require('../lib/query');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const val = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
// .env を読む（crawl.js と同じ簡易ローダ）
(function loadDotEnv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})(path.join(ROOT, '.env'));

const config = JSON.parse(fs.readFileSync(path.resolve(val('config', path.join(ROOT, 'config.json'))), 'utf8'));
const dataDirRaw = val('data', config.dataDir || 'data');
const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(ROOT, dataDirRaw);
const dbPath = path.resolve(val('db', path.join(dataDir, 'kb.sqlite')));
const PORT = Number(val('port', process.env.PORT || 8080));
const HOST = val('host', process.env.HOST || '127.0.0.1');
const TOKEN = process.env.AUTH_TOKEN || '';
const INDEX_HTML = path.join(ROOT, 'web', 'index.html');

if (!fs.existsSync(dbPath)) { console.error(`索引がありません: ${dbPath}（node bin/build-index.js を先に実行）`); process.exit(1); }
const q = new Query(dbPath);

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function authorized(req, url) {
  if (!TOKEN) return true;
  const h = req.headers['authorization'] || '';
  if (h === `Bearer ${TOKEN}`) return true;
  if (url.searchParams.get('token') === TOKEN) return true;
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(INDEX_HTML));
    }
    if (p === '/api/health') return json(res, 200, { ok: true, db: path.basename(dbPath), docs: q.docs().length, auth: !!TOKEN });
    if (!p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (!authorized(req, url)) return json(res, 401, { error: 'unauthorized' });

    if (p === '/api/docs') return json(res, 200, { docs: q.docs() });
    if (p === '/api/card') {
      const raw = (url.searchParams.get('code') || '').trim();
      if (!raw) return json(res, 400, { error: 'code required' });
      const code = /^施[:：]/.test(raw) ? '施:' + kb.norm(raw.replace(/^施[:：]/, '')) : q.parseCode(raw);
      if (!code) return json(res, 400, { error: `区分番号として解釈できません: ${raw}` });
      return json(res, 200, q.card(code));
    }
    if (p === '/api/search') {
      const text = (url.searchParams.get('q') || '').trim();
      if (!text) return json(res, 400, { error: 'q required' });
      const words = text.split(/[\s　]+/).filter(Boolean);
      const limit = Math.min(50, Number(url.searchParams.get('limit') || 10));
      const table = url.searchParams.get('table') || null;
      const code = words.length === 1 ? q.parseCode(words[0]) : null;
      const key = code ? null : q.shisetsuKey(words);
      const out = { query: text, card: null, search: null };
      if (code) out.card = q.card(code);
      else {
        if (key) out.card = q.card(key);
        out.search = q.search(words, { table, limit });
      }
      return json(res, 200, out);
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[mhlw-kb] listening on http://${HOST}:${PORT}/  db=${dbPath}  auth=${TOKEN ? 'token' : 'none'}`);
});
process.on('SIGTERM', () => { server.close(() => { q.close(); process.exit(0); }); });
