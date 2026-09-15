// カンペ — レッスンごとの「型・Key Phrases・See・Try・準備の質問・Act・追撃質問・注意」。
// 教材本文を含むので公開リポジトリには置かず、private のデータリポジトリから同期トークンで取りに行く。
// 取ったものは localStorage に置き、次回からはオフラインでも開ける。

import { fetchRepoFile, syncConfigured } from './sync.js';

const CACHE_KEY = 'bizmates-log/kanpe';
const VIEW_KEY = 'bizmates-log/kanpe-view';
let ctx = null;
const $ = (id) => document.getElementById(id);
const view = { rank: 'C', lesson: 1 };

function rememberView() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* 無視 */ }
}
function recallView() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); } catch { return null; }
}

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function saveCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* 容量超過などは無視 */ }
}

/** 取得した HTML を安全な断片にする（script・style・iframe・イベント属性を落とす）。 */
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  for (const bad of doc.querySelectorAll('script, style, iframe, object, embed, link, meta, form')) bad.remove();
  for (const el of doc.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      if ((a.name === 'href' || a.name === 'src') && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
    }
  }
  return doc.body.firstChild;
}

export async function getKanpe(rank, lesson, { refresh = false } = {}) {
  const key = `${rank}-${lesson}`;
  const hit = loadCache()[key];
  if (!refresh && hit && hit.html) return { html: hit.html, from: 'cache', at: hit.at };
  if (!syncConfigured()) throw new Error('同期先が未設定です。履歴 → データ同期にリポジトリとトークンを入れると読めます');
  const path = `kanpe/${rank}/${String(lesson).padStart(2, '0')}.html`;
  const html = await fetchRepoFile(path);
  // 取得後に読み直してから書く（共通カードと同時に取ると、先に読んだ古いキャッシュで上書きしてしまうため）
  const cache = loadCache();
  cache[key] = { html, at: new Date().toISOString() };
  saveCache(cache);
  return { html, from: 'repo', at: cache[key].at };
}

export async function getCommon({ refresh = false } = {}) {
  const hit = loadCache().common;
  if (!refresh && hit && hit.html) return hit.html;
  if (!syncConfigured()) return '';
  try {
    const html = await fetchRepoFile('kanpe/common.html');
    const cache = loadCache();
    cache.common = { html, at: new Date().toISOString() };
    saveCache(cache);
    return html;
  } catch { return ''; }
}

function fillLessons() {
  const sel = $('kanpeLesson');
  sel.replaceChildren();
  for (const l of ctx.lessonsOf(view.rank)) {
    const o = ctx.el('option', null, `Lesson ${l.lesson}: ${l.topic}${l.type === 'challenge' ? '（Challenge）' : ''}`);
    o.value = String(l.lesson);
    sel.appendChild(o);
  }
  sel.value = String(view.lesson);
  if (!sel.value && sel.options.length) { sel.value = sel.options[0].value; view.lesson = Number(sel.value); }
}

export async function renderKanpe({ refresh = false } = {}) {
  const box = $('kanpeBody');
  const status = $('kanpeStatus');
  rememberView();
  $('kanpeRankBadge').textContent = `Rank ${view.rank}`;
  box.replaceChildren();
  status.textContent = '読み込み中…';
  try {
    const [common, k] = await Promise.all([getCommon({ refresh }), getKanpe(view.rank, view.lesson, { refresh })]);
    if (common) {
      const c = sanitize(common);
      c.classList.add('common');
      box.appendChild(c);
    }
    box.appendChild(sanitize(k.html));
    const when = new Date(k.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    status.textContent = k.from === 'cache' ? `この端末に保存済み（${when} 取得）。「更新」で取り直せます` : `取得しました（${when}）`;
  } catch (e) {
    status.textContent = e.message;
    box.appendChild(ctx.el('p', 'empty', 'カンペを表示できませんでした。'));
  }
}

/** 予習タブや記録タブから「このレッスンのカンペ」を開く。 */
export function openKanpe(rank, lesson) {
  view.rank = rank;
  view.lesson = lesson;
  fillLessons();
  ctx.switchView('kanpe');
  renderKanpe();
}

export function setupKanpe(c) {
  ctx = c;
  view.rank = ctx.currentRank();
  const last = recallView();
  view.lesson = last && last.rank === view.rank && last.lesson ? last.lesson : ctx.suggestedLesson();
  fillLessons();
  $('kanpeLesson').addEventListener('change', () => { view.lesson = Number($('kanpeLesson').value); renderKanpe(); });
  $('kanpePrev').addEventListener('click', () => { if (view.lesson > 1) { view.lesson -= 1; fillLessons(); renderKanpe(); } });
  $('kanpeNext').addEventListener('click', () => { const n = ctx.lessonsOf(view.rank).length; if (view.lesson < n) { view.lesson += 1; fillLessons(); renderKanpe(); } });
  $('kanpeRefresh').addEventListener('click', () => { ctx.toast('取り直しています'); renderKanpe({ refresh: true }); });
  // ナビから開いたときは、そのとき選ばれているレッスンを描画する
  $('tab-kanpe').addEventListener('click', () => { syncKanpeRank(); renderKanpe(); });
}

/** ランク切替に追従する。 */
export function syncKanpeRank() {
  if (!ctx) return;
  const r = ctx.currentRank();
  if (r !== view.rank) { view.rank = r; view.lesson = ctx.suggestedLesson(); fillLessons(); }
}
