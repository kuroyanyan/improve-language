// private リポジトリ（improve-language-data）の読み書き。カンペと記録の置き場。
// トークンは環境変数。ブラウザには渡さない。

const API = 'https://api.github.com';
const repo = () => process.env.DATA_REPO || 'kuroyanyan/improve-language-data';

const hasToken = () => !!process.env.GITHUB_TOKEN;
const token = () => {
  const v = process.env.GITHUB_TOKEN;
  if (!v) throw Object.assign(new Error('GITHUB_TOKEN が未設定です（Railway の Variables に入れてください）'), { status: 503 });
  return v;
};

// トークンが無いとき（手元での試運転）だけ、記録をこのプロセス内に置いて動かす。
const local = new Map();

const headers = () => ({
  Authorization: `Bearer ${token()}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'bizmates-log',
});

const shaCache = new Map();

/** テキストファイルを1つ読む。無ければ null。 */
export async function readFile(path) {
  const res = await fetch(`${API}/repos/${repo()}/contents/${path}`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`GitHub 読み取りに失敗（${res.status}）${path}`), { status: 502 });
  const j = await res.json();
  shaCache.set(path, j.sha);
  return Buffer.from(j.content || '', 'base64').toString('utf8');
}

/** テキストファイルを1つ書く（無ければ作る）。 */
export async function writeFile(path, text, message) {
  let sha = shaCache.get(path);
  if (!sha) {
    const got = await fetch(`${API}/repos/${repo()}/contents/${path}`, { headers: headers() });
    if (got.ok) sha = (await got.json()).sha;
    else if (got.status !== 404) throw Object.assign(new Error(`GitHub 読み取りに失敗（${got.status}）`), { status: 502 });
  }
  const res = await fetch(`${API}/repos/${repo()}/contents/${path}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ message, content: Buffer.from(text, 'utf8').toString('base64'), ...(sha ? { sha } : {}) }),
  });
  if (res.status === 409) { shaCache.delete(path); throw Object.assign(new Error('同時に更新されました。もう一度お試しください'), { status: 409 }); }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw Object.assign(new Error(`GitHub 書き込みに失敗（${res.status}）${t.slice(0, 160)}`), { status: 502 });
  }
  const j = await res.json();
  if (j.content && j.content.sha) shaCache.set(path, j.content.sha);
}

// ---------------------------------------------------------------- カンペ（起動後はメモリに持つ）

const kanpeCache = new Map();

export async function getKanpe(rank, lesson) {
  const key = `${rank}/${String(lesson).padStart(2, '0')}`;
  if (!kanpeCache.has(key)) kanpeCache.set(key, await readFile(`kanpe/${key}.html`));
  if (!kanpeCache.has('common')) kanpeCache.set('common', await readFile('kanpe/common.html'));
  const html = kanpeCache.get(key);
  if (html == null) throw Object.assign(new Error(`カンペがまだありません（Rank ${rank} Lesson ${lesson}）`), { status: 404 });
  return { html, common: kanpeCache.get('common') || '' };
}

// ---------------------------------------------------------------- 記録

export async function loadState() {
  if (!hasToken()) return local.get('state') || null;
  const raw = await readFile('state.json');
  return raw ? JSON.parse(raw) : null;
}

export async function saveState(state, snapshot) {
  if (!hasToken()) { local.set('state', state); return; }
  const today = snapshot && snapshot.date ? snapshot.date : new Date().toISOString().slice(0, 10);
  await writeFile('state.json', `${JSON.stringify(state, null, 2)}\n`, `state ${today}`);
  if (snapshot) {
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeFile('latest.json', text, `latest ${today}`);
    await writeFile(`snapshots/${today}.json`, text, `snapshot ${today}`);
  }
}
