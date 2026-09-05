'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStructure, validate, CODE_HEAD_RE, parseCodeList, normCode } = require('../lib/structure');

// 実際の告示 PDF から観測したレイアウト（x 座標）を模した最小フィクスチャ
function L(p, x, text) { return { p, x, y: 0, w: 100, h: 9, size: 9, text }; }
const kokuji = { fid: 'test', pages: 3, lines: [
  L(1, 74, '別表第一'), L(1, 106, '医科診療報酬点数表'), L(1, 85, '［目次］'),
  L(1, 85, '第１章 基本診療料'), L(1, 96, '第１部 初・再診料'), L(1, 106, '第１節 初診料'),
  L(1, 85, '第２章 特掲診療料'), L(1, 96, '第１部 医学管理等'),
  L(2, 127, '第１章 基本診療料'),
  L(2, 137, '第１部 初・再診料'), L(2, 85, '通則'), L(2, 95, '１ 健康保険法…'),
  L(2, 148, '第１節 初診料'), L(2, 85, '区分'),
  L(2, 85, 'Ａ０００ 初診料 291点'), L(2, 148, '注１ 保険医療機関において初診を行った場合に算定する。'),
  L(2, 169, '区分番号Ａ３０１に掲げる特定集中治療室管理料の注２に規定する'), // 本文中の参照（字下げ）
  L(2, 85, 'Ａ００１ 再診料 75点'),
  L(2, 169, '第６部注射、第７部リハビリテーション（別に厚生労働大臣が定めるものに限る'), // 本文文
  L(3, 127, '第２章 特掲診療料'), L(3, 137, '第１部 医学管理等'),
  L(3, 85, 'Ｂ００１ 特定疾患治療管理料'), L(3, 148, '１ ウイルス疾患指導料'),
  L(3, 85, 'Ｂ００１－２ 小児科外来診療料（１日につき）'),
  L(3, 85, 'Ｂ００１－２－10 削除'),
  L(3, 85, 'Ｂ００５－10－２ ハイリスク妊産婦連携指導料２ 750点'),
  L(3, 85, 'Ａ２０１からＡ２０３まで 削除'),
  L(3, 85, 'Ｋ００３、Ｋ００４ 皮膚、皮下、粘膜下血管腫摘出術'),
  L(3, 85, 'Ｂ００１－２―２ 口腔機能実地指導料 46点'),
  L(3, 85, 'Ｎ０１２－２スライディングプレート'),
  L(3, 85, 'Ｉ００８に掲げる根管充填及びＩ００８－２に掲げる加圧根管充填処置'), // 通知本文（見出しではない）
] };

test('目次を飛ばし、本文の章/部/節と通則・区分番号チャンクを組み立てる', () => {
  const st = buildStructure(kokuji);
  const v = validate(st);
  assert.deepEqual(st.sections.map(s => s.title), ['第1章 基本診療料', '第1部 初・再診料', '第1節 初診料', '第2章 特掲診療料', '第1部 医学管理等']);
  assert.equal(v.n_tsusoku, 1);
  assert.deepEqual(v.duplicates, []);
  const codes = st.chunks.filter(c => c.kind === 'kubun').map(c => c.code);
  assert.deepEqual(codes, ['A000', 'A001', 'B001', 'B001-2', 'B001-2-10', 'B005-10-2', 'A201', 'K003', 'B001-2-2', 'N012-2']);
  const a000 = st.chunks.find(c => c.code === 'A000');
  assert.deepEqual(a000.path, ['第1章 基本診療料', '第1部 初・再診料', '第1節 初診料']);
  assert.equal(a000.title, '初診料 291点');
  assert.match(a000.text, /区分番号Ａ３０１に掲げる/); // 参照行は本文として A000 に含まれる
  assert.equal(st.chunks.find(c => c.code === 'A201').range.to, 'A203');
  assert.deepEqual(st.chunks.find(c => c.code === 'K003').codes, ['K003', 'K004']);
  assert.equal(st.chunks.find(c => c.code === 'N012-2').title, 'スライディングプレート');
});

test('調剤点数表（英字なし2桁）は数字コードを区分として扱う', () => {
  const chozai = { fid: 't2', pages: 1, lines: [
    L(1, 74, '別表第三'), L(1, 85, '［目次］'), L(1, 106, '第１節 調剤技術料'),
    L(1, 85, '通則'), L(1, 95, '１ 投薬の費用は…'),
    L(1, 148, '第１節 調剤技術料'), L(1, 85, '区分'),
    L(1, 85, '００ 調剤基本料（処方箋の受付１回につき）'), L(1, 148, '１ 調剤基本料１ 47点'),
    L(1, 85, '１０－２ 調剤管理料'),
  ] };
  const st = buildStructure(chozai);
  assert.deepEqual(st.chunks.map(c => c.code), [null, '00', '10-2']);
  assert.deepEqual(st.chunks[1].path, ['第1節 調剤技術料']);
});

test('英字コードがある文書では数字だけの行を区分とみなさない', () => {
  const doc = { fid: 't3', pages: 1, lines: [
    L(1, 56, '＜通則＞'), L(1, 67, '１０ 入院期間の…'), L(1, 77, 'Ａ０００ 初診料'), L(1, 88, '１０ 何かの項番'),
  ] };
  const st = buildStructure(doc);
  assert.deepEqual(st.chunks.map(c => c.kind), ['tsusoku', 'kubun']);
});

test('区分番号の正規化', () => {
  assert.equal(normCode('Ａ３０３の２'), 'A303-2');
  assert.equal(normCode('Ｄ００６－27'), 'D006-27');
  assert.equal(parseCodeList('Ａ２１６及びＡ２１７').codes.join(','), 'A216,A217');
  assert.equal(CODE_HEAD_RE.test('Ｍ０２０に掲げる鋳造鉤'), false);
});

test('調剤の通知: 「区分００」前置と「＜調剤技術料＞」見出し', () => {
  const doc = { fid: 't4', pages: 1, lines: [
    L(1, 56, '＜通則＞'), L(1, 90, '12 区分番号は、例えば「区分００」調剤基本料における…'),
    L(1, 80, '＜調剤技術料＞'), L(1, 90, '区分００ 調剤基本料'), L(1, 101, '１ 受付回数等'),
    L(1, 90, '区分１０－２ 調剤管理料'),
  ] };
  const st = buildStructure(doc);
  assert.deepEqual(st.chunks.map(c => c.code), [null, '00', '10-2']);
  assert.deepEqual(st.chunks[2].path, ['調剤技術料']);
});
