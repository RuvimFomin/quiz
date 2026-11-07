// 50 независимых мобильных интерфейсов в Chrome. Пароль вводится скрыто через stdin.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const base = new URL(process.argv[2] || 'https://quiz-841v.onrender.com').origin;
const runId = Date.now().toString(36);
const out = path.join('artifacts', 'mobile50', runId);
fs.mkdirSync(out, { recursive: true });
const sizes = [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 412, height: 915 }];
const errors = [], networkErrors = [], httpErrors = [], metrics = {};
const report = { runId, target: base, startedAt: new Date().toISOString(), sessions: 50, engine: 'Chromium', sizes, checks: [], rounds: 0, errors, networkErrors, httpErrors, screenshots: [] };
let browser, adminContext, host, presenter, key = '', ownsGame = false, closing = false;
const phones = [];
const secrets = new Set();
const scrub = text => { for (const secret of secrets) if (secret) text = String(text).split(secret).join('[redacted]'); return String(text); };
function check(name, condition) { assert(condition, name); report.checks.push(name); }
function sample(name, value) { (metrics[name] ||= []).push(value); }
async function password() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  console.log('Ready for host password on stdin (hidden)'); process.stdin.resume();
  return new Promise(resolve => {
    let result = '';
    const read = chunk => {
      for (const c of chunk.toString()) {
        if (c === '\r' || c === '\n') { process.stdin.off('data', read); if (process.stdin.isTTY) process.stdin.setRawMode(false); process.stdin.pause(); return resolve(result); }
        if (c === '\u0003') process.exit(130);
        result += c;
      }
    };
    process.stdin.on('data', read);
  });
}
function observe(page, label) {
  page.on('pageerror', e => errors.push(label + ': ' + scrub(e.message)));
  page.on('crash', () => errors.push(label + ': page crashed'));
  page.on('response', response => { if (response.status() >= 500) httpErrors.push({ label, status: response.status(), path: new URL(response.url()).pathname }); });
  page.on('requestfailed', req => {
    if (closing || phones.some(p => p.page === page && p.offline)) return;
    const reason = req.failure()?.errorText || '';
    if (reason.includes('ERR_ABORTED')) return;
    networkErrors.push({ label, path: new URL(req.url()).pathname, reason });
  });
}
async function admin(action, body = {}) {
  const response = await adminContext.request.post(base + '/api/host/' + action, { data: body });
  assert.equal(response.status(), 200, action);
}
async function state(page) { return page.evaluate(() => ({ phase: state.phase, index: state.index, score: state.me?.score, name: state.me?.name, emoji: state.me?.emoji, answer: state.myAnswer, points: state.result?.points, correct: state.result?.correct, questionHasKey: state.question ? 'correct' in state.question : false })); }
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' }); report.screenshots.push(name);
}
async function waitPhones(phase, index) {
  await Promise.all(phones.map(({ page }) => page.waitForFunction(({ phase, index }) => typeof state !== 'undefined' && state?.phase === phase && (index == null || state.index === index), { phase, index }, { timeout: 25000 })));
}
async function cleanup() {
  closing = true;
  if (adminContext && host) {
    try {
      if (ownsGame) await admin('reset');
      const ownPlayers = await host.evaluate(prefix => state?.players?.filter(p => p.name.startsWith(prefix)).map(p => p.id) || [], 'MB' + runId + '-');
      for (const id of ownPlayers) await admin('kick', { id });
      const names = await (await adminContext.request.get(base + '/api/names')).json();
      check('All own test profiles removed', !names.taken.some(n => n.startsWith('mb' + runId + '-')));
    } catch (e) { errors.push('Cleanup: ' + scrub(e.message)); }
  }
  await browser?.close().catch(() => {});
}
(async () => {
  try {
    key = process.env.QUIZ_HOST_PASSWORD || await password(); secrets.add(key);
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : process.platform === 'darwin' ? { channel: 'chrome' } : {}), args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    report.browserVersion = browser.version();
    adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, baseURL: base });
    const auth = await adminContext.request.get('/api/host/check', { headers: { 'X-Host-Key': key } }); key = '';
    assert.equal(auth.status(), 200, 'Host password');
    host = await adminContext.newPage(); observe(host, 'host');
    await host.goto(base + '/host');
    await host.waitForFunction(() => typeof state !== 'undefined' && state !== null);
    let initial = await host.evaluate(() => ({ phase: state.phase, count: state.players.length }));
    report.initialRoom = initial;
    if (process.argv.includes('--clear-lobby')) {
      assert.equal(initial.phase, 'lobby', 'Only lobby profiles may be cleared');
      const ids = await host.evaluate(() => state.players.map(p => p.id));
      for (const id of ids) await admin('kick', { id });
      await host.waitForFunction(() => state.players.length === 0);
      initial = await host.evaluate(() => ({ phase: state.phase, count: state.players.length }));
      report.clearedLobbyProfiles = ids.length;
    }
    if (process.argv.includes('--inspect')) { report.mode = 'preflight'; console.log(JSON.stringify({ room: initial })); return; }
    check('Room starts empty in lobby', initial.phase === 'lobby' && initial.count === 0);
    ownsGame = true;
    const content = await (await adminContext.request.get('/api/questions')).json();
    assert.equal(content.questions.length, 25);
    presenter = await adminContext.newPage(); observe(presenter, 'presenter');
    await presenter.setViewportSize({ width: 1920, height: 1080 }); await presenter.goto(base + '/present');
    const began = performance.now();
    for (let start = 0; start < 50; start += 5) {
      await Promise.all(Array.from({ length: 5 }, async (_, offset) => {
        const i = start + offset, name = 'MB' + runId + '-' + String(i + 1).padStart(2, '0');
        const context = await browser.newContext({ baseURL: base, viewport: sizes[i % sizes.length], isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        const page = await context.newPage(); const phone = { context, page, name, number: i + 1, offline: false, expectedScore: 0 }; phones.push(phone); observe(page, name);
        await context.addInitScript(dark => localStorage.setItem('quiz-theme', dark ? 'dark' : 'light'), i % 2 === 1);
        await page.goto('/play');
        await page.locator('#nameInput').fill(name);
        await page.locator('.emo').nth(i % 24).tap();
        await page.locator('#joinBtn').tap();
        await expect(page.locator('#lobby')).toBeVisible({ timeout: 20000 });
      }));
      console.log('Mobile UI ready: ' + phones.length + '/50');
    }
    phones.sort((a, b) => a.number - b.number);
    check('50 isolated browser contexts', new Set(phones.map(p => p.context)).size === 50);
    await expect(host.locator('#pcount')).toHaveText('50', { timeout: 20000 });
    sample('all50Registered', performance.now() - began);
    await screenshot(host, 'host-50-players.png');
    await host.locator('#primary').click();
    for (let i = 0; i < 25; i++) {
      const q = content.questions[i];
      const arrival = performance.now(); await waitPhones('question', i); sample('all50QuestionUI', performance.now() - arrival);
      await expect(presenter.locator('.qtitle')).toHaveText(q.question);
      check('Q' + (i + 1) + ': same question and no answer key in all 50 UIs', (await Promise.all(phones.map(async ({ page }) => ({ s: await state(page), text: await page.locator('#qText').textContent(), buttons: await page.locator('.opt').count() })))).every(v => v.s.index === i && !v.s.questionHasKey && v.text === q.question && v.buttons === 4));
      if (i === 0) {
        await host.locator('#pauseBtn').click(); await waitPhones('paused', i);
        check('Pause disables answers on all 50 phones', (await Promise.all(phones.map(({ page }) => page.locator('.opt').first().isDisabled()))).every(Boolean));
        await host.reload(); await expect(host.locator('#pauseBtn')).toHaveText('▶ Продолжить'); await host.locator('#pauseBtn').click(); await waitPhones('question', i);
      }
      if (i === 14) {
        const overflow = await Promise.all(phones.map(({ page }) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
        check('Long question has no horizontal overflow at all mobile widths', overflow.every(v => !v));
        await screenshot(phones[0].page, 'phone-360-light-question15.png');
        await screenshot(phones[1].page, 'phone-390-dark-question15.png');
        await screenshot(phones[2].page, 'phone-412-light-question15.png');
      }
      await Promise.all(phones.map(async phone => {
        const selected = phone.number % 5 === 0 ? (q.correct + 1) % 4 : q.correct;
        const t = performance.now();
        await phone.page.locator('.opt').nth(selected).tap();
        await phone.page.waitForFunction(selected => state?.myAnswer === selected, selected, { timeout: 15000 });
        await expect(phone.page.locator('#qStatus')).toContainText('Ответ принят', { timeout: 15000 });
        sample('tapToConfirmation', performance.now() - t);
      }));
      check('Q' + (i + 1) + ': answers locked after tap on all 50 phones', (await Promise.all(phones.map(({ page }) => page.locator('.opt').first().isDisabled()))).every(Boolean));
      if (i === 0) {
        const recovering = phones.slice(0, 5);
        const before = await Promise.all(recovering.map(({ page }) => state(page)));
        for (const p of recovering) p.offline = true;
        await Promise.all(recovering.map(p => p.context.route('**/*', route => route.abort('internetdisconnected'))));
        // Abort new requests only in the selected contexts; close their existing SSE streams to model a dropped connection.
        await Promise.all(recovering.map(p => p.page.evaluate(() => { es.close(); connect(); })));
        await Promise.all(recovering.map(p => expect(p.page.locator('#conn')).toBeVisible({ timeout: 12000 })));
        await Promise.all(recovering.map(p => p.context.unroute('**/*')));
        await Promise.all(recovering.map(p => expect(p.page.locator('#conn')).toBeHidden({ timeout: 20000 })));
        const after = await Promise.all(recovering.map(({ page }) => state(page)));
        check('Five phones recover after forced SSE interruption and offline network', after.every((s, j) => s.answer === before[j].answer && s.name === before[j].name && s.emoji === before[j].emoji));
        for (const p of recovering) p.offline = false;
      }
      await host.locator('#primary').click(); await expect(host.locator('#primary')).toHaveText('Раскрыть ответ'); await waitPhones('closed', i);
      await host.locator('#primary').click(); await waitPhones('reveal', i);
      check('Q' + (i + 1) + ': all 50 results and cumulative scores correct', (await Promise.all(phones.map(async phone => {
        const s = await state(phone.page), expectedCorrect = phone.number % 5 !== 0;
        phone.expectedScore += s.points;
        return s.correct === expectedCorrect && s.score === phone.expectedScore && (expectedCorrect ? s.points >= 500 && s.points <= 1000 : s.points === 0);
      }))).every(Boolean));
      if (i === 0) {
        const before = await Promise.all(phones.slice(0, 5).map(({ page }) => state(page)));
        await Promise.all(phones.slice(0, 5).map(({ page }) => page.reload()));
        await waitPhones('reveal', i);
        check('Five mobile reloads retain names, avatar, score and answer', (await Promise.all(phones.slice(0, 5).map(({ page }) => state(page)))).every((s, j) => s.score === before[j].score && s.answer === before[j].answer && s.name === before[j].name && s.emoji === before[j].emoji));
        await host.locator('#hideBoardBtn').click(); await host.locator('#boardBtn').click(); await waitPhones('leaderboard', i);
        check('Hidden ranking absent on all 50 phone screens', (await Promise.all(phones.map(({ page }) => page.locator('#boardList .row').count()))).every(n => n === 0));
        await host.locator('#hideBoardBtn').click();
        await Promise.all(phones.map(({ page }) => expect(page.locator('#boardList .row')).toHaveCount(50)));
      }
      report.rounds++; console.log('Round ' + (i + 1) + '/25: 50 mobile screens OK');
      await host.locator('#primary').click();
    }
    await waitPhones('final');
    await Promise.all(phones.map(({ page }) => expect(page.locator('#finalList .row')).toHaveCount(50)));
    const ranks = await Promise.all(phones.map(({ page }) => page.locator('#finalList').innerText()));
    check('All 50 phones show the same final ranking', ranks.every(r => r === ranks[0]));
    check('All 50 phones show top-three podium', (await Promise.all(phones.map(({ page }) => page.locator('#finalPodium .place').count()))).every(n => n === 3));
    await screenshot(phones[0].page, 'phone-final.png'); await screenshot(presenter, 'projector-final.png');
    check('No JavaScript errors or page crashes', errors.length === 0);
    check('No HTTP 5xx responses', httpErrors.length === 0);
  } catch (e) { errors.push(scrub(e.message)); console.error('FAILED: ' + scrub(e.message)); if (host) await screenshot(host, 'failure-host.png').catch(() => {}); }
  finally {
    await cleanup(); key = '';
    report.finishedAt = new Date().toISOString();
    report.metrics = Object.fromEntries(Object.entries(metrics).map(([name, values]) => { const s = [...values].sort((a, b) => a - b); const p = x => Math.round(s[Math.min(s.length - 1, Math.ceil(s.length * x) - 1)]); return [name, { count: s.length, medianMs: p(.5), p95Ms: p(.95), maxMs: Math.round(s.at(-1)) }]; }));
    report.passed = errors.length === 0 && httpErrors.length === 0 && (report.rounds === 25 || report.mode === 'preflight');
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, rounds: report.rounds, checks: report.checks.length, metrics: report.metrics, errors, networkErrors, httpErrors, report: path.join(out, 'report.json') }, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  }
})();
