'use strict';
// HTTP 取得（Node 18+ の組み込み fetch を使用。外部依存なし）
// - 識別可能な User-Agent
// - リトライ（指数バックオフ）
// - HEAD による軽量チェック
// - 本体は Buffer で返し、呼び出し側で SHA-256 を取る

const crypto = require('crypto');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, { retries = 3, baseMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(i); } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(baseMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}

function pickHeaders(res) {
  return {
    etag: res.headers.get('etag') || null,
    last_modified: res.headers.get('last-modified') || null,
    content_length: res.headers.get('content-length') ? Number(res.headers.get('content-length')) : null,
    content_type: res.headers.get('content-type') || null,
  };
}

async function head(url, { userAgent, timeoutMs = 30000, retries = 3 } = {}) {
  return withRetry(async () => {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) throw new Error(`HEAD ${url} -> ${res.status}`);
    return { status: res.status, ...pickHeaders(res) };
  }, { retries });
}

async function get(url, { userAgent, timeoutMs = 120000, retries = 3 } = {}) {
  return withRetry(async () => {
    const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const h = pickHeaders(res);
    if (h.content_length != null && h.content_length !== buf.length && !res.headers.get('content-encoding')) {
      throw new Error(`GET ${url}: truncated (${buf.length}/${h.content_length})`);
    }
    return { status: res.status, ...h, buf, sha256: sha256(buf) };
  }, { retries });
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

module.exports = { head, get, sha256, sleep };
