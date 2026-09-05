'use strict';
// 施設基準（基本診療料・特掲診療料）の告示・通知 → 項目チャンク
//
// 告示（官報の縦書き。extract.js が列を再構成し、x に「列の先頭 y（字下げ量）」を入れている）:
//   x≈90   第三初・再診料の施設基準等             ← 節（漢数字）
//   x≈104  一の二医科初診料の特定妥結率初診料…の施設基準   ← 項目（漢数字、枝番は「の」）。番号と題名の間に空白なし
//   x≥118  本文
// 通知（横書き）:
//   x≈70   第１ 基本診療料の施設基準等 / 第２ 届出に関する手続き …（本文）、別添１〜 の中では
//   x<80   第１ 情報通信機器を用いた診療 / 第１の３ 機能強化加算 …  ← 項目（算用数字、枝番は「の」）
//   x≈80   １ 機能強化加算に関する施設基準  (1)  ア …

const KANJI = '〇一二三四五六七八九十百';
const KANJI_RE = new RegExp(`^[${KANJI}]+`);

function kanjiToInt(s) {
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch === '十') { cur = (cur || 1) * 10; total += cur; cur = 0; }
    else if (ch === '百') { cur = (cur || 1) * 100; total += cur; cur = 0; }
    else { const d = '〇一二三四五六七八九'.indexOf(ch); if (d < 0) return NaN; cur = d; }
  }
  return total + cur;
}
function toAscii(s) { return (s || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); }

// 縦書き告示の項目番号: 「一の二医科初診料…」→ { nos:[1,2], title }。「三一般病棟…」の誤読を避けるため、
// 直前の番号から見て妥当な番号（同じ深さで +1、枝番の開始、枝番 +1）になる最長の切り方を選ぶ。
function parseKanjiItem(text, prev) {
  const m = text.match(new RegExp(`^([${KANJI}]+(?:の[${KANJI}]+)*)`));
  if (!m) return null;
  const candidates = [];
  const full = m[1];
  // 候補: 末尾から漢数字を削って短くしたもの（「三一般」→「三一」「三」）
  for (let len = full.length; len >= 1; len--) {
    const head = full.slice(0, len);
    if (/の$/.test(head)) continue;
    const nos = head.split('の').map(kanjiToInt);
    if (nos.some(n => !Number.isFinite(n) || n === 0)) continue;
    candidates.push({ head, nos });
  }
  const plausible = c => {
    if (!prev) return c.nos.length === 1 && c.nos[0] === 1;
    const p = prev;
    if (c.nos.length === p.length && c.nos.slice(0, -1).every((n, i) => n === p[i]) && c.nos[c.nos.length - 1] === p[p.length - 1] + 1) return true; // 同じ深さで +1
    if (c.nos.length === p.length + 1 && c.nos.slice(0, -1).every((n, i) => n === p[i]) && c.nos[c.nos.length - 1] === 2) return true; // 枝番の開始（一 → 一の二）
    if (c.nos.length < p.length && c.nos.slice(0, -1).every((n, i) => n === p[i]) && c.nos[c.nos.length - 1] === p[c.nos.length - 1] + 1) return true; // 枝番から親の次へ
    return false;
  };
  const pick = candidates.find(plausible) || null;
  if (!pick) return null;
  return { nos: pick.nos, no: pick.nos.join('-'), title: text.slice(pick.head.length).trim() };
}

const SEC_V_RE = new RegExp(`^第([${KANJI}]+)(.*)$`);
const SEC_H_RE = /^第([０-９0-9]+)(?:[\s　]*の[\s　]*([０-９0-9]+))?[\s　]+(.+)$/;
const BESSHI_RE = /^別添([０-９0-9]+)[\s　]*(.*)$/;

/**
 * @param {object} textJson data/text/<fid>.json
 * @param {'kokuji'|'tsuchi'} kind
 */
function buildShisetsu(textJson, kind) {
  const lines = textJson.lines;
  const chunks = [];
  const sections = [];
  let sec = null;   // 現在の節（告示: 第三…／通知: 別添N）
  let cur = null, prevNos = null;

  function close(endIdx) {
    if (!cur) return;
    cur.line_end = endIdx; cur.p_end = lines[endIdx].p;
    cur.text = lines.slice(cur.line_start, endIdx + 1).map(l => l.text).join('\n');
    chunks.push(cur); cur = null;
  }
  function open(i, fields) {
    close(i - 1);
    cur = { id: null, kind: 'shisetsu', ...fields, path: sec ? [sec.title] : [], p_start: lines[i].p, line_start: i };
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; const t = l.text.trim();
    if (kind === 'kokuji') {
      if (!l.v) continue; // 縦書き以外（表紙等）は無視
      if (l.x <= 96) {
        const m = t.match(SEC_V_RE);
        if (m && kanjiToInt(m[1]) > 0) { close(i - 1); sec = { no: kanjiToInt(m[1]), title: `第${m[1]} ${m[2].trim()}`.trim(), p: l.p, line: i }; sections.push(sec); prevNos = null; continue; }
      }
      if (l.x > 96 && l.x <= 110 && sec) {
        const it = parseKanjiItem(t, prevNos);
        if (it) { open(i, { no: `${sec.no}-${it.no}`, no_raw: t.slice(0, t.length - it.title.length), title: it.title }); prevNos = it.nos; continue; }
      }
    } else {
      if (l.x < 80) {
        const bm = t.match(BESSHI_RE);
        if (bm) { close(i - 1); sec = { no: Number(toAscii(bm[1])), title: `別添${toAscii(bm[1])} ${bm[2]}`.trim(), p: l.p, line: i }; sections.push(sec); continue; }
        const m = t.match(SEC_H_RE);
        if (m && t.length <= 60 && !/[、。]/.test(m[3])) {
          const no = toAscii(m[1]) + (m[2] ? '-' + toAscii(m[2]) : '');
          open(i, { no: sec ? `${sec.no}/${no}` : no, no_raw: t.slice(0, t.indexOf(m[3])).trim(), title: m[3].trim() });
          continue;
        }
      }
    }
  }
  close(lines.length - 1);
  // 別添の題（次行に置かれることがある）: 「別添１」だけの行の直後の行を題にする
  for (const s of sections) if (/^別添[0-9]+$/.test(s.title) && lines[s.line + 1]) s.title += ' ' + lines[s.line + 1].text.trim();
  for (const c of chunks) if (c.path.length && /^別添[0-9]+$/.test(c.path[0])) { const s = sections.find(x => x.title.startsWith(c.path[0] + ' ')); if (s) c.path = [s.title]; }
  chunks.forEach((c, k) => { c.id = `${textJson.fid}:${k}`; });
  return { fid: textJson.fid, kind, pages: textJson.pages, sections, chunks };
}

// 項目の題から「施設基準の名称」を取り出す（告示「医科初診料の機能強化加算の施設基準」→「機能強化加算」に近づける）
function baseName(title) {
  return (title || '')
    .replace(/[\s　]+/g, '')
    .replace(/(の|に関する|に係る)?(施設基準|基準|届出|要件)(等)?$/, '')
    .replace(/(の|に関する|に係る)?(施設基準|基準)(等)?$/, '');
}

module.exports = { buildShisetsu, parseKanjiItem, kanjiToInt, baseName };
