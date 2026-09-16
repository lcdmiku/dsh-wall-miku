// store.js owns the split that makes the boot sequence flicker-free: the
// metadata index lives in localStorage (synchronous, readable on the first
// frame), the image bytes live in IndexedDB (asynchronous, arrives a beat
// later). Two stores mean they can drift, so most of these tests are about the
// ORDER of writes and about what survives when one half fails.
//
// Nothing here reaches into the store through a test-only back door. Where a
// test needs a specific persisted state it writes that state into the injected
// storage itself, which is exactly how the store reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";

import { createStore, INDEX_KEY } from "../client/src/store.js";

/** A localStorage stand-in that can be told to fail on demand. */
function fakeStorage() {
	const map = new Map();
	return {
		failWrites: false,
		getItem(key) {
			return map.has(key) ? map.get(key) : null;
		},
		setItem(key, value) {
			if (this.failWrites) throw new DOMException("quota exceeded", "QuotaExceededError");
			map.set(key, String(value));
		},
		/** Write straight through, bypassing failWrites: test setup, not behaviour. */
		seed(key, value) {
			map.set(key, value);
		},
	};
}

function newStore(overrides = {}) {
	const storage = overrides.storage ?? fakeStorage();
	const idbFactory = overrides.idbFactory ?? new IDBFactory();
	return { storage, store: createStore({ idbFactory, storage }) };
}

function blobOf(bytes) {
	return new Blob([new Uint8Array(bytes)], { type: "image/webp" });
}

async function bytesOf(blob) {
	assert.ok(blob instanceof Blob, "expected a Blob back");
	return [...new Uint8Array(await blob.arrayBuffer())];
}

const ENTRY = {
	id: "custom-1",
	name: "我的海景",
	createdAt: 1757000000000,
	accent: {
		darkAccent: "129, 140, 248",
		darkAccentSoft: "165, 180, 252",
		lightAccent: "79, 70, 229",
		lightAccentDeep: "67, 56, 202",
	},
	accentSource: "auto",
	thumb: "data:image/webp;base64,AAAA",
};

test("an added skin comes back with its bytes intact", async () => {
	const { store } = newStore();
	const bytes = [137, 80, 78, 71, 13, 10, 26, 10];
	await store.add(ENTRY, blobOf(bytes));

	assert.deepEqual(await bytesOf(await store.blob(ENTRY.id)), bytes);
	assert.equal(store.get(ENTRY.id).name, "我的海景");
});

test("the index is readable synchronously, before any database work", () => {
	const { store } = newStore();
	// Nothing is open yet and nothing may be awaited: the first rendered frame
	// already has to know the active skin's accents.
	assert.deepEqual(store.list(), []);
	assert.equal(store.get("anything"), undefined);
});

test("a skin disappears from both halves on remove", async () => {
	const { store } = newStore();
	await store.add(ENTRY, blobOf([1, 2, 3]));
	await store.remove(ENTRY.id);

	assert.deepEqual(store.list(), []);
	assert.equal(await store.blob(ENTRY.id), undefined);
});

test("a failed index write rejects and leaves no half-registered skin", async () => {
	const { storage, store } = newStore();
	await store.add(ENTRY, blobOf([1, 2, 3]));

	storage.failWrites = true;
	await assert.rejects(() => store.add({ ...ENTRY, id: "custom-2" }, blobOf([4, 5, 6])));

	// The blob may linger -- an orphan is harmless and sweep() collects it -- but
	// the index must never list a skin whose image was never stored, because that
	// is the state the user experiences as "selected, but no wallpaper".
	assert.deepEqual(
		store.list().map((entry) => entry.id),
		[ENTRY.id],
	);
});

test("a failed blob delete still clears the skin from the index", async () => {
	const storage = fakeStorage();
	storage.seed(INDEX_KEY, JSON.stringify([ENTRY]));
	const { store } = newStore({
		storage,
		idbFactory: {
			open() {
				throw new DOMException("database is gone", "InvalidStateError");
			},
		},
	});

	await store.remove(ENTRY.id);

	// The index is the truth and the blob is an attachment, so it is cleared
	// first: a delete that cannot finish leaves debris, never a broken entry.
	assert.deepEqual(store.list(), []);
});

test("renaming changes only the label", async () => {
	const { store } = newStore();
	await store.add(ENTRY, blobOf([9, 8, 7]));
	store.rename(ENTRY.id, "猫猫");

	assert.equal(store.get(ENTRY.id).name, "猫猫");
	assert.deepEqual(await bytesOf(await store.blob(ENTRY.id)), [9, 8, 7]);
	assert.equal(store.get(ENTRY.id).accentSource, "auto");
});

test("sweep deletes blobs the index no longer knows about", async () => {
	const { storage, store } = newStore();
	await store.add(ENTRY, blobOf([1, 2, 3]));
	await store.add({ ...ENTRY, id: "custom-orphan" }, blobOf([4, 5, 6]));
	// The residue of "localStorage was cleared, IndexedDB was not".
	storage.seed(INDEX_KEY, JSON.stringify([ENTRY]));

	const swept = await store.sweep();

	assert.equal(swept, 1, "exactly the orphaned blob should be collected");
	assert.deepEqual(await store.listBlobIds(), [ENTRY.id]);
	assert.deepEqual(await bytesOf(await store.blob(ENTRY.id)), [1, 2, 3]);
});

test("a corrupt index reads as empty instead of breaking the plugin", () => {
	const storage = fakeStorage();
	storage.seed(INDEX_KEY, "{{{ not json");
	const { store } = newStore({ storage });

	// Losing the library is bad; refusing to boot is worse.
	assert.deepEqual(store.list(), []);
});

test("a failed blob write leaves nothing in the index", async () => {
	const { storage, store } = newStore();
	await store.add(ENTRY, blobOf([1, 2, 3]));

	// This is the failure the write ORDER exists to prevent. Were the index
	// written first, a blob that could not be stored would leave a skin listed
	// with no image behind it -- the "selected, but no wallpaper" state, which is
	// the one outcome the whole split is arranged to make impossible.
	const broken = newStore({
		storage,
		idbFactory: {
			open() {
				throw new DOMException("out of space", "QuotaExceededError");
			},
		},
	});
	await assert.rejects(() => broken.store.add({ ...ENTRY, id: "custom-2" }, blobOf([4, 5, 6])));

	assert.deepEqual(
		store.list().map((entry) => entry.id),
		[ENTRY.id],
	);
});
