# PLAN · Leader 编排记录（人类 leader 代行的开工决策）

> 本文件是 leader（编排者）的派工记录与决策台账。三个 agent 开工前读：
> `.agent/CONTRACTS.md`（冻结契约）→ 本文件的 `Decisions`（leader 已代人类拍板项）→ `.agent/agents/<自己的卡>.md` → `.agent/TASKBOARD.md` 里自己的卡。

## 0. 本次协作对原条约的三处适配（leader 声明）

| 原条约 | 本次适配 | 理由 |
|---|---|---|
| WORLD/SOUND 推 `agent/*` 分支，CORE 在 14:00/16:30 集成 main | **三方共享同一工作副本，只写各自独占文件；git 提交与推送由 leader 独占执行** | 三个 subagent 在同一 clone 里并发操作 git 会互相覆盖 HEAD/index；「文件所有权不相交」这条真正的不变量被完整保留，被放弃的只是分支介质 |
| CORE 有 main 写权限 | **CORE 有 `src/main.js`/`index.html`/`vite.config.js`/`package.json` 的写权限；main 分支写权限归 leader** | 同上 |
| 🚩人类验收门（D1 P0 定稿 / D3 审美门 / D5 砍单 / D7 试玩 / D9 发布） | **leader 代拍板，全部记进下方 `Decisions`，agent 不得再自行分叉** | 本次为初版自动化开发，审美门以「结构断言 + 候选并存」替代人工挑选：候选参数保留在配置里，默认值取最保守方案 |

`T20 否决权`、`T2 所有权`、`T4 时钟唯一真相`、`T5 字段只增不改`、`T12/T24 无卡不做事/不扩范围`、`T16 审美不许独断` 全部按原条约生效。

## 1. Decisions（leader 代人类拍板，agent 必须照此实现，不得各写一种）

| 编号 | 决策 | 依据 |
|---|---|---|
| L-01 | **判定窗口基准 = PERFECT ±60ms / GOOD ±110ms**；`strictWindow` 开关收紧到 ±50/±100。下限保护 PERFECT≥40 / GOOD≥80ms 不变 | PRD §12 P0-3 |
| L-02 | **音乐锁方案 C：全程序合成，仓库内零音频素材文件**（`public/` 不放任何音频） | PRD §12 P0-1（Safari 无 Ogg Vorbis） |
| L-03 | **`jumpAirBeats = 0.9`（拍长系数，不是秒）** | PRD §12 P0-2 |
| L-04 | **UI 界面层用 DOM 覆盖在 canvas 之上**（`#ui-root`），不写 Phaser 场景 | 会话结论：省工 + 白送键盘可达性 |
| L-05 | **仓库分支策略：单 `main` + tag**（`r1-contract`、`v0.1.0`），只在关卡内容上开数据差异，不开代码分支 | 会话结论 |
| L-06 | **预砍（代行 🚩D5 砍单）**：K-14 校准小游戏 → 降级为 `[` / `]` 手动微调 + 当前值显示；S-19 回放 → 只做 2× 分轨重组；W-12 假节拍 → L5 保留 ≤8 处标记但其中仅 2 处演出型故障闪烁 | 会话建议组合 |
| L-07 | **第 6 关 `windowScale` 取 0.95**（与 L5 持平），难度主要由密度表达 | PRD §7.4 建议 |
| L-08 | **色盲冗余编码为必做项**：三声部除颜色外必须有互异形状（三角 / 横条平台 / 六边形），灰度化后仍可分辨 | PRD 会话结论，成本 <0.4 人日 |
| L-09 | **渲染引擎用 Phaser 3**（PRD §1.2 技术栈），但 Phaser 只当场景/绘制容器：所有与「何时」有关的量取自 `BeatClock`，禁止 `scene.time`/`this.time.now` | C1 + T4 |
| L-10 | **初版验收标准**：`npm run build` 通过 + 四道 `check:*` 全绿 + 真实浏览器（Chrome）打开页面能从标题走到 L1 结算且 console 零报错 + 六关 JSON 全部可载入 | PRD §13.1 的自动化子集 |

## 2. 目录与所有权（与 C9 一致，leader 已建好骨架）

```
src/main.js                        CORE   Phaser 启动 + ?selftest= 路由
src/audio/BeatClock.js             CORE   ★ 时间真相
src/audio/TrackMixer.js            SOUND
src/audio/SynthVoices.js           SOUND
src/audio/Metronome.js             SOUND
src/audio/Sfx.js                   SOUND
src/audio/ReplayAssembler.js       SOUND
src/game/systems/JudgeSystem.js    CORE   ★
src/game/systems/DisassembleSystem.js CORE ★
src/game/systems/PatternGenerator.js   SOUND ★
src/game/systems/EffectSystem.js   WORLD
src/game/objects/*                 WORLD  Player/Obstacle/Spike/Platform/Barrage/Timeline/Silhouette
src/game/render/*                  WORLD  WorldLayer/Background
src/game/scenes/*                  CORE   Boot/Title/Level（LevelScene ≤250 行薄编排）
src/data/physics.js                CORE   ★ D2 冻结
src/data/config.js                 CORE   窗口基准/缩放/下限
src/data/save.js                   CORE
src/data/theme.js                  WORLD  ★ 全项目唯一取色入口
src/data/levels/level{1..6}.json   SOUND  ★ 唯一内容真相
src/ui/**                          CORE   Hud/Popup/Calibration/DebugPanel/screens/*
src/mocks/MockClock.js             CORE   供 WORLD/SOUND 离线开发
src/styles/neon.css                WORLD
tools/contractTest.mjs             CORE
tools/checkLevel.mjs               SOUND
tools/audioAssert.mjs              SOUND
tools/screenshotCheck.mjs          WORLD
tools/verifyAll.mjs                leader  聚合门禁，agent 不改
vite.config.js package.json index.html eslint.config.js   CORE（leader 初始版本）
```

**越界规则**：想改他人文件 → 在 `.agent/CONTRACTS.md` 末尾追加 CR，不许动手。

## 3. 轮次计划（本次压缩为三轮，对应原 D1–D9）

| 轮 | 目标（门） | CORE | WORLD | SOUND |
|---|---|---|---|---|
| **R1 契约与纯函数** | 三方离线可验；`check:contract` 有真断言 | K-01 K-02 K-03 + K-04 K-06 K-08 | W-01 W-02 + W-04 W-05 | S-01 S-02 S-03 + S-04 S-06 |
| **R2 闭环打通** | 第 1 关可从标题进入并通关到结算，拆解→静音→世界变安静 | K-05 K-07 K-09 K-10 K-11 | W-03 W-06 W-07 W-08 W-09 W-10 W-11 | S-05 S-07 S-08 S-09 S-10 |
| **R3 内容与流程** | 六关齐 + 界面全流程 + 构建产物可玩 | K-12 K-13 K-14 K-15 K-16 K-18 | W-12 W-13 W-14 W-16 | S-11 S-12 S-13 S-14 S-15 S-16 S-17 S-18 |
| **R4 集成验证** | leader：build 绿 + 四 check 绿 + 浏览器实跑 + 推送打 tag | — | — | — |

依赖热点（每轮先看）：C5 noteEvents 字段（11 张卡依赖）→ R1 内冻结；K-07 DisassembleSystem（6 张卡依赖）→ CORE 在 R2 优先交付 stub；K-04 physics（6 张卡依赖）→ R1 结束必须定稿。
