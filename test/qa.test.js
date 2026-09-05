'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQA, validateQA, extractCodes } = require('../lib/qa');

function L(p, x, text) { return { p, x, y: 0, w: 100, h: 9, size: 9, text }; }
const doc = { fid: 'f', pages: 3, lines: [
  L(1, 428, '事 務 連 絡'), L(1, 193, '疑義解釈資料の送付について（その12）'),
  L(1, 82, '問15 及び問143 について、別添６のとおり訂正します。'), // 表紙の文（問ではない）
  L(2, 445, '（別添１）'), L(2, 231, '医科診療報酬点数表関係'),
  L(2, 85, '【特定機能病院等紹介患者受入加算】'),
  L(2, 83, '問１ 特定機能病院等紹介患者受入加算の算定には、紹介状による紹介を受け'), L(2, 107, 'る必要があるか。'),
  L(2, 85, '（答）当該加算は、継続的な治療管理を行うため'), L(2, 109, '算定できる。'),
  L(2, 85, '【心不全再入院予防継続管理料】'),
  L(2, 83, '問６ 「Ｂ００１－10」心不全再入院予防継続管理料の施設基準に規定する'),
  L(2, 85, '（答）対面での開催を原則とする。'),
  L(2, 282, '医－2'),
  L(3, 436, '（別添２）'), L(3, 139, '看護職員処遇改善評価料及びベースアップ評価料関係'),
  L(3, 70, '【ベースアップ評価料】'), L(3, 69, '問１ 常勤換算数はどのように計算するのか。'), L(3, 70, '（答）非常勤職員の実労働時間で算出する。'),
  L(3, 262, '看ベ－1'),
  L(3, 436, '（別添３）'), L(3, 231, '調剤報酬点数表関係'), L(3, 85, '【調剤時残薬調整加算】'),
  L(3, 83, '問３ 「区分10 の２」調剤管理料の「注３」の調剤時残薬調整加算について'), L(3, 85, '（答）算定できる。'),
] };

test('疑義解釈: 別添ごとの section、【】topic、問／答、区分番号参照', () => {
  const r = parseQA(doc, { doc: 'その12' });
  const v = validateQA(r);
  assert.equal(v.n, 4);
  assert.equal(v.no_answer, 0);
  assert.deepEqual(r.qas.map(q => q.no), ['問1', '問6', '問1', '問3']);
  assert.equal(r.qas[0].q, '特定機能病院等紹介患者受入加算の算定には、紹介状による紹介を受ける必要があるか。');
  assert.equal(r.qas[0].a, '当該加算は、継続的な治療管理を行うため算定できる。');
  assert.equal(r.qas[0].topic, '特定機能病院等紹介患者受入加算');
  assert.deepEqual(r.qas[1].codes, ['医:B001-10']);
  assert.equal(r.qas[2].section, '看護職員処遇改善評価料及びベースアップ評価料関係');
  assert.equal(r.qas[3].table, '調');
  assert.deepEqual(r.qas[3].codes, ['調:10-2']);
  assert.deepEqual(v.dup_no, []);
});

test('extractCodes: 点数表ごとの名前空間', () => {
  assert.deepEqual(extractCodes('「Ｍ０１７」ポンティック', '歯科診療報酬点数表関係'), ['歯:M017']);
  assert.deepEqual(extractCodes('区分番号06 の訪問看護', '訪問看護療養費関係'), ['訪:06']);
});
