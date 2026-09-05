'use strict';
// 疑義解釈資料（事務連絡）の座標付きテキスト → 問／答レコード
//
// レイアウト（実測）:
//   x≈231  「医科診療報酬点数表関係」「歯科診療報酬点数表関係」「調剤報酬点数表関係」「訪問看護療養費関係」（別添の区切り）
//   x≈282  「医－1」「歯－3」「調－2」「訪看－1」（ページラベル。除去）
//   x≈85   【心不全再入院予防継続管理料】（話題見出し）
//   x≈83   問６ …（質問。続き行は x≈107）
//   x≈85   （答）…（回答。続き行は x≈109）
// 表紙（事務連絡の鑑）は最初の「…関係」見出し or 最初の【】/問 が出るまで読み飛ばす。

const { normCode, toAscii } = require('./structure');

// 別添の題（「医科診療報酬点数表関係」「看護職員処遇改善評価料及びベースアップ評価料関係」など）。
// 「（別添N）」の直後の行、または「…関係」で終わる中央寄せの短い行。
const SECTION_RE = /^.{1,40}関係$/;
// ページラベル: 医－1 / 歯－3 / 調－2 / 訪看－1 / 看ベ－4 / DPC－12 / 施－5 …
const PAGE_LABEL_RE = /^[^\s　]{1,4}[\s　]*[－‐―-][\s　]*[０-９0-9]+$/;
const TOPIC_RE = /^【(.+)】$/;
const Q_RE = /^問[\s　]*([０-９0-9]+)[\s　]*(.*)$/;
const A_RE = /^[（(]答[)）][\s　]*(.*)$/;
const BESSHI_RE = /^[（(]?別添[０-９0-9]+[)）]?$/;

// 本文中の区分番号参照:
//   医科・歯科: 「Ｂ００１－10」「Ａ０００」（「」囲みが多いが囲みなしも拾う）
//   調剤:      「区分10 の２」「区分00」   訪問看護: 「区分番号06」
// 点数表ごとの名前空間を付けて返す（医:A000 / 歯:A000 / 調:10-2 / 訪:06）。
const LETTER_CODE_RE = /[Ａ-Ｚ][０-９]{3}(?:(?:[－‐―-]|の)[０-９0-9]+)*/g;
const NUM_CODE_RE = /区分(?:番号)?[\s　]*[「]?([０-９0-9]{2}(?:[\s　]*(?:[－‐―-]|の)[\s　]*[０-９0-9]+)*)/g;

function tableOf(section) {
  const s = section || '';
  if (/歯科/.test(s)) return '歯';
  if (/調剤/.test(s)) return '調';
  if (/訪問看護/.test(s)) return '訪';
  return '医';
}

function extractCodes(text, section) {
  const table = tableOf(section);
  const set = new Set();
  for (const m of text.match(LETTER_CODE_RE) || []) set.add(`${table === '歯' ? '歯' : '医'}:${normCode(m)}`);
  for (const m of text.matchAll(NUM_CODE_RE)) set.add(`${table === '訪' ? '訪' : '調'}:${normCode(m[1].replace(/[\s　]/g, ''))}`);
  return [...set];
}

function parseQA(textJson, meta = {}) {
  const lines = textJson.lines;
  const qas = [];
  let section = null, topic = null;
  let cur = null; // { no, q:[], a:[], mode:'q'|'a', p_start, p_end }
  let started = false;
  let afterBesshi = false; // 直前が「（別添N）」行

  function flush() {
    if (!cur) return;
    const q = cur.q.join('').replace(/\s+/g, ' ').trim();
    const a = cur.a.join('').replace(/\s+/g, ' ').trim();
    qas.push({
      id: `${textJson.fid}:q${qas.length + 1}`, fid: textJson.fid, doc: meta.doc || null,
      section, table: tableOf(section), topic, no: cur.no, q, a,
      codes: extractCodes(topic ? topic + ' ' + q + ' ' + a : q + ' ' + a, section),
      p_start: cur.p_start, p_end: cur.p_end,
    });
    cur = null;
  }

  for (const l of lines) {
    const t = l.text.trim();
    if (!t) continue;
    if (BESSHI_RE.test(t)) { afterBesshi = true; continue; }
    if (PAGE_LABEL_RE.test(t) && l.x > 200) continue;
    const isSection = (afterBesshi && !TOPIC_RE.test(t) && !Q_RE.test(t) && t.length <= 40 && !/[、。]/.test(t) && l.x > 100)
      || (SECTION_RE.test(t) && l.x > 120 && !/[、。]/.test(t));
    afterBesshi = false;
    if (isSection) { flush(); section = t; topic = null; started = true; continue; }
    const tm = t.match(TOPIC_RE);
    if (tm) { flush(); topic = tm[1].trim(); started = true; continue; }
    const qm = t.match(Q_RE);
    if (qm && l.x < 100 && started) { // 表紙の「問15 及び問143 について…訂正します」を拾わないよう、見出し後に限る
      flush(); started = true;
      cur = { no: '問' + toAscii(qm[1]), q: [qm[2]], a: [], mode: 'q', p_start: l.p, p_end: l.p };
      continue;
    }
    if (!started) continue; // 表紙
    const am = t.match(A_RE);
    if (am && cur) { cur.mode = 'a'; cur.a.push(am[1]); cur.p_end = l.p; continue; }
    if (cur) { (cur.mode === 'q' ? cur.q : cur.a).push(t); cur.p_end = l.p; }
  }
  flush();
  return { fid: textJson.fid, doc: meta.doc || null, pages: textJson.pages, qas };
}

function validateQA(res) {
  const noAnswer = res.qas.filter(x => !x.a).length;
  // 問番号は別添（医科/歯科/調剤/訪問看護）ごとに 1 から振り直されるので、section と組で重複を見る
  const nos = res.qas.map(x => `${x.section || ''}|${x.no}`);
  const dup = nos.filter((n, i) => nos.indexOf(n) !== i);
  return { n: res.qas.length, no_answer: noAnswer, no_section: res.qas.filter(x => !x.section).length, no_topic: res.qas.filter(x => !x.topic).length, dup_no: [...new Set(dup)] };
}

module.exports = { parseQA, validateQA, extractCodes, tableOf };
