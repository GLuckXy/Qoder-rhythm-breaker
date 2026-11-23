/* clock-ok —— 本文件唯一的时间读取是 meta.firstPlayedAt（存档元数据，非判定/调度/定位路径） */
// src/data/save.js — Owner: CORE（K-08）
// PRD §8.3 schema v1，键 `rhythm-breaker/save`。
// 三条硬要求：
//   SAV-01 带 version 的 schema；
//   SAV-02 节流写入（≥500ms），禁止每帧写；
//   SAV-03 字段缺失 / JSON 损坏 / 隐私模式禁用 → 静默降级为内存默认档，**不抛错**、只提示一次。
// v1 内部的加性字段（T5）：levels[id].encounterRate = DEF-05 的「评级口径」Perfect 率（遭遇口径），
//   与 §7.3 的 perfectRate（谱面口径）并存；version 仍是 1，因为它只加不改语义，老档补默认值即可读。
//   W-13 追加 options.tutorialSkipped（教学浮层是否被玩家关掉，PRD P2「第 2 次进第 1 关不需要再看」）：
//   同一个 v1、同一个存储键，老档经 mergeGroup 补 false ⇒ 首次进关照常教学；不新增键、不改任何既有字段语义。
// 可在 Node 里自验：所有读写都接受注入的 storage 桩（见 tools/contractTest.mjs --case save）。

export const SAVE_KEY = 'rhythm-breaker/save';
export const SAVE_VERSION = 1;
/** SAV-02 写入节流下限。 */
export const WRITE_THROTTLE_MS = 500;
export const RANKS = Object.freeze(['S', 'A', 'B', 'C']);

export function defaultLevelEntry() {
  // encounterRate（DEF-05 / SAV-01 加性字段）：评级实际用的「遭遇口径」Perfect 率。
  // perfectRate 保持 §7.3 的谱面口径 P/N 一字不动（选关页的横向比较与旧档都还靠它）；
  // 缺字段的老档经 mergeLevelEntry 补 0，读取不抛错（SAV-03）。
  return { cleared: false, rank: null, perfectRate: 0, maxCombo: 0, miss: 0, encounterRate: 0 };
}

/** 默认档（每次调用返回新对象，避免共享引用被改写）。 */
export function defaultSave() {
  return {
    version: SAVE_VERSION,
    levels: {},
    audio: { latencyOffset: 0, master: 1, music: 1, sfx: 1, muted: false },
    options: { showTimelineGuides: true, reduceFlash: false, strictWindow: false, unlockedNudge: true, tutorialSkipped: false },
    meta: { firstPlayedAt: 0, totalRuns: 0 }
  };
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function numOf(v, fallback, min = -Infinity, max = Infinity) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function boolOf(v, fallback) {
  return typeof v === 'boolean' ? v : typeof v === 'string' ? v === 'true' : fallback;
}

function mergeLevelEntry(raw) {
  const d = defaultLevelEntry();
  if (!raw || typeof raw !== 'object') return d;
  return {
    cleared: boolOf(raw.cleared, d.cleared),
    rank: RANKS.includes(raw.rank) ? raw.rank : null,
    perfectRate: numOf(raw.perfectRate, d.perfectRate, 0, 1),
    maxCombo: Math.round(numOf(raw.maxCombo, d.maxCombo, 0, 1e6)),
    miss: Math.round(numOf(raw.miss, d.miss, 0, 1e6)),
    encounterRate: numOf(raw.encounterRate, d.encounterRate, 0, 1)
  };
}

function mergeGroup(raw, defaults, numberRanges = {}) {
  const out = { ...defaults };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(defaults)) {
      const dv = defaults[key];
      if (typeof dv === 'number') {
        const range = numberRanges[key] || {};
        out[key] = numOf(raw[key], dv, range.min ?? -Infinity, range.max ?? Infinity);
      } else if (typeof dv === 'boolean') {
        out[key] = boolOf(raw[key], dv);
      } else if (dv === null) {
        out[key] = raw[key] === null ? null : out[key];
      }
    }
    // 前向兼容：未知字段原样保留（T5 字段只增不改）
    for (const key of Object.keys(raw)) {
      if (!(key in defaults)) out[key] = raw[key];
    }
  }
  return out;
}

/**
 * 字段级合并（不做整体覆盖）：缺失字段用默认值，已有字段做类型校验后保留。
 * 任何输入（null / 数字 / 数组 / 半截对象）都不会抛错。
 * @param {unknown} raw
 */
export function mergeSave(raw) {
  const d = defaultSave();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
  const out = {
    version: SAVE_VERSION,
    levels: {},
    audio: mergeGroup(raw.audio, d.audio, {
      latencyOffset: { min: -200, max: 200 },
      master: { min: 0, max: 1 },
      music: { min: 0, max: 1 },
      sfx: { min: 0, max: 1 }
    }),
    options: mergeGroup(raw.options, d.options),
    meta: mergeGroup(raw.meta, d.meta, {
      firstPlayedAt: { min: 0, max: Number.MAX_SAFE_INTEGER },
      totalRuns: { min: 0, max: Number.MAX_SAFE_INTEGER }
    })
  };
  if (raw.levels && typeof raw.levels === 'object' && !Array.isArray(raw.levels)) {
    for (const key of Object.keys(raw.levels)) {
      if (!/^\d{1,3}$/.test(key)) continue;
      const entry = mergeLevelEntry(raw.levels[key]);
      const prev = out.levels[key];
      if (!prev) out.levels[key] = entry;
      else {
        out.levels[key] = {
          cleared: entry.cleared || prev.cleared,
          rank: bestRank(entry.rank, prev.rank),
          perfectRate: Math.max(entry.perfectRate, prev.perfectRate),
          maxCombo: Math.max(entry.maxCombo, prev.maxCombo),
          miss: entry.miss,
          encounterRate: Math.max(entry.encounterRate, prev.encounterRate)
        };
      }
    }
  }
  for (const key of Object.keys(raw)) {
    if (!(key in d)) out[key] = raw[key];
  }
  return out;
}

const RANK_ORDER = { S: 4, A: 3, B: 2, C: 1, null: 0 };

function bestRank(a, b) {
  return (RANK_ORDER[a] ?? 0) >= (RANK_ORDER[b] ?? 0) ? a ?? b : b;
}

function deepMerge(target, source) {
  const out = { ...target };
  if (!source || typeof source !== 'object') return out;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv === undefined) continue;
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 模块内状态（单存档，PRD 无多 Profile 需求）                           */
/* ------------------------------------------------------------------ */

let current = null;
let degraded = false;
let notice = null;
let timer = null;
let boundStorage = null;

function pickStorage(injected) {
  if (injected === null) return null;
  if (injected && typeof injected.getItem === 'function') return injected;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    return null; // 隐私模式：访问即抛
  }
  return null;
}

function markDegraded(reason) {
  if (!degraded) {
    notice = notice || reason;
    console.warn(`[save] ${reason} → 本次会话使用内存档，不阻断游戏（SAV-03）`);
  }
  degraded = true;
}

/** 真正落盘；任何异常都吞掉并降级。 */
export function flushSave(storage) {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const st = storage !== undefined ? pickStorage(storage) : boundStorage;
  if (!st) return false;
  try {
    st.setItem(SAVE_KEY, JSON.stringify(current ?? defaultSave()));
    return true;
  } catch (err) {
    markDegraded(`localStorage 写入失败（${err?.name || 'Error'}）`);
    return false;
  }
}

/**
 * 读档：JSON 损坏 / 字段缺失 / 存储不可用 → 默认档 + 降级标记，不抛错。
 * @param {Storage|null} [storage] 注入桩；显式传 null 表示「禁用存储」
 */
export function loadSave(storage) {
  const st = storage !== undefined ? pickStorage(storage) : boundStorage;
  boundStorage = st;
  if (!st) {
    markDegraded('localStorage 不可用（隐私模式或 iframe 分区）');
    current = mergeSave(current ?? defaultSave());
    return current;
  }
  let text = null;
  try {
    text = st.getItem(SAVE_KEY);
  } catch (err) {
    markDegraded(`localStorage 读取被拒（${err?.name || 'Error'}）`);
    current = mergeSave(current ?? defaultSave());
    return current;
  }
  if (text === null || text === undefined || text === '') {
    current = defaultSave();
    return current;
  }
  try {
    current = mergeSave(JSON.parse(text));
  } catch {
    markDegraded('存档 JSON 已损坏 → 用全新默认档');
    current = defaultSave();
  }
  return current;
}

/** 当前内存档（首次访问时读盘）。 */
export function getSave(storage) {
  if (current === null) loadSave(storage);
  return current;
}

/**
 * 更新并节流写入（SAV-02）。
 * @param {object|((save:object)=>object|void)} patch 增量对象或变异函数
 * @param {{storage?:Storage|null, throttleMs?:number, now?:()=>number}} [opts]
 */
export function updateSave(patch, opts = {}) {
  if (opts.storage !== undefined || boundStorage === null) boundStorage = pickStorage(opts.storage);
  if (current === null) loadSave(boundStorage);
  const base = current ?? defaultSave();
  let next = patch;
  if (typeof patch === 'function') {
    const mutated = patch(deepMerge(base, {}));
    next = mutated && typeof mutated === 'object' ? mutated : undefined;
  }
  const merged = mergeSave(next === undefined ? base : deepMerge(base, next));
  if (merged.meta.firstPlayedAt === 0 && opts.stampMeta !== false) {
    merged.meta.firstPlayedAt = opts.now ? opts.now() : Date.now();
  }
  current = merged;
  const throttle = Number.isFinite(opts.throttleMs) ? Math.max(0, opts.throttleMs) : WRITE_THROTTLE_MS;
  if (timer !== null) return current;
  if (throttle <= 0) {
    flushSave();
    return current;
  }
  timer = setTimeout(() => {
    timer = null;
    flushSave();
  }, throttle);
  // Node 里不让节流定时器吊住进程（浏览器无此方法）
  timer?.unref?.();
  return current;
}

/** 覆盖写入整档（导入/重置用）。 */
export function writeSave(raw, opts = {}) {
  current = mergeSave(raw);
  if (opts.immediate === false) return current;
  flushSave(opts.storage);
  return current;
}

/** 清档并落盘。 */
export function resetSave(opts = {}) {
  current = defaultSave();
  degraded = false;
  notice = null;
  flushSave(opts.storage);
  return current;
}

/** 是否处于「内存档」降级态（设置界面据此显示一次性提示）。 */
export function isDegraded() {
  return degraded;
}

/** 取走一次性提示文案（取后即清，SAV-03「一次性提示」）。 */
export function consumeNotice() {
  const n = notice;
  notice = null;
  return n;
}

/** 测试/自检用：清空模块内状态。 */
export function __resetSaveState() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  current = null;
  degraded = false;
  notice = null;
  boundStorage = null;
}

/** 便捷：某关的进度条目（缺省给默认值，不写回）。 */
export function levelEntry(save, levelId) {
  const s = save ?? getSave();
  const key = String(levelId);
  if (!/^\d{1,3}$/.test(key)) return defaultLevelEntry();
  return { ...defaultLevelEntry(), ...(s.levels?.[key] ?? {}) };
}

export default {
  SAVE_KEY,
  SAVE_VERSION,
  WRITE_THROTTLE_MS,
  defaultSave,
  mergeSave,
  loadSave,
  getSave,
  updateSave,
  writeSave,
  flushSave,
  resetSave,
  levelEntry,
  isDegraded,
  consumeNotice
};
