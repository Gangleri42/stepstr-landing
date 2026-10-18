// What the landing build will not publish (private-text.ts). Text that would be held back is assembled at runtime, so
// the file itself holds none.
import { describe, expect, it } from 'vitest';
import { looksPrivate } from './private-text.ts';

describe('what the landing build holds back', () => {
	it('finds local paths, including the escaped forms STEP and JSON write', () => {
		const paths = ['/Us' + 'ers/jane/model.f3d', '/ho' + 'me/jane/x', "FILE_NAME('C:" + '\\\\Users\\\\jane' + "')", 'C:/' + 'Users/jane', '/private/var/' + 'folders/xy/T/tmp'];
		for (const text of paths) expect(looksPrivate(text)).toBe(true);
	});

	it('finds Autodesk ids, email addresses and IP addresses', () => {
		expect(looksPrivate('urn:' + 'adsk.wipprod:fs.file:vf.abc')).toBe(true);
		expect(looksPrivate(`jane${'@'}mail.test`)).toBe(true);
		expect(looksPrivate('http://10.0.0.' + '7:8080/')).toBe(true);
	});

	it('passes version numbers and the text of ordinary headers and notes', () => {
		const texts = ["'Autodesk Translation Framework v15.15.0.0'", 'CREO PARAMETRIC BY PTC INC, 2024103', '~/models/part.step and /home', 'Rotation_Pitch_08i: 1 face(s) could not be meshed and are missing'];
		for (const text of texts) expect(looksPrivate(text)).toBe(false);
	});
});
