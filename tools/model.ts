// The landing pages' models (subjects.ts), each converted the way the app converts it, then made small for the
// page (compress.ts). subjects/<id>/model.json pins the source and holds what was settled by looking at
// the model in the app. For each subject it writes .cache/landing/<id>/, which the landing build reads:
//   model/<id>-<sha12>.glb  the compressed GLB, named by the first 12 hex digits of its sha256
//   model/LICENSE.txt       the source's licence file, byte for byte, when model.json pins one
//   model/NOTICE.txt        what was changed, from what, under which licence, where the licence asks for it
//   summary.json            the GLB's pin, the files under model/, the measurement data the measured pair needs, the
//                           source and the counts
// and two files to write the storyboard from: tree.txt, every part with its id, and spheres.json, each part's bounding
// sphere, assembled and fully exploded. The STEP files, the licences and the conversions are kept by sha256 in
// .cache/landing/step and .cache/landing/convert for the next run, whichever subject asks.
//   npm run model                           every subject
//   npm run model -- ii                     one subject
//   npm run model -- --from ../sh-hardware  also look for pinned files there (a clone of the source's
//                                                   repository, or a file), when a commit pin no longer downloads
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { runnerImport } from 'vite';
import { loadConverter } from '../stepstr/converter/loader.js';
import { cacheOf, SUBJECTS } from '../subjects.ts';
import { MESH_RULE, type MeshRule } from '../stepstr/src/lib/convert/mesh-rule.ts';
import type { MeasureData } from '../stepstr/src/lib/measure/format.ts';
import { parseRef } from '../stepstr/src/lib/state/hash.ts';
import { Explode } from '../stepstr/src/lib/viewer/explode.ts';
import { indexParts, type Part, type PartIndex } from '../stepstr/src/lib/viewer/parts.ts';
import { about } from '../stepstr/pipeline/about.ts';
import { compressGlb, glbJson, solidsOf, trimMeasure } from './compress.ts';
import { looksPrivate } from './private-text.ts';

type Pin = { url: string; sha256: string; size: number };
type Settled = {
	/** Whose model it is, for the GLB's copyright and the notice. */
	copyright: string;
	source: Pin & { repository: string; commit: string; path: string; licence: string; licenceFile?: Pin & { path: string } };
	measure?: string[];
	names?: Record<string, string | { name: string; in: string }>;
};
type Converted = {
	glb: Uint8Array;
	measure: MeasureData;
	doc: string;
	unit: string;
	solids: number;
	triangles: number;
	warnings: string[];
};
type Progress = { phase: string; done?: number; total?: number };
type ConvertStep = (
	wasm: unknown,
	step: Uint8Array,
	name: string,
	options: { onProgress(progress: Progress): void; yieldToHost(): Promise<void>; meshRule?: MeshRule }
) => Promise<Converted>;

/**
 * What each licence asks of a changed copy. A source under a licence not listed here stops the run, so a new one is
 * read before a page ships it.
 */
const LICENCES: Record<string, { name: string; notice: boolean }> = {
	// Section 4(b): modified files must carry prominent notices stating that they were changed.
	'Apache-2.0': { name: 'the Apache License, Version 2.0', notice: true },
	Unlicense: { name: 'the Unlicense, which dedicates it to the public domain', notice: false }
};

const at = (path: string) => (isAbsolute(path) ? path : fileURLToPath(new URL(`../${path}`, import.meta.url)));
const CACHE = '.cache/landing';
/** The page loads the GLB before the model shows; past this it would wait too long on a phone. */
const BUDGET = 6_000_000;

function fail(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => readFileSync(at(path));
const save = (path: string, bytes: Uint8Array | string) => {
	mkdirSync(at(path.slice(0, path.lastIndexOf('/'))), { recursive: true });
	writeFileSync(at(path), bytes);
};
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;

const { values: flags, positionals } = parseArgs({ options: { from: { type: 'string', multiple: true } }, allowPositionals: true });
/** Other places a pinned file may already sit: a clone of the source's repository (joined with the pin's path) or a file. */
const elsewhere = (flags.from ?? []).map((path) => resolve(path));

/**
 * Bytes pinned by their sha256: from the landing cache, else from where they may already sit, else downloaded. A
 * directory given with --from is looked into at the pin's path in the repository.
 */
async function pinned(pin: Pin, path: string): Promise<Uint8Array> {
	const kept = `${CACHE}/step/${pin.sha256}`;
	const inside = (place: string) => (existsSync(place) && statSync(place).isDirectory() ? join(place, path) : place);
	const places = [kept, ...elsewhere.map(inside)];
	for (const place of places) {
		if (!existsSync(at(place)) || statSync(at(place)).isDirectory()) continue;
		const bytes = new Uint8Array(read(place));
		if (sha256(bytes) !== pin.sha256) {
			console.warn(`${place} holds other bytes than ${pin.url} at its pin`);
			continue;
		}
		if (place !== kept) save(kept, bytes);
		return bytes;
	}
	console.log(`downloading ${pin.url}`);
	const response = await fetch(pin.url, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok) fail(`${pin.url} answered ${response.status}; a clone of its repository can stand in: --from <clone>`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (sha256(bytes) !== pin.sha256) fail(`${pin.url} sent bytes whose sha256 is not ${pin.sha256}`);
	save(kept, bytes);
	return bytes;
}

/** The app's conversion of the STEP file, kept by the file's sha256 and the conversion id. */
async function convert(step: Uint8Array, sha: string, fileName: string, wasmPath: string, conversion: string): Promise<Converted> {
	const dir = `${CACHE}/convert/${sha}-${conversion}`;
	if (existsSync(at(`${dir}/summary.json`))) {
		const summary = JSON.parse(read(`${dir}/summary.json`).toString('utf8'));
		const measure: MeasureData = JSON.parse(read(`${dir}/measure.json`).toString('utf8'));
		return { ...summary, measure, glb: new Uint8Array(read(`${dir}/model.glb`)) };
	}
	// run.ts and the pipeline behind it import each other through $lib, which only Vite resolves.
	const { module } = await runnerImport<{ convertStep: ConvertStep }>(at('stepstr/src/lib/convert/run.ts'), {
		logLevel: 'warn',
		resolve: { alias: { $lib: at('stepstr/src/lib') } }
	});
	const wasm = await loadConverter(readFileSync(wasmPath), { onOutput: () => {} });
	const start = performance.now();
	let phase = '';
	const result = await module.convertStep(wasm, step, fileName, {
		onProgress: (progress) => {
			if (progress.phase === phase) return;
			phase = progress.phase;
			console.log(`converting: ${phase}${progress.total ? ` (${progress.total} solids)` : ''}`);
		},
		yieldToHost: async () => {},
		meshRule: MESH_RULE
	});
	console.log(`converted in ${((performance.now() - start) / 1000).toFixed(1)} s`);
	const { glb, measure, doc, unit, solids, triangles, warnings } = result;
	save(`${dir}/model.glb`, glb);
	save(`${dir}/measure.json`, JSON.stringify(measure));
	const summary = { doc, unit, solids, triangles, warnings, meshRule: MESH_RULE };
	save(`${dir}/summary.json`, `${JSON.stringify(summary, null, '\t')}\n`);
	return { glb, measure, doc, unit, solids, triangles, warnings };
}

/** The GLB as the viewer has it: the root's glTF scale and turn dropped, so world coordinates are the file's, in mm. */
async function scene(glb: Uint8Array) {
	const loaded = await new GLTFLoader().parseAsync(glb.slice().buffer, '');
	const root = loaded.scene.children[0];
	root.position.set(0, 0, 0);
	root.quaternion.identity();
	root.scale.set(1, 1, 1);
	loaded.scene.updateMatrixWorld(true);
	return { root, index: indexParts(root) };
}

/** A body the tree folds into its occurrence's row: the occurrence's only body, which Measure names by its own id. */
const folded = (part: Part) => part.body && !!part.parent && !part.parent.children.includes(part);

/** Every part, one per line in tree order, folded bodies under the row that shows them. */
function treeText(index: PartIndex) {
	const lines = [
		'# Every part of the model in tree order: id, depth, kind, body meshes at or below it, name (as the tree shows',
		'# it, indented by depth) and component. Kinds: assembly (has rows below it), part, body; fastener explodes',
		'# along its axis; folded is a body the tree shows as its occurrence\'s row, which Measure names by its own id.',
		['# id', 'depth', 'kind', 'meshes', 'name', 'component'].join('\t')
	];
	const visit = (part: Part) => {
		const kind = [part.body ? 'body' : part.children.length ? 'assembly' : 'part', part.fastener && 'fastener', folded(part) && 'folded']
			.filter(Boolean)
			.join(',');
		const name = `${'  '.repeat(part.depth)}${part.name}`;
		lines.push([part.id, part.depth, kind, part.meshes.length, name, part.component ?? ''].join('\t'));
		for (const body of index.byId.values()) if (body.parent === part && folded(body)) visit(body);
		for (const child of part.children) visit(child);
	};
	for (const root of index.roots) visit(root);
	return `${lines.join('\n')}\n`;
}

/** Each part's bounding sphere, as fit() frames it: the sphere around its box, in mm. */
function spheres(root: THREE.Object3D, index: PartIndex) {
	const r2 = (v: number) => Number(v.toFixed(2));
	const sphereOf = (meshes: THREE.Object3D[]) => {
		const box = new THREE.Box3();
		for (const mesh of meshes) box.expandByObject(mesh);
		const sphere = box.getBoundingSphere(new THREE.Sphere());
		return { centre: sphere.center.toArray().map(r2), radius: r2(sphere.radius) };
	};
	const parts = [...index.byId.values()];
	const all = parts.flatMap((p) => p.meshes);
	const measure = () => ({ model: sphereOf(all), parts: parts.map((p) => sphereOf(p.meshes)) });
	const assembled = measure();
	const explode = new Explode();
	explode.attach(index);
	explode.set(1);
	root.updateMatrixWorld(true);
	const exploded = measure();
	explode.set(0);
	root.updateMatrixWorld(true);
	return {
		model: { assembled: assembled.model, exploded: exploded.model },
		parts: Object.fromEntries(
			parts.map((p, i) => [p.id, { name: p.name, assembled: assembled.parts[i], exploded: exploded.parts[i] }])
		)
	};
}

/**
 * Fails on a name in model.json that no row of the tree has, or that several have where it is looked up: in the whole
 * model, or within the part its `in` names.
 */
function checkNames(settled: Settled, index: PartIndex, where: string) {
	const names = settled.names ?? {};
	const within = (part: Part): Part[] => [part, ...part.children.flatMap(within)];
	const resolve = (key: string): Part[] => {
		const entry = names[key] ?? fail(`${where}: "${key}" is used but not named`);
		const { name, in: inside } = typeof entry === 'string' ? { name: entry, in: undefined } : entry;
		const scope = inside ? resolve(inside).flatMap(within) : [...index.byId.values()];
		return scope.filter((p) => p.name === name && !folded(p));
	};
	for (const key of Object.keys(names)) {
		const found = resolve(key);
		const what = `${JSON.stringify(names[key])} (${key})`;
		if (!found.length) fail(`${where}: no part is called ${what}`);
		if (found.length > 1) fail(`${where}: ${found.length} parts are called ${what}; name the part it is in`);
	}
}

/** The notice a licence that asks for one gets: what the page's files are, where they come from, what was changed. */
function notice(settled: Settled, file: string, fileName: string, licenceName: string) {
	const { source } = settled;
	return [
		`The 3D model ${file} and the measurement data that come with it are derived from`,
		`"${fileName}" (${settled.copyright}), ${source.repository}:`,
		`the file ${source.path} at commit ${source.commit},`,
		`${source.size} bytes, sha256 ${source.sha256}.`,
		`It is licensed under ${licenceName}, which is in LICENSE.txt.`,
		'',
		'Changes: stepstr converted the STEP file\'s exact geometry into triangle meshes with OpenCascade, simplified',
		'them, and added edge lines and the B-rep face id of every vertex. The vertices were then reordered, quantized',
		'to 16-bit positions and 10-bit normals, and compressed with meshoptimizer, and the measurement data was cut',
		'down to the parts the page measures. The names, colours and assembly structure are the STEP file\'s.',
		'These changes are stepstr\'s, not the model\'s authors\'.',
		''
	].join('\n');
}

async function make(id: string, wasmPath: string, conversion: string) {
	const where = `subjects/${id}/model.json`;
	if (!existsSync(at(where))) fail(`${where} does not exist`);
	const settled: Settled = JSON.parse(read(where).toString('utf8'));
	const { source } = settled;
	const licence = LICENCES[source.licence] ?? fail(`${where}: the licence "${source.licence}" is not in LICENCES; read it first`);
	const out = cacheOf(id);
	const fileName = decodeURIComponent(source.url.slice(source.url.lastIndexOf('/') + 1));
	console.log(`${id}: ${fileName}`);

	const step = await pinned(source, source.path);
	const licenceText = source.licenceFile && (await pinned(source.licenceFile, source.licenceFile.path));
	const converted = await convert(step, source.sha256, fileName, wasmPath, conversion);
	const glbBefore = sha256(converted.glb);

	const { root, index } = await scene(converted.glb);
	save(`${out.dir}/tree.txt`, treeText(index));
	save(`${out.dir}/spheres.json`, `${JSON.stringify(spheres(root, index), null, '\t')}\n`);
	checkNames(settled, index, where);
	const { solids: solidCount, triangles, unit } = converted;
	console.log(`${fileName}: ${index.byId.size} parts, ${solidCount} solids, ${triangles} triangles, ${unit}, meshed '${MESH_RULE}'`);
	for (const warning of converted.warnings) console.log(`  converter: ${warning}`);
	console.log(`GLB ${glbBefore.slice(0, 12)}…; ${out.dir}/tree.txt and spheres.json written`);

	if (!settled.measure?.length) fail(`${where} names no measured pair yet: settle it, then run this again`);
	const refs = settled.measure.map((token) => parseRef(token) ?? fail(`${where}: "${token}" is no measured item`));
	const solids = [...new Set(solidsOf(glbJson(converted.glb), refs.map((ref) => ref.part)))];

	const { repository, commit, path, url, size } = source;
	const glb = await compressGlb(converted.glb, {
		copyright:
			`${settled.copyright} (${repository}), ${source.licence}: ${path} at ${commit.slice(0, 7)}, ` +
			'converted, simplified, quantized and compressed by stepstr',
		extras: {
			source: { repository, commit, path, url, sha256: source.sha256, size, licence: source.licence },
			changes:
				'Converted from STEP by stepstr: meshed with OpenCascade, simplified, with edge lines and B-rep face ids added; ' +
				'vertices reordered, quantized (16-bit positions, 10-bit normals) and compressed with meshoptimizer.',
			conversion,
			meshRule: MESH_RULE
		}
	});
	const glbSha = sha256(glb);
	const measure = trimMeasure(converted.measure, solids, glbSha);

	const privately = 'looks like a local path, an email or an IP address';
	if (looksPrivate(JSON.stringify(glbJson(glb)))) fail(`the GLB's JSON holds text that ${privately}`);
	if (looksPrivate(JSON.stringify(measure))) fail(`the measurement data holds text that ${privately}`);
	if (glb.length > BUDGET) fail(`the GLB is ${mb(glb.length)}, over the page's ${mb(BUDGET)}`);

	const file = `${id}-${glbSha.slice(0, 12)}.glb`;
	const files = [file];
	save(`${out.model}/${file}`, glb);
	if (licenceText) {
		save(`${out.model}/LICENSE.txt`, licenceText);
		files.push('LICENSE.txt');
	}
	if (licence.notice) {
		if (!licenceText) fail(`${where}: ${source.licence} asks for its text to go with the model; pin licenceFile`);
		save(`${out.model}/NOTICE.txt`, notice(settled, file, fileName, licence.name));
		files.push('NOTICE.txt');
	}
	// Only what this run made stays, so the build ships nothing an older run left.
	for (const old of readdirSync(at(out.model))) if (!files.includes(old)) rmSync(at(`${out.model}/${old}`));
	const summary = {
		glb: { file, sha256: glbSha, size: glb.length },
		files,
		measure,
		step: { url, sha256: source.sha256, size },
		conversion,
		meshRule: MESH_RULE,
		parts: index.byId.size,
		solids: solidCount,
		triangles,
		unit,
		warnings: converted.warnings
	};
	save(out.summary, `${JSON.stringify(summary)}\n`);

	const [measureBefore, measureAfter] = [converted.measure, measure].map((data) => JSON.stringify(data).length);
	console.log(`GLB ${mb(converted.glb.length)} → ${mb(glb.length)} (${out.model}/${file})`);
	const kept = `${solids.length} of ${converted.measure.solids.length} solids`;
	console.log(`measurement data ${kb(measureBefore)} → ${kb(measureAfter)}: ${kept}`);
}

const wasmPath = process.env.CONVERTER_WASM ?? at('stepstr/converter/dist/converter.wasm');
const { conversion, converter } = about(wasmPath);
if (!conversion || !converter) fail('the converter build is missing; build it with `converter/build.sh`');
// A subject not yet listed (its page still in the making) can be named to make its model and tree.
const ids = positionals.length ? positionals : SUBJECTS.map((subject) => subject.id);
for (const id of ids) await make(id, wasmPath, conversion);
