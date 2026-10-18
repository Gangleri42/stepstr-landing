// The app's part tree, mounted as a puppet: the storyboard sets what it shows, the visitor only watches. Its props are
// getters over raw state, so the parts' three.js objects are never wrapped in proxies.
import { mount } from 'svelte';
import PartTree from '$lib/ui/PartTree.svelte';
import type { Part } from '$lib/viewer/parts';

let roots = $state.raw<Part[]>([]);
let hidden = $state.raw(new Set<string>());
let isolated = $state.raw(new Set<string>());
let selected = $state.raw<string | null>(null);

const same = (a: Set<string>, b: string[]) => a.size === b.length && b.every((id) => a.has(id));

export const tree = {
	setRoots(parts: Part[]) {
		roots = parts;
	},
	/** Only what changed is set, so the tree redraws, and scrolls to its selection, only when the picture moves on. */
	show(next: { hidden: string[]; isolated: string[]; selected: string | null }) {
		if (!same(hidden, next.hidden)) hidden = new Set(next.hidden);
		if (!same(isolated, next.isolated)) isolated = new Set(next.isolated);
		if (selected !== next.selected) selected = next.selected;
	}
};

/** Replaces the static list in the slot with the live tree. Clicks do nothing: the slot is inert. */
export function mountTree(slot: HTMLElement) {
	slot.replaceChildren();
	slot.inert = true;
	const noop = () => {};
	return mount(PartTree, {
		target: slot,
		props: {
			get roots() {
				return roots;
			},
			get hidden() {
				return hidden;
			},
			get isolated() {
				return isolated;
			},
			get selected() {
				return selected;
			},
			onToggle: noop,
			onSelect: noop,
			onIsolate: noop
		}
	});
}
