'use strict';
// Gmail (SMTP 587 / アプリパスワード) 経由の通知メール。
// 環境変数: MAIL_USER, MAIL_PASS(アプリパスワード), MAIL_FROM(省略時 MAIL_USER), MAIL_TO(カンマ区切り)
// 設定が無ければ送信せず本文を標準出力に出す（開発時・dry-run 用）。

const nodemailer = require('nodemailer');

function configured() {
  return !!(process.env.MAIL_USER && process.env.MAIL_PASS && process.env.MAIL_TO);
}

async function send({ subject, text }) {
  if (!configured()) {
    console.log('[mail] 未設定のため送信しません。件名: ' + subject + '\n' + text);
    return { sent: false };
  }
  const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port: Number(process.env.MAIL_PORT || 587),
    secure: false,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  });
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
    to: process.env.MAIL_TO,
    subject, text,
  });
  return { sent: true, id: info.messageId };
}

function fmtBytes(n) {
  if (n == null) return '?';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB';
  if (n >= 1024) return Math.round(n / 1024) + 'KB';
  return n + 'B';
}

const LABEL = {
  content_changed: '【内容更新】', added: '【新規】', removed: '【削除】',
  url_changed: '【URL変更】', moved: '【移動/文言変更】', text_changed: '【注記変更】',
};

// 変更イベント → メール本文（プレーンテキスト）
function renderReport({ page, crawl, events, stats }) {
  const lines = [];
  lines.push(`${page.title}`);
  lines.push(page.url);
  lines.push(`クロール: ${crawl.ts}  (crawl_id ${crawl.crawl_id})`);
  lines.push(`リンク ${stats.links} 件 / ダウンロード ${stats.downloaded} 件 / 変更イベント ${events.length} 件`);
  lines.push('');
  const watched = events.filter(e => (e.curr || e.prev).watch);
  const others = events.filter(e => !(e.curr || e.prev).watch);
  const block = (title, evs) => {
    if (!evs.length) return;
    lines.push(`■ ${title} (${evs.length})`);
    for (const e of evs) {
      const o = e.curr || e.prev;
      lines.push(`${LABEL[e.type] || e.type} [${o.category}] ${o.aname}${o.note ? ' ' + o.note : ''}`);
      lines.push(`    ${o.h2}${o.h3 ? ' > ' + o.h3 : ''}${o.label ? ' > ' + o.label : ''}`);
      if (e.prev && e.curr) {
        if (e.prev.fid !== e.curr.fid) lines.push(`    fid ${e.prev.fid} (${fmtBytes(e.prev.bytes)}) → ${e.curr.fid} (${fmtBytes(e.curr.bytes)})`);
        if (e.prev.url !== e.curr.url) lines.push(`    url ${e.prev.url} → ${e.curr.url}`);
        if (e.prev.aname !== e.curr.aname) lines.push(`    文言 ${e.prev.aname} → ${e.curr.aname}`);
        if (e.prev.note !== e.curr.note) lines.push(`    注記 ${e.prev.note || '(なし)'} → ${e.curr.note || '(なし)'}`);
      } else {
        lines.push(`    fid ${o.fid} (${fmtBytes(o.bytes)})  ${o.url}`);
      }
      lines.push('');
    }
  };
  block('監視対象（告示・通知・疑義解釈）', watched);
  block('その他のファイル', others);
  return lines.join('\n');
}

module.exports = { send, configured, renderReport, LABEL };
