// src/game/objects/Player.js — Owner: WORLD（W-03）
// 角色表现：自动奔跑、固定高度跳（滞空按拍）、冲刺（0.35 拍 + 无敌帧）、微调、受击。
//
// ★ 纪律 2 的落地点：**角色的屏幕 x 恒等于下层判定线 x = 0.30W**（fixedX）。
//   冲刺不移动角色本体，只画一段「前倾 + 回位」的表现位移（dashOffsetX 首尾为 0），
//   因为一旦角色离开判定线，上下层对齐虚线（TIM-03）与双读谱承诺同时失效。
// ★ 纪律 1：跳跃/冲刺/受击的位移都是 (nowSec − 动作起始时刻) 的纯函数，
//   没有 velocity、没有 dt 累加、没有 scene.time。掉帧或暂停回来仍在正确高度。
// ★ T2：本文件不判断命中、不算窗口、不碰 hp。动作「对不对」是 CORE 的 JudgeSystem（C2 JDG-07），
//   「什么时候该跳」由 CORE 的事件/输入驱动（这里只接受 atSec）。
// 不 import Phaser、不 import 时钟 → 可在 Node 直接断言（tools/screenshotCheck.mjs render:jumparc）。

import { COLORS, MOTION, alphaOf, resolveView } from '../../data/theme.js';
import { FROZEN, jumpKinematics, jumpOffset } from '../../data/physics.js';

export const PLAYER_STATES = ['run', 'jump', 'dash', 'hit'];

/**
 * 微调（PRD PLR-05 的小碎步）表现参数：**纯表现**，不参与任何判定，
 * 高度与时长都以 jumpPeakH / 拍长为基准缩放（变速关自动跟随）。
 * T16 审美候选（默认最保守 = micro 档 1）：
 *   1 档：峰值 0.18× 跳高、滞空 0.35 拍（几乎只是脚尖一点，最不容易被误读成「能上平台」）
 *   2 档：0.28× / 0.5 拍
 *   3 档：0.40× / 0.65 拍
 */
export const MICRO_CANDIDATES = [
  { label: '轻点（默认）', peakRatio: 0.18, airBeats: 0.35 },
  { label: '明显', peakRatio: 0.28, airBeats: 0.5 },
  { label: '夸张', peakRatio: 0.4, airBeats: 0.65 }
];
export const MICRO_DEFAULT = 0;

/** 受击闪烁的拍系数（表现，不驱动逻辑；无敌帧本身归 physics.FROZEN.invulnSec） */
export const HIT_FLASH_BEATS = MOTION.shakeBeats;

/** ★ 角色固定 x = 判定线 x（纪律 2 的唯一实现处） */
export function fixedX(view) {
  return resolveView(view).judgeX;
}

/** 角色尺寸（高 = 0.075H，宽按 PRD 34×56 比例） */
export function playerSize(view) {
  const v = resolveView(view);
  return { w: v.sizes.player.w, h: v.sizes.player.h };
}

function physicsView(view) {
  const v = resolveView(view);
  return { w: v.width, h: v.height };
}

/**
 * 跳跃的离地高度（px，向上为正）。对称抛物线：v0 = 4h/T，g = 8h/T²（physics K-04 冻结式）。
 * 滞空时长 = jumpAirBeats × 拍长（L-03：拍长系数，不是秒）。
 * @param {object} view  theme.buildView 的产物或 {width,height}
 * @param {number} nowSec  clock.now()
 * @param {number} jumpStartSec  起跳的绝对时刻
 * @param {number} [beatSec] 覆盖拍长（缺省取 view.beatSec）
 * @param {number} [peakRatio] 峰值系数（1 = 满跳；微调传 MICRO_CANDIDATES[*].peakRatio）
 * @param {number} [airBeats] 滞空拍数（缺省 = FROZEN.jumpAirBeats）
 */
export function jumpOffsetY(view, nowSec, jumpStartSec, beatSec, peakRatio = 1, airBeats = FROZEN.jumpAirBeats) {
  const v = resolveView(view);
  const b = Number.isFinite(beatSec) ? beatSec : v.beatSec || 0.5;
  const airSec = airBeats * b;
  const t = Number(nowSec) - Number(jumpStartSec);
  if (!(airSec > 0) || !Number.isFinite(t) || t <= 0 || t >= airSec) return 0;
  const kin = jumpKinematics(physicsView(v), b);
  if (peakRatio === 1 && airBeats === FROZEN.jumpAirBeats) return jumpOffset(kin, t);
  // 微调档：同一条抛物线按峰值/时长按例缩放（保证 t=0 与 t=air 处仍为 0）
  const scaled = { ...kin, airSec: airSec, v0: (4 * kin.peakH * peakRatio) / airSec, g: (8 * kin.peakH * peakRatio) / (airSec * airSec) };
  return jumpOffset(scaled, t);
}

/** 滞空时长（秒），给 CORE/DebugPanel 用同一口径 */
export function jumpAirSecOf(view, beatSec) {
  const v = resolveView(view);
  return FROZEN.jumpAirBeats * (Number.isFinite(beatSec) ? beatSec : v.beatSec || 0.5);
}

/**
 * 冲刺的表现位移（px，向右为正）。0.35 拍里「前倾 dashDist(0.12W) 再回位」：
 * 中点 = 满位移，首尾严格为 0 → 角色不会漂出判定线（纪律 2）。
 */
export function dashOffsetX(view, nowSec, dashStartSec, beatSec) {
  const v = resolveView(view);
  const b = Number.isFinite(beatSec) ? beatSec : v.beatSec || 0.5;
  const dur = FROZEN.dashDurBeats * b;
  const u = dur > 0 ? (Number(nowSec) - Number(dashStartSec)) / dur : NaN;
  if (!Number.isFinite(u) || u <= 0 || u >= 1) return 0;
  return FROZEN.dashDist * v.width * 4 * u * (1 - u);
}

export class Player {
  /**
   * @param {object} [opts] { micro?:number, onState?:fn, tone?:'luma'|'voice' }
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.microIndex = Number.isInteger(opts.micro) ? opts.micro : MICRO_DEFAULT;
    this.view = resolveView({ width: 1920, height: 1080 });
    /** 动作起点 = 绝对时刻（秒，来自 BeatClock）。只存时刻，不存位移。 */
    this.action = { kind: 'run', atSec: null, durSec: 0 };
    this.hitAtSec = null;
    this.screen = { x: this.view.judgeX, y: this.view.groundY, lift: 0, lean: 0, state: 'run', invuln: false };
    this.legPhaseBeats = MOTION.trailBeats;
  }

  layout(view) {
    this.view = resolveView(view);
    this.screen.x = fixedX(this.view);
    return this;
  }

  /** 当前档的微调参数 */
  micro() {
    return MICRO_CANDIDATES[this.microIndex] || MICRO_CANDIDATES[MICRO_DEFAULT];
  }

  setMicro(i) {
    if (!MICRO_CANDIDATES[i | 0]) throw new Error(`[Player] unknown micro candidate: ${i}`);
    this.microIndex = i | 0;
    return this.micro();
  }

  // ---- 动作入口（由 CORE 的输入/事件驱动，携带绝对时刻） ------------------

  jump(atSec, beatSec) {
    return this._act('jump', atSec, jumpAirSecOf(this.view, beatSec ?? this.view.beatSec));
  }

  dash(atSec, beatSec) {
    const b = Number.isFinite(beatSec) ? beatSec : this.view.beatSec || 0.5;
    return this._act('dash', atSec, FROZEN.dashDurBeats * b);
  }

  /** 微调（PLR-05 的小碎步）：表现档，不改判定、不改 x */
  fine(atSec, beatSec) {
    const m = this.micro();
    const b = Number.isFinite(beatSec) ? beatSec : this.view.beatSec || 0.5;
    return this._act('micro', atSec, m.airBeats * b);
  }

  /** 受击表现（MISS/撞障碍）：CORE 结算后调用；无敌帧长度读 physics 冻结值 */
  hit(atSec) {
    this.hitAtSec = atSec;
    const prev = this.action.kind;
    this.action = { kind: 'hit', atSec, durSec: HIT_FLASH_BEATS * (this.view.beatSec || 0.5) };
    this._notify(prev, 'hit', atSec);
    return this;
  }

  /** 动作自动过期（表现层回收；判定归 CORE） */
  reset(atSec = null) {
    this.action = { kind: 'run', atSec: null, durSec: 0 };
    this.hitAtSec = null;
    void atSec;
    return this;
  }

  _act(kind, atSec, durSec) {
    const prev = this.action.kind;
    this.action = { kind, atSec, durSec };
    this._notify(prev, kind, atSec);
    return this;
  }

  _notify(from, to, atSec) {
    if (from !== to && typeof this.opts.onState === 'function') this.opts.onState({ from, to, atSec });
  }

  // ---- 入口 1：纯几何更新（不碰任何场景对象） ----------------------------

  /** @param {number} nowSec clock.now() */
  update(nowSec, view = null) {
    const v = resolveView(view || this.view);
    this.view = v;
    const a = this.action;
    let lift = 0;
    let lean = 0;
    let state = 'run';
    if (a.atSec != null) {
      const dt = nowSec - a.atSec;
      if (dt >= 0 && dt < a.durSec) {
        if (a.kind === 'jump') {
          lift = jumpOffsetY(v, nowSec, a.atSec);
          state = 'jump';
        } else if (a.kind === 'micro') {
          const m = this.micro();
          lift = jumpOffsetY(v, nowSec, a.atSec, v.beatSec, m.peakRatio, m.airBeats);
          state = 'jump';
        } else if (a.kind === 'dash') {
          lean = dashOffsetX(v, nowSec, a.atSec);
          state = 'dash';
        }
      } else if (a.kind === 'hit' && dt >= 0 && dt < Math.max(a.durSec, FROZEN.invulnSec)) {
        state = 'hit';
      }
    }
    const invuln = this.hitAtSec != null && nowSec - this.hitAtSec < FROZEN.invulnSec;
    this.screen = {
      x: fixedX(v) + lean,
      baseX: fixedX(v),
      y: v.groundY - v.sizes.player.h - lift,
      footY: v.groundY - lift,
      lift,
      lean,
      state,
      invuln
    };
    return this.screen;
  }

  /** 只读探针（断言与 DebugPanel 用；不改状态） */
  probeAt(nowSec, view = null) {
    const v = resolveView(view || this.view);
    const a = this.action;
    let lift = 0;
    let lean = 0;
    let state = 'run';
    if (a.atSec != null) {
      const dt = nowSec - a.atSec;
      if (dt >= 0 && dt < a.durSec) {
        if (a.kind === 'jump' || a.kind === 'micro') {
          const m = a.kind === 'micro' ? this.micro() : { peakRatio: 1, airBeats: FROZEN.jumpAirBeats };
          lift = jumpOffsetY(v, nowSec, a.atSec, v.beatSec, m.peakRatio, m.airBeats);
          state = 'jump';
        } else if (a.kind === 'dash') {
          lean = dashOffsetX(v, nowSec, a.atSec);
          state = 'dash';
        }
      } else if (a.kind === 'hit') state = 'hit';
    }
    return {
      x: fixedX(v) + lean,
      baseX: fixedX(v),
      y: v.groundY - v.sizes.player.h - lift,
      lift,
      lean,
      state
    };
  }

  // ---- 入口 2：渲染（只读 update() 的缓存） ------------------------------

  /**
   * 只画三样：躯干（白）、脚底标记（系统青）、动作附加线。
   * 颜色只用系统双色（纪律 3：声部色是「信息」，角色不许占用）。
   */
  render(g, view = null) {
    const v = resolveView(view || this.view);
    const { w, h } = playerSize(v);
    const s = this.screen.x === null ? this.update(v.beatSec, v) : this.screen;
    const cx = s.x == null ? fixedX(v) : s.x;
    const footY = s.footY == null ? v.groundY : s.footY;
    const bodyY = footY - h;
    const alpha = s.state === 'hit' ? 0.55 + 0.45 * Math.abs(Math.sin(((s.state === 'hit' ? 1 : 0) * Math.PI) / 2)) : 1;

    // 躯干
    g.fillStyle(COLORS.white.int, alphaOf('judgeHead', 1) * alpha);
    g.fillRect(cx - w / 2, bodyY, w, h * 0.72);
    // 头
    g.fillCircle(cx, bodyY - h * 0.16, Math.max(2, h * 0.16));
    // 脚底接触标记（角色 x = 判定线 x 的可视化证据）
    g.lineStyle(Math.max(1, v.designScale * 2), COLORS.system.int, alphaOf('judgeDot', 1) * (s.state === 'dash' ? 1 : 0.75));
    g.lineBetween(cx - w * 0.6, footY, cx + w * 0.6, footY);
    // 冲刺：前倾拖痕（按拍长度表达，不用 tween）
    if (s.state === 'dash' && s.lean > 0) {
      g.lineStyle(Math.max(1, v.designScale * 3), COLORS.system.int, alphaOf('markerJudged', 1));
      for (let k = 1; k <= 3; k++) {
        const x = cx - k * s.lean * 0.35;
        g.lineBetween(x, bodyY + h * 0.18 * k, x - v.pxPerBeat * 0.08, bodyY + h * 0.18 * k);
      }
    }
    // 跳跃：顶点指示（帮助玩家读「固定高度跳」，只画一次短线）
    if (s.state === 'jump' && s.lift > 0) {
      g.lineStyle(Math.max(1, v.designScale), COLORS.white.int, alphaOf('guideLine', 1));
      g.lineBetween(cx - w, v.groundY, cx + w, v.groundY);
    }
    // 无敌帧：外框（受击后仍可读，W-08 复活表现一致性的前置）
    if (s.invuln) {
      g.lineStyle(Math.max(1, v.designScale * 1.5), COLORS.system.int, alphaOf('coreEdge', 1) * 0.6);
      g.strokeRect(cx - w * 0.8, bodyY - h * 0.34, w * 1.6, h * 1.14);
    }
    return true;
  }

  /** 静帧自证 */
  describe() {
    return {
      kind: 'player',
      fixedX: fixedX(this.view),
      judgeX: this.view.judgeX,
      size: playerSize(this.view),
      state: this.action.kind,
      micro: this.micro()
    };
  }
}

export default Player;
