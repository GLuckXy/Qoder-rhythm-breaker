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
（待填）
```

## WORLD · 本轮变更
```
（待填）
```

## SOUND · 本轮变更
```
（待填）
```

## 当前可运行状态

```
R1 结束时应为：`node tools/contractTest.mjs` 绿（变速互逆<1ms、三档窗口、复活三口径、存档降级）；
`node tools/checkLevel.mjs --all` 对 L1/L2 草案绿；`node tools/audioAssert.mjs` 对 buildSchedule 绿；
`node tools/screenshotCheck.mjs` 对几何纯函数绿；npm run build 仍绿。浏览器里仍是 D0 占位画面（R2 接上）。
```

## 已知红点
```
（待填）
```

## 下一轮第一步
```
CORE  : 跑 `node tools/contractTest.mjs` 确认未回归，开 K-05 场景生命周期 + K-07 DisassembleSystem，
        并把 main.js/LevelScene 换成真实流程（?selftest= 路由要在此轮落地）
WORLD : 跑 `node tools/screenshotCheck.mjs`，开 W-03 Player + W-06 对齐虚线 + W-07 拆解演出
SOUND : 跑 `node tools/checkLevel.mjs --all`，开 S-05 L1 完整谱面 + S-07 段落/静音接线 + S-08 Sfx
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
（无）
```
