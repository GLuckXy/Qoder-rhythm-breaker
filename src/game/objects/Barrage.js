// src/game/objects/Barrage.js — Owner: WORLD（W-10 / W-11 的一部分）
// 合成器 · 品红 · 六边形弹幕核心 + 弹幕网（OBS-01/OBS-04）。
//
// 三件事：① 网的几何（行、间隙、孔位、核心尺寸）全部是 view 的纯函数，并且把
//   「间隙 ≥ 2.2 × 角色高」这条硬门限做成可断言的数（render:gap）；
//   ② 时值 → 速度档：C4 的 instance.speed 是 SOUND 用 durToSpeed 映射好的，
//   WORLD 只消费它，**不自己重排 pattern**（C5）。本文件的 speedForDur 只为离线预览/自检复刻同一张表，
//   并由 tools/screenshotCheck.mjs 逐值比对 SOUND 的实现，防止两套映射漂移；
//   ③ 形状通道与下层时间轴共用 drawTrackShape 的 hexagon → 灰度化后仍分得清（L-08）。
//
// 弹幕带的位置纪律：整张网挂在「地面线上方 2.2× 角色高」的带上（Obstacle.worldYFor('synth')），
//   所以**站立跑动永远碰不到它** → 「必须冲刺穿越」在画面语法上为真；
//   网的最低一条横线也要高过站立角色的头顶（netGeometry 的 headroom 项），否则会被读成「站着也能撞」。
//
// **不算命中、不算窗口、不改 hp**（T2）。纪律 1：横线 x 由 screen.x（拍域纯函数）+ 拍间距推出，
//   没有速度积分；速度档只影响**网的疏密与拖尾强度**这类表现，不改 x 的拍位含义。

import { ALPHA, BACKGROUND_CFG, COLORS, MARKER_TONE_MODE_DEFAULT, alphaOf, markerColor, resolveView } from '../../data/theme.js';
import { Obstacle, drawCoreEdge, drawTrackShape, shapePoints, worldYFor } from './Obstacle.js';

export const BARRAGE_TRACK = 'synth';
export const BARRAGE_TYPE = 'barrage';
export const BARRAGE_SHAPE = 'hexagon';

/** C5 缺省的速度档（与 SOUND 的 durToSpeed 缺省表一致：cuts [0.4,0.75] → outs [1.35,1.0,0.75]） */
export const SPEED_CUTS = [0.4, 0.75];
export const SPEED_LEVELS = [1.35, 1.0, 0.75];

/** 网的默认行数（≥2 是 DoD：单行不成「网」） */
export const NET_ROWS_DEFAULT = 2;
/** 孔位横间距 = N 拍（按拍不按秒 → 变速关疏密自动跟随） */
export const NET_HOLE_BEATS = 1;

/** 间隙硬门限：2.2 × 角色高（physics.AUX.barrageGapRatio 同值，由 render:gap 锁死） */
export function gapMinPx(view) {
  const v = resolveView(view);
  return v.sizes.charH * BACKGROUND_CFG.gapToCharH;
}

/** 核心（六边形）边长口径：PRD §7.5 的 56×56 @1080p */
export function coreSize(view) {
  const v = resolveView(view);
  return { w: v.sizes.barrage.w, h: v.sizes.barrage.h };
}

/**
 * 时值（拍）→ 速度档。语义与 SOUND 完全一致：时值越短 = 网越密 = 穿越越快。
 * ★ 运行时优先用 instance.speed（SOUND 已映射），本函数只服务离线预览与自检。
 */
export function speedForDur(durBeats, cuts = SPEED_CUTS, outs = SPEED_LEVELS) {
  const c = Array.isArray(cuts) && cuts.length >= 2 ? cuts : SPEED_CUTS;
  const o = Array.isArray(outs) && outs.length >= 3 ? outs : SPEED_LEVELS;
  const d = Number.isFinite(durBeats) ? durBeats : 1;
  return d <= c[0] ? o[0] : d <= c[1] ? o[1] : o[2];
}

/**
 * 弹幕网几何（纯函数，可在 Node 断言）。
 * @param {object} view
 * @param {{dur?:number, core?:boolean, rows?:number, lane?:number|null}} [opts]
 * @returns {{rows:number, gap:number, gaps:number[], rowCenters:number[], center:number,
 *            bandBottomY:number, bandTopY:number, coreSize:number, headroomOk:boolean,
 *            holeEveryPx:number, holes:Array<{row:number, dx:number}>, speed:number,
 *            strandHalfPx:number, density:number}}
 */
export function netGeometry(view, opts = {}) {
  const v = resolveView(view);
  const dur = Number.isFinite(opts.dur) ? opts.dur : 1;
  const speed = speedForDur(dur);
  const gap = gapMinPx(v);
  const cs = coreSize(v).w;
  const center = worldYFor(BARRAGE_TRACK, v);
  const worldTop = v.zones.worldTop;
  // 可用高度：中心向上到世界带顶（留出核心半径），向下到「站立角色头顶」
  const headTop = v.groundY - v.sizes.charH;
  const upRoom = center - cs / 2 - (worldTop + cs / 2);
  const maxRows = 2 + Math.floor(Math.max(0, upRoom) / gap);
  const rows = Math.max(2, Math.min(opts.rows == null ? NET_ROWS_DEFAULT : opts.rows, maxRows));
  const rowCenters = [];
  for (let i = 0; i < rows; i++) rowCenters.push(center - i * gap);
  const gaps = [];
  for (let i = 1; i < rows; i++) gaps.push(rowCenters[i - 1] - rowCenters[i]);
  const bandBottomY = center + cs / 2;
  const bandTopY = rowCenters[rows - 1] - cs / 2;
  const holeEveryPx = v.pxPerBeat * NET_HOLE_BEATS;
  const holes = [];
  for (let r = 0; r < rows; r++) {
    // 每行的孔位错开半个间距 → 网眼呈交错（交错量按拍，仍是拍域量）
    const phase = (r % 2) * holeEveryPx * 0.5;
    for (let k = -1; k <= 1; k++) holes.push({ row: r, dx: phase + k * holeEveryPx });
  }
  return {
    rows,
    gap,
    gaps,
    rowCenters,
    center,
    bandBottomY,
    bandTopY,
    coreSize: cs,
    // 网的最低边必须高过站立角色头顶（否则「站着也能撞」的误读会成立）
    headroomOk: bandBottomY <= headTop + 1e-6,
    headTopY: headTop,
    holeEveryPx,
    holes,
    speed,
    strandHalfPx: holeEveryPx * 0.5,
    /** 网眼密度（越快越密）：用于横线粗细/拖尾强度，不改任何拍位 */
    density: 1 / speed
  };
}

export class Barrage extends Obstacle {
  constructor(instance, opts = {}) {
    super(instance, opts);
    if (this.track !== BARRAGE_TRACK) {
      throw new Error(`[Barrage] instance ${instance.id} track=${this.track}，弹幕只属于 synth`);
    }
    this.shape = BARRAGE_SHAPE;
    /** SPEED_LEVELS 之外的自定义档（缺省用 SOUND 给的 instance.speed） */
    this.speed = Number.isFinite(instance.speed) && instance.speed > 0 ? instance.speed : 1;
    /** CR-07 的可选 lane：未 APPROVE 前不作为依据，缺省落中间行 */
    this.lane = Number.isInteger(instance.lane) ? instance.lane : null;
  }

  glyphSize(view) {
    return coreSize(resolveView(view)).w / 2;
  }

  /** 核心中心 y（默认在带的基准行；lane 给了就往上下偏移一行） */
  anchorY(view) {
    const v = resolveView(view);
    const base = worldYFor(BARRAGE_TRACK, v);
    if (this.lane == null) return base;
    const net = netGeometry(v, { dur: 1 });
    const idx = Math.max(0, Math.min(net.rows - 1, this.lane));
    return net.rowCenters[net.rows - 1 - idx];
  }

  outline(view) {
    const v = resolveView(view);
    return shapePoints(BARRAGE_SHAPE, this.screen.x, this.anchorY(v), this.glyphSize(v));
  }

  /**
   * 渲染：1) 网横线（交错孔位，按拍间距）；2) 六边形核心（与下层同一形状函数）；
   * 3) 核心节点加白描边 + 内点（W-11：非核心没有这层）。
   * 横线全部相对 screen.x 定位 → 掉帧后仍在正确拍位（纪律 1）。
   */
  render(g, view = null) {
    if (!this.screen.onScreen || this.screen.alpha <= 0) return false;
    const v = resolveView(view || { width: 1920, height: 1080 });
    const net = netGeometry(v, { dur: 1, rows: this.lane == null ? NET_ROWS_DEFAULT : undefined });
    const s = this.glyphSize(v);
    const cy = this.anchorY(v);
    const alpha = this.screen.alpha;
    const lineW = Math.max(1, v.designScale * (0.75 + 0.5 * this.speed));

    // ① 网：只在核心所在行画穿过线，其它行画淡底（层数由 netGeometry 决定）
    for (let r = 0; r < net.rows; r++) {
      const y = net.rowCenters[r];
      const onCoreRow = Math.abs(y - cy) < net.gap * 0.5;
      const tone = onCoreRow ? ALPHA.barLine : ALPHA.guideLine;
      g.lineStyle(lineW, COLORS.system.int, alphaOf(onCoreRow ? 'barLine' : 'guideLine', 1) * alpha);
      // 孔位之间才画线（画出「网眼」而不是实心栅栏）
      for (const hole of net.holes) {
        if (hole.row !== r) continue;
        const x0 = this.screen.x + hole.dx - net.strandHalfPx * 0.55;
        const x1 = this.screen.x + hole.dx + net.strandHalfPx * 0.55;
        if (Math.max(x0, x1) < 0 || Math.min(x0, x1) > v.width) continue;
        g.lineBetween(x0, y, x1, y);
      }
      void tone;
    }

    // ② 核心：六边形（形状通道 + 明度通道，灰度可辨）
    const pts = drawTrackShape(g, {
      track: BARRAGE_TRACK,
      cx: this.screen.x,
      cy,
      size: s,
      core: false,
      alpha,
      tone: this.tone
    });

    // ③ 核心节点辨识（W-11）：白描边 + 内点；非核心只留一个淡外框
    if (this.core) drawCoreEdge(g, pts, s, alpha);
    else {
      g.lineStyle(Math.max(1, v.designScale), COLORS.white.int, alphaOf('markerExpired', 1) * alpha);
      g.strokePoints(pts, true);
    }
    return true;
  }

  /** 静帧自证 */
  describe() {
    return {
      id: this.id,
      kind: BARRAGE_TYPE,
      track: BARRAGE_TRACK,
      speed: this.speed,
      lane: this.lane,
      colorChannel: markerColor(BARRAGE_TRACK, MARKER_TONE_MODE_DEFAULT),
      shapeChannel: BARRAGE_SHAPE,
      core: this.core,
      state: this.state
    };
  }

  toJSON() {
    return { ...super.toJSON(), speed: this.speed, lane: this.lane };
  }
}

/** 批量：把 synth 实例映射成 Barrage */
export function barragesFrom(instances, opts = {}) {
  return (instances || [])
    .filter((i) => i && i.track === BARRAGE_TRACK)
    .map((i) => new Barrage(i, opts));
}

export default Barrage;
