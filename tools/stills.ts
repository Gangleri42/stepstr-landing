// The landing pages' still pictures, shown where WebGL is missing, data is saved or the live view fails, and in each
// page's link preview. Each is the viewer's own picture of a beat's last hold, photographed from the landing dev server
// in light and dark, with the route of each (routes.json), which the page's index of views links to. They are made
// from the models, some under licences that ask for notices, so they live in .cache/landing/<id>/stills and go into
// the build, never into the repository.
//   npm run stills                  makes what is missing or out of date, for every page
//   npm run stills -- ii            for one page
//   npm run stills -- --force       makes them all again
//   npm run review                  a sheet of every hold beside the hold before, to see what each changes,
//                                           into .cache/landing/<id>/review (never shipped)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { cacheOf, SUBJECTS } from '../subjects.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const SIZE = 1200;
/** The beats whose holds change more than the camera, which the review sheet shows hold by hold, and its cells. */
const REVIEWED = ['orbit', 'measure', 'parts', 'explode', 'section', 'route'];
const CELL = 600;

const options = { force: { type: 'boolean' }, review: { type: 'boolean' } } as const;
const { values: flags, positionals } = parseArgs({ options, allowPositionals: true });

type Shot = { beat: string; hold?: number; scene?: 'prev' };
/** What the page in shot mode offers (src/stage.ts). */
type Shooting = {
	beats(): { id: string; holds: number[] }[];
	shoot(shot: Shot): Promise<string>;
	pixels(): number[];
};

/** The files under a directory, tests left out, in a fixed order. */
function walk(dir: string): string[] {
	return readdirSync(dir)
		.sort()
		.flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? walk(path) : /\.test\.ts$/.test(name) ? [] : [path];
		});
}

/**
 * Everything a page's stills or their routes depend on: its model, its subject's files and page, the director, the
 * viewer that draws it, the route grammar and this script. A change anywhere there makes that page's stills again;
 * --force does so regardless.
 */
function key(id: string, page: string) {
	const hash = createHash('sha256');
	hash.update(readFileSync(join(root, cacheOf(id).summary)));
	const sources = [
		...walk(join(root, 'subjects', id)),
		join(root, `${page}index.html`),
		...walk(join(root, 'src')),
		...walk(join(root, 'stepstr/src/lib/viewer')),
		join(root, 'stepstr/src/lib/state/hash.ts'),
		fileURLToPath(import.meta.url)
	];
	for (const file of sources) hash.update(`${relative(root, file)}\n`).update(readFileSync(file));
	return hash.digest('hex');
}

/** A screenshot of the stage, or of the whole page, encoded by the browser. */
async function photograph(page: Page, type: 'image/webp' | 'image/jpeg', quality: number, whole = false) {
	const options = { type: 'png' as const, animations: 'disabled' as const };
	const png = whole ? await page.screenshot(options) : await page.locator('.stage').screenshot(options);
	return encode(page, png, type, quality);
}

/** A PNG made over as WebP or JPEG by the browser, which has the encoders Node lacks. */
async function encode(page: Page, png: Buffer, type: 'image/webp' | 'image/jpeg', quality: number) {
	const url = await page.evaluate(
		async ({ data, type, quality }) => {
			const img = new Image();
			img.src = `data:image/png;base64,${data}`;
			await img.decode();
			const canvas = document.createElement('canvas');
			Object.assign(canvas, { width: img.naturalWidth, height: img.naturalHeight });
			canvas.getContext('2d')!.drawImage(img, 0, 0);
			return canvas.toDataURL(type, quality);
		},
		{ data: png.toString('base64'), type, quality }
	);
	return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

/** One page's stills: the og picture first, whose page lists the beats, then each beat's last hold, light and dark. */
async function stills(browser: Browser, base: string, id: string, page: string, want: string) {
	const out = join(root, cacheOf(id).stills);
	mkdirSync(out, { recursive: true });
	const shoot = async (shot: string, scheme: 'light' | 'dark', width: number, height: number) => {
		const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: scheme });
		const errors: string[] = [];
		tab.on('pageerror', (e) => errors.push(e.message));
		await tab.goto(`${base}${page}?shot=${shot}`);
		await tab.waitForFunction(() => document.documentElement.dataset.shot === 'ready', null, { timeout: 180_000 });
		await tab.waitForTimeout(300);
		if (errors.length) throw new Error(`${id} ${shot}: ${errors.join('; ')}`);
		return tab;
	};
	const written = new Set<string>();
	const write = (name: string, bytes: Buffer) => {
		writeFileSync(join(out, name), bytes);
		written.add(name);
		console.log(`${id}/${name} ${(bytes.length / 1024).toFixed(0)} KB`);
	};

	const og = await shoot('og', 'light', 1200, 630);
	const beats = await og.$$eval('.scrolly > .beat', (els) => els.map((el) => el.id));
	write('og.jpg', await photograph(og, 'image/jpeg', 0.86, true));
	await og.close();
	const routes: Record<string, string> = {};
	for (const beat of beats) {
		for (const scheme of ['light', 'dark'] as const) {
			const tab = await shoot(beat, scheme, SIZE, SIZE);
			routes[beat] = (await tab.locator('html').getAttribute('data-route')) ?? '';
			write(`${beat}-${scheme}.webp`, await photograph(tab, 'image/webp', 0.8));
			await tab.close();
		}
	}
	// A picture an older storyboard left behind would otherwise ship with the page.
	for (const name of readdirSync(out)) if (/\.(webp|jpg)$/.test(name) && !written.has(name)) rmSync(join(out, name));
	writeFileSync(join(out, 'routes.json'), `${JSON.stringify(routes, null, '\t')}\n`);
	// Every picture the page shows must be one this run made: a renamed beat would leave a broken poster.
	const html = readFileSync(join(root, `${page}index.html`), 'utf8');
	const missing = [...new Set([...html.matchAll(/stills\/([\w.-]+)/g)].map((m) => m[1]))].filter((name) => !written.has(name));
	if (missing.length) throw new Error(`${page}index.html shows stills this run did not make: ${missing.join(', ')}`);
	writeFileSync(join(out, 'key.txt'), `${want}\n`);
}

/**
 * The review sheet of one page: every hold of the beats that change more than the camera, each beside the scene of the
 * hold before at the same camera, with what changed and how much of the picture it changed. For looking at, in light
 * and dark; nothing here ships.
 */
async function review(browser: Browser, base: string, id: string, page: string) {
	const out = join(root, cacheOf(id).review);
	mkdirSync(out, { recursive: true });
	const report: { beat: string; hold: number; change: string; changed: number }[] = [];
	for (const scheme of ['light', 'dark'] as const) {
		const tab = await browser.newPage({ viewport: { width: CELL, height: CELL }, deviceScaleFactor: 1, colorScheme: scheme });
		await tab.goto(`${base}${page}?shot=iso`);
		await tab.waitForFunction(() => document.documentElement.dataset.shot === 'ready', null, { timeout: 180_000 });
		type Shooter = { landing: Shooting };
		const listed = await tab.evaluate(() => (window as unknown as Shooter).landing.beats());
		const beats = listed.filter((beat) => REVIEWED.includes(beat.id));
		const take = async (shot: Shot) => {
			const change = await tab.evaluate((shot) => (window as unknown as Shooter).landing.shoot(shot), shot);
			const png = await tab.locator('.stage').screenshot({ type: 'png', animations: 'disabled' });
			const pixels = await tab.evaluate(() => (window as unknown as Shooter).landing.pixels());
			return { change, png, pixels };
		};
		const rows: { beat: string; cells: { hold: number; of: number; change: string; changed: number; now: string; was: string }[] }[] = [];
		for (const { id: beat, holds } of beats) {
			const cells = [];
			for (let hold = 0; hold < holds.length; hold++) {
				const now = await take({ beat, hold });
				const was = await take({ beat, hold, scene: 'prev' });
				let changed = 0;
				for (let i = 0; i < now.pixels.length; i += 3) {
					const d = [0, 1, 2].reduce((sum, c) => sum + Math.abs(now.pixels[i + c] - was.pixels[i + c]), 0);
					if (d > 24) changed++;
				}
				const share = changed / Math.max(1, now.pixels.length / 3);
				writeFileSync(join(out, `${beat}-${hold}-${scheme}.webp`), await encode(tab, now.png, 'image/webp', 0.8));
				writeFileSync(join(out, `${beat}-${hold}-prev-${scheme}.webp`), await encode(tab, was.png, 'image/webp', 0.8));
				if (scheme === 'light') report.push({ beat, hold, change: now.change, changed: Number(share.toFixed(3)) });
				const data = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
				cells.push({ hold, of: holds.length, change: now.change, changed: share, now: data(now.png), was: data(was.png) });
			}
			rows.push({ beat, cells });
		}
		await tab.close();

		// Rows of beats, a hold to a cell: the hold large, the hold before small in its corner, and a caption.
		const columns = Math.max(...rows.map((row) => row.cells.length));
		const sheet = await browser.newPage({
			viewport: { width: 140 + columns * 320, height: rows.length * 352 + 16 },
			deviceScaleFactor: 1,
			colorScheme: scheme
		});
		const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
		const cell = (c: (typeof rows)[number]['cells'][number], beat: string) => `
			<figure><img class="now" src="${c.now}" /><img class="was" src="${c.was}" />
			<figcaption>${escape(beat)} ${c.hold + 1}/${c.of} · ${escape(c.change)} · ${(c.changed * 100).toFixed(0)}%</figcaption></figure>`;
		await sheet.setContent(`<!doctype html><style>
			body { margin: 8px; font: 13px/1.3 system-ui; background: Canvas; color: CanvasText; color-scheme: ${scheme}; }
			.row { display: flex; gap: 16px; align-items: flex-start; height: 352px; }
			.row > h2 { width: 108px; font-size: 14px; margin: 8px 0 0; }
			figure { position: relative; margin: 0; width: 304px; }
			.now { width: 304px; height: 304px; display: block; }
			.was { position: absolute; left: 0; top: 0; width: 96px; height: 96px; border: 2px solid CanvasText; }
			figcaption { margin-top: 4px; }
		</style>${rows.map((row) => `<div class="row"><h2>${escape(row.beat)}</h2>${row.cells.map((c) => cell(c, row.beat)).join('')}</div>`).join('')}`);
		await sheet.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
		writeFileSync(join(out, `sheet-${scheme}.webp`), await photograph(sheet, 'image/webp', 0.85, true));
		await sheet.close();
		console.log(`${id}: review sheet, ${scheme}`);
	}
	writeFileSync(join(out, 'review.json'), `${JSON.stringify(report, null, '\t')}\n`);
	for (const row of report) console.log(`${id} ${row.beat} ${row.hold + 1}: ${row.change} · ${(row.changed * 100).toFixed(0)}% changed`);
}

async function main() {
	const ids = positionals.length ? positionals : SUBJECTS.map((subject) => subject.id);
	const todo: { id: string; page: string; want: string }[] = [];
	for (const id of ids) {
		const subject = SUBJECTS.find((s) => s.id === id);
		if (!subject) throw new Error(`subjects.ts lists no subject "${id}"`);
		const { summary, stills: dir } = cacheOf(id);
		const how = `run \`npm run model -- ${id}\``;
		if (!existsSync(join(root, summary))) throw new Error(`The landing page "${id}" has no model yet: ${how}.`);
		const want = key(id, subject.page);
		const keyFile = join(root, dir, 'key.txt');
		const current = existsSync(keyFile) && readFileSync(keyFile, 'utf8').trim() === want && existsSync(join(root, dir, 'og.jpg'));
		if (current && !flags.force) console.log(`landing stills, ${id}: up to date`);
		else todo.push({ ...subject, want });
	}
	if (flags.review) {
		todo.length = 0;
		for (const id of ids) todo.push({ ...SUBJECTS.find((s) => s.id === id)!, want: '' });
	}
	if (!todo.length) return;
	const server = await createServer({
		configFile: join(root, 'vite.config.ts'),
		server: { port: 5185, strictPort: false },
		logLevel: 'warn'
	});
	await server.listen();
	const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5185/';
	const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
	try {
		for (const { id, page, want } of todo) {
			if (flags.review) await review(browser, base, id, page);
			else await stills(browser, base, id, page, want);
		}
	} finally {
		await browser.close();
		await server.close();
	}
}

await main();
