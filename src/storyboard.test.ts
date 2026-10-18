// Each page's storyboard against its page and its model (subjects.ts). Every part a storyboard names is one its
// model.json settled, and its beats are the page's sections, in order and of the same lengths. A page shows only its own
// model and links to it by relative paths, so it may sit at any path. On the real model (once `npm run model`
// has made it) every name resolves, the timeline keeps its invariants, and each beat's last hold prints a route that
// reopens it. The rows of the "ways in" chapters show what stepstr makes of their inputs.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import type { MeasureData } from '$lib/measure/format';
import { routeFromInput } from '$lib/source/input';
import { decode, defaultState, encode, parseRef, type MeasureRef, type UpAxis } from '$lib/state/hash';
import { Topology } from '$lib/viewer/measure/data';
import { Explode } from '$lib/viewer/explode';
import { indexParts } from '$lib/viewer/parts';
import { lacking, landingModel } from '../test/prerequisites';
import { cacheOf, SUBJECTS } from '../subjects.ts';
import { DESKTOP, PHONE, STILL, type Vec3 } from './camera.ts';
import { describeModel } from './model.ts';
import { check, evaluateStepped, resolve, type Beat } from './timeline.ts';

type Settled = {
	source: {
		repository: string;
		commit: string;
		path: string;
		url: string;
		sha256: string;
		licenceFile?: { path: string; url: string };
	};
	up: UpAxis;
	measure: string[];
	names: Record<string, string | { name: string }>;
	points: Record<string, Vec3>;
};

const storyboards = import.meta.glob<{ STORYBOARD: Beat[] }>('../subjects/*/storyboard.ts', { eager: true });
/** Only the paths: a glue module imports its page's virtual module, which only the landing build provides. */
const glues = Object.keys(import.meta.glob('../subjects/*/subject.ts'));
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const settledOf = (id: string) => JSON.parse(read(`../subjects/${id}/model.json`)) as Settled;
/** The owner and name of a GitHub repository, and a path in it as a URL spells it. */
const github = ({ repository, path }: { repository: string; path: string }) => {
	const [owner, name] = new URL(repository).pathname.split('/').filter(Boolean);
	return { owner, name, path: path.split('/').map(encodeURIComponent).join('/') };
};

/** Every part name a key of the storyboard gives. */
function namesUsed(storyboard: Beat[]) {
	const names = new Set<string>();
	for (const beat of storyboard) {
		for (const key of beat.keys) {
			for (const spec of [key.target, key.size && { centre: key.size.fit }]) {
				if (spec && typeof spec === 'object' && 'centre' in spec && spec.centre !== '*') names.add(spec.centre);
			}
			const listed = [...(key.hidden ?? []), ...(key.isolated ?? []), ...(key.highlight ? [key.highlight] : [])];
			for (const name of listed) names.add(name);
		}
	}
	return names;
}

describe('the landing pages', () => {
	it('are the subjects that have a glue module, each at a page of its own', () => {
		const folders = glues.map((path) => /subjects\/([\w-]+)\/subject\.ts$/.exec(path)![1]).sort();
		expect(SUBJECTS.map((subject) => subject.id).sort()).toEqual(folders);
		expect(new Set(SUBJECTS.map((subject) => subject.page)).size).toBe(SUBJECTS.length);
		for (const { id } of SUBJECTS) expect(storyboards, id).toHaveProperty([`../subjects/${id}/storyboard.ts`]);
	});
});

for (const { id, page } of SUBJECTS) {
	const settled = settledOf(id);
	const html = read(`../${page}index.html`);
	const { STORYBOARD } = storyboards[`../subjects/${id}/storyboard.ts`];
	const others = SUBJECTS.filter((subject) => subject.id !== id).map((subject) => settledOf(subject.id));

	describe(`the ${id} storyboard and its page`, () => {
		it('names only parts the settled model names', () => {
			const settledNames = new Set(Object.values(settled.names).map((n) => (typeof n === 'string' ? n : n.name)));
			expect([...namesUsed(STORYBOARD)].filter((name) => !settledNames.has(name))).toEqual([]);
		});

		it('runs through the page’s sections, in order and of the same lengths', () => {
			const beat = /<section class="beat[^"]*" id="([\w-]+)"[^>]*style="--len: ([\d.]+)"/g;
			const sections = [...html.matchAll(beat)].map((m) => ({ id: m[1], len: Number(m[2]) }));
			expect(sections).toEqual(STORYBOARD.map(({ id, len }) => ({ id, len })));
		});

		it('names only points the settled model has', () => {
			for (const beat of STORYBOARD) {
				for (const key of beat.keys) {
					const target = key.target;
					if (target && typeof target === 'object' && 'point' in target) expect(settled.points).toHaveProperty(target.point);
				}
			}
		});

		it('is its subject’s page, with one hand-off and every index link on a beat', () => {
			expect(/<html[^>]*\sdata-subject="([\w-]+)"/.exec(html)?.[1]).toBe(id);
			expect(html.match(/\sdata-open[\s>]/g)).toHaveLength(1);
			const beats = new Set(STORYBOARD.map((beat) => beat.id));
			for (const [, view] of html.matchAll(/data-view="([\w-]+)"/g)) expect(beats.has(view), view).toBe(true);
		});

		it('links its pictures and model by paths relative to itself, so it may sit at any path', () => {
			expect(html).not.toMatch(/(src|srcset|href|content)="\/(stills|model)\//);
			// The build makes these absolute against the address the pages are published at.
			expect(html).toContain('<meta property="og:url" content="./" />');
			expect(html).toContain('<meta property="og:image" content="stills/og.jpg" />');
		});

		it('pins its source by repository, commit and path, and names the repository', () => {
			const { commit, url, licenceFile } = settled.source;
			const { owner, name, path } = github(settled.source);
			expect(url).toBe(`https://raw.githubusercontent.com/${owner}/${name}/${commit}/${path}`);
			if (licenceFile) {
				const licence = github({ repository: settled.source.repository, path: licenceFile.path });
				expect(licenceFile.url).toBe(`https://raw.githubusercontent.com/${owner}/${name}/${commit}/${licence.path}`);
			}
			expect(html).toContain(settled.source.repository);
		});

		it('shows nothing of the other pages’ models', () => {
			for (const other of others) {
				expect(html).not.toContain(other.source.sha256.slice(0, 8));
				expect(html).not.toContain(other.source.repository);
			}
		});

		it('shows in the ways-in rows what stepstr makes of each input', () => {
			const { repository, commit, sha256 } = settled.source;
			const { owner, name, path } = github(settled.source);
			const raw = new RegExp(`^#/u\\?src=https%3A%2F%2Fraw\\.githubusercontent\\.com%2F${owner}%2F`);
			expect(routeFromInput(`${repository}/blob/${commit}/${path}`)).toHaveProperty('route', expect.stringMatching(raw));
			expect(routeFromInput(settled.source.url)).toHaveProperty('route', expect.stringMatching(raw));
			const blossom = routeFromInput(`blossom:sha256:${sha256}`);
			expect(blossom).toHaveProperty('route', expect.stringMatching(new RegExp(`^#/b/${sha256}`)));
			const raws = '#/u?src=https%3A%2F%2Fraw.githubusercontent.com…';
			const shown = [raws, `#/b/${sha256.slice(0, 8)}…`, `github.com/${owner}/${name}/blob/`];
			for (const text of shown) expect(html).toContain(text);
		});
	});

	describe.skipIf(lacking(landingModel(id)))(`the ${id} storyboard on the real model`, async () => {
		const cache = cacheOf(id);
		type Summary = { glb: { file: string }; files: string[]; measure: MeasureData };
		const summary = JSON.parse(readFileSync(cache.summary, 'utf8')) as Summary;
		const glb = readFileSync(`${cache.model}/${summary.glb.file}`);
		const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
		const { scene } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, '');
		// As the viewer places it: the GLB root's metres and Y up dropped, so nodes are in the file's millimetres.
		const root = scene.children[0];
		root.position.set(0, 0, 0);
		root.quaternion.identity();
		root.scale.set(1, 1, 1);
		scene.updateMatrixWorld(true);
		const parts = indexParts(root);
		const explode = new Explode();
		explode.attach(parts);
		const model = describeModel(scene, parts, (factor) => explode.set(factor), settled.up, settled.points);
		const resolved = resolve(STORYBOARD, model);
		const refs = settled.measure.map(parseRef).filter((ref): ref is MeasureRef => !!ref);
		const topology = new Topology(summary.measure, parts);
		const measured = refs
			.map((ref) => topology.entity(ref))
			.flatMap((entity) => (entity?.type === 'point' ? [entity.position.toArray() as Vec3] : []));

		it('resolves every name', () => {
			expect(resolved.missing).toEqual([]);
		});

		it('keeps the timeline’s rules on a desktop, a phone and in the stills', () => {
			expect(measured).toHaveLength(2);
			expect(check(resolved, [DESKTOP, PHONE, STILL], model, measured)).toEqual([]);
		});

		it('prints for each beat a route that reopens its last hold', () => {
			const source = { kind: 'url' as const, url: settled.source.url, sha256: settled.source.sha256 };
			for (const [index, beat] of STORYBOARD.entries()) {
				const state = evaluateStepped(resolved, index + (beat.holds.at(-1) ?? 0.5) + 1e-6, DESKTOP);
				const measure = state.measure ? refs : [];
				const { hidden, isolated, cuts, camera } = state;
				const route = encode({ ...defaultState(source), up: settled.up, hidden, isolated, cuts, explode: state.explode, camera, measure });
				const view = decode(route);
				expect(view.source, beat.id).toEqual(source);
				expect(view.up, beat.id).toBe(settled.up);
				expect(view.hidden, beat.id).toEqual(state.hidden);
				expect(view.isolated, beat.id).toEqual(state.isolated);
				expect(view.cuts.map((c) => [c.axis, c.flip]), beat.id).toEqual(state.cuts.map((c) => [c.axis, c.flip]));
				expect(view.measure.length, beat.id).toBe(measure.length);
				const target = new THREE.Vector3(...view.camera!.target);
				expect(target.distanceTo(new THREE.Vector3(...state.camera.target)), beat.id).toBeLessThan(0.1);
			}
		});

		it('links only files its model ships', () => {
			for (const [, file] of html.matchAll(/href="model\/([^"]+)"/g)) expect(summary.files, file).toContain(file);
		});
	});
}
