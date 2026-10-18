// The landing pages for start.stepstr.space: a plain Vite build in which stepstr's own viewer draws a
// model as the page scrolls, one page per subject (subjects.ts). tools/model.ts makes each model
// (`npm run model`) into .cache/landing/<id>/model, and tools/stills.ts renders the pictures shown
// without WebGL into .cache/landing/<id>/stills. This config serves both in development, emits them into the build
// next to their page, and hands each page its model's facts as virtual:landing-model/<id>.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { cacheOf, LANDING_ORIGIN, SUBJECTS } from './subjects.ts';
import { mimeOf, readConfig } from './stepstr/pipeline/nostr/config.ts';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** What tools/model.ts writes for a subject, next to its model. */
type Summary = {
	glb: { file: string; sha256: string; size: number };
	/** Everything the page may link under model/: the GLB and the licence files. */
	files: string[];
	measure: unknown;
	step: { url: string; sha256: string; size: number };
	parts: number;
	solids: number;
	triangles: number;
	unit: string;
	warnings: string[];
};

/** A subject's files, as absolute paths. */
function filesOf(id: string) {
	const cache = cacheOf(id);
	return {
		summary: at(`./${cache.summary}`),
		model: at(`./${cache.model}`),
		stills: at(`./${cache.stills}`),
		settled: at(`./subjects/${id}/model.json`)
	};
}

/** The files a directory of the cache holds, by the plain names the page asks for. */
function listing(dir: string) {
	return existsSync(dir) ? readdirSync(dir).filter((name) => /^[\w.-]+$/.test(name)) : [];
}
const pictures = (dir: string) => listing(dir).filter((name) => /\.(webp|jpg)$/.test(name));

function serveFrom(dir: string) {
	return (req: Connect.IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
		const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
		if (!listing(dir).includes(name)) return next();
		res.setHeader('content-type', mimeOf(name));
		res.setHeader('cache-control', 'no-cache');
		res.end(readFileSync(join(dir, name)));
	};
}

/**
 * The models and their pictures. Some are made from files under licences that ask for notices, so none of it is in
 * the repository: generated into .cache, emitted into the build next to each page (<page>model/ and <page>stills/), and
 * described to the page by virtual:landing-model/<id>, together with the settled choices in the subject's model.json
 * and the web viewer's address.
 */
function landingModel(): Plugin {
	const prefix = 'virtual:landing-model/';
	const site = readConfig(at('./stepstr/.nsite/config.json'));
	const origin = site.url ?? 'https://stepstr.space';
	const summary = (id: string): Summary => {
		const { summary } = filesOf(id);
		if (!existsSync(summary)) throw new Error(`The landing page "${id}" has no model yet: run \`npm run model -- ${id}\`.`);
		return JSON.parse(readFileSync(summary, 'utf8'));
	};
	return {
		name: 'landing-model',
		resolveId(source) {
			if (!source.startsWith(prefix)) return null;
			const id = source.slice(prefix.length);
			if (!SUBJECTS.some((subject) => subject.id === id)) throw new Error(`${source}: subjects.ts lists no subject "${id}"`);
			return `\0${source}`;
		},
		configureServer(server) {
			for (const { id, page } of SUBJECTS) {
				const files = filesOf(id);
				server.watcher.add([files.summary, files.settled]);
				server.middlewares.use(`/${page}model`, serveFrom(files.model));
				server.middlewares.use(`/${page}stills`, serveFrom(files.stills));
			}
		},
		// Each page's own: its og addresses made absolute, and its index of views linked to each still's view in the
		// app, by the routes the stills were taken with.
		transformIndexHtml(html, { filename }) {
			const id = /<html[^>]*\sdata-subject="([\w-]+)"/.exec(html)?.[1];
			const subject = SUBJECTS.find((s) => s.id === id);
			if (!subject) throw new Error(`${filename}: its <html data-subject> names no subject in subjects.ts`);
			if (filename !== at(`./${subject.page}index.html`)) {
				throw new Error(`${filename}: the page of "${subject.id}" is ${subject.page}index.html (subjects.ts)`);
			}
			const base = `${LANDING_ORIGIN}/${subject.page}`;
			html = html.replace(
				/(<meta property="og:(?:url|image)" content=")([^"]*)(")/g,
				(_, open: string, content: string, close: string) => `${open}${new URL(content, base).href}${close}`
			);
			const file = join(filesOf(subject.id).stills, 'routes.json');
			if (!existsSync(file)) return html;
			const routes: Record<string, string> = JSON.parse(readFileSync(file, 'utf8'));
			return html.replace(/data-view="([\w-]+)" href="[^"]*"/g, (whole: string, view: string) =>
				routes[view] ? `data-view="${view}" href="${origin}/${routes[view].replace(/&/g, '&amp;')}"` : whole
			);
		},
		handleHotUpdate({ file, server }) {
			const subject = SUBJECTS.find(({ id }) => [filesOf(id).summary, filesOf(id).settled].includes(file));
			if (!subject) return;
			const module = server.moduleGraph.getModuleById(`\0${prefix}${subject.id}`);
			if (module) server.moduleGraph.invalidateModule(module);
			server.ws.send({ type: 'full-reload' });
		},
		load(source) {
			if (!source.startsWith(`\0${prefix}`)) return null;
			const id = source.slice(prefix.length + 1);
			const made = summary(id);
			const files = filesOf(id);
			const settled = JSON.parse(readFileSync(files.settled, 'utf8'));
			this.addWatchFile(files.summary);
			this.addWatchFile(files.settled);
			const model = {
				...settled,
				glb: { path: `model/${made.glb.file}`, sha256: made.glb.sha256, size: made.glb.size },
				data: made.measure,
				step: made.step,
				facts: { parts: made.parts, solids: made.solids, triangles: made.triangles, unit: made.unit, warnings: made.warnings }
			};
			return [`export const model = ${JSON.stringify(model)};`, `export const webOrigin = ${JSON.stringify(origin)};`].join('\n');
		},
		generateBundle() {
			for (const { id, page } of SUBJECTS) {
				const made = summary(id);
				const files = filesOf(id);
				for (const name of made.files) {
					this.emitFile({ type: 'asset', fileName: `${page}model/${name}`, source: readFileSync(join(files.model, name)) });
				}
				for (const name of pictures(files.stills)) {
					this.emitFile({ type: 'asset', fileName: `${page}stills/${name}`, source: readFileSync(join(files.stills, name)) });
				}
			}
		}
	};
}

export default defineConfig({
	root: at('.'),
	base: './',
	publicDir: at('./public'),
	// One page per subject, each at its own path; a path without its slash is no page.
	appType: 'mpa',
	// Its own dependency cache, so this dev server and the app's do not outdate each other's bundles.
	cacheDir: at('./node_modules/.vite'),
	resolve: { alias: [{ find: '$lib', replacement: at('./stepstr/src/lib') }] },
	plugins: [landingModel(), svelte({ configFile: false, preprocess: vitePreprocess(), compilerOptions: { runes: true } })],
	build: {
		outDir: at('./dist'),
		emptyOutDir: true,
		target: 'es2022',
		sourcemap: false,
		// three.js and the viewer in the stage chunk, loaded after the text.
		chunkSizeWarningLimit: 1200,
		rolldownOptions: {
			input: Object.fromEntries(SUBJECTS.map(({ id, page }) => [id, at(`./${page}index.html`)]))
		}
	},
	server: { host: '127.0.0.1', port: 5183, strictPort: true, fs: { allow: ['.'] } },
	preview: { host: '127.0.0.1', port: 4383, strictPort: true },
	// One tsconfig for every file, the submodule's included: its own extends a file SvelteKit generates, absent here.
	tsconfig: 'tsconfig.json',
	// vitest: the pages' own tests; the submodule carries stepstr's, which run there.
	test: { exclude: ['**/node_modules/**', 'stepstr/**', 'dist/**', '.cache/**'] }
});
