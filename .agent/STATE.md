# STATE · 项目交接板（agent 的外置记忆）

> **仓库根目录 `.agent/STATE.md`。** 本项目唯一的记忆载体（T17）。每轮开头必读、收工必写。
> 规则：只追加、只覆盖自己那一段；`Decisions` 与 `CONFLICTS` 只增不删；全文 ≤120 行。
> leader 的派工与代拍决策见 `.agent/PLAN.md`；契约见 `.agent/CONTRACTS.md`；卡片见 `.agent/TASKBOARD.md`。

---

## 当前

```
轮次：R1（契约与纯函数，对应原 D1+D2 前半）   门：三方离线均可自验   状态：进行中
最近绿 tag：（无）
main HEAD：a1b0d1e（D0 骨架，npm run build 绿，verify:all = 0/4 PASS + 4 SKIP）
远程：https://github.com/GLuckXy/Qoder-rhythm-breaker.git （main 已建立，push 可用）
```

## 本轮 writes 声明（T7，三方集合两两不相交）

```
CORE  : src/main.js src/audio/BeatClock.js src/mocks/MockClock.js src/game/systems/JudgeSystem.js
        src/data/{physics,config,save}.js src/ui/DebugPanel.js tools/contractTest.mjs
WORLD : src/data/theme.js src/styles/neon.css src/game/render/{WorldLayer,Background}.js
        src/game/objects/{Obstacle,Spike,Timeline}.js tools/screenshotCheck.mjs
SOUND : src/audio/{TrackMixer,SynthVoices,Metronome}.js src/game/systems/PatternGenerator.js
        src/data/levels/level{1..6}.json tools/{checkLevel,audioAssert}.mjs
交集检查：空 ✅
leader 独占：tools/verifyAll.mjs 的语义、git 全部操作、main 分支与 tag
```

## 编排者约束（本轮生效，覆盖 WORLD.md/SOUND.md 里的分支条款）

1. **不许运行任何 `git` 命令**（add/commit/branch/stash/push 全部由 leader 执行）。见 PLAN §0。
2. **不许 `npm install` / 改 `package.json`**（C10/T19）。允许用已装好的 `phaser`、`vite`、`eslint`。
3. **只写上面自己名下的路径**。需要改他人文件 → 在 `.agent/CONTRACTS.md` 末尾追加 CR，不要动手。
4. 依赖文件尚不存在时：你的工具对该断言打 `SKIP <原因>` 并在报告里点名，**不要代他人创建文件**（T2）。
5. 收工报告写 `.agent/rounds/R1-<你的名字>.md`：逐卡「做了什么 + verify 实际输出关键行 + 未做完的 + CR」。
6. **禁止假完成**（T13）：没跑过的命令不许写「已通过」。

## CORE · 本轮变更
```
新增 9 文件（全部 CORE 名下）：src/audio/BeatClock.js src/mocks/MockClock.js src/game/systems/JudgeSystem.js
src/data/{physics,config,save}.js src/ui/DebugPanel.js tools/contractTest.mjs src/main.js（改，仍 D0 占位场景+挂面板）
K-01 时钟：分段积分（ramp 对「周期」线性插值→严格可逆），实测 120→140 互逆误差 6.09e-12 ms；25ms/120ms 预调度、
队列按绝对时刻排序、resume 只平移原点不重置拍序；MockClock 与 BeatClock 同类同构，WORLD/SOUND 可在 Node import。
K-02 判定：±60/±110（strict ±50/±100）、下限 40/80、六关 scale 1.2/1.1/1.0/1.0/0.95/0.95、latency、JDG-04 三级规则、
超时 MISS 自检重排保证不早结算；新修：judgable:false 的 bed 背景实例不入队（修掉 L1 的 39 条假 MISS）。
K-04 physics：C8 十项 + §7.5 辅助数全冻结为视口纯函数；obstacleX 公式与跳跃 v0=4h/T、g=8h/T²；selfTest 1.087<1.33 拍。
K-08 save：v1 字段级合并、三径静默降内存档、500ms 尾沿节流、可注入 stub storage。K-06 事件流：升序 + Perfect 率可重算。
K-03 DebugPanel（5+3 项读数、`/D 开关、?debug=1）+ contractTest：7 case / 306 断言全绿，最后一行 RESULT: 契约不变。
验证：node tools/contractTest.mjs → RESULT: PASS 306/306（7/7 case，0 skip）；npm run build ✓5.08s；
npx eslint <CORE 9 文件> 0 错 0 警；verify:all → contract OK / level OK / audio+render SKIP。
提出 CR-08（emptyBeat 语义 + 新增 trigger/penalizes/key + tempoChanges 周期线性口径 + schedule 提前量约定）
与 CR-09（C4 承认 judgable:false 背景实例）。证据全文见 .agent/rounds/R1-CORE.md。
```

## WORLD · 本轮变更
```
R1 收尾 + R2 部分。新增 tools/screenshotCheck.mjs（W-02，前任未写）：Node 侧纯函数几何门禁，用「录制用 Graphics」驱动
生产路径本身（WorldLayer/Timeline/Background/Obstacle/Spike/Platform/Barrage/Player），17 组 305 条断言，无浏览器。
实跑输出：`node tools/screenshotCheck.mjs` → RESULT: PASS 判定线Δ0px(≤1) 角色x=576 4拍=883.2px（六 BPM 全等）
pxPerBeatΔ0 灰度 kick:101 bass:213 synth:161（最小对 bass/synth Δ52 ≥ 门限 40）上下层逐实例Δ0px
真谱面 L1/L2 21条/Δ0px 扫描0命中·17文件 theme=11 css=24 WORLD越界=0 待CR=11 CSS 54 var 分区 86.4/648/345.6px
quiet档 burst=12 bloom=0 parallax=2 · 305通过/0失败/3SKIP；`node tools/verifyAll.mjs` → 4/4 PASS。--json 可解析，
--selftest <file|inline|-> 入口已留（schema=world-selftest/v1，已用 Node 伪造负载跑通 11 条断言）。
门禁抓到的 3 个真缺陷（都不是我新增代码，是前任遗留）：① WorldLayer 私有 laneOf() 与 Obstacle.laneKeyOf() 算出两个值
（`lv01-kick` vs `1-kick`）→ 跨泳道保护把所有实例拦掉 = **上层世界画不出任何障碍**，真谱面必现；已改为唯一口径 laneKeyOf。
② theme.buildView 把 beatSec/pxPerSec 各舍入到 2 位 → pxPerSec ≠ pxPerBeat/beatSec（@110BPM 差 0.8%），已给速率量 r6。
③ QUALITY_CAPS.parallaxLayersMax=4 但层表只有 3 条（降级开关会要一个不存在的层），已对齐成 3。
补齐 R2 三张卡：objects/Platform.js（W-09：三档 y 直接取 physics.FROZEN.platformTiers，与 CORE 的 platformTopY 同值
Δ≤0.6px；核心落点 = judgeX；可达包络 6 档 BPM 全过）；objects/Barrage.js（W-10：间隙 = 2.2×角色高，行的排布在世界带内，
网最低边高过站立角色头顶 →「站着碰不到」成立；speedForDur 与 SOUND 的 durToSpeed 逐值相等，不另立映射）；
objects/Player.js（W-03：fixedX ≡ judgeX，跳跃用 physics 冻结的 v0=4h/T、g=8h/T² 现算高度，冲刺表现位移首尾为 0，
微调三档候选；全部 (nowSec − 动作起始秒) 的纯函数）。WorldLayer 挂接表补 platform/barrage，并新增 applyAction/
snapshot.player（CORE 只需在 sync 的 extra 里传 action:{kind,atSec}）。worldYFor('bass') 改为按档位取板顶面
（原先自插一条「跳跃带」中间值，与 CORE 的 platformTiers 是两套数，W-09 会分叉）。
neon.css 从 7 行占位重写为 token 层：49 个 --rb-* 与 theme.cssTokens() 逐值同源 + 5 个别名（清单见 rounds 报告），
CORE 界面层所需 15 个 token（分区/比例/字号/声部标记/quality）齐备；render:colors 逐条比对，改 theme 不改 css 会红。
CR：已批复 CR-08（emptyBeat 在 WORLD 侧天然 no-op，已写进门禁）与 CR-09/C10/C12 里指向 WORLD 的开放问题；
新提 CR-13（CORE 名下 11 处颜色字面量含第七色 #e8ecf4，请改走 token）。
未做：W-07 EffectSystem（门禁对该组是 SKIP 并点名）、W-06 对齐虚线只做了 alignDashAlpha 断言、bed 层按
arrivalSpacing 画进时间轴带（CR-10 批复后待接）。全文见 .agent/rounds/R1-WORLD.md。未跑 git、未 npm install。
```

## SOUND · 本轮变更
```
R2 交付：新增 src/data/levels/level{3,4,5,6}.json（谱面内容，§7.4 六关齐）+ src/audio/Sfx.js（S-08，合成逐字从
SoundEngine.playSfx 迁出，无新机制）；改 SoundEngine.js（playSfx 变委托 + 新增 playForEvent 作 C7 消费唯一入口）、
SynthVoices.js（createVoiceEngine 起音 0.0008→0.006，与 buildSchedule 的 RAMP.minAttackSec 对齐，A2 抓出的真爆音）、
tools/checkLevel.mjs（§11 关卡级 gate：L3 弹幕必须落整数冲刺拍且前后满足 actionRecoveryBeats、L4 变速配置锁死
「64 拍 120→140 过渡 2 拍」+过渡区间留白、L5 ghostBeats 不落核心拍、L6 freeOrder+windowScale 0.95+三声部核心 ≥6+同窗峰值）、
tools/audioAssert.mjs（三处口径修正：FM 调制深度节点不再当幅度包络、长阻塞仿真改用带 tempoChanges 的 defaultClock、
「补发」= 早于跳点的发声；新增 A12 SFX 断言）；删 .agent/run/genL3456.mjs（一次性吐 JSON，src/ 内零 pattern 数组）。
未动 R1 已验收机制与 CORE-2/WORLD-2 名下文件，未跑 git/npm install。
数据：L3 chiptune 126/128 61.0s 到达52 密度1.86(声明2.0) 床56 核心15(7/4/4)；L4 dnb 120→140@64 160拍 73.1s 到达83
2.31(2.5) 床69 核心22(9/7/6) 发声152/仿真152 cues1 变速提示1；L5 glitch 128/144 67.5s 到达64 2.00(2.0) 床64 核心20(8/6/6)
ghostBeats 8 条(4 压非核心到达拍+4 落空拍，validateGhosts 真触发)；L6 full-arr 132/160 72.7s 到达99 2.75(3.0) 床72 核心27(9/9/9) freeOrder。
验证：checkLevel --all → PASS 6关 障碍409 核心114 空8拍窗0 同拍跨类0 错误0 警告0；audioAssert --all → PASS 6关 事件757
轨间差max=2.03dB 混音阶跃max=0.020 音符包络227条 错误0 警告13（全是 R1 既有口径提示）；npm run lint 0/0；npm run build ✓8.84s。
反向验证全部 FAIL 过并已还原：L3 弹幕 @24.5、L4 transitionBeats=1、L5 ghost@核心拍4、L6 freeOrder=false+windowScale=0.9、
Sfx 去掉 penalizes 守卫（→ 错误4）。
偏离与风险：① 实测密度低于 §7.4 声明值（根因仍是 physics 的 1.33 拍下限），已逐关写进 densityNote；② 仍未真实试听，
音色候选按 T16 全取最保守默认（L3 punch/round/square/bit、L4 metal/reese/fm/ride、L5 metal/reese/fm/bit、
L6 punch/saw/supo/ride），待人类审美门 1 点名；③ S-18 ReplayAssembler **未做**（CORE-2 正在写 hp/state 的生产者与场景，
本轮没有消费者，不做无证据交付）；④ Sfx.playForEvent 尚无调用点，请 CORE 接线（口径见 CR-12）。全文见 .agent/rounds/R2-SOUND.md。
```

## 当前可运行状态

```
R1 结束时应为：`node tools/contractTest.mjs` 绿（变速互逆<1ms、三档窗口、复活三口径、存档降级）；
`node tools/checkLevel.mjs --all` 对 L1/L2 草案绿；`node tools/audioAssert.mjs` 对 buildSchedule 绿；
`node tools/screenshotCheck.mjs` 对几何纯函数绿；npm run build 仍绿。浏览器里仍是 D0 占位画面（R2 接上）。
```

## 已知红点
```
CORE→WORLD（缺陷退回，非契约问题，CORE 不代改）：`npm run lint` 收工快照 4 error 全在 WORLD 名下 —
  Obstacle.js:330:28 'y'、Timeline.js:351:66 与 352:29 'TRACKS'、Background.js:164:18 'calmFactor'（均 no-undef）；
  另 10 warning 分布在 WORLD（Obstacle/Timeline）与 SOUND（SoundEngine/PatternGenerator/audioAssert/checkLevel）。
  CORE 名下 9 文件 `npx eslint` 干净。影响：verify:all 暂不含 lint 所以门禁不红，R2 一旦纳入就会被这 4 行卡住。
CORE 自评未完成：① BeatClock.driftMs() 只有 Node 侧口径验证，浏览器真机 ≤2ms 未测（R2 用 ?selftest 补）；
  ② C7 的 hp/state 两类事件尚无生产者（等 K-07 DisassembleSystem 与 K-05 场景接线）；
  ③ 「真实谱面跑一遍」目前是一次性命令，尚未固化成 contractTest 的 integration case。
CR-08 / CR-09（CORE 提出，涉及 C1/C2/C4/C7）结论行仍空，WORLD/SOUND 需在下一集成窗口前回复，否则按 T21 记冲突。
```

## 下一轮第一步
```
CORE  : 跑 `node tools/contractTest.mjs` 确认未回归，开 K-05 场景生命周期 + K-07 DisassembleSystem，
        并把 main.js/LevelScene 换成真实流程（?selftest= 路由要在此轮落地）
WORLD : 跑 `node tools/screenshotCheck.mjs`，开 W-03 Player + W-06 对齐虚线 + W-07 拆解演出
SOUND : 跑 `node tools/checkLevel.mjs --all` + `node tools/audioAssert.mjs --all`（现已双绿，先确认未回归），开 S-09 L3 谱面
        （chiptune，bed 非空）+ S-08 Sfx；`?selftest=audio` 浏览器链路要等 CORE 在 main.js 接 SoundEngine（CR-11）
```

## Decisions
```
见 .agent/PLAN.md 的 L-01…L-10（leader 代人类拍板，agent 不得分叉）
```

## CONFLICTS（T21）
```
（无）
```

## CR 待回复
```
CR-10（SOUND→WORLD/CORE）：C5 追加 noteEvents.bed、tracks.bed{disassemble:false}、tracks[].voice、style/densityNote/mapping；
  并告知已按 CR-09 删除实例内 pxPerSec/beatWidthSec，bed 横坐标请用 arrivalSpacing(...).widthSec × physics.pxPerSec。
CR-11（SOUND→CORE）：C6 的 tempoCue() 签名改为 tempoCue(atSec:number, secondAtSec?)（无参 = bug：warn 一次返回 false）；
  SoundEngine.js 补进 C9 所有权矩阵；CORE 需接三处（每帧 ensureRunning / 首次手势 unlockOnFirstGesture / 关卡起 loadLevel+arm）。
CR-08 / CR-09（CORE 提出）：SOUND 侧已按批复落地（见上），结论行仍空，请 CORE/WORLD 补填 APPROVE。
  → WORLD 侧已补：CR-08/CR-09 结论行已填 + CONTRACTS 末尾「WORLD 批复」段（含 CR-10 arrivalSpacing 满足、CR-12 lengthBeats 够用）。
CR-13（WORLD→CORE，R1 收尾新增）：CORE 名下 11 处颜色字面量（main.js / LevelScene / BootScene / TitleScene / DebugPanel，
  含第七色 #e8ecf4）请改走 theme.js 取值或 neon.css 的 --rb-* token；WORLD 无权改他人文件，screenshotCheck 目前只能记 SKIP+待CR。
  若 CORE 要保留 #e8ecf4，请说明语义角色，WORLD 登记为 --rb-inkSoft 并纳入白名单。
```
