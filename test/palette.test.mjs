// palette.js is the only part of the custom-skin feature that can be verified
// without a browser: it takes pixel data in and returns colour strings out, with
// no DOM, no storage, no React. These tests are where the colour maths earns
// its trust -- eyeballing extracted colours on a screenshot proves nothing.
import { test } from "node:test";
import assert from "node:assert/strict";

import { srgbToOklch, oklchToSrgb, extractDominantColor, deriveAccents, toHex, fromHex, parseRgb as parseAccentRgb } from "../client/src/palette.js";

/**
 * Build RGBA pixel data for a test image.
 * @param fill - returns `[r, g, b]` or `[r, g, b, a]` for a coordinate.
 */
function imageData(width, height, fill) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const [r, g, b, a = 255] = fill(x, y);
			const at = (y * width + x) * 4;
			data[at] = r;
			data[at + 1] = g;
			data[at + 2] = b;
			data[at + 3] = a;
		}
	}
	return { data, width, height };
}

/** Euclidean distance between two RGB triples. */
function rgbDistance(a, b) {
	return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/** Round-trip samples spanning the achromatic axis and several hue families. */
const ROUND_TRIP_SAMPLES = [
	{ name: "black", rgb: { r: 0, g: 0, b: 0 } },
	{ name: "white", rgb: { r: 255, g: 255, b: 255 } },
	{ name: "mid grey", rgb: { r: 128, g: 128, b: 128 } },
	{ name: "red", rgb: { r: 255, g: 0, b: 0 } },
	{ name: "green", rgb: { r: 0, g: 128, b: 0 } },
	{ name: "blue", rgb: { r: 0, g: 0, b: 255 } },
	{ name: "cyan accent", rgb: { r: 34, g: 211, b: 238 } },
	{ name: "sakura accent", rgb: { r: 251, g: 113, b: 133 } },
];

test("sRGB survives a round trip through OKLCH", () => {
	for (const { name, rgb } of ROUND_TRIP_SAMPLES) {
		const back = oklchToSrgb(srgbToOklch(rgb));
		for (const channel of ["r", "g", "b"]) {
			assert.ok(
				Math.abs(back[channel] - rgb[channel]) < 0.5,
				`${name}.${channel}: ${rgb[channel]} -> ${back[channel]}`,
			);
		}
	}
});

// A round trip alone is weak evidence: two matrices that are wrong but mutually
// inverse still round-trip, and every colour comes out shifted. These two tests
// pin the transform to properties it cannot fake -- exact normalisation, and the
// perceptual uniformity that is the entire reason OKLCH was chosen over HSL.

test("the transform is exactly normalised: white is L=1, black is L=0, greys have no chroma", () => {
	// Tolerance is 1e-6, not machine epsilon: the published OKLab matrix rows sum
	// to 1 only to the precision the constants are printed at (the L row sums to
	// 0.999999), so white lands ~1e-8 off unity by construction. 1e-6 still
	// catches any coefficient typo big enough to matter -- see the mutation note
	// in the commit that introduced this test.
	const white = srgbToOklch({ r: 255, g: 255, b: 255 });
	assert.ok(Math.abs(white.l - 1) < 1e-6, `white L = ${white.l}`);
	assert.ok(white.c < 1e-6, `white C = ${white.c}`);

	const black = srgbToOklch({ r: 0, g: 0, b: 0 });
	assert.ok(black.l < 1e-6, `black L = ${black.l}`);
	assert.ok(black.c < 1e-6, `black C = ${black.c}`);

	// The achromatic axis must stay achromatic all the way up.
	for (const level of [16, 64, 128, 200, 240]) {
		const grey = srgbToOklch({ r: level, g: level, b: level });
		assert.ok(grey.c < 1e-6, `grey ${level} C = ${grey.c}`);
		assert.ok(grey.l > 0 && grey.l < 1, `grey ${level} L = ${grey.l}`);
	}
});

test("lightness is perceptually ordered -- yellow reads far brighter than blue", () => {
	const lightnessOf = (rgb) => srgbToOklch(rgb).l;
	const yellow = lightnessOf({ r: 255, g: 255, b: 0 });
	const green = lightnessOf({ r: 0, g: 255, b: 0 });
	const red = lightnessOf({ r: 255, g: 0, b: 0 });
	const blue = lightnessOf({ r: 0, g: 0, b: 255 });

	assert.ok(
		yellow > green && green > red && red > blue,
		`expected yellow > green > red > blue, got ${[yellow, green, red, blue].join(" > ")}`,
	);
	// HSL gives every one of these L=0.5, so a spread this wide is something only
	// a perceptually uniform space can produce. A swap to HSL fails right here.
	assert.ok(
		yellow - blue > 0.3,
		`yellow-blue lightness spread too small: ${(yellow - blue).toFixed(3)}`,
	);
});


// Dominant-colour extraction: the part that decides what a wallpaper "is".
// Scoring is population^0.5 * saturation * lightnessPenalty, so a big white
// field must lose to a small vivid patch -- that IS the design, and these tests
// are what hold it in place.

test("a small saturated patch beats a large white field", () => {
	const patch = { r: 74, g: 158, b: 255 };
	// ~19% of the pixels carry all the colour; 81% are pure white.
	const image = imageData(64, 64, (x, y) =>
		x < 28 && y < 28 ? [patch.r, patch.g, patch.b] : [255, 255, 255]);

	const dominant = extractDominantColor(image);

	assert.notEqual(dominant, null, "expected a colour, got none");
	assert.ok(
		rgbDistance(dominant, patch) < 12,
		`picked rgb(${dominant.r},${dominant.g},${dominant.b}), wanted rgb(${patch.r},${patch.g},${patch.b})`,
	);
});

test("a small saturated patch beats a large black field", () => {
	const patch = { r: 251, g: 113, b: 133 };
	const image = imageData(64, 64, (x, y) =>
		x < 28 && y < 28 ? [patch.r, patch.g, patch.b] : [0, 0, 0]);

	const dominant = extractDominantColor(image);

	assert.notEqual(dominant, null, "expected a colour, got none");
	assert.ok(
		rgbDistance(dominant, patch) < 12,
		`picked rgb(${dominant.r},${dominant.g},${dominant.b}), wanted rgb(${patch.r},${patch.g},${patch.b})`,
	);
});

test("the colour comes back exact, not snapped to a quantisation bucket", () => {
	// 74/158/255 is nowhere near the 16-step grid a 4-bit histogram quantises to;
	// averaging the winning bucket's raw pixels is what recovers the true value.
	const patch = { r: 74, g: 158, b: 255 };
	const image = imageData(32, 32, () => [patch.r, patch.g, patch.b]);

	const dominant = extractDominantColor(image);

	assert.notEqual(dominant, null);
	assert.ok(
		rgbDistance(dominant, patch) < 1,
		`picked rgb(${dominant.r},${dominant.g},${dominant.b}) -- looks quantised`,
	);
});

test("fully transparent pixels do not vote", () => {
	const patch = { r: 129, g: 140, b: 248 };
	// A large transparent red field would win on population if alpha were ignored.
	const image = imageData(64, 64, (x, y) =>
		x < 28 && y < 28 ? [patch.r, patch.g, patch.b] : [255, 0, 0, 0]);

	const dominant = extractDominantColor(image);

	assert.notEqual(dominant, null, "expected a colour, got none");
	assert.ok(
		rgbDistance(dominant, patch) < 12,
		`picked rgb(${dominant.r},${dominant.g},${dominant.b}), wanted rgb(${patch.r},${patch.g},${patch.b})`,
	);
});

test("a greyscale image has no dominant hue", () => {
	const ramp = imageData(64, 64, (x, y) => {
		const level = ((x + y) * 255) / 126;
		return [level, level, level];
	});

	assert.equal(extractDominantColor(ramp), null);
});

test("an entirely transparent image has no dominant hue", () => {
	const empty = imageData(16, 16, () => [0, 0, 0, 0]);

	assert.equal(extractDominantColor(empty), null);
});

test("a large pale field loses to a small vivid patch", () => {
	// Both colours are blue, so hue is not what separates them. The pale field
	// is ~9x larger; only population^0.5 (which compresses that ratio) combined
	// with the lightness penalty (which discounts the pale end) can flip it.
	// Raw population, or no penalty, picks the pale field here.
	const pale = { r: 180, g: 210, b: 255 };
	const vivid = { r: 74, g: 158, b: 255 };
	const image = imageData(128, 128, (x, y) =>
		x < 40 && y < 40 ? [vivid.r, vivid.g, vivid.b] : [pale.r, pale.g, pale.b]);

	const dominant = extractDominantColor(image);

	assert.notEqual(dominant, null, "expected a colour, got none");
	assert.ok(
		rgbDistance(dominant, vivid) < 12,
		`picked rgb(${dominant.r},${dominant.g},${dominant.b}), wanted the vivid rgb(${vivid.r},${vivid.g},${vivid.b})`,
	);
});

// ---- accent derivation ----------------------------------------------------
// The contrast helpers below are implemented HERE, independently of palette.js,
// on purpose: a test that asked the production code whether the production code
// is readable would pass no matter how wrong that code was.

/** WCAG relative luminance, written from the spec rather than shared. */
function relativeLuminance({ r, g, b }) {
	const linear = (channel) => {
		const c = channel / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a, b) {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Parse the "r, g, b" strings the token layer expects. */
function parseRgb(value) {
	const parts = value.split(",").map((part) => Number(part.trim()));
	assert.equal(parts.length, 3, `not an "r, g, b" triple: ${JSON.stringify(value)}`);
	assert.ok(parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255), `out of range: ${value}`);
	return { r: parts[0], g: parts[1], b: parts[2] };
}

/** A primary colour at a given hue, via the OKLCH space under test. */
function primaryAtHue(hue) {
	return oklchToSrgb({ l: 0.6, c: 0.15, h: hue });
}

const WHITE = { r: 255, g: 255, b: 255 };
const DARK_SURFACE = { r: 6, g: 9, b: 20 };
const HUE_SWEEP = Array.from({ length: 24 }, (_, index) => index * 15);
/** A denser sweep, for the tests that must hold across the whole colour space. */
const HUE_FINE_SWEEP = Array.from({ length: 72 }, (_, index) => index * 5);
const CHROMA_SWEEP = Array.from({ length: 16 }, (_, index) => 0.02 + index * 0.02);

test("every hue and chroma yields accents that clear the 3:1 floor on their own surface", () => {
	// This sweep IS the contrast guarantee. Derivation runs no runtime contrast
	// check -- it relies on the target lightnesses holding with margin -- so if
	// someone retunes a target and eats that margin, this is what catches it.
	// It replaced an iterative rescue loop that measurement showed could never
	// fire: over these same 4608 combinations it never moved a single value.
	let checked = 0;
	for (const hue of HUE_FINE_SWEEP) {
		for (const chroma of CHROMA_SWEEP) {
			const accents = deriveAccents(oklchToSrgb({ l: 0.6, c: chroma, h: hue }));
			for (const role of ["lightAccent", "lightAccentDeep"]) {
				const ratio = contrastRatio(parseRgb(accents[role]), WHITE);
				assert.ok(
					ratio >= 3,
					`hue ${hue} chroma ${chroma.toFixed(2)}: ${role} rgb(${accents[role]}) vs white = ${ratio.toFixed(2)}:1`,
				);
			}
			for (const role of ["darkAccent", "darkAccentSoft"]) {
				const ratio = contrastRatio(parseRgb(accents[role]), DARK_SURFACE);
				assert.ok(
					ratio >= 3,
					`hue ${hue} chroma ${chroma.toFixed(2)}: ${role} rgb(${accents[role]}) vs dark surface = ${ratio.toFixed(2)}:1`,
				);
			}
			checked += 4;
		}
	}
	assert.equal(checked, HUE_FINE_SWEEP.length * CHROMA_SWEEP.length * 4);
	assert.ok(checked >= 4608, `sweep thinner than intended: ${checked}`);
});

test("accents keep the wallpaper's hue instead of drifting to a safe default", () => {
	for (const hue of HUE_SWEEP) {
		const primary = primaryAtHue(hue);
		const sourceHue = srgbToOklch(primary).h;
		const accents = deriveAccents(primary);
		for (const role of ["lightAccent", "lightAccentDeep", "darkAccent", "darkAccentSoft"]) {
			const derived = srgbToOklch(parseRgb(accents[role]));
			// Greys have no meaningful hue; only judge the colourful outcomes.
			if (derived.c < 0.02) continue;
			const raw = Math.abs(derived.h - sourceHue);
			const drift = Math.min(raw, 360 - raw);
			assert.ok(drift < 12, `${role} at hue ${hue} drifted ${drift.toFixed(1)} deg`);
		}
	}
});

test("each accent lands on its role's lightness target", () => {
	const accents = deriveAccents(primaryAtHue(210));
	const expected = {
		lightAccent: 0.42,
		lightAccentDeep: 0.32,
		darkAccent: 0.68,
		darkAccentSoft: 0.78,
	};
	for (const [role, target] of Object.entries(expected)) {
		const lightness = srgbToOklch(parseRgb(accents[role])).l;
		assert.ok(
			Math.abs(lightness - target) < 0.04,
			`${role}: L=${lightness.toFixed(3)}, wanted ~${target}`,
		);
	}
});

test("extreme primaries still produce usable accents", () => {
	// Near-white yellow and near-black blue are the shapes that push the guard
	// hardest: one cannot be darkened without losing its hue, the other cannot be
	// lightened without washing out.
	for (const primary of [
		{ r: 255, g: 252, b: 200 },
		{ r: 8, g: 10, b: 40 },
		{ r: 255, g: 0, b: 0 },
		{ r: 0, g: 255, b: 0 },
		{ r: 128, g: 128, b: 128 },
	]) {
		const accents = deriveAccents(primary);
		const light = parseRgb(accents.lightAccent);
		const dark = parseRgb(accents.darkAccent);
		assert.ok(
			contrastRatio(light, WHITE) >= 3,
			`rgb(${primary.r},${primary.g},${primary.b}) lightAccent only ${contrastRatio(light, WHITE).toFixed(2)}:1`,
		);
		assert.ok(
			contrastRatio(dark, DARK_SURFACE) >= 3,
			`rgb(${primary.r},${primary.g},${primary.b}) darkAccent only ${contrastRatio(dark, DARK_SURFACE).toFixed(2)}:1`,
		);
	}
});

// ---- colour formatting ----------------------------------------------------
// The picker speaks a different dialect from the token layer: an <input
// type="color"> reads and writes "#rrggbb", while the accents are stored as
// "r, g, b" so they can be interpolated into rgba(...).

test("an RGB triple survives a round trip through hex", () => {
	for (const rgb of [
		{ r: 0, g: 0, b: 0 },
		{ r: 255, g: 255, b: 255 },
		{ r: 74, g: 158, b: 255 },
		{ r: 251, g: 113, b: 133 },
	]) {
		assert.deepEqual(fromHex(toHex(rgb)), rgb);
	}
});

test("hex is the six-digit lowercase form a colour input expects", () => {
	assert.equal(toHex({ r: 74, g: 158, b: 255 }), "#4a9eff");
	assert.equal(toHex({ r: 0, g: 0, b: 0 }), "#000000");
	assert.equal(toHex({ r: 255, g: 255, b: 255 }), "#ffffff");
});

test("hex parsing accepts what a colour input emits, case included", () => {
	assert.deepEqual(fromHex("#4A9EFF"), { r: 74, g: 158, b: 255 });
	assert.deepEqual(fromHex("#000000"), { r: 0, g: 0, b: 0 });
});

test("a malformed colour is refused rather than half-parsed", () => {
	// Found by the switcher's own integration test, not by reasoning: the picker
	// can hand over an empty string, and `parseInt("")` is NaN. NaN then reaches
	// the chroma search in deriveAccent, which steps toward zero and cannot get
	// there from NaN -- so a bad colour did not merely look wrong, it never
	// returned, and the tab hung.
	for (const bad of ["", "#", "#12", "#12345", "#1234567", "rgb(1,2,3)", "blue", undefined, null, 42]) {
		assert.throws(() => fromHex(bad), TypeError, `fromHex(${JSON.stringify(bad)}) must refuse`);
	}
});

test("a non-finite primary still yields accents instead of spinning forever", () => {
	// The same hang, reached from the other direction: whatever the caller did to
	// produce a NaN channel, the derivation must still terminate. If the guard in
	// deriveAccent were removed this test would not fail, it would never finish.
	const accents = deriveAccents({ r: Number.NaN, g: Number.NaN, b: Number.NaN });
	for (const [role, value] of Object.entries(accents)) {
		assert.equal(typeof value, "string", role);
		assert.match(value, /^\d+, \d+, \d+$/, `${role} must still be an "r, g, b" triple`);
	}
});

test("the stored accent format parses back to a colour", () => {
	// This is the exact string shape aliasTokens interpolates into rgba().
	assert.deepEqual(parseAccentRgb("74, 158, 255"), { r: 74, g: 158, b: 255 });
	assert.deepEqual(parseAccentRgb("0, 0, 0"), { r: 0, g: 0, b: 0 });
});
