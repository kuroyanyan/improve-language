// Claude / OpenAI 呼び出し。プロンプトとスキーマはサーバーが持つ（ブラウザからは種類と素材だけを送る）。
// キーは環境変数。コードにも端末にも置かない。

const CLAUDE_MODEL = 'claude-opus-5';
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';

// 「大山スタイル」— 簡単な文法と広い意味の動詞で、聞き手の負荷を下げる英語。
export const OYAMA_STYLE = [
  'Style rule ("simple spoken English"): use only very common words (the kind in the first 1,500 words of English).',
  'Prefer broad verbs like do, get, make, have, take, go, see, think, feel, like, want.',
  'One idea per sentence. Keep every sentence 12 words or fewer. Avoid relative clauses when you can.',
  'Contractions are fine. If a rarer word is really needed, keep it but flag it.',
].join(' ');

const need = (name) => {
  const v = process.env[name];
  if (!v) throw Object.assign(new Error(`${name} が未設定です（Railway の Variables に入れてください）`), { status: 503 });
  return v;
};

export async function callClaude({ system, user, schema, maxTokens = 4000 }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': need('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
      fallbacks: 'default',
    }),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Claude の呼び出しに失敗（${res.status}）${text.slice(0, 200)}`), { status: 502 });
  const msg = JSON.parse(text);
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('生成できませんでした（refusal）'), { status: 502 });
  const out = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { data: JSON.parse(out), model: msg.model, usage: msg.usage };
  } catch {
    throw Object.assign(new Error('応答の形式が読めませんでした'), { status: 502 });
  }
}

export async function transcribe(bytes, contentType, promptText) {
  const form = new FormData();
  const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('ogg') ? 'ogg' : 'webm';
  form.append('file', new Blob([bytes], { type: contentType }), `audio.${ext}`);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'json');
  if (promptText) form.append('prompt', promptText);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('OPENAI_API_KEY')}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`文字起こしに失敗（${res.status}）${text.slice(0, 200)}`), { status: 502 });
  const data = JSON.parse(text);
  if (!data.text) throw Object.assign(new Error('文字起こし結果が空でした'), { status: 502 });
  return data.text;
}

// ---------------------------------------------------------------- レッスンのフィードバック

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
        properties: { en: { type: 'string' }, ja: { type: 'string' } },
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

const LEARNER_PROFILE = 'Head of HR at a trading card company in Japan; team of seven; responsible for hiring and organization; also runs a new business; hobbies: running, cooking, working out.';

export function feedback({ transcript, audio, lesson, topic, keyPhrases = [], declaredPieces = [], pieces = [] }) {
  // 録音から作った文字起こしなら、相手（トレーナー）の声が入っているか。貼り付けは不明
  const voices = audio === 'both' || audio === 'learner_only' ? audio : null;
  const system = [
    'You are an English coach reviewing a transcript of a Bizmates online lesson (Level 1).',
    'The learner is a Japanese HR manager whose goal is to work across countries in English, not to pass a test.',
    'Coach toward natural, simple business English the learner can actually say tomorrow.',
    '',
    'About the transcript: it comes from automatic speech recognition on mixed Japanese/English audio.',
    'Japanese words are often mis-recognized as English and vice versa, and the two speakers are not labeled.',
    ...(voices === 'both' ? ['The audio mixed the trainer (lesson audio) and the learner (microphone) into one track, cut into parts every 10 minutes.'] : []),
    ...(voices === 'learner_only' ? [
      "This audio has ONLY the learner's microphone. The trainer's voice is not in it.",
      'Do not guess what the trainer asked: return trainer_questions as [] and trainer_question_count as 0. Label every line of cleaned_transcript as Me.',
    ] : []),
    'Use the lesson topic and key phrases as context to reconstruct what was most likely said.',
    'Where you cannot tell, keep it short and mark [?] rather than inventing content.',
    '',
    'Keep every suggested English sentence extremely simple and short (Level 1 learner).',
    OYAMA_STYLE,
    'The learner also prepares "pieces": short self-introduction units (3 sentences + 1 question back).',
    'Count questions carefully: trainer_question_count = questions the trainer asked the learner; learner_question_count = questions the learner asked back.',
    'Write Japanese explanations plainly. Never use the abbreviation "JTC".',
    `Learner facts you may rely on: ${LEARNER_PROFILE}`,
  ].join('\n');
  const declared = declaredPieces.map((p) => `- ${String(p.en || '').replace(/\n/g, ' / ')}`).join('\n');
  const all = pieces.map((p) => `- ${String(p.en || '').replace(/\n/g, ' / ')}`).join('\n');
  const user =
    `Lesson ${lesson}: ${topic}\nKey phrases: ${keyPhrases.join(' / ')}\n\n` +
    (declared ? `Pieces the learner declared to say in this lesson:\n${declared}\n\n` : 'Pieces declared for this lesson: none\n\n') +
    (all ? `All prepared pieces (for judging "covered"):\n${all}\n\n` : '') +
    `Raw transcript (ASR, ${voices === 'learner_only' ? 'learner only' : 'unlabeled speakers'}, JA/EN mixed):\n"""\n${transcript}\n"""`;
  return callClaude({ system, user, schema: FEEDBACK_SCHEMA, maxTokens: 16000 });
}

// ---------------------------------------------------------------- ピースの英語化

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
        properties: { word: { type: 'string' }, simpler: { type: 'string', description: 'より簡単な言い方。無ければ空文字' } },
        required: ['word', 'simpler'],
        additionalProperties: false,
      },
    },
    note_ja: { type: 'string', description: '日本語で一言。何を削ったか、どこを短くしたか。' },
  },
  required: ['en_lines', 'rare_words', 'note_ja'],
  additionalProperties: false,
};

export function pieceToEnglish({ ja, cat }) {
  const system = [
    'You turn a Japanese self-introduction note into spoken English for a Level 1 learner.',
    OYAMA_STYLE,
    'Output exactly: 3 sentences (the fact; the feeling or thought; the link to now), then 1 short question back to the listener.',
    'The question should be easy to answer in a few words at first (yes/no or a short answer).',
    'Keep the learner\'s own content. Do not add facts. Never use the abbreviation "JTC".',
  ].join('\n');
  return callClaude({ system, user: `Category: ${cat || 'その他'}\nJapanese note (up to 3 lines + a question):\n"""\n${ja}\n"""`, schema: PIECE_SCHEMA, maxTokens: 1500 });
}

// ---------------------------------------------------------------- 60秒サンプルの採点

export const SAMPLE_PROMPTS = [
  { en: 'Where did you grow up, and what was it like?', ja: 'どこで育った？ どんなところだった？' },
  { en: 'What do you like to do outside work?', ja: '仕事の外で好きなことは？' },
  { en: 'What have you been thinking about lately?', ja: '最近よく考えていることは？' },
];

const SAMPLE_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'integer', description: '固定ルーブリック 1〜5。1 単語の羅列 / 2 短文が途切れ途切れ / 3 短文で言い切れる / 4 短文をつなげて30秒以上続く / 5 理由や気持ちを添え、質問も返せる' },
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

export function scoreSample({ transcript }) {
  const system = [
    'You score a 60-second spoken self-introduction sample by a Japanese Level 1 English learner.',
    'The learner answered these three prompts in order: ' + SAMPLE_PROMPTS.map((p) => `"${p.en}"`).join(', ') + '.',
    'Use the fixed 1-5 rubric exactly as described in the schema. Be consistent across months: the same performance must get the same level.',
    'Count, do not guess: sentences, complete sentences, and stucks (restarts, long pauses, Japanese, fillers).',
    'Write Japanese notes plainly and positively, but do not inflate the level.',
    'When suggesting English, follow this style: ' + OYAMA_STYLE,
  ].join('\n');
  return callClaude({ system, user: `Transcript (ASR, learner only):\n"""\n${transcript}\n"""`, schema: SAMPLE_SCHEMA, maxTokens: 3000 });
}
