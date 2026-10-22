// The stage: stepstr's own viewer drawing the page's model behind the copy. It loads the model, resolves the
// storyboard's part names, and on every scroll moves the viewer to the state the timeline gives for that position. The
// viewer renders on demand, so this module only sets what changed and lets the viewer's loop draw it. Which model and
// storyboard is the page's subject's (subjects/<id>/subject.ts), handed in by main.ts.
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { MeasureData } from '$lib/measure/format';
import { defaultState, encode, parseRef, type Camera, type Cut, type MeasureRef, type UpAxis, type ViewState } from '$lib/state/hash';
import { MeasureTool } from '$lib/viewer/measure/tool';
import { upVector } from '$lib/viewer/orientation';
import { applyVisibility, type PartIndex } from '$lib/viewer/parts';
import { defaultRenderOptions, Viewer } from '$lib/viewer/scene';
import { direction, pose, type Rect, type Vec3, type Viewport } from './camera';
import type { Mode } from './main';
import { isJump, tauAt } from './scroll';
import { settled, step } from './spring';
import { evaluate, evaluateStepped, resolve, type Beat, type State } from './timeline';
import { describeModel } from './model';
import { mountTree, tree } from './tree.svelte';

/** A page's model and storyboard, as its subject's glue module hands them over. */
export type Subject = {
	model: {
		glb: { path: string; sha256: string };
		data: MeasureData;
		source: { url: string; sha256: string };
		up: UpAxis;
		/** The two measured items, as route tokens. */
		measure: string[];
		points: Record<string, Vec3>;
	};
	/** Where the web viewer lives; the hand-off's link points there. */
	webOrigin: string;
	storyboard: Beat[];
	/** From where in the hand-off beat (the one holding a[data-open]) the visitor turns the model. */
	handoffAt: number;
};

type Start = {
	stage: HTMLElement;
	canvas: HTMLCanvasElement;
	poster: HTMLElement;
	mode: Mode;
	reduced: MediaQueryList;
	subject: Subject;
	onFail(reason: string): void;
};

/** The playhead's spring, per second. */
const OMEGA = 10;
const FOV = 30;
/** Above this median frame interval the render settings drop a step; above the second, holds apply without travel. */
const SLOW_MS = 34;
const STEPPED_MS = 50;

const touch = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
const narrow = matchMedia('(max-width: 900px)');

export async function start({ stage, canvas, poster, mode, reduced, subject, onFail }: Start) {
	const { model } = subject;
	const options = defaultRenderOptions();
	if (touch) options.maxPixelRatio = 1.5;
	if (mode.low) Object.assign(options, { antialias: false, maxPixelRatio: 1, shadowSize: 1024, shadowType: 'basic' });
	const viewer = new Viewer(canvas, options);
	viewer.pickable = false;
	viewer.loader.setMeshoptDecoder(MeshoptDecoder);
	viewer.controls.enabled = false;
	viewer.setUp(model.up, false);
	viewer.controls.enabled = false;
	// The controls claim every touch on the canvas; the page must keep scrolling and zooming over it.
	canvas.style.touchAction = 'pan-y pinch-zoom';
	viewer.onContextLost = () => onFail('context');
	paint(viewer);

	const response = await fetch(model.glb.path);
	if (!response.ok) throw new Error(`The model did not load: ${response.status}`);
	const parts = await viewer.loadBuffer(await response.arrayBuffer());
	if (!parts) throw new Error('The model did not load.');
	document.documentElement.dataset.glb = model.glb.sha256;
	if (mode.low) viewer.setEdges(false);

	const resolved = resolve(subject.storyboard, describeModel(viewer.model!, parts, (factor) => viewer.setExplode(factor), model.up, model.points));
	if (resolved.missing.length) console.warn('storyboard: unresolved names', resolved.missing);

	const tool = new MeasureTool(viewer, { change() {}, outcome() {} });
	viewer.setTool(tool);
	stage.querySelector('.measure-layer')?.setAttribute('data-ui', 'measure');
	// The page's model is the scene's only file.
	tool.setModel([model.data]);
	tool.setSelection(model.measure.map(parseRef).filter((ref): ref is MeasureRef => !!ref && tool.valid(ref)));

	const slot = document.querySelector<HTMLElement>('[data-ui=parts]');
	if (slot) {
		tree.setRoots(parts.roots);
		mountTree(slot);
	}

	warmUp(viewer, tool, parts);

	const query = new URLSearchParams(location.search);
	const shot = query.get('shot');
	if (shot && shot !== 'og') return still(viewer, tool, parts, resolved, query, stage, subject);
	// The link preview is the first screen itself, headline and model, without the bar.
	if (shot === 'og') document.documentElement.classList.add('og');

	const director = new Director({ viewer, tool, parts, resolved, stage, canvas, mode, reduced, subject });
	director.measure();
	director.kick(true);
	// For the browser tests and for looking at a device: what is drawn, read-only. `story` is the timeline's shape,
	// which the browser tests cannot import (a storyboard's types reach the app's modules).
	const story = () => ({
		handoff: { beat: director.handoffBeat, at: subject.handoffAt },
		beats: resolved.beats.map(({ id, len, holds }) => ({ id, len, holds }))
	});
	const landing = { camera: () => viewer.getCamera(), painted: () => painted(viewer), stepped: () => director.stepped, story };
	Object.assign(window, { landing });
	if (import.meta.env.DEV) Object.assign(window, { dev: { viewer, parts, tool, resolved, applyVisibility } });
	requestAnimationFrame(() => {
		stage.classList.add('live');
		poster.classList.add('gone');
		if (shot === 'og') setTimeout(() => (document.documentElement.dataset.shot = 'ready'), 1500);
	});
	if (mode.debug) director.debug();
}

/** The page's colours, read from its tokens, so the model sits on the page's own paper in either scheme. */
function paint(viewer: Viewer) {
	const css = getComputedStyle(document.documentElement);
	const token = (name: string) => css.getPropertyValue(name).trim();
	viewer.setPalette({ background: token('--paper'), edges: token('--edges'), accent: token('--accent'), ground: token('--ground'), measure: token('--measure') });
}

/** The stage as the canvas shows it now, 160 pixels wide. */
function sample(viewer: Viewer) {
	viewer.renderer.render(viewer.scene, viewer.camera);
	const source = viewer.renderer.domElement;
	const width = 160;
	const height = Math.max(1, Math.round((width * source.height) / Math.max(1, source.width)));
	const copy = Object.assign(document.createElement('canvas'), { width, height });
	const context = copy.getContext('2d', { willReadFrequently: true });
	if (!context) return null;
	context.drawImage(source, 0, 0, width, height);
	return context.getImageData(0, 0, width, height);
}

/** The stage's pixels as red, green and blue, for a browser test to compare two stills by. */
function pixels(viewer: Viewer) {
	const image = sample(viewer);
	return image ? Array.from(image.data.filter((_, i) => i % 4 !== 3)) : [];
}

/** The share of the stage's pixels that are not the page's paper: something was drawn. */
function painted(viewer: Viewer) {
	const image = sample(viewer);
	if (!image) return 0;
	const { width, height } = image;
	const pixels = image.data;
	// The background is cleared to the paper's own sRGB value, untouched by tone mapping.
	const paper = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()).getHex();
	const [r, g, b] = [(paper >> 16) & 255, (paper >> 8) & 255, paper & 255];
	let off = 0;
	for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - r) + Math.abs(pixels[i + 1] - g) + Math.abs(pixels[i + 2] - b) > 24) off++;
	return off / (width * height);
}

/**
 * Renders once with each number of cuts the story uses, with Measure on and with a part tinted, before the first frame
 * is shown: each is a shader variant, and compiling one mid-scroll would stall the page.
 */
function warmUp(viewer: Viewer, tool: MeasureTool, parts: PartIndex) {
	const { max } = viewer.bounds;
	const outside = (axis: 'x' | 'y' | 'z'): Cut => ({ axis, offset: max[axis] + viewer.radius, flip: false });
	const render = () => viewer.renderer.render(viewer.scene, viewer.camera);
	for (const cuts of [[outside('x')], [outside('x'), outside('y')], [outside('x'), outside('y'), outside('z')], []]) {
		viewer.setCuts(cuts);
		render();
	}
	const first = parts.roots[0];
	if (first) {
		viewer.highlight(first);
		render();
		viewer.highlight(null);
	}
	tool.setActive(true);
	render();
	tool.setActive(false);
}

/** A still: a beat's hold (the last one unless `hold` counts another), with that hold's own scene or the one before. */
type Still = { beat: string; hold?: number; scene?: 'prev' };

/**
 * ?shot=<beat>: the beat's last hold, framed in the whole stage with the copy hidden, for tools/stills.ts to
 * photograph. &hold=<n> takes the beat's nth hold instead, counted from 0, and &scene=prev keeps that hold's camera
 * but shows the cuts, parts, tint and Measure of the hold before it, so the review sheet can set what a hold changed
 * beside it; window.landing.shoot() takes another still in the same page. ?shot=og (handled in start) is the first
 * screen as it is, for the link preview.
 */
function still(
	viewer: Viewer,
	tool: MeasureTool,
	parts: PartIndex,
	resolved: ReturnType<typeof resolve>,
	query: URLSearchParams,
	stage: HTMLElement,
	subject: Subject
) {
	const root = document.documentElement;
	root.classList.add('shot');
	const { width, height } = stage.getBoundingClientRect();
	const viewport: Viewport = { width, height, fov: FOV, free: { x0: 0, y0: 0, x1: width, y1: height } };
	// A hair past the hold: index + hold can land a rounding error short of it, which is the hold before.
	const at = (index: number, t: number) => evaluateStepped(resolved, index + t + 1e-6, viewport);
	const every = resolved.beats.flatMap((beat, index) => beat.holds.map((t) => ({ index, t })));
	const name = (id: string) => parts.byId.get(id)?.name ?? id;

	const shoot = ({ beat, hold, scene }: Still) => {
		const index = resolved.beats.findIndex((b) => b.id === beat);
		if (index < 0) throw new Error(`No beat ${beat}`);
		const { holds } = resolved.beats[index];
		const t = holds[hold ?? holds.length - 1] ?? 0.5;
		const state = at(index, t);
		const k = every.findIndex((h) => h.index === index && h.t === t);
		const empty = { ...state, cuts: [], hidden: [], isolated: [], highlight: null, measure: false };
		const before = k > 0 ? at(every[k - 1].index, every[k - 1].t) : empty;
		const shown = scene === 'prev' ? before : state;
		viewer.setCamera(state.camera);
		viewer.setExplode(state.explode);
		viewer.setCuts(shown.cuts);
		applyVisibility(parts, new Set(shown.hidden), new Set(shown.isolated));
		viewer.highlight(shown.highlight ? (parts.byId.get(shown.highlight) ?? null) : null);
		tool.setActive(shown.measure);
		viewer.requestRender();
		// The view's address, for the index of views at the end of the page: the same picture, opened in the app.
		root.dataset.route = route(subject, { ...defaultState(), ...pick(subject, state) });
		// What the hold changed since the one before, in words, for the review sheet's captions.
		const added = (now: string[], was: string[]) => now.filter((id) => !was.includes(id)).map(name);
		// A parked cut waits outside the model and takes nothing away.
		const { min, max } = viewer.bounds;
		const cuts = (cut: Cut | undefined) => !!cut && cut.offset > min[cut.axis] && cut.offset < max[cut.axis];
		const moved = state.cuts.filter((cut, i) => cuts(cut) && !sameCuts([cut], before.cuts.slice(i, i + 1)));
		const gone = before.cuts.filter((cut, i) => cuts(cut) && !cuts(state.cuts[i]));
		const change = [
			...moved.map((cut) => `cut ${cut.axis} ${cut.offset.toFixed(1)}`),
			...gone.map((cut) => `cut ${cut.axis} out`),
			...added(state.hidden, before.hidden).map((part) => `${part} off`),
			...added(before.hidden, state.hidden).map((part) => `${part} on`),
			...added(state.isolated, before.isolated).map((part) => `${part} alone`),
			...(before.isolated.length && !state.isolated.length ? ['all shown'] : []),
			...(state.explode !== before.explode ? [`explode ${state.explode.toFixed(2)}`] : []),
			...(state.measure !== before.measure ? [`Measure ${state.measure ? 'on' : 'off'}`] : [])
		];
		return new Promise<string>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(change.join(', ') || 'camera'))));
	};

	const beat = query.get('shot')!;
	const hold = query.has('hold') ? Number(query.get('hold')) : undefined;
	const scene = query.get('scene') === 'prev' ? 'prev' : undefined;
	// For the stills script and the browser tests: the beats and their holds, another still, the pixels on the canvas.
	const beats = () => resolved.beats.map(({ id, holds }) => ({ id, holds }));
	Object.assign(window, { landing: { beats, shoot, pixels: () => pixels(viewer) } });
	stage.classList.add('live');
	void shoot({ beat, hold, scene }).then(() => (root.dataset.shot = 'ready'));
}

type DirectorParts = {
	viewer: Viewer;
	tool: MeasureTool;
	parts: PartIndex;
	resolved: ReturnType<typeof resolve>;
	stage: HTMLElement;
	canvas: HTMLCanvasElement;
	mode: Mode;
	reduced: MediaQueryList;
	subject: Subject;
};

/** Where a playhead falls: the beat, how far through it (1 past the last), and that beat's frame on screen, if any. */
type At = { index: number; local: number; frame: { k: number; rect: Rect } | null };

/**
 * Scroll to state. The playhead is the middle of the viewport, followed by a critically damped spring so the model
 * glides; the state is a pure function of the playhead, so scrolling back replays exactly.
 */
class Director {
	#v: DirectorParts;
	#beats: HTMLElement[];
	#sections: { top: number; height: number }[] = [];
	/** The free part of the stage for each beat: right of the copy on a desktop, above the card on a phone. */
	#free: Viewport['free'][] = [];
	#size = { width: 1, height: 1 };
	#width = innerWidth;
	#spring = { x: 0, v: 0 };
	#target = 0;
	#running = false;
	#last = 0;
	#previous: State | undefined;
	#applied: State | null = null;
	/** The camera last handed to the viewer, which a blend or the hand-off can make differ from the state's. */
	#camera: Camera | null = null;
	#stepped: boolean;
	#degraded = false;
	#frames: number[] = [];
	#visible = true;
	#handoff = false;
	#blend: { from: Camera; start: number } | null = null;
	#routeAt = 0;
	/** The route each <code> shows, so only what changed in it turns orange. */
	#printed = new WeakMap<HTMLElement, string>();
	/** The page's paper and the frame's tone, read once per colour scheme. */
	#colors: { paper: THREE.Color; tone: THREE.Color } | null = null;
	#debug: HTMLElement | null = null;
	/** The beat that hands the model over: the one holding the link that opens the view in the app. */
	#handoffIndex: number;
	/** The web viewer's host, which a printed route starts with. */
	#host: string;

	constructor(parts: DirectorParts) {
		this.#v = parts;
		this.#beats = [...document.querySelectorAll<HTMLElement>('.scrolly > .beat')];
		this.#handoffIndex = this.#beats.findIndex((beat) => beat.querySelector('a[data-open]'));
		this.#host = new URL(parts.subject.webOrigin).host;
		this.#stepped = parts.mode.stepped;
		parts.reduced.addEventListener('change', (e) => (this.#stepped = e.matches || parts.mode.stepped || this.#stepped));
		addEventListener('scroll', () => this.kick(), { passive: true });
		// A phone's address bar coming and going resizes the window mid-scroll; only a new width is a new layout to snap
		// to, the glide carries on otherwise.
		addEventListener('resize', () => {
			this.measure();
			const snap = innerWidth !== this.#width;
			this.#width = innerWidth;
			this.kick(snap);
		});
		narrow.addEventListener('change', () => this.measure());
		matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
			paint(parts.viewer);
			this.#colors = null;
			this.kick(true);
		});
		new IntersectionObserver(([entry]) => {
			this.#visible = entry.isIntersecting;
			if (this.#visible) this.kick();
		}).observe(document.querySelector('.scrolly')!);
		// The cards change height as the part tree mounts and fonts arrive; the free area follows them.
		const resize = new ResizeObserver(() => this.measure());
		for (const el of [document.body, ...document.querySelectorAll('.card')]) resize.observe(el);
	}

	get stepped() {
		return this.#stepped;
	}

	get handoffBeat() {
		return this.#beats[this.#handoffIndex]?.id ?? null;
	}

	/** Section offsets and the free area, read once per layout change. */
	measure() {
		this.#sections = this.#beats.map((beat) => {
			const rect = beat.getBoundingClientRect();
			return { top: rect.top + scrollY, height: rect.height };
		});
		const { width, height } = this.#v.canvas.getBoundingClientRect();
		this.#size = { width: Math.max(1, width), height: Math.max(1, height) };
		const bar = document.querySelector('.bar')?.getBoundingClientRect().height ?? 0;
		const svh = document.querySelector<HTMLElement>('.copy')?.clientHeight ?? height;
		this.#free = this.#beats.map((beat) => {
			if (narrow.matches) {
				const cards = [...beat.querySelectorAll<HTMLElement>('.card')];
				const card = Math.max(0, ...cards.map((c) => c.offsetHeight));
				return { x0: 0, y0: bar, x1: width, y1: Math.max(bar + 120, svh - card) };
			}
			const card = beat.querySelector<HTMLElement>('.card');
			const right = card ? card.getBoundingClientRect().right : width * 0.4;
			return { x0: Math.min(width * 0.6, right), y0: bar, x1: width, y1: height };
		});
	}

	/** Where tau falls. Past the last beat it stays in the last one, at its end, so the hand-off holds below the page. */
	#at(tau: number): At {
		const index = Math.min(this.#beats.length - 1, Math.max(0, Math.floor(tau)));
		const local = Math.min(1, tau - index);
		const slot = this.#beats[index]?.querySelector<HTMLElement>('[data-frame]');
		if (!slot) return { index, local, frame: null };
		// The napplet's frame: the stage clips into it as the beat begins and opens again as it ends.
		const { left, top, right, bottom } = slot.getBoundingClientRect();
		const k = THREE.MathUtils.smoothstep(local, 0.02, 0.3) * (1 - THREE.MathUtils.smoothstep(local, 0.82, 1));
		return { index, local, frame: { k, rect: { x0: left, y0: top, x1: right, y1: bottom } } };
	}

	/** The viewport at a playhead position: the free areas of neighbouring beats blend over the join, and a frame draws in. */
	#viewport({ index, local, frame }: At): Viewport {
		const a = this.#free[index];
		const b = this.#free[Math.min(this.#free.length - 1, index + 1)];
		let free = mix(a, b, THREE.MathUtils.smoothstep(local, 0.85, 1));
		if (frame) free = mix(free, frame.rect, frame.k);
		return { width: this.#size.width, height: this.#size.height, fov: FOV, free };
	}

	/** The stage clipped to the frame, on the tile's own tone, as far as the beat has gone into it. */
	#clip({ frame }: At) {
		const { viewer, stage } = this.#v;
		const k = frame?.k ?? 0;
		if (k <= 0.001) {
			if (stage.style.clipPath) {
				stage.style.clipPath = '';
				paint(viewer);
			}
			return;
		}
		const { x0, y0, x1, y1 } = frame!.rect;
		const { width, height } = this.#size;
		const px = (v: number) => `${(v * k).toFixed(1)}px`;
		stage.style.clipPath = `inset(${px(y0)} ${px(width - x1)} ${px(height - y1)} ${px(x0)} round ${px(10)})`;
		if (!this.#colors) {
			const css = getComputedStyle(document.documentElement);
			this.#colors = { paper: new THREE.Color(css.getPropertyValue('--paper').trim()), tone: new THREE.Color(css.getPropertyValue('--tone').trim()) };
		}
		(viewer.scene.background as THREE.Color).copy(this.#colors.paper).lerp(this.#colors.tone, k);
		viewer.requestRender();
	}

	kick(snap = false) {
		if (!this.#visible && !snap) return;
		this.#target = scrollY + innerHeight / 2;
		if (snap || this.#stepped || isJump(this.#spring.x, this.#target, innerHeight)) this.#spring = { x: this.#target, v: 0 };
		if (this.#running) return;
		this.#running = true;
		this.#last = performance.now();
		requestAnimationFrame((now) => this.#tick(now));
	}

	#tick(now: number) {
		const dt = Math.min(0.064, (now - this.#last) / 1000);
		this.#frames.push(now - this.#last);
		this.#last = now;
		this.#spring = this.#stepped ? { x: this.#target, v: 0 } : step(this.#spring, this.#target, OMEGA, dt);
		const tau = tauAt(this.#spring.x, this.#sections);
		const at = this.#at(tau);
		const viewport = this.#viewport(at);
		const state = this.#stepped ? evaluateStepped(this.#v.resolved, tau, viewport) : evaluate(this.#v.resolved, tau, viewport, this.#previous);
		this.#previous = state;
		this.#apply(state, at);
		this.#watchSpeed();
		if (this.#debug) {
			const mode = `${this.#stepped ? 'stepped' : 'spring'}${this.#degraded ? ' · low' : ''}`;
			this.#debug.textContent = `${(this.#frames.at(-1) ?? 0).toFixed(0)} ms · τ ${tau.toFixed(2)} · ${mode}`;
		}
		if (settled(this.#spring, this.#target, 0.5) && !this.#blend) {
			this.#running = false;
			this.#frames = [];
			return;
		}
		requestAnimationFrame((t) => this.#tick(t));
	}

	/** Twenty moving frames decide: a slow median drops the render settings once, a very slow one stops the travel. */
	#watchSpeed() {
		if (this.#frames.length < 21) return;
		const sorted = this.#frames.slice(1).sort((a, b) => a - b);
		const median = sorted[sorted.length >> 1];
		this.#frames = [];
		if (median > STEPPED_MS) this.#stepped = true;
		if (median > SLOW_MS && !this.#degraded) {
			this.#degraded = true;
			const { renderer } = this.#v.viewer;
			renderer.setPixelRatio(1);
			renderer.shadowMap.autoUpdate = false;
			renderer.shadowMap.needsUpdate = true;
			this.#v.viewer.setEdges(false);
		}
	}

	#apply(state: State, at: At) {
		const { viewer, tool, parts } = this.#v;
		const was = this.#applied;
		const beat = this.#beats[at.index];
		const handoff = at.index === this.#handoffIndex && at.local >= this.#v.subject.handoffAt;
		if (handoff && !this.#handoff) this.#enterHandoff(state);
		else if (!handoff && this.#handoff) this.#leaveHandoff(at);

		let changed = false;
		if (!this.#handoff) {
			let camera = state.camera;
			if (this.#blend) {
				const k = Math.min(1, (performance.now() - this.#blend.start) / 600);
				const e = k * k * (3 - 2 * k);
				const mix = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] - v) * e) as [number, number, number];
				camera = { position: mix(this.#blend.from.position, camera.position), target: mix(this.#blend.from.target, camera.target) };
				if (k >= 1) this.#blend = null;
			}
			if (!this.#camera || !sameCamera(this.#camera, camera)) {
				viewer.setCamera(camera);
				this.#camera = camera;
			}
		}
		if (!was || was.explode !== state.explode) {
			viewer.setExplode(state.explode);
			changed = true;
		}
		if (!was || !sameCuts(was.cuts, state.cuts)) {
			viewer.setCuts(state.cuts);
			changed = true;
		}
		if (!was || !sameList(was.hidden, state.hidden) || !sameList(was.isolated, state.isolated)) {
			applyVisibility(parts, new Set(state.hidden), new Set(state.isolated));
			viewer.requestRender();
			changed = true;
		}
		if (!was || was.highlight !== state.highlight) viewer.highlight(state.highlight ? (parts.byId.get(state.highlight) ?? null) : null);
		if (!was || was.measure !== state.measure) tool.setActive(state.measure);
		if (changed && this.#degraded) viewer.renderer.shadowMap.needsUpdate = true;
		this.#clip(at);
		// The copy keeps a ground of paper while the model may pass behind it: a shot that fills the stage, or one the
		// storyboard marks (`ui: { ground: true }`), such as a look inside the model whose parts surround the subject.
		document.documentElement.classList.toggle('ground', state.full > 0.25 || state.ui.ground === true);
		this.#showTree(state);
		this.#showRoute(state, beat);
		this.#applied = state;
	}

	/** The part tree follows the picture, but only while it is wholly on screen: it scrolls to its selection. */
	#showTree(state: State) {
		const slot = document.querySelector<HTMLElement>('[data-ui=parts]');
		if (!slot) return;
		const rect = slot.getBoundingClientRect();
		if (rect.top < 0 || rect.bottom > innerHeight) return;
		tree.show({ hidden: state.hidden, isolated: state.isolated, selected: state.highlight ?? state.isolated[0] ?? null });
	}

	/** The route of what is on screen, up to ten times a second, its newest key in orange. */
	#showRoute(state: State, beat: HTMLElement | undefined) {
		const code = beat?.querySelector<HTMLElement>('[data-ui=route] code');
		if (!code || this.#handoff) return;
		const now = performance.now();
		if (now - this.#routeAt < 100) return;
		this.#routeAt = now;
		const { subject } = this.#v;
		this.#print(code, route(subject, { ...defaultState(), ...pick(subject, state) }));
	}

	#print(code: HTMLElement, text: string) {
		const shown = this.#printed.get(code);
		if (text === shown) return;
		this.#printed.set(code, text);
		const before = shown ? new Map(shown.split(/[?&]/).map((p) => [p.split('=')[0], p] as const)) : null;
		const [head, query = ''] = text.split('?');
		code.replaceChildren(`${this.#host}/${head}?`);
		query.split('&').forEach((param, i) => {
			if (i) code.append('&');
			const b = document.createElement('b');
			b.textContent = shorten(param);
			if (before && before.get(param.split('=')[0]) !== param) b.className = 'new';
			code.append(b);
		});
	}

	#enterHandoff(state: State) {
		const { viewer, stage } = this.#v;
		this.#handoff = true;
		this.#blend = null;
		// The timeline turns the camera to put the model beside the copy; the visitor's orbit must turn about the model
		// itself, so on a desktop the view's centre moves right of the copy instead, and the camera looks at the model.
		if (narrow.matches) viewer.setCamera(state.camera);
		else {
			viewer.setInset(this.#free.at(-1)?.x0 ?? 0, 0);
			viewer.setCamera({ position: state.camera.position, target: state.shot.target });
		}
		// From here the controls move the camera; what was last applied is no longer on screen.
		this.#camera = null;
		Object.assign(viewer.controls, { enabled: true, enableZoom: false, enablePan: false });
		stage.classList.add('turnable');
		this.#beats[this.#handoffIndex]?.querySelector('.hint')?.classList.add('shown');
		viewer.onCameraChange = () => this.#link(this.#applied ?? state);
		this.#link(state);
	}

	#leaveHandoff(at: At) {
		const { viewer, stage } = this.#v;
		this.#handoff = false;
		const { controls } = viewer;
		controls.enabled = false;
		// The damping's leftover turn is spent at once, or the viewer's loop would keep turning the camera under the
		// timeline.
		controls.enableDamping = false;
		controls.update();
		controls.enableDamping = true;
		// Back to the timeline's way of placing the model: no inset, the camera turned toward the free area, the picture
		// unchanged; from there a blend to the timeline's camera, or straight there when holds apply without travel.
		let from = viewer.getCamera();
		if (!narrow.matches) {
			const { up } = this.#v.subject.model;
			viewer.setInset(0, 0);
			from = pose(shotOf(from, up), this.#viewport(at), 0, up);
			viewer.setCamera(from);
		}
		this.#camera = from;
		this.#blend = this.#stepped ? null : { from, start: performance.now() };
		stage.classList.remove('turnable');
		viewer.onCameraChange = () => {};
	}

	/** The hand-off: the address of the view on screen, as the app would open it. */
	#link(state: State) {
		const { viewer, subject } = this.#v;
		const { hidden, isolated, cuts, explode } = state;
		const text = route(subject, { ...defaultState(), hidden, isolated, cuts, explode, camera: viewer.getCamera() });
		const beat = this.#beats[this.#handoffIndex];
		const code = beat?.querySelector<HTMLElement>('[data-ui=route] code');
		if (code) this.#print(code, text);
		const open = beat?.querySelector<HTMLAnchorElement>('a[data-open]');
		if (open) open.href = `${subject.webOrigin}/${text}`;
	}

	debug() {
		this.#debug = document.createElement('div');
		const style = { position: 'fixed', left: '8px', bottom: '8px', zIndex: '9', font: '12px/1.4 system-ui', background: 'var(--paper)', padding: '4px 8px' };
		Object.assign(this.#debug.style, style);
		document.body.append(this.#debug);
		console.info(this.#v.viewer.describe());
	}
}

/** What of a timeline state goes into a route: the measured items only while Measure is on. */
function pick({ model }: Subject, state: State) {
	const measure = state.measure ? model.measure.map(parseRef).filter((ref): ref is MeasureRef => !!ref) : [];
	return { hidden: state.hidden, isolated: state.isolated, cuts: state.cuts, explode: state.explode, camera: state.camera, measure };
}

/** The app's route for a view of the page's file: pinned to its bytes, with the file's up axis. */
export function route({ model }: Subject, view: ViewState) {
	const source = { kind: 'url' as const, url: model.source.url, sha256: model.source.sha256 };
	return encode({ ...view, source, up: model.up });
}

/** A long parameter, for reading: the link itself keeps it whole. */
function shorten(param: string) {
	const [key, value = ''] = param.split('=');
	if (key === 'src') return `src=${value.slice(0, 34)}…${value.slice(-18)}`;
	if (key === 'x') return `x=${value.slice(0, 8)}…`;
	return param;
}

/** The orbit a camera sits on: its distance, and its azimuth and elevation as camera.ts counts them. */
function shotOf(camera: Camera, up: UpAxis) {
	const offset = new THREE.Vector3(...camera.position).sub(new THREE.Vector3(...camera.target));
	const dist = offset.length();
	const d = offset.normalize();
	const axis = upVector(up);
	const el = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(d.dot(axis), -1, 1)));
	const front = new THREE.Vector3(...direction(0, 0, up));
	const side = new THREE.Vector3(...direction(90, 0, up));
	const az = THREE.MathUtils.radToDeg(Math.atan2(d.dot(side), d.dot(front)));
	return { target: camera.target, az, el, dist };
}

const mix = (a: Rect, b: Rect, k: number): Rect => ({
	x0: a.x0 + (b.x0 - a.x0) * k,
	y0: a.y0 + (b.y0 - a.y0) * k,
	x1: a.x1 + (b.x1 - a.x1) * k,
	y1: a.y1 + (b.y1 - a.y1) * k
});
const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
const sameCamera = (a: Camera, b: Camera) => a.position.every((v, i) => near(v, b.position[i])) && a.target.every((v, i) => near(v, b.target[i]));
const sameCuts = (a: Cut[], b: Cut[]) => a.length === b.length && a.every((c, i) => c.axis === b[i].axis && c.flip === b[i].flip && near(c.offset, b[i].offset));
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
