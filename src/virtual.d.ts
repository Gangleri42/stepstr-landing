// stepstr's own virtual modules: the pages serve neither, but the types of stepstr modules they import reach them
// (state/route.ts takes the site's role from virtual:stepstr-site).
/// <reference path="../stepstr/src/virtual.d.ts" />

// What vite.config.ts hands each page: the settled choices of subjects/<id>/model.json, plus what
// tools/model.ts made of that subject's file.
declare module 'virtual:landing-model/*' {
	import type { MeasureData } from '$lib/measure/format';
	import type { UpAxis } from '$lib/state/hash';

	type Vec3 = [number, number, number];
	type Pin = { url: string; sha256: string; size: number };

	export const model: {
		/** Whose model it is, as the GLB's copyright and the page's credit name it. */
		copyright: string;
		/** The compressed GLB, relative to the page. */
		glb: { path: string; sha256: string; size: number };
		/** Measure's data, trimmed to the solids the measured items use. */
		data: MeasureData;
		step: Pin;
		facts: { parts: number; solids: number; triangles: number; unit: string; warnings: string[] };
		source: Pin & { repository: string; commit: string; path: string; licence: string; licenceFile?: Pin & { path: string } };
		up: UpAxis;
		/** The two measured items, as route tokens. */
		measure: string[];
		/** Short keys for the exact display names the storyboard uses. */
		names: Record<string, string | { name: string; in: string }>;
		/** Named points in the file's frame, mm. */
		points: Record<string, Vec3>;
		[key: string]: unknown;
	};
	/** Where the web viewer lives; the hand-off's link points there. */
	export const webOrigin: string;
}
