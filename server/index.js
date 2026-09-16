// Bizmates Log の裏方。アプリの配信と、AI・カンペ・記録の中継だけを行う。
// キー（Anthropic / OpenAI / GitHub）はここの環境変数にあり、ブラウザには一切渡らない。

import http from 'node:http';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { readFile as readLocal, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedback, pieceToEnglish, scoreSample, transcribe } from './claude.js';
import * as store from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 26 * 1024 * 1024;
const COOKIE = 'bl_session';
const SALT = process.env.SESSION_SALT || randomBytes(16).toString('hex');

// ---------------------------------------------------------------- 認証（合言葉1つ）

const expected = () => {
  const pass = process.env.APP_PASSCODE;
  if (!pass) return null;               // 未設定なら誰でも入れる（起動直後だけの状態）
  return createHash('sha256').update(`${pass}:${SALT}`).digest('hex');
};

function authed(req) {
  const want = expected();
  if (!want) return true;
  const raw = req.headers.cookie || '';
  const got = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
  if (!got) return false;
  const val = got.slice(COOKIE.length + 1);
  if (val.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(val), Buffer.from(want));
}

// ---------------------------------------------------------------- 使いすぎ防止（1時間あたり）

const hits = [];
function rateOk(limit = 60) {
  const now = Date.now();
  while (hits.length && now - hits[0] > 3600000) hits.shift();
  if (hits.length >= limit) return false;
  hits.push(now);
  return true;
}

// ---------------------------------------------------------------- 小道具

const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('送信が大きすぎます（25MB まで）'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = async (req) => {
  const b = await readBody(req);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('JSON が読めません'), { status: 400 }); }
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..')) return send(res, 400, { error: 'bad path' });
  const allowed = rel === 'index.html' || rel.startsWith('assets/');
  if (!allowed) return send(res, 404, { error: 'not found' });
  const file = path.join(ROOT, rel);
  try {
    await stat(file);
    const body = await readLocal(file);
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': rel === 'index.html' ? 'no-store' : 'public, max-age=300' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// ---------------------------------------------------------------- ルーティング

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') return send(res, 200, { ok: true, passcode: !!process.env.APP_PASSCODE });

  if (p === '/api/login' && req.method === 'POST') {
    const want = expected();
    if (!want) return send(res, 200, { ok: true });
    const { passcode } = await json(req);
    const got = createHash('sha256').update(`${String(passcode || '')}:${SALT}`).digest('hex');
    if (got !== want) return send(res, 401, { error: '合言葉が違います' });
    return send(res, 200, { ok: true }, 'application/json; charset=utf-8', {
      'set-cookie': `${COOKIE}=${want}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`,
    });
  }

  if (!authed(req)) return send(res, 401, { error: '合言葉を入れてください' });

  if (p === '/api/session') return send(res, 200, { ok: true });

  if (p === '/api/kanpe' && req.method === 'GET') {
    const rank = (url.searchParams.get('rank') || 'C').replace(/[^A-Z]/g, '');
    const lesson = Number(url.searchParams.get('lesson') || 1);
    if (!rank || !Number.isInteger(lesson) || lesson < 1 || lesson > 40) return send(res, 400, { error: 'rank / lesson が不正です' });
    return send(res, 200, await store.getKanpe(rank, lesson));
  }

  if (p === '/api/state' && req.method === 'GET') {
    return send(res, 200, { state: await store.loadState() });
  }

  if (p === '/api/state' && req.method === 'PUT') {
    const { state, snapshot } = await json(req);
    if (!state || typeof state !== 'object') return send(res, 400, { error: 'state がありません' });
    await store.saveState(state, snapshot);
    return send(res, 200, { ok: true, at: new Date().toISOString() });
  }

  if (p === '/api/transcribe' && req.method === 'POST') {
    if (!rateOk()) return send(res, 429, { error: '今は使いすぎです。しばらく待ってください' });
    const bytes = await readBody(req);
    if (!bytes.length) return send(res, 400, { error: '音声がありません' });
    const text = await transcribe(bytes, req.headers['content-type'] || 'audio/webm', url.searchParams.get('prompt') || '');
    return send(res, 200, { text });
  }

  if (p.startsWith('/api/ai/') && req.method === 'POST') {
    if (!rateOk()) return send(res, 429, { error: '今は使いすぎです。しばらく待ってください' });
    const body = await json(req);
    const kind = p.slice('/api/ai/'.length);
    const run = kind === 'feedback' ? feedback : kind === 'piece' ? pieceToEnglish : kind === 'sample' ? scoreSample : null;
    if (!run) return send(res, 404, { error: 'unknown kind' });
    const r = await run(body);
    console.log(`[ai] ${kind} model=${r.model} in=${r.usage.input_tokens} out=${r.usage.output_tokens}`);
    return send(res, 200, r.data);
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url.pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[error]', e.message);
    if (!res.headersSent) send(res, status, { error: e.message || 'サーバーエラー' });
  }
});

server.listen(PORT, () => {
  console.log(`bizmates-log listening on ${PORT}`);
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'APP_PASSCODE']) {
    if (!process.env[k]) console.log(`  (未設定) ${k}`);
  }
});
