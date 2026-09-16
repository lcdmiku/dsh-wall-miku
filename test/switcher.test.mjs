// The switcher UI, driven for real.
//
// `artifact.test.mjs` catches a bundle that cannot LOAD. This catches a bundle
// that loads and then misbehaves: it renders the registered `shell.overlay`
// component with the actual React from the profile, clicks the actual buttons,
// and reads the DOM back. Three things live only here, and each is a design risk
// no source-level test can reach:
//
//  1. RISK 3 of the design -- a nested interactive element. The row used to be
//     one `<button>`; adding the `⋮` affordance without restructuring it would
//     produce button-inside-button, which is invalid HTML: the parser splits the
//     elements apart and click behaviour becomes unpredictable. The structure
//     assertion below is what keeps that from shipping.
//  2. The custom-skin lifecycle -- list, select, rename, delete, and both import
//     paths -- end to end over localStorage + IndexedDB, so the two halves of
//     the store are exercised together rather than in isolation.
//  3. That the wallpaper actually reaches `body` and the accent family actually
//     reaches the theme layer, which is the only reason any of this exists.
//
// The browser APIs come from jsdom, plus two stubs for what jsdom lacks: a 2D
// canvas context that honours the requested fill colour (so a test can decide
// whether an image has a usable hue, and thereby which import path runs), and
// `createImageBitmap`, whose real implementation would need an image decoder.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { IDBFactory } from "fake-indexeddb";

import { createStore, INDEX_KEY } from "../client/src/store.js";
import { fromHex } from "../client/src/palette.js";

const ROOT = new URL("..", import.meta.url);
const ARTIFACT = fileURLToPath(new URL("client/client.js", ROOT));

/**
 * The library a seeding step prepared for the window under test, plus the one
 * IndexedDB every window shares.
 *
 * jsdom gives each window its own localStorage, and it becomes unusable the
 * moment that window is closed -- so the seeded index is snapshotted into this
 * plain slot rather than read back off a dead window later. It has to be
 * snapshotted because the plugin reads the index synchronously on the very first
 * frame, leaving no room for a test to interleave anything.
 */
const SEED = { index: null, factory: null };

/** The one blob database, opened on first use and reused by every window after. */
function blobFactory() {
	SEED.factory ??= new IDBFactory();
	return SEED.factory;
}

// Every test starts from an empty library on a fresh origin. Without this the
// seeded index slot leaks forward, and a test that expected four rows silently
// inherits the previous one's skin -- which is exactly the kind of cross-test
// coupling that makes a suite fail in a different order than it passes in.
beforeEach(() => {
	SEED.index = null;
	SEED.factory = new IDBFactory();
	OBJECT_URLS.clear();
});

/** Parse the handful of colour syntaxes the stub needs to understand. */
function parseCssColour(value) {
	const hex = /^#([0-9a-f]{6})$/i.exec(value);
	if (hex !== null) {
		const parsed = fromHex(`#${hex[1]}`);
		return [parsed.r, parsed.g, parsed.b];
	}
	const parts = value.match(/\d+/g) ?? ["0", "0", "0"];
	return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** A 2D context that records what was drawn instead of discarding it. */
function drawingContext() {
	let width = 0;
	let height = 0;
	let buffer = new Uint8ClampedArray(0);

	/** Allocate on demand: a canvas is sized before it has anything drawn on it. */
	const pixels = () => {
		if (buffer.length !== width * height * 4) buffer = new Uint8ClampedArray(width * height * 4);
		return buffer;
	};

	return {
		fillStyle: "#000000",
		/** Set by `stubImaging` once there is a canvas to hand this context to. */
		whenReady: null,
		fillRect() {
			const [r, g, b] = parseCssColour(this.fillStyle);
			const data = pixels();
			for (let at = 0; at < data.length; at += 4) {
				data[at] = r;
				data[at + 1] = g;
				data[at + 2] = b;
				data[at + 3] = 255;
			}
		},
		getImageData: () => ({ data: pixels(), width, height }),
		drawImage() {},
		resize(nextWidth, nextHeight) {
			width = nextWidth;
			height = nextHeight;
		},
	};
}

/**
 * Stub the two browser capabilities jsdom does not provide.
 *
 * `importImage` reaches the DOM through `document.createElement("canvas")` and
 * the global `createImageBitmap`, so stubbing those is the whole interception --
 * no production module grows a test-only seam for this.
 * @param paint - called with each new canvas; fills it with a chosen colour,
 *   which is how a test selects between the auto and manual import paths.
 */
function stubImaging(paint) {
	const previous = {
		createImageBitmap: Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap"),
		offscreen: Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas"),
		createElement: globalThis.document.createElement,
	};

	// Node ships a real `OffscreenCanvas` global, and the plugin prefers it. Its
	// context needs a native canvas addon this environment does not have, so it
	// is removed for the duration and the code falls to `document.createElement`
	// -- the documented fallback, exercised rather than stubbed around.
	delete globalThis.OffscreenCanvas;

	// A small fixed "photo". Sizing this by the blob's byte count -- as an
	// earlier version did -- turns a large data URL into a canvas with millions
	// of pixels, and the stubbed fill walks every one of them.
	globalThis.createImageBitmap = async () => ({ width: 64, height: 48, close() {} });

	const createElement = globalThis.document.createElement.bind(globalThis.document);
	globalThis.document.createElement = (tag, ...rest) => {
		const element = createElement(tag, ...rest);
		if (tag !== "canvas") return element;
		// `whenReady` is wired BEFORE the size properties are installed: the
		// first dimension assignment fires the paint, so setting it afterwards
		// left the first canvas of every render unpainted, and a zero-filled
		// buffer reads to palette.js as "no usable hue".
		const context = { ...drawingContext(), whenReady: paint };
		element.getContext = () => context;
		// jsdom implements no canvas encoding at all, so this stands in for both
		// `toBlob` and `convertToBlob`. The bytes are irrelevant -- only that
		// something Blob-shaped comes back for the wallpaper and the thumbnail.
		element.toBlob = (callback) => {
			callback(new globalThis.Blob([new Uint8Array(ENCODED)], { type: "image/webp" }));
		};
		// `render()` assigns width and height, then draws, then reads the pixels
		// back -- all synchronously. The paint therefore has to happen at the
		// resize, not on a later microtask. It waits for BOTH dimensions: the
		// first assignment arrives while the other is still undefined, and
		// painting then would allocate a zero-length buffer.
		let sized;
		const size = (edge, value) => {
			sized = { width: 0, height: 0, ...sized, [edge]: value };
			if (!Number.isFinite(sized.width) || !Number.isFinite(sized.height)) return;
			context.resize(sized.width, sized.height);
			paint(element, context);
		};
		Object.defineProperty(element, "width", { set: (value) => size("width", value), configurable: true });
		Object.defineProperty(element, "height", { set: (value) => size("height", value), configurable: true });
		return element;
	};

	return () => {
		if (previous.createImageBitmap === undefined) delete globalThis.createImageBitmap;
		else Object.defineProperty(globalThis, "createImageBitmap", previous.createImageBitmap);
		if (previous.offscreen === undefined) delete globalThis.OffscreenCanvas;
		else Object.defineProperty(globalThis, "OffscreenCanvas", previous.offscreen);
		globalThis.document.createElement = previous.createElement;
	};
}

/** A `File`-shaped object the upfront checks accept. */
function imageFile({ name = "wall.png", type = "image/png", size = 4096 } = {}) {
	return { name, type, size };
}

/** Bytes standing in for an encoded image. Kept tiny: only their presence matters. */
const ENCODED = [137, 80, 78, 71];

/** A fresh jsdom document plus the globals the plugin reaches for at runtime. */
function installDom() {
	const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:3080/" });
	const { window } = dom;

	const previous = new Map();
	const globals = [
		"window", "document", "localStorage", "FileReader", "Blob", "File",
		"DOMException", "indexedDB", "URL", "navigator", "crypto",
	];
	for (const key of globals) previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));

	/** Install one global, tolerating the getter-only ones Node defines. */
	const put = (key, value) => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (descriptor !== undefined && descriptor.set === undefined) {
			// `crypto` and `navigator` are accessor-only on Node's globalThis, so a
			// plain assignment throws. Replacing the whole descriptor is the only
			// way in, and `restore` puts the original back verbatim.
			Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
			return;
		}
		globalThis[key] = value;
	};

	put("window", window);
	put("document", window.document);
	put("localStorage", window.localStorage);
	// The window's Blob/File/FileReader are used as a set: the thumbnail path
	// reads a Blob back through a FileReader, and mixing Node's classes with
	// jsdom's reader is the kind of mismatch that fails for unrelated reasons.
	put("Blob", window.Blob);
	put("File", window.File);
	put("FileReader", window.FileReader);
	put("DOMException", window.DOMException);
	put("URL", window.URL);
	put("crypto", window.crypto);
	put("indexedDB", blobFactory());

	// jsdom has no `URL.createObjectURL` at all. Without a stand-in the plugin
	// would take its "the image is gone" path on every custom skin, which is a
	// real branch -- so this stubs the API rather than the branch, keeping the
	// test honest about which code path it exercised.
	const restoreObjectUrls = stubObjectUrls(window.URL);

	// The seeded index is consumed exactly once. Clearing the slot is what keeps
	// a seeded library from leaking into the tests that follow, which would
	// otherwise make each test depend on the ones before it.
	if (SEED.index !== null) globalThis.localStorage.setItem(INDEX_KEY, SEED.index);
	SEED.index = null;

	return {
		window,
		restore() {
			restoreObjectUrls();
			for (const [key, descriptor] of previous) {
				if (descriptor === undefined) delete globalThis[key];
				else Object.defineProperty(globalThis, key, descriptor);
			}
			dom.window.close();
		},
	};
}

/**
 * Stand in for the object-URL pair jsdom does not implement.
 *
 * A URL that stays resolvable for exactly as long as it has not been revoked is
 * what the plugin's lifecycle depends on: revoking the previous skin's URL is
 * how it avoids leaking a multi-megabyte image per switch. So the registry is
 * kept and `resolve` is exposed for tests that want to check that pairing.
 */
const OBJECT_URLS = new Map();

function stubObjectUrls(url) {
	let next = 0;
	url.createObjectURL = (blob) => {
		const objectUrl = `blob:http://127.0.0.1:3080/${String((next += 1))}`;
		OBJECT_URLS.set(objectUrl, blob);
		return objectUrl;
	};
	url.revokeObjectURL = (objectUrl) => void OBJECT_URLS.delete(objectUrl);
	return () => {
		delete url.createObjectURL;
		delete url.revokeObjectURL;
	};
}

/** Load the built bundle and hand back the module it registers. */
async function loadBundle() {
	const captured = [];
	globalThis.window.__ModuleLoader__ = { load: (options) => void captured.push(options) };
	// A unique query sidesteps the ESM module cache so each mount re-executes.
	await import(`../client/client.js?switcher=${String(Date.now())}${String(Math.random())}`);
	assert.equal(captured.length, 1, "the bundle must register exactly one module");
	return captured[0];
}

/**
 * Boot the plugin against a recording ctx and render its switcher with the menu
 * already open.
 * @param paint - optional canvas painter; when given, the imaging stubs are
 *   installed too, which is what the import tests need and nothing else does.
 * @returns handles for driving the rendered tree.
 */
async function mount(paint) {
	const dom = installDom();
	// After installDom, never before: the stub wraps `document.createElement`.
	const restoreImaging = paint === undefined ? undefined : stubImaging(paint);
	const React = (await import("react")).default;
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;

	const registered = [];
	const themes = [];
	const disposers = [];
	const ctx = {
		effect: (factory) => {
			const dispose = factory();
			disposers.push(typeof dispose === "function" ? dispose : () => {});
			return () => {};
		},
		// No locale service: the plugin must fall back to English keys, which is
		// also what makes the assertions below readable.
		get: () => undefined,
		theme: {
			overrideTokens: (source, overrides) => {
				themes.push({ source, overrides });
				return () => {};
			},
		},
		slots: {
			inject: (_name, callback) => callback(),
			register: (options, component) => void registered.push({ options, component }),
		},
	};

	const module = await loadBundle();
	const plugin = module.factory((id) => {
		assert.equal(id, "react", "the bundle may only require react, and only from its factory");
		return React;
	});
	plugin.apply(ctx);
	assert.equal(registered.length, 1, "apply must register exactly one overlay slot");
	assert.equal(registered[0].options.name, "shell.overlay");

	const container = dom.window.document.createElement("div");
	dom.window.document.body.appendChild(container);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(container);

	const act = React.act;
	const api = {
		dom,
		React,
		act,
		ctx,
		themes,
		/** The most recent theme layer, which is the one in force. */
		theme: () => themes.at(-1).overrides,
		filePicker: () => dom.window.document.head.querySelector("input[type=file]"),
		backdrop: () => dom.window.document.getElementById("dsh-skin-miku-css").textContent,
		find: (selector) => container.querySelector(selector),
		all: (selector) => [...container.querySelectorAll(selector)],
		byText: (selector, text) =>
			[...container.querySelectorAll(selector)].find((node) => node.textContent.includes(text)),
		click: async (element) => {
			assert.ok(element, "clicked a selector that matched nothing");
			await act(async () => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
		},
		/**
		 * Set an input's value so React's `onChange` actually fires.
		 *
		 * React reads the DOM value through its own tracker, so assigning
		 * `element.value` makes the tracker report "unchanged" and the handler is
		 * skipped -- silently. Going through the prototype's native setter is what
		 * makes the change observable, and it is how every real browser behaves.
		 */
		setValue: (element, value) => {
			const prototype = Object.getPrototypeOf(element);
			const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
			descriptor.set.call(element, value);
		},
		/**
		 * Type into an input the way a browser does, then commit by taking focus
		 * away. React 19 delegates `onBlur` through the bubbling `focusout`
		 * event, so a plain `blur` -- which does not bubble -- never reaches the
		 * handler, and the field would silently never commit.
		 */
		type: async (input, value) => {
			await act(async () => {
				input.focus();
				api.setValue(input, value);
				input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
				input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
				input.dispatchEvent(new dom.window.FocusEvent("blur", { bubbles: false }));
			});
			await api.settle();
		},
		/** Move a range slider: jsdom's value setter ignores `type=range`. */
		slide: async (input, value) => {
			await act(async () => {
				input.setAttribute("value", value);
				api.setValue(input, value);
				input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
				input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
			});
			await api.settle();
		},
		/** Hand a file to the plugin the way the hidden input would. */
		importFile: async (file) => {
			const picker = api.filePicker();
			assert.ok(picker, "the plugin must install its file input");
			Object.defineProperty(picker, "files", { value: [file], configurable: true });
			await act(async () => picker.dispatchEvent(new dom.window.Event("change", { bubbles: false })));
			await api.settle();
		},
		/**
		 * Let the plugin's queued work finish inside act().
		 *
		 * An import walks two IndexedDB round trips and a FileReader before the
		 * wallpaper lands, and `act` only awaits what is already queued -- so a
		 * fixed number of turns is a guess, and guessing short is what makes a
		 * suite pass alone and fail in a group. Every visible change the plugin
		 * makes goes through `theme.overrideTokens`, so that counter is the signal:
		 * drain until it has been still for several turns.
		 */
		settle: async () => {
			await act(async () => {
				let quiet = 0;
				for (let turn = 0; turn < 200 && quiet < 4; turn += 1) {
					const before = themes.length;
					await new Promise((resolve) => setTimeout(resolve, 0));
					quiet = themes.length === before ? quiet + 1 : 0;
				}
			});
		},
		unmount: async () => {
			await act(async () => root.unmount());
			for (const dispose of disposers) dispose();
			if (restoreImaging !== undefined) restoreImaging();
			dom.restore();
		},
	};

	await act(async () => root.render(React.createElement(registered[0].component)));
	await api.click(api.find(".dshSkinSwitcherBtn"));
	assert.ok(api.find(".dshSkinSwitcherMenu"), "the switcher button must open the menu");
	return api;
}

/**
 * Seed the library the way an earlier session would have left it.
 *
 * The blob half goes through the real store into a real IndexedDB, so a seeding
 * bug cannot cancel out a reading bug. The index half is snapshotted, because
 * the window it would be written into is gone by the time `mount()` builds the
 * one that reads it -- and the plugin reads synchronously on the first frame, so
 * it must already be in place by then.
 */
async function seedCustom({ id = "custom-1", name = "我的海景", accent, thumb = "data:image/webp;base64,AAAA" } = {}) {
	const entry = {
		id,
		name,
		createdAt: 1757000000000,
		accent: accent ?? {
			darkAccent: "129, 140, 248",
			darkAccentSoft: "165, 180, 252",
			lightAccent: "79, 70, 229",
			lightAccentDeep: "67, 56, 202",
		},
		accentSource: "auto",
		thumb,
	};

	// A throwaway window to seed into; the blob database is shared with the
	// window that will read it.
	const seeding = installDom();
	try {
		const store = createStore({ idbFactory: blobFactory(), storage: globalThis.localStorage });
		await store.add(entry, new globalThis.Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" }));
	} finally {
		seeding.restore();
	}
	SEED.index = JSON.stringify([entry]);
	return entry;
}

test("the menu lists every built-in skin and nests no interactive element", async () => {
	const app = await mount();
	try {
		const items = app.all(".dshSkinSwitcherItem");
		assert.equal(items.length, 5, "all five built-in skins must be listed");
		assert.deepEqual(
			items.map((item) => item.textContent),
			// The active one carries the tick; Ninja is the default.
			["Ninja✓", "Sakura", "Bamboo", "Ronin", "Ryujin"],
		);
		assert.equal(app.all(".dshSkinSwitcherCheck").length, 1, "exactly one skin may read as active");

		// RISK 3: the row's `⋮` affordance must not have been added INSIDE the
		// selecting button. A nested button is split apart by the parser, so the
		// mistake is invisible in the source and total in the browser.
		assert.equal(app.all(".dshSkinSwitcherRow button button").length, 0, "no button may nest inside a button");
		assert.equal(app.all("button.dshSkinSwitcherItem").length, 5);
		assert.equal(app.all(".dshSkinSwitcherDot").length, 5, "built-ins identify themselves by colour dot");
		assert.equal(app.all("img.dshSkinSwitcherThumb").length, 0, "no custom skin means no thumbnails");
		assert.ok(app.find(".dshSkinSwitcherAdd"), "the add affordance must be reachable");
		assert.ok(app.find(".dshSkinSwitcherOpacity input[type=range]"), "the opacity slider must stay");
	} finally {
		await app.unmount();
	}
});

test("choosing a built-in skin moves both the accents and the wallpaper", async () => {
	const app = await mount();
	try {
		const before = app.backdrop();
		await app.click(app.byText(".dshSkinSwitcherItem", "Sakura"));

		// A choice closes the menu, so the whole flow is one click deep.
		assert.equal(app.find(".dshSkinSwitcherMenu"), null, "selecting a skin closes the menu");
		assert.equal(globalThis.localStorage.getItem("dsh-skin-miku:skin"), "sakura");

		const accents = app.theme();
		assert.equal(accents["--dsw-alias-brand-primary"].light, "rgb(225, 29, 72)", "sakura's light accent");
		assert.equal(accents["--dsw-alias-brand-primary"].dark, "rgb(251, 113, 133)", "sakura's dark accent");

		const backdrop = app.backdrop();
		assert.notEqual(backdrop, before, "the backdrop stylesheet must be rewritten");
		assert.match(backdrop, /\/skin-miku\/sakura-light\.png/);
		assert.match(backdrop, /\/skin-miku\/sakura-dark\.png/);
	} finally {
		await app.unmount();
	}
});

test("a custom skin is listed with its real thumbnail, not a colour dot", async () => {
	const entry = await seedCustom();
	const app = await mount();
	try {
		// apply() reads the index synchronously, so a library seeded beforehand is
		// already listed on the very first frame this component renders.
		const thumb = app.find("img.dshSkinSwitcherThumb");
		assert.ok(thumb, "a custom skin must render its thumbnail, not a dot");
		assert.equal(thumb.getAttribute("src"), entry.thumb);
		assert.equal(app.all(".dshSkinSwitcherDot").length, 5, "the built-ins keep their dots");
		assert.equal(app.byText(".dshSkinSwitcherName", "我的海景").textContent, "我的海景");
		assert.equal(app.find(".dshSkinSwitcherSection").textContent, "My skins");
	} finally {
		await app.unmount();
	}
});

test("a custom skin's accent reaches the theme layer and its blob reaches body", async () => {
	const entry = await seedCustom();
	const app = await mount();
	try {
		await app.click(app.byText(".dshSkinSwitcherItem", "我的海景"));
		await app.settle();

		const accents = app.theme();
		assert.equal(accents["--dsw-alias-brand-primary"].light, `rgb(${entry.accent.lightAccent})`);
		assert.equal(accents["--dsw-alias-brand-primary"].dark, `rgb(${entry.accent.darkAccent})`);
		assert.equal(globalThis.localStorage.getItem("dsh-skin-miku:skin"), entry.id);

		// The image arrives one database round trip after the colours, which is
		// the point of the split: the frame painted first is already correct.
		const backdrop = app.backdrop();
		assert.match(backdrop, /body \{[\s\S]*url\('blob:/, "the light scheme must use the skin's own blob");
		assert.match(backdrop, /data-ds-dark-theme[\s\S]*url\('blob:/, "and so must the dark one");
	} finally {
		await app.unmount();
	}
});

test("an image with no usable hue asks for a colour instead of inventing one", async () => {
	const app = await mount((_element, context) => {
		context.fillStyle = "#808080";
		context.fillRect(0, 0, 1, 1);
	});
	try {
		await app.importFile(imageFile());

		assert.ok(app.find(".dshSkinSwitcherPicker"), "the picker must replace the list");
		assert.equal(app.find(".dshSkinSwitcherList"), null, "the picker takes over the panel");
		assert.ok(app.find(".dshSkinSwitcherPicker input[type=color]"), "the picker needs a colour input");

		await app.click(app.byText(".dshSkinSwitcherPicker button", "Cancel"));
		assert.equal(app.find(".dshSkinSwitcherPicker"), null);
		assert.ok(app.find(".dshSkinSwitcherList"), "cancelling returns to the list");

		// Closing the menu while the question is up abandons the import: the
		// image was never written, and reopening must not resurrect the picker
		// for a file the user walked away from.
		await app.importFile(imageFile());
		assert.ok(app.find(".dshSkinSwitcherPicker"), "the picker must come back for the new file");
		await app.click(app.find(".dshSkinSwitcherBtn"));
		await app.click(app.find(".dshSkinSwitcherBtn"));
		assert.equal(app.find(".dshSkinSwitcherPicker"), null, "a reopened menu starts from the list");

		assert.equal(globalThis.localStorage.getItem(INDEX_KEY), null, "an abandoned import is never stored");
	} finally {
		await app.unmount();
	}
});

test("a hue the image does have is taken automatically", async () => {
	const app = await mount((_element, context) => {
		context.fillStyle = "#3b5bdb";
		context.fillRect(0, 0, 1, 1);
	});
	try {
		await app.importFile(imageFile());

		assert.equal(app.find(".dshSkinSwitcherPicker"), null, "a usable hue needs no question");
		const entries = JSON.parse(globalThis.localStorage.getItem(INDEX_KEY));
		assert.equal(entries.length, 1);
		assert.equal(entries[0].accentSource, "auto");
		assert.match(entries[0].thumb, /^data:image\/webp;base64,/);
		assert.equal(globalThis.localStorage.getItem("dsh-skin-miku:skin"), entries[0].id);

		// The stored accent is the wallpaper's HUE held at the role's own
		// lightness -- not the sampled colour pasted in unchanged, which is the
		// entire reason palette.js does OKLCH maths.
		const accents = app.theme();
		assert.notEqual(accents["--dsw-alias-brand-primary"].light, "rgb(59, 91, 219)");
		assert.equal(accents["--dsw-alias-brand-primary"].light, `rgb(${entries[0].accent.lightAccent})`);
		assert.match(app.backdrop(), /url\('blob:/, "the imported image must become the wallpaper");
		assert.ok(app.byText(".dshSkinSwitcherItem", entries[0].name), "the new skin must be listed and selected");
	} finally {
		await app.unmount();
	}
});

test("the picker's chosen colour is stored as manual and drives the accents", async () => {
	const app = await mount((_element, context) => {
		context.fillStyle = "#808080";
		context.fillRect(0, 0, 1, 1);
	});
	try {
		await app.importFile(imageFile());
		const input = app.find(".dshSkinSwitcherPicker input[type=color]");
		// Prefilled with the accent in force, so accepting is never an
		// invisible no-op.
		assert.match(input.getAttribute("value"), /^#[0-9a-f]{6}$/);

		await app.click(app.byText(".dshSkinSwitcherPicker button", "Use this colour"));
		await app.settle();

		const entries = JSON.parse(globalThis.localStorage.getItem(INDEX_KEY));
		assert.equal(entries.length, 1);
		assert.equal(entries[0].accentSource, "manual", "a picked colour is recorded as picked");
		assert.equal(globalThis.localStorage.getItem("dsh-skin-miku:skin"), entries[0].id);
		assert.equal(app.theme()["--dsw-alias-brand-primary"].light, `rgb(${entries[0].accent.lightAccent})`);
	} finally {
		await app.unmount();
	}
});

test("renaming edits the label in place and leaves the rest of the entry alone", async () => {
	const entry = await seedCustom();
	const app = await mount();
	try {
		await app.click(app.find(".dshSkinSwitcherMore"));
		await app.click(app.byText(".dshSkinSwitcherConfirm button", "Rename"));

		const input = app.find("input.dshSkinSwitcherInput");
		assert.ok(input, "renaming must happen in place, not in a dialog");
		await app.type(input, "猫猫");

		const stored = JSON.parse(globalThis.localStorage.getItem(INDEX_KEY));
		assert.equal(stored.length, 1);
		assert.equal(stored[0].id, entry.id);
		assert.equal(stored[0].name, "猫猫");
		assert.deepEqual(stored[0].accent, entry.accent, "renaming must not disturb the accent");
		assert.equal(stored[0].accentSource, "auto");
		assert.equal(app.byText(".dshSkinSwitcherName", "猫猫").textContent, "猫猫");
	} finally {
		await app.unmount();
	}
});

test("deleting asks once, then clears both halves of the store", async () => {
	const entry = await seedCustom();
	const app = await mount();
	try {
		await app.click(app.find(".dshSkinSwitcherMore"));
		await app.click(app.byText(".dshSkinSwitcherConfirm button", "Delete"));

		// One confirmation, in place. It has to be a question AND a distinct
		// action label: reusing the question text as the button made the two
		// indistinguishable to anyone reading the panel.
		const confirm = app.find(".dshSkinSwitcherConfirm");
		assert.ok(confirm, "deleting must ask first");
		assert.ok(confirm.textContent.includes("Delete this skin?"), "the question must be shown");
		assert.ok(confirm.textContent.includes("Delete it"), "and an action button that names the act");

		await app.click(app.byText(".dshSkinSwitcherConfirm button", "Delete it"));
		await app.settle();

		assert.deepEqual(JSON.parse(globalThis.localStorage.getItem(INDEX_KEY) ?? "[]"), []);
		const store = createStore({ idbFactory: globalThis.indexedDB, storage: globalThis.localStorage });
		assert.equal(
			await store.blob(entry.id),
			undefined,
			"the bytes must go too, or the library leaks a megabyte per delete",
		);

		// Like choosing a skin, a completed delete leaves the panel closed, so the
		// list has to be reopened before it can be read.
		assert.equal(app.find(".dshSkinSwitcherMenu"), null, "a completed action closes the panel");
		await app.click(app.find(".dshSkinSwitcherBtn"));
		assert.equal(app.all(".dshSkinSwitcherItem").length, 5, "only the built-ins are left");
		assert.equal(app.all("img.dshSkinSwitcherThumb").length, 0, "and no thumbnail survives it");
	} finally {
		await app.unmount();
	}
});

test("an unreadable image is refused with a reason instead of failing silently", async () => {
	const app = await mount();
	try {
		await app.importFile(imageFile({ type: "application/pdf" }));
		const notice = app.find(".dshSkinSwitcherNotice[data-error]");
		assert.ok(notice, "a refusal must be visible");
		assert.equal(notice.textContent, "Please choose an image file");
		assert.equal(globalThis.localStorage.getItem(INDEX_KEY), null);

		await app.importFile(imageFile({ type: "image/svg+xml" }));
		assert.equal(app.find(".dshSkinSwitcherNotice[data-error]").textContent, "SVG is not supported yet — use PNG/JPEG/WebP");
	} finally {
		await app.unmount();
	}
});

test("the opacity slider keeps its subject and re-derives the surfaces", async () => {
	const app = await mount();
	try {
		const before = app.theme()["--dsw-alias-bg-base"].dark;
		await app.slide(app.find(".dshSkinSwitcherOpacity input[type=range]"), "0");

		assert.equal(globalThis.localStorage.getItem("dsh-skin-miku:opacity"), "0");
		assert.notEqual(app.theme()["--dsw-alias-bg-base"].dark, before, "lower transparency means denser surfaces");
		// Alpha is capped just below opaque so the artwork always reads through.
		const alpha = Number(/rgba\([^)]*?,\s*([\d.]+)\)/.exec(app.theme()["--dsw-alias-bg-base"].dark)[1]);
		assert.ok(alpha <= 0.98, `surface alpha ${String(alpha)} must stay below opaque`);
	} finally {
		await app.unmount();
	}
});

test("the built artifact is newer than every source it was built from", () => {
	// The other artifact test checks this too; it is repeated here because this
	// file asserts against the bundle's BEHAVIOUR, and a stale bundle would let
	// every assertion above pass while the shipped file diverged from source.
	const built = statSync(ARTIFACT).mtimeMs;
	const source = statSync(fileURLToPath(new URL("client/src/index.js", ROOT))).mtimeMs;
	assert.ok(built >= source, "client/client.js is older than client/src/index.js -- run: npm run build");
	assert.match(readFileSync(ARTIFACT, "utf8"), /dshSkinSwitcherPicker/, "the bundle lacks the import UI");
});
