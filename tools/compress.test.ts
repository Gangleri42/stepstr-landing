// The landing page's compression on a small model built by the app's own pipeline: a box with a face in a colour of
// its own and a pin placed twice, each under a turned occurrence. What the viewer and Measure read must come through
// unchanged, and the positions within the quantization step.
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import type { MeasureData } from '../stepstr/src/lib/measure/format.ts';
import { buildModel, type Manifest, type RawMesh } from '../stepstr/src/lib/pipeline/build-model.ts';
import { MemoryIO } from '../stepstr/src/lib/pipeline/memory-io.ts';
import { sha256Hex } from '../stepstr/src/lib/source/sha256.ts';
import { compressGlb, glbJson, solidsOf, trimMeasure } from './compress.ts';

type Vec = [number, number, number];

/** Separate nodes per face, as the converter writes them: four corners each, counterclockwise from outside. */
function box(half: Vec, coloured: number): RawMesh {
	const faces: [Vec, Vec, Vec][] = [
		[[1, 0, 0], [0, 1, 0], [0, 0, 1]],
		[[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
		[[0, 1, 0], [0, 0, 1], [1, 0, 0]],
		[[0, -1, 0], [1, 0, 0], [0, 0, 1]],
		[[0, 0, 1], [1, 0, 0], [0, 1, 0]],
		[[0, 0, -1], [0, 1, 0], [1, 0, 0]]
	];
	// The coloured face goes last: the converter writes a body's own colour first.
	const order = [...faces.keys()].filter((f) => f !== coloured).concat(coloured);
	const positions: number[] = [], normals: number[] = [], indices: number[] = [], faceIds: number[] = [];
	const extent = (v: Vec) => v.reduce((sum, c, k) => sum + Math.abs(c) * half[k], 0);
	for (const f of order) {
		const [n, u, v] = faces[f];
		const base = positions.length / 3;
		for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
			for (let k = 0; k < 3; k++) positions.push(n[k] * extent(n) + a * u[k] * extent(u) + b * v[k] * extent(v));
			normals.push(...n);
		}
		indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
		faceIds.push(f, f);
	}
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
		faceIds: new Uint32Array(faceIds),
		groups: [{ appearance: null, triangles: 10 }, { appearance: 'red', triangles: 2 }],
		deflection: 0.01
	};
}

/** A pin along z: its side (face 0) and two caps (faces 1 and 2). */
function pin(radius: number, length: number, segments: number): RawMesh {
	const positions: number[] = [], normals: number[] = [], indices: number[] = [], faceIds: number[] = [];
	const at = (j: number) => (2 * Math.PI * (j % segments)) / segments;
	const node = (x: number, y: number, z: number, n: Vec) => {
		positions.push(x, y, z);
		normals.push(...n);
		return positions.length / 3 - 1;
	};
	const side = Array.from({ length: segments }, (_, j) => {
		const [c, s] = [Math.cos(at(j)), Math.sin(at(j))];
		return [node(radius * c, radius * s, 0, [c, s, 0]), node(radius * c, radius * s, length, [c, s, 0])];
	});
	for (let j = 0; j < segments; j++) {
		const [b0, t0] = side[j], [b1, t1] = side[(j + 1) % segments];
		indices.push(b0, b1, t1, b0, t1, t0);
		faceIds.push(0, 0);
	}
	for (const [face, z, up] of [[1, length, 1], [2, 0, -1]] as const) {
		const centre = node(0, 0, z, [0, 0, up]);
		const ring = Array.from({ length: segments }, (_, j) =>
			node(radius * Math.cos(at(j)), radius * Math.sin(at(j)), z, [0, 0, up])
		);
		for (let j = 0; j < segments; j++) {
			const [a, b] = [ring[j], ring[(j + 1) % segments]];
			indices.push(...(up > 0 ? [centre, a, b] : [centre, b, a]));
			faceIds.push(face);
		}
	}
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
		faceIds: new Uint32Array(faceIds),
		groups: [{ appearance: null, triangles: indices.length / 3 }],
		deflection: 0.01
	};
}

/** A row-major placement: turned by `angle` about one axis, then moved. */
function placement(axis: 'x' | 'z', angle: number, move: Vec): number[] {
	const [c, s] = [Math.cos(angle), Math.sin(angle)];
	const r = axis === 'z' ? [c, -s, 0, s, c, 0, 0, 0, 1] : [1, 0, 0, 0, c, -s, 0, s, c];
	return [r[0], r[1], r[2], move[0], r[3], r[4], r[5], move[1], r[6], r[7], r[8], move[2], 0, 0, 0, 1];
}

const red: [string, string, unknown][] = [
	['interior_model', 'integer', 0],
	['opaque_albedo', 'color', [200, 30, 20, 255]],
	['surface_roughness', 'float', 0.45]
];
const manifest: Manifest = {
	doc: 'two bodies',
	occurrences: [
		{ path: 'box:1', parent: null, name: 'box:1', component: 'box', matrix: placement('z', Math.PI / 6, [100, 50, 0]) },
		{ path: 'pin:1', parent: null, name: 'pin:1', component: 'pin', matrix: placement('x', Math.PI / 2, [-30, 0, 20]) },
		{ path: 'pin:2', parent: null, name: 'pin:2', component: 'pin', matrix: placement('z', -Math.PI / 3, [-60, 10, 5]) }
	],
	bodies: [
		{ occ: 'box:1', body: 'box', mesh: 0, appearance: null },
		{ occ: 'pin:1', body: 'pin', mesh: 1, appearance: null },
		{ occ: 'pin:2', body: 'pin', mesh: 1, appearance: null }
	],
	meshes: [{ component: 'box', body: 'box' }, { component: 'pin', body: 'pin' }],
	appearances: { red }
};
const meshes = [box([20, 10, 5], 4), pin(3, 15, 24)];

const built = await buildModel(
	{ manifest, mesh: (i) => meshes[i], geometry: () => null },
	{
		title: 'two bodies',
		simplifyError: () => 0.001,
		writeGlb: (doc) => new MemoryIO().writeBinary(doc),
		sha256: sha256Hex,
		strict: true
	}
);
const notice = { copyright: 'a model, changed', extras: { source: 'somewhere' } };
const compressed = await compressGlb(built.glb, notice);

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
/** The scene as the viewer has it: the root's glTF scale and turn dropped, so world coordinates are in mm. */
async function scene(glb: Uint8Array) {
	const loaded = await loader.parseAsync(glb.slice().buffer, '');
	const root = loaded.scene.children[0];
	root.position.set(0, 0, 0);
	root.quaternion.identity();
	root.scale.set(1, 1, 1);
	loaded.scene.updateMatrixWorld(true);
	const objects: THREE.Object3D[] = [];
	loaded.scene.traverse((o) => objects.push(o));
	return objects;
}
const [before, after] = [await scene(built.glb), await scene(compressed)];
const surfaces = (objects: THREE.Object3D[]) => objects.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh);
const lines = (objects: THREE.Object3D[]) => objects.filter((o): o is THREE.LineSegments => (o as THREE.LineSegments).isLineSegments);

/** Triangles per B-rep face. */
function trianglesPerFace(mesh: THREE.Mesh) {
	const ids = mesh.geometry.getAttribute('_faceid'), index = mesh.geometry.getIndex()!;
	const count: Record<number, number> = {};
	for (let t = 0; t < index.count / 3; t++) count[ids.getX(index.getX(t * 3))] = (count[ids.getX(index.getX(t * 3))] ?? 0) + 1;
	return count;
}

/** World-space segments of an edge-line object. */
function segments(line: THREE.LineSegments) {
	const position = line.geometry.getAttribute('position'), index = line.geometry.getIndex()!;
	const point = (i: number) => new THREE.Vector3().fromBufferAttribute(position, index.getX(i)).applyMatrix4(line.matrixWorld);
	return Array.from({ length: index.count / 2 }, (_, s) => [point(2 * s), point(2 * s + 1)]);
}

describe('landing model compression', () => {
	it('declares the extensions it needs and makes the file smaller', () => {
		const json = glbJson(compressed);
		const both = ['EXT_meshopt_compression', 'KHR_mesh_quantization'];
		expect(json.extensionsUsed).toEqual(both);
		expect(json.extensionsRequired).toEqual(both);
		expect(compressed.length).toBeLessThan(built.glb.length);
		expect(json.asset).toMatchObject(notice);
	});

	it('keeps every extra as it was', () => {
		expect(after.map((o) => o.userData)).toEqual(before.map((o) => o.userData));
		const materials = (objects: THREE.Object3D[]) => surfaces(objects).map((m) => (m.material as THREE.Material).userData);
		expect(materials(after)).toEqual(materials(before));
		// The bodies took the dequantization; the occurrences above them, which Measure places its geometry with, did not.
		const bodies = after.filter((o) => o.userData.body);
		expect(bodies.every(({ scale }) => scale.x === scale.y && scale.y === scale.z && scale.x < 1)).toBe(true);
		const occurrences = (objects: THREE.Object3D[]) =>
			objects.filter((o) => o.userData.id && !o.userData.body).map((o) => o.matrixWorld.toArray());
		expect(occurrences(after)).toEqual(occurrences(before));
	});

	it('keeps the triangles of every face', () => {
		expect(surfaces(after)).toHaveLength(4);
		expect(surfaces(after).map(trianglesPerFace)).toEqual(surfaces(before).map(trianglesPerFace));
	});

	it('keeps each mesh within a quantization step of where it was', () => {
		surfaces(before).forEach((mesh, i) => {
			const [a, b] = [new THREE.Box3().setFromObject(mesh, true), new THREE.Box3().setFromObject(surfaces(after)[i], true)];
			const size = a.getSize(new THREE.Vector3());
			const step = Math.max(size.x, size.y, size.z) / 32767;
			for (const k of ['x', 'y', 'z'] as const) {
				expect(Math.abs(b.min[k] - a.min[k])).toBeLessThanOrEqual(step);
				expect(Math.abs(b.max[k] - a.max[k])).toBeLessThanOrEqual(step);
			}
		});
	});

	it('keeps the direction of every normal, whatever its length', () => {
		/** Each vertex in world space: its face, where it is and which way its normal points. */
		const vertices = (mesh: THREE.Mesh) => {
			const { attributes } = mesh.geometry;
			const turn = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
			return Array.from({ length: attributes.position.count }, (_, v) => ({
				face: attributes._faceid.getX(v),
				at: new THREE.Vector3().fromBufferAttribute(attributes.position, v).applyMatrix4(mesh.matrixWorld),
				normal: new THREE.Vector3().fromBufferAttribute(attributes.normal, v).applyMatrix3(turn).normalize()
			}));
		};
		surfaces(before).forEach((mesh, i) => {
			const was = vertices(mesh);
			for (const now of vertices(surfaces(after)[i])) {
				const same = was.find((v) => v.face === now.face && v.at.distanceTo(now.at) < 1e-3);
				expect(same, `face ${now.face} at ${now.at.toArray()}`).toBeDefined();
				// Ten bits a component turn a normal by a tenth of a degree at most.
				expect(now.normal.angleTo(same!.normal)).toBeLessThan(0.005);
			}
		});
	});

	it('keeps the edge lines', () => {
		expect(lines(before)).toHaveLength(4);
		expect(lines(after)).toHaveLength(4);
		lines(before).forEach((line, i) => {
			const [was, now] = [segments(line), segments(lines(after)[i])];
			expect(now).toHaveLength(was.length);
			const close = (p: THREE.Vector3, q: THREE.Vector3) => p.distanceTo(q) < 1e-3;
			const same = ([p, q]: THREE.Vector3[], [r, s]: THREE.Vector3[]) => (close(p, r) && close(q, s)) || (close(p, s) && close(q, r));
			for (const segment of was) expect(now.some((other) => same(segment, other))).toBe(true);
		});
	});
});

describe('landing measurement data', () => {
	const data: MeasureData = {
		v: 1,
		units: 'mm',
		glb: 'a'.repeat(64),
		solids: [{ tol: 1, p: [], e: [], f: [] }, { tol: 2, p: [], e: [], f: [] }, null]
	};

	it('keeps the solids asked for, in their places, and names the new GLB', () => {
		expect(trimMeasure(data, [1], 'b'.repeat(64))).toEqual({ ...data, glb: 'b'.repeat(64), solids: [null, data.solids[1], null] });
		expect(() => trimMeasure(data, [2], '')).toThrow(/no measurement data/);
	});

	it('finds the solid of a body by its id', () => {
		const json = glbJson(built.glb);
		const id = json.nodes!.find((n) => n.extras?.body && n.extras.solid === 1)!.extras!.id!;
		expect(solidsOf(json, [id])).toEqual([1]);
		expect(() => solidsOf(json, ['nothing'])).toThrow(/no body/);
	});
});
