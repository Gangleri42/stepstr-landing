import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Cut } from '$lib/state/hash';
import { Section } from '$lib/viewer/section';
import { DESKTOP, ISO_EL, PHONE, STILL, direction, fitDistance, smootherstep, type Vec3 } from './camera.ts';
import {
	HYSTERESIS,
	check,
	evaluate,
	evaluateStepped,
	parkedOffset,
	resolve,
	type Beat,
	type CutSpec,
	type Key,
	type Model,
	type State
} from './timeline.ts';

const sphere = (centre: Vec3, radius: number) => ({ centre, radius });
const box = (min: Vec3, max: Vec3) => ({ min, max });
/** A small arm standing on Z: a base, an upper arm, a jaw, and two servos that share a name, inside the upper arm. */
const MODEL: Model = {
	up: 'z',
	bounds: { min: [-60, -40, 0], max: [60, 40, 200] },
	explodedBounds: { min: [-120, -60, -30], max: [100, 60, 300] },
	bodies: [
		{ ids: ['a1'], box: box([-40, -30, 0], [40, 30, 50]) },
		{ ids: ['b2'], box: box([-25, -20, 50], [25, 20, 160]) },
		{ ids: ['c3'], box: box([14, -6, 170], [30, 6, 192]) },
		{ ids: ['d4'], box: box([-12, -10, 50], [0, 10, 70]) },
		{ ids: ['d5'], box: box([0, -10, 50], [12, 10, 70]) }
	],
	parts: new Map([
		['Base', { ids: ['a1'], sphere: sphere([0, 0, 25], 45), explodedSphere: sphere([0, 0, 0], 45) }],
		['Upper_arm', { ids: ['b2'], sphere: sphere([0, 0, 100], 60), explodedSphere: sphere([0, 0, 150], 60) }],
		['Jaw', { ids: ['c3'], sphere: sphere([20, 0, 180], 12), explodedSphere: sphere([60, 0, 280], 12) }],
		['Servo', { ids: ['d4', 'd5'], sphere: sphere([0, 0, 60], 18), explodedSphere: sphere([-90, 0, 60], 24) }]
	]),
	points: { jawTip: [26, 0, 192] }
};
const VIEWPORTS = [DESKTOP, PHONE, STILL];
/** The two ends of the stored dimension line. */
const MEASURED: Vec3[] = [
	[26, 0, 192],
	[0, 30, 10]
];
const RADIUS = Math.hypot(120, 80, 200) / 2;
const EXPLODED_RADIUS = Math.hypot(220, 120, 330) / 2;

/** Seen from the measure beat's side (azimuth 270, x and y below 0, above the model), both take away what faces it. */
const X: CutSpec = { axis: 'x', offset: 0, flip: true, in: 0 };
const Z: CutSpec = { axis: 'z', offset: 110, flip: false, in: 0 };
/** The plan's storyboard in small: every kind of key, keeping every rule. */
const STORY: Beat[] = [
	{ id: 'iso', len: 1.5, holds: [0.3], keys: [{ t: 0, size: { fit: '*', k: 1.05 } }, { t: 1, az: 10 }] },
	{
		id: 'orbit',
		len: 3,
		holds: [0.45, 0.75],
		keys: [
			{ t: 0.3, target: { point: 'jawTip' }, az: 110, size: { fit: 'Jaw', k: 1.4 } },
			{ t: 0.6, az: 210, size: { fit: 'Jaw', k: 0.45 }, full: 1 },
			{ t: 0.9, target: '*', size: { fit: '*', k: 1.05 }, full: 0 }
		]
	},
	{
		id: 'measure',
		len: 2,
		holds: [0.5],
		keys: [{ t: 0.1, az: 270, el: 15 }, { t: 0.15, measure: true }, { t: 0.9, measure: false }]
	},
	{
		id: 'parts',
		len: 2.5,
		holds: [0.2, 0.5, 0.8],
		keys: [
			{ t: 0.1, highlight: 'Upper_arm' },
			{ t: 0.3, hidden: ['Upper_arm'], highlight: null },
			{ t: 0.6, hidden: [], isolated: ['Servo'], target: { centre: 'Servo' }, size: { fit: 'Servo', k: 1.2 } },
			{ t: 0.95, isolated: [], target: '*', size: { fit: '*', k: 1.05 } }
		]
	},
	{
		id: 'explode',
		len: 2.5,
		holds: [0.5],
		keys: [{ t: 0.1, explode: 0 }, { t: 0.4, explode: 1 }, { t: 0.6, explode: 1 }, { t: 0.9, explode: 0 }]
	},
	{
		id: 'section',
		len: 2.5,
		holds: [0.6],
		keys: [
			{ t: 0, cuts: [X, Z] },
			{ t: 0.3, cuts: [{ ...X, in: 1 }, Z] },
			{ t: 0.6, cuts: [{ ...X, in: 1 }, { ...Z, in: 1 }] },
			{ t: 0.95, cuts: [X, Z] }
		]
	},
	{ id: 'yours', len: 2, holds: [0.5], keys: [{ t: 0, cuts: [] }, { t: 0.5, az: 360, el: ISO_EL, full: 1 }] }
];
const at = (id: string) => STORY.findIndex((beat) => beat.id === id);
/** The storyboard with one beat's keys replaced. */
const variant = (id: string, keys: Key[]) => STORY.map((beat) => (beat.id === id ? { ...beat, keys } : beat));
const rules = (beats: Beat[]) => check(resolve(beats, MODEL), VIEWPORTS, MODEL, MEASURED).map((v) => v.rule);
/** One beat on its own, after a first beat that leaves everything at its default. */
const alone = (keys: Key[], len = 1): Beat[] => [
	{ id: 'still', len: 1, holds: [], keys: [] },
	{ id: 'test', len, holds: [], keys }
];
const v3 = (v: Vec3) => new THREE.Vector3(...v);

function corners({ min, max }: { min: Vec3; max: Vec3 }) {
	const pick = (i: number, axis: number) => (i & (1 << axis) ? max[axis] : min[axis]);
	return Array.from({ length: 8 }, (_, i) => new THREE.Vector3(pick(i, 0), pick(i, 1), pick(i, 2)));
}
/** Whether the viewer's own Section keeps every corner of the model, assembled and exploded, under these cuts. */
function keepsAll(cuts: Cut[]) {
	const section = new Section();
	section.set(cuts);
	return [...corners(MODEL.bounds), ...corners(MODEL.explodedBounds)].every((corner) => section.keeps(corner));
}

describe('interpolation', () => {
	const resolved = resolve(STORY, MODEL);
	const orbit = at('orbit');

	it('orbits in unwrapped degrees, the long way round', () => {
		expect(evaluate(resolved, orbit + 0.15, DESKTOP).shot.az).toBeCloseTo(60, 9);
		const middle = evaluate(resolved, orbit + 0.45, DESKTOP);
		expect(middle.shot.az).toBeCloseTo(160, 9);
		const seen = v3(middle.camera.position).sub(v3(middle.shot.target)).normalize();
		expect(seen.distanceTo(v3(direction(160, middle.shot.el, 'z')))).toBeLessThan(1e-9);
		let az = -Infinity;
		for (let t = 0; t <= 1; t += 0.01) {
			const next = evaluate(resolved, orbit + t, DESKTOP).shot.az;
			expect(next).toBeGreaterThanOrEqual(az - 1e-9);
			az = next;
		}
		expect(az).toBe(210);
	});

	it('eases the distance in log space, following the framed sphere', () => {
		const story = alone([{ t: 0, size: { fit: 'Jaw' } }, { t: 1, size: { fit: '*' } }]);
		const near = fitDistance(12, PHONE, 0), far = fitDistance(RADIUS, PHONE, 0);
		const state = (t: number) => evaluate(resolve(story, MODEL), 1 + t, PHONE).shot.dist;
		expect(state(0)).toBeCloseTo(near, 9);
		expect(state(0.5)).toBeCloseTo(Math.sqrt(near * far), 9);
		expect(state(0.25)).toBeCloseTo(near * (far / near) ** smootherstep(0.25), 9);
	});

	it('holds the elevation within ±80°', () => {
		const resolvedClamp = resolve(alone([{ t: 0, el: 60 }, { t: 0.5, el: 100 }, { t: 1, el: -120 }]), MODEL);
		expect(evaluate(resolvedClamp, 1.25, DESKTOP).shot.el).toBeCloseTo(80, 9);
		expect(evaluate(resolvedClamp, 1.5, DESKTOP).shot.el).toBe(80);
		expect(evaluate(resolvedClamp, 2, DESKTOP).shot.el).toBe(-80);
	});

	it('eases the framing, and moves explode and the cuts at an even pace', () => {
		const cut: CutSpec = { axis: 'y', offset: 10, flip: false, in: 0 };
		const story = alone([{ t: 0, cuts: [cut] }, { t: 1, full: 1, explode: 1, cuts: [{ ...cut, in: 1 }] }]);
		const state = evaluate(resolve(story, MODEL), 1.25, DESKTOP);
		expect(state.full).toBeCloseTo(smootherstep(0.25), 12);
		expect(state.explode).toBeCloseTo(0.25, 12);
		const parked = parkedOffset(MODEL, 'y', false);
		const offset = expect.closeTo(parked + (10 - parked) * 0.25, 9);
		expect(state.cuts).toEqual([{ axis: 'y', offset, flip: false }]);
	});

	it('follows the exploded sphere while explode is above 0', () => {
		const state = evaluate(resolved, at('explode') + 0.25, DESKTOP);
		expect(state.explode).toBeCloseTo(0.5, 12);
		// Halfway from the assembled centre, (0, 0, 100), to the exploded one, (-10, 0, 135).
		expect(state.shot.target).toEqual([expect.closeTo(-5, 9), 0, expect.closeTo(117.5, 9)]);
		expect(state.shot.dist).toBeCloseTo(fitDistance(((RADIUS + EXPLODED_RADIUS) / 2) * 1.05, DESKTOP, 0), 9);
	});
});

describe('carrying values over', () => {
	it('keeps what a key leaves out from the key before', () => {
		const resolved = resolve(alone([{ t: 0.2, az: 40, el: 20 }, { t: 0.6, el: 50 }]), MODEL);
		expect(evaluate(resolved, 1.6, DESKTOP).shot).toMatchObject({ az: 40, el: 50 });
		expect(evaluate(resolved, 1.4, DESKTOP).shot.az).toBe(40);
		expect(evaluate(resolved, 1.4, DESKTOP).shot.el).toBeCloseTo(35, 9);
	});

	it('starts each beat from where the previous one ended', () => {
		const resolved = resolve(STORY, MODEL);
		// The orbit ended at azimuth 210; the measure beat's first key, at 0.1, turns to 270.
		expect(evaluate(resolved, at('measure') + 0.05, DESKTOP).shot.az).toBeCloseTo(240, 9);
		for (let b = 1; b < STORY.length; b++) {
			const [end, start] = [evaluate(resolved, b - 1e-9, PHONE), evaluate(resolved, b, PHONE)];
			expect(v3(end.camera.position).distanceTo(v3(start.camera.position))).toBeLessThan(1e-3);
			expect(start.explode).toBeCloseTo(end.explode, 6);
		}
	});

	it('resolves part names to ids: hidden and isolated take every occurrence, the highlight the first', () => {
		const resolved = resolve(STORY, MODEL);
		const parts = at('parts');
		expect(evaluate(resolved, parts + 0.2, DESKTOP).highlight).toBe('b2');
		expect(evaluate(resolved, parts + 0.4, DESKTOP)).toMatchObject({ hidden: ['b2'], highlight: null });
		expect(evaluate(resolved, parts + 0.7, DESKTOP)).toMatchObject({ hidden: [], isolated: ['d4', 'd5'] });
		const story = alone([{ t: 0.5, highlight: 'Servo' }]);
		expect(evaluate(resolve(story, MODEL), 1.5, DESKTOP).highlight).toBe('d4');
	});
});

describe('names the model lacks', () => {
	const story = alone([
		{ t: 0.1, az: 30, hidden: ['Jaw'], target: { centre: 'Upper_arm' } },
		{ t: 0.2, target: { centre: 'Nope' }, size: { fit: 'Gone' }, hidden: ['Jaw', 'Nada'] },
		{ t: 0.3, highlight: 'Zip', isolated: ['Ghost'], target: { point: 'nowhere' } }
	]);
	const resolved = resolve(story, MODEL);

	it('are listed with the key and field that named them', () => {
		expect(resolved.missing).toEqual([
			{ beat: 'test', key: 1, field: 'target', name: 'Nope' },
			{ beat: 'test', key: 1, field: 'size', name: 'Gone' },
			{ beat: 'test', key: 1, field: 'hidden', name: 'Nada' },
			{ beat: 'test', key: 2, field: 'target', name: 'nowhere' },
			{ beat: 'test', key: 2, field: 'isolated', name: 'Ghost' },
			{ beat: 'test', key: 2, field: 'highlight', name: 'Zip' }
		]);
	});

	it('drop their field, so the value before carries on', () => {
		const state = evaluate(resolved, 1.5, DESKTOP);
		expect(state).toMatchObject({ hidden: ['c3'], isolated: [], highlight: null });
		expect(state.shot.target).toEqual([0, 0, 100]);
		expect(state.shot.dist).toBeCloseTo(fitDistance(RADIUS, DESKTOP, 0), 9);
	});

	it('fail the check', () => {
		expect(check(resolved, VIEWPORTS, MODEL).filter((v) => v.rule === 'missing')).toHaveLength(6);
	});
});

describe('parked cuts', () => {
	it('sit outside the model, assembled or exploded, on the side they keep', () => {
		for (const axis of ['x', 'y', 'z'] as const) {
			for (const flip of [false, true]) {
				expect(keepsAll([{ axis, offset: parkedOffset(MODEL, axis, flip), flip }])).toBe(true);
				expect(keepsAll([{ axis, offset: 0, flip }])).toBe(false);
			}
		}
	});

	it('remove nothing before they slide in, and cut once they have', () => {
		const resolved = resolve(STORY, MODEL);
		const section = at('section');
		const start = evaluate(resolved, section, DESKTOP).cuts;
		expect(start).toEqual([
			{ axis: 'x', offset: parkedOffset(MODEL, 'x', true), flip: true },
			{ axis: 'z', offset: parkedOffset(MODEL, 'z', false), flip: false }
		]);
		expect(keepsAll(start)).toBe(true);
		const placed = evaluate(resolved, section + 0.6, DESKTOP).cuts;
		expect(placed.map((cut) => cut.offset)).toEqual([expect.closeTo(0, 9), expect.closeTo(110, 9)]);
		expect(keepsAll(placed)).toBe(false);
		// The beat parks them again by its end, so the next can drop them without a jump.
		expect(keepsAll(evaluate(resolved, section + 0.97, DESKTOP).cuts)).toBe(true);
	});
});

describe('stepped mode', () => {
	const resolved = resolve(STORY, MODEL);
	const same = (a: State, b: State) => {
		expect(a.camera).toEqual(b.camera);
		expect({ ...a, camera: null }).toEqual({ ...b, camera: null });
	};

	it('shows the last hold passed, all at once', () => {
		const measure = at('measure');
		same(evaluateStepped(resolved, measure + 0.6, DESKTOP), evaluate(resolved, measure + 0.5, DESKTOP));
		same(evaluateStepped(resolved, measure + 0.99, DESKTOP), evaluate(resolved, measure + 0.5, DESKTOP));
		expect(evaluateStepped(resolved, measure + 0.6, DESKTOP)).toMatchObject({ beat: measure, local: 0.5 });
	});

	it("shows the previous beat's last hold before a beat's first", () => {
		const measure = at('measure');
		same(evaluateStepped(resolved, measure + 0.2, PHONE), evaluate(resolved, measure - 1 + 0.75, PHONE));
	});

	it('shows the first hold before any has passed', () => {
		same(evaluateStepped(resolved, 0.1, DESKTOP), evaluate(resolved, 0.3, DESKTOP));
	});
});

describe('hysteresis', () => {
	// The key lies at 0.5 in a beat two viewports tall, so the margin is HYSTERESIS / 2 of the beat.
	const resolved = resolve(alone([{ t: 0.5, measure: true, hidden: ['Jaw'], highlight: 'Base' }], 2), MODEL);
	const margin = HYSTERESIS / 2;
	const walk = (from: number, ...taus: number[]) =>
		taus.reduce((state, tau) => evaluate(resolved, tau, DESKTOP, state), evaluate(resolved, from, DESKTOP));

	it('switches exactly at the key without a previous state', () => {
		expect(evaluate(resolved, 1.5, DESKTOP).measure).toBe(true);
		expect(evaluate(resolved, 1.5 - 1e-9, DESKTOP).measure).toBe(false);
	});

	it('switches hidden and Measure on only once the playhead is the margin past the key', () => {
		expect(walk(1.4, 1.5 + margin / 2)).toMatchObject({ measure: false, hidden: [] });
		expect(walk(1.4, 1.5 + margin / 2, 1.5 + margin * 1.5)).toMatchObject({ measure: true, hidden: ['c3'] });
	});

	it('switches them back only once the playhead is the margin before the key on the way up', () => {
		expect(walk(1.6, 1.5 - margin / 2)).toMatchObject({ measure: true, hidden: ['c3'] });
		expect(walk(1.6, 1.5 - margin / 2, 1.5 - margin * 1.5)).toMatchObject({ measure: false, hidden: [] });
	});

	it('does not toggle while the playhead jitters about the key', () => {
		const jitter = [1.5 + margin * 0.8, 1.5 - margin * 0.8, 1.5 + margin * 0.8, 1.5 - margin * 0.8];
		expect(walk(1.4, ...jitter).measure).toBe(false);
		expect(walk(1.6, ...jitter).measure).toBe(true);
	});

	it('leaves the highlight to switch at its key', () => {
		expect(walk(1.4, 1.5 + margin / 2).highlight).toBe('a1');
	});
});

describe('the storyboard check', () => {
	it('passes a storyboard that keeps every rule, on desktop and phone', () => {
		expect(check(resolve(STORY, MODEL), VIEWPORTS, MODEL, MEASURED)).toEqual([]);
	});

	it('catches a beat that starts away from where the previous one ended', () => {
		const keys: Key[] = [{ t: 0, az: 270, el: 15 }, { t: 0.15, measure: true }, { t: 0.9, measure: false }];
		expect(rules(variant('measure', keys))).toEqual(['join']);
		// A switch right at the join counts too: the beat should begin where the last one left off.
		const parts = STORY[at('parts')].keys;
		expect(rules(variant('parts', [{ t: 0, highlight: 'Upper_arm' }, ...parts.slice(1)]))).toEqual(['join']);
	});

	it('catches cuts that change in number within a beat', () => {
		const third: CutSpec = { axis: 'y', offset: 0, flip: false, in: 0 };
		const keys: Key[] = [
			{ t: 0, cuts: [X, Z] },
			{ t: 0.3, cuts: [{ ...X, in: 1 }, Z] },
			{ t: 0.6, cuts: [{ ...X, in: 1 }, { ...Z, in: 1 }] },
			{ t: 0.7, cuts: [{ ...X, in: 1 }, { ...Z, in: 1 }, third] },
			{ t: 0.95, cuts: [X, Z] }
		];
		expect(rules(variant('section', keys))).toEqual(['cuts']);
	});

	it('catches Measure on while explode is above 0', () => {
		const keys: Key[] = [
			{ t: 0.1, explode: 0 },
			{ t: 0.4, explode: 1, measure: true },
			{ t: 0.6, explode: 1, measure: false },
			{ t: 0.9, explode: 0 }
		];
		expect(rules(variant('explode', keys))).toEqual(['measure-explode']);
	});

	it('catches Measure held on by the hysteresis as explode begins', () => {
		const story = alone([{ t: 0.2, measure: true }, { t: 0.5, measure: false }, { t: 0.8, explode: 1 }], 2);
		const resolved = resolve(story, MODEL);
		// Switched exactly at its key, Measure would be off before explode moves.
		for (let tau = 1; tau <= 2; tau += 0.001) {
			const state = evaluate(resolved, tau, DESKTOP);
			expect(state.measure && state.explode > 0).toBe(false);
		}
		expect(rules(story)).toEqual(['measure-explode']);
	});

	it('catches a measured point behind the camera', () => {
		const keys: Key[] = [
			{ t: 0.1, az: 270, el: 15 },
			{ t: 0.15, measure: true },
			{ t: 0.4, target: { point: 'jawTip' }, el: -60, size: { fit: 'Jaw', k: 0.1 } },
			{ t: 0.6, target: '*', el: 15, size: { fit: '*', k: 1.05 } },
			{ t: 0.9, measure: false }
		];
		// Behind the camera is out of the frame too.
		expect(rules(variant('measure', keys))).toEqual(['measure-framed', 'measure-behind']);
	});

	it('catches keys out of order', () => {
		const parts = STORY[at('parts')].keys;
		expect(rules(variant('parts', [parts[1], parts[0], parts[2], parts[3]]))).toContain('keys');
	});
});

describe('the holds', () => {
	const parts = STORY[at('parts')].keys;
	/** The section beat with its two cuts replaced, sliding in and out as the storyboard's do. */
	const cutting = (x: CutSpec, z: CutSpec, also: Key = { t: 0.15 }) =>
		variant('section', [
			{ t: 0, cuts: [x, z] },
			also,
			{ t: 0.3, cuts: [{ ...x, in: 1 }, z] },
			{ t: 0.6, cuts: [{ ...x, in: 1 }, { ...z, in: 1 }] },
			{ t: 0.95, cuts: [x, z] }
		]);

	it('pass the storyboard as it stands', () => {
		expect(rules(STORY)).toEqual([]);
		expect(rules(cutting(X, Z))).toEqual([]);
	});

	it('catch a cut whose face turns from the camera', () => {
		expect(rules(cutting({ ...X, flip: false }, Z))).toEqual(['cut-faces']);
	});

	it('catch a cut that takes away next to nothing', () => {
		expect(rules(cutting({ ...X, offset: -38 }, Z))).toEqual(['cut-removes']);
	});

	it('catch a cut that misses what the shot frames', () => {
		const jaw: Key = { t: 0.15, target: { centre: 'Jaw' }, size: { fit: 'Jaw' } };
		const placed = { ...X, in: 1 };
		const keys: Key[] = [{ t: 0, cuts: [X] }, jaw, { t: 0.3, cuts: [placed] }, { t: 0.6, cuts: [placed] }, { t: 0.95, cuts: [X] }];
		expect(rules(variant('section', keys))).toEqual(['cut-framed']);
	});

	it('catch a shot whose target is cut away', () => {
		expect(rules(cutting(X, Z, { t: 0.15, target: [0, 0, 150] }))).toEqual(['subject-kept']);
	});

	it('catch a part switched off that stands in front of nothing the shot is about', () => {
		const keys = [parts[0], { t: 0.3, hidden: ['Jaw'], highlight: null }, ...parts.slice(2)];
		expect(rules(variant('parts', keys))).toEqual(['hide-reveals']);
	});

	it('catch a part kept alone that was not the subject of the hold before', () => {
		// The camera stays on the whole arm until the jaw is kept alone, then turns to it.
		const jaw: Key = { ...parts[2], isolated: ['Jaw'], target: { centre: 'Jaw' }, size: { fit: 'Jaw', k: 1.2 } };
		expect(rules(variant('parts', [...parts.slice(0, 2), { t: 0.55 }, jaw, parts[3]]))).toEqual(['isolate-subject']);
	});

	it('pass a part kept alone that was the subject of the hold before', () => {
		const keys = [...parts.slice(0, 2), { t: 0.55 }, { ...parts[2], target: { centre: 'Servo' } }, parts[3]];
		expect(rules(variant('parts', keys))).toEqual([]);
	});

	it('catch a tinted part that is switched off', () => {
		const keys = [parts[0], { t: 0.3, hidden: ['Upper_arm'] }, { ...parts[2], highlight: null }, parts[3]];
		expect(rules(variant('parts', keys))).toEqual(['highlight-shown']);
	});

	it('catch two holds of a beat that show the same picture', () => {
		const story = STORY.map((beat) => (beat.id === 'measure' ? { ...beat, holds: [0.4, 0.6] } : beat));
		expect(rules(story)).toEqual(['hold-differs']);
	});

	it('catch a measured point outside the frame', () => {
		const keys: Key[] = [
			{ t: 0.1, az: 270, el: 15 },
			{ t: 0.15, measure: true },
			{ t: 0.3, target: { point: 'jawTip' }, size: { fit: 'Jaw', k: 1 } },
			{ t: 0.85, target: '*', size: { fit: '*', k: 1.05 } },
			{ t: 0.9, measure: false }
		];
		expect(rules(variant('measure', keys))).toEqual(['measure-framed']);
	});

	it('catch a part kept alone that hardly spreads when taken apart', () => {
		const keys: Key[] = [
			{ t: 0.1, explode: 0, isolated: ['Servo'] },
			{ t: 0.4, explode: 1 },
			{ t: 0.6, explode: 1 },
			{ t: 0.9, explode: 0 },
			{ t: 0.95, isolated: [] }
		];
		const story = variant('explode', keys);
		expect(rules(story)).toEqual([]);
		const servo = MODEL.parts.get('Servo')!;
		const stiff: Model = { ...MODEL, parts: new Map([...MODEL.parts, ['Servo', { ...servo, explodedSphere: servo.sphere }]]) };
		expect(check(resolve(story, stiff), VIEWPORTS, stiff, MEASURED).map((v) => v.rule)).toEqual(['explode-spreads']);
	});

	it('catch a camera inside a body', () => {
		const keys: Key[] = [
			{ t: 0, size: { fit: '*', k: 1.05 } },
			{ t: 0.2, target: [0, 0, 100], size: { fit: 'Jaw', k: 0.1 } },
			{ t: 1, az: 10, target: '*', size: { fit: '*', k: 1.05 } }
		];
		expect(rules(variant('iso', keys))).toEqual(['camera-clear']);
	});
});
