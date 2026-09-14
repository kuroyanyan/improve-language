// 録音 → 文字起こし → Claude によるフィードバック。
// API キーは localStorage の別キーに置き、記録データの書き出しには含めない。
// どちらの API もブラウザから直接呼ぶ（自分専用の静的サイト前提。キーは自分の端末にしか置かない）。

const KEYS_KEY = 'bizmates-log/keys';
const CLAUDE_MODEL = 'claude-opus-5';
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

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
    return { anthropic: '', openai: '', ...(JSON.parse(localStorage.getItem(KEYS_KEY) || '{}')) };
  } catch {
    return { anthropic: '', openai: '' };
  }
}

export function saveKeys(keys) {
  localStorage.setItem(KEYS_KEY, JSON.stringify({ anthropic: keys.anthropic || '', openai: keys.openai || '' }));
}

// ---------------------------------------------------------------- recorder

const rec = { recorder: null, chunks: [], stream: null, startedAt: 0, timer: null, blob: null, mime: '' };

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return cands.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('この端末のブラウザは録音に対応していません');
  rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  rec.mime = pickMime();
  rec.chunks = [];
  rec.blob = null;
  // 25分でも 6MB 前後に収まるよう低めのビットレートにする
  rec.recorder = new MediaRecorder(rec.stream, rec.mime ? { mimeType: rec.mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
  rec.recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); });
  rec.recorder.start(5000);
  rec.startedAt = Date.now();
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!rec.recorder) { resolve(null); return; }
    rec.recorder.addEventListener('stop', () => {
      rec.blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || rec.mime || 'audio/webm' });
      if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
      rec.recorder = null;
      rec.stream = null;
      resolve(rec.blob);
    }, { once: true });
    rec.recorder.stop();
  });
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- transcription (OpenAI)

async function transcribe(blob, ctx, key) {
  if (!key) throw new Error('OpenAI の API キーが未設定です（履歴タブ → AI設定）');
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`音声が大きすぎます（${(blob.size / 1048576).toFixed(1)}MB）。25MB 以下にしてください`);
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', blob, `lesson.${ext}`);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'json');
  // ASR に文脈を渡す。英語中心・日本語が混ざる・レッスンの語彙、を先に教えておくと混在の誤認識が減る
  form.append('prompt',
    `Online English lesson (Bizmates). A Japanese learner practices business English with a trainer. ` +
    `Mostly English; the learner occasionally speaks Japanese. Topic: ${ctx.topic}. ` +
    `Key phrases: ${ctx.keyPhrases.join('; ')}.`);

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
    next_focus_ja: { type: 'string', description: '次回いちばん意識すること、1つだけ（日本語）' },
    cleaned_transcript: {
      type: 'string',
      description: '話者（Trainer / Me）を分け、日英の誤認識を文脈から直した文字起こし。自信がない箇所は [?] を付ける。',
    },
  },
  required: ['summary_ja', 'good', 'corrections', 'stucks', 'words', 'key_phrase_use', 'next_focus_ja', 'cleaned_transcript'],
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
    'Write Japanese explanations plainly. Never use the abbreviation "JTC".',
    profile ? `Learner facts you may rely on: ${profile}` : '',
  ].filter(Boolean).join('\n');
}

async function getFeedback(transcript, ctx, key) {
  if (!key) throw new Error('Anthropic の API キーが未設定です（履歴タブ → AI設定）');
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system: systemPrompt(ctx.profile),
    messages: [{
      role: 'user',
      content:
        `Lesson ${ctx.lesson}: ${ctx.topic}\nKey phrases: ${ctx.keyPhrases.join(' / ')}\n\n` +
        `Raw transcript (ASR, unlabeled speakers, JA/EN mixed):\n"""\n${transcript}\n"""`,
    }],
    output_config: { format: { type: 'json_schema', schema: FEEDBACK_SCHEMA } },
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
  if (msg.stop_reason === 'refusal') throw new Error('フィードバックを生成できませんでした（refusal）');
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('フィードバックの形式が読めませんでした');
  }
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
