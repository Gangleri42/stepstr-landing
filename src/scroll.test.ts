import { describe, expect, it } from 'vitest';
import { isJump, tauAt } from './scroll.ts';

describe('the playhead from the scroll position', () => {
	const sections = [
		{ top: 100, height: 200 },
		{ top: 300, height: 400 },
		{ top: 800, height: 100 }
	];

	it('counts sections passed and the share of the one under the middle of the viewport', () => {
		expect(tauAt(0, sections)).toBe(0);
		expect(tauAt(100, sections)).toBe(0);
		expect(tauAt(200, sections)).toBe(0.5);
		expect(tauAt(300, sections)).toBe(1);
		expect(tauAt(600, sections)).toBe(1.75);
		expect(tauAt(850, sections)).toBe(2.5);
	});

	it('holds at the next start between sections and at the last end after them', () => {
		expect(tauAt(750, sections)).toBe(2);
		expect(tauAt(900, sections)).toBe(3);
		expect(tauAt(5000, sections)).toBe(3);
	});

	it('passes over a section with no height', () => {
		expect(tauAt(300, [{ top: 100, height: 200 }, { top: 300, height: 0 }, { top: 300, height: 100 }])).toBe(2);
	});

	it('snaps moves of more than two viewports', () => {
		expect(isJump(0, 1800, 900)).toBe(false);
		expect(isJump(0, 1801, 900)).toBe(true);
		expect(isJump(5000, 3000, 900)).toBe(true);
	});
});
