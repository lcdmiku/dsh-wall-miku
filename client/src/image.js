/**
 * Turning a user's chosen file into something storable: validate, decode, scale
 * down, re-encode, and sample the colours.
 *
 * The module is split by testability. `targetSize` and `rejectionFor` are pure
 * and carry the real tests. The decode/re-encode half talks to browser APIs
 * (`createImageBitmap`, canvas) and has NO automated coverage -- that gap is
 * recorded in the design rather than papered over, so the browser half is kept
 * as thin as it can be.
 *
 * Re-encoding rather than storing the original is not about saving space for its
 * own sake: a 6000x4000 photo decodes to roughly 190MB of GPU texture, and a
 * wallpaper is redrawn on every skin switch.
 */

import { extractDominantColor } from "./palette.js";

/** Long edge of the stored image. 2560 is ample for a full-screen backdrop. */
export const MAX_EDGE = 2560;

/** Long edge of the list thumbnail: big enough to recognise, small enough to keep in localStorage. */
export const THUMB_EDGE = 48;

/** Long edge of the colour-sampling buffer, chosen to pair with palette.js's 4-bit histogram. */
export const SAMPLE_EDGE = 128;

/** Refuse anything larger before decoding: a 100MB image would otherwise kill the tab. */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

const WEBP_QUALITY = 0.9;
const THUMB_WEBP_QUALITY = 0.8;

/** Thrown when a file is refused; `reason` is an i18n key the UI can show. */
export class ImageRejection extends Error {
	constructor(reason) {
		super(`image rejected: ${reason}`);
		this.name = "ImageRejection";
		this.reason = reason;
	}
}

/**
 * The size an image should be stored at.
 * @param maxEdge - longest allowed edge; the image is never enlarged.
 * @returns integer dimensions, each at least 1 so canvas stays valid.
 */
export function targetSize(width, height, maxEdge = MAX_EDGE) {
	const longest = Math.max(width, height);
	if (longest <= maxEdge) return { width, height };
	const scale = maxEdge / longest;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/**
 * Why a file cannot be used, or undefined when it can.
 * @returns an i18n reason key, checked cheapest-and-most-fundamental first.
 */
export function rejectionFor({ type, size }) {
	if (typeof type !== "string" || !type.startsWith("image/")) return "not-an-image";
	if (type === "image/svg+xml") return "vector-unsupported";
	if (size > MAX_UPLOAD_BYTES) return "too-large";
	return undefined;
}

/** A 2D canvas of the given size, preferring the offscreen kind. */
function canvasOf(width, height) {
	if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

/** Encode a canvas. `OffscreenCanvas` and `<canvas>` expose different verbs. */
async function encode(canvas, type, quality) {
	if (typeof canvas.convertToBlob === "function") return await canvas.convertToBlob({ type, quality });
	return await new Promise((resolve) => void canvas.toBlob(resolve, type, quality));
}

function blobToDataUrl(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/** Draw a bitmap into a fresh canvas at the given size. */
function render(bitmap, width, height) {
	const canvas = canvasOf(width, height);
	canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
	return canvas;
}

/**
 * Read a file's pixels into a downscaled buffer for colour analysis.
 * @returns `ImageData`, or null when the canvas cannot supply pixels (a tainted
 *   canvas cannot happen for a local file, but a zero-area one could).
 */
function sampleColours(bitmap) {
	const size = targetSize(bitmap.width, bitmap.height, SAMPLE_EDGE);
	const canvas = render(bitmap, size.width, size.height);
	return canvas.getContext("2d").getImageData(0, 0, size.width, size.height);
}

/**
 * Prepare a chosen file for storage.
 * @param file - the `File` from an `<input type="file">`.
 * @returns the stored image, its 48px thumbnail as a data URL, and the dominant
 *   colour (null when the image carries no usable hue, which is the caller's cue
 *   to ask the user for one).
 * @throws {ImageRejection} before any decode work when the file cannot be used.
 */
export async function importImage(file) {
	const rejection = rejectionFor(file);
	if (rejection !== undefined) throw new ImageRejection(rejection);

	const bitmap = await createImageBitmap(file);
	try {
		const size = targetSize(bitmap.width, bitmap.height, MAX_EDGE);

		// The stored image. If the browser cannot encode WebP it hands back
		// something else, and that is fine: the format is not worth failing over.
		const stored = await encode(render(bitmap, size.width, size.height), "image/webp", WEBP_QUALITY);
		if (stored === null) throw new Error("image: the browser could not encode the wallpaper");

		const thumbSize = targetSize(bitmap.width, bitmap.height, THUMB_EDGE);
		const thumbBlob = await encode(render(bitmap, thumbSize.width, thumbSize.height), "image/webp", THUMB_WEBP_QUALITY);

		return {
			blob: stored,
			thumb: thumbBlob === null ? undefined : await blobToDataUrl(thumbBlob),
			accent: extractDominantColor(sampleColours(bitmap)),
			width: size.width,
			height: size.height,
		};
	} finally {
		bitmap.close();
	}
}
