// Bizmates Log — レッスン後の記録と、次回の5分予習。
// 保存先は localStorage だけ。バックエンドもビルドも無し。

import { setupAI, loadKeys, saveKeys } from './ai.js';

const STORAGE_KEY = 'bizmates-log/v1';
// AI フィードバックの system prompt に渡す、自分についての最小限の事実（名前は入れない）
const LEARNER_PROFILE = 'Head of HR at a trading card company in Japan; team of seven; responsible for hiring and organization; also runs a new business; hobbies: running, cooking, working out.';
const PREP_STEPS = [
  { title: '前回つまずいたところ', seconds: 60, desc: '日本語を見て、英語を声に出す。出なければ答えを読む。' },
  { title: '今日の Key Phrases', seconds: 100, desc: '2回ずつ音読する。意味より先に口を慣らす。' },
  { title: '自分のことを1文', seconds: 80, desc: 'Key Phrase を1つ使って、自分の話にする。書いてから声に出す。' },
  { title: '単語カード', seconds: 60, desc: '日本語を見て英語。出なければ答えを見て、そのまま1回言う。' },
];
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

const blankState = () => ({
  version: 1,
  profile: { rank: 'C', level: '1', lastLogLesson: 1, lastPrepLesson: 1 },
  sessions: [],
  cards: [],
  preps: [],
});

let state = blankState();
let lessons = [];
let lessonById = new Map();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state = { ...blankState(), ...parsed, profile: { ...blankState().profile, ...(parsed.profile || {}) } };
      for (const k of ['sessions', 'cards', 'preps']) {
        if (!Array.isArray(state[k])) state[k] = [];
      }
    }
  } catch (e) {
    console.warn('保存データを読めませんでした', e);
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

async function loadLessons() {
  const res = await fetch('assets/data/lessons.json');
  if (!res.ok) throw new Error(`lessons.json: ${res.status}`);
  const data = await res.json();
  lessons = data.lessons || [];
  lessonById = new Map(lessons.map((l) => [l.lesson, l]));
  $('rankLine').textContent = `Level ${data.level} · Rank ${data.rank} · Lesson 1–${data.total}`;
}

function fillLessonSelect(select, selected) {
  select.replaceChildren();
  for (const l of lessons) {
    const o = el('option', null, `Lesson ${l.lesson}: ${l.topic}${l.type === 'challenge' ? '（Challenge）' : ''}`);
    o.value = String(l.lesson);
    select.appendChild(o);
  }
  select.value = String(selected);
}

/** 最後に記録したレッスンの次。まだ無ければ保存済みの選択値。 */
function suggestedNextLesson() {
  if (!state.sessions.length) return state.profile.lastPrepLesson || 1;
  const last = Math.max(...state.sessions.map((s) => s.lesson));
  return Math.min(last + 1, lessons.length || 20);
}

// ---------------------------------------------------------------- 記録タブ

const draft = { rating: 0, stucks: [], words: [], ai: null };

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
  $('logLessonBadge').textContent = l.type === 'challenge' ? 'Challenge' : `Rank ${l.rank}`;
  $('logLessonBadge').className = l.type === 'challenge' ? 'badge warn' : 'badge';
  const done = state.sessions.some((s) => s.lesson === n);
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
  });

  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      draft.rating = Number(b.dataset.rating);
      for (const other of document.querySelectorAll('.seg button')) {
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
}

function saveSession() {
  const lesson = Number($('logLesson').value);
  const session = {
    id: uid(),
    date: today(),
    lesson,
    rating: draft.rating || 0,
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

  state.profile.lastLogLesson = Math.min(lesson + 1, lessons.length || 20);
  state.profile.lastPrepLesson = state.profile.lastLogLesson;
  save();

  draft.rating = 0;
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
  renderAll();

  toast(made ? `記録しました（カード ${made} 枚）` : '記録しました');
  buzz(30);
  setTimeout(() => switchView('prep'), 600);
}

// ---------------------------------------------------------------- 5分予習タブ

const prep = { running: false, stepIndex: 0, stepLeft: 0, totalLeft: PREP_TOTAL, timer: null, tickAt: 0, sentence: '' };

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
    const first = l && l.keyPhrases.length ? l.keyPhrases[0] : 'I';
    box.appendChild(el('p', 'hint', `例: 「${first} …」から始めて、自分の仕事の話にする。`));
    const ta = el('textarea');
    ta.id = 'prepSentence';
    ta.placeholder = '短くていい。主語と動詞だけでいい。';
    ta.value = prep.sentence;
    ta.addEventListener('input', () => { prep.sentence = ta.value; });
    box.appendChild(ta);
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
  state.preps.push({ id: uid(), date: today(), lesson, sentence: prep.sentence.trim() });
  save();
  resetPrep(true);
  renderAll();
  toast('5分やりきりました 🎉');
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

function renderHistory() {
  $('stSessions').textContent = String(state.sessions.length);
  $('stCards').textContent = String(state.cards.length);
  $('stStreak').textContent = String(streakDays());

  const seen = state.cards.reduce((n, c) => n + c.seen, 0);
  const ok = state.cards.reduce((n, c) => n + c.correct, 0);
  $('historyHint').textContent = seen
    ? `カードの正答率 ${Math.round((ok / seen) * 100)}%（${ok}/${seen}）・5分予習 ${state.preps.length} 回`
    : `5分予習 ${state.preps.length} 回`;

  const box = $('historyList');
  box.replaceChildren();
  const list = [...state.sessions].reverse();

  // まだ受けていないレッスンの予習で作った文は、受講記録が無いのでここに出す
  const recorded = new Set(state.sessions.map((s) => s.lesson));
  const ahead = state.preps.filter((p) => p.sentence && !recorded.has(p.lesson)).reverse();
  if (ahead.length) {
    const d = el('details', 'log');
    d.open = true;
    const sm = el('summary');
    sm.appendChild(document.createTextNode('予習で作った文'));
    sm.appendChild(el('span', 'when', 'まだ受けていないレッスン'));
    const inner = el('div', 'inner');
    for (const p of ahead.slice(0, 5)) inner.appendChild(cueBlock(p.sentence, `Lesson ${p.lesson} · ${jpDate(p.date)}`));
    d.append(sm, inner);
    box.appendChild(d);
  }

  if (!list.length) {
    if (!ahead.length) box.appendChild(el('p', 'empty', 'まだ記録がありません。'));
    return;
  }
  const RATING = { 3: '◎ 言えた', 2: '○ まあまあ', 1: '△ きつかった' };
  for (const s of list) {
    const l = lessonById.get(s.lesson);
    const d = el('details', 'log');
    const sm = el('summary');
    sm.appendChild(document.createTextNode(`L${s.lesson} ${l ? l.topic : ''}`));
    sm.appendChild(el('span', 'when', `${jpDate(s.date)}${s.rating ? ` · ${RATING[s.rating]}` : ''}`));
    const inner = el('div', 'inner');

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
      if (s.ai.cleaned_transcript) {
        const t = el('details', 'log');
        t.appendChild(el('summary', null, '文字起こしを見る'));
        const ti = el('div', 'inner');
        ti.appendChild(el('pre', 'transcript', s.ai.cleaned_transcript));
        t.appendChild(ti);
        inner.appendChild(t);
      }
    }
    const preps = state.preps.filter((p) => p.lesson === s.lesson && p.sentence);
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
  fillLessonSelect($('prepLesson'), suggestedNextLesson());
  renderPrepLesson();
}

function boot(isReload) {
  if (isReload) {
    fillLessonSelect($('logLesson'), state.profile.lastLogLesson || 1);
    draft.rating = 0;
    draft.stucks = [];
    draft.words = [];
    renderDraftLists();
    resetPrep(true);
    current = null;
    queue = [];
  }
  renderAll();
  refillQueue();
}

async function main() {
  load();
  try {
    await loadLessons();
  } catch (e) {
    console.error(e);
    toast('教材データを読み込めませんでした');
    lessons = Array.from({ length: 20 }, (_, i) => ({
      lesson: i + 1, rank: 'C', level: '1', topic: `Lesson ${i + 1}`, title: '', type: 'regular', keyPhrases: [],
    }));
    lessonById = new Map(lessons.map((l) => [l.lesson, l]));
  }
  setupNav();
  setupLogTab();
  setupPrepTab();
  setupCardsTab();
  setupHistoryTab();
  setupAI({
    getContext() {
      const n = Number($('logLesson').value);
      const l = lessonById.get(n) || { topic: '', keyPhrases: [] };
      return { lesson: n, topic: l.topic, keyPhrases: l.keyPhrases, profile: LEARNER_PROFILE };
    },
    addStuck(item) { draft.stucks.push(item); renderDraftLists(); },
    addWord(item) { draft.words.push(item); renderDraftLists(); },
    setPendingAI(ai) { draft.ai = ai; },
    toast,
  });
  boot(false);
}

main();
