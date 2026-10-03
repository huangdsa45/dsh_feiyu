# @local/dsh-pet — 桌面大肥鱼（DSH 客户端插件）

把大肥鱼挂在 DeepSeek Harness GUI 的右下角。**纯前端浮层**：不新增后台进程、不注册任何模型可见内容（无 tool / skill / command，零 token 占用）、不发起任何对外的网络请求。

> **本仓库只包含这个插件**（`lib/` + `assets/` + `test/` + `tools/`）。
> 桌面版 Python 项目（PySide6 桌宠本体）在 [MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop)，不在本仓库。
> 动画素材的第三方授权声明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 它怎么工作

```
宿主半 lib/index.js                    客户端半 lib/client.js
  ctx.webServer.register('/dsh-pet') ──► fetch('/dsh-pet/clips.json')
  ctx.webServer.tapIndex(注入 base)  ──► window.__DSH_PET__.base
  (只读文件 + 单段 Range)                 <video> 播放 selected clip
```

- 客户端注册进官方浮层插槽 **`shell.overlay`**（该层天生 `pointer-events:none`，只有大肥鱼本体接管点击）。
- 宿主半只做两件事：把包内 `assets/` 以严格白名单提供出去、往首页注入一行 `window.__DSH_PET__`。**没有定时器、没有子进程、没有对外请求。**
- 之所以要宿主半：内置的前端 dist 服务器不支持 HTTP Range，而 `<video>` 在 seek/循环时会发 Range 请求。

## 设计红线

1. **绝不影响正常使用 DSH**：不订阅任何宿主事件、不碰审批/提问、不改任何 DSH 状态；插件任何一步失败都只表现为「没有桌宠」。
2. **绝不多占后台**：同一时刻只解码 1 个 `<video>`；没有轮询；页面隐藏即暂停；定时器只有 1 个 250ms 的调度节拍（隐藏时不工作）。

## 当前功能

动画链（待机/转向/动作/移动，概率 30/10/40/20，与桌面版一致）、随机自言自语气泡（默认 20–60s）、点击回应、拖拽与抛出、气泡（时长 `1200ms + 60ms/字`，夹 2.5–8s）、位置记忆（localStorage）、右键设置面板；彩蛋：**边缘探头**（贴到视口左右边自动倾斜）、**黄金回旋**（连点三次逐圈加速）、**撞边旋转**（抛出撞到边界）、**拖文件互动**（只播反应动画，**从不读取文件**）。

14 段精选动画（6.41MB）+ 一张内联待机帧（随 `clips.json` 内联，`assets/` 里一个图片文件都没有），素材由 `tools/build_assets.py` 从上游桌面项目的素材目录生成（**该源素材目录不随本仓库分发**；脚本只读源素材、不改动）。

## 性能：为什么待机是静止的

**待机时 DOM 里根本没有 `<video>`**，只显示内联的静态帧；解码器只在点击/拖拽/抛出/随机事件时挂载，播完立刻卸载。这不是偷懒，而是唯一能满足「空闲 CPU < 0.5%」的做法：浏览器里 24fps 的 VP9 **alpha** 视频是**软件解码**，一直播就是持续单核占用。右键面板可切「待机动画（常开）」，观感更活但 CPU 显著上升。

**测量教训（重要）**：不要把 renderer 的 CPU 直接当成插件开销。实测同一台机器、同一时刻：桌宠**关闭**时 renderer 84%，桌宠**开启（静止）**时 78% —— renderer 里绝大部分是 DSH 界面自身（尤其超长会话）的渲染。**只有背靠背 A/B 差值才能说明问题**，且最好在空会话里复测。

## 硬性实现约定（都踩过坑）

1. **只内联唯一一张待机帧，绝不用文件海报**。静态帧只在「没有在播动画」时显示，而那个状态永远是待机；给每段动画配一张 `.png` 既不会显示，又会在宿主白名单不认该扩展名时变成 **404**，被 Chrome 画成**带边框的破图占位**（用户看到的白色框）。现在 `clips.json` 顶层放一份 `idle_poster`（data URL），`assets/` 里**一个图片文件都没有** —— 零图片请求，破图框在结构上不可能出现。也**不要**把静态帧设成命令式的 `visibility:hidden`：节点跨片段复用，一旦单向下隐藏就再也回不来（表现为「播完一段动画后永久消失」）。
2. **静态帧与 `<video>` 绝不同时可见**（重影的根因）。两层都是满舞台同几何，同时绘制时可见轮廓 = 待机姿势 ∪ 动作姿势：实测每次动作会多画 **2%–14%** 的第二套轮廓，就是用户报的「重影」。规则是**任一时刻只有一个图层在画**：`playing` 时静态帧改成状态驱动的 `opacity:0`（可逆、节点仍挂载），并把同一张内联帧设为 `<video poster>` 接住交接瞬间（像素一致 → 不闪空白）。推论两条：① 每个片段用**全新的 `<video>` 元素**（`key` 含 clip id），复用的元素会在换源期间继续画上一段的末帧；② 静态帧被隐藏后，「解码器不出帧」等于空白角落，所以 `onError` 与 `play()` 被拒都必须回落到静态帧（没有静态帧可退时改为红条报错，不许静默空白）。
3. **抽静态帧必须用 `libvpx-vp9` 解码器**。VP9 的 alpha 在 BlockAdditional 的独立 alpha 流里，ffmpeg 原生 `vp9` 解码器**会丢掉它**，产出不透明黑底帧（桌宠坐在一块黑方块上）。`tools/build_assets.py` 已强制该解码器，并加了 **alpha 取值区间门禁**：`min(alpha) == 255` 视为黑底，拒绝使用。注意只查 PNG 颜色类型是不够的——`-pix_fmt rgba` 会产出「颜色类型 6 但 alpha 全 255」。
4. 尺寸变化必须重锚，面板不能挂在桌宠盒子里；拖动用 `translate3d` + **rAF 合并**；设置持久化是 **250ms trailing debounce**，拖动期间不写盘。
5. **尺寸固定 50%**（`FIXED_SCALE`）：按需求去掉了大小滑块，640×360 画布 → 320px 宽。
6. **插槽注册走 `ctx.effect`**：`apply()` 用 `ctx.effect(register)` 托管 `ctx.slots.inject(...)` 的 disposer（同 profile 的 `deepseek-wallpaper` 是同一写法）。少了它，插件重载/销毁后旧注册不会释放，页面里会同时挂两只桌宠——各自独立随机链，同样表现为重影。宿主没有 `ctx.effect` 时退回直接注册。


## 安装（desktop profile）

1. **profile 依赖**：`~/.dsh/profiles/desktop/package.json`（Windows：`C:\Users\<你>\.dsh\profiles\desktop\package.json`）→ `dependencies` 加
   ```json
   "@local/dsh-pet": "link:E:/vibecoding/dsh-pet-indesktop"
   ```
   （`link:` 指向**本仓库根目录**，即 `package.json` 所在的那一层）
2. **bundle 列表**：同文件 `dsh.profile.bundles` 末尾追加 `"@local/dsh-pet"`
3. **模块链接**：`...\profiles\desktop\node_modules\@local\dsh-pet` → junction 到本仓库根目录
4. **重启 DeepSeek Harness**（desktop profile 未声明 `patchReload: live`）

## 卸载

删掉上面 3 处 + 清 localStorage 里 `dsh-pet.*` 的键，重启。插件不写文件、不改配置、不起进程，没有宿主侧残留。

## 排障

| 现象 | 处理 |
|---|---|
| 右下角什么都没有 | 确认 3 处改动 + 已重启；DevTools Console 搜 `[dsh-pet]` |
| 出现红色条 | 面板会写明失败原因（`clips.json` 取不到 / 结构不合法） |
| 视频区黑框 | VP9 alpha 未生效，记录后走回落方案 |
| `window.__DSH_PET_DEBUG__` | 控制台可 `__DSH_PET_DEBUG__.state()` 查看当前 clip / 模式 / 位置 |

## 开发

```powershell
# 重新生成素材（改 tools/build_assets.py 的 CLIPS 后）
# 需要上游桌面项目的 assets/characters/shenshen/videos/ 素材目录（不随本仓库分发）
python tools/build_assets.py
# 测试（37 项：客户端纯逻辑/渲染树 + 宿主路由安全边界）
node --test "test/*.test.mjs"
```

约定：`lib/client.js` 必须是**惰性 CJS factory**（`window.__ModuleLoader__.load({ id, factory })`），`id` 等于包名，**不能出现 `import`/`export`**，也不能 `require` 同包的兄弟文件——所有客户端代码必须在同一文件里；纯函数通过 `exports.__test` 暴露给测试。没有构建步骤，改动后重启应用生效。
