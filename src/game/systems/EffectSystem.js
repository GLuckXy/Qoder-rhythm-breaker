// src/game/systems/EffectSystem.js — Owner: WORLD（W-07 拆解演出 v1 / W-08 复活表现 / W-11 的演出侧）
//
// ★ 本作的情绪支点。PRD §7.4 表「hp 归 0 → 停止 + 在场碎裂 → 降饱和 + 大字」、
//   DIS-04「三者同帧触发，慢放截图可证」、支柱 1「越玩越薄」。
//
// ───────────────────────── 对外接口（CORE 的接线面） ─────────────────────────
//   import EffectSystem from '../systems/EffectSystem.js';
//   const fx = new EffectSystem({ quality: 'quiet' });   // 不 import Phaser，Node 里可直接 import
//   fx.layout(view);                                     // 可选；不传则第一次事件时按 view 参数建
//
//   // A. 事件入口（**同帧**：一次调用 = 三要素同时起跑，见 _open()）
//   fx.onDisassemble({ track:'kick', atSec }, nowSec, view)      → {shatter, desaturate, bigText, bloom}
//   fx.onRevive({ track:'kick', ids:[...], atSec }, nowSec, view)→ {revive}
//   fx.onHpChange({ track:'kick', hp:2, atSec }, nowSec, view)   → {tap}
//   fx.onJudgment(judgment, nowSec, view)                        → {burst, flash, vignette, shake} | null
//   fx.onAction({kind:'jump'|'dash', atSec}, nowSec, view)       → {trail, dust} | null
//   fx.feed(ev, nowSec, view)   // 按 ev.type/kind 分发（C3 'disassemble'/'revive'/'hp-change' 原样可喂）
//   const off = fx.attach(disassembleSystem, clock)              // 便捷：直接订阅 C3 广播（返回取消函数）
//
//   // B. 查询与绘制（纯时间函数：任意顺序、任意次数调用同一 nowSec 得到同一结果）
//   fx.stateAt(nowSec, view) → { nowBeat, desaturate, bigText, shatter, revive, flash, vignette, shake, hitStop, events }
//   fx.draw(g, { nowSec, view, targets? })                       // g = 鸭子类型的 Phaser Graphics
//   fx.shatterTargets? → 由 draw 的 frame.targets 提供（WorldLayer 传在场障碍）
//   fx.liveCount() / fx.probe() / fx.reset() / fx.shutdown()
//
// ★ WorldLayer 已经把它接进 `world.sync(..., {disassembledTracks:['kick']})`，
//   CORE 只要按 C3 原样转发事件即可，**不需要**逐个调用；手动调用同样有效（幂等：同 track 同 atSec 不重复开）。
//
// ───────────────────────── 三条纪律在本文件的落点 ─────────────────────────
// 纪律 1：不读场景时钟、不做速度积分。每个效果都是「触发时刻 + 拍位」的闭式函数：
//         k = (nowBeat − startBeat) / phaseBeats，几何由 k 现算（碎片位置是
//         x0 + dir·spread·ease(k) 的解析式，没有 `x += v*dt`，也没有 tween）。
// 拍长系数（WORLD.md 失败模式 3）：**所有时长的真相是「拍数」**，秒数只在报告用
//         （`sec = beats × beatSec`）。因此第 1 关 @110 与第 6 关 @150 的演出「看起来一样长」，
//         变速关 L4 过渡中的演出用 view.timeToBeat（= clock.beatAt）积分拍位，不会脱钩。
// 上限与审美（T16）：粒子数、bloom、震动幅度、驻留拍数**只从 theme.QUALITY_PRESETS 取**
//         （quiet/standard/vivid 三档，默认 quiet=最保守），代码里不出现一个魔数强度。
// 纪律 3：颜色只从 theme 的 COLORS/DERIVED/markerColor 取。
//
// PRD §15.2 动效清单的取舍（T24：没有数据驱动的就不做）
//   ✅ 拆解三要素（C3 'disassemble'）  ✅ 复活扫回 + hp 回 1（C3 'revive'/'hp-change'）
//   ✅ PERFECT 粒子 + 判定线金闪（C2 grade='PERFECT'）  ✅ MISS 红 vignette + 衰减震动（grade='MISS'）
//   ✅ dash 拖尾 / 落地微尘（extra.action.kind + 拍域滞空）
//   ⛔ 顿帧（frameHold）：本文件只**产出建议值** `stateAt().hitStop`，真正冻结时序要 CORE 在
//      BeatClock/主循环处生效 → 未接线前 quiet/standard 档 preset.frameHoldBeats 决定是否显示，
//      绝不在 WORLD 里偷偷改时间流。
//   ⛔ 角色挤压：Player.js（W-03，前任已交付）自己按拍算形变，此处不重复。

import {
  ALPHA,
  COLORS,
  DEFAULT_QUALITY,
  DERIVED,
  FX_TIMING,
  FONT_TIERS,
  MOTION,
  TRACK_COLOR,
  VOICE_NAME,
  beatOffsetX,
  markerColor,
  quality,
  timeToBeatOf
} from '../../data/theme.js';

export const EFFECT_VERSION = 'R3.0';

/** 事件种类（内部记录用；CORE 不需要传） */
export const FX_KINDS = ['disassemble', 'revive', 'hpTap', 'perfect', 'miss', 'trail', 'dust'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * 确定性伪随机（**不用 Math.random**）：碎片形状是 (seed, i) 的纯函数，
 * 于是同一 nowSec 重复调用得到像素级相同的结果 → screenshotCheck 与慢放截图可证。
 */
export function hash01(seed, i = 0) {
  let h = (seed ^ 0x9e3779b9) + (i + 1) * 0x85ebca6b;
  h ^= h >>> 16;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 15;
  return ((h >>> 0) % 100000) / 100000;
}

function seedOf(value, salt = 0) {
  const n = Number.isFinite(value) ? Math.round(value * 1000) : 0;
  return (n ^ (salt * 0x51ed270b)) | 0;
}

/** 拍位：优先 view.timeToBeat（= clock.beatAt，支持变速），否则按当前拍长等速回退 */
export function beatAt(view, nowSec) {
  return timeToBeatOf(view, nowSec);
}

/** 相位进度 0..1（<0 或 >1 分别钳到 0/1；窗外由调用方按 done 处理） */
export function phaseK(startBeat, nowBeat, beats) {
  if (!(beats > 0)) return nowBeat >= startBeat ? 1 : 0;
  return clamp01((nowBeat - startBeat) / beats);
}

/** 记录尚未到触发拍（用于「未来时刻」类演出：落地微尘排在 atSec + 滞空拍） */
export function isPending(ev, nowBeat) {
  return nowBeat < ev.startBeat - 1e-12;
}

/* ═══════════════════════════════════════════════════════════════
 * 1 · 三要素各自的纯函数（全部按拍）
 * ═══════════════════════════════════════════════════════════════ */

/**
 * ① 全屏碎裂：在场该类障碍 → 每只炸 `particlesPerBurst` 片（≤ preset 上限），
 *    外加整屏裂纹（crack）覆盖世界带 → 「全屏」而非「判定点」。
 * @returns {{live:number, total:number, alpha:number, k:number, shards:object[]}}
 */
export function shatterAt(ev, view, nowBeat, q, yOf = null) {
  const beats = FX_TIMING.shatterBeats;
  const k = phaseK(ev.startBeat, nowBeat, beats);
  const done = k >= 1;
  const targets = ev.targets && ev.targets.length ? ev.targets : defaultTargets(ev.track, view, yOf);
  const per = Math.max(1, Math.min(q.particlesPerBurst, Math.floor(q.particlesLiveMax / Math.max(1, targets.length))));
  const spread = view.pxPerBeat * FX_TIMING.shardSpreadBeats;
  const lifeSec = beats * (view.beatSec || 1);
  const grav = FX_TIMING.shardFallG * view.height * (view.beatSec || 1);
  const shards = [];
  if (!done) {
    for (let t = 0; t < targets.length; t++) {
      const o = targets[t];
      const size = o.size || view.sizes.spike.h / 2;
      for (let i = 0; i < per; i++) {
        const h1 = hash01(seedOf(ev.startBeat, t * 31 + 7), i);
        const h2 = hash01(seedOf(ev.startBeat, t * 31 + 13), i + 977);
        const ang = -Math.PI / 2 + (h1 - 0.5) * Math.PI * 1.9;
        const vel = 0.45 + h2 * 0.8;
        const trav = spread * vel * (1 - (1 - k) * (1 - k)); // easeOutQuad 闭式
        const dtSec = k * lifeSec;
        shards.push({
          x: r2(o.x + Math.cos(ang) * trav),
          y: r2(o.y + Math.sin(ang) * trav + 0.5 * grav * dtSec * dtSec),
          size: Math.max(1, size * FX_TIMING.shardSizeRatio * (0.5 + h1 * 0.8) * (1 - 0.7 * k)),
          spin: (h2 - 0.5) * 3 * k,
          alpha: (1 - k) * (1 - k),
          track: ev.track,
          seed: t * 1000 + i
        });
      }
    }
  }
  const cap = q.particlesLiveMax;
  const live = Math.min(shards.length, cap);
  return {
    k,
    done,
    track: ev.track,
    startSec: ev.startSec,
    startBeat: ev.startBeat,
    live,
    total: shards.length,
    alpha: (1 - k) * (1 - k),
    crackAlpha: (1 - phaseK(ev.startBeat, nowBeat, FX_TIMING.crackBeats)) * FX_TIMING.crackAlpha,
    perBurst: per,
    shards: shards.slice(0, cap),
    beats
  };
}

/**
 * ② 降饱和：DIS-04「屏幕降饱和 0.3s 恢复」→ 真相是 preset.desaturateBeats（0.55 拍 @110 ≈ 0.30s），
 *    而不是写死 300ms；L6 @150 自动变短，两关的「演出长度」一致。
 *    画法是 base 色满屏叠印（Phaser 只当容器，L-09：不上 shader），k 越大越淡出。
 */
export function desaturateAt(ev, view, nowBeat, q) {
  const beats = q.desaturateBeats;
  const k = phaseK(ev.startBeat, nowBeat, beats);
  // DIS-04 的口径是「瞬间降下去、0.3s 恢复」⇒ 强度在第 0 拍就是满的（三要素**同帧可见**），
  // 之后按 (1−k) 线性回升。写成三角波会让触发帧 alpha=0，等于错帧。
  const relax = 1 - k;
  return {
    k,
    done: k >= 1,
    track: ev.track,
    startSec: ev.startSec,
    startBeat: ev.startBeat,
    beats,
    sec: beats * (view.beatSec || 1),
    depth: clamp01(relax * (1 - (q.desaturateFloor != null ? q.desaturateFloor : MOTION.desaturateFloor))),
    alpha: r2(clamp01(relax * FX_TIMING.desaturateAlpha * (q.flashReductionSafe ? FX_TIMING.safeScale : 1))),
    floor: q.desaturateFloor
  };
}

/**
 * ③ 大字标题：「鼓 · 已拆解」（VOICE_NAME × 状态词），驻留 preset.bigTextBeats 拍，
 *    字号取 FONT_TIERS.display 阶（W-15 的字号阶不许被演出绕过）。
 *    返回**描述子**，由 WorldLayer 在同一帧落到 host.add.text 上（本模块不碰 Phaser）。
 */
export function bigTextAt(ev, view, nowBeat, q) {
  const beats = q.bigTextBeats;
  const k = phaseK(ev.startBeat, nowBeat, beats);
  // 出场即满 alpha（同帧要求）；只有末段 bigTextOutRatio 比例做淡出，字号从 bigTextScaleFrom 砸到 1。
  const outK = clamp01((1 - k) / FX_TIMING.bigTextOutRatio);
  const inK = clamp01(k / FX_TIMING.bigTextInRatio);
  const scale = q.bigTextScaleFrom != null ? q.bigTextScaleFrom : MOTION.bigTextScaleFrom;
  return {
    k,
    done: k >= 1,
    track: ev.track,
    startSec: ev.startSec,
    startBeat: ev.startBeat,
    text: ev.text || `${VOICE_NAME[ev.track] || ev.track} · ${FX_TIMING.wordDisassemble}`,
    word: FX_TIMING.wordDisassemble,
    tier: 'display',
    fontSizePx: view.fontPx ? view.fontPx.display : FONT_TIERS.display,
    alpha: r2(outK),
    scale: r2(1 + (scale - 1) * (1 - inK)),
    color: COLORS.white.int,
    hex: COLORS.white.hex,
    x: r2(view.judgeX + view.pxPerBeat * FX_TIMING.bigTextBeatOffset),
    y: r2(view.zones.worldTop + view.zones.worldHeight * FX_TIMING.bigTextYRatio),
    beats
  };
}

/** W-08 复活扫回：自当前拍之后沿世界带从判定线向右扫（不补发历史 ⇒ 扫描起点就是判定线） */
export function reviveAt(ev, view, nowBeat, q) {
  const beats = FX_TIMING.reviveBeats;  const k = phaseK(ev.startBeat, nowBeat, beats);
  return {
    k,
    done: k >= 1,
    beats,
    sec: beats * (view.beatSec || 1),
    track: ev.track,
    ids: (ev.ids || []).slice(),
    x0: r2(view.judgeX),
    x1: r2(beatOffsetX(view, view.leadBeats * k)),
    alpha: r2((1 - k) * FX_TIMING.reviveAlpha),
    hpDisplay: ev.hp != null ? ev.hp : FX_TIMING.reviveHpDisplay,
    flash: r2((1 - phaseK(ev.startBeat, nowBeat, MOTION.reviveFlashBeats)) * FX_TIMING.reviveFlashAlpha * (q && q.flashReductionSafe ? FX_TIMING.safeScale : 1))
  };
}

/** hp 点血反馈：只做「该轨图例闪一下」的强度建议（HUD 归 CORE，画在时间轴道首由 W-11 负责） */
export function hpTapAt(ev, view, nowBeat) {
  const beats = FX_TIMING.hpTapBeats;
  const k = phaseK(ev.startBeat, nowBeat, beats);
  return { k, done: k >= 1, beats, track: ev.track, hp: ev.hp, alpha: r2((1 - k) * FX_TIMING.hpTapAlpha) };
}

/** PERFECT 金闪（判定线）+ 粒子；MISS 红 vignette + 衰减震动。全部 preset 驱动。 */
export function flashAt(ev, view, nowBeat, q) {
  const beats = MOTION.coreFlashBeats;
  const k = phaseK(ev.startBeat, nowBeat, beats);
  return {
    k,
    done: k >= 1,
    beats,
    grade: ev.grade,
    // 光敏安全档把所有瞬态亮度一起压低（PERF-05 ③），不是只管拆解叠印
    alpha: r2((1 - k) * FX_TIMING.flashAlpha * (ev.core ? 1 : FX_TIMING.flashNonCoreRatio) * (q && q.flashReductionSafe ? FX_TIMING.safeScale : 1)),
    gold: ev.grade === 'PERFECT'
  };
}

export function burstAt(ev, view, nowBeat, q) {
  const beats = FX_TIMING.burstBeats;
  const k = phaseK(ev.startBeat, nowBeat, beats);
  const n = ev.perBurst || Math.max(1, Math.min(q.particlesPerBurst, FX_TIMING.burstPerf));
  const pts = [];
  if (k < 1) {
    const spread = view.pxPerBeat * FX_TIMING.burstSpreadBeats;
    for (let i = 0; i < n; i++) {
      const h1 = hash01(seedOf(ev.startBeat, i + 3), i);
      const h2 = hash01(seedOf(ev.startBeat, i + 71), i + 13);
      const ang = (h1 * 2 - 1) * Math.PI;
      const trav = spread * (0.18 + 0.82 * (1 - (1 - k) * (1 - k))) * (0.35 + h2);
      pts.push({
        x: r2((ev.x != null ? ev.x : view.judgeX) + Math.cos(ang) * trav),
        y: r2((ev.y != null ? ev.y : view.groundY - view.sizes.charH / 2) + Math.sin(ang) * trav),
        size: Math.max(1, view.designScale * FX_TIMING.burstSizeRatio * (1 - 0.6 * k)),
        alpha: (1 - k) * (1 - k)
      });
    }
  }
  return { k, done: k >= 1, beats, live: pts.length, total: n, points: pts };
}

export function vignetteAt(ev, view, nowBeat, q) {
  const beats = FX_TIMING.vignetteBeats;
  const k = phaseK(ev.startBeat, nowBeat, beats);
  const safe = q.flashReductionSafe ? FX_TIMING.safeScale : 1;
  return {
    k,
    done: k >= 1,
    beats,
    alpha: r2((1 - k) * ALPHA.vignette * q.vignetteAlpha * safe * 2)
  };
}

/** 震屏：MOTION.shakeBeats 内按拍衰减到 0；幅度上限 = preset.shakeMaxPx（PRD 14px 归 standard 档） */
export function shakeAt(ev, view, nowBeat, q) {
  const beats = MOTION.shakeBeats;
  const k = phaseK(ev.startBeat, nowBeat, beats);
  const amp = Math.min(q.shakeMaxPx, FX_TIMING.shakeMaxCapPx) * (1 - k) * (1 - k);
  const b = ev.startBeat + k * beats;
  const dx = amp * Math.sin(b * Math.PI * 2 * FX_TIMING.shakeCycles);
  const dy = amp * 0.6 * Math.sin(b * Math.PI * 2 * FX_TIMING.shakeCycles * 1.7 + 1.1);
  return { k, done: k >= 1, beats, x: r2(dx), y: r2(dy), amp: r2(amp) };
}

/** 顿帧建议值（见文件头 ⛔：WORLD 不冻结时序，只把 preset 的拍系数换算出来给 CORE） */
export function hitStopAt(ev, view, nowBeat, q) {
  const beats = q.frameHoldBeats;
  if (!(beats > 0)) return { k: 1, done: true, beats: 0, sec: 0, active: false };
  const k = phaseK(ev.startBeat, nowBeat, beats);
  return { k, done: k >= 1, beats, sec: beats * (view.beatSec || 1), active: k < 1 };
}

/** 拖尾 / 落地微尘（PRD「奔跑挤压·跳跃拖尾·落地微尘」里数据能驱动的两句） */
export function trailAt(ev, view, nowBeat, q) {
  if (!q.trailOn) return { k: 1, done: true, beats: 0, points: [], live: 0 };
  const beats = MOTION.trailBeats;
  const k = phaseK(ev.startBeat, nowBeat, beats);
  const pts = [];
  if (k < 1) {
    const len = view.width * (view.ratios.dashDist || 0.12) || 0;
    for (let i = 0; i < FX_TIMING.trailGhosts; i++) {
      const f = (i + 1) / FX_TIMING.trailGhosts;
      pts.push({
        x: r2((ev.x != null ? ev.x : view.judgeX) - len * f * k),
        y: r2(ev.y != null ? ev.y : view.groundY - view.sizes.charH / 2),
        alpha: (1 - k) * (1 - f) * FX_TIMING.trailAlpha,
        w: Math.max(1, view.designScale * 2),
        h: r2(view.sizes.charH * (1 - f * 0.25))
      });
    }
  }
  return { k, done: k >= 1, beats, points: pts, live: pts.length };
}

export function dustAt(ev, view, nowBeat) {
  const beats = FX_TIMING.dustBeats;
  const k = phaseK(ev.startBeat, nowBeat, beats);
  const pts = [];
  if (k < 1 && !isPending(ev, nowBeat)) {
    const n = FX_TIMING.dustCount;
    for (let i = 0; i < n; i++) {
      const h1 = hash01(seedOf(ev.startBeat, i + 5), i);
      const side = i % 2 === 0 ? -1 : 1;
      pts.push({
        x: r2((ev.x != null ? ev.x : view.judgeX) + side * view.pxPerBeat * FX_TIMING.dustSpreadBeats * h1 * k),
        y: r2((ev.y != null ? ev.y : view.groundY) - view.designScale * (1 + h1 * 3) * (1 - k)),
        size: Math.max(1, view.designScale * (0.8 + h1)),
        alpha: (1 - k) * FX_TIMING.dustAlpha
      });
    }
  }
  return { k, done: k >= 1, beats, points: pts, live: pts.length };
}

/** 世界带 y 的唯一取值口径：由宿主（WorldLayer）注入 Obstacle.worldYFor，缺省退到地面线 */
const bandY = (track, view, yOf) => (typeof yOf === 'function' ? yOf(track, view) : view.groundY);

/** 无 targets 时的兜底碎裂点：沿该声部世界带在「可读窗」内均分（仍是纯函数） */
export function defaultTargets(track, view, yOf = null) {
  const y = bandY(track, view, yOf);
  const n = Math.max(2, Math.min(FX_TIMING.defaultTargets, view.leadBeats | 0 || 4));
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = ((i + 0.5) * (view.leadBeats || 4)) / n;
    out.push({
      x: beatOffsetX(view, b),
      y: y - view.sizes.spike.h / 2,
      size: view.sizes.spike.h / 2,
      track,
      beat: null
    });
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════
 * 2 · 系统本体
 * ═══════════════════════════════════════════════════════════════ */

export class EffectSystem {
  /**
   * @param {object} [opts]
   * @param {string} [opts.quality] 审美档名（缺省 = theme.DEFAULT_QUALITY；也可传 view.quality.name）
   * @param {object} [opts.view]    预置 view（不传则用第一次事件/查询的第三参）
   * @param {boolean}[opts.enabled] false = 全关（光敏/低配）
   * @param {number} [opts.maxEvents] 事件环形缓冲上限（FX_TIMING.maxEvents）
   * @param {(d:object)=>void}[opts.onBigText] 描述子外流（CORE/WorldLayer 挂 text 对象）
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.enabled = opts.enabled !== false;
    this.qualityName = opts.quality || null;
    this.q = null;
    this.view = null;
    /** 世界带 y 的注入点（WorldLayer 传 Obstacle.worldYFor；缺省退地面线，绝不另立一套几何真相） */
    this.trackYOf = typeof opts.trackYOf === 'function' ? opts.trackYOf : null;
    if (opts.view) this.layout(opts.view);
    this.events = [];
    this.maxEvents = opts.maxEvents || FX_TIMING.maxEvents;
    this._last = { nowSec: 0, state: null };
    this._open = new Map(); // kind|track → 事件记录（同帧幂等去重）
    this.stats = { disassembles: 0, revives: 0, bursts: 0, sameFrameTriple: 0 };
  }

  layout(view) {
    if (!view) return this;
    this.view = view;
    if (!this.qualityName) this.qualityName = (view.quality && view.quality.name) || this.opts.quality || DEFAULT_QUALITY;
    this.q = quality(this.qualityName);
    return this;
  }

  /** 当前档（preset 引用，越界值在 quality() 里已被 clamp 到 QUALITY_CAPS） */
  preset() {
    if (!this.q) this.q = quality(this.qualityName || DEFAULT_QUALITY);
    return this.q;
  }

  setQuality(name) {
    this.qualityName = name || DEFAULT_QUALITY;
    this.q = quality(this.qualityName);
    return this.q;
  }

  _view(view) {
    const v = view || this.view;
    if (!v) throw new Error('[EffectSystem] 需要先 layout(view) 或把 view 作为第三参传入');
    if (!this.q) this.layout(v);
    return v;
  }

  /** 事件记录：**三要素共用同一个 startBeat**（这是 DIS-04「同帧」的实现点，不是三个独立计时器） */
  _record(kind, ev, view, nowSec, nowBeat) {
    const startSec = typeof ev.atSec === 'number' ? ev.atSec : nowSec;
    const key = `${kind}:${ev.track || '-'}:${r2(startSec)}`;
    const hit = this._open.get(key);
    if (hit) return { ev: hit, reused: true, key };
    const rec = {
      kind,
      track: ev.track || null,
      startSec,
      startBeat: beatAt(view, startSec),
      ids: (ev.ids || []).slice(),
      hp: ev.hp == null ? null : ev.hp,
      grade: ev.grade || null,
      core: !!ev.core,
      text: ev.text || null,
      x: ev.x == null ? null : ev.x,
      y: ev.y == null ? null : ev.y,
      perBurst: ev.perBurst || null,
      targets: ev.targets && ev.targets.length ? ev.targets.slice(0, FX_TIMING.maxTargets) : null
    };
    this.events.push(rec);
    if (this.events.length > this.maxEvents) {
      const dropped = this.events.shift();
      for (const [k, v] of this._open) if (v === dropped) this._open.delete(k);
    }
    this._open.set(key, rec);
    return { ev: rec, reused: false, key };
  }

  /** 丢弃已播完的记录（纯时间函数：不读场景时钟，只按 nowBeat 判寿命） */
  _gc(nowBeat) {
    const horizon = FX_TIMING.gcBeats;
    this.events = this.events.filter((e) => nowBeat - e.startBeat < horizon);
    this._open.clear();
    for (const e of this.events) this._open.set(`${e.kind}:${e.track || '-'}:${r2(e.startSec)}`, e);
  }

  // ---------------------------------------------------------------- 事件入口

  /**
   * ★ W-07 主入口：声部 hp 归 0。一次调用同时开出 碎裂 / 降饱和 / 大字 三要素，
   *   三者的 startSec 与 startBeat **逐字段相等**（AC 断言 `render:fx` 的同帧线）。
   * @param {{track:string, atSec?:number, ids?:string[], targets?:object[], text?:string}} ev
   * @param {number} nowSec  绝对秒（clock.now()）
   * @param {object} [view]
   * @returns {{shatter:object, desaturate:object, bigText:object, bloom:object, sameFrame:true}}
   */
  onDisassemble(ev, nowSec, view, targets = null) {
    const v = this._view(view);
    const q = this.preset();
    const nb = beatAt(v, nowSec);
    const payload = { ...ev, targets: targets || ev.targets };
    const { ev: rec, reused } = this._record('disassemble', payload, v, nowSec, nb);
    if (!this.enabled) return { shatter: null, desaturate: null, bigText: null, bloom: null, sameFrame: false, disabled: true };
    const shatter = shatterAt(rec, v, nb, q, this.trackYOf);
    const desaturate = desaturateAt(rec, v, nb, q);
    const bigText = bigTextAt(rec, v, nb, q);
    const bloom = { intensity: q.bloomIntensity, layers: q.bloomLayers, alpha: r2(q.bloomIntensity * FX_TIMING.bloomAlphaScale) };
    this.stats.disassembles += reused ? 0 : 1;
    this.stats.sameFrameTriple += 1;
    this._last = { nowSec, state: { shatter, desaturate, bigText, bloom, liveCount: shatter.live } };
    if (!reused && typeof this.opts.onBigText === 'function') this.opts.onBigText({ ...bigText, track: rec.track, startSec: rec.startSec });
    return { shatter, desaturate, bigText, bloom, sameFrame: true, reused: !!reused, startSec: rec.startSec, startBeat: rec.startBeat };
  }

  /**
   * ★ W-08 复活：C3 'revive'{track,ids,hp} → 该类自**当前拍之后**恢复（扫描起点 = 判定线 x，
   *   左侧已过去的拍位**不补发**：扫描只在 [judgeX, judgeX+leadPx·k] 前进），hp 显示回 1。
   */
  onRevive(ev, nowSec, view) {
    const v = this._view(view);
    const q = this.preset();
    const nb = beatAt(v, nowSec);
    const { ev: rec, reused } = this._record('revive', ev, v, nowSec, nb);
    this.stats.revives += reused ? 0 : 1;
    return { revive: reviveAt(rec, v, nb, q), sameFrame: true, startSec: rec.startSec, startBeat: rec.startBeat };
  }

  /** C3 'hp-change'{track,hp}：点血闪；hp 归 0 的那一次**转发**给 disassemble（同帧唯一真相，不开第二条计时器） */
  onHpChange(ev, nowSec, view) {
    const v = this._view(view);
    const q = this.preset();
    const nb = beatAt(v, nowSec);
    if (ev && ev.hp === 0) {
      return this.onDisassemble({ track: ev.track, atSec: typeof ev.atSec === 'number' ? ev.atSec : nowSec, hp: 0 }, nowSec, view);
    }
    const { ev: rec } = this._record('hpTap', ev, v, nowSec, nb);
    return { tap: hpTapAt(rec, v, nb, q) };
  }

  /**
   * ★ C2 Judgment 的唯一演出入口（判定归 CORE，这里只消费 fx 标志）。
   * 空拍（rule==='emptyBeat' / penalizes===false）与 obstacleId===null 一律 no-op，
   * 与 CR-08 批复一致：WORLD 不写第二份「算不算 MISS」的分支。
   */
  onJudgment(judgment, nowSec, view) {
    if (!judgment) return null;
    if (judgment.rule === 'emptyBeat' || judgment.penalizes === false || !judgment.obstacleId) return null;
    const grade = judgment.grade;
    if (grade !== 'PERFECT' && grade !== 'MISS') return null;
    const v = this._view(view);
    const q = this.preset();
    const nb = beatAt(v, nowSec);
    const atSec = typeof judgment.atSec === 'number' ? judgment.atSec : nowSec;
    const kind = grade === 'PERFECT' ? 'perfect' : 'miss';
    const { ev: rec, reused } = this._record(kind, { ...judgment, atSec }, v, nowSec, nb);
    rec.x = judgment.x == null ? v.judgeX : judgment.x;
    rec.y = judgment.y == null ? v.groundY - v.sizes.charH / 2 : judgment.y;
    this.stats.bursts += reused ? 0 : 1;
    if (grade === 'MISS') {
      return {
        burst: null,
        flash: flashAt(rec, v, nb, q),
        vignette: vignetteAt(rec, v, nb, q),
        shake: shakeAt(rec, v, nb, q),
        hitStop: { k: 1, done: true, beats: 0, sec: 0, active: false }
      };
    }
    return {
      burst: burstAt(rec, v, nb, q),
      flash: flashAt(rec, v, nb, q),
      vignette: { k: 1, done: true, alpha: 0 },
      shake: { k: 1, done: true, x: 0, y: 0, amp: 0 },
      hitStop: hitStopAt(rec, v, nb, q)
    };
  }

  /** extra.action（W-03 的 {kind,atSec}）：dash 拖尾 + 落地微尘（落地时刻 = atSec + jumpAirBeats×拍长） */
  onAction(action, nowSec, view) {
    if (!action || typeof action.atSec !== 'number') return null;
    const v = this._view(view);
    const q = this.preset();
    const nb = beatAt(v, nowSec);
    let trail = null;
    let dust = null;
    if (action.kind === 'dash') {
      const { ev: rec } = this._record('trail', { atSec: action.atSec, track: null, x: v.judgeX, y: v.groundY - v.sizes.charH / 2 }, v, nowSec, nb);
      trail = trailAt(rec, v, nb, q);
    }
    if (action.kind === 'jump' || action.kind === 'hit') {
      const airBeats = v.ratios && v.ratios.jumpAirBeats != null ? v.ratios.jumpAirBeats : 0.9;
      const landSec = action.atSec + airBeats * (v.beatSec || 1);
      const { ev: rec } = this._record('dust', { atSec: landSec, track: null, x: v.judgeX, y: v.groundY }, v, nowSec, nb);
      dust = dustAt(rec, v, nb, q);
    }
    if (!trail && !dust) return null;
    return { trail, dust };
  }

  /** 按事件名分发（C3 的 {type,track,hp,ids} 或 C2 的 Judgment 都能喂） */
  feed(ev, nowSec, view, targets = null) {
    if (!ev) return null;
    const kind = ev.type || ev.kind;
    if (kind === 'disassemble') return this.onDisassemble({ ...ev, atSec: typeof ev.atSec === 'number' ? ev.atSec : nowSec }, nowSec, view, targets);
    if (kind === 'revive') return this.onRevive({ ...ev, atSec: typeof ev.atSec === 'number' ? ev.atSec : nowSec }, nowSec, view);
    if (kind === 'hp-change' || kind === 'hp') return this.onHpChange({ ...ev, atSec: typeof ev.atSec === 'number' ? ev.atSec : nowSec }, nowSec, view);
    if (kind === 'judge' || ev.grade) return this.onJudgment(ev.grade ? { ...ev, atSec: typeof ev.atSec === 'number' ? ev.atSec : nowSec } : ev, nowSec, view);
    if (kind === 'jump' || kind === 'dash' || kind === 'fine' || kind === 'hit') return this.onAction({ ...ev }, nowSec, view);
    return null;
  }

  /**
   * 便捷订阅：直接挂 CORE 的 DisassembleSystem（C3 广播原样消费，绝不反向调用）。
   * @param {{on:fn}} system  C3 事件发射器
   * @param {{now:fn}} clock   只用来取绝对秒
   * @param {object} [view]
   * @returns {() => void} 取消订阅
   */
  attach(system, clock, view = null) {
    if (!system || typeof system.on !== 'function') return () => {};
    const now = () => (clock && typeof clock.now === 'function' ? clock.now() : 0);
    const v = view || this.view;
    const offs = [];
    for (const [name, handler] of [
      ['disassemble', (p) => this.onDisassemble({ ...p, atSec: now() }, now(), v)],
      ['revive', (p) => this.onRevive({ ...p, atSec: now() }, now(), v)],
      ['hp-change', (p) => this.onHpChange({ ...p, atSec: now() }, now(), v)]
    ]) {
      offs.push(system.on(name, handler));
    }
    return () => {
      for (const off of offs) if (typeof off === 'function') off();
    };
  }

  // ---------------------------------------------------------------- 查询 / 绘制

  /** 该拍位上「哪些记录还活着」（同类多条取最晚开出的那个，避免叠印；pending = 未到触发拍，仍可被画） */
  _pick(kind, nowBeat, { allowPending = false } = {}) {
    let best = null;
    for (const e of this.events) {
      if (e.kind !== kind) continue;
      if (!allowPending && nowBeat < e.startBeat - 1e-12) continue;
      if (!best || e.startBeat > best.startBeat) best = e;
    }
    return best;
  }

  /**
   * ★ 完整状态（纯函数；screenshotCheck / DebugPanel / ?selftest=render 都读它）
   * @returns {{nowSec:number, nowBeat:number, quality:string, desaturate:object|null, bigText:object|null,
   *            shatter:object|null, revive:object|null, flash:object|null, burst:object|null,
   *            vignette:object|null, shake:object|null, hitStop:object|null, trail:object|null,
   *            dust:object|null, tap:object|null, sameFrame:object, liveCount:number, events:object[]}}
   */
  stateAt(nowSec, view) {
    const v = this._view(view);
    const q = this.preset();
    const nb = beatAt(v, nowSec);
    this._gc(nb);
    // 整档关闭（光敏/低配）时一律视为「无事件」：连状态查询也不产出，宿主就不会把大字/叠印亮起来
    const on = this.enabled;
    const dis = on ? this._pick('disassemble', nb) : null;
    const rev = on ? this._pick('revive', nb) : null;
    const per = on ? this._pick('perfect', nb) : null;
    const mis = on ? this._pick('miss', nb) : null;
    const tap = on ? this._pick('hpTap', nb) : null;
    const trl = on ? this._pick('trail', nb) : null;
    const dst = on ? this._pick('dust', nb) : null;
    const shatter = dis ? shatterAt(dis, v, nb, q, this.trackYOf) : null;
    const desaturate = dis ? desaturateAt(dis, v, nb, q) : null;
    const bigText = dis ? bigTextAt(dis, v, nb, q) : null;
    const out = {
      version: EFFECT_VERSION,
      nowSec,
      nowBeat: nb,
      bpm: v.bpm,
      beatSec: v.beatSec,
      quality: q.name,
      enabled: this.enabled,
      shatter,
      desaturate,
      bigText,
      bloom: dis ? { intensity: q.bloomIntensity, layers: q.bloomLayers } : null,
      revive: rev ? reviveAt(rev, v, nb, q) : null,
      tap: tap ? hpTapAt(tap, v, nb, q) : null,
      burst: per ? burstAt(per, v, nb, q) : null,
      flash: per ? flashAt(per, v, nb, q) : mis ? flashAt(mis, v, nb, q) : null,
      vignette: mis ? vignetteAt(mis, v, nb, q) : null,
      shake: mis ? shakeAt(mis, v, nb, q) : { k: 1, done: true, x: 0, y: 0, amp: 0 },
      hitStop: per ? hitStopAt(per, v, nb, q) : { k: 1, done: true, beats: 0, sec: 0, active: false },
      trail: trl ? trailAt(trl, v, nb, q) : null,
      dust: dst ? dustAt(dst, v, nb, q) : null,
      sameFrame: dis
        ? {
            // ★ DIS-04 的验收线：三要素读的是**同一条记录**的 startSec/startBeat（不是三个计时器）
            startSec: dis.startSec,
            startBeat: dis.startBeat,
            sharedRecord: !!(shatter && desaturate && bigText) && dis.kind === 'disassemble',
            shatterSec: FX_TIMING.shatterBeats * (v.beatSec || 1),
            desaturateSec: q.desaturateBeats * (v.beatSec || 1),
            bigTextSec: q.bigTextBeats * (v.beatSec || 1),
            kShatter: shatter ? shatter.k : null,
            kDesaturate: desaturate ? desaturate.k : null,
            kBigText: bigText ? bigText.k : null
          }
        : null,
      liveCount: 0,
      events: this.events.map((e) => ({ kind: e.kind, track: e.track, startSec: r2(e.startSec), startBeat: r2(e.startBeat) }))
    };
    out.liveCount =
      (shatter ? shatter.live : 0) +
      (out.burst ? out.burst.live : 0) +
      (out.dust ? out.dust.live : 0) +
      (out.trail ? out.trail.live : 0);
    this._last = { nowSec, state: out };
    return out;
  }

  /** 上次查询的状态（无 view 时的便捷口；DebugPanel 用） */
  probe() {
    return this._last.state;
  }

  /** 当前存活粒子数（断言 ≤ preset.particlesLiveMax 的那个数） */
  liveCount(nowSec = null, view = null) {
    if (nowSec == null && this._last.state) return this._last.state.liveCount;
    return this.stateAt(nowSec, view).liveCount;
  }

  /** 该拍是否有拆解三要素在播（WorldLayer 用它决定 g.fx 是否 clear/redraw 与 text 是否可见） */
  activeAt(nowSec, view) {
    const s = this.stateAt(nowSec, view);
    return !!(s.shatter && !s.shatter.done) || !!(s.bigText && !s.bigText.done) || !!(s.desaturate && !s.desaturate.done);
  }

  /**
   * ★ 唯一绘制入口（鸭子类型 Graphics；Node 里给 RecordingGraphics 就能断言到像素级操作）
   * @param {object} g
   * @param {{nowSec:number, view?:object, targets?:object[]}} frame
   * @returns {object} 本次画了什么（计数，供 frameStats）
   */
  draw(g, frame = {}) {
    const nowSec = frame.nowSec;
    const v = this._view(frame.view);
    if (!g || typeof g.fillStyle !== 'function') return { drawn: 0 };
    if (frame.targets) {
      for (const e of this.events) {
        if (e.kind === 'disassemble' && !e.targets && Math.abs(e.startSec - nowSec) < 1e-9) e.targets = frame.targets.slice(0, FX_TIMING.maxTargets);
      }
    }
    const s = this.stateAt(nowSec, v);
    if (!this.enabled) {
      g.clear && g.clear();
      return { drawn: 0, disabled: true };
    }
    const q = this.preset();
    const counts = { shards: 0, cracks: 0, burst: 0, dust: 0, trail: 0, overlays: 0, revive: 0, flash: 0 };
    const width = v.width;
    const height = v.height;

    // ② 满屏降饱和叠印（先画：碎裂要压在灰上）
    if (s.desaturate && s.desaturate.alpha > 0) {
      g.fillStyle(COLORS.base.int, s.desaturate.alpha);
      g.fillRect(0, 0, width, height);
      counts.overlays++;
    }
    // bloom：只读 preset.bloomIntensity / bloomLayers（quiet 档 = 0 ⇒ 一像素不画；这就是 T16 三档的可见差）
    if (s.shatter && !s.shatter.done && q.bloomLayers > 0 && q.bloomIntensity > 0) {
      for (let i = 0; i < q.bloomLayers; i++) {
        const a = r2(s.shatter.alpha * q.bloomIntensity * FX_TIMING.bloomAlphaScale * (1 - i / q.bloomLayers) * (q.flashReductionSafe ? FX_TIMING.safeScale : 1));
        if (a <= 0.002) continue;
        g.fillStyle(COLORS.white.int, a);
        const inset = Math.round((height * 0.06 * i) / Math.max(1, q.bloomLayers));
        g.fillRect(inset, inset, width - inset * 2, height - inset * 2);
        counts.overlays++;
      }
    }
    // ① 碎裂：碎片（三角形 = 形状通道）+ 整屏裂纹
    if (s.shatter && !s.shatter.done) {
      for (const p of s.shatter.shards) {
        const col = p.track && TRACK_INT[p.track] != null ? markerColor(p.track) : COLORS.white.int;
        g.fillStyle(col, Math.max(0, Math.min(1, p.alpha)));
        g.fillPoints(
          [
            { x: p.x, y: p.y - p.size },
            { x: p.x + p.size * 0.8, y: p.y + p.size * 0.6 },
            { x: p.x - p.size * 0.8, y: p.y + p.size * 0.6 }
          ],
          true
        );
        counts.shards++;
      }
      const ca = s.shatter.crackAlpha;
      if (ca > 0) {
        g.lineStyle(Math.max(1, v.designScale * FX_TIMING.crackWidthRatio), COLORS.white.int, ca);
        for (const ln of crackLines(v, this.trackYOf)) {
          g.lineBetween(ln.x1, ln.y1, ln.x2, ln.y2);
          counts.cracks++;
        }
      }
    }
    // W-08 复活扫回
    if (s.revive && !s.revive.done && s.revive.alpha > 0) {
      const y = bandY(s.revive.track, v, this.trackYOf);
      g.fillStyle(TRACK_INT[s.revive.track] != null ? markerColor(s.revive.track) : COLORS.system.int, s.revive.alpha);
      g.fillRect(s.revive.x0, y - v.sizes.charH, Math.max(0, s.revive.x1 - s.revive.x0), v.sizes.charH * 0.5);
      g.lineStyle(Math.max(1, v.designScale * 2), COLORS.white.int, s.revive.flash);
      g.lineBetween(s.revive.x1, v.zones.worldTop, s.revive.x1, v.zones.worldBottom);
      counts.revive++;
    }
    if (s.tap && !s.tap.done && s.tap.alpha > 0) {
      const y = bandY(s.tap.track, v, this.trackYOf);
      g.fillStyle(TRACK_INT[s.tap.track] != null ? markerColor(s.tap.track) : COLORS.system.int, s.tap.alpha);
      g.fillRect(v.judgeX - v.sizes.judgeLineWidth * 2, y - v.sizes.charH, v.sizes.judgeLineWidth * 4, v.sizes.charH);
      counts.overlays++;
    }
    // PERFECT 粒子 + 金闪 / MISS vignette
    if (s.burst && !s.burst.done) {
      for (const p of s.burst.points) {
        g.fillStyle(COLORS.white.int, p.alpha);
        g.fillCircle(p.x, p.y, p.size);
        counts.burst++;
      }
    }
    if (s.flash && !s.flash.done && s.flash.alpha > 0) {
      g.lineStyle(Math.max(1, v.sizes.judgeLineWidth * 3), s.flash.gold ? COLORS.white.int : COLORS.system.int, s.flash.alpha);
      g.lineBetween(v.judgeX, v.zones.worldTop, v.judgeX, v.zones.worldBottom);
      counts.flash++;
    }
    if (s.vignette && !s.vignette.done && s.vignette.alpha > 0) {
      const bands = FX_TIMING.vignetteBands;
      const deep = height * FX_TIMING.vignetteDepthRatio;
      for (let i = 0; i < bands; i++) {
        const a = s.vignette.alpha * (1 - i / bands) * (1 - i / bands);
        if (a <= 0.002) continue;
        g.fillStyle(COLORS.kick.int, a);
        const t = Math.max(1, deep / bands);
        g.fillRect(0, 0, width, t);
        g.fillRect(0, height - t, width, t);
        g.fillRect(0, 0, t, height);
        g.fillRect(width - t, 0, t, height);
        counts.overlays++;
      }
    }
    if (s.trail && !s.trail.done) {
      for (const p of s.trail.points) {
        g.fillStyle(COLORS.system.int, p.alpha);
        g.fillRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
        counts.trail++;
      }
    }
    if (s.dust && !s.dust.done) {
      for (const p of s.dust.points) {
        g.fillStyle(DERIVED.ground.int, p.alpha);
        g.fillCircle(p.x, p.y, p.size);
        counts.dust++;
      }
    }
    counts.total = counts.shards + counts.cracks + counts.burst + counts.dust + counts.trail + counts.overlays + counts.revive + counts.flash;
    counts.state = s;
    return counts;
  }

  /** 震屏偏移（WorldLayer 每帧把 dx/dy 赋给各 Graphics 的 x/y —— 是时间的函数，不是积分） */
  shakeOffset(nowSec, view) {
    const s = this.stateAt(nowSec, view);
    if (!s.shake || s.shake.done || !(s.shake.amp > 0)) return { x: 0, y: 0 };
    const lim = Math.min(this.preset().shakeMaxPx, FX_TIMING.shakeMaxCapPx);
    return { x: Math.max(-lim, Math.min(lim, s.shake.x)), y: Math.max(-lim, Math.min(lim, s.shake.y)) };
  }

  reset() {
    this.events = [];
    this._open.clear();
    this._last = { nowSec: 0, state: null };
    return this;
  }

  shutdown() {
    this.reset();
    this.enabled = false;
    this.view = null;
    return this;
  }

  /** 关卡自检负载（?selftest=render 消费；纯 JSON） */
  audit(nowSec, view) {
    const v = this._view(view);
    const q = this.preset();
    const s = this.stateAt(nowSec, v);
    const dis = this.events.find((e) => e.kind === 'disassemble') || null;
    return {
      version: EFFECT_VERSION,
      quality: q.name,
      caps: { particlesPerBurst: q.particlesPerBurst, particlesLiveMax: q.particlesLiveMax, bloomIntensity: q.bloomIntensity },
      liveCount: s.liveCount,
      overCap: s.liveCount > q.particlesLiveMax,
      sameFrame: dis
        ? {
            startSec: dis.startSec,
            startBeat: dis.startBeat,
            shatterSec: FX_TIMING.shatterBeats * v.beatSec,
            desaturateSec: q.desaturateBeats * v.beatSec,
            bigTextSec: q.bigTextBeats * v.beatSec
          }
        : null,
      state: s
    };
  }
}

/* ═══════════════════════════════════════════════════════════════
 * 3 · 内部小工具（几何/颜色取值；全部来自 theme）
 * ═══════════════════════════════════════════════════════════════ */

const TRACK_INT = { ...TRACK_COLOR };

/**
 * 整屏裂纹：以该声部世界带为中心向四角发散的定长折线（数量固定、形状由 seed 决定）。
 * 「全屏碎裂」的视觉真相 = 碎片从障碍处炸开 + 裂纹横贯整个画布。
 */
export function crackLines(view, yOf = null) {
  const lines = [];
  const n = FX_TIMING.crackCount;
  const W = view.width;
  const H = view.height;
  const cy = bandY('kick', view, yOf);
  for (let i = 0; i < n; i++) {
    const h = hash01(0x51ed + i * 977, i);
    const x0 = W * h;
    const y0 = i % 2 === 0 ? 0 : H;
    lines.push({
      x1: r2(x0),
      y1: r2(y0),
      x2: r2(x0 + (view.judgeX - x0) * FX_TIMING.crackBendRatio),
      y2: r2(y0 + (cy - y0) * FX_TIMING.crackBendRatio)
    });
    lines.push({
      x1: r2(x0 + (view.judgeX - x0) * FX_TIMING.crackBendRatio),
      y1: r2(y0 + (cy - y0) * FX_TIMING.crackBendRatio),
      x2: r2(W - x0),
      y2: r2(H - y0 + (cy - H) * 0.2)
    });
  }
  return lines;
}

export default EffectSystem;
