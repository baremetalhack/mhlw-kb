'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parsePage } = require('../lib/parse');
const { compile, classify } = require('../lib/classify');
const { diffObservations } = require('../lib/diff');

const html = fs.readFileSync(path.join(__dirname, 'fixtures/r8_excerpt.html'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));
const rules = compile(config.rules);
const BASE = 'https://www.mhlw.go.jp/stf/newpage_67729.html';

function parsed() {
  const { links } = parsePage(html, { baseUrl: BASE, contentSelector: 'main' });
  return links.map(l => ({ ...l, ...classify(l, rules) }));
}
const byUrl = (links, id) => links.find(l => l.url.endsWith(`/${id}`));

test('main 以外（ヘッダ・フッタ）のリンクは拾わない', () => {
  const links = parsed();
  assert.equal(links.filter(l => /00000000[12]\.pdf/.test(l.url)).length, 0);
  assert.equal(links.length, 41);
});

test('絶対URLに解決される', () => {
  const l = byUrl(parsed(), '001686842.pdf');
  assert.equal(l.url, 'https://www.mhlw.go.jp/content/12400000/001686842.pdf');
  assert.equal(l.ext, 'pdf');
});

test('告示版と通知版の医科点数表が別の key・別の category になる', () => {
  const links = parsed();
  const kokuji = byUrl(links, '001686842.pdf');
  const tsuchi = byUrl(links, '001732089.pdf');
  assert.equal(kokuji.category, 'ika_kokuji');
  assert.equal(tsuchi.category, 'ika_tsuchi');
  assert.notEqual(kokuji.key, tsuchi.key);
  assert.match(kokuji.label, /告示第69号/);
  assert.match(tsuchi.label, /留意事項について/);
  assert.equal(tsuchi.note, '（0730訂正後）');
  assert.equal(tsuchi.revision, '0730');
  assert.equal(kokuji.note, '');
});

test('6カテゴリの監視対象がすべて watch=true で拾える', () => {
  const links = parsed();
  const cats = new Set(links.filter(l => l.watch).map(l => l.category));
  for (const c of ['ika_kokuji', 'ika_tsuchi', 'shika_kokuji', 'shika_tsuchi', 'chozai_kokuji', 'chozai_tsuchi',
    'kihon_kokuji', 'kihon_tsuchi', 'tokkei_kokuji', 'tokkei_tsuchi', 'gigi', 'gigi_teisei', 'gigi_other', 'teisei_tsuchi']) {
    assert.ok(cats.has(c), `missing category ${c}`);
  }
  assert.equal(links.filter(l => l.category === 'gigi').length, 4);
  assert.equal(byUrl(links, '001689078.pdf').category, 'gigi_teisei');
  assert.equal(byUrl(links, '001706045.pdf').category, 'gigi_other');
});

test('別紙 Excel は施設基準の通知行の後でも分類され、注記を保持する', () => {
  const l = byUrl(parsed(), '001707255.xlsx');
  assert.equal(l.category, 'shisetsu_besshi');
  assert.equal(l.note, '（0529訂正後）');
  assert.equal(l.ext, 'xlsx');
});

test('汎用アンカー（PDF/Excel）は行頭ラベルを prefix に持ち key が衝突しない', () => {
  const links = parsed();
  const a = byUrl(links, '001667956.pdf'), b = byUrl(links, '001666872.pdf');
  assert.match(a.prefix, /別添１/);
  assert.match(b.prefix, /別添２/);
  assert.notEqual(a.key, b.key);
});

test('同一文言の DPC 電子点数表は更新日注記で区別される', () => {
  const links = parsed().filter(l => /電子点数表（正式版）/.test(l.aname));
  assert.equal(links.length, 3);
  assert.equal(new Set(links.map(l => l.key)).size, 3);
});

test('key は訂正ラベル・サイズ表記の変化に対して安定', () => {
  const v1 = parsed();
  const html2 = html
    .replace('医科点数表［4.7MB］</a>（0730訂正後）', '医科点数表［4.8MB］</a>（0915訂正後）')
    .replace('（令和８年３月５日保医発0305第６号）（0529訂正後）', '（令和８年３月５日保医発0305第６号）（0915訂正後）')
    .replace('001732089.pdf', '001799999.pdf');
  const v2 = parsePage(html2, { baseUrl: BASE }).links.map(l => ({ ...l, ...classify(l, rules) }));
  const a = byUrl(v1, '001732089.pdf'), b = byUrl(v2, '001799999.pdf');
  assert.equal(a.key, b.key);
  assert.equal(b.revision, '0915');
  // 同じ訂正で歯科通知の key も変わらない（ラベルの訂正表記のみ変化）
  assert.equal(byUrl(v1, '001707252.pdf').key, byUrl(v2, '001707252.pdf').key);
});

test('diff: 内容更新・新規・削除・注記変更を検出する', () => {
  const mk = (links, fidMap) => links.map(l => ({ ...l, fid: fidMap[l.url] || 'fid_' + l.url.slice(-13, -4) }));
  const v1 = parsed();
  const html2 = html
    .replace('医科点数表［4.7MB］</a>（0730訂正後）', '医科点数表［4.8MB］</a>（0915訂正後）')
    .replace('001732089.pdf', '001799999.pdf')
    .replace(/・<a data-icon="pdf" target="_blank" href="\/content\/12400000\/001678310.pdf">[^<]+<\/a><br>\s*/, '')
    .replace('（0619訂正後）<br>\n\t　　<a data-icon="pdf" target="_blank" href="/content/12400000/001713885.pdf">',
      '（0619訂正後）<br>\n\t・<a data-icon="pdf" target="_blank" href="/content/12400000/001800001.pdf">疑義解釈資料の送付について（その13）（令和８年９月15日保険局医療課事務連絡）［500KB］</a><br>\n\t　　<a data-icon="pdf" target="_blank" href="/content/12400000/001713885.pdf">');
  const v2 = parsePage(html2, { baseUrl: BASE }).links.map(l => ({ ...l, ...classify(l, rules) }));
  const prev = mk(v1, {});
  const curr = mk(v2, { 'https://www.mhlw.go.jp/content/12400000/001799999.pdf': 'fid_new_ika' });
  const ev = diffObservations(prev, curr);
  const types = Object.fromEntries(ev.map(e => [e.type, (e.curr || e.prev).aname]));
  assert.equal(ev.filter(e => e.type === 'content_changed').length, 1);
  assert.match(types.content_changed, /^医科点数表/);
  assert.equal(ev.filter(e => e.type === 'added').length, 1);
  assert.match(types.added, /その13/);
  assert.equal(ev.filter(e => e.type === 'removed').length, 1);
  assert.match(types.removed, /その１/);
  const cc = ev.find(e => e.type === 'content_changed');
  assert.deepEqual(cc.changes, ['content_changed', 'url_changed', 'text_changed']);
});

test('Apache ETag: ミラー間の mtime ずれ（<5s）は同一、サイズ違い・別日は別物', () => {
  const { Ledger } = require('../lib/ledger');
  assert.equal(Ledger.etagEquivalent('"473b7-6533f1f29a928"', '"473b7-6533f1f2bf356"'), true);   // 実測: 約150ms差
  assert.equal(Ledger.etagEquivalent('"473b7-6533f1f29a928"', '"473b8-6533f1f2bf356"'), false);  // size 違い
  assert.equal(Ledger.etagEquivalent('"473b7-6533f1f29a928"', '"473b7-6540f1f29a928"'), false);  // 別日
  assert.equal(Ledger.etagEquivalent('"abc"', '"473b7-6533f1f29a928"'), false);
});
