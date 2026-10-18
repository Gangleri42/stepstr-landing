// What the arm does as the page scrolls: one beat per chapter of the copy, each a few viewport heights long, its keys
// at points through it. Parts are named as the tree shows them; the stage resolves the names once the model is in.
// `holds` are the moments the copy describes: stepped mode jumps between them, and the stills are taken at the last.
// Distances are framings (`size`), so a shot keeps its composition on any screen. Azimuths count from the Iso view,
// which looks at the gripper's side of the arm; 45 looks along the joint axes from +x, the side the mid-plane cut takes
// away, where its face shows each servo's gears (from -x it shows their boards). Offsets of cuts are in the file's
// millimetres, Z up. Each cut takes away a part of the arm that can be seen and the camera stands on the side it takes
// away; each part switched off stands in front of the shot's subject; the part kept alone is the subject before it is
// (timeline.ts checks all of it, src/visible.test.ts on the pictures).
import type { Vec3 } from '../../src/camera.ts';
import type { Beat, CutSpec } from '../../src/timeline.ts';

const UPPER_ARM = 'Upper_arm_SO101 v9';
const FIXED_JAW = 'Wrist_Roll_Follower_SO101 v10';
const JAW = 'Moving_Jaw_SO101 v3';
const BASE = 'Base_SO101 v12';
/** The base's lid, over the servo inside it. */
const COVER = 'Base_08p v18';
/** The servo in the base, which turns the whole arm: uncovered, kept alone, then taken apart. */
const PAN = 'ST3215 Servo v2';
/** Between the two jaws, a little below the moving jaw's tip: what the orbit circles. */
const GRIP: Vec3 = [5, -172, 200];
/** Where the moving jaw turns on its servo's horn, under four screws: the closest the camera comes. */
const PIVOT: Vec3 = [5, -163, 183];

/** From where the hand-off begins in the last beat: the visitor turns the arm from here on. */
export const HANDOFF_AT = 0.35;

/**
 * The section beat's cuts, parked until each slides in: down the arm's middle, through every servo; level through the
 * wrist servo's middle, which lifts off the moving jaw; and across the base through the pan servo's motor, which takes
 * the elbow and the arms' back halves away.
 */
const cuts = (a: number, b: number, c: number): CutSpec[] => [
	{ axis: 'x', offset: 4, flip: false, in: a },
	{ axis: 'z', offset: 152.7, flip: false, in: b },
	{ axis: 'y', offset: 20, flip: false, in: c }
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
		id: 'orbit',
		len: 3,
		holds: [0.3, 0.55, 0.85],
		keys: [
			{ t: 0.3, target: GRIP, az: 40, el: 10, size: { fit: FIXED_JAW, k: 1.0 } },
			{ t: 0.55, target: PIVOT, az: 80, el: 4, size: { fit: JAW, k: 0.7 }, full: 1 },
			{ t: 0.85, target: GRIP, az: 190, el: 20, size: { fit: FIXED_JAW, k: 1.5 }, full: 0 },
			{ t: 1, az: 205 }
		]
	},
	{
		id: 'measure',
		len: 2,
		holds: [0.5],
		keys: [
			{ t: 0.15, target: { centre: UPPER_ARM }, az: 225, el: 4, size: { fit: UPPER_ARM, k: 1.35 }, measure: true },
			{ t: 0.85, az: 232, measure: true },
			{ t: 0.92, measure: false }
		]
	},
	{
		// From behind the base: its lid goes off, then its shell, and the servo inside, the one that turns the whole arm,
		// stays alone.
		id: 'parts',
		len: 2,
		holds: [0.3, 0.55, 0.92],
		keys: [
			{ t: 0.1, target: { centre: PAN }, az: 226, el: 20, size: { fit: BASE, k: 1.3 }, highlight: COVER },
			{ t: 0.22, hidden: [COVER], highlight: BASE },
			{ t: 0.45, hidden: [COVER, BASE], highlight: PAN },
			{ t: 0.65, hidden: [], isolated: [PAN], highlight: null },
			{ t: 0.9, az: 238, el: 22, size: { fit: PAN, k: 1.2 } }
		]
	},
	{
		id: 'explode',
		len: 2.2,
		holds: [0.35, 0.72],
		keys: [
			{ t: 0.08, explode: 0 },
			{ t: 0.35, explode: 1, az: 255 },
			{ t: 0.48, isolated: [] },
			{ t: 0.72, target: '*', size: { fit: '*', k: 0.86 }, az: 370, el: 20 },
			{ t: 0.95, explode: 0, size: { fit: '*', k: 0.8 }, az: 390 }
		]
	},
	{
		// Seen from the +x, +y side the three cuts take away, a little more of it as each comes in.
		id: 'section',
		len: 2.2,
		holds: [0.35, 0.62, 0.9],
		keys: [
			{ t: 0, cuts: cuts(0, 0, 0) },
			{ t: 0.15, target: [0, -45, 135], az: 405, el: 14, size: { fit: '*', k: 0.72 } },
			{ t: 0.35, cuts: cuts(1, 0, 0) },
			{ t: 0.48, az: 420, el: 24 },
			{ t: 0.62, cuts: cuts(1, 1, 0) },
			{ t: 0.9, cuts: cuts(1, 1, 1), target: [0, -75, 85], az: 448, el: 28, size: { fit: '*', k: 0.62 } }
		]
	},
	{
		// With three cuts in and the camera on the side they take away, no part stands in front of anything, so the
		// address holds the cuts and the camera only.
		id: 'route',
		len: 2,
		holds: [0.5],
		keys: [
			{ t: 0.2, az: 462, el: 30 },
			{ t: 0.8, cuts: cuts(1, 1, 1) },
			{ t: 1, cuts: cuts(0, 0, 0), el: 22 }
		]
	},
	{
		id: 'drop',
		len: 1,
		holds: [0.5],
		keys: [
			{ t: 0, cuts: [] },
			{ t: 1, az: 470, el: 22, target: '*', size: { fit: '*', k: 0.8 } }
		]
	},
	{ id: 'github', len: 1, holds: [0.5], keys: [{ t: 1, az: 510 }] },
	{ id: 'blossom', len: 1, holds: [0.5], keys: [{ t: 1, az: 560 }] },
	{ id: 'napplet', len: 1.5, holds: [0.6], keys: [{ t: 1, az: 640 }] },
	{
		id: 'yours',
		len: 2,
		holds: [0.5],
		keys: [{ t: HANDOFF_AT, az: 720, el: 24, size: { fit: '*', k: 0.8 } }]
	}
];
