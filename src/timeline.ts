// The storyboard as a function of the scroll position. Beats hold keys; resolve() ties their part names to the loaded
// model once, and evaluate() gives the whole view at any position. Nothing is kept between calls, so scrolling back
// replays exactly what scrolling forward showed.
import type { Axis, Camera, Cut, UpAxis } from '$lib/state/hash';
import {
	EL_LIMIT,
	ISO_EL,
	fitDistance,
	frameRect,
	lerp,
	lerpVec,
	logLerp,
	pose,
	project,
	smootherstep,
	type Shot,
	type Vec3,
	type Viewport
} from './camera.ts';

/** A part by its display name in the part tree. A name several occurrences share stands for all of them. */
export type PartRef = string;
/** A point in mm, the centre of a part, a named point of the model's settled data, or '*', the whole model's centre. */
export type PointSpec = Vec3 | { centre: PartRef } | { point: string } | '*';
/** Far enough for the bounding sphere of that part, or of the whole model, to fill the frame, times k (default 1). */
export type SizeSpec = { fit: PartRef | '*'; k?: number };
/** A section cut, its offset in mm. `in` slides it from parked (0), just outside the model, to its offset (1). */
export type CutSpec = { axis: Axis; offset: number; flip: boolean; in: number };

/**
 * One moment of a beat, at `t` from 0 to 1 through it. A field left out keeps the previous key's value, and a beat's
 * first key starts from where the previous beat ended. Lists (cuts, hidden, isolated) and ui replace the previous ones
 * whole.
 */
export type Key = {
	t: number;
	target?: PointSpec;
	/** Degrees, unwrapped: from 10 to 210 the camera goes the long way round. */
	az?: number;
	/** Degrees above level, held within ±80. */
	el?: number;
	size?: SizeSpec;
	/** 0 frames the subject in the free rect, 1 in the whole canvas. */
	full?: number;
	explode?: number;
	cuts?: CutSpec[];
	hidden?: PartRef[];
	isolated?: PartRef[];
	highlight?: PartRef | null;
	measure?: boolean;
	/** Whatever the page shows beside the model at this point; the timeline only carries it. */
	ui?: Record<string, unknown>;
};
/** A stretch of the page `len` viewport heights tall. `holds` are the moments its text describes, as t values. */
export type Beat = { id: string; len: number; keys: Key[]; holds: number[] };

export type Box = { min: Vec3; max: Vec3 };
export type Sphere = { centre: Vec3; radius: number };
/** A body's box, assembled, and the ids of the parts that hold it: its own first, then each one above it. */
export type Body = { ids: string[]; box: Box };
/** What the timeline needs to know of the loaded model. The exploded bounds and spheres are taken at setExplode(1). */
export type Model = {
	up: UpAxis;
	bounds: Box;
	explodedBounds: Box;
	bodies: Body[];
	parts: Map<PartRef, { ids: string[]; sphere: Sphere; explodedSphere: Sphere }>;
	points: Record<string, Vec3>;
};

/** A point assembled and exploded: explode moves it from one to the other. */
type Place = { assembled: Vec3; exploded: Vec3 };
/** A cut with the offset it parks at. */
type Slot = { axis: Axis; flip: boolean; offset: number; in: number; parked: number };
/** A key with every field filled in and every part name turned into ids. */
export type Pose = {
	t: number;
	target: Place;
	az: number;
	el: number;
	/** The radius the camera frames, k included, assembled and exploded. */
	size: { assembled: number; exploded: number };
	full: number;
	explode: number;
	cuts: Slot[];
	hidden: string[];
	isolated: string[];
	highlight: string | null;
	measure: boolean;
	ui: Record<string, unknown>;
};
/** A name a key gives that the model lacks. The key's field is dropped, so the value before it carries on. */
export type Missing = {
	beat: string;
	key: number;
	field: 'target' | 'size' | 'hidden' | 'isolated' | 'highlight';
	name: string;
};
/**
 * A beat with its keys resolved. The first key, at t = 0, is where the previous beat ended (for the first beat, the
 * whole model from Iso); the storyboard's keys follow. `start` is where it begins, in viewport heights.
 */
export type ResolvedBeat = { id: string; len: number; start: number; keys: Pose[]; holds: number[] };
export type Resolved = { up: UpAxis; beats: ResolvedBeat[]; missing: Missing[] };

/** The whole view at one point of the timeline. Part ids, as Viewer and hash.ts use them. */
export type State = {
	beat: number;
	local: number;
	camera: Camera;
	shot: Shot;
	/** The radius the shot frames, mm. */
	radius: number;
	full: number;
	explode: number;
	cuts: Cut[];
	hidden: string[];
	isolated: string[];
	highlight: string | null;
	measure: boolean;
	ui: Record<string, unknown>;
};

/** How far past a key, in viewport heights, the playhead must go before hidden, isolated or measure switch. */
export const HYSTERESIS = 0.02;
/** How far beyond the model parked cuts wait, as a share of its diagonal, assembled and exploded together. */
const PARK_MARGIN = 0.02;
/** Samples per beat when check() walks the timeline. */
const CHECK_STEPS = 400;
const AXES: Axis[] = ['x', 'y', 'z'];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Number(v.toFixed(4));
const centreOf = (box: Box) => lerpVec(box.min, box.max, 0.5);
/** The radius of the sphere around a box, as Box3.getBoundingSphere makes it and Viewer.fit frames it. */
const radiusOf = ({ min, max }: Box) => Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
const sameSet = (a: string[], b: string[]) => {
	if (a.length !== b.length) return false;
	const sorted = [...b].sort();
	return [...a].sort().every((id, i) => id === sorted[i]);
};

/** How far the model reaches along an axis, assembled or exploded. */
function span(model: Model, axis: Axis): [number, number] {
	const i = AXES.indexOf(axis);
	const { bounds, explodedBounds } = model;
	return [Math.min(bounds.min[i], explodedBounds.min[i]), Math.max(bounds.max[i], explodedBounds.max[i])];
}

/**
 * Where a cut parks: beyond the model, assembled or exploded, on the side the cut keeps, so it removes nothing. A cut
 * removes the positive side of its axis, the negative side when flipped (section.ts).
 */
export function parkedOffset(model: Model, axis: Axis, flip: boolean) {
	const extent = AXES.map((a) => {
		const [lo, hi] = span(model, a);
		return hi - lo;
	});
	const margin = PARK_MARGIN * Math.hypot(...extent);
	const [lo, hi] = span(model, axis);
	return flip ? lo - margin : hi + margin;
}

/** Whether a cut leaves the whole model standing, assembled or exploded. */
function removesNothing(model: Model, cut: Cut) {
	const [lo, hi] = span(model, cut.axis);
	return cut.flip ? cut.offset <= lo : cut.offset >= hi;
}

/** Fills in every key from the one before and resolves its names against the model. */
export function resolve(beats: Beat[], model: Model): Resolved {
	if (!beats.length) throw new Error('A storyboard needs at least one beat.');
	const missing: Missing[] = [];
	const whole: Place = { assembled: centreOf(model.bounds), exploded: centreOf(model.explodedBounds) };

	const place = (spec: PointSpec): Place | null => {
		if (spec === '*') return whole;
		if (Array.isArray(spec)) return { assembled: spec, exploded: spec };
		if ('centre' in spec) {
			const part = model.parts.get(spec.centre);
			return part ? { assembled: part.sphere.centre, exploded: part.explodedSphere.centre } : null;
		}
		const point = Object.hasOwn(model.points, spec.point) ? model.points[spec.point] : null;
		return point && { assembled: point, exploded: point };
	};
	const size = ({ fit, k = 1 }: SizeSpec) => {
		if (fit === '*') return { assembled: radiusOf(model.bounds) * k, exploded: radiusOf(model.explodedBounds) * k };
		const part = model.parts.get(fit);
		return part ? { assembled: part.sphere.radius * k, exploded: part.explodedSphere.radius * k } : null;
	};
	const pointName = (spec: PointSpec) => {
		if (spec === '*' || Array.isArray(spec)) return '';
		return 'centre' in spec ? spec.centre : spec.point;
	};

	let last: Pose = {
		t: 0,
		target: whole,
		az: 0,
		el: ISO_EL,
		size: { assembled: radiusOf(model.bounds), exploded: radiusOf(model.explodedBounds) },
		full: 0,
		explode: 0,
		cuts: [],
		hidden: [],
		isolated: [],
		highlight: null,
		measure: false,
		ui: {}
	};
	let start = 0;
	const resolved = beats.map((beat): ResolvedBeat => {
		const keys: Pose[] = [{ ...last, t: 0 }];
		beat.keys.forEach((key, index) => {
			const lost = (field: Missing['field'], name: string) => {
				missing.push({ beat: beat.id, key: index, field, name });
			};
			/** The ids for these names, or null when any of them is unknown. */
			const ids = (names: PartRef[], field: 'hidden' | 'isolated') => {
				const unknown = names.filter((name) => !model.parts.has(name));
				for (const name of unknown) lost(field, name);
				return unknown.length ? null : names.flatMap((name) => model.parts.get(name)?.ids ?? []);
			};
			const pose: Pose = { ...keys[keys.length - 1], t: key.t };
			if (key.target !== undefined) {
				const target = place(key.target);
				if (target) pose.target = target;
				else lost('target', pointName(key.target));
			}
			if (key.az !== undefined) pose.az = key.az;
			if (key.el !== undefined) pose.el = key.el;
			if (key.size) {
				const framed = size(key.size);
				if (framed) pose.size = framed;
				else lost('size', key.size.fit);
			}
			if (key.full !== undefined) pose.full = clamp(key.full, 0, 1);
			if (key.explode !== undefined) pose.explode = clamp(key.explode, 0, 1);
			if (key.cuts) {
				pose.cuts = key.cuts.map((cut) => ({
					axis: cut.axis,
					flip: cut.flip,
					offset: cut.offset,
					in: clamp(cut.in, 0, 1),
					parked: parkedOffset(model, cut.axis, cut.flip)
				}));
			}
			if (key.hidden) pose.hidden = ids(key.hidden, 'hidden') ?? pose.hidden;
			if (key.isolated) pose.isolated = ids(key.isolated, 'isolated') ?? pose.isolated;
			if (key.highlight === null) pose.highlight = null;
			else if (key.highlight !== undefined) {
				const id = model.parts.get(key.highlight)?.ids[0];
				if (id) pose.highlight = id;
				else lost('highlight', key.highlight);
			}
			if (key.measure !== undefined) pose.measure = key.measure;
			if (key.ui) pose.ui = key.ui;
			keys.push(pose);
		});
		last = keys[keys.length - 1];
		const begins = start;
		start += beat.len;
		return { id: beat.id, len: beat.len, start: begins, keys, holds: [...beat.holds].sort((a, b) => a - b) };
	});
	return { up: model.up, beats: resolved, missing };
}

/** Where tau falls: the beat, and how far through it. Tau runs from 0 to the number of beats. */
function locate(resolved: Resolved, tau: number) {
	const count = resolved.beats.length;
	const at = clamp(tau, 0, count);
	const beat = Math.min(Math.floor(at), count - 1);
	return { beat, local: at - beat };
}

/** The keys either side of a point in a beat, and how far the point is from the one to the other. */
function segment(keys: Pose[], local: number) {
	let i = 0;
	while (i + 1 < keys.length && keys[i + 1].t <= local) i++;
	const from = keys[i];
	const to = keys[i + 1] ?? from;
	return { from, to, u: to === from ? 0 : clamp((local - from.t) / (to.t - from.t), 0, 1) };
}

const placeAt = (place: Place, explode: number) => lerpVec(place.assembled, place.exploded, explode);
const sizeAt = (pose: Pose, explode: number) => lerp(pose.size.assembled, pose.size.exploded, explode);

/**
 * The cuts between two keys, slot by slot. A slot only one key has is parked at the other, so a cut slides in or out;
 * every slot moves at an even pace.
 */
function cutsBetween(from: Slot[], to: Slot[], u: number): Cut[] {
	return Array.from({ length: Math.max(from.length, to.length) }, (_, i) => {
		const slot = to[i] ?? from[i];
		const at = (cut: Slot | undefined) => (cut ? lerp(cut.parked, cut.offset, cut.in) : slot.parked);
		return { axis: slot.axis, offset: lerp(at(from[i]), at(to[i]), u), flip: slot.flip };
	});
}

/** The view at a point of one beat, without hysteresis. */
function stateAt(resolved: Resolved, beat: number, local: number, viewport: Viewport): State {
	const { from, to, u } = segment(resolved.beats[beat].keys, local);
	const eased = smootherstep(u);
	// Explode moves at an even pace: Explode.set eases each level of the assembly itself. The framed sphere and the
	// part centres move with it, toward where explode takes them.
	const explode = lerp(from.explode, to.explode, u);
	const full = lerp(from.full, to.full, eased);
	const radius = logLerp(sizeAt(from, explode), sizeAt(to, explode), eased);
	const shot: Shot = {
		target: lerpVec(placeAt(from.target, explode), placeAt(to.target, explode), eased),
		az: lerp(from.az, to.az, eased),
		el: clamp(lerp(from.el, to.el, eased), -EL_LIMIT, EL_LIMIT),
		dist: fitDistance(radius, viewport, full)
	};
	return {
		beat,
		local,
		camera: pose(shot, viewport, full, resolved.up),
		shot,
		radius,
		full,
		explode,
		cuts: cutsBetween(from.cuts, to.cuts, u),
		hidden: [...from.hidden],
		isolated: [...from.isolated],
		highlight: from.highlight,
		measure: from.measure,
		ui: { ...from.ui }
	};
}

/** The key in force `by` viewport heights from a point, across beats. */
function keyNear(resolved: Resolved, beat: number, local: number, by: number) {
	const { beats } = resolved;
	const at = beats[beat].start + local * beats[beat].len + by;
	let b = 0;
	while (b + 1 < beats.length && beats[b + 1].start <= at) b++;
	const { start, len, keys } = beats[b];
	return segment(keys, len > 0 ? clamp((at - start) / len, 0, 1) : 0).from;
}

/**
 * The view at tau, the beat's index plus how far through it. Continuous fields ease between keys; discrete ones switch
 * at their key. Given the previous state, hidden, isolated and measure switch only once the playhead is HYSTERESIS past
 * their key in the direction it travels, so a playhead resting near a key does not toggle them.
 */
export function evaluate(resolved: Resolved, tau: number, viewport: Viewport, previous?: State): State {
	const { beat, local } = locate(resolved, tau);
	const state = stateAt(resolved, beat, local, viewport);
	if (!previous) return state;
	// Within the margin of a key the value on either side of it may stand; past it, only the value there.
	const before = keyNear(resolved, beat, local, -HYSTERESIS);
	const after = keyNear(resolved, beat, local, HYSTERESIS);
	const stands = (field: 'hidden' | 'isolated') =>
		sameSet(previous[field], before[field]) || sameSet(previous[field], after[field]);
	if (stands('hidden')) state.hidden = [...previous.hidden];
	if (stands('isolated')) state.isolated = [...previous.isolated];
	if (previous.measure === before.measure || previous.measure === after.measure) state.measure = previous.measure;
	return state;
}

/**
 * Stepped mode, for reduced motion and slow devices: the view at the last hold passed, all at once. Before a beat's
 * first hold that is the previous beat's last hold; before the first hold of all, the first. The state's beat and local
 * are the hold's.
 */
export function evaluateStepped(resolved: Resolved, tau: number, viewport: Viewport): State {
	const { beat, local } = locate(resolved, tau);
	const holds = resolved.beats.flatMap((b, index) => b.holds.map((t) => ({ beat: index, t })));
	const passed = holds.filter((hold) => hold.beat < beat || (hold.beat === beat && hold.t <= local));
	const hold = passed.at(-1) ?? holds[0] ?? { beat: 0, t: 0 };
	return stateAt(resolved, hold.beat, hold.t, viewport);
}

export type Violation = {
	rule:
		| 'missing'
		| 'keys'
		| 'join'
		| 'cuts'
		| 'measure-explode'
		| 'measure-behind'
		| 'cut-faces'
		| 'cut-removes'
		| 'cut-framed'
		| 'subject-kept'
		| 'hide-reveals'
		| 'isolate-subject'
		| 'highlight-shown'
		| 'hold-differs'
		| 'measure-framed'
		| 'explode-spreads'
		| 'camera-clear';
	beat: string;
	message: string;
};

// What makes a hold show what its copy says. The thresholds were measured on the SO-101 and the SeedHammer II.

/**
 * How far off a cutting plane the camera must stand, as a share of its distance to the target (the sine of 10°): seen
 * closer to edge-on, the cut face is a sliver of hatching.
 */
const CUT_FACING = Math.sin((10 * Math.PI) / 180);
/**
 * The least share of the body volume the other cuts keep that a cut must take away as it comes in. The SO-101's cuts
 * that barely showed took 1% and 3%; the smallest that read clearly took 8%.
 */
const CUT_REMOVES = 0.06;
/** How far the shot's target may lie on a cut's removed side, as a share of the framed radius. */
const SUBJECT_SLACK = 0.1;
/** A part about to be kept alone is the subject of the hold before: its centre within this share of the framed radius. */
const ISOLATE_NEAR = 1 / 3;
/** Two holds of a beat show different pictures when the view changes by as much as one of these. */
const HOLD_CHANGE = { az: 10, el: 8, radius: 1.25, target: 0.25, explode: 0.25, full: 0.5 };
/** How far inside the frame the measured points must show, as a share of its smaller side. */
const MEASURE_MARGIN = 0.04;
/** A part kept alone and taken apart must spread to at least this many times its radius, or nothing shows. */
const EXPLODE_SPREAD = 1.2;
/** Explode at or below this counts as assembled, where the bodies' boxes hold. */
const ASSEMBLED = 0.01;

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

/** Whether a body is shown under these hidden and kept-alone ids, as applyVisibility decides it. */
function shown(body: Body, hidden: Set<string>, isolated: Set<string>) {
	if (body.ids.some((id) => hidden.has(id))) return false;
	return !isolated.size || body.ids.some((id) => isolated.has(id));
}

/** The box every cut keeps: the half-spaces they keep meet in one (section.ts). */
function keptBox(cuts: Cut[]): Box {
	const min: Vec3 = [-Infinity, -Infinity, -Infinity];
	const max: Vec3 = [Infinity, Infinity, Infinity];
	for (const cut of cuts) {
		const i = AXES.indexOf(cut.axis);
		if (cut.flip) min[i] = Math.max(min[i], cut.offset);
		else max[i] = Math.min(max[i], cut.offset);
	}
	return { min, max };
}

/** The volume two boxes share. */
function overlap(a: Box, b: Box) {
	let volume = 1;
	for (let i = 0; i < 3; i++) volume *= Math.max(0, Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]));
	return volume;
}

const within = (p: Vec3, box: Box) => p.every((v, i) => v >= box.min[i] && v <= box.max[i]);

/** Whether the segment from p to q passes through a box. */
function crosses(p: Vec3, q: Vec3, box: Box) {
	let enter = 0, leave = 1;
	for (let i = 0; i < 3; i++) {
		const d = q[i] - p[i];
		if (Math.abs(d) < 1e-12) {
			if (p[i] < box.min[i] || p[i] > box.max[i]) return false;
			continue;
		}
		const [a, b] = [(box.min[i] - p[i]) / d, (box.max[i] - p[i]) / d].sort((x, y) => x - y);
		enter = Math.max(enter, a);
		leave = Math.min(leave, b);
		if (enter > leave) return false;
	}
	return true;
}

/** How far a point lies from the segment from p to q. */
function fromSegment(point: Vec3, p: Vec3, q: Vec3) {
	const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
	const length = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
	const t = length ? clamp(((point[0] - p[0]) * d[0] + (point[1] - p[1]) * d[1] + (point[2] - p[2]) * d[2]) / length, 0, 1) : 0;
	return distance(point, [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t]);
}

/** Whether two cut lists are the same cuts in the same places. */
const sameCutList = (a: Cut[], b: Cut[]) =>
	a.length === b.length &&
	a.every((cut, i) => cut.axis === b[i].axis && cut.flip === b[i].flip && Math.abs(cut.offset - b[i].offset) < 1e-6);

/**
 * The rules a hold keeps, on one viewport: each hold is a picture the copy describes (stepped mode and the stills show
 * exactly these), so each must show what changed in it.
 * - cut-faces: the camera stands on the side every cut takes away, so their faces turn toward it.
 * - cut-removes: a cut, as it comes in, takes away a share of what the other cuts keep that can be seen.
 * - cut-framed and subject-kept: every cut passes through what the shot frames, and the shot's target is not cut away.
 * - hide-reveals: a part switched off stands between the camera and the target, so switching it off uncovers the target.
 * - isolate-subject: a part kept alone was the shot's subject, and shown, in the hold before.
 * - highlight-shown: a tinted part is shown and in the frame.
 * - hold-differs: the holds of a beat are different pictures.
 * - measure-framed: the measured points are kept by every cut and show inside the frame.
 * - explode-spreads: a part kept alone and taken apart spreads.
 * - camera-clear: the camera does not stand inside a body.
 */
function checkHolds(
	resolved: Resolved,
	viewport: Viewport,
	model: Model,
	measurePoints: Vec3[],
	report: (rule: Violation['rule'], index: number, message: string) => void
) {
	const partOf = new Map<string, { name: string; sphere: Sphere; explodedSphere: Sphere }>();
	for (const [name, part] of model.parts) for (const id of part.ids) partOf.set(id, { name, ...part });
	const bodiesOf = (id: string) => model.bodies.filter((body) => body.ids.includes(id));
	const placed = (part: { sphere: Sphere; explodedSphere: Sphere }, explode: number) => ({
		centre: lerpVec(part.sphere.centre, part.explodedSphere.centre, explode),
		radius: lerp(part.sphere.radius, part.explodedSphere.radius, explode)
	});
	const size = `${viewport.width}×${viewport.height}`;
	const holds = resolved.beats.flatMap((beat, b) => beat.holds.map((t) => ({ b, t })));

	let before: { b: number; t: number; state: State } | null = null;
	for (const { b, t } of holds) {
		const state = stateAt(resolved, b, t, viewport);
		const at = `at the hold t = ${t} on ${size}`;
		const camera = state.camera.position;
		const target = state.shot.target;
		const R = state.radius;
		const hidden = new Set(state.hidden);
		const isolated = new Set(state.isolated);
		const cutting = state.cuts.filter((cut) => !removesNothing(model, cut));
		const assembled = state.explode <= ASSEMBLED;

		for (const cut of cutting) {
			const i = AXES.indexOf(cut.axis);
			const what = `the ${cut.axis} cut at ${round(cut.offset)}`;
			const off = cut.flip ? cut.offset - camera[i] : camera[i] - cut.offset;
			if (off < CUT_FACING * distance(camera, target)) report('cut-faces', b, `${what} turns its face from the camera ${at}`);
			if (Math.abs(cut.offset - target[i]) > R) report('cut-framed', b, `${what} lies outside what the shot frames ${at}`);
			const beyond = cut.flip ? cut.offset - target[i] : target[i] - cut.offset;
			if (beyond > SUBJECT_SLACK * R) report('subject-kept', b, `${what} takes away the shot's target ${at}`);
		}

		if (assembled) {
			const seen = model.bodies.filter((body) => shown(body, hidden, isolated));
			const all = keptBox(cutting);
			const keptAll = seen.reduce((sum, body) => sum + overlap(body.box, all), 0);
			state.cuts.forEach((cut, k) => {
				if (removesNothing(model, cut)) return;
				const was = before?.state.cuts[k];
				if (was && was.axis === cut.axis && was.flip === cut.flip && !removesNothing(model, was)) return;
				const others = keptBox(cutting.filter((other) => other !== cut));
				const keptOthers = seen.reduce((sum, body) => sum + overlap(body.box, others), 0);
				const share = keptOthers > 0 ? (keptOthers - keptAll) / keptOthers : 0;
				if (share < CUT_REMOVES) {
					const what = `the ${cut.axis} cut at ${round(cut.offset)}`;
					report('cut-removes', b, `${what} takes away ${percent(share)} of what the other cuts keep ${at}`);
				}
			});
		}

		if (!isolated.size) {
			for (const id of state.hidden) {
				if (before?.state.hidden.includes(id)) continue;
				const part = partOf.get(id);
				const boxes = bodiesOf(id).map((body) => body.box);
				const covers = boxes.length
					? boxes.some((box) => crosses(camera, target, box))
					: !!part && fromSegment(part.sphere.centre, camera, target) <= part.sphere.radius;
				if (!covers) report('hide-reveals', b, `${part?.name ?? id} goes off without standing in front of the target ${at}`);
			}
		}

		if (before) {
			const previous = before.state;
			for (const id of state.isolated) {
				if (previous.isolated.includes(id)) continue;
				const part = partOf.get(id);
				if (!part) continue;
				const wasShown = bodiesOf(id).some((body) => shown(body, new Set(previous.hidden), new Set(previous.isolated)));
				const near = distance(placed(part, previous.explode).centre, previous.shot.target) <= ISOLATE_NEAR * previous.radius;
				if (!wasShown || !near) {
					report('isolate-subject', b, `${part.name} is kept alone but was not the subject of the hold before ${at}`);
				}
			}
		}

		if (state.highlight) {
			const part = partOf.get(state.highlight);
			const visible = bodiesOf(state.highlight).some((body) => shown(body, hidden, isolated));
			const sphere = part && placed(part, state.explode);
			const framed = !!sphere && distance(sphere.centre, target) <= sphere.radius + R;
			if (!visible || !framed) report('highlight-shown', b, `${part?.name ?? state.highlight} is tinted but not in sight ${at}`);
		}

		if (before && before.b === b) {
			const previous = before.state;
			const changed =
				!sameSet(previous.hidden, state.hidden) ||
				!sameSet(previous.isolated, state.isolated) ||
				previous.highlight !== state.highlight ||
				previous.measure !== state.measure ||
				!sameCutList(previous.cuts, state.cuts) ||
				Math.abs(previous.shot.az - state.shot.az) >= HOLD_CHANGE.az ||
				Math.abs(previous.shot.el - state.shot.el) >= HOLD_CHANGE.el ||
				Math.max(previous.radius / R, R / previous.radius) >= HOLD_CHANGE.radius ||
				distance(previous.shot.target, target) >= HOLD_CHANGE.target * R ||
				Math.abs(previous.explode - state.explode) >= HOLD_CHANGE.explode ||
				Math.abs(previous.full - state.full) >= HOLD_CHANGE.full;
			if (!changed) report('hold-differs', b, `the hold at t = ${t} shows the picture of the hold at t = ${before.t} on ${size}`);
		}

		if (state.measure) {
			const rect = frameRect(viewport, state.full);
			const margin = MEASURE_MARGIN * Math.min(rect.x1 - rect.x0, rect.y1 - rect.y0);
			for (const point of measurePoints) {
				const kept = within(point, keptBox(cutting));
				const shownAt = project(point, state.camera, viewport, resolved.up);
				const inside =
					!!shownAt &&
					shownAt[0] >= rect.x0 + margin &&
					shownAt[0] <= rect.x1 - margin &&
					shownAt[1] >= rect.y0 + margin &&
					shownAt[1] <= rect.y1 - margin;
				if (!kept || !inside) report('measure-framed', b, `a measured point is ${kept ? 'outside the frame' : 'cut away'} ${at}`);
			}
		}

		if (state.explode > 0.5) {
			for (const id of state.isolated) {
				const part = partOf.get(id);
				if (part && part.explodedSphere.radius < EXPLODE_SPREAD * part.sphere.radius) {
					report('explode-spreads', b, `${part.name}, kept alone, hardly spreads when taken apart ${at}`);
				}
			}
		}

		if (assembled) {
			const kept = keptBox(cutting);
			const inside = model.bodies.find((body) => {
				if (!shown(body, hidden, isolated)) return false;
				const min = body.box.min.map((v, i) => Math.max(v, kept.min[i])) as Vec3;
				const max = body.box.max.map((v, i) => Math.min(v, kept.max[i])) as Vec3;
				return within(camera, { min, max });
			});
			if (inside) {
				const name = inside.ids.map((id) => partOf.get(id)?.name).find(Boolean) ?? inside.ids[0];
				report('camera-clear', b, `the camera stands inside ${name} ${at}`);
			}
		}

		before = { b, t, state };
	}
}

/** Where check() looks in a beat: fine even steps, every key, and either side of every key. */
function samples(beat: ResolvedBeat) {
	const at = new Set<number>();
	for (let i = 0; i <= CHECK_STEPS; i++) at.add(i / CHECK_STEPS);
	for (const key of beat.keys) for (const t of [key.t - 1e-6, key.t, key.t + 1e-6]) if (t >= 0 && t <= 1) at.add(t);
	return [...at].sort((a, b) => a - b);
}

/**
 * What is wrong with where a storyboard key sits or what it frames, or null. `index` counts the storyboard's own keys;
 * the resolved beat's first key is the previous beat's end.
 */
function keyProblem(beat: ResolvedBeat, index: number) {
	const key = beat.keys[index + 1];
	if (!(key.t >= 0 && key.t <= 1)) return `key ${index} at t = ${key.t} lies outside 0 to 1`;
	if (index > 0 && key.t <= beat.keys[index].t) return `key ${index} at t = ${key.t} is not after key ${index - 1}`;
	if (!(key.size.assembled > 0 && key.size.exploded > 0)) return `key ${index} frames a size of 0 or less`;
	return null;
}

/** Whether a point lies between the near and far planes Viewer sets from the model's radius. */
function inFront(point: Vec3, camera: Camera, radius: number) {
	const [px, py, pz] = camera.position;
	const [fx, fy, fz] = [camera.target[0] - px, camera.target[1] - py, camera.target[2] - pz];
	const depth = ((point[0] - px) * fx + (point[1] - py) * fy + (point[2] - pz) * fz) / Math.hypot(fx, fy, fz);
	return depth > Math.max(0.1, radius / 200) && depth < radius * 40;
}

/** What differs between the end of one beat and the start of the next, or null when nothing does. */
function jump(end: State, start: State, model: Model) {
	const tolerance = 1e-6 * radiusOf(model.bounds);
	const apart = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > tolerance;
	if (apart(end.camera.position, start.camera.position) || apart(end.camera.target, start.camera.target)) {
		return 'the camera';
	}
	if (Math.abs(end.full - start.full) > 1e-9) return 'the framing';
	if (Math.abs(end.explode - start.explode) > 1e-9) return 'explode';
	// Parked cuts come and go at a join: they remove nothing, so only the ones that cut must match.
	const cutting = (state: State) => state.cuts.filter((cut) => !removesNothing(model, cut));
	const [a, b] = [cutting(end), cutting(start)];
	const moved = (cut: Cut, i: number) =>
		cut.axis !== b[i].axis || cut.flip !== b[i].flip || Math.abs(cut.offset - b[i].offset) > tolerance;
	if (a.length !== b.length || a.some(moved)) return 'the cuts';
	if (!sameSet(end.hidden, start.hidden)) return 'the hidden parts';
	if (!sameSet(end.isolated, start.isolated)) return 'the isolated parts';
	if (end.highlight !== start.highlight) return 'the highlight';
	if (end.measure !== start.measure) return 'Measure';
	return null;
}

/**
 * Checks the storyboard's rules over the whole timeline, at fine steps, on each viewport, scrolling down and up with
 * the hysteresis evaluate() applies: every name resolves; keys run in order within their beat; no beat starts with a
 * jump from where the previous one ended; the cuts keep their count, axes and sides within a beat; Measure is never on
 * while explode is above 0; and while Measure is on, every measured point lies in front of the camera. At every hold
 * it checks that the picture shows what changed in it (checkHolds). One violation is reported per rule and beat.
 */
export function check(resolved: Resolved, viewports: Viewport[], model: Model, measurePoints: Vec3[] = []) {
	const violations: Violation[] = resolved.missing.map(({ beat, key, field, name }) => ({
		rule: 'missing',
		beat,
		message: `${beat}: key ${key} names "${name}" for ${field}, which the model lacks`
	}));
	const reported = new Set<string>();
	const report = (rule: Violation['rule'], index: number, message: string) => {
		const beat = resolved.beats[index].id;
		if (reported.has(`${rule} ${beat}`)) return;
		reported.add(`${rule} ${beat}`);
		violations.push({ rule, beat, message: `${beat}: ${message}` });
	};
	const size = (viewport: Viewport) => `${viewport.width}×${viewport.height}`;

	resolved.beats.forEach((beat, b) => {
		if (!(beat.len > 0)) report('keys', b, `its length ${beat.len} is not positive`);
		for (let i = 0; i + 1 < beat.keys.length; i++) {
			const problem = keyProblem(beat, i);
			if (problem) report('keys', b, problem);
		}
		const hold = beat.holds.find((t) => !(t >= 0 && t <= 1));
		if (hold !== undefined) report('keys', b, `the hold at t = ${hold} lies outside 0 to 1`);

		let shape: string | undefined;
		for (const local of samples(beat)) {
			const { from, to, u } = segment(beat.keys, local);
			const now = cutsBetween(from.cuts, to.cuts, u).map((cut) => `${cut.axis}${cut.flip ? '!' : ''}`).join(' ');
			shape ??= now;
			if (now !== shape) {
				report('cuts', b, `its cuts change from [${shape}] to [${now}] at t = ${round(local)}`);
				break;
			}
		}
	});

	const radius = radiusOf(model.bounds);
	const taus = [...new Set(resolved.beats.flatMap((beat, b) => samples(beat).map((t) => b + t)))];
	taus.sort((a, b) => a - b);
	for (const viewport of viewports) {
		checkHolds(resolved, viewport, model, measurePoints, report);
		for (let b = 1; b < resolved.beats.length; b++) {
			const what = jump(stateAt(resolved, b - 1, 1, viewport), stateAt(resolved, b, 0, viewport), model);
			if (what) report('join', b, `${what} jumps where it starts, on ${size(viewport)}`);
		}
		for (const way of ['down', 'up']) {
			let previous: State | undefined;
			for (const tau of way === 'down' ? taus : [...taus].reverse()) {
				const state = evaluate(resolved, tau, viewport, previous);
				previous = state;
				if (!state.measure) continue;
				const at = `t = ${round(state.local)}, scrolling ${way} on ${size(viewport)}`;
				if (state.explode > 0) {
					report('measure-explode', state.beat, `Measure is on at explode ${round(state.explode)}, ${at}`);
				}
				if (measurePoints.some((point) => !inFront(point, state.camera, radius))) {
					report('measure-behind', state.beat, `a measured point is not in front of the camera at ${at}`);
				}
			}
		}
	}
	return violations;
}
