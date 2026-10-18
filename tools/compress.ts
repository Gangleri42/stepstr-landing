// Makes the viewer's GLB small enough to send with a web page, keeping what the viewer and Measure read from it: the
// node extras, the B-rep face of every vertex and the edge lines. Each mesh's vertices are reordered for the GPU's
// caches, its positions are stored as 16-bit integers inside a box around the mesh and its normals at 10 bits, and the
// buffers are compressed with meshoptimizer (KHR_mesh_quantization, EXT_meshopt_compression).
//
// The integers go back to millimetres through the body node, which the converter leaves without a transform, by one
// uniform scale and a translation. Uniform, so normals, bounding boxes and the quaternions three.js takes apart from a
// world matrix (a fastener's explode axis) come out as before. Measure places the exact geometry with the occurrence
// above the body node (src/lib/viewer/measure/data.ts), so the scale never reaches a measured value; faces.ts,
// highlight.ts, explode.ts, the section caps and the floor all read the mesh's or the body's world matrix, which
// carries the scale.
import { Node, Primitive, type Accessor, type Document, type Mesh, type TypedArray } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import type { MeasureData } from '../stepstr/src/lib/measure/format.ts';
import { MemoryIO } from '../stepstr/src/lib/pipeline/memory-io.ts';

/** Positions are integers from -32767 to 32767 across the largest side of the mesh's box. */
const POSITION_RANGE = 32767;
/**
 * Normals as signed 10-bit integers in normalized 16-bit storage, as gltfpack writes them: short vectors that the
 * shaders normalize. Scaled up to unit length they would compress worse, since every byte would change.
 */
const NORMAL_RANGE = 511;

export type Notice = { copyright: string; extras: Record<string, unknown> };

/** A colour group: its triangles, and the edge lines drawn over the same positions. */
type Group = { triangles: Primitive; lines: Primitive[] };

function groupsOf(mesh: Mesh): Group[] {
	const name = mesh.getName();
	const primitives = mesh.listPrimitives();
	const { TRIANGLES, LINES } = Primitive.Mode;
	const odd = primitives.find((p) => p.getMode() !== TRIANGLES && p.getMode() !== LINES);
	if (odd) throw new Error(`${name}: a primitive of mode ${odd.getMode()}, which the converter never writes`);
	const lines = primitives.filter((p) => p.getMode() === LINES);
	const over = (triangles: Primitive) => lines.filter((l) => l.getAttribute('POSITION') === triangles.getAttribute('POSITION'));
	const groups = primitives.filter((p) => p.getMode() === TRIANGLES).map((triangles) => ({ triangles, lines: over(triangles) }));
	if (groups.reduce((n, g) => n + g.lines.length, 0) !== lines.length) {
		throw new Error(`${name}: edge lines over positions no triangles use`);
	}
	// Every accessor is rewritten in place, so each must belong to one group of this mesh alone.
	const accessors = groups.flatMap((group) => [
		...group.triangles.listAttributes(),
		group.triangles.getIndices(),
		...group.lines.map((l) => l.getIndices())
	]);
	if (accessors.some((a) => !a)) throw new Error(`${name}: a primitive without indices`);
	if (new Set(accessors).size !== accessors.length) throw new Error(`${name}: an accessor two groups share`);
	for (const accessor of accessors as Accessor[]) {
		const users = accessor.listParents().filter((p): p is Primitive => p instanceof Primitive);
		if (users.some((p) => !primitives.includes(p))) throw new Error(`${name}: an accessor shared with another mesh`);
	}
	return groups;
}

function remapped(array: TypedArray, size: number, remap: Uint32Array): TypedArray {
	const out = new (array.constructor as new (length: number) => TypedArray)(array.length);
	for (let i = 0; i < remap.length; i++) for (let k = 0; k < size; k++) out[remap[i] * size + k] = array[i * size + k];
	return out;
}

/**
 * Orders the triangles for the vertex cache and the vertices by first use (meshoptimizer), which also makes them
 * compress better. Every vertex of the converter's GLB belongs to a triangle; one that did not would come back unmapped.
 */
function reorder(mesh: Mesh, { triangles, lines }: Group) {
	const count = triangles.getAttribute('POSITION')!.getCount();
	const indices = Uint32Array.from(triangles.getIndices()!.getArray()!);
	const [remap, unique] = MeshoptEncoder.reorderMesh(indices, true, false);
	if (unique !== count || remap.length !== count) throw new Error(`${mesh.getName()}: ${count - unique} vertices no triangle uses`);
	for (const attribute of triangles.listAttributes()) {
		attribute.setArray(remapped(attribute.getArray()!, attribute.getElementSize(), remap));
	}
	triangles.getIndices()!.setArray(indices);
	for (const edges of lines.map((l) => l.getIndices()!)) edges.setArray(Uint32Array.from(edges.getArray()!, (v) => remap[v]));
}

/** Indices in 16 bits where every vertex fits below 65535, which glTF keeps for primitive restart. */
const narrow = (indices: Accessor, vertices: number) => {
	if (vertices <= 0xffff) indices.setArray(Uint16Array.from(indices.getArray()!));
};

const clamp = (v: number, range: number) => Math.max(-range, Math.min(range, Math.round(v)));

/**
 * Stores the mesh's positions as integers about the centre of its box, one step the same length on every axis, and
 * returns the transform that turns them back into millimetres.
 */
function quantize(mesh: Mesh, groups: Group[]) {
	const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	for (const { triangles } of groups) {
		const p = triangles.getAttribute('POSITION')!.getArray()!;
		for (let i = 0; i < p.length; i++) {
			min[i % 3] = Math.min(min[i % 3], p[i]);
			max[i % 3] = Math.max(max[i % 3], p[i]);
		}
	}
	const centre = [0, 1, 2].map((k) => (min[k] + max[k]) / 2) as [number, number, number];
	const half = Math.max(...[0, 1, 2].map((k) => (max[k] - min[k]) / 2));
	const step = half > 0 ? half / POSITION_RANGE : 1;
	for (const { triangles, lines } of groups) {
		const position = triangles.getAttribute('POSITION')!;
		const count = position.getCount();
		position.setArray(Int16Array.from(position.getArray()!, (v, i) => clamp((v - centre[i % 3]) / step, POSITION_RANGE)));
		const normal = triangles.getAttribute('NORMAL');
		normal?.setArray(Int16Array.from(normal.getArray()!, (v) => clamp(v * NORMAL_RANGE, NORMAL_RANGE))).setNormalized(true);
		const faces = triangles.getAttribute('_FACEID');
		if (faces) {
			const ids = faces.getArray()!;
			if (ids.some((f) => !Number.isInteger(f) || f < 0 || f > 0xffff)) throw new Error(`${mesh.getName()}: a face id past 16 bits`);
			faces.setArray(Uint16Array.from(ids));
		}
		narrow(triangles.getIndices()!, count);
		for (const line of lines) narrow(line.getIndices()!, count);
	}
	return { translation: centre, scale: [step, step, step] as [number, number, number] };
}

/** Translation, rotation and scale of a node without a transform. */
const IDENTITY = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1];

/** The meshes reordered and quantized, the dequantization on every node that shows them. */
function prepare(doc: Document) {
	for (const mesh of doc.getRoot().listMeshes()) {
		const groups = groupsOf(mesh);
		for (const group of groups) reorder(mesh, group);
		const placement = quantize(mesh, groups);
		for (const node of mesh.listParents().filter((p): p is Node => p instanceof Node)) {
			if ([...node.getTranslation(), ...node.getRotation(), ...node.getScale()].some((v, i) => v !== IDENTITY[i])) {
				throw new Error(`${mesh.getName()}: its node has a transform of its own, which the dequantization would replace`);
			}
			node.setTranslation(placement.translation).setScale(placement.scale);
		}
	}
}

/** The compressed GLB, with the notice in its asset. Reads the converter's GLB; changes nothing it is given. */
export async function compressGlb(glb: Uint8Array, notice: Notice): Promise<Uint8Array> {
	await MeshoptEncoder.ready;
	const io = new MemoryIO()
		.registerExtensions([KHRMeshQuantization, EXTMeshoptCompression])
		.registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
	const doc = await io.readBinary(glb);
	prepare(doc);
	doc.createExtension(KHRMeshQuantization).setRequired(true);
	doc.createExtension(EXTMeshoptCompression)
		.setRequired(true)
		.setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
	const asset = doc.getRoot().getAsset();
	asset.copyright = notice.copyright;
	asset.extras = notice.extras;
	return io.writeBinary(doc);
}

/** A GLB's JSON chunk, parsed. */
export function glbJson(glb: Uint8Array): GltfJson {
	const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
	// 'glTF', version 2, then the first chunk, which the format requires to be the JSON.
	if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== 0x4e4f534a) {
		throw new Error('not a glTF 2.0 binary');
	}
	return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true))));
}

export type GltfJson = {
	asset: { copyright?: string; extras?: Record<string, unknown>; generator?: string; version: string };
	extensionsUsed?: string[];
	extensionsRequired?: string[];
	nodes?: { name?: string; mesh?: number; extras?: { id?: string; body?: boolean; solid?: number } }[];
};

/** The solid of each body the ids name, by its node's extras; an id that names no body with a solid throws. */
export function solidsOf(json: GltfJson, ids: string[]): number[] {
	return ids.map((id) => {
		const solid = json.nodes?.find((n) => n.extras?.id === id && n.extras.body)?.extras?.solid;
		if (solid === undefined) throw new Error(`${id} is no body with exact geometry in this GLB`);
		return solid;
	});
}

/**
 * The measurement data for these solids alone, everything else null with the list as long as before: a body keeps
 * finding its record by its index, and Measure treats the others as bodies without exact geometry. `glb` names the
 * file the data now belongs to.
 */
export function trimMeasure(data: MeasureData, solids: number[], glb: string): MeasureData {
	const keep = new Set(solids);
	for (const s of keep) if (!data.solids[s]) throw new Error(`solid ${s} has no measurement data to keep`);
	return { ...data, glb, solids: data.solids.map((record, i) => (keep.has(i) ? record : null)) };
}
