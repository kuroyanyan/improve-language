// 月1回の60秒サンプル — 毎回同じ3問に60秒で答え、自己ベストを更新していく。合否は無い。
// 録音 → 文字起こし（OpenAI） → 固定ルーブリックで採点（Claude）。語数/分は端末側で計算する。

import { callClaude, transcribeBlob, createRecorder, OYAMA_STYLE } from './ai.js';

export const SAMPLE_PROMPTS = [
  { en: 'Where did you grow up, and what was it like?', ja: 'どこで育った？ どんなところだった？' },
  { en: 'What do you like to do outside work?', ja: '仕事の外で好きなことは？' },
  { en: 'What have you been thinking about lately?', ja: '最近よく考えていることは？' },
];
export const SAMPLE_SECONDS = 60;
const MIN_DAYS_BETWEEN = 25;

const SAMPLE_SCHEMA = {
  type: 'object',
  properties: {
    level: {
      type: 'integer',
      description: '固定ルーブリック 1〜5。1 単語の羅列 / 2 短文が途切れ途切れ / 3 短文で言い切れる / 4 短文をつなげて30秒以上続く / 5 理由や気持ちを添え、質問も返せる',
    },
    level_reason_ja: { type: 'string', description: 'そのレベルにした理由。日本語で1〜2文' },
    total_sentences: { type: 'integer', description: '発話された文の数' },
    complete_sentences: { type: 'integer', description: '主語と動詞がそろって言い切れた文の数' },
    stuck_count: { type: 'integer', description: '言い直し・長い沈黙・日本語への逃げ・フィラー（uh, um, えー）の回数' },
    best_sentence: { type: 'string', description: 'いちばん良かった1文。原文のまま' },
    tip_ja: { type: 'string', description: '次の1回だけ意識すること。日本語で1つ' },
    cleaned_transcript: { type: 'string', description: '読みやすく整えた文字起こし。内容は変えない。自信が無い箇所は [?]' },
  },
  required: ['level', 'level_reason_ja', 'total_sentences', 'complete_sentences', 'stuck_count', 'best_sentence', 'tip_ja', 'cleaned_transcript'],
  additionalProperties: false,
};

export const countWords = (text) => (String(text || '').match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;

export function bestOf(samples) {
  if (!samples || !samples.length) return null;
  return {
    wpm: Math.max(...samples.map((s) => s.wpm || 0)),
    level: Math.max(...samples.map((s) => s.level || 0)),
    last: samples[samples.length - 1],
  };
}

async function scoreSample(transcript, key) {
  const system = [
    'You score a 60-second spoken self-introduction sample by a Japanese Level 1 English learner.',
    'The learner answered these three prompts in order: ' + SAMPLE_PROMPTS.map((p) => `"${p.en}"`).join(', ') + '.',
    'Use the fixed 1-5 rubric exactly as described in the schema. Be consistent across months: the same performance must get the same level.',
    'Count, do not guess: sentences, complete sentences, and stucks (restarts, long pauses, Japanese, fillers).',
    'Write Japanese notes plainly and positively, but do not inflate the level.',
    'When suggesting English, follow this style: ' + OYAMA_STYLE,
  ].join('\n');
  const user = `Transcript (ASR, learner only):\n"""\n${transcript}\n"""`;
  return callClaude({ system, user, schema: SAMPLE_SCHEMA, key, maxTokens: 3000 });
}

// ---------------------------------------------------------------- UI

let ctx = null;
const $ = (id) => document.getElementById(id);
const st = { rec: null, blob: null, seconds: 0, timer: null, stopAt: null, startedAt: 0 };

function daysBetween(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

function paintTimer(left) {
  const s = Math.max(0, Math.ceil(left));
  $('sampleTimer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setRunButtons() {
  $('sampleScore').disabled = !(st.blob || $('samplePaste').value.trim());
}

export function renderSampleSummary() {
  const state = ctx.state();
  const best = bestOf(state.samples);
  const status = $('sampleStatus');
  if (!best) {
    status.textContent = 'まだ記録がありません。最初の1回が「開始時の自分」になります。';
  } else {
    const gap = daysBetween(best.last.date, ctx.today());
    const next = gap >= MIN_DAYS_BETWEEN ? '次の1回、いつでもどうぞ。' : `次は ${MIN_DAYS_BETWEEN - gap} 日後くらいでOK。`;
    status.textContent = `自己ベスト ${best.wpm} 語/分 · Level ${best.level}　前回 ${ctx.jpDate(best.last.date)}。${next}`;
  }
  const list = $('sampleList');
  list.replaceChildren();
  for (const s of [...state.samples].reverse()) {
    const li = ctx.el('li');
    const body = ctx.el('div', 'body');
    body.appendChild(ctx.el('div', 'en', `${ctx.jpDate(s.date)} · ${s.wpm} 語/分 · Level ${s.level} · 詰まり ${s.stuck_count}`));
    if (s.best_sentence) body.appendChild(ctx.el('div', 'ja', `ベスト: ${s.best_sentence}`));
    if (s.tip_ja) body.appendChild(ctx.el('div', 'ja', `次: ${s.tip_ja}`));
    const del = ctx.el('button', 'icon', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', 'このサンプルを消す');
    del.addEventListener('click', () => {
      if (!confirm('このサンプルの記録を消しますか？')) return;
      state.samples = state.samples.filter((x) => x.id !== s.id);
      ctx.save();
      renderSampleSummary();
      ctx.renderAll();
    });
    li.append(body, del);
    list.appendChild(li);
  }
}

async function stopSample() {
  clearInterval(st.timer);
  clearTimeout(st.stopAt);
  const blob = st.rec ? await st.rec.stop() : null;
  st.rec = null;
  st.seconds = Math.min(SAMPLE_SECONDS, Math.round((Date.now() - st.startedAt) / 1000)) || SAMPLE_SECONDS;
  $('sampleStop').hidden = true;
  $('sampleRec').hidden = false;
  paintTimer(0);
  if (!blob || !blob.size) { $('sampleNote').textContent = '音声が取れませんでした'; return; }
  st.blob = blob;
  $('sampleSeconds').value = String(st.seconds);
  $('sampleNote').textContent = `録音 ${st.seconds} 秒。「採点する」でどうぞ`;
  setRunButtons();
}

export function setupSample(c) {
  ctx = c;
  const ol = $('samplePrompts');
  ol.replaceChildren();
  for (const p of SAMPLE_PROMPTS) {
    const li = ctx.el('li');
    li.appendChild(document.createTextNode(p.en));
    li.appendChild(ctx.el('span', 'ja', p.ja));
    ol.appendChild(li);
  }
  paintTimer(SAMPLE_SECONDS);

  $('sampleRec').addEventListener('click', async () => {
    try {
      st.rec = createRecorder();
      await st.rec.start();
      st.blob = null;
      st.startedAt = Date.now();
      $('sampleRec').hidden = true;
      $('sampleStop').hidden = false;
      $('sampleNote').textContent = '録音中。3問に順番に答える。止まっても言い直してOK';
      st.timer = setInterval(() => paintTimer(SAMPLE_SECONDS - (Date.now() - st.startedAt) / 1000), 250);
      st.stopAt = setTimeout(stopSample, SAMPLE_SECONDS * 1000);
      ctx.buzz(30);
    } catch (e) {
      $('sampleNote').textContent = `録音を始められませんでした: ${e.message}`;
    }
  });
  $('sampleStop').addEventListener('click', stopSample);
  $('samplePaste').addEventListener('input', setRunButtons);

  $('sampleScore').addEventListener('click', async () => {
    const keys = ctx.getKeys();
    const state = ctx.state();
    $('sampleScore').disabled = true;
    try {
      let transcript = $('samplePaste').value.trim();
      const seconds = Math.max(10, Math.min(180, Number($('sampleSeconds').value) || SAMPLE_SECONDS));
      if (!transcript) {
        $('sampleNote').textContent = '文字起こし中…';
        transcript = await transcribeBlob(st.blob, 'A Japanese learner answers three self-introduction questions in simple English. Mostly English.', keys.openai);
        $('samplePaste').value = transcript;
      }
      $('sampleNote').textContent = 'Claude が採点中…';
      const r = await scoreSample(transcript, keys.anthropic);
      const words = countWords(r.cleaned_transcript || transcript);
      const wpm = Math.round(words / (seconds / 60));
      const total = Math.max(1, r.total_sentences || 0);
      const sample = {
        id: ctx.uid(), date: ctx.today(), seconds, words, wpm,
        level: r.level, level_reason_ja: r.level_reason_ja,
        total_sentences: r.total_sentences, complete_sentences: r.complete_sentences,
        complete_ratio: Math.round(((r.complete_sentences || 0) / total) * 100) / 100,
        stuck_count: r.stuck_count, best_sentence: r.best_sentence, tip_ja: r.tip_ja,
        transcript: r.cleaned_transcript || transcript,
      };
      const prevBest = bestOf(state.samples);
      state.samples.push(sample);
      ctx.save();
      const box = $('sampleResult');
      box.hidden = false;
      box.replaceChildren();
      box.appendChild(ctx.el('p', 'best', `${wpm} 語/分 · Level ${r.level}`));
      box.appendChild(ctx.el('p', 'hint', `${r.level_reason_ja}　完全文 ${r.complete_sentences}/${r.total_sentences}・詰まり ${r.stuck_count}`));
      if (r.best_sentence) box.appendChild(ctx.el('p', 'cue', r.best_sentence));
      if (r.tip_ja) box.appendChild(ctx.el('p', 'hint', `次の1回: ${r.tip_ja}`));
      const isBest = !prevBest || wpm > prevBest.wpm || r.level > prevBest.level;
      $('sampleNote').textContent = isBest ? '自己ベスト更新 🎉 記録しました' : '記録しました。記録は減りません';
      ctx.toast(isBest ? '自己ベスト更新 🎉' : 'サンプルを記録しました');
      ctx.buzz(isBest ? [60, 80, 60, 80, 120] : 30);
      st.blob = null;
      $('samplePaste').value = '';
      renderSampleSummary();
      ctx.renderAll();
    } catch (e) {
      $('sampleNote').textContent = e.message;
    } finally {
      setRunButtons();
    }
  });

  renderSampleSummary();
}
