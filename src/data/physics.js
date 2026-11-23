// src/data/physics.js — Owner: CORE（K-04，C8 冻结项）
// 全项目「画面几何 + 运动学」的唯一换算源。所有值表达为「比例 × 视口」的纯函数，
// 基准分辨率 1920×1080（PRD §7.5：其他分辨率按比例）。
//
// 变更规则（C8）：FROZEN 内的项要改值 → WORLD 提 CR 附可达性包络计算，
// SOUND 提 CR 附「哪个谱面因此不可玩」。AUX/派生项可增，不改语义。

/** 基准分辨率（比例值在此分辨率下等于 PRD 表中的绝对像素）。 */
export const BASE_VIEW = Object.freeze({ w: 1920, h: 1080 });

/** C8 冻结项：只增不改。 */
export const FROZEN = Object.freeze({
  /** pxPerBeat = 0.115 × W（上下层共享，VIS-05） */
  pxPerBeat: 0.115,
  /** 判定线 x = 0.30 × W */
  judgeX: 0.30,
  /** 地面线 y = 0.52 × H */
  groundY: 0.52,
  /** 跳跃滞空 = 0.9 × 拍长（L-03：拍长系数，不是秒） */
  jumpAirBeats: 0.9,
  /** 跳跃峰值高度 = 0.20 × H */
  jumpPeakH: 0.20,
  /** 平台三档高度（相对地面线上方）＝ 0.10 / 0.16 / 0.21 × H */
  platformTiers: Object.freeze([0.1, 0.16, 0.21]),
  /** 冲刺时长 = 0.35 × 拍长 */
  dashDurBeats: 0.35,
  /** 冲刺位移 = 0.12 × W */
  dashDist: 0.12,
  /** 受击无敌帧（秒，固定不随 BPM） */
  invulnSec: 0.5,
  /** 落地输入缓冲（毫秒，PLR-06 与 JDG-04 同一实现 → 只在此处定义一次） */
  inputBufferMs: 80
});

/** C8 冻结项的键清单，供 contractTest 断言「常量齐」。 */
export const FROZEN_KEYS = Object.freeze([
  'pxPerBeat',
  'judgeX',
  'groundY',
  'jumpAirBeats',
  'jumpPeakH',
  'platformTiers',
  'dashDurBeats',
  'dashDist',
  'invulnSec',
  'inputBufferMs'
]);

/**
 * 非冻结补充项：PRD §7.5 表里的尺寸/分区，以及 WORLD 可自行覆盖的角色尺寸。
 * sizes 为 1080p 基准像素，按 uiScale 等比缩放。
 */
export const AUX = Object.freeze({
  /** HUD 带高 0.08 × H */
  hudBand: 0.08,
  /** 上层世界带高 0.60 × H（分区比 8/60/32） */
  worldBand: 0.6,
  /** 下层时间轴带高 0.32 × H */
  timelineBand: 0.32,
  /** 时间轴标记高 40px@1080p */
  timelineMarkPx: 40,
  /** 尖刺 / 平台 / 弹幕核心尺寸（px@1080p） */
  sizes: Object.freeze({
    spike: Object.freeze({ w: 48, h: 40 }),
    platform: Object.freeze({ w: 120, h: 24 }),
    barrage: Object.freeze({ w: 56, h: 56 })
  }),
  /** 角色高度（非冻结：WORLD 的 Player 可用自身贴图高度覆盖） */
  charH: 0.075,
  /** 弹幕网间隙 ≥ 2.2 × 角色高度（OBS/W-10 自检用） */
  barrageGapRatio: 2.2,
  /** 同类障碍最小间隔（拍）：密度 4 拍 ≤ 3 个 → 1.33 拍 */
  minSameTypeGapBeats: 1.33,
  /** 预告窗口：进入屏幕到判定线 = 4 拍（OBS-03 / TIM-01） */
  lookAheadBeats: 4,
  /** 六关 BPM（含第 4 关变速后的 140），用于 §7.5 约束自检 */
  selfTestBpms: Object.freeze([110, 120, 126, 128, 132, 140])
});

/**
 * 归一化视口。
 * @param {{w?:number,h?:number}} [view]
 */
export function resolveView(view) {
  const w = Number.isFinite(view?.w) && view.w > 0 ? view.w : BASE_VIEW.w;
  const h = Number.isFinite(view?.h) && view.h > 0 ? view.h : BASE_VIEW.h;
  return { w, h };
}

/** 固定像素资产（障碍尺寸、字号）的等比系数。 */
export function uiScale(view) {
  const v = resolveView(view);
  return Math.min(v.w / BASE_VIEW.w, v.h / BASE_VIEW.h);
}

/**
 * 视口下的全部绝对几何值（纯函数，不缓存）。
 * @param {{w?:number,h?:number}} [view]
 */
export function metrics(view) {
  const v = resolveView(view);
  const { w, h } = v;
  const s = uiScale(v);
  const hudH = AUX.hudBand * h;
  const timelineH = AUX.timelineBand * h;
  return {
    w,
    h,
    uiScale: s,
    judgeX: FROZEN.judgeX * w,
    groundY: FROZEN.groundY * h,
    pxPerBeat: FROZEN.pxPerBeat * w,
    /** 玩家固定 x = 判定线 x（VIS-05，使 TIM-03 对齐虚线成立） */
    playerX: FROZEN.judgeX * w,
    hudBandH: hudH,
    worldBandH: AUX.worldBand * h,
    timelineBandH: timelineH,
    /** 下层时间轴带顶边 y */
    timelineTop: h - timelineH,
    timelineCenterY: h - timelineH / 2,
    timelineMarkH: AUX.timelineMarkPx * s,
    jumpPeakH: FROZEN.jumpPeakH * h,
    platformTierY: FROZEN.platformTiers.map((r) => FROZEN.groundY * h - r * h),
    platformTierH: FROZEN.platformTiers.slice(),
    dashDist: FROZEN.dashDist * w,
    charH: AUX.charH * h,
    sizes: {
      spike: { w: AUX.sizes.spike.w * s, h: AUX.sizes.spike.h * s },
      platform: { w: AUX.sizes.platform.w * s, h: AUX.sizes.platform.h * s },
      barrage: { w: AUX.sizes.barrage.w * s, h: AUX.sizes.barrage.h * s }
    },
    /** 4 拍预告换算的像素距离 */
    lookAheadPx: AUX.lookAheadBeats * FROZEN.pxPerBeat * w
  };
}

/** 便利别名：1920×1080 下的 metrics。 */
export function metrics1080() {
  return metrics(BASE_VIEW);
}

/**
 * 世界滚动速率：pxPerSec = pxPerBeat / beatSec（OBS-02 的时间纯函数所需）。
 * 变速关请按当前拍长调用（BeatClock.beatLengthSec）。
 * @param {{w?:number,h?:number}} view
 * @param {number} beatSec 当前拍长（秒）
 */
export function pxPerSec(view, beatSec) {
  const b = Number.isFinite(beatSec) && beatSec > 0 ? beatSec : 0.5;
  return metrics(view).pxPerBeat / b;
}

/**
 * 障碍 x = judgeX + (obstacleT - now) × pxPerSec（OBS-02，禁止速度积分）。
 * @param {{w?:number,h?:number}} view
 * @param {number} obstacleT 障碍到达判定线的绝对时刻（秒，来自 BeatClock.timeAtBeat）
 * @param {number} nowSec BeatClock.now()
 * @param {number} beatSec 当前拍长
 */
export function obstacleX(view, obstacleT, nowSec, beatSec) {
  const m = metrics(view);
  return m.judgeX + (obstacleT - nowSec) * pxPerSec(view, beatSec);
}

/** 某拍在时间轴上的 x（TIM-02：按拍等距，与秒无关）。 */
export function timelineX(view, beatDelta) {
  return metrics(view).judgeX + beatDelta * metrics(view).pxPerBeat;
}

/** 下层三声部泳道 y（非冻结：WORLD 可自定布局，此处只保证同一换算源）。 */
export function timelineLaneY(view, laneIndex) {
  const m = metrics(view);
  const lanes = 3;
  const inner = m.timelineBandH - m.timelineMarkH;
  const step = inner / lanes;
  const i = Math.min(lanes - 1, Math.max(0, laneIndex | 0));
  return m.timelineTop + m.timelineMarkH / 2 + step * i + (inner - step * lanes) / 2;
}

/** 平台第 tier 档顶面 y（0 低 / 1 中 / 2 高）。 */
export function platformTopY(view, tier) {
  const m = metrics(view);
  const r = FROZEN.platformTiers[Math.min(2, Math.max(0, tier | 0))];
  return m.groundY - r * m.h;
}

/**
 * 跳跃运动学：T = 滞空秒数 = jumpAirBeats × beatSec，h = jumpPeakH。
 * v0 = 4h / T，g = 8h / T²（对称抛物线，顶点 h）。
 * @param {{w?:number,h?:number}} view
 * @param {number} beatSec
 */
export function jumpKinematics(view, beatSec) {
  const m = metrics(view);
  const b = Number.isFinite(beatSec) && beatSec > 0 ? beatSec : 0.5;
  const airSec = FROZEN.jumpAirBeats * b;
  const peakH = m.jumpPeakH;
  return {
    airSec,
    airBeats: FROZEN.jumpAirBeats,
    peakH,
    v0: (4 * peakH) / airSec,
    g: (8 * peakH) / (airSec * airSec),
    beatSec
  };
}

/** 滞空秒数（JudgeSystem 的落地时刻与 WORLD 的弧线共用）。 */
export function jumpAirSec(beatSec) {
  const b = Number.isFinite(beatSec) && beatSec > 0 ? beatSec : 0.5;
  return FROZEN.jumpAirBeats * b;
}

/** 冲刺秒数。 */
export function dashSec(beatSec) {
  const b = Number.isFinite(beatSec) && beatSec > 0 ? beatSec : 0.5;
  return FROZEN.dashDurBeats * b;
}

/** 抛物线高度：y 偏移（向上为正），t ∈ [0, airSec]。 */
export function jumpOffset(kin, tSec) {
  if (!(kin && kin.airSec > 0)) return 0;
  const t = Math.min(Math.max(tSec, 0), kin.airSec);
  return kin.v0 * t - 0.5 * kin.g * t * t;
}

/** 落地缓冲换算成拍（§7.5 自检用）。 */
export function bufferBeats(beatSec) {
  const b = Number.isFinite(beatSec) && beatSec > 0 ? beatSec : 0.5;
  return FROZEN.inputBufferMs / 1000 / b;
}

/**
 * PRD §7.5「约束自检（必须能算）」：
 * ① 同类最小间隔 1.33 拍 > 滞空 0.9 拍 + 落地缓冲（≈0.18 拍）→ 不存在落地前遇到同类的硬冲突；
 * ② 平台三档都在固定跳跃可达包络内（峰值 + 角色半高余量）；
 * ③ 4 拍预告不超过屏宽 55%（留出安全区与背景）；
 * ④ 弹幕间隙 ≥ 2.2 × 角色高度。
 * @param {{w?:number,h?:number}} [view]
 * @returns {{errors:string[], warnings:string[], rows:Array}}
 */
export function selfTest(view) {
  const errors = [];
  const warnings = [];
  const m = metrics(view);
  const rows = [];
  const reach = m.jumpPeakH + m.charH / 2;

  for (const bpm of AUX.selfTestBpms) {
    const beatSec = 60 / bpm;
    const need = FROZEN.jumpAirBeats + bufferBeats(beatSec);
    const ok = AUX.minSameTypeGapBeats > need;
    rows.push({
      bpm,
      beatMs: beatSec * 1000,
      airBeats: FROZEN.jumpAirBeats,
      bufferBeats: bufferBeats(beatSec),
      needBeats: need,
      minGapBeats: AUX.minSameTypeGapBeats,
      ok
    });
    if (!ok) {
      errors.push(`§7.5 间隔冲突 @${bpm}BPM：最小同类间隔 ${AUX.minSameTypeGapBeats} 拍 <= 滞空+缓冲 ${need.toFixed(3)} 拍`);
    }
  }

  FROZEN.platformTiers.forEach((r, i) => {
    const need = r * m.h;
    if (need > reach + 1e-6) {
      errors.push(`平台第 ${i} 档高 ${need.toFixed(1)}px 超出跳跃包络 ${reach.toFixed(1)}px`);
    }
  });

  if (m.lookAheadPx > m.w * 0.55) {
    warnings.push(`4 拍预告 ${m.lookAheadPx.toFixed(0)}px 超过屏宽 55%，右侧安全区不足`);
  }
  const gap = AUX.barrageGapRatio * m.charH;
  if (gap < m.sizes.barrage.h * 1.5) {
    warnings.push(`弹幕间隙 ${gap.toFixed(0)}px 与弹幕核心 ${m.sizes.barrage.h.toFixed(0)}px 相比余量偏小`);
  }
  if (Math.abs(AUX.hudBand + AUX.worldBand + AUX.timelineBand - 1) > 1e-9) {
    errors.push('分区比 8/60/32 不等于 1');
  }
  return { errors, warnings, rows, reachPx: reach };
}

export default FROZEN;
