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

