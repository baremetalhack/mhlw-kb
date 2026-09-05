#!/usr/bin/env node
'use strict';
// data/text/<fid>.json → data/struct/<fid>.json（章/部/節/款 + 区分番号チャンク）
//
//   node bin/structure.js --fid=<fid>[,..]     指定 fid を構造化して検証結果を表示
//   node bin/structure.js --compare=<fidA>,<fidB>  2文書（例: 告示と通知）の区分番号集合を比較

const fs = require('fs');
const path = require('path');
const { buildStructure, validate } = require('../lib/structure');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const val = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const config = JSON.parse(fs.readFileSync(path.resolve(val('config', path.join(ROOT, 'config.json'))), 'utf8'));
const dataDirRaw = val('data', config.dataDir || 'data');
const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(ROOT, dataDirRaw);
const structDir = path.join(dataDir, 'struct');
fs.mkdirSync(structDir, { recursive: true });

function build(fid) {
  const tj = JSON.parse(fs.readFileSync(path.join(dataDir, 'text', `${fid}.json`), 'utf8'));
  const st = buildStructure(tj);
  fs.writeFileSync(path.join(structDir, `${fid}.json`), JSON.stringify(st));
  return st;
}

if (val('compare')) {
  const [a, b] = val('compare').split(',').map(s => s.trim());
  const sa = build(a), sb = build(b);
  const ca = new Set(sa.chunks.filter(c => c.kind === 'kubun').map(c => c.code));
  const cb = new Set(sb.chunks.filter(c => c.kind === 'kubun').map(c => c.code));
  console.log(`${a}: 区分 ${ca.size} / ${b}: 区分 ${cb.size}`);
  console.log(`${a} のみ (${[...ca].filter(c => !cb.has(c)).length}):`, [...ca].filter(c => !cb.has(c)).join(' '));
  console.log(`${b} のみ (${[...cb].filter(c => !ca.has(c)).length}):`, [...cb].filter(c => !ca.has(c)).join(' '));
  process.exit(0);
}

for (const fid of (val('fid') || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const st = build(fid);
  const v = validate(st);
  console.log(`== ${fid}  pages ${st.pages}`);
  console.log(JSON.stringify(v));
  console.log('sections:', st.sections.filter(s => s.level === '章' || s.level === '部').map(s => `${s.title}(p${s.p})`).join(' / '));
  if (args.includes('--list')) for (const c of st.chunks) console.log(`  p${String(c.p_start).padStart(4)} ${c.kind === 'kubun' ? c.code.padEnd(8) : '通則    '} ${(c.title || '').slice(0, 40).padEnd(40)} | ${c.path.join(' > ')}`);
}
