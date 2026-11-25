const crypto = require('crypto');

const OTDB = 'https://opentdb.com';
const KEY = crypto.createHash('sha256').update(process.env.QUIZ_SECRET).digest();
const QUESTION_TIME_MS = 15000;
const QUESTIONS_PER_QUIZ = 10;

// ---- throttled access to Open Trivia DB (1 request / 5s) ----
let lastCall = 0;
let queue = Promise.resolve();
function throttled(fn) {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCall + 5200 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { lastCall = Date.now(); }
  });
  queue = run.catch(() => {});
  return run;
}

// ---- in-memory pools (lost on restart, that's fine) ----
const pools = new Map();
let categoriesCache = null;

async function getCategories() {
  if (categoriesCache) return categoriesCache;
  const data = await throttled(async () => (await fetch(`${OTDB}/api_category.php`)).json());
  categoriesCache = data.trivia_categories; // [{id, name}]
  return categoriesCache;
}

async function fetchBatch(category, difficulty, amount) {
  const p = new URLSearchParams({ amount, type: 'multiple', encode: 'url3986' });
  if (category) p.set('category', category);
  if (difficulty) p.set('difficulty', difficulty);
  const data = await throttled(async () => (await fetch(`${OTDB}/api.php?${p}`)).json());
  return data; // response_code 0 = ok, 1 = not enough questions, 5 = rate limited
}

async function takeQuestions(category, difficulty, count) {
  const key = `${category || 'any'}:${difficulty || 'any'}`;
  const pool = pools.get(key) || [];
  if (pool.length < count) {
    let data = await fetchBatch(category, difficulty, 50);
    if (data.response_code === 1) data = await fetchBatch(category, difficulty, count);
    if (data.response_code !== 0) throw new Error('Could not load questions, try again shortly');
    pool.push(...data.results);
  }
  pools.set(key, pool);
  return pool.splice(0, count);
}

// ---- helpers ----
const dec = (s) => decodeURIComponent(s);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function decrypt(token) {
  const buf = Buffer.from(token, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  const out = Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  return JSON.parse(out.toString('utf8'));
}

// ---- start a quiz ----
async function startQuiz(userId, { category, difficulty } = {}) {
  const raw = await takeQuestions(category, difficulty, QUESTIONS_PER_QUIZ);
  const answers = [];
  const questions = raw.map((r) => {
    const correct = dec(r.correct_answer);
    const options = shuffle([correct, ...r.incorrect_answers.map(dec)]);
    answers.push(options.indexOf(correct));
    return { question: dec(r.question), options, category: dec(r.category), difficulty: r.difficulty };
  });
  const quizId = crypto.randomUUID();
  const token = encrypt({ uid: String(userId), quizId, iat: Date.now(), answers });
  return { quizId, timePerQuestionMs: QUESTION_TIME_MS, questions, token };
}

// ---- score a quiz ----
function scoreQuiz(userId, token, submitted) {
  let t;
  try { t = decrypt(token); } catch { throw new Error('Invalid quiz token'); }
  if (t.uid !== String(userId)) throw new Error('This quiz belongs to another user');

  const n = t.answers.length;
  const elapsed = Date.now() - t.iat;
  if (elapsed > n * (QUESTION_TIME_MS + 10000) + 60000) throw new Error('Quiz expired');
  if (elapsed < n * 1000) throw new Error('Submission too fast');
  if (!Array.isArray(submitted) || submitted.length !== n) throw new Error('Wrong number of answers');

  let score = 0, streak = 0, bestStreak = 0, correctCount = 0;
  const perQuestion = t.answers.map((correctIndex, i) => {
    const s = submitted[i] || {};
    const timeMs = Math.min(Math.max(Number(s.timeMs) || QUESTION_TIME_MS, 0), QUESTION_TIME_MS);
    const isCorrect = s.selected === correctIndex && timeMs < QUESTION_TIME_MS;
    let points = 0;
    if (isCorrect) {
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
      correctCount += 1;
      const timeBonus = Math.round(50 * (1 - timeMs / QUESTION_TIME_MS)); // up to +50
      const streakBonus = Math.min((streak - 1) * 10, 50);                // up to +50
      points = 100 + timeBonus + streakBonus;
    } else {
      streak = 0;
    }
    score += points;
    return { correctIndex, selected: s.selected ?? null, correct: isCorrect, points };
  });

  return { quizId: t.quizId, total: n, correct: correctCount, score, bestStreak, perQuestion };
}

module.exports = { getCategories, startQuiz, scoreQuiz };