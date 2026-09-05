'use strict';
// 座標付きテキスト（data/text/<fid>.json）→ 点数表の構造（章/部/節/款 と 区分番号チャンク）
//
// 対象: 医科・歯科・調剤点数表の告示、および同 通知（留意事項）。
// 区分番号見出し（例「Ａ１００ 一般病棟入院基本料（１日につき）」）は、
//   - 行頭が 区分番号パターン（全角英字 + 全角数字3桁 [－n][のn]）
//   - 行の x が左端寄り（本文中の「区分番号Ａ３０１に掲げる…」という参照は字下げされているので除外）
// で判定する。見出しから次の見出しまでを1チャンクとし、章/部/節/款 の経路を付与する。

// 区分番号トークン: Ａ１００ / Ａ２０４－２ / Ｂ００１－２－２ / Ａ３０３の２ / Ｂ００５－１－３の２ …
// 枝番は 10 以上が半角数字で書かれる（Ｂ００５－10、Ｄ００６－27）ため両方を許容
// 調剤点数表は「００ 調剤基本料」「１５ 薬剤調製料」のように英字なし2桁
// 枝番の区切りは 全角ハイフン／半角／U+2015（歯科で混用）／「の」
const CODE_TOKEN = '(?:[Ａ-Ｚ][０-９]{3}|[０-９]{2})(?:(?:[－‐―-]|の)[０-９0-9]+)*';
// 見出しの区分番号部分: 単独 / 「ＡからＢまで」 / 「Ａ及びＢ」 / 「Ａ、Ｂ、Ｃ」 の並び
const CODE_LIST = `${CODE_TOKEN}(?:\\s*(?:、|及び|から)\\s*${CODE_TOKEN}(?:\\s*まで)?)*`;
// 題名との間の空白は稀に欠ける（「Ｎ０１２－２スライディングプレート」）ので任意にするが、
// 「Ｉ００８に掲げる…」のような本文文は題名の先頭文字で除外する
const CODE_HEAD_RE = new RegExp(`^(${CODE_LIST})(?:[\\s　]+(.*)|([^\\s　０-９0-9－‐―\\-の、にをはが及か].*))?$`);

// 見出しの区分番号部分を分解: { codes:[...], range:{from,to}|null }
function parseCodeList(head) {
  const toks = head.match(new RegExp(CODE_TOKEN, 'g')) || [];
  const codes = toks.map(normCode);
  const range = /から/.test(head) && codes.length === 2 ? { from: codes[0], to: codes[1] } : null;
  return { codes, range };
}
const SECTION_RE = /^第([０-９0-9]+)[\s　]*(章|部|節|款)[\s　]*(.*)$/; // 通知は「第10 部 手術」のように空白が入る
const TSUSOKU_RE = /^[＜<]?通則[＞>]?[\s　]*$/;

function toAscii(s) {
  return (s || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

// 「Ａ２０４－２」→ A204-2、「Ｂ００１－２－２」→ B001-2-2、「Ａ３０３の２」→ A303-2（raw は保持）
function normCode(token) {
  return toAscii(token).replace(/[－‐―]/g, '-').replace(/の/g, '-');
}

// 章/部/節/款 の見出しか（本文中の「第２部第２節入院基本料等加算、…に掲げる」のような文を除外）
function isSectionHeading(m, x, headX) {
  const title = m[3];
  // 本文中の部/節見出しは字下げ・中央寄せで x が大きいことがあるので x では判定しない
  return title.length <= 30 && !/[、。]|に掲げ|に規定|及び|の各区分|通則/.test(title);
}

/**
 * @param {object} textJson data/text/<fid>.json
 * @param {object} opts { headX: 区分番号見出しとみなす x の上限 (default 92) }
 */
function buildStructure(textJson, opts = {}) {
  const headX = opts.headX ?? 92;
  const lines = textJson.lines;
  const sections = [];
  const chunks = [];
  const pathState = { '章': null, '部': null, '節': null, '款': null };
  const order = ['章', '部', '節', '款'];
  let cur = null;
  // 冒頭の目次: 章/部/節/款 の見出しだけが並ぶ。最初に現れた「章」見出しと同じ題が再び現れた時点を本文開始とみなす。
  // 目次がある文書（告示）だけ: 冒頭数行に「目次」があれば目次モードで開始。
  let inToc = lines.slice(0, 8).some(l => /目次/.test(l.text));
  // 英字付き区分番号（Ａ０００…）が1つでもあれば、数字だけの「１０ …」は区分見出しとみなさない
  // （医科・歯科の通則の項番との混同を避ける。調剤点数表だけが「００ 調剤基本料」形式）
  const hasLetterCodes = lines.some(l => l.x <= headX && /^[Ａ-Ｚ][０-９]{3}/.test(l.text.trim()));
  const isCodeHead = (t) => { const m = t.match(CODE_HEAD_RE); return m && (!hasLetterCodes || /^[Ａ-Ｚ]/.test(m[1])) ? m : null; };
  let firstChapter = null;

  function closeChunk(endIdx) {
    if (!cur) return;
    cur.line_end = endIdx;
    cur.p_end = lines[endIdx].p;
    cur.text = lines.slice(cur.line_start, endIdx + 1).map(l => l.text).join('\n');
    chunks.push(cur);
    cur = null;
  }
  function currentPath() {
    return order.map(k => pathState[k]).filter(Boolean);
  }
  function openChunk(i, fields) {
    closeChunk(i - 1);
    cur = { id: null, ...fields, path: currentPath(), p_start: lines[i].p, line_start: i };
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.text.trim();
    if (inToc) {
      const sm0 = t.match(SECTION_RE);
      if (sm0 && sm0[2] === '章') {
        const no = toAscii(sm0[1]);
        if (firstChapter === null) { firstChapter = no; continue; }
        if (no === firstChapter) inToc = false; // 本文で第１章が再出現 → 本文開始（この行から通常処理）
        else continue;
      } else if (TSUSOKU_RE.test(t) || (l.x <= headX && isCodeHead(t))) {
        inToc = false; // 章見出しのない表（調剤）: 通則/区分番号の初出で本文開始
      } else continue; // 目次内（部/節/款 の行や表題）
    }

    const sm = t.match(SECTION_RE);
    if (sm && isSectionHeading(sm, l.x, headX)) {
      const level = sm[2];
      pathState[level] = `第${toAscii(sm[1])}${level} ${sm[3]}`.trim();
      for (const k of order.slice(order.indexOf(level) + 1)) pathState[k] = null;
      sections.push({ level, title: pathState[level], p: l.p, line: i });
      closeChunk(i - 1);
      continue;
    }
    if (TSUSOKU_RE.test(t) && l.x <= headX + 40) {
      openChunk(i, { kind: 'tsusoku', code: null, code_raw: null, title: '通則' });
      continue;
    }
    const cm = l.x <= headX ? isCodeHead(t) : null;
    if (cm) {
      const { codes, range } = parseCodeList(cm[1]);
      openChunk(i, { kind: 'kubun', code: codes[0], codes, code_raw: cm[1], title: (cm[2] || cm[3] || '').trim(), range });
      continue;
    }
  }
  closeChunk(lines.length - 1);

  chunks.forEach((c, k) => { c.id = `${textJson.fid}:${k}`; });
  return { fid: textJson.fid, pages: textJson.pages, sections, chunks };
}

// 検証用: 区分番号の重複・並び順の異常を報告
function validate(struct) {
  const codes = struct.chunks.filter(c => c.kind === 'kubun').map(c => c.code);
  const dup = codes.filter((c, i) => codes.indexOf(c) !== i);
  return { n_sections: struct.sections.length, n_chunks: struct.chunks.length, n_kubun: codes.length, n_tsusoku: struct.chunks.filter(c => c.kind === 'tsusoku').length, duplicates: [...new Set(dup)] };
}

module.exports = { buildStructure, validate, CODE_HEAD_RE, SECTION_RE, toAscii, normCode, parseCodeList };
