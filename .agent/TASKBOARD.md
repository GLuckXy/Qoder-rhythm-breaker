# TASKBOARD · 58 张任务卡

> **放置位置：仓库根目录 `.agent/TASKBOARD.md`。** 这是三个 agent 唯一的工作指令来源——没有卡就没有工作（T12/T24）。
> 状态字段：`ready`（可派）→ `active`（本轮进行中）→ `review`（已 verify，等 CORE 集成）→ `done` / `rework`（缺陷退回）/ `cut`（被砍）/ `blocked`（写 `blocked-by: CR-xx`）。
> 每轮每 agent 最多 3 张 `active`。派卡时五要素齐全（卡号 / 依赖 / writes / reads / verify），缺 verify 不许派（§7.1）。

**verify 命令简写**

| 简写 | 实际命令 | 归属 |
|---|---|---|
| `contract:<case>` | `node tools/contractTest.mjs --case <case>` | CORE |
| `level:<scope>` | `node tools/checkLevel.mjs --all \| --lv <N>` | SOUND |
| `audio:<scope>` | `node tools/audioAssert.mjs --<scope>`（纯函数侧在 Node 跑；需浏览器的读 `?selftest=audio`） | SOUND |
| `render:<scope>` | `node tools/screenshotCheck.mjs --<scope>`（无浏览器自动化时读 `?selftest=render` 的 JSON） | WORLD |
| `build` | `npm run build && npx serve dist` 可访问 | CORE |
| `🚩<名>` | 人类验收：审美门 / 试玩 / 矩阵实测，结果写进 STATE.md 的 Decisions | 人类 |

---

## D1 · 契约日（门：三 agent 均能离线开工）

| 卡 | 内容 | 依赖 | writes | verify | 状态 |
|---|---|---|---|---|---|
| K-01 | BeatClock：`timeAtBeat/beatAt` 变速分段积分、25ms 预调度、`pause/resume` 原点重算 + `MockClock` | — | audio/BeatClock.js, mocks/MockClock.js | `contract:clock` | ready |
| K-02 | JudgeSystem：三档窗口+缩放+下限、队列匹配、空拍优先级（rule 字段）、超时 MISS 回调 | K-01 | systems/JudgeSystem.js, data/config.js | `contract:judge` | ready |
| K-03 | DebugPanel（拍/now/队列/窗口/drift）+ contractTest 脚手架 + 事件流导出按钮 | K-01 | ui/DebugPanel.js, tools/contractTest.mjs | `build` + `🚩漂移截图` | ready |
| W-01 | `theme.js` 全量落地 + 分区常量 + 静止帧上层世界骨架（地面线/视差/判定线） | CONTRACTS C8 | data/theme.js, render/WorldLayer.js, render/Background.js | `render:zones` | ready |
| W-02 | `?selftest=render` 端点（判定线 x、上下层偏差、分区比、灰度可辨）+ 断言脚本 | W-01 | tools/screenshotCheck.mjs, render/WorldLayer.js | `render:selftest` | ready |
| S-01 | TrackMixer + gain 斜坡（0.1/0.15s，禁瞬时）+ `buildSchedule` 纯函数 + `audioAssert` | — | audio/TrackMixer.js, tools/audioAssert.mjs | `audio:envelope` | ready |
| S-02 | 三音色程序合成初版 + 6 曲风 preset 骨架 + 节拍器轨 | S-01 | audio/SynthVoices.js, audio/Metronome.js | `audio:voices` + `🚩候选3套` | ready |
| S-03 | noteEvents 字段扩展申请（CR-01）+ `level1/2.json` 草案（各 16 拍，够 D2 用） | CONTRACTS C5 | data/levels/level1.json, level2.json | `level:draft-parse` | ready |

🚩 **D1 人类必须做的两件事**：① 逐条定稿 PRD §12 的 5 个 P0 与 Q1–Q3（三 agent 无法自行裁决窗口基准 ±50 还是 ±60，只会各写一种）；② 把 CONTRACTS/TASKBOARD/STATE 三份文件放进 `.agent/`。

---

## D2 · 打通链路（门：第 1 关可玩，PERFECT 打得出来）

| 卡 | 内容 | 依赖 | writes | verify | 状态 |
|---|---|---|---|---|---|
| K-04 | `physics.js` 冻结（含 `jumpAirBeats=0.9`）+ 跳跃可达包络可视化开关 | K-01 | data/physics.js, ui/DebugPanel.js | `contract:physics` | ready |
| K-05 | 场景生命周期 + 统一 `shutdown()`（interval/音源/监听全登记）+ R 重开路径 | K-01 | scenes/LevelScene.js, scenes/BootScene.js | `contract:teardown` | ready |
| K-06 | 事件流格式落地（judge/hp/input/state）与导出 | K-02 | systems/JudgeSystem.js | `contract:eventlog` | ready |
| W-03 | Player：自动奔跑、固定高度跳（滞空按拍）、冲刺（0.35 拍+无敌）、微调、受击表现 | K-04, W-01 | objects/Player.js | `render:jumparc` | ready |
| W-04 | Obstacle 基类（时间纯函数定位 + 生命周期状态机）+ Spike 完整链路 | K-01, C4 | objects/Obstacle.js, objects/Spike.js | `render:obstaclePos` | ready |
| W-05 | Timeline：4 拍可见窗、标记流动、三声部形状编码、变速按拍等距预留 | W-01 | objects/Timeline.js | `render:grayscale` | ready |
| W-06 | 上下层对齐虚线 v0 + 判定线同 x 校验 | W-04, W-05 | objects/Timeline.js | `render:judgeX` | ready |
| S-04 | PatternGenerator v1（kick→spike，含 `core`/`pitchTier`）+ `checkLevel` v1 | S-03, K-01 | systems/PatternGenerator.js, tools/checkLevel.mjs | `level:lv1` | ready |
| S-05 | L1 谱面与编曲（128 拍，前 16 拍每 2 拍一根桩，核心节点 4 个前置） | S-04 | data/levels/level1.json | `level:lv1` | ready |
| S-06 | 休止符 → 显式喘息区生成 + 喘息表输出 | S-04 | systems/PatternGenerator.js, tools/checkLevel.mjs | `level:breathe` | ready |

---

## D3 · 拆解闭环（门：踩碎 4 桩 → 鼓消失 → 世界变安静。🚩审美门 1 = 音色冻结）

| 卡 | 内容 | 依赖 | writes | verify | 状态 |
|---|---|---|---|---|---|
| K-07 | DisassembleSystem：hp、核心+动作校验才扣、**复活选择（并列/全满）**、状态机迁移与非法迁移报错 | K-02, K-06 | systems/DisassembleSystem.js | `contract:revive-tie` | ready |
| K-08 | Save：schema v1 + 字段级合并 + 损坏/隐私模式降级 + 节流写入 | — | data/save.js | `contract:save` | ready |
| W-07 | 拆解演出 v1：在场障碍全屏碎裂 + 降饱和 0.3s + 大字标题，三要素同帧 | K-07 | systems/EffectSystem.js, objects/Obstacle.js | `render:disassemble` + `🚩15s GIF` | ready |
| W-08 | 复活表现：该类障碍自当前拍后恢复、不补发、hp 显示回 1 | K-07 | systems/EffectSystem.js, objects/*.js | `render:revive` | ready |
| S-07 | 段落进入（`sections.layers`）+ 静音/复活音频侧接线 + 拆解后响度层次 | K-07 | audio/TrackMixer.js | `audio:sections` | ready |
| S-08 | Sfx 全套 v1：PERFECT/GOOD/MISS/碎裂/复活/UI/变速提示/终点踩灭 | S-01 | audio/Sfx.js | `audio:sfx` | active·rework·派 CORE/SOUND |
| S-09 | L2 谱面与编曲（鼓+贝斯，音高→三档平台） | S-04 | data/levels/level2.json | `level:lv2` | ready |

---

## D4 · 三障碍齐（门：三类各 1 关可通关；同拍不跨类；灰度可辨）

| 卡 | 内容 | 依赖 | writes | verify | 状态 |
|---|---|---|---|---|---|
| K-09 | 动作类型校验（JDG-07：错动作按 GOOD 不涨不扣）+ 同拍单输入消费 | K-02, W-09/10 | systems/JudgeSystem.js | `contract:actiontype` | ready |
| K-10 | 契约回归：变速下 `timeSec === timeAtBeat(beat)`、事件流字段完整、重复符号检查 | K-04, K-06 | tools/contractTest.mjs | `contract:all` | ready |
| W-09 | Platform：三档高度（0.10/0.16/0.21H）+ 核心落点判定 + 包络可达验证 | K-04, W-03 | objects/Platform.js | `render:tierReach` | ready |
| W-10 | Barrage：弹幕网生成、间隙 ≥2.2× 角色高、冲刺穿越判定、时值→速度 | W-03 | objects/Barrage.js | `render:gap` | ready |
| W-11 | 核心节点视觉辨识（描边/高亮 + 非核心不给 hp 的视觉表达） | W-04 | objects/Obstacle.js, objects/*.js | `render:coreMark` + `🚩能指出核心` | ready |
| S-10 | `checkLevel` 补核心节点数 ≥12、同拍跨类、时长 60–90s 断言 + L1–L3 全绿报告 | S-04 | tools/checkLevel.mjs | `level:--all` | ready |
| S-11 | L3 谱面与编曲（三声部，**弹幕只出现在冲刺拍**） | S-10 | data/levels/level3.json | `level:lv3` | ready |
| S-12 | 分关 `style` 视觉参数包（曲风→色温/脉冲幅度/视差密度）→ CR 交 WORLD 落地 | S-09 | data/levels/*.json | `level:style` + `CR→W-14` | ready |

---

## D5 · 内容量产（门：6 关全部可从选关进入并通关。🚩砍单决策点）

| 卡 | 内容 | 依赖 | writes | verify | 状态 |
|---|---|---|---|---|---|
| K-11 | 寂静段（光点逐拍踩灭）+ 终点演出 + `SILENCE` 段内 MISS 不复活 + `DISASSEMBLED→PEAK` 世界重建 | K-07 | systems/DisassembleSystem.js, scenes/LevelScene.js | `contract:silence` | ready |
| K-12 | L6 `freeOrder`：三声部核心同时常驻可交互，顺序不影响段落进入 | K-07 | systems/DisassembleSystem.js | `contract:freeorder` | ready |
| W-12 | 变速下时间轴按拍等距 + 假节拍渲染层（偏移标记 + 故障闪烁，**不污染判定与音频**） | W-05 | objects/Timeline.js | `render:ghost` | ready |
| W-13 | 教学浮层渲染（前 8 拍 3 步、可跳过、不遮挡判定线） | W-01 | render/OverlayLayer.js | `render:overlay` + `🚩20 拍内首次 PERFECT` | active·派 WORLD |
| S-13 | L4 变速谱面与编曲（`tempoChanges` 120→140，2 拍过渡提示，密度 2.5） | S-10 | data/levels/level4.json | `level:lv4` + `contract:tempo` | ready |
| S-14 | L5 谱面与编曲（Glitch，`ghostBeats` ≤8 处且不落核心拍） | S-10 | data/levels/level5.json | `level:lv5` | ready |
| S-15 | L6 谱面与编曲（完整编曲，密度 3.0，单声部核心 ≥6 个容错） | S-10 | data/levels/level6.json | `level:lv6` | ready |
| S-16 | 六关全量自检 + 密度/时长/核心数汇总表 + 试玩者预约提醒（→ STATE `human-actions`） | S-13/14/15 | tools/checkLevel.mjs | `level:--all` | ready |

🚩 **D5 人类执行**：① 砍单（建议预砍 K-14 校准小游戏 → 降级为 `[ ]` 微调；S-19 回放完整版 → 2× 分轨重组），agent 无此权限（T20）；② 发出 D7 试玩者邀约。

---

## D6 · 流程闭环（门：打开页面 → 通关 L6 无断点，console 零报错）

| 卡 | 内容 | 依赖 | writes | verify | 状态 |
|---|---|---|---|---|---|
| K-13 | 五界面：标题（点击 = AudioContext resume）/ 选关（徽章 + Perfect 率）/ 暂停（调 `clock.pause`）/ 设置 / 结算 | K-05, K-08 | ui/screens/*.js | `build` + `render:screens` + `🚩T11` | ready |
| K-14 | 校准（小游戏取中位数，或降级版仅 `[ ]` 微调 + 当前值显示）+ 设置项持久化 | K-08 | ui/Calibration.js, data/config.js | `contract:latency` | active·派 CORE/SOUND·完整版 |
| K-15 | 教学触发与全流程串接 + 跳转图核对（标题→L1→…→L6→结算→下一关） | K-13 | ui/Popup.js, scenes/LevelScene.js | `🚩无断点走查` | ready |
| W-14 | 上层世界 polish：2 层视差、边缘脉冲、地面线质感、分关色温（消费 S-12 的 CR） | S-12 | render/Background.js, systems/EffectSystem.js, data/theme.js | `render:perlevel` | ready |
| S-17 | 音量三通道（主/音乐/音效）+ 六关混音终版（轨间差 ≤3dB） | S-07 | audio/TrackMixer.js | `audio:loudness` | ready |
| S-18 | 结算数据接口：从事件流产出分轨统计与拆解时刻，供 K-13 消费 | K-06 | audio/ReplayAssembler.js | `contract:eventlog` | ready |

---

## D7 · 手感日（门：不看时间轴能玩 + 说得出爽点。🚩审美门 2 = 试玩）

| 卡 | 内容 | 依赖 | writes | verify | 状态 |
|---|---|---|---|---|---|
| K-19 | 3 名试玩者事件流分析 → `deltaMs` 分布 → 判定窗口终值（**只改 `config.js`**）；归因按 T22 | K-06 | data/config.js | `contract:window-cfg` + `🚩分布报告` | ready |
| W-15 | 动效清单逐项核对（PRD §15.2）+ 顿帧/震屏/拖尾/挤压细调；缺口当场修 | K-19 | systems/EffectSystem.js, objects/Player.js | `render:motion-checklist` + `🚩视觉走查` | ready |
| S-20 | Sfx 层次打磨（拆解瞬间的音效分层）+ 试玩暴露的关密度微调（**只改 JSON**） | K-19 | audio/Sfx.js, data/levels/*.json | `level:--all` + `🚩反馈表` | ready |

---

## D8 · 表现日（门：录屏 60 秒每秒都有东西。🚩审美门 3 = 录屏评审）

| 卡 | 内容 | 依赖 | writes | verify | 状态 |
|---|---|---|---|---|---|
| K-20 | 数值终调（窗口/无敌帧/输入缓冲/物理常量复核）；main 起只收 bugfix | K-19 | data/config.js, data/physics.js | `contract:all` | ready |
| W-16 | bloom/粒子/配色终校 + 降级开关（先粒子后 bloom）+ 60s 录屏粗剪 + 5 张截图 | W-15 | systems/EffectSystem.js, data/theme.js | `render:fps` + `🚩逐秒看` | ready |
| S-19 | 回放分轨重组（默认 2× 加速版；完整版为 `🚩D5` 未砍时的备选）+ 音频录屏素材 | S-18 | audio/ReplayAssembler.js | `audio:replay` + `🚩与 hp 事件顺序一致` | ready |

---

## D9 · 上线日（门：链接发给朋友，对方无需指导即可玩）

| 卡 | 内容 | 依赖 | writes | verify | 状态 |
|---|---|---|---|---|---|
| K-16 | `vite.config` base 相对路径、构建产物本地 serve 跑通、Vercel 部署与预览链接 | K-13 | vite.config.js, package.json | `build` + `🚩线上无 404` | ready |
| K-17 | Chrome/Edge/Firefox/Safari 各跑通 1 关 + 键盘事件（空格滚页/Esc/iframe 焦点）+ 阻断修 | K-16 | CORE 域 + 缺陷卡退回 | `🚩兼容矩阵` | ready |
| K-18 | README（玩法/双时钟与谱面同源/操作/本地运行）+ known-issues + tag `v1.0.0` | 全部 | README.md | `🚩走查` | ready |
| W-17 | 渲染兼容与性能：Safari WebGL 滤镜兜底、掉帧降级路径实测、itch iframe 内画面与分区正确 | K-17 | render/*.js, systems/EffectSystem.js | `render:matrix` + `🚩` | ready |
| S-21 | Safari 音频自检（`currentTime` 单调性与自动播放）、物料音频、itch 英文文案的听觉说明 | K-17 | tools/audioAssert.mjs, 文案 | `audio:safari` + `🚩` | ready |

---

## 依赖热点（编排者每轮先看这三条）

1. **C5 noteEvents 字段** 被 11 张卡依赖（S-03/04/05/09/11/13/14/15、W-04/09/10）→ D1 必须冻结，中途任何改动会同时打断三条线（RA1）。
2. **K-07 DisassembleSystem** 被 W-07/08/11、S-07、K-11/12 依赖 → D3 那天 CORE 只能做它，别派第三张卡给它。
3. **K-04 physics.js** 被 W-03/09/10、S-05/11/15 依赖 → D2 EOD 前 WORLD 与 SOUND 都只能用包络可视化的估计值排版，D2 结束必须定稿，否则 D4 平台不可达要重排谱面。

## 砍单候选与卡的对应（人类在 D5 执行）

| 建议砍 | 卡 | 省下 | 后果 |
|---|---|---|---|
| 校准小游戏 → 仅 `[ ]` 微调 | K-14（部分） | ~0.5 | 试玩者初始手感略差，但 T22 归因仍可用 |
| 回放完整版 → 2× 分轨重组 | S-19（部分） | ~0.4 | 作品集叙事减弱，仍可展示拆解顺序 |
| L5 假节拍 → 2 处演出型标记 | W-12 + S-14（部分） | ~0.5 | 少一条差异化卖点，六关数量不变 |
| **不可砍** | K-02/07（判定与拆解）、W-07（拆解演出）、S-05/09/11/13/14/15（六关）、W-13（教学） | — | 支柱 1/3/4 与体量 |

---

## 实况状态 · R11（leader 更正，2026-11-23）

> 上面 58 行的「状态」列是 **D0 计划快照**，此后一直没回写——这是编排失误（板是三个 agent 唯一的工作指令来源，状态失真会让人误派已完成的卡）。**以本节为准**，逐轮对账，证据列全部是实跑输出，不是「agent 说做完了」。

| 轮 | 卡 | 实况 | 证据（可复跑） |
|---|---|---|---|
| D1 | K-01/02/03、W-01/02、S-01/02/03 | **done** | `contract:clock` `contract:judge` `render:zones` `render:selftest` `audio:envelope` `audio:voices` `level:draft-parse` 全绿 |
| D2 | K-04/05/06、W-03/04/05/06、S-04/05/06 | **done** | `render:judgeX` `level:lv1` `level:breathe`；L1 浏览器全流程 `state=RESULT` |
| D3 | K-07/08、W-07/08、S-07/09 | **done** | `contract:revive-tie` `contract:save` `render:disassemble` `render:revive` `audio:sections` `level:lv2`；DEF-04 把复活改为「取消退役」后 `restoredLive=3` |
| D3 | S-08 | **rework（部分）** | 8 类音效里 `revive` 已接调用点，`ui` **未接线**（README 已知限制 10）→ 本轮派给 CORE/SOUND agent |
| D4 | K-09/10、W-09/10/11、S-10/11/12 | **done** | `contract:actiontype` `contract:all` `render:tierReach` `render:gap` `render:coreMark` `level:--all` `level:lv3` `level:style` |
| D5 | K-11/12、W-12、S-13/14/15/16 | **done** | `contract:silence` `contract:freeorder`（L6 `freeOrder:true`）`render:ghost` `level:lv4/5/6`；`tempoChanges` 120→140、`ghostBeats` 在 L5 非核心拍 |
| D5 | **W-13** | **active（本轮派 WORLD）** | 我 R11 审计发现**一行都没实现**：无 `src/game/render/OverlayLayer.js`，全工程 `教学/Overlay/浮层` 只在 `LevelRuntime.js:284` 的注释里命中。D9「朋友无需指导即可玩」此前无支撑 |
| D6 | K-13、W-14、S-17/18 | **done** | 五界面齐（`src/ui/screens/` 四屏 + 结算）；`QUALITY_PRESETS` 在 `theme.js:464`；`audio:loudness` 轨间差达标；`ReplayAssembler.scaleEvents(speed=2)` + `REPLAY_SPEEDS` 白名单 |
| D6 | **K-14** | **active（本轮派 CORE/SOUND）** | 只有降级版活着（`[`/`]` + 暂停面板当前值）；`src/ui/Calibration.js` **不存在**，取中位数的小游戏没做。砍单建议属人类权限且**未批复**，故按完整版实现 |
| D6 | K-15 | **review** | 跳转图与全流程已实跑（六关 title→关→RESULT 无断点，console 错误 0）；教学触发段待 W-13 落地 |
| D7 | K-19、W-15、S-20 | **blocked** | 需 3 名真人试玩者的事件流与反馈表（`🚩审美门 2`）。需求方已明确「先出初版」，试玩不在本轮验收线 |
| D8 | K-20 | **review** | 数值经 DEF-04/05 两轮回归（`contract:all` 802 断言）；`🚩逐秒看` 的 60s 录屏未做 |
| D8 | W-16、S-19 | **blocked（半）** | 降级开关与配色终校已实现；bloom/粒子的**人眼**终校、60s 录屏粗剪、5 张截图属人类门禁 |
| D9 | K-16 | **rework→部分替代** | 提交站 = 仓库本身：`main` 与 `v0.1.0` 已推达（`ssh://git@ssh.github.com:443`，HTTPS 走代理被 407）；**Vercel/itch 部署未做**。可见性：需求方批复「改成 public」，本机无 API 令牌，需浏览器会话执行 |
| D9 | K-18 | **review** | README 已含玩法/双时钟与谱面同源/操作/本地运行/已知限制；tag 停在 `v0.1.0`（`v1.0.0` 留给上线轮） |
| D9 | K-17、W-17、S-21 | **blocked** | Chrome/Edge/Firefox/Safari 兼容矩阵、Safari 音频自检、真机 iframe 画面——只有无头 Edge 跑过 |

**🚩 人类门禁累计未过（agent 无权代判，T20）**：音色候选 3 套（S-02）、审美门 1 音色冻结（D3）、拆解演出 15s GIF（W-07）、能否指出核心节点（W-11）、D5 砍单决策、20 拍内首次 PERFECT（W-13）、审美门 2 试玩（D7）、审美门 3 录屏（D8）、线上无 404 与兼容矩阵（D9）。
README「已知限制」1/2/3/4/5/10 条正是这些缺口的如实登记，不是待修的 bug 清单。
