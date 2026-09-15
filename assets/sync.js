// データ同期（任意）— 集計だけを private の GitHub リポジトリに置き、週1の改善ループが読む。
// 送らないもの: 文字起こし本文・音声・メモ・API キー・トレーナー名。
// 認証はそのリポジトリだけに絞った fine-grained PAT。API キーと同じ場所（書き出しに含まれない）に保存する。

import { loadKeys, saveKeys } from './ai.js';

const DEBOUNCE_MS = 8000;
const SNAPSHOT_SCHEMA = 1;

let ctx = null;
let timer = null;
let last = { at: '', ok: null, msg: '' };
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 週の計算（月曜はじまり）

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay() || 7;
  dt.setDate(dt.getDate() - (day - 1));
  return fmt(dt);
}

export function isoWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- スナップショット

const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

function sessionRow(s) {
  const ai = s.ai || {};
  const kp = ai.key_phrase_use || [];
  const tq = ai.trainer_questions || [];
  const declared = s.declared || [];
  return {
    date: s.date, lesson: s.lesson, rating: s.rating || 0,
    talk_min: s.talkMin ?? null,
    declared: declared.length,
    recovered: declared.filter((d) => d.ok).length,
    stucks: (s.stucks || []).length,
    words: (s.words || []).length,
    has_ai: !!ai.summary_ja,
    kp_used: kp.filter((k) => k.used).length,
    kp_total: kp.length,
    trainer_q: ai.trainer_question_count ?? tq.length,
    trainer_q_covered: tq.filter((q) => q.covered).length,
    learner_q: ai.learner_question_count ?? null,
  };
}

export function buildSnapshot(state, todayStr) {
  const sessions = (state.sessions || []).map(sessionRow);
  const preps = state.preps || [];
  const byWeek = new Map();
  const touch = (date) => {
    const k = isoWeek(date);
    if (!byWeek.has(k)) byWeek.set(k, { week: k, start: mondayOf(date), days: new Set(), sessions: 0, preps: 0, talk_min: 0, declared: 0, recovered: 0, kp_used: 0, kp_total: 0, trainer_q: 0, trainer_q_covered: 0, learner_q: 0, stucks: 0, ratings: [] });
    return byWeek.get(k);
  };
  for (const s of sessions) {
    const w = touch(s.date);
    w.days.add(s.date); w.sessions += 1; w.talk_min += s.talk_min || 0; w.declared += s.declared; w.recovered += s.recovered;
    w.kp_used += s.kp_used; w.kp_total += s.kp_total; w.trainer_q += s.trainer_q || 0; w.trainer_q_covered += s.trainer_q_covered; w.learner_q += s.learner_q || 0;
    w.stucks += s.stucks; if (s.rating) w.ratings.push(s.rating);
  }
  for (const p of preps) { const w = touch(p.date); w.days.add(p.date); w.preps += 1; }
  const weeks = [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week)).slice(-12)
    .map((w) => ({ ...w, days_active: w.days.size, days: undefined, rating_avg: avg(w.ratings), ratings: undefined }));

  const pieces = (state.pieces || []).map((p) => ({
    id: p.id, cat: p.cat, en: p.en, created: p.createdAt,
    uses: (p.uses || []).length, ok: (p.uses || []).filter((u) => u.ok).length, graduated: p.graduatedAt || null,
  }));
  const samples = (state.samples || []).map((s) => ({
    date: s.date, seconds: s.seconds, words: s.words, wpm: s.wpm, level: s.level,
    complete_ratio: s.complete_ratio, stuck_count: s.stuck_count, best_sentence: s.best_sentence || '',
  }));
  const real = (state.real || []).map((r) => ({ date: r.date, text: r.text }));

  return {
    app: 'bizmates-log', schema: SNAPSHOT_SCHEMA, generated_at: new Date().toISOString(), date: todayStr,
    profile: { rank: state.profile.rank, level: state.profile.level, next_lesson: state.profile.lastLogLesson },
    totals: {
      sessions: sessions.length, preps: preps.length, cards: (state.cards || []).length,
      pieces: pieces.length, pieces_graduated: pieces.filter((p) => p.graduated).length,
      real: real.length, samples: samples.length,
    },
    weeks, pieces, samples, real, sessions: sessions.slice(-60),
  };
}

// ---------------------------------------------------------------- GitHub Contents API

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function headers(pat) {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function putFile(cfg, path, text, message) {
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
  let sha;
  const got = await fetch(url, { headers: headers(cfg.pat) });
  if (got.ok) sha = (await got.json()).sha;
  else if (got.status !== 404) throw new Error(`GitHub 読み取りに失敗（${got.status}）`);
  const res = await fetch(url, {
    method: 'PUT', headers: headers(cfg.pat),
    body: JSON.stringify({ message, content: b64utf8(text), ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`GitHub 書き込みに失敗（${res.status}）${t.slice(0, 120)}`);
  }
}

export async function pushSnapshot(snapshot, cfg) {
  const text = JSON.stringify(snapshot, null, 2);
  await putFile(cfg, `snapshots/${snapshot.date}.json`, text, `snapshot ${snapshot.date}`);
  await putFile(cfg, 'latest.json', text, `latest ${snapshot.date}`);
}


/** private リポジトリのファイルを1つ読む（Contents API、UTF-8 テキスト）。 */
export async function fetchRepoFile(path) {
  const cfg = syncConfig();
  if (!syncConfigured()) throw new Error('同期先が未設定です');
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, { headers: headers(cfg.pat) });
  if (res.status === 404) throw new Error(`まだありません: ${path}`);
  if (!res.ok) throw new Error(`GitHub 読み取りに失敗（${res.status}）`);
  const j = await res.json();
  const bin = atob((j.content || '').replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------- 実行

export function syncConfig() {
  const k = loadKeys();
  return { repo: (k.github_repo || '').trim(), pat: (k.github_pat || '').trim() };
}
export const syncConfigured = () => { const c = syncConfig(); return !!(c.repo && c.pat && /^[\w.-]+\/[\w.-]+$/.test(c.repo)); };

export async function syncNow(silent = false) {
  if (!syncConfigured()) { if (!silent) ctx.toast('同期先が未設定です'); return false; }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { last = { at: '', ok: false, msg: 'オフライン' }; renderSyncStatus(); return false; }
  try {
    const snap = buildSnapshot(ctx.state(), ctx.today());
    await pushSnapshot(snap, syncConfig());
    last = { at: new Date().toISOString(), ok: true, msg: '' };
    if (!silent) ctx.toast('同期しました');
    try { localStorage.setItem('bizmates-log/sync', last.at); } catch { /* 無視 */ }
  } catch (e) {
    last = { at: new Date().toISOString(), ok: false, msg: e.message };
    if (!silent) ctx.toast('同期できませんでした');
  }
  renderSyncStatus();
  return last.ok;
}

export function scheduleSync() {
  if (!ctx || !syncConfigured()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow(true); }, DEBOUNCE_MS);
}

export function renderSyncStatus() {
  const s = $('syncStatus');
  if (!s) return;
  if (!syncConfigured()) { s.textContent = '未設定。設定すると、保存のたびに集計だけを自動で送ります。'; return; }
  let lastOk = last.ok ? last.at : '';
  if (!lastOk) { try { lastOk = localStorage.getItem('bizmates-log/sync') || ''; } catch { /* 無視 */ } }
  const when = lastOk ? new Date(lastOk).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'まだ';
  s.textContent = last.ok === false ? `最後の同期に失敗: ${last.msg}` : `最後の同期: ${when}`;
}

export function setupSync(c) {
  ctx = c;
  const cfg = syncConfig();
  $('syncRepo').value = cfg.repo;
  $('syncPat').value = cfg.pat;
  $('syncSave').addEventListener('click', () => {
    saveKeys({ github_repo: $('syncRepo').value.trim(), github_pat: $('syncPat').value.trim() });
    renderSyncStatus();
    ctx.toast('同期先を保存しました');
  });
  $('syncNow').addEventListener('click', () => syncNow(false));
  renderSyncStatus();
}
