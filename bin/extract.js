#!/usr/bin/env node
'use strict';
// PDF → 座標付きテキスト JSON（MuPDF.js）
//
//   node bin/extract.js --watch            監視対象カテゴリの PDF をすべて抽出（既存はスキップ）
//   node bin/extract.js --fid=<fid>[,..]   指定 fid のみ
//   node bin/extract.js --all              台帳にある全 PDF
//   node bin/extract.js ... --force        既存 JSON を上書き
//
// 出力: data/text/<fid>.json
//   { fid, pages, extracted_at, extractor, lines: [ { p, x, y, w, h, size, text } ... ] }
//   - ルビ（小サイズで本文行の直上に置かれる文字列）は除去し、同一ベースラインの断片は結合する
//   - ページ番号行（「- 21 -」）と空行は除去する
//
// この工程は MuPDF（AGPL）を使う唯一の場所であり、オフラインのバッチとして分離してある。
// 後段（構造化・索引・お尋ねサーバー）はこの JSON だけを読む。

const fs = require('fs');
const path = require('path');
const { Ledger } = require('../lib/ledger');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const config = JSON.parse(fs.readFileSync(path.resolve(val('config', path.join(ROOT, 'config.json'))), 'utf8'));
const dataDirRaw = val('data', config.dataDir || 'data');
const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(ROOT, dataDirRaw);
const textDir = path.join(dataDir, 'text');

const RUBY_MAX_SIZE = 6.5;       // 本文 9pt に対しルビは 5pt 前後
const PAGE_NO_RE = /^[-－‐–—]\s*\d+\s*[-－‐–—]$/; // "- 21 -"

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

// 縦書きページ（官報形式の施設基準告示など）: MuPDF は1文字ずつの「行」を返す。
// 同じ x の文字を列にまとめ、列内は上→下、列は右→左の順に読む。
// 出力行の x には「列の先頭文字の y（字下げ量に相当）」を入れ、y には列の x を入れる（v:true で区別）。
function isVerticalPage(raw) {
  const cells = raw.filter(l => l.text.trim().length === 1);
  return raw.length >= 20 && cells.length / raw.length >= 0.6;
}
function verticalColumns(raw, pno) {
  const items = raw.filter(l => !(/^\s*\d+\s*$/.test(l.text) && l.y > 780)); // 下端中央のページ番号を除く
  const cols = []; // { cx, cells:[{y,text,h}] }
  for (const l of items) {
    const cx = l.x + l.w / 2;
    let col = cols.find(c => Math.abs(c.cx - cx) <= 6);
    if (!col) { col = { cx, cells: [] }; cols.push(col); }
    col.cells.push({ y: l.y, text: l.text.trim(), h: l.h });
  }
  cols.sort((a, b) => b.cx - a.cx); // 右→左
  const out = [];
  for (const c of cols) {
    c.cells.sort((a, b) => a.y - b.y);
    const text = c.cells.map(k => k.text).join('');
    if (!text.trim()) continue;
    const top = c.cells[0].y, last = c.cells[c.cells.length - 1];
    out.push({ p: pno, x: Math.round(top * 10) / 10, y: Math.round(c.cx * 10) / 10, w: Math.round((last.y + last.h - top) * 10) / 10, h: 14, size: null, text, v: true });
  }
  return out;
}

// MuPDF の構造化テキスト → 行配列（1ページ分）
function pageLines(page, pno) {
  const j = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON());
  const raw = [];
  for (const b of j.blocks) {
    if (b.type !== 'text') continue;
    for (const l of b.lines) {
      const text = (l.text || '').replace(/ /g, ' ').replace(/\s+$/, '');
      if (!text.trim()) continue;
      raw.push({ p: pno, x: l.bbox.x, y: l.bbox.y, w: l.bbox.w, h: l.bbox.h, size: l.font ? l.font.size : null, text });
    }
  }
  if (isVerticalPage(raw)) return verticalColumns(raw, pno);
  // ルビ除去: 小サイズかつ、直後に同程度の x 範囲を持つ本文行が下にある
  const body = raw.filter(l => !(l.size != null && l.size <= RUBY_MAX_SIZE && l.h <= RUBY_MAX_SIZE + 1));
  // 同一ベースライン（y 差 ≤ 1.5pt）の断片を x 順に結合
  body.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const merged = [];
  for (const l of body) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.y - l.y) <= 1.5 && l.x >= last.x + last.w - 2) {
      const gap = l.x - (last.x + last.w);
      last.text += (gap > 10 ? ' ' : '') + l.text;
      last.w = (l.x + l.w) - last.x;
      last.h = Math.max(last.h, l.h);
    } else {
      merged.push({ ...l });
    }
  }
  return merged.filter(l => !PAGE_NO_RE.test(l.text.trim())).map(l => ({
    p: l.p, x: Math.round(l.x * 10) / 10, y: Math.round(l.y * 10) / 10, w: Math.round(l.w * 10) / 10, h: Math.round(l.h * 10) / 10,
    size: l.size, text: l.text,
  }));
}

async function extractOne(mupdf, fid, pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const n = doc.countPages();
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(...pageLines(doc.loadPage(i), i + 1));
  return { fid, pages: n, extracted_at: new Date().toISOString(), extractor: 'mupdf.js', lines };
}

async function main() {
  const mupdf = await import('mupdf');
  const ledger = new Ledger(path.join(dataDir, 'ledger'));
  fs.mkdirSync(textDir, { recursive: true });

  let targets = [];
  const fileIndex = ledger.fileIndex();
  if (val('fid')) {
    targets = val('fid').split(',').map(f => fileIndex.get(f.trim())).filter(Boolean);
  } else {
    const wantWatch = has('--watch');
    const seen = new Set();
    for (const page of config.pages) {
      const last = ledger.lastSuccessfulCrawl(page.id);
      if (!last) continue;
      for (const o of ledger.observationsOf(last.crawl_id)) {
        if (!o.fid || o.ext !== 'pdf' || seen.has(o.fid)) continue;
        if (wantWatch && !o.watch) continue;
        if (!wantWatch && !has('--all')) continue;
        seen.add(o.fid); targets.push({ ...fileIndex.get(o.fid), aname: o.aname, category: o.category });
      }
    }
  }
  if (!targets.length) { console.error('対象がありません（--watch / --all / --fid= を指定）'); process.exit(1); }

  let done = 0, skipped = 0;
  for (const f of targets) {
    if (f.ext !== 'pdf') continue;
    const out = path.join(textDir, `${f.fid}.json`);
    if (fs.existsSync(out) && !has('--force')) { skipped++; continue; }
    const t = Date.now();
    const res = await extractOne(mupdf, f.fid, path.join(dataDir, f.path));
    fs.writeFileSync(out, JSON.stringify(res));
    done++;
    log(`${f.fid} ${String(res.pages).padStart(4)}p ${String(res.lines.length).padStart(6)} lines ${Date.now() - t}ms  ${(f.aname || f.first_aname || '').slice(0, 50)}`);
  }
  log(`extracted ${done}, skipped ${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
