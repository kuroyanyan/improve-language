// 自分史ピース — 「自分の話」を 3文＋投げ返し1問 の単位で持つ。
// 書いた時点では数えない。レッスンのフリートークで見ずに言えたら 1 回。別の日に 3 回言えたら卒業。
// 英語化は「大山スタイル」（基本語・広い動詞・1文12語以下・1文1意）で Claude に縛りをかける。

import { callClaude, OYAMA_STYLE } from './ai.js';

export const PIECE_CATS = [
  { id: 'origin', ja: '育ち・住まい' },
  { id: 'work', ja: '仕事' },
  { id: 'like', ja: '好きなこと' },
  { id: 'lately', ja: '最近考えていること' },
  { id: 'recent', ja: '昨日・週末・予定' },
  { id: 'future', ja: 'これから' },
  { id: 'other', ja: 'その他' },
];
export const GRADUATE_AT = 3;

export const catJa = (id) => (PIECE_CATS.find((c) => c.id === id) || PIECE_CATS[PIECE_CATS.length - 1]).ja;
export const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
export const firstLine = (s) => lines(s)[0] || '';

export function okDates(p) { return new Set((p.uses || []).filter((u) => u.ok).map((u) => u.date)); }
export function isGraduated(p) { return okDates(p).size >= GRADUATE_AT; }
export function activePieces(state) { return (state.pieces || []).filter((p) => !p.graduatedAt); }
export function graduatedPieces(state) { return (state.pieces || []).filter((p) => p.graduatedAt); }

/** 今日のピース: 未卒業から「今日まだ使っていない → 使った回数が少ない → 最後に使ったのが古い」の順で1つ。 */
export function pickTodayPiece(state, today, excludeId) {
  const act = activePieces(state).filter((p) => p.id !== excludeId);
  if (!act.length) return null;
  const lastUse = (p) => (p.uses && p.uses.length ? p.uses[p.uses.length - 1].date : '');
  return act.slice().sort((a, b) => {
    const ta = lastUse(a) === today ? 1 : 0;
    const tb = lastUse(b) === today ? 1 : 0;
    if (ta !== tb) return ta - tb;
    const ua = (a.uses || []).length;
    const ub = (b.uses || []).length;
    if (ua !== ub) return ua - ub;
    return lastUse(a).localeCompare(lastUse(b));
  })[0];
}

/** レッスンでの結果を記録する。同じ日・同じレッスンの結果は上書き。戻り値 { piece, graduatedNow } */
export function recordPieceResult(state, pieceId, ok, date, lesson, source = 'self') {
  const p = (state.pieces || []).find((x) => x.id === pieceId);
  if (!p) return null;
  p.uses = (p.uses || []).filter((u) => !(u.date === date && u.lesson === lesson));
  p.uses.push({ date, lesson, ok: !!ok, source });
  const before = !!p.graduatedAt;
  if (!before && isGraduated(p)) p.graduatedAt = date;
  return { piece: p, graduatedNow: !before && !!p.graduatedAt };
}

/** 保存できる形か。3文＋質問、1文は短く。 */
export function validatePiece(ja, en) {
  const jl = lines(ja);
  const elns = lines(en);
  if (!jl.length) return '日本語を入れてください';
  if (!elns.length) return '英語を入れてください（「英語にする」で作れます）';
  if (elns.length > 5) return '英語は4行まで（3文＋質問1つ）';
  if (!/[?？]\s*$/.test(elns[elns.length - 1])) return '最後の行は相手への質問にしてください（? で終わる）';
  const longest = Math.max(...elns.map((l) => l.split(/\s+/).length));
  if (longest > 16) return `1文が長すぎます（最長 ${longest} 語）。12語以下を目安に切ってください`;
  return '';
}

const PIECE_SCHEMA = {
  type: 'object',
  properties: {
    en_lines: {
      type: 'array',
      items: { type: 'string' },
      description: '英語の行。3文（事実・気持ちか考え・今とのつながり）＋最後に相手への短い質問1つ。各行1文、12語以下。',
    },
    rare_words: {
      type: 'array',
      description: '基本語でない語があれば挙げる（最大3つ）。無ければ空。',
      items: {
        type: 'object',
        properties: {
          word: { type: 'string' },
          simpler: { type: 'string', description: 'より簡単な言い方。無ければ空文字' },
        },
        required: ['word', 'simpler'],
        additionalProperties: false,
      },
    },
    note_ja: { type: 'string', description: '日本語で一言。何を削ったか、どこを短くしたか。' },
  },
  required: ['en_lines', 'rare_words', 'note_ja'],
  additionalProperties: false,
};

export async function pieceToEnglish(ja, catId, key) {
  const system = [
    'You turn a Japanese self-introduction note into spoken English for a Level 1 learner.',
    OYAMA_STYLE,
    'Output exactly: 3 sentences (the fact; the feeling or thought; the link to now), then 1 short question back to the listener.',
    'The question should be easy to answer in a few words at first (yes/no or a short answer).',
    'Keep the learner\'s own content. Do not add facts. Never use the abbreviation "JTC".',
  ].join('\n');
  const user = `Category: ${catJa(catId)}\nJapanese note (up to 3 lines + a question):\n"""\n${ja}\n"""`;
  return callClaude({ system, user, schema: PIECE_SCHEMA, key, maxTokens: 1500 });
}

// ---------------------------------------------------------------- UI（自分の話タブ）

let ctx = null;
let editingId = null;
const $ = (id) => document.getElementById(id);

function fillCats() {
  const sel = $('pieceCat');
  sel.replaceChildren();
  for (const c of PIECE_CATS) {
    const o = ctx.el('option', null, c.ja);
    o.value = c.id;
    sel.appendChild(o);
  }
}

function resetForm() {
  editingId = null;
  $('pieceJa').value = '';
  $('pieceEn').value = '';
  $('pieceCat').value = 'work';
  $('pieceNote').textContent = '';
  $('pieceSave').textContent = 'ピースを保存';
  $('pieceCancel').hidden = true;
}

export function renderPieces() {
  const state = ctx.state();
  const list = $('pieceList');
  list.replaceChildren();
  const act = activePieces(state);
  const grad = graduatedPieces(state);
  $('pieceStatus').textContent = state.pieces.length
    ? `言える（卒業）${grad.length} ・ 練習中 ${act.length}`
    : 'まだピースがありません。まず1つ、仕事か好きなことから。';

  const ordered = [...act].reverse().concat([...grad].reverse());
  for (const p of ordered) {
    const li = ctx.el('li', p.graduatedAt ? 'piece grad' : 'piece');
    const body = ctx.el('div', 'body');
    body.appendChild(ctx.el('div', 'ja', `${catJa(p.cat)} · 言えた ${okDates(p).size}/${GRADUATE_AT}${p.graduatedAt ? ' · 🎓 卒業' : ''}`));
    body.appendChild(ctx.el('div', 'en', lines(p.en).join('\n')));
    body.appendChild(ctx.el('div', 'ja', lines(p.ja).join(' / ')));
    const btns = ctx.el('div', 'col');
    const edit = ctx.el('button', 'icon', '編集');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      editingId = p.id;
      $('pieceJa').value = p.ja;
      $('pieceEn').value = p.en;
      $('pieceCat').value = p.cat;
      $('pieceSave').textContent = '更新する';
      $('pieceCancel').hidden = false;
      $('pieceJa').focus();
      $('pieceJa').scrollIntoView({ block: 'center' });
    });
    const del = ctx.el('button', 'icon', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', 'このピースを消す');
    del.addEventListener('click', () => {
      if (!confirm('このピースを消しますか？')) return;
      state.pieces = state.pieces.filter((x) => x.id !== p.id);
      ctx.save();
      renderPieces();
      ctx.renderAll();
    });
    btns.append(edit, del);
    li.append(body, btns);
    list.appendChild(li);
  }
}

export function setupPieces(c) {
  ctx = c;
  fillCats();
  resetForm();

  $('pieceAI').addEventListener('click', async () => {
    const ja = $('pieceJa').value.trim();
    if (!ja) { $('pieceJa').focus(); return; }
    const key = ctx.getKeys().anthropic;
    if (!key) { ctx.toast('Anthropic のキーが未設定です（履歴 → AI 設定）'); return; }
    $('pieceAI').disabled = true;
    $('pieceNote').textContent = '英語にしています…';
    try {
      const r = await pieceToEnglish(ja, $('pieceCat').value, key);
      $('pieceEn').value = (r.en_lines || []).join('\n');
      const rare = (r.rare_words || []).filter((w) => w.word);
      $('pieceNote').textContent = (r.note_ja || '')
        + (rare.length ? `　難しめの語: ${rare.map((w) => (w.simpler ? `${w.word} → ${w.simpler}` : w.word)).join(', ')}` : '');
    } catch (e) {
      $('pieceNote').textContent = e.message;
    } finally {
      $('pieceAI').disabled = false;
    }
  });

  $('pieceSave').addEventListener('click', () => {
    const state = ctx.state();
    const ja = $('pieceJa').value.trim();
    const en = $('pieceEn').value.trim();
    const cat = $('pieceCat').value;
    const err = validatePiece(ja, en);
    if (err) { ctx.toast(err); return; }
    const wasEdit = !!editingId;
    if (wasEdit) {
      const p = state.pieces.find((x) => x.id === editingId);
      if (p) { p.ja = ja; p.en = en; p.cat = cat; p.updatedAt = ctx.today(); }
    } else {
      state.pieces.push({ id: ctx.uid(), cat, ja, en, createdAt: ctx.today(), uses: [], graduatedAt: null });
    }
    ctx.save();
    resetForm();
    renderPieces();
    ctx.renderAll();
    ctx.toast(wasEdit ? '更新しました' : 'ピースを追加しました。次の予習に出ます');
    ctx.buzz(30);
  });

  $('pieceCancel').addEventListener('click', resetForm);
  renderPieces();
}
