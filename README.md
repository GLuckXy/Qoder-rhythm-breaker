# 节奏拆解台（Rhythm Breaker）

一句话玩法：一个自动奔跑的节奏游戏，你按拍跳跃 / 冲刺去**拆解**当前 BGM 的三条声部（鼓 / 贝斯 / 合成）——
每次 PERFECT 打掉该声部 1 点 hp，hp 归零则该声部从音乐里被静音、障碍也不再生成；三条全拆完，曲子进入寂静段，
踩灭最后一束光点即抵达终点并结算评级。

技术栈：Vite + Phaser 3（只当渲染容器）+ 手写 WebAudio 合成器，零外部美术与音频素材。

---

## 两条架构主张是怎么落地的

### 1. 双时钟：判定用拍钟，发声用 AudioContext，二者只做单向换算

| 时钟 | 归属 | 单位 | 负责 | 不负责 |
| --- | --- | --- | --- | --- |
| `BeatClock` | `src/audio/BeatClock.js`（CORE 名下，工程唯一时间权威） | 拍 / 逻辑秒 | `now()` `beatAt()` `timeAtBeat()` `currentBeat()` `pause()/resume()` `driftMs()` | 任何发声 |
| `AudioContext.currentTime` | SOUND 持有（`SoundEngine` 是全工程唯一 `new AudioContext` 处） | 绝对秒 | 逐音源的排程精度 | 判定、生成、UI |

落地方式：

- **判定与调度路径禁止读真实时间**。`JudgeSystem` / `DisassembleSystem` / `LevelRuntime` / 各场景里
  不允许出现 `scene.time`、`this.time.now`、`performance.now()`、`Date.now()`，也不允许 `setTimeout` 型判定
  （这条由 `tools/screenshotCheck.mjs` 的 `render:scan` 与 `tools/contractTest.mjs` 双向扫描把关）。
  需要「何时」一律 `clock.now()`。
- **每帧只取一次样**。`LevelRuntime.update()`（`src/game/scenes/LevelRuntime.js:137`）的顺序是 CR-11 批复的裁决：
  `clock.now()` 取样 → `engine.ensureRunning()` → `engine.pump(nowSec)` → `world.sync(...)`。
  帧序与真实时间无关，所以同一份谱面在 30fps 和 144fps 下判定结果一致。
- **两钟的对齐是预调度窗口**，不是硬同步。`SoundEngine.pump()` 拿 `nowSec` 算出 horizon，把未来一段时间内的事件
  用 `AudioContext` 的绝对时刻排出去（`arm()` 必须在 `clock.start(atSec)` 之后，`LevelRuntime.js:121`）。
  两钟之间的偏差由 `BeatClock.driftMs()` 度量，`?selftest=audio` 的 `sim` 段会把它一起报出来。
- **暂停只有一个权威**：`LevelRuntime.togglePause()`（`LevelRuntime.js:284`）只调 `clock.pause()/clock.resume()`，
  界面层与角色都不许自己停表；恢复后拍序不重置（R11 契约）。

### 2. 「谱面即关卡」同源：一关 = 一个 JSON，音乐域与玩法域读同一份

`src/data/levels/level{1..6}.json` 由 SOUND 维护，是**唯一**的关卡真相。装一关时四个消费者读的是同一个对象
（见 `LevelRuntime.start()`，`LevelRuntime.js:98`）：

```
clock.init({bpm, sections, tempoChanges, introBeats, lengthBeats})   // 时间域
PG.build(cfg, clock)        → instances（障碍 = noteEvents 的玩法投影）// 玩法域
ds.load(cfg, {instances})   → 三声部 hp 与拆解态                       // 玩法域
judge.registerObstacles(instances)                                     // 判定域
engine.loadLevel(cfg, clock) → 音序 / 静音 / 复活斜坡                   // 音乐域
```

推论（也是本项目的纪律）：

- **不存在「关卡编辑器」与「音序器」两套数据**。改一次 `noteEvents` 就同时改了旋律、障碍位置和该声部的 hp 上限。
- 变速段（`tempoChanges`）在两域里都是**按拍等距**换算的，靠的是同一个 `clock`，所以下层时间轴的标记
  和上层障碍的横向间距天然对齐（`WorldLayer` 与 `Timeline` 共用 `view.pxPerBeat`）。
- 同一份 JSON 也被 Node 侧门禁直接消费：`tools/checkLevel.mjs` 校验结构、`tools/audioAssert.mjs` 用假
  AudioContext 断言包络与响度、`tools/screenshotCheck.mjs` 拿真谱面跑一遍几何。**能自证的东西不靠人眼。**

---

## 操作说明

按键定义在 `src/game/scenes/LevelRuntime.js:20`（`KEYMAP`，JDG-01）。

| 键 | 动作 | 说明 |
| --- | --- | --- |
| `空格` / `J` | 跳跃 | 对应需要跳的障碍（固定高度跳，滞空 = 0.9 × 当前拍长） |
| `K` | 冲刺 | 对应需要冲刺的障碍 |
| `[` | 判定延迟 −（向左微调） | 每按一次走 `config.nudgeLatency()` 一档，立刻写进存档 |
| `]` | 判定延迟 + | 同上，反方向。校准值 = `JudgeSystem.setLatency()` |
| `Esc` | 暂停 / 恢复 | 开暂停面板，时钟只由 `clock.pause()/resume()` 决定 |
| `R` | 重开本关 | 与首次进关走完全同一条 `start()` 路径（teardown 基线用） |
| `Q` | 退出本关回标题 | — |

寂静段（三条声部全拆完）里按跳跃/冲刺踩的是**节拍器光点**，不产生判定事件、不进 Perfect 分母。

界面是 canvas 之上的 DOM 覆盖层（`#ui-root`），五块屏：标题 / 选关 / 暂停 / 设置 / 结算，
代码在 `src/ui/screens/`。首次点击或按键会解锁音频（CR-11：解锁监听只挂在 `src/main.js` 一处）。

---

## 本地运行

```bash
npm i
npm run dev        # Vite 开发服务器
npm run build      # 产出 dist/
npm run serve      # 预览 dist/（http://localhost:4173）
```

### 页面内自检端点（agent 没有眼睛和耳朵，这是替代通道）

| URL | 产出 | 消费者 |
| --- | --- | --- |
| `?selftest=render` | `window.__WORLD_SELFTEST__`，schema `world-selftest/v1` | `node tools/screenshotCheck.mjs --selftest <file\|inline-json\|->` |
| `?selftest=audio` | `window.__SOUND_SELFTEST__`（`{result,checked,detail}`） | `tools/audioAssert.mjs` 的同一份判据 |
| `?level=N` | 深链直达第 N 关 | 人工试玩 |
| `?debug=1` | 显示 DebugPanel（`#debug-root`） | 人工试玩 |

把浏览器实测折回门禁：

```bash
# 浏览器里 JSON.stringify(window.__WORLD_SELFTEST__)，存成文件
node tools/screenshotCheck.mjs --selftest ./world-selftest.json
```

另外 `window.__CORE__` 导出只读句柄（`game / clock / judge / ds / engine / ui / gotoLevel / snapshot /
runSoundSelftest / runWorldSelftest`），可在控制台直接调 `__CORE__.snapshot()` 看当前链路状态。

---

## 四道门禁与 `verify:all`

```bash
npm run check:contract   # node tools/contractTest.mjs —— 契约与全流程仿真断言（当前 601 条 / 13 case）
npm run check:level      # node tools/checkLevel.mjs   —— 六关 JSON 的结构合法性（拍数/窗口/密度/休止符）
npm run check:audio      # node tools/audioAssert.mjs  —— 假 AudioContext 跑真谱面：包络、斜坡、轨间响度、loop 对齐
npm run check:render     # node tools/screenshotCheck.mjs —— 渲染几何与配色扫描（分区比、判定线 x、灰度可辨、禁用色）
npm run verify:all       # 依次跑上面四道 + lint，任一红即退出码非 0
```

共同纪律：每道门禁最后一行必须是 `RESULT: PASS|FAIL|SKIP <细节>`；`SKIP` 不算失败但也不算通过，
**不许为了让门禁变绿而放松断言**。`check:render` 在不带 `--selftest` 负载时，浏览器实测那一组会记 SKIP。

---

## 已知限制（如实列，不粉饰）

1. **全项目音色没有人耳验收过**。`check:audio` 只断言结构（事件时刻、gain 包络形状、轨间响度、loop 与拍边界），
   「好不好听 / 像不像 chiptune」是人类门禁，仍是 P0 残留风险。
2. **峰值 1.084，可能削峰**。混音复核记录的总峰值超过 1.0，浏览器实听时可能出现爆音；
   尚未决定是否压 master 或改轨间比例。
3. **六关的窗口与密度是纸面参数，未经试玩验证**。`windowScale`、每关障碍密度、休止符位置由
   `checkLevel` 的静态判据推出来，没有真人通关过一遍，实际难度曲线可能整体偏硬或偏软。
4. **多浏览器兼容未测**。只在 Vite 的 dev/build 链路上验证过；Safari 的音频解锁手势、
   `AudioContext.resume()` 的 Promise 语义、Firefox 的 `OfflineAudioContext` 差异都没有真机跑过。
5. **`BeatClock.driftMs()` 的双钟漂移只有 Node 侧口径验证**，浏览器真机 ≤2ms 这一条待 `?selftest=audio` 实测。
6. **下层时间轴的灰度采样（`pixels[]`）在 `?selftest=render` 里是空数组**。要填它得在浏览器里 `readPixels`，
   绘制真相归 WORLD，CORE 不猜数；`screenshotCheck` 那一组目前按 SKIP 处理。
7. **`npm run build` 依赖 WORLD 名下的 `src/game/objects/Timeline.js` 能解析**——`?selftest=render` 的负载按
   `world-selftest/v1` 契约必须带 `timeline` 快照，所以该文件进了浏览器图。WORLD 编辑期间的语法抖动会连带卡构建。
8. **浏览器实跑目前只覆盖 L1 一条完整路径**（无头 Edge + CDP 可信按键，从起跑到结算）。它抓出了 Node 侧 601 条断言
   测不到的一整类缺陷：拆解/复活把实例摘队后旧超时定时器仍在补发 MISS、`registerObstacles` 的重开语义被热路径复用
   导致已判实例拉回 pending 反复重判（`MISS` 实测冲到 149903）。修法与口径已固化成 `contractTest` 的 `misstorm` case
   （一局 60s 仿真到底 `MISS ≤ 可判对象数`、队列内 id 不重复），但 **L2–L6 的浏览器全流程仍未实跑过**，
   同一类问题是否在多声部/变速关卡里以别的形态出现，尚待逐关验证。
9. **favicon 走内联 data-URI SVG**（`index.html`），不新增素材文件；这同时消掉了 `/favicon.ico` 的两条 404，
   「console 零报错」这条验收线目前只在 L1 路径上核过。
8. **音效里 `revive` / `ui` 两个是「调用点直发」**（SOUND 的 `SFX_TRIGGERS` 明确登记 C7 事件流里没有这两类）。
   `revive` 已接在 `LevelRuntime._onRevive`；**界面按钮的 `ui` 声尚未接线**（不影响判定与音乐）。
9. **无浏览器自动化**：`check:render` 的像素级结论与「五界面点得动」这类事实，目前只能靠人工打开一次页面回贴 JSON。
