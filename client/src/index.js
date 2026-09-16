// Bundled by esbuild into client/client.js. The imports sit at the module's
// TRUE top level because ESM `import` cannot appear inside the factory function
// below. They are pure declarations with no side effects, so esbuild hoisting
// them above the registration call is harmless.
import { createStore } from "./store.js";
import { importImage, ImageRejection } from "./image.js";
import { deriveAccents, toHex, fromHex, parseRgb } from "./palette.js";

window.__ModuleLoader__.load({ id: "dsh-skin-miku", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  // React comes from the FACTORY PARAMETER, never from an `import`. esbuild
  // hoists an imported require() above the factory, where no `require` exists,
  // and the bundle then throws the moment it loads -- caught by
  // test/artifact.test.mjs, which reproduces exactly that.
  const React = require("react");

const name = "dsh-skin-miku";
const inject = ["theme", "slots"];

const STORAGE_KEY = "dsh-skin-miku:skin";
const OPACITY_KEY = "dsh-skin-miku:opacity";

const DEFAULT_OPACITY = 50;
const opacityFactor = (v) => 1.4 - (v / 100) * 0.8;

const SKINS = [
		{
			id: "ninja",
			darkAccent: "34, 211, 238", darkAccentSoft: "103, 232, 249",
			lightAccent: "8, 145, 178", lightAccentDeep: "14, 116, 144",
			images: { dark: "ninja-dark.png", light: "ninja-light.png" },
		},
		{
			id: "sakura",
			darkAccent: "251, 113, 133", darkAccentSoft: "253, 164, 175",
			lightAccent: "225, 29, 72", lightAccentDeep: "190, 18, 60",
			images: { dark: "sakura-dark.png", light: "sakura-light.png" },
		},
		{
			id: "bamboo",
			darkAccent: "74, 222, 128", darkAccentSoft: "134, 239, 172",
			lightAccent: "22, 163, 74", lightAccentDeep: "21, 128, 61",
			images: { dark: "bamboo-dark.png", light: "bamboo-light.png" },
		},
		{
			id: "ronin",
			darkAccent: "251, 146, 60", darkAccentSoft: "253, 186, 116",
			lightAccent: "234, 88, 12", lightAccentDeep: "194, 65, 12",
			images: { dark: "ronin-dark.png", light: "ronin-light.png" },
		},
		{
			id: "ryujin",
			darkAccent: "129, 140, 248", darkAccentSoft: "165, 180, 252",
			lightAccent: "79, 70, 229", lightAccentDeep: "67, 56, 202",
			images: { dark: "ryujin-dark.png", light: "ryujin-light.png" },
		},
	];



// The resolved shape every skin is rendered from, built-in or user-imported.
// It exists so the token layer and the backdrop stylesheet never learn where an
// image came from: a built-in names a file on the plugin's own route, a custom
// skin hands over a blob URL, and both are just a string here.
const ASSET_PREFIX = "/skin-miku";

function resolveBuiltIn(skin) {
	return {
		id: skin.id,
		labelKey: `skin.${skin.id}`,
		accent: {
			darkAccent: skin.darkAccent,
			darkAccentSoft: skin.darkAccentSoft,
			lightAccent: skin.lightAccent,
			lightAccentDeep: skin.lightAccentDeep,
		},
		imageUrls: {
			light: `${ASSET_PREFIX}/${skin.images.light}`,
			dark: `${ASSET_PREFIX}/${skin.images.dark}`,
		},
	};
}

const BUILT_IN = SKINS.map(resolveBuiltIn);

// ----- static scale(shared by all skins)
function staticTokens(k) {
		// s(): surface alpha scaled by the user's transparency factor, capped
		// just below opaque so the artwork always reads through a little.
		const s = (rgb, a) => `rgba(${rgb}, ${Math.min(0.98, a * k).toFixed(3)})`;
		return {
			"--dsw-static-neutral-bluish-950": { light: "rgb(21, 21, 23)", dark: s("7, 10, 22", 0.55) },
			"--dsw-static-neutral-bluish-900": { light: "rgb(27, 27, 28)", dark: s("9, 13, 28", 0.55) },
			"--dsw-static-neutral-bluish-875": { light: "rgb(35, 35, 36)", dark: s("12, 17, 34", 0.60) },
			"--dsw-static-neutral-bluish-850": { light: "rgb(44, 44, 46)", dark: s("16, 22, 42", 0.62) },
			"--dsw-static-neutral-bluish-800": { light: "rgb(53, 54, 56)", dark: s("21, 29, 54", 0.72) },
			"--dsw-static-neutral-bluish-750": { light: "rgb(67, 69, 74)", dark: s("28, 38, 68", 0.80) },
			"--dsw-static-neutral-bluish-00": { light: s("255, 255, 255", 0.62), dark: "rgb(255, 255, 255)" },
			"--dsw-static-neutral-bluish-50": { light: s("249, 251, 255", 0.66), dark: "rgb(249, 250, 251)" },
			"--dsw-static-neutral-bluish-60": { light: s("246, 249, 255", 0.70), dark: "rgb(249, 250, 251)" },
			"--dsw-static-neutral-bluish-75": { light: s("243, 247, 255", 0.72), dark: "rgb(241, 243, 245)" },
			"--dsw-static-neutral-bluish-100": { light: s("240, 246, 255", 0.75), dark: "rgb(235, 238, 242)" },
			"--dsw-static-neutral-bluish-150": { light: s("238, 244, 255", 0.90), dark: "rgb(233, 236, 242)" },
		};
}

// ---- alias layer ---------------------------------------------------------
	// Shared translucent surfaces plus the skin's accent family. Every value is
	// a { light, dark } pair so neither scheme bleeds into the other.
	function aliasTokens(accent, k) {
		const dk = (a) => `rgba(${accent.darkAccent}, ${a})`;
		const lt = (a) => `rgba(${accent.lightAccent}, ${a})`;
		// surface alphas follow the transparency factor; accent tints do not
		const s = (rgb, a) => `rgba(${rgb}, ${Math.min(0.98, a * k).toFixed(3)})`;
		// overlay surfaces scale too but keep a readability floor
		const so = (rgb, a) => `rgba(${rgb}, ${Math.min(0.98, Math.max(0.8, a * k)).toFixed(3)})`;
		return {
			// surfaces: transparent enough that the artwork reads through
			"--dsw-alias-bg-base": { light: s("247, 250, 255", 0.45), dark: s("6, 9, 20", 0.45) },
			"--dsw-alias-bg-layer-1": { light: s("255, 255, 255", 0.55), dark: s("11, 16, 32", 0.55) },
			"--dsw-alias-bg-layer-2": { light: s("255, 255, 255", 0.62), dark: s("15, 21, 40", 0.60) },
			"--dsw-alias-bg-layer-3": { light: s("255, 255, 255", 0.72), dark: s("20, 28, 52", 0.72) },
			"--dsw-alias-bg-module-platform": { light: s("255, 255, 255", 0.60), dark: s("18, 25, 47", 0.62) },
			// overlays/menus stay near-opaque for readability
			"--dsw-alias-bg-overlay": { light: so("252, 254, 255", 0.97), dark: so("20, 28, 52", 0.96) },
			"--dsw-alias-toast-bg": { light: so("252, 254, 255", 0.97), dark: so("16, 22, 42", 0.96) },
			"--dsw-alias-tooltip-bg": { light: so("30, 41, 59", 0.95), dark: so("16, 22, 42", 0.96) },
			"--dsw-alias-bg-multi-select": { light: lt(0.10), dark: dk(0.14) },
			"--dsw-alias-bg-skeleton": { light: lt(0.08), dark: dk(0.08) },
			// borders
			"--dsw-alias-border-l1": { light: lt(0.14), dark: dk(0.12) },
			"--dsw-alias-border-l2": { light: lt(0.24), dark: dk(0.22) },
			"--dsw-alias-border-l2-darkmode-thin": { light: lt(0.24), dark: dk(0.18) },
			"--dsw-alias-border-l3": { light: lt(0.32), dark: dk(0.30) },
			"--dsw-alias-border-l4": { light: lt(0.45), dark: dk(0.42) },
			// brand + primary actions
			"--dsw-alias-brand-primary": { light: `rgb(${accent.lightAccent})`, dark: `rgb(${accent.darkAccent})` },
			"--dsw-alias-brand-text": { light: `rgb(${accent.lightAccentDeep})`, dark: `rgb(${accent.darkAccentSoft})` },
			"--dsw-alias-button-primary-hover": { light: `rgb(${accent.lightAccentDeep})`, dark: `rgb(${accent.darkAccentSoft})` },
			"--dsw-alias-button-primary-dimmed": { light: lt(0.45), dark: dk(0.45) },
			// secondary buttons and hovers
			"--dsw-alias-button-elevated-fill": { light: s("255, 255, 255", 0.70), dark: s("24, 33, 60", 0.75) },
			"--dsw-alias-button-floating-fill": { light: s("255, 255, 255", 0.80), dark: s("24, 33, 60", 0.85) },
			"--dsw-alias-button-floating-hover": { light: s("240, 248, 255", 0.90), dark: s("32, 44, 78", 0.90) },
			"--dsw-alias-button-ghost-active-border": { light: lt(0.50), dark: dk(0.50) },
			"--dsw-alias-button-ghost-active-fill": { light: lt(0.10), dark: dk(0.12) },
			"--dsw-alias-button-ghost-active-hover": { light: lt(0.16), dark: dk(0.18) },
			"--dsw-alias-button-tool-bar-fill": { light: s("255, 255, 255", 0.65), dark: s("21, 29, 54", 0.70) },
			"--dsw-alias-button-tool-bar-hover": { light: lt(0.12), dark: dk(0.14) },
			"--dsw-alias-interactive-bg-hover": { light: lt(0.10), dark: dk(0.10) },
			"--dsw-alias-interactive-bg-active": { light: lt(0.16), dark: dk(0.16) },
			"--dsw-alias-interactive-bg-hover-accent": { light: lt(0.14), dark: dk(0.14) },
			"--dsw-alias-interactive-bg-hover-solid": { light: "rgba(228, 240, 250, 0.95)", dark: "rgba(28, 38, 68, 0.95)" },
			// text: subtle cool cast on secondary roles only; primary stays stock
			"--dsw-alias-label-secondary": { light: "rgb(75, 94, 112)", dark: "rgb(163, 184, 205)" },
			"--dsw-alias-label-primary-bluish": { light: `rgb(${accent.lightAccentDeep})`, dark: `rgb(${accent.darkAccentSoft})` },
			// markdown/code surfaces
			"--dsw-alias-markdown-code-block": { light: s("240, 246, 254", 0.75), dark: s("9, 13, 27", 0.72) },
			"--dsw-alias-markdown-code-block-banner": { light: s("230, 240, 252", 0.85), dark: s("14, 19, 38", 0.85) },
			"--dsw-alias-markdown-inline-code": { light: lt(0.10), dark: dk(0.12) },
			// scrollbars
			"--dsw-alias-scrollbar-bg-l1": { light: lt(0.25), dark: dk(0.25) },
			"--dsw-alias-scrollbar-hover-l1": { light: lt(0.45), dark: dk(0.45) },
			"--dsw-alias-scrollbar-bg-l2": { light: lt(0.25), dark: dk(0.25) },
			"--dsw-alias-scrollbar-hover-l2": { light: lt(0.45), dark: dk(0.45) },
		};
	}
// The backdrop is body-level so it needs no product DOM selectors; the theme
	// presenter owns body[data-ds-dark-theme], which doubles as the scheme switch.
	function backdropCss(imageUrls) {
		// An absent URL is a normal state, not an error: a custom skin's colours
		// are known from the index before its image has been read back, and the
		// tokens' own background colour is what should show until it lands.
		const layer = (url, gradient) => url === undefined
			? "  background-image: none;"
			: `  background-image: linear-gradient(${gradient}), url('${url}');`;
		return [
			"body {",
			layer(imageUrls.light, "rgba(247, 250, 255, 0), rgba(247, 250, 255, 0.15)"),
			"  background-size: cover;",
			"  background-position: center;",
			"  background-attachment: fixed;",
			"}",
			"body[data-ds-dark-theme] {",
			layer(imageUrls.dark, "rgba(4, 6, 14, 0.02), rgba(4, 6, 14, 0.22)"),
			"}",
		].join("\n");
	}

	// Switcher UI styling, static across skins (colors ride on theme vars).
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
		"}",
	].join("\n");

	// Locale dictionaries; the locale service is optional so the plugin still
	// works in compositions without it (labels then fall back to English).
	const NS = "dsh-skin-miku";
	const DICTS = {
		zh: {
			tooltip: "切换皮肤",
			opacity: "透明度",
			"skin.ninja": "忍者", "skin.sakura": "樱花", "skin.bamboo": "竹林", "skin.ronin": "落日", "skin.ryujin": "苍龙",
			"custom.section": "我的皮肤",
			"custom.add": "添加自定义皮肤",
			"custom.defaultName": "自定义",
			"custom.more": "更多操作",
			"custom.rename": "重命名",
			"custom.delete": "删除",
			"custom.deleteConfirm": "删除这款皮肤？",
			"custom.confirm": "确认删除",
			"custom.cancel": "取消",
			"custom.busy": "正在处理图片…",
			"custom.pickHint": "这张图里没找到可用的主色，自己选一个吧",
			"custom.save": "用这个颜色",
			"error.not-an-image": "请选择图片文件",
			"error.vector-unsupported": "暂不支持 SVG，请用 PNG／JPEG／WebP",
			"error.too-large": "图片太大了，上限 40MB",
			"error.import-failed": "处理这张图失败了",
			"error.image-missing": "这款皮肤的图片已丢失，已切回默认皮肤",
			"error.storage": "浏览器存储不可用，无法保存",
		},
		en: {
			tooltip: "Switch skin",
			opacity: "Transparency",
			"skin.ninja": "Ninja", "skin.sakura": "Sakura", "skin.bamboo": "Bamboo", "skin.ronin": "Ronin", "skin.ryujin": "Ryujin",
			"custom.section": "My skins",
			"custom.add": "Add custom skin",
			"custom.defaultName": "Custom",
			"custom.more": "More actions",
			"custom.rename": "Rename",
			"custom.delete": "Delete",
			"custom.deleteConfirm": "Delete this skin?",
			"custom.confirm": "Delete it",
			"custom.cancel": "Cancel",
			"custom.busy": "Processing image…",
			"custom.pickHint": "No usable colour in that image — pick one yourself",
			"custom.save": "Use this colour",
			"error.not-an-image": "Please choose an image file",
			"error.vector-unsupported": "SVG is not supported yet — use PNG/JPEG/WebP",
			"error.too-large": "That image is too large (40MB limit)",
			"error.import-failed": "Could not process that image",
			"error.image-missing": "This skin's image is gone; reverted to the default",
			"error.storage": "Browser storage is unavailable, so nothing could be saved",
		},
	};

// The de-facto "skin/outfit" glyph: a t-shirt outline.
	function ShirtIcon() {
		return React.createElement("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
			React.createElement("path", {
				d: "M16.2 4 20 6.5c.4.3.6.8.4 1.3l-1.2 3c-.2.5-.8.8-1.3.6l-1.4-.5v8.1c0 .6-.4 1-1 1H8.5c-.6 0-1-.4-1-1v-8.1l-1.4.5c-.5.2-1.1-.1-1.3-.6l-1.2-3c-.2-.5 0-1 .4-1.3L7.8 4h2.4c.1 1 .8 1.7 1.8 1.7S13.7 5 13.8 4h2.4Z",
				stroke: "currentColor", strokeWidth: 1.5, strokeLinejoin: "round",
			}),
		);
	}

	function apply(ctx) {
		const store = createStore({ idbFactory: globalThis.indexedDB, storage: localStorage });
		// The index is read once, synchronously, so the very first painted frame
		// already knows which skin is active and what its accents are.
		let customEntries = store.list();

		let current = initialSkin();
		let objectUrl;
		let pending = null;      // an import waiting for the user to pick a colour
		let busy = false;
		let error = null;        // an i18n reason, rendered as `error.<reason>`
		let renamingId = null;
		let confirmingId = null;
		let actionsFor = null;

		const storedOpacity = Number(localStorage.getItem(OPACITY_KEY));
		let opacity = Number.isFinite(storedOpacity) && localStorage.getItem(OPACITY_KEY) !== null
			? Math.min(100, Math.max(0, storedOpacity))
			: DEFAULT_OPACITY;
		let disposeTokens;
		const listeners = new Set();
		const notify = () => { for (const fn of listeners) fn(); };

		const backdropTag = document.createElement("style");
		backdropTag.id = "dsh-skin-miku-css";
		const buttonTag = document.createElement("style");
		buttonTag.id = "dsh-skin-miku-button-css";
		buttonTag.textContent = BUTTON_CSS;

		// A custom skin uses ONE image for both schemes -- the per-scheme gradient
		// in backdropCss is what distinguishes them -- so both URLs are the same
		// object URL. It is undefined until the blob arrives.
		function resolvedCustom(entry, url) {
			return {
				id: entry.id,
				label: entry.name,
				accent: entry.accent,
				imageUrls: { light: url, dark: url },
				custom: true,
				entry,
			};
		}

		function initialSkin() {
			const id = localStorage.getItem(STORAGE_KEY);
			const builtIn = BUILT_IN.find((skin) => skin.id === id);
			if (builtIn !== undefined) return builtIn;
			const entry = customEntries.find((candidate) => candidate.id === id);
			// Accents now (they are in the index), image when it arrives.
			if (entry !== undefined) return resolvedCustom(entry, undefined);
			return BUILT_IN[0];
		}

		// Exactly one live object URL at a time. Without the matching revoke, every
		// skin switch would leak a multi-megabyte image for the page's lifetime.
		function adoptObjectUrl(url) {
			if (objectUrl !== undefined && objectUrl !== url) URL.revokeObjectURL(objectUrl);
			objectUrl = url;
		}

		function releaseObjectUrl() {
			if (objectUrl === undefined) return;
			URL.revokeObjectURL(objectUrl);
			objectUrl = undefined;
		}

		// Re-calling overrideTokens with the same source replaces the whole
		// layer, so switching is one call; only the latest disposer matters.
		const applySkin = (skin) => {
			current = skin;
			const k = opacityFactor(opacity);
			disposeTokens = ctx.theme.overrideTokens("dsh-skin-miku", {
				...staticTokens(k),
				...aliasTokens(skin.accent, k),
			});
			backdropTag.textContent = backdropCss(skin.imageUrls);
			notify();
		};

		function rememberActiveId(id) {
			try {
				localStorage.setItem(STORAGE_KEY, id);
			} catch {
				// Losing the memory of the choice is worth saying out loud; the
				// choice itself still applies for this session.
				error = "storage";
			}
		}

		async function selectSkin(id) {
			error = null;
			const builtIn = BUILT_IN.find((skin) => skin.id === id);
			if (builtIn !== undefined) {
				releaseObjectUrl();
				rememberActiveId(id);
				applySkin(builtIn);
				return;
			}
			const entry = customEntries.find((candidate) => candidate.id === id);
			if (entry === undefined) {
				// The remembered id names nothing -- fall back rather than render a
				// skin with no colours and no image.
				rememberActiveId(BUILT_IN[0].id);
				applySkin(BUILT_IN[0]);
				return;
			}
			// Colours first, so the frame painted now is already correct; the image
			// follows one database round trip later.
			applySkin(resolvedCustom(entry, undefined));
			rememberActiveId(id);
			try {
				const blob = await store.blob(id);
				if (blob === undefined) throw new Error("missing blob");
				const url = URL.createObjectURL(blob);
				adoptObjectUrl(url);
				if (current.id === id) applySkin(resolvedCustom(entry, url));
			} catch {
				// The index promised an image that is not there. Drop the promise
				// instead of leaving a skin selected with no wallpaper behind it.
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

		function renameCustom(id, name) {
			const trimmed = name.trim();
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
			const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			return `custom-${suffix}`;
		}

		async function persistImport(result, accent, accentSource) {
			const entry = {
				id: newCustomId(),
				name: `${t("custom.defaultName")} ${customEntries.length + 1}`,
				createdAt: Date.now(),
				accent,
				accentSource,
				thumb: result.thumb,
			};
			try {
				await store.add(entry, result.blob);
			} catch {
				error = "storage";
				return;
			}
			customEntries = store.list();
			// The import is finished as soon as it is stored; clearing `pending`
			// here rather than after the selection means a failure to read the
			// image back cannot leave the user staring at a picker for a skin that
			// is already in their library.
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
					// No usable hue. Asking beats inventing a colour, so hand the
					// user the picker rather than a guess.
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
				// A malformed colour (a browser that reports one, or a stored value
				// that drifted) lands here. Say so instead of leaving the panel on a
				// silent no-op.
				error = "import-failed";
			} finally {
				busy = false;
				notify();
			}
		}

		// One detached file input, reused. Nothing about it needs to be reactive.
		const filePicker = document.createElement("input");
		filePicker.type = "file";
		filePicker.accept = "image/*";
		filePicker.style.display = "none";
		filePicker.addEventListener("change", () => {
			const file = filePicker.files?.[0];
			filePicker.value = "";
			if (file !== undefined) void addFromFile(file);
		});

		ctx.effect(() => {
			document.head.appendChild(buttonTag);
			document.head.appendChild(backdropTag);
			document.head.appendChild(filePicker);
			applySkin(current);
			// The active skin's image, if it has one, arrives a beat later.
			if (current.custom === true) void selectSkin(current.id);
			// Best effort: without this Chromium may evict the library under disk
			// pressure. A refusal changes nothing about how the plugin works.
			try {
				void navigator.storage?.persist?.();
			} catch {
				// No storage manager, or it refused. Nothing to do.
			}
			// Only opens the database for users who actually have custom skins, so
			// an IndexedDB that is unavailable (private mode) cannot trouble anyone
			// who never imported one. The bounded cost is that an orphan left by a
			// failed delete of the LAST skin survives until the next import.
			if (customEntries.length > 0) void store.sweep().catch(() => {});
			return () => {
				disposeTokens();
				releaseObjectUrl();
				filePicker.remove();
				backdropTag.remove();
				buttonTag.remove();
			};
		}, "dsh-skin-miku: skin layer");

		// Optional locale service: registered when present, English fallback when not.
		let t = (key) => DICTS.en[key] ?? key;
		const locale = ctx.get("locale");
		if (locale !== undefined) {
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
				// Closing while the colour picker is up abandons that import. The
				// image was never written to the library, so there is nothing to
				// undo -- but `pending` has to be dropped here rather than merely
				// forgotten, or reopening the menu would resurrect the picker for
				// a file the user had already walked away from.
				pending = null;
				renamingId = null;
				confirmingId = null;
				actionsFor = null;
			};

			const choose = (id) => {
				void selectSkin(id);
				close();
			};

			// One row shape for both kinds of skin. The name is the only difference:
			// a built-in looks its label up, a custom skin carries the user's own
			// string and must NOT be passed through t(), or their text would be
			// treated as a dictionary key.
			const row = (key, label, dotColour, thumb, isActive, onSelect, trailing) =>
				React.createElement("div", { className: "dshSkinSwitcherRow", key },
					React.createElement("button", {
						className: "dshSkinSwitcherItem",
						"data-active": isActive ? "" : undefined,
						onClick: onSelect,
					},
						thumb === undefined
							? React.createElement("span", { className: "dshSkinSwitcherDot", style: { background: `rgb(${dotColour})` } })
							: React.createElement("img", { className: "dshSkinSwitcherThumb", src: thumb, alt: "" }),
						React.createElement("span", { className: "dshSkinSwitcherName" }, label),
						isActive ? React.createElement("span", { className: "dshSkinSwitcherCheck" }, "✓") : null,
					),
					trailing,
				);

			const customRow = (entry) => {
				if (renamingId === entry.id) {
					return React.createElement("div", { className: "dshSkinSwitcherRow", key: entry.id },
						React.createElement("input", {
							className: "dshSkinSwitcherInput",
							defaultValue: entry.name,
							autoFocus: true,
							onKeyDown: (event) => {
								// Commit on blur, which both Enter and a click elsewhere
								// produce; Escape marks the commit as cancelled first.
								if (event.key === "Escape") event.currentTarget.dataset.cancel = "1";
								if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
							},
							onBlur: (event) => {
								const cancelled = event.currentTarget.dataset.cancel === "1";
								const value = event.currentTarget.value;
								renamingId = null;
								if (!cancelled) renameCustom(entry.id, value);
								forceRender();
							},
						}),
					);
				}
				if (confirmingId === entry.id) {
					return React.createElement("div", { className: "dshSkinSwitcherRow", key: entry.id },
						React.createElement("div", { className: "dshSkinSwitcherConfirm" },
							React.createElement("span", { className: "dshSkinSwitcherName" }, t("custom.deleteConfirm")),
							React.createElement("button", { "data-danger": "", onClick: () => { void deleteCustom(entry.id); close(); } }, t("custom.confirm")),
							React.createElement("button", { onClick: () => { confirmingId = null; forceRender(); } }, t("custom.cancel")),
						),
					);
				}
				if (actionsFor === entry.id) {
					// In place rather than as a popup: a nested floating layer inside
					// the scrolling list would be clipped by it, and every extra
					// overlay has to re-argue with shell.overlay's pointer-events rule.
					return React.createElement("div", { className: "dshSkinSwitcherRow", key: entry.id },
						React.createElement("div", { className: "dshSkinSwitcherConfirm" },
							React.createElement("button", { onClick: () => { renamingId = entry.id; actionsFor = null; forceRender(); } }, t("custom.rename")),
							React.createElement("button", { "data-danger": "", onClick: () => { confirmingId = entry.id; actionsFor = null; forceRender(); } }, t("custom.delete")),
							React.createElement("button", { onClick: () => { actionsFor = null; forceRender(); } }, t("custom.cancel")),
						),
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
						onClick: () => { actionsFor = entry.id; forceRender(); },
					}, "⋮"),
				);
			};

			const builtInRows = BUILT_IN.map((skin) =>
				row(skin.id, t(skin.labelKey), skin.accent.darkAccent, undefined, skin.id === current.id, () => choose(skin.id), null));
			const customRows = customEntries.map(customRow);

			// The section heading doubles as the only separator between the two
			// lists, so an import that is still in flight -- busy, with the entry
			// not yet in the index -- must draw it too, or the "processing" line
			// would read as a caption on the built-in skins.
			const sectionHeader = customEntries.length === 0 && !busy
				? null
				: React.createElement("div", { className: "dshSkinSwitcherSection" }, t("custom.section"));

			const opacityRow = React.createElement("div", { className: "dshSkinSwitcherOpacity" },
				React.createElement("div", { className: "dshSkinSwitcherOpacityLabel" },
					React.createElement("span", null, t("opacity")),
					React.createElement("span", null, `${opacity}%`),
				),
				React.createElement("input", {
					type: "range", min: 0, max: 100, step: 5, value: opacity,
					onChange: (event) => {
						opacity = Math.min(100, Math.max(0, Number(event.target.value)));
						try {
							localStorage.setItem(OPACITY_KEY, String(opacity));
						} catch {
							// Same failure mode as the index; the slider still works.
						}
						applySkin(current);
					},
				}),
			);

			const defaultHex = toHex(parseRgb(current.accent.lightAccent));
			const picker = React.createElement("div", { className: "dshSkinSwitcherPicker" },
				React.createElement("p", null, t("custom.pickHint")),
				React.createElement("div", { className: "dshSkinSwitcherPickerRow" },
					React.createElement("input", {
						type: "color",
						value: picked ?? defaultHex,
						onChange: (event) => setPicked(event.target.value),
					}),
					React.createElement("button", { onClick: () => { void savePicked(picked ?? defaultHex); } }, t("custom.save")),
					React.createElement("button", { onClick: () => { pending = null; setPicked(null); forceRender(); } }, t("custom.cancel")),
				),
			);

			const body = pending !== null
				? picker
				: React.createElement(React.Fragment, null,
					React.createElement("div", { className: "dshSkinSwitcherList" },
						builtInRows,
						sectionHeader,
						customRows,
					),
					busy ? React.createElement("div", { className: "dshSkinSwitcherNotice" }, t("custom.busy")) : null,
					error === null ? null : React.createElement("div", { className: "dshSkinSwitcherNotice", "data-error": "" }, t(`error.${error}`)),
					React.createElement("button", { className: "dshSkinSwitcherAdd", onClick: () => filePicker.click() }, `+ ${t("custom.add")}`),
					opacityRow,
				);

			return React.createElement(React.Fragment, null,
				open ? React.createElement("div", { className: "dshSkinSwitcherBackdrop", onClick: close }) : null,
				React.createElement("div", { className: "dshSkinSwitcher" },
					React.createElement("button", {
						className: "dshSkinSwitcherBtn",
						title: t("tooltip"),
						"aria-label": t("tooltip"),
						onClick: () => (open ? close() : setOpen(true)),
					}, React.createElement(ShirtIcon)),
					open ? React.createElement("div", { className: "dshSkinSwitcherMenu" }, body) : null,
				),
			);
		}

		ctx.slots.inject("shell.overlay", () => ctx.slots.register(
			{ name: "shell.overlay", id: "dsh-skin-switcher", label: () => "dsh-skin-miku" },
			SkinSwitcher,
		));
	}
  exports.name = name;
  exports.inject = inject;
  exports.apply = apply;
  return module.exports;
}});