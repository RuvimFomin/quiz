const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser', timeout: 120000, workers: 1,
  reporter: [['list']], outputDir: 'artifacts/playwright',
  use: { baseURL: 'http://127.0.0.1:3117', screenshot: 'only-on-failure', launchOptions: process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : process.platform === 'darwin' ? { channel: 'chrome' } : {} },
  webServer: { command: 'node scripts/browser-server.js', url: 'http://127.0.0.1:3117', reuseExistingServer: false, env: { PORT: '3117', HOST_PASSWORD: 'browser-test-only' } },
});
