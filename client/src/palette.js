/**
 * Colour maths for the skin palette: sRGB <-> OKLCH plus the derivations the
 * switcher needs to turn one dominant colour into a full accent family.
 *
 * Pure functions only -- no DOM, no storage, no React -- so the whole module is
 * testable in node. The browser half (`switcher.js`, `image.js`) owns decoding
 * and rendering; this file owns numbers.
 *
 * OKLCH rather than HSL because OKLCH's lightness is perceptually uniform: the
 * same L reads as the same brightness across hues, which is what lets one
 * derivation rule serve a yellow wallpaper and a blue one alike.
 */

/** sRGB transfer function, both directions. Coefficients are the standard ones. */
function srgbToLinear(channel) {
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel) {
	// Clamping here is a gamut clip: an OKLCH triple can name a colour sRGB
	// cannot show. Callers must measure the sRGB they actually got back rather
	// than the OKLCH they asked for.
	const clamped = Math.min(1, Math.max(0, channel));
	return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/**
 * Convert an sRGB triple to OKLCH.
 * @param rgb - channels in 0..255.
 * @returns lightness 0..1, chroma, and hue in degrees 0..360.
 */
export function srgbToOklch({ r, g, b }) {
	const lr = srgbToLinear(r / 255);
	const lg = srgbToLinear(g / 255);
	const lb = srgbToLinear(b / 255);
	// Linear sRGB -> LMS -> cube roots -> OKLab.
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const hue = (Math.atan2(bb, a) * 180) / Math.PI;
	return { l: lightness, c: Math.hypot(a, bb), h: hue < 0 ? hue + 360 : hue };
}

/** OKLCH -> linear sRGB, unclamped: a channel outside 0..1 means out of gamut. */
function oklchToLinear({ l: lightness, c, h }) {
	const radians = (h * Math.PI) / 180;
	const a = c * Math.cos(radians);
	const bb = c * Math.sin(radians);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * bb) ** 3;
	return {
		r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	};
}

/** Gamma-encode an unclamped linear triple to sRGB 0..255, clipping the gamut. */
function linearToSrgbTriple({ r, g, b }) {
	return { r: linearToSrgb(r) * 255, g: linearToSrgb(g) * 255, b: linearToSrgb(b) * 255 };
}

/** Tolerance for the gamut test, so floating point cannot reject a boundary colour. */
const GAMUT_EPSILON = 1e-4;

function isInGamut(linear) {
	return (
		linear.r >= -GAMUT_EPSILON &&
		linear.r <= 1 + GAMUT_EPSILON &&
		linear.g >= -GAMUT_EPSILON &&
		linear.g <= 1 + GAMUT_EPSILON &&
		linear.b >= -GAMUT_EPSILON &&
		linear.b <= 1 + GAMUT_EPSILON
	);
}

/**
 * Convert an OKLCH triple back to sRGB.
 * @param oklch - lightness 0..1, chroma, hue in degrees.
 * @returns channels in 0..255, unrounded so callers can round once at the edge.
 *   Out-of-gamut requests are clipped; callers that care about hue should test
 *   {@link isInGamut} first rather than accepting the clipped result.
 */
export function oklchToSrgb(oklch) {
	return linearToSrgbTriple(oklchToLinear(oklch));
}

// ---- dominant colour ------------------------------------------------------
// Pixels below half opacity do not vote: a wallpaper's transparent regions are
// absence, not a colour choice.

const ALPHA_THRESHOLD = 128;

/**
 * Bits kept per channel when bucketing. Deliberately 4, not 5: the extraction
 * sample is ~128x128, so 5 bits would spread 16k samples over 32k buckets and
 * leave under one sample per bucket, making `count` noise. 4 bits gives ~4
 * samples per bucket and merges colours the eye cannot separate anyway.
 */
const QUANTIZE_BITS = 4;

/** How many of the most populous buckets get scored. */
const CANDIDATE_LIMIT = 32;

/** Below this saturation a colour carries no usable hue (greyscale, near-grey). */
const MIN_SATURATION = 0.15;

/** The perceptual lightness wallpapers read best against. */
const PREFERRED_LIGHTNESS = 0.55;

/** HSV-style saturation, so a "no hue" verdict is independent of brightness. */
function saturationOf({ r, g, b }) {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	return max === 0 ? 0 : (max - min) / max;
}

/**
 * Fade out colours that are too bright or too dark to be a usable accent.
 * Peaks at {@link PREFERRED_LIGHTNESS} and reaches zero at both extremes, which
 * is what stops a white wall or a black frame from winning on sheer area.
 */
function lightnessPenalty(lightness) {
	const distance = Math.abs(lightness - PREFERRED_LIGHTNESS) / (1 - PREFERRED_LIGHTNESS);
	return Math.max(0, 1 - distance * distance);
}

/**
 * Pick the colour a wallpaper "is".
 * @param image - RGBA pixel data (an `ImageData`, or any `{ data }`).
 * @returns the dominant colour as sRGB 0..255, or null when the image carries no
 *   usable hue (greyscale, or nothing opaque) -- the caller's cue to ask the
 *   user for a colour instead of inventing one.
 */
export function extractDominantColor({ data }) {
	const buckets = new Map();
	for (let at = 0; at < data.length; at += 4) {
		if (data[at + 3] < ALPHA_THRESHOLD) continue;
		const r = data[at];
		const g = data[at + 1];
		const b = data[at + 2];
		const key =
			((r >> (8 - QUANTIZE_BITS)) << (QUANTIZE_BITS * 2)) |
			((g >> (8 - QUANTIZE_BITS)) << QUANTIZE_BITS) |
			(b >> (8 - QUANTIZE_BITS));
		let bucket = buckets.get(key);
		if (bucket === undefined) {
			bucket = { count: 0, r: 0, g: 0, b: 0 };
			buckets.set(key, bucket);
		}
		bucket.count += 1;
		bucket.r += r;
		bucket.g += g;
		bucket.b += b;
	}
	if (buckets.size === 0) return null;

	const candidates = [...buckets.values()]
		.sort((left, right) => right.count - left.count)
		.slice(0, CANDIDATE_LIMIT);

	let best = null;
	let bestScore = 0;
	for (const bucket of candidates) {
		// Average the bucket's RAW pixels rather than using the bucket's centre:
		// 4-bit bucketing snaps to a 16-step grid, and the average is what puts
		// the colour back where it actually was.
		const average = {
			r: bucket.r / bucket.count,
			g: bucket.g / bucket.count,
			b: bucket.b / bucket.count,
		};
		const saturation = saturationOf(average);
		if (saturation === 0) continue;
		// Square root on population so a merely-large flat area cannot outrank a
		// smaller but genuinely vivid one.
		const score = Math.sqrt(bucket.count) * saturation * lightnessPenalty(srgbToOklch(average).l);
		if (score > bestScore) {
			bestScore = score;
			best = average;
		}
	}
	if (best === null || saturationOf(best) < MIN_SATURATION) return null;
	return { r: Math.round(best.r), g: Math.round(best.g), b: Math.round(best.b) };
}

// ---- accent derivation ----------------------------------------------------
// One dominant colour becomes the four values the token layer interpolates:
// two for the light scheme, two for the dark one. Hue is the wallpaper's
// identity, so it is preserved and only lightness is assigned per role --
// which is exactly what OKLCH buys us over HSL.

/** How much chroma is shed per attempt while bringing the target lightness into gamut. */
const CHROMA_STEP = 0.02;

/**
 * The four accents and the perceptual lightness each one aims at.
 *
 * Those lightnesses ARE the contrast guarantee: 0.42 and 0.32 sit far enough
 * below white, and 0.68 and 0.78 far enough above the dark surface, that every
 * hue clears 3:1 with room to spare. The test suite asserts that directly over
 * the whole hue and chroma range, which is what lets the derivation stay a
 * single lookup instead of an iterative rescue.
 *
 * A rescue loop was written first and then deleted: measurement over 4608
 * (hue, chroma, role) combinations showed it never moved a single value off its
 * target, because the margins above are so wide. Code no input can reach is not
 * insurance, it is dead weight -- and the invariant it claimed to protect is
 * exactly what the sweep test now proves.
 */
const ACCENT_ROLES = [
	{ key: "lightAccent", lightness: 0.42 },
	{ key: "lightAccentDeep", lightness: 0.32 },
	{ key: "darkAccent", lightness: 0.68 },
	{ key: "darkAccentSoft", lightness: 0.78 },
];

/** Format for the token layer, which interpolates `rgba(${value}, alpha)`. */
function formatRgb({ r, g, b }) {
	return `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
}

/**
 * Resolve one accent: keep the hue, land on the target lightness, and shed only
 * as much chroma as the sRGB gamut forces.
 *
 * Shedding chroma -- never moving lightness -- is what preserves hue, and hue is
 * what makes an accent look like it came from this wallpaper. Searching
 * lightness for a solution would be worse than useless: near L=0 every colour
 * collapses toward black and so "fits" the gamut however much chroma it asked
 * for, which turns such a search into a race to the bottom.
 */
function deriveAccent(primary, target) {
	const base = srgbToOklch(primary);
	for (let step = 0; ; step += 1) {
		// Math.max pins the final level to exactly 0: stepping by a float would
		// otherwise skip it. Chroma 0 is in gamut at any lightness, so this
		// terminates -- the loop needs no fallback branch.
		const chroma = Math.max(0, base.c - step * CHROMA_STEP);
		const linear = oklchToLinear({ l: target, c: chroma, h: base.h });
		if (isInGamut(linear)) return linearToSrgbTriple(linear);
	}
}

/**
 * Turn one dominant colour into the full accent family.
 * @param primary - the wallpaper's dominant colour, sRGB 0..255.
 * @returns the four accents as `"r, g, b"` strings. Each holds at least 3:1
 *   against the surface it is drawn on; that guarantee comes from the target
 *   lightnesses and is asserted over the whole hue and chroma range by the test
 *   suite, not checked at runtime.
 */
export function deriveAccents(primary) {
	const accents = {};
	for (const { key, lightness } of ACCENT_ROLES) {
		accents[key] = formatRgb(deriveAccent(primary, lightness));
	}
	return accents;
}
