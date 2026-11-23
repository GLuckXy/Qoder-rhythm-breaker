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
