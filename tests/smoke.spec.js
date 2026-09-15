// 主要フローのスモークテスト。API は route でモックし、外部には出ない。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const STORAGE = 'bizmates-log/v1';
const PIECE_JA = '最近、人はどうやって成長するかをよく考える\n面接をたくさんするので、安心できて仕事が難しいときに人が伸びるのを見る\nだからそういうチームを作ろうとしている\nあなたが一番成長したのは何のとき？';
const PIECE_EN = 'Lately, I think a lot about how people grow.\nPeople grow when they feel safe and the work is hard.\nSo I try to make that kind of team.\nWhat made you grow the most?';

const state = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), STORAGE);
const patchState = (page, fn) => page.evaluate(([k, src]) => {
  const st = JSON.parse(localStorage.getItem(k));
  // eslint-disable-next-line no-new-func
  new Function('st', src)(st);
  localStorage.setItem(k, JSON.stringify(st));
}, [STORAGE, fn]);

async function addPiece(page, ja = PIECE_JA, en = PIECE_EN) {
  await page.click('#tab-cards');
  await page.fill('#pieceJa', ja);
  await page.fill('#pieceEn', en);
  await page.click('#pieceSave');
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('#logLesson option')).toHaveCount(20);
});

test('記録 → 予習へ遷移、次レッスン繰り上げ、カード生成、フリートーク分数', async ({ page }) => {
  await page.selectOption('#logLesson', '14');
  await page.click('.seg button[data-rating="3"]');
  await page.click('#talkSeg button[data-talk="10"]');
  await page.fill('#stuckJa', 'その件は来週までに終わらせます');
  await page.fill('#stuckFix', "I'll get it done by next week.");
  await page.click('#stuckAdd');
  await page.click('#saveSession');
  await expect(page.locator('#view-prep')).toBeVisible();
  const s = await state(page);
  expect(s.sessions).toHaveLength(1);
  expect(s.sessions[0]).toMatchObject({ lesson: 14, rank: 'C', rating: 3, talkMin: 10 });
  expect(s.profile.lastLogLesson).toBe(15);
  expect(s.cards).toHaveLength(1);
  await page.click('#tab-history');
  await expect(page.locator('#historyList details').first()).toContainText('L14');
  await expect(page.locator('#historyList details').first()).toContainText('フリートーク 10分');
});

test('ピース: 質問なしは保存できない → 作成 → 予習で宣言 → 記録で回収 → 3日目で卒業', async ({ page }) => {
  await addPiece(page, 'テスト', 'I like running.');
  await expect(page.locator('#pieceList li.piece')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('質問');

  await addPiece(page);
  await expect(page.locator('#pieceList li.piece')).toHaveCount(1);
  await expect(page.locator('#pieceStatus')).toContainText('練習中 1');

  // 別日の「言えた」を2回入れておく（今日の1回で3回になる）
  await patchState(page, "st.pieces[0].uses.push({date:'2026-01-05',lesson:1,ok:true},{date:'2026-01-06',lesson:2,ok:true});");
  await page.reload();

  await page.click('#tab-prep');
  await page.click('#prepStart');
  await page.click('#prepNext');
  await page.click('#prepNext');
  await expect(page.locator('#clockStep')).toContainText('今日のピースを宣言');
  await expect(page.locator('#cueBox .cue.piece .en')).toContainText('Lately, I think a lot');
  await expect(page.locator('#cueBox .cue.piece .top')).toContainText('最近、人は');
  await page.click('#prepNext');
  await page.click('#prepNext');
  await expect(page.locator('#toast')).toContainText('宣言したピース');
  const s1 = await state(page);
  expect(s1.preps).toHaveLength(1);
  expect(s1.preps[0].pieceId).toBe(s1.pieces[0].id);

  await page.click('#tab-log');
  await expect(page.locator('#declaredBox .item')).toHaveCount(1);
  await page.click('#declaredBox .item button.yes');
  await expect(page.locator('#declaredBox .item button.yes')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#saveSession');
  await expect(page.locator('#toast')).toContainText('卒業');
  const s2 = await state(page);
  expect(s2.sessions[0].declared).toEqual([expect.objectContaining({ ok: true })]);
  expect(s2.pieces[0].uses).toHaveLength(3);
  expect(s2.pieces[0].graduatedAt).toBeTruthy();
  await page.click('#tab-history');
  await expect(page.locator('#stPieces')).toHaveText('1');
  await expect(page.locator('#historyList details').first()).toContainText('宣言したピース');
});

test('実戦ログ・今週の日数・今月の記録証', async ({ page }) => {
  await page.click('#saveSession');
  await page.click('#tab-log');
  await page.fill('#realText', '面接の冒頭で自己紹介を英語でした');
  await page.click('#realSave');
  await expect(page.locator('#toast')).toContainText('実戦');
  await page.click('#tab-history');
  await expect(page.locator('#stWeek')).toHaveText('1/7');
  await expect(page.locator('#stReal')).toHaveText('1');
  await expect(page.locator('#monthStats .stat')).toHaveCount(4);
  await expect(page.locator('#monthStats')).toContainText('実戦');
  await expect(page.locator('#historyHint')).toContainText('連続 1 日');
});

test('Rank 切替で教材が変わり、記録はランク付きで残る', async ({ page }) => {
  await expect(page.locator('#rankPick')).toBeVisible();
  await page.selectOption('#rankPick', 'D');
  await expect(page.locator('#logLesson option').first()).toContainText('Talking About Your Company');
  await expect(page.locator('#logLessonBadge')).toHaveText('Rank D');
  await page.click('#saveSession');
  let s = await state(page);
  expect(s.sessions[0].rank).toBe('D');
  expect(s.profile.rank).toBe('D');
  await page.reload();
  await expect(page.locator('#rankPick')).toHaveValue('D');
  await page.selectOption('#rankPick', 'C');
  await expect(page.locator('#logLesson option').first()).toContainText('Talking about Yourself');
  await page.click('#tab-history');
  await expect(page.locator('#historyList details').first()).toContainText('Rank D L1');
  s = await state(page);
  expect(s.profile.rank).toBe('C');
});

test('AI フィードバック（モック）: 宣言ピースの判定が回収ボタンに先に入る', async ({ page }) => {
  await addPiece(page);
  await page.click('#tab-prep');
  await page.click('#prepStart');
  for (let i = 0; i < 4; i += 1) await page.click('#prepNext');
  await page.click('#tab-history');
  await page.fill('#keyAnthropic', 'sk-ant-test-not-real');
  await page.click('#saveKeys');

  await page.route('https://api.anthropic.com/v1/messages', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const wantsFeedback = JSON.stringify(body.output_config || {}).includes('trainer_questions');
    const fb = {
      summary_ja: 'よく話せています。', good: ['質問を返せた'], corrections: [], stucks: [], words: [],
      key_phrase_use: [], piece_use: [{ piece: 'Lately, I think a lot about how people grow.', used: true, how_ja: '最後まで言えた' }],
      trainer_questions: [{ q_en: 'What do you do?', q_ja: '仕事は？', covered: true }],
      trainer_question_count: 3, learner_question_count: 2,
      next_focus_ja: 'ゆっくり', cleaned_transcript: 'Trainer: What do you do?\nMe: I do HR.',
    };
    const piece = { en_lines: ['I like running.', 'It makes me feel good.', 'So I run in the morning.', 'Do you run?'], rare_words: [], note_ja: '短くしました' };
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(wantsFeedback ? fb : piece) }] }),
    });
  });

  await page.click('#tab-log');
  await page.fill('#aiPaste', 'Trainer: What do you do? Me: I do HR. Lately I think a lot about how people grow.');
  await page.click('#aiRun');
  await expect(page.locator('#aiResult')).toContainText('宣言したピースは言えたか');
  await expect(page.locator('#aiResult')).toContainText('聞かれた質問');
  await expect(page.locator('#aiResult')).toContainText('あなたから 2 回');
  await expect(page.locator('#declaredBox .item button.yes')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#saveSession');
  const s = await state(page);
  expect(s.sessions[0].ai.trainer_questions).toHaveLength(1);
  expect(s.sessions[0].declared[0].ok).toBe(true);
  await page.click('#tab-history');
  await expect(page.locator('#monthHint')).toContainText('質問カバー率 100%');

  // ピースの英語化もモックで通す
  await page.click('#tab-cards');
  await page.fill('#pieceJa', '走るのが好き\n気持ちがいい\nだから朝走る\nあなたは走る？');
  await page.click('#pieceAI');
  await expect(page.locator('#pieceEn')).toHaveValue(/Do you run\?/);
  await expect(page.locator('#pieceNote')).toContainText('短くしました');
});

test('60秒サンプルの UI と採点（モック）', async ({ page }) => {
  await page.click('#tab-cards');
  await expect(page.locator('#samplePrompts li')).toHaveCount(3);
  await expect(page.locator('#sampleScore')).toBeDisabled();
  await page.click('#tab-history');
  await page.fill('#keyAnthropic', 'sk-ant-test-not-real');
  await page.click('#saveKeys');
  await page.route('https://api.anthropic.com/v1/messages', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
      level: 3, level_reason_ja: '短文で言い切れている', total_sentences: 6, complete_sentences: 5, stuck_count: 2,
      best_sentence: 'I grew up in a small town.', tip_ja: '質問を1つ返す', cleaned_transcript: 'I grew up in a small town. It was quiet. I like running. I run in the morning. Lately I think about growth. It is fun.',
    }) }] }),
  }));
  await page.click('#tab-cards');
  await page.fill('#samplePaste', 'I grew up in a small town. It was quiet. I like running. I run in the morning. Lately I think about growth. It is fun.');
  await page.fill('#sampleSeconds', '60');
  await expect(page.locator('#sampleScore')).toBeEnabled();
  await page.click('#sampleScore');
  await expect(page.locator('#sampleResult')).toContainText('Level 3');
  await expect(page.locator('#sampleNote')).toContainText('自己ベスト');
  const s = await state(page);
  expect(s.samples).toHaveLength(1);
  expect(s.samples[0].wpm).toBeGreaterThan(20);
  expect(s.samples[0].complete_ratio).toBeCloseTo(0.83, 1);
  await page.click('#tab-history');
  await expect(page.locator('#monthHint')).toContainText('自己ベスト');
  await expect(page.locator('#monthBest')).toContainText('small town');
});

test('書き出し JSON に API キーと同期トークンが入らない・古い形式も読める', async ({ page }) => {
  await page.click('#tab-history');
  await page.fill('#keyAnthropic', 'sk-ant-test-not-real');
  await page.fill('#keyOpenai', 'sk-test-openai');
  await page.click('#saveKeys');
  await page.fill('#syncRepo', 'kuroyanyan/improve-language-data');
  await page.fill('#syncPat', 'github_pat_test_not_real');
  await page.click('#syncSave');
  await expect(page.locator('#syncStatus')).toContainText('最後の同期');
  // キーを別々に保存しても互いに消えない
  const keys = await page.evaluate(() => JSON.parse(localStorage.getItem('bizmates-log/keys')));
  expect(keys).toMatchObject({ anthropic: 'sk-ant-test-not-real', github_pat: 'github_pat_test_not_real' });

  await page.click('#tab-log');
  await page.click('#saveSession');
  await page.click('#tab-history');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  expect(text).not.toContain('sk-ant-test');
  expect(text).not.toContain('sk-test-openai');
  expect(text).not.toContain('github_pat');
  const parsed = JSON.parse(text);
  expect(parsed.sessions).toHaveLength(1);
  expect(Array.isArray(parsed.pieces)).toBe(true);

  // v0 形式（pieces/real/samples が無い）を読み込んでも壊れない
  const old = { version: 1, profile: { rank: 'C', level: '1', lastLogLesson: 3, lastPrepLesson: 3 }, sessions: [{ id: 'x', date: '2026-09-01', lesson: 2, rating: 2, stucks: [], words: [], memo: '', ai: null }], cards: [], preps: [] };
  await page.setInputFiles('#importFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await expect(page.locator('#toast')).toContainText('読み込みました');
  const s = await state(page);
  expect(s.pieces).toEqual([]);
  expect(s.sessions[0].lesson).toBe(2);
  await expect(page.locator('#historyList details').first()).toContainText('L2');
});

test('ダークテーマでも描画される', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(16, 23, 30)');
  await expect(page.locator('h1')).toBeVisible();
});
