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

/** 「予習した」を押し、今日の終わりのポップアップを閉じるところまで。 */
async function endPrepDay(page, { answer = 'yes' } = {}) {
  await page.click('#prepDone');
  await expect(page.locator('#celebrate')).toBeVisible();
  if (answer === 'yes') {
    await page.click('#celebrateYes');
    await page.click('#celebrateClose');
  } else {
    await page.click('#celebrateLater');
  }
  await expect(page.locator('#celebrate')).toBeHidden();
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
  await go(page, 'log');
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
  await expect(page.locator('#prepPiece .cue.piece .en')).toContainText('Lately, I think a lot');
  await page.click('#prepDone');
  await page.click('#celebrateYes');
  await expect(page.locator('#celebrateDeclared')).toContainText('次のレッスンでこれを言う');
  await expect(page.locator('#celebrateDeclared')).toContainText('Lately, I think a lot');
  await page.click('#celebrateClose');

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

test('予習で作った文は履歴に残る（古い sentence だけの記録も読める）', async ({ page }) => {
  await addPiece(page);
  await go(page, 'prep');
  await page.selectOption('#prepLesson', '7');
  await endPrepDay(page);

  // まだ受けていないレッスンなので、履歴の先頭に出る
  await go(page, 'history');
  const ahead = page.locator('#historyList details').first();
  await expect(ahead).toContainText('予習で作った文');
  await expect(ahead).toContainText('Lately, I think a lot about how people grow.');
  expect((await state(page)).preps[0].pieceId).toBeTruthy();

  // そのレッスンを受けたら、受講記録の中に移る
  await go(page, 'log');
  await page.selectOption('#logLesson', '7');
  await page.click('#saveSession');
  await go(page, 'history');
  await expect(page.locator('#historyList details').first()).toContainText('予習で作った文');

  // ピースが無かった頃の記録（sentence だけ）も、そのまま出る
  await patchState(page, "st.preps.push({ id: 'old', date: '2026-09-01', rank: 'C', lesson: 12, sentence: 'I work at a trading card company.', pieceId: null });");
  await page.reload();
  await go(page, 'history');
  await expect(page.locator('#historyList')).toContainText('I work at a trading card company.');
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

test('AI（モック）: 詰まり・単語が自動で下書きに入り、宣言ピースの AI 判定は押さずに別に残る', async ({ page }) => {
  await addPiece(page);
  await go(page, 'prep');
  await endPrepDay(page);

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
  // AI の判定で回収ボタンを先に押さない。押すのは本人で、AI の判定は別に残る（自己申告と突き合わせるため）
  await expect(page.locator('#declaredBox .item button.yes')).toHaveAttribute('aria-pressed', 'false');
  await page.click('#declaredBox .item button.no');
  const puts = await stubState(page);
  await page.click('#saveSession');
  expect((await state(page)).sessions[0].declared[0]).toMatchObject({ ok: false, ai: true });
  await expect.poll(() => puts.length, { timeout: 15000 }).toBeGreaterThan(0);
  expect(puts[puts.length - 1].snapshot.sessions[0].declared_detail).toEqual([{ ok: false, ai: true }]);
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
  await page.click('#prepOpenKanpe');
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

test('予習: Challenge は評価の5点・復習範囲の Key Phrases（日本語つき）・Situation を出し、「読み込み中」を残さない', async ({ page }) => {
  const regular = (n) => `<section class="card"><h3>今日の型 <span class="jp">これさえ守れば勝ち</span></h3><p>型 L${n}</p></section>`
    + `<section class="card"><h3>Key Phrases <span class="jp">教材で青字のやつ</span></h3><ul class="kp"><li><span class="en">Phrase of L${n} 〜</span><span class="jp">L${n} の日本語</span></li></ul></section>`
    + `<section class="card"><h3>準備の3質問 <span class="jp">ロールプレイ前に聞かれる</span></h3><p>Q L${n}</p></section>`
    + `<section class="card"><h3>Act <span class="jp">仕上げのロールプレイ</span></h3><p>Act L${n}</p></section>`;
  const challenge = '<section class="card"><h3>評価される5点 <span class="jp">トレーナーが星をつける基準</span></h3><p>5 points</p></section>'
    + '<section class="card"><h3>Situation 1 <span class="jp">チームの役割</span></h3><p>S1</p></section>'
    + '<section class="card"><h3>Situation 2 <span class="jp">重要タスク</span></h3><p>S2</p></section>'
    + '<section class="card"><h3>5分を持たせるコツ <span class="jp">沈黙対策</span></h3><p>tips</p></section>';
  await page.route('**/api/kanpe**', (route) => {
    const n = Number(new URL(route.request().url()).searchParams.get('lesson'));
    if (n === 12) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'カンペがまだありません（Rank C Lesson 12）' }) });
    const html = n === 15 ? challenge : n === 3 ? '<section class="card"><h3>See</h3><p>only see</p></section>' : regular(n);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ html, common: '' }) });
  });
  await go(page, 'prep');
  await page.selectOption('#prepLesson', '15');

  // ② 評価される5点 → 復習範囲（L11–14）の Key Phrases → コツ。読めなかった L12 は飛ばす
  const pattern = page.locator('#prepPattern');
  await expect(pattern.locator('section.card h3')).toHaveText([/^評価される5点/, /^Key Phrases\s+L11 /, /^Key Phrases\s+L13 /, /^Key Phrases\s+L14 Talking About Your Workload/, /^5分を持たせるコツ/]);
  await expect(pattern).toContainText('L11 の日本語');
  await expect(pattern).toContainText('L14 の日本語');
  await expect(pattern).not.toContainText('Situation');
  await expect(pattern).not.toContainText('読み込み中');

  // ③ Challenge は Act ではなく Situation 2本が本番
  const act = page.locator('#prepAct');
  await expect(act.locator('section.card h3')).toHaveText([/^Situation 1/, /^Situation 2/]);
  await expect(act).not.toContainText('読み込み中');

  // 通常レッスンで、出す項目がカンペに無いとき
  await page.selectOption('#prepLesson', '3');
  await expect(act).toContainText('ここに出す項目がありません');
  await expect(pattern).toContainText('ここに出す項目がありません');
  await expect(pattern).not.toContainText('読み込み中');

  // 通常レッスンで、カンペが読めないとき
  await page.selectOption('#prepLesson', '12');
  await expect(act).toContainText('カンペを読めませんでした');
  await expect(pattern).toContainText('カンペを読めませんでした');
  await expect(pattern).not.toContainText('読み込み中');

  // 通常レッスンは今まで通り
  await page.selectOption('#prepLesson', '14');
  await expect(pattern.locator('section.card h3')).toHaveText([/^今日の型/, /^Key Phrases/]);
  await expect(act.locator('section.card h3')).toHaveText([/^準備の3質問/, /^Act/]);
});

test('今日の流れ: 起動はカンペ、記録で②、予習で③が終わる', async ({ page }) => {
  await page.route('**/api/kanpe**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ html: '<div class="lesson-head"><h2>Talking About Your Workload</h2></div><section class="card"><h3>今日の型 <span class="jp">これさえ守れば勝ち</span></h3><p>The most important task is …</p></section><section class="card"><h3>準備の3質問</h3><p>What do you do?</p></section><section class="card"><h3>Act</h3><p>Explain your work.</p></section>', common: '' }),
  }));
  // 何もしていない日は、開くとカンペに着地する
  await page.goto('/');
  await expect(page.locator('#view-kanpe')).toBeVisible();
  await expect(page.locator('.fstep[data-step="kanpe"]')).toHaveClass(/now/);

  // カンペの「次へ」で記録へ
  await page.click('#kanpeToLog');
  await expect(page.locator('#view-log')).toBeVisible();
  await page.click('#saveSession');
  await expect(page.locator('#view-prep')).toBeVisible();
  await expect(page.locator('.fstep[data-step="kanpe"]')).toHaveClass(/done/);
  await expect(page.locator('.fstep[data-step="log"]')).toHaveClass(/done/);

  // 予習に次回レッスンのカンペ（準備の質問と Act）が出る
  await expect(page.locator('#prepAct')).toContainText('準備の3質問');
  await expect(page.locator('#prepAct')).toContainText('Act');
  // 2つの枠が同時に読み込まれても、どちらもカンペの中身に置き換わる
  await expect(page.locator('#prepPattern')).toContainText('今日の型');
  await expect(page.locator('#prepPattern')).not.toContainText('読み込み中');

  await endPrepDay(page);
  await expect(page.locator('#flowBar')).toHaveClass(/all-done/);

  // 開き直すと、今日はもう流れが終わっている
  await page.reload();
  await expect(page.locator('#flowBar')).toHaveClass(/all-done/);
});

test('Act の想定問答: 日本語 → 英語 → 次回これを言う', async ({ page }) => {
  await page.route('**/api/kanpe**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ html: '<section class="card"><h3>準備の3質問</h3><p>What do you do?</p></section>', common: '' }),
  }));
  let sent = null;
  await page.route('**/api/ai/piece', async (route) => {
    sent = JSON.parse(route.request().postData() || 'null');
    await new Promise((r) => setTimeout(r, 700)); // 待っている間の表示を見るため
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ en_lines: ['Hiring is my job.', 'We hire someone every month.', 'So I do many interviews.', 'How do you hire people?'], rare_words: [], note_ja: '短くしました' }),
    });
  });
  await go(page, 'prep');
  const ja = '採用が私の担当\n毎月だれかを採用している\nだから毎週たくさん面接する\nあなたの会社はどうやって採用する？';
  await page.fill('#prepActJa', ja);
  await page.click('#prepActAI');
  // 待っている間は「作業中」と分かる色になる
  await expect(page.locator('#prepActNote')).toHaveClass(/working/);
  await expect(page.locator('#prepActEn')).toHaveValue(/How do you hire people\?/);
  await expect(page.locator('#prepActNote')).toContainText('短くしました');
  await expect(page.locator('#prepActNote')).not.toHaveClass(/working/);
  // 書いた日本語がそのまま届いている（文字列だけ送って ja が undefined になっていた）
  expect(sent).toMatchObject({ ja, cat: '仕事' });
  await page.click('#prepActSave');
  await expect(page.locator('#toast')).toContainText('次回これを言う');
  await expect(page.locator('#prepPiece')).toContainText('Hiring is my job.');
  const s = await state(page);
  expect(s.pieces).toHaveLength(1);
  expect(s.pieces[0].fromLesson).toMatchObject({ rank: 'C' });

  // 宣言したものが、次の記録で回収できる
  await endPrepDay(page);
  await go(page, 'log');
  await expect(page.locator('#declaredBox .item')).toContainText('Hiring is my job.');
});

/**
 * 画面共有とマイクを偽物に差し替える（ヘッドレスで録音の流れを通すため）。区切りは 1.2 秒にする。
 * マイクは無音、共有したタブは 440Hz で鳴る（tabSilent なら無音）。録音に音があれば、それはタブから来た音。
 */
async function fakeMedia(page, { share = true, tabSilent = false } = {}) {
  await page.addInitScript(([shareOk, silent]) => {
    window.__lessonSegmentMs = 1200;
    window.__mediaCalls = [];
    const tone = (hz, level) => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = hz;
      gain.gain.value = level;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      return dest.stream;
    };
    navigator.mediaDevices.getUserMedia = async () => { window.__mediaCalls.push('mic'); return tone(220, 0); };
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.__mediaCalls.push('share');
      if (!shareOk) throw new DOMException('共有をやめた', 'NotAllowedError');
      const video = document.createElement('canvas').captureStream(1).getVideoTracks();
      return new MediaStream([...video, ...tone(440, silent ? 0 : 0.8).getAudioTracks()]);
    };
  }, [share, tabSilent]);
  await page.reload();
  await expect(page.locator('#logLesson option')).toHaveCount(20);
}

const LESSON_FEEDBACK = {
  summary_ja: 'よく話せています。', good: [], corrections: [], stucks: [], words: [], key_phrase_use: [], piece_use: [],
  trainer_questions: [{ q_en: 'What do you do?', q_ja: '仕事は？', covered: true }],
  trainer_question_count: 1, learner_question_count: 1, next_focus_ja: 'ゆっくり', cleaned_transcript: 'Trainer: What do you do?\nMe: I do HR.',
};

/** 文字起こしと AI の窓口をモックし、送られてきたものを集める。 */
async function stubLessonAI(page) {
  const got = { transcribe: [], feedback: null };
  await page.route('**/api/transcribe**', (route) => {
    got.transcribe.push(route.request().postDataBuffer() || Buffer.alloc(0));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: `part ${got.transcribe.length}` }) });
  });
  await page.route('**/api/ai/feedback', (route) => {
    got.feedback = JSON.parse(route.request().postData() || '{}');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LESSON_FEEDBACK) });
  });
  return got;
}

test('録音: カンペから相手の声ごと録り、区切って文字起こしし、相手の声ありとして AI に渡す', async ({ page }) => {
  await fakeMedia(page);
  const got = await stubLessonAI(page);
  await go(page, 'kanpe');
  await page.click('#kanpeRec');
  await expect(page.locator('#recLive')).toBeVisible();
  await expect(page.locator('#kanpeRecHint')).toContainText('相手の声と自分の声');
  await expect(page.locator('#kanpeRec')).toHaveText(/録音を終えて記録へ/);
  // 画面共有は押した直後にしか開けないので、マイクより先に頼む
  expect(await page.evaluate(() => window.__mediaCalls)).toEqual(['share', 'mic']);
  await page.waitForTimeout(3000);

  // 「レッスンが終わった → 記録する」で録音も止まる
  await page.click('#kanpeToLog');
  await expect(page.locator('#view-log')).toBeVisible();
  await expect(page.locator('#recLive')).toBeHidden();
  await expect(page.locator('#aiStatus')).toContainText('相手の声あり');
  await expect(page.locator('#kanpeRec')).toHaveText(/録音してレッスンを始める/);

  await page.click('#aiRun');
  await expect(page.locator('#aiResult')).toContainText('よく話せています');
  expect(got.transcribe.length).toBeGreaterThanOrEqual(2);
  // 送った音声を復号して、相手（タブ）の音が本当に入っていることを確かめる（マイクは無音にしてある）
  const rms = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const d = (await new AudioContext().decodeAudioData(bytes.buffer)).getChannelData(0);
    return Math.sqrt(d.reduce((sum, v) => sum + v * v, 0) / d.length);
  }, got.transcribe[0].toString('base64'));
  expect(rms).toBeGreaterThan(0.05);
  expect(got.feedback.audio).toBe('both');
  expect(got.feedback.transcript.indexOf('part 1')).toBeLessThan(got.feedback.transcript.indexOf('part 2'));

  await page.click('#saveSession');
  expect((await state(page)).sessions[0].ai.audio).toBe('both');
});

test('録音: 共有しなかったら自分の声だけ録り、同じボタンで止めて、AI にもそう伝える', async ({ page }) => {
  await fakeMedia(page, { share: false });
  const got = await stubLessonAI(page);
  await go(page, 'kanpe');
  await page.click('#kanpeRec');
  await expect(page.locator('#kanpeRecHint')).toContainText('自分の声だけ');
  await page.waitForTimeout(800);
  await page.click('#kanpeRec');
  await expect(page.locator('#view-log')).toBeVisible();
  await expect(page.locator('#aiStatus')).toContainText('自分の声だけ');

  await page.click('#aiRun');
  await expect(page.locator('#aiResult')).toContainText('よく話せています');
  expect(got.feedback.audio).toBe('learner_only');

  // 貼り付けた文字起こしは、相手の声が入っているか分からないので伝えない
  await page.fill('#aiPaste', 'Trainer: Hi. Me: Hello.');
  await page.click('#aiRun');
  await expect.poll(() => got.feedback.transcript).toBe('Trainer: Hi. Me: Hello.');
  expect(got.feedback.audio).toBeUndefined();
});

test('録音: 共有したタブが一度も鳴らなければ、相手の声あり扱いにしない', async ({ page }) => {
  await fakeMedia(page, { tabSilent: true });
  const got = await stubLessonAI(page);
  await go(page, 'kanpe');
  await page.click('#kanpeRec');
  await expect(page.locator('#kanpeRecHint')).toContainText('相手の声と自分の声');
  await page.waitForTimeout(1500);
  await page.click('#kanpeToLog');
  await expect(page.locator('#aiStatus')).toContainText('相手の声が聞こえませんでした');
  await page.click('#aiRun');
  await expect(page.locator('#aiResult')).toContainText('よく話せています');
  expect(got.feedback.audio).toBe('learner_only');
});

test('今日の終わり: 予習したら「終わりにしますか」→ ねぎらいとワンフレーズとクラッカー', async ({ page }) => {
  await go(page, 'prep');
  await page.click('#prepDone');

  // まず聞かれる。まだ続けるなら、そのまま閉じる
  const box = page.locator('#celebrate');
  await expect(box).toBeVisible();
  await expect(page.locator('#celebrateTitle')).toContainText('終わりにしますか');
  await page.click('#celebrateLater');
  await expect(box).toBeHidden();
  expect((await state(page)).preps[0].end).toBe('continue');

  // もう一度。今度は最後まで見る
  await page.click('#prepDone');
  await page.click('#celebrateYes');
  await expect(page.locator('#celebrateDone')).toBeVisible();
  const praise = await page.locator('#celebratePraise').textContent();
  expect(praise.trim().length).toBeGreaterThan(0);
  await expect(page.locator('#celebratePhrase')).not.toBeEmpty();
  await expect(page.locator('#celebratePop i').first()).toBeVisible(); // クラッカー
  await page.click('#celebrateClose');
  await expect(box).toBeHidden();
  expect((await state(page)).preps[1].end).toBe('done');

  // ねぎらいの一言は前回と変わる
  await page.click('#prepDone');
  await page.click('#celebrateYes');
  expect((await page.locator('#celebratePraise').textContent()).trim()).not.toBe(praise.trim());
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
});
