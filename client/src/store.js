/**
 * Persistence for user-imported skins, split deliberately across two stores.
 *
 * localStorage holds the metadata INDEX: small, JSON, and -- the whole point --
 * SYNCHRONOUS. The first rendered frame has to know which skin is active and
 * what its accents are, and only a synchronous read can deliver that. IndexedDB
 * holds the image BYTES, which are far too large for localStorage and only
 * needed a beat later.
 *
 * Two stores can drift, so the rules are:
 *
 *   - The index is the truth; the blob is an attachment.
 *   - Add writes the blob FIRST, so a failure can only leave an orphan blob
 *     (harmless, collected by {@link Store.sweep}) and never an index entry
 *     pointing at an image that was never stored. The state the user would
 *     experience as "selected, but no wallpaper" is the one we refuse to create.
 *   - Remove clears the index FIRST and tolerates a failed blob delete, for the
 *     same reason read the other way round.
 *
 * Dependencies are injected (`idbFactory`, `storage`) so the module can be tested
 * in node without a browser and without a test-only back door.
 */

/** localStorage key holding the custom-skin index. Part of the persisted format. */
export const INDEX_KEY = "dsh-skin-miku:custom";

const DB_NAME = "dsh-skin-miku";
const DB_VERSION = 1;
const BLOB_STORE = "blobs";

/**
 * @param idbFactory - an `IDBFactory`; production passes the global `indexedDB`.
 * @param storage - a `Storage`-like object; production passes `localStorage`.
 */
export function createStore({ idbFactory, storage }) {
	let opening;

	/** Open (once) the blob database, creating the object store on first run. */
	function openDb() {
		if (opening === undefined) {
			opening = new Promise((resolve, reject) => {
				const request = idbFactory.open(DB_NAME, DB_VERSION);
				request.onupgradeneeded = () => {
					const db = request.result;
					if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
				};
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		}
		return opening;
	}

	/** Run one request against the blob store and resolve with its result. */
	async function withBlobs(mode, build) {
		const db = await openDb();
		return await new Promise((resolve, reject) => {
			const transaction = db.transaction(BLOB_STORE, mode);
			const request = build(transaction.objectStore(BLOB_STORE));
			transaction.oncomplete = () => resolve(request.result);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
	}

	/** Parse the index. A corrupt value reads as empty: losing the library beats refusing to boot. */
	function readIndex() {
		const raw = storage.getItem(INDEX_KEY);
		if (raw === null) return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	/** Replace the index. Throws (quota, private mode) rather than failing silently. */
	function writeIndex(entries) {
		storage.setItem(INDEX_KEY, JSON.stringify(entries));
	}

	return {
		/** Every custom skin, synchronously, in insertion order. */
		list: () => readIndex(),

		/** One custom skin's metadata, or undefined. Synchronous by design. */
		get: (id) => readIndex().find((entry) => entry.id === id),

		/** Store a new skin. Rejects if the blob or the index write fails. */
		async add(entry, blob) {
			await withBlobs("readwrite", (blobs) => blobs.put(blob, entry.id));
			writeIndex([...readIndex(), entry]);
		},

		/**
		 * Drop a skin. Never rejects on the blob half: once the index no longer
		 * lists the skin it is gone as far as the user is concerned, and reporting
		 * an error for a deletion that visibly succeeded would be a lie. Any blob
		 * left behind is collected by {@link sweep}.
		 */
		async remove(id) {
			writeIndex(readIndex().filter((entry) => entry.id !== id));
			try {
				await withBlobs("readwrite", (blobs) => blobs.delete(id));
			} catch {
				// Deliberate: see above.
			}
		},

		/** Change only the label. Rejects if the index write fails. */
		rename(id, name) {
			writeIndex(readIndex().map((entry) => (entry.id === id ? { ...entry, name } : entry)));
		},

		/** The stored image for a skin, or undefined. */
		blob: (id) => withBlobs("readonly", (blobs) => blobs.get(id)),

		/** Every blob key currently in the database, indexed or not. */
		listBlobIds: () => withBlobs("readonly", (blobs) => blobs.getAllKeys()),

		/**
		 * Delete blobs the index no longer references, so a half-cleared browser
		 * profile heals itself instead of leaking megabytes. Returns how many went.
		 */
		async sweep() {
			const indexed = new Set(readIndex().map((entry) => entry.id));
			const orphans = (await withBlobs("readonly", (blobs) => blobs.getAllKeys())).filter(
				(id) => !indexed.has(id),
			);
			for (const id of orphans) {
				await withBlobs("readwrite", (blobs) => blobs.delete(id));
			}
			return orphans.length;
		},
	};
}
