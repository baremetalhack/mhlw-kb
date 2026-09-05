'use strict';
// 訂正事務連絡「令和８年度診療報酬改定関連通知及び官報掲載事項の一部訂正について」 → 訂正レコード
//
// 構造（実測）:
//   表紙: 「・「＜対象通知の題＞」（令和８年３月５日保医発0305 第６号）（別添N）」の列挙
//   本文: ページ右上の「（別添N）」で区切られ、対象通知と同じ見出し構造（章/部/節/区分番号、第１の３ …）の下に
//         訂正後の該当箇所だけが載る（「（中略）」「Ａ → Ｂ」矢印つきの箇所もある）。
//   留意事項通知（保医発0305第６号）の別添の中には、さらに「別添１ 医科…」「別添２ 歯科…」「別添３ 調剤…」の内側区切りがある。
//
// 出力: { fid, date, targets, records:[{ id, date, besshi, target, tbl, kind, code, title, text, p_start, p_end }] }
//   kind: 'kubun'（区分番号 → code 医:A104 など） / 'shisetsu'（施設基準項目 → code 施:機能強化加算） / 'other'

const { buildStructure } = require('./structure');
const { buildShisetsu, baseName } = require('./shisetsu');
const { norm } = require('./db');

const toAscii = s => (s || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
const OUTER_RE = /^[（(]別添([０-９0-9]+)[)）]$/;
const INNER_RE = /^別添([０-９0-9]+)$/;

function reiwaToIso(s) {
  const m = (s || '').match(/令和\s*([０-９0-9]+)\s*年\s*([０-９0-9]+)\s*月\s*([０-９0-9]+)\s*日/);
  if (!m) return null;
  const [y, mo, d] = [m[1], m[2], m[3]].map(x => Number(toAscii(x)));
  return `${2018 + y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 表紙の「・「題」（…）（別添N）」を読む
function parseCover(lines, endIdx) {
  const text = lines.slice(0, endIdx).map(l => l.text.trim()).join('\n');
  const targets = [];
  for (const seg of text.split(/\n?・「/).slice(1)) {
    const m = seg.match(/（別添([０-９0-9]+)）/);
    if (!m) continue;
    const head = seg.slice(0, m.index);
    const title = head.replace(/\n/g, '').replace(/（令和[^）]*）\s*$/, '').replace(/」\s*$/, '').trim();
    const ref = (head.match(/（(令和[^）]*)）\s*$/) || [])[1] || '';
    targets.push({ n: Number(toAscii(m[1])), title, ref });
  }
  return targets;
}

function tableOfInner(title) {
  if (/歯科/.test(title)) return '歯';
  if (/調剤/.test(title)) return '調';
  if (/医科/.test(title)) return '医';
  return null;
}

function parseTeisei(textJson) {
  const lines = textJson.lines;
  const date = reiwaToIso(lines.filter(l => l.p === 1).map(l => l.text).join(' '));
  // 外側の別添区切り（右上の（別添N））
  const marks = [];
  lines.forEach((l, i) => { const m = l.text.trim().match(OUTER_RE); if (m && l.x > 300) marks.push({ n: Number(toAscii(m[1])), i }); });
  const ranges = [];
  for (const m of marks) {
    const last = ranges[ranges.length - 1];
    if (last && last.n === m.n) continue; // 同じ別添が複数ページに続く
    if (last) last.end = m.i;
    ranges.push({ n: m.n, start: m.i, end: lines.length });
  }
  const targets = parseCover(lines, marks.length ? marks[0].i : Math.min(lines.length, 120));
  // 表紙で拾えなかった別添は、別添ページ冒頭の題（x>100 の行が続く部分）を使う
  const targetOf = (n, start) => {
    const t = targets.find(t => t.n === n);
    if (t) return t;
    const head = [];
    for (let i = start + 1; i < Math.min(lines.length, start + 6); i++) { const l = lines[i]; if (l.x < 100) break; head.push(l.text.trim()); }
    const title = head.join('').replace(/（令和[^）]*）\s*$/, '').trim();
    return { n, title: title || `別添${n}`, ref: (head.join('').match(/（(令和[^）]*)）/) || [])[1] || '' };
  };

  const records = [];
  const push = r => { records.push({ id: `${textJson.fid}:t${records.length + 1}`, fid: textJson.fid, date, ...r }); };

  for (const rg of ranges) {
    const target = targetOf(rg.n, rg.start);
    const sub = lines.slice(rg.start + 1, rg.end);
    const meta = { besshi: rg.n, target: target.title, target_ref: target.ref };
    if (/留意事項/.test(target.title) && /算定方法/.test(target.title)) {
      // 内側の 別添１ 医科 / 別添２ 歯科 / 別添３ 調剤 で分ける
      const inner = [];
      sub.forEach((l, i) => { if (INNER_RE.test(l.text.trim()) && l.x < 100) inner.push({ i, tbl: tableOfInner((sub[i + 1] || {}).text || '') }); });
      const parts = inner.length ? inner.map((x, k) => ({ tbl: x.tbl, lines: sub.slice(x.i, k + 1 < inner.length ? inner[k + 1].i : sub.length) })) : [{ tbl: '医', lines: sub }];
      for (const part of parts) {
        if (!part.tbl) continue;
        const st = buildStructure({ fid: textJson.fid, pages: textJson.pages, lines: part.lines }, { headX: 92 });
        for (const c of st.chunks) {
          if (c.kind !== 'kubun') continue;
          push({ ...meta, tbl: part.tbl, kind: 'kubun', code: `${part.tbl}:${c.code}`, title: c.title, text: c.text, p_start: c.p_start, p_end: c.p_end });
        }
      }
    } else if (/(基本診療料|特掲診療料)の施設基準/.test(target.title)) {
      const tbl = /基本診療料/.test(target.title) ? '基本' : '特掲';
      const st = buildShisetsu({ fid: textJson.fid, pages: textJson.pages, lines: sub }, 'tsuchi');
      for (const c of st.chunks) {
        if (!c.path.length) { push({ ...meta, tbl, kind: 'other', code: null, title: c.title, text: c.text, p_start: c.p_start, p_end: c.p_end }); continue; }
        push({ ...meta, tbl, kind: 'shisetsu', code: `施:${norm(baseName(c.title))}`, title: c.title, text: c.text, p_start: c.p_start, p_end: c.p_end });
      }
    } else {
      const text = sub.map(l => l.text).join('\n');
      if (text.trim()) push({ ...meta, tbl: null, kind: 'other', code: null, title: target.title, text: text.slice(0, 20000), p_start: sub.length ? sub[0].p : null, p_end: sub.length ? sub[sub.length - 1].p : null });
    }
  }
  return { fid: textJson.fid, date, targets, records };
}

module.exports = { parseTeisei, parseCover, reiwaToIso };
