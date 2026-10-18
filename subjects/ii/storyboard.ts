// What the SeedHammer II does as the page scrolls: one beat per chapter of the copy, each a few viewport heights long,
// its keys at points through it. Parts are named as the tree shows them; the stage resolves the names once the model
// is in. `holds` are the moments the copy describes: stepped mode jumps between them, and the stills are taken at the
// last. Distances are framings (`size`), so a shot keeps its composition on any screen. Azimuths count from the Iso
// view, which looks from the front left: +x is the front, where the plate goes in under the needle, and the left wall
// faces Iso. The walls close the sides to the top and the front panel stands 44 mm high, so close shots look in over
// it. Offsets of cuts are in the file's millimetres, Z up. Each cut takes away a part of the machine that can be seen
// and the camera stands on the side it takes away; each part switched off stands in front of the shot's subject; the
// part kept alone is the subject before it is (timeline.ts checks all of it, src/visible.test.ts on the
// pictures).
import type { Beat, CutSpec } from '../../src/timeline.ts';

/** The 85 mm steel plate the machine engraves, in its sled. */
const PLATE = 'plate';
const NEEDLE = 'needle';
/** The hammer's carriage: the clamp that rides the X axis's rods, its bushings and nut, the hammer and the needle. */
const CARRIAGE = 'x_carriage';
/** The sled that carries the plate along the Y axis. */
const SLED = 'y_carriage';
const LEFT = 'left';
/** The deck on top, which holds the screen. */
const DECK = 'faceplate';
/** The circuit board under the deck, the screen and the cables. */
const ELECTRONICS = 'electronics';
/** The Y axis's rod at y +33, under the sled. */
const ROD = 'y_rod (2)';

/** From where the hand-off begins in the last beat: the visitor turns the machine from here on. */
export const HANDOFF_AT = 0.35;

/**
 * The section beat's cuts, parked until each slides in: down the hammer's axis, 0.3 mm off the machine's symmetry
 * plane so no face lies in it (a route keeps offsets to 0.1 mm); level through the X axis's lead screw and its nut;
 * and in front of the plate, which takes the front panel and the clamp's lever away.
 */
const cuts = (a: number, b: number, c: number): CutSpec[] => [
	{ axis: 'y', offset: 0.3, flip: true, in: a },
	{ axis: 'z', offset: 108, flip: false, in: b },
	{ axis: 'x', offset: 45, flip: false, in: c }
];

export const STORYBOARD: Beat[] = [
	{
		id: 'iso',
		len: 1.5,
		holds: [0.45],
		keys: [
			{
				t: 0,
				target: '*',
				az: -8,
				el: 24,
				size: { fit: '*', k: 0.8 },
				full: 0,
				explode: 0,
				cuts: [],
				hidden: [],
				isolated: [],
				highlight: null,
				measure: false
			},
			{ t: 1, az: 4 }
		]
	},
	{
		// Once around the machine, past the motors at the back, then in over the front panel to the needle's tip.
		id: 'orbit',
		len: 3.5,
		holds: [0.28, 0.52, 0.86],
		keys: [
			{ t: 0.28, az: 115, el: 32, size: { fit: '*', k: 0.85 } },
			{ t: 0.52, az: 245, el: 30 },
			// From here the camera is inside the machine, whose parts fill the stage around the subject: the copy gets
			// a ground until the parts beat steps back out.
			{ t: 0.74, target: [0, 0, 80], az: 395, el: 16, ui: { ground: true } },
			{ t: 0.86, target: { point: 'needleTip' }, az: 405, el: 8, size: { fit: NEEDLE, k: 2.6 } },
			{ t: 1, az: 408 }
		]
	},
	{
		// The plate from the front, measured across between the two front corners of its top face.
		id: 'measure',
		len: 2,
		holds: [0.5],
		keys: [
			{ t: 0.15, target: { centre: PLATE }, az: 395, el: 45, size: { fit: PLATE, k: 1.45 }, measure: true },
			{ t: 0.85, az: 398, measure: true },
			{ t: 0.92, measure: false }
		]
	},
	{
		// The wall facing the camera goes off, then the deck and the electronics over the carriage, and the carriage
		// stays alone.
		id: 'parts',
		len: 2,
		holds: [0.32, 0.62, 0.92],
		keys: [
			{ t: 0.15, target: { centre: CARRIAGE }, az: 335, el: 18, size: { fit: '*', k: 0.72 }, highlight: LEFT, ui: {} },
			{ t: 0.25, hidden: [LEFT], highlight: DECK },
			{ t: 0.45, az: 330, el: 40 },
			{ t: 0.55, hidden: [LEFT, DECK, ELECTRONICS], highlight: CARRIAGE },
			{ t: 0.72, hidden: [], isolated: [CARRIAGE], highlight: null },
			{ t: 0.9, az: 325, el: 20, size: { fit: CARRIAGE, k: 1.25 } }
		]
	},
	{
		// The carriage comes apart, then the whole machine, seen from the front so the left wall flies out of the way.
		id: 'explode',
		len: 2.2,
		holds: [0.35, 0.72],
		keys: [
			{ t: 0.08, explode: 0 },
			{ t: 0.35, explode: 1, az: 318, el: 18 },
			{ t: 0.48, isolated: [] },
			{ t: 0.72, target: '*', size: { fit: '*', k: 0.86 }, az: 400, el: 30 },
			{ t: 0.95, explode: 0, size: { fit: '*', k: 0.8 }, az: 395, el: 20 }
		]
	},
	{
		// From the front left, the side all three cuts take away, closing in on what is left as each comes in.
		id: 'section',
		len: 2.2,
		holds: [0.35, 0.62, 0.9],
		keys: [
			{ t: 0, cuts: cuts(0, 0, 0) },
			{ t: 0.15, target: '*', az: 380, el: 15, size: { fit: '*', k: 0.75 } },
			{ t: 0.35, cuts: cuts(1, 0, 0) },
			{ t: 0.48, target: [-10, 20, 70], az: 372, el: 30, size: { fit: '*', k: 0.7 } },
			{ t: 0.62, cuts: cuts(1, 1, 0) },
			{ t: 0.9, cuts: cuts(1, 1, 1), target: [-20, 25, 55], az: 360, el: 32, size: { fit: '*', k: 0.66 } }
		]
	},
	{
		// The cuts stay, and the sled goes off over the rod it rides on: the address holds both.
		id: 'route',
		len: 2,
		holds: [0.5],
		keys: [
			{ t: 0.2, hidden: [SLED], target: { centre: ROD }, az: 368, el: 40, size: { fit: '*', k: 0.7 } },
			{ t: 0.8, cuts: cuts(1, 1, 1) },
			{ t: 1, cuts: cuts(0, 0, 0), hidden: [], el: 24 }
		]
	},
	{
		id: 'drop',
		len: 1,
		holds: [0.5],
		keys: [
			{ t: 0, cuts: [] },
			{ t: 1, az: 400, el: 22, target: '*', size: { fit: '*', k: 0.8 } }
		]
	},
	{ id: 'github', len: 1, holds: [0.5], keys: [{ t: 1, az: 450 }] },
	{ id: 'blossom', len: 1, holds: [0.5], keys: [{ t: 1, az: 520 }] },
	{ id: 'napplet', len: 1.5, holds: [0.6], keys: [{ t: 1, az: 620 }] },
	{
		id: 'yours',
		len: 2,
		holds: [0.5],
		keys: [{ t: HANDOFF_AT, az: 720, el: 24, size: { fit: '*', k: 0.8 } }]
	}
];
