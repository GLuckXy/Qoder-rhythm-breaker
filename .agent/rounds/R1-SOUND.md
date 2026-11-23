# R1 · SOUND 收工报告（S-03 S-04 S-06 S-01 S-02）

轮次：R1（= D1 + D2 前半）｜ 写入者：SOUND ｜ 时间：2026-11-23
本文件只记 SOUND 名下事实；未跑过的命令一律写「未跑」。**本轮没有任何一次真实试听**（详见「未做完」）。

---

## S-03 · level1.json / level2.json（谱面 = 关卡）

**做了什么**
- `src/data/levels/level1.json`「启动」110BPM / 128 拍 / introBeats 4 / silenceBeats 8 / windowScale 1.2 /
  style `minimal-electro`；`tracks.kick.hp=4`，`bass.hp=0`、`synth.hp=0`（§11：第 1 关只有鼓）；
  `noteEvents.kick` 55 个事件全在整数强拍（4,6,…,112，`d:1`），前 16 拍严格「每 2 拍一根」= 4/6/8/10/12/14/16，
  **前 4 根（4/6/8/10）标 `core:true`** 作核心拆解序列，另有 8 的倍数拍共 16 个核心；
  `noteEvents.bed` 39 条铺底（奇数拍空位，`d:0.25`，`gain` 0.85/0.6）——**铺底写在 JSON 里，JS 不生成**（leader 硬要求）。
- `src/data/levels/level2.json`「脉冲」120BPM / 128 拍 / introBeats 4 / silenceBeats 12 / windowScale 1.1 /
  style `synthwave`；kick hp4 + bass hp4，synth hp0；分段严格按 §11：0–16 只有鼓 → 16–96 鼓+贝斯 →
  96–120 高密度 → 120–128 尾声（事件只到 116）；56 个可判定事件（38 鼓 + 18 贝斯），14 个核心（鼓 8 / 贝斯 6）；
  贝斯音高走 A 小调五声（`PENTA=[0,3,5,7,10]` + 每句根音位移），`mapping.platformTiers=[28,46]` 按实测音高分布定的，
  使 `pitchTier` 三档**都被用到**；`noteEvents.bed` 48 条。
- 硬规则落地：同一拍绝不跨声部（L1/L2 实测 0 处）；`hp:0` 的轨既不发声也不生成障碍；`style` 用曲风名不用形容词。

**冲突与处置（要人类知道）**
PRD §7.4 的 density 列（鼓 2 / 贝斯 3 / 合成 4 每 4 拍）与 §11 的逐关写法在物理上不可能同时成立：
`physics.js` 冻结 `AUX.minSameTypeGapBeats=1.33`，且同轨两障碍的落地恢复是
`FROZEN.jumpAirBeats(0.9) + bufferBeats(beatSec) ≈ 1.06–1.08 拍`。同轨每 4 拍 3 个事件意味着平均间隔 1.33 拍，
已经贴到上限；要 4 个（8 分音）就必须有 0.5 拍间隔 → **判定窗口再宽也救不回来，属物理不可能**。
处置：按 §11 写谱，把实测密度写进 `density` 字段并用 `densityNote` 说明偏离（L1 1.90、L2 2.00），
铺底另立 `noteEvents.bed`（不参与拆解）去满足「密度听感」。§7.4 的表格建议在 D2 前改成「含铺底的总事件密度」。

## S-04 · PatternGenerator.js + tools/checkLevel.mjs

**做了什么**
- `src/game/systems/PatternGenerator.js`（纯函数，时钟外部注入，缺省 `isoClock` 等速桩）：
  `build(levelCfg, clock, opts)` → C4 形状实例（`id: 'lv2-kick-008'`，kick→spike / bass→platform / synth→barrage /
  bed→`type:'bed', judgable:false, layer:'timeline'`；`timeSec = roundSec(clock.timeAtBeat(beat))` 量化到 1e-4 秒；
  `state:'pending'`、`grade:null`）；`buildAll()` 带 `active/inactiveReason('hp0'|'intro'|'silence')`；
  `arrivalGroups()` / `arrivalSpacing(instances, clock)`（**CR-09 批复后新增**，见「CR 与合规」）；
  `analyzeRests()`（S-06 喘息表）、`buildSchedule()`（C6 发声侧）、`adsrEnvelope()`、`selfTest(cfg, instances, clock)`
  三参签名（缺 clock 时回落等速）、`silenceStartBeat(cfg)`（WORLD 的 Obstacle.update 与 CORE 均在用）、
  `validateGhosts/validateTempoChanges/validateFreeOrder/feasibility`、`pitchToMidi/pitchToTier/durToSpeed/voiceOf`。
- `tools/checkLevel.mjs`：`--all / --lv N[,M] / --json / --quiet`；时钟优先用 CORE 真实现
  `src/mocks/MockClock.js`（手动模式，**故意用 originSec=1.25**，任何「假定第 0 拍 = 0 秒」的写法都会在这里露馅），
  拿不到才退回本地桩并打印用了哪个。除 selfTest 的断言外还加了：
  时长 60–90s、每 4 拍同类 ≤3、每 8 拍 ≥1 次 ≥1 拍喘息、同拍跨类 = 0、核心 ≥12 且每声部 ≥4、
  `hp:0` 不发声不生成（bed 单列）、`build()` 条数 == `buildAll().active` 条数、
  **声谱同源性**（逐轨：schedule 事件数 == 实例数，且每个 `timeSec` 与 `timeAtBeat` 差 <1ms）、
  `beatAt(timeSec)` 回拍误差 <0.002 拍、bed 层必须存在且全 `judgable:false` 且在 `[intro, silenceStartBeat]` 内、
  §11 逐关门禁（L1：bpm/拍数/寂静/windowScale 精确、bass+synth 必须 hp0、鼓只在整数强拍、前 16 拍恰好 7 根且间隔 2、
  前 4 根为核心、112 拍后无事件；L2：参数精确、鼓贝斯都 hp4、16 拍前无贝斯、16–96 有贝斯、
  高密度段密度必须高于主段、尾声有事件）；输出对齐表格 + 逐关喘息表 + 寂静段，**最后一行恒为 `RESULT:`**。

**verify 实际输出（本轮最后一次跑）**
```
$ node tools/checkLevel.mjs --all
checkLevel · 谱面自检（S-04/S-06/S-10）· 时钟：src/mocks/MockClock.js（CORE 真实现，手动模式，originSec=1.25）
L1 minimal-electro 110 128 69.8 障碍55 1.90 声明1.9 床39 核心16(k/b/s 16/0/0) 喘息55/116/8 空8拍窗0 同拍跨类0 每轨4拍峰值2 错误0 警告0
L2 synthwave       120 128 64.0 障碍56 2.00 声明2   床48 核心14(k/b/s 8/6/0)  喘息56/112/2 空8拍窗0 同拍跨类0 每轨4拍峰值2/1 错误0 警告0
RESULT: PASS 2关 障碍111 核心30 喘息111处/228拍 空8拍窗0 同拍跨类0 错误0 警告0
```
反向验证（确认门禁真的会红，改完立即还原）：
`L2.bpm 120→121` → `RESULT: FAIL … L2 参数偏离 §11`；`L1.density 1.9→2.9` → 声明/实测密度偏离警告；
`bed 响度 mix 0.28→0.9 且 tracks.bed.gain→1.0` → `✗ bed 仅比主声部低 0.92dB（要求 ≥6dB）` + FAIL。

## S-06 · 休止 → 显式喘息区

**做了什么**
喘息定义 = **到达间隔 ≥ 1 拍**（leader 口径；不是「整数拍完全空」，后者在高密度段物理上做不到，
第一版按「空拍」实现会让 L2 高密度段全线报错）。`analyzeRests()` 输出连续段落 + 长度 + 寂静段 + 占用拍；
`checkLevel` 逐关打印「起–止(长度)」表（>12 段折叠并给总数），RESULT 行带「喘息处数/拍数」。
L1：55 处 / 116 拍，最长 8 拍（寂静段）；L2：56 处 / 112 拍，最长 2 拍。
8 拍窗内必有一次喘息的断言零违规（`空8拍窗0`）；16 拍乐句级 ≥2 拍连息作为 warning 呈现（当前为 0）。

## S-01 · TrackMixer.js + tools/audioAssert.mjs

**做了什么**
- `src/audio/TrackMixer.js`：纯侧 `RAMP{silenceSec:0.1, reviveSec:0.15, uiSec:0.05, min:1e-4}`、`MIXER_TRACKS`、
  `db()`、`trackLoudness()`、**`auditSchedule(levelCfg, schedule, clock)`**（A0–A7 全部硬断言）、
  `buildSchedule` 再导出（C6 入口留在 audio/ 下，CORE 只需 import 一处）；浏览器侧 `TrackMixer` 类：
  每声部 gain→panner→music 子总线，`silence/revive/setLevel/setGain/applyHp/load/setVolumes/bus/levelOf`，
  **所有增益变化都走 `cancelScheduledValues + setValueAtTime(当前真值) + linearRampToValueAtTime`**，
  当前值取 `computedValueAtTime`，半路被打断也不会跳；全文件没有一处 `gain.value =` 运行时写入（只有建图初值）。
- `tools/audioAssert.mjs`：CLI（`--all/--lv/--json/--quiet/--nosim`）+ **`export async function run(opts)`**
  浏览器入口（顶层不 import 任何 Node 内置模块，`node:fs` 只在 CLI 分支里动态取）。断言：
  A1 事件时刻 vs `timeAtBeat` <1ms；A2 包络 32 点形状 \|Δ\|≤0.05 **且** 混音层 automation 在 **1ms 网格**上
  \|Δ\|≤0.05（假 AudioContext 里自己实现 `evalParam()` 求值）；A3 同拍跨声部 = 0；A4 `hp:0` 全静音；
  A5 轨间响度（口径见下）；A7 `attackSec ≥ 6ms` 且不超过时长 60%；
  **A8 整关仿真**：假 AudioContext + CORE 的 MockClock 把 L1/L2 从头跑到尾，逐条核对
  「每个事件恰好响一次 / 不早于 `timeSec` / 时刻误差 <1ms / 节拍器次数 == 计划数」；
  **A8b 长阻塞仿真**：先正常预调度，再把时钟一口气跳过半关 → 队列内 5/7 项必须全部判迟到且不补发，
  恢复后剩余事件仍各发一次（`leadSec < -0.002 → 不发声`）；
  A9 `silence` 找到 0.1s 线性斜坡、`revive` 找到 0.15s；A10 节拍器计划与变速提示双音间隔；
  另外校 `tempoCue()` 无参返回 false、`tempoCue(atSec)` 返回 true、`setVolumes` 落状态、`beatClick(false)` 回读。

**verify 实际输出（本轮最后一次跑）**
```
$ node tools/audioAssert.mjs --all
audioAssert vR1 · 结构断言（假 AudioContext + CORE 真时钟）· 目标 L1,L2,L3,L4,L5,L6
  未就绪（跳过，不算失败）：L3,L4,L5,L6 —— src/data/levels 里没有对应 JSON
L1 启动 [minimal-electro] 时钟=src/mocks/MockClock.js（CORE 真实现，originSec=1.25）
  发声 94 条 {"kick":55,"bed":39}｜响度 {"kick":0,"bed":-21.51} dB｜面积 {"kick":-14.43,"bed":-35.57}
  轨间差 （不足两条可判定声部）｜bed 相对主声部 -21.51dB｜同时峰值 1.084
  仿真：响 94 次（应 94）｜节拍器 12｜迟到跳过 0｜长阻塞：队列 5 项全部跳过 5、补发 0，恢复后 44+8/101
  斜坡：静音 1 条 / 复活 1 条｜混音 1ms 最大步长 0.02（限 0.05）｜节点 9 个 gain
L2 脉冲 [synthwave]  … 发声 104 条 {"kick":38,"bed":48,"bass":18}｜响度 {"kick":0,"bed":-21.51,"bass":-1.36}
  轨间差 kick/bass=1.36dB｜bed 相对主声部 -21.51dB｜仿真：响 104 次（应 104）｜节拍器 16｜长阻塞 7 项全跳
RESULT: PASS 2关 事件198 轨间差max=1.36dB(≤3) 混音阶跃max=0.020(≤0.05) 音符包络162条 错误0 警告5
```
3 条 warning 是事实不是妥协：L1 只有 1 条可判定声部（轨间差天然不适用）、L1/L2 同时峰值 1.084 > 1.0
（靠主压限器兜，听感需在审美门确认）、长阻塞后跳掉的条数（这是「宁缺不糊」的预期行为）。

**响度口径（我定的解释，请人类确认）**：≤3dB 的门只用在**可判定声部两两之间**（kick/bass/synth，
按事件峰值幅度 `ev.gain × tracks[].gain × 曲风 mix` 算 dB）；`bed` 是背景层，改断言「比最响主声部低 6–24dB」。
理由：若把 bed 也塞进 ≤3dB，铺底必须做到与底鼓同幅度，「拆完鼓世界变安静」这条验收线（失败模式 4）就消失了。
两种口径的数值都打印（`响度` = 峰值 dB，`面积` = 时间平均功率 dB），人类若要按面积口径收紧，改一行即可。

## S-02 · SynthVoices.js + Metronome.js（+ SoundEngine.js，CR-02 批复后新增名下）

**做了什么**
- `src/audio/SynthVoices.js`：`VOICE_LIBRARY`（kick/bass/arp/hihat/click 五库，**每库 3 套候选**，
  候选内参数键完全一致，`libraryAudit()` 断言这一点）、`STYLE_PRESETS` 六曲风（选哪套候选 + `mix` + `tone`，
  默认一律取**最保守**候选，符合「审美不许独断」）、`SFX_CANDIDATES` 8 个名字 × 2–3 套（接口先冻结，S-08 在 R2 落地）、
  `TRACK_PAN`、`resolveVoice(style, track, candidate)`、`pitchToHz()`、`createVoiceEngine(ctx, dest)`
  （正弦下滑底鼓 + 6ms 起音的噪声瞬态、双层失谐锯齿贝斯 + 副八度、方波/超锯齿/FM 琶音、高通或带通噪声碎镲、
  节拍器短音）、`libraryAudit()` 自检。
  **包络形状的唯一真相在这里**，`PatternGenerator.voiceOf()` 直接 import `resolveVoice`，
  所以 Node 侧断言的曲线和浏览器里建的 automation 是同一份数据（原来散在 PatternGenerator 里的
  `VOICE_ENVELOPES` 已删除，避免第二份真相）。
- `src/audio/Metronome.js`：`METRONOME_SHAPE`（倒计时 4 拍 1-2-3-GO；寂静段逐拍、每 4 拍重拍；
  变速提示 1056Hz/60ms + **0.11 拍后**1579Hz/50ms + 高通 800Hz）、`clickAt/clickPlan/tempoCuePlan`
  （时刻全部 `clock.timeAtBeat`；`tempoCuePlan` 优先用 CORE 的 `clock.getTempoCues()`，桩时钟才回落 `tempoChanges`，
  过渡拍数必须为 2 由 `validateTempoChanges` 守）、`auditMetronome()`、`createMetronome(ctx, opts)` 含
  **`tempoCue(atSec: number, secondAtSec?)`**：无参 → `console.warn` 一次并返回 false，绝不抛。
- `src/audio/SoundEngine.js`（Web Audio 唯一出口，CR-02 批复后归我名下）：三总线 master/music/sfx + duck +
  `DynamicsCompressor`；`unlockOnFirstGesture(target)`（pointerdown/keydown/touchstart 任一触发建图）；
  `ensureRunning()` 自愈分支严格为 `state==='suspended' && !paused → resume()`；`setPaused(flag)` 只翻标志
  （挂起权威在 BeatClock）；`loadLevel(cfg, clock)` 一次算好 schedule + clickPlan + cuePlan + audit；
  `pump()/update()` 用 `clock.schedule(fn, atSec)` 做**滚动预调度**（每帧只灌未来 0.14s，无 setTimeout 调度器），
  回调 `(atSec, leadSec)`，`leadSec < -0.002` 跳过并计数；重开检测靠 `currentBeat()` 回跳 >0.5 拍自动 `arm()`；
  `silence/revive/applyHp/beatClick/tempoCue/setVolumes/setDuck/playSfx/getStatus/dispose`；
  `init(injectedCtx)` 允许测试注入假上下文（audioAssert 的长阻塞仿真用，绝不污染第一关节点图）。

**候选清单（审美门 1 要给人类听的，全部有 `label` + `audition` 字段）**
- kick：`soft`（默认，150→48Hz/90ms）、`punch`（190→52Hz + 6ms 噪声）、`metal`（230→58Hz + 12ms 高通噪声）
- bass：`round`（默认，triangle→LP320）、`saw`（默认用于 synthwave，saw×2 detune6¢→LP460 Q1.2）、`reese`（saw×3 detune18¢→LP620 Q2.4）
- arp：`square`（默认，LP2200）、`supo`（saw×2 detune12¢→LP2800）、`fm`（carrier×3, index240→LP3400）
- hihat/bed：`hat`（默认，HP7k 40ms）、`ride`（HP4.2k 120ms）、`bit`（BP3.6k Q3.2 22ms）
- click/节拍器：`met`（1.6k/2.4k 35ms）、`wood`（BP900 50ms）、`dot`（默认，2.2k 柔和高频 60ms）
- SFX：perfect{bell 默认/pluck/chime}、good{tick 默认/blip}、miss{thud 默认/buzz}、crack{shatter 默认/glass}、
  revive{swell 默认/reverse}、ui{click 默认/soft}、tempo{sweep 默认/double}、finish{stomp 默认/gate}

---

## CR 与合规

- **CR-10（新提）**：`noteEvents.bed` + `tracks.bed{disassemble:false}` + `tracks[].voice` + `style/densityNote/mapping`
  进 C5；并记录我已按 **CR-09 批复删除** `build()` 实例内的 `pxPerSec` / `beatWidthSec`，
  取而代之 `arrivalSpacing(instances, clock)`（拍长是时钟量，不是几何量）。`tools/checkLevel.mjs` 现在反向断言
  「实例里若再出现这两个字段就报错」。**WORLD 请注意**：bed 的横坐标请用
  `physics.pxPerSec(view, spacing[i].widthSec)`，我这边不再给视口常量。
- **CR-11（新提）**：C6 的 `tempoCue()` 签名改为 `tempoCue(atSec: number, secondAtSec?)`（无参 = bug，warn 一次返回 false）；
  新增名下文件 `src/audio/SoundEngine.js` 请 CORE 补进 C9 所有权矩阵；CORE 需接三处
  （每帧 `ensureRunning()`、首次手势 `unlockOnFirstGesture()`、关卡起 `loadLevel`+`arm`）。
- CR-08 的采纳：`buildSchedule` 不消费 `tempoMap.beatDuration`（CORE 未导出），拍长一律 `timeAtBeat(b+d)-timeAtBeat(b)`；
  L4 变速按 **拍长线性** 口径写谱（leader 已裁决，不加 `ramp` 选项）；`schedule` 提前量按第 4 点在 engine 侧自检 leadSec。
- CR-09 的采纳：判据只看 `judgable`，bed 的 `track/type` 只是分类标签；`pxPerSec/beatWidthSec` 已删（见上）。

## 未做完 / 风险（不粉饰）

1. **一次都没听过。** 本轮所有音频结论都来自结构断言（假 AudioContext 的 automation 求值 + 整关仿真计数）。
   「程序合成音色能不能达到电子音的最低听感」是 P0-2 风险，需要人类在审美门 1 用浏览器实听；
   我给出的候选表就是为此准备的，但**默认候选未经听感验证**。
2. `src/main.js`（CORE 名下）没有 import 任何音频模块，所以 `npm run build` 的产物里**不含**我的模块，
   浏览器实际发声链路（真 AudioContext、Safari 解锁、`?selftest=audio` 挂载）**未跑过**。
   我的模块目前由 `npm run lint`（0 错 0 警）+ Node 假上下文仿真覆盖。
3. S-08 `Sfx.js` 未写（leader 已裁到 R2）；但 `SoundEngine.playSfx(name)` 与 `SFX_CANDIDATES` 已可用，R2 只是拆文件。
4. 等级 3–6 未写（S-09/S-11/S-13/S-14/S-15 仍是 ready），因此 `checkLevel/audioAssert` 对它们打
   `未就绪（跳过，不算失败）`，RESULT 行只统计 2 关。**每份新谱面必须带非空 `noteEvents.bed`**（已被断言强制）。
5. `bed` 的横坐标渲染需要 WORLD 的 `arrivalSpacing` 接线确认（CR-10 待回复）。
6. 高密度段的 16 拍乐句连息目前只有 1 拍级喘息（L2 最长 2 拍）；若人类要求「每 16 拍一次 ≥2 拍连息」，
   L2 的 96–120 段要重新排（会影响密度），已作为待裁决项写在这里而不是偷偷改。

## 本轮实际跑过的命令

```
node tools/checkLevel.mjs --all            → RESULT: PASS 2关 … 错误0 警告0
node tools/audioAssert.mjs --all           → RESULT: PASS 2关 … 错误0 警告5
node tools/audioAssert.mjs --lv 2 --json   → RESULT: PASS 1关 …（JSON 模式正常）
npm run lint                               → 0 error 0 warning（含 tools/）
npm run build                              → ✓ built in 4.86s（未破）
node tools/verifyAll.mjs                   → contract OK / level OK / audio OK / render SKIP，3/4 PASS 0 FAIL
```
注：`npm run lint` 早前被 CORE 记为「10 warning 分布在 SOUND 名下」，本轮已清零（含 PatternGenerator 的
`REST_GRID`、SoundEngine 的 `STYLE_PRESETS`、checkLevel 的 `isoClock/hiOf/allArg`、audioAssert 的死代码）。

## 下一轮第一步

1. 请 CORE 在 `src/main.js` 接上 `SoundEngine`（CR-11 的三处），跑 `?selftest=audio` 浏览器端
   `run({levels:[L1,L2]})` 并把 JSON 挂到 `window.__SOUND_SELFTEST__`，让「未听过的链路」至少先「响起来」。
2. 写 L3（chiptune，`noteEvents.bed` 非空 + `style:'chiptune'`），把 `validateGhosts/validateTempoChanges`
   接到 L5/L4 的谱面上（目前只有函数没有关卡触发它们）。
3. S-08 `src/audio/Sfx.js`：把 `SFX_CANDIDATES` 拆出来，接 C7 的 judge/disassemble 事件
   （**先判 `penalizes === false` 再落 `grade`**，CR-08 第 1 点，ReplayAssembler 同规则）。
4. 若人类收紧响度口径为「面积功率 ≤3dB」，则 bed 的 `mix` 需要从 0.26–0.32 提到 ~0.8，
   同时把主声部 `tracks[].gain` 降下来保 headroom（当前同时峰值 1.084）。
