// src/game/objects/Timeline.js — Owner: WORLD (W-05)
// 下层时间轴读谱带（§5.8 TIM）：判定线、4 拍可见窗、标记流动、三声部形状编码、变速按拍等距。
//
// ★「双读谱殊途同归」的下层实现：本文件与上层 WorldLayer 共用同一套换算——
//   判定线 x = theme.view.judgeX = 0.30W（= 角色固定 x）
//   每拍像素 = theme.view.pxPerBeat（**上下层同值**）
//   x(拍) = beatOffsetX(view, beat - nowBeat)（**同一个函数**，所以两层不可能分叉）
//
// 纪律 1：不持有任何累积位置。每帧从 `nowSec` 现算（`this.draw(g, {nowSec, instances, view})`）。
// 纪律 2：见文件头。
// 纪律 3：颜色只从 theme.js 取（DERIVED / COLORS / markerColor）。
// 不 import Phaser、不 import 时钟 → 可在 Node 用假 Graphics 断言（tools/screenshotCheck.mjs）。
//
// 预留接口：W-06 对齐虚线（flashAlign / drawAlignDash）、W-12 假节拍（setGhostBeats / drawGhostMarkers）。

import {
  ALPHA,
  COLORS,
  DERIVED,
  LEAD_BEATS,
  MOTION,
  SHAPE_BY_TRACK,
  TIMELINE_CFG,
  TRACKS,
  beatOffsetX,
  markerColor,
  pxPerSecOf,
  beatToTimeOf,
  resolveView,
  timeToBeatOf
} from '../../data/theme.js';
// 与上层共用同一份形状/位置/淡入实现（永不分叉）；Obstacle.js 不反向依赖本文件 → 无环。
import { beatsToJudge, drawTrackShape, isRenderableInstance, spawnFadeAlpha } from './Obstacle.js';

// ---------------------------------------------------------------------------
// 1 · 纯几何（全部可在 Node 断言）
// ---------------------------------------------------------------------------

/** 下层判定线 x —— 必须与上层同值（WORLD.md 纪律 2） */
export function timelineJudgeX(view) {
  return resolveView(view).judgeX;
}

/** 下层每拍像素 —— 必须与上层同值（VIS-05 / OBS-03） */
export function timelinePxPerBeat(view) {
  return resolveView(view).pxPerBeat;
}

/** 第 `beat` 拍在给定 `nowBeat` 时刻的屏幕 x（按拍等距 → TIM-02 变速下不崩） */
export function beatX(view, beat, nowBeat) {
  return beatOffsetX(resolveView(view), beat - nowBeat);
}

/** 距线拍数是否落在可见窗（[-1, 4]：判定线左侧留 1 拍给碎裂演出） */
export function isBeatsVisible(beatsFromNow, leadBeats = LEAD_BEATS) {
  return beatsFromNow >= -1 && beatsFromNow <= leadBeats + 1e-9;
}

/** 绝对拍口径的可见窗判定（= isBeatsVisible(beat − nowBeat)） */
export function isBeatVisible(beat, nowBeat, leadBeats = LEAD_BEATS) {
  return isBeatsVisible(beat - nowBeat, leadBeats);
}

/** 可见窗内的整数拍列表（画刻度用） */
export function visibleBeatTicks(nowBeat, view, leadBeats = LEAD_BEATS) {
  const from = Math.floor(nowBeat);
  const to = Math.ceil(nowBeat + leadBeats);
  const out = [];
  for (let b = from; b <= to; b++) out.push(b);
  return out;
}

/** 三声部泳道 y（kick 下 / bass 中 / synth 上，与上层障碍的直觉方向一致） */
export function laneY(track, view) {
  const v = resolveView(view);
  const y = v.lanes && v.lanes[track];
  if (typeof y !== 'number') throw new Error(`[Timeline] unknown track for laneY: ${track}`);
  return y;
}

/** 时间轴标记边长（PRD §7.5：标记高 40px，且不得越过带高） */
export function timelineMarkerSize(view) {
  return resolveView(view).lanes.markerW;
}

/** 时间轴带矩形（画 bg / 裁剪用） */
export function bandRect(view) {
  const v = resolveView(view);
  return { x: 0, y: v.zones.timelineTop, w: v.width, h: v.zones.timelineHeight };
}

/** 可见窗右界 x（= 上层出生线，同一列 → OBS-03 的像素等式） */
export function windowRightX(view) {
  const v = resolveView(view);
  return v.judgeX + v.pxPerBeat * LEAD_BEATS;
}

/** 对齐虚线的透明度（纯函数 of 触发时刻；用拍长换算，不用固定 ms tween） */
export function alignDashAlpha(triggerSec, nowSec, view) {
  if (triggerSec == null) return 0;
  const v = resolveView(view);
  const dur = MOTION.alignDashBeats * (v.beatSec || 1);
  const k = (nowSec - triggerSec) / dur;
  return k < 0 || k > 1 ? 0 : 1 - k;
}

/** 假节拍的渲染拍位（L-06：最多 8 处标记、其中 2 处演出型故障闪烁；仅渲染层，不进判定/音频） */
export function ghostRenderX(view, ghost, nowBeat) {
  const list = normalizeGhosts(ghost);
  return list.map((gh) => beatX(view, gh.beat + gh.offsetBeats, nowBeat));
}

/** 归一化 C5 的 ghostBeats：`[{beat,offsetBeats}]` 或 `[40]` 或 `[{b:40,d:0.5}]` */
export function normalizeGhosts(ghosts) {
  const arr = Array.isArray(ghosts) ? ghosts : [];
  const out = [];
  for (const g of arr) {
    if (g == null) continue;
    const beat = typeof g === 'number' ? g : Number(g.beat != null ? g.beat : g.b);
    if (!Number.isFinite(beat)) continue;
    const offsetBeats =
      typeof g === 'number' ? 0.5 : Number(g.offsetBeats != null ? g.offsetBeats : g.d != null ? g.d : 0.5);
    out.push({
      beat,
      offsetBeats,
      glitch: !!g.glitch,
      lane: g.lane == null ? null : g.lane | 0
    });
    if (out.length >= TIMELINE_CFG.ghostMax) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2 · 渲染器（draw-only：无状态迁移、无 Phaser 依赖）
// ---------------------------------------------------------------------------

export class Timeline {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.tracks] 泳道集合（默认三声部；关配置可去掉 hp:0 的轨）
   * @param {boolean} [opts.guides=true] 辅助线开关（TIM-05）
   * @param {object[]} [opts.ghostBeats] C5 的 ghostBeats（W-12）
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.tracks = sanitizeTracks(opts.tracks);
    this.guidesOn = opts.guides !== false;
    this.ghosts = normalizeGhosts(opts.ghostBeats || []);
    this.alignTriggerSec = null;
    this.coreIds = new Set(opts.coreIds || []);
    this.enabled = opts.enabled !== false;
    this.stats = { markers: 0, ticks: 0, ghosts: 0 };
  }

  setGuides(on) {
    this.guidesOn = !!on;
  }

  /** W-12：换关时注入假节拍（只影响本层的视觉标记） */
  setGhostBeats(ghosts) {
    this.ghosts = normalizeGhosts(ghosts);
  }

  /** W-06：障碍到线的瞬间调用（CORE 的 Judgment 或拍事件驱动），本帧起按拍衰减 */
  flashAlign(atSec) {
    this.alignTriggerSec = atSec;
  }

  /** 关卡配置里的 hp:0 声部不画泳道（与「既不发声也不生成障碍」同口径） */
  setActiveTracks(tracks) {
    const next = sanitizeTracks(tracks);
    if (next.length) this.tracks = next;
  }

  /**
   * ★ 唯一绘制入口（每帧现画，全部几何来自 nowSec + instances）
   * @param {object} g Phaser Graphics
   * @param {{nowSec:number, instances?:object[], view:object, beatSec?:number, hpByTrack?:Record<string,number>}} frame
   */
  draw(g, frame) {
    if (!this.enabled) return this.stats;
    const view = resolveView(frame.view);
    const nowSec = Number(frame.nowSec);
    const nowBeat = timeToBeatOf(view, nowSec);
    this.stats = { markers: 0, ticks: 0, ghosts: 0, nowBeat };

    this.drawBand(g, view);
    if (this.guidesOn) this.drawBeatGrid(g, view, nowBeat);
    this.drawLanes(g, view);
    this.drawWindow(g, view);
    this.drawMarkers(g, view, nowBeat, frame.instances || []);
    if (this.ghosts.length) this.drawGhostMarkers(g, view, nowBeat);
    this.drawJudgeLine(g, view, frame);
    this.drawAlignDash(g, view, nowSec);
    return this.stats;
  }

  // ---- 各部件（拆成小方法：WorldLayer 与测试都能单独调用） ---------------

  drawBand(g, view) {
    const r = bandRect(view);
    g.fillStyle(DERIVED.bandTimeline.int, 1);
    g.fillRect(r.x, r.y, r.w, r.h);
    g.lineStyle(Math.max(1, view.designScale), DERIVED.divider.int, 0.9);
    g.lineBetween(0, r.y, view.width, r.y);
  }

  /** 拍刻度：按拍等距（TIM-02）。小节线（每 4 拍）更亮。 */
  drawBeatGrid(g, view, nowBeat) {
    const r = bandRect(view);
    const ticks = visibleBeatTicks(nowBeat, view);
    const top = r.y + r.h * 0.08;
    const bottom = r.y + r.h * 0.92;
    for (const b of ticks) {
      if (!isBeatVisible(b, nowBeat)) continue;
      const x = beatX(view, b, nowBeat);
      if (x < 0 || x > view.width) continue;
      const isBar = ((b % 4) + 4) % 4 === 0;
      const half = isBar ? r.h * 0.34 : r.h * 0.16;
      const mid = (top + bottom) / 2;
      g.lineStyle(
        Math.max(1, view.designScale * (isBar ? 2 : 1)),
        isBar ? DERIVED.barLine.int : DERIVED.beatTick.int,
        isBar ? ALPHA.barLine : ALPHA.beatTick
      );
      g.lineBetween(x, mid - half, x, mid + half);
      this.stats.ticks++;
    }
  }

  /** 三泳道基线（消色差，不引入新色相；泳道 = 声部的第二重定位线索） */
  drawLanes(g, view) {
    for (const track of this.tracks) {
      const y = laneY(track, view);
      const x0 = view.judgeX - view.pxPerBeat * 0.6;
      const x1 = windowRightX(view) + view.pxPerBeat * 0.6;
      g.lineStyle(Math.max(1, view.designScale), DERIVED.parallaxMid.int, ALPHA.guideLine);
      g.lineBetween(Math.max(0, x0), y, Math.min(view.width, x1), y);
      // 道首形状图例：让玩家不依赖颜色也知道「哪一道是哪一声部」
      drawLegend(g, track, view, view.judgeX - view.pxPerBeat * TIMELINE_CFG.legendBeatOffset, y);
    }
  }

  /** 4 拍可见窗右界（= 上层出生线）：画一条淡竖线，明示「从这里开始出现」 */
  drawWindow(g, view) {
    const r = bandRect(view);
    const x = windowRightX(view);
    if (x > view.width) return;
    g.lineStyle(Math.max(1, view.designScale * 2), DERIVED.divider.int, ALPHA.guideLine);
    g.lineBetween(x, r.y + r.h * 0.06, x, r.y + r.h * 0.94);
  }

  /** ★ 标记流动：x 只由 (beat − nowBeat) × pxPerBeat 决定 —— 无速度、无积分 */
  drawMarkers(g, view, nowBeat, instances) {
    const size = timelineMarkerSize(view) / 2;
    const nowSec = beatToTimeOf(view, nowBeat); // 往返换算：等速关严格互逆，变速关以拍域为准
    for (const it of instances) {
      if (!isRenderableInstance(it)) continue; // 过滤 bed 伴奏行 / 非三声部 / judgable:false
      if (!this.tracks.includes(it.track)) continue;
      const b = beatsToJudge(it, nowSec, view); // ← 与上层 WorldLayer 同一个函数
      if (!isBeatsVisible(b)) continue;
      const x = beatOffsetX(view, b);
      if (x < -size || x > view.width + size) continue;
      const dead = it.state === 'judged' || it.state === 'expired';
      const alpha = dead ? ALPHA.markerExpired : spawnFadeAlpha(b);
      if (alpha <= 0) continue;
      drawMarker(g, {
        track: it.track,
        x,
        y: laneY(it.track, view),
        size,
        core: !!it.core,
        alpha,
        hollow: it.state === 'revived'
      });
      this.stats.markers++;
    }
  }

  /** W-12：假节拍标记（空心菱形 + 故障偏移。**不进判定队列**，见 TIM-04） */
  drawGhostMarkers(g, view, nowBeat) {
    let glitchUsed = 0;
    for (const gh of this.ghosts) {
      const x = beatX(view, gh.beat + gh.offsetBeats, nowBeat);
      if (x < 0 || x > view.width) continue;
      const wantGlitch = gh.glitch !== false && glitchUsed < TIMELINE_CFG.ghostGlitchMax;
      if (wantGlitch) glitchUsed++;
      drawGhost(g, view, x, gh, nowBeat, wantGlitch);
      this.stats.ghosts++;
    }
  }

  /** 判定线：x = 上层同一 x（纪律 2）。连击 ≥10 的金边留给 W-07（DIS-09）。 */
  drawJudgeLine(g, view, frame = {}) {
    const r = bandRect(view);
    const w = view.sizes.judgeLineWidth;
    const comboGold = frame.combo != null && frame.combo >= 10;
    const color = comboGold ? COLORS.bass.int : COLORS.system.int;
    g.lineStyle(w, color, 0.95);
    g.lineBetween(view.judgeX, r.y + r.h * 0.04, view.judgeX, r.y + r.h * 0.96);
    // 线底三角：指示「在这里踩」
    const s = Math.max(6, view.sizes.judgeLineWidth * 3);
    g.fillStyle(color, 0.85);
    g.fillPoints(
      [
        { x: view.judgeX - s, y: r.y + r.h * 0.02 },
        { x: view.judgeX + s, y: r.y + r.h * 0.02 },
        { x: view.judgeX, y: r.y + r.h * 0.02 + s * 1.3 }
      ],
      true
    );
  }

  /** W-06 v0：到线瞬间的闪现竖虚线（alpha 由拍长衰减，不用 tween） */
  drawAlignDash(g, view, nowSec) {
    const a = alignDashAlpha(this.alignTriggerSec, nowSec, view);
    if (a <= 0) return false;
    const r = bandRect(view);
    const step = Math.max(6, view.pxPerBeat * 0.06);
    g.lineStyle(Math.max(1, view.designScale * 2), COLORS.system.int, a * 0.9);
    for (let y = view.zones.worldBottom; y < r.y + r.h; y += step * 2) {
      g.lineBetween(view.judgeX, y, view.judgeX, Math.min(y + step, r.y + r.h));
    }
    return true;
  }

  /** 供 Node 断言：整带的一次性快照 */
  snapshot(frame) {
    const view = resolveView(frame.view);
    const nowBeat = timeToBeatOf(view, Number(frame.nowSec));
    return {
      judgeX: timelineJudgeX(view),
      pxPerBeat: timelinePxPerBeat(view),
      pxPerSec: pxPerSecOf(view),
      windowRightX: windowRightX(view),
      band: bandRect(view),
      lanes: Object.fromEntries(this.tracks.map((t) => [t, laneY(t, view)])),
      markerXs: (frame.instances || [])
        .filter((i) => isRenderableInstance(i) && this.tracks.includes(i.track) && isBeatVisible(i.beat, nowBeat))
        .map((i) => ({ id: i.id, track: i.track, x: beatX(view, i.beat, nowBeat) }))
    };
  }
}

// ---------------------------------------------------------------------------
// 3 · 单元绘制（形状通道与上层共用 Obstacle.drawTrackShape → 永不分叉）
// ---------------------------------------------------------------------------

/** 泳道集合归一化：只允许三声部（bed 伴奏行、拼写错误一律剔除 → laneY 永不抛错） */
function sanitizeTracks(tracks) {
  const list = Array.isArray(tracks) && tracks.length ? tracks : TRACKS;
  return list.filter((t) => TRACKS.includes(t));
}

function drawMarker(g, { track, x, y, size, core, alpha, hollow }) {
  drawTrackShape(g, { track, cx: x, cy: y, size, core, alpha, hollow });
}

/** 声部图例（道首小形状，静止不动，帮玩家建立「形状=声部」的映射） */
function drawLegend(g, track, view, x, y) {
  const size = Math.max(4, timelineMarkerSize(view) * 0.34);
  drawTrackShape(g, { track, cx: x, cy: y, size, core: false, alpha: ALPHA.legend, stroke: false });
}

/** 假节拍标记：空心 + 轻微故障横移，用系统色（**绝不用声部色**，避免被误读成真事件） */
function drawGhost(g, view, x, gh, nowBeat, glitch) {
  const size = timelineMarkerSize(view) * 0.42;
  const y = view.lanes.timelineMidY;
  const jitter = glitch ? Math.sin((nowBeat + gh.beat) * 6.1) * size * 0.22 : 0;
  const pts = [
    { x: x + jitter, y: y - size },
    { x: x + size * 0.7 + jitter, y },
    { x: x + jitter, y: y + size },
    { x: x - size * 0.7 + jitter, y }
  ];
  g.lineStyle(Math.max(1, view.designScale * 1.5), COLORS.system.int, glitch ? 0.75 : 0.4);
  g.strokePoints(pts, true);
  if (glitch) {
    g.lineStyle(Math.max(1, view.designScale), COLORS.white.int, 0.3);
    g.lineBetween(x - size * 1.6, y + size * 0.5, x + size * 1.6, y + size * 0.5);
  }
}

/** 形状通道表（导出给断言，值来自 theme.SHAPE_BY_TRACK，不另立一份） */
export const TIMELINE_SHAPES = SHAPE_BY_TRACK;
export const TIMELINE_MARKER_COLORS = {
  kick: markerColor('kick'),
  bass: markerColor('bass'),
  synth: markerColor('synth')
};

export default Timeline;
