const { test, expect } = require('@playwright/test');
const fixture = require('../content.fixture.json');
const fs = require('node:fs');

test('Три игрока проходят 25 вопросов; ведущий, проектор, смартфоны, редактор', async ({ browser, baseURL }) => {
  const errors = [], photoRequests = [];
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const host = await hostContext.newPage();
  const present = await hostContext.newPage();
  await present.setViewportSize({ width: 1920, height: 1080 });
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })));
  const people = await Promise.all(contexts.map(c => c.newPage()));
  for (const p of [host, present, ...people]) {
    p.on('pageerror', e => errors.push(e.message));
    p.on('request', r => { if (/\/people\/|unsplash|gravatar|pravatar/.test(r.url())) photoRequests.push(r.url()); });
  }
  await host.goto(baseURL + '/host');
  await host.getByPlaceholder('Пароль ведущего').fill('browser-test-only');
  await host.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(host.locator('#qr svg')).toBeVisible();
  await present.goto(baseURL + '/present');
  await expect(present.locator('#qr svg')).toBeVisible();
  await expect(present.locator('#primary')).toBeHidden();
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    await p.goto(baseURL + '/play');
    await p.locator('#nameInput').fill('Тест ' + (i + 1));
    await p.locator('.emo').nth(i + 6).click();
    await p.getByRole('button', { name: 'Войти в игру' }).click();
    await expect(p.locator('#lobby')).toBeVisible();
  }
  await expect(host.locator('#pcount')).toHaveText('3');
  fs.mkdirSync('artifacts/screenshots', { recursive: true });
  await host.screenshot({ path: 'artifacts/screenshots/host-lobby.png', fullPage: true, animations: 'disabled' });
  await present.screenshot({ path: 'artifacts/screenshots/present-lobby.png', fullPage: true, animations: 'disabled' });
  await host.locator('#primary').click();
  for (let i = 0; i < 25; i++) {
    await expect(people[0].locator('#qText')).toHaveText(fixture.questions[i].question);
    await expect(present.locator('.qtitle')).toHaveText(fixture.questions[i].question);
    const q = fixture.questions[i];
    await expect(host.locator('.answer.right')).toHaveCount(0);
    if (i === 0) {
      await host.locator('#pauseBtn').click();
      await expect(people[0].locator('#qSecs')).toContainText('пауза');
      await expect(people[0].locator('.opt').first()).toBeDisabled();
      await host.reload();
      await expect(host.locator('#pauseBtn')).toHaveText('▶ Продолжить');
      await host.locator('#pauseBtn').click();
      await expect(people[0].locator('.opt').first()).toBeEnabled();
    }
    if (i === 14) {
      await host.screenshot({ path: 'artifacts/screenshots/host-question.png', fullPage: true, animations: 'disabled' });
      await present.screenshot({ path: 'artifacts/screenshots/present-question.png', fullPage: true, animations: 'disabled' });
      await people[0].screenshot({ path: 'artifacts/screenshots/play-question.png', fullPage: true, animations: 'disabled' });
      const overflow = await people[0].evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow).toBe(false);
    }
    for (let j = 0; j < 3; j++) {
      await people[j].locator('.opt').nth(j === 1 ? (q.correct + 1) % 4 : q.correct).click();
      await expect(people[j].locator('#qStatus')).toContainText('Ответ принят');
      await expect(people[j].locator('.opt').first()).toBeDisabled();
    }
    if (i === 0) {
      await people[0].reload();
      await expect(people[0].locator('#qStatus')).toContainText('Ответ принят');
      await expect(people[0].locator('.opt.chosen')).toHaveCount(1);
    }
    await host.locator('#primary').click();
    await expect(host.locator('#primary')).toHaveText('Раскрыть ответ');
    await expect(people[0].locator('#qStatus')).toContainText('завершён');
    await host.locator('#primary').click();
    await expect(people[0].locator('#verdict .big')).toHaveText('Верно!');
    await expect(people[1].locator('#verdict .big')).toHaveText('Неверно');
    await expect(present.locator('.answer.right .t')).toHaveText(q.answers[q.correct]);
    if (i === 0) {
      await host.locator('#hideBoardBtn').click();
      await host.locator('#boardBtn').click();
      await expect(present.locator('h1')).toHaveText('Сохраним интригу 🤫');
      await expect(people[0].locator('#boardList .row')).toHaveCount(0);
      await host.locator('#hideBoardBtn').click();
      await expect(present.locator('.board .row')).toHaveCount(3);
      await expect(present.locator('#main')).toHaveAttribute('data-score-animating', 'false');
      await present.screenshot({ path: 'artifacts/screenshots/present-leaderboard.png', fullPage: true, animations: 'disabled' });
    }
    await host.locator('#primary').click();
  }
  await expect(host.locator('h1')).toHaveText('Победители');
  await expect(host.locator('.podium .place')).toHaveCount(3);
  await expect(host.locator('.board .row')).toHaveCount(3);
  await expect(people[0].locator('#final')).toBeVisible();
  await expect(people[0].locator('#finalList .row')).toHaveCount(3);
  await expect(present.locator('#main')).toHaveAttribute('data-score-animating', 'false');
  await present.screenshot({ path: 'artifacts/screenshots/present-final.png', fullPage: true, animations: 'disabled' });
  // Тема и редактор: сохранение исходных вопросов без изменения контента.
  await host.locator('[data-theme-toggle]').click();
  await expect(host.locator('html')).toHaveAttribute('data-theme', 'dark');
  const editor = await hostContext.newPage();
  editor.on('pageerror', e => errors.push(e.message));
  await editor.goto(baseURL + '/editor');
  await expect(editor.locator('.outline-item')).toHaveCount(25);
  await editor.locator('[data-select="14"]').click();
  await expect(editor.locator('#preview h2')).toHaveText(fixture.questions[14].question);
  const downloadPromise = editor.waitForEvent('download');
  await editor.locator('#exportBtn').click();
  const download = await downloadPromise;
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(exported.questions).toHaveLength(25);
  await editor.locator('#jsonFile').setInputFiles({ name: 'quiz.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await expect(editor.locator('#saved')).toHaveText('Есть несохранённые изменения');
  await editor.locator('#save').click();
  await expect(editor.locator('#saved')).toHaveText('Всё сохранено');
  await editor.locator('.toast').waitFor({ state: 'hidden' });
  await editor.screenshot({ path: 'artifacts/screenshots/editor.png', fullPage: true, animations: 'disabled' });
  await editor.close();
  await host.locator('#primary').click();
  await host.locator('#teamBtn').click();
  await expect(host.locator('#teamBtn')).toHaveText('👥 Командная игра');
  await expect(people[0].locator('#lobbyCount')).toContainText('Команда');
  await people[0].locator('#renameBtn').click();
  await expect(people[0].locator('#teamBlock')).toBeVisible();
  await people[0].locator('#teamInput').selectOption('love');
  await people[0].locator('#joinBtn').click();
  await expect(people[0].locator('#lobbyCount')).toContainText('Любовь');
  await host.locator('#primary').click();
  await expect(people[0].locator('#qText')).toHaveText(fixture.questions[0].question);
  await people[0].locator('.opt').nth(fixture.questions[0].correct).click();
  await host.locator('#primary').click();
  await expect(host.locator('#primary')).toHaveText('Раскрыть ответ');
  await host.locator('#primary').click();
  await host.locator('#boardBtn').click();
  await expect(present.locator('h1')).toHaveText('Командный рейтинг');
  await expect(people[0].locator('#boardPlace')).toContainText('Любовь');
  await expect(present.locator('#main')).toHaveAttribute('data-score-animating', 'false');
  await present.screenshot({ path: 'artifacts/screenshots/present-teams.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
  expect(photoRequests).toEqual([]);
  for (const c of [...contexts, hostContext]) await c.close();
});
