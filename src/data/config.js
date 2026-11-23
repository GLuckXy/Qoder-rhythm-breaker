// src/data/config.js — Owner: CORE（K-02）
// 判定窗口基准 / 关卡缩放 / 下限保护。数值口径来自 leader 决策 L-01 与 L-07，
// 与 PRD §7.1 的「建议基准 ±60/±110 + 严格模式收紧」一致。
// 这里只放「判定与调度」的配置；画面与物理常量在 physics.js（C8 冻结）。

/** 判定窗口基准（毫秒）。strictWindow 打开时用 strict 一档。 */
export const JUDGE_CONFIG = Object.freeze({
  perfectMs: 60,
  goodMs: 110,
  strict: Object.freeze({ perfectMs: 50, goodMs: 100 }),
  /** JDG-02 下限保护：缩放后再紧也不能小于这个值 */
  floor: Object.freeze({ perfectMs: 40, goodMs: 80 }),
  /** 关卡配置缺省缩放 */
  defaultWindowScale: 1.0
});

/** 六关窗口缩放（L-07：第 6 关 0.95，与第 5 关持平）。 */
export const LEVEL_WINDOW_SCALE = Object.freeze({
  1: 1.2,
  2: 1.1,
  3: 1.0,
  4: 1.0,
  5: 0.95,
  6: 0.95
});

/** 同表的数组形式，供 contractTest 逐关断言。 */
export const WINDOW_SCALES = Object.freeze([1.2, 1.1, 1.0, 1.0, 0.95, 0.95]);

/**
 * 取某关的窗口缩放；未知关卡回退到 1.0（不阻断进入关卡，PRD §8.1 末条）。
 * @param {number|string} levelId
 * @returns {number}
 */
export function windowScaleFor(levelId) {
  const k = LEVEL_WINDOW_SCALE[Number(levelId)];
  return Number.isFinite(k) ? k : JUDGE_CONFIG.defaultWindowScale;
}

/**
 * 窗口解算：基准 × 缩放，再套下限保护（JDG-02）。
 * 恒等式保证：goodMs >= perfectMs，避免缩放极端时窗口倒挂。
 * @param {{scale?:number, strict?:boolean, base?:{perfectMs:number, goodMs:number}}} [opt]
 * @returns {{perfectMs:number, goodMs:number, scale:number, strict:boolean, floored:boolean}}
 */
export function resolveWindows(opt = {}) {
  const { scale = JUDGE_CONFIG.defaultWindowScale, strict = false } = opt;
  const base = opt.base || (strict ? JUDGE_CONFIG.strict : JUDGE_CONFIG);
  const s = Number.isFinite(scale) && scale > 0 ? scale : JUDGE_CONFIG.defaultWindowScale;
  const rawP = base.perfectMs * s;
  const rawG = base.goodMs * s;
  const perfectMs = Math.max(rawP, JUDGE_CONFIG.floor.perfectMs);
  const goodMs = Math.max(Math.max(rawG, JUDGE_CONFIG.floor.goodMs), perfectMs);
  return {
    perfectMs,
    goodMs,
    scale: s,
    strict: !!strict,
    floored: perfectMs > rawP + 1e-9 || goodMs > rawG + 1e-9
  };
}

/** 校准（JDG-09 / L-06 降级版）：`[` `]` 每步 1ms， clamp 到 ±200ms。 */
export const CALIBRATION = Object.freeze({
  stepMs: 1,
  minMs: -200,
  maxMs: 200
});

/**
 * 校准微调一步。
 * @param {number} currentMs 当前 latencyOffset
 * @param {1|-1} dir
 * @returns {number}
 */
export function nudgeLatency(currentMs, dir) {
  const cur = Number.isFinite(currentMs) ? currentMs : 0;
  const next = cur + dir * CALIBRATION.stepMs;
  return Math.min(CALIBRATION.maxMs, Math.max(CALIBRATION.minMs, next));
}

export default JUDGE_CONFIG;
