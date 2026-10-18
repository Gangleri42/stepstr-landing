// The landing pages in Chromium, Firefox and WebKit, as their build serves them, on a port of their own so no other
// project's server is taken for them. The test skips when the models are not made (e2e/landing.e2e.ts says how).
//   npx playwright install chromium firefox webkit   once
//   npm run test:e2e
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '*.e2e.ts',
	timeout: 180_000,
	expect: { timeout: 10_000 },
	workers: 3,
	reporter: 'list',
	use: { baseURL: 'http://127.0.0.1:4383', serviceWorkers: 'block' },
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } }
	],
	webServer: {
		command: 'npm run build && npm run preview',
		url: 'http://127.0.0.1:4383/',
		reuseExistingServer: !process.env.CI,
		timeout: 600_000
	}
});
