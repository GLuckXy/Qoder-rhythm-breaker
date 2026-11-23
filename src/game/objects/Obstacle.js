// src/game/objects/Obstacle.js — Owner: WORLD（W-04 基类；本文件是 WORLD 独占域 src/game/objects/*）
// 障碍基类：**生命周期状态机 + 位置纯函数定位**（OBS-02 / C4 ObstacleInstance）。
//
// 纪律 1（不可违反）：位置是时间的纯函数。本文件没有任何「x += v*dt」式积分，也没有任何时钟——
//   `nowSec` 由调用方（CORE 的 LevelScene 经 BeatClock.now()）传入。
//   → 因此本文件不 import Phaser、不 import 时钟，可在 Node 直接跑断言（tools/screenshotCheck.mjs）。
// 纪律 2：判定线 x 与 pxPerBeat 只在 theme.buildView() 里算一次，上下层共用（judgeLineX / pxPerBeatOf）。
// 纪律 3：颜色只从 theme.js 取（markerColor / COLORS / DERIVED / ALPHA）。
//
// 越界声明（T2）：本文件**绝不**判断命中。命中与否是 CORE 的 JudgeSystem 的事（C2 Judgment），
//   我们只消费它：`obstacle.onJudgment(judgment)`。hp / 复活选择 = DisassembleSystem（C3）。
//
// 与 SOUND 的实际输出对齐（src/game/systems/PatternGenerator.js）：
//   instance.laneKey 已由生成侧提供（`{level}-{track}`）→ laneKeyOf() 优先读它，缺省才自算。
//   复活 = 生成侧产出**新实例**（新 id），不是在旧实例上翻状态 → pending→revived 非法。

import {
  ALPHA,
  BACKGROUND_CFG,
  COLORS,
  CORE_EDGE,
  CORE_MARK,
  LEAD_BEATS,
  MARKER_TONE_MODE_DEFAULT,
  MOTION,
  SHAPE_BY_TRACK,
  TRACKS,
  TYPE_BY_TRACK,
  VIEW_RATIOS,
  VOICE_NAME,
  alphaOf,
  beatOffsetX,
  markerColor,
  pxPerSecOf,
  resolveView,
  timeToBeatOf
} from '../../data/theme.js';

// ---------------------------------------------------------------------------
// 1 · 生命周期状态机（C4：state = pending | judged | expired | revived）
// ---------------------------------------------------------------------------

export const OBSTACLE_STATES = ['pending', 'judged', 'expired', 'revived'];

/**
 * 合法迁移表（W-04 v0）：
 *  pending → judged   收到 CORE 的 Judgment（PERFECT/GOOD）
 *  pending → expired   收到 MISS，或过了 `timeSec + goodWindow` 仍未判（CORE 用 BeatClock.schedule 驱动）
 *  judged / expired    终态，不可再迁移（防重复扣分与演出重放）
 *  revived             **出生即为此态**（DIS-05「自当前拍之后恢复、不补发历史」→ 由生成侧新建实例）。
 *                      pending → revived 非法：已挂接的实例不做历史改写（T5 语义稳定）。
 */
export const LEGAL_TRANSITIONS = {
  pending: ['judged', 'expired'],
  revived: ['judged', 'expired'],
  judged: [],
  expired: []
};

export function canTransition(from, to) {
  const list = LEGAL_TRANSITIONS[from];
  return Array.isArray(list) && list.includes(to);
}

/** 该状态是否还该出现在画面上（终态后由 EffectSystem 播完演出即摘除） */
export function isLiveState(state) {
  return state === 'pending' || state === 'revived';
}

/**
 * 是否为「可渲染的障碍实例」。
 * ★ 生成侧（PatternGenerator）会把**铺底轨**（`track:'bed'` / `type:'bed'` / `judgable:false`，
 *   如 L1 的 16 分 hi-hat）一并下发，它们不是 C4 意义上的可判定障碍：
 *   不占声部色、不进判定、默认也不画（TIM-04 的「说谎」与「多余噪音」都会伤读谱）。
 *   所有挂接/绘制入口必须先过这道闸，否则 shapeOf('bed') 直接抛错 → 一帧毁掉整局（R1 实测崩溃点）。
 * @param {object} inst
 */
export function isRenderableInstance(inst) {
  if (!inst || typeof inst !== 'object') return false;
  if (inst.judgable === false) return false;
  return TRACKS.includes(inst.track);
}

/** 铺底/背景轨（S-19 分轨重组用；W-12 的 ghostBeats 同样不算障碍） */
export function isBedInstance(inst) {
  return !!inst && (inst.type === 'bed' || inst.track === 'bed' || inst.judgable === false);
}

/** id → 解析（两种口径都吃：`lv2-kick-008` 与 SOUND 现行的 `2-kick-8`，见 CR-11）。 */
export function parseObstacleId(id) {
  const m = /^lv?(\d+)-(kick|bass|synth)-(\d+)$/i.exec(String(id || ''));
  if (!m) return null;
  return { level: +m[1], track: m[2], index: +m[3] };
}

/**
 * 泳道键：同一 laneKey 的实例在渲染侧互斥占位（C4 未定义该字段 → 属 WORLD 内部调度，不外泄）。
 * ★ 生成侧（PatternGenerator）若已提供 `laneKey` 就**直接用它的**，避免两套分道口径。
 */
export function laneKeyOf(instance) {
  if (!instance) return null;
  if (typeof instance.laneKey === 'string' && instance.laneKey) return instance.laneKey;
  if (typeof instance.track === 'string' && TRACKS.includes(instance.track)) {
    const level = parseObstacleId(instance.id);
    return `${level ? level.level : 'x'}-${instance.track}`;
  }
  const parts = String(instance.id || '').split('-');
  return parts.length >= 2 ? parts.slice(0, 2).join('-') : String(instance.id || 'unknown');
}

/**
 * 实例数组不变量自检（供 screenshotCheck 复用；CORE 的 contractTest 亦可 import，见 CR-09）。
 * @returns {{errors:string[],warnings:string[]}}
 */
export function assertUniqueInstanceIds(instances) {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const lastByLane = new Map();
  for (const it of instances || []) {
    if (!it || typeof it.id !== 'string' || !it.id) {
      errors.push('instance without string id');
      continue;
    }
    if (seen.has(it.id)) errors.push(`duplicate id: ${it.id}`);
    seen.add(it.id);
    if (!isRenderableInstance(it)) continue; // 铺底/背景轨：不是可判定障碍，只查 id 唯一性
    if (typeof it.timeSec !== 'number' || !Number.isFinite(it.timeSec)) errors.push(`${it.id}: timeSec not numeric`);
    if (typeof it.beat !== 'number' || !Number.isFinite(it.beat)) errors.push(`${it.id}: beat not numeric`);
    if (!TRACKS.includes(it.track)) errors.push(`${it.id}: bad track ${it.track}`);
    if (it.state != null && !OBSTACLE_STATES.includes(it.state)) errors.push(`${it.id}: bad state ${it.state}`);
    if (it.state != null && !isLiveState(it.state)) warnings.push(`${it.id}: spawned in terminal state ${it.state}`);
    const lane = laneKeyOf(it);
    const prev = lastByLane.get(lane);
    if (prev != null && typeof it.beat === 'number') {
      if (it.beat < prev - 1e-9) warnings.push(`${lane}: beat descends at ${it.id}`);
    }
    if (typeof it.beat === 'number') lastByLane.set(lane, it.beat);
  }
  return { errors, warnings };
}

/** 同轨相邻实例的最小拍间隔（PRD §7.5 自检：同类 4 拍 ≤3 ⇒ ≥1.33 拍） */
export function minSameTrackGapBeats(instances) {
  const byTrack = new Map();
  for (const it of instances || []) {
    if (typeof it.beat !== 'number') continue;
    const arr = byTrack.get(it.track) || [];
    arr.push(it.beat);
    byTrack.set(it.track, arr);
  }
  let min = Infinity;
  for (const arr of byTrack.values()) {
    arr.sort((a, b) => a - b);
    for (let i = 1; i < arr.length; i++) min = Math.min(min, arr[i] - arr[i - 1]);
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * 时间读取适配（C1）：接受 BeatClock / MockClock / 裸秒数。
 * CORE 的时钟已在 R1 合入（src/audio/BeatClock.js）；这里保留裸秒数分支是为了纯函数断言。
 */
export function readNowSec(clock) {
  if (clock && typeof clock.now === 'function') return clock.now();
  if (typeof clock === 'number' && Number.isFinite(clock)) return clock;
  if (clock && typeof clock.nowSec === 'number') return clock.nowSec;
  throw new Error('[Obstacle] readNowSec: need BeatClock.now() or a number of seconds');
}

/** 时间 → 拍（同样接受 clock / 裸秒）：缺 beatAt 时按 view.beatSec 等速回退 */
export function readNowBeat(clock, view) {
  const nowSec = typeof clock === 'number' ? clock : readNowSec(clock);
  if (clock && typeof clock.beatAt === 'function') return clock.beatAt(nowSec);
  const v = resolveView(view || {});
  if (typeof v.timeToBeat === 'function') return v.timeToBeat(nowSec);
  return nowSec / (v.beatSec || 1);
}

/** 把实例数组按 timeSec 升序整理（挂接前的稳定化，不改原数组） */
export function sortInstancesByTime(instances) {
  return [...(instances || [])].sort((a, b) => a.timeSec - b.timeSec || String(a.id).localeCompare(String(b.id)));
}

/** 距最近拍网格（默认半拍）的残差。**只供表现**；判定不许读它（T2） */
export function beatGridResidual(beat, grid = 0.5) {
  const r = ((beat % grid) + grid) % grid;
  return Math.min(r, grid - r);
}

// ---------------------------------------------------------------------------
// 2 · 位置纯函数（纪律 1 的唯一实现处）
// ---------------------------------------------------------------------------

/** 判定线 x：上下层唯一真相 = 角色固定 x = 0.30W（纪律 2） */
export function judgeLineX(view) {
  return resolveView(view).judgeX;
}

/** 上下层共享的 pxPerBeat（「4 拍预告像素一致」的前提） */
export function pxPerBeatOf(view) {
  return resolveView(view).pxPerBeat;
}

/** C8 冻结的 4 拍预告窗（OBS-03） */
export function leadBeatsOf() {
  return LEAD_BEATS;
}

/**
 * 拍域定位（**推荐**，变速关唯一正确形式）：第 `beatsFromNow` 拍的屏幕 x。
 * 与下层时间轴的 beatX() 是同一个 theme.beatOffsetX → 两层不可能分叉。
 */
export function screenXFromBeats(beatsFromNow, view) {
  return beatOffsetX(resolveView(view), beatsFromNow);
}

/**
 * 秒域定位（WORLD.md 纪律 1 的字面式：`x = judgeX + (obstacleT - now) * pxPerSec`）。
 * 等速关与拍域逐像素一致（screenshotCheck 断言 <0.01px）；变速关以拍域为准。
 */
export function screenXFromSeconds(timeSec, nowSec, view) {
  const v = resolveView(view);
  return v.judgeX + (timeSec - nowSec) * pxPerSecOf(v);
}

/**
 * ★ 障碍屏幕 x（纯函数：同 (instance, nowSec, view) 永远同值，与调用历史/帧间隔无关）。
 * 优先拍域；instance 无 beat 时退秒域（仍不含任何积分）。
 */
export function obstacleScreenX(instance, nowSec, view) {
  if (!instance) throw new Error('[Obstacle] obstacleScreenX: instance is required');
  const v = resolveView(view);
  if (typeof nowSec !== 'number' || !Number.isFinite(nowSec)) {
    throw new Error('[Obstacle] obstacleScreenX: nowSec must be a number (pass clock.now())');
  }
  if (typeof instance.beat === 'number' && Number.isFinite(instance.beat)) {
    return beatOffsetX(v, instance.beat - timeToBeatOf(v, nowSec));
  }
  const tSec = Number(instance.timeSec);
  if (!Number.isFinite(tSec)) throw new Error(`[Obstacle] instance ${instance.id} has no numeric timeSec/beat`);
  return screenXFromSeconds(tSec, nowSec, v);
}

/** 距判定线还有几拍（负 = 已过线） */
export function beatsToJudge(instance, nowSec, view) {
  const v = resolveView(view);
  if (typeof instance.beat === 'number' && Number.isFinite(instance.beat)) {
    return instance.beat - timeToBeatOf(v, nowSec);
  }
  return (instance.timeSec - nowSec) / (v.beatSec || 1);
}

/** 距判定线还有几秒（C4：timeSec 权威） */
export function secondsToJudge(instance, nowSec) {
  return instance.timeSec - nowSec;
}

/** 是否在 4 拍预告窗内（OBS-03，与下层可见窗同界） */
export function isInLeadWindow(instance, nowSec, view, beats = LEAD_BEATS) {
  const b = beatsToJudge(instance, nowSec, view);
  return b >= 0 && b <= beats;
}

/** 世界层出生 x = 判定线 + 4 拍（= 下层时间轴窗右界 → 同一列出现、同一刻到线） */
export function worldSpawnX(view) {
  return beatOffsetX(resolveView(view), LEAD_BEATS);
}

/** 世界可读区 x 范围 [判定线 − 1 拍, 出生线]（其右侧只画背景，不画障碍） */
export function worldWindowRect(view) {
  const v = resolveView(view);
  const w = v.worldWindow || { x0: v.judgeX, x1: worldSpawnX(v) };
  return { x0: w.x0 - v.pxPerBeat, x1: w.x1, judgeX: w.x0 };
}

/** 是否需要绘制（过线后仍留 1 拍给碎裂演出） */
export function isOnScreen(x, view) {
  const r = worldWindowRect(view);
  return x >= r.x0 && x <= r.x1;
}

/**
 * 入画淡入系数（0..1）：出生线右侧 MOTION.spawnFadeBeats 拍内 0→1。
 * 纯函数 of 距线拍数（不用 tween）→ 变速关一致、掉帧不脱拍。
 */
export function spawnFadeAlpha(beatsToJudgeNow, leadBeats = LEAD_BEATS) {
  const fade = MOTION.spawnFadeBeats;
  if (beatsToJudgeNow > leadBeats + fade) return 0;
  if (beatsToJudgeNow <= leadBeats) return 1;
  return (leadBeats + fade - beatsToJudgeNow) / fade;
}

/** 出生提前量 = 4 拍 + 淡入跨度（WorldLayer 用它决定何时开始挂接） */
export function spawnLeadBeats(view) {
  const v = resolveView(view);
  return v.leadBeats + (v.spawnFadeBeats || MOTION.spawnFadeBeats);
}

// ---------------------------------------------------------------------------
// 3 · 形状通道（L-08 三通道之一：几何互异）
// ---------------------------------------------------------------------------

/** 三声部形状轮廓（点数组，纯几何可断言）。cx/cy = 中心，s = 参考半径。 */
export function shapePoints(kind, cx, cy, s) {
  switch (kind) {
    case 'triangle': // 尖刺：顶点朝上（读作「踩它」）
      return [
        { x: cx, y: cy - s },
        { x: cx + s * 0.86, y: cy + s * 0.78 },
        { x: cx - s * 0.86, y: cy + s * 0.78 }
      ];
    case 'platformBar': // 平台：横条（读作「落上去」）
      return [
        { x: cx - s * 1.5, y: cy - s * 0.3 },
        { x: cx + s * 1.5, y: cy - s * 0.3 },
        { x: cx + s * 1.5, y: cy + s * 0.3 },
        { x: cx - s * 1.5, y: cy + s * 0.3 }
      ];
    case 'hexagon': // 弹幕核心：六边形（读作「穿过去」）
      return hexPoints(cx, cy, s);
    case 'diamond': // 假节拍 / 通用空心标记
      return [
        { x: cx, y: cy - s },
        { x: cx + s * 0.7, y: cy },
        { x: cx, y: cy + s },
        { x: cx - s * 0.7, y: cy }
      ];
    default:
      throw new Error(`[Obstacle] unknown shape kind: ${kind}`);
  }
}

function hexPoints(cx, cy, s) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    pts.push({ x: cx + Math.cos(a) * s, y: cy + Math.sin(a) * s });
  }
  return pts;
}

/** track → 形状（值来自 theme.SHAPE_BY_TRACK，不另立一份） */
export function shapeOf(track) {
  const kind = SHAPE_BY_TRACK[track];
  if (!kind) throw new Error(`[Obstacle] unknown track: ${track}`);
  return kind;
}

/** 形状顶点数（灰度可辨断言用的第二通道指标） */
export function shapeVertexCount(kind) {
  return shapePoints(kind, 0, 0, 1).length;
}

/**
 * ★ 唯一形状绘制出口（上层障碍与下层标记共用 → 两层形状编码不可能分叉）。
 * @param {object} g Phaser Graphics 或测试用 RecordingGraphics
 */
export function drawTrackShape(g, o) {
  const kind = shapeOf(o.track);
  const pts = shapePoints(kind, o.cx, o.cy, o.size);
  const alpha = o.alpha == null ? 1 : o.alpha;
  const fill = markerColor(o.track, o.tone);
  g.fillStyle(fill, alpha);
  g.fillPoints(pts, true);
  if (o.stroke !== false) {
    g.lineStyle(Math.max(1, o.size * 0.12), fill, Math.min(1, alpha * 1.1));
    g.strokePoints(pts, true);
  }
  if (o.hollow) {
    g.fillStyle(COLORS.base.int, 0.92);
    g.fillCircle(o.cx, o.cy, o.size * 0.45);
  }
  if (o.core) drawCoreEdge(g, pts, o.size, alpha);
  return pts;
}

/**
 * 核心节点标记（W-11 的 v1）= **三条独立通道**，任一条被削掉都还能分辨：
 *  ① 明度通道：白描边 + 中心点（255 灰度，非核心节点没有任何 255 级墨迹）；
 *  ② 空间通道：`coreBracketLines` 的 4 个角括号**必定落在字形包围盒之外**（灰度化后仍是「外围有东西」）；
 *  ③ 计数通道：段数固定 = CORE_MARK.count × 2，可数（与形状/色相无关）。
 * 非核心节点走同一函数时直接 return，**不给任何 hp 暗示**（hp 属 HUD 与图例，障碍本体不画格数）。
 */
export function drawCoreEdge(g, pts, size, alpha = 1) {
  g.lineStyle(Math.max(1, size * CORE_EDGE.widthRatio), CORE_EDGE.color, CORE_EDGE.alpha * alpha);
  g.strokePoints(pts, true);
  const c = centroid(pts);
  g.fillStyle(COLORS.white.int, alphaOf('coreEdge', ALPHA.coreEdge) * alpha);
  g.fillCircle(c.x, c.y, Math.max(1.5, size * 0.18));
  const lines = coreBracketLines(pts, size);
  g.lineStyle(Math.max(1, size * CORE_MARK.widthRatio), CORE_EDGE.color, CORE_MARK.alpha * alpha);
  for (const ln of lines) g.lineBetween(ln.x1, ln.y1, ln.x2, ln.y2);
  return lines;
}

/**
 * 四角括号的线段表（纯几何，导出给断言：可验证「全部在包围盒外」与「恰好 8 段」）。
 * 角点 = 包围盒四角沿对角线外推 pad；两条臂沿轴回指 LEN，形成 L 形。
 */
export function coreBracketLines(pts, size = 0) {
  if (!pts || !pts.length) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const half = Math.max(maxX - minX, maxY - minY, size * 2, 1) / 2;
  const pad = half * (CORE_MARK.bracketGapRatio - 1) + 1;
  const len = Math.max(2, half * CORE_MARK.bracketLenRatio);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const ex = half + pad;
  const ey = (maxY - minY) / 2 + pad;
  const out = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const px = cx + sx * ex;
      const py = cy + sy * ey;
      out.push({ x1: px, y1: py, x2: px - sx * len, y2: py });
      out.push({ x1: px, y1: py, x2: px, y2: py - sy * len });
    }
  }
  return out;
}

function centroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** 剪影轮廓（W-13 / UI-07 的 S-19 消费）：等比缩放后形状通道不变 → 灰度仍可辨声部 */
export function silhouettePoints(instance, cx, cy, size, scale = 1) {
  const s = size * scale;
  return shapePoints(shapeOf(instance.track), cx, cy, s);
}

// ---------------------------------------------------------------------------
// 4 · 上层世界的 y 轴（三声部「可读高度带」，与下层泳道解耦）
// ---------------------------------------------------------------------------

/**
 * 声部在世界层的 y 口径（**按声部分带，不按 pitchTier**）：
 *  - kick    底边贴地面线（0.52H）：跳跃 = 唯一动作，视觉最接近角色。
 *  - bass    平台三档顶面 = 地面线上方 0.10 / 0.16 / 0.21 × H（**直接采用 physics.FROZEN.platformTiers**，
 *            与 CORE 的 platformTopY 同一个数：C8 说「WORLD 的障碍几何以 physics.js 为准」，
 *            所以这里不再自插一条「跳跃带」中间值，否则 W-09 的三档与 CORE 算出来的高度会分叉。
 *            三档都落在跳跃可达包络内（见 trackEnvelope 的 bassTop 与 physics.selfTest）。）
 *  - synth   地面线上方 ≥ 2.2× 身高：**站立跑动永远碰不到** → 「必须冲刺穿越」在画面语法上为真。
 * 为什么不能把三声部全挤在同一条地面基线：同一 x 会出现三形状叠印（读谱崩坏），
 * 且弹幕会被误读成「站着也能撞」，破坏 PLR-03 与支柱 2。分层只动 y，
 * 判定线 x / pxPerBeat / 拍↔像素换算一字未改 → 不违反纪律 2（论证见 R1-WORLD.md）。
 */
export function worldYFor(trackOrInstance, view, opts = {}) {
  const v = resolveView(view);
  const track = typeof trackOrInstance === 'string' ? trackOrInstance : trackOrInstance.track;
  const charH = v.sizes.player.h;
  if (track === 'kick') return v.groundY;
  if (track === 'bass') {
    const tiers = v.ratios.platformTiers || VIEW_RATIOS.platformTiers;
    const tier = Math.max(0, Math.min(tiers.length - 1, (opts.pitchTier || 0) | 0));
    const top = v.groundY - v.height * tiers[tier];
    const bandTop = v.groundY - v.height * v.ratios.jumpPeakH - charH * 0.5; // 跳跃最高点（越过即不可达硬伤）
    return Math.max(top, bandTop);
  }
  return v.groundY - charH * BACKGROUND_CFG.gapToCharH;
}

/** 三声部在世界层的可达性包络（给 CR-09 与 SOUND 的可行域约束用） */
export function trackEnvelope(view) {
  const v = resolveView(view);
  const charH = v.sizes.player.h;
  const jumpH = v.height * v.ratios.jumpPeakH;
  const bassTop = v.groundY - jumpH - charH / 2;
  const kickY = worldYFor('kick', v);
  const bassY = worldYFor('bass', v, { pitchTier: 2 });
  const synthY = worldYFor('synth', v);
  return {
    charH,
    jumpPeakPx: jumpH,
    kick: { mode: 'ground', y: kickY, clearancePx: v.groundY - kickY },
    bass: { mode: 'jump-band', y: bassY, bandTopY: bassTop, reachPx: jumpH + charH / 2, clearancePx: v.groundY - bassY },
    synth: { mode: 'dash-only', y: synthY, clearancePx: v.groundY - synthY, minClearPx: charH * BACKGROUND_CFG.gapToCharH },
    ok: v.groundY - synthY >= charH * BACKGROUND_CFG.gapToCharH - 1e-6 && bassY >= bassTop - 1e-6
  };
}

/** 旧名兼容（基类内部与测试用） */
export const anchorY = worldYFor;

// ---------------------------------------------------------------------------
// 5 · 障碍基类（update 与 render 入口分离）
// ---------------------------------------------------------------------------

export class Obstacle {
  /**
   * @param {object} instance C4 的 ObstacleInstance
   * @param {object} [opts] { maxLeadBeats, onReject(from,to,wrapper), tolerant:boolean }
   */
  constructor(instance, opts = {}) {
    if (!instance || typeof instance !== 'object') throw new Error('[Obstacle] constructor needs an ObstacleInstance (C4)');
    const id = typeof instance.id === 'string' && instance.id ? instance.id : null;
    if (!id && !opts.tolerant) throw new Error('[Obstacle] instance without string id (C4 要求 id 唯一)');
    if (typeof instance.timeSec !== 'number' && opts.tolerant !== true) {
      throw new Error(`[Obstacle] instance ${id} missing numeric timeSec (C4)`);
    }
    this.instance = instance;
    this.id = id || `anon-${laneKeyOf(instance)}-${instance.beat}`;
    this.sourceId = this.id;
    this.laneKey = laneKeyOf(instance);
    this.track = instance.track;
    this.type = instance.type || TYPE_BY_TRACK[this.track];
    this.shape = SHAPE_BY_TRACK[this.track] ? shapeOf(this.track) : 'diamond';
    this.core = !!instance.core;
    this.beat = typeof instance.beat === 'number' ? instance.beat : null;
    this.timeSec = instance.timeSec;
    this.pitchTier = instance.pitchTier | 0;
    this.speed = typeof instance.speed === 'number' ? instance.speed : 1;
    this.state = OBSTACLE_STATES.includes(instance.state) ? instance.state : 'pending';
    this.grade = instance.grade || null;
    this.judgedAtSec = null;
    this.tone = instance.tone || MARKER_TONE_MODE_DEFAULT;
    this.opts = opts;
    /** 演出（W-07 的 EffectSystem）消费的一次性标志：读出即清 → 保证只播一次 */
    this.fx = { spawn: true, judged: false, missed: false, revived: this.state === 'revived', disintegrating: false };
    /** update() 写入、render() 只读的纯几何缓存（入口分离） */
    this.screen = { x: null, y: null, onScreen: false, beatsToJudge: null, alpha: 0, fade: 0 };
    this.retired = false;
  }

  // ---- 状态迁移 ----------------------------------------------------------

  /** @returns {boolean} 是否真的迁移了（非法迁移返回 false 并回调，绝不静默改状态） */
  transition(to) {
    if (!OBSTACLE_STATES.includes(to) || !canTransition(this.state, to)) {
      this._reject(this.state, to);
      return false;
    }
    const from = this.state;
    this.state = to;
    this.instance.state = to;
    this.stateHistory = (this.stateHistory || [from]).concat(to);
    return true;
  }

  _reject(from, to) {
    if (typeof this.opts.onReject === 'function') this.opts.onReject(from, to, this);
    else if (typeof console !== 'undefined') {
      console.warn(`[Obstacle] illegal transition ${from} -> ${to} on ${this.id}`);
    }
  }

  /**
   * ★ 只消费 CORE 的 Judgment（C2）。这里没有窗口、没有动作对错、没有 hp。
   * @param {{obstacleId:string,grade:'PERFECT'|'GOOD'|'MISS',actionMatch:boolean,deltaMs:number,atSec?:number}} judgment
   */
  onJudgment(judgment) {
    if (!judgment || judgment.obstacleId !== this.id) return false;
    if (!isLiveState(this.state)) return false; // 终态：迟到判定不改状态
    this.grade = judgment.grade;
    if (typeof judgment.atSec === 'number') this.judgedAtSec = judgment.atSec;
    const moved = this.transition(judgment.grade === 'MISS' ? 'expired' : 'judged');
    if (!moved) return false;
    this.instance.grade = judgment.grade;
    this.fx.judged = judgment.grade !== 'MISS';
    this.fx.missed = judgment.grade === 'MISS';
    return true;
  }

  /** CORE 的超时 MISS（`BeatClock.schedule` 在 timeSec+goodWindow 处驱动）走这里 */
  markExpired(atSec = null) {
    const moved = this.transition('expired');
    if (moved) {
      this.grade = this.grade || 'MISS';
      this.instance.grade = this.grade;
      this.judgedAtSec = atSec;
      this.fx.missed = true;
    }
    return moved;
  }

  /**
   * C3 'revive' 的渲染侧响应。v0 语义下**总是** false：
   * DIS-05 规定「自当前拍之后恢复、不补发历史」⇒ 复活的表达是生成侧发**新实例**（state:'revived'），
   * 而不是把场上 pending 实例改状态。保留本方法是为了让集成点显式可见、且可被断言「不该生效」。
   */
  markRevived() {
    if (this.state === 'revived') return false;
    this._reject(this.state, 'revived');
    return false;
  }

  /** DIS-04：该声部拆解 → 在场实例交给 EffectSystem 播碎裂（W-07） */
  markDisassembling() {
    this.fx.disintegrating = true;
    return this;
  }

  isSilenced() {
    return !isLiveState(this.state);
  }

  /** 生成侧不再下发该实例时调用：等待碎裂演出结束后由 WorldLayer 摘除 */
  retire() {
    this.retired = true;
    return this;
  }

  /**
   * 换关/重开：把同一 id 的新 instance 数据镜像进来（**不改状态**，状态只由事件驱动）。
   * 跨泳道（track/laneKey 变了）→ 拒绝并返回 false，调用方应新建包裹对象。
   */
  attach(instance, nowSec = null) {
    if (!instance || laneKeyOf(instance) !== this.laneKey) return false;
    this.instance = instance;
    this.track = instance.track;
    this.type = instance.type || TYPE_BY_TRACK[this.track];
    this.shape = SHAPE_BY_TRACK[this.track] ? shapeOf(this.track) : this.shape;
    this.core = !!instance.core;
    this.beat = typeof instance.beat === 'number' ? instance.beat : this.beat;
    this.timeSec = instance.timeSec;
    this.pitchTier = instance.pitchTier | 0;
    this.speed = typeof instance.speed === 'number' ? instance.speed : this.speed;
    if (typeof instance.state === 'string' && OBSTACLE_STATES.includes(instance.state)) this.state = instance.state;
    this.grade = instance.grade || this.grade;
    void nowSec;
    return true;
  }

  // ---- 入口 1：更新（纯几何，不碰任何场景对象） --------------------------

  /** @param {number} nowSec clock.now() @param {object} view */
  update(nowSec, view) {
    const v = resolveView(view);
    const x = obstacleScreenX(this.instance, nowSec, v);
    const b = beatsToJudge(this.instance, nowSec, v);
    this.screen.x = x;
    this.screen.y = this.anchorY(v);
    this.screen.beatsToJudge = b;
    this.screen.onScreen = isOnScreen(x, v) && !this.retired;
    this.screen.fade = spawnFadeAlpha(b, v.leadBeats);
    this.screen.alpha = this.isSilenced() ? ALPHA.markerExpired : this.screen.fade;
    this.fx.spawn = false;
    return this.screen;
  }

  /** 底边/中心 y 锚点（子类覆写） */
  anchorY(view) {
    return worldYFor(this.track, view, { pitchTier: this.pitchTier });
  }

  // ---- 入口 2：渲染（只读 update() 的缓存） ------------------------------

  /** @param {object} g Phaser Graphics @param {object} [view] */
  render(g, view = null) {
    if (!this.screen.onScreen || this.screen.alpha <= 0) return false;
    const v = resolveView(view || { width: 1920, height: 1080 });
    drawTrackShape(g, {
      track: this.track,
      cx: this.screen.x,
      cy: this.screen.y - this.glyphSize(v),
      size: this.glyphSize(v),
      core: this.core,
      alpha: this.screen.alpha,
      tone: this.tone
    });
    return true;
  }

  /** 子类覆写的字形参考半径 */
  glyphSize(view) {
    return view.sizes.spike.h / 2;
  }

  /** 是否已超出挂接窗（WorldLayer 的裁剪条件之一） */
  isStaleAt(nowSec, view) {
    const lead = this.opts.maxLeadBeats || spawnLeadBeats(view);
    return beatsToJudge(this.instance, nowSec, view) > lead + 0.001;
  }

  /** HUD/结算/自检用的人话名 */
  label() {
    return `${VOICE_NAME[this.track] || this.track}·${this.shape}${this.core ? '·核心' : ''}`;
  }

  toJSON() {
    return {
      id: this.id,
      laneKey: this.laneKey,
      track: this.track,
      type: this.type,
      beat: this.beat,
      timeSec: this.timeSec,
      core: this.core,
      state: this.state,
      grade: this.grade,
      screen: this.screen
    };
  }
}

/** 开发/断言用：把最小 spec 变成合法 ObstacleInstance（生产路径归 PatternGenerator） */
let nextLocalId = 0;
export function makeTestInstance(spec) {
  const track = spec.track || 'kick';
  return {
    id: spec.id || `tst-${track}-${++nextLocalId}`,
    track,
    type: spec.type || TYPE_BY_TRACK[track],
    beat: spec.beat,
    timeSec: spec.timeSec,
    core: false,
    pitchTier: 0,
    speed: 1,
    state: 'pending',
    grade: null,
    ...spec
  };
}

export default Obstacle;
