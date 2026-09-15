// 録音 → 文字起こし → Claude によるフィードバック。
// API キーは localStorage の別キーに置き、記録データの書き出しには含めない。
// どちらの API もブラウザから直接呼ぶ（自分専用の静的サイト前提。キーは自分の端末にしか置かない）。

const KEYS_KEY = 'bizmates-log/keys';
const CLAUDE_MODEL = 'claude-opus-5';
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

// 「大山スタイル」— 簡単な文法と広い意味の動詞で、聞き手の負荷を下げる英語。
// ピースの英語化・採点・FB の言い換えすべてに、この縛りをかける。
export const OYAMA_STYLE = [
  'Style rule ("simple spoken English"): use only very common words (the kind in the first 1,500 words of English).',
  'Prefer broad verbs like do, get, make, have, take, go, see, think, feel, like, want.',
  'One idea per sentence. Keep every sentence 12 words or fewer. Avoid relative clauses when you can.',
  'Contractions are fine. If a rarer word is really needed, keep it but flag it.',
].join(' ');

const DEFAULT_KEYS = { anthropic: '', openai: '', github_repo: 'kuroyanyan/improve-language-data', github_pat: '' };

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ---------------------------------------------------------------- keys

export function loadKeys() {
  try {
    return { ...DEFAULT_KEYS, ...(JSON.parse(localStorage.getItem(KEYS_KEY) || '{}')) };
  } catch {
    return { ...DEFAULT_KEYS };
  }
}

/** 渡したキーだけ上書きし、他は保持する（AI キーと同期設定が別々に保存できるように）。 */
export function saveKeys(keys) {
  const cur = loadKeys();
  const next = { ...cur };
  for (const k of Object.keys(DEFAULT_KEYS)) {
    if (k in keys) next[k] = keys[k] || '';
  }
  localStorage.setItem(KEYS_KEY, JSON.stringify(next));
}

// ---------------------------------------------------------------- recorder

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return cands.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

/** 録音ハンドル。start() → stop() で Blob。レッスン録音と60秒サンプルの両方で使う。 */
export function createRecorder() {
  const h = { recorder: null, chunks: [], stream: null, mime: '' };
  return {
    async start() {
      if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('この端末のブラウザは録音に対応していません');
      h.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      h.mime = pickMime();
      h.chunks = [];
      // 25分でも 6MB 前後に収まるよう低めのビットレートにする
      h.recorder = new MediaRecorder(h.stream, h.mime ? { mimeType: h.mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
      h.recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) h.chunks.push(e.data); });
      h.recorder.start(5000);
    },
    stop() {
      return new Promise((resolve) => {
        if (!h.recorder) { resolve(null); return; }
        h.recorder.addEventListener('stop', () => {
          const blob = new Blob(h.chunks, { type: h.recorder.mimeType || h.mime || 'audio/webm' });
          if (h.stream) h.stream.getTracks().forEach((t) => t.stop());
          h.recorder = null;
          h.stream = null;
          resolve(blob);
        }, { once: true });
        h.recorder.stop();
      });
    },
  };
}

const rec = { handle: null, startedAt: 0, timer: null, blob: null };

async function startRecording() {
  rec.handle = createRecorder();
  await rec.handle.start();
  rec.blob = null;
  rec.startedAt = Date.now();
}

async function stopRecording() {
  if (!rec.handle) return null;
  rec.blob = await rec.handle.stop();
  rec.handle = null;
  return rec.blob;
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- transcription (OpenAI)

/** 音声 Blob を文字起こしする。promptText は ASR に渡す文脈（英語中心・語彙など）。 */
export async function transcribeBlob(blob, promptText, key) {
  if (!key) throw new Error('OpenAI の API キーが未設定です（履歴タブ → AI設定）');
  if (!blob) throw new Error('音声がありません');
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`音声が大きすぎます（${(blob.size / 1048576).toFixed(1)}MB）。25MB 以下にしてください`);
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', blob, `audio.${ext}`);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'json');
  form.append('prompt', promptText);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`文字起こしに失敗（${res.status}）${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.text) throw new Error('文字起こし結果が空でした');
  return data.text;
}

function transcribe(blob, ctx, key) {
  // ASR に文脈を渡す。英語中心・日本語が混ざる・レッスンの語彙、を先に教えておくと混在の誤認識が減る
  return transcribeBlob(blob,
    `Online English lesson (Bizmates). A Japanese learner practices business English with a trainer. ` +
    `Mostly English; the learner occasionally speaks Japanese. Topic: ${ctx.topic}. ` +
    `Key phrases: ${ctx.keyPhrases.join('; ')}.`, key);
}

// ---------------------------------------------------------------- feedback (Claude)

const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    summary_ja: { type: 'string', description: '日本語で3文以内の総評。前向きに、でも具体的に。' },
    good: { type: 'array', items: { type: 'string' }, description: 'よかった点（日本語、2〜3個）' },
    corrections: {
      type: 'array',
      description: '学習者の発話で直したい表現。多くても6個。簡単で短い言い換えにする。',
      items: {
        type: 'object',
        properties: {
          said: { type: 'string', description: '学習者が実際に言った（と思われる）英語' },
          better: { type: 'string', description: 'より自然で、かつ学習者のレベルで言える短い英語' },
          why_ja: { type: 'string', description: '一言の理由（日本語）' },
        },
        required: ['said', 'better', 'why_ja'],
        additionalProperties: false,
      },
    },
    stucks: {
      type: 'array',
      description: '学習者が言葉に詰まった・日本語に逃げた・言い直した箇所。多くても5個。',
      items: {
        type: 'object',
        properties: {
          ja: { type: 'string', description: '言いたかったこと（日本語）' },
          en: { type: 'string', description: 'そのまま使える短い英文' },
        },
        required: ['ja', 'en'],
        additionalProperties: false,
      },
    },
    words: {
      type: 'array',
      description: 'このレッスンで覚える価値のある語・フレーズ。多くても6個。',
      items: {
        type: 'object',
        properties: {
          en: { type: 'string' },
          ja: { type: 'string' },
        },
        required: ['en', 'ja'],
        additionalProperties: false,
      },
    },
    key_phrase_use: {
      type: 'array',
      description: '今日の Key Phrases を学習者が使えたか',
      items: {
        type: 'object',
        properties: {
          phrase: { type: 'string' },
          used: { type: 'boolean' },
          example: { type: 'string', description: '使えていればその発話、使えていなければ次に言うための例文' },
        },
        required: ['phrase', 'used', 'example'],
        additionalProperties: false,
      },
    },
    piece_use: {
      type: 'array',
      description: '学習者が予習で宣言した「自分の話」ピースを、見ずに言えたか。宣言が無ければ空。',
      items: {
        type: 'object',
        properties: {
          piece: { type: 'string', description: '宣言ピースの最初の1文（渡されたものをそのまま）' },
          used: { type: 'boolean', description: 'そのピースの内容をおおむね言えていれば true' },
          how_ja: { type: 'string', description: '一言（日本語）。どこまで言えたか、どこで止まったか' },
        },
        required: ['piece', 'used', 'how_ja'],
        additionalProperties: false,
      },
    },
    trainer_questions: {
      type: 'array',
      description: 'トレーナーが学習者に聞いた質問（自己紹介・意見・経験を尋ねるもの）。多くても8個。',
      items: {
        type: 'object',
        properties: {
          q_en: { type: 'string' },
          q_ja: { type: 'string' },
          covered: { type: 'boolean', description: '準備済みの自分の話（ピース）で、止まらずに答えられていれば true' },
        },
        required: ['q_en', 'q_ja', 'covered'],
        additionalProperties: false,
      },
    },
    trainer_question_count: { type: 'integer', description: 'トレーナーが学習者に投げた質問の総数' },
    learner_question_count: { type: 'integer', description: '学習者がトレーナーに投げ返した質問の総数' },
    next_focus_ja: { type: 'string', description: '次回いちばん意識すること、1つだけ（日本語）' },
    cleaned_transcript: {
      type: 'string',
      description: '話者（Trainer / Me）を分け、日英の誤認識を文脈から直した文字起こし。自信がない箇所は [?] を付ける。',
    },
  },
  required: ['summary_ja', 'good', 'corrections', 'stucks', 'words', 'key_phrase_use', 'piece_use', 'trainer_questions',
    'trainer_question_count', 'learner_question_count', 'next_focus_ja', 'cleaned_transcript'],
  additionalProperties: false,
};

function systemPrompt(profile) {
  return [
    'You are an English coach reviewing a transcript of a Bizmates online lesson (Level 1).',
    'The learner is a Japanese HR manager whose goal is to work across countries in English, not to pass a test.',
    'Coach toward natural, simple business English the learner can actually say tomorrow.',
    '',
    'About the transcript: it comes from automatic speech recognition on mixed Japanese/English audio.',
    'Japanese words are often mis-recognized as English and vice versa, and the two speakers are not labeled.',
    'Use the lesson topic and key phrases as context to reconstruct what was most likely said.',
    'Where you cannot tell, keep it short and mark [?] rather than inventing content.',
    '',
    'Keep every suggested English sentence extremely simple and short (Level 1 learner).',
    OYAMA_STYLE,
    'The learner also prepares "pieces": short self-introduction units (3 sentences + 1 question back).',
    'Count questions carefully: trainer_question_count = questions the trainer asked the learner; learner_question_count = questions the learner asked back.',
    'Write Japanese explanations plainly. Never use the abbreviation "JTC".',
    profile ? `Learner facts you may rely on: ${profile}` : '',
  ].filter(Boolean).join('\n');
}

/** Claude を構造化出力で呼ぶ共通関数。schema は JSON Schema（object）。 */
export async function callClaude({ system, user, schema, key, maxTokens = 4000 }) {
  if (!key) throw new Error('Anthropic の API キーが未設定です（履歴タブ → AI設定）');
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
    // 安全分類で止まった場合にサーバー側で別モデルへ引き継ぐ
    fallbacks: 'default',
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Claude の呼び出しに失敗（${res.status}）${t.slice(0, 200)}`);
  }
  const msg = await res.json();
  if (msg.stop_reason === 'refusal') throw new Error('生成できませんでした（refusal）');
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('応答の形式が読めませんでした');
  }
}

function getFeedback(transcript, ctx, key) {
  const declared = (ctx.declaredPieces || []).map((p) => `- ${p.en.replace(/\n/g, ' / ')}`).join('\n');
  const all = (ctx.pieces || []).map((p) => `- ${p.en.replace(/\n/g, ' / ')}`).join('\n');
  const user =
    `Lesson ${ctx.lesson}: ${ctx.topic}\nKey phrases: ${ctx.keyPhrases.join(' / ')}\n\n` +
    (declared ? `Pieces the learner declared to say in this lesson:\n${declared}\n\n` : 'Pieces declared for this lesson: none\n\n') +
    (all ? `All prepared pieces (for judging "covered"):\n${all}\n\n` : '') +
    `Raw transcript (ASR, unlabeled speakers, JA/EN mixed):\n"""\n${transcript}\n"""`;
  return callClaude({ system: systemPrompt(ctx.profile), user, schema: FEEDBACK_SCHEMA, key, maxTokens: 16000 });
}

// ---------------------------------------------------------------- UI

/**
 * hooks:
 *   getContext()           -> { lesson, topic, keyPhrases, profile }
 *   addStuck({ja, fix})    -> 記録ドラフトへ
 *   addWord({en, ja})      -> 記録ドラフトへ
 *   setPendingAI(obj|null) -> セッション保存時に一緒に入れる
 *   toast(msg)
 */
export function setupAI(hooks) {
  const status = $('aiStatus');
  const say = (m) => { status.textContent = m; };

  // --- 録音
  $('recStart').addEventListener('click', async () => {
    try {
      await startRecording();
      $('recStart').hidden = true;
      $('recStop').hidden = false;
      say('録音中… レッスンが終わったら停止を押す');
      rec.timer = setInterval(() => { $('recClock').textContent = fmt(Date.now() - rec.startedAt); }, 500);
    } catch (e) {
      say(`録音を始められませんでした: ${e.message}`);
    }
  });

  $('recStop').addEventListener('click', async () => {
    clearInterval(rec.timer);
    const blob = await stopRecording();
    $('recStop').hidden = true;
    $('recStart').hidden = false;
    if (!blob || !blob.size) { say('音声が取れませんでした'); return; }
    $('recSave').hidden = false;
    $('aiRun').disabled = false;
    say(`録音 ${fmt(Date.now() - rec.startedAt)}・${(blob.size / 1048576).toFixed(1)}MB。「文字起こし → AI FB」でどうぞ`);
  });

  $('recSave').addEventListener('click', () => {
    if (!rec.blob) return;
    const url = URL.createObjectURL(rec.blob);
    const a = el('a');
    a.href = url;
    a.download = `bizmates-L${hooks.getContext().lesson}-${new Date().toISOString().slice(0, 10)}.${rec.blob.type.includes('mp4') ? 'm4a' : 'webm'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // --- 貼り付け（Notion などの文字起こしをそのまま使う）
  $('aiPaste').addEventListener('input', () => {
    $('aiRun').disabled = !($('aiPaste').value.trim() || rec.blob);
  });

  // --- 実行
  $('aiRun').addEventListener('click', async () => {
    const keys = loadKeys();
    const ctx = hooks.getContext();
    $('aiRun').disabled = true;
    try {
      let transcript = $('aiPaste').value.trim();
      if (!transcript) {
        say('文字起こし中…（数十秒）');
        transcript = await transcribe(rec.blob, ctx, keys.openai);
        $('aiPaste').value = transcript;
      }
      say('Claude がフィードバックを作成中…（1分ほど）');
      const fb = await getFeedback(transcript, ctx, keys.anthropic);
      renderFeedback(fb, hooks);
      hooks.setPendingAI({ ...fb, raw_transcript_chars: transcript.length, model: CLAUDE_MODEL, at: new Date().toISOString() });
      if (hooks.onPieceUse && fb.piece_use && fb.piece_use.length) hooks.onPieceUse(fb.piece_use, ctx.declaredPieces || []);
      say('できました。使うものを「＋」で記録に入れてください');
      hooks.toast('AI フィードバック完了');
    } catch (e) {
      say(e.message);
    } finally {
      $('aiRun').disabled = false;
    }
  });
}

function section(title) {
  const h = el('h4', null, title);
  return h;
}

function pairRow(main, sub, onAdd, addLabel) {
  const li = el('li');
  const body = el('div', 'body');
  body.appendChild(el('div', 'en', main));
  if (sub) body.appendChild(el('div', 'ja', sub));
  li.appendChild(body);
  if (onAdd) {
    const b = el('button', 'icon', addLabel || '＋');
    b.type = 'button';
    b.addEventListener('click', () => { onAdd(); b.textContent = '✓'; b.disabled = true; });
    li.appendChild(b);
  }
  return li;
}

export function renderFeedback(fb, hooks, { readOnly = false } = {}) {
  const box = $('aiResult');
  box.replaceChildren();
  box.hidden = false;

  box.appendChild(el('p', 'cue', fb.summary_ja));

  if (fb.good && fb.good.length) {
    box.appendChild(section('よかった点'));
    const ul = el('ul', 'items');
    for (const g of fb.good) ul.appendChild(pairRow(g));
    box.appendChild(ul);
  }

  if (fb.stucks && fb.stucks.length) {
    box.appendChild(section('詰まっていた箇所 → 記録へ'));
    const ul = el('ul', 'items');
    for (const s of fb.stucks) {
      ul.appendChild(pairRow(s.ja, s.en, readOnly ? null : () => hooks.addStuck({ ja: s.ja, fix: s.en })));
    }
    box.appendChild(ul);
  }

  if (fb.corrections && fb.corrections.length) {
    box.appendChild(section('こう言うともっと自然'));
    const ul = el('ul', 'items');
    for (const c of fb.corrections) {
      ul.appendChild(pairRow(c.better, `${c.said} — ${c.why_ja}`, readOnly ? null : () => hooks.addStuck({ ja: c.why_ja, fix: c.better })));
    }
    box.appendChild(ul);
  }

  if (fb.words && fb.words.length) {
    box.appendChild(section('覚える語・フレーズ → 記録へ'));
    const ul = el('ul', 'items');
    for (const w of fb.words) {
      ul.appendChild(pairRow(w.en, w.ja, readOnly ? null : () => hooks.addWord({ en: w.en, ja: w.ja })));
    }
    box.appendChild(ul);
  }

  if (fb.piece_use && fb.piece_use.length) {
    box.appendChild(section('宣言したピースは言えたか'));
    const ul = el('ul', 'items');
    for (const p of fb.piece_use) {
      ul.appendChild(pairRow(`${p.used ? '✓' : '△'} ${p.piece}`, p.how_ja));
    }
    box.appendChild(ul);
  }

  if (fb.trainer_questions && fb.trainer_questions.length) {
    box.appendChild(section('聞かれた質問 → 準備済みで答えられたか'));
    const ul = el('ul', 'items');
    for (const q of fb.trainer_questions) {
      ul.appendChild(pairRow(`${q.covered ? '✓' : '△'} ${q.q_en}`, q.q_ja));
    }
    box.appendChild(ul);
  }
  if (typeof fb.trainer_question_count === 'number' || typeof fb.learner_question_count === 'number') {
    box.appendChild(el('p', 'hint', `質問の往復: あなたから ${fb.learner_question_count ?? 0} 回 / トレーナーから ${fb.trainer_question_count ?? 0} 回`));
  }

  if (fb.key_phrase_use && fb.key_phrase_use.length) {
    box.appendChild(section('Key Phrases は使えたか'));
    const ul = el('ul', 'items');
    for (const k of fb.key_phrase_use) {
      ul.appendChild(pairRow(`${k.used ? '✓' : '△'} ${k.phrase}`, k.example));
    }
    box.appendChild(ul);
  }

  if (fb.next_focus_ja) {
    box.appendChild(section('次回はこれ一つ'));
    box.appendChild(el('p', 'cue', fb.next_focus_ja));
  }

  if (fb.cleaned_transcript) {
    const d = el('details', 'log');
    d.appendChild(el('summary', null, '整理済みの文字起こしを見る'));
    const inner = el('div', 'inner');
    const pre = el('pre', 'transcript', fb.cleaned_transcript);
    inner.appendChild(pre);
    d.appendChild(inner);
    box.appendChild(d);
  }
}
