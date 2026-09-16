# dsh-skin-miku

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 换壁纸的插件：5 款内置皮肤，加上**由你自己导入壁纸、自动取色**的自定义皮肤。

装上之后界面右上角多一个衣服图标，点开是皮肤面板：内置皮肤、你的皮肤、透明度滑杆。

## 内置皮肤

| id | 名字 | 主色 |
|---|---|---|
| `ninja` | 忍者 | 青 |
| `sakura` | 樱花 | 玫红 |
| `bamboo` | 竹林 | 绿 |
| `ronin` | 落日 | 橙 |
| `ryujin` | 苍龙 | 靛蓝 |

每款皮肤是一张浅色壁纸 + 一张深色壁纸 + 一套 5 个配色值，配色会铺到整个 UI：表面、边框、按钮、滚动条、代码块底色。跟随系统的明暗主题切换（`body[data-ds-dark-theme]`）。

## 自定义皮肤

「+ 添加自定义皮肤」选一张图，插件会：

1. **校验**：非图片、SVG、超过 40MB 的，在解码前就拒绝并说明原因；
2. **解码一次**，然后复用三次 —— 长边压到 2560px 的 WebP（存储用）、128×128 的像素缓冲（取色用）、48×48 的 WebP data URL（列表缩略图用）；
3. **取色**：4 bit 量化建直方图 → 按 `population^0.5 × 饱和度 × 亮度惩罚` 打分 → 回收桶内原始像素的平均值；
4. **推导配色**：保留色相，在 OKLCH 里按角色分配感知亮度，得到 4 个 accent。

取色不可靠时（灰阶图、饱和度不足、对比度救不回来）**不会硬猜**：面板会换成一个选色器，让你自己挑一个主色，走同一条推导管线，标记为 `manual`。

自动与手动只在「主色从哪来」这一步分叉 —— 后面的推导、保真、存储、渲染完全共用一条路。

## 为什么用 OKLCH

HSL 的 L 不是感知亮度：同样 `L=0.5`，黄色看起来远比蓝色亮。按固定 HSL L 裁剪，黄色系的按钮底色会亮到白字压不住，蓝色系又偏暗 —— 同一套算法在不同色相上给出差别很大的实际对比度。

OKLCH 的 L 感知均匀，固定 L 才能让不同色相观感一致。代价是要手写 sRGB↔OKLCH 变换（约 60 行矩阵运算，零依赖），`test/palette.test.mjs` 里有往返测试守着它。

## 存储

**元数据放 localStorage，只有图片字节放 IndexedDB。**

这不是随手选的：localStorage 是同步 API，第一帧就能读到「当前选中哪款、它的 accent 是什么」，配色立刻正确；只有壁纸图片需要等 IndexedDB 异步取回，晚一拍贴上来。若把 accent 也放 IndexedDB，启动瞬间只能先渲染默认色、等异步回来再跳一下，那个跳变是看得见的。

两个存储会漂移，所以规则是：**索引是真相，blob 是附件。**

- 新增：先写 blob，再更新索引 —— 失败最多留个孤儿 blob（无害），绝不会出现「选中了但没图」；
- 删除：先清索引，再删 blob —— 删了一半也只是留下垃圾，不会留下坏条目；
- 启动：跑一次孤儿清扫，能自愈「清了 localStorage 没清 IndexedDB」这类残留；
- 选中时只校验当前这一款，N 次 IO 不值当。

## 安装

```bash
dsh plugin --profile web add dsh-skin-miku
```

或者直接在 profile 的 `package.json` 里 `link:` 到本地目录（开发时更方便，改完 `npm run build` 刷新页面即可）。

## 开发

```bash
npm install
npm run build   # esbuild 把 client/src/ 打成 client/client.js
npm test
```

- `client/client.js` **必须提交**：harness 直接读文件，没有构建步骤。
- `npm test` 带 `--experimental-test-isolation=none`，让所有测试跑在一个进程里。默认模式要为每个测试文件起子进程，在受限沙箱（无法开命名管道）下会直接 `spawn EPERM`。

### 结构

| 文件 | 职责 |
|---|---|
| `index.mjs` | 宿主半边：注册 `/skin-miku` 静态资源路由 |
| `client/src/index.js` | 插件入口：`apply(ctx)`、主题覆盖、切换器 UI |
| `client/src/store.js` | 持久化：localStorage 索引 + IndexedDB 字节 |
| `client/src/image.js` | 导入管线：校验 → 解码 → 缩放 → 重编码 |
| `client/src/palette.js` | 纯函数：OKLCH 数学、主色提取、accent 推导 |

`palette.js` 与 `image.js` 不碰 DOM 状态，所以能被 `test/` 直接 import。

### 两条容易踩的坑

1. **任何模块都不得写 `import React from "react"`。** 插件是 `factory: (require) => {...}` 加载的，`require` 是**工厂的参数**；`import` 会让 esbuild 把 `require("react")` 提升到 IIFE 顶层，也就是跑到 factory 外面，那里没有 `require`，插件一加载就抛。`test/artifact.test.mjs` 同时挡住这个和「改了源码忘了构建」。
2. **`client/src/` 里加文件后必须 `npm run build`。** 测试读的是产物，构建守卫（源码 mtime ≤ 产物 mtime）会因此变红 —— 这是有意的。

## 测试

59 个测试，全部在 node 里跑，不需要浏览器：

- `palette.test.mjs` —— 色彩数学的主战场：灰阶图判无有效色相、白底vs小块饱和色、极端明暗的对比度保底、OKLCH 往返、以及让循环终止的 NaN 守卫；
- `switcher.test.mjs` —— 用 jsdom + 真 React 把切换器渲染出来点一遍：结构合法性（不能有嵌套 button）、5 款内置皮肤、导入的两条分支、重命名、删除、透明度；
- `store.test.mjs` —— 注入 fake localStorage / IndexedDB，重点测**写入顺序**和一半失败时剩下什么；
- `artifact.test.mjs` —— 构建产物冒烟：能否加载、`require` 有没有跑出 factory、产物是否比源码新；
- `assets.test.mjs` —— 宿主路由与客户端 URL 前缀的契约。

**明确的缺口**：`image.js` 的解码／编码层（`createImageBitmap`、canvas）没有自动化覆盖，需要真实浏览器，靠手动验证。`switcher.test.mjs` 用桩替代了这两者，所以它测到的是「插件怎么用这些 API」，不是「浏览器怎么实现它们」。

## 已知限制

- **皮肤库绑定来源（origin）。** 浏览器按 (scheme, host, port) 三元组隔离存储。默认 `http://127.0.0.1:3080`，**`localhost` 与 `127.0.0.1` 是不同的源**，用 `--port 0` 或改端口也会换源 —— 数据还在磁盘上，只是绑在旧源下，看起来像「皮肤库消失了」。建议固定使用 `dsh web` 自动打开的那个地址。
- **`/skin-miku` 路由没有鉴权。** handler 未调用 `connectionOf(ctx).requestRejection(req)`，任何本地调用者都能访问。当前只发静态 GET，暴露面低；记录在案。
- 不做键盘方向键导航、`role="menu"` 语义补全、拖拽上传。

## 许可

MIT
