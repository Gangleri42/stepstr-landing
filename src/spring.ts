// The playhead's spring. Critically damped, it closes on its target as fast as a spring can without passing it from
// rest. It is solved in closed form, so a long frame lands where a run of short ones would and never makes it ring.

/** Position, in whatever unit the playhead uses, and velocity in that unit per second. */
export type SpringState = { x: number; v: number };

/** A longer frame (a background tab, a stall) moves the spring no further than this many seconds would. */
export const MAX_DT = 0.064;

/** The state `dt` seconds on, pulled toward `target` at `omega` radians per second. */
export function step(state: SpringState, target: number, omega: number, dt: number): SpringState {
	const t = Math.min(Math.max(dt, 0), MAX_DT);
	const offset = state.x - target;
	const drift = state.v + omega * offset;
	const decay = Math.exp(-omega * t);
	return { x: target + (offset + drift * t) * decay, v: (state.v - omega * drift * t) * decay };
}

/** Whether the spring has come to rest on its target: its distance and its speed both below epsilon. */
export const settled = (state: SpringState, target: number, epsilon: number) =>
	Math.abs(state.x - target) < epsilon && Math.abs(state.v) < epsilon;
