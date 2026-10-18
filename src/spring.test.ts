import { describe, expect, it } from 'vitest';
import { MAX_DT, settled, step, type SpringState } from './spring.ts';

const OMEGA = 10;

/** Steps the spring at 60 frames a second toward a target that may move, and returns every state. */
function run(start: SpringState, target: (time: number) => number, seconds: number) {
	const dt = 1 / 60;
	const states: SpringState[] = [];
	let state = start;
	for (let frame = 1; frame * dt <= seconds + 1e-9; frame++) {
		state = step(state, target(frame * dt), OMEGA, dt);
		states.push(state);
	}
	return states;
}

describe('the playhead spring', () => {
	it('closes on its target from rest without passing it', () => {
		const xs = run({ x: 0, v: 0 }, () => 1, 2).map((s) => s.x);
		for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
		expect(Math.max(...xs)).toBeLessThanOrEqual(1);
	});

	it('does not overshoot when the scroll it follows stops', () => {
		const states = run({ x: 0, v: 0 }, (time) => 900 * Math.min(time, 0.5), 3);
		expect(Math.max(...states.map((s) => s.x))).toBeLessThanOrEqual(450);
	});

	it('comes to rest on its target', () => {
		const states = run({ x: 0, v: 0 }, () => 1000, 2.5);
		const from = states.findIndex((s) => settled(s, 1000, 0.5));
		expect(from).toBeGreaterThan(0);
		expect((from + 1) / 60).toBeLessThan(2);
		expect(states.slice(from).every((s) => settled(s, 1000, 0.5))).toBe(true);
		expect(settled(states[0], 1000, 0.5)).toBe(false);
	});

	it('lands where a run of shorter frames would', () => {
		const once = step({ x: 0, v: 0 }, 1, OMEGA, 0.05);
		const twice = step(step({ x: 0, v: 0 }, 1, OMEGA, 0.02), 1, OMEGA, 0.03);
		expect(twice.x).toBeCloseTo(once.x, 12);
		expect(twice.v).toBeCloseTo(once.v, 12);
	});

	it('moves no further in a long frame than in 64 ms', () => {
		const start = { x: 0, v: 0 };
		expect(step(start, 1, OMEGA, 5)).toEqual(step(start, 1, OMEGA, MAX_DT));
		expect(step(start, 1, OMEGA, 5).x).toBeLessThan(0.15);
		expect(MAX_DT).toBe(0.064);
	});
});
