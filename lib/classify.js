'use strict';
// リンクレコードに category / watch を付与する。config.rules を上から順に評価し最初に一致した規則を採用。
// 一致しないものは "other:<h3>" として保存対象に含める（監視通知の対象外）。

function compile(rules) {
  return rules.map(r => ({
    ...r,
    _aname: r.aname ? new RegExp(r.aname) : null,
    _label: r.label ? new RegExp(r.label) : null,
    _h2: r.h2 ? new RegExp(r.h2) : null,
    _h3: r.h3 ? new RegExp(r.h3) : null,
    _note: r.note ? new RegExp(r.note) : null,
  }));
}

function classify(link, compiledRules) {
  for (const r of compiledRules) {
    if (r._aname && !r._aname.test(link.aname)) continue;
    if (r._label && !r._label.test(link.label)) continue;
    if (r._h2 && !r._h2.test(link.h2)) continue;
    if (r._h3 && !r._h3.test(link.h3)) continue;
    if (r._note && !r._note.test(link.note)) continue;
    if (r.ext && r.ext !== link.ext) continue;
    return { category: r.id, watch: !!r.watch, desc: r.desc || r.id };
  }
  const h = (link.h3 || link.h2 || '').replace(/^[0-9０-９]+[．.]\s*/, '').slice(0, 30);
  return { category: 'other:' + (h || 'unclassified'), watch: false, desc: h || '未分類' };
}

module.exports = { compile, classify };
