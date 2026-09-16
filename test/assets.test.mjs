// Guards the contract between the host half (index.mjs, which registers the
// asset route) and the web half (client/client.js, which points body's
// background-image at that route). The two halves live in different languages
// and files, so nothing but a test keeps the route prefix and the asset
// directory in sync — a drift shows up as a silently colourless backdrop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";

import { apply as applyHost } from "../index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Mount the host half against a stub ctx and return the registered routes. */
function mountRoutes() {
	const routes = [];
	const ctx = {
		effect: (fn) => fn(),
		webServer: {
			register: (route) => {
				routes.push(route);
				return () => {};
			},
		},
	};
	applyHost(ctx);
	return routes;
}

/** Drive a route's handler with a fake req/res and collect the response. */
function request(route, pathname) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const res = new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(chunk);
				callback();
			},
		});
		res.statusCode = 0;
		res.headers = {};
		res.writeHead = function (code, headers) {
			this.statusCode = code;
			if (headers !== undefined) Object.assign(this.headers, headers);
			return this;
		};
		res.setHeader = function (key, value) {
			this.headers[key] = value;
			return this;
		};
		res.on("finish", () =>
			resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
		);
		res.on("error", reject);
		route.handler({ url: pathname, method: "GET" }, res);
	});
}

/**
 * The asset prefix the web half builds its backdrop URLs from. It used to be
 * visible as a literal inside the CSS `url(...)`; it now lives in a named
 * constant, because a custom skin's image is a blob URL sharing no prefix with
 * the built-ins. The coupling to the host route is unchanged -- only its
 * spelling moved -- so this reads the constant instead of the CSS.
 */
function clientAssetPrefix() {
	const source = readFileSync(`${ROOT}client/client.js`, "utf8");
	const match = /ASSET_PREFIX\s*=\s*"([^"]+)"/.exec(source);
	assert.notEqual(match, null, "client/client.js declares no ASSET_PREFIX -- did the build run?");
	return match[1];
}

/** The asset filenames the web half references. */
function clientImageFiles() {
	const source = readFileSync(`${ROOT}client/client.js`, "utf8");
	return [...new Set([...source.matchAll(/"([a-z0-9-]+\.png)"/g)].map((match) => match[1]))];
}

test("the host half registers exactly one asset route", () => {
	const routes = mountRoutes();
	assert.equal(routes.length, 1);
	assert.equal(routes[0].kind, "prefix");
});

test("the client builds its backdrop URLs from the host's route prefix", () => {
	const [route] = mountRoutes();
	const prefix = clientAssetPrefix();
	assert.equal(prefix, route.path, `client requests ${prefix}/…, but the host serves ${route.path}/…`);
});

test("every asset the client references is served by the registered route", async () => {
	const [route] = mountRoutes();
	const files = clientImageFiles();
	assert.ok(files.length > 0, "client references no asset files");

	for (const file of files) {
		const response = await request(route, `${route.path}/${file}`);
		assert.equal(response.status, 200, `${file} answered ${response.status}`);
		assert.equal(response.headers["content-type"], "image/png", `${file} wrong content type`);
		assert.ok(response.body.length > 0, `${file} served an empty body`);
	}
});

test("unknown and traversal paths are refused", async () => {
	const [route] = mountRoutes();
	for (const pathname of [`${route.path}/nope.png`, `${route.path}/../index.mjs`]) {
		const response = await request(route, pathname);
		assert.equal(response.status, 404, `${pathname} should not be served`);
	}
});
