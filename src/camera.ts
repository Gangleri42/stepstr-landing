// Where the director's camera stands. A shot names a target, an azimuth and an elevation around it, and a distance;
// pose() turns it into the position and look-at point that Viewer.setCamera takes, with the target placed in the
// part of the page the text leaves free. It follows the viewer throughout: the up axis and Iso view of
// orientation.ts, the perspective camera's field of view and Viewer.fit's framing rule.
import * as THREE from 'three';
import type { Camera, UpAxis } from '$lib/state/hash';
import { cameraUp, upVector, viewDirection } from '$lib/viewer/orientation';

export type Vec3 = [number, number, number];
/** A rectangle in CSS pixels, from the canvas's top left corner. */
export type Rect = { x0: number; y0: number; x1: number; y1: number };
/**
 * The canvas in CSS pixels, its camera's vertical field of view in degrees, and the free rect: the stage less the top
 * bar and the copy, which is a left column on a desktop and a bottom card on a phone.
 */
export type Viewport = { width: number; height: number; fov: number; free: Rect };
/** The point the subject centres on, the azimuth and elevation in degrees, and the camera's distance from it in mm. */
export type Shot = { target: Vec3; az: number; el: number; dist: number };

/** Elevations stay within this many degrees of level, short of where setCamera stops keeping the up axis upright. */
export const EL_LIMIT = 80;
/** The Iso view's elevation: at azimuth 0 it gives viewDirection('iso') exactly. */
export const ISO_EL = THREE.MathUtils.radToDeg(Math.atan2(0.75, Math.SQRT2));
/**
 * The steepest the camera's own line of sight may be. setCamera keeps the up axis as the camera's up while the line of
 * sight is within asin(0.99), about 81.9°, of level, and past that turns the picture a quarter turn. A target placed
 * high or low in the frame tilts the line of sight beyond the shot's elevation, so the tilt stops here.
 */
const PITCH_LIMIT = THREE.MathUtils.degToRad(81);

/** The page's layouts as planned, for tests: a desktop with the copy in a left column, a phone with a bottom card. */
export const DESKTOP: Viewport = { width: 1440, height: 900, fov: 30, free: { x0: 560, y0: 64, x1: 1440, y1: 900 } };
export const PHONE: Viewport = { width: 390, height: 844, fov: 30, free: { x0: 0, y0: 56, x1: 390, y1: 464 } };
/** The stills' frame (tools/stills.ts): a square stage with nothing over it. */
export const STILL: Viewport = { width: 1200, height: 1200, fov: 30, free: { x0: 0, y0: 0, x1: 1200, y1: 1200 } };

const { clamp, degToRad } = THREE.MathUtils;
const vec = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => [
	lerp(a[0], b[0], t),
	lerp(a[1], b[1], t),
	lerp(a[2], b[2], t)
];
/** Lerps by ratio, for distances: 4 m to 2 m takes as long as 4 mm to 2 mm. Both ends must be positive. */
export const logLerp = (a: number, b: number, t: number) => a * (b / a) ** t;

/** Speed and acceleration are zero at both ends, so a move starts and stops without a jolt. */
export function smootherstep(t: number) {
	const x = clamp(t, 0, 1);
	return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * The unit vector from the target to the camera. Azimuth 0 is the level part of the Iso view's direction and grows
 * counter-clockwise seen from above, a right-handed turn about the up axis; elevation is the angle above level.
 */
export function direction(az: number, el: number, up: UpAxis): Vec3 {
	const axis = upVector(up);
	const iso = viewDirection('iso', up);
	const ahead = iso.addScaledVector(axis, -iso.dot(axis)).normalize();
	const left = new THREE.Vector3().crossVectors(axis, ahead);
	const a = degToRad(az), e = degToRad(clamp(el, -EL_LIMIT, EL_LIMIT));
	const level = ahead.multiplyScalar(Math.cos(a)).addScaledVector(left, Math.sin(a));
	return vec(level.multiplyScalar(Math.cos(e)).addScaledVector(axis, Math.sin(e)));
}

/** The rect the subject fills: the free rect at full = 0, the whole canvas at full = 1, and the two blended between. */
export function frameRect(viewport: Viewport, full: number): Rect {
	const { width, height, free } = viewport;
	const f = clamp(full, 0, 1);
	return {
		x0: lerp(free.x0, 0, f),
		y0: lerp(free.y0, 0, f),
		x1: lerp(free.x1, width, f),
		y1: lerp(free.y1, height, f)
	};
}

/**
 * The frame rect where its sides cross the plane one unit in front of a camera aimed at the canvas's centre (x right,
 * y up), and its centre there, which is where the target must show.
 */
function tangents(viewport: Viewport, full: number) {
	const { x0, y0, x1, y1 } = frameRect(viewport, full);
	const scale = Math.tan(degToRad(viewport.fov / 2)) / (viewport.height / 2);
	const left = (x0 - viewport.width / 2) * scale, right = (x1 - viewport.width / 2) * scale;
	const top = (viewport.height / 2 - y0) * scale, bottom = (viewport.height / 2 - y1) * scale;
	return { left, right, top, bottom, x: (left + right) / 2, y: (top + bottom) / 2 };
}

/**
 * How far from its centre a sphere of this radius fills the frame rect: Viewer.fit's r / sin(min(halfV, halfH)),
 * with each half-angle taken between the line to the rect's centre and the plane through the camera and one side of
 * the rect. For a rect centred on the canvas that is fit()'s own formula. For one off to a side the sphere shows a
 * little wider than it would centred, so the sides farther from the canvas's centre limit it, and it touches them and
 * stays inside.
 */
export function fitDistance(radius: number, viewport: Viewport, full: number) {
	const { left, right, top, bottom, x, y } = tangents(viewport, full);
	const length = Math.hypot(x, y, 1);
	const sine = (inside: number, side: number) => inside / (length * Math.hypot(1, side));
	const horizontal = Math.min(sine(right - x, right), sine(x - left, left));
	return radius / Math.min(horizontal, sine(top - y, top), sine(y - bottom, bottom));
}

/**
 * The camera for a shot. It stands at target + direction · dist and turns, without rolling (setCamera's lookAt keeps
 * the up axis upright), until the target shows at the centre of the frame rect. It looks at the point of its line of
 * sight that lies as deep as the target: the target shifted along the camera's own right and up vectors.
 */
export function pose(shot: Shot, viewport: Viewport, full: number, up: UpAxis): Camera {
	const axis = upVector(up);
	const target = new THREE.Vector3(...shot.target);
	const sight = new THREE.Vector3(...direction(shot.az, shot.el, up)).negate();
	const position = target.clone().addScaledVector(sight, -shot.dist);
	// The line to the target, split into its rise along the up axis and its level part.
	const rise = sight.dot(axis);
	const level = Math.sqrt(Math.max(0, 1 - rise * rise));
	const ahead = sight.clone().addScaledVector(axis, -rise).normalize();
	const left = new THREE.Vector3().crossVectors(axis, ahead);
	// Turned by yaw about the up axis and tilted by pitch, the camera sees the target at
	// x = s·√(1 + y²) / √(1 − s²), where s = level · sin(yaw) is the target's part along the camera's right, and at
	// y = tan(its angle above the line of sight). Solving for yaw first, then pitch, puts it at the rect's centre.
	const { x, y } = tangents(viewport, full);
	const g = x / Math.hypot(1, y);
	const yaw = Math.asin(clamp(g / Math.hypot(1, g) / level, -1, 1));
	const pitch = clamp(Math.atan2(rise, level * Math.cos(yaw)) - Math.atan(y), -PITCH_LIMIT, PITCH_LIMIT);
	const heading = ahead.multiplyScalar(Math.cos(yaw)).addScaledVector(left, Math.sin(yaw));
	const forward = heading.multiplyScalar(Math.cos(pitch)).addScaledVector(axis, Math.sin(pitch));
	const look = position.clone().addScaledVector(forward, shot.dist * sight.dot(forward));
	return { position: vec(position), target: vec(look) };
}

/**
 * Where a point shows on the canvas, in CSS pixels from its top left corner, for a camera placed as Viewer.setCamera
 * places it; null when the point lies behind the camera.
 */
export function project(point: Vec3, camera: Camera, viewport: Viewport, up: UpAxis): [number, number] | null {
	const eye = new THREE.PerspectiveCamera(viewport.fov, viewport.width / viewport.height, 0.1, 1e9);
	const position = new THREE.Vector3(...camera.position), target = new THREE.Vector3(...camera.target);
	eye.position.copy(position);
	eye.up.copy(cameraUp(position.clone().sub(target).normalize(), up));
	eye.lookAt(target);
	eye.updateMatrixWorld(true);
	const seen = new THREE.Vector3(...point).applyMatrix4(eye.matrixWorldInverse);
	if (seen.z >= 0) return null;
	const ndc = new THREE.Vector3(...point).project(eye);
	return [((ndc.x + 1) / 2) * viewport.width, ((1 - ndc.y) / 2) * viewport.height];
}
