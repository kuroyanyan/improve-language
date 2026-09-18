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

/** 録音ハンドル（マイクだけ）。start() → stop() で Blob。60秒サンプルで使う（レッスンは createLessonRecorder）。 */
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

/**
 * レッスンの録音。相手の声（共有したタブの音）と自分の声（マイク）を1本に混ぜて録る。
 * 文字起こしは約23分を超える音声を受け付けないので、10分ごとに別のファイルに区切る。
 * 共有しなかったとき・タブの音声が付いていないときは、自分の声だけを録る。
 */
export function createLessonRecorder({ onTabEnded } = {}) {
  const h = { ctx: null, tracks: [], current: null, done: [], parts: [], timer: null, meter: null, tabHeard: false };
  const segmentMs = Number(window.__lessonSegmentMs) || 10 * 60 * 1000; // テストでだけ短くする

  function beginSegment(stream) {
    const mime = pickMime();
    const i = h.done.length;
    const chunks = [];
    const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
    r.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });
    h.done.push(new Promise((resolve) => {
      r.addEventListener('stop', () => { h.parts[i] = new Blob(chunks, { type: r.mimeType || mime || 'audio/webm' }); resolve(); }, { once: true });
    }));
    r.start(5000);
    h.current = r;
  }

  return {
    /** 録音を始める。tab は相手の声（タブの音）が入っているか。 */
    async start() {
      if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('このブラウザは録音に対応していません');
      h.ctx = new AudioContext();
      // 画面共有は押した直後でないと開けないので、マイクより先に頼む
      let shared = null;
      if (navigator.mediaDevices.getDisplayMedia) {
        const controller = window.CaptureController ? new CaptureController() : null;
        try {
          shared = await navigator.mediaDevices.getDisplayMedia({
            video: { displaySurface: 'browser', frameRate: 1 },
            audio: { suppressLocalAudioPlayback: false },
            systemAudio: 'include',
            selfBrowserSurface: 'exclude',
            surfaceSwitching: 'include',
            ...(controller ? { controller } : {}),
          });
          // 共有したタブに画面を切り替えない（カンペを見たまま）
          try { if (controller && controller.setFocusBehavior) controller.setFocusBehavior('no-focus-change'); } catch { /* 未対応は無視 */ }
        } catch {
          shared = null; // 共有をやめた → 自分の声だけ
        }
      }
      let mic;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) {
        if (shared) shared.getTracks().forEach((t) => t.stop());
        h.ctx.close();
        throw e;
      }
      const dest = h.ctx.createMediaStreamDestination();
      h.ctx.createMediaStreamSource(mic).connect(dest);
      h.tracks.push(...mic.getTracks());
      const tabAudio = shared && shared.getAudioTracks()[0];
      if (tabAudio) {
        const tab = h.ctx.createMediaStreamSource(new MediaStream([tabAudio]));
        tab.connect(dest);
        // 違うタブを選ぶと、無音のまま「相手の声あり」になる。一度でも鳴ったかを見張る
        const meter = h.ctx.createAnalyser();
        tab.connect(meter);
        const buf = new Float32Array(meter.fftSize);
        h.meter = setInterval(() => {
          meter.getFloatTimeDomainData(buf);
          if (Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length) > 0.01) { h.tabHeard = true; clearInterval(h.meter); }
        }, 500);
        tabAudio.addEventListener('ended', () => { if (onTabEnded) onTabEnded(); }, { once: true });
        h.tracks.push(...shared.getTracks());
      } else if (shared) {
        shared.getTracks().forEach((t) => t.stop()); // 音の付いていない共有は要らない
      }
      if (h.ctx.state === 'suspended') await h.ctx.resume();
      beginSegment(dest.stream);
      h.timer = setInterval(() => { const prev = h.current; beginSegment(dest.stream); prev.stop(); }, segmentMs);
      return { tab: !!tabAudio };
    },
    /** 止めて、区切ったファイル（録った順）と、共有したタブが一度でも鳴ったかを返す。 */
    async stop() {
      clearInterval(h.timer);
      clearInterval(h.meter);
      if (h.current && h.current.state !== 'inactive') h.current.stop();
      await Promise.all(h.done);
      h.tracks.forEach((t) => t.stop());
      if (h.ctx) await h.ctx.close();
      return { parts: h.parts.filter((b) => b && b.size), tabHeard: h.tabHeard };
    },
  };
}

const REC_IDLE_HINT = '押したら MyStage のタブを選び、「タブの音声も共有する」をオンに。相手の声と自分の声を一緒に録ります（音声は保存しません）。';
const rec = { handle: null, startedAt: 0, timer: null, parts: [], audio: null, tabEnded: false, tabSilent: false, transcript: '' };

function paintRecButton() {
  const b = $('kanpeRec');
  b.textContent = rec.handle ? '■ 録音を終えて記録へ' : '● 録音してレッスンを始める';
  b.setAttribute('aria-pressed', String(!!rec.handle));
}

/** 記録タブの状態表示。working の間は色を変えて、待ちなのが分かるようにする。 */
function sayStatus(text, working = false) {
  const el = $('aiStatus');
  el.textContent = text;
  el.classList.toggle('working', !!working);
}

/** 録音中なら止めて、記録タブで文字起こしに回せる状態にする。録音していなければ何もしない。 */
export async function finishLessonRecording() {
  if (!rec.handle) return;
  const handle = rec.handle;
  rec.handle = null;
  clearInterval(rec.timer);
  $('recLive').hidden = true;
  paintRecButton();
  $('kanpeRecHint').textContent = REC_IDLE_HINT;
  const { parts, tabHeard } = await handle.stop();
  rec.parts = parts;
  rec.transcript = '';
  // 共有したタブが一度も鳴らなければ、相手の声は入っていないものとして扱う（AI に相手の発話を推測させない）
  rec.tabSilent = rec.audio === 'both' && !tabHeard;
  if (rec.tabSilent) rec.audio = 'learner_only';
  const took = fmt(Date.now() - rec.startedAt);
  const voices = rec.audio === 'both' ? `相手の声あり${rec.tabEnded ? '・途中で共有が止まった' : ''}`
    : rec.tabSilent ? '相手の声が聞こえませんでした。共有したタブが違ったかもしれません・自分の声だけ' : '自分の声だけ';
  sayStatus(rec.parts.length
    ? `録音 ${took}（${voices}・${rec.parts.length}つに区切って文字起こしします）。「文字起こし → AI フィードバック」でどうぞ`
    : '音声が取れませんでした');
  $('aiRun').disabled = !(rec.parts.length || $('aiPaste').value.trim());
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
  const say = sayStatus;

  // カンペ画面の録音ボタン。録音中はもう一度押すと止めて記録へ
  $('kanpeRec').addEventListener('click', async () => {
    if (rec.handle) { await finishLessonRecording(); hooks.showLog(); return; }
    const btn = $('kanpeRec');
    btn.disabled = true;
    try {
      const handle = createLessonRecorder({
        onTabEnded: () => { rec.tabEnded = true; hooks.toast('相手の声の共有が止まりました。自分の声は録り続けています'); },
      });
      const { tab } = await handle.start();
      Object.assign(rec, { handle, startedAt: Date.now(), parts: [], audio: tab ? 'both' : 'learner_only', tabEnded: false, tabSilent: false, transcript: '' });
      $('kanpeRecHint').textContent = tab
        ? '録音中（相手の声と自分の声）。カンペを読んでいても続きます。終わったら下の「記録する」か、このボタンで止めます。'
        : '録音中（自分の声だけ）。相手の声は入っていません。入れるには一度止めて、MyStage のタブを選び「タブの音声も共有する」をオンに。';
      rec.timer = setInterval(() => {
        const live = $('recLive');
        live.hidden = false;
        live.textContent = `● 録音中 ${fmt(Date.now() - rec.startedAt)}`;
      }, 500);
    } catch (e) {
      $('kanpeRecHint').textContent = `録音を始められませんでした: ${e.message}`;
    } finally {
      btn.disabled = false;
      paintRecButton();
    }
  });

  $('aiPaste').addEventListener('input', () => {
    $('aiRun').disabled = !($('aiPaste').value.trim() || rec.parts.length);
  });

  $('aiRun').addEventListener('click', async () => {
    const ctx = hooks.getContext();
    $('aiRun').disabled = true;
    try {
      let transcript = $('aiPaste').value.trim();
      if (!transcript && rec.parts.length) {
        const texts = [];
        for (const [i, part] of rec.parts.entries()) {
          say(`文字起こし中… ${i + 1}/${rec.parts.length}（数十秒ずつ）`, true);
          texts.push(await transcribeBlob(part,
            `Online English lesson (Bizmates). A Japanese learner practices business English with a trainer. ` +
            `Mostly English; the learner occasionally speaks Japanese. Topic: ${ctx.topic}. ` +
            `Key phrases: ${ctx.keyPhrases.join('; ')}.`));
        }
        transcript = texts.join('\n').trim();
        rec.transcript = transcript;
        $('aiPaste').value = transcript;
      }
      if (!transcript) throw new Error('録音か文字起こしがありません');
      // 録音から作った文字起こしなら、相手の声が入っているかを AI に伝える（貼り付けたものは伝えない）
      const audio = rec.transcript && transcript === rec.transcript ? rec.audio : undefined;
      say('Claude がフィードバックを作成中…（1分ほど）', true);
      const fb = await getFeedback({ transcript, audio, ...ctx });
      if (hooks.autoFill) hooks.autoFill(fb);
      renderFeedback(fb, hooks, { readOnly: !!hooks.autoFill });
      hooks.setPendingAI({ ...fb, audio, raw_transcript_chars: transcript.length, at: new Date().toISOString() });
      if (hooks.onPieceUse && fb.piece_use && fb.piece_use.length) hooks.onPieceUse(fb.piece_use, ctx.declaredPieces || []);
      rec.parts = [];
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
