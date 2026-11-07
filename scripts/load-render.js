// Проверка реального хостинга. Секрет ведущего — только stdin/окружение, в отчёт не попадает.
// node scripts/load-render.js https://quiz-841v.onrender.com --connections-only
// node scripts/load-render.js https://quiz-841v.onrender.com --password-stdin
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const http2 = require('node:http2');
const sessions = new Map();
async function session(kind) {
  if (sessions.has(kind)) return sessions.get(kind);
  const client = http2.connect(base);
  client.on('error', () => {});
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.destroy(); reject(new Error('HTTP/2 connect timeout')); }, 30000);
    client.once('connect', () => { clearTimeout(timer); resolve(client); });
    client.once('error', e => { clearTimeout(timer); reject(e); });
  });
  sessions.set(kind, ready);
  return ready;
}
const base = new URL(process.argv[2] || 'https://quiz-841v.onrender.com').origin;
const connectionsOnly = process.argv.includes('--connections-only');
const runId = Date.now().toString(36);
const pause = ms => new Promise(r => setTimeout(r, ms));
const clients = [], people = [], samples = {}, failures = [], networkErrors = [];
const report = { target: base, startedAt: new Date().toISOString(), clients: 50, mode: connectionsOnly ? 'connections' : 'full-game', transport: 'HTTP/2, 50 independent player streams and concurrent answer requests', rounds: 0, checks: [], failures };
let key = process.env.QUIZ_HOST_PASSWORD || '', cookie = '', host, ownsGame = false;
let shutdown = false;
function metric(name, ms) { (samples[name] ||= []).push(ms); }
function check(name, condition) { assert(condition, name); report.checks.push(name); }
async function passwordStdin() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('Ready for host password on stdin (hidden)\n');
  process.stdin.resume();
  return new Promise(resolve => {
    let value = '';
    const read = chunk => {
      for (const c of chunk.toString()) {
        if (c === '\n' || c === '\r') {
          process.stdin.off('data', read); if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.pause(); return resolve(value);
        }
        if (c === '\u0003') process.exit(130);
        value += c;
      }
    };
    process.stdin.on('data', read);
  });
}
async function request(route, body, admin = false) {
  const start = performance.now();
  try {
    const client = await session('api');
    const result = await new Promise((resolve, reject) => {
      const stream = client.request({ ':path': route, ':method': body === undefined ? 'GET' : 'POST', 'content-type': 'application/json', ...(admin ? { 'x-host-key': key, cookie } : {}) });
      let headers, chunks = [];
      stream.setTimeout(30000, () => { stream.close(http2.constants.NGHTTP2_CANCEL); reject(new Error('HTTP/2 request timeout')); });
      stream.on('response', h => headers = h);
      stream.on('data', c => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => {
        try { resolve({ status: headers[':status'], data: JSON.parse(Buffer.concat(chunks).toString()), response: { headers: { get: name => Array.isArray(headers[name]) ? headers[name][0] : headers[name] } } }); }
        catch (e) { reject(e); }
      });
      stream.end(body === undefined ? undefined : JSON.stringify(body));
    });
    metric(route === '/api/answer' ? 'answerHTTP' : 'otherHTTP', performance.now() - start);
    return result;
  } catch (e) {
    networkErrors.push({ route, message: e.message, cause: e.code || e.name });
    throw new Error(route + ': ' + e.message + ' (' + (e.code || e.name) + ')');
  }
}
async function until(predicate, description, timeout = 20000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (failures.length) throw new Error(failures[0]);
    if (predicate()) return;
    await pause(15);
  }
  throw new Error('Timeout: ' + description);
}
async function openStream(person) {
  const abort = new AbortController();
  const client = { abort, person, state: null, heartbeats: 0, ended: false, receivedAt: 0 };
  clients.push(client);
  const start = performance.now();
  const query = person ? '?player=' + encodeURIComponent(person.id) + '&token=' + encodeURIComponent(person.token) : '';
  const transport = await session('sse');
  const response = transport.request({ ':path': '/events' + query, ...(person ? {} : { cookie }) });
  abort.signal.addEventListener('abort', () => response.close(http2.constants.NGHTTP2_CANCEL));
  response.on('error', () => {});
  response.end();
  const headers = await new Promise((resolve, reject) => { response.once('response', resolve); response.once('error', reject); });
  assert.equal(headers[':status'], 200, 'SSE HTTP');
  metric('SSEConnect', performance.now() - start);
  (async () => {
    const decoder = new TextDecoder(); let buffer = '';
    try {
      for await (const chunk of response) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split('\n\n'); buffer = frames.pop();
        for (const frame of frames) {
          if (frame.startsWith(': ping')) client.heartbeats++;
          const line = frame.split('\n').find(l => l.startsWith('data: '));
          if (line) { client.state = JSON.parse(line.slice(6)); client.receivedAt = performance.now(); }
        }
      }
      client.ended = true;
      if (!abort.signal.aborted && !shutdown) failures.push('SSE unexpectedly ended');
    } catch (e) { client.ended = true; if (!abort.signal.aborted && !shutdown) failures.push('SSE transport: ' + e.name); }
  })();
  await until(() => client.state !== null, 'first SSE snapshot');
  return client;
}
async function action(name) {
  const r = await request('/api/host/' + name, {}, true);
  assert.equal(r.status, 200, 'Host ' + name + ': ' + (r.data.error || ''));
}
function playerClients() { return clients.filter(c => c.person && !c.abort.signal.aborted); }
async function allPhase(phase, index, timeout) {
  await until(() => playerClients().length === 50 && playerClients().every(c => c.state.phase === phase && (index == null || c.state.index === index)), phase + ' for all 50', timeout);
}
async function cleanup() {
  shutdown = true;
  if (ownsGame) {
    try { await action('reset'); } catch (e) { failures.push('Cleanup reset: ' + e.message); }
  }
  for (const c of clients) c.abort.abort();
  if (ownsGame || connectionsOnly) {
    const result = await Promise.allSettled(people.map(p => request('/api/leave', { id: p.id, token: p.token })));
    for (let i = 0; i < result.length; i++) {
      if (result[i].status === 'fulfilled' && result[i].value.status === 200) continue;
      if (!ownsGame) { failures.push('Cleanup player failed'); continue; }
      const r = await request('/api/host/kick', { id: people[i].id }, true).catch(() => null);
      if (r?.status !== 200) failures.push('Cleanup player failed');
    }
    try {
      const names = (await request('/api/names')).data.taken;
      check('Test player profiles removed', !names.some(n => n.startsWith('lt' + runId)));
    } catch (e) { failures.push(e.message); }
  }
}
(async () => {
  try {
    if (!connectionsOnly) {
      if (process.argv.includes('--password-stdin')) key = await passwordStdin();
      if (!key) throw new Error('Host password required via QUIZ_HOST_PASSWORD or --password-stdin');
      const login = await request('/api/host/check', undefined, true);
      assert.equal(login.status, 200, 'Host authentication failed');
      cookie = login.response.headers.get('set-cookie').split(';')[0];
      host = await openStream();
      if (host.state.phase === 'lobby' && host.state.players.length) {
        const priorRuns = fs.existsSync('artifacts/load') ? fs.readdirSync('artifacts/load').filter(f => f.endsWith('.json')).map(f => { try { const r = JSON.parse(fs.readFileSync('artifacts/load/' + f)); return r.target === base ? f.split('-')[0] : ''; } catch (_) { return ''; } }).filter(Boolean) : [];
        const orphaned = host.state.players.filter(p => priorRuns.some(id => p.name.startsWith('LT' + id + '-')));
        for (const p of orphaned) { const r = await request('/api/host/kick', { id: p.id }, true); assert.equal(r.status, 200); }
        await until(() => host.state.players.length === 0, 'cleanup previous test profiles');
      }
      check('Room is empty lobby before test', host.state.phase === 'lobby' && host.state.players.length === 0);
      ownsGame = true;
    } else {
      const names = await request('/api/names');
      check('Room has no existing players', names.status === 200 && names.data.taken.length === 0);
    }
    console.log('Registering 50 test players on ' + base);
    const began = performance.now();
    const registrations = await Promise.allSettled(Array.from({ length: 50 }, async (_, i) => {
      const r = await request('/api/join', { name: 'LT' + runId + '-' + String(i + 1).padStart(2, '0'), emoji: '🧪' });
      assert.equal(r.status, 200, 'Player registration'); people.push(r.data); return r.data;
    }));
    const rejectedRegistration = registrations.find(r => r.status === 'rejected');
    if (rejectedRegistration) throw rejectedRegistration.reason;
    const joined = registrations.map(r => r.value);
    const connections = await Promise.allSettled(joined.map(p => openStream(p)));
    const rejectedConnection = connections.find(r => r.status === 'rejected');
    if (rejectedConnection) throw rejectedConnection.reason;
    await allPhase('lobby');
    check('50 simultaneous SSE sessions received lobby', playerClients().every(c => c.state.playersCount === 50));
    metric('all50Connected', performance.now() - began);
    const excess = await request('/api/join', { name: 'LT-over-capacity', emoji: '🧪' });
    check('51st player rejected at capacity', excess.status === 403);
    console.log('50/50 connected; capacity enforced. Holding connections through heartbeat cycles.');
    if (connectionsOnly) {
      for (let i = 0; i < 3; i++) { await pause(15000); console.log('Alive: ' + playerClients().filter(c => !c.ended).length + '/50, ' + (i + 1) * 15 + ' seconds'); }
      check('All 50 remained connected for 45 seconds', playerClients().every(c => !c.ended && c.heartbeats >= 2));
    } else {
      const content = await request('/api/questions', undefined, true);
      assert.equal(content.data.questions.length, 25);
      const scores = new Map(people.map(p => [p.id, 0]));
      for (let i = 0; i < 25; i++) {
        const started = performance.now();
        if (i === 0) await action('start'); else await action('next');
        await allPhase('question', i);
        metric('questionPropagation', Math.max(...playerClients().map(c => c.receivedAt)) - started);
        check('Q' + (i + 1) + ': correct answer withheld from 50 clients', playerClients().every(c => !('correct' in c.state.question)));
        const q = content.data.questions[i];
        const responses = await Promise.allSettled(people.map((p, j) => request('/api/answer', { id: p.id, token: p.token, index: i, choice: j % 5 === 0 ? (q.correct + 1) % 4 : q.correct })));
        const rejected = responses.find(r => r.status === 'rejected');
        if (rejected) throw rejected.reason;
        check('Q' + (i + 1) + ': 50 simultaneous answers accepted', responses.every(r => r.value.status === 200));
        const duplicate = await request('/api/answer', { id: people[0].id, token: people[0].token, index: i, choice: q.correct });
        check('Q' + (i + 1) + ': duplicate rejected', duplicate.status === 409);
        if (i === 0) {
          console.log('Waiting for actual server timer with 50 connected players…');
          await allPhase('closed', i, 40000);
          check('50 connections survived actual question timer', playerClients().every(c => !c.ended && c.heartbeats >= 1));
        } else await action('close');
        await allPhase('closed', i);
        check('Q' + (i + 1) + ': closed voting still withholds key', playerClients().every(c => !('correct' in c.state.question)));
        const revealStart = performance.now(); await action('reveal'); await allPhase('reveal', i);
        metric('revealPropagation', Math.max(...playerClients().map(c => c.receivedAt)) - revealStart);
        check('Q' + (i + 1) + ': results and scores correct for all 50', playerClients().every(c => {
          const result = c.state.result; const idx = people.findIndex(p => p.id === c.person.id); const correct = idx % 5 !== 0;
          if (result.correct !== correct || result.answered !== true || (correct ? result.points < 500 || result.points > 1000 : result.points !== 0)) return false;
          scores.set(c.person.id, scores.get(c.person.id) + result.points);
          return c.state.me.score === scores.get(c.person.id) && c.state.question.correct === q.correct;
        }));
        if (i === 0) {
          const reconnect = playerClients().slice(0, 5);
          reconnect.forEach(c => c.abort.abort());
          await Promise.all(reconnect.map(c => openStream(c.person)));
          await allPhase('reveal', i);
          check('5 players reconnected with scores and answers preserved', reconnect.every(old => playerClients().find(c => c.person.id === old.person.id).state.me.score === scores.get(old.person.id) && playerClients().find(c => c.person.id === old.person.id).state.myAnswer === old.state.myAnswer));
        }
        report.rounds++; console.log('Round ' + (i + 1) + '/25: 50 answers, 50 results OK');
      }
      await action('next'); await allPhase('final');
      check('Final ranking contains 50 players on all 50 clients', playerClients().every(c => c.state.leaderboard.length === 50));
      check('Final ranking sorted and identical', playerClients().every(c => JSON.stringify(c.state.leaderboard) === JSON.stringify(playerClients()[0].state.leaderboard)));
      check('No unexpected stream disconnects', failures.length === 0);
    }
  } catch (e) { failures.push(e.message); console.error('FAILED: ' + e.message); }
  finally {
    await cleanup(); key = ''; cookie = '';
    for (const ready of sessions.values()) { try { (await ready).destroy(); } catch (_) {} }
    report.networkErrors = networkErrors;
    report.finishedAt = new Date().toISOString();
    report.metrics = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const percentile = p => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]);
      return [name, { count: values.length, medianMs: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: Math.round(sorted.at(-1)) }];
    }));
    report.passed = failures.length === 0;
    fs.mkdirSync(path.join('artifacts', 'load'), { recursive: true });
    const file = path.join('artifacts', 'load', runId + '-' + report.mode + '.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, rounds: report.rounds, checks: report.checks.length, metrics: report.metrics, networkErrors, failures, report: file }, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  }
})();
