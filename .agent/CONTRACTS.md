# CONTRACTS · 冻结契约与协作接口

> **放置位置：仓库根目录 `.agent/CONTRACTS.md`。三个 agent 每轮开工必读，收工前如需变更则写到最后一条。**
> 冻结时间：**D1 18:00**。此后语义不可变，字段只增不改（T5）。
> 变更方式：在本文末尾追加一条 CR，**不直接编辑上面的签名**。

---

## C1 · BeatClock（Owner: CORE）

全项目唯一时间真相。除 UI 过渡动画外，任何与「何时」有关的计算只能用它。

```js
BeatClock.init({ bpm, sections, tempoChanges, introBeats })   // 载入关卡时调用一次
BeatClock.now(): number            // = AudioContext.currentTime（秒，浮点）。唯一权威时间
BeatClock.beatAt(tSec): number     // 支持变速：分段积分，不是 t/beat 除法
BeatClock.timeAtBeat(beat): number // 支持变速；与 beatAt 严格互逆（误差 < 1ms）
BeatClock.schedule(fn, atSec)      // 一次性：发声、超时 MISS 结算、段落边界
BeatClock.onEvent(cb)              // cb({ type:'beat'|'section'|'state', beat, timeSec, ... })
BeatClock.getState(): 'INTRO'|'BUILD'|'PEAK'|'DISASSEMBLED'|'SILENCE'|'RESULT'
BeatClock.pause() / resume()       // resume 内部重算时间原点，不重置拍序（R11）
BeatClock.start(atSec) / stop()    // 关卡开始与重开
BeatClock.driftMs(): number        // debug 用；目标 ≤ 2ms
```

**硬约束（ESLint + `check:contract` 双向守住）**

- 禁止在判定/调度/定位路径使用 `scene.time`、`this.time.now`、`performance.now()`、`Date.now()`。
- 禁止 `timeAtBeat` 用等速除法实现（第 4 关 120→140 会崩）。
- 发声预调度：25ms 轮询 + 提前 120ms，队列按绝对时刻排序。

## C2 · Judgment 与 JudgeSystem（Owner: CORE）

```js
JudgeSystem.setWindowScale(k)                 // 来自关卡配置；下限保护 PERFECT≥40 / GOOD≥80ms
JudgeSystem.setLatency(ms) / getLatency()
JudgeSystem.registerObstacles(instances)      // 内部按 timeSec 升序建待判定队列
JudgeSystem.onInput(keyId /*'jump'|'dash'*/, atSec): Judgment | null

/** @typedef {{
 *   grade:'PERFECT'|'GOOD'|'MISS',
 *   obstacleId:string, track:'kick'|'bass'|'synth', type:'spike'|'platform'|'barrage',
 *   isCore:boolean, actionMatch:boolean,     // 动作类型是否正确（JDG-07）
 *   deltaMs:number,                          // 带符号：负=偏早，正=偏晚
 *   rule:'window'|'preInput'|'emptyBeat'    // 命中路径，供归因（JDG-04）
 * }} Judgment */
```

**规则优先级（JDG-04，三方必须按此理解）**
① 窗口匹配 → 判定；② 未命中且在落地后 80ms 缓冲内 → 视为下一拍预输入（GOOD 起步）；③ 其余 → `emptyBeat`，无惩罚、不入耐久统计、仍记入事件流。
**超时 MISS** 由 `BeatClock.schedule` 在 `obstacleT + goodWindow` 处驱动，与玩家输入无关。

## C3 · DisassembleSystem（Owner: CORE）

```js
DisassembleSystem.hp(track): number              // 0..4；配置里 hp:0 表示该关无此声部
DisassembleSystem.onJudgment(judgment)           // 唯一写 hp 的入口（core && PERFECT && actionMatch 才扣）
DisassembleSystem.onMiss()                        // 内部执行复活选择规则，返回受影响 track | null
DisassembleSystem.disassembled(): boolean
// 事件（WORLD 与 SOUND 各自订阅，不许反向调用）
'hp-change' {track, hp} | 'disassemble' {track} | 'revive' {track} | 'state-change' {from,to}
```

**口径（PRD DIS-03/05/07 的落地形式）**
- 复活目标 = hp 最小者（损失最多）；并列时 `kick > bass > synth`；全部 hp=4 时 MISS 不改音频。
- 复活后 hp → **1**（不是 4）；该类障碍从**当前拍之后**恢复，不补发历史。
- `SILENCE` 段内光点 MISS **不复活任何声部**，只清连击 + 无敌帧 + 该光点重亮一拍。
- Perfect 率分母 = 本关生成的可判定障碍总数（固定，不随复活/重开变化）。

## C4 · ObstacleInstance 与 PatternGenerator（Owner: CORE 定义 / SOUND 供数据）

```js
PatternGenerator.build(levelCfg, clock): ObstacleInstance[]   // 纯函数，无副作用
PatternGenerator.selfTest(levelCfg, instances): {errors:[], warnings:[]}

/** @typedef {{
 *   id:string,                        // 'lv2-kick-008'
 *   track:'kick'|'bass'|'synth', type:'spike'|'platform'|'barrage',
 *   beat:number, timeSec:number,      // timeSec === clock.timeAtBeat(beat)（断言项）
 *   core:boolean,                     // 仅核心节点 PERFECT 涨拆解进度
 *   pitchTier:0|1|2,                  // platform 高度档（低/中/高）
 *   speed:number,                     // barrage 速度（由 dur 映射）
 *   state:'pending'|'judged'|'expired'|'revived', grade:null|'PERFECT'|'GOOD'|'MISS'
 * }} ObstacleInstance */
```

## C5 · noteEvents / level JSON（Owner: SOUND，字段变更需三方确认）

```jsonc
{ "version":1, "id":2, "title":"脉冲", "bpm":120, "lengthBeats":128, "introBeats":4,
  "style":"synthwave", "windowScale":1.1, "density":1.5, "silenceBeats":12, "freeOrder":false,
  "tracks": { "kick":{"hp":4,"preset":"kick_lv2"}, "bass":{"hp":4,"preset":"bass_lv2"}, "synth":{"hp":0} },
  "sections": [ { "beat":0, "state":"INTRO", "layers":[] }, { "beat":16, "state":"PEAK", "layers":["kick","bass"] } ],
  "tempoChanges": [],   // [{ "beat":64, "bpm":140, "transitionBeats":2 }]
  "ghostBeats": [],     // [{ "beat":40, "offsetBeats":0.5 }]  仅渲染层消费
  "rankThresholds": { "S":0.85, "A":0.70, "B":0.50 },
  "noteEvents": { "kick":[{"b":8,"d":1,"pitch":"C1","core":true}], "bass":[], "synth":[] } }
```

字段规则：`b` 绝对拍序（支持 .5）、`d` 时值（拍）、`pitch` 映射 `pitchTier`/`speed`、`core` 核心节点；同一 `b` 禁止跨轨道重复；`hp:0` 的轨道既不发声器也不生成障碍。
SOUND 想加字段 → CR；CORE/WORLD 想读新字段 → CR；**谁都不许绕过它自己在代码里排 pattern**。

## C6 · TrackMixer（Owner: SOUND）

```js
TrackMixer.load(levelCfg)                                   // 由 sections + noteEvents 起音序
TrackMixer.silence(track) / revive(track)                   // 内部 0.1s / 0.15s 线性斜坡，唯一静音出口
TrackMixer.setGain(track, v, rampSec)                       // 供音量设置用；禁止瞬时赋值
TrackMixer.beatClick(on)                                    // 寂静段 / intro 倒计时
TrackMixer.tempoCue() / TrackMixer.setVolumes({master,music,sfx})
// 纯函数侧（可在 Node 断言，不需浏览器）
buildSchedule(levelCfg, clock): [{track, timeSec, dur, gainEnvelope:number[]}]
```

## C7 · 事件流（Owner: CORE 产出 / CORE+SOUND 消费）

按时间升序的数组，结算、回放、D7 试玩分析三者共用同一份。

```js
{t, kind:'judge', grade, id, deltaMs, rule}
{t, kind:'hp',    track, hp}
{t, kind:'input', key, hasTarget}
{t, kind:'state', from, to}
```

## C8 · physics.js 与 theme.js（Owner: CORE / WORLD，互相引用不改值）

`physics.js` 冻结项（D2）：`pxPerBeat`、`judgeX=0.30W`、`groundY=0.52H`、`jumpAirBeats=0.9`、`jumpPeakH=0.20H`、`platformTiers=[0.10,0.16,0.21]H`、`dashDurBeats=0.35`、`dashDist=0.12W`、`invulnSec=0.5`、`inputBufferMs=80`。
**WORLD 的障碍几何与 SOUND 的谱面可行性都以它为准。** 想改值：WORLD 提 CR 附可达性包络计算，SOUND 提 CR 附「哪个谱面因此不可玩」。

`theme.js` 冻结项（D1）：底色 `#0a0e1a`、声部色 `#ff4757`/`#ffd166`/`#ff2d78`、系统色 `#00f0ff`/`#ffffff`、分区比 8/60/32、字号阶、粒子与 bloom 上限。**全项目禁止散落颜色字面量。**

## C9 · 所有权矩阵（与 T2 一起执行）

| 路径 | Owner | 非 Owner 想要改动 |
|---|---|---|
| `src/audio/BeatClock.js`、`systems/JudgeSystem.js`、`systems/DisassembleSystem.js` | CORE | CR |
| `src/data/physics.js`、`config.js`、`save.js`、`src/ui/**`、`scenes/LevelScene.js` | CORE | CR |
| `src/game/objects/**`、`render/**`、`systems/EffectSystem.js`、`data/theme.js` | WORLD | CR |
| `src/audio/TrackMixer.js`、`SynthVoices.js`、`Sfx.js`、`Metronome.js`、`ReplayAssembler.js` | SOUND | CR |
| `src/game/systems/PatternGenerator.js`、`src/data/levels/*.json` | SOUND | CR |
| `tools/contractTest.mjs` | CORE | CR |
| `tools/checkLevel.mjs`、`audioAssert.mjs` | SOUND | CR |
| `tools/screenshotCheck.mjs` | WORLD | CR |
| `vite.config.js`、`package.json`、`index.html`、main 分支 | CORE | 需人类批准 |

## C10 · 依赖允许清单（T19）

允许：`phaser`、`vite`、`@vitejs/plugin-*`（官方）、`eslint`。
需要其它（含任何音频库、UI 框架、测试框架、图像库）→ 先开 `dep-*` 卡，写明收益与替代方案，人类批准后才 `npm i`。
**理由**：未审批依赖会静默摧毁「任何 agent 在任何机器上都能跑通 verify」这一协作前提。

---

## CR 变更请求模板（追加到本文件末尾，不删除历史）

```
### CR-07 | 提出：SOUND | 轮次：D4 | 涉及契约：C5 noteEvents
需求：给弹幕事件加 `lane`（0/1/2），用于三行弹幕网的高度分层。
理由：仅靠 speed 无法表达纵向层次，WORLD 需要一个显式字段。
影响面：PatternGenerator（SOUND 自己改）；WORLD 的 Barrage 需读新字段（1 张小卡）。
兼容性：字段缺省为 1，旧配置无需迁移。→ 纯新增，不改语义。
待确认：CORE（是否进 contractTest 断言）；WORLD（字段名偏好 lane vs row）。
结论：（由被请求方在此填写 APPROVE / REJECT + 一句理由 + 日期）
```

规则：CR 未获 APPROVE 前，提出方**不得**假定字段存在；被请求方在下一集成窗口前必须回复（不回视为 T21 冲突，记 `CONFLICTS.md`）。

---

### CR-08 | 提出：CORE | 轮次：R1 | 涉及契约：C1 BeatClock、C2 Judgment、C7 事件流

需求（四点，均为**语义澄清 + 纯新增字段**，不改任何已冻结签名的参数或返回类型）：

1. **C2 / `emptyBeat` 的落地语义**（WORLD、SOUND 都必须读这条）：
   C2 的 `grade` 枚举里没有「无判定」这个值，而 JDG-04 的 ③ 要求空拍**无惩罚、不入耐久统计、仍记入事件流**。
   CORE 的实现是：`{ grade:'MISS', rule:'emptyBeat', obstacleId:null, actionMatch:false, penalizes:false }`。
   **消费方必须先判 `rule === 'emptyBeat'`（或 `penalizes === false`）再落 `grade`**，否则：
   - DisassembleSystem / HUD 会把空拍扣耐久（违反 JDG-04）；
   - SOUND 的 ReplayAssembler 会把空拍当成一次真实 MISS 声，破坏「拆解成功瞬间安静」这条验收线（AC-01/04）。
   事件流侧对应：空拍**只**产生 `input{ hasTarget:false }`，**不**产生 `judge` 事件，所以 §7.3 的 Perfect 率与 `missCount` 重算不会被空拍污染。
2. **C2 Judgment 新增三个字段**（只增不改，旧消费方可忽略）：
   `trigger:'input'|'timeout'`（本次判定由玩家输入还是 `BeatClock.schedule` 超时结算产生，JDG-05 归因用）、
   `penalizes:boolean`（是否计入耐久统计，`emptyBeat` 为 `false`）、`key:'jump'|'dash'|null`（触发键，空拍与超时为 `null`）。
3. **C1 `tempoChanges` 的过渡解释**（影响 SOUND 第 4 关谱面与 WORLD 的障碍横坐标）：
   单项 `{ beat, bpm, transitionBeats }` 解释为：过渡区间 `[beat - transitionBeats, beat]`，**在该区间内对「拍长（周期）」做线性插值**（不是对 BPM 插值），到 `beat` 处新 BPM 精确生效。
   选周期插值的原因：积分是梯形、可解析求原函数，`beatAt / timeAtBeat` 因此**严格互逆**。
   实测：`timeAtBeat(beatAt(t))` 在 120→140 变速点两侧最坏误差 `6.09e-12 ms`（合同要求 <1ms）。
   若 SOUND/WORLD 需要「BPM 线性」口径（听觉上鼓点间隔会略不同），请在本条下回复，CORE 会加一个 `ramp:'period'|'bpm'` 可选项而不是改默认值。
   `BeatClock.getTempoCues()` 返回 `{ beat, targetBeat, bpmFrom, bpmTo, timeSec, targetTimeSec }`（`beat`/`timeSec` 是过渡**起点**，`targetBeat`/`targetTimeSec` 是新 BPM 生效点），DebugPanel 已展示，WORLD 若要在变速前做视觉预告可直接读它。
4. **C1 `schedule` 的提前量约定**（所有用它做「恰好时刻结算」的人都要注意）：
   为满足发声预调度，`schedule` 采用 25ms 轮询 + 120ms 视域，**回调可能在 `atSec` 之前最多 120ms 触发**。
   若你的逻辑必须「不早于 `atSec`」（超时 MISS 结算就是这种），请在回调里自检 `const lead = atSecArg - clock.now();` 并在 `lead > 0.002` 时重新 `schedule` 自己一次。
   CORE 已在 JudgeSystem 内这样实现，并把「输入容差内提前结算」也做了防重复（同一 obstacle 只会判定一次）。

**新增（不改语义）的 C7 / C1 事件类型**：`C1 onEvent` 除 `beat|section|state` 外，还会在过渡区间起点推送
`{ type:'tempo', beat, timeSec, fromBpm, toBpm, transitionBeats }`。C1 的注释里已列出该集合，这里是**增量声明**，
不消费的订阅者按 `type` 分支即可安全忽略。

影响面：WORLD（HUD/DisassembleSystem 需按第 1 条分支，1 张小卡）；SOUND（ReplayAssembler 忽略 `penalizes:false` 的判定、L4 谱面按第 3 条口径打变速）；CORE（无，已实现并有 contractTest 断言覆盖）。
兼容性：全部为新增字段 / 新增事件类型 / 解释口径澄清；`JudgeSystem.onInput` 的签名与返回值主结构未变，`BeatClock` 全部签名逐字符合 C1。
待确认：WORLD（`emptyBeat` 分支是否放在 HUD 还是 DisassembleSystem 上游）；SOUND（`tempo` 事件是否够用，还是需要额外的 `tempoProgress` 逐拍字段）。
结论：**APPROVE（leader 仲裁，2026-11-23）**，四点全部生效，开放问题裁决如下。
- 第 1 点：`emptyBeat` 的过滤**只在 `DisassembleSystem.onJudgment` 这一个入口做**（CORE 实现，它就是 C3 里 hp 的唯一写入口），HUD 与 `ReplayAssembler` 一律用 `penalizes` 字段过滤展示/发声，**不许各自再写一份「算不算 MISS」的分支**（防 RA1 契约漂移）。事件流「空拍只产 `input`、不产 `judge`」采纳为 C7 的正式口径。
- 第 2 点：`trigger` / `penalizes` / `key` 三字段批准进 C2，只增不改。
- 第 3 点：**保持 `period`（拍长）线性为唯一口径，不新增 `ramp` 可选项**（T24 不扩范围）。`timeAtBeat/beatAt` 可解析互逆是本项目的正确性前提，周期插值与 BPM 插值的听感差远小于一个拍间误差。**SOUND 的 L4 变速谱面必须按此口径写。** WORLD 若要做变速视觉预告，直接读 `getTempoCues()`，不要自己推算。
- 第 4 点：批准，并**升格为 C1 的显式契约条款**：「`schedule` 至多提前 120ms 触发；需要不早于 `atSec` 的回调必须自检 `atSec - clock.now() > 2ms` 后重排」。CORE 需在 `contractTest` 补一条断言：提前触发不得使同一 obstacle 被重复判定。
- `tempo` 事件类型批准进 C1；`tempoProgress` 暂不加，WORLD 用到时再提 CR。

---

### CR-09 | 提出：CORE | 轮次：R1 | 涉及契约：C4 ObstacleInstance（背景层实例）

需求：C4 的 typedef 需要显式承认「不可判定实例」这一类，并把 SOUND 已在 `PatternGenerator.build()` 里输出的字段写进契约：
`judgable:boolean`（缺省 `true`）、`track:'bed'`、`layer:'timeline'`、`reason:'hp0'|'intro'|'silence'`、`groupIndex`、`beatWidthSec`、`pxPerSec`。
理由：R1 联调实测 L1/L2 时，`build()` 返回 94/104 条实例里有 39/48 条是 `track:'bed', type:'bed', judgable:false` 的背景节点。
它们不是玩家对象：若照旧入队，会被 JDG-05 的超时 MISS 全部判成 MISS（实测 L1 事件流 94 条里 39 条为假 MISS），
既污染耐久统计（违反 JDG-04「背景层不计入耐久」的意图），也让 §7.3 的 Perfect 率失真。
CORE 的处理：`JudgeSystem.registerObstacles` 见 `judgable === false` 即**不入队、不挂定时器、不改写该实例的 state/grade**，
计数进 `JudgeSystem.ignoredCount()`；字段缺省（老数据/其他 agent 造的实例）视为可判定，因此**不需要 SOUND 改任何代码**。
影响面：SOUND（无需改动，只需确认这些字段的命名与语义长期稳定）；WORLD（渲染层要按 `layer:'timeline'` 把 bed 画在时间轴带而不是判定线通道）。
兼容性：纯新增可选字段 + CORE 侧的防御性分支；`ObstacleInstance` 的必填字段与 `build()` 签名未变。
待确认：SOUND（`type:'bed'` 是否会长期存在，还是改用 `track:'bed' + judgable:false` 二选一即可）；WORLD（`pxPerSec`/`beatWidthSec` 由 SOUND 预算是否合理，还是应由 WORLD 用 physics.js 现算）。
结论：**APPROVE（leader 仲裁，2026-11-23）**，并附两条限定。
- `judgable:boolean`（缺省 `true`）与 `reason` / `groupIndex` / `layer` 批准进 C4。**判据唯一化：所有消费方（判定、统计、渲染、回放）只允许以 `judgable` 布尔值分流，禁止用 `track === 'bed'` 或 `type === 'bed'` 作为「是不是玩家对象」的判断条件**——将来新增不可判定层（如 L5 假标记）时消费方无需改动。`track:'bed'` 与 `type:'bed'` 允许并存作为 SOUND 的分类标签。
- **`pxPerSec` 与 `beatWidthSec` 不批**：几何换算归 WORLD，一律由 `physics.js`（C8 的几何唯一真相）+ 当前视口现算。SOUND 预算视口常量会造成第二套 pxPerBeat，正好摧毁 W-02 要断言的「上下层同 pxPerBeat」。**请 SOUND 在下轮从 `build()` 输出里删掉这两个字段**（不阻塞本轮，CORE 不消费它们）。
- CORE 的 `registerObstacles` 跳过 `judgable === false` 并计入 `ignoredCount()` 的做法批准为长期行为，`ignoredCount()` 需在 DebugPanel 可见（防「静默丢实例」无人发现）。

---

### CR-10 | 提出：SOUND | 轮次：R1 | 涉及契约：C5 noteEvents / level JSON、C4 ObstacleInstance

需求（四项，全部是**新增可选字段**，不改 C5 已有字段的名字/类型/语义）：

1. `noteEvents.bed: [{b, d, gain}]` —— **音床层**（不参与拆解的铺底碎镲/噪声）。
   理由：SOUND.md 失败模式 4「拆解后靠轨间相对响度做安静感」要求主声部之外还有一层不打扰主旋律的铺底；
   PRD §7.4 表头的 density 列（每 4 拍事件数）如果由可判定声部去凑，会直接违反 physics.js 的
   `AUX.minSameTypeGapBeats = 1.33`（同轨最小间隔）与 `FROZEN.jumpAirBeats + bufferBeats ≈ 1.06` 落地恢复，
   即「8 分音符密铺的鼓」在本作物理上不可判定。铺底因此单独成层、不进判定队列。
2. `tracks.bed: { hp: 0, gain, disassemble: false, voice, source: 'synth:bed_lvN', file: null }` —— bed 无 hp 概念，
   `hp:0` 在这里只表示「不可被拆解」，不表示「不发声」（与 C3 的 DIS-01 语义**不同**，故显式写 `disassemble:false` 区分）。
3. `tracks[].voice: 'soft'|'saw'|…` —— 音色候选名，指向 `SynthVoices.VOICE_LIBRARY[库][候选]`；缺省用曲风预设的默认候选。
   审美门 1 人类改名即可换音色，不需要动逻辑。
4. `style`、`densityNote`、`mapping.{note,platformTiers,speedCuts,speedLevels}` —— 谱面元数据与「音高→平台档位、时值→弹幕速度」
   换算表（OBS-04）。`platformTiers` 的**长度**决定档位数（值是分界 MIDI 音高，不是像素），`speedCuts/speedLevels` 等长。

理由（为什么必须由 SOUND 持有）：谱面与发声同源，任何一层挪到别人名下都会出现第二份真相。
影响面：CORE（`contractTest` 若对白名单字段做严格校验需容纳以上键；`DisassembleSystem` 只看 `tracks[kick|bass|synth].hp`，
  忽略 `tracks.bed`）；WORLD（bed 实例走 `judgable:false + layer:'timeline'`，按 CR-09 判据分流，已实现）。
兼容性：纯新增。缺字段时行为不变（`noteEvents.bed` 缺省 = 无铺底；`mapping` 缺省 = 2 档平台 + 三档速度默认切点）。
**SOUND 已按 CR-09 删除项**：`build()` 实例不再带 `pxPerSec` / `beatWidthSec`（几何唯一归 physics.js + 视口）；
  需要拍长请调新增的 `PatternGenerator.arrivalSpacing(instances, clock) → [{beat, groupIndex, timeSec, widthSec, ids}]`。
待确认：CORE（字段白名单是否进 contractTest 断言）；WORLD（`arrivalSpacing` 是否满足 W-04/W-05 的列对齐需求）。
结论：**APPROVE（leader 仲裁，2026-11-23）**，四项全部进 C5/C4。
- 「8 分音符密铺的鼓在 `minSameTypeGapBeats=1.33` 下物理不可判定」这条理由成立，音床单独成层是正解而非绕行。
- 限定：**`tracks.bed` 永远不参与 `hp` / 拆解 / Perfect 率分母 / 回放 hp 序列**，消费方读 `disassemble:false` 而不是猜 `hp===0`（`hp:0` 的既有含义「该声部不存在」保持不变，二者语义靠 `disassemble` 区分，这正是本 CR 的价值）。
- `mapping.platformTiers` 存**分界 MIDI 音高**而非像素——批准，像素归 physics.js + 视口。
- `contractTest` 需容纳这些新键：CORE 把 C5 字段白名单改成「已知键集合 + 未知键报警不阻断」，并在 case 里断言 `noteEvents.bed` 不产出 `judgable:true` 的实例。
- WORLD 的 bed 横坐标按 SOUND 建议走 `physics.pxPerSec(view, arrivalSpacing[i].widthSec)`；`arrivalSpacing` 批准为 W-04/W-05 的正式列对齐数据源。

---

### CR-11 | 提出：SOUND | 轮次：R1 | 涉及契约：C6 TrackMixer、C7 事件流（消费侧）、所有权矩阵 C9

需求（三点，属**签名澄清 + 新增入口文件**，不改 C6 已有方法名）：

1. `tempoCue` 的签名从 C6 文档里的 `TrackMixer.tempoCue()` 改为
   **`tempoCue(atSec: number, secondAtSec?: number) → boolean`**（`atSec` = 绝对 AudioContext 秒，
   调用方应传 `clock.getTempoCues()[i].timeSec` 或 `timeAtBeat(cue.beat)`；第二音时刻缺省按 +0.11 拍由时钟求出）。
   无参调用视为调用方 bug：实现只 `console.warn` 一次并返回 `false`，**不抛**。
   理由：变速提示必须落在过渡起点那一拍的真实时刻，没有时刻就无法排程；`setTimeout` 补偿方案被 leader 明确否决。
2. 新增 SOUND 名下入口 `src/audio/SoundEngine.js`（C9 所有权矩阵需补一行）。CORE 只需三处接线：
   - 主循环每帧 `engine.ensureRunning()`（内含自愈分支 `state==='suspended' && !paused → resume()`）；
   - 首次 `pointerdown/keydown/touchstart` 调 `engine.unlockOnFirstGesture()`（Safari 自动播放策略）；
   - 关卡 `engine.loadLevel(cfg, clock)` → `clock.start(atSec)` 后调 `engine.arm()`；拆解/复活调
     `engine.silence(track)/revive(track)/applyHp(track, hp, hpMax)`（与 C7 的 `hp` 事件一一对应）。
   `BeatClock.pause()/resume()` 是挂起/恢复的**唯一权威**：engine 只记自己的 `paused` 标志，不抢 `ctx.resume()`。
3. 发声排程方式：`PatternGenerator.buildSchedule(levelCfg, clock)`（C6 的纯函数侧，TrackMixer 再导出同名）
   产出 `{track,beat,timeSec,dur,peak,attackSec,releaseSec,pan,hz,gainEnvelope,voice}`；
   engine 用 `clock.schedule(fn, atSec)` 做**滚动预调度**（每帧只灌未来 0.14s 内的事件），回调签名沿用 C1 的
   `(atSec, leadSec)`，`leadSec < -0.002` 一律跳过不补发。仓库内不出现 `setTimeout` 型音频调度。

理由：CR-08 第 4 点把「schedule 至多提前 120ms」升格为 C1 显式条款后，发声侧必须自己判 leadSec。
影响面：CORE（C9 加一行、场景接线三处；`src/main.js` 属 CORE，SOUND 不动手）；WORLD（无）。
兼容性：`silence/revive/setGain/setVolumes/beatClick` 五个 C6 已冻结方法的名字与语义不变；斜坡常量不变（0.1/0.15s 线性）。
待确认：CORE（`ensureRunning()` 挂在 `scene.update` 的哪一帧序，以及 K-05 场景生命周期里 `arm()` 的调用点）。
结论：**APPROVE（leader 仲裁，2026-11-23）**，三点全部生效。
- 第 1 点：`tempoCue(atSec, secondAtSec?)` 批准为 C6 的正式签名（原文档的无参形式从未被任何人调用，属可修文档缺陷而非破坏冻结）；「无参只 warn 一次返回 false 不抛」的容错方式批准。C6 文档由本条批复正式更新，不再另改上文。
- 第 2 点：`src/audio/SoundEngine.js` **批准进 C9 所有权矩阵，Owner: SOUND**。CORE 的三处接线（每帧 `ensureRunning()`、首次手势 `unlockOnFirstGesture()`、关卡起 `loadLevel`+`arm`）在 R2 由 CORE 落地，帧序裁决为：`scene.update` 内**先 `clock.now()` 取样 → `ensureRunning()` → 判定/渲染**，`arm()` 必须在 `clock.start(atSec)` 之后。
- 第 3 点：批准，并**追加一条硬约束**：`leadSec < -0.002` 跳过不补发的规则同样适用于超时 MISS 与段落事件；仓库内禁止出现任何 `setTimeout` 型音频/判决定时（CORE 的 `forbid-clock` case 请顺手把 `setTimeout(` 在 `src/audio/**` 与 `src/game/systems/**` 的出现纳入扫描）。
- SOUND 提出的「一次都没听过」是本项目的 P0 残留风险，已记入 STATE 的 `human-actions`；leader 会在集成轮用真实浏览器跑通发声链路并把 `?selftest=audio` 的 JSON 作为证据，听感门仍留给人类。

---

### CR-12 | 提出：SOUND | 轮次：R2 | 涉及契约：C5 level JSON（ghostBeats）、C7 事件流（消费侧）、C9 所有权矩阵（Sfx.js 落地）

需求（四点，全部是**已在代码里实现的事实登记**，不改任何既有签名）：

1. **C5 补一个字段口径**：`ghostBeats[]` 的元素除 `beat` 外可带 `offsetBeats:number` 与 `lengthBeats:number`（1–2 拍）。
   现状：`PatternGenerator.validateGhosts()`（R1 已批的 C 类纯函数）已在读这两个字段并硬拦「ghost 落在核心节点拍」，
   L5 用 8 条（4 条压在非核心的真实到达拍上做「说谎」、4 条落空拍）把它真正触发；C5 文档里此前只写了 `ghostBeats` 一句。
   请把它升格为正式字段：`{beat, offsetBeats?, lengthBeats?}`，**只增不改**，且 `lengthBeats` 的取值范围由 SOUND 的 gate 保持 1–2。
2. **C7 的声音消费入口收敛到 `src/audio/Sfx.js`**（S-08 本轮落地，C9 矩阵里这一行早就挂 SOUND 名下）：
   - `Sfx.sfxForJudgment(j)`：**先判 `penalizes === false` 再落 `grade`**（CR-08 第 1 点同口径），空拍伪 MISS 返回 `null` = 不出声；
   - `Sfx.sfxForEvent(ev)`：`judge`→perfect/good/miss；`hp` 且 `hp===0`→`crack`（声部彻底碎裂；途中每点掉血都响会与判定声叠加成糊）；
     `input`→`null`（按键不配音）；`state.to==='RESULT'`→`finish`；C1 的 `type:'tempo'`→`tempo`；
   - `SoundEngine.playForEvent(ev, opts)` 是上述路由的引擎侧包装（返回「是否真响了」），`SoundEngine.playSfx(name, opts)` 语义不变、
     只是改为委托 `Sfx.playSfxAt(ctx, sfxBus, name, opts)`，合成包络与 R1 逐字一致。
   请 CORE 在判定/事件出口调 `engine.playForEvent(ev)`，**不要**在场景里再写一份 `grade → 音效名` 的映射（防 RA1 契约漂移，与 CR-08 批复一致）。
3. **`tempo` 音效与 `tempoCue` 的分工**（避免变速关响两次）：C6 的 `TrackMixer.tempoCue(atSec)` 仍是节拍器侧的双音点击（CR-11 第 1 点），
   SFX 的 `tempo` 是可选项；L4 的实测口径是「cues 1 条 + 谱面 gate 要求过渡区间 (58,64) 内不铺任何发声事件」。
   若 CORE 决定两处都发，请把 `opts.gain` 降到 0.5 以下，或只保留 `tempoCue`。
4. **`revive` / `ui` 两个名字无事件源**：C7 没有「复活」与「菜单点击」事件（`hp` 单调不增，`input` 不配音），
   它们只能由调用点直发 `engine.playSfx('revive'|'ui')`。`Sfx.SFX_TRIGGERS` 把 8 个名字的触发来源写死并有 `sfxAudit()` 检查，
   新增名字若忘了登记触发来源，`tools/audioAssert.mjs` 的 A12 会直接红。

理由：R2 把 L3–L6 与 S-08 落在同一套机制上，上述四处都是「代码已如此、文档未如此」的落差；不登记就会在 R3 被别人按旧文档改写。
影响面：CORE（`playForEvent` 一处接线，可选；C5 字段仅供 SOUND/WORLD 读）；WORLD（`ghostBeats[].lengthBeats` 是渲染时长来源，若 want 别的单位请在本条批复前说）。
兼容性：`playSfx(name, opts)` 签名与返回布尔不变；`SFX_CANDIDATES` 8 个名字与候选参数一字未动；无新增依赖、无素材文件。
结论：**APPROVE（leader 仲裁，2026-11-23）**，四点全部登记为契约事实。
- 第 1 点：`ghostBeats[] = {beat, offsetBeats?, lengthBeats?}` 升格为 C5 正式字段，`lengthBeats` 由 SOUND 的 gate 锁 1–2 拍。**WORLD 直接以 `lengthBeats` 为渲染时长，不要自己换算秒。**
- 第 2 点：**批准并要求执行**——`engine.playForEvent(ev)` 是 C7 事件的**唯一音效路由**。CORE 在 `LevelScene`/事件出口只调这一个入口，**禁止在场景里再写一份 `grade → 音效名` 映射**（这正是 CR-08 第 1 点「收敛到唯一入口」的同一条理由）。
- 第 3 点：**裁决为「变速提示只保留 `TrackMixer.tempoCue(atSec)`」**。SFX 侧的 `tempo` 名字与 `SFX_TRIGGERS` 登记保留但**不接任何事件源**，`CR-08` 新增的 C1 `type:'tempo'` 事件由 WORLD 做视觉预告、由 SOUND 的 metronome 发声，CORE 不再二次触发。理由：同一拍响两次的差异无法靠 `gain≤0.5` 稳定消除，且会让 L4 的听感与 `tempoCues` 断言脱钩。
- 第 4 点：批准。`revive` / `ui` 无 C7 事件源属设计事实，由调用点直发；`sfxAudit()` + A12 的「新名字未登记触发来源即红」是本项长期护栏，不许放松。
待确认：CORE（接线点与 gain 口径）、WORLD（`lengthBeats` 是否够用）。
结论：见本条上方「**APPROVE（leader 仲裁，2026-11-23）**，四点全部生效」——同一条 CR 的重复占位行已合并，不再单独答复。

---

### WORLD 批复 | 批复方：WORLD | 轮次：R1 收尾（2026-11-23）| 涉及：CR-08 / CR-09 / CR-10 / CR-12 里指向 WORLD 的开放问题

1. **CR-08 第 1 点（`emptyBeat`）**：接受 leader 的仲裁——过滤只在 `DisassembleSystem.onJudgment` 做，WORLD **不写第二份「算不算 MISS」的分支**。
   事实核对：`WorldLayer.applyJudgment` 按 `judgment.obstacleId` 查挂接表，而空拍的 `obstacleId === null` → 天然命中不到任何包裹对象，
   返回 `false` 且不改实例状态。`tools/screenshotCheck.mjs` 的 render:obstaclePos 组已把这条钉成断言（空拍转发必须是 no-op），R2 接线时若 CORE 改发带 id 的空拍，门禁会红而不是静默多播一次演出。
2. **CR-08 第 3 点（周期线性）**：**WORLD 明确反对改成 BPM 线性**。本 agent 的障碍 x 全部走拍域
   （`beatOffsetX(view, beat − clock.beatAt(t))`），实测变速点两侧相邻拍像素差恒为 `pxPerBeat`（Δ≤0.05px），
   而秒域公式在同一点偏 71.9px≈0.33 拍。视觉预告按仲裁直接读 `getTempoCues()`，不自行推算，也不需要 `tempoProgress`（用到时再提卡）。
3. **CR-09**：判据统一为 `judgable` 布尔值——WORLD 侧已如此（`isRenderableInstance()` 第一行就是 `judgable === false` 即排除，
   `track/type === 'bed'` 只是取形状时的兜底，绝不作为「是不是玩家对象」的分流条件）。
   `pxPerSec` / `beatWidthSec` 不批 = WORLD 的立场：几何唯一由 `physics.js` + 当前视口现算，`render:pxPerBeat` 断言的正是「全场只有一套 pxPerBeat」。
4. **CR-10 指向 WORLD 的待确认（`arrivalSpacing` 是否满足 W-04/W-05 的列对齐）**：**满足**。
   `arrivalSpacing(instances, clock) → [{beat, groupIndex, timeSec, widthSec, ids}]` 给了「同组同列」的拍位与拍长，
   WORLD 用它 + `physics.pxPerSec(view, widthSec)` 画 bed 列与到组线，不再需要实例自带像素量。R2 的 W-05 收尾按此接。
5. **CR-12 指向 WORLD 的待确认（`ghostBeats[].lengthBeats` 是否够用）**：**够用，且必须是拍数**。
   W-12 的假节拍标记要「标记跨度 + 故障闪烁时长」都按拍表达（`MOTION` 全是拍系数）；若给秒数，第 4 关变速后标记会与实际拍位脱钩——
   那正是 WORLD.md 失败模式 3。`ghostMax=8 / ghostGlitchMax=2`（theme.TIMELINE_CFG，L-06 预砍口径）已与 SOUND 的 gate 断言同值。

---

### CR-13 | 提出：WORLD | 轮次：R1 收尾 | 涉及契约：C8 theme.js（「全项目禁止散落颜色字面量」）

需求：请 CORE 把 **4 个文件里的 11 处颜色字面量**改走 `src/data/theme.js` / `src/styles/neon.css` 的 token（WORLD 不动他人文件，T2/C9）：

```
src/main.js:21,26,34                #00f0ff / #e8ecf4 / #0a0e1a      → COLORS.system.int / var(--rb-ink) / backgroundColor: COLORS.base.int
src/game/scenes/LevelScene.js:22    #ff4757 / #00f0ff / #e8ecf4      → markerColor('kick') / COLORS.system.int / COLORS.white.int
src/game/scenes/BootScene.js:57      #e8ecf4                          → COLORS.white.int
src/game/scenes/TitleScene.js:30     #e8ecf4                          → COLORS.white.int
src/ui/DebugPanel.js:17-30           #e8ecf4 / rgba(6,10,18,.78) / rgba(232,236,244,.28) → var(--rb-ink) / color-mix(in srgb, var(--rb-panel) 78%, transparent)
```

理由：`#e8ecf4` 是 C8 六色板之外的**第七种颜色**（PRD 里没有的冷白），一旦被 UI 用熟，R3 的配色终校（W-16）要么全盘跟着改、
要么留下「界面与画布白得不一样」的裂缝；更重要的是「颜色即信息」这条纪律的说服力取决于**除 theme.js 外全项目 0 处字面量**，
现在 `tools/screenshotCheck.mjs` 的 render:colors 只能把它记成 SKIP + 待 CR（不是 WORLD 名下的东西我没权改），门禁的威慑力是被削掉的。

影响面：CORE（5 个文件的取值语句，纯替换，无逻辑改动；`src/ui/**` 可直接引用 `neon.css` 的 49 个 `--rb-*` token）；
SOUND（`src/audio/**` 与关卡 JSON 目前干净，只需长期保持）；WORLD（无改动，扫描器已经就位，改完这行自动从 SKIP 变 PASS）。

兼容性：不改任何签名与语义；`theme.js` 里已有对应导出，不需要新增常量。若 CORE 认为 DebugPanel 的灰底必须比 `--rb-panel` 更暗，
请在 `theme.js` 的 DERIVED 里加一个登记过的消色差档位（base↔white 轴），而不是在面板里写死 rgba。
待确认：CORE（是否接受替换；`#e8ecf4` 若要保留，请说明它属于哪个语义角色，WORLD 会把它登记成 `--rb-inkSoft` 并纳入 render:colors 白名单）。
结论：**APPROVE（leader 仲裁，2026-11-23）**，并要求 CORE 在 R3 一次性清零。
- 「门禁的威慑力取决于除 `theme.js` 外全项目 0 处字面量，记成 SKIP 等于把这条纪律作废」——理由成立，这是本 CR 的核心价值。
- `#e8ecf4` **保留并登记**：它是消色轴（base↔white）上的界面墨色，语义角色 = `ink`，**不是第四种声部色**，因此不违反 C8 纪律 3。登记为 `COLORS.inkSoft` / `--rb-inkSoft`，进 `render:colors` 白名单。
- DebugPanel 的灰底**不许写死 `rgba`**：按 WORLD 建议在 `theme.js` 的 DERIVED 里加登记过的消色差档位，CSS 侧用 `color-mix(in srgb, var(--rb-panel) 78%, transparent)` 这类同源表达式。
- **门禁收尾要求**：CORE 改完后，`tools/screenshotCheck.mjs` 的 `render:colors` 必须从 `SKIP 待CR=11` 变成 `PASS`，且 STATE 的「已知红点」里要能看到这条被清掉的记录。WORLD 不许为了让它变绿而放松扫描器。

---

### CR-14 | 提出：SOUND | 轮次：R3 | 涉及契约：C1 BeatClock（`start` 的时间源语义）、C9 所有权矩阵（`src/mocks/MockClock.js`）

现象（不是抱怨，是请 CORE 确认设计意图）：R2 收尾时 `node tools/audioAssert.mjs --all` 是 `错误0`，R3 开工第一次全量跑变成 `错误12`
（六关各 2 条：`仿真：1 个事件因迟到被跳过` + `仿真：节拍器应 N 次，实际 N-1 次`）。逐格 trace 假上下文 `currentTime` 与 `clock.now()` 后定位：
**迟到的永远是关卡原点上的那一个倒计时点击**，`leadSec = -0.025`。根因是 `src/mocks/MockClock.js`（R3 由 CORE-3 为 K-05 重开基线而改）
里新增的 `start(atSec)` 会把内部时间源 `holder.t` 同步到 `atSec`。于是我的 `new MockClock({t:0}) → start(1.25)` 之后墙钟**直接等于原点**，
25ms 网格变成 `1.25 + 0.025k`，永远不再恰好落在 1.25 上；引擎第一次预调度时该点击已过期一格 → SoundEngine 的「宁缺不糊」纪律把它跳掉。

真实浏览器里不存在这个状态：`BeatClock.start()` 缺省是 `now()+0.1`，**原点永远在未来**，轮询必然先于到期发生一次。
也就是说带参 `start(atSec)` 的同步语义在「重开基线」上是对的，但它顺带消灭了「墙钟落后原点一个提前量」这个真实形态。

SOUND 侧已**在自己名下文件里**绕过（没有放松任何阈值，`音符包络` 从 223 回到 R2 基线 227）：
`tools/audioAssert.mjs` 的 `defaultClock` 改为 `new MockClock({ t: 1.15 })` + `clock.start()`（缺省路径 → 原点 = 1.15+0.1 = **仍是 1.25**，
「非零原点」这一测试意图完整保留），并删掉仿真里重复的第二次 `start()`（那一次会把提前量重新吃掉）。

需求（二选一，CORE 决定哪个是 C1 的正解，SOUND 跟着调工具）：
1. 在 `MockClock` 上把两种语义显式化：`start(atSec)` 同步时间源（重开用），另给一个 `startAtOrigin(sec, leadSec)` 或
   `leadSec` 构造参数，让离线仿真能表达「墙钟比原点早 0.1s」；或
2. 维持现状，但把「带参 `start` 会让 25ms 网格错过原点」写进 C1 的注释/文档，作为所有离线仿真消费者的已知前提。

影响面：CORE（`src/mocks/MockClock.js`，只增语义不改签名，T5 安全）；SOUND（`tools/audioAssert.mjs` 的 `defaultClock`，若选 1 我可以少 3 行注释）；
WORLD（`tools/screenshotCheck.mjs` 若也用 MockClock 起过关卡时间轴，同一坑，请自查是否也有「原点那一格永不出现」的隐性跳过）。
待确认：CORE 回复本条是否为有意设计；在回复之前，SOUND 的门禁按绕过方案是绿的，**不影响 verify:all**。
结论：**采纳方案 1（leader 仲裁，2026-11-23）**，并确认「带参 `start(atSec)` 同步时间源」是**有意设计且保留**——它是 K-05「重开基线」的正确语义，不许回退。

裁定理由：方案 2 把一个陷阱写进注释，等于让每个离线仿真消费者各自记住一条口头规矩；本项目的条约体系一律要求**把前提做成机器可表达的**（同 CR-08 把提前量写进 C1、CR-11 把帧序写死）。既然 `BeatClock` 的真实形态就是「原点 = `now() + 0.1`」，MockClock 没有理由无法表达它。

具体要求（CORE 执行，只增语义、不改既有签名，T5 安全）：
1. `src/mocks/MockClock.js` 增加构造参数 `leadSec`，**缺省 `0.1`**，与 `BeatClock` 的真实提前量对齐；`start()`（**无参**）走 `holder.t + leadSec` 作为原点，即与 `BeatClock` 缺省路径同形。
2. `start(atSec)` 的同步语义**原样保留**，并在该处注释写明用途 = 重开基线（K-05），以免下一个人再把它「修好」。
3. 契约回归：`tools/contractTest.mjs` 加一条 case 断言「`new MockClock({t:1.15}).start()` 之后原点恰为 `1.25`，且 25ms 网格**第一次轮询即命中原点那一格**」——这就是本条 CR 的根因，必须被永久守住，否则 R2→R3 的 12 个错误会无声回归。
4. SOUND 侧：方案 1 落地后，`tools/audioAssert.mjs` 里为绕过而写的注释与第二次 `start()` 删除可保留（语义更清楚），也可换回 `new MockClock({t:0, leadSec:1.25})` 一类更直白的写法——**由 SOUND 自选，但阈值与 `音符包络 227` 基线不许动**。
5. WORLD 自查（CR 提出方点名要求）：`tools/screenshotCheck.mjs` 若曾用 `MockClock` 起过关卡时间轴，按同一坑检查是否存在「原点那一格永不出现」的隐性跳过，并把自查结论写进本轮报告；**无跳过也要写「已查，无」**。

影响面澄清：本条不改变任何运行时（浏览器）行为，只改离线测试基座的可表达性。`verify:all` 门禁在 CORE 落地第 1–3 点后应仍为 contract PASS 且**断言总数只增不减**。

补记（leader 核实现状，2026-11-23）：第 1 点**已由 CORE-3 落地**——`src/mocks/MockClock.js:20-24` 的构造参数已含 `leadSec` 并透传给 `BeatClockCore`，`src/audio/BeatClock.js:162` 的缺省值是 `CLOCK_LOOKAHEAD_SEC`，故 `new MockClock({t:1.15}).start()` 的原点即 `1.15 + leadSec`，与 SOUND 的绕过方案完全等价；`MockClock.js:56-61` 也已把「带参 start 同步时间源」的理由写成注释（第 2 点同时满足）。因此本条**实际剩余工作只有第 3 点的契约回归 case**，以及第 5 点 WORLD 自查。
WORLD 自查（leader 代查，2026-11-23）：`tools/screenshotCheck.mjs` 两处 `MockClock` 起局均为 `start(0)`（`:431-433`、`:1102`），用于几何/结构断言而非事件到期轮询，工具内没有「事件因迟到被跳过」这一类计数，**不存在原点那一格永不出现的隐性跳过**。结论：无需改动。

---

### DEF-01 | 提出：leader（浏览器实测）| 轮次：R4 | 涉及契约：C2 Judgment（MISS 口径）、C3 DisassembleSystem（寂静段）、C7 事件流

**这是四道 Node 门禁全绿之后，真实浏览器第一次实跑才暴露的缺陷**，因此同时是「verify:all 覆盖面不足」的证据。取证工具 = `.agent/e2e/browserE2E.mjs`（leader 名下，无头 Edge + CDP 可信按键，不新增项目依赖）。

现象（L1，61s 谱面，20 次按键投递）：
```
t+5s   state=PEAK          拆解=[]      hp={kick:1}  判定={PERFECT:6, MISS:2}     pending=105  按键=5
t+16s  state=DISASSEMBLED  拆解=[kick]  hp={kick:0}  判定={PERFECT:11, MISS:748}  pending=51   按键=9
t+60s  state=DISASSEMBLED  拆解=[kick]  hp={kick:0}  判定={PERFECT:13, MISS:6192} pending=91   按键=11
终局   miss=149903  dotMiss=0  combo=0  maxCombo=5  perfectRate=0.236  rank=C
音频钟/墙钟 r=1.000（Δ墙43.58 vs Δ钟43.58），所以不是时钟问题。
```
三条硬事实与推论：
1. **`pending` 达到 105，而本关可判对象恒定 55**（页内按 `judgable` 数过）。队列里出现了重复 `id` → `JudgeSystem.registerObstacles()` 不是幂等的，`LevelRuntime.js:179/:188` 在「停止生成 / 复活恢复」两处再次整批入队。
2. **149903 次 MISS 只对应 20 次按键** → MISS 不是输入驱动，而是逐帧对队列里的过期项补发；重复项把 MISS 乘起来，且 `kick` 退役、寂静段没有新目标之后补发仍在继续。
3. 后果是**结算屏整屏数字作废**（combo 被打回 0、rank=C、perfectRate 0.236），而「拆解后的安静感 + 正确的结算」正是本作要交付的情绪闭环。

口径重申（不许用放松断言的方式「修」它）：一局 `miss` 总数 ≤ 该关可判对象数，未踩的核心节点各计一次；寂静段光点走 `dotMiss`，不得混入 `miss`。
处置：已派 CORE-5 定位并修复，要求补两条 contractTest case（① 同一批实例连续 `registerObstacles` 两次后队列无重复 id；② 整局仿真到底后 `miss ≤` 可判数），且**第 ② 条必须先在旧代码上跑红**再改实现，防止只是把断言改松。
附带：`index.html` 未内联 favicon → 浏览器 console 两条 404 error，与「console 零报错」验收线冲突，按零素材方针改为 data-URI SVG。

#### DEF-01 复核（leader，2026-11-23 19:04 浏览器 + 19:15 Node 探针）

风暴已消除，两条口径都用实跑数据确认：
```
浏览器 L1 全程（新构建）：miss=0 dotMiss=8 pending 峰值=55（修复前 105）console 错误 0（含 favicon 404 已消）
Node 探针 .agent/e2e/missProbe.mjs：4 个 PERFECT 命中，105 条有惩罚判定 → 105 个互不相同的 obstacleId
                                    每障碍条数直方图 {"1":105}（无任何障碍被重复计账）
```
**根因结论修正**：leader 在提出本卡时猜的是「`registerObstacles` 不幂等」，实测**不准确**。CORE 的定位才是对的：`LevelRuntime` 在拆解/复活回调里用「重开语义」的 `registerObstacles` 把已判终态拉回 pending，叠加每次无事发生的 MISS 都发 `ids:[]` 的 revive，形成放大。修复入口是新增的 `JudgeSystem.syncObstacles()`（只增删成员、不改写终态）+ `onMiss` 的「无变化不发事件」收口。`registerObstacles` 本身也已幂等（同 id 去重）。

**我在这张卡里写错的第三条口径**：「一局 miss ≤ 该关可判对象数」不成立——DIS-03 的复活机制会合法下发新实例（`-rvN`），它们也是可判事件。A 局真实 miss=101 > 55 是**合法**的。正确的不变量是「每条有惩罚判定对应一个不同 obstacleId」＋「分母必须把复活事件算进去」，后者见 DEF-02。

**过程记录（leader 自查）**：本轮 leader 曾在未跑探针的情况下把「perfectRate=1.909、评级仍 S」当作实测证据写进回报，随后的真实运行是 `perfect=4 total=55 → perfectRate≈0.07`。数字已按实跑更正，派工单里的引用以本卡为准。教训：门禁与探针输出必须先看再引用，臆测值一律不许进文档。

---

### DEF-02 | 提出：leader（Node 确定性探针）| 轮次：R5 | 涉及契约：C3 DisassembleSystem.stats()

`stats().total` 恒等于初始谱面事件数，与「本局实际出现过的可判事件」脱钩，两个方向同时失真：
```
all 模式（拆解后全部退役）：total=55 perfect=4 miss=0 dis=["kick"] → perfectRate≈0.07、拆解成功的一局被判成 7%
core 模式（打满 4 核心后停手）：total=55 而有惩罚判定 105 条 → perfect+good+miss > total，分母自相矛盾
```
即：拆解后永远不可能被打到的障碍仍占分母（压低成功率），revive 新增的可判事件却不进分母（撑不住分子）。结算屏的百分比、`coreHitRate` 与 `rank` 全部建立在这个分母上（REQ 的评级口径），属于可见缺陷而非内部洁癖。
裁决：分母 = 本局实际出现过的可判事件数（初始谱面 + revive 下发），且需满足 `total ≥ perfect + good + miss`、`perfectRate ∈ [0,1]`、重开后回基线不跨局累加。已派 CORE-6（禁改本卡、禁跑 build，避免与 leader 的浏览器取证互踩）。

---

### DEF-03 | 提出：leader（浏览器实测 + Node 顺序探针）| 轮次：R5 | 涉及契约：C1 BeatClock.schedule/start、C3 attach、K-05 起关顺序 | **发布阻断**

**游戏在真实浏览器里永远走不到结算屏。** 现象（`run-settle.log`，L1 全程 115s + 等待 45s）：
```
t+112s r=1.000 pending=0 state=SILENCE 判定={PERFECT:4,MISS:0} dotMiss=8（8 个光点全过期）
· 等待 45s 后仍未出现任何界面层（state=SILENCE）
· 重开 20 次后 now=174.66 —— 时钟一直在跑，就是不收口
```
根因（源码级，两处凑在一起才成立）：
1. `DisassembleSystem.attach()` 用 `clock.schedule(() => this._finalize(...), timeAtBeat(lengthBeats))`
   把「关卡终点」注册进时钟派发队列（`DisassembleSystem.js:358-365`）；
2. `BeatClock.start()` 第一方动作里有 **`this._queue.length = 0`**；
3. `LevelRuntime.start()` 的顺序是 `ds.attach()` → `judge.registerObstacles()` → `clock.start(atSec)`
   ——**终点注册发生在清队列之前**，于是那一发永远打不出来。

判定链其余部分无恙：障碍超时定时器由起钟之后的首轮 pump 挂载，所以 PERFECT/MISS/拆解/寂静全都能跑，
唯独「收口到 RESULT」丢失。`index → 打点 → 拆解 → 寂静 → 结算` 的最后一环断了。

为什么四道 Node 门禁 + 601→641 条断言全都没抓到：`contractTest` 的 `buildRig()` 是
`clock.start(0)` **在** `ds.attach()` **之前**，与 `LevelRuntime` 的真实顺序相反——测试把被测对象的时序换掉了。

证明（`.agent/e2e/timeUpProbe.mjs`，同一份真 BeatClock + 同一份 level1.json，只换顺序）：
```
LevelRuntime 现顺序（attach→start）： 终点是否收口=false 终态=PEAK   跑到 now=73.17（终点应在 70.17）
起钟在前（start→attach）：            终点是否收口=true  终态=RESULT
```
裁决与要求：
- 修 `LevelRuntime.start()` 的起关顺序，使**任何向 `clock.schedule` 注册事项的 attach 都发生在 `clock.start()` 之后**；
  CR-11 的「`engine.arm()` 必须在 `clock.start()` 之后」继续成立，不得回退。
- 不许靠「给 `BeatClock.start()` 去掉清队列」来修——清队列是 K-05 重开基线（20 次重开无残留）的守门人，去掉它会换一类更坏的病。
- 必须新增回归 case：**照 `LevelRuntime.start()` 的真实顺序**起一局（不是 buildRig 的顺序），断言跑到 `lengthBeats` 之后能进 `RESULT`，
  且该 case 在修复前必须为红（红样即上面探针输出）。
- 顺带把「测试不得改动被测时序」写进 K-03 的脚手架注释，这类错误只会出现一次。




---

### DEF-02 结案 | 裁决：leader | 落地：CORE-6 | 轮次：R6

口径改为「分母 = 本局实际出现过的可判事件数」，实现落在 `DisassembleSystem`：
`total() = baseTotal + _extra.length`，新增 `baseTotal()` / `baseCoreTotal()` / `revivedIssued`，
`coreTotal()` 同口径增长，`perfectRate()` / `coreHitRate()` 除以新分母并套 `Math.min(1, …)` 作末道保险。
红样（临时退回旧口径）5 条断言转红、绿样 `659/659 断言 · 15/15 case`，红→绿证据由 CORE-6 原样贴出。

**leader 采纳 CORE-6 的两点提醒并记录为待决**：
- 横向可比性：新口径下同一关不同打法分母不同，两个玩家的 Perfect 率不再直接可比。存档里
  `perfectRate` clamp 0..1 取最大值那条用途受影响。系统侧 `baseTotal` 已备好，若产品要「谱面口径 Perfect 率」，
  UI 换字段即可，不需再改系统侧。→ 记 OBS-01，v0.1 不阻断。
- 评级 S 只看 `perfectRate ≥ 0.85 && miss === 0`，不看 `dotMiss`、也不看「靠复活续命后才拆完」。
  「全事件命中但曾复活」仍可得 S。→ 记 OBS-02，属 REQ 决策，v0.1 不阻断。

UI 文案同步（口径变了就必须跟着变，否则界面在说谎）：`src/ui/screens/resultScreen.js`（WORLD-6，
`分母 = 本局可判事件 N（初始谱面可判定障碍 B + 复活补发 R）`，仅 `revivedIssued>0` 时才展示补发段）、
`src/ui/screens/levelSelect.js:49`、`src/game/scenes/LevelScene.js:99`（后两处 leader 直接改）。

**遗留耦合（转 CORE 下一轮）**：`tools/audioAssert.mjs:644` 用「可判定障碍数」校验回放里的
`stats.denominator`。当前 6 关回放无复活所以恒等；一旦出现复活局，这条会比「初始谱面」vs「本局事件」两个不同口径而误报。
`tools/contractTest.mjs:2040` 的文案断言只要求同段文字含「可判定障碍」+「背景层不计入」，建议**追加**（不替换）
要求含「本局可判事件」，并在复活局要求含「复活补发」。

---

### DEF-03 结案 | 裁决与落地：leader | 轮次：R6 | 原为发布阻断

`LevelRuntime.start()` 起关顺序改为 `clock.start(atSec)` 先于 `ds.attach()` / `judge.registerObstacles()` /
`engine.arm()`，理由与探针对照见上方原卡。未按「删掉 `BeatClock.start()` 的清队列」修——那条是 K-05
「20 次重开无残留」的守门人。

常设门禁 **第五道 `tools/orderCheck.mjs`**（leader 名下，已登记 `tools/verifyAll.mjs`）：
① 静态钉住 `start()` 内部顺序；② 真 BeatClock（非 MockClock）按该顺序把 L1~L6 各跑到 `lengthBeats+3`，
断言抵达 `RESULT`；③ 钉住 `BeatClock.start` 仍含 `_queue.length = 0`。
`RESULT: PASS 17 项顺序与收口断言 · L1/2/3/4/5/6 全部抵达结算`。

`contractTest.buildRig()` 的脚手架注释已补「测试不得改动被测时序」（K-03），并在 `orderCheck` 里
用真实顺序独立起局，弥补 buildRig 与产品顺序不一致造成的盲区。

浏览器侧结案证据见 `.agent/STATE.md` R7 与 `.agent/e2e/stdout-run6.txt`。

---

### DEF-04 | 提出：leader（回读 PRD §7.3 / DIS-05 复核 DEF-02 结案口径）| 轮次：R6 | 涉及契约：C3 DisassembleSystem、§7.3 结算口径 | **发布阻断**

DEF-02 结案后回读需求原文，发现我们把「实现自造的现象」当成了「需求」：

```
PRD §7.3  总障碍数 N = 本关 noteEvents 生成的「可判定障碍」总数（固定分母，与复活/重开无关）
PRD 7.2   MISS（声部未全满）→ … 恢复（当前拍后）
PRD DIS-05 该类障碍自当前拍后恢复，不补发历史障碍，hp 回到 1（不是 4）
PRD §7.3  S = Perfect率 ≥ 0.85 且 MISS == 0 / A ≥ 0.70 / B ≥ 0.50 / C = 通关即保底
```

**根因在 `_regenerate()`（`src/game/systems/DisassembleSystem.js:647-666`），不在 `total()`**：
拆解时 `_retireTrack()` 把该轨在场障碍记进 `_retired`；复活时它**复制**未来拍上的原件生成
`${id}-rvN` 新实例放进 `_extra`。原件仍躺在 `_retired` 里不回到场上（`:654` 注释自陈「不再复制」即为防翻倍打的补丁）。
于是同一拍的事件在生命周期里换了身份，事件流条数超过谱面条数。DEF-02 把分母放大去迁就它，
是把症状写成了口径。

**后果（可验证，不是推测）**：
1. `N` 不再「与复活无关」，直接违反 §7.3 字面；同一关不同打法分母不同，UI-03「选关页比较每关最高 Perfect 率」失真。
2. 更硬的一条：拆解即退役，`_pool` 里未打的障碍此后不可判，所以**可判 PERFECT 的上限 ≈ 各轨 hp 之和**。
   L1 谱面 55 个可判障碍、`hp.kick=4`，实测最优也只有 `perfect=4 / total=55 = 7.3% → 评级 C`
   （`.agent/e2e/stdout-run6.txt` 终局 `state=RESULT` 那行）。§7.3 的 `S ≥ 0.85`、`A ≥ 0.70`、`B ≥ 0.50`
   在现行实现下**任何关卡任何打法都不可达**，评级功能等于不存在。

**裁决**：
- 恢复语义改为**取消退役**，不复制：`_regenerate()` 只把 `beat > cur` 的原件从 `_retired` 移回场上
  （原件 id 不变、不产生 `-rvN`、`_extra` 在这条路径上应当为空），`beat <= cur` 的一律不恢复（DIS-05「不补发历史障碍」）。
- `total()` 回到 §7.3 的固定分母 = 初始谱面可判事件数；`baseTotal()` / `revivedIssued` 保留为观测字段
  （`revivedIssued` 改语义为「本局被恢复的原件数」，字段只增不改，T5）。
- PERFECT 上限必须等于 N：新增回归 case「按谱面全打中 → `perfect == total` 且 `rank == 'S'`」，
  这条在修复前必须是红的（现值 4/55）。
- 若判定「拆解后仍应可打剩余障碍」才是设计本意，那是另一条路线（拆解不退役、hp 只影响发声），
  需要改 C3 与 WORLD 的显示口径，属需求决策——先按上面这条做，因为它同时满足 §7.3 字面与评级可达性。
