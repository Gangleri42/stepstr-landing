// What each page shows at its holds, on the real models (once `npm run model` has made them): ray-cast pictures
// of which body shows at each pixel of the stills' square frame. Every change a hold makes must show in them: a cut
// coming in changes a tenth of the model's pixels, a part switched off uncovers the shot's subject, the subject is what
// the camera sees at its target, and a part about to be kept alone is in the picture before. Bodies rather than
// colours: white parts on the light paper and black ones on the dark sit inside any colour threshold, and shadows move
// with the geometry. A hit on a body's inside is its cut face, which the viewer draws in the body's colour.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import type { Axis, Cut, UpAxis } from '$lib/state/hash';
import { Explode } from '$lib/viewer/explode';
import { cameraUp } from '$lib/viewer/orientation';
import { applyVisibility, indexParts, isShown, type Part } from '$lib/viewer/parts';
import { Section } from '$lib/viewer/section';
import { lacking, landingModel } from '../test/prerequisites';
import { cacheOf, SUBJECTS } from '../subjects.ts';
import { STILL, type Vec3 } from './camera.ts';
import { describeModel } from './model.ts';
import { evaluateStepped, resolve, type Beat, type PointSpec, type State } from './timeline.ts';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** The pictures' side in pixels: the stills' square frame, coarser. */
const SIDE = 96;
/** A cut coming in changes at least this share of the model's pixels. The SO-101's slivers changed 1.5% and 4.7%. */
const CUT_SHOWS = 0.1;
/** A part switched off lets the shot's subject grow by at least this much in the picture... */
const HIDE_GROWS = 1.25;
/** ...and the subject, or a part about to be kept alone, covers at least this share of the frame. */
const SUBJECT_SHARE = 0.01;
/** What the camera sees first toward a part or point target lies within this share of the framed radius of it. */
const SUBJECT_NEAR = 0.25;

const AXES: Axis[] = ['x', 'y', 'z'];
const storyboards = import.meta.glob<{ STORYBOARD: Beat[] }>('../subjects/*/storyboard.ts', { eager: true });
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The target a storyboard's keys have set by a hold: the last one given at or before it, '*' before any. */
function targetAt(storyboard: Beat[], beat: number, t: number): PointSpec {
	for (let b = beat; b >= 0; b--) {
		const keys = storyboard[b].keys.filter((key) => key.target !== undefined && (b < beat || key.t <= t));
		if (keys.length) return keys[keys.length - 1].target!;
	}
	return '*';
}

for (const { id } of SUBJECTS) {
	describe.skipIf(lacking(landingModel(id)))(`what the ${id} page shows at its holds`, async () => {
		const { STORYBOARD } = storyboards[`../subjects/${id}/storyboard.ts`];
		const settled = JSON.parse(read(`../subjects/${id}/model.json`)) as { up: UpAxis; points: Record<string, Vec3> };
		const cache = cacheOf(id);
		const summary = JSON.parse(readFileSync(cache.summary, 'utf8')) as { glb: { file: string } };
		const glb = readFileSync(`${cache.model}/${summary.glb.file}`);
		const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
		const loaded = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, '');
		// As the viewer places it: the GLB root's metres and Y up dropped, so nodes are in the file's millimetres.
		const root = loaded.scene.children[0];
		root.position.set(0, 0, 0);
		root.quaternion.identity();
		root.scale.set(1, 1, 1);
		loaded.scene.updateMatrixWorld(true);
		const parts = indexParts(root);
		const explode = new Explode();
		explode.attach(parts);
		const model = describeModel(loaded.scene, parts, (factor) => explode.set(factor), settled.up, settled.points);
		const resolved = resolve(STORYBOARD, model);

		// Every body, numbered, its meshes ready for rays from both sides: a cut face is a body seen from inside.
		const bodies = [...parts.byId.values()].filter((part) => part.body && part.meshes.length);
		const number = new Map(bodies.map((part, i) => [part, i]));
		const owner = new Map<THREE.Object3D, Part>();
		for (const part of bodies) for (const mesh of part.meshes) owner.set(mesh, part);
		const meshes = [...owner.keys()] as THREE.Mesh[];
		for (const mesh of meshes) {
			(mesh.material as THREE.Material).side = THREE.DoubleSide;
			mesh.geometry.computeBoundsTree();
		}
		/** The bodies of a part, by number: itself if it is one, and every one below it. */
		const bodiesOf = (ids: string[]) => {
			const within = (part: Part) => {
				for (let p: Part | null = part; p; p = p.parent) if (ids.includes(p.id)) return true;
				return false;
			};
			return new Set(bodies.filter(within).map((part) => number.get(part)!));
		};

		const { min, max } = model.bounds;
		/** Whether a cut lies within the model, so it takes something away; parked ones wait outside it. */
		const inside = (cut: Cut) => {
			const i = AXES.indexOf(cut.axis);
			return cut.offset > min[i] && cut.offset < max[i];
		};
		type Scene = { cuts: Cut[]; hidden: string[]; isolated: string[] };
		const sceneOf = (state: State): Scene => ({ cuts: state.cuts.filter(inside), hidden: state.hidden, isolated: state.isolated });

		/** Places the model and the camera as a still of this state does, with the parts and cuts of `scene`. */
		function stage(state: State, scene: Scene) {
			explode.set(state.explode);
			root.updateMatrixWorld(true);
			applyVisibility(parts, new Set(scene.hidden), new Set(scene.isolated));
			const section = new Section();
			section.set(scene.cuts);
			const camera = new THREE.PerspectiveCamera(STILL.fov, STILL.width / STILL.height, 0.1, 1e7);
			const position = new THREE.Vector3(...state.camera.position);
			const target = new THREE.Vector3(...state.camera.target);
			camera.position.copy(position);
			camera.up.copy(cameraUp(position.clone().sub(target).normalize(), settled.up));
			camera.lookAt(target);
			camera.updateMatrixWorld(true);
			const visible = meshes.filter((mesh) => isShown(owner.get(mesh)!));
			const ray = new THREE.Raycaster();
			/** The first thing a ray meets that the cuts keep. */
			const first = () => ray.intersectObjects(visible, false).find((hit) => section.keeps(hit.point)) ?? null;
			return { camera, ray, first };
		}

		/** Which body shows at each pixel, by number; -1 where the paper shows. */
		function picture(state: State, scene: Scene) {
			const { camera, ray, first } = stage(state, scene);
			const labels = new Int32Array(SIDE * SIDE).fill(-1);
			const pixel = new THREE.Vector2();
			for (let j = 0; j < SIDE; j++) {
				for (let i = 0; i < SIDE; i++) {
					ray.setFromCamera(pixel.set(((i + 0.5) / SIDE) * 2 - 1, 1 - ((j + 0.5) / SIDE) * 2), camera);
					const hit = first();
					if (hit) labels[j * SIDE + i] = number.get(owner.get(hit.object)!)!;
				}
			}
			return labels;
		}
		const count = (labels: Int32Array, of: Set<number>) => labels.reduce((n, label) => n + (of.has(label) ? 1 : 0), 0);

		const holds = resolved.beats.flatMap((beat, b) => beat.holds.map((t) => ({ b, t, beat: beat.id })));
		const states = holds.map(({ b, t }) => evaluateStepped(resolved, b + t + 1e-6, STILL));
		const where = (h: number) => `${holds[h].beat} at t = ${holds[h].t}`;

		it('shows each cut as it comes in', () => {
			const faint: string[] = [];
			states.forEach((state, h) => {
				if (state.explode > 0.01) return;
				state.cuts.forEach((cut, k) => {
					const was = states[h - 1]?.cuts[k];
					if (!inside(cut) || (was && was.axis === cut.axis && was.flip === cut.flip && inside(was))) return;
					const scene = sceneOf(state);
					const withIt = picture(state, scene);
					const without = picture(state, { ...scene, cuts: scene.cuts.filter((other) => other !== cut) });
					let model = 0, changed = 0;
					for (let p = 0; p < withIt.length; p++) {
						if (withIt[p] >= 0 || without[p] >= 0) model++;
						if (withIt[p] !== without[p]) changed++;
					}
					const share = model ? changed / model : 0;
					if (share < CUT_SHOWS) faint.push(`${where(h)}: the ${cut.axis} cut changes ${(share * 100).toFixed(1)}% of the model`);
				});
			});
			expect(faint).toEqual([]);
		}, 120_000);

		it('uncovers the shot’s subject with each part it switches off', () => {
			const idle: string[] = [];
			states.forEach((state, h) => {
				const newly = state.hidden.filter((part) => !states[h - 1]?.hidden.includes(part));
				if (!newly.length || state.isolated.length) return;
				const spec = targetAt(STORYBOARD, holds[h].b, holds[h].t);
				if (typeof spec !== 'object' || !('centre' in spec)) {
					idle.push(`${where(h)}: a part goes off, but the shot's target is no part`);
					return;
				}
				const subject = bodiesOf(model.parts.get(spec.centre)?.ids ?? []);
				const scene = sceneOf(state);
				const before = count(picture(state, { ...scene, hidden: scene.hidden.filter((part) => !newly.includes(part)) }), subject);
				const after = count(picture(state, scene), subject);
				if (after < HIDE_GROWS * Math.max(1, before) || after < SUBJECT_SHARE * SIDE * SIDE) {
					idle.push(`${where(h)}: ${spec.centre} goes from ${before} to ${after} pixels`);
				}
			});
			expect(idle).toEqual([]);
		}, 120_000);

		it('sees the shot’s subject first, toward its target', () => {
			const hidden: string[] = [];
			states.forEach((state, h) => {
				const spec = targetAt(STORYBOARD, holds[h].b, holds[h].t);
				if (typeof spec !== 'object' || Array.isArray(spec)) return;
				const { ray, first } = stage(state, sceneOf(state));
				const from = new THREE.Vector3(...state.camera.position);
				const target = new THREE.Vector3(...state.shot.target);
				ray.set(from, target.clone().sub(from).normalize());
				const hit = first();
				if (!hit) return;
				const subject = 'centre' in spec ? bodiesOf(model.parts.get(spec.centre)?.ids ?? []) : new Set<number>();
				const onSubject = subject.has(number.get(owner.get(hit.object)!)!);
				const near = hit.point.distanceTo(target) <= SUBJECT_NEAR * state.radius;
				const name = 'centre' in spec ? spec.centre : spec.point;
				if (!onSubject && !near) hidden.push(`${where(h)}: ${owner.get(hit.object)!.name} stands in front of ${name}`);
			});
			expect(hidden).toEqual([]);
		}, 120_000);

		it('shows a part in the picture before it is kept alone', () => {
			const unseen: string[] = [];
			states.forEach((state, h) => {
				const previous = states[h - 1];
				const newly = state.isolated.filter((part) => !previous?.isolated.includes(part));
				if (!previous || !newly.length) return;
				const share = count(picture(previous, sceneOf(previous)), bodiesOf(newly)) / (SIDE * SIDE);
				if (share < SUBJECT_SHARE) unseen.push(`${where(h)}: the part kept alone covered ${(share * 100).toFixed(2)}% before`);
			});
			expect(unseen).toEqual([]);
		}, 120_000);
	});
}
