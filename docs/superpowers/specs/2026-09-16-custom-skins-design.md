# 自定义皮肤（用户导入壁纸 + 自动取色）设计

日期：2026-09-16
状态：设计已确认，待实现
插件：`dsh-skin-miku`（仓库 `d:\DSH\deepseek-harness\tmp\wall`，独立 git 仓库）

## 1. 背景与目标

插件目前内置 5 款皮肤（忍者／樱花／竹林／落日／苍龙）。每款皮肤 = 一张浅色壁纸 + 一张深色壁纸 + 一套 5 个配色值，作用于整个 UI（表面、边框、按钮、滚动条、代码块底色）。

目标：让**最终用户在运行时导入自己的壁纸**，插件从图里自动提取主色并推导出整套配色，效果与内置皮肤对等。

成功标准：

- 用户导入一张图，无需任何其他操作，UI 立刻变成以该图为主色的完整皮肤。
- 自动取色不可靠时（灰阶图、对比度救不回来），退化为让用户手选一个主色，而不是给出一套难看的配色。
- 自定义皮肤与内置皮肤在切换器里并列，可切换、可重命名、可删除。
- 导入的图在处理后足够小（约 600KB–1.5MB），不会撑爆浏览器配额，也不会让切换皮肤时掉帧。

## 2. 已确认的决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 存储位置 | **仅浏览器本地（IndexedDB）** | 不需要服务端上传接口、不需要鉴权设计。代价是只在这台机器的这个浏览器生效 |
| 自定义范围 | **一张图 + 自动取色** | 用户零额外操作；配色由图中主色推导 |
| 数量 | **可存多个，组成皮肤库** | 与内置皮肤并列，可切换／重命名／删除 |
| 导入处理 | **统一压缩**：长边 ≤2560px 的 WebP q0.9 | 单张落到 300KB–1MB，比内置 PNG 还小；彻底避开大图卡顿 |
| 压缩上限 | 超过 **40MB** 的文件在解码前拒绝 | 不校验的话一张 100MB 的图会拖死标签页 |
| 矢量图 | **不支持 SVG** | `createImageBitmap` 对无固有尺寸的 SVG 行为不一致 |
| 取色失败 | **让用户手动选一个主色** | 用户可控，避免「传了黑白照整个 UI 变灰」 |
| 色彩空间 | **OKLCH**（不先用 HSL） | 「自动取的颜色在不同色相下观感一致」是本功能的成败点 |
| 代码组织 | **加 esbuild 构建**，源码拆多文件 | 客户端半边否则只能是 ~900 行的单文件 |

## 3. 现状与约束（已勘定）

这些是设计必须贴着的事实，来自对 harness 仓库的实测：

1. **客户端半边只能是单文件。** 客户端模块图的一行 = 一个包（`WebBootEntry.id` 的注释原文是 "Entry name == package name"），工厂收到的 `require` 按**包名**解析而非相对路径。所以不能拆出 `client/store.js` 让 `client/index.js` 相对 require。这是引入 esbuild 的直接原因。

2. **`theme.overrideTokens(source, tokens)` 只能设 CSS 变量，不能带图片。** 签名见 `packages/client/ui-theme/src/client/index.ts:308`；`ThemeTokenOverrides = Record<string, ThemeTokenModes>`，`ThemeTokenModes = { light: string; dark: string }`（两者皆必填），插件传的值在 `validateOverrides`（同文件 383–403）里做运行时校验。壁纸因此必须沿用现有的「往 `document.head` 插 `<style>`」机制——这也正是 blob URL 能用的地方。

3. **`shell.overlay` 是 `kind: 'list'`、`scope: 'root'`**，声明于 `packages/client/ui-layout/src/client/index.ts:91`，渲染进 `AppFrame.module.css:90-99` 的 `.overlayLayer { position:absolute; inset:0; z-index:20; pointer-events:none }`，其直接子元素自动 `pointer-events:auto`。现有切换器已吃到这条规则。`slots.register(options, component)` 返回 disposer；`slots.inject(name, cb)` 用于等待尚未声明的 slot。

4. **本仓库没有 IndexedDB / Cache API / 文件系统访问的先例**，也没有 `ctx.storage` 这类浏览器侧存储服务。`packages/client` 里唯一的浏览器本地持久化是 `localStorage`（JSON，~5MB），`URL.createObjectURL` 只被当作临时预览用（`ui-conversation/src/client/service.ts:77,602` 等）。

5. **桌面端主窗口的源是 `dsh-app://app/index.html`**（`apps/desktop/src/main.ts:26,173`），自定义 scheme 注册为 `standard: true, secure: true, supportFetchAPI: true`（同文件 45-50）——是真实元组源而非不透明源。**且 `localStorage` 在该源下已正常工作**（现有的皮肤选择与透明度就是靠它持久化的），不透明源连 `localStorage` 都会失效。这是 IndexedDB 可用的强证据，但**不是证据本身**，见风险 1。

6. **现有代码把资源的 URL 前缀写死在模板里**：`client.js:140,146` 的 `backdropCss` 硬编码 `/skin-miku/${file}`，而 `index.mjs:7` 注册的 `ROUTE_PREFIX` 也是 `/skin-miku`。两者靠人工保持一致（`test/assets.test.mjs` 现在守着这个契约）。本设计要解掉这个耦合。

## 4. 架构：模块划分

`client/src/` 拆 5 个文件，esbuild 打成 `client/client.js`（提交进仓，发布用它）：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `index.js` | 插件入口：`apply(ctx)`、inject、注册 slot、装配。**唯一调用 `require("react")` 的地方** | 其余全部 |
| `store.js` | 持久化：localStorage 索引 + IndexedDB 图片字节 | 无 |
| `image.js` | 导入管线：File → 解码 → 缩放 → 编码 → Blob；含纯函数 `targetSize` | 无 |
| `palette.js` | **纯函数**：ImageData → 主色；主色 → 4 个 accent；OKLCH 转换；对比度保底 | 无 |
| `switcher.js` | 切换器 UI（列表／导入／选色／重命名／删除）+ 样式 | palette, store |

`palette.js` 与 `image.js` 不碰 DOM 状态，所以能被 `test/` 直接 import 做单元测试。

**react 的注入规则（硬约束）**：任何模块都不得写 `import React from "react"`。现有产物是唯一入口，`window.__ModuleLoader__.load({ factory: (require) => {...} })` 里的 `require` 是**工厂的参数**；若某模块 `import react`，esbuild 会把 `require("react")` 提升到 IIFE 顶层，即跑到 factory 外面，而那里没有 `require`，运行时直接抛错——且只在插件真被加载时才暴露。正确做法是 `index.js` 在 factory 内部 `require("react")` 一次，再作为参数注入（如 `createSwitcher({ React, ... })`）。这也与现有代码把 `React.createElement` 一路穿下去的风格一致。

## 5. 数据模型

**关键决定：元数据放 localStorage，只有图片字节放 IndexedDB。**

```js
// localStorage: "dsh-skin-miku:custom" → JSON 索引，小、可同步读
[{
  id: "custom-<uuid>",
  name: "我的海景",                    // 用户可改
  createdAt: 1757000000000,
  accent: {
    darkAccent: "129, 140, 248", darkAccentSoft: "165, 180, 252",
    lightAccent: "79, 70, 229",  lightAccentDeep: "67, 56, 202",
  },
  accentSource: "auto" | "manual",
  thumb: "data:image/webp;base64,...",  // 48×48，约 1–2KB，供列表渲染
}]

// IndexedDB: db "dsh-skin-miku" v1 / store "blobs" / 外置 key = id → Blob
```

选这个拆分是为了**开机零闪烁**：`localStorage` 是同步 API，第一帧就能读到「当前选中哪款、它的 accent 是什么」，配色立刻正确。只有壁纸图片本身需要等 IndexedDB 异步取回，晚一拍贴上来。若把 accent 也放 IndexedDB，启动瞬间只能先渲染内置默认色、等异步回来再跳一下，那个跳变可见。

**统一抽象**：内置与自定义皮肤归一到同一形状再进渲染管线：

```js
{
  id,
  label,                                        // 内置查词典；自定义直接用用户填的名字
  accent: { darkAccent, darkAccentSoft, lightAccent, lightAccentDeep },
  imageUrls: { light, dark },                   // 内置 '/skin-miku/x.png'；自定义 blob: URL
  dispose?(),                                   // 自定义：吊销 object URL
}
```

`aliasTokens` 与 `backdropCss` 只认这个形状。`backdropCss` 不再硬编码 `/skin-miku/` 前缀，改由皮肤自己给出 URL（解掉第 3 节的约束 6）。

**id 空间**：内置 id 为 `ninja`/`sakura`/…；自定义为 `custom-<uuid>`，无碰撞。`localStorage["dsh-skin-miku:skin"]` 存的就是这个 id。

**object URL 生命周期**：全程只保留一个 `activeObjectUrl`，切换或卸载时 `revokeObjectURL` 旧的。这是 `packages/client` 里唯一有先例的 blob 用法，必须严格配对，否则每切一次皮肤泄漏一张几 MB 的图。

## 6. 启动时序

```
同步第一帧
  ├─ 读 localStorage["dsh-skin-miku:skin"] 与 ":custom" 索引
  ├─ 解析出目标皮肤（内置 → 直接用；自定义 → 用索引里的 accent，壁纸暂缺）
  └─ applySkin()：配色此刻已完全正确，无闪烁
异步紧随其后
  ├─ await store.load()：IndexedDB 取回选中款的 blob
  ├─ URL.createObjectURL(blob) → 重新 applySkin()，壁纸贴上
  └─ 孤儿清扫：listBlobIds() 删掉不在索引里的 blob
降级
  └─ 若 IndexedDB 打不开、或选中款的 blob 不存在
     → 回退内置默认皮肤 + 从索引清掉该条 + 提示一次
     → 不留「选中了但没图」的状态
```

## 7. 取色算法（`palette.js`）

输入是导入时顺手采出的一张 **128×128 ImageData**（16384 个像素），不是原图。

1. 丢弃 alpha < 0.5 的像素（壁纸有透明区时别让透明像素投票）。
2. **量化**：RGB 各降 **4 bit**（16³ = 4096 个桶）建直方图。

   这里样本量与桶数的配比是有意的：16384 个样本 / 4096 个桶 ≈ 平均每桶 4 个样本，直方图才有统计意义。若用 5 bit（32768 个桶），平均每桶 0.5 个样本以下，`population` 就成了噪声，整条打分链失效。少一位量化同时还把肉眼难分的近似色并到一起，这正是我们要的。

3. 按像素数取前 32 个桶，逐个打分：

   ```
   score = population^0.5 × saturation × lightnessPenalty
   ```

   `population` 开方而非直接用：纯计数会让「一大片灰白背景」永远赢，开方让「数量不少**且够鲜艳**」的颜色有机会胜出。`lightnessPenalty` 在感知亮度 ≈0.55 处最高、两端衰减，压掉白墙与纯黑背景。

4. **中选桶要回收精度**：4 bit 量化会把颜色吸附到 16 级网格上（色阶间隔 16/255），直接拿桶心当主色会有可见偏差。所以取该桶内**原始未量化的像素做平均**，得到精确主色。这一步不能省。

5. 若最高分的 `saturation < 0.15` → 判定**无有效色相**（灰阶照、黑白图），转手动选色。

**主色 → 4 个 accent**：固定色相与饱和度，只分配感知亮度。

| 目标 | 用途 | 目标 OKLCH L |
|---|---|---|
| `lightAccent` | 浅色方案主按钮底色（白字压其上） | ≈ 0.42 |
| `lightAccentDeep` | 浅色方案文本／悬停 | ≈ 0.32 |
| `darkAccent` | 深色方案主体 | ≈ 0.68 |
| `darkAccentSoft` | 深色方案文本／高亮 | ≈ 0.78 |

**为什么必须 OKLCH 而非 HSL**：HSL 的 L 不是感知亮度——同样 L=0.5，黄色看起来远比蓝色亮。按固定 HSL L 夹，黄色系的 `lightAccent` 会亮到白字压不住、蓝色系又偏暗，同一算法在不同色相上给出差别很大的实际对比度。OKLCH 的 L 感知均匀，固定 L 才能让不同色相观感一致。

代价：需手写 sRGB↔OKLCH 变换（sRGB→线性→LMS→OKLab→OKLCH 及逆变换，约 60 行矩阵运算）。零依赖可行。**OKLCH 往返必须单测**（见第 11 节）。

## 8. 对比度保底与降级

推导出的色会铺满整个 UI，必须验：

- `lightAccent` 对白底 `#fff`：**≥ 3:1**（大色块／按钮底色的门槛；正文才要 4.5:1）
- `darkAccent` 对深色底 `rgb(6, 9, 20)`（插件自己的深色 `bg-base`）：**≥ 3:1**

用 WCAG 相对亮度计算。不达标时**保持色相与饱和度、只沿亮度轴往安全方向推**，每步 ±0.02 L 迭代到达标。推到边界仍不达标 → 降饱和度重试，几轮后仍失败 → 判定自动取色不可靠，转手动选色。

**手动选色**：灰阶图与对比度救不回来这两个触发点汇聚到同一个 UI——一个预填了当前内置皮肤 accent 的小选色器。选完走**同一条推导与保底管线**，落库标记 `accentSource: "manual"`。

自动与手动**只在「主色从哪来」这一步分叉**，后面的推导、保底、存储、渲染完全共用一条路。

## 9. 导入管线（`image.js`）

```
File → 前置校验 → createImageBitmap 解码 → 缩放到 ≤2560 → WebP q0.9 编码
                                              ├→ 128×128 ImageData  → palette.js（取色）
                                              └→ 48×48 WebP data URL → 索引 thumb 字段（列表显示）
```

解码后的 bitmap 被复用三次，所以只解码一次：**显示用**的 2560px 重编码、**取色用**的 128×128 原始 ImageData、**列表缩略图**的 48×48 data URL。后两者是两回事——一个是不经编码的像素缓冲（取色只需要像素），一个是编码后的小图字符串（要塞进 localStorage 索引）。

1. **前置校验**（解码前）：非 `image/*` 拒绝；>40MB 拒绝并给明确提示；SVG 拒绝。
2. **解码**：`createImageBitmap(file)`，解码在浏览器内部线程，不阻塞主线程。
3. **缩放**：长边压到 ≤2560，**不放大**（小图保持原尺寸）。优先 `OffscreenCanvas` + `drawImage` + `convertToBlob`；回退普通 `<canvas>` + `toBlob`。
4. **编码**：WebP q0.9。若浏览器不支持编码 WebP（`toBlob` 返回 null 或给回 PNG），**接受它给什么就用什么**，不因格式让导入失败。
5. 纯函数 `targetSize(w, h, maxEdge)` 单独可测：算缩放后尺寸、不放大。

2560px 重编码在主线程约 100–300ms，导入 UI 期间必须有明确忙碌态。

## 10. 存储与一致性（`store.js`）

手写 Promise 封装（约 60 行，不引 `idb` 依赖），依赖注入以便测试：

```js
createStore({ idbFactory, storage })   // 生产传 indexedDB / localStorage
  openDb()            → Promise<IDBDatabase>   // 记忆化，处理 onupgradeneeded
  putBlob(id, blob)   → Promise<void>
  getBlob(id)         → Promise<Blob | undefined>
  deleteBlob(id)      → Promise<void>
  listBlobIds()       → Promise<string[]>
```

**一致性策略**：localStorage 索引是真相，IndexedDB 是附件。所有写入顺序偏向「宁可有孤儿 blob，不可有没图的皮肤」：

- **新增**：先 `putBlob` 成功，再更新索引。中途失败最多留个孤儿 blob（无害）。
- **删除**：先从索引移除，再 `deleteBlob`。
- **启动**：读索引后跑一次 `listBlobIds()` 清扫孤儿。一次只取 key 的轻量调用，能自愈「清了 localStorage 没清 IndexedDB」这类残留。
- **选中时**：只校验当前这一款的 blob 是否存在；不存在 → 回退内置默认 + 从索引清理 + 提示一次。其余款式不做启动全量校验（N 次 IO 不值），等用户点到再验。

**主动申请持久化**：Chromium 在磁盘压力下会驱逐 best-effort 源的存储，用户的自定义壁纸可能某天凭空消失。`navigator.storage.persist()` 正是为这个场景，一行调用，成败不影响功能：

```js
if (navigator.storage?.persist) void navigator.storage.persist()
```

**localStorage 写失败要可见**：`localStorage.setItem` 在配额满或隐私模式下会抛异常。现有 `client.js:274`（存皮肤选择）与 `client.js:292`（存透明度）是裸调用，无 try/catch。索引写入必须包住并给用户明确反馈；**顺手把那两处裸调用也包上**——同一失败模式、同一文件、新代码就写在它们旁边，属范围内收尾。

## 11. 切换器 UI（`switcher.js`）

```
┌─────────────────────────────┐
│ ● 忍者                    ✓ │   ← 内置 5 款，不动
│ ● 樱花                      │
│ ● 竹林                      │
│ ● 落日                      │
│ ● 苍龙                      │
├─────────────────────────────┤
│ 我的皮肤                     │   ← 有自定义皮肤时才出现
│ ▨ 我的海景              ✓ ⋮ │   ← ▨ 是真实缩略图
│ ▨ 猫猫                    ⋮ │
├─────────────────────────────┤
│ + 添加自定义皮肤              │
├─────────────────────────────┤
│ 透明度            50%       │   ← 不动
│ ──────●──────               │
└─────────────────────────────┘
```

**列表用真实缩略图，不用色点**：内置那列是色点（accent 派生），自定义皮肤若也放色点，用户分不清自己那几张图。但**不能**为画缩略图去逐张读 blob——菜单每开一次就是 N 次 IO + N 个 object URL。所以缩略图作为 48×48 WebP data URL 存在 localStorage 索引里（约 1–2KB/款），列表渲染变成纯同步，零 IO、零 object URL。

**不做「缩略图当占位壁纸」**：考虑过开机先把 48×48 放大顶上去、真图回来再换。否掉——2560px WebP 约 600KB，IndexedDB 取回十几到几十毫秒，这一拍感知不到；而放大 48×48 会先闪一张糊成一片的图，比晚一拍难看得多。

**行结构必须重构（不是样式问题）**：现在每项是 `<button className="dshSkinSwitcherItem">`（`client.js:269`）。要在行尾加 `⋮` 就变成 button 嵌套 button——非法 HTML，浏览器会把它拆开，点击行为不可预期。所以行改成：外层 `<div>`，内含一个占满宽度的选择 `<button>`（缩略图 + 名字 + 选中勾）和一个独立的 `⋮` `<button>`。内置 5 款走同一结构，保持视觉一致。

**重命名**：原地把标签换成 `<input>`，Enter／失焦提交，Esc 取消。不开对话框。

**删除**：点 `⋮` → 浮出「重命名／删除」。删除**不用模态框**，就地把该行换成 `删除？[确认][取消]`。删除的代价是那张图从 IndexedDB 消失（原文件还在用户磁盘上，重导入即可恢复），但用户可能刚花时间导入+选色，所以需要一次确认；模态框对这个重量级太重。

**导入流程与忙碌态**：

```
选择文件 → [ 正在处理… ] → 自动取色成功？ ─ 是 → 保存 + 自动选中 + 关菜单
                                        └ 否 → 选色器（预填当前内置 accent）
                                               → 用户选 → 保存 + 选中
```

选色器**替换菜单面板的内容**，不是另起一层浮层——与「重命名原地换 `<input>`」同一个模式。这样只有一层浮层，不必额外协调 `shell.overlay` 的 `pointer-events` 与裁切规则。选色器里 Esc／取消 → **放弃这次导入，不落库**（此时图还没存进 IndexedDB）。

**菜单容量**：列表 `max-height: 40vh; overflow-y: auto`，「添加」与「透明度」两行固定不滚——透明度和当前选择永远够得着。

**i18n**：新字符串补进 `DICTS` 的 zh/en 两份（约 10 条：我的皮肤、添加自定义皮肤、重命名、删除、删除确认、正在处理、未找到主色、存储不可用…）。**自定义皮肤的名字是用户字符串而非词典键**：标签取值必须分叉——内置走 `t('skin.'+id)`，自定义直接用 `skin.name` 不经 `t()`。否则用户输入会被当作键去查表，虽然当下结果看起来对（查不到原样返回），但语义是错的，将来有人改了 `t` 的兜底行为就会出问题。

**明确不做**：键盘方向键导航、`role="menu"`/`aria-expanded` 语义补全、拖拽上传。现有菜单本就没有这些，属既有状态，不在本次范围。

## 12. 构建接线

```json
"scripts": {
  "build": "esbuild client/src/index.js --bundle --format=iife --external:react --outfile=client/client.js",
  "test": "node --test",
  "prepublishOnly": "npm run build"
}
```

- 产物 `client/client.js` **必须提交**——harness 直接读文件，没有构建步骤。
- `files` 保持 `"client/client.js"`，不含 `client/src`（源码在 GitHub 上，npm 包只需产物）。
- `devDependencies` 加 esbuild。
- `--external:react` 是必须的（react 由工厂参数提供，不打包）。

## 13. 测试策略

**`palette.js`（主战场，node 内可真测）**——输入只是 `{data,width,height}`，无需浏览器：

- 纯灰阶图 → 判定「无有效色相」
- 大片白底 + 一小块饱和色 → 选中那块饱和色而非白底（直接验 `population^0.5` 打分设计）
- 纯黑底 + 饱和色 → 验 `lightnessPenalty` 两端衰减
- alpha 全 0 → 不崩、走降级
- 极亮／极暗主色 → 输出的 accent 对底色 ≥3:1
- **OKLCH 往返**：`srgb→oklch→srgb` 对一组已知色回到原值（容差内）。纯数学，必须测——矩阵写错会让所有颜色整体偏移而无人察觉

**`store.js`**：注入 fake `idbFactory` 与 fake `storage`。测 put/get/delete/listBlobIds 往返；测写入顺序（`putBlob` 失败时索引不被改）。

**`image.js`**：只测纯函数 `targetSize`（缩放尺寸、不放大）。解码／编码层需要真实浏览器，**没有自动化测试——这是明确的缺口**，靠手动验证，不假装它被覆盖。

**两个必须挡住的假绿**：

1. **改了源码忘了构建**：加了构建后源码在 `client/src/`、产物在 `client/client.js`，而现有 `test/assets.test.mjs` 读的是产物——不挡就会出现「测试全绿但跑的是旧代码」。加一条断言：源码 mtime ≤ 产物 mtime。
2. **esbuild 把 `require` 提升出 factory**（见第 4 节）：构建产物的冒烟测试——在 node 里 stub `window.__ModuleLoader__` 与一个假 `React`，import 产物、取出 factory、执行它，断言 `exports.name === "dsh-skin-miku"` 且可调 `apply`。这条同时覆盖构建正确性与「产物可加载」。

## 14. 风险

| # | 风险 | 处理 |
|---|---|---|
| 1 | **IndexedDB 可用性未经验证**——本仓库首次使用 | **写功能代码前先验证**（见第 15 节第 1 步） |
| 2 | esbuild 提升 `require` 出 factory，只在运行时暴露 | 构建产物冒烟测试 |
| 3 | `⋮` 浮层可能与 `shell.overlay` 的 `pointer-events`／裁切冲突 | UI 完成后在真实界面点一遍 |
| 4 | `persist()` 可能被拒，存储仍可能被驱逐 | 启动孤儿清扫 + 选中款缺失即回退，**必须实现**，不能只写文档 |
| 5 | `image.js` 解码／编码层无自动化测试 | 明确的手动验证缺口 |

**风险 1 是唯一可能推翻整个方案的**：若 IndexedDB 在真实前端不可用，「只存浏览器本地」就断了，需退回宿主存储——那要加上传接口（`webServer.register` 的 handler 自己读流并设上限）与逐请求 `requestRejection` 鉴权，等于重做第 4–5 节。

## 15. 实施顺序

1. **验证 IndexedDB**（风险 1）——不通过就停下来商量，不要往下做
2. `palette.js` + 测试（纯函数，TDD 最合适）
3. 构建接线 + 冒烟测试（此时产物行为应与今天等价）
4. `store.js` + 测试（注入 fake）
5. 统一抽象重构（`backdropCss` 不再写死前缀）——**不得改变任何可见行为**，现有 4 个测试必须继续绿
6. `image.js` + `targetSize` 测试
7. 切换器 UI（含行结构重构）
8. 端到端手动验证（含风险 3 的点检）

## 16. 本次不处理（已知问题）

- **`/skin-miku` 路由没有鉴权**：`index.mjs` 的 handler 未调用 `connectionOf(ctx).requestRejection(req)`，任何本地调用者都能访问（对比 `packages/host/open-in-app/src/index.ts:185-191` 的做法）。当前只发静态 GET，暴露面低。本次不新增任何写接口，所以不变更；记录在案。
- `client.js` 中 `localStorage.setItem` 的另外两处裸调用仅做 try/catch 收尾（见第 10 节），不改其行为。
