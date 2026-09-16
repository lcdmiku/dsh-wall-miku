// image.js is split by testability: the arithmetic and the upfront validation
// are pure and are tested here for real. The decode/re-encode half needs a
// browser (createImageBitmap, canvas) and has NO automated coverage -- that gap
// is deliberate and documented in the design, not an oversight to paper over.
import { test } from "node:test";
import assert from "node:assert/strict";

import { targetSize, rejectionFor, MAX_UPLOAD_BYTES, MAX_EDGE } from "../client/src/image.js";

test("a landscape image is bounded by its width", () => {
	assert.deepEqual(targetSize(6000, 4000, 2560), { width: 2560, height: 1707 });
});

test("a portrait image is bounded by its height", () => {
	assert.deepEqual(targetSize(4000, 6000, 2560), { width: 1707, height: 2560 });
});

test("a square image is bounded by either edge", () => {
	assert.deepEqual(targetSize(6000, 6000, 2560), { width: 2560, height: 2560 });
});

test("an image already within the bound is left alone, never upscaled", () => {
	// Upscaling would inflate the file for no visible gain.
	assert.deepEqual(targetSize(1920, 1080, 2560), { width: 1920, height: 1080 });
	assert.deepEqual(targetSize(2560, 1440, 2560), { width: 2560, height: 1440 });
	assert.deepEqual(targetSize(800, 600, 2560), { width: 800, height: 600 });
});

test("a degenerate edge still yields a positive dimension", () => {
	// A 1px-tall panorama is silly but legal; a zero dimension would break canvas.
	const size = targetSize(9000, 1, 2560);
	assert.ok(size.width >= 1 && size.height >= 1, JSON.stringify(size));
});

test("the default bound is the documented 2560px long edge", () => {
	assert.equal(MAX_EDGE, 2560);
	assert.deepEqual(targetSize(6000, 6000), { width: 2560, height: 2560 });
});

test("ordinary raster images are accepted", () => {
	for (const type of ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"]) {
		assert.equal(rejectionFor({ type, size: 1024 }), undefined, type);
	}
});

test("a non-image is refused before anything tries to decode it", () => {
	assert.equal(rejectionFor({ type: "text/plain", size: 10 }), "not-an-image");
	assert.equal(rejectionFor({ type: "", size: 10 }), "not-an-image");
	assert.equal(rejectionFor({ type: "application/pdf", size: 10 }), "not-an-image");
});

test("svg is refused as unsupported rather than mis-decoded", () => {
	// createImageBitmap is inconsistent about SVGs lacking intrinsic dimensions.
	assert.equal(rejectionFor({ type: "image/svg+xml", size: 10 }), "vector-unsupported");
	assert.equal(rejectionFor({ type: "image/svg+xml", size: 99 * 1024 * 1024 }), "vector-unsupported");
});

test("an oversized file is refused before the decode would exhaust memory", () => {
	assert.equal(rejectionFor({ type: "image/png", size: MAX_UPLOAD_BYTES + 1 }), "too-large");
	// The boundary itself is allowed.
	assert.equal(rejectionFor({ type: "image/png", size: MAX_UPLOAD_BYTES }), undefined);
	assert.equal(MAX_UPLOAD_BYTES, 40 * 1024 * 1024);
});
