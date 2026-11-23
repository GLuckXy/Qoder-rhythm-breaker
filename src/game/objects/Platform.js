// src/game/objects/Platform.js — Owner: WORLD（W-09）
// 贝斯 · 黄 · 横条平台（OBS-01/OBS-04）：三档高度 + 核心落点 + 可达性自检。
//
// 只做三件事：① 把 CORE 冻结的三档高度（physics.FROZEN.platformTiers = 0.10/0.16/0.21 × H）
//   换算成世界层 y；② 用与下层时间轴**同一个** drawTrackShape 画「横条」形状（L-08 形状通道不分叉）；
//   ③ 把「这一档跳不跳得到」做成可断言的纯函数，交给 tools/screenshotCheck.mjs 的 render:tierReach。
//
// **不算命中、不算窗口、不改 hp**（T2）：是否踩到 = CORE 的 JudgeSystem（C2 Judgment），
//   耐久 = DisassembleSystem（C3）。本文件只读 instance.pitchTier / instance.core。
// 纪律 1：位置来自 Obstacle 的拍域纯函数（x = judgeX + (beat − nowBeat) × pxPerBeat），
//   这里没有一帧的累积量；y 只由 (track, pitchTier, view) 决定 → 与时间无关。
// 纪律 2：判定线 x / pxPerBeat 一律取自 view，不改值。
// 纪律 3：颜色只从 theme 取（markerColor / COLORS / ALPHA）；平台只用 bass 一支。

import { BACKGROUND_CFG, COLORS, MOTION, VIEW_RATIOS, alphaOf, markerColor, resolveView } from '../../data/theme.js';
import { Obstacle, drawCoreEdge, drawTrackShape, shapePoints, worldYFor } from './Obstacle.js';

export const PLATFORM_TRACK = 'bass';
export const PLATFORM_TYPE = 'platform';
export const PLATFORM_SHAPE = 'platformBar';

/**
 * 三档高度比例（**引用 theme.VIEW_RATIOS.platformTiers**，它与 physics.FROZEN.platformTiers 同值，
 * 由 render:physics 逐条锁死；这里不再抄第三份数字）。
 */
export const PLATFORM_TIERS = VIEW_RATIOS.platformTiers;

/** 越界的档位号夹到 0..2（生成侧给 3 也不能崩，但要能在 DebugPanel 看出来） */
export function clampTier(tier) {
  return Math.max(0, Math.min(PLATFORM_TIERS.length - 1, Number(tier) | 0));
}

/** 第 tier 档的**板顶面** y = 地面线 − 比例 × H（与 CORE 的 physics.platformTopY 同一个数）。 */
export function tierTopY(view, tier = 1) {
  const v = resolveView(view);
  return v.groundY - v.height * PLATFORM_TIERS[clampTier(tier)];
}

/** 板体尺寸（PRD §7.5 的 120×24 @1080p，按 designScale 缩放） */
export function platformSlab(view) {
  const v = resolveView(view);
  return { w: v.sizes.platform.w, h: v.sizes.platform.h };
}

/**
 * 形状通道的参考半径：platformBar 多边形宽 = 3s、高 = 0.6s，
 * 取 s = 板宽/3 → 宽恰为 120、高恰为 24（与 physics.AUX.sizes.platform 同值）。
 */
export function platformGlyphSize(view) {
  return platformSlab(view).w / 3;
}

/** 板中心 y（形状按中心画，顶面 = anchorY） */
export function tierCenterY(view, tier = 1) {
  const { h } = platformSlab(view);
  return tierTopY(view, tier) + h / 2;
}

/**
 * 板下方的通行净空（角色跑动时会不会头撞到板）。
 * = 地面线 − (板底) = groundY − (top + 板厚)。低档（0.10H）是最紧的一档。
 */
export function netClearancePx(view, tier = 0) {
  const v = resolveView(view);
  const { h } = platformSlab(v);
  return v.groundY - (tierTopY(v, tier) + h);
}

/** 该档净空是否容得下一个站立体（背景档里的下限常数，与弹幕的 2.2× 是两套门限） */
export function tierClearanceOk(view, tier = 0) {
  const v = resolveView(view);
  return netClearancePx(v, tier) >= v.sizes.charH * BACKGROUND_CFG.tierClearanceMinChars - 1e-6;
}

/**
 * 跳跃可达包络（W-09 的「三档都可达」论证，也是提 CR 时附的那份计算）：
 * 固定高度跳的峰值 = jumpPeakH(0.20H)，角色站上板需要峰值 ≥ 板高；
 * 再加半身高余量（脚底对齐允许误差）后与 physics.selfTest 的 reachPx 同式。
 * @returns {{peakPx:number, reachPx:number, tiers:Array<{tier:number, risePx:number, reachable:boolean, marginPx:number}>}}
 */
export function reachEnvelope(view) {
  const v = resolveView(view);
  const peakPx = v.height * v.ratios.jumpPeakH;
  const reachPx = peakPx + v.sizes.charH / 2;
  const tiers = PLATFORM_TIERS.map((r, tier) => {
    const risePx = v.height * r;
    return { tier, risePx, reachable: risePx <= reachPx + 1e-6, marginPx: reachPx - risePx };
  });
  return { peakPx, reachPx, tiers, ok: tiers.every((t) => t.reachable) };
}

/**
 * 核心落点 x（OBS-05 的视觉承诺：核心平台的「该踩的那一点」就在判定线上）。
 * 判定本身归 CORE，这里只是把落点画出来给玩家对齐用。
 */
export function coreLandingX(view) {
  return resolveView(view).judgeX;
}

/** 落点提示的驻留跨度（拍）：到线后仍在判定线上留 MOTION.coreFlashBeats 的一记高亮 */
export function landingHoldBeats() {
  return MOTION.coreFlashBeats;
}

export class Platform extends Obstacle {
  constructor(instance, opts = {}) {
    super(instance, opts);
    if (this.track !== PLATFORM_TRACK) {
      throw new Error(`[Platform] instance ${instance.id} track=${this.track}，平台只属于 bass`);
    }
    this.shape = PLATFORM_SHAPE;
    this.pitchTier = clampTier(instance.pitchTier);
  }

  /** 档位（生成侧 pitchTier 夹过后恒为 0/1/2） */
  tier() {
    return this.pitchTier;
  }

  /** 板顶面 y —— 角色落上去时脚底就在此处（与 Obstacle.worldYFor('bass') 严格同值） */
  anchorY(view) {
    const v = resolveView(view);
    return worldYFor(PLATFORM_TRACK, v, { pitchTier: this.pitchTier });
  }

  /** 参考半径（基类的 render/剪影与 screenshotCheck 都读这个） */
  glyphSize(view) {
    return platformGlyphSize(view);
  }

  /** 板顶面 y（等价于 anchorY，命名上给读代码的人一个提醒） */
  topY(view) {
    return this.anchorY(view);
  }

  /** 顶点数与面积可断言（形状通道：横条 = 4 顶点） */
  outline(view) {
    const v = resolveView(view);
    const s = this.glyphSize(v);
    return shapePoints(PLATFORM_SHAPE, this.screen.x, this.anchorY(v) + platformSlab(v).h / 2, s);
  }

  /**
   * 渲染入口（只读 update() 写好的缓存；不产生状态迁移）。
   * 1) 板体 = 与下层同一个 platformBar 多边形（颜色含明度通道）→ 灰度可辨；
   * 2) 顶面高光线 = 系统白（低 alpha，不新增色相）→ 告诉玩家「落脚的是这一面」；
   * 3) 核心板加白描边 + 内点（OBS-05，非核心不给这层）。
   */
  render(g, view = null) {
    if (!this.screen.onScreen || this.screen.alpha <= 0) return false;
    const v = resolveView(view || { width: 1920, height: 1080 });
    const slab = platformSlab(v);
    const s = this.glyphSize(v);
    const cy = this.anchorY(v) + slab.h / 2;
    const pts = drawTrackShape(g, {
      track: PLATFORM_TRACK,
      cx: this.screen.x,
      cy,
      size: s,
      core: false,
      alpha: this.screen.alpha,
      tone: this.tone
    });
    // 顶面：一条更亮的水平短线（消色差，只是 alpha 层次）
    g.lineStyle(Math.max(1, v.designScale * 2), COLORS.white.int, alphaOf('judgeDot', 1) * this.screen.alpha);
    g.lineBetween(this.screen.x - slab.w / 2, this.anchorY(v), this.screen.x + slab.w / 2, this.anchorY(v));
    if (this.core) {
      drawCoreEdge(g, pts, s, this.screen.alpha);
      // 核心落点对齐短线：判定线右侧 0.35 拍处（= 到线前的一记预备提示），仍按拍不按秒
      const tick = this.screen.x - v.pxPerBeat * landingHoldBeats();
      g.lineStyle(Math.max(1, v.designScale), COLORS.system.int, alphaOf('guideLine', 1) * this.screen.alpha);
      g.lineBetween(tick, this.anchorY(v) - s * 0.5, tick, this.anchorY(v) + s * 0.5);
    }
    return true;
  }

  /** 静帧自证（截图断言与 DebugPanel 用，不画任何东西） */
  describe() {
    return {
      id: this.id,
      kind: PLATFORM_TYPE,
      track: PLATFORM_TRACK,
      tier: this.pitchTier,
      colorChannel: markerColor(PLATFORM_TRACK, this.tone),
      shapeChannel: PLATFORM_SHAPE,
      core: this.core,
      state: this.state
    };
  }

  toJSON() {
    return { ...super.toJSON(), tier: this.pitchTier, topY: this.screen.y };
  }
}

/** 批量：把 bass 实例映射成 Platform（不给非法放宽） */
export function platformsFrom(instances, opts = {}) {
  return (instances || [])
    .filter((i) => i && i.track === PLATFORM_TRACK)
    .map((i) => new Platform(i, opts));
}

export default Platform;
