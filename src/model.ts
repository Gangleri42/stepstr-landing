// What the timeline needs to know of the loaded model, read from the scene: each display name's parts and bounding
// spheres, assembled and exploded, every body's box, and the bounds the parked cuts wait beyond. The stage and the
// storyboard's test both read the model this way.
import * as THREE from 'three';
import type { UpAxis } from '$lib/state/hash';
import type { Part, PartIndex } from '$lib/viewer/parts';
import type { Vec3 } from './camera';
import type { Model } from './timeline';

/**
 * `root` is the model's top node, already placed in the scene's frame; `explode` sets the explode factor on it, as
 * Viewer.setExplode does. It is left at 0.
 */
export function describeModel(
	root: THREE.Object3D,
	parts: PartIndex,
	explode: (factor: number) => void,
	up: UpAxis,
	points: Record<string, Vec3>
): Model {
	const byName = new Map<string, Part[]>();
	for (const part of parts.byId.values()) {
		// A body folded into its occurrence's row carries the occurrence's name; the occurrence stands for both.
		if (part.body && part.parent && !part.parent.children.includes(part)) continue;
		const list = byName.get(part.name) ?? [];
		list.push(part);
		byName.set(part.name, list);
	}
	const sphereOf = (list: Part[]) => {
		const box = new THREE.Box3();
		for (const part of list) for (const mesh of part.meshes) box.expandByObject(mesh);
		return box.getBoundingSphere(new THREE.Sphere());
	};
	const vec = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
	const sphere = (s: THREE.Sphere) => ({ centre: vec(s.center), radius: s.radius });
	const boxOf = (b: THREE.Box3) => ({ min: vec(b.min), max: vec(b.max) });

	root.updateMatrixWorld(true);
	const bounds = new THREE.Box3().setFromObject(root);
	const assembled = new Map([...byName].map(([name, list]) => [name, sphereOf(list)]));
	// Every body's box, assembled, with the parts that hold it: what the rules weigh a cut or a hidden part by.
	const bodies = [...parts.byId.values()].flatMap((part) => {
		const box = new THREE.Box3();
		for (const mesh of part.body ? part.meshes : []) box.expandByObject(mesh);
		if (box.isEmpty()) return [];
		const ids: string[] = [];
		for (let p: Part | null = part; p; p = p.parent) ids.push(p.id);
		return [{ ids, box: boxOf(box) }];
	});
	explode(1);
	root.updateMatrixWorld(true);
	const explodedBounds = new THREE.Box3().setFromObject(root);
	const exploded = new Map([...byName].map(([name, list]) => [name, sphereOf(list)]));
	explode(0);
	root.updateMatrixWorld(true);

	return {
		up,
		bounds: boxOf(bounds),
		explodedBounds: boxOf(explodedBounds),
		bodies,
		parts: new Map(
			[...byName].map(([name, list]) => [
				name,
				{ ids: list.map((p) => p.id), sphere: sphere(assembled.get(name)!), explodedSphere: sphere(exploded.get(name)!) }
			])
		),
		points
	};
}
