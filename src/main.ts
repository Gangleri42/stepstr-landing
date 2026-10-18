// The page's first script: it decides how the model can be shown on this device, then brings in the stage (three.js,
// the viewer) and the page's subject (its model and storyboard) after the text has painted. Without WebGL, with
// Save-Data, or when anything on the way fails, the page shows still pictures at the same places instead.
import { jitOff } from '$lib/convert/jit';
import type { Subject } from './stage';

/** Each page's model and storyboard, in a chunk of its own: a page loads the one its <html data-subject> names. */
const subjects = import.meta.glob<Subject>('../subjects/*/subject.ts', { import: 'subject' });

export type Mode = {
	/** Holds apply at once, without travel: reduced motion, a slow device, no JIT. */
	stepped: boolean;
	/** The lowest render settings from the start. */
	low: boolean;
	/** ?debug: a frame-time readout. */
	debug: boolean;
};

const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const stage = document.querySelector<HTMLElement>('.stage')!;
const canvas = stage.querySelector('canvas')!;
const poster = stage.querySelector<HTMLElement>('.poster')!;

export function stillMode(reason: string) {
	root.classList.add('still-mode');
	root.dataset.still = reason;
}

// A still that is not there (a development server before `npm run stills`) leaves no broken picture behind.
for (const img of document.querySelectorAll<HTMLImageElement>('.poster img, .still img, .index img')) {
	const hide = () => img.closest<HTMLElement>('.index li, .still, .poster')?.classList.add('gone');
	if (img.complete && !img.naturalWidth && img.src) hide();
	else img.addEventListener('error', hide, { once: true });
}

// Entrances: each card, the napplet's tiles, the index and the footer tiles rise once as they come into view.
if (!reduced.matches) {
	root.classList.add('motion');
	const seen = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add('in');
				seen.unobserve(entry.target);
			}
		},
		{ threshold: 0.2 }
	);
	const arriving = '.card, .napplet .shot, .napplet .facts, .views, .index, .tiles';
	for (const el of document.querySelectorAll(arriving)) seen.observe(el);
}

function webgl() {
	try {
		return !!document.createElement('canvas').getContext('webgl2');
	} catch {
		return false;
	}
}

const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

const query = new URLSearchParams(location.search);

// ?still shows the page as a browser without WebGL sees it.
if (query.has('still') || !webgl()) stillMode('webgl');
// The model's geometry is meshopt-compressed and decoded in WebAssembly, which some locked-down browsers turn off.
else if (typeof WebAssembly !== 'object') stillMode('wasm');
else if (saveData || matchMedia('(prefers-reduced-data: reduce)').matches) stillMode('save-data');
else {
	// After the first paint, so measuring the JIT never holds the text back.
	requestAnimationFrame(() =>
		setTimeout(async () => {
			const interpreted = jitOff() === true;
			const mode: Mode = { stepped: reduced.matches || interpreted, low: interpreted, debug: query.has('debug') };
			if (interpreted) await idle();
			try {
				const load = subjects[`../subjects/${root.dataset.subject}/subject.ts`];
				if (!load) throw new Error(`No subject ${root.dataset.subject ?? ''}`);
				const [{ start }, subject] = await Promise.all([import('./stage'), load()]);
				await start({ stage, canvas, poster, mode, reduced, subject, onFail: stillMode });
			} catch (err) {
				console.error('stage', err);
				stillMode('failed');
			}
		}, 0)
	);
}

/** Resolves when the browser has a moment, or after two seconds. */
function idle() {
	return new Promise<void>((resolve) => {
		if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout: 2000 });
		else setTimeout(resolve, 200);
	});
}
