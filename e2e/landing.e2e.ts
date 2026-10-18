// The landing pages, as their build serves them (subjects.ts): stepstr's viewer draws each page's model as the
// page scrolls, and at the end the visitor turns it and takes the link. A page reads its own model from its own folder
// and nothing else: no other origin, no other page's files.
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { cacheOf, LANDING_ORIGIN, SUBJECTS } from '../subjects.ts';
import { decode } from '../stepstr/src/lib/state/hash.ts';

const ORIGIN = 'http://127.0.0.1:4383/';
const file = (path: string) => new URL(`../${path}`, import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(file(path), 'utf8'));
const site = json('stepstr/.nsite/config.json') as { url: string };
const webOrigin = site.url;

type Story = { handoff: { beat: string; at: number }; beats: { id: string; len: number; holds: number[] }[] };
type Landing = { camera(): { position: number[]; target: number[] }; painted(): number; stepped(): boolean; story(): Story };

const made = existsSync(file('stepstr/converter/dist/converter.wasm')) && SUBJECTS.every(({ id }) => existsSync(file(cacheOf(id).summary)));
test.skip(!made, 'no landing models: build the converter, then `npm run model`');

const story =(page: Page) => page.evaluate(() => (window as unknown as { landing: Landing }).landing.story());
const camera = (page: Page) => page.evaluate(() => (window as unknown as { landing: Landing }).landing.camera());

/** Scrolls so the viewport's middle is `t` of the way through a beat, and lets the playhead settle. */
async function scrollTo(page: Page, beat: string, t: number) {
	await page.evaluate(
		({ beat, t }) => {
			const rect = document.getElementById(beat)!.getBoundingClientRect();
			window.scrollTo(0, rect.top + scrollY + t * rect.height - innerHeight / 2);
		},
		{ beat, t }
	);
	await page.waitForTimeout(1200);
}

for (const { id, page: path } of SUBJECTS) {
	const url = `${ORIGIN}${path}`;
	const settled = json(`subjects/${id}/model.json`) as { source: { url: string; sha256: string }; up: string };
	const others = SUBJECTS.filter((subject) => subject.id !== id).map((subject) => {
		return (json(`subjects/${subject.id}/model.json`) as { source: { sha256: string } }).source.sha256;
	});

	/** Console errors, page errors, requests that leave the page's origin or folders, and scripts with another model. */
	function watch(page: Page) {
		const problems: string[] = [];
		const reading: Promise<void>[] = [];
		page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
		page.on('console', (m) => {
			if (m.type() === 'error') problems.push(`console: ${m.text()}`);
		});
		page.on('request', (r) => {
			const href = r.url();
			if (href.startsWith('data:') || href.startsWith('blob:')) return;
			const { pathname } = new URL(href);
			const own = pathname.startsWith(`/${path}model/`) || pathname.startsWith(`/${path}stills/`);
			if (!href.startsWith(ORIGIN)) problems.push(`request: ${href}`);
			else if (/\/(model|stills)\//.test(pathname) && !own) problems.push(`another page's file: ${pathname}`);
		});
		page.on('response', (r) => {
			if (!r.url().endsWith('.js')) return;
			reading.push(
				r.text().then((text) => {
					for (const sha of others) if (text.includes(sha)) problems.push(`${r.url()} carries another page's model`);
				})
			);
		});
		return { problems, settled: () => Promise.all(reading).then(() => problems) };
	}

	async function loaded(page: Page) {
		const { glb } = json(cacheOf(id).summary) as { glb: { sha256: string } };
		await expect(page.locator('html')).toHaveAttribute('data-glb', glb.sha256, { timeout: 60_000 });
		await page.waitForFunction(() => 'landing' in window);
	}

	test.describe(id, () => {
		test('draws the model, tells each chapter, and hands over a link to the view', async ({ page }) => {
			const seen = watch(page);
			await page.goto(url);
			await loaded(page);
			expect(await page.evaluate(() => (window as unknown as { landing: Landing }).landing.painted())).toBeGreaterThan(0.02);
			await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', `${LANDING_ORIGIN}/${path}stills/og.jpg`);
			for (const link of await page.locator('a[href^="model/"]').all()) {
				const href = new URL((await link.getAttribute('href'))!, url).href;
				expect((await page.request.get(href)).status(), href).toBe(200);
			}

			for (const heading of await page.locator('.beat h1, .beat h2').all()) {
				await heading.scrollIntoViewIfNeeded();
				await expect(heading).toBeInViewport();
			}

			// Into the hand-off: the link opens this view in the app, on the page's file, as the beat's still records it.
			const { handoff } = await story(page);
			await scrollTo(page, handoff.beat, (handoff.at + 1) / 2);
			const open = page.locator('a[data-open]');
			await expect(open).toHaveAttribute('href', new RegExp(`^${webOrigin.replace(/\./g, '\\.')}/#/u\\?`));
			const view = decode(((await open.getAttribute('href')) ?? '').replace(/^[^#]*/, ''));
			expect(view.source).toEqual({ kind: 'url', url: settled.source.url, sha256: settled.source.sha256 });
			expect(view.up).toBe(settled.up);
			expect(view.camera).not.toBeNull();
			const still = decode((json(`${cacheOf(id).stills}/routes.json`) as Record<string, string>)[handoff.beat]);
			expect(view.cuts).toEqual(still.cuts);
			expect(view.hidden).toEqual(still.hidden);
			expect(view.isolated).toEqual(still.isolated);

			// Turning the model moves the link with it.
			const box = (await page.locator('.stage canvas').boundingBox())!;
			const before = await open.getAttribute('href');
			await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.45);
			await page.mouse.down();
			await page.mouse.move(box.x + box.width * 0.7 + 160, box.y + box.height * 0.45, { steps: 8 });
			await page.mouse.up();
			await expect.poll(() => open.getAttribute('href'), { timeout: 5000 }).not.toBe(before);

			// A wheel over the model scrolls the page; it never zooms.
			const y = await page.evaluate(() => scrollY);
			await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.45);
			await page.mouse.wheel(0, 500);
			await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y + 100);

			expect(await seen.settled()).toEqual([]);
		});

		// The pictures the page draws in shot mode, where window.landing can take any hold, with its own scene or the one
		// before. Node's ray-cast pictures (src/visible.test.ts) cannot see whether the browser draws cut faces.
		test('draws each cut as it comes in', async ({ page, browserName }) => {
			test.skip(browserName !== 'chromium', 'one browser draws the pictures to compare');
			type Shooter = {
				landing: {
					beats(): { id: string; holds: number[] }[];
					shoot(shot: { beat: string; hold: number; scene?: 'prev' }): Promise<string>;
					pixels(): number[];
				};
			};
			await page.goto(`${url}?shot=section`);
			await page.waitForFunction(() => document.documentElement.dataset.shot === 'ready', null, { timeout: 120_000 });
			const beats = await page.evaluate(() => (window as unknown as Shooter).landing.beats());
			const { holds } = beats.find((beat) => beat.id === 'section')!;
			const picture = async (hold: number, scene?: 'prev') => {
				await page.evaluate((shot) => (window as unknown as Shooter).landing.shoot(shot), { beat: 'section', hold, scene });
				return page.evaluate(() => (window as unknown as Shooter).landing.pixels());
			};
			for (let hold = 0; hold < holds.length; hold++) {
				const [now, was] = [await picture(hold), await picture(hold, 'prev')];
				let changed = 0;
				for (let i = 0; i < now.length; i += 3) {
					if (Math.abs(now[i] - was[i]) + Math.abs(now[i + 1] - was[i + 1]) + Math.abs(now[i + 2] - was[i + 2]) > 24) changed++;
				}
				// Of the whole frame, paper included: the cuts that barely showed changed 0% and 1% of it.
				expect(changed / (now.length / 3), `the section's hold ${hold + 1}`).toBeGreaterThan(0.02);
			}
		});

		test.describe('with reduced motion', () => {
			test.use({ reducedMotion: 'reduce' });

			test('keeps the text and the link, and the camera waits for each hold', async ({ page }) => {
				const seen = watch(page);
				await page.goto(url);
				await loaded(page);
				expect(await page.evaluate(() => (window as unknown as { landing: Landing }).landing.stepped())).toBe(true);
				// Between the two holds of a beat that lie furthest apart on screen, a little scrolling must not move the
				// camera. Not in a beat with a frame, which moves the picture as it closes in whatever the holds.
				const { beats } = await story(page);
				const framed = await page.evaluate(() => [...document.querySelectorAll('.beat:has([data-frame])')].map((el) => el.id));
				let gap = { beat: '', t: 0, height: 0 };
				for (const { id, len, holds } of beats.filter((beat) => !framed.includes(beat.id))) {
					for (let i = 1; i < holds.length; i++) {
						const height = (holds[i] - holds[i - 1]) * len;
						if (height > gap.height) gap = { beat: id, t: (holds[i] + holds[i - 1]) / 2, height };
					}
				}
				expect(gap.height, 'a beat with two holds').toBeGreaterThan(0.3);
				await scrollTo(page, gap.beat, gap.t);
				const held = await camera(page);
				await page.evaluate(() => window.scrollBy(0, 60));
				await page.waitForTimeout(800);
				// The viewer derives the same camera again with rounding differences far below a micrometre.
				const near = (v: number[]) => v.map((x) => expect.closeTo(x, 6));
				expect(await camera(page)).toEqual({ position: near(held.position), target: near(held.target) });
				await expect(page.locator('.beat:has(a[data-open]) h2')).not.toBeEmpty();
				await expect(page.locator('a[data-open]')).toHaveAttribute('href', /^https:\/\//);
				expect(await seen.settled()).toEqual([]);
			});
		});
	});
}
