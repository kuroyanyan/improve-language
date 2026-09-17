// 記録の保存 — 端末の localStorage と、裏方（private リポジトリ）の両方に置く。
// 裏方には記録の全体（state.json）と、週1の改善ループが読む集計（latest.json）を保存する。
// 認証もトークンもサーバー側にあり、このファイルは持たない。

import { apiGet, apiSend } from './api.js';

const DEBOUNCE_MS = 4000;
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
    audio: ai.audio || null, // 録音から: both（相手の声あり）/ learner_only。貼り付けは null
    declared_detail: declared.map((d) => ({ ok: !!d.ok, ai: typeof d.ai === 'boolean' ? d.ai : null })),
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

// ---------------------------------------------------------------- 保存と読み込み

/** 起動時に裏方から記録を読む。取れなければ null（端末の保存で動かす）。 */
export async function loadRemoteState() {
  try {
    const r = await apiGet('/api/state');
    return r.state || null;
  } catch {
    return null;
  }
}

export async function syncNow(silent = false) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    last = { at: '', ok: false, msg: 'オフライン' };
    renderSyncStatus();
    return false;
  }
  try {
    const state = ctx.state();
    await apiSend('/api/state', { state, snapshot: buildSnapshot(state, ctx.today()) }, 'PUT');
    last = { at: new Date().toISOString(), ok: true, msg: '' };
    if (!silent) ctx.toast('保存しました');
    try { localStorage.setItem('bizmates-log/sync', last.at); } catch { /* 無視 */ }
  } catch (e) {
    last = { at: new Date().toISOString(), ok: false, msg: e.message };
    if (!silent) ctx.toast('保存できませんでした');
  }
  renderSyncStatus();
  return last.ok;
}

export function scheduleSync() {
  if (!ctx) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow(true); }, DEBOUNCE_MS);
}

/** 記録の保存状態を、履歴タブの一行に出す（設定は無い）。 */
export function renderSyncStatus() {
  const s = $('syncStatus');
  if (!s) return;
  if (last.ok === false) { s.textContent = `記録の保存に失敗: ${last.msg}（この端末には残っています）`; return; }
  let at = last.ok ? last.at : '';
  if (!at) { try { at = localStorage.getItem('bizmates-log/sync') || ''; } catch { /* 無視 */ } }
  s.textContent = at
    ? `記録は自動で保存されています（最後: ${new Date(at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）`
    : '記録はこの端末と、あなた専用の保存先に自動で残ります。';
}

export function setupSync(c) {
  ctx = c;
  renderSyncStatus();
}
