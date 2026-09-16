// Playwright smoke test — 裏方サーバーごと起動し、AI とカンペは /api/* をモックして主要フローを通す。
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8790',
    ...devices['Pixel 7'],
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'PORT=8790 node server/index.js',
    url: 'http://127.0.0.1:8790/api/health',
    reuseExistingServer: true,
    timeout: 15000,
  },
});
