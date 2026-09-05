'use strict';
// 小さな索引を作って bin/server.js を起動し、API と画面を叩く
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const kb = require('../lib/db');

const ROOT = path.join(__dirname, '..');

function seed(dbPath) {
  const db = kb.open(dbPath);
  db.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('f1', 'ika_kokuji', '医', 'kokuji', '医科点数表', '', null, 'u', 'c', 't', 1);
  db.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('f2', 'gigi', null, 'qa', 'その2', '', null, 'u', 'c', 't', 1);
  const text = 'Ｃ１０１ 在宅自己注射指導管理料\n注 導入初期加算 580点';
  db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('c1', 'f1', '医', 'kubun', '医:C101', '["医:C101"]', '在宅自己注射指導管理料', '["第2章"]', 163, 163, text, kb.norm(text));
  db.prepare('INSERT INTO chunks_fts (id, title, norm) VALUES (?,?,?)').run('c1', '在宅自己注射指導管理料', kb.norm(text));
  db.prepare('INSERT INTO qa VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('q1', 'f2', 'その2', '医科診療報酬点数表関係', '医', '在宅自己注射', '問1', '導入初期加算は算定できるか。', '算定できる。', '["医:C101"]', 5, 5, kb.norm('在宅自己注射 導入初期加算は算定できるか。 算定できる。'));
  db.prepare('INSERT INTO qa_fts (id, topic, norm) VALUES (?,?,?)').run('q1', '在宅自己注射', kb.norm('在宅自己注射 導入初期加算は算定できるか。 算定できる。'));
  db.prepare('INSERT INTO refs VALUES (?,?,?)').run('q1', 'qa', '医:C101');
  db.close();
}

async function withServer(env, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhlwkb-srv-'));
  const dbPath = path.join(tmp, 'kb.sqlite');
  seed(dbPath);
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/server.js'), `--db=${dbPath}`, `--port=${port}`, '--host=127.0.0.1'], { env: { ...process.env, AUTH_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.stdout.on('data', d => { if (/listening/.test(String(d))) resolve(); }); child.stderr.on('data', d => reject(new Error(String(d)))); });
  try { await fn(`http://127.0.0.1:${port}`); } finally { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('HTTP API: health / card / search / 画面', async () => {
  await withServer({}, async base => {
    const h = await (await fetch(base + '/api/health')).json();
    assert.equal(h.ok, true); assert.equal(h.docs, 2);
    const card = await (await fetch(base + '/api/card?code=C101')).json();
    assert.equal(card.code, '医:C101'); assert.equal(card.chunks.length, 1); assert.equal(card.qas.length, 1);
    assert.equal(card.chunks[0].doc, '告示 [fid f1]');
    const s = await (await fetch(base + '/api/search?q=' + encodeURIComponent('在宅自己注射 導入初期'))).json();
    assert.equal(s.card, null); assert.equal(s.search.total, 2);
    assert.match(s.search.results[0].snip, /\[/);
    const s2 = await (await fetch(base + '/api/search?q=C101')).json();
    assert.equal(s2.card.code, '医:C101'); assert.equal(s2.search, null);
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /告示通知 お尋ね/);
    assert.equal((await fetch(base + '/api/card')).status, 400);
    assert.equal((await fetch(base + '/nope')).status, 404);
  });
});

test('HTTP API: AUTH_TOKEN を設定すると API は 401、health は通る', async () => {
  await withServer({ AUTH_TOKEN: 'secret' }, async base => {
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/api/card?code=C101')).status, 401);
    assert.equal((await fetch(base + '/api/card?code=C101', { headers: { Authorization: 'Bearer secret' } })).status, 200);
    assert.equal((await fetch(base + '/api/card?code=C101&token=secret')).status, 200);
  });
});
