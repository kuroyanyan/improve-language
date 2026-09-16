// 裏方（同じサーバー）への窓口。キーもトークンもブラウザには無い。
// 合言葉が必要なときは、画面に1枚のゲートを出して通す。

let gateResolve = null;

const $ = (id) => document.getElementById(id);

async function parse(res) {
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 200) }; }
  if (res.status === 401) { await openGate(); throw new Error('合言葉を入れてください'); }
  if (!res.ok) throw new Error(body.error || `サーバーエラー（${res.status}）`);
  return body;
}

export async function apiGet(path) {
  return parse(await fetch(path, { credentials: 'same-origin' }));
}

export async function apiSend(path, data, method = 'POST') {
  return parse(await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  }));
}

/** 音声をそのまま送る（multipart はサーバー側で組む）。 */
export async function apiAudio(path, blob, promptText) {
  const url = `${path}?prompt=${encodeURIComponent(promptText || '')}`;
  return parse(await fetch(url, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': blob.type || 'audio/webm' },
    body: blob,
  }));
}

// ---------------------------------------------------------------- 合言葉ゲート

function openGate() {
  const gate = $('gate');
  if (!gate) return Promise.resolve();
  if (!gate.hidden && gateResolve) return new Promise((r) => { const prev = gateResolve; gateResolve = (v) => { prev(v); r(v); }; });
  gate.hidden = false;
  $('gateInput').value = '';
  $('gateError').textContent = '';
  setTimeout(() => $('gateInput').focus(), 50);
  return new Promise((resolve) => { gateResolve = resolve; });
}

export function setupGate() {
  const form = $('gateForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('gateSubmit');
    btn.disabled = true;
    $('gateError').textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passcode: $('gateInput').value }),
      });
      if (!res.ok) { $('gateError').textContent = '合言葉が違います'; return; }
      $('gate').hidden = true;
      if (gateResolve) { const r = gateResolve; gateResolve = null; r(true); }
    } catch {
      $('gateError').textContent = 'サーバーに届きませんでした';
    } finally {
      btn.disabled = false;
    }
  });
}

/** 起動時に一度だけ。合言葉が要るときだけゲートを出す。それ以外は待たずに進む。 */
export async function ensureSession() {
  let res;
  try {
    res = await fetch('/api/session', { credentials: 'same-origin' });
  } catch {
    return false;   // オフライン。端末に保存済みの記録で動かす
  }
  if (res.ok) return true;
  if (res.status === 401) { await openGate(); return true; }
  return false;     // 裏方が無い場所で開いたとき（静的配信など）も動かす
}
