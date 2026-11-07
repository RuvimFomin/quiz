const { test, expect } = require('@playwright/test');
const fs = require('node:fs');

test('Проектор показывает все 50 мест, листает страницы и помещается в 720p/1080p', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.request.get(baseURL + '/api/host/check', { headers: { 'X-Host-Key': 'browser-test-only' } });
  const host = await context.newPage(), projector = await context.newPage();
  const errors = []; for (const p of [host, projector]) p.on('pageerror', e => errors.push(e.message));
  const action = async (name, body = {}) => expect((await context.request.post(baseURL + '/api/host/' + name, { data: body })).status()).toBe(200);
  await host.goto(baseURL + '/host');
  await host.waitForFunction(() => typeof state !== 'undefined' && state);
  await action('reset');
  for (const id of await host.evaluate(() => state.players.map(p => p.id))) await action('kick', { id });
  if (await host.evaluate(() => state.teamMode)) await action('teammode');
  try {
    const players = await Promise.all(Array.from({ length: 50 }, async (_, i) => {
      const r = await context.request.post(baseURL + '/api/join', { data: { name: i === 0 ? 'Ш'.repeat(18) + '01' : 'Участник ' + String(i + 1).padStart(2, '0'), emoji: '🦊' } });
      expect(r.status()).toBe(200); return r.json();
    }));
    await projector.setViewportSize({ width: 1920, height: 1080 }); await projector.goto(baseURL + '/present');
    await host.locator('#primary').click();
    await Promise.all(players.map((p, i) => context.request.post(baseURL + '/api/answer', { data: { ...p, index: 0, choice: i % 5 ? 2 : 0 } })));
    await action('close'); await action('reveal'); await action('board');
    const seen = new Set();
    for (let page = 0; page < 3; page++) {
      await expect(projector.locator('.projected-footer')).toContainText(`${page * 20 + 1}–${Math.min(50, page * 20 + 20)}`);
      const rows = projector.locator('.projected-rows .row');
      await expect(rows).toHaveCount(page < 2 ? 20 : 10);
      for (const rank of await rows.evaluateAll(nodes => nodes.map(n => Number(n.dataset.rank)))) seen.add(rank);
      if (page < 2) await host.locator('#rankNext').click();
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    await expect(host.locator('#rankAuto')).toHaveText('▶ Автолистание');
    await host.locator('#rankAuto').click();
    await expect(projector.locator('.projected-footer')).toContainText('1–20', { timeout: 12000 });
    await host.locator('#rankAuto').click();
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
      await projector.setViewportSize(viewport);
      await projector.reload();
      await expect(projector.locator('.projected-rows .row')).toHaveCount(20);
      await expect(projector.locator('#main')).toHaveAttribute('data-score-animating', 'false');
      const layout = await projector.evaluate(() => {
        const rows = [...document.querySelectorAll('.projected-rows .row')];
        return { overflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth, fits: rows.every(row => { const r = row.getBoundingClientRect(); const name = row.querySelector('.name').getBoundingClientRect(); const score = row.querySelector('.score').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && name.right <= score.left && name.height <= r.height; }) };
      });
      expect(layout).toEqual({ overflow: false, fits: true });
      fs.mkdirSync('artifacts/screenshots', { recursive: true });
      await projector.screenshot({ path: `artifacts/screenshots/projector-ranking-50-${viewport.height}p.png`, animations: 'disabled' });
    }
    await expect(host.locator('.lb > .board .row')).toHaveCount(50);
    await action('finish');
    await expect(projector.locator('.projected-podium .place')).toHaveCount(3);
    await host.locator('#rankNext').click();
    await expect(projector.locator('.projected-footer')).toContainText('1–20');
    await host.locator('#rankNext').click();
    await expect(projector.locator('.projected-footer')).toContainText('21–40');
    await host.locator('#rankNext').click();
    await expect(projector.locator('.projected-footer')).toContainText('41–50');
    expect(errors).toEqual([]);
  } finally {
    await action('reset');
    for (const id of await host.evaluate(() => state.players.map(p => p.id))) await action('kick', { id });
    await context.close();
  }
});
