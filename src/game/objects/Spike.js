// src/game/objects/Spike.js — Owner: WORLD (W-04)
// 鼓 · 红 · 三角（OBS-01）：底边贴地面线、顶点朝上的尖刺，读作「按 J 踩碎它」。
// 只做三件事：① 声明自己的声部/形状通道；② 把基类的纯几何换成 PRD §7.5 的 48×40 轮廓；③ 绘制。
// **不算命中、不算窗口、不改 hp**（T2：那是 CORE 的 JudgeSystem / DisassembleSystem）。

import { DERIVED, markerColor, resolveView } from '../../data/theme.js';
import { LEGAL_TRANSITIONS, Obstacle, drawCoreEdge } from './Obstacle.js';

export const SPIKE_TRACK = 'kick';
export const SPIKE_TYPE = 'spike';
export const SPIKE_SHAPE = 'triangle';

/**
 * 尖刺轮廓（纯几何，底边锚在 baseY → 与 anchorY('spike') = groundY 对齐）。
 * @param {number} cx 中心 x（= obstacleScreenX 的结果）
 * @param {number} baseY 底边 y（= 地面线）
 * @param {number} w 宽（PRD 48px@1080p）
 * @param {number} h 高（PRD 40px@1080p）
 * @returns {{x:number,y:number}[]}
 */
export function spikePoints(cx, baseY, w, h) {
  return [
    { x: cx - w / 2, y: baseY },
    { x: cx, y: baseY - h },
    { x: cx + w / 2, y: baseY }
  ];
}

/** 玩家可读性辅助：尖刺的「需要起跳的拍」= 它自己的拍（不做任何判定） */
export function spikeTakeoverHint(instance) {
  return { beat: instance.beat, timeSec: instance.timeSec, action: 'jump' };
}

export class Spike extends Obstacle {
  constructor(instance, opts = {}) {
    super(instance, opts);
    if (this.track !== SPIKE_TRACK) {
      throw new Error(`[Spike] instance ${instance.id} track=${this.track}，尖刺只属于 kick`);
    }
    this.shape = SPIKE_SHAPE;
    // 终态不可回退（pending→revived 非法）已写在基类表里，这里只做一次自检暴露给断言
    this.legalTargets = LEGAL_TRANSITIONS[this.state] || [];
  }

  /** 世界层尺寸口径：PRD §7.5 的 48×40（按高度缩放） */
  sizeOf(view) {
    const v = resolveView(view);
    return { w: v.sizes.spike.w, h: v.sizes.spike.h };
  }

  /** 顶点 y（供 Player 的包络/受击表现查询，纯几何） */
  apexY(view) {
    const v = resolveView(view);
    return this.screen.y - this.sizeOf(v).h;
  }

  /** 渲染入口（只读 update() 写好的 this.screen；不产生任何状态迁移） */
  render(g, view = null) {
    if (!this.screen.onScreen || this.screen.alpha <= 0) return false;
    const v = resolveView(view || { width: 1920, height: 1080 });
    const { w, h } = this.sizeOf(v);
    const pts = spikePoints(this.screen.x, this.screen.y, w, h);
    const fill = markerColor(this.track);
    const alpha = this.screen.alpha;

    // 1) 本体：声部色（明度通道由 theme.TONE_BY_TRACK 决定，灰度化后仍可辨）
    g.fillStyle(fill, alpha);
    g.fillPoints(pts, true);
    // 2) 描边：同色相（提亮由 markerColor 的 tone 负责），加强形状通道
    g.lineStyle(Math.max(1, v.designScale * 2), fill, Math.min(1, alpha * 0.9));
    g.strokePoints(pts, true);
    // 3) 底座阴影：消色差派生色，不引入新色相（纪律 3）
    g.fillStyle(DERIVED.divider.int, alpha * 0.55);
    g.fillRect(this.screen.x - w / 2, this.screen.y, w, Math.max(1, 3 * v.designScale));
    // 4) 核心节点（OBS-05）：白描边 + 内点；非核心不给这层
    if (this.core) drawCoreEdge(g, pts, h * 0.5, alpha);
    return true;
  }

  /** 静帧（未进入主循环时）自证用：返回当前该画什么，不画 */
  describe() {
    return {
      id: this.id,
      kind: 'spike',
      colorChannel: 'kick',
      shapeChannel: SPIKE_SHAPE,
      lumaChannel: markerColor(this.track),
      core: this.core,
      state: this.state
    };
  }
}

/** 方便断言与调试：把一组实例映射成 Spike 列表（不做任何合法性放宽） */
export function spikesFrom(instances, opts = {}) {
  return (instances || []).filter((i) => i.track === SPIKE_TRACK).map((i) => new Spike(i, opts));
}

export default Spike;
