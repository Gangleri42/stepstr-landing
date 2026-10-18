// From the scroll position to the playhead. The playhead is the middle of the viewport (scrollY + innerHeight / 2), so
// a beat's view arrives as its section reaches mid-screen, whatever the screen's height.

/** A beat's section on the page, in CSS pixels from the top of the document. */
export type Span = { top: number; height: number };

/**
 * The playhead's position in the storyboard, tau: the index of the section under `mid` plus the share of it passed.
 * Before the first section it is 0, between two sections the start of the next, after the last that section's end.
 */
export function tauAt(mid: number, sections: Span[]) {
	let tau = 0;
	for (const [index, { top, height }] of sections.entries()) {
		if (mid < top) break;
		tau = mid < top + height ? index + (mid - top) / height : index + 1;
	}
	return tau;
}

/** Whether going from one scroll position to another is a jump (a link, Home, End): it snaps instead of springing. */
export const isJump = (from: number, to: number, viewportHeight: number) => Math.abs(to - from) > 2 * viewportHeight;
