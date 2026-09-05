'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../lib/db');

test('norm: 全角英数→半角、空白除去（英数字同士の間だけ1つ残す）', () => {
  assert.equal(kb.norm('令和８年３月31 日 保医発0305 第６号 Ａ０００'), '令和8年3月31日保医発0305第6号a000');
  assert.equal(kb.norm('（１） 充実管理加算１ 30点'), '（1）充実管理加算1 30点');
  assert.equal(kb.norm('Ｂ００１－３ 生活習慣病管理料'), 'b001-3生活習慣病管理料');
});

test('snippetOf: 原文の抜粋に検索語を [ ] で示す', () => {
  const text = 'イ 充実管理加算（脂質異常症を主病とする場合）\n（１） 充実管理加算１ 30点\n（２） 充実管理加算２ 20点';
  const snip = kb.snippetOf(text, [kb.norm('充実管理加算')], 30);
  assert.match(snip, /\[充実管理加算\]/);
  assert.match(snip, /加算１ 30点/);
  assert.doesNotMatch(snip, /加算130点/);
  const s2 = kb.snippetOf('区分番号Ｂ００１－３に掲げる生活習慣病管理料', [kb.norm('B001-3')], 5);
  assert.match(s2, /\[Ｂ００１－３\]/);
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
