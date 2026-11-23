// src/audio/ReplayAssembler.js — Owner: SOUND（S-18，范围严格按 leader 决策 L-06）
//
// ★ 本轮只做「2× 分轨重组」：输入 C7 事件流，输出按 `hp` 事件顺序重组的分轨时刻表 + 每关统计。
//   完整版回放（任意时刻分层启动 + 操作剪影同步）是条约里的预砍项，本文件不做，也不许在别处做。
//
// 口径来源（不许各写一份）：
//  · CR-08 批复第 1 点：**先判 `penalizes === false` 再落 `grade`**——空拍伪 MISS 不算 MISS、不进任何分母。
//    `DisassembleSystem.onJudgment` 已按此过滤一次，本文件只做「读侧」的同一判据，不加新分支语义。
//  · C3 口径：Perfect 率分母 = **本关可判定障碍总数（固定）**，不随复活/重开变化；
//    `judgable === false` 的 bed 实例不进分母（C5 字段规则 + CR-09 批复）。
//  · C3：复活后 hp → 1，该类障碍从**当前拍之后**恢复，**不补发历史**（`catchUp:false` 是硬口径）。
//  · C1/T4：向 clock 要时刻（`beatAt` / `timeAtBeat`），本文件**绝不**自己乘除 60/bpm；
//    没有 clock 时把拍域字段留 null，而不是退回等速除法。
//  · 2× 只是播放倍率：倍速只缩放 `t`，**不改变事件顺序**（L-06）。
//  · 静音/复活只用斜坡：分段边界是逻辑时刻，发声侧仍由 TrackMixer 的 RAMP（0.1s / 0.15s）平滑，
//    本文件不产生任何瞬时赋值。
//
// 纯函数 + Node 可断言（职责卡纪律 4：SOUND 听不到波形，只有结构能被验证）。

import { RAMP } from './TrackMixer.js';

/** 回放倍率：L-06 只做 2×，其它倍率同样只是 `t` 的缩放。 */
export const REPLAY_SPEED = 2;
/** 允许的倍率白名单（超出范围只 warn，不改变顺序语义）。 */
export const REPLAY_SPEEDS = Object.freeze([1, 1.5, 2]);

const JUDGE_TRACK_ORDER = Object.freeze(['kick', 'bass', 'synth']);
const EPS = 1e-9;

/* ------------------------------------------------------------------ */
/* C7 事件流的读侧判据（字段名照 JudgeSystem.EventLog 的实际产出）        */
/* ------------------------------------------------------------------ */

/**
 * 是否计入判定统计。C7 的 judge 事件形如 `{t, kind:'judge', grade, id, deltaMs, rule}`；
 * `penalizes === false`（或等价的 `rule:'emptyBeat'`）的空拍伪 MISS **不算 MISS**（CR-08 第 1 点）。
 * @param {object} ev
 * @returns {boolean}
 */
export function isScoringEvent(ev) {
  if (!ev || ev.kind !== 'judge') return false;
  if (ev.penalizes === false) return false;
  if (ev.rule === 'emptyBeat') return false;
  return ev.grade === 'PERFECT' || ev.grade === 'GOOD' || ev.grade === 'MISS';
}

/** 空拍伪判定（只统计数量，不进任何率值）。 */
export function isEmptyBeatEvent(ev) {
  if (!ev || ev.kind !== 'judge') return false;
  return ev.penalizes === false || ev.rule === 'emptyBeat';
}

/**
 * 倍速只缩放时刻，不改顺序：返回等长的新数组，`t` 除以倍率，其余字段原样（含引用字段）。
 * @param {object[]} events
 * @param {number} [speed]
 * @returns {object[]}
 */
export function scaleEvents(events, speed = REPLAY_SPEED) {
  const k = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const list = Array.isArray(events) ? events : [];
  return list.map((ev) => ({ ...ev, t: Number(ev && ev.t) / k }));
}

/**
 * 可判定障碍总数 = Perfect 率的固定分母（C3）。
 * `judgable === false` 的 bed 实例被排除；按 id 去重，重开/复活不会把分母变大。
 * @param {object[]|null} instances
 * @returns {number}
 */
export function judgableTotal(instances) {
  if (!Array.isArray(instances)) return 0;
  const seen = new Set();
  for (const it of instances) {
    if (!it || it.judgable === false) continue;
    if (typeof it.id !== 'string' || !it.id) continue;
    seen.add(it.id);
  }
  return seen.size;
}

/** 核心节点总数（同样是固定分母，只数 judgable 的实例）。 */
export function coreTotal(instances) {
  if (!Array.isArray(instances)) return 0;
  const seen = new Set();
  for (const it of instances) {
    if (!it || it.judgable === false || !it.core) continue;
    if (typeof it.id !== 'string' || !it.id) continue;
    seen.add(it.id);
  }
  return seen.size;
}

/* ------------------------------------------------------------------ */
/* 分轨时刻表                                                           */
/* ------------------------------------------------------------------ */

function trackStartHp(levelCfg, track) {
  const t = levelCfg && levelCfg.tracks ? levelCfg.tracks[track] : null;
  const hp = t && Number.isFinite(t.hp) ? t.hp : 0;
  return hp > 0 ? Math.round(hp) : 0;
}

/** 本关参与的声部：tracks 里 hp>0 者 ∪ 事件流里出现过 hp 事件的声部，按 kick/bass/synth 优先排序。 */
function activeTracks(levelCfg, hpEvents) {
  const set = new Set();
  if (levelCfg && levelCfg.tracks) {
    for (const name of Object.keys(levelCfg.tracks)) if (trackStartHp(levelCfg, name) > 0) set.add(name);
  }
  for (const ev of hpEvents) if (typeof ev.track === 'string' && ev.track) set.add(ev.track);
  return [...set].sort((a, b) => {
    const ia = JUDGE_TRACK_ORDER.indexOf(a);
    const ib = JUDGE_TRACK_ORDER.indexOf(b);
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function beatOf(clock, sec) {
  if (!clock || typeof clock.beatAt !== 'function' || !Number.isFinite(sec)) return null;
  const b = clock.beatAt(sec);
  return Number.isFinite(b) ? b : null;
}

function secOfBeat(clock, beat) {
  if (!clock || typeof clock.timeAtBeat !== 'function' || !Number.isFinite(beat)) return null;
  const s = clock.timeAtBeat(beat);
  return Number.isFinite(s) ? s : null;
}

/**
 * 一条声部的 hp 区间表：每个 `hp` 事件都恰好是一个区间边界（不多不少），
 * 复活后的区间只在 `[openSec, closeSec)` 内取点，因此天然「不补发历史」。
 */
function buildStem(track, startHp, hpEvents, opts) {
  const { t0Sec, endSec, clock, points } = opts;
  const segs = [];
  let hp = startHp;
  let openSec = t0Sec;
  let openKind = 'start';
  const audible = () => hp > 0;

  const close = (atSec, why) => {
    if (!Number.isFinite(atSec) || atSec <= openSec + EPS) return;
    segs.push(mkSegment({ track, openSec, closeSec: atSec, hp, kind: openKind, why, clock, points }));
  };

  for (const ev of hpEvents) {
    const at = Number(ev.t);
    const next = Number.isFinite(ev.hp) ? Math.round(ev.hp) : hp;
    if (audible()) close(at, 'hp');
    const wasSilent = hp <= 0;
    hp = next;
    if (hp > 0) {
      openSec = at;
      openKind = wasSilent ? 'revive' : 'damage';
    } else {
      openSec = at;
      openKind = 'silent';
    }
  }
  if (hp > 0 && Number.isFinite(endSec) && endSec > openSec) close(endSec, 'level-end');

  const boundaries = [];
  for (const s of segs) {
    boundaries.push(s.openSec);
    boundaries.push(s.closeSec);
  }
  const dedup = [...new Set(boundaries)];
  dedup.sort((a, b) => a - b);
  return {
    track,
    hpStart: startHp,
    hpEnd: hp,
    silent: hp <= 0,
    segments: segs,
    boundaries: dedup,
    activeSec: segs.reduce((a, s) => a + (s.closeSec - s.openSec), 0),
    pointCount: segs.reduce((a, s) => a + s.points.length, 0),
    missedWhileSilent: segs.length
      ? points.filter((p) => p.track === track && p.timeSec >= segs[0].openSec - EPS
        && !segs.some((s) => p.timeSec >= s.openSec - EPS && p.timeSec < s.closeSec - EPS)).length
      : 0
  };
}

function mkSegment({ track, openSec, closeSec, hp, kind, why, clock, points }) {
  const openBeat = beatOf(clock, openSec);
  const seg = {
    track,
    openSec,
    closeSec,
    hp,
    kind, // 'start' | 'damage' | 'revive'
    edge: why, // 这条区间的右边界来自哪个 hp 事件（或关尾）
    openBeat,
    closeBeat: beatOf(clock, closeSec),
    // C3：复活只从「当前拍之后」恢复，不补发历史。
    catchUp: false,
    resumeFromBeat: kind === 'revive' && Number.isFinite(openBeat) ? Math.ceil(openBeat - EPS) : null,
    rampSec: kind === 'revive' ? RAMP.reviveSec : RAMP.silenceSec,
    points: []
  };
  for (const p of points) {
    if (p.track !== track) continue;
    if (p.timeSec < openSec - EPS) continue; // 不补发：区间起点之前的历史点一律不回收
    if (p.timeSec >= closeSec - EPS) continue;
    seg.points.push(p);
  }
  return seg;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

/**
 * 2× 分轨重组（S-18，L-06 范围）。
 *
 * @param {object} input
 * @param {object[]} [input.events]     C7 事件流（`{t,kind:'judge'|'hp'|'input'|'state',...}`），t 为秒
 * @param {object[]} [input.instances]  PatternGenerator 的 ObstacleInstance[]（提供固定分母与 core 映射）
 * @param {object}   [input.levelCfg]   C5 level JSON（`tracks[].hp`、`lengthBeats`）
 * @param {object}   [input.clock]      BeatClock（只用 beatAt/timeAtBeat）
 * @param {object[]} [input.schedule]   C6 buildSchedule 的输出，给了就顺带产出每段的可发声点
 * @param {number}   [input.speed]      播放倍率，默认 2；只缩放 t，不改顺序
 * @returns {{speed:number, startSec:number, endSec:number, stems:object[], timeline:object[],
 *            events:object[], stats:object, warnings:string[]}}
 */
export function assembleReplay(input = {}) {
  const warnings = [];
  const raw = Array.isArray(input.events) ? input.events : [];
  const speed = Number.isFinite(input.speed) && input.speed > 0 ? input.speed : REPLAY_SPEED;
  if (!REPLAY_SPEEDS.includes(speed)) warnings.push(`倍率 ${speed} 不在白名单 ${REPLAY_SPEEDS.join('/')} 内（顺序语义不变，只缩放 t）`);
  if (!raw.length) warnings.push('事件流为空：重组结果只有静默的声部骨架');

  const clock = input.clock || null;
  if (!clock) warnings.push('没有传入 clock：拍域字段留 null（本模块不许自己乘 60/bpm）');

  // 顺序防御：C7 约定按 t 升序，EventLog._push 已保证；这里只做稳定性校验，不重排。
  const outOfOrder = raw.some((ev, i) => i > 0 && Number(ev.t) < Number(raw[i - 1].t) - EPS);
  if (outOfOrder) warnings.push('事件流未按 t 升序（C7 约定被破坏），统计按输入顺序照算');

  const events = speed === 1 ? raw.map((ev) => ({ ...ev })) : scaleEvents(raw, speed);
  const byKind = (kind) => events.filter((ev) => ev && ev.kind === kind);

  const hpEvents = byKind('hp');
  const judgeEvents = events.filter((ev) => ev && ev.kind === 'judge');
  const stateEvents = byKind('state');
  const inputEvents = byKind('input');

  const instancePoints = Array.isArray(input.instances)
    ? input.instances.filter((it) => it && Number.isFinite(it.timeSec)).map((it) => ({
      track: it.track, timeSec: it.timeSec, id: it.id, core: !!it.core, judgable: it.judgable !== false
    }))
    : [];
  const sched = Array.isArray(input.schedule) ? input.schedule : [];
  const points = sched.length
    ? sched.filter((p) => p && Number.isFinite(p.timeSec)).map((p) => ({ track: p.track, timeSec: p.timeSec, id: p.id ?? null, core: false, judgable: true }))
    : instancePoints;

  const firstT = events.length ? Number(events[0].t) : 0;
  const startSec = secOfBeat(clock, 0) ?? Math.min(firstT, 0);
  const lengthBeats = input.levelCfg && Number.isFinite(input.levelCfg.lengthBeats) ? input.levelCfg.lengthBeats : null;
  const endBeat = lengthBeats != null ? lengthBeats : (beatOf(clock, Math.max(firstT, 0)) ?? 0);
  const endSec = Math.max(secOfBeat(clock, endBeat) ?? firstT, firstT);
  if (endSec <= startSec) warnings.push('关尾时刻不晚于关首：区间表退化为空');

  const tracks = activeTracks(input.levelCfg, hpEvents);
  if (!tracks.length) warnings.push('本关没有任何 hp 声部（tracks 全 hp:0 且事件流无 hp 事件）');
  const stems = tracks.map((track) => buildStem(
    track,
    trackStartHp(input.levelCfg, track),
    hpEvents.filter((ev) => ev.track === track),
    { t0Sec: startSec, endSec, clock, points }
  ));

  // 时间线：把每条声部的区间边界摊平成一个升序时刻表，回放侧照它排 UI。
  const timeline = [];
  for (const s of stems) {
    for (const seg of s.segments) {
      timeline.push({ t: seg.openSec, beat: seg.openBeat, track: s.track, hp: seg.hp, from: seg.kind, to: 'audible' });
      timeline.push({ t: seg.closeSec, beat: seg.closeBeat, track: s.track, hp: seg.hp, from: 'audible', to: seg.hp > 0 ? 'hp-change' : 'silent' });
    }
  }
  timeline.sort((a, b) => a.t - b.t);

  const stats = summarize({
    judgeEvents,
    inputEvents,
    stateEvents,
    hpEvents,
    stems,
    instances: input.instances,
    levelCfg: input.levelCfg,
    clock,
    startSec,
    endSec,
    speed,
    warnings
  });

  return { speed, startSec, endSec, stems, timeline, events, stats, warnings };
}

/** CORE-3 结算界面直接调这个：只要统计，不要区间表。 */
export function summarizeReplay(input = {}) {
  return assembleReplay(input).stats;
}

function summarize({ judgeEvents, inputEvents, stateEvents, hpEvents, stems, instances, levelCfg, clock, startSec, endSec, speed, warnings }) {
  const counts = { PERFECT: 0, GOOD: 0, MISS: 0 };
  const byTrack = {};
  let combo = 0;
  let maxCombo = 0;
  let emptyBeats = 0;
  let sumAbsDeltaMs = 0;
  const coreHit = new Set();
  const judgedIds = new Set();
  const coreMap = new Map();
  const trackMap = new Map();
  if (Array.isArray(instances)) {
    for (const it of instances) {
      if (!it || typeof it.id !== 'string') continue;
      coreMap.set(it.id, !!it.core && it.judgable !== false);
      if (typeof it.track === 'string') trackMap.set(it.id, it.track);
    }
  }

  for (const ev of judgeEvents) {
    if (isEmptyBeatEvent(ev)) {
      emptyBeats += 1;
      continue;
    }
    if (!isScoringEvent(ev)) continue;
    counts[ev.grade] += 1;
    const tr = typeof ev.track === 'string' && ev.track ? ev.track : (trackMap.get(ev.id) || 'unknown');
    byTrack[tr] = (byTrack[tr] || { PERFECT: 0, GOOD: 0, MISS: 0 });
    byTrack[tr][ev.grade] += 1;
    if (Number.isFinite(ev.deltaMs)) sumAbsDeltaMs += Math.abs(ev.deltaMs);
    if (typeof ev.id === 'string' && ev.id) judgedIds.add(ev.id);
    if (ev.grade === 'PERFECT' && coreMap.get(ev.id)) coreHit.add(ev.id);
    if (ev.grade === 'MISS') {
      combo = 0;
    } else {
      combo += 1;
      if (combo > maxCombo) maxCombo = combo;
    }
  }

  // 分母固定（C3）：优先用 instances；没给就退回「事件流里出现过的 id 数」并明确警告。
  let denominator = judgableTotal(instances);
  let coreCount = coreTotal(instances);
  let denominatorSource = 'instances';
  if (!Array.isArray(instances) || !instances.length) {
    denominatorSource = 'events-fallback';
    denominator = judgedIds.size;
    coreCount = coreHit.size;
    warnings.push('未提供 instances：Perfect 率分母退回事件流出现过的障碍数（口径不固定，仅供冒烟）');
  }

  const disassembled = disassemblyMoment(stateEvents, stems, hpEvents, clock);
  const revives = stems.reduce((a, s) => a + s.segments.filter((seg) => seg.kind === 'revive').length, 0);

  return {
    counts,
    perfectRate: denominator > 0 ? counts.PERFECT / denominator : 0,
    goodRate: denominator > 0 ? counts.GOOD / denominator : 0,
    missRate: denominator > 0 ? counts.MISS / denominator : 0,
    denominator,
    denominatorSource,
    coreTotal: coreCount,
    coreHit: coreHit.size,
    coreHitRate: coreCount > 0 ? coreHit.size / coreCount : 0,
    maxCombo,
    miss: counts.MISS,
    judged: counts.PERFECT + counts.GOOD + counts.MISS,
    emptyBeats,
    avgAbsDeltaMs: counts.PERFECT + counts.GOOD + counts.MISS > 0
      ? Math.round(sumAbsDeltaMs / (counts.PERFECT + counts.GOOD + counts.MISS))
      : 0,
    byTrack,
    inputs: inputEvents.length,
    inputsNoTarget: inputEvents.filter((ev) => ev.hasTarget === false).length,
    hpEvents: hpEvents.length,
    revives,
    stems: stems.map((s) => ({
      track: s.track,
      hpStart: s.hpStart,
      hpEnd: s.hpEnd,
      segments: s.segments.length,
      activeSec: Number(s.activeSec.toFixed(3)),
      boundaries: s.boundaries.length,
      pointCount: s.pointCount,
      missedWhileSilent: s.missedWhileSilent
    })),
    disassembledAtSec: disassembled.atSec,
    disassembledAtBeat: disassembled.beat,
    disassembledSource: disassembled.source, // 'state' | 'hp' | null
    silenceSecAfterDisassemble: disassembled.atSec == null ? null : Number(Math.max(0, endSec - disassembled.atSec).toFixed(3)),
    totalSec: Number(Math.max(0, endSec - startSec).toFixed(3)),
    scaledTotalSec: Number((Math.max(0, endSec - startSec) / speed).toFixed(3)),
    speed,
    levelId: levelCfg && levelCfg.id != null ? levelCfg.id : null,
    title: levelCfg && levelCfg.title ? levelCfg.title : null,
    rampSec: { silence: RAMP.silenceSec, revive: RAMP.reviveSec }
  };
}

/** 拆解完成时刻：优先 C7 `state` 事件的 DISASSEMBLED，退回「最后一个把某声部打到 0 的 hp 事件」。 */
function disassemblyMoment(stateEvents, stems, hpEvents, clock) {
  for (const ev of stateEvents) {
    if (ev.to === 'DISASSEMBLED' || ev.to === 'SILENCE') {
      const at = Number(ev.t);
      return { atSec: at, beat: beatOf(clock, at), source: 'state' };
    }
  }
  const live = stems.filter((s) => s.hpStart > 0);
  if (!live.length) return { atSec: null, beat: null, source: null };
  const allSilent = live.every((s) => s.hpEnd <= 0);
  if (!allSilent) return { atSec: null, beat: null, source: null };
  const lastZero = hpEvents
    .filter((ev) => Number(ev.hp) <= 0 && live.some((s) => s.track === ev.track))
    .reduce((acc, ev) => (acc == null || Number(ev.t) > acc ? Number(ev.t) : acc), null);
  return { atSec: lastZero, beat: Number.isFinite(lastZero) ? beatOf(clock, lastZero) : null, source: 'hp' };
}

/**
 * 人造事件流（给 Node 断言与 `?selftest=replay` 用）：
 * 一份「三声部在同一拍被打通到 0」的剧本，用来复现「拆解瞬间安静」。
 * @param {{trackHps?:Record<string,number>, atSec?:number}} [opts]
 * @returns {object[]}
 */
export function syntheticSilenceEvents(opts = {}) {
  const trackHps = opts.trackHps || { kick: 4, bass: 4, synth: 4 };
  const at = Number.isFinite(opts.atSec) ? opts.atSec : 8;
  const events = [];
  for (const track of Object.keys(trackHps)) {
    let hp = trackHps[track];
    while (hp > 0) {
      hp -= 1;
      events.push({ t: at - hp * 0.05, kind: 'hp', track, hp });
    }
  }
  events.push({ t: at, kind: 'state', from: 'PEAK', to: 'DISASSEMBLED' });
  events.sort((a, b) => a.t - b.t);
  return events;
}

/** 自检（浏览器 `?selftest=replay` 与 tools/audioAssert.mjs 共用同一份判据）。 */
export function replaySelfTest() {
  const errors = [];
  const warnings = [];
  const isoClock = {
    stub: true,
    label: 'isoClock 等速桩（仅自检）',
    beatAt: (t) => t,
    timeAtBeat: (b) => b
  };
  const levelCfg = { id: 0, title: 'selftest', lengthBeats: 16, tracks: { kick: { hp: 4 }, bass: { hp: 4 }, synth: { hp: 0 } } };
  const instances = [];
  for (let i = 0; i < 8; i += 1) {
    const track = i % 2 ? 'bass' : 'kick';
    instances.push({ id: `lv0-${track}-${String(i).padStart(3, '0')}`, track, core: i < 4, timeSec: i * 2, beat: i * 2, judgable: true });
  }
  instances.push({ id: 'lv0-bed-000', track: 'bed', type: 'bed', core: false, timeSec: 1, beat: 1, judgable: false });

  const judge = instances
    .filter((it) => it.judgable) // bed 实例不产 judge 事件（C5/C3 口径），因此也不进任何分子
    .map((it) => ({ t: it.timeSec, kind: 'judge', grade: 'PERFECT', id: it.id, deltaMs: 5, rule: 'window' }));
  judge.push({ t: 1.5, kind: 'judge', grade: 'MISS', id: null, deltaMs: 0, rule: 'emptyBeat', penalizes: false });
  const hp = [];
  const hpNow = { kick: 4, bass: 4 };
  for (const it of instances) {
    if (!it.core) continue;
    hpNow[it.track] -= 1;
    hp.push({ t: it.timeSec, kind: 'hp', track: it.track, hp: hpNow[it.track] });
  }
  const events = [...judge, ...hp, { t: 3, kind: 'input', key: 'jump', hasTarget: false }, { t: 14, kind: 'state', from: 'PEAK', to: 'DISASSEMBLED' }]
    .sort((a, b) => a.t - b.t);

  const one = assembleReplay({ events, instances, levelCfg, clock: isoClock, speed: 1 });
  const two = assembleReplay({ events, instances, levelCfg, clock: isoClock, speed: 2 });

  if (one.stats.denominator !== 8) errors.push(`分母应为可判定障碍 8（bed 不进分母），实得 ${one.stats.denominator}`);
  if (one.stats.emptyBeats !== 1) errors.push(`空拍伪 MISS 应被单独计数，实得 ${one.stats.emptyBeats}`);
  if (one.stats.counts.MISS !== 0) errors.push(`penalizes:false 竟被算成 MISS：${one.stats.counts.MISS}`);
  if (one.stats.perfectRate !== 1) errors.push(`Perfect 率应为 8/8=1，实得 ${one.stats.perfectRate}`);
  if (one.stats.maxCombo !== 8) errors.push(`maxCombo 应为 8，实得 ${one.stats.maxCombo}`);
  if (one.stats.coreHitRate !== 1) errors.push(`核心命中率应为 1，实得 ${one.stats.coreHitRate}`);
  if (one.stats.disassembledAtSec !== 14) errors.push(`拆解时刻应取 state 事件 14，实得 ${one.stats.disassembledAtSec}`);

  // 倍速只缩放 t，不动顺序
  if (two.events.length !== one.events.length) errors.push('倍速改变了事件数量');
  const sameOrder = two.events.every((ev, i) => ev.id === one.events[i].id && ev.kind === one.events[i].kind);
  if (!sameOrder) errors.push('倍速改变了事件顺序（L-06 禁止）');
  const ratio = two.events.filter((ev) => ev.t !== 0).map((ev, i) => (one.events.filter((x) => x.t !== 0)[i] || {}).t / ev.t);
  if (!ratio.every((r) => Math.abs(r - 2) < 1e-9)) errors.push(`倍速没有精确把 t 缩到 1/2：${ratio.slice(0, 3).join(', ')}`);
  if (two.stats.disassembledAtSec * 2 !== one.stats.disassembledAtSec) errors.push('拆解时刻未随倍速等比缩放');

  // 分轨边界与 hp 事件时刻严格一致
  const bErr = replayBoundaryErrors(one);
  errors.push(...bErr);

  // 拆解瞬间安静
  const silenceEvents = syntheticSilenceEvents({ trackHps: { kick: 4, bass: 4 }, atSec: 8 });
  const sil = assembleReplay({
    events: [...silenceEvents, { t: 9, kind: 'judge', grade: 'PERFECT', id: 'lv0-kick-000', deltaMs: 0, rule: 'window' }],
    instances,
    levelCfg,
    clock: isoClock,
    speed: 1
  });
  const after = sil.stems.reduce((a, s) => a + s.segments.filter((seg) => seg.closeSec > 8 + EPS && seg.openSec < 8 + EPS).length, 0);
  if (after !== 0) errors.push(`拆解瞬间（8s）之后仍有 ${after} 段声部在响`);
  if (sil.stats.disassembledAtSec !== 8) errors.push(`人造剧本的拆解时刻应为 8，实得 ${sil.stats.disassembledAtSec}`);

  // 复活不补发历史
  const revEvents = [...silenceEvents];
  revEvents.push({ t: 10, kind: 'hp', track: 'kick', hp: 1 });
  revEvents.sort((a, b) => a.t - b.t);
  const rev = assembleReplay({ events: revEvents, instances, levelCfg, clock: isoClock, speed: 1 });
  const kick = rev.stems.find((s) => s.track === 'kick');
  const revived = kick.segments.filter((seg) => seg.kind === 'revive');
  if (revived.length !== 1) errors.push(`kick 应恰有 1 段复活区间，实得 ${revived.length}`);
  else {
    if (revived[0].catchUp !== false) errors.push('复活区间不许补发历史（catchUp 必须为 false）');
    if (revived.some((seg) => seg.points.some((p) => p.timeSec < seg.openSec - EPS))) errors.push('复活区间里出现了起点之前的历史发声点');
  }
  if (rev.stats.revives !== 1) errors.push(`复活计数应为 1，实得 ${rev.stats.revives}`);

  if (RAMP.silenceSec !== 0.1 || RAMP.reviveSec !== 0.15) warnings.push('斜坡常量与 C6 文档不一致（只警告，由 audioAssert 定红）');

  return { errors, warnings, stats: one.stats, stats2x: two.stats, stems: one.stems.length };
}

/**
 * 断言用：分轨区间边界必须与该声部 `hp` 事件时刻**严格一致**（集合相等，非容差）。
 * @param {{stems:object[],events:object[]}} replay
 * @returns {string[]}
 */
export function replayBoundaryErrors(replay) {
  const errors = [];
  const hpByTrack = new Map();
  for (const ev of replay.events) {
    if (!ev || ev.kind !== 'hp') continue;
    if (!hpByTrack.has(ev.track)) hpByTrack.set(ev.track, []);
    hpByTrack.get(ev.track).push(Number(ev.t));
  }
  for (const stem of replay.stems) {
    const hp = hpByTrack.get(stem.track) || [];
    if (!hp.length) {
      if (stem.segments.some((seg) => seg.edge !== 'level-end')) errors.push(`声部 ${stem.track} 没有任何 hp 事件却切出了非关尾的区间`);
      continue;
    }
    const firstOpen = stem.segments.length ? stem.segments[0].openSec : NaN;
    const lastClose = stem.segments.length ? stem.segments[stem.segments.length - 1].closeSec : NaN;
    // 「按 hp 事件顺序重组」：hp 事件（除与关首重合的那一个）逐项等于区间表里由 hp 产生的边界，
    // 复活段的左边界也必须是 hp 事件时刻。
    const edges = [];
    for (const seg of stem.segments) {
      if (seg.edge === 'hp') edges.push(seg.closeSec);
      if (seg.kind === 'revive') edges.push(seg.openSec);
    }
    const a = [...new Set(hp.filter((t) => t > firstOpen + EPS))].sort((x, y) => x - y).join(',');
    const b = [...new Set(edges)].sort((x, y) => x - y).join(',');
    if (a !== b) errors.push(`声部 ${stem.track} 的分轨边界与 hp 事件时刻不一致：hp[${a}] vs 边界[${b}]`);
    for (const t of stem.boundaries) {
      const isHp = hp.some((h) => Math.abs(h - t) < EPS);
      if (!isHp && t !== firstOpen && t !== lastClose) errors.push(`声部 ${stem.track} 出现了既非 hp 事件也非关首/关尾的边界时刻 ${t}`);
    }
  }
  return errors;
}

export default assembleReplay;
