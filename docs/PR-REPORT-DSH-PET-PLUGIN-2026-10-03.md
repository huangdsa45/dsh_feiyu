# PR 报告：桌面大肥鱼改造为 DSH 客户端插件（`@local/dsh-pet`）

> **基线**：`2786c15`（Merge PR #190，插件化 DLC 基线）
> **分支**：`main`（本地工作树）　**日期**：2026-10-03
> **范围**：9 个新增文件（实现 5、测试 2、工具 1、文档 1）+ 14 段动画 + 14 张静态帧
> **关联**：本次改造把 `pet/`（PySide6 桌面版）在浏览器端重写为纯客户端插件；Python 侧**零改动**

## 一、核心特性

把桌面肥鱼重做成 DeepSeek Harness 的**纯客户端浮层插件**：注册进官方 `shell.overlay` 插槽，挂在 GUI 右下角，动画/气泡/随机互动/拖拽/彩蛋全部保留；**不新增后台进程，不注册任何模型可见内容（无 tool/skill/command，零 token），不发起任何对外网络请求**。

取舍按用户确认执行：保留动画桌宠、气泡、点击互动、随机互动、角色切换、玩法彩蛋；去除 Agent 联动、审批回写、灵动岛、待办、语音报时、节日、歌词、识屏、AI 聊天、余额、托盘/自启/更新/多开，以及整套 Python 运行时。

**红线 / 不变量**：
- 宿主半只做两件事（只读资源路由 + 注入 base），无定时器、无子进程；
- 任何失败都只表现为「没有桌宠」，绝不抛错进宿主或页面；
- `pet/` 下 Python 代码一个字节都不改（`git status` 仅 `?? plugin/`）。

## 二、修改文件说明

全部为新增（无删除、无改动既有文件）：

### 实现

| 文件 | 行数 | 改动意图 |
|---|---|---|
| `plugin/dsh-pet/package.json` | 39 | 插件清单：`exports["./client"]`、`dsh.client.platform=web`、`dsh.bundle.patch`、`meta.title/description` |
| `plugin/dsh-pet/cordis.patch.yml` | 14 | bundle 补丁：`insert` 宿主条目。**纯 ASCII**（本生态有 patch 文件编码事故史） |
| `plugin/dsh-pet/lib/index.js` | 237 | 宿主半：`ctx.webServer.register({kind:'prefix', path:'/dsh-pet'})` 只读资源路由（严格白名单 + ETag/304 + RFC 9110 单段 Range/416）；`tapIndex` 注入 `window.__DSH_PET__` |
| `plugin/dsh-pet/lib/client.js` | 1210 | 客户端半：惰性 CJS factory，注册 `shell.overlay`；动画链（30/10/40/20）、静态帧待机、气泡、点击/拖拽/抛出、边缘探头、黄金回旋、撞边旋转、拖文件互动、缩放、位置记忆、右键设置面板、隐藏后的恢复入口；**静态帧失败回退**、**尺寸变化重锚**、**rAF 合并**、**持久化去抖**、**合成器定位** |
| `plugin/dsh-pet/tools/build_assets.py` | 213 | 素材流水线：从 `assets/characters/shenshen/videos/` 精选 14 段（只读源素材）→ 平铺 ASCII 名 + ffmpeg 抽首帧 → `clips.json`（待机帧内联为 data URL） |

### 测试

| 文件 | 行数 | 覆盖 |
|---|---|---|
| `plugin/dsh-pet/test/client.test.mjs` | 373 | 通过**真实 loader 桩**加载 `lib/client.js`：id 必须等于包名、文件不得含 `import/export`、`apply` 失败不抛出、动画链阈值、气泡时长夹取、步幅量化、设置清洗、`parseClips` 校验、body_box 换算、**隐藏后必须仍渲染恢复入口**、**静态帧失败回退**、**尺寸重锚**、**rAF 合并**、**持久化去抖** |
| `plugin/dsh-pet/test/host.test.mjs` | 177 | 宿主半：只 inject `webServer`、注册一条前缀路由 + 一次 index 注入、`enabled:false` 全不注册、**目录穿越/未知名/嵌套路径全部拒绝**、方法白名单、**资源必须从包根而非 `lib/` 解析**（回归守卫）、Range 206/416、GET/HEAD 一致 |

### 文档 / 素材

| 文件 | 说明 |
|---|---|
| `plugin/dsh-pet/README.md` | 47 行：架构、红线、安装/卸载（profile 三处 + junction）、排障、开发约定 |
| `plugin/dsh-pet/assets/*.webm` | 14 段精选（6.41 MB），由脚本从仓库高清素材复制生成 |
| `plugin/dsh-pet/assets/*.png` | 14 张静态帧（1.36 MB），ffmpeg 抽首帧 |
| `plugin/dsh-pet/assets/clips.json` | 143 行 / 132 KB：几何常量、概率链、步幅、片段表；待机帧内联 |

### 未改动（故意）

`pet/` 全部 Python、`assets/characters/` 源素材、`pyproject.toml` / `pytest.ini` / CI 工作流、仓库既有测试——本插件是纯新增目录，不参与 Python 打包与门禁。

## 三、实现要点

- **浮层与穿透**：`shell.overlay` 天生 `pointer-events:none`，入口 `<div>` 也显式设 `none`，只有按 `body_box` 定位的命中区接管指针；大肥鱼因此浮在所有栏之上、又不会挡住界面点击。
- **待机不解码**（本 PR 的核心设计）：`<video>` 元素**只在播放时存在**；静止时渲染内联静态帧。这是「空闲 CPU ≈ 0」的唯一可行解，见性能分析。
- **素材投递**：内置 dist 服务器不支持 HTTP Range，而 `<video>` 循环/seek 必发 Range 请求，所以宿主半自建只读路由；白名单是「裸文件名 + 固定扩展名」，请求输入永不参与路径拼接。
- **位置驱动视觉**：沿用桌面版「位置量化成 stride 整数倍」，避免滑步；移动用 rAF，且 `document.hidden` 时停表。
- **不碰文件**：拖入文件只播一段反应动画并冒泡，**从不读取 `dataTransfer.files`**。

## 四、性能分析

**方法（可复现）**：`Get-Process` 取 `TotalProcessorTime`，按 Chromium 进程类型（`--type=renderer` / `gpu-process`）分别采样 60 s，除采样时长得单核占用率。环境：Windows / 16 逻辑核 / DeepSeek Harness 桌面端（Electron）。

**实测（同一会话、背靠背 A/B，唯一变量是桌宠是否挂载）**

| 状态 | renderer | gpu-process | 合计（单核口径） |
|---|---|---|---|
| 桌宠**完全关闭**（`显示桌宠` 取消勾选） | 50.500 s → **84.17%** | 32.953 s → **54.92%** | **139.09%** |
| 桌宠开启（默认静态待机） | 46.516 s → **77.53%** | 32.922 s → **54.87%** | **132.40%** |

**结论**：桌宠的边际开销**低于测量噪声**（开启甚至比关闭低 6.7 个百分点）。★ 重要教训：先前把「整机 renderer 负载」当成桌宠负载，得出过一次 34% 的错误结论；实际那 139% 几乎全是**本会话本身**（超长对话历史）的 DSH 界面渲染开销。测插件开销必须做 A/B 差值，不能在繁忙界面上单点测量。

逐条回答：

| 问题 | 结论 |
|---|---|
| ① 稳态开销有没有变化 | **没有可测量变化**；静止待机时 DOM 中不存在 `<video>`，无解码器、无 rAF、无网络请求 |
| ② 新增路径的绝对成本与触发频率 | 唯一周期任务是 1 个 **250 ms** 的 `setInterval`（纯比较，不 setState）；动画仅由点击/拖拽/抛出/随机事件触发，播完即卸载解码器 |
| ③ 有没有新的系统调用/网络/磁盘/线程 | 无系统调用、无子进程、无线程；网络仅**同源本地** `GET /dsh-pet/*`（首次加载资源，带 ETag，命中 304）；宿主半只 `stat`+`createReadStream` 读包内文件 |
| ④ 内存与缓存有没有增长 | 素材总量 7.74 MB（14 webm + 14 png + clips.json），`<video>` 生命周期随播放结束销毁；渲染器 RSS 在 A/B 两次采样中无可归因于插件的增长 |

**素材/包体**：`plugin/dsh-pet/assets` **6.54 MB**（14 段 webm 6.41 MB + clips.json 0.13 MB，含内联待机帧；**不含任何图片文件**），预算 8 MB，脚本超预算即失败。

## 五、实机运行记录

**环境**：本机 Windows，DeepSeek Harness 桌面端（Electron），GUI `http://127.0.0.1:19387`，profile = `desktop`。

1. **安装**：profile `package.json` 增加 `link:` 依赖 + `dsh.profile.bundles` 追加；`node_modules\@local\dsh-pet` junction；`dsh plugin --profile desktop install`（pnpm v11.7.0，`Already up to date`）后 `pnpm-lock.yaml` 已登记该依赖。
2. **首次启动失败与根因**（真实输出，非推断）：页面显示 `大肥鱼加载失败：clips.json 404（base=/dsh-pet 宿主注入=无）`。用 HTTP 探测定位到**响应体长度为 0** → 该 404 来自内置静态兜底而非本插件处理器。进一步发现真因：`lib/index.js` 在 `lib/` 子目录，而代码用 `new URL('.', import.meta.url)` 解析包根，实际指向 `<包>/lib/`，导致每次查文件都落在 `<包>/lib/assets/...`。**修复：改为 `new URL('..', ...)`**。
3. **修复后验证（服务器端实测）**：
   - `GET /dsh-pet/clips.json` → `200 application/json; charset=utf-8`，2402 字节，14 段
   - `HEAD /dsh-pet/idle_breath.webm` → `200 video/webm`，`Content-Length: 441437`，带 `ETag: W/"6bc5d-1a10104fe10"`
   - `GET` + `Range: bytes=0-1023` → **`206`**，`Content-Range: bytes 0-1023/441437`，`Content-Length: 1024`
4. **用户可见行为确认**：用户重启后反馈「重启过后已经可以正常显示了」；随后按提示 Ctrl+R 并确认「大肥鱼还是静止的（默认关待机动画）」。
5. **失败路径观察**：Resource 不可达时红色错误条**显示 base 与宿主注入状态**并提供「重试」按钮（本次即靠它拿到关键线索）；`enabled:false` 时宿主半不注册任何东西。
6. **第三个真实缺陷（用户实测暴露，已修）**：用户为做 A/B 基准取消勾选「显示桌宠」后，重启应用发现**大肥鱼再也回不来**。根因是客户端把「隐藏」实现为整棵树 `return null`，而设置面板正在同一棵树里，于是没有任何回 UI 的入口；该偏好又持久化在 localStorage，刷新/重启都无法恢复。修复：隐藏时改为渲染角落一枚 **🐟 恢复按钮**（点击即恢复），并把它放在 `clips.json` 加载之前，使恢复入口不依赖资源路由是否健康。**服务器端复核**：问题报告时 `/dsh-pet/clips.json` 与 `/dsh-pet/idle_breath.webm` 均为 200，证明插件与宿主半都正常，纯属客户端 UX 缺陷。
7. **第二轮：用户实测报「时不时突然消失 + 大小滑块很卡且拖动不改变」**（四条缺陷，全部为客户端实现问题，宿主半无责）：
   - **消失**：`HEAD /dsh-pet/idle_breath.png` 实测 **404**（宿主进程启动 18:39:13 早于含 `.png` 白名单的 `index.js` 改于 18:41:28）→ 每张静态帧加载失败 → 原实现用 `style.visibility = "hidden"` **永久**隐藏该 `<img>`，而该节点跨片段复用 → 播完第一段动画后**永久空白**。修复：改为**状态化回退**到内联待机帧（`resolvePosterFile`），且**绝不改 DOM**；`<img>` key 带片段 id；极端情况下回退渲染 `<video>`，保证任何情况都有画面。
   - **滑块拖动不改变尺寸**：`pos` 不随 `scale` 重锚，桌宠以左上角为锚向右下生长，在屏幕右下角时**长到屏幕外**。修复：`anchorAfterResize()` 保持**右下角固定**并 clamp 进视口，放大时向内生长。
   - **滑块卡**：设置面板挂在尺寸会变的 stage 内（`position:absolute; right:0`），拖动时控件从指针下漂移；且每次设置变化**同步写 localStorage**。修复：面板移出 stage 改为独立 `position: fixed`（由 `pos` 计算、越界翻转），持久化改 **250ms trailing debounce**（卸载时 flush）。
   - **拖动桌宠卡**：`setPos` 按指针事件频率提交，且用 `left/top` 定位触发 layout。修复：`createFrameCoalescer()` 把位置提交合并到**每帧一次**；stage 改用 `translate3d` 走合成器，边缘探头的旋转下移到内层，两个 transform 不再互相覆盖。
8. **第三轮：用户报「算了大小固定 50%，另外把框框和黑色背景去掉」**（两条，均在客户端/素材侧）：
   - **黑色背景**：用户截图显示桌宠坐在一块纯黑矩形上。根因是**抽静态帧时用错了 ffmpeg 解码器**——VP9 的 alpha 存在 BlockAdditional 的独立 alpha 流里，ffmpeg **原生 `vp9` 解码器会丢弃它**，只输出不透明黑底帧（实测 alpha 全为 255，颜色类型 2）；换成 **`libvpx-vp9`** 后 alpha 区间恢复为 `(0, 255)`。修复：构建脚本强制 `-c:v libvpx-vp9 -pix_fmt rgba`，并加 **alpha 取值区间门禁**（Pillow 解出 alpha 的 min，`min == 255` 即判定为黑底并**拒绝使用该帧**）。
     - ⚠️ **踩过的坑**：第一版门禁只查 PNG IHDR 颜色类型（6 = 有 alpha），结果**拦不住**这个问题——`-pix_fmt rgba` 会产出「颜色类型 6 但 alpha 全 255」的帧。已改为解出真实 alpha 取值，并在 Node 测试里**手写 PNG 解码**（zlib inflate + 逐行反滤波）验证产物像素。
   - **框框（白色破图占位）**：左键点击会换到一段新的点击动画，而该动画的静态帧 `/dsh-pet/click_*.png` 仍是 404（宿主进程早于 `.png` 白名单），Chrome 把失败的 `<img>` 画成**带边框的破图占位**；上一轮的「失败回退」虽然会救回来，但**那一帧破图已经画出来了**，且每换一段就闪一次。
     - **最终做法（比回退更彻底）**：意识到「每段动画各自的静态帧」是多余的——静态帧只在**没有播动画**时显示，而那个状态**永远是待机**（播完/走完/点击结束都会回到待机）。于是改为**只内联唯一一张待机帧**（`idle_poster`，顶层一份，不再逐片段重复），并**删除全部 `.png` 产物**。结果：**零图片请求 → 零 404 → 破图框在结构上不可能出现**，同时素材从 8.35 MB 降到 **6.54 MB**。
   - **尺寸固定 50%**：按用户要求**移除大小滑块**，改为常量 `FIXED_SCALE = 0.5`（640×360 画布 → 320px 宽），同时删掉 `scale` 设置键（旧存档里的该键被忽略）。
   - **素材预算**：带 alpha 的 PNG 更大，逐片段落盘时总量一度到 **8.35 MB 超出预算**（脚本如实返回非零并用预算门拦住）。最终方案不再产出 PNG 文件，产物目录 **6.54 MB / 8 MB**；预算门已改为统计**真实产物目录**而非只看 webm 源。
9. **无法自动验证的部分**：`shell.overlay` 的视觉层级（大肥鱼会被打开的下拉菜单/弹窗盖住，这是该插槽 `z-index:20` 的固有语义）只能人工目视；自动化浏览器不可用，故以服务器端 HTTP 断言 + 用户目视确认替代。

## 六、测试与验证

| 门 | 命令 | 结果 |
|---|---|---|
| 静态检查（插件） | `node --check lib/client.js` / `lib/index.js` | 通过 |
| 插件测试 | `node --test "test/*.test.mjs"` | **29 passed / 0 failed** |
| 断言有效性（宿主包根） | 临时把 `new URL('..')` 改回 `'.'` 重跑 | **新守卫变红（2 项失败）**，还原后全绿且文件哈希与原来一致 |
| 断言有效性（隐藏恢复入口） | 临时把隐藏分支改回 `return null` 重跑 | **守卫变红（1 项失败）**，还原后全绿且哈希一致 |
| 断言有效性（静态帧回退） | 临时去掉失败回退分支 | **守卫变红（fail 1）**，还原后全绿 |
| 断言有效性（尺寸重锚） | 临时让 `anchorAfterResize` 恒返回原位置 | **守卫变红（fail 1）**，还原后全绿 |
| 断言有效性（rAF 合并） | 临时让合并器立即提交 | **守卫变红（fail 1）**，还原后全绿 |
| 断言有效性（持久化去抖） | 临时让 `schedule()` 立即写盘 | **守卫变红（fail 1）**，还原后全绿 |
| 断言有效性（静态帧 alpha） | 临时把抽帧解码器换回原生 `vp9` 重建 | **构建拒绝全部 14 帧**（打印警告），**测试变红（`found 0`）**，还原后全绿且脚本哈希一致 |
| Python 侧零回归 | `git status --short` | 仅 `?? plugin/`，`pet/` 无改动 |
| 契约检查 | 测试内断言 | `id` 必须等于包名；文件**不得含 `import/export`**；`apply` 失败不抛出 |

## 七、已知限制与后续

- **默认静止待机**：拍板依据是「空闲 CPU < 0.5%」这条硬红线——持续 24 fps VP9 alpha 解码在浏览器里是**软件解码**，任何「一直动」的实现都无法满足。右键面板可切「待机动画（常开）」换取观感，此时 CPU 会显著上升（本次未能单独测准，因测量环境被本会话 UI 噪声淹没；建议在空会话里用 DevTools Performance 复测）。
- **不做**：像素级鼠标穿透（浏览器无此能力）、跨窗口遮罩（层级低于菜单/弹窗）、OS 级托盘/自启/更新。
- 素材为 14 段精选（原 106 段 70 MB）；如需更多表情，改 `tools/build_assets.py` 的 `CLIPS` 后重跑，脚本会守住 8 MB 预算。

## 八、风险与回滚

- **影响面**：仅新增 `plugin/dsh-pet/`，不触碰 Python 运行时、打包脚本与 CI；不注册任何模型可见内容，不订阅任何宿主事件。
- **回滚**：从 profile `package.json` 移除依赖项与 bundles 条目 + 删 `node_modules\@local\dsh-pet` junction + 清 localStorage 的 `dsh-pet.*` 键，重启即可；插件不写文件、不改配置、不起进程，无残留状态。
- **`pet/` 是否受影响**：不受影响，Python 桌面版仍可独立运行。

---

# 第二轮修正：动作重影（2026-10-03 追加）

> 按 [`PR-REPORT-TEMPLATE.md`](PR-REPORT-TEMPLATE.md)「后续轮次在同一文档追加章节」的约定追加，不改写上文。
> **基线**：`2786c15` + 第一轮插件（`plugin/` 尚未提交）。**触发**：用户实机反馈「小肥鱼在做动作时会有重影」（附截图）。

## 第二轮 · 核心特性

**根因（确定性）**：客户端渲染里，内联待机帧 `<img>` **永远挂载**，播放时再把 `<video>` 追加在它后面，两者共用同一份满舞台几何（相同 `left/top/width/height`）。VP9 alpha 视频的透明处会露出下层 `<img>`，于是合成出的可见轮廓 = **待机姿势 ∪ 动作姿势**——每次动作都多画出一套轮廓，即用户看到的「重影」。桌面版一次只画一张 pixmap，所以这是插件独有的缺陷。

**实测量化**（内存中解码真实素材，不落盘；命令见「第二轮 · 性能分析」）：

| 片段 | 时刻 | 动作姿势像素 | 修复前可见像素（并集） | 多出的鬼影像素 | 占比 |
|---|---|---|---|---|---|
| move_run | 2.0s | 38303 | 43737 | 5434 | **14.2%** |
| turn_look | 0.7s | 37957 | 42796 | 4839 | **12.7%** |
| click_happy | 2.0s | 37167 | 40679 | 3512 | **9.4%** |
| act_stretch | 0.7s | 39073 | 40143 | 1070 | 2.7% |
| move_run | 0.0s | 39626 | 40482 | 856 | 2.2% |

**第二处根因（独立成立，一并修正）**：`apply()` 直接 `ctx.slots.inject(...)`，没有用 `ctx.effect` 托管注册返回的 disposer（同 profile 的 `deepseek-wallpaper` 是标准写法 `ctx.effect(() => ctx.slots.inject(...))`）。插件一旦被重载/销毁，旧注册不会释放 → 页面里同时挂两只桌宠，各自独立随机链 → 一只静止一只动，同样表现为重影。

**红线 / 不变量**：
- 任一时刻**最多一个图层**在绘制角色；
- 解码器在跑时**不得**出现空白帧（静态帧由 `<video poster>` 用同一张图接管）；
- 空闲路径不变：待机时 DOM 里依然没有 `<video>`、无新定时器、无新请求。

## 第二轮 · 修改文件说明

`plugin/` 至今未被 git 跟踪（`git status` 仅 `?? plugin/`），`git diff --numstat` 没有可比基线；下表用「改动前实测行数 → 改动后实测行数」替代，并逐处列出改动位置。

| 文件 | 行数 | 改动 |
|---|---|---|
| `plugin/dsh-pet/lib/client.js` | 1184 → **1256**（净 +72） | 6 处，见下 |
| `plugin/dsh-pet/test/client.test.mjs` | 460 → **723**（净 +263） | 新增 8 项测试 + 渲染树播种工具 |
| `plugin/dsh-pet/README.md` | 75 → **77**（净 +2） | 硬性约定 4 条 → 6 条；订正过期描述 |
| 本报告 | 138 → +本节 | 追加第二轮三份证据 |
| `docs/INDEX.md` | 1 行 | 「PR 报告存档」该行补记重影修复 |

`lib/client.js` 的 6 处（行号为改动后）：

| # | 位置 | 改了什么 | 为什么 |
|---|---|---|---|
| 1 | `mediaLayers()` :196-214 | 新增纯函数：由 `playing`/`posterSrc` 决定"谁可见" | 把"单层可见"变成可断言的不变量，而不是散在 JSX 里的条件 |
| 2 | `failRef` :361-363 | 新增"最新回落"引用，供只注册一次的 handler 使用 | `visibilitychange` 只注册一次，却必须调到最新回调（与既有 `tickRef` 同法） |
| 3 | `visibilitychange` :476 | `.catch(() => {})` → `failRef.current(error)` | 恢复播放被拒时回落到静态帧，而不是把桌宠留在空白上 |
| 4 | 播放/失败路径 :692-739 | 抽 `settleToIdle()`；新增 `onPlayRejected`（忽略 `AbortError`）与 `onVideoError`（有静态帧则回落，没有则走红条报错）；`onEnded` 复用它 | 静态帧被隐藏后"解码器不出帧"= 空白角落，必须把每条失败路径都收口到静态帧 |
| 5 | 渲染段 :954-998 | 按 `mediaLayers` 出层：`playing` 时静态帧 `opacity:0`；`<video>` 带 `poster`、`src`/`loop` 改声明式、`key` 含 clip id、挂 `onError` | 修复本体：两层不再同时绘制；每片段换新元素，杜绝"旧片段末帧 + 静态帧"再次叠影 |
| 6 | `apply()` :1207-1232 | 注册改由 `ctx.effect(register, "dsh-pet: overlay")` 托管；宿主无 `ctx.effect` 时退回直接注册 | 第二处根因；同时保证旧宿主不会因此不出桌宠 |

## 第二轮 · 实现要点

- **交接不闪**：`<video poster>` 与 `<img>` 是同一张内联 data URL、同一几何 → 隐藏 `<img>` 的同一帧里视频已画出同样的像素，首帧解码完成后才换成动画帧。
- **单元素不可能画两张图**：每个片段用全新 `<video>` 元素（`key` 含 clip id），换源期间不存在"上一段末帧 + 新一段"的叠加窗口，因此不需要引入 `loadeddata` 中间态。
- **失败也要有画面**：`onError` → 有静态帧回待机、无静态帧走既有红条；`play()` 被拒时忽略 `AbortError`（正常的换源打断），其余同样回落。
- **隐藏是可逆状态，不是 DOM 变更**：静态帧节点仍挂载、只改 `opacity`（旧坑是命令式 `visibility:hidden` 单向下隐藏，节点跨片段复用后再也回不来）。

## 第二轮 · 性能分析

**方法（可复现，无 mock）**

```powershell
# 1) 缺陷量化：内存解码真实素材，比较 alpha 掩膜（不写任何文件）
python -c "...imageio_ffmpeg + Pillow：idle_poster vs 各片段帧的并集/交集..."
# 2) 新增热路径微基准
node -e "...mediaLayers(...) × 2,000,000..."
# 3) 周期性 API 清点（证明没有新增定时器/请求）
node -e "src.split(token).length-1"
```

环境：Windows / 16 逻辑核 / Node v24.12.0 / Python 3.12.4。

| 指标 | 实测 | 归属 |
|---|---|---|
| 修复前每次动作多绘制的轮廓像素 | **2.2%–14.2%**（样本：4 段 × 5 个时刻，见上表） | 缺陷本体（本次消除） |
| `mediaLayers()` 调用成本 | **5.7 ns/次**（2,000,000 次） | 新增路径；每次渲染 1 次，非每帧 |
| `setInterval` / `setTimeout` / `fetch(` | 1 / 1 / 1（改动前后相同） | 未新增任何定时器、网络或线程 |
| `XMLHttpRequest` / `createReadStream` / `new Audio` | 0 / 0 / 0 | 客户端仍不碰文件与音频设备 |
| 插件测试 | 29 项 148.7 ms → **37 项 165.3 ms** | 新增 8 项守卫 |

**结论**：① 稳态开销无变化——待机路径一个字节没动（新测试断言"静止的桌宠挂载 0 个 `<video>`"）；② 新增路径只有 1 次 5.7 ns 的纯函数调用 + 每个动作 1 次 `poster` 属性赋值（同一张已解码的内联图，无新请求）；③ 未引入任何新的系统调用/网络/磁盘/线程；④ 内存不增长，动作期间反而少合成一层。**唯一未自动测准的**：`<video poster>` 在真实 Chromium 里的首帧交接耗时——本机无浏览器自动化（探针结论见下一节），因此不上报推断数字。

## 第二轮 · 实机运行记录

1. **活跃实例探测（本机真实环境）**：插件此刻正被 GUI 加载，宿主路由实测可达——
   `GET http://127.0.0.1:19387/dsh-pet/clips.json` → `200 application/json; charset=utf-8`，138130 字节；
   `HEAD http://127.0.0.1:19387/dsh-pet/idle_breath.webm` → `200 video/webm`，441437 字节，带 `ETag`。
   证明"重影"不是资源缺失（缺失只会表现为不显示或破图框）。
2. **素材侧排除**：`idle_poster` 为内联 PNG、alpha 取值区间 `(0,255)`（非黑底）；`assets/` 里 0 个图片文件 → 不存在 404 破图框叠影。
3. **用户可见行为确认（已完成）**：本 profile 未声明 `patchReload: live`，本机也没有 DSH 源码 checkout 在跑 `dev:web`，客户端 bundle 只在宿主启动时装配——**必须重启 DeepSeek Harness 才生效**；重启宿主会终止 agent 会话，故该步骤由用户执行。
   - **重启取证**：`Get-Process` 显示全部 `DeepSeek Harness` 进程启动于 **2026-10-03 19:50:18**（本轮改动落盘于 19:31 之前），即运行中的确实是修复后的客户端 bundle。
   - **重启后路由复核**：`GET /dsh-pet/clips.json` → 200（138130 字节）、`HEAD /dsh-pet/idle_breath.webm` → 200（441437 字节，`ETag: W/"6bc5d-1a10104fe10"`，与重启前一致 → 素材未变，偏差只来自客户端渲染）。
   - **用户确认（原话）**：「我已重启，没用再出现重影了应该是修复好了」——重启后依次做过单击、连点（黄金回旋）、拖拽、抛出与随机动作，**未再出现第二套轮廓**。
   **探针（用于将来分流，DevTools Console）**：`document.querySelectorAll('[data-dsh-pet-stage]').length`（期望 1；若为 2 则第二处根因是主因）、`document.querySelectorAll('video').length`（待机 0 / 动作 1）。本次修复后现象消失，无需该探针进一步分流。
4. **无法自动验证的部分**：本机没有可驱动的浏览器（无 Playwright/CDP 依赖，且 DSH 网页需要鉴权：`GET /` 未带凭据返回 **401**），故"重影"的视觉确认只能由用户目视完成；替代证据是上表 2.2%–14.2% 的像素级量化 + 新增的渲染树断言。

## 第二轮 · 测试与验证

| 门 | 命令 | 结果 |
|---|---|---|
| 语法 | `node --check lib/client.js` | 通过 |
| 插件测试 | `cd plugin/dsh-pet; node --test "test/*.test.mjs"` | **37 passed / 0 failed**（29 → 37） |
| 断言有效性 ①（静态帧恒可见） | 临时改回 `style: mediaStyle` | **红**：`a playing pet hides the still frame and hands it to the decoder poster` |
| 断言有效性 ②（`<video>` 无 poster） | 临时删 `poster: layers.videoPoster \|\| undefined,` | **红**：同一项 |
| 断言有效性 ③（无 `onError` 回落） | 临时删 `onError: onVideoError,` | **红**：回落项 + 报错项 |
| 断言有效性 ④（无 `ctx.effect`） | 临时改成 `if (false) ctx.effect(...)` | **红**：`the overlay registration is owned by ctx.effect ...` |
| 还原校验 | 四轮注入后重算哈希 | 与注入前**逐字节一致**（`sha256=03c9a724a2ea8a41bf58a0e8fb6ca258fc76b546d99ec1c93a2cbb68efeb9626`） |
| Python 侧 | 未改动任何 `pet/**`；`git status` 仅 `M docs/INDEX.md` 与未跟踪插件目录 | 全量 pytest 豁免理由：本改动不进入 Python 运行时 |

## 第二轮 · 已知限制与后续

- **本轮已闭合并经实机确认**：2026-10-03 19:50 重启宿主后，用户确认单击/连点/拖拽/抛出/随机动作均不再出现重影。若日后再现，按第 3 步探针判定；若 `[data-dsh-pet-stage]` = 1 且 `video` ≤ 1，则该现象不来自本仓库可控的两处根因，须登记宿主浮层合成侧的探针证据，不做猜测。
- `onError` 回落后 `nextChainAt = 0`，下一拍（250 ms）会再挑一个随机片段；若某片段在宿主侧被拒，会周期性重试（不卡死，但持续失败）。片段集是 14 个实际存在的文件，属可接受边界。

## 第二轮 · 风险与回滚

- **影响面**：仅 `plugin/dsh-pet/lib/client.js`（客户端）与其测试；宿主半 `lib/index.js`、素材、`clips.json` schema、Python 运行时、打包与 CI 全部未改。
- **回滚**：还原本轮前的 `lib/client.js` 并重启应用即可；插件不写文件、不改配置、不起进程，无残留状态。
