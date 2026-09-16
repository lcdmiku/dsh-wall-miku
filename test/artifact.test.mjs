// Smoke test for the BUILT artifact.
//
// Two failure modes this exists to catch, neither of which any source-level test
// can see:
//
//  1. esbuild hoisting the factory's `require` out of the factory. The plugin is
//     loaded as `factory: (require) => {...}`, so `require` is a PARAMETER, not a
//     global. If any module ever writes `import React from "react"`, esbuild
//     emits `require("react")` at the top of the IIFE -- outside the factory --
//     and the bundle throws the moment the plugin is actually loaded. Nothing in
//     `client/src/` would fail; only the bundle does.
//  2. Editing `client/src/` and forgetting to rebuild. The tests that matter
//     read `client/client.js`, so a stale artifact would keep them green while
//     the shipped file silently diverges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("..", import.meta.url);
const ARTIFACT = fileURLToPath(new URL("client/client.js", ROOT));
const SOURCES = [
	"client/src/index.js",
	"client/src/palette.js",
].map((relative) => fileURLToPath(new URL(relative, ROOT)));

test("the artifact is not older than the sources it was built from", () => {
	const built = statSync(ARTIFACT).mtimeMs;
	for (const source of SOURCES) {
		const edited = statSync(source).mtimeMs;
		assert.ok(
			built >= edited,
			`${source.split(/[\\/]/).pop()} is newer than client/client.js -- run: npm run build`,
		);
	}
});

/** Install the minimum globals the bundle touches at load and at apply time. */
function installStubs() {
	const head = [];
	const listeners = new Map();
	const previous = {
		window: Object.getOwnPropertyDescriptor(globalThis, "window"),
		document: Object.getOwnPropertyDescriptor(globalThis, "document"),
		localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
	};

	const stored = new Map();
	globalThis.localStorage = {
		getItem: (key) => (stored.has(key) ? stored.get(key) : null),
		setItem: (key, value) => void stored.set(key, String(value)),
	};
	globalThis.document = {
		head: { appendChild: (node) => void head.push(node) },
		createElement: () => ({
			id: "",
			textContent: "",
			remove() {
				const at = head.indexOf(this);
				if (at >= 0) head.splice(at, 1);
			},
		}),
	};

	return {
		head,
		listeners,
		restore() {
			for (const [key, descriptor] of Object.entries(previous)) {
				if (descriptor === undefined) delete globalThis[key];
				else Object.defineProperty(globalThis, key, descriptor);
			}
		},
	};
}

/** Load the bundle, run its factory, and hand back the plugin's exports. */
async function loadPlugin() {
	const captured = [];
	globalThis.window = {
		__ModuleLoader__: { load: (options) => void captured.push(options) },
	};
	// A unique query sidesteps the ESM module cache, so a second load re-executes.
	await import(`../client/client.js?smoke=${String(Date.now())}${String(Math.random())}`);
	assert.equal(captured.length, 1, "the bundle must register exactly one module");
	return captured[0];
}

test("the bundle loads and exposes the plugin contract", async () => {
	const stubs = installStubs();
	try {
		const options = await loadPlugin();
		assert.equal(options.id, "dsh-skin-miku");

		// If esbuild hoisted the require, this call is where it blows up.
		const plugin = options.factory((id) => {
			assert.equal(id, "react");
			return {};
		});

		assert.equal(plugin.name, "dsh-skin-miku");
		assert.deepEqual(plugin.inject, ["theme", "slots"]);
		assert.equal(typeof plugin.apply, "function");
	} finally {
		stubs.restore();
	}
});

test("apply registers a full theme layer and a switcher slot", async () => {
	const stubs = installStubs();
	try {
		const options = await loadPlugin();
		const React = {
			createElement: () => null,
			Fragment: {},
			useState: () => [false, () => {}],
			useEffect: () => {},
			useReducer: () => [0, () => {}],
		};
		const plugin = options.factory(() => React);

		let tokens = null;
		let registered = null;
		const ctx = {
			effect: (factory) => factory(),
			get: () => undefined,
			theme: {
				overrideTokens: (source, overrides) => {
					tokens = { source, overrides };
					return () => {};
				},
			},
			slots: {
				inject: (_name, callback) => callback(),
				register: (options_, component) => {
					registered = { options: options_, component };
					return () => {};
				},
			},
		};

		plugin.apply(ctx);

		assert.notEqual(tokens, null, "apply must install a token layer");
		assert.ok(tokens.source.length > 0, "overrideTokens needs a non-empty source");

		// The theme service validates this shape at runtime: every value must be an
		// object carrying BOTH modes as strings. A single-mode value throws there,
		// so it is worth failing here instead.
		const entries = Object.entries(tokens.overrides);
		assert.ok(entries.length > 0, "the layer must not be empty");
		for (const [name, value] of entries) {
			assert.equal(typeof name, "string");
			assert.equal(typeof value, "object", `${name} must be a { light, dark } pair`);
			assert.equal(typeof value.light, "string", `${name}.light must be a string`);
			assert.equal(typeof value.dark, "string", `${name}.dark must be a string`);
		}

		assert.notEqual(registered, null, "apply must register the switcher");
		assert.equal(registered.options.name, "shell.overlay");
		assert.equal(typeof registered.component, "function");

		// The backdrop stylesheet is the only place the wallpaper URLs live.
		const backdrop = stubs.head.find((node) => node.id === "dsh-skin-miku-css");
		assert.notEqual(backdrop, undefined, "the backdrop style element must be installed");
		assert.match(backdrop.textContent, /\/skin-miku\/[a-z-]+\.png/);
	} finally {
		stubs.restore();
	}
});

test("the artifact contains no require outside the factory parameter", () => {
	const source = readFileSync(ARTIFACT, "utf8");
	// Deliberately no \b: esbuild names its CommonJS shim `__require`, and a word
	// boundary would skip it -- which is exactly the shape the hoisting bug takes.
	const calls = [...source.matchAll(/require\w*\s*\(/g)];
	const factoryAt = source.indexOf("factory:");
	assert.ok(factoryAt >= 0, "the artifact no longer declares a factory");
	for (const call of calls) {
		assert.ok(
			call.index > factoryAt,
			`a require call escaped the factory at offset ${String(call.index)}`,
		);
	}
	assert.equal(
		calls.length,
		1,
		`expected exactly one require call (the factory parameter), found ${String(calls.length)}`,
	);
});
