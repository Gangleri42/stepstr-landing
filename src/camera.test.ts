import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { UP_AXES, type Camera, type UpAxis } from '$lib/state/hash';
import { cameraUp, upVector, viewDirection } from '$lib/viewer/orientation';
import {
	DESKTOP,
	ISO_EL,
	PHONE,
	direction,
	fitDistance,
	frameRect,
	lerp,
	lerpVec,
	logLerp,
	pose,
	smootherstep,
	type Rect,
	type Vec3,
	type Viewport
} from './camera.ts';

const VIEWPORTS = [DESKTOP, PHONE];
const SHOTS = [
	{ az: 0, el: ISO_EL },
	{ az: 75, el: -35 },
	{ az: 200, el: 60 },
	{ az: -130, el: 10 }
];
const TARGET: Vec3 = [12, -40, 85];
const v3 = (v: Vec3) => new THREE.Vector3(...v);

/** A perspective camera set up the way Viewer.setCamera sets up its own: aspect, fov, position, up, lookAt. */
function viewerCamera(camera: Camera, viewport: Viewport, up: UpAxis) {
	const position = v3(camera.position), target = v3(camera.target);
	const drawn = new THREE.PerspectiveCamera(viewport.fov, viewport.width / viewport.height, 0.1, 1e6);
	drawn.position.copy(position);
	drawn.up.copy(cameraUp(position.clone().sub(target).normalize(), up));
	drawn.lookAt(target);
	drawn.updateMatrixWorld();
	return drawn;
}

/** Where a world point shows on the canvas, in CSS pixels. */
function onCanvas(point: THREE.Vector3, camera: THREE.PerspectiveCamera, viewport: Viewport) {
	const p = point.clone().project(camera);
	return { x: ((p.x + 1) / 2) * viewport.width, y: ((1 - p.y) / 2) * viewport.height };
}

/** A sphere's outline as a camera at `eye` sees it: the circle where its lines of sight graze the sphere. */
function rim(centre: THREE.Vector3, radius: number, eye: THREE.Vector3, count = 1440) {
	const toEye = eye.clone().sub(centre);
	const share = (radius * radius) / toEye.lengthSq();
	const middle = centre.clone().addScaledVector(toEye, share);
	const ring = radius * Math.sqrt(1 - share);
	const a = new THREE.Vector3().crossVectors(toEye, new THREE.Vector3(0.31, 0.53, 0.79)).normalize();
	const b = new THREE.Vector3().crossVectors(toEye, a).normalize();
	return Array.from({ length: count }, (_, i) => {
		const turn = (i / count) * 2 * Math.PI;
		return middle.clone().addScaledVector(a, ring * Math.cos(turn)).addScaledVector(b, ring * Math.sin(turn));
	});
}

/** How far a sphere's outline stays inside each side of a rect, in pixels; negative where it crosses the side. */
function gaps(centre: Vec3, radius: number, camera: Camera, viewport: Viewport, up: UpAxis, rect: Rect) {
	const drawn = viewerCamera(camera, viewport, up);
	const points = rim(v3(centre), radius, v3(camera.position)).map((p) => onCanvas(p, drawn, viewport));
	const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
	return {
		left: Math.min(...xs) - rect.x0,
		right: rect.x1 - Math.max(...xs),
		top: Math.min(...ys) - rect.y0,
		bottom: rect.y1 - Math.max(...ys)
	};
}

describe('direction', () => {
	it('is the Iso view at azimuth 0 and the Iso elevation, for every up axis', () => {
		expect(ISO_EL).toBeCloseTo(27.94, 2);
		for (const axis of UP_AXES) {
			expect(v3(direction(0, ISO_EL, axis)).distanceTo(viewDirection('iso', axis))).toBeLessThan(1e-12);
		}
	});

	it('turns counter-clockwise seen from above as the azimuth grows', () => {
		for (const axis of UP_AXES) {
			const ahead = v3(direction(0, 0, axis));
			const quarter = new THREE.Vector3().crossVectors(upVector(axis), ahead);
			expect(v3(direction(90, 0, axis)).distanceTo(quarter)).toBeLessThan(1e-12);
			expect(v3(direction(450, 0, axis)).distanceTo(quarter)).toBeLessThan(1e-12);
		}
	});

	it('is a unit vector at the elevation asked for, held within ±80°', () => {
		for (const el of [-95, -80, -20, 0, 45, 80, 89]) {
			const d = v3(direction(33, el, 'y'));
			expect(d.length()).toBeCloseTo(1, 12);
			const expected = Math.max(-80, Math.min(80, el));
			expect(THREE.MathUtils.radToDeg(Math.asin(d.dot(upVector('y'))))).toBeCloseTo(expected, 9);
		}
	});
});

describe('framing', () => {
	it('stands the camera at target + direction · dist', () => {
		for (const axis of UP_AXES) {
			for (const { az, el } of SHOTS) {
				const camera = pose({ target: TARGET, az, el, dist: 600 }, DESKTOP, 0, axis);
				const expected = v3(TARGET).addScaledVector(v3(direction(az, el, axis)), 600);
				expect(v3(camera.position).distanceTo(expected)).toBeLessThan(1e-9);
			}
		}
	});

	it('shows the target at the centre of the frame rect, within a pixel', () => {
		let worst = 0;
		for (const viewport of VIEWPORTS) {
			for (const full of [0, 0.35, 1]) {
				const { x0, y0, x1, y1 } = frameRect(viewport, full);
				for (const axis of UP_AXES) {
					for (const { az, el } of SHOTS) {
						const camera = pose({ target: TARGET, az, el, dist: 600 }, viewport, full, axis);
						const shown = onCanvas(v3(TARGET), viewerCamera(camera, viewport, axis), viewport);
						worst = Math.max(worst, Math.hypot(shown.x - (x0 + x1) / 2, shown.y - (y0 + y1) / 2));
					}
				}
			}
		}
		expect(worst).toBeLessThan(1);
	});

	it('looks straight at the target when the frame is the whole canvas', () => {
		const camera = pose({ target: TARGET, az: 40, el: 20, dist: 300 }, PHONE, 1, 'z');
		expect(v3(camera.target).distanceTo(v3(TARGET))).toBeLessThan(1e-9);
	});

	it('fits a sphere at fitDistance to the frame rect: inside it, touching the limiting side', () => {
		const radius = 50;
		for (const viewport of VIEWPORTS) {
			for (const full of [0, 0.5, 1]) {
				const rect = frameRect(viewport, full);
				for (const axis of ['z', '-y'] as const) {
					for (const { az, el } of SHOTS) {
						const dist = fitDistance(radius, viewport, full);
						const camera = pose({ target: TARGET, az, el, dist }, viewport, full, axis);
						const g = gaps(TARGET, radius, camera, viewport, axis, rect);
						const sides = [g.left, g.right, g.top, g.bottom];
						expect(Math.min(...sides)).toBeGreaterThan(-0.5);
						expect(Math.min(...sides)).toBeLessThan(0.5);
					}
				}
			}
		}
	});

	it('is Viewer.fit for the whole canvas: the sphere touches both limiting sides', () => {
		for (const viewport of VIEWPORTS) {
			const halfV = THREE.MathUtils.degToRad(viewport.fov / 2);
			const halfH = Math.atan(Math.tan(halfV) * (viewport.width / viewport.height));
			expect(fitDistance(80, viewport, 1)).toBeCloseTo(80 / Math.sin(Math.min(halfV, halfH)), 9);
			const dist = fitDistance(80, viewport, 1);
			const camera = pose({ target: TARGET, az: 120, el: 30, dist }, viewport, 1, 'z');
			const g = gaps(TARGET, 80, camera, viewport, 'z', frameRect(viewport, 1));
			// Landscape is limited by its height, portrait by its width.
			const [a, b] = viewport.width > viewport.height ? [g.top, g.bottom] : [g.left, g.right];
			expect(Math.abs(a)).toBeLessThan(0.5);
			expect(Math.abs(b)).toBeLessThan(0.5);
		}
	});

	it('gives the camera Viewer.fit gives for Iso', () => {
		for (const axis of UP_AXES) {
			const distance = fitDistance(80, DESKTOP, 1) * 1.02;
			const camera = pose({ target: TARGET, az: 0, el: ISO_EL, dist: distance }, DESKTOP, 1, axis);
			const fitted = v3(TARGET).addScaledVector(viewDirection('iso', axis), distance);
			expect(v3(camera.position).distanceTo(fitted)).toBeLessThan(1e-9);
			expect(v3(camera.target).distanceTo(v3(TARGET))).toBeLessThan(1e-9);
		}
	});

	it('blends from the free rect to the whole canvas as full goes from 0 to 1', () => {
		const half = frameRect(PHONE, 0.5);
		expect(half).toEqual({ x0: 0, y0: 28, x1: 390, y1: (464 + 844) / 2 });
		expect(frameRect(PHONE, 0)).toEqual(PHONE.free);
		expect(frameRect(PHONE, 2)).toEqual({ x0: 0, y0: 0, x1: 390, y1: 844 });
		for (const viewport of VIEWPORTS) {
			const [free, between, whole] = [0, 0.5, 1].map((full) => fitDistance(50, viewport, full));
			expect(free).toBeGreaterThan(between);
			expect(between).toBeGreaterThan(whole);
		}
	});

	it('keeps the up axis upright on screen at ±80°, wherever the frame rect sits', () => {
		for (const viewport of VIEWPORTS) {
			for (const axis of UP_AXES) {
				for (const el of [80, -80]) {
					const camera = pose({ target: TARGET, az: 25, el, dist: 400 }, viewport, 0, axis);
					const sight = v3(camera.position).sub(v3(camera.target)).normalize();
					expect(cameraUp(sight, axis).distanceTo(upVector(axis))).toBeLessThan(1e-12);
				}
			}
		}
	});
});

describe('interpolation helpers', () => {
	it('smootherstep eases in and out and clamps', () => {
		expect(smootherstep(0)).toBe(0);
		expect(smootherstep(0.5)).toBe(0.5);
		expect(smootherstep(1)).toBe(1);
		expect(smootherstep(-1)).toBe(0);
		expect(smootherstep(2)).toBe(1);
		expect(smootherstep(1e-4) / 1e-4).toBeLessThan(1e-6);
		expect((1 - smootherstep(1 - 1e-4)) / 1e-4).toBeLessThan(1e-6);
	});

	it('lerps numbers and vectors, and distances by ratio', () => {
		expect(lerp(2, 6, 0.25)).toBe(3);
		expect(lerpVec([0, 10, -4], [4, 20, 4], 0.5)).toEqual([2, 15, 0]);
		expect(logLerp(4, 1, 0.5)).toBeCloseTo(2, 12);
		expect(logLerp(10, 1000, 0.5)).toBeCloseTo(100, 9);
		expect(logLerp(7, 70, 0)).toBe(7);
	});
});
