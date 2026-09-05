'use strict';
// 厚労省ページ HTML → リンクレコード配列
//
// ページ本文を「見出し / 改行 / テキスト / リンク」のトークン列に線形化し、
// 行単位で解釈する。各ファイルリンクについて次を得る:
//   h2, h3      : 所属する見出し
//   label       : 直前の「リンクを含まない行」のテキスト（例: 告示番号を示す項目名）
//   prefix      : 同じ行でリンクの前にあるテキスト（例: 「（別紙１）」）
//   aname       : アンカーテキスト（例: 「医科点数表［4.7MB］」）
//   note        : 同じ行でリンクの直後〜次のリンクまでのテキスト（例: 「（0730訂正後）」）
//   key         : 論理文書を同定するための安定キー（訂正ラベルやサイズ表記を除いて算出）

const crypto = require('crypto');
const cheerio = require('cheerio');

const FILE_RE = /\.(pdf|xlsx?|docx?|pptx?|zip|csv)(\?.*)?$/i;
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'ul', 'ol', 'tr', 'table', 'section', 'article']);
const HEADING_RE = /^h[1-6]$/;

// 訂正ラベル: （0730訂正後）（0402訂正反映後）など
const REVISION_RE = /[（(]\s*\d{4}\s*訂正(反映)?後\s*[)）]/g;
// サイズ表記: ［4.5MB］[738KB]
const SIZE_RE = /[［\[]\s*[\d.,]+\s*(KB|MB|GB|B)\s*[］\]]/gi;

function normText(s) {
  return (s || '')
    .replace(/[​ ]/g, ' ')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

// キー算出用の正規化: 訂正ラベル・サイズ・箇条書き記号・空白を除去
function normForKey(s) {
  return normText(s)
    .replace(REVISION_RE, '')
    .replace(SIZE_RE, '')
    .replace(/[・･➢➡■□●○※・]/g, '')
    .replace(/[\s　]+/g, '')
    .trim();
}

function extractRevision(s) {
  const m = (s || '').match(/[（(]\s*(\d{4})\s*訂正(反映)?後\s*[)）]/);
  return m ? m[1] : null;
}

// リンク間テキストを「前のリンクの注記」と「次のリンクの前置き」に分割する。
// 注記とみなすもの: （0730訂正後）（令和８年４月15日更新）（令和８年４月20日保険局医療課事務連絡）（再掲）
//                  （別添３（調剤関係）追加） ※前回掲載データの一部修正 など、先頭から連続する括弧書き/※書き。
// 「（別紙１）」のような単なる見出しは注記ではなく次のリンクの前置きとする。
const NOTE_WORD_RE = /訂正|更新|事務連絡|再掲|追加|反映|修正|周知|令和|版/;
function splitNote(s) {
  let rest = normText(s);
  const notes = [];
  for (;;) {
    let m = rest.match(/^[（(]((?:[^（()）]|[（(][^（()）]*[)）])*)[)）]\s*/);
    if (m && NOTE_WORD_RE.test(m[1])) { notes.push(m[0].trim()); rest = rest.slice(m[0].length); continue; }
    m = rest.match(/^※[^（(]*?(?=\s*[（(]|$)/);
    if (m && m[0].length > 1) { notes.push(m[0].trim()); rest = rest.slice(m[0].length).trim(); continue; }
    break;
  }
  return { note: notes.join(''), rest: normText(rest) };
}

function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// DOM を線形トークン列に変換
function tokenize($, root) {
  const tokens = [];
  function walk(node) {
    for (const child of node.children || []) {
      if (child.type === 'text') {
        tokens.push({ t: 'text', s: child.data });
      } else if (child.type === 'tag') {
        const name = child.name.toLowerCase();
        if (name === 'script' || name === 'style' || name === 'noscript') continue;
        if (HEADING_RE.test(name)) {
          tokens.push({ t: 'heading', level: Number(name[1]), s: normText($(child).text()) });
          continue;
        }
        if (name === 'br') { tokens.push({ t: 'br' }); continue; }
        if (name === 'a' && child.attribs && child.attribs.href) {
          tokens.push({ t: 'link', href: child.attribs.href, s: normText($(child).text()) });
          continue;
        }
        if (BLOCK_TAGS.has(name)) tokens.push({ t: 'br' });
        walk(child);
        if (BLOCK_TAGS.has(name)) tokens.push({ t: 'br' });
      }
    }
  }
  walk(root);
  return tokens;
}

function isFileHref(href) {
  return FILE_RE.test((href || '').split('#')[0]);
}

function extOf(href) {
  const m = (href || '').split('#')[0].match(FILE_RE);
  return m ? m[1].toLowerCase() : '';
}

/**
 * @param {string} html ページ全体のHTML
 * @param {object} opts { baseUrl, contentSelector }
 * @returns {{ links: object[], contentHtml: string, headings: string[] }}
 */
function parsePage(html, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://www.mhlw.go.jp/';
  const $ = cheerio.load(html, { decodeEntities: true });
  let root = $(opts.contentSelector || 'main').first();
  if (!root.length) root = $('body').first();
  const contentHtml = $.html(root);

  const tokens = tokenize($, root.get(0));

  let h2 = '', h3 = '';
  let label = '';
  let line = [];
  const links = [];
  const headings = [];
  const keyCount = new Map();

  function flushLine() {
    if (!line.length) { return; }
    const hasLink = line.some(tk => tk.t === 'link' && isFileHref(tk.href));
    const lineText = normText(line.map(tk => tk.t === 'text' ? tk.s : (tk.t === 'link' ? tk.s : '')).join(''));
    if (!hasLink) {
      if (lineText && lineText.replace(/[・\s　]/g, '')) label = lineText;
      line = [];
      return;
    }
    // 行を「リンク」と「リンク間テキスト（span）」に分ける。
    // リンク間テキストは、先頭の注記部分（訂正後/更新/事務連絡/再掲 など）を前のリンクの note に、
    // 残りを次のリンクの prefix に振り分ける。
    const segs = []; // {link, pre:string}
    let cur = { link: null, pre: [] };
    for (const tk of line) {
      if (tk.t === 'link' && isFileHref(tk.href)) { segs.push({ link: tk, pre: normText(cur.pre.join('')) }); cur = { link: tk, pre: [] }; }
      else cur.pre.push(tk.s);
    }
    const tail = normText(cur.pre.join(''));
    for (let i = 0; i < segs.length; i++) {
      const tk = segs[i].link;
      const prefixRaw = segs[i].pre;
      const between = i + 1 < segs.length ? segs[i + 1].pre : tail;
      const note = splitNote(between).note;
      const prefix = i === 0 ? prefixRaw : splitNote(prefixRaw).rest;
      const url = new URL(tk.href, baseUrl).href;
      const keySrc = [normForKey(h2), normForKey(h3), normForKey(label), normForKey(prefix), normForKey(tk.s), normForKey(note)].join('|');
      let key = sha1(keySrc).slice(0, 16);
      const n = (keyCount.get(key) || 0) + 1; keyCount.set(key, n);
      if (n > 1) key = sha1(keySrc + '#' + n).slice(0, 16);
      links.push({
        key, url, ext: extOf(tk.href),
        aname: tk.s, note, prefix, label, h2, h3,
        revision: extractRevision(note) || extractRevision(tk.s) || extractRevision(label),
        ordinal: n,
      });
    }
    line = [];
  }

  for (const tk of tokens) {
    if (tk.t === 'heading') {
      flushLine();
      if (tk.level <= 2) { h2 = tk.s; h3 = ''; label = ''; }
      else if (tk.level === 3) { h3 = tk.s; label = ''; }
      else { label = tk.s; }
      headings.push(`${'#'.repeat(tk.level)} ${tk.s}`);
    } else if (tk.t === 'br') {
      flushLine();
    } else {
      line.push(tk);
    }
  }
  flushLine();

  // 正規化本文: 厚労省はミラーごとに HTML の細部（<?ra ?> 処理命令・コメント・&nbsp; と &#160; など）が
  // 異なるため、マークアップではなく「本文テキスト + リンクの href」でページ同一性を判定する。
  const canonical = normText(root.text()) + '\n' + links.map(l => l.url).join('\n');
  return { links, contentHtml, headings, canonical };
}

module.exports = { parsePage, normText, normForKey, extractRevision, REVISION_RE, SIZE_RE };
