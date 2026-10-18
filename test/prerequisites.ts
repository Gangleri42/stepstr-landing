// Files the tests need but the repository does not hold: stepstr's converter build, in the submodule, and each page's
// model under .cache/landing. A test skips without them, so a plain `npm test` runs on any checkout. With STEPSTR_STRICT=1
// a missing one fails the run instead, naming the file and the command that makes it, so a green strict run has tested
// everything.
import { existsSync } from 'node:fs';
import { cacheOf } from '../subjects.ts';

export type Prerequisite = { what: string; path: string; how: string };

export const STRICT = process.env.STEPSTR_STRICT === '1';

// STEPSTR_WASM points the tests at another build.
export const CONVERTER: Prerequisite = {
	what: 'the converter build',
	path: process.env.STEPSTR_WASM ?? 'stepstr/converter/dist/converter.wasm',
	how: 'build it with `stepstr/converter/build.sh`'
};

/** A page's model (subjects.ts), with the conversion it was made from kept under .cache/landing. */
export function landingModel(id: string): Prerequisite {
	return {
		what: `the landing model "${id}"`,
		path: cacheOf(id).summary,
		how: `make it with \`npm run model -- ${id}\``
	};
}

/**
 * Whether a test must skip for want of one of these files. Under STEPSTR_STRICT=1 a missing file throws instead, while
 * vitest collects the tests, which fails the test file with the message.
 */
export function lacking(...needed: Prerequisite[]): boolean {
	const absent = needed.filter((p) => !existsSync(p.path));
	if (absent.length && STRICT) {
		throw new Error(`STEPSTR_STRICT: ${absent.map((p) => `${p.what} (${p.path}) is missing; ${p.how}`).join('. ')}`);
	}
	return absent.length > 0;
}
