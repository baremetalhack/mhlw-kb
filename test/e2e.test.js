'use strict';
// ローカルのモックサーバーに対して crawl.js を実際に走らせ、台帳・スナップショット・差分・HEAD再利用を検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/r8_excerpt.html'), 'utf8');

function startServer(state) {
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/stf/newpage_67729.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(state.html); }
    const m = u.match(/\/content\/12400000\/(\d+)\.(\w+)$/);
    if (m) {
      const body = Buffer.from(state.files[m[1]] || `PDF-${m[1]}-v1`);
      const etag = `"${m[1]}-${body.length}-${state.mtime[m[1]] || 1}"`;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length, etag, 'last-modified': 'Wed, 02 Sep 2026 09:07:53 GMT' });
      return req.method === 'HEAD' ? res.end() : res.end(body);
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// execFileSync はイベントループを止めるためモックサーバーが応答できない → 非同期で実行
function run(cfgPath, dataDir, ...flags) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'bin/crawl.js'), `--config=${cfgPath}`, `--data=${dataDir}`, '--no-mail', ...flags],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MAIL_USER: '', MAIL_PASS: '', MAIL_TO: '' } },
      (err, stdout, stderr) => err ? reject(new Error(err.message + '\n' + stdout + stderr)) : resolve(stdout + stderr));
  });
}

test('e2e: 初期化 → 無変更 → 差替え/追加 の3回クロール', async () => {
  const state = { html: fixture, files: {}, mtime: {} };
  const srv = await startServer(state);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhlwkb-'));
  const dataDir = path.join(tmp, 'data');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.pages = [{ id: 't', url: `${base}/stf/newpage_67729.html`, title: 'test', contentSelector: 'main' }];
  cfg.download = { concurrency: 4, delayMs: 0, retries: 0, timeoutMs: 5000 };
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  try {
    // 1) init
    let out = await run(cfgPath, dataDir, '--init');
    assert.match(out, /downloaded 41/);
    const ledger = path.join(dataDir, 'ledger');
    const crawls = () => fs.readFileSync(path.join(ledger, 'crawls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const files = () => fs.readFileSync(path.join(ledger, 'files.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(crawls().length, 1);
    assert.equal(files().length, 41);
    assert.equal(fs.readdirSync(path.join(dataDir, 'snapshots', 't')).length, 1);
    assert.equal(fs.readdirSync(path.join(dataDir, 'files')).length, 41);
    const cur = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 't.current.json'), 'utf8'));
    assert.equal(cur.files.length, 41);
    assert.ok(cur.files.every(f => f.fid && f.fname.endsWith('.' + f.url.split('.').pop())));

    // 2) no change: HEAD で再利用、ダウンロード0、スナップショット増えない、イベント0
    out = await run(cfgPath, dataDir);
    assert.match(out, /events 0, downloaded 0, reused 41/);
    assert.equal(fs.readdirSync(path.join(dataDir, 'snapshots', 't')).length, 1);
    assert.equal(crawls().length, 2);

    // 3) 医科点数表（通知）を同一URLで差替え(etag変化) + 疑義解釈その13を追加 + 歯科通知のURL変更(内容同じ)
    state.files['001732089'] = 'PDF-001732089-v2-revised'; state.mtime['001732089'] = 2;
    state.files['001799001'] = 'PDF-001707252-v1'; // 歯科通知: 新URLだが内容は旧と同一
    state.html = fixture
      .replace('001707252.pdf', '001799001.pdf')
      .replace('・<a data-icon="pdf" target="_blank" href="/content/12400000/001744953.pdf">',
        '・<a data-icon="pdf" target="_blank" href="/content/12400000/001800013.pdf">疑義解釈資料の送付について（その13）（令和８年９月15日保険局医療課事務連絡）［500KB］</a><br>\n\t・<a data-icon="pdf" target="_blank" href="/content/12400000/001744953.pdf">');
    out = await run(cfgPath, dataDir);
    assert.match(out, /events 3/);
    assert.match(out, /【内容更新】 \[ika_tsuchi\] 医科点数表/);
    assert.match(out, /【新規】 \[gigi\] 疑義解釈資料の送付について（その13）/);
    assert.match(out, /【URL変更】 \[shika_tsuchi\] 歯科点数表/);
    assert.equal(fs.readdirSync(path.join(dataDir, 'snapshots', 't')).length, 2);
    assert.equal(files().length, 43); // 医科v2 + その13 （歯科は同一内容なので増えない）
    const obs = fs.readFileSync(path.join(ledger, 'observations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(obs.length, 41 * 2 + 42);
  } finally {
    srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
