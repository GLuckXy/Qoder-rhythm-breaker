# STATE · 项目交接板（agent 的外置记忆）

> **放置位置：仓库根目录 `.agent/STATE.md`。**
> 这是本项目唯一的记忆载体（T17）。**每个 agent 每轮开头必读、收工必写；不写完不许结束会话。**
> 规则：只追加、只覆盖自己那一段；`Decisions` 与 `CONFLICTS` 只增不删；全文保持在 120 行以内（超了就删最旧的 `红点` 与 `变更` 条目，把它们沉到 CHANGELOG.md）。

---

## 当前

```
轮次：D1（契约日）        门：三 agent 均能离线开工        状态：未开始
最近绿 tag：（无）
main HEAD：（未初始化）
```

## 本轮 writes 声明（T7 开工前填，三方集合必须两两不相交）

```
CORE  : src/audio/BeatClock.js, src/mocks/MockClock.js, src/game/systems/JudgeSystem.js,
        src/data/config.js, src/ui/DebugPanel.js, tools/contractTest.mjs
WORLD : src/data/theme.js, src/game/render/WorldLayer.js, src/game/render/Background.js,
        tools/screenshotCheck.mjs
SOUND : src/audio/TrackMixer.js, src/audio/SynthVoices.js, src/audio/Metronome.js,
        tools/audioAssert.mjs, src/data/levels/level1.json, level2.json
交集检查：空 ✅  /  冲突：（列出冲突路径 → 由编排者拆轮次）
```

## CORE · 本轮变更

```
（示例）K-01 完成：timeAtBeat 改为分段积分，变速点误差从 18ms → 0.4ms；
        pause/resume 内部重算原点，暂停 30s 恢复后判定不漂移。
        verify: node tools/contractTest.mjs --case clock → PASS（贴输出，不贴描述）
```

## WORLD · 本轮变更

```
（示例）W-01/W-02 完成：theme.js 全量落地，颜色字面量在其余目录为 0；
        render 端点输出 judgeX 上层 576px / 下层 576px，diff 0px。
```

## SOUND · 本轮变更

```
（示例）S-01 完成：silence 用 0.1s 线性斜坡，包络采样无 >0.05 的阶跃；
        S-02 交了 3 套 kick 候选（soft/metal/punch），等审美门 1 选定。
```

## 当前可运行状态（一句话，别人据此决定从哪继续）

```
D1 结束时应为：能启动节拍器并按出 PERFECT/GOOD/MISS，画面只有地面线与时间轴，
              三轨能各自开合。无关卡内容，无 UI。
```

## 已知红点（不修但必须让所有人看见；清掉后删除该行并沉 CHANGELOG）

```
（示例）R: L4 变速时下层标记间距仍按秒算 → 需 W-12；CORE 的 timeAtBeat 已正确，勿重复修
```

## 下一轮第一步（每个 agent 一行，新会话的第一件事）

```
CORE  : 先跑 `npm run verify:all` 确认 tag r1-contract 是绿的，再开 K-04
WORLD : 读 ?selftest=render 输出确认判定线未回归，然后开 W-03
SOUND : 读 checkLevel --lv1 报告确认字段未回归，然后开 S-04
```

## Decisions（一行一条，含时间、影响面、拍板人；跨域分歧的最终落点）

```
D1-人类 : 判定窗口基准定为 ±60/±110ms，严格模式做成开关。理由：浏览器输出延迟实测 40–90ms
D1-人类 : 音乐锁方案 C（程序合成），本项目不引入任何音频素材文件（Safari 不支持 Ogg）
D1-人类 : 跳跃滞空 = 0.9 × 拍长（非固定秒数），否则 L4 变速后所有跳跃跳过头
D3-人类 : 音色选定候选 B（metal kick），此后 D8 前音色不再变动
```

## CONFLICTS（T21：15 分钟未达成 → 记此 + 采最保守方案 + 提交人类，不空转）

```
（示例）D4 SOUND vs WORLD：L6 密度 3.0 下弹幕间隙不足 2.2× 角色高
  临时方案：L6 弹幕改 2 行 + 密度降到 2.75（最保守）  待人类仲裁：☐
```

## human-actions（只有人类能做的事，agent 在此挂请求）

```
☐ D1 : PRD §12 的 5 个 P0 与 Q1–Q3 定稿并回写 PRD v1.0
☐ D3 : 审美门 1 —— 从 SOUND 的 3 套 kick 候选里选一套并签字冻结
☐ D5 : 执行砍单（agent 无权限）—— 见 TASKBOARD 末表
☐ D5 : 预约 3 名 D7 试玩者
☐ D7 : 主持试玩并回收事件流与反馈表
☐ D8 : 审美门 3 —— 60 秒录屏逐秒评审，标出空档
☐ D9 : 批准发布
```

## CR 待回复（超过一个集成窗口未回 → 自动升级为 CONFLICT）

```
CR-01 SOUND→CORE/WORLD : noteEvents 加 lane 字段（弹幕分层）  状态：待回复
```

---

## 写入规范（三条，违反等于没写）

1. **变更段只写「做了什么 + 证据」**，证据必须是 verify 的实际输出或其关键行。「K-04 已完成」不合格；「`contract:physics` PASS，包络峰值 216px@0.9beat」合格。
2. **「下一轮第一步」写给一个没有任何上下文的新会话读**。假设读者刚醒来、什么都没看过。这条专治 RA3（上下文截断后重复实现）。
3. 需要他人配合的事，只能出现在 `CR 待回复` / `CONFLICTS` / `human-actions` 三段里，**不许出现在自己变更段的「我顺手帮 X 改了」里**（T2/T4 越界）。
