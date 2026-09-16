// 録音と、裏方への受け渡し。API キーはこのアプリには無い（サーバーの環境変数にある）。

import { apiSend, apiAudio } from './api.js';

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

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

// ---------------------------------------------------------------- 裏方への受け渡し

/** 音声を文字起こしする。promptText は認識の手がかり（レッスンの語彙など）。 */
export async function transcribeBlob(blob, promptText) {
  if (!blob) throw new Error('音声がありません');
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`音声が大きすぎます（${(blob.size / 1048576).toFixed(1)}MB）。25MB 以下にしてください`);
  const r = await apiAudio('/api/transcribe', blob, promptText);
  return r.text;
}

export const getFeedback = (payload) => apiSend('/api/ai/feedback', payload);
export const pieceToEnglish = (payload) => apiSend('/api/ai/piece', payload);
export const scoreSample = (payload) => apiSend('/api/ai/sample', payload);

// ---------------------------------------------------------------- UI

/**
 * hooks:
 *   getContext()           -> { lesson, topic, keyPhrases, declaredPieces, pieces }
 *   addStuck({ja, fix})    -> 記録ドラフトへ
 *   addWord({en, ja})      -> 記録ドラフトへ
 *   autoFill(fb)           -> AI の結果を下書きに自動反映
 *   setPendingAI(obj|null) -> セッション保存時に一緒に入れる
 *   onPieceUse(results, declared)
 *   toast(msg)
 */
export function setupAI(hooks) {
  const status = $('aiStatus');
  const say = (m) => { status.textContent = m; };

  $('recStart').addEventListener('click', async () => {
    try {
      await startRecording();
      $('recStart').hidden = true;
      $('recStop').hidden = false;
      say('録音中… レッスンが終わったら停止を押す。カンペを見に行っても録音は続きます');
      rec.timer = setInterval(() => {
        const t = fmt(Date.now() - rec.startedAt);
        $('recClock').textContent = t;
        const live = $('recLive');
        if (live) { live.hidden = false; live.textContent = `● 録音中 ${t}`; }
      }, 500);
    } catch (e) {
      say(`録音を始められませんでした: ${e.message}`);
    }
  });

  $('recStop').addEventListener('click', async () => {
    clearInterval(rec.timer);
    const live = $('recLive');
    if (live) live.hidden = true;
    const blob = await stopRecording();
    $('recStop').hidden = true;
    $('recStart').hidden = false;
    if (!blob || !blob.size) { say('音声が取れませんでした'); return; }
    $('recSave').hidden = false;
    $('aiRun').disabled = false;
    say(`録音 ${fmt(Date.now() - rec.startedAt)}・${(blob.size / 1048576).toFixed(1)}MB。「文字起こし → AI フィードバック」でどうぞ`);
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

  $('aiPaste').addEventListener('input', () => {
    $('aiRun').disabled = !($('aiPaste').value.trim() || rec.blob);
  });

  $('aiRun').addEventListener('click', async () => {
    const ctx = hooks.getContext();
    $('aiRun').disabled = true;
    try {
      let transcript = $('aiPaste').value.trim();
      if (!transcript) {
        say('文字起こし中…（数十秒）');
        transcript = await transcribeBlob(rec.blob,
          `Online English lesson (Bizmates). A Japanese learner practices business English with a trainer. ` +
          `Mostly English; the learner occasionally speaks Japanese. Topic: ${ctx.topic}. ` +
          `Key phrases: ${ctx.keyPhrases.join('; ')}.`);
        $('aiPaste').value = transcript;
      }
      say('Claude がフィードバックを作成中…（1分ほど）');
      const fb = await getFeedback({ transcript, ...ctx });
      if (hooks.autoFill) hooks.autoFill(fb);
      renderFeedback(fb, hooks, { readOnly: !!hooks.autoFill });
      hooks.setPendingAI({ ...fb, raw_transcript_chars: transcript.length, at: new Date().toISOString() });
      if (hooks.onPieceUse && fb.piece_use && fb.piece_use.length) hooks.onPieceUse(fb.piece_use, ctx.declaredPieces || []);
      say('できました。詰まり・単語は下の「記録に入るもの」に入れました。要らないものは ✕ で外して保存');
      hooks.toast('AI フィードバック完了');
    } catch (e) {
      say(e.message);
    } finally {
      $('aiRun').disabled = false;
    }
  });
}

function section(title) {
  return el('h4', null, title);
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
    box.appendChild(section(readOnly ? '詰まっていた箇所（記録に入れました）' : '詰まっていた箇所 → 記録へ'));
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
    box.appendChild(section(readOnly ? '覚える語・フレーズ（記録に入れました）' : '覚える語・フレーズ → 記録へ'));
    const ul = el('ul', 'items');
    for (const w of fb.words) {
      ul.appendChild(pairRow(w.en, w.ja, readOnly ? null : () => hooks.addWord({ en: w.en, ja: w.ja })));
    }
    box.appendChild(ul);
  }

  if (fb.piece_use && fb.piece_use.length) {
    box.appendChild(section('宣言したピースは言えたか'));
    const ul = el('ul', 'items');
    for (const p of fb.piece_use) ul.appendChild(pairRow(`${p.used ? '✓' : '△'} ${p.piece}`, p.how_ja));
    box.appendChild(ul);
  }

  if (fb.trainer_questions && fb.trainer_questions.length) {
    box.appendChild(section('聞かれた質問 → 準備済みで答えられたか'));
    const ul = el('ul', 'items');
    for (const q of fb.trainer_questions) ul.appendChild(pairRow(`${q.covered ? '✓' : '△'} ${q.q_en}`, q.q_ja));
    box.appendChild(ul);
  }
  if (typeof fb.trainer_question_count === 'number' || typeof fb.learner_question_count === 'number') {
    box.appendChild(el('p', 'hint', `質問の往復: あなたから ${fb.learner_question_count ?? 0} 回 / トレーナーから ${fb.trainer_question_count ?? 0} 回`));
  }

  if (fb.key_phrase_use && fb.key_phrase_use.length) {
    box.appendChild(section('Key Phrases は使えたか'));
    const ul = el('ul', 'items');
    for (const k of fb.key_phrase_use) ul.appendChild(pairRow(`${k.used ? '✓' : '△'} ${k.phrase}`, k.example));
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
    inner.appendChild(el('pre', 'transcript', fb.cleaned_transcript));
    d.appendChild(inner);
    box.appendChild(d);
  }
}
