// Playwright smoke test — 静的サイトを python の http.server で配信して、スマホ幅で主要フローを通す。
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
    command: 'python3 -m http.server 8790 --bind 127.0.0.1',
    url: 'http://127.0.0.1:8790/index.html',
    reuseExistingServer: true,
    timeout: 15000,
  },
});
