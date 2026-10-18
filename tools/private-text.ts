// What the landing build will not publish. The GLB's names and the measurement data come from the STEP file's text, so
// the build stops on anything there that looks like a local path, an Autodesk id, an email address or an IP address.
const PATTERNS = [
	// Windows paths also in their escaped forms, as STEP and JSON write them.
	/\/Users\/[^/\s'"]|\/home\/[a-z]|\/private\/var\/folders\/|\/Volumes\/[^/\s'"]|[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)/,
	// Fusion and Inventor write these ids into their exports. Bracketed, so that a search for such ids skips this line.
	/urn:ads[k]/i,
	/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i,
	// Four octets standing alone, so version numbers (v15.15.0.0) do not count.
	/(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/
];

/** Whether the text holds anything the landing build does not publish. */
export const looksPrivate = (text: string) => PATTERNS.some((pattern) => pattern.test(text));
