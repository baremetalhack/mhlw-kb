'use strict';
// 前回観測と今回観測を key で突き合わせ、変更を分類する。
//   added           : 新しいリンク（key が初出）
//   removed         : リンクが消えた
//   content_changed : 同じ論理文書で fid（内容）が変わった  ← 最重要
//   url_changed     : 内容は同じだが URL が変わった
//   text_changed    : アンカー文言・注記（訂正ラベル等）が変わった
// 1件のリンクに複数の変化が同時に起こることがあるので、変化は配列で持つ。

function diffObservations(prev, curr) {
  const pm = new Map(prev.map(o => [o.key, o]));
  const cm = new Map(curr.map(o => [o.key, o]));
  const events = [];

  for (const c of curr) {
    const p = pm.get(c.key);
    if (!p) { events.push({ type: 'added', curr: c }); continue; }
    const changes = [];
    if (p.fid !== c.fid) changes.push('content_changed');
    if (p.url !== c.url) changes.push('url_changed');
    if (p.aname !== c.aname || p.note !== c.note) changes.push('text_changed');
    if (changes.length) events.push({ type: changes[0], changes, prev: p, curr: c });
  }
  for (const p of prev) if (!cm.has(p.key)) events.push({ type: 'removed', prev: p });

  // 「removed + added で fid が同じ」は見出し移動/文言変更による key 変化 → moved としてまとめる
  const removedByFid = new Map(events.filter(e => e.type === 'removed').map(e => [e.prev.fid, e]));
  for (const e of events) {
    if (e.type === 'added' && removedByFid.has(e.curr.fid)) {
      const r = removedByFid.get(e.curr.fid);
      e.type = 'moved'; e.prev = r.prev; r.type = '_merged';
    }
  }
  return events.filter(e => e.type !== '_merged');
}

const ORDER = { content_changed: 0, added: 1, removed: 2, url_changed: 3, moved: 4, text_changed: 5 };

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const wa = (a.curr || a.prev).watch ? 0 : 1, wb = (b.curr || b.prev).watch ? 0 : 1;
    if (wa !== wb) return wa - wb;
    return (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9);
  });
}

module.exports = { diffObservations, sortEvents };
