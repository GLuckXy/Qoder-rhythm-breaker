# R4 · CORE — 集成收尾轮（selftest 端点接通 + 游玩链路断链修复 + README）

范围：只做 leader 派的 4 件事。**未碰** `src/game/{objects,render,systems/EffectSystem.js}`、`src/data/theme.js`、
`src/audio/` 他人文件、`tools/{screenshotCheck.mjs,verifyAll.mjs}`、`package.json`、`vite.config.js`、`index.html`。

## 门禁结果

| 命令 | 结果 |
| --- | --- |
| `node tools/contractTest.mjs` | `RESULT: PASS 601/601 断言 · 13/13 case · 0 skip`（**未减少、未放松任何断言**） |
| `npx eslint src tools` | 我名下文件 **0 error 0 warning**。剩余 3 条全在他人文件：`EffectSystem.js:437` warning、`Timeline.js:529` / `screenshotCheck.mjs:1840` parse error（WORLD 本轮正在改，收工时快照） |
| `npm run build` | **红**，唯一报错点 `src/game/objects/Timeline.js (529:29): Expression expected` —— WORLD 名下、正在编辑（本会话第一次 lint 时该文件还是干净的，几分钟后出现语法错）。CORE 名下模块无错 |
| `npx vite --port 5199` + curl | `/` → HTTP 200（503B，`#game-root / #ui-root / #debug-root` 三个挂载点齐全）；`/src/main.js` → 200（含 `world-selftest/v1`）；`/src/game/scenes/LevelRuntime.js` → 200。**dev 链路无 500** |

`tools/contractTest.mjs:1654` 的未使用参数 warning：**接手时已不存在**（`npx eslint .` 全仓扫，该文件 0 问题）。
1654 行现状是 `eq('freeorder: L6 完美局无惩罚 MISS', rig.ds.counts().miss, 0);`，无未用形参。

## 一、两个 selftest 端点

路由骨架前任已留（`src/main.js:308 bootSelftest()` / `:321` 只在 `route.selftest` 非空时激活），
本轮**只改 `?selftest=render` 的产出格式**，audio 侧接的 `tools/audioAssert.mjs` 的 `run({levels})` 已核实是浏览器安全的
（`node:fs` 只在 `loadLevels()` 里、且是 `/* @vite-ignore */` 的动态 import；`process.stdout` 只在 `main()` 里，
`run()` 两者都不碰）。

### `?selftest=render` → `window.__WORLD_SELFTEST__`

按 `tools/screenshotCheck.mjs:32-36` 声明的口径产出（`src/main.js:213`）：

```jsonc
{
  "schema": "world-selftest/v1",
  "level": 1,
  "nowSec": 12.34,                       // 只从 BeatClock.now() 取（T4）
  "viewport": { "width": 1280, "height": 720 },
  "dpr": 1,
  "world":    WorldLayer.snapshot(nowSec),                       // {view:{judgeX,pxPerBeat,pxPerSec,rightSpawnX},items:[{id,track,x,y,beatsToJudge}],layers:[…]}
  "timeline": new Timeline().snapshot({view, nowSec, instances}),// {judgeX,pxPerBeat,windowRightX,band,lanes,markerXs:[{id,track,x}]}
  "pixels": [],                                                  // readPixels 归 WORLD，CORE 不猜灰度值
  "checks": { "result": "PASS", "errors": [], "samples": […], "consoleErrors": 0 }
}
```

三个关键点：

1. **上下层吃同一批 instances 与同一个 view**（`main.js:253-261`：`rt.ds.activeInstances()` + `rt.view`），
   否则 `runSelftest` 的「逐实例 x 比对」会走 SKIP 分支。
2. `viewport.width/height` 直接取 `rt.view`，与 `WorldLayer` 建 `judgeX` 用的是同一个数（Phaser RESIZE 的 CSS 像素），
   所以「0.30W 口径」那条断言比对的是同域数字，不含 DPR 混淆。
3. `Timeline` 用 `await import()` + try/catch（`main.js:256-263`）：装不上只降级掉 `timeline` 一项并在 `checks.errors`
   里记名，**不把整页带崩**。代价是 `npm run build` 现在把 `Timeline.js` 纳进浏览器图（见上面的构建红）。

`checks` 是 CORE 自己的结构体检（实例非空 / 坐标有限 / 右侧生成左侧判定顺序 / 上下层判定线一致 / console.error 计数），
顶层多键不影响 `screenshotCheck` 解析。

### `?selftest=audio` → `window.__SOUND_SELFTEST__`

`main.js:181 runSoundSelftest()`：`availableLevelIds()` → `loadLevel(id)` 逐关装载 → `audioAssert.run({levels})`。
CORE 只喂谱面，不改判据。产出 `{result, checked, detail:{version,levels[],errors[],warnings[],notes[],library,ramps,replay,sim}}`。

## 二、游玩链路核实：断链清单与修复

逐项追证的结论（✅ = 原本就通，🔧 = 本轮修复，⚠️ = 通但有保留）：

| 环节 | 调用点 | 状态 |
| --- | --- | --- |
| 打开页面 → Boot → Title | `BootScene.js:74` → `TitleScene.js:38 uiRef.current.showTitle(...)` | ✅ |
| 标题挂进 `#ui-root` | `main.js:130 createUiLayer(...)` → `UiLayer.js:24 mountRoot(deps)` → `dom.js:129-132 getElementById('ui-root')`；index.html 实测有该节点 | ✅ |
| 点开始 → 选关 | `UiLayer.js:96-107 buildTitle({...onSelect:()=>showSelect(), gotoLevel})` | ✅ |
| 选关 → 进 L1 | `UiLayer.js:120 onPick:(id)=>deps.gotoLevel(id)` → `main.js:109 gotoLevel()`（唯一装谱出口） | ✅ |
| 按拍判定 | `LevelRuntime.js:249` 起的 `bindKeys` → `onAction()` → `judge.onInput(action, clock.now())` | ✅ |
| **PERFECT → 音效** | **`engine.playForEvent(ev)` 在全仓 `src/` 里 0 个调用点**（只在 `SoundEngine.js:379` 定义）→ Sfx 八个音效**一个都不响** | 🔧 |
| PERFECT → 掉 hp | `LevelRuntime.js:157 ds.onJudgment(j)`（hp 唯一写入口）→ `DisassembleSystem.js:239 emit 'hp-change'` | ✅ |
| hp=0 → 拆解演出 | `LevelRuntime.js:144 world.sync({clock,instances,view}, extra)` 的第 2 参喂 `extra.disassembledTracks`（`:150`）/ `hpByTrack`（`:149`）/ `revivedIds`（`:187`）→ `WorldLayer.js:158-164` 消费 → `WorldLayer.js:79` 内部 `new EffectSystem(...)` | ✅ |
| **玩家按键 → 角色跳/冲** | **`extra.action` 从未被填过**：`WorldLayer.js:160 this.applyAction(extra.action,…)` 永远收到 `undefined` → 判定与音频照跑、**角色一动不动** | 🔧 |
| 声部静音 | `LevelRuntime.js:178 engine.silence(p.track)`（C6 唯一静音出口，0.1s 斜坡） | ✅ |
| 寂静段光点 | `LevelRuntime.js:194 engine.beatClick(true)` + `onAction()` 的 `state==='SILENCE'` 分支走 `ds.stompDot({atSec})`（不产生 judge 事件、不进分母） | ✅ |
| 终点 → 结算 | `:195 p.to==='RESULT'` → `_finish()` → `onEnd(stats)` → `LevelScene.js:91 ui.showResult(stats,{level})` → `resultScreen` 的 `onNext:(id)=>deps.gotoLevel(id)`（`UiLayer.js:228`） | ✅ |
| 暂停 | `LevelRuntime.js:284 togglePause()` **只**调 `clock.pause()/clock.resume()`（`:287-288`），再 `onPauseChange` → `LevelScene.js:116 syncPauseScreen` → `ui.showPause()`；面板「继续」的唯一解冻路径是 `UiLayer.js:156 rt.togglePause()` | ✅ |
| `shutdown()` 释放 | `LevelRuntime._offs` 单一登记表（键位 / judge 订阅 / ds 四个事件），`shutdown()` 逐条 pop 并 try/catch → `judge.reset()` / `ds.detach()` / `clock.stop()` / `world.shutdown()` / `engine.stop()|dispose()`；`LevelScene.js:57 SHUTDOWN → teardown()`，`main.js:305 game 'destroy'` 再兜一层 | ✅（contractTest 的 20 次重开基线断言通过） |

### 修的两处断链

**① CR-12 唯一音效路由从未接上**（`src/game/scenes/LevelRuntime.js`）

新增 `_sfx(ev)` 转发器（`:161`，带 `typeof engine.playForEvent === 'function'` 守卫 + try/catch 隔离，
engine 抛错不影响判定），在三个事件出口各挂一行：

- `:156` `_onJudgment` → `this._sfx({...j, kind:'judge'})`
- `:173` `_onHpChange` → `this._sfx({kind:'hp', track, hp})`
- `:193` `_onStateChange` → `this._sfx({kind:'state', to:p.to})`
- `:186` `_onRevive` → `engine.playSfx('revive')`

两个必须是这样的理由（都写进代码注释了）：

- **`kind` 必须显式打且必须后写**：C2 的 judgment 自带 `type` 字段（障碍种类 `'spike'`…），而
  `Sfx.sfxForEvent` 取的是 `ev.kind || ev.type`（`Sfx.js:150`）。原样把 judgment 丢进去会被 `type:'spike'` 命中
  `default → null`，一个声都不出。打 `kind` 才走 `case 'judge'`。
- **不在 CORE 侧写任何 `grade → 音效名` 映射**（CR-12 批复）。空拍伪 MISS 的静音由 SOUND 的
  `sfxForJudgment` 用 `penalizes === false` 拦（`Sfx.js:133`）；`'crack'` 的触发条件（`hp === 0`）也写在 SOUND 侧。
  `tempo` 不在这接 —— `SoundEngine.pump()` 自己有 `_pumpList(this.cues, …, playCue)`（`SoundEngine.js:216`），
  再发一次就是双份。`revive`/`ui` 是 SOUND 在 `SFX_TRIGGERS` 里标注的「调用点直发」（C7 没有这两类事件），不算映射。

**② `extra.action` 没喂给 WorldLayer**（`LevelRuntime.js:265`）

`onAction()` 在 `clock.now()` 取样后立刻 `this._extra.action = { kind: action, atSec }`，
下一帧 `update()` 的 `_extra` 交换把它带进 `world.sync(…, extra)`。放在状态分支**之前**，
所以寂静段踩光点也有角色动作。`kind` 只发 `'jump'|'dash'`（W-03 契约里的 `'fine'`/`'hit'` 需要 WORLD 先定义语义）。

## 三、README（K-18）

`README.md`（新建）章节：一句话玩法 → **两条架构主张怎么落地**（双时钟对照表 + 每帧取样顺序 + 「谱面即关卡」
的一 JSON 四消费者数据流）→ 操作说明（`KEYMAP` 全表）→ 本地运行 + **四个 URL 端点表** → 四道 `check:*` 与
`verify:all` 各测什么 → **已知限制 9 条**。

已知限制如实列了：音色无人耳验收、峰值 1.084 可能削峰、六关窗口/密度是纸面参数、多浏览器未测、
`driftMs()` 真机未测、`pixels[]` 为空、build 对 `Timeline.js` 的新耦合、`ui` 音效未接线、无浏览器自动化。
全文只写仓库里真实存在的命令与文件名。

## 四、浏览器实跑最可能崩在哪

1. **`?selftest=render` 的第一次 `world.snapshot()` 里 `view` 缺 `rightSpawnX`/`timelineTop`**。
   `screenshotCheck.runSelftest` 直接读 `wv.rightSpawnX` 和 `t.windowRightX` 比对（`:1890`），
   而 `WorldLayer.snapshot()` 是否导出 `rightSpawnX` 我无从在 Node 里证（它需要 `world.init(真 Phaser host)`）。
   若缺，那条断言红 —— **不是几何错，是负载少字段**，要看 WORLD 的 `snapshot()` 实现。
2. **`window.devicePixelRatio ≠ 1`（Retina / 150% 缩放）**：`view` 用 CSS 像素建 `judgeX`，
   `screenshotCheck` 的「0.30W」容差只有 1.5px，理论上同域不会差，但如果 WORLD 某处在 DPR 之后的画布坐标系里算了几何就会红。
3. **音频没解锁就跑 `?selftest=render`**：`sound.ready` 为 false，我只在 `checks.notes` 里提示（不判红），
   但 `engine.pump()` 在无 ctx 时的行为若抛错会污染 `consoleErrors` → 那条就判红了。这条是 CR-11 自愈路径的真机首测点。
4. **Safari**：`AudioContext.resume()` 的 Promise 语义 + `unlockOnFirstGesture` 的 `touchstart`，从未真机验证。

## 五、要转派的（我不碰他人文件）

- **WORLD**：`src/game/objects/Timeline.js:529` 当前有语法错，**卡住 `npm run build`**（`?selftest=render` 的
  schema 要求负载带 `timeline` 快照，所以该文件已进浏览器图）。另：`EffectSystem.js:437` 的 `nowBeat` 未用参数 warning。
- **WORLD**：`tools/screenshotCheck.mjs:1840` 同批 parse error（收工快照，可能已在改）。
- **SOUND**（非阻塞）：`pixels[]` 若要让 `?selftest=render` 填上真灰度，需要 WORLD/SOUND 给出浏览器侧的
  `readPixels` 入口；CORE 不猜数。
- **leader**：界面按钮的 `ui` 音效要不要接（`SFX_TRIGGERS` 标「调用点直发」，接在 `UiLayer` 的 `mount()` 之后
  每个按钮 handler 上，或给 `dom.js` 的 `binder.on()` 加一个 `onFire` 钩子）。属玩法打磨，不属链路断链。
