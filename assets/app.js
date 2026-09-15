// Bizmates Log — レッスン後の記録と、次回の5分予習。
// 保存先は localStorage だけ。バックエンドもビルドも無し。

import { setupAI, loadKeys, saveKeys } from './ai.js';
import { setupPieces, renderPieces, pickTodayPiece, recordPieceResult, activePieces, graduatedPieces, firstLine, lines as pieceLines } from './pieces.js';
import { setupSample, renderSampleSummary, bestOf } from './sample.js';
import { setupSync, scheduleSync, renderSyncStatus, mondayOf } from './sync.js';

const STORAGE_KEY = 'bizmates-log/v1';
// AI フィードバックの system prompt に渡す、自分についての最小限の事実（名前は入れない）
const LEARNER_PROFILE = 'Head of HR at a trading card company in Japan; team of seven; responsible for hiring and organization; also runs a new business; hobbies: running, cooking, working out.';
const PREP_STEPS = [
  { title: '前回つまずいたところ', seconds: 60, desc: '日本語を見て、英語を声に出す。出なければ答えを読む。' },
  { title: '今日の Key Phrases', seconds: 60, desc: '2回ずつ音読する。意味より先に口を慣らす。' },
  { title: '今日のピースを宣言', seconds: 120, desc: '日本語を見て英語を声に出す。3回言えたら見ずに。これを今日のフリートークで言うと決める。' },
  { title: '単語カード', seconds: 60, desc: '日本語を見て英語。出なければ答えを見て、そのまま1回言う。' },
];
const TALK_CHOICES = [0, 5, 10, 15, 20];
const PREP_TOTAL = PREP_STEPS.reduce((n, s) => n + s.seconds, 0);
// Leitner 方式。箱が上がるほど次に出る間隔が伸びる（日数）。
const BOX_DAYS = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 14 };
const MAX_BOX = 5;

// ---------------------------------------------------------------- utilities

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** 端末のローカル日付（JST 端末なら JST）を YYYY-MM-DD で返す。 */
function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function jpDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}（${wd}）`;
}

function daysBetween(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function mmss(total) {
  const s = Math.max(0, Math.round(total));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function buzz(pattern) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* 未対応端末は無視 */ }
  }
}

// ---------------------------------------------------------------- state

const LIST_KEYS = ['sessions', 'cards', 'preps', 'pieces', 'real', 'samples'];

const blankState = () => ({
  version: 1,
  profile: { rank: 'C', level: '1', lastLogLesson: 1, lastPrepLesson: 1 },
  sessions: [],
  cards: [],
  preps: [],
  pieces: [],   // 自分史ピース（3文＋質問）
  real: [],     // レッスン外で英語を使った記録（1行）
  samples: [],  // 月1の60秒サンプル
});

let state = blankState();
let lessons = [];
let lessonById = new Map();

/** 読み込んだデータを現在の形に揃える（古い書き出し JSON もそのまま読めるように）。 */
function normalize(parsed) {
  const s = { ...blankState(), ...parsed, profile: { ...blankState().profile, ...(parsed.profile || {}) } };
  for (const k of LIST_KEYS) {
    if (!Array.isArray(s[k])) s[k] = [];
  }
  for (const p of s.pieces) {
    if (!Array.isArray(p.uses)) p.uses = [];
    if (!('graduatedAt' in p)) p.graduatedAt = null;
  }
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') state = normalize(parsed);
  } catch (e) {
    console.warn('保存データを読めませんでした', e);
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    scheduleSync();
  } catch (e) {
    console.warn('保存できませんでした', e);
    toast('保存できませんでした（ブラウザの設定を確認してください）');
  }
}

// ---------------------------------------------------------------- cards / SRS

function addCard(ja, en, source) {
  const jaT = (ja || '').trim();
  const enT = (en || '').trim();
  if (!jaT || !enT) return null;
  const dup = state.cards.find((c) => c.ja === jaT && c.en === enT);
  if (dup) return dup;
  const card = {
    id: uid(), ja: jaT, en: enT, source,
    box: 1, due: today(), seen: 0, correct: 0, createdAt: today(),
  };
  state.cards.push(card);
  return card;
}

const dueCards = () => state.cards.filter((c) => c.due <= today());

function gradeCard(card, ok) {
  card.seen += 1;
  if (ok) {
    card.correct += 1;
    card.box = Math.min(MAX_BOX, card.box + 1);
    card.due = today(BOX_DAYS[card.box]);
  } else {
    card.box = 1;
    card.due = today(); // 同じ日のうちにもう一度出す
  }
  save();
}

// ---------------------------------------------------------------- lessons

let ranks = [];   // [{ rank, level, total, lessons }]

const currentRank = () => state.profile.rank || (ranks[0] ? ranks[0].rank : 'C');
const sameRank = (x) => (x.rank || 'C') === currentRank();

function lessonFor(rank, n) {
  const r = ranks.find((x) => x.rank === (rank || 'C'));
  return r ? r.lessons.find((l) => l.lesson === n) : null;
}

function lessonLabel(rank, n) {
  const r = rank || 'C';
  return r === currentRank() ? `L${n}` : `Rank ${r} L${n}`;
}

/** 現在のランクを切り替え、lessons / lessonById を差し替える。 */
function applyRank(rank) {
  const r = ranks.find((x) => x.rank === rank) || ranks[0] || { rank: 'C', level: '1', total: 20, lessons: [] };
  state.profile.rank = r.rank;
  state.profile.level = r.level || state.profile.level;
  lessons = r.lessons || [];
  lessonById = new Map(lessons.map((l) => [l.lesson, l]));
  const pick = $('rankPick');
  if (pick && pick.value !== r.rank) pick.value = r.rank;
  $('rankLine').textContent = `Level ${r.level} · Lesson 1–${r.total || lessons.length}`;
  $('footLine').textContent = `Bizmates Level ${r.level} · Rank ${ranks.map((x) => x.rank).join('・')}（各 Lesson 1–20）の Key Phrases を収録`;
}

async function loadLessons() {
  const res = await fetch('assets/data/lessons.json');
  if (!res.ok) throw new Error(`lessons.json: ${res.status}`);
  const data = await res.json();
  ranks = Array.isArray(data.ranks) && data.ranks.length
    ? data.ranks
    : [{ rank: data.rank || 'C', level: data.level || '1', total: data.total || 20, lessons: data.lessons || [] }];
  const pick = $('rankPick');
  pick.replaceChildren();
  for (const r of ranks) {
    const o = el('option', null, `Rank ${r.rank}`);
    o.value = r.rank;
    pick.appendChild(o);
  }
  pick.hidden = ranks.length < 2;
  applyRank(state.profile.rank);
}

function fillLessonSelect(select, selected) {
  select.replaceChildren();
  for (const l of lessons) {
    const o = el('option', null, `Lesson ${l.lesson}: ${l.topic}${l.type === 'challenge' ? '（Challenge）' : ''}`);
    o.value = String(l.lesson);
    select.appendChild(o);
  }
  select.value = String(selected);
  if (!select.value && lessons.length) select.value = String(lessons[0].lesson);
}

/** 現在のランクで最後に記録したレッスンの次。まだ無ければ保存済みの選択値。 */
function suggestedNextLesson() {
  const mine = state.sessions.filter(sameRank);
  if (!mine.length) return state.profile.lastPrepLesson || 1;
  const last = Math.max(...mine.map((s) => s.lesson));
  return Math.min(last + 1, lessons.length || 20);
}

function switchRank(rank) {
  applyRank(rank);
  const next = suggestedNextLesson();
  state.profile.lastLogLesson = state.sessions.some(sameRank) ? next : 1;
  state.profile.lastPrepLesson = state.profile.lastLogLesson;
  save();
  fillLessonSelect($('logLesson'), state.profile.lastLogLesson);
  renderLogLesson();
  renderDeclared();
  renderAll();
  toast(`Rank ${state.profile.rank} に切り替えました`);
}

// ---------------------------------------------------------------- 記録タブ

const draft = { rating: 0, stucks: [], words: [], ai: null, talkMin: null, pieceResults: {}, extraPieces: [] };

/** このレッスン向けに宣言したピース。予習が無ければ直近3日の予習から。 */
function declaredPieces(lesson) {
  const forLesson = state.preps.filter((p) => p.pieceId && sameRank(p) && p.lesson === lesson);
  let src = forLesson.length ? [forLesson[forLesson.length - 1]] : [];
  if (!src.length) {
    const recent = state.preps.filter((p) => p.pieceId && daysBetween(p.date, today()) <= 3);
    if (recent.length) src = [recent[recent.length - 1]];
  }
  const ids = [...new Set([...src.map((p) => p.pieceId), ...draft.extraPieces])];
  return ids.map((id) => state.pieces.find((p) => p.id === id)).filter(Boolean);
}

function renderDeclared() {
  const lesson = Number($('logLesson').value);
  const box = $('declaredBox');
  box.replaceChildren();
  const list = declaredPieces(lesson);
  if (!list.length) {
    box.appendChild(el('p', 'hint', state.pieces.length
      ? '宣言したピースはありません。予習でピースを宣言すると、ここで「言えた」を残せます。'
      : 'まだピースがありません。「自分の話」タブで1つ作ると、予習で宣言 → ここで回収、が始まります。'));
  }
  for (const p of list) {
    const item = el('div', 'item');
    const en = el('div', 'en', pieceLines(p.en).join('\n'));
    const ja = el('div', 'ja', firstLine(p.ja));
    const pair = el('div', 'pair');
    const yes = el('button', 'yes', '◎ 見ずに言えた');
    const no = el('button', 'no', '△ まだ');
    yes.type = 'button';
    no.type = 'button';
    const paint = () => {
      const r = draft.pieceResults[p.id];
      yes.setAttribute('aria-pressed', String(r === true));
      no.setAttribute('aria-pressed', String(r === false));
    };
    yes.addEventListener('click', () => { draft.pieceResults[p.id] = draft.pieceResults[p.id] === true ? undefined : true; paint(); });
    no.addEventListener('click', () => { draft.pieceResults[p.id] = draft.pieceResults[p.id] === false ? undefined : false; paint(); });
    paint();
    pair.append(no, yes);
    item.append(en, ja, pair);
    box.appendChild(item);
  }

  // ほかのピースも言えたときに足せる
  const sel = $('declareExtra');
  sel.replaceChildren();
  const shown = new Set(list.map((p) => p.id));
  const o0 = el('option', null, 'ほかに言えたピースがあれば…');
  o0.value = '';
  sel.appendChild(o0);
  for (const p of activePieces(state).concat(graduatedPieces(state))) {
    if (shown.has(p.id)) continue;
    const o = el('option', null, firstLine(p.en));
    o.value = p.id;
    sel.appendChild(o);
  }
  $('declareExtraRow').hidden = sel.options.length <= 1;
}

function renderTalkSeg() {
  for (const b of document.querySelectorAll('#talkSeg button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.talk) === draft.talkMin));
  }
}

function renderDraftLists() {
  const sl = $('stuckList');
  sl.replaceChildren();
  draft.stucks.forEach((s, i) => {
    const li = el('li');
    const body = el('div', 'body');
    body.appendChild(el('div', 'ja', s.ja));
    if (s.fix) body.appendChild(el('div', 'fix', `→ ${s.fix}`));
    const del = el('button', 'icon', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', `${s.ja} を消す`);
    del.addEventListener('click', () => { draft.stucks.splice(i, 1); renderDraftLists(); });
    li.append(body, del);
    sl.appendChild(li);
  });

  const wl = $('wordList');
  wl.replaceChildren();
  draft.words.forEach((w, i) => {
    const li = el('li');
    const body = el('div', 'body');
    body.appendChild(el('div', 'en', w.en));
    body.appendChild(el('div', 'ja', w.ja));
    const del = el('button', 'icon', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', `${w.en} を消す`);
    del.addEventListener('click', () => { draft.words.splice(i, 1); renderDraftLists(); });
    li.append(body, del);
    wl.appendChild(li);
  });

  const n = draft.stucks.length + draft.words.length;
  $('saveHint').textContent = n
    ? `詰まったこと ${draft.stucks.length} 件 / 単語 ${draft.words.length} 件を記録します。`
    : '空のままでも、受けた記録だけ残せます。';
}

function renderLogLesson() {
  const n = Number($('logLesson').value);
  const l = lessonById.get(n);
  if (!l) return;
  $('logLessonBadge').textContent = l.type === 'challenge' ? 'Challenge' : `Rank ${l.rank || currentRank()}`;
  $('logLessonBadge').className = l.type === 'challenge' ? 'badge warn' : 'badge';
  const done = state.sessions.some((s) => sameRank(s) && s.lesson === n);
  $('logLessonHint').textContent = l.keyPhrases.length
    ? `${l.keyPhrases.slice(0, 3).join(' / ')}${l.keyPhrases.length > 3 ? ' …' : ''}${done ? '（記録済み）' : ''}`
    : done ? '記録済み' : '';
}

function setupLogTab() {
  fillLessonSelect($('logLesson'), state.profile.lastLogLesson || 1);
  renderLogLesson();

  $('logLesson').addEventListener('change', () => {
    state.profile.lastLogLesson = Number($('logLesson').value);
    save();
    renderLogLesson();
    renderDeclared();
  });

  const seg = $('talkSeg');
  for (const m of TALK_CHOICES) {
    const b = el('button', null, m === 0 ? '0分' : m === 20 ? '20分+' : `${m}分`);
    b.type = 'button';
    b.dataset.talk = String(m);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { draft.talkMin = draft.talkMin === m ? null : m; renderTalkSeg(); });
    seg.appendChild(b);
  }

  $('declareExtra').addEventListener('change', () => {
    const id = $('declareExtra').value;
    if (!id) return;
    draft.extraPieces.push(id);
    draft.pieceResults[id] = true;
    renderDeclared();
  });

  $('realSave').addEventListener('click', () => {
    const text = $('realText').value.trim();
    if (!text) { $('realText').focus(); return; }
    state.real.push({ id: uid(), date: today(), text });
    save();
    $('realText').value = '';
    renderAll();
    toast('実戦を記録しました 🌍');
    buzz([40, 60, 40]);
  });

  for (const b of document.querySelectorAll('.seg button[data-rating]')) {
    b.addEventListener('click', () => {
      draft.rating = Number(b.dataset.rating);
      for (const other of document.querySelectorAll('.seg button[data-rating]')) {
        other.setAttribute('aria-pressed', String(other === b));
      }
    });
  }

  const addStuck = () => {
    const ja = $('stuckJa').value.trim();
    if (!ja) { $('stuckJa').focus(); return; }
    draft.stucks.push({ ja, fix: $('stuckFix').value.trim() });
    $('stuckJa').value = '';
    $('stuckFix').value = '';
    $('stuckJa').focus();
    renderDraftLists();
  };
  $('stuckAdd').addEventListener('click', addStuck);
  $('stuckFix').addEventListener('keydown', (e) => { if (e.key === 'Enter') addStuck(); });

  const addWord = () => {
    const en = $('wordEn').value.trim();
    const ja = $('wordJa').value.trim();
    if (!en || !ja) { (en ? $('wordJa') : $('wordEn')).focus(); return; }
    draft.words.push({ en, ja });
    $('wordEn').value = '';
    $('wordJa').value = '';
    $('wordEn').focus();
    renderDraftLists();
  };
  $('wordAdd').addEventListener('click', addWord);
  $('wordJa').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWord(); });

  $('saveSession').addEventListener('click', saveSession);
  renderDraftLists();
  renderDeclared();
  renderTalkSeg();
}

function saveSession() {
  const lesson = Number($('logLesson').value);
  const declared = declaredPieces(lesson)
    .filter((p) => draft.pieceResults[p.id] === true || draft.pieceResults[p.id] === false)
    .map((p) => ({ id: p.id, en: firstLine(p.en), ok: draft.pieceResults[p.id] === true }));
  const session = {
    id: uid(),
    date: today(),
    rank: currentRank(),
    lesson,
    rating: draft.rating || 0,
    talkMin: draft.talkMin,
    declared,
    stucks: draft.stucks.slice(),
    words: draft.words.slice(),
    memo: $('memo').value.trim(),
    ai: draft.ai,
  };
  state.sessions.push(session);

  let made = 0;
  for (const s of session.stucks) {
    if (addCard(s.ja, s.fix, { lesson, kind: 'stuck' })) made += 1;
  }
  for (const w of session.words) {
    if (addCard(w.ja, w.en, { lesson, kind: 'word' })) made += 1;
  }
  const graduated = [];
  for (const d of declared) {
    const r = recordPieceResult(state, d.id, d.ok, session.date, lesson);
    if (r && r.graduatedNow) graduated.push(r.piece);
  }

  state.profile.lastLogLesson = Math.min(lesson + 1, lessons.length || 20);
  state.profile.lastPrepLesson = state.profile.lastLogLesson;
  save();

  draft.rating = 0;
  draft.talkMin = null;
  draft.pieceResults = {};
  draft.extraPieces = [];
  draft.stucks = [];
  draft.words = [];
  draft.ai = null;
  $('memo').value = '';
  $('aiPaste').value = '';
  $('aiResult').hidden = true;
  $('aiResult').replaceChildren();
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', 'false');
  fillLessonSelect($('logLesson'), state.profile.lastLogLesson);
  renderLogLesson();
  renderDraftLists();
  renderDeclared();
  renderTalkSeg();
  renderAll();

  const said = declared.filter((d) => d.ok).length;
  if (graduated.length) {
    toast(`🎓 ピース卒業: ${firstLine(graduated[0].en)}`);
    buzz([60, 80, 60, 80, 120]);
  } else {
    toast(`記録しました${said ? `（言えた ${said}）` : ''}${made ? `（カード ${made} 枚）` : ''}`);
    buzz(30);
  }
  setTimeout(() => switchView('prep'), graduated.length ? 1400 : 600);
}

// ---------------------------------------------------------------- 5分予習タブ

const prep = { running: false, stepIndex: 0, stepLeft: 0, totalLeft: PREP_TOTAL, timer: null, tickAt: 0, sentence: '', pieceId: null };

function renderSteps() {
  const box = $('stepList');
  box.replaceChildren();
  PREP_STEPS.forEach((s, i) => {
    const d = el('div', 'step');
    d.dataset.state = !prep.running && prep.totalLeft === PREP_TOTAL ? 'idle'
      : i < prep.stepIndex ? 'done' : i === prep.stepIndex ? 'active' : 'idle';
    d.appendChild(el('span', 'no', String(i + 1)));
    const body = el('div');
    body.appendChild(el('div', 'ttl', `${s.title}　${mmss(s.seconds)}`));
    body.appendChild(el('div', 'desc', s.desc));
    d.appendChild(body);
    box.appendChild(d);
  });
}

function cueBlock(main, sub) {
  const p = el('p', 'cue');
  p.appendChild(document.createTextNode(main));
  if (sub) {
    const s = el('span', 'ja', sub);
    p.appendChild(s);
  }
  return p;
}

function renderCues() {
  const box = $('cueBox');
  box.replaceChildren();
  const lesson = Number($('prepLesson').value);
  const l = lessonById.get(lesson);
  const idx = prep.running ? prep.stepIndex : -1;

  if (idx === -1) {
    box.appendChild(el('p', 'hint', '「5分はじめる」を押すと、ステップごとに読むものがここに出ます。'));
    return;
  }

  if (idx === 0) {
    const last = [...state.sessions].reverse().find((s) => s.stucks.length);
    if (!last) {
      box.appendChild(el('p', 'hint', 'まだ「詰まったこと」の記録がありません。ここは飛ばして次へ。'));
    } else {
      box.appendChild(el('p', 'hint', `Lesson ${last.lesson}（${jpDate(last.date)}）で詰まったこと`));
      for (const s of last.stucks.slice(0, 4)) box.appendChild(cueBlock(s.ja, s.fix || '（正しい言い方は未記入）'));
    }
  } else if (idx === 1) {
    if (!l || !l.keyPhrases.length) {
      box.appendChild(el('p', 'hint', 'この回は Key Phrases が登録されていません。教材を開いて音読してください。'));
    } else {
      for (const p of l.keyPhrases.slice(0, 8)) box.appendChild(cueBlock(p));
    }
  } else if (idx === 2) {
    const piece = prep.pieceId ? state.pieces.find((p) => p.id === prep.pieceId) : null;
    if (piece) {
      box.appendChild(el('p', 'hint', '日本語を見て、英語を声に出す。3回目は見ずに。今日のフリートークで、これを言う。'));
      const c = el('p', 'cue piece');
      c.appendChild(el('span', 'top', pieceLines(piece.ja).join('\n')));
      c.appendChild(el('span', 'en', pieceLines(piece.en).join('\n')));
      box.appendChild(c);
      const swap = el('button', 'ghost', '別のピースにする');
      swap.type = 'button';
      swap.addEventListener('click', () => {
        const next = pickTodayPiece(state, today(), prep.pieceId);
        if (next) { prep.pieceId = next.id; renderCues(); }
        else toast('練習中のピースはこれだけです');
      });
      box.appendChild(swap);
    } else {
      const first = l && l.keyPhrases.length ? l.keyPhrases[0] : 'I';
      box.appendChild(el('p', 'hint', `ピースがまだ無いので、代わりに1文。例: 「${first} …」から始めて、自分の話にする。「自分の話」タブでピースを作ると、ここに出ます。`));
      const ta = el('textarea');
      ta.id = 'prepSentence';
      ta.placeholder = '短くていい。主語と動詞だけでいい。';
      ta.value = prep.sentence;
      ta.addEventListener('input', () => { prep.sentence = ta.value; });
      box.appendChild(ta);
    }
  } else {
    const due = dueCards().slice(0, 3);
    if (!due.length) {
      box.appendChild(el('p', 'hint', '今日ぶんのカードはありません。ここも音読の続きに使ってしまって大丈夫です。'));
    } else {
      for (const c of due) {
        const d = el('details', 'log');
        const sm = el('summary', null, c.ja);
        const inner = el('div', 'inner');
        inner.appendChild(el('p', 'answer', c.en));
        d.append(sm, inner);
        box.appendChild(d);
      }
    }
  }
}

function paintTimer() {
  $('clock').textContent = mmss(prep.totalLeft);
  $('track').style.width = `${((PREP_TOTAL - prep.totalLeft) / PREP_TOTAL) * 100}%`;
  $('clockStep').textContent = prep.running
    ? `${prep.stepIndex + 1}/${PREP_STEPS.length}　${PREP_STEPS[prep.stepIndex].title}　あと ${mmss(prep.stepLeft)}`
    : prep.totalLeft === PREP_TOTAL ? 'タップして開始' : '一時停止中';
}

function advanceStep() {
  if (prep.stepIndex >= PREP_STEPS.length - 1) { finishPrep(); return; }
  // 残り時間はステップ境界に合わせ直す（早送りしたぶんは捨てる）
  prep.stepIndex += 1;
  prep.stepLeft = PREP_STEPS[prep.stepIndex].seconds;
  prep.totalLeft = PREP_STEPS.slice(prep.stepIndex).reduce((n, s) => n + s.seconds, 0);
  buzz([40, 60, 40]);
  renderSteps();
  renderCues();
  paintTimer();
}

function tick() {
  const now = Date.now();
  const delta = Math.max(0, (now - prep.tickAt) / 1000);
  prep.tickAt = now;
  prep.stepLeft -= delta;
  prep.totalLeft -= delta;
  if (prep.stepLeft <= 0) {
    if (prep.stepIndex >= PREP_STEPS.length - 1) { finishPrep(); return; }
    advanceStep();
    return;
  }
  paintTimer();
}

function startPrep() {
  prep.running = true;
  prep.stepIndex = 0;
  prep.stepLeft = PREP_STEPS[0].seconds;
  prep.totalLeft = PREP_TOTAL;
  prep.tickAt = Date.now();
  const piece = pickTodayPiece(state, today());
  prep.pieceId = piece ? piece.id : null;
  clearInterval(prep.timer);
  prep.timer = setInterval(tick, 250);
  $('prepStart').textContent = '❚❚ 一時停止';
  $('prepNext').disabled = false;
  $('prepReset').disabled = false;
  renderSteps();
  renderCues();
  paintTimer();
  buzz(30);
}

function pausePrep() {
  prep.running = false;
  clearInterval(prep.timer);
  $('prepStart').textContent = '▶ つづきから';
  paintTimer();
}

function resumePrep() {
  prep.running = true;
  prep.tickAt = Date.now();
  prep.timer = setInterval(tick, 250);
  $('prepStart').textContent = '❚❚ 一時停止';
  paintTimer();
}

function resetPrep(silent) {
  clearInterval(prep.timer);
  prep.running = false;
  prep.stepIndex = 0;
  prep.stepLeft = 0;
  prep.totalLeft = PREP_TOTAL;
  prep.sentence = '';
  prep.pieceId = null;
  $('prepStart').textContent = '▶ 5分はじめる';
  $('prepNext').disabled = true;
  $('prepReset').disabled = true;
  renderSteps();
  renderCues();
  paintTimer();
  if (!silent) toast('やめました');
}

function finishPrep() {
  const lesson = Number($('prepLesson').value);
  const pieceId = prep.pieceId;
  state.preps.push({ id: uid(), date: today(), rank: currentRank(), lesson, sentence: prep.sentence.trim(), pieceId: pieceId || null });
  save();
  resetPrep(true);
  renderDeclared();
  renderAll();
  toast(pieceId ? '5分やりきりました 🎉 宣言したピースは、レッスン後に「言えた」で回収' : '5分やりきりました 🎉');
  buzz([60, 80, 60, 80, 120]);
}

function renderPrepLesson() {
  const n = Number($('prepLesson').value);
  const l = lessonById.get(n);
  if (!l) return;
  $('prepTopic').textContent = l.keyPhrases.length
    ? `${l.topic} — ${l.keyPhrases.length} phrases`
    : `${l.topic} — Key Phrases 未登録`;
  const suggested = suggestedNextLesson();
  $('prepBadge').textContent = n === suggested ? '次回' : l.type === 'challenge' ? 'Challenge' : '復習';
  $('prepBadge').className = n === suggested ? 'badge ok' : 'badge';
  if (!prep.running) renderCues();
}

function setupPrepTab() {
  fillLessonSelect($('prepLesson'), suggestedNextLesson());
  renderPrepLesson();
  renderSteps();
  paintTimer();
  renderCues();

  $('prepLesson').addEventListener('change', () => {
    state.profile.lastPrepLesson = Number($('prepLesson').value);
    save();
    renderPrepLesson();
  });

  $('prepStart').addEventListener('click', () => {
    if (prep.running) pausePrep();
    else if (prep.totalLeft < PREP_TOTAL) resumePrep();
    else startPrep();
  });
  $('prepNext').addEventListener('click', advanceStep);
  $('prepReset').addEventListener('click', () => resetPrep(false));
}

// ---------------------------------------------------------------- 単語タブ

let queue = [];
let current = null;

function nextCard() {
  current = queue.shift() || null;
  const body = $('flashBody');
  const empty = $('flashEmpty');
  const controls = $('flashControls');
  const grade = $('flashGrade');

  if (!current) {
    body.hidden = true;
    empty.hidden = false;
    controls.hidden = true;
    grade.hidden = true;
    empty.innerHTML = state.cards.length
      ? '今日ぶんは終わりました 🎉<br>また明日、出番のカードが並びます。'
      : '今日ぶんのカードはありません。<br>レッスンを記録すると、詰まったことと単語がカードになります。';
    return;
  }

  empty.hidden = true;
  body.hidden = false;
  controls.hidden = false;
  grade.hidden = true;
  $('flashAnswer').hidden = true;
  $('flashPrompt').textContent = current.ja;
  $('flashAnswer').textContent = current.en;
  const src = current.source || {};
  $('flashMeta').textContent = `Lesson ${src.lesson ?? '-'} · ${src.kind === 'stuck' ? '詰まったこと' : '単語'} · box ${current.box}`;
}

function renderCards() {
  const due = dueCards();
  $('cardsStatus').textContent = state.cards.length
    ? `今日ぶん ${due.length} 枚 / 全部で ${state.cards.length} 枚`
    : 'まだカードがありません。';

  const dot = $('dueDot');
  dot.hidden = due.length === 0;
  dot.textContent = String(due.length);

  const list = $('allCards');
  list.replaceChildren();
  const recent = [...state.cards].reverse().slice(0, 30);
  if (!recent.length) {
    list.appendChild(el('p', 'empty', 'カードはまだありません。'));
  }
  for (const c of recent) {
    const li = el('li');
    const body = el('div', 'body');
    body.appendChild(el('div', 'ja', c.ja));
    body.appendChild(el('div', 'en', c.en));
    const meta = el('div', 'ja', `box ${c.box} · 次は ${jpDate(c.due)} · ${c.correct}/${c.seen}`);
    body.appendChild(meta);
    const del = el('button', 'icon', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', `${c.ja} のカードを消す`);
    del.addEventListener('click', () => {
      state.cards = state.cards.filter((x) => x.id !== c.id);
      queue = queue.filter((x) => x.id !== c.id);
      save();
      renderCards();
      renderHistory();
    });
    li.append(body, del);
    list.appendChild(li);
  }
}

function refillQueue() {
  const due = dueCards();
  const activeId = current ? current.id : null;
  queue = due.filter((c) => c.id !== activeId);
  if (!current) nextCard();
}

function setupCardsTab() {
  $('flashShow').addEventListener('click', () => {
    $('flashAnswer').hidden = false;
    $('flashControls').hidden = true;
    $('flashGrade').hidden = false;
  });
  $('gradeOk').addEventListener('click', () => {
    if (current) gradeCard(current, true);
    renderCards();
    renderHistory();
    nextCard();
  });
  $('gradeNg').addEventListener('click', () => {
    if (current) { gradeCard(current, false); queue.push(current); }
    renderCards();
    renderHistory();
    nextCard();
  });
}

// ---------------------------------------------------------------- 履歴タブ

function streakDays() {
  const days = new Set([...state.sessions.map((s) => s.date), ...state.preps.map((p) => p.date)]);
  if (!days.size) return 0;
  // 今日まだ何もしていなければ、昨日までの連続を数える
  let cursor = days.has(today()) ? today() : today(-1);
  if (!days.has(cursor)) return 0;
  let n = 0;
  while (days.has(cursor)) {
    n += 1;
    const d = new Date(`${cursor}T00:00:00`);
    d.setDate(d.getDate() - 1);
    cursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return n;
}

/** 今週（月曜はじまり）に何日動いたか。 */
function weekProgress() {
  const start = mondayOf(today());
  const days = new Set([...state.sessions.map((s) => s.date), ...state.preps.map((p) => p.date)].filter((d) => d >= start && d <= today()));
  return days.size;
}

const monthKey = (d) => d.slice(0, 7);

function renderMonthCard() {
  const m = monthKey(today());
  const sessions = state.sessions.filter((s) => monthKey(s.date) === m);
  const declared = sessions.flatMap((s) => s.declared || []);
  const said = declared.filter((d) => d.ok).length;
  const graduated = state.pieces.filter((p) => p.graduatedAt && monthKey(p.graduatedAt) === m).length;
  const real = state.real.filter((r) => monthKey(r.date) === m).length;
  const talk = sessions.reduce((n, s) => n + (s.talkMin || 0), 0);

  const stats = $('monthStats');
  stats.replaceChildren();
  const items = [
    [declared.length ? `${said}/${declared.length}` : '–', '言えた／宣言'],
    [String(graduated), '卒業ピース'],
    [String(real), '実戦'],
    [String(talk), 'フリートーク分'],
  ];
  for (const [n, k] of items) {
    const d = el('div', 'stat');
    d.appendChild(el('span', 'n', n));
    d.appendChild(el('span', 'k', k));
    stats.appendChild(d);
  }

  const withAi = sessions.filter((s) => s.ai && s.ai.summary_ja);
  const tq = withAi.flatMap((s) => s.ai.trainer_questions || []);
  const covered = tq.filter((q) => q.covered).length;
  const ratios = withAi
    .filter((s) => typeof s.ai.trainer_question_count === 'number' && s.ai.trainer_question_count > 0)
    .map((s) => (s.ai.learner_question_count || 0) / s.ai.trainer_question_count);
  const ratio = ratios.length ? (ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2) : null;
  const best = bestOf(state.samples);
  const bits = [];
  if (tq.length) bits.push(`質問カバー率 ${Math.round((covered / tq.length) * 100)}%（${covered}/${tq.length}）`);
  if (ratio !== null) bits.push(`質問の往復比 ${ratio}`);
  if (best) bits.push(`60秒サンプル 自己ベスト ${best.wpm} 語/分 · Level ${best.level}`);
  $('monthHint').textContent = bits.length ? bits.join('　') : 'AI フィードバックと60秒サンプルを使うと、質問カバー率・往復比・自己ベストがここに出ます。';

  const bestLine = (best && best.last && best.last.best_sentence)
    || (withAi.length && withAi[withAi.length - 1].ai.good && withAi[withAi.length - 1].ai.good[0])
    || '';
  $('monthBest').hidden = !bestLine;
  $('monthBest').textContent = bestLine ? `今月のベスト1文: ${bestLine}` : '';
}

function renderHistory() {
  $('stWeek').textContent = `${weekProgress()}/7`;
  $('stPieces').textContent = String(graduatedPieces(state).length);
  $('stReal').textContent = String(state.real.filter((r) => monthKey(r.date) === monthKey(today())).length);

  const seen = state.cards.reduce((n, c) => n + c.seen, 0);
  const ok = state.cards.reduce((n, c) => n + c.correct, 0);
  const bits = [`レッスン ${state.sessions.length} 回`, `5分予習 ${state.preps.length} 回`, `連続 ${streakDays()} 日`];
  if (seen) bits.push(`カード正答率 ${Math.round((ok / seen) * 100)}%`);
  $('historyHint').textContent = bits.join('・');
  renderMonthCard();

  const box = $('historyList');
  box.replaceChildren();
  const list = [...state.sessions].reverse();

  // まだ受けていないレッスンの予習で作った文は、受講記録が無いのでここに出す
  const recorded = new Set(state.sessions.map((s) => `${s.rank || 'C'}-${s.lesson}`));
  const ahead = state.preps.filter((p) => p.sentence && !recorded.has(`${p.rank || 'C'}-${p.lesson}`)).reverse();
  if (ahead.length) {
    const d = el('details', 'log');
    d.open = true;
    const sm = el('summary');
    sm.appendChild(document.createTextNode('予習で作った文'));
    sm.appendChild(el('span', 'when', 'まだ受けていないレッスン'));
    const inner = el('div', 'inner');
    for (const p of ahead.slice(0, 5)) inner.appendChild(cueBlock(p.sentence, `${lessonLabel(p.rank, p.lesson)} · ${jpDate(p.date)}`));
    d.append(sm, inner);
    box.appendChild(d);
  }

  if (!list.length) {
    if (!ahead.length) box.appendChild(el('p', 'empty', 'まだ記録がありません。'));
    return;
  }
  const RATING = { 3: '◎ 言えた', 2: '○ まあまあ', 1: '△ きつかった' };
  for (const s of list) {
    const l = lessonFor(s.rank, s.lesson);
    const d = el('details', 'log');
    const sm = el('summary');
    sm.appendChild(document.createTextNode(`${lessonLabel(s.rank, s.lesson)} ${l ? l.topic : ''}`));
    const extra = [];
    if (s.rating) extra.push(RATING[s.rating]);
    if (typeof s.talkMin === 'number') extra.push(`フリートーク ${s.talkMin}分${s.talkMin >= 20 ? '+' : ''}`);
    sm.appendChild(el('span', 'when', `${jpDate(s.date)}${extra.length ? ` · ${extra.join(' · ')}` : ''}`));
    const inner = el('div', 'inner');

    if (s.declared && s.declared.length) {
      inner.appendChild(el('h4', null, '宣言したピース'));
      for (const x of s.declared) inner.appendChild(cueBlock(`${x.ok ? '◎' : '△'} ${x.en}`, x.ok ? '見ずに言えた' : 'まだ'));
    }
    if (s.stucks.length) {
      inner.appendChild(el('h4', null, '詰まったこと'));
      for (const x of s.stucks) inner.appendChild(cueBlock(x.ja, x.fix || null));
    }
    if (s.words.length) {
      inner.appendChild(el('h4', null, '単語・フレーズ'));
      for (const w of s.words) inner.appendChild(cueBlock(w.en, w.ja));
    }
    if (s.memo) {
      inner.appendChild(el('h4', null, 'メモ'));
      inner.appendChild(el('p', 'hint', s.memo));
    }
    if (s.ai && s.ai.summary_ja) {
      inner.appendChild(el('h4', null, 'AI フィードバック'));
      inner.appendChild(cueBlock(s.ai.summary_ja, s.ai.next_focus_ja ? `次回: ${s.ai.next_focus_ja}` : null));
      if (s.ai.trainer_questions && s.ai.trainer_questions.length) {
        const covered = s.ai.trainer_questions.filter((q) => q.covered).length;
        inner.appendChild(el('p', 'hint', `聞かれた質問 ${s.ai.trainer_questions.length} 件、準備済みで答えられた ${covered} 件${typeof s.ai.learner_question_count === 'number' ? `・投げ返した質問 ${s.ai.learner_question_count} 回` : ''}`));
      }
      if (s.ai.cleaned_transcript) {
        const t = el('details', 'log');
        t.appendChild(el('summary', null, '文字起こしを見る'));
        const ti = el('div', 'inner');
        ti.appendChild(el('pre', 'transcript', s.ai.cleaned_transcript));
        t.appendChild(ti);
        inner.appendChild(t);
      }
    }
    const preps = state.preps.filter((p) => (p.rank || 'C') === (s.rank || 'C') && p.lesson === s.lesson && p.sentence);
    if (preps.length) {
      inner.appendChild(el('h4', null, '予習で作った文'));
      for (const p of preps) inner.appendChild(cueBlock(p.sentence, jpDate(p.date)));
    }
    if (!inner.children.length) inner.appendChild(el('p', 'hint', '受けた記録のみ。'));

    d.append(sm, inner);
    box.appendChild(d);
  }
}

function setupHistoryTab() {
  const keys = loadKeys();
  $('keyAnthropic').value = keys.anthropic;
  $('keyOpenai').value = keys.openai;
  $('saveKeys').addEventListener('click', () => {
    saveKeys({ anthropic: $('keyAnthropic').value.trim(), openai: $('keyOpenai').value.trim() });
    toast('キーを保存しました');
  });

  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `bizmates-log-${today()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('書き出しました');
  });

  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.sessions)) throw new Error('形式が違います');
      if (!confirm('いまの記録を、読み込むファイルの内容で置き換えます。よろしいですか？')) return;
      state = { ...blankState(), ...parsed, profile: { ...blankState().profile, ...(parsed.profile || {}) } };
      save();
      boot(true);
      toast('読み込みました');
    } catch (err) {
      console.warn(err);
      toast('読み込めませんでした');
    } finally {
      e.target.value = '';
    }
  });

  $('wipeBtn').addEventListener('click', () => {
    if (!confirm('この端末に保存された記録をすべて消します。元に戻せません。よろしいですか？')) return;
    state = blankState();
    localStorage.removeItem(STORAGE_KEY);
    boot(true);
    toast('消しました');
  });
}

// ---------------------------------------------------------------- タブ切り替え

function switchView(name) {
  for (const v of document.querySelectorAll('.view')) {
    v.hidden = v.id !== `view-${name}`;
  }
  for (const b of document.querySelectorAll('.nav button')) {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (name === 'cards') refillQueue();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function setupNav() {
  for (const b of document.querySelectorAll('.nav button')) {
    b.addEventListener('click', () => switchView(b.dataset.view));
  }
}

// ---------------------------------------------------------------- 起動

function renderAll() {
  renderCards();
  renderHistory();
  renderLogLesson();
  if (!prep.running) fillLessonSelect($('prepLesson'), suggestedNextLesson());
  renderPrepLesson();
  renderPieces();
  renderSampleSummary();
  renderSyncStatus();
}

function boot(isReload) {
  if (isReload) {
    applyRank(state.profile.rank);
    fillLessonSelect($('logLesson'), state.profile.lastLogLesson || 1);
    draft.rating = 0;
    draft.talkMin = null;
    draft.pieceResults = {};
    draft.extraPieces = [];
    draft.stucks = [];
    draft.words = [];
    renderDraftLists();
    renderTalkSeg();
    resetPrep(true);
    current = null;
    queue = [];
  }
  renderDeclared();
  renderAll();
  refillQueue();
}

// モジュールに渡す共通の道具。state は常に最新を返す関数で渡す（読み込み直しで差し替わるため）。
const ctx = {
  state: () => state,
  save, today, jpDate, uid, el, toast, buzz,
  getKeys: loadKeys,
  renderAll: () => renderAll(),
};

async function main() {
  load();
  try {
    await loadLessons();
  } catch (e) {
    console.error(e);
    toast('教材データを読み込めませんでした');
    ranks = [{
      rank: 'C', level: '1', total: 20,
      lessons: Array.from({ length: 20 }, (_, i) => ({ lesson: i + 1, rank: 'C', level: '1', topic: `Lesson ${i + 1}`, title: '', type: 'regular', keyPhrases: [] })),
    }];
    applyRank('C');
  }
  $('rankPick').addEventListener('change', () => switchRank($('rankPick').value));
  setupNav();
  setupLogTab();
  setupPrepTab();
  setupCardsTab();
  setupHistoryTab();
  setupPieces(ctx);
  setupSample(ctx);
  setupSync(ctx);
  setupAI({
    getContext() {
      const n = Number($('logLesson').value);
      const l = lessonById.get(n) || { topic: '', keyPhrases: [] };
      return {
        lesson: n, topic: l.topic, keyPhrases: l.keyPhrases, profile: LEARNER_PROFILE,
        declaredPieces: declaredPieces(n).map((p) => ({ id: p.id, en: p.en })),
        pieces: activePieces(state).concat(graduatedPieces(state)).map((p) => ({ id: p.id, en: p.en })),
      };
    },
    addStuck(item) { draft.stucks.push(item); renderDraftLists(); },
    addWord(item) { draft.words.push(item); renderDraftLists(); },
    setPendingAI(ai) { draft.ai = ai; },
    // AI が「宣言ピースを言えたか」を判定したら、回収ボタンに先に入れておく（本人が上書きできる）
    onPieceUse(results, declared) {
      for (const r of results) {
        const hit = declared.find((d) => firstLine(d.en) === r.piece || d.en.replace(/\n/g, ' / ').startsWith(r.piece));
        if (hit && draft.pieceResults[hit.id] === undefined) draft.pieceResults[hit.id] = !!r.used;
      }
      renderDeclared();
    },
    toast,
  });
  boot(false);
}

main();
