'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../lib/db');

test('norm: 全角英数→半角、空白除去', () => {
  assert.equal(kb.norm('令和８年３月31 日 保医発0305 第６号 Ａ０００'), '令和8年3月31日保医発0305第6号a000');
});

test('SQLite FTS5 trigram で日本語部分一致と区分番号参照の結合ができる', () => {
  const db = kb.open(':memory:');
  db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('c1', 'f1', '医', 'kubun', '医:C101', '["医:C101"]', '在宅自己注射指導管理料', '[]', 163, 163, '注 導入初期加算', kb.norm('Ｃ１０１ 在宅自己注射指導管理料 注 導入初期加算'));
  db.prepare('INSERT INTO chunks_fts (id, title, norm) VALUES (?,?,?)').run('c1', '在宅自己注射指導管理料', kb.norm('Ｃ１０１ 在宅自己注射指導管理料 注 導入初期加算'));
  db.prepare('INSERT INTO qa VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('q1', 'f2', 'その2', '医科診療報酬点数表関係', '医', '在宅自己注射', '問1', '導入初期加算は', '算定できる', '["医:C101"]', 5, 5, kb.norm('導入初期加算は 算定できる'));
  db.prepare('INSERT INTO refs VALUES (?,?,?)').run('q1', 'qa', '医:C101');
  const hit = db.prepare("SELECT id FROM chunks_fts WHERE chunks_fts MATCH ?").all('"在宅自己注射" AND "導入初期"');
  assert.deepEqual(hit.map(h => h.id), ['c1']);
  const joined = db.prepare('SELECT q.no FROM refs r JOIN qa q ON q.id = r.owner WHERE r.code = ?').all('医:C101');
  assert.deepEqual(joined.map(j => j.no), ['問1']);
  db.close();
});
