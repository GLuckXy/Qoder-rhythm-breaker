// tools/playtestReport.mjs — Owner: leader（新增工具，不属于任何 agent 的任务卡）
//
// 为什么存在：K-19 的验收是「3 名试玩者事件流分析 → deltaMs 分布 → 判定窗口终值」，verify 写的是
// `contract:window-cfg` + `🚩分布报告`。导出侧早就通了（DebugPanel 的「导出事件流」→ judge 的
// exportEvents），但**读回侧一个工具都没有**——也就是说那条人类门禁连产生自己证据的手段都缺。
// 本工具补的就是这一环，并且把条约 T22 的四路归因做成**可计算的判据**，而不是一段话：
//   |delta| 稳定偏正 → CORE（校准）；偏散 → WORLD（读谱/预告）；集中在某类障碍 → SOUND（谱面）；
//   集中在变速附近 → CORE（时钟）。归因没做出来之前，两个 agent 同时改代码「试一下」= 条约违规。
//
// 纪律：本工具**不改任何生产代码、不写 config.js**（K-19 才是改它的卡）。它只读数、给判据、给反事实。
// 与其余门禁同一约定：最后一行必须 `RESULT: PASS|FAIL|SKIP <细节>`；SKIP 不算通过。
// 没有真人数据时永远 SKIP——不许拿合成样本冒充试玩结论（合成的只用于自测，见 --selftest）。

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEVEL_DIR = resolve(HERE, '../src/data/levels');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const MIN_PLAYERS = Number(flag('min-players', 3));

/* ------------------------------------------------------------------ */
/* 统计基元（手写，不引依赖）                                          */
/* ------------------------------------------------------------------ */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function sorted(list) {
  return list.slice().sort((a, b) => a - b);
}

/** 线性插值分位（q∈[0,1]）：空数组返回 NaN，绝不返回 0 冒充「没有偏差」。 */
function quantile(list, q) {
  const s = sorted(list);
  const n = s.length;
  if (!n) return Number.NaN;
  if (n === 1) return s[0];
  const pos = Math.min(Math.max(q, 0), 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const median = (list) => quantile(list, 0.5);

function mean(list) {
  if (!list.length) return Number.NaN;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

function sd(list) {
  const n = list.length;
  if (n < 2) return Number.NaN;
  const m = mean(list);
  return Math.sqrt(list.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}

const f = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '—');
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');

/* ------------------------------------------------------------------ */
/* 事件流解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * C7 事件流的 judge 行（src/game/systems/JudgeSystem.js:59）：`{t, kind:'judge', grade, id, deltaMs, rule}`。
 * t 是**逻辑秒**（`:432` 传的是 atSec），不是拍。
 * 三类行的含义不同，混在一个池子里算分布会得出错误结论：
 *  · PERFECT/GOOD —— 玩家真的有输入，deltaMs = 输入秒 − 障碍时刻，这才是「手感」；
 *  · MISS + rule:'window'（`:531`）—— 超时补发，deltaMs 取的是窗口边缘值，**没有输入**，只能算超时率；
 *  · MISS + rule:'emptyBeat'（`:393`）—— 空拍无目标，deltaMs 是「离最近障碍多远」，与时机准确性无关。
 * 所以主分布只用第一类。
 */
function classify(events, label) {
  const errors = [];
  const timed = []; // 有输入的真实偏差（ms，带符号）
  const timeouts = []; // {id, track, level}
  const empties = 0;
  let judgeRows = 0;
  const levels = new Set();

  if (!Array.isArray(events)) {
    return { errors: [`${label}: 顶层不是数组（期望 exportEvents 的原始事件列表）`], levels, timed, timeouts, empties, judgeRows };
  }
  for (const e of events) {
    if (!e || e.kind !== 'judge') continue;
    judgeRows += 1;
    const parsed = idParts(e.id);
    if (parsed && parsed.level != null) levels.add(parsed.level);
    if (!isNum(e.deltaMs)) continue;
    if (e.rule === 'emptyBeat') continue;
    if (e.grade === 'PERFECT' || e.grade === 'GOOD') {
      timed.push({ deltaMs: e.deltaMs, ...parsed, grade: e.grade, t: isNum(e.t) ? e.t : null, beat: isNum(e.beat) ? e.beat : null, player: label });
    } else if (e.grade === 'MISS' && e.rule === 'window') {
      timeouts.push({ ...parsed, t: isNum(e.t) ? e.t : null });
    } else {
      errors.push(`${label}: 未预期的 judge 行 grade=${e.grade} rule=${e.rule}`);
    }
  }
  return { errors, timed, timeouts, empties, judgeRows, levels, label };
}

/** id 惯例 `{N}-{track}-{i}`（SOUND 现行）或 `lv{N}-{track}-{NNN}`（C4 旧口径），两种都吃。 */
function idParts(id) {
  const m = /^(?:lv)?(\d+)-(kick|bass|synth)-\d+$/i.exec(String(id || ''));
  if (!m) return { level: null, track: null };
  return { level: Number(m[1]), track: m[2].toLowerCase() };
}

/* ------------------------------------------------------------------ */
/* 关卡侧上下文（变速附近归因要真按拍算，不猜秒）                      */
/* ------------------------------------------------------------------ */

async function levelContext(levelNo) {
  if (!levelNo) return null;
  const path = resolve(LEVEL_DIR, `level${levelNo}.json`);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { levelNo, path, cfg: null, tempoBeats: [], bpm: null };
  }
  const base = Number(cfg.bpm);
  // 变速点直接用**拍**表达：事件里只要有 beat 就能判定「±2 拍内」，
  // 不需要把秒换算回来（时钟原点 originSec 是运行时量，离线拿不到，见 CR-18）。
  const tempoBeats = (cfg.tempoChanges || [])
    .map((tc) => ({
      beat: Number(tc.beat),
      toBpm: Number(tc.bpm),
      fromBpm: base,
      transitionBeats: Number.isFinite(Number(tc.transitionBeats)) ? Number(tc.transitionBeats) : 0
    }))
    .filter((tc) => Number.isFinite(tc.beat) && tc.beat > 0);
  return { levelNo, path, cfg, tempoBeats, bpm: base };
}

/* ------------------------------------------------------------------ */
/* T22 四路归因                                                        */
/* ------------------------------------------------------------------ */

const T22 = {
  biasAbsMs: 15, // 稳定偏正/偏负：|中位| ≥ 15
  tightIqrMs: 30, // 且足够集中：IQR ≤ 30 → 才是「系统性偏移」，可用校准吃掉
  scatterIqrMs: 40, // 偏散：IQR ≥ 40
  scatterSdMs: 45, // 偏散：sd ≥ 45
  trackGapMs: 25, // 某声部整体比别的慢/快 ≥ 25
  tempoGapMs: 25, // 变速 ±2 拍内的中位偏差比全局差 ≥ 25
  minCell: 8 // 单元格样本不足 8 条不下结论（否则是噪声）
};

function attribute(all, timeouts, ctxByLevel) {
  const deltas = all.map((r) => r.deltaMs);
  const iqr = quantile(deltas, 0.75) - quantile(deltas, 0.25);
  const med = median(deltas);
  const spread = sd(deltas);
  const out = [];

  const bias = Math.abs(med) >= T22.biasAbsMs && isNum(iqr) && iqr <= T22.tightIqrMs;
  out.push({
    branch: '① 稳定偏移 → CORE（校准）',
    hit: bias,
    detail: `中位 ${f(med)}ms，IQR ${f(iqr)}ms（判据 |中位|≥${T22.biasAbsMs} 且 IQR≤${T22.tightIqrMs}）`,
    action: bias ? '先跑校准小游戏（K-14），把整体偏移吃掉再看残余；不许先动窗口' : '不成立：偏移不显著或不集中'
  });

  const scatter = (isNum(iqr) && iqr >= T22.scatterIqrMs) || (isNum(spread) && spread >= T22.scatterSdMs);
  out.push({
    branch: '② 偏散 → WORLD（读谱/预告）',
    hit: scatter,
    detail: `IQR ${f(iqr)}ms，sd ${f(spread)}ms（判据 IQR≥${T22.scatterIqrMs} 或 sd≥${T22.scatterSdMs}）`,
    action: scatter ? '问题在「看不看得准」：时间轴预告窗/形状编码/上下层对齐，不是窗口数字' : '不成立：离散度在可接受范围内'
  });

  const byTrack = {};
  for (const r of all) (byTrack[r.track] = byTrack[r.track] || []).push(r.deltaMs);
  const trackRows = Object.entries(byTrack)
    .filter(([, v]) => v.length >= T22.minCell)
    .map(([k, v]) => ({ track: k, n: v.length, med: median(v), p90abs: quantile(v.map(Math.abs), 0.9) }))
    .sort((a, b) => a.med - b.med);
  const trackGap = trackRows.length >= 2 ? trackRows[trackRows.length - 1].med - trackRows[0].med : Number.NaN;
  const trackHit = isNum(trackGap) && trackGap >= T22.trackGapMs;
  out.push({
    branch: '③ 集中在某类障碍 → SOUND（谱面）',
    hit: trackHit,
    detail: trackRows.map((r) => `${r.track}: n${r.n} 中位${f(r.med)}ms`).join(' ｜ ') + ` → 极差 ${f(trackGap)}ms（判据 ≥${T22.trackGapMs}）`,
    action: trackHit ? `某声部的可打性有问题（排位/密度/同拍），改 ${trackRows[trackRows.length - 1].track} 的谱面而不是窗口` : '不成立：三声部没有系统性差异'
  });

  const withBeat = all.filter((r) => isNum(r.beat));
  const changes = [];
  for (const r of withBeat) {
    const ctx = ctxByLevel.get(r.level);
    for (const tb of ctx?.tempoBeats || []) if (!changes.some((c) => c.level === r.level && c.beat === tb.beat)) changes.push({ ...tb, level: r.level });
  }
  const near = [];
  const far = [];
  for (const r of withBeat) {
    const ctx = ctxByLevel.get(r.level);
    const close = (ctx?.tempoBeats || []).some((tb) => Math.abs(r.beat - tb.beat) <= 2);
    (close ? near : far).push(r.deltaMs);
  }
  // 没有 beat 字段就**没有口径**：按 T21 取保守，这一路明确报「无法判定」，
  // 不许拿 t（绝对秒）猜原点，也不许把「没命中」写成「没问题」。
  const noBeat = all.length > 0 && withBeat.length === 0;
  const nearMed = median(near);
  const farMed = median(far);
  const tempoGap = isNum(nearMed) && isNum(farMed) ? Math.abs(nearMed - farMed) : Number.NaN;
  const tempoHit = !noBeat && isNum(tempoGap) && tempoGap >= T22.tempoGapMs && near.length >= T22.minCell;
  out.push({
    branch: '④ 集中在变速附近 → CORE（时钟）',
    hit: tempoHit,
    na: noBeat,
    detail: noBeat
      ? `无口径：${all.length} 条时机样本全都没有 beat 字段（judge 事件只有 t 绝对秒，离线拿不到时钟原点，不能猜）`
      : `变速±2拍内 n${near.length} 中位 ${f(nearMed)}ms，其余 n${far.length} 中位 ${f(farMed)}ms，差 ${f(tempoGap)}ms（判据 ≥${T22.tempoGapMs} 且 n≥${T22.minCell}）；本关变速点 ${changes.map((c) => `L${c.level}@${c.beat}拍→${c.toBpm}bpm`).join('，') || '无'}`,
    action: noBeat
      ? '先补遥测再谈归因：CR-18 要求 CORE 在 judge 事件加 beat 字段（T5 只增字段），加完之后这一路才有效'
      : tempoHit ? '变速段的拍↔秒换算或预调度有系统误差：查 BeatClock 分段积分与 horizon，不是玩家手感' : '不成立：变速附近没有异常聚集'
  });

  const timeoutByTrack = {};
  for (const r of timeouts) timeoutByTrack[r.track] = (timeoutByTrack[r.track] || 0) + 1;
  return { rows: out, iqr, med, spread, trackGap, timeoutByTrack };
}

/* ------------------------------------------------------------------ */
/* 窗口反事实：用真分布回答「窗口该定多大」                            */
/* ------------------------------------------------------------------ */

/**
 * ★ 必须**逐关**算：`LEVEL_WINDOW_SCALE`（L-07）本身是每关一档（L1 1.2 → L6 0.95），
 *   玩家实际经历的窗口是 `resolveWindows({scale: windowScaleFor(关)})`，不是全局 60/110。
 *   拿全局口径去对比真分布，会得出「窗口太松」的假结论。
 */
async function counterfactual(rows) {
  const { resolveWindows, windowScaleFor, JUDGE_CONFIG } = await import('../src/data/config.js');
  const gradeOf = (win, d) => (d <= win.perfectMs ? 'PERFECT' : d <= win.goodMs ? 'GOOD' : 'MISS');
  const mix = (win, list) => {
    const c = { PERFECT: 0, GOOD: 0, MISS: 0 };
    for (const d of list) c[gradeOf(win, d)] += 1;
    return c;
  };
  const build = (list) => {
    const a = list.map((r) => Math.abs(r.deltaMs));
    const p90 = Math.ceil(quantile(a, 0.9));
    const p97 = Math.ceil(quantile(a, 0.97));
    const perfectMs = Math.max(p90, JUDGE_CONFIG.floor.perfectMs);
    const goodMs = Math.max(p97, JUDGE_CONFIG.floor.goodMs, perfectMs);
    const scale = Number((goodMs / JUDGE_CONFIG.goodMs).toFixed(3));
    const viaScale = resolveWindows({ scale });
    return {
      n: a.length,
      current: resolveWindows({ scale: windowScaleFor(list[0]?.level) }),
      currentScale: windowScaleFor(list[0]?.level),
      recommend: { perfectMs, goodMs },
      p90,
      p97,
      windowScale: scale,
      viaScale,
      // K-19 只许改 config.js：推荐必须能只用 scale（或基准值之一）表达出来
      reproducible: Math.abs(viaScale.goodMs - goodMs) <= 1 && Math.abs(viaScale.perfectMs - perfectMs) <= 1,
      mixAt: mix({ perfectMs, goodMs }, a),
      absAll: a
    };
  };

  const overall = build(rows);
  overall.currentMix = mix(overall.current, overall.absAll);
  delete overall.absAll;

  const byLevel = new Map();
  for (const r of rows) (byLevel.get(r.level) || byLevel.set(r.level, []).get(r.level)).push(r);
  const perLevel = new Map();
  for (const [lv, list] of byLevel) {
    if (!lv) continue;
    const c = build(list);
    c.currentMix = mix(c.current, c.absAll);
    delete c.absAll;
    perLevel.set(lv, c);
  }
  return { overall, perLevel, mix, gradeOf };
}

/* ------------------------------------------------------------------ */
/* 合成自测（只验工具自身，绝不冒充试玩结论）                          */
/* ------------------------------------------------------------------ */

async function selftest() {
  const results = [];
  const push = (name, ok, note) => results.push({ name, ok, note });
  const mk = (rows) => rows.map((r) => ({ kind: 'judge', t: 1, deltaMs: 0, ...r }));

  // ① 稳定偏正：全体 +40ms，窄散布
  const bias = mk(Array.from({ length: 40 }, (_, i) => ({ grade: 'GOOD', id: `1-kick-${i}`, deltaMs: 40 + (i % 5) - 2 })));
  const a1 = classify(bias, 'synthetic-bias');
  const c1 = new Map([[1, { tempoBeats: [], levelNo: 1 }]]);
  const r1 = attribute(a1.timed, a1.timeouts, c1);
  push('① 稳定偏移命中 CORE 校准', r1.rows[0].hit === true && !r1.rows[1].hit, `中位${f(r1.med)} IQR${f(r1.iqr)}`);

  // ② 偏散：中位≈0 但跨度大
  const scatter = mk(Array.from({ length: 60 }, (_, i) => ({ grade: i % 3 ? 'GOOD' : 'PERFECT', id: `1-bass-${i}`, deltaMs: ((i * 37) % 181) - 90 })));
  const r2 = attribute(classify(scatter, 'synthetic-scatter').timed, [], c1);
  push('② 偏散命中 WORLD 读谱', r2.rows[1].hit === true, `IQR${f(r2.iqr)} sd${f(r2.spread)}`);

  // ③ 某声部系统性慢
  const skew = mk([
    ...Array.from({ length: 20 }, (_, i) => ({ grade: 'GOOD', id: `1-kick-${i}`, deltaMs: 0 + (i % 3) })),
    ...Array.from({ length: 20 }, (_, i) => ({ grade: 'GOOD', id: `1-synth-${i}`, deltaMs: 55 + (i % 3) }))
  ]);
  const r3 = attribute(classify(skew, 'synthetic-track').timed, [], c1);
  push('③ 声部极差命中 SOUND 谱面', r3.rows[2].hit === true && isNum(r3.trackGap) && r3.trackGap >= 50, `极差 ${f(r3.trackGap)}ms`);

  // ④ 变速附近（真关 JSON 的真实变速点，不造假口径）
  const ctx4 = new Map([[4, await levelContext(4)]]);
  const chg = (ctx4.get(4)?.tempoBeats || [])[0]?.beat;
  const tempo = mk([
    ...Array.from({ length: 12 }, (_, i) => ({ grade: 'GOOD', id: `4-kick-${i}`, beat: chg + (i % 3) - 1, deltaMs: 80 + (i % 3) })),
    ...Array.from({ length: 30 }, (_, i) => ({ grade: 'GOOD', id: `4-bass-${i}`, beat: 8 + i, deltaMs: (i % 5) - 2 }))
  ]);
  const r4 = attribute(classify(tempo, 'synthetic-tempo').timed, [], ctx4);
  push('④ 变速聚集命中 CORE 时钟', r4.rows[3].hit === true && !r4.rows[3].na, r4.rows[3].detail);
  push('L4 真谱面有变速点可用', Number.isFinite(chg) && chg > 0, `level4.tempoChanges → beat ${chg}`);

  // ④ 缺 beat 字段时必须报「无口径」，不许报「不成立」
  const noBeatRows = classify(mk(Array.from({ length: 20 }, (_, i) => ({ grade: 'GOOD', id: `4-kick-${i}`, t: 10 + i, deltaMs: (i % 5) - 2 }))), 'synthetic-nobeat').timed;
  const r4b = attribute(noBeatRows, [], ctx4);
  push('缺 beat 时报无口径而非假阴性', r4b.rows[3].na === true && r4b.rows[3].hit === false && /CR-18/.test(r4b.rows[3].action), r4b.rows[3].detail);

  // 超时行不得进主分布
  const withTimeout = classify([
    ...mk([{ grade: 'GOOD', id: '1-kick-0', deltaMs: 5 }]),
    { kind: 'judge', grade: 'MISS', rule: 'window', id: '1-kick-1', deltaMs: 110, t: 2 },
    { kind: 'judge', grade: 'MISS', rule: 'emptyBeat', id: '1-kick-2', deltaMs: 300, t: 3 }
  ], 'synthetic-mix');
  push('超时/空拍不污染主分布', withTimeout.timed.length === 1 && withTimeout.timeouts.length === 1, `主分布${withTimeout.timed.length} 超时${withTimeout.timeouts.length}`);

  // 分位数与中位数对照（偶数取中间两值平均）
  push('中位数偶数口径', median([1, 2, 4, 8]) === 3, `median[1,2,4,8]=${median([1, 2, 4, 8])}`);

  // 反事实可只用 scale 表达（K-19 只改 config.js 的前提）+ 必须逐关算
  const mkRow = (i, level) => ({ deltaMs: ((i * 41) % 160) - 80, level });
  const cf = await counterfactual(Array.from({ length: 60 }, (_, i) => mkRow(i, 3)));
  const o = cf.overall;
  push('推荐窗口不击穿 floor', o.recommend.perfectMs >= 40 && o.recommend.goodMs >= 80 && o.recommend.goodMs >= o.recommend.perfectMs, `P${o.recommend.perfectMs} G${o.recommend.goodMs}`);
  push('current 用该关的 scale 而非全局基准', o.current.goodMs === 110 && o.currentScale === 1.0, `L3 scale=${o.currentScale} G=${o.current.goodMs}`);
  // scale 只能整体缩放：|delta| 的 p90/p97 比例 ≈ 60/110 时才可用单个 scale 表达。
  // 上面这份数据推荐 P73/G80（要同时「放宽 perfect、收紧 good」），数学上单 scale 做不到，
  // 工具必须如实报「需改基准值并走 CR」，不能假装能复现。
  push('不可单 scale 复现时如实标记', o.reproducible === false, `scale=${o.windowScale} → P${o.viaScale.perfectMs}/G${o.viaScale.goodMs} ≠ 目标 P${o.recommend.perfectMs}/G${o.recommend.goodMs}`);
  // 可复现的那一支：|delta| 的 p90/p97 恰好等于基准窗口按同一个 s=0.9 缩放（54/99 = 60/110 × 0.9），
  // 这时单个 windowScale 就能表达推荐口径。
  const near = [...Array.from({ length: 950 }, (_, i) => (i % 2 ? 54 : -54)), ...Array.from({ length: 50 }, (_, i) => (i % 2 ? 99 : -99))];
  const cfYes = await counterfactual(near.map((d) => ({ deltaMs: d, level: 3 })));
  push('可单 scale 复现时如实标记', cfYes.overall.reproducible === true && cfYes.overall.windowScale === 0.9,
    `推荐 P${cfYes.overall.recommend.perfectMs}/G${cfYes.overall.recommend.goodMs} ← scale ${cfYes.overall.windowScale} 解出 P${cfYes.overall.viaScale.perfectMs}/G${cfYes.overall.viaScale.goodMs}`);
  const cfL = await counterfactual([
    ...Array.from({ length: 30 }, (_, i) => mkRow(i, 1)),
    ...Array.from({ length: 30 }, (_, i) => mkRow(i, 5)),
  ]);
  push('反事实逐关分列（L1≠L5 现行窗口）', cfL.perLevel.size === 2 && cfL.perLevel.get(1).currentScale === 1.2 && cfL.perLevel.get(5).currentScale === 0.95,
    `L1 G=${cfL.perLevel.get(1)?.current?.goodMs} L5 G=${cfL.perLevel.get(5)?.current?.goodMs}`);

  let bad = 0;
  for (const r of results) {
    if (!r.ok) bad += 1;
    console.log(`[${r.ok ? 'OK  ' : 'FAIL'}] ${r.name}${r.note ? `  — ${r.note}` : ''}`);
  }
  console.log(`\n自测只验证工具自身的判据分支；合成数据不是试玩结论，不得写进 STATE 的分布报告。`);
  console.log(`RESULT: ${bad ? 'FAIL' : 'PASS'} playtestReport 自测 ${results.length - bad}/${results.length}`);
  process.exit(bad ? 1 : 0);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  if (has('selftest')) return selftest();

  const players = [];
  for (const path of files) {
    let raw;
    try {
      raw = readFileSync(resolve(path), 'utf8');
    } catch (e) {
      console.log(`RESULT: FAIL 读不到事件流文件 ${path}（${e.code || e.message}）`);
      process.exit(1);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.log(`RESULT: FAIL ${path} 不是合法 JSON：${e.message}`);
      process.exit(1);
    }
    players.push(classify(parsed, path.replace(/^.*[\\/]/, '').replace(/\.json$/i, '')));
  }

  const errors = players.flatMap((p) => p.errors).filter((m) => !m.includes('未预期的 judge'));
  const unknownRule = players.flatMap((p) => p.errors).filter((m) => m.includes('未预期的 judge'));
  const timed = players.flatMap((p) => p.timed);
  const timeouts = players.flatMap((p) => p.timeouts);
  const levels = new Set(players.flatMap((p) => p.levels));

  console.log(`# 试玩事件流分布报告（tools/playtestReport.mjs）`);
  console.log(`试玩者 ${players.length} 名（门禁要求 ≥${MIN_PLAYERS}）· 关卡 ${[...levels].sort().join('/') || '未识别'} · judge 行合计 ${players.reduce((a, p) => a + p.judgeRows, 0)}`);
  console.log(`可用时机样本 ${timed.length} 条（有输入的 PERFECT/GOOD）· 超时未输入 ${timeouts.length} 条 · 空拍行不计入时机`);
  if (unknownRule.length) console.log(`提示：${unknownRule.length} 条 judge 行口径未预期，未进分布（按 T21 取保守：宁可不采样也不猜语义）`);
  if (errors.length) console.log(`解析错误：${errors.join('；')}`);

  if (timed.length === 0) {
    console.log(`RESULT: SKIP 没有可用的真人时机样本（事件流为空或缺 deltaMs）——本门禁不接受合成数据顶替`);
    process.exit(0);
  }

  const ctxByLevel = new Map();
  for (const lv of levels) ctxByLevel.set(lv, await levelContext(lv));

  const deltas = timed.map((r) => r.deltaMs);
  const abs = deltas.map(Math.abs);
  const at = attribute(timed, timeouts, ctxByLevel);

  console.log(`\n## deltaMs 分布（带符号；正=打晚了）`);
  console.log(`p10 ${f(quantile(deltas, 0.1))} · p25 ${f(quantile(deltas, 0.25))} · 中位 ${f(at.med)} · p75 ${f(quantile(deltas, 0.75))} · p90 ${f(quantile(deltas, 0.9))} · IQR ${f(at.iqr)} · sd ${f(at.spread)}`);
  console.log(`|delta| p50 ${f(median(abs))} · p90 ${f(quantile(abs, 0.9))} · p97 ${f(quantile(abs, 0.97))} · max ${f(Math.max(...abs))}`);
  console.log(`按试玩者：${players.map((p) => `${p.label} n${p.timed.length} 中位${f(median(p.timed.map((r) => r.deltaMs)))}`).join(' ｜ ')}`);

  console.log(`\n## T22 归因（四路各自给判据与数字）`);
  for (const r of at.rows) {
    console.log(`${r.na ? '⚠无口径' : r.hit ? '★命中 ' : '     —   '}${r.branch}`);
    console.log(`         ${r.detail}`);
    console.log(`         ${r.action}`);
  }
  const hits = at.rows.filter((r) => r.hit).map((r) => r.branch);
  console.log(`归属结论：${hits.length ? hits.join(' + ') : '四路都不显著——那么问题不在参数，按 T22 不许并发改代码试手感'}`);

  console.log(`\n## 窗口反事实（现状窗口 vs 用真分布推出来的窗口；只读，不改 config.js）`);
  const cf = await counterfactual(timed);
  const mixLine = (m, n) => `PERFECT ${pct(m.PERFECT, n)} · GOOD ${pct(m.GOOD, n)} · MISS ${pct(m.MISS, n)}`;
  const o = cf.overall;
  console.log(`合在一起看  现行 P${o.current.perfectMs}/G${o.current.goodMs} → ${mixLine(o.currentMix, o.n)}｜推荐 P${o.recommend.perfectMs}/G${o.recommend.goodMs} → ${mixLine(o.mixAt, o.n)}`);
  console.log(`（推荐口径 = |delta| 的 p90/p97，且不低于 floor 40/80；合在一起看只是量级参考，逐关口径见下表）`);
  if (cf.perLevel.size) {
    console.log(`\n逐关（★玩家实际经历的是本关的 scale，不是全局 60/110）`);
    for (const [lv, c] of [...cf.perLevel.entries()].sort((a, b) => a[0] - b[0])) {
      const gain = c.mixAt.PERFECT - c.currentMix.PERFECT;
      console.log(`  L${lv} n${c.n} scale ${c.currentScale} → 现行 P${c.current.perfectMs}/G${c.current.goodMs}｜推荐 P${c.recommend.perfectMs}/G${c.recommend.goodMs}（windowScale ${c.windowScale}${c.reproducible ? '，可只改 config.js 复现' : '，需改基准值并走 CR'}）`);
      console.log(`        ${mixLine(c.currentMix, c.n)} → ${mixLine(c.mixAt, c.n)}（PERFECT ${gain >= 0 ? '+' : ''}${f(gain)} 个百分点）`);
    }
  }
  console.log(`超时未输入按声部：${Object.entries(at.timeoutByTrack).map(([k, v]) => `${k} ${v}`).join(' ｜ ') || '无'}`);

  const enoughPlayers = players.length >= MIN_PLAYERS;
  const enoughSamples = timed.length >= 30;
  const verdict = enoughPlayers && enoughSamples && !errors.length ? 'PASS' : 'SKIP';
  console.log(`\nRESULT: ${verdict} ${verdict === 'PASS' ? `${players.length} 名试玩者 · ${timed.length} 条时机样本 · 归因 ${hits.length || '无'} 路命中` : `条件不足（试玩者 ${players.length}/${MIN_PLAYERS}，时机样本 ${timed.length}/30）——报告可看，门禁不算过`}`);
  process.exit(0);
}

main().catch((e) => {
  console.log(`RESULT: FAIL 工具自身异常 ${e.message}`);
  process.exit(1);
});
