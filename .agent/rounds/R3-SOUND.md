# R3 · SOUND 交付报告

轮次：R3 承担：S-18（L-06 范围内的 2× 分轨重组）+ S-17（音量三通道与六关混音**复核**）
未动 R1/R2 已验收机制：`TrackMixer/SoundEngine/SynthVoices/Metronome/Sfx/PatternGenerator/level*.json/checkLevel.mjs` 的既有逻辑
（`audioAssert.mjs` 只加 case，并把仿真的时钟原点口径对齐真实浏览器，见 §3）。未跑任何 git，未 npm install。

---

## 1. S-18 `src/audio/ReplayAssembler.js`（新增，只做 2× 分轨重组）

### 1.1 给 CORE-3 结算界面的入口（唯一需要 import 的两个函数）

```js
import { summarizeReplay, assembleReplay } from '../audio/ReplayAssembler.js';

// 结算界面只要统计：
const stats = summarizeReplay({ events: JudgeSystem.events.events, instances, levelCfg: cfg, clock: BeatClock, speed: 1 });
// 回放条/分轨时刻表要区间：
const rep = assembleReplay({ events, instances, levelCfg: cfg, clock: BeatClock, speed: 2 });
```

入参（全部可选，缺项只在 `warnings` 里报口径退化，不抛）：

| 字段 | 内容 |
|---|---|
| `events` | C7 事件流本体（`JudgeSystem.events.events`，`{t,kind:'judge'|'hp'|'input'|'state',...}`） |
| `instances` | `PatternGenerator.build(cfg, clock)` 的 ObstacleInstance[]——**固定分母与 core/track 映射的唯一来源** |
| `levelCfg` | C5 level JSON（读 `tracks[].hp` 与 `lengthBeats`） |
| `clock` | BeatClock（只用 `beatAt`/`timeAtBeat`，本模块零 `60/bpm`） |
| `schedule` | 可选，C6 `buildSchedule` 输出；给了就顺带把每段的可发声点算进 `segment.points` |
| `speed` | 播放倍率，默认 2；**只缩放 t，不改顺序** |

`summarizeReplay` 返回的 `stats` 字段（结算界面可直接取用）：

```
counts{PERFECT,GOOD,MISS}  perfectRate  goodRate  missRate  denominator  denominatorSource
coreTotal  coreHit  coreHitRate  maxCombo  miss  judged  emptyBeats  avgAbsDeltaMs
byTrack{track:{PERFECT,GOOD,MISS}}  inputs  inputsNoTarget  hpEvents  revives
stems[{track,hpStart,hpEnd,segments,activeSec,boundaries,pointCount,missedWhileSilent}]
disassembledAtSec  disassembledAtBeat  disassembledSource('state'|'hp'|null)
silenceSecAfterDisassemble  totalSec  scaledTotalSec  speed  levelId  title
rampSec{silence:0.1,revive:0.15}
```

`assembleReplay` 另返回 `startSec / endSec / stems / timeline / events / warnings`：
`stems[i].segments[j] = {track, openSec, closeSec, hp, kind:'start'|'damage'|'revive', edge:'hp'|'level-end',
openBeat, closeBeat, catchUp:false, resumeFromBeat, rampSec, points[]}`；`timeline` 是把全部区间边界摊平成升序数组。

**注意倍速口径**：`speed:2` 时 `events/stems/timeline/disassembledAtSec/scaledTotalSec` 都是**缩放后的秒**
（2× 播放 = 用时减半）；`perfectRate/maxCombo/分母`等计数类字段与倍速无关。要原始秒请传 `speed:1`。

其余导出：`REPLAY_SPEED(2) REPLAY_SPEEDS isScoringEvent isEmptyBeatEvent scaleEvents judgableTotal coreTotal
replayBoundaryErrors syntheticSilenceEvents replaySelfTest`。

### 1.2 口径落点（不各写一份）

- **CR-08 批复第 1 点**：`isScoringEvent()` 先判 `penalizes === false`（连带 `rule === 'emptyBeat'`）再落 `grade`；
  实测 L1 剧本里 3 条空拍伪 MISS → `counts.MISS = 3`（真漏判）而 `emptyBeats = 3` 单列，两者不互相污染。
- **C3 分母固定**：`denominator = judgableTotal(instances)`（按 id 去重的可判定障碍数），
  `judgable:false` 的 bed 实例**不进分母**；没传 `instances` 才退回「事件流出现过的 id 数」并写 warning
  （`denominatorSource:'events-fallback'`，audioAssert 里这条一出现就判红）。
- **C3 复活不补发**：`revive` 段的 `catchUp:false`，取点条件是 `openSec ≤ timeSec < closeSec`，
  区间起点之前的历史点结构上不可能被回收；`missedWhileSilent` 给出静默期内被吞掉的点数供 UI 显示。
- **拆解时刻**：优先 C7 `state` 事件（`to:'DISASSEMBLED'|'SILENCE'`），退回「最后一个把某声部打到 0 的 hp 事件」，
  两者都没有则为 `null`（L3 的剧本就是 null——它的核心节点不足以把三声部同时打通，属数据事实不是缺陷）。
- 静音/复活只体现为逻辑边界 + `RAMP` 时长引用，本模块不产生任何瞬时赋值；时刻全部向 clock 索取。
- 仓库内零音频素材、`src/` 内零硬编码 pattern、无 `setTimeout` 音频调度（本文件连定时器都不出现）。

### 1.3 Node 断言结果（听不到波形，只验结构）

`replaySelfTest()`（`tools/audioAssert.mjs` 每次 `run` 跑一遍，另可给 CORE 的 `?selftest=` 路由复用）：
**0 错误 0 警告**（19 项人造判据）——分母 = 8（1 个 bed 实例被排除）、Perfect 率 1、maxCombo 8、
`emptyBeats` 1 且 `counts.MISS` 0、2× 后 `disassembledAtSec` 14→7 且顺序逐项相等、
人造「三声部同刻归零」剧本的拆解瞬间 8s 之后 0 段在响、复活段恰 1 段且 `catchUp:false`。

关卡级 A11（`replayAudit(cfg, clock)`，六关各跑一遍，全部 0 错误）实测：

```
L1 分母55(可判定55/bed39) P52 G0 M3 空拍3 Perfect率0.9455 核心1 maxCombo28 声部1段4 拆解6.7045s 2×时长34.909s
L2 分母56(56/48)           P45 G9 M2 空拍1 0.8036 0.7143 27 声部2段8 拆解49.25s  2×时长32s
L3 分母52(52/56)           P42 G7 M3 空拍2 0.8077 0.9333 16 声部3段12 拆解null   2×时长30.476s
L4 分母83(83/69)           P68 G12 M3 空拍3 0.8193 0.8182 56 声部3段12 拆解63.3929s 2×时长36.536s
L5 分母64(64/64)           P51 G9 M4  空拍3 0.7969 0.8     16 声部3段12 拆解49.7656s 2×时长33.75s
L6 分母99(99/72)           P78 G16 M5 空拍4 0.7879 0.8148 48 声部3段12 拆解40.5682s 2×时长36.364s
```

断言项（每关 20+ 条，判据与实现**不同源**：MISS/分母/核心命中/maxCombo 都独立重算一遍再比）：
① `replayBoundaryErrors`：每个区间的 hp 来源边界集合与该声部 `hp` 事件时刻集合**逐项相等**（关首/关尾除外）；
② 倍速只缩放 t：`scaleEvents` 前后 `kind:id` 序列逐位相同，且非零 `t` 满足 `t₂·2 === t₁`（1e-9 容差），
声部数/区间段数在 1× 与 2× 下完全一致；
③ 拆解瞬间安静：把三声部打到 0 的事件流喂进去，`closeSec > atSec && openSec < atSec` 的段数必须为 0；
④ `penalizes:false` 不算 MISS、bed 不进分母、分母来源必须是 `instances`；
⑤ 复活段 `catchUp:false` 且 `openSec` 恰等于那条 hp 事件的时刻。

---

## 2. S-17 音量三通道与六关混音复核（只复核，没重构）

`TrackMixer.setVolumes({master,music,sfx})` 保持原样，未动合成器与包络代码。

| 复核项 | 判据 | 实测 | 结论 |
|---|---|---|---|
| 轨间差（可判定声部两两） | ≤3dB | L2 1.36／L3 max 1.17／L4 max 2.03／L5 max 1.83／L6 max 1.83，**全局 max 2.03dB** | 达标，**未改任何 `tracks[].gain`/`bed.mix`** |
| bed 相对主声部 | −6～−24dB | −21.51／−21.51／−23.57／−22.33／−21.77／−22.33 | 达标 |
| `hp:0` 声部不发声 | A4 | 六关 0 违规（L1 只有 kick 一条可判定声部 → 轨间差项打 warning 不判红） | 达标 |
| silence/revive 斜坡无阶跃 | A2+A9（0.1s/0.15s 线性、1ms 网格最大步长 ≤0.05、全程无 `gain.value=`） | 六关混音 1ms 最大步长 0.020，静音/复活各 1 条斜坡，阶跃违规 0 | 达标 |
| 同时峰值 | leader 裁决：**维持峰值口径不改断言**，>1.0 只记 warning | 1.084／1.084／1.066／1.077／1.082／1.077（max **1.084** @7.25s on L1） | 已按裁决登记红点 + 新增 warning |

新增的 warning（不是 error，`RESULT` 不因它变红）：

```js
if (Number.isFinite(row.peakSum) && row.peakSum > 1.0) row.warnings.push(`混音同时峰值 ${row.peakSum} > 1.0（真 ctx 上有削峰风险…）`);
```
实跑 `峰值warn6`（六关各一条）。SOUND-2 留的「面积功率口径」待裁决项**没有执行**：
按 leader 裁决维持峰值口径，bed `mix` 仍 0.26–0.32，未提到 0.8、未压低主声部。

---

## 3. 顺手抓到的一个真回归（CORE-3 名下，非我改坏）

R2 收尾时 `audioAssert --all` 是 `错误0`，本轮开工第一次全量跑变成 `错误12`（六关各 2 条）：

```
仿真：1 个事件因迟到被跳过（正常应为 0）
仿真：节拍器应 12 次，实际 11 次
```

定位过程（逐格 trace 假上下文的 `currentTime` 与 `clock.now()`）：迟到的那一条**永远是关卡原点上的第一个倒计时点击**，
`leadSec = -0.025`。根因在 `src/mocks/MockClock.js`（17:48 被 CORE-3 改过，K-05 重开基线）：
`start(atSec)` 现在会把内部时间源同步到 `atSec`，于是 `tools/audioAssert.mjs` 里
`new MockClock({t:0}) → start(1.25)` 之后墙钟直接等于原点，25ms 网格再也不会落在 1.25 上，
引擎第一次预调度时就已过期一格。真实浏览器里 `BeatClock.start()` 缺省是 `now()+0.1`，原点永远在未来，不存在这格。

修法在**我自己的工具侧**（不越界改 CORE 文件、不放宽任何阈值）：
`defaultClock` 改为 `new MockClock({ t: 1.15 })` + `clock.start()`（缺省 = 1.15+0.1 = **原点仍是 1.25**，
非零原点这个测试意图完全保留），并删掉仿真里重复的第二次 `start()`。
修完 `音符包络` 从 223 回到 R2 基线的 **227**，六关 `节拍器 12/16 次全中、迟到跳过 0`。
**已在 CONTRACTS.md 追加 CR-14** 请 CORE 确认 `MockClock.start()` 无参路径与 `start(atSec)` 带参路径的差别是有意设计。

---

## 4. 门禁实际输出（逐字）

```
$ node tools/audioAssert.mjs --all
audioAssert vR3 · 结构断言（假 AudioContext + CORE 真时钟）· 目标 L1,L2,L3,L4,L5,L6
RESULT: PASS 6关 事件757 轨间差max=2.03dB(≤3) 混音阶跃max=0.020(≤0.05) 音符包络227条 回放段60 峰值warn6 错误0 警告19

$ node tools/checkLevel.mjs --all
RESULT: PASS 6关 障碍409 核心114 喘息409处/756拍 空8拍窗0 同拍跨类0 错误0 警告0

$ npx eslint src/audio tools/audioAssert.mjs tools/checkLevel.mjs
（0 error 0 warning，退出码 0）

$ npx eslint src/audio tools        ← 含他人名下文件
tools/contractTest.mjs 1654:10 warning 'ds_free' is defined but never used  no-unused-vars
✖ 1 problem (0 errors, 1 warning)     ← 这条在 CORE-3 名下，我没动
```

跑 `audioAssert` 时控制台会打一行 `[SoundEngine] tempoCue(atSec) 需要绝对时刻（秒）… 本次忽略`——
那是 `tools/audioAssert.mjs:528` 的**反向用例**（`engine.tempoCue()` 无参必须返回 false）故意触发的，
不是缺陷，别去追它。

---

## 5. 未做 / 边界

1. **完整版回放（任意时刻分层启动 + 操作剪影同步）没做**——L-06 预砍项，做了就是 T24 越界。
2. **S-17 没做任何混音改动**：六关全部指标已在裁决口径内，改 `tracks[].gain` 只会破坏已验收的响度平衡；
   面积功率口径若要启用需要 leader 重新裁决（届时 bed `mix` 0.26–0.32 → ~0.8 且要压主声部留 headroom）。
3. `ReplayAssembler` 尚无浏览器消费者：`playForEvent` 已接好，回放侧只等 CORE-3 在结算界面调 `summarizeReplay`；
   `?selftest=replay` 的路由在 CORE 名下，我只保证了 `replaySelfTest()` 在 Node 可跑、返回 `{errors,warnings,stats}`。
4. 仍未真实试听（纪律 4）：本轮所有结论都是结构断言，音色候选仍取最保守默认，待人类审美门 1 点名。
