const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fixture = require('./content.fixture.json');
const delay = ms => new Promise(r => setTimeout(r, ms));

test('Полный квиз: 30 SSE-клиентов, 25 вопросов, безопасность, таймер и редактор', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-quiz-test-'));
  for (const f of ['server.js', 'questions.json']) fs.copyFileSync(path.join(__dirname, '..', f), path.join(tmp, f));
  fs.cpSync(path.join(__dirname, '..', 'public'), path.join(tmp, 'public'), { recursive: true });
  const port = 32000 + Math.floor(Math.random() * 10000);
  const base = `http://127.0.0.1:${port}`;
  const password = 'integration-test-only';
  const child = spawn(process.execPath, ['server.js'], { cwd: tmp, env: { ...process.env, PORT: String(port), HOST_PASSWORD: password } });
  let stderr = '';
  child.stderr.on('data', c => stderr += c);
  const streams = [];
  async function req(route, body, host = false, method = 'POST') {
    const res = await fetch(base + route, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json', ...(host ? { 'X-Host-Key': password } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  }
  async function stream(route, headers = {}) {
    const abort = new AbortController();
    const r = await fetch(base + route, { signal: abort.signal, headers });
    assert.equal(r.status, 200);
    const s = { values: [], close: () => abort.abort() };
    streams.push(s);
    (async () => {
      try {
        let buffer = '';
        for await (const chunk of r.body) {
          buffer += Buffer.from(chunk).toString();
          const parts = buffer.split('\n\n'); buffer = parts.pop();
          for (const part of parts) {
            const d = part.split('\n').find(l => l.startsWith('data: '));
            if (d) { s.values.push(JSON.parse(d.slice(6))); s.latest = s.values.at(-1); }
          }
        }
      } catch (e) { if (e.name !== 'AbortError') throw e; }
    })();
    s.wait = async predicate => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { if (s.latest && predicate(s.latest)) return s.latest; await delay(10); }
      throw new Error('Не получено состояние SSE: ' + JSON.stringify(s.latest));
    };
    await s.wait(() => true);
    return s;
  }
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base)).ok) break; } catch (_) {}
      if (i === 99) throw new Error('Сервер не запущен: ' + stderr);
      await delay(30);
    }
    for (const page of ['/host', '/play', '/present', '/editor']) assert.equal((await fetch(base + page)).status, 200);
    assert.equal((await req('/api/questions')).status, 403);
    assert.equal((await req('/api/host/start', {})).status, 403);
    assert.equal((await fetch(base + '/people/mark.jpg')).status, 404);
    const check = await fetch(base + '/api/host/check', { headers: { 'X-Host-Key': password } });
    const cookie = check.headers.get('set-cookie').split(';')[0];
    assert(check.headers.get('set-cookie').includes('HttpOnly'));
    const host = await stream('/events', { Cookie: cookie });
    const code = host.latest.roomCode;
    assert.equal((await req('/api/join', { name: 'Неверный код', code: '000000' })).status, 400);
    const people = await Promise.all(Array.from({ length: 30 }, async (_, i) => {
      const r = await req('/api/join', { name: 'Игрок ' + (i + 1), emoji: '🦊', code });
      assert.equal(r.status, 200); return r.data;
    }));
    const feeds = await Promise.all(people.map(p => stream('/events?player=' + p.id + '&token=' + p.token)));
    await host.wait(s => s.players.filter(p => p.connected).length === 30);
    assert(!JSON.stringify(host.latest).includes(people[0].token));
    assert(!JSON.stringify(host.latest).includes('photo'));
    assert.equal((await req('/api/join', { id: people[0].id, name: 'Чужой' })).status, 403);
    assert.equal((await req('/api/answer', { id: people[0].id, choice: 2, index: 0 })).status, 403);
    assert.equal((await req('/api/leave', { id: people[0].id })).status, 403);
    const stolen = await stream('/events?player=' + people[0].id);
    assert.deepEqual(stolen.latest, {}); stolen.close();
    feeds[29].close();
    await host.wait(s => !s.players.find(p => p.id === people[29].id).connected);
    assert.equal((await req('/api/join', { name: people[29].name })).status, 409);
    const restored = await req('/api/join', people[29]);
    assert.equal(restored.data.id, people[29].id);
    feeds[29] = await stream('/events?player=' + people[29].id + '&token=' + people[29].token);
    const saved = (await req('/api/questions', undefined, true)).data.questions;
    assert.equal((await req('/api/questions', { questions: [] }, true, 'PUT')).status, 400);
    assert.equal((await req('/api/questions', { questions: [{ ...saved[0], answers: ['one', 'two'] }] }, true, 'PUT')).status, 400);
    saved[0].time = 5;
    assert.equal((await req('/api/questions', { questions: saved }, true, 'PUT')).status, 200);
    async function action(name) { const r = await req('/api/host/' + name, {}, true); assert.equal(r.status, 200, JSON.stringify(r)); }
    await action('start');
    assert.equal((await req('/api/host/start', {}, true)).status, 400);
    assert.equal((await req('/api/questions', { questions: saved }, true, 'PUT')).status, 409);
    let expected = new Map(people.map(p => [p.id, 0]));
    for (let i = 0; i < 25; i++) {
      let h = await host.wait(s => s.phase === 'question' && s.index === i);
      assert.equal(h.question.text, fixture.questions[i].question);
      assert.deepEqual(h.question.answers, fixture.questions[i].answers);
      assert(!('correct' in h.question));
      await feeds[0].wait(s => s.phase === 'question' && s.index === i);
      assert(!('correct' in feeds[0].latest.question));
      if (i === 0) {
        await action('pause');
        const paused = await host.wait(s => s.phase === 'paused');
        await delay(120);
        assert.equal((await req('/api/answer', { ...people[0], choice: 2, index: i })).status, 409);
        await action('resume');
        h = await host.wait(s => s.phase === 'question');
        assert(h.question.remaining >= paused.question.remaining - 50);
        assert.equal((await req('/api/host/reveal', {}, true)).status, 400);
      }
      const correct = fixture.questions[i].correct;
      assert.equal((await req('/api/answer', { ...people[0], choice: correct, index: i - 1 })).status, 409);
      assert.equal((await req('/api/answer', { ...people[0], choice: null, index: i })).status, 409);
      const answers = await Promise.all(people.slice(0, 29).map((p, j) => req('/api/answer', { ...p, index: i, choice: j === 2 ? (correct + 1) % 4 : correct })));
      answers.forEach(r => assert.equal(r.status, 200));
      assert.equal((await req('/api/answer', { ...people[0], choice: correct, index: i })).status, 409);
      if (i === 0) await host.wait(s => s.phase === 'closed'); // настоящий серверный таймаут 5 секунд
      else await action('close');
      h = await host.wait(s => s.phase === 'closed' && s.index === i);
      assert(!('correct' in h.question));
      assert.equal((await req('/api/answer', { ...people[29], choice: correct, index: i })).status, 409);
      await action('reveal');
      h = await host.wait(s => s.phase === 'reveal' && s.index === i);
      assert.equal(h.question.correct, correct);
      assert.equal(h.distribution[correct], 28);
      assert.equal(h.distribution.reduce((a, b) => a + b, 0), 29);
      for (const p of h.leaderboard) {
        if (p.id === people[2].id || p.id === people[29].id) assert.equal(p.lastPoints, 0);
        else assert(p.lastPoints >= 500 && p.lastPoints <= 1000);
        expected.set(p.id, expected.get(p.id) + p.lastPoints);
        assert.equal(p.score, expected.get(p.id));
      }
      await feeds[0].wait(s => s.phase === 'reveal' && s.index === i);
      assert.equal(feeds[0].latest.result.correct, true);
      if (i === 0) {
        const oldScore = feeds[0].latest.me.score;
        feeds[0].close();
        feeds[0] = await stream('/events?player=' + people[0].id + '&token=' + people[0].token);
        assert.equal(feeds[0].latest.me.score, oldScore);
        assert.equal(feeds[0].latest.myAnswer, correct);
        const reloadedHost = await stream('/events', { Cookie: cookie });
        assert.equal(reloadedHost.latest.phase, 'reveal'); reloadedHost.close();
        await action('toggleboard'); await action('board');
        await feeds[0].wait(s => s.phase === 'leaderboard' && s.leaderboardHidden);
        assert.equal(feeds[0].latest.leaderboard.length, 0);
        await action('toggleboard');
        await feeds[0].wait(s => s.phase === 'leaderboard' && !s.leaderboardHidden);
        assert.equal(feeds[0].latest.leaderboard.length, 30);
      }
      await action('next');
    }
    const final = await host.wait(s => s.phase === 'final');
    assert.equal(final.leaderboard.length, 30);
    assert(final.leaderboard.every((p, i, list) => i === 0 || list[i - 1].score >= p.score));
    const csv = await (await fetch(base + '/api/results.csv', { headers: { Cookie: cookie } })).text();
    assert(csv.includes('Время, мс'));
    // Каждая запись CSV проверяется по сохранённой формуле серверного начисления.
    for (const line of csv.split('\r\n').slice(33)) {
      if (!line) continue;
      const fields = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]);
      if (fields.length !== 6) continue;
      const [q, , , correct, points, ms] = fields;
      const time = saved[Number(q) - 1].time * 1000;
      assert.equal(Number(points), correct === 'Да' ? Math.round(1000 - 500 * Number(ms) / time) : 0);
    }
    await action('reset');
    await host.wait(s => s.phase === 'lobby');
    assert(host.latest.leaderboard.every(p => p.score === 0));
    await action('teammode');
    await host.wait(s => s.teamMode);
    assert.equal((await req('/api/join', { ...people[0], team: 'light' })).status, 200);
    await action('start');
    await host.wait(s => s.phase === 'question');
    assert.equal((await req('/api/host/teammode', {}, true)).status, 400);
    assert.equal((await req('/api/join', { ...people[0], team: 'love' })).status, 409);
    assert.equal((await req('/api/answer', { ...people[0], index: 0, choice: fixture.questions[0].correct })).status, 200);
    await action('close'); await action('reveal');
    const teamResult = await host.wait(s => s.phase === 'reveal');
    assert.equal(teamResult.teamLeaderboard.length, 4);
    for (const team of teamResult.teamLeaderboard) assert.equal(team.score, teamResult.leaderboard.filter(p => p.team === team.id).reduce((sum, p) => sum + p.score, 0));
    await action('finish');
    await host.wait(s => s.phase === 'final');
    assert.equal(stderr, '');
    console.log('OK: 30 подключений, 25 раундов, правильные/неправильные/пропущенные ответы, таймаут, пауза, восстановление, CSV, защита сессий');
  } finally {
    streams.forEach(s => s.close());
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
