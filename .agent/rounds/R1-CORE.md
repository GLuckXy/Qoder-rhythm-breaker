# R1 · CORE 收工报告（K-01 K-02 K-04 K-08 K-06 K-03）

轮次：R1（= D1 + D2 前半）｜ 写入者：CORE ｜ 时间：2026-11-23
本文件只记 CORE 名下事实；未跑过的命令一律写「未跑」。

---

## K-01 · BeatClock + MockClock（C1）

**做了什么**
- `src/audio/BeatClock.js`：全项目唯一时间真相。`buildTempoMap()` 把 `{bpm, tempoChanges}` 编译成
  分段（常量段 + ramp 段）映射；**ramp 段对「拍长（周期）」线性插值**，积分是梯形 →
  `localSecOfBeat` 解析可积，`beatOfLocalSec` 用数值稳定二次根 `x = 2dt/(p0+√(p0²+4k·dt))` 反解，
  因此 `beatAt / timeAtBeat` **严格互逆**（不是等速除法，R7/P1-6）。
- 预调度：`CLOCK_POLL_MS=25` + `CLOCK_LOOKAHEAD_SEC=0.12`，单一优先队列按**绝对时刻**升序插入
  （`_pushSorted` 尾部上溯，插入顺序不影响执行顺序）；每轮派发前先 `_pump(horizon)` 补充谱面事件，
  再用 `born/_cycle` 时间戳隔离「本轮新建项」，杜绝重排回调在同 tick 内自激循环。
- `start(atSec)/stop()/pause()/resume()`：`resume()` 只做 `_originSec += delta` 并平移队列项的 `at`，
  **不重置拍序**（R11/P1-7）；`schedule()` 返回退订函数（幂等，`item.dead` 标记，teardown 无残留）。
- 状态机 `CLOCK_STATES` 与 `setState()` 非法名 `RangeError`；`onEvent` 推 `beat|section|state|tempo`。
- `driftMs()`：定义 = 轮询间隔抖动 EMA（在权威时钟上量，**不使用** `performance.now()`，T4）。
- `now()` 在无 AudioContext（Node）时退回 `_originSec`；AudioContext 只在 `attach()/start()` 时惰性建，
  **import 时零副作用**，所以 WORLD/SOUND 在 Node 里 import 不会炸。
- `src/mocks/MockClock.js`：`extends BeatClockCore`，注入 `now` 源 + `manual:true`，与 BeatClock
  **同一个类、同一套语义**；新增 `advanceTo/advanceBy/advanceSteps/flush/time/loadAndStart`，
  `ready()/unlock()` 恒真。这是 WORLD/SOUND 的离线依赖，已可 import（SOUND 的 `checkLevel` 已在用同款口径）。

**验证**
```
$ node tools/contractTest.mjs --case clock
PASS clock        72/72 断言
       · 120→140 变速点 timeAtBeat/beatAt 互逆误差 = 6.09e-12 ms（正向，最坏点 64.180 拍）/ 7.11e-12 ms（反向）
RESULT: PASS 72/72 断言 · 1/7 case · 0 skip
```
覆盖点：42 拍/3 段落事件计数、变速两侧互逆、`schedule` 提前 ≤120ms、暂停 30s 恢复后拍序连续且不重不漏、
乱序插入队列按绝对时刻派发、退订后不派发、`stop()` 后队列为空且无幽灵回调、MockClock 与 BeatClock 同名方法一一对齐。

**未完成 / 风险**
- 浏览器侧 `driftMs() ≤ 2ms` **未在真机验证**（Node 无 AudioContext，只能验证口径与抖动算法）→ R2 用 `?selftest=1` 页面实测。
- `sections` 驱动的 `state` 事件已发，但没有消费者（K-05/K-07 在 R2 接）。

---

## K-02 · JudgeSystem + config（C2）

**做了什么**
- `src/data/config.js`：L-01 基准窗 ±60/±110ms，`strict` ±50/±100，下限 40/80；
  `resolveWindows()` 保证 `good ≥ perfect`（不会出现窗口倒挂）且触底时打 `floored` 标记；
  L-07 六关 `windowScale` = 1.2/1.1/1.0/1.0/0.95/0.95（`windowScaleFor(id)` 越界回退默认 1.0）。
  另放 L-06 的 `CALIBRATION`（默认 0ms、`[`/`]` 每按 5ms）与 `nudgeLatency()`。
- `src/game/systems/JudgeSystem.js`：签名逐字符合 C2。规则优先级严格按 JDG-04：
  ① 窗口匹配（取最近 pending 同轨障碍）→ ② 落地后 80ms 缓冲内的预输入按 GOOD 起步（`rule:'preInput'`）
  → ③ 其余 `rule:'emptyBeat'`（**无惩罚、不入耐久统计、仍进事件流**）。
  超时 MISS 由 `clock.schedule(o.timeSec + goodWindow)` 驱动，与输入无关（JDG-05）；
  因预调度允许提前 120ms，回调内自检 `now < due - 2ms` 时**自我重排一次**，保证不早结算。
  窗口变更（`setWindowScale/setStrictWindow`）后重挂未判定障碍的定时器；`setLatency(ms)` 以
  `t = atSec - latency/1000` 生效（R13：仅影响判定窗口，不动音频时刻）。
- 本轮新增（联调发现的真实缺陷，已修）：`registerObstacles()` 跳过 `judgable === false` 的背景实例，
  不入队、不挂定时器、不改写其 `state/grade`，计数进 `ignoredCount()`；缺省视为可判定 → **见 CR-09**。

**验证**
```
$ node tools/contractTest.mjs --case judge
PASS judge        79/79 断言
RESULT: PASS 79/79 断言 · 1/7 case · 0 skip
```
覆盖点：±60/±110 三档边界含 ±1ms 临界、动作类型错配（JDG-07 spike+dash → `actionMatch:false`）、
preInput 与 emptyBeat 分流、超时 MISS 恰好一次不重复、latency 偏移两侧对称、
`windowScale` 触底、背景层不入队（7 条新断言）。

**与真实谱面的联调（一次性命令，未固化成 case）**
```
$ node --input-type=module -e "...MockClock + PG.build + JudgeSystem 全 PERFECT 走一遍"
level1 入队=55 跳过背景=39 误配=0 grades={"PERFECT":55} 事件=110 升序=true pending=0
level2 入队=56 跳过背景=48 误配=0 grades={"PERFECT":56} 事件=112 升序=true pending=0
```
（修 `judgable` 之前同一份数据是 `grades={"PERFECT":55,"MISS":39}` —— 39 条假 MISS。）

---

## K-04 · physics.js（C8 冻结）

**做了什么**
- `FROZEN` 10 项按 C8 逐字冻结（judgeX 0.18、通道 y 0.30/0.50/0.70、角色 x 0.18/高 0.12 等），
  全部写成 `{w,h}` 的纯函数比值，基准 1920×1080；`AUX` 收 §7.5 的辅助数（喘息带 0.08H、
  时间轴带 0.32H、spike 48×40、platform 120×24、barrage 56×56、`minSameTypeGapBeats 1.33`、
  `lookAheadBeats 4`、自检 BPM 集 110/120/126/128/132/140）。
- `obstacleX(view, obstacleT, nowSec, beatSec)` = `judgeX + (T − now) × pxPerSec`（OBS-02 定位公式，
  唯一入参是 `clock.now()`）；`timelineX / timelineLaneY / platformTopY / jumpAirSec / dashSec /
  jumpOffset / bufferBeats` 同批。
- 跳跃运动学按卡面给式：`v0 = 4h/T`、`g = 8h/T²`、滞空 0.9 拍（PRD 区间 0.7–1.1 中值）。
- `selfTest(view)` 实现 §7.5 两条硬校验：`1.33 拍 > 滞空 0.9 + 缓冲`、platform 三档包络不越界。

**验证**
```
$ node tools/contractTest.mjs --case physics
PASS physics      65/65 断言
       · 140BPM：滞空 0.9 拍 + 缓冲 0.187 拍 = 1.087 拍 < 最小同类间隔 1.33 拍（余量 0.243 拍）
```
另含：全部冻结项与 PRD §7.5 逐项对齐、1280×720 / 1920×1080 / 3840×2160 / 800×600 四档视口比值恒定、
`obstacleX` 在 now=T 时恰等于 judgeX、4 拍前瞻像素与通道 y 落带内。

---

## K-08 · save.js（§8.3）

**做了什么**
- v1 schema 键 `rhythm-breaker/save`；`mergeSave(raw)` 字段级合并：数值 `numOf` 强制+夹取、
  布尔只认 `true/'true'`、非法 level 键丢弃、**未知键原样保留**（前向兼容），rank 取历史最优。
- localStorage 不可用 / JSON 损坏 / 读写抛错 → **静默降内存档**，一次 `console.warn`，不抛异常（SAV-03）；
  `consumeNotice()` 供 R2 的设置页提示「本次未存档」。
- 写节流 500ms（尾沿 `setTimeout(...).unref?.()`，Node 下不吊住进程）；`updateSave(patch|fn, {storage, throttleMs, now, stampMeta})`
  可注入 stub storage（含 `null` = 显式禁用）以便 Node 测。
- 文件头带 `/* clock-ok */`，理由写在该行：唯一时间读取是 `meta.firstPlayedAt`（存档元数据，非判定/调度/定位路径）。

**验证**
```
$ node tools/contractTest.mjs --case save
[save] 存档 JSON 已损坏 → 用全新默认档 → 本次会话使用内存档，不阻断游戏（SAV-03）
[save] localStorage 不可用（隐私模式或 iframe 分区） → 本次会话使用内存档，不阻断游戏（SAV-03）
PASS save         43/43 断言
```
覆盖点：字段级合并不覆盖兄弟字段、500ms 内多次 `updateSave` 只落盘一次、损坏 JSON/禁用 storage/写失败三径降级、
重置只清进度不设置、版本迁移保留未知键。

---

## K-06 · 事件流（C7）

**做了什么**
- `EventLog` 内联在 `src/game/systems/JudgeSystem.js`（**C9 未给 EventLog 单列路径，故不新建他人名下文件**），
  产出 `{t, kind:'judge'|'input'|'state'|'hp', ...}` 且**插入即按 t 升序**（乱序喂入也稳定）。
- `exportEvents()` 返回 JSON 串（DebugPanel 导出按钮直接用它）；`count()/clear()`。
- 空拍只产 `input{hasTarget:false}`，**不产 judge 事件** → §7.3 的 Perfect 率可从事件流重算且不被空拍污染。

**验证**
```
$ node tools/contractTest.mjs --case eventlog
PASS eventlog     22/22 断言
```
含「1 次 PERFECT + 2 次 GOOD + 1 次 MISS → Perfect 率 0.25」的重算回归（AC-07 口径）。

---

## K-03 · DebugPanel + contractTest（本轮最关键交付）

**做了什么**
- `src/ui/DebugPanel.js`：DOM 覆盖层挂 `#debug-root`（L-04），显示卡面要求的 5 项 + 额外 3 项
  （当前拍/now()、状态机、judge+clock 队列长度、当前窗口 ms 含 `[FLOOR]`/strict 标记、driftMs 含峰值与
  25ms/120ms 参数、latency、事件计数、变速 cue 行）。
  默认按 `` ` `` 或 `D` 开关，`?debug=1` 自动展开；只用中性灰白，不 import WORLD 的 theme.js（避 C8 色板耦合）。
  无 DOM（Node）→ 返回空操作句柄，不抛错。
- `tools/contractTest.mjs`：纯 Node、零依赖，7 个 case：`clock judge physics save eventlog debug forbid-clock`。
  `--case`（可重复/`--case=`）、`--all`/无参、`--json` 全支持；最后一行严格 `RESULT: PASS <统计>` / `RESULT: FAIL <第一个失败断言>`。
  他人文件缺失 → `SKIP <原因>`，不代造。
  `forbid-clock` = `src/**` 扫描 `scene.time / *.time.now / performance.now() / Date.now() / new Date() / game.loop.delta`，
  白名单为**文件头 6 行内**的 `/* clock-ok */`；带正控制（6/6 必须抓到）与负控制（合法写法零误报），
  防止正则失效导致空跑 PASS。
  本轮追加 `debug` case（假 DOM 渲染 21 条断言），使 K-03 有可跑的证据而不是「写了没验」。

**验证**
```
$ node tools/contractTest.mjs
PASS clock        72/72 断言
PASS judge        79/79 断言
PASS physics      65/65 断言
PASS save         43/43 断言
PASS eventlog     22/22 断言
PASS debug        21/21 断言
PASS forbid-clock 4/4 断言
       · 扫描 19 个 src/** 文件；白名单（文件头 clock-ok）：src/audio/BeatClock.js, src/data/save.js
RESULT: PASS 306/306 断言 · 7/7 case · 0 skip · 54ms

$ npm run build   → ✓ built in 5.08s（12 modules，dist 正常产出）
$ npx eslint <CORE 全部 9 个文件> → 0 error 0 warning
$ npm run verify:all
[OK  ] contract  306/306 断言 · 7/7 case · 0 skip
[OK  ] level     2关 障碍111 核心30 喘息111处/228拍 空8拍窗0 同拍跨类0 错误0 警告0
[SKIP] audio     tool not implemented yet
[SKIP] render    tool not implemented yet
verify:all -> 2/4 PASS, 2 SKIP, 0 FAIL
```

**未完成**
- `npm run lint`（全仓）收工快照 **4 error / 10 warning，无一在 CORE 名下**；CORE 不代改（T2/T10），已登记「已知红点」并退回：
  `src/game/objects/Obstacle.js:330:28 'y' is not defined`、`src/game/objects/Timeline.js:351:66 + 352:29 'TRACKS' is not defined`、
  `src/game/render/Background.js:164:18 'calmFactor' is not defined`（均 WORLD 名下，他们正在编辑，数字会随提交变动）。
  warning 侧：WORLD 的 Obstacle/Timeline + SOUND 的 SoundEngine/PatternGenerator/audioAssert/checkLevel。
  `npx eslint <CORE 9 文件>` = 0 错 0 警（已在上面的验证块里）。
- 真浏览器里 `#debug-root` 的实际可见性未截图确认（R2 与 WORLD 的 screenshotCheck 一起做）。
- `debug` case 用假 DOM，`?debug=1` 只测了 URL 解析分支，没测真实键盘事件在 Phaser 焦点丢失下的表现。

---

## 本轮提出的 CR

- **CR-08**（C1/C2/C7 语义澄清 + 纯新增字段）：`emptyBeat` 的返回形状（`grade:'MISS' + rule:'emptyBeat' + penalizes:false`，
  消费方必须先判 `rule`）、Judgment 新增 `trigger/penalizes/key`、`tempoChanges` 采用**周期线性** ramp 口径
  （含 `getTempoCues()` 的确切字段名）、`schedule()` 可能提前 ≤120ms 因此「必须准点」的回调需自检重排、
  C1 新增 `type:'tempo'` 事件。→ 待 WORLD/SOUND 在结论行填 APPROVE/REJECT。
- **CR-09**（C4）：承认 `judgable:false` 背景实例这一类（SOUND 已输出 `judgable/layer/reason/groupIndex/pxPerSec/beatWidthSec`），
  CORE 侧改为不入队；请 SOUND 确认字段长期稳定、WORLD 按 `layer:'timeline'` 渲染 bed。

## 下一轮第一步（CORE）

1. `node tools/contractTest.mjs`（确认 306 条未回归）→ 把本轮联调的「真实谱面走一遍」固化成 `integration` case
   （读 `src/data/levels/*.json`，缺文件打 SKIP）。
2. K-05 场景生命周期 + teardown（R 连打 20 次后 interval/监听数回基线）+ `?selftest=1` 路由，
   替换 `src/main.js` 的 D0 占位场景（LevelScene 保持 ≤250 行，逻辑进 systems）。
3. K-07 DisassembleSystem 接 `onJudgment`，**第一处分支即 `rule === 'emptyBeat'` 直通**（CR-08 第 1 条）。
4. 浏览器实测 `driftMs()` 并回填数字；催 CR-08/CR-09 的回复。
