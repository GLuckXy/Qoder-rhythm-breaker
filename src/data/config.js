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

/**
 * 校准小游戏（JDG-09 完整版 / 任务卡 K-14）。与上面的降级版**并存**，不替换 `[` `]` 通路。
 * 口径来源：PRD JDG-09「8 拍跟拍敲击，取中位数（非均值，抗离群）写入 localStorage；
 * 提供手动 ±1ms 微调与「重置为 0」」+ PRD §10「校准小游戏：8 拍引导敲击（听合成节拍器跟拍）、
 * 结果偏移与稳定度、应用/取消，说明文字 ≤ 2 行」。
 */
export const CALIB_GAME = Object.freeze({
  /** 节拍器速度：拍长 600ms，比出厂最慢关（110BPM）还宽松，新手跟得上 */
  bpm: 100,
  /** 一共放几拍、请玩家打几下（JDG-09 = 8） */
  beats: 8,
  /** 丢弃前 N 次样本：起手第一下最不稳，PRD 只说取中位数，这里按 K-14 卡面显式丢掉 */
  warmupBeats: 2,
  /** 热身后的最少有效样本数；不足 → 拒绝写入并提示（不许把 1、2 下的偶然值当校准值） */
  minSamples: 4,
  /** 末拍之后再等 0.75 拍收口（用 clock.timeAtBeat 求绝对时刻，不是 setTimeout） */
  tailBeats: 0.75,
  /** 起钟提前量（秒）：第 0 拍必须落在 now() 的未来，否则第一拍一出生就迟到 */
  startLeadSec: 0.35,
  /** CR-11 同口径：派发时 leadSec < -0.002 视为迟到 → 这一拍不出声、也不记账 */
  lateLimitSec: 0.002,
  /** IQR（四分位距）≤ 此值算「打得稳」，超过就建议重测一次；只做提示，不拦写入 */
  stableIqrMs: 40,
  /** 写入精度：0.1ms（存档与 DebugPanel 都是 1 位小数，再细的位数是假精度） */
  precisionMs: 0.1
});

/**
 * 把任意校准值夹紧到存档允许的 latencyOffset 区间。
 * 区间上下限取自 CALIBRATION（= src/data/save.js:96 的 { min:-200, max:200 } 同一口径），
 * 只此一处，避免「界面夹 ±200、存档夹 ±200」两套数各自漂移。
 * @param {number} ms
 * @returns {number}
 */
export function clampLatency(ms) {
  const v = Number.isFinite(ms) ? ms : 0;
  return Math.min(CALIBRATION.maxMs, Math.max(CALIBRATION.minMs, v));
}

export default JUDGE_CONFIG;
