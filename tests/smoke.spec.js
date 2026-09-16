// 主要フローのスモークテスト。AI・カンペ・記録の保存は /api/* をモックし、外部には出ない。
import { test, expect } from '@playwright/test';

const STORAGE = 'bizmates-log/v1';
const PIECE_JA = '最近、人はどうやって成長するかをよく考える\n安心できて、仕事が難しいときに人は伸びる\nだからそういうチームを作ろうとしている\nあなたが一番成長したのは何のとき？';
const PIECE_EN = 'Lately, I think a lot about how people grow.\nPeople grow when they feel safe and the work is hard.\nSo I try to make that kind of team.\nWhat made you grow the most?';

const go = async (page, view) => { await page.click('#menuBtn'); await page.click(`#tab-${view}`); };
const state = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), STORAGE);
const patchState = (page, fn) => page.evaluate(([k, src]) => {
  const st = JSON.parse(localStorage.getItem(k));
  // eslint-disable-next-line no-new-func
  new Function('st', src)(st);
  localStorage.setItem(k, JSON.stringify(st));
}, [STORAGE, fn]);

/** 記録の保存先をテストごとに空にし、PUT された本文を集める。 */
async function stubState(page, initial = null) {
  const puts = [];
  await page.route('**/api/state', async (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      puts.push(JSON.parse(req.postData() || '{}'));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, at: new Date().toISOString() }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: initial }) });
  });
  return puts;
}

async function addPiece(page, ja = PIECE_JA, en = PIECE_EN) {
  await go(page, 'cards');
  await page.fill('#pieceJa', ja);
  await page.fill('#pieceEn', en);
  await page.click('#pieceSave');
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await stubState(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('#logLesson option')).toHaveCount(20);
});

test('記録 → 予習へ遷移、次レッスン繰り上げ、カード生成、フリートーク分数', async ({ page }) => {
  await page.selectOption('#logLesson', '14');
  await page.click('.seg button[data-rating="3"]');
  await page.click('#talkSeg button[data-talk="10"]');
  await page.click('#view-log details.log summary');
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
  await go(page, 'history');
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

  await patchState(page, "st.pieces[0].uses.push({date:'2026-01-05',lesson:1,ok:true},{date:'2026-01-06',lesson:2,ok:true});");
  await page.reload();

  await go(page, 'prep');
  await page.click('#prepStart');
  await page.click('#prepNext');
  await page.click('#prepNext');
  await expect(page.locator('#clockStep')).toContainText('今日のピースを宣言');
  await expect(page.locator('#cueBox .cue.piece .en')).toContainText('Lately, I think a lot');
  await page.click('#prepNext');
  await page.click('#prepNext');
  await expect(page.locator('#toast')).toContainText('宣言したピース');

  await go(page, 'log');
  await expect(page.locator('#declaredBox .item')).toHaveCount(1);
  await page.click('#declaredBox .item button.yes');
  await page.click('#saveSession');
  await expect(page.locator('#toast')).toContainText('卒業');
  const s = await state(page);
  expect(s.pieces[0].uses).toHaveLength(3);
  expect(s.pieces[0].graduatedAt).toBeTruthy();
  await go(page, 'history');
  await expect(page.locator('#stPieces')).toHaveText('1');
});

test('実戦ログ・今週の日数・今月の記録証', async ({ page }) => {
  await page.click('#saveSession');
  await go(page, 'log');
  await page.fill('#realText', '面接の冒頭で自己紹介を英語でした');
  await page.click('#realSave');
  await expect(page.locator('#toast')).toContainText('実戦');
  await go(page, 'history');
  await expect(page.locator('#stWeek')).toHaveText('1/7');
  await expect(page.locator('#stReal')).toHaveText('1');
  await expect(page.locator('#monthStats .stat')).toHaveCount(4);
});

test('Rank 切替で教材が変わり、記録はランク付きで残る', async ({ page }) => {
  await page.selectOption('#rankPick', 'D');
  await expect(page.locator('#logLesson option').first()).toContainText('Talking About Your Company');
  await page.click('#saveSession');
  expect((await state(page)).sessions[0].rank).toBe('D');
  await page.reload();
  await expect(page.locator('#rankPick')).toHaveValue('D');
  await page.selectOption('#rankPick', 'C');
  await go(page, 'history');
  await expect(page.locator('#historyList details').first()).toContainText('Rank D L1');
});

test('AI（モック）: 詰まり・単語が自動で下書きに入り、宣言ピースの判定も先に入る', async ({ page }) => {
  await addPiece(page);
  await go(page, 'prep');
  await page.click('#prepStart');
  for (let i = 0; i < 4; i += 1) await page.click('#prepNext');

  await page.route('**/api/ai/feedback', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      summary_ja: 'よく話せています。', good: ['質問を返せた'], corrections: [],
      stucks: [{ ja: 'その件は来週までに終わらせます', en: 'I will get it done by next week.' }],
      words: [{ en: 'get it done', ja: '終わらせる' }],
      key_phrase_use: [], piece_use: [{ piece: 'Lately, I think a lot about how people grow.', used: true, how_ja: '最後まで言えた' }],
      trainer_questions: [{ q_en: 'What do you do?', q_ja: '仕事は？', covered: true }],
      trainer_question_count: 3, learner_question_count: 2,
      next_focus_ja: 'ゆっくり', cleaned_transcript: 'Trainer: What do you do?\nMe: I do HR.',
    }),
  }));
  await page.route('**/api/ai/piece', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ en_lines: ['I like running.', 'It makes me feel good.', 'So I run in the morning.', 'Do you run?'], rare_words: [], note_ja: '短くしました' }),
  }));

  await go(page, 'log');
  await page.fill('#aiPaste', 'Trainer: What do you do? Me: I do HR.');
  await page.click('#aiRun');
  await expect(page.locator('#aiResult')).toContainText('宣言したピースは言えたか');
  await expect(page.locator('#aiResult')).toContainText('あなたから 2 回');
  await expect(page.locator('#stuckList li')).toHaveCount(1);
  await expect(page.locator('#wordList li')).toHaveCount(1);
  await expect(page.locator('#declaredBox .item button.yes')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#saveSession');
  expect((await state(page)).sessions[0].declared[0].ok).toBe(true);
  await go(page, 'history');
  await expect(page.locator('#monthHint')).toContainText('質問カバー率 100%');

  await go(page, 'cards');
  await page.fill('#pieceJa', '走るのが好き\n気持ちがいい\nだから朝走る\nあなたは走る？');
  await page.click('#pieceAI');
  await expect(page.locator('#pieceEn')).toHaveValue(/Do you run\?/);
});

test('60秒サンプル（モック）', async ({ page }) => {
  await page.route('**/api/ai/sample', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      level: 3, level_reason_ja: '短文で言い切れている', total_sentences: 6, complete_sentences: 5, stuck_count: 2,
      best_sentence: 'I grew up in a small town.', tip_ja: '質問を1つ返す',
      cleaned_transcript: 'I grew up in a small town. It was quiet. I like running. I run in the morning. Lately I think about growth. It is fun.',
    }),
  }));
  await go(page, 'cards');
  await expect(page.locator('#samplePrompts li')).toHaveCount(3);
  await expect(page.locator('#sampleTimer')).toHaveText('1:00');
  await page.fill('#samplePaste', 'I grew up in a small town. It was quiet. I like running.');
  await page.click('#sampleScore');
  await expect(page.locator('#sampleResult')).toContainText('Level 3');
  await expect(page.locator('#sampleNote')).toContainText('自己ベスト');
  const s = await state(page);
  expect(s.samples[0].wpm).toBeGreaterThan(20);
  await go(page, 'history');
  await expect(page.locator('#monthBest')).toContainText('small town');
});

test('記録は裏方に自動保存され、起動時に読み戻される（旧形式でも壊れない）', async ({ page }) => {
  const puts = await stubState(page);
  await page.click('#saveSession');
  await expect.poll(() => puts.length, { timeout: 15000 }).toBeGreaterThan(0);
  const body = puts[puts.length - 1];
  expect(body.state.sessions).toHaveLength(1);
  expect(body.snapshot.totals.sessions).toBe(1);
  expect(JSON.stringify(body)).not.toContain('github_pat');

  // 裏方に古い形式（pieces/real/samples 無し）があっても読める
  const old = { version: 1, profile: { rank: 'C', level: '1', lastLogLesson: 3, lastPrepLesson: 3 },
    sessions: [{ id: 'x', date: '2026-09-01', lesson: 2, rating: 2, stucks: [], words: [], memo: '', ai: null }], cards: [], preps: [] };
  await page.unroute('**/api/state');
  await stubState(page, old);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const s = await state(page);
  expect(s.pieces).toEqual([]);
  expect(s.sessions[0].lesson).toBe(2);
  await go(page, 'history');
  await expect(page.locator('#historyList details').first()).toContainText('L2');
  await expect(page.locator('#syncStatus')).toContainText('記録');
});

test('設定画面が無い（キー入力欄・書き出し・同期設定）', async ({ page }) => {
  await go(page, 'history');
  for (const id of ['#keyAnthropic', '#keyOpenai', '#syncRepo', '#syncPat', '#exportBtn', '#importBtn', '#wipeBtn']) {
    await expect(page.locator(id)).toHaveCount(0);
  }
  const html = await page.content();
  expect(html).not.toContain('api.anthropic.com');
  expect(html).not.toContain('sk-ant-');
});

test('カンペ: 裏方から取得して端末に保存、script は落とす', async ({ page }) => {
  let hits = 0;
  await page.route('**/api/kanpe**', (route) => {
    hits += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      html: '<div class="lesson-head"><p class="lesson-num">Lesson 14</p><h2>Talking About Your Workload</h2></div><section class="card"><h3>今日の型</h3><p>The most important task is …</p></section><script>window.__evil=1</script>',
      common: '<section class="card"><h3>自分の基本情報</h3><ul class="kp"><li><span class="en">I work at a trading card company in Japan.</span></li></ul></section>',
    }) });
  });
  await go(page, 'kanpe');
  await page.selectOption('#kanpeLesson', '14');
  await expect(page.locator('#kanpeBody')).toContainText('Talking About Your Workload');
  expect(await page.evaluate(() => window.__evil)).toBeUndefined();
  await expect(page.locator('#kanpeStatus')).toContainText('取得しました');

  const before = hits;
  await page.reload();
  await go(page, 'kanpe');
  await expect(page.locator('#kanpeBody')).toContainText('Talking About Your Workload');
  await expect(page.locator('#kanpeStatus')).toContainText('保存済み');
  expect(hits).toBe(before);

  await go(page, 'prep');
  await page.click('#prepStart');
  await page.click('#prepNext');
  await page.click('#cueBox button.ghost');
  await expect(page.locator('#view-kanpe')).toBeVisible();
});

test('☰ メニュー: 開閉と現在地、Esc と背景で閉じる', async ({ page }) => {
  await expect(page.locator('#drawer')).toBeHidden();
  await page.click('#menuBtn');
  await expect(page.locator('#drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer')).toBeHidden();
  await go(page, 'kanpe');
  await expect(page.locator('#whereLabel')).toHaveText('カンペ');
  await page.click('#menuBtn');
  await expect(page.locator('#tab-kanpe')).toHaveAttribute('aria-current', 'page');
  await page.click('#backdrop', { position: { x: 400, y: 300 } });
  await expect(page.locator('#drawer')).toBeHidden();
});

test('ダークテーマでも描画される', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(16, 23, 30)');
});
