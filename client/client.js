"use strict";
(() => {
  // client/src/store.js
  var INDEX_KEY = "dsh-skin-miku:custom";
  var DB_NAME = "dsh-skin-miku";
  var DB_VERSION = 1;
  var BLOB_STORE = "blobs";
  function createStore({ idbFactory, storage }) {
    let opening;
    function openDb() {
      if (opening === void 0) {
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
        }
      },
      /** Change only the label. Rejects if the index write fails. */
      rename(id, name) {
        writeIndex(readIndex().map((entry) => entry.id === id ? { ...entry, name } : entry));
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
          (id) => !indexed.has(id)
        );
        for (const id of orphans) {
          await withBlobs("readwrite", (blobs) => blobs.delete(id));
        }
        return orphans.length;
      }
    };
  }

  // client/src/palette.js
  function srgbToLinear(channel) {
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }
  function linearToSrgb(channel) {
    const clamped = Math.min(1, Math.max(0, channel));
    return clamped <= 31308e-7 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  }
  function srgbToOklch({ r, g, b }) {
    const lr = srgbToLinear(r / 255);
    const lg = srgbToLinear(g / 255);
    const lb = srgbToLinear(b / 255);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const hue = Math.atan2(bb, a) * 180 / Math.PI;
    return { l: lightness, c: Math.hypot(a, bb), h: hue < 0 ? hue + 360 : hue };
  }
  function oklchToLinear({ l: lightness, c, h }) {
    const radians = h * Math.PI / 180;
    const a = c * Math.cos(radians);
    const bb = c * Math.sin(radians);
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * bb) ** 3;
    return {
      r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    };
  }
  function linearToSrgbTriple({ r, g, b }) {
    return { r: linearToSrgb(r) * 255, g: linearToSrgb(g) * 255, b: linearToSrgb(b) * 255 };
  }
  var GAMUT_EPSILON = 1e-4;
  function isInGamut(linear) {
    return linear.r >= -GAMUT_EPSILON && linear.r <= 1 + GAMUT_EPSILON && linear.g >= -GAMUT_EPSILON && linear.g <= 1 + GAMUT_EPSILON && linear.b >= -GAMUT_EPSILON && linear.b <= 1 + GAMUT_EPSILON;
  }
  var ALPHA_THRESHOLD = 128;
  var QUANTIZE_BITS = 4;
  var CANDIDATE_LIMIT = 32;
  var MIN_SATURATION = 0.15;
  var PREFERRED_LIGHTNESS = 0.55;
  function saturationOf({ r, g, b }) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  }
  function lightnessPenalty(lightness) {
    const distance = Math.abs(lightness - PREFERRED_LIGHTNESS) / (1 - PREFERRED_LIGHTNESS);
    return Math.max(0, 1 - distance * distance);
  }
  function extractDominantColor(image) {
    const data = image?.data;
    if (data === void 0 || data === null) return null;
    const buckets = /* @__PURE__ */ new Map();
    for (let at = 0; at < data.length; at += 4) {
      if (data[at + 3] < ALPHA_THRESHOLD) continue;
      const r = data[at];
      const g = data[at + 1];
      const b = data[at + 2];
      const key = r >> 8 - QUANTIZE_BITS << QUANTIZE_BITS * 2 | g >> 8 - QUANTIZE_BITS << QUANTIZE_BITS | b >> 8 - QUANTIZE_BITS;
      let bucket = buckets.get(key);
      if (bucket === void 0) {
        bucket = { count: 0, r: 0, g: 0, b: 0 };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    }
    if (buckets.size === 0) return null;
    const candidates = [...buckets.values()].sort((left, right) => right.count - left.count).slice(0, CANDIDATE_LIMIT);
    let best = null;
    let bestScore = 0;
    for (const bucket of candidates) {
      const average = {
        r: bucket.r / bucket.count,
        g: bucket.g / bucket.count,
        b: bucket.b / bucket.count
      };
      const saturation = saturationOf(average);
      if (saturation === 0) continue;
      const score = Math.sqrt(bucket.count) * saturation * lightnessPenalty(srgbToOklch(average).l);
      if (score > bestScore) {
        bestScore = score;
        best = average;
      }
    }
    if (best === null || saturationOf(best) < MIN_SATURATION) return null;
    return { r: Math.round(best.r), g: Math.round(best.g), b: Math.round(best.b) };
  }
  var CHROMA_STEP = 0.02;
  var ACCENT_ROLES = [
    { key: "lightAccent", lightness: 0.42 },
    { key: "lightAccentDeep", lightness: 0.32 },
    { key: "darkAccent", lightness: 0.68 },
    { key: "darkAccentSoft", lightness: 0.78 }
  ];
  function formatRgb({ r, g, b }) {
    return `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
  }
  function deriveAccent(primary, target) {
    const base = srgbToOklch(primary);
    if (!Number.isFinite(base.h) || !Number.isFinite(base.c)) {
      return linearToSrgbTriple(oklchToLinear({ l: target, c: 0, h: 0 }));
    }
    for (let step = 0; ; step += 1) {
      const chroma = Math.max(0, base.c - step * CHROMA_STEP);
      const linear = oklchToLinear({ l: target, c: chroma, h: base.h });
      if (isInGamut(linear)) return linearToSrgbTriple(linear);
    }
  }
  function deriveAccents(primary) {
    const accents = {};
    for (const { key, lightness } of ACCENT_ROLES) {
      accents[key] = formatRgb(deriveAccent(primary, lightness));
    }
    return accents;
  }
  function toHex({ r, g, b }) {
    const pair = (channel) => Math.round(channel).toString(16).padStart(2, "0");
    return `#${pair(r)}${pair(g)}${pair(b)}`;
  }
  function fromHex(hex) {
    if (typeof hex !== "string") throw new TypeError("fromHex: expected a colour string");
    const digits = hex.trim().replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(digits)) throw new TypeError(`fromHex: not a #rrggbb colour: ${JSON.stringify(hex)}`);
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16)
    };
  }
  function parseRgb(value) {
    const [r, g, b] = value.split(",").map((part) => Number(part.trim()));
    return { r, g, b };
  }

  // client/src/image.js
  var MAX_EDGE = 2560;
  var THUMB_EDGE = 48;
  var SAMPLE_EDGE = 128;
  var MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
  var WEBP_QUALITY = 0.9;
  var THUMB_WEBP_QUALITY = 0.8;
  var ImageRejection = class extends Error {
    constructor(reason) {
      super(`image rejected: ${reason}`);
      this.name = "ImageRejection";
      this.reason = reason;
    }
  };
  function targetSize(width, height, maxEdge = MAX_EDGE) {
    const longest = Math.max(width, height);
    if (longest <= maxEdge) return { width, height };
    const scale = maxEdge / longest;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }
  function rejectionFor({ type, size }) {
    if (typeof type !== "string" || !type.startsWith("image/")) return "not-an-image";
    if (type === "image/svg+xml") return "vector-unsupported";
    if (size > MAX_UPLOAD_BYTES) return "too-large";
    return void 0;
  }
  function canvasOf(width, height) {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
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
  function render(bitmap, width, height) {
    const canvas = canvasOf(width, height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    return canvas;
  }
  function sampleColours(bitmap) {
    const size = targetSize(bitmap.width, bitmap.height, SAMPLE_EDGE);
    const canvas = render(bitmap, size.width, size.height);
    return canvas.getContext("2d").getImageData(0, 0, size.width, size.height);
  }
  async function importImage(file) {
    const rejection = rejectionFor(file);
    if (rejection !== void 0) throw new ImageRejection(rejection);
    const bitmap = await createImageBitmap(file);
    try {
      const size = targetSize(bitmap.width, bitmap.height, MAX_EDGE);
      const stored = await encode(render(bitmap, size.width, size.height), "image/webp", WEBP_QUALITY);
      if (stored === null) throw new Error("image: the browser could not encode the wallpaper");
      const thumbSize = targetSize(bitmap.width, bitmap.height, THUMB_EDGE);
      const thumbBlob = await encode(render(bitmap, thumbSize.width, thumbSize.height), "image/webp", THUMB_WEBP_QUALITY);
      return {
        blob: stored,
        thumb: thumbBlob === null ? void 0 : await blobToDataUrl(thumbBlob),
        accent: extractDominantColor(sampleColours(bitmap)),
        width: size.width,
        height: size.height
      };
    } finally {
      bitmap.close();
    }
  }

  // client/src/index.js
  window.__ModuleLoader__.load({ id: "dsh-skin-miku", factory: (require2) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require2("react");
    const name = "dsh-skin-miku";
    const inject = ["theme", "slots"];
    const STORAGE_KEY = "dsh-skin-miku:skin";
    const OPACITY_KEY = "dsh-skin-miku:opacity";
    const DEFAULT_OPACITY = 50;
    const opacityFactor = (v) => 1.4 - v / 100 * 0.8;
    const SKINS = [
      {
        id: "ninja",
        darkAccent: "34, 211, 238",
        darkAccentSoft: "103, 232, 249",
        lightAccent: "8, 145, 178",
        lightAccentDeep: "14, 116, 144",
        images: { dark: "ninja-dark.png", light: "ninja-light.png" }
      },
      {
        id: "sakura",
        darkAccent: "251, 113, 133",
        darkAccentSoft: "253, 164, 175",
        lightAccent: "225, 29, 72",
        lightAccentDeep: "190, 18, 60",
        images: { dark: "sakura-dark.png", light: "sakura-light.png" }
      },
      {
        id: "bamboo",
        darkAccent: "74, 222, 128",
        darkAccentSoft: "134, 239, 172",
        lightAccent: "22, 163, 74",
        lightAccentDeep: "21, 128, 61",
        images: { dark: "bamboo-dark.png", light: "bamboo-light.png" }
      },
      {
        id: "ronin",
        darkAccent: "251, 146, 60",
        darkAccentSoft: "253, 186, 116",
        lightAccent: "234, 88, 12",
        lightAccentDeep: "194, 65, 12",
        images: { dark: "ronin-dark.png", light: "ronin-light.png" }
      },
      {
        id: "ryujin",
        darkAccent: "129, 140, 248",
        darkAccentSoft: "165, 180, 252",
        lightAccent: "79, 70, 229",
        lightAccentDeep: "67, 56, 202",
        images: { dark: "ryujin-dark.png", light: "ryujin-light.png" }
      }
    ];
    const ASSET_PREFIX = "/skin-miku";
    function resolveBuiltIn(skin) {
      return {
        id: skin.id,
        labelKey: `skin.${skin.id}`,
        accent: {
          darkAccent: skin.darkAccent,
          darkAccentSoft: skin.darkAccentSoft,
          lightAccent: skin.lightAccent,
          lightAccentDeep: skin.lightAccentDeep
        },
        imageUrls: {
          light: `${ASSET_PREFIX}/${skin.images.light}`,
          dark: `${ASSET_PREFIX}/${skin.images.dark}`
        }
      };
    }
    const BUILT_IN = SKINS.map(resolveBuiltIn);
    function staticTokens(k) {
      const s = (rgb, a) => `rgba(${rgb}, ${Math.min(0.98, a * k).toFixed(3)})`;
      return {
        "--dsw-static-neutral-bluish-950": { light: "rgb(21, 21, 23)", dark: s("7, 10, 22", 0.55) },
        "--dsw-static-neutral-bluish-900": { light: "rgb(27, 27, 28)", dark: s("9, 13, 28", 0.55) },
        "--dsw-static-neutral-bluish-875": { light: "rgb(35, 35, 36)", dark: s("12, 17, 34", 0.6) },
        "--dsw-static-neutral-bluish-850": { light: "rgb(44, 44, 46)", dark: s("16, 22, 42", 0.62) },
        "--dsw-static-neutral-bluish-800": { light: "rgb(53, 54, 56)", dark: s("21, 29, 54", 0.72) },
        "--dsw-static-neutral-bluish-750": { light: "rgb(67, 69, 74)", dark: s("28, 38, 68", 0.8) },
        "--dsw-static-neutral-bluish-00": { light: s("255, 255, 255", 0.62), dark: "rgb(255, 255, 255)" },
        "--dsw-static-neutral-bluish-50": { light: s("249, 251, 255", 0.66), dark: "rgb(249, 250, 251)" },
        "--dsw-static-neutral-bluish-60": { light: s("246, 249, 255", 0.7), dark: "rgb(249, 250, 251)" },
        "--dsw-static-neutral-bluish-75": { light: s("243, 247, 255", 0.72), dark: "rgb(241, 243, 245)" },
        "--dsw-static-neutral-bluish-100": { light: s("240, 246, 255", 0.75), dark: "rgb(235, 238, 242)" },
        "--dsw-static-neutral-bluish-150": { light: s("238, 244, 255", 0.9), dark: "rgb(233, 236, 242)" }
      };
    }
    function aliasTokens(accent, k) {
      const dk = (a) => `rgba(${accent.darkAccent}, ${a})`;
      const lt = (a) => `rgba(${accent.lightAccent}, ${a})`;
      const s = (rgb, a) => `rgba(${rgb}, ${Math.min(0.98, a * k).toFixed(3)})`;
      const so = (rgb, a) => `rgba(${rgb}, ${Math.min(0.98, Math.max(0.8, a * k)).toFixed(3)})`;
      return {
        // surfaces: transparent enough that the artwork reads through
        "--dsw-alias-bg-base": { light: s("247, 250, 255", 0.45), dark: s("6, 9, 20", 0.45) },
        "--dsw-alias-bg-layer-1": { light: s("255, 255, 255", 0.55), dark: s("11, 16, 32", 0.55) },
        "--dsw-alias-bg-layer-2": { light: s("255, 255, 255", 0.62), dark: s("15, 21, 40", 0.6) },
        "--dsw-alias-bg-layer-3": { light: s("255, 255, 255", 0.72), dark: s("20, 28, 52", 0.72) },
        "--dsw-alias-bg-module-platform": { light: s("255, 255, 255", 0.6), dark: s("18, 25, 47", 0.62) },
        // overlays/menus stay near-opaque for readability
        "--dsw-alias-bg-overlay": { light: so("252, 254, 255", 0.97), dark: so("20, 28, 52", 0.96) },
        "--dsw-alias-toast-bg": { light: so("252, 254, 255", 0.97), dark: so("16, 22, 42", 0.96) },
        "--dsw-alias-tooltip-bg": { light: so("30, 41, 59", 0.95), dark: so("16, 22, 42", 0.96) },
        "--dsw-alias-bg-multi-select": { light: lt(0.1), dark: dk(0.14) },
        "--dsw-alias-bg-skeleton": { light: lt(0.08), dark: dk(0.08) },
        // borders
        "--dsw-alias-border-l1": { light: lt(0.14), dark: dk(0.12) },
        "--dsw-alias-border-l2": { light: lt(0.24), dark: dk(0.22) },
        "--dsw-alias-border-l2-darkmode-thin": { light: lt(0.24), dark: dk(0.18) },
        "--dsw-alias-border-l3": { light: lt(0.32), dark: dk(0.3) },
        "--dsw-alias-border-l4": { light: lt(0.45), dark: dk(0.42) },
        // brand + primary actions
        "--dsw-alias-brand-primary": { light: `rgb(${accent.lightAccent})`, dark: `rgb(${accent.darkAccent})` },
        "--dsw-alias-brand-text": { light: `rgb(${accent.lightAccentDeep})`, dark: `rgb(${accent.darkAccentSoft})` },
        "--dsw-alias-button-primary-hover": { light: `rgb(${accent.lightAccentDeep})`, dark: `rgb(${accent.darkAccentSoft})` },
        "--dsw-alias-button-primary-dimmed": { light: lt(0.45), dark: dk(0.45) },
        // secondary buttons and hovers
        "--dsw-alias-button-elevated-fill": { light: s("255, 255, 255", 0.7), dark: s("24, 33, 60", 0.75) },
        "--dsw-alias-button-floating-fill": { light: s("255, 255, 255", 0.8), dark: s("24, 33, 60", 0.85) },
        "--dsw-alias-button-floating-hover": { light: s("240, 248, 255", 0.9), dark: s("32, 44, 78", 0.9) },
        "--dsw-alias-button-ghost-active-border": { light: lt(0.5), dark: dk(0.5) },
        "--dsw-alias-button-ghost-active-fill": { light: lt(0.1), dark: dk(0.12) },
        "--dsw-alias-button-ghost-active-hover": { light: lt(0.16), dark: dk(0.18) },
        "--dsw-alias-button-tool-bar-fill": { light: s("255, 255, 255", 0.65), dark: s("21, 29, 54", 0.7) },
        "--dsw-alias-button-tool-bar-hover": { light: lt(0.12), dark: dk(0.14) },
        "--dsw-alias-interactive-bg-hover": { light: lt(0.1), dark: dk(0.1) },
        "--dsw-alias-interactive-bg-active": { light: lt(0.16), dark: dk(0.16) },
        "--dsw-alias-interactive-bg-hover-accent": { light: lt(0.14), dark: dk(0.14) },
        "--dsw-alias-interactive-bg-hover-solid": { light: "rgba(228, 240, 250, 0.95)", dark: "rgba(28, 38, 68, 0.95)" },
        // text: subtle cool cast on secondary roles only; primary stays stock
        "--dsw-alias-label-secondary": { light: "rgb(75, 94, 112)", dark: "rgb(163, 184, 205)" },
        "--dsw-alias-label-primary-bluish": { light: `rgb(${accent.lightAccentDeep})`, dark: `rgb(${accent.darkAccentSoft})` },
        // markdown/code surfaces
        "--dsw-alias-markdown-code-block": { light: s("240, 246, 254", 0.75), dark: s("9, 13, 27", 0.72) },
        "--dsw-alias-markdown-code-block-banner": { light: s("230, 240, 252", 0.85), dark: s("14, 19, 38", 0.85) },
        "--dsw-alias-markdown-inline-code": { light: lt(0.1), dark: dk(0.12) },
        // scrollbars
        "--dsw-alias-scrollbar-bg-l1": { light: lt(0.25), dark: dk(0.25) },
        "--dsw-alias-scrollbar-hover-l1": { light: lt(0.45), dark: dk(0.45) },
        "--dsw-alias-scrollbar-bg-l2": { light: lt(0.25), dark: dk(0.25) },
        "--dsw-alias-scrollbar-hover-l2": { light: lt(0.45), dark: dk(0.45) }
      };
    }
    function backdropCss(imageUrls) {
      const layer = (url, gradient) => url === void 0 ? "  background-image: none;" : `  background-image: linear-gradient(${gradient}), url('${url}');`;
      return [
        "body {",
        layer(imageUrls.light, "rgba(247, 250, 255, 0), rgba(247, 250, 255, 0.15)"),
        "  background-size: cover;",
        "  background-position: center;",
        "  background-attachment: fixed;",
        "}",
        "body[data-ds-dark-theme] {",
        layer(imageUrls.dark, "rgba(4, 6, 14, 0.02), rgba(4, 6, 14, 0.22)"),
        "}"
      ].join("\n");
    }
    const BUTTON_CSS = [
      ".dshSkinSwitcher { position: absolute; top: 44px; right: 16px; display: flex; flex-direction: column; align-items: flex-end; }",
      ".dshSkinSwitcherBtn {",
      "  display: flex; align-items: center; justify-content: center;",
      "  width: 32px; height: 32px; border-radius: 10px; cursor: pointer;",
      "  background: var(--dsw-alias-button-floating-fill);",
      "  border: 1px solid var(--dsw-alias-border-l2);",
      "  color: var(--dsw-alias-label-secondary);",
      "  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);",
      "}",
      ".dshSkinSwitcherBtn:hover {",
      "  background: var(--dsw-alias-button-floating-hover);",
      "  color: var(--dsw-alias-brand-text);",
      "  border-color: var(--dsw-alias-border-l3);",
      "}",
      ".dshSkinSwitcherMenu {",
      "  margin-top: 6px; min-width: 224px; padding: 4px;",
      "  background: var(--dsw-alias-bg-overlay);",
      "  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;",
      "  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);",
      "}",
      ".dshSkinSwitcherItem {",
      "  display: flex; align-items: center; gap: 8px; width: 100%;",
      "  padding: 6px 10px; border: none; border-radius: 7px; cursor: pointer;",
      "  background: transparent; color: var(--dsw-alias-label-primary);",
      "  font: inherit; font-size: 13px; text-align: left;",
      "}",
      ".dshSkinSwitcherItem:hover { background: var(--dsw-alias-interactive-bg-hover); }",
      ".dshSkinSwitcherItem[data-active] { color: var(--dsw-alias-brand-text); }",
      ".dshSkinSwitcherDot { width: 8px; height: 8px; border-radius: 50%; flex: none; }",
      ".dshSkinSwitcherCheck { margin-left: auto; }",
      ".dshSkinSwitcherBackdrop { position: fixed; inset: 0; }",
      ".dshSkinSwitcherOpacity {",
      "  margin-top: 4px; padding: 6px 10px 8px;",
      "  border-top: 1px solid var(--dsw-alias-border-l1);",
      "}",
      ".dshSkinSwitcherOpacityLabel {",
      "  display: flex; justify-content: space-between; margin-bottom: 4px;",
      "  font-size: 12px; color: var(--dsw-alias-label-secondary);",
      "}",
      ".dshSkinSwitcherOpacity input[type=range] {",
      "  width: 100%; margin: 0; accent-color: var(--dsw-alias-brand-primary);",
      "}",
      // Custom-skin additions. Every affordance is rendered IN PLACE -- rename,
      // actions, delete confirmation all replace the row -- so the list needs no
      // floating layer of its own, and nothing has to re-argue with
      // shell.overlay's pointer-events rule or be clipped by the scroll box.
      ".dshSkinSwitcherList { max-height: 40vh; overflow-y: auto; }",
      ".dshSkinSwitcherSection {",
      "  padding: 8px 10px 2px; font-size: 11px; letter-spacing: .05em;",
      "  text-transform: uppercase; color: var(--dsw-alias-label-secondary);",
      "}",
      ".dshSkinSwitcherRow { display: flex; align-items: center; gap: 2px; }",
      ".dshSkinSwitcherRow .dshSkinSwitcherItem { flex: 1; min-width: 0; }",
      ".dshSkinSwitcherName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".dshSkinSwitcherThumb { width: 18px; height: 18px; border-radius: 4px; flex: none; object-fit: cover; }",
      ".dshSkinSwitcherMore {",
      "  flex: none; padding: 4px 7px; border: none; border-radius: 6px; cursor: pointer;",
      "  background: transparent; color: var(--dsw-alias-label-secondary);",
      "  font: inherit; line-height: 1;",
      "}",
      ".dshSkinSwitcherMore:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }",
      ".dshSkinSwitcherAdd {",
      "  display: block; width: 100%; margin-top: 6px; padding: 7px 10px;",
      "  border: none; border-top: 1px solid var(--dsw-alias-border-l1); cursor: pointer;",
      "  background: transparent; color: var(--dsw-alias-brand-text);",
      "  font: inherit; font-size: 13px; text-align: left;",
      "}",
      ".dshSkinSwitcherAdd:hover { background: var(--dsw-alias-interactive-bg-hover); }",
      ".dshSkinSwitcherNotice { padding: 6px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }",
      // A literal danger colour: the theme has no destructive token to borrow.
      ".dshSkinSwitcherNotice[data-error] { color: #e5484d; }",
      ".dshSkinSwitcherInput {",
      "  flex: 1; min-width: 0; margin: 2px 10px; padding: 4px 8px;",
      "  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;",
      "  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);",
      "  font: inherit; font-size: 13px;",
      "}",
      ".dshSkinSwitcherConfirm { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 10px; }",
      ".dshSkinSwitcherConfirm button {",
      "  flex: none; padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l2);",
      "  border-radius: 6px; cursor: pointer; background: var(--dsw-alias-button-elevated-fill);",
      "  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;",
      "}",
      ".dshSkinSwitcherConfirm button[data-danger] { border-color: #e5484d; color: #e5484d; }",
      ".dshSkinSwitcherPicker { padding: 10px 10px 12px; }",
      ".dshSkinSwitcherPicker p { margin: 0 0 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }",
      ".dshSkinSwitcherPickerRow { display: flex; align-items: center; gap: 8px; }",
      ".dshSkinSwitcherPicker input[type=color] {",
      "  flex: none; width: 44px; height: 28px; padding: 0; cursor: pointer;",
      "  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent;",
      "}",
      ".dshSkinSwitcherPicker button {",
      "  flex: none; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2);",
      "  border-radius: 6px; cursor: pointer; background: var(--dsw-alias-button-elevated-fill);",
      "  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;",
      "}"
    ].join("\n");
    const NS = "dsh-skin-miku";
    const DICTS = {
      zh: {
        tooltip: "\u5207\u6362\u76AE\u80A4",
        opacity: "\u900F\u660E\u5EA6",
        "skin.ninja": "\u5FCD\u8005",
        "skin.sakura": "\u6A31\u82B1",
        "skin.bamboo": "\u7AF9\u6797",
        "skin.ronin": "\u843D\u65E5",
        "skin.ryujin": "\u82CD\u9F99",
        "custom.section": "\u6211\u7684\u76AE\u80A4",
        "custom.add": "\u6DFB\u52A0\u81EA\u5B9A\u4E49\u76AE\u80A4",
        "custom.defaultName": "\u81EA\u5B9A\u4E49",
        "custom.more": "\u66F4\u591A\u64CD\u4F5C",
        "custom.rename": "\u91CD\u547D\u540D",
        "custom.delete": "\u5220\u9664",
        "custom.deleteConfirm": "\u5220\u9664\u8FD9\u6B3E\u76AE\u80A4\uFF1F",
        "custom.confirm": "\u786E\u8BA4\u5220\u9664",
        "custom.cancel": "\u53D6\u6D88",
        "custom.busy": "\u6B63\u5728\u5904\u7406\u56FE\u7247\u2026",
        "custom.pickHint": "\u8FD9\u5F20\u56FE\u91CC\u6CA1\u627E\u5230\u53EF\u7528\u7684\u4E3B\u8272\uFF0C\u81EA\u5DF1\u9009\u4E00\u4E2A\u5427",
        "custom.save": "\u7528\u8FD9\u4E2A\u989C\u8272",
        "error.not-an-image": "\u8BF7\u9009\u62E9\u56FE\u7247\u6587\u4EF6",
        "error.vector-unsupported": "\u6682\u4E0D\u652F\u6301 SVG\uFF0C\u8BF7\u7528 PNG\uFF0FJPEG\uFF0FWebP",
        "error.too-large": "\u56FE\u7247\u592A\u5927\u4E86\uFF0C\u4E0A\u9650 40MB",
        "error.import-failed": "\u5904\u7406\u8FD9\u5F20\u56FE\u5931\u8D25\u4E86",
        "error.image-missing": "\u8FD9\u6B3E\u76AE\u80A4\u7684\u56FE\u7247\u5DF2\u4E22\u5931\uFF0C\u5DF2\u5207\u56DE\u9ED8\u8BA4\u76AE\u80A4",
        "error.storage": "\u6D4F\u89C8\u5668\u5B58\u50A8\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u4FDD\u5B58"
      },
      en: {
        tooltip: "Switch skin",
        opacity: "Transparency",
        "skin.ninja": "Ninja",
        "skin.sakura": "Sakura",
        "skin.bamboo": "Bamboo",
        "skin.ronin": "Ronin",
        "skin.ryujin": "Ryujin",
        "custom.section": "My skins",
        "custom.add": "Add custom skin",
        "custom.defaultName": "Custom",
        "custom.more": "More actions",
        "custom.rename": "Rename",
        "custom.delete": "Delete",
        "custom.deleteConfirm": "Delete this skin?",
        "custom.confirm": "Delete it",
        "custom.cancel": "Cancel",
        "custom.busy": "Processing image\u2026",
        "custom.pickHint": "No usable colour in that image \u2014 pick one yourself",
        "custom.save": "Use this colour",
        "error.not-an-image": "Please choose an image file",
        "error.vector-unsupported": "SVG is not supported yet \u2014 use PNG/JPEG/WebP",
        "error.too-large": "That image is too large (40MB limit)",
        "error.import-failed": "Could not process that image",
        "error.image-missing": "This skin's image is gone; reverted to the default",
        "error.storage": "Browser storage is unavailable, so nothing could be saved"
      }
    };
    function ShirtIcon() {
      return React.createElement(
        "svg",
        { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
        React.createElement("path", {
          d: "M16.2 4 20 6.5c.4.3.6.8.4 1.3l-1.2 3c-.2.5-.8.8-1.3.6l-1.4-.5v8.1c0 .6-.4 1-1 1H8.5c-.6 0-1-.4-1-1v-8.1l-1.4.5c-.5.2-1.1-.1-1.3-.6l-1.2-3c-.2-.5 0-1 .4-1.3L7.8 4h2.4c.1 1 .8 1.7 1.8 1.7S13.7 5 13.8 4h2.4Z",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinejoin: "round"
        })
      );
    }
    function apply(ctx) {
      const store = createStore({ idbFactory: globalThis.indexedDB, storage: localStorage });
      let customEntries = store.list();
      let current = initialSkin();
      let objectUrl;
      let pending = null;
      let busy = false;
      let error = null;
      let renamingId = null;
      let confirmingId = null;
      let actionsFor = null;
      const storedOpacity = Number(localStorage.getItem(OPACITY_KEY));
      let opacity = Number.isFinite(storedOpacity) && localStorage.getItem(OPACITY_KEY) !== null ? Math.min(100, Math.max(0, storedOpacity)) : DEFAULT_OPACITY;
      let disposeTokens;
      const listeners = /* @__PURE__ */ new Set();
      const notify = () => {
        for (const fn of listeners) fn();
      };
      const backdropTag = document.createElement("style");
      backdropTag.id = "dsh-skin-miku-css";
      const buttonTag = document.createElement("style");
      buttonTag.id = "dsh-skin-miku-button-css";
      buttonTag.textContent = BUTTON_CSS;
      function resolvedCustom(entry, url) {
        return {
          id: entry.id,
          label: entry.name,
          accent: entry.accent,
          imageUrls: { light: url, dark: url },
          custom: true,
          entry
        };
      }
      function initialSkin() {
        const id = localStorage.getItem(STORAGE_KEY);
        const builtIn = BUILT_IN.find((skin) => skin.id === id);
        if (builtIn !== void 0) return builtIn;
        const entry = customEntries.find((candidate) => candidate.id === id);
        if (entry !== void 0) return resolvedCustom(entry, void 0);
        return BUILT_IN[0];
      }
      function adoptObjectUrl(url) {
        if (objectUrl !== void 0 && objectUrl !== url) URL.revokeObjectURL(objectUrl);
        objectUrl = url;
      }
      function releaseObjectUrl() {
        if (objectUrl === void 0) return;
        URL.revokeObjectURL(objectUrl);
        objectUrl = void 0;
      }
      const applySkin = (skin) => {
        current = skin;
        const k = opacityFactor(opacity);
        disposeTokens = ctx.theme.overrideTokens("dsh-skin-miku", {
          ...staticTokens(k),
          ...aliasTokens(skin.accent, k)
        });
        backdropTag.textContent = backdropCss(skin.imageUrls);
        notify();
      };
      function rememberActiveId(id) {
        try {
          localStorage.setItem(STORAGE_KEY, id);
        } catch {
          error = "storage";
        }
      }
      async function selectSkin(id) {
        error = null;
        const builtIn = BUILT_IN.find((skin) => skin.id === id);
        if (builtIn !== void 0) {
          releaseObjectUrl();
          rememberActiveId(id);
          applySkin(builtIn);
          return;
        }
        const entry = customEntries.find((candidate) => candidate.id === id);
        if (entry === void 0) {
          rememberActiveId(BUILT_IN[0].id);
          applySkin(BUILT_IN[0]);
          return;
        }
        applySkin(resolvedCustom(entry, void 0));
        rememberActiveId(id);
        try {
          const blob = await store.blob(id);
          if (blob === void 0) throw new Error("missing blob");
          const url = URL.createObjectURL(blob);
          adoptObjectUrl(url);
          if (current.id === id) applySkin(resolvedCustom(entry, url));
        } catch {
          await dropCustom(id);
          rememberActiveId(BUILT_IN[0].id);
          error = "image-missing";
          applySkin(BUILT_IN[0]);
        }
      }
      async function dropCustom(id) {
        try {
          await store.remove(id);
        } catch {
          error = "storage";
        }
        customEntries = store.list();
        notify();
      }
      function renameCustom(id, name2) {
        const trimmed = name2.trim();
        if (trimmed.length === 0) return;
        try {
          store.rename(id, trimmed);
        } catch {
          error = "storage";
        }
        customEntries = store.list();
        if (current.id === id) applySkin(resolvedCustom(store.get(id), current.imageUrls.light));
        notify();
      }
      async function deleteCustom(id) {
        if (current.id === id) {
          releaseObjectUrl();
          rememberActiveId(BUILT_IN[0].id);
          applySkin(BUILT_IN[0]);
        }
        await dropCustom(id);
      }
      function newCustomId() {
        const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        return `custom-${suffix}`;
      }
      async function persistImport(result, accent, accentSource) {
        const entry = {
          id: newCustomId(),
          name: `${t("custom.defaultName")} ${customEntries.length + 1}`,
          createdAt: Date.now(),
          accent,
          accentSource,
          thumb: result.thumb
        };
        try {
          await store.add(entry, result.blob);
        } catch {
          error = "storage";
          return;
        }
        customEntries = store.list();
        pending = null;
        await selectSkin(entry.id);
      }
      async function addFromFile(file) {
        busy = true;
        error = null;
        pending = null;
        notify();
        try {
          const result = await importImage(file);
          if (result.accent === null) {
            pending = result;
          } else {
            await persistImport(result, deriveAccents(result.accent), "auto");
          }
        } catch (thrown) {
          error = thrown instanceof ImageRejection ? thrown.reason : "import-failed";
        } finally {
          busy = false;
          notify();
        }
      }
      async function savePicked(hex) {
        const result = pending;
        if (result === null) return;
        busy = true;
        notify();
        try {
          await persistImport(result, deriveAccents(fromHex(hex)), "manual");
        } catch {
          error = "import-failed";
        } finally {
          busy = false;
          notify();
        }
      }
      const filePicker = document.createElement("input");
      filePicker.type = "file";
      filePicker.accept = "image/*";
      filePicker.style.display = "none";
      filePicker.addEventListener("change", () => {
        const file = filePicker.files?.[0];
        filePicker.value = "";
        if (file !== void 0) void addFromFile(file);
      });
      ctx.effect(() => {
        document.head.appendChild(buttonTag);
        document.head.appendChild(backdropTag);
        document.head.appendChild(filePicker);
        applySkin(current);
        if (current.custom === true) void selectSkin(current.id);
        try {
          void navigator.storage?.persist?.();
        } catch {
        }
        if (customEntries.length > 0) void store.sweep().catch(() => {
        });
        return () => {
          disposeTokens();
          releaseObjectUrl();
          filePicker.remove();
          backdropTag.remove();
          buttonTag.remove();
        };
      }, "dsh-skin-miku: skin layer");
      let t = (key) => DICTS.en[key] ?? key;
      const locale = ctx.get("locale");
      if (locale !== void 0) {
        ctx.effect(() => locale.register(NS, DICTS), "dsh-skin-miku: dictionaries");
        t = locale.bind(NS);
      }
      function SkinSwitcher() {
        const forceRender = React.useReducer((x) => x + 1, 0)[1];
        const [open, setOpen] = React.useState(false);
        const [picked, setPicked] = React.useState(null);
        React.useEffect(() => {
          listeners.add(forceRender);
          return () => listeners.delete(forceRender);
        }, []);
        const close = () => {
          setOpen(false);
          setPicked(null);
          pending = null;
          renamingId = null;
          confirmingId = null;
          actionsFor = null;
        };
        const choose = (id) => {
          void selectSkin(id);
          close();
        };
        const row = (key, label, dotColour, thumb, isActive, onSelect, trailing) => React.createElement(
          "div",
          { className: "dshSkinSwitcherRow", key },
          React.createElement(
            "button",
            {
              className: "dshSkinSwitcherItem",
              "data-active": isActive ? "" : void 0,
              onClick: onSelect
            },
            thumb === void 0 ? React.createElement("span", { className: "dshSkinSwitcherDot", style: { background: `rgb(${dotColour})` } }) : React.createElement("img", { className: "dshSkinSwitcherThumb", src: thumb, alt: "" }),
            React.createElement("span", { className: "dshSkinSwitcherName" }, label),
            isActive ? React.createElement("span", { className: "dshSkinSwitcherCheck" }, "\u2713") : null
          ),
          trailing
        );
        const customRow = (entry) => {
          if (renamingId === entry.id) {
            return React.createElement(
              "div",
              { className: "dshSkinSwitcherRow", key: entry.id },
              React.createElement("input", {
                className: "dshSkinSwitcherInput",
                defaultValue: entry.name,
                autoFocus: true,
                onKeyDown: (event) => {
                  if (event.key === "Escape") event.currentTarget.dataset.cancel = "1";
                  if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
                },
                onBlur: (event) => {
                  const cancelled = event.currentTarget.dataset.cancel === "1";
                  const value = event.currentTarget.value;
                  renamingId = null;
                  if (!cancelled) renameCustom(entry.id, value);
                  forceRender();
                }
              })
            );
          }
          if (confirmingId === entry.id) {
            return React.createElement(
              "div",
              { className: "dshSkinSwitcherRow", key: entry.id },
              React.createElement(
                "div",
                { className: "dshSkinSwitcherConfirm" },
                React.createElement("span", { className: "dshSkinSwitcherName" }, t("custom.deleteConfirm")),
                React.createElement("button", { "data-danger": "", onClick: () => {
                  void deleteCustom(entry.id);
                  close();
                } }, t("custom.confirm")),
                React.createElement("button", { onClick: () => {
                  confirmingId = null;
                  forceRender();
                } }, t("custom.cancel"))
              )
            );
          }
          if (actionsFor === entry.id) {
            return React.createElement(
              "div",
              { className: "dshSkinSwitcherRow", key: entry.id },
              React.createElement(
                "div",
                { className: "dshSkinSwitcherConfirm" },
                React.createElement("button", { onClick: () => {
                  renamingId = entry.id;
                  actionsFor = null;
                  forceRender();
                } }, t("custom.rename")),
                React.createElement("button", { "data-danger": "", onClick: () => {
                  confirmingId = entry.id;
                  actionsFor = null;
                  forceRender();
                } }, t("custom.delete")),
                React.createElement("button", { onClick: () => {
                  actionsFor = null;
                  forceRender();
                } }, t("custom.cancel"))
              )
            );
          }
          return row(
            entry.id,
            entry.name,
            entry.accent.darkAccent,
            entry.thumb,
            entry.id === current.id,
            () => choose(entry.id),
            React.createElement("button", {
              className: "dshSkinSwitcherMore",
              title: t("custom.more"),
              "aria-label": t("custom.more"),
              onClick: () => {
                actionsFor = entry.id;
                forceRender();
              }
            }, "\u22EE")
          );
        };
        const builtInRows = BUILT_IN.map((skin) => row(skin.id, t(skin.labelKey), skin.accent.darkAccent, void 0, skin.id === current.id, () => choose(skin.id), null));
        const customRows = customEntries.map(customRow);
        const sectionHeader = customEntries.length === 0 && !busy ? null : React.createElement("div", { className: "dshSkinSwitcherSection" }, t("custom.section"));
        const opacityRow = React.createElement(
          "div",
          { className: "dshSkinSwitcherOpacity" },
          React.createElement(
            "div",
            { className: "dshSkinSwitcherOpacityLabel" },
            React.createElement("span", null, t("opacity")),
            React.createElement("span", null, `${opacity}%`)
          ),
          React.createElement("input", {
            type: "range",
            min: 0,
            max: 100,
            step: 5,
            value: opacity,
            onChange: (event) => {
              opacity = Math.min(100, Math.max(0, Number(event.target.value)));
              try {
                localStorage.setItem(OPACITY_KEY, String(opacity));
              } catch {
              }
              applySkin(current);
            }
          })
        );
        const defaultHex = toHex(parseRgb(current.accent.lightAccent));
        const picker = React.createElement(
          "div",
          { className: "dshSkinSwitcherPicker" },
          React.createElement("p", null, t("custom.pickHint")),
          React.createElement(
            "div",
            { className: "dshSkinSwitcherPickerRow" },
            React.createElement("input", {
              type: "color",
              value: picked ?? defaultHex,
              onChange: (event) => setPicked(event.target.value)
            }),
            React.createElement("button", { onClick: () => {
              void savePicked(picked ?? defaultHex);
            } }, t("custom.save")),
            React.createElement("button", { onClick: () => {
              pending = null;
              setPicked(null);
              forceRender();
            } }, t("custom.cancel"))
          )
        );
        const body = pending !== null ? picker : React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "div",
            { className: "dshSkinSwitcherList" },
            builtInRows,
            sectionHeader,
            customRows
          ),
          busy ? React.createElement("div", { className: "dshSkinSwitcherNotice" }, t("custom.busy")) : null,
          error === null ? null : React.createElement("div", { className: "dshSkinSwitcherNotice", "data-error": "" }, t(`error.${error}`)),
          React.createElement("button", { className: "dshSkinSwitcherAdd", onClick: () => filePicker.click() }, `+ ${t("custom.add")}`),
          opacityRow
        );
        return React.createElement(
          React.Fragment,
          null,
          open ? React.createElement("div", { className: "dshSkinSwitcherBackdrop", onClick: close }) : null,
          React.createElement(
            "div",
            { className: "dshSkinSwitcher" },
            React.createElement("button", {
              className: "dshSkinSwitcherBtn",
              title: t("tooltip"),
              "aria-label": t("tooltip"),
              onClick: () => open ? close() : setOpen(true)
            }, React.createElement(ShirtIcon)),
            open ? React.createElement("div", { className: "dshSkinSwitcherMenu" }, body) : null
          )
        );
      }
      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "dsh-skin-switcher", label: () => "dsh-skin-miku" },
        SkinSwitcher
      ));
    }
    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  } });
})();
