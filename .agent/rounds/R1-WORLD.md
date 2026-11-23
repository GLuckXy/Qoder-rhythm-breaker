# R1-WORLD · 收工报告（WORLD agent，R1 收尾 + R2 部分交付）

> 接手前任（工具额度耗尽中断）的收尾。策略：**先读懂并复用已落盘的 theme.js / WorldLayer / Background / Obstacle / Spike / Timeline，
> 只补缺口**；补齐 leader 的硬任务 1（`tools/screenshotCheck.mjs`）与 2（`src/styles/neon.css`），
> 并顺手推进任务 3 的三张渲染卡（Platform / Barrage / Player）。
> 未跑任何 git 命令，未 `npm install`，未改 package.json / index.html / vite.config.js / src/main.js / tools/verifyAll.mjs / src/audio/** / src/data/levels/**。

---

## 1 · 卡片完成情况

| 卡 | 状态 | 落点 | 自检 id |
|---|---|---|---|
| W-01 | 前任已交付，本轮**修 2 处真缺陷** | `src/data/theme.js`（速率精度、视差上限） | `render:zones` / `render:quality` / `render:physics` |
| W-02 | **本轮新增（前任完全没写）** | `tools/screenshotCheck.mjs` | 全部 17 组 |
| W-04 | 前任已交付，本轮验证为完整 | `src/game/objects/Obstacle.js`、`Spike.js` | `render:obstaclePos` / `render:chart` |
| W-05 | 前任已交付，本轮修 snapshot 的 bed 泄漏 | `src/game/objects/Timeline.js` | `render:grayscale` / `render:chart` |
| W-06 | 部分（v0） | `Timeline.alignDashAlpha/flashAlign` 已有，本轮补断言 | `render:grayscale` 两条 |
| W-09 | **本轮新增** | `src/game/objects/Platform.js` | `render:tierReach`（16 条） |
| W-10 | **本轮新增** | `src/game/objects/Barrage.js` | `render:gap`（41 条） |
| W-03 | **本轮新增** | `src/game/objects/Player.js` + WorldLayer 挂接 | `render:jumparc`（13 条）+ `render:judgeX` |
| W-07/W-08 | **未做**（EffectSystem 缺席，门禁该组 SKIP 并点名） | — | `render:fx` |
| neon.css（W-01 附属） | **本轮重写** | `src/styles/neon.css` | `render:colors`（token 逐值比对） |

---

## 2 · `tools/screenshotCheck.mjs` 实际输出（真跑，非描述）

```
$ node tools/screenshotCheck.mjs
RESULT: PASS 判定线Δ0px(≤1) 角色x=576=judgeX=0.30W 4拍=883.2px（六 BPM 全等） pxPerBeatΔ0
灰度 kick:101 bass:213 synth:161；最小对 bass/synth Δ52 上下层逐实例Δ0px 真谱面 L2:21条/Δ0px
0/0命中·17文件 theme=11 css=24 WORLD越界=0 待CR=11 CSS 54 个 var 分区 86.4/648/345.6px
quiet档·burst=12·bloom=0·parallax=2（候选 quiet/standard/vivid） 305通过/0失败/3SKIP

$ node tools/verifyAll.mjs render
[OK  ] render    （同上那行）
verify:all -> 1/1 PASS, 0 SKIP, 0 FAIL

$ node tools/verifyAll.mjs
[OK  ] contract  306/306 断言 · 7/7 case · 0 skip · 45ms
[OK  ] level     6关 障碍409 核心114 …
[OK  ] audio     6关 事件757 …
[OK  ] render    …
verify:all -> 4/4 PASS, 0 SKIP, 0 FAIL

$ npx eslint <WORLD 9 个文件>   → 0 error 0 warning（exit=0）
```

分组明细（`--verbose`）：zones 35✓ / judgeX 22✓ / pxPerBeat 23✓ / lead4 32✓ / grayscale 27✓ / obstaclePos 26✓ /
chart 14✓ / scan 3✓ / colors 7✓+1SKIP / quality 12✓ / bg 17✓ / physics 17✓ / tierReach 16✓ / gap 41✓ / jumparc 13✓ /
fx SKIP / selftest SKIP（未带负载）。合计 **305 通过 / 0 失败 / 3 SKIP**。

### 2.1 leader 点名的每条断言在哪

| 要求 | 断言名（组） | 实测 |
|---|---|---|
| 判定线上下层同 x（<1px） | `上下层绘制判定线偏差 < 1px`（judgeX）——从**录制 Graphics 的 lineBetween** 量，不是读常量 | Δ=0px |
| 角色固定 x = 判定线 x = 0.30W | `判定线单一真相（10 个读取点）`（judgeX）+ `Player.fixedX === judgeX` | 576.00 = 0.30×1920，10 点离散度 0 |
| 上下层同一 pxPerBeat | `pxPerBeat 单一真相（7 个读取点）`（pxPerBeat）+ 五档视口逐项 | Δ=0；0.115W=220.80 |
| 4 拍预告 = judgeX 侧 4×pxPerBeat | `4 拍像素距离单一真相（判定线右侧）`（lead4，7 个来源） | 883.20px，含 physics.lookAheadPx / worldWindow 宽 / windowRightX |
| 110/120/126/132BPM 一致（按拍不按秒） | `六档 BPM 的 leadPx 全等` + 每档 `4 拍前恰在出生线`（用 CORE 的 MockClock） | 六档（含 128/140）leadPx 全等 883.20；到线误差 ≤0.5px |
| 变速关也按拍 | `变速中·相邻拍像素差=pxPerBeat`（L4 口径 120→140@64，过渡 2 拍） | Δ≤0.05px；同点秒域公式偏 71.9px≈0.33 拍（已量化，证明必须拍域） |
| 三声部灰度可辨（L-08） | `灰度Δ(kick,bass)=112 / Δ(kick,synth)=60 / Δ(bass,synth)=52 ≥ 40`（grayscale，用 theme.LUMA_BY_TRACK） | 门限 `GRAY_CONTRAST_MIN=40` |
| 反证（明度通道是承重的） | `反证：裸声部色灰度差 < 门限` | 裸色最小差 16 < 40 → 不加明度通道红/品红会撞 |
| 形状/色相两通道 | `形状顶点数互异`（3/4/6）、`形状面积两两相差>10%`、`色相漂移≤2°`、`三声部色相间隔≥10°` | 面积 1620/7200/12990px²；漂移 ≤0.2° |
| 分区比 8/60/32 → 1080p 像素 | `1080p·HUD=86.4 / 世界=648 / 时间轴=345.6 / 世界带底=734.4` + 绘制证据 `分区分隔线已画@y` | 全部相等，5 档视口复算 |
| 位置是时间的纯函数 | `x 随 nowSec 严格单调递减`（241 点）、`dx/dt ≡ -pxPerSec`、三条公式一致、`乱序采样逐点全等`、`掉帧跳走再跳回 → x 复现`、`多次 update 后仍与公式一致` | 最大偏差 1e-9px 级 |
| 源码扫描 0 处 scene.time/this.time.*/积分 | `WORLD 名下 src/game/** 禁用形式 = 0 处`（17 文件 × 7 探测器，**剥注释/字符串/正则**后才匹配） | 命中 0；他人文件 0 |
| 探测器不空转 | `scan:selftest 探测器有效`（14 条植入违规 + 5 条好例不许误报）+ `扫描器对正则/注释行线性且必然终止`（960 行 <2s） | 14/14 抓到，0 误报 |
| 颜色字面量 theme.js 外 0 处 | `WORLD 名下颜色字面量 = 0 处` + `neon.css 的每个色值都等于 theme 派生值` | theme 内 11 处（唯一入口），css 24 处全部同源；**他人文件 11 处 → CR-13** |
| 最后一行 RESULT + `--json` | `--json` 可被 `JSON.parse`（已用 Node 校验），RESULT 恒为最后一行 | status=PASS，groups=17 |
| 预留浏览器入口 | `--selftest <file|inline-json|->`，schema `world-selftest/v1`；已用 Node 伪造负载实跑 11 条断言 | 判定线偏差/逐实例 x/灰度采样全部实测通过 |

### 2.2 门禁抓到的三个真缺陷（都是前任遗留，非本轮新增代码）

1. **上层世界画不出任何障碍（阻断级）**。`WorldLayer._reconcile` 用私有 `laneOf(inst)`（`id.split('-')[0..1]` → `lv01-kick`）
   与包裹对象的 `Obstacle.laneKeyOf(inst)`（`1-kick`）比较，两者永不相等 → 每个新实例都被「跨泳道冲突」保护 `continue` 掉。
   SOUND 的真实 id 正是 `lv01-kick-001` 格式，所以只要接真谱面，上层就是空画面。复现证据：
   `wraps.size=0 / visible=0 / drawn=0`（修复前），修复后 `render:chart` 14 条断言全绿、L1/L2 逐实例 x 偏差 0px。
   → 改法：WorldLayer 只准用 `laneKeyOf` 这一份口径（已加注释说明为什么不能自算）。
2. **`pxPerSec` 与 `pxPerBeat/beatSec` 不同值**。`buildView` 把 `beatSec` 也 `r2` 舍入到 2 位 → 110BPM 下 404.80 vs 401.45（0.8%），
   秒域回退公式在 4 拍窗上会偏出 1px 级。→ 速率量改用 `r6`（像素量仍 `r2`）。
3. **`QUALITY_CAPS.parallaxLayersMax = 4` 与层表 3 条不一致**：降级开关把 `parallaxLayers` 设到 4 时 `layerGeometry(view,3)` 会抛
   `no such parallax layer`。→ 上限对齐为 3（`activeLayerCount` 本来就夹到层表长度，行为不变）。

另外主动收掉的一处「两套数」：`Obstacle.worldYFor('bass')` 原先自己插值一条「跳跃带」y，与 CORE `physics.platformTopY` 的
0.10/0.16/0.21H 是两套值 → W-09 一接真档就会分叉。现改为直接取 `VIEW_RATIOS.platformTiers`（与 `FROZEN` 同值，由
`render:physics` 锁死），并证明三档都落在跳跃可达包络内（`render:tierReach` 16 条，含 `physics.selfTest()` 无 error）。

---

## 3 · `src/styles/neon.css`（CSS token 层）

`theme.cssTokens()` 是唯一定义处，neon.css 逐值镜像；`render:colors` 会双向检查（缺 token / 自造未登记 token / 值不一致都会红）。

**CORE 的 `#ui-root` 可引用的变量名（54 个）**

- 色板：`--rb-base` `--rb-kick` `--rb-bass` `--rb-synth` `--rb-system` `--rb-white`
- 派生（base↔white 消色差轴）：`--rb-bandTimeline` `--rb-bandHud` `--rb-divider` `--rb-parallaxFar` `--rb-parallaxMid`
  `--rb-parallaxNear` `--rb-beatTick` `--rb-barLine` `--rb-ground` `--rb-dim`
- 声部三通道：`--rb-track-{kick,bass,synth}`、`--rb-marker-{kick,bass,synth}`（明度通道后的实际填充色）、
  `--rb-shape-{kick,bass,synth}`（值 = `triangle` / `platformBar` / `hexagon`）
- 分区比：`--rb-zone-hud`(0.08) `--rb-zone-world`(0.6) `--rb-zone-timeline`(0.32)
- 画面比例：`--rb-ratio-judgeX`(0.3) `--rb-ratio-groundY`(0.52) `--rb-ratio-pxPerBeat`(0.115) `--rb-ratio-dashDist`(0.12)
  `--rb-ratio-jumpPeakH`(0.2) `--rb-ratio-jumpAirBeats`(0.9) `--rb-ratio-dashDurBeats`(0.35) `--rb-ratio-charH`(0.075)
  `--rb-ratio-platformTiers`("0.1 0.16 0.21")
- 字号阶（@1080p，最小 20px）：`--rb-font-display`(104) `--rb-font-title`(56) `--rb-font-hud`(30) `--rb-font-sub`(24)
  `--rb-font-body`(22) `--rb-font-caption`(20) `--rb-font-debug`(20) `--rb-font-family`
- 演出档：`--rb-particles-per-burst`(12) `--rb-particles-live-max`(80) `--rb-bloom-intensity`(0) `--rb-quality`(quiet)
- 已登记别名：`--rb-bg`(=`--rb-base`) `--rb-ink`(=`--rb-white`) `--rb-hairline`(=`--rb-divider`)
  `--rb-panel`(=`--rb-bandHud`) `--rb-panel-strong`(=`--rb-bandTimeline`)

除 token 外只提供：三个挂载点的层序（`#game-root` z0 / `#ui-root` `#debug-root` z2 + `pointer-events:none` 基线，
交互控件白名单打开）、`.rb-band-hud/.rb-band-world/.rb-band-timeline/.rb-judge-column`（按 `--rb-zone-*` 与
`--rb-ratio-judgeX` 算，DOM 与画布同带）、`.rb-text-*` 字号阶、`.rb-chip[data-track]`（clip-path 三形状 → 灰度也可辨）、
`.rb-hp`、`:focus-visible` 焦点环、`.rb-panel`（用 `color-mix` 而不是 rgba 字面量）、`prefers-reduced-motion`。

---

## 4 · R2 渲染卡做到哪一步

- **W-09 `Platform.js`**：完成。`PLATFORM_TIERS` 引用 theme→physics 同值；`tierTopY(view,tier)` 与 `physics.platformTopY` Δ≤0.6px；
  `platformGlyphSize = 板宽/3`（platformBar 多边形宽 3s、高 0.6s → 恰为 120×24@1080p）；`coreLandingX(view) === judgeX`；
  `reachEnvelope`（peak 0.20H + 半身高 = 162px ≥ 最高档 226.8px? 不 —— 见 §5 的诚实说明）；`netClearancePx(view,0)=84px`
  容得下 81px 的站立体（`tierClearanceMinChars` 从 1.5 改 1.0 的理由写在 theme 注释里：1.5 与 C8 冻结的 0.10H 直接矛盾）。
- **W-10 `Barrage.js`**：完成。`gapMinPx = 2.2×角色高`（与 `AUX.barrageGapRatio` 同口径，断言 Δ≤0.5px）；
  `netGeometry(view,{dur,rows})` 纯函数：行距 ≥ 门限、核心 56px ≤ 最小间隙、**带底高过站立角色头顶**、孔位间距 = 1 拍；
  `speedForDur` 与 SOUND `durToSpeed` 在 dur=0.25/0.5/1/2/4 上**逐值相等**（不另立映射）；CR-07 的 `lane` 字段**不作为依据**（未 APPROVE），缺省落基准行。
- **W-03 `Player.js`**：完成。`fixedX(view) === view.judgeX`；跳跃高度用 CORE 冻结式（v0=4h/T、g=8h/T²），
  顶点 = jumpPeakH 且落在滞空中点、首尾恒 0、132BPM 下峰值像素不变；冲刺表现位移首尾为 0（角色不漂出判定线），
  中点 = dashDist(0.12W)；微调三档候选（`MICRO_CANDIDATES`）；受击只改表现态与 `invuln` 读数（无敌帧长度读 `FROZEN.invulnSec`）。
  `WorldLayer` 已挂：`CLASS_BY_TYPE` 补 platform/barrage，`applyAction(extra.action, nowSec, view)` 驱动 Player，`snapshot()` 带 `player`。

**未做（如实）**：W-07 `EffectSystem.js`（碎裂/降饱和/大字同帧的三要素只有 Obstacle 侧的 `fx` 标志与 WorldLayer 的 `g.fx` 图层入口，**没有生产者**）；
W-08 复活表现只在 `applyRevived` 点亮 `fx.revived`，无演出；W-06 对齐虚线只有 alpha 纯函数，未接 `flashAlign` 调用点；
CR-10 批复的 bed 层（用 `arrivalSpacing(...).widthSec × physics.pxPerSec` 画进时间轴带）未做；浏览器 `?selftest=render` 端点本身归 CORE 的 K-05/main 路由。

---

## 5 · 交给 leader 的两类事项

**(a) T16 审美候选（默认已取最保守档，请代人类挑）**

| 档 | burst | live | bloom(intensity/layers) | 视差 | 顿帧 | 大字驻留 | 说明 |
|---|---|---|---|---|---|---|---|
| `quiet`（默认） | 12 | 80 | 0 / 0 | 2 | 0 | 1.0 拍 | 不需要实测帧率就能发 |
| `standard` | 22 | 150 | 0.3 / 1 | 3 | 0.04 拍 | 1.25 拍 | PRD §15.2 的 22 粒口径 |
| `vivid` | 34 | 260 | 0.55 / 2 | 3 | 0.07 拍 | 1.5 拍 | `flashReductionSafe:false`，需 D9 帧率证据 |

另有两组：`MARKER_TONE_MODES`（`luma` 默认 / `voice` 只靠形状）、`MICRO_CANDIDATES`（轻点 / 明显 / 夸张）。
切换入口：`theme.setQuality('standard'|'vivid'|null)`，分区与 pxPerBeat 三档完全不动（`render:quality` 有断言）。

**(b) CR**

- **新提 CR-13（WORLD→CORE）**：CORE 名下 11 处颜色字面量（`src/main.js`、`scenes/LevelScene.js`、`BootScene.js`、`TitleScene.js`、
  `ui/DebugPanel.js`）改走 theme 取值或 `--rb-*`；其中 `#e8ecf4` 是 C8 六色板之外的**第七色**。
  WORLD 不改他人文件，所以门禁对它只记 SKIP + 待 CR（`待CR=11` 就在这个数字上）。
- **已批复**：CR-08（结论行填 APPROVE，含「反对 BPM 线性」的理由与实测数字）、CR-09（判据唯一化 = `judgable`，
  `pxPerSec/beatWidthSec` 不该进实例）；CONTRACTS 末尾新增「WORLD 批复」段回答 CR-10 的 `arrivalSpacing`（满足）
  与 CR-12 的 `lengthBeats`（够用且必须是拍数）。CR-07 在 CONTRACTS 里仍只是模板示例，未立案，故 `Barrage` 不把 `lane` 当依据。

**需要 leader 过目的两处几何余量（实测，@1920×1080）**

- 三档平台都可达：可达包络 = `jumpPeakH + charH/2 = 216 + 40.5 = 256.5px`，三档上升量 108 / 172.8 / 226.8px，
  余量 148.5 / 83.7 / **29.7px**（`render:tierReach` 与 `physics.selfTest()` 双重断言，errors=0）。高档不紧，但也还有余量。
- 真正紧的是**低档板下方的通行净空**：板顶 453.6、板底 477.6、地面线 561.6 → 下方只剩 **84px**，
  而角色高 81px，余量 3px。所以 `BACKGROUND_CFG.tierClearanceMinChars` 只能取 1.0（前任写的 1.5 与 C8 冻结的 0.10H 直接矛盾，
  会让 W-09 自检恒红，理由已写进 theme.js 注释）。若 R3 想让玩家「站在低档板上再跳」更从容，需要与 CORE 一起动
  `platformTiers`（C8 冻结项，WORLD 有 T20 否决权但会打断 SOUND 已验收的六关谱面 → 走 CR 而不是直接改）。
- 弹幕网：2 行、行距 178.2px（= 2.2×81 恰为门限）、核心 56px、带底 411.4 高过站立角色头顶 480.6 ✓、
  带顶 177.2 在世界带顶 86.4 之下 ✓（`render:gap` 41 条）。**行数受世界带高度约束**：以 2.2× 身高做行距，
  世界带只容得下 2 行（第 3 行会顶进 HUD 带），所以 `NET_ROWS_DEFAULT = 2`；想要三行网必须先谈行距或带高（CR）。

---

## 6 · CORE 在 R2 接 LevelScene 时，调用 WorldLayer 的确切签名

```js
import WorldLayer from './game/render/WorldLayer.js';   // 默认导出 = WorldLayer 类
const world = new WorldLayer(opts?);       // opts 可含 { background, player:false }（player:false = CORE 自绘角色）

world.init(scene, view?);                  // scene.create() 调一次；scene 只需提供 add.graphics()
world.sync(frame, extra?);                 // 每帧一次，返回 frameStats（可直接喂 DebugPanel）
//   frame = { clock,                       // clock 或裸秒数都吃（readNowSec 兼容 BeatClock/MockClock/number）
//             instances,                   // C4 数组原样传入；bed/不可判定由 WORLD 内部按 judgable 过滤
//             view }                       // theme.buildView(w,h,{timeToBeat,beatToTime,beatSec}) 的产物
//   extra = { judgment,                    // C2 Judgment 原样转发（空拍靠 obstacleId:null 天然 no-op）
//             disassembledTracks:[track],  // C3 'disassemble'
//             revivedIds:[id],             // C3 'revive' 后的新实例 id
//             hpByTrack:{kick,bass,synth}, // C3 'hp-change' 汇总 → 远景变安静（VIS-06）
//             action:{kind,atSec},         // ★ W-03：kind='jump'|'dash'|'fine'|'hit'|'reset'，atSec 绝对秒
//             combo,                       // 连击数（W-07 金边用，现在不消费也不报错）
//             view }
world.shutdown();                          // K-05 teardown：销毁 4 个 Graphics（bg/obstacles/player/fx）、清空挂接

// 事件驱动（不是每帧）：
world.applyJudgment(judgment, nowSec?) -> boolean;
world.applyAction({kind,atSec}, nowSec, view?) -> boolean;   // sync 的 extra.action 已代调，一般不用直接调
world.markTrackDisassembled(track) -> id[];
world.applyRevived(ids) -> id[];

// 查询/自检：
world.snapshot(clockOrNowSec) -> { version, view:{judgeX,groundY,pxPerBeat,pxPerSec,rightSpawnX,timelineTop,width,height},
                                   player:{x,baseX,y,lift,lean,state,fixedX,size}, nowSec, items:[{id,track,shape,state,core,x,y,beatsToJudge}],
                                   layers:[{name,factor,traces}], stats }
world.live() / world.get(id) / world.worldYOf(trackOrInstance, view?) / world.ready
```

`view` 必须由 `theme.buildView(W, H, { timeToBeat: t => clock.beatAt(t), beatToTime: b => clock.timeAtBeat(b), beatSec: clock.beatLengthSec(0) })`
生成（变速关要拍↔秒换算挂进 view，否则 WORLD 会退回等速除法）。`?selftest=render` 端点请回传
`{ schema:'world-selftest/v1', nowSec, viewport:{width,height}, dpr, world: world.snapshot(clock), timeline: new Timeline().snapshot({view,nowSec,instances}), pixels:[{track,luma}] }`，
`node tools/screenshotCheck.mjs --selftest <file>` 就能把浏览器实测折回同一套断言。
