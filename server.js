// Локальный сервер квиза. Без внешних зависимостей: нужен только Node.js.
// Запуск: node server.js  (или двойной клик по «Запустить квиз.command»)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMAGES_DIR = path.join(__dirname, 'images');
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
// На публичном сервере задайте переменную HOST_PASSWORD — без неё экран ведущего откроется только с этого компьютера
const HOST_PASSWORD = process.env.HOST_PASSWORD || '';
const HOST_KEY = HOST_PASSWORD || crypto.randomBytes(3).toString('hex');
const MAX_PLAYERS = 50;
const ANSWER_GRACE_MS = 600;

fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ---------- Вопросы ----------

function normalizeQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const text = String(q.question || '').trim();
  const answers = Array.isArray(q.answers)
    ? q.answers.map((a) => String(a ?? '').trim()).slice(0, 6)
    : [];
  if (answers.some((a) => !a)) return null;
  const correct = Number(q.correct);
  const time = Math.min(300, Math.max(5, Number(q.time) || 20));
  const image = q.image ? path.basename(String(q.image)) : '';
  const explanation = String(q.explanation || '').trim();
  if (!text || answers.length < 2 || !Number.isInteger(correct) || correct < 0 || correct >= answers.length) {
    return null;
  }
  return { question: text, answers, correct, time, image, explanation };
}

function loadTitle() {
  try {
    return String(JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')).title || '').trim();
  } catch (_) {
    return '';
  }
}

function loadQuestions() {
  try {
    const raw = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.questions;
    const valid = (list || []).map(normalizeQuestion).filter(Boolean);
    if (valid.length !== (list || []).length) {
      console.warn(`⚠️  Пропущено некорректных вопросов: ${(list || []).length - valid.length}`);
    }
    return valid;
  } catch (e) {
    console.error('⚠️  Не удалось прочитать questions.json:', e.message);
    return [];
  }
}

function saveQuestions(list) {
  const tmp = QUESTIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ title: loadTitle(), questions: list }, null, 2), 'utf8');
  fs.renameSync(tmp, QUESTIONS_FILE);
}

// ---------- Состояние игры ----------

const game = {
  phase: 'lobby', // lobby | question | reveal | leaderboard | final
  index: -1,
  questions: loadQuestions(),
  startedAt: 0,
  endsAt: 0,
  answers: new Map(), // playerId -> { choice, ms, correct, points }
  timer: null,
};

const players = new Map(); // id -> { id, name, score, lastPoints, lastCorrect, prevRank, streams: Set }
const hostStreams = new Set();

const currentQuestion = () => game.questions[game.index] || null;
const isConnected = (p) => p.streams.size > 0;

function ranking() {
  return [...players.values()].sort((a, b) => b.score - a.score || a.totalMs - b.totalMs || a.name.localeCompare(b.name, 'ru'));
}

function rankOf(id) {
  const list = ranking();
  const i = list.findIndex((p) => p.id === id);
  return i === -1 ? null : i + 1;
}

function leaderboard() {
  return ranking().map((p, i) => ({
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    score: p.score,
    lastPoints: p.lastPoints,
    rank: i + 1,
    prevRank: p.prevRank,
    connected: isConnected(p),
  }));
}

function questionPayload(withCorrect) {
  const q = currentQuestion();
  if (!q) return null;
  return {
    text: q.question,
    answers: q.answers,
    image: q.image ? '/images/' + encodeURIComponent(q.image) : '',
    time: q.time,
    remaining: Math.max(0, game.endsAt - Date.now()),
    correct: withCorrect ? q.correct : undefined,
    explanation: withCorrect ? q.explanation : undefined,
  };
}

function playerView(p) {
  const inQuestion = game.phase === 'question' || game.phase === 'reveal';
  const a = game.answers.get(p.id);
  return {
    phase: game.phase,
    index: game.index,
    total: game.questions.length,
    playersCount: players.size,
    me: { id: p.id, name: p.name, emoji: p.emoji, score: p.score, rank: rankOf(p.id) },
    question: inQuestion ? questionPayload(game.phase === 'reveal') : null,
    myAnswer: a ? a.choice : null,
    result: game.phase === 'reveal' ? { correct: p.lastCorrect, points: p.lastPoints, answered: !!a } : null,
    leaderboard: game.phase === 'leaderboard' || game.phase === 'final' ? leaderboard().slice(0, 10) : null,
  };
}

function hostView() {
  const inQuestion = game.phase === 'question' || game.phase === 'reveal';
  const q = currentQuestion();
  let distribution = null;
  if (game.phase === 'reveal' && q) {
    distribution = q.answers.map(() => 0);
    for (const a of game.answers.values()) distribution[a.choice]++;
  }
  return {
    phase: game.phase,
    index: game.index,
    total: game.questions.length,
    title: loadTitle(),
    question: inQuestion ? questionPayload(true) : null,
    answeredCount: game.answers.size,
    distribution,
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      score: p.score,
      connected: isConnected(p),
      answered: game.answers.has(p.id),
    })),
    leaderboard: leaderboard(),
    joinUrls: joinUrls(),
  };
}

// ---------- Рассылка (Server-Sent Events) ----------

function send(res, data, event) {
  try {
    res.write((event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`);
  } catch (_) {}
}

function broadcast() {
  for (const p of players.values()) {
    const view = playerView(p);
    for (const res of p.streams) send(res, view);
  }
  const hv = hostView();
  for (const res of hostStreams) send(res, hv);
}

setInterval(() => {
  for (const p of players.values()) for (const res of p.streams) res.write(': ping\n\n');
  for (const res of hostStreams) res.write(': ping\n\n');
}, 15000);

// ---------- Ход игры ----------

function startQuestion() {
  const q = currentQuestion();
  clearTimeout(game.timer);
  game.phase = 'question';
  game.answers.clear();
  game.startedAt = Date.now();
  game.endsAt = game.startedAt + q.time * 1000;
  game.timer = setTimeout(reveal, q.time * 1000 + ANSWER_GRACE_MS);
  broadcast();
}

function reveal() {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  const ranks = new Map(ranking().map((p, i) => [p.id, i + 1]));
  for (const p of players.values()) {
    const a = game.answers.get(p.id);
    p.prevRank = ranks.get(p.id);
    p.lastPoints = a ? a.points : 0;
    p.lastCorrect = a ? a.correct : false;
    p.score += p.lastPoints;
    // Общее время ответов — решает при равенстве очков (не ответил = всё время вопроса)
    p.totalMs += a ? a.ms : currentQuestion().time * 1000;
  }
  game.phase = 'reveal';
  game.endsAt = Date.now();
  broadcast();
}

function submitAnswer(p, choice) {
  const q = currentQuestion();
  if (game.phase !== 'question' || !q) return 'Сейчас нельзя отвечать';
  if (game.answers.has(p.id)) return 'Ответ уже принят';
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.answers.length) return 'Неверный вариант';
  const ms = Date.now() - game.startedAt;
  if (ms > q.time * 1000 + ANSWER_GRACE_MS) return 'Время вышло';
  const correct = choice === q.correct;
  // Верный ответ: от 1000 (мгновенно) до 500 (в последнюю секунду) очков
  const ratio = Math.min(1, ms / (q.time * 1000));
  const points = correct ? Math.round(1000 - 500 * ratio) : 0;
  game.answers.set(p.id, { choice, ms, correct, points });

  const online = [...players.values()].filter(isConnected);
  if (online.length > 0 && online.every((x) => game.answers.has(x.id))) {
    clearTimeout(game.timer);
    game.timer = setTimeout(reveal, 700); // все ответили — небольшая пауза и показываем ответ
  }
  broadcast();
  return null;
}

const hostActions = {
  start() {
    game.questions = loadQuestions();
    if (!game.questions.length) return 'Нет вопросов — добавьте их в редакторе';
    for (const p of players.values()) Object.assign(p, { score: 0, totalMs: 0, lastPoints: 0, lastCorrect: false, prevRank: null });
    game.index = 0;
    startQuestion();
  },
  reveal() {
    reveal();
  },
  next() {
    if (game.phase === 'reveal') {
      game.phase = game.index >= game.questions.length - 1 ? 'final' : 'leaderboard';
      broadcast();
    } else if (game.phase === 'leaderboard') {
      game.index++;
      startQuestion();
    }
  },
  finish() {
    clearTimeout(game.timer);
    if (game.phase === 'question') reveal();
    game.phase = 'final';
    broadcast();
  },
  reset() {
    clearTimeout(game.timer);
    game.questions = loadQuestions();
    game.phase = 'lobby';
    game.index = -1;
    game.answers.clear();
    for (const p of players.values()) Object.assign(p, { score: 0, totalMs: 0, lastPoints: 0, lastCorrect: false, prevRank: null });
    broadcast();
  },
  kick(body) {
    const p = players.get(body.id);
    if (!p) return;
    for (const res of p.streams) {
      send(res, {}, 'kicked');
      res.end();
    }
    players.delete(p.id);
    game.answers.delete(p.id);
    broadcast();
  },
};

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function joinUrls() {
  const publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (publicUrl) return [publicUrl.replace(/\/$/, '')];
  // Обычные домашние/офисные сети — первыми; VPN-интерфейсы (например, 198.18.x.x) — в конце
  const priority = (ip) =>
    /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  const ips = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(utun|tun|tap|bridge|vmnet|vboxnet|docker|awdl|llw)/i.test(name)) continue;
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  return ips.sort((a, b) => priority(a) - priority(b)).map((ip) => `http://${ip}:${PORT}`);
}

function isHost(req, url) {
  const addr = req.socket.remoteAddress || '';
  const local = !HOST_PASSWORD && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
  return local || url.searchParams.get('key') === HOST_KEY || req.headers['x-host-key'] === HOST_KEY;
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new Error('Некорректные данные'));
      }
    });
    req.on('error', reject);
  });
}

function serveFile(res, dir, rel) {
  const file = path.normalize(path.join(dir, rel));
  if (!file.startsWith(dir)) return json(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);
}

const DEFAULT_EMOJI = ['😀', '😎', '🦊', '🐻', '🐼', '🦁', '🐯', '🐨', '🐸', '🦉', '🐬', '🦋'];

function cleanEmoji(e) {
  const s = String(e || '').trim();
  const first = s ? [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(s)][0].segment : '';
  if (first && first.length <= 16 && /\p{Extended_Pictographic}/u.test(first)) return first;
  return DEFAULT_EMOJI[Math.floor(Math.random() * DEFAULT_EMOJI.length)];
}

function cleanName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/join' && req.method === 'POST') {
    const body = await readBody(req, 10_000);
    const existing = body.id && players.get(body.id);
    if (existing && !body.name) return json(res, 200, { id: existing.id, name: existing.name });

    const name = cleanName(body.name);
    const emoji = cleanEmoji(body.emoji);
    if (name.length < 2) return json(res, 400, { error: 'Никнейм — минимум 2 символа' });
    if (existing) {
      const clash = [...players.values()].find((p) => p.id !== existing.id && p.name.toLowerCase() === name.toLowerCase());
      if (clash) return json(res, 409, { error: 'Этот никнейм уже занят' });
      existing.name = name;
      existing.emoji = emoji;
      broadcast();
      return json(res, 200, { id: existing.id, name });
    }
    const sameName = [...players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (sameName) {
      // Тот же ник, но игрок офлайн — вероятно, закрыл вкладку. Возвращаем его с сохранёнными очками.
      if (!isConnected(sameName)) {
        sameName.emoji = emoji;
        return json(res, 200, { id: sameName.id, name: sameName.name });
      }
      return json(res, 409, { error: 'Этот никнейм уже занят' });
    }
    if (players.size >= MAX_PLAYERS) return json(res, 403, { error: 'Комната заполнена' });
    const id = crypto.randomUUID();
    players.set(id, { id, name, emoji, score: 0, totalMs: 0, lastPoints: 0, lastCorrect: false, prevRank: null, streams: new Set() });
    broadcast();
    return json(res, 200, { id, name });
  }

  if (route === '/api/answer' && req.method === 'POST') {
    const body = await readBody(req, 10_000);
    const p = players.get(body.id);
    if (!p) return json(res, 404, { error: 'Игрок не найден' });
    const error = submitAnswer(p, Number(body.choice));
    return error ? json(res, 409, { error }) : json(res, 200, { ok: true });
  }

  if (route === '/api/leave' && req.method === 'POST') {
    const body = await readBody(req, 10_000);
    const p = players.get(body.id);
    if (p) {
      for (const s of p.streams) s.end();
      players.delete(p.id);
      game.answers.delete(p.id);
      broadcast();
    }
    return json(res, 200, { ok: true });
  }

  // --- Всё ниже доступно только ведущему ---
  if (!isHost(req, url)) return json(res, 403, { error: 'Только для ведущего' });

  if (route === '/api/host/check') return json(res, 200, { ok: true });

  const hostMatch = route.match(/^\/api\/host\/(\w+)$/);
  if (hostMatch && req.method === 'POST' && hostActions[hostMatch[1]]) {
    const body = await readBody(req, 10_000);
    const error = hostActions[hostMatch[1]](body);
    return error ? json(res, 400, { error }) : json(res, 200, { ok: true });
  }

  if (route === '/api/questions' && req.method === 'GET') {
    return json(res, 200, { questions: loadQuestions() });
  }

  if (route === '/api/questions' && req.method === 'PUT') {
    if (game.phase !== 'lobby' && game.phase !== 'final') {
      return json(res, 409, { error: 'Игра идёт — редактировать можно до старта или после финала' });
    }
    const body = await readBody(req, 2 * 1024 * 1024);
    const list = Array.isArray(body.questions) ? body.questions : [];
    const normalized = list.map(normalizeQuestion);
    const bad = normalized.findIndex((q) => !q);
    if (bad !== -1) return json(res, 400, { error: `Вопрос №${bad + 1} заполнен не полностью` });
    saveQuestions(normalized);
    game.questions = normalized;
    broadcast();
    return json(res, 200, { ok: true, count: normalized.length });
  }

  if (route === '/api/upload' && req.method === 'POST') {
    const body = await readBody(req);
    const m = String(body.data || '').match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
    if (!m) return json(res, 400, { error: 'Поддерживаются PNG, JPG, GIF, WEBP' });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(IMAGES_DIR, name), Buffer.from(m[2], 'base64'));
    return json(res, 200, { image: name });
  }

  return json(res, 404, { error: 'Не найдено' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = decodeURIComponent(url.pathname);

  try {
    if (route === '/events') {
      const playerId = url.searchParams.get('player');
      if (playerId) {
        const p = players.get(playerId);
        openStream(req, res);
        if (!p) {
          send(res, {}, 'unknown');
          return res.end();
        }
        p.streams.add(res);
        send(res, playerView(p));
        if (p.streams.size === 1) broadcast(); // игрок снова онлайн
        req.on('close', () => {
          p.streams.delete(res);
          if (players.has(p.id)) broadcast();
        });
        return;
      }
      if (!isHost(req, url)) return json(res, 403, { error: 'Только для ведущего' });
      openStream(req, res);
      hostStreams.add(res);
      send(res, hostView());
      req.on('close', () => hostStreams.delete(res));
      return;
    }

    if (route.startsWith('/api/')) return await handleApi(req, res, url);
    if (route === '/' || route === '/play') return serveFile(res, PUBLIC_DIR, 'index.html');
    if (route === '/host') return serveFile(res, PUBLIC_DIR, 'host.html');
    if (route === '/editor') return serveFile(res, PUBLIC_DIR, 'editor.html');
    if (route.startsWith('/images/')) return serveFile(res, IMAGES_DIR, route.slice('/images/'.length));
    return serveFile(res, PUBLIC_DIR, route.slice(1));
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const urls = joinUrls();
  const line = '─'.repeat(52);
  console.log(`\n${line}\n  🎉  Квиз запущен\n${line}`);
  console.log(`\n  Экран ведущего (откройте на этом компьютере):\n     http://localhost:${PORT}/host`);
  console.log(`\n  Редактор вопросов:\n     http://localhost:${PORT}/editor`);
  if (urls.length) {
    console.log(`\n  Участникам (телефон/ПК в той же Wi‑Fi сети):`);
    for (const u of urls) console.log(`     ${u}`);
    console.log(`\n  Управлять с другого устройства:\n     ${urls[0]}/host?key=${HOST_KEY}`);
  } else {
    console.log('\n  ⚠️  Компьютер не подключён к сети — участники не смогут войти.');
  }
  console.log(`\n  Вопросов загружено: ${game.questions.length}`);
  console.log(`  Остановить сервер: Ctrl + C\n${line}\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌ Порт ${PORT} занят. Возможно, квиз уже запущен в другом окне.`);
    console.error(`   Закройте его или запустите на другом порту: PORT=3001 node server.js\n`);
  } else console.error(e);
  process.exit(1);
});
