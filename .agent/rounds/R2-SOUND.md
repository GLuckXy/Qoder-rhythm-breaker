# R2 · SOUND 交接（声音与谱面内容）

角色：SOUND agent。派工：leader R2 任务书第 1–8 条。硬约束回顾：不改 R1 已验收的
`TrackMixer/SoundEngine/SynthVoices/Metronome/PatternGenerator/level1/level2/checkLevel/audioAssert` 机制，
只在同一套机制上扩内容；不碰 CORE-2 / WORLD-2 名下文件；不跑 git、不 `npm install`、不改 `package.json`。

## 0. 结论

**六关全绿。** 本轮新增 `level3/4/5/6.json`（谱面内容）+ `src/audio/Sfx.js`（S-08 拆分），
并给两个门禁工具补上「§7.4/§11 的关卡级验收」与「SFX 路由」两组断言，且都做过反向验证（改坏必红）。

```
node tools/checkLevel.mjs --all
  RESULT: PASS 6关 障碍409 核心114 喘息409处/756拍 空8拍窗0 同拍跨类0 错误0 警告0
node tools/audioAssert.mjs --all
  RESULT: PASS 6关 事件757 轨间差max=2.03dB(≤3) 混音阶跃max=0.020(≤0.05) 音符包络227条 错误0 警告13
npm run lint   → 0 error 0 warning
npm run build  → ✓ built in 8.84s（仅既有的 chunk>1500kB 提示）
```

13 条 warning 全是 R1 就有的口径类提示（峰值叠加 >1.0 依赖主压限器、长阻塞「宁缺不糊」吞点、
`silenceBeats` 前段落语级喘息不足 2 拍的提醒），0 error。

## 1. 派工对照

| # | 卡 | 状态 | 证据 |
|---|---|---|---|
| 1 | L3 chiptune 弹幕关 | 完成 | checkLevel 表 `L3 chiptune 126 128 61.0 52 1.86 2 56 15(k/b/s 7/4/4)`；§11 gate「弹幕只落整数冲刺拍」反向验证 FAIL |
| 2 | L4 DnB 变速关 | 完成 | `L4 drum-and-bass 120 160 73.1 83 2.31 2.5 69 22(9/7/6)`；audioAssert `发声 152 条｜节拍器 {cues:1}｜变速提示 1 条｜仿真：响 152 次（应 152）` |
| 3 | L5 glitch 假节拍关 | 完成 | `L5 glitch 128 144 67.5 64 2.00 2 64 20(8/6/6)`；`validateGhosts()` 被 `ghostBeats` 8 条真实触发（反向验证：把 ghost 挪到核心拍 4 → `✗ ghost 落在核心拍 4`） |
| 4 | L6 终曲 freeOrder | 完成 | `L6 full-arrangement 132 160 72.7 99 2.75 3 72 27(9/9/9)`；三声部核心各 9 ≥ 6（freeOrder 硬线），`windowScale 0.95` 由 gate 锁死 |
| 5 | S-08 `src/audio/Sfx.js` | 完成 | 合成逐字迁出，`SoundEngine.playSfx` 只剩委托；新增 `playForEvent`（C7 消费唯一入口）；audioAssert A12 断言 8 个名字逐个发声 + 9 条路由用例；反向验证 FAIL |
| 6 | 每关跑双门禁 | 完成 | 见上；每关写完都跑过，最终态 6 关全绿 |
| 7 | S-18 `ReplayAssembler.js` | **未做** | 理由：R2 没有任何消费者（`hp/state` 事件的生产者在 CORE-2 正在写的 `DisassembleSystem`/场景里，我不能碰）。写一份只能被自造桩数组证明的模块 = 无证据的「假完成」，按 T24 与「宁可少做并如实报告」推给 R3 |
| 8 | 报告 + STATE + CR | 完成 | 本文件、`## SOUND · 本轮变更`、CONTRACTS 末尾 CR-12 |

## 2. 四关的写法（都沿用 L1/L2 的机制，无新字段）

每关都是 `.agent/run/genL3456.mjs`（一次性，已删除）吐 JSON，`src/` 内零 pattern 数组、仓库内零音频素材文件。
事件模板都同时满足：到达间 ≥1.25 拍、同轨 ≥1.33 拍、kick 只在整数拍、每 8 拍有 ≥1 拍喘息、每 16 拍有语级休息、
时长 60–90s、同拍不跨类（铺底一律放奇数拍，主声部占偶数/四分位）。

- **L3 弹幕（chiptune 126/128，hi=116）**：A 段 4–18 只用 kick 教拍，B 段 20–108 每 8 拍 `[0k, 2b, 4s, 6k]`。
  「弹幕只出现在冲刺拍」的落地口径（不新增 C5 字段）：`synth` 的 `d`（时长）→ 弹幕速度由 `mapping.speedCuts [0.4,0.75]`
  映射成三档，而它所在拍必须是**整数拍**，且前一个到达离它 ≥ `actionRecoveryBeats.jump`（约 1.07 拍，保证人已落地能冲刺）、
  后一个到达 ≥ `dash` 恢复（约 1.07 拍）。这条被 checkLevel §11 gate 逐条检查。
- **L4 过载（dnb，120→140 @beat64，transitionBeats 2）**：严格按 CR-08 #3 批复的**拍长（period）线性插值**口径写
  （leader 已裁：不加 `ramp` 选项）。谱面事件只写 `beat`，时刻一律 `clock.timeAtBeat(beat)` 求出；audioAssert A1 断言
  `timeSec === timeAtBeat(beat)`（<1ms）在变速后仍成立，且整关仿真 152/152 恰好各响一次（`cues:1`、变速提示 1 条）。
  过渡区间 (58,64) 的铺底留白——变速那一拍不给声音，让 120→140 的挤压本身成为提示。
- **L5 干扰（glitch 128/144）**：`ghostBeats` 8 条，每条 1–2 拍：4 条压在**非核心**真实到达拍（10/38/46/74，说谎说在
  「不需要判定精度」的节点上），4 条是纯幻影（61.5/77.5/97.5/113.5，落在真空拍）。核心拍一条都不碰，由 `validateGhosts()` 硬拦。
  难度全靠 `windowScale 0.95` + 视觉说谎，密度声明 2.0 实测 2.00。
- **L6 终曲（full-arrangement 132/160，freeOrder）**：16 拍大循环 `[0k,1.25b,2.5s,4k,5.25b,6.5s,8k,9.25b,10.5s,12b,14k]`，
  三声部各 9 个核心节点（≥6 的 freeOrder 硬线），同拍三声部同屏的峰值窗口由 gate 检查（要求 ≥3 处三声部核心同窗），
  玩家自选拆解顺序时任何一个声部都还有足够的「可听骨架」。密度实测 2.75 / 声明 3.0（3.0 已被 physics 的 1.33 拍下限封死）。

## 3. 工具侧改动（SOUND 名下，只加断言不加机制）

`tools/checkLevel.mjs`：import 补 `actionRecoveryBeats`；末尾新增 §11 的 L3–L6 关卡级 gate（弹幕冲刺拍栅格、
L4 变速配置必须恰好「第 64 拍 120→140 过渡 2 拍」且过渡区间不许有事件、L5 ghost 不落核心拍 + 说谎强度统计、
L6 `freeOrder`/`windowScale=0.95`/三声部核心 ≥6 + 同窗峰值）。反向验证四次全部 FAIL 并逐条定位：

```
✗ L3 弹幕 @24.5 不在整数拍 → 不是可数的冲刺拍
✗ L4 变速配置偏离 §11（应恰好一项：第 64 拍 120→140、过渡 2 拍）
✗ ghost 落在核心拍 4（§11：绝不落核心节点）
✗ L6 windowScale 0.9 ≠ 0.95（leader 决策 L-07…） ; ✗ L6 必须 freeOrder:true ; ✗ L6 三声部核心同窗峰值 0 < 3
```

`tools/audioAssert.mjs`（三处口径修正 + 一组新断言）：
1. `auditNoteEnvelopes` 跳过 FM **调制深度**节点（值域是 Hz，不是幅度包络），计数进 `stats.sim.noteModNodes`；
   判据是 `max(v) > 1.5`，真音符增益永远进不来这一支。
2. 长阻塞仿真改用与外层同一个 `defaultClock(cfg)`：原来的 `isoClock` 桩不认 `tempoChanges`，L4 会算出 161 个
   「应发声」而真时钟只承认 152 个，误报 9 个节拍器丢点。
3. 「补发」定义改为**早于跳点时刻**（`h[2] < jumpSec - 0.002`）；旧口径把跳点后 0.14s 预调度视域内的未来事件也算补发，
   变速关必现误报。
4. 新增 A12（S-08）：8 个 SFX 名字逐个在假 ctx 上真长出节点 + 9 条 C7/C1 路由用例（含
   `{grade:'MISS',rule:'emptyBeat',penalizes:false}` → **不响**）+ `sfxAudit()` 候选表/触发表一一对应。
   反向验证（去掉 `penalizes` 守卫、让非 0 hp 也响）→ `RESULT: FAIL … 错误4`，还原后 0。

`src/audio/SynthVoices.js`：`createVoiceEngine` 的起音改为 `Math.max(0.006, …)`（原来是 0.0008）。
这是被 A2 断言抓出来的**真爆音**：铺底 `d=0.25` 时浏览器侧 attack 只有 0.4ms，而 `buildSchedule` 的
`attackSec` 早就按 `RAMP.minAttackSec=0.006` 夹过——两侧口径不一致，Node 侧绿、浏览器侧会「哒」一声。
改 src 而不是放松断言。

## 4. S-08 拆分细节

`src/audio/Sfx.js`（SOUND 名下，C9 矩阵里本来就有这一行）：
- `playSfxAt(ctx, dest, name, opts)`：合成体逐字从 `SoundEngine.playSfx` 迁来（sine/saw/pluck/twoTone/sineDrop/sineRise/
  noise/noiseBurst/noiseRise/fm 十种 kind，包络 0.008s 起音 → `setTargetAtTime` → `durSec` 归零），候选仍来自
  `SynthVoices.SFX_CANDIDATES`，**没有新造机制**。
- `sfxForJudgment(j)`：**先判 `penalizes === false` 再落 `grade`**（CR-08 #1），`EARLY/LATE` 等不扣血等级返回 null。
- `sfxForEvent(ev)`：`judge` → perfect/good/miss；`hp` 且 `hp === 0` → crack（声部彻底碎裂；途中每点掉血都响会跟判定声糊成一片）；
  `input` → null（声音挂在 judge 上）；`state.to === 'RESULT'` → finish；C1 的 `type:'tempo'` → tempo。
  `revive`/`ui` 是调用点直发（C7 里没有这两类事件，hp 单调不增推不出复活），触发来源写死在 `SFX_TRIGGERS` 里由 `sfxAudit()` 检查。
- `SoundEngine.playSfx` 只剩 2 行委托，另加 `playForEvent(ev, opts)` 作为事件流唯一消费入口；`rampKind`/`clamp01` 迁出
  （`clamp01` 由 Sfx.js 导出、SoundEngine import，避免两份实现）。`tools/audioAssert.mjs` 原来两次 `playSfx` 调用不改也能过，
  证明委托等价。

## 5. 音色候选（T16：不许独断，等人类在审美门 1 挑）

四关全部取 STYLE_PRESETS 的**最保守默认候选**，`tracks[].voice` 显式写死，改一个字符串就能换：

| 关 | 曲风 | kick | bass | arp(synth) | bed | 备注（各关 `styleNote` 里都写了） |
|---|---|---|---|---|---|---|
| L3 | chiptune | punch | round | square | bit | 想要更硬的像素味：kick→metal、arp→fm |
| L4 | drum-and-bass | metal | reese | fm | ride | Reese 太脏可回 round |
| L5 | glitch | metal | reese | fm | bit | 假标记只在渲染层（WORLD 消费），发声/障碍侧没有任何「假」事件 |
| L6 | full-arrangement | punch | saw | supo | ride | reverb 0.28 最厚；`windowScale 0.95` 是 leader 决策 L-07，非 §7.4 表的 0.9 |

SFX 候选同口径：默认 `bell/tick/thud/shatter/swell/click/sweep/stomp`，备选都在 `SFX_CANDIDATES` 里，人类点名后
CORE 传 `opts.candidate` 即可，无需改代码。

## 6. 偏离、风险与未做

1. **实测密度低于声明值**：L3 1.86/2.0、L4 2.31/2.5、L6 2.75/3.0。根因同 R1（physics 的 `AUX.minSameTypeGapBeats 1.33`
   与 §7.4 的密度列冲突），已逐关写进 `densityNote`，checkLevel 按「声明 ±25%」放行。要真打到 3.0 只能改 physics 或加宽窗口，属 CORE/WORLD 决策。
2. **仍未做真实试听**（P0 残留风险，R1 已记 `human-actions`）：所有结论来自结构断言 + 假 AudioContext。
   L3 的弹幕速度档、L4 的变速听感、L5 的「假标记说谎是否可玩」都需要人类在浏览器里过一遍。
3. `ReplayAssembler` 未做（见 §1 表第 7 行）。
4. `Sfx.playForEvent` 还没有调用点：CORE-2 正在写 `DisassembleSystem`/场景，接线时请用它而不是自己判 `grade`
   （CR-08 #1 的「不许各自再写一份」同样适用于声音侧）。已在 CR-12 里挂号待批。

## 7. 下一轮第一步（给 R3 的 SOUND）

1. CORE 把 `engine.playForEvent(judgment)` 接进判定出口，`hp/state` 事件验证后补 `ReplayAssembler`（2× stem 重组，只做 L-06 范围）。
2. 审美门 1 人类点名候选后，只改 `tracks[].voice` / `SFX_CANDIDATES` 的 `default` 字段，双门禁重跑即可。
3. 若 leader 要 L7+ 或更高密度：先把 `physics.js` 的 1.33 拍下限与 §7.4 密度列的对账结论拿到，再动谱面，
   否则 `checkLevel` 的可行性 gate 一定会红。
4. 浏览器试听时顺手看 `?selftest=audio` 里 `sim.noteMinAttackSec ≥ 0.006`、`sim.sfxRouted` 含 6 个路由名，
   可确认本轮两处修复在真 ctx 上同样成立。
