// Each landing page's model as `npm run model` leaves it: made from this converter's conversion, its measured
// pair valid on the compressed GLB with the trimmed measurement data and measuring there what the app measures on its
// own conversion, within the page's size budget, and carrying what its licence asks for.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Object3D } from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import type { MeasureData } from '$lib/measure/format';
import { Measurer } from '$lib/measure/measure';
import { formatRow } from '$lib/measure/units';
import { parseRef, type MeasureRef } from '$lib/state/hash';
import { Topology } from '$lib/viewer/measure/data';
import { indexParts } from '$lib/viewer/parts';
import { cacheOf, SUBJECTS } from '../subjects';
import { about } from '../stepstr/pipeline/about';
import { glbJson } from '../tools/compress';
import { CONVERTER, lacking, landingModel } from './prerequisites';

type Summary = {
	glb: { file: string; sha256: string; size: number };
	files: string[];
	measure: MeasureData;
	step: { url: string; sha256: string; size: number };
	conversion: string;
};
type Settled = {
	copyright: string;
	source: {
		url: string;
		sha256: string;
		size: number;
		commit: string;
		repository: string;
		licence: string;
		licenceFile?: { sha256: string };
	};
	measure: string[];
	measureRows: Record<string, string>;
};

/** The page's GLB may not be larger than this (tools/model.ts). */
const BUDGET = 6_000_000;
/** The licences whose text must travel with a changed copy as a notice of the changes (tools/model.ts). */
const NOTICE = { 'Apache-2.0': 'Apache License, Version 2.0' } as Record<string, string>;
const at = (path: string) => new URL(`../${path}`, import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The GLB's parts as the viewer indexes them, with the root's glTF scale and turn dropped as the viewer drops them. */
async function parts(glb: Uint8Array) {
	const { scene } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(glb.slice().buffer, '');
	const root: Object3D = scene.children[0];
	root.position.set(0, 0, 0);
	root.quaternion.identity();
	root.scale.set(1, 1, 1);
	scene.updateMatrixWorld(true);
	return indexParts(root);
}

for (const { id } of SUBJECTS) {
	const cache = cacheOf(id);
	/** Read once, when the first test asks, so a run without the files collects the tests and skips them. */
	let files: ReturnType<typeof read> | null = null;
	const read = () => {
		const summary: Summary = JSON.parse(readFileSync(at(cache.summary), 'utf8'));
		const settled: Settled = JSON.parse(readFileSync(at(`subjects/${id}/model.json`), 'utf8'));
		// The conversion the model was made from, as the app makes it, kept by the pipeline.
		const kept = `.cache/landing/convert/${summary.step.sha256}-${summary.conversion}`;
		return {
			summary,
			settled,
			glb: new Uint8Array(readFileSync(at(`${cache.model}/${summary.glb.file}`))),
			original: new Uint8Array(readFileSync(at(`${kept}/model.glb`))),
			full: JSON.parse(readFileSync(at(`${kept}/measure.json`), 'utf8')) as MeasureData
		};
	};
	const model = () => (files ??= read());

	describe.skipIf(lacking(CONVERTER, landingModel(id)))(`the landing model ${id}`, () => {
		it('was made from the conversion this converter makes', () => {
			const { summary } = model();
			const stale = `the converter or the pipeline changed since: run \`npm run model -- ${id}\``;
			expect(summary.conversion, stale).toBe(about(CONVERTER.path).conversion);
		});

		it('measures the stored pair as the app measures it on its own conversion', async () => {
			const { summary, settled, glb, original, full } = model();
			const refs = settled.measure.map((token) => parseRef(token)).filter((ref): ref is MeasureRef => !!ref);
			expect(refs).toHaveLength(2);
			const page = new Topology([summary.measure], await parts(glb));
			const app = new Topology([full], await parts(original));
			for (const ref of refs) {
				expect(page.valid(ref), `${settled.measure} on the page`).toBe(true);
				expect(app.valid(ref), `${settled.measure} in the app`).toBe(true);
			}
			// The trimmed data holds the measured bodies' solids and nothing else.
			const solids = new Set(refs.map((ref) => page.body(ref.part)!.object.userData.solid as number));
			expect(summary.measure.solids.flatMap((record, i) => (record ? [i] : []))).toEqual([...solids].sort((a, b) => a - b));

			const rows = (topology: Topology) => {
				const [a, b] = refs.map((ref) => topology.entity(ref)!);
				return new Measurer().measure(a, b).rows;
			};
			const [shown, measured] = [rows(page), rows(app)];
			expect(shown.map((row) => row.key)).toEqual(measured.map((row) => row.key));
			shown.forEach((row, i) => {
				expect(Math.abs(row.value - measured[i].value), row.key).toBeLessThanOrEqual(0.002);
				expect(formatRow(row, 2)).toBe(formatRow(measured[i], 2));
			});
			// The rows the app showed for the pair when it was chosen, at its default two decimals.
			expect(Object.fromEntries(measured.map((row) => [row.key, formatRow(row, 2)]))).toEqual(settled.measureRows);
		}, 60_000);

		it('keeps within the page\'s budget, named by its hash', () => {
			const { summary, glb } = model();
			expect(glb.length).toBe(summary.glb.size);
			expect(sha256(glb)).toBe(summary.glb.sha256);
			expect(summary.measure.glb).toBe(summary.glb.sha256);
			expect(summary.glb.file).toBe(`${id}-${summary.glb.sha256.slice(0, 12)}.glb`);
			expect(glb.length).toBeLessThanOrEqual(BUDGET);
		});

		it('names its source and licence, and ships what the licence asks for', () => {
			const { summary, settled, glb } = model();
			const { source } = settled;
			const { asset } = glbJson(glb);
			for (const text of [settled.copyright, source.repository, source.licence]) expect(asset.copyright).toContain(text);
			const { url, size, commit, licence } = source;
			expect(asset.extras?.source).toMatchObject({ url, sha256: source.sha256, size, commit, licence });
			expect(summary.step).toEqual({ url: source.url, sha256: source.sha256, size: source.size });

			const shipped = (name: string) => summary.files.includes(name) && existsSync(at(`${cache.model}/${name}`));
			expect(shipped(summary.glb.file)).toBe(true);
			expect(shipped('LICENSE.txt')).toBe(!!source.licenceFile);
			if (source.licenceFile) expect(sha256(readFileSync(at(`${cache.model}/LICENSE.txt`)))).toBe(source.licenceFile.sha256);
			expect(shipped('NOTICE.txt')).toBe(source.licence in NOTICE);
			if (source.licence in NOTICE) {
				const notice = readFileSync(at(`${cache.model}/NOTICE.txt`), 'utf8');
				const names = [summary.glb.file, source.repository, source.commit, NOTICE[source.licence], 'LICENSE.txt'];
				for (const text of names) expect(notice).toContain(text);
			}
		});
	});
}
