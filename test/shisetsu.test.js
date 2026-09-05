'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildShisetsu, parseKanjiItem, kanjiToInt } = require('../lib/shisetsu');

test('漢数字', () => {
  assert.equal(kanjiToInt('三'), 3); assert.equal(kanjiToInt('十'), 10); assert.equal(kanjiToInt('十一'), 11); assert.equal(kanjiToInt('二十三'), 23); assert.equal(kanjiToInt('百二'), 102);
});

test('縦書き告示の項目番号: 「一般病棟」を「一」+「般病棟」と誤読しない', () => {
  assert.deepEqual(parseKanjiItem('一保険医療機関は', null), { nos: [1], no: '1', title: '保険医療機関は' });
  assert.deepEqual(parseKanjiItem('一の二医科初診料の', [1]), { nos: [1, 2], no: '1-2', title: '医科初診料の' });
  assert.deepEqual(parseKanjiItem('二一般病棟入院基本料の施設基準', [1, 2]), { nos: [2], no: '2', title: '一般病棟入院基本料の施設基準' });
  assert.equal(parseKanjiItem('一般病棟の患者', [2]), null); // 番号としてあり得ない（3 ではない）
  assert.deepEqual(parseKanjiItem('三の八削除', [3, 7]), { nos: [3, 8], no: '3-8', title: '削除' });
});

function V(p, top, text) { return { p, x: top, y: 500, w: 100, h: 14, size: null, text, v: true }; }
function H(p, x, text) { return { p, x, y: 0, w: 100, h: 9, size: 9, text }; }

test('告示（縦書き）: 第X 節と 一/一の二 項目', () => {
  const doc = { fid: 'k', pages: 1, lines: [
    H(1, 70, '表紙の横書き行'),
    V(1, 90, '第一届出の通則'), V(1, 104, '一保険医療機関は、届出を行わなければならないこと。'), V(1, 104, '二届出の内容の変更'),
    V(1, 90, '第三初・再診料の施設基準等'), V(1, 104, '一医科初診料の注７の時間外加算等に係る時間'), V(1, 118, '当該地域において'),
    V(1, 104, '一の二医科初診料の特定妥結率初診料の施設基準'), V(1, 132, '次のいずれかに該当する保険医療機関であること。'),
    V(1, 104, '二一般病棟入院基本料の施設基準'),
  ] };
  const st = buildShisetsu(doc, 'kokuji');
  assert.deepEqual(st.sections.map(s => s.title), ['第一 届出の通則', '第三 初・再診料の施設基準等']);
  assert.deepEqual(st.chunks.map(c => c.no), ['1-1', '1-2', '3-1', '3-1-2', '3-2']);
  assert.equal(st.chunks[3].title, '医科初診料の特定妥結率初診料の施設基準');
  assert.match(st.chunks[3].text, /次のいずれかに該当/);
  assert.deepEqual(st.chunks[3].path, ['第三 初・再診料の施設基準等']);
});

test('通知（横書き）: 別添と 第１の３ 項目', () => {
  const doc = { fid: 't', pages: 2, lines: [
    H(1, 70, '第１ 基本診療料の施設基準等'), H(1, 80, '１ 初・再診料の施設基準等は別添１のとおりとすること。'),
    H(2, 70, '別添１'), H(2, 200, '初・再診料の施設基準等'),
    H(2, 70, '第１ 情報通信機器を用いた診療'), H(2, 80, '１ 情報通信機器を用いた診療に係る施設基準'), H(2, 90, '(1) 厚生労働省の定める'),
    H(2, 70, '第１の３ 機能強化加算'), H(2, 80, '１ 機能強化加算に関する施設基準'),
    H(2, 90, '第２章第１部の各項目に掲げる、算定できない。'), // 本文（見出しではない）
  ] };
  const st = buildShisetsu(doc, 'tsuchi');
  assert.equal(st.sections[0].title, '別添1 初・再診料の施設基準等');
  const items = st.chunks.filter(c => c.path.length);
  assert.deepEqual(items.map(c => c.no), ['1/1', '1/1-3']);
  assert.equal(items[1].title, '機能強化加算');
  assert.deepEqual(items[1].path, ['別添1 初・再診料の施設基準等']);
  assert.match(items[1].text, /算定できない/);
});

test('baseName: 題から施設基準の名称を取り出す', () => {
  const { baseName } = require('../lib/shisetsu');
  assert.equal(baseName('機能強化加算に関する施設基準'), '機能強化加算');
  assert.equal(baseName('一般病棟入院基本料の施設基準等'), '一般病棟入院基本料');
  assert.equal(baseName('機能強化加算'), '機能強化加算');
  assert.equal(baseName('医科初診料の特定妥結率初診料の施設基準'), '医科初診料の特定妥結率初診料');
});
