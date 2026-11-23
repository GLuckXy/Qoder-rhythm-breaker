// tools/checkLevel.mjs — Owner: SOUND（S-04 / S-06 / S-10 的 verify 端）。
// 用法：node tools/checkLevel.mjs [--all | --lv N[,M]] [--json] [--quiet]
// 约定：最后一行必须打印 `RESULT: PASS|FAIL|SKIP <细节>`，否则 tools/verifyAll.mjs 判 FAIL。
//
// 时钟来源优先级：
//   1) src/audio/BeatClock.js + src/mocks/MockClock.js（CORE 的真实现，Node 手动模式）
//   2) 本文件内部的契约桩 stubClock()（仅当 1 缺失时使用，输出里会注明）
// 桩只写在这里，不落任何 src/ 文件（T2：BeatClock/MockClock 归 CORE）。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  build,
  buildAll,
  buildSchedule,
  selfTest,
  analyzeRests,
  arrivalSpacing,
  silenceStartBeat,
  actionRecoveryBeats,
  validateGhosts,
  validateTempoChanges,
  validateFreeOrder,
  feasibility,
  MIN_SAME_TRACK_GAP,
  MIN_TRACK_SPACING_BEATS,
  BREATHE_WINDOW_BEATS,
  DENSITY_WINDOW_BEATS,
  DENSITY_WINDOW_MAX
} from '../src/game/systems/PatternGenerator.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEVEL_DIR = join(ROOT, 'src', 'data', 'levels');
const SECONDS_RANGE = [60, 90];
const introOf = (cfg) => Number(cfg.introBeats) || 0;

/* ----------------------------- 时钟装配 ----------------------------- */

/**
 * C1 契约的最小桩：分段积分（拍长线性过渡，与 BeatClock 同一口径），带非零 originSec，
 * 用于证明生成器没有偷偷假设「第 0 拍 = 0 秒」。
 */
function stubClock(levelCfg, originSec = 1.25) {
  const base = Number(levelCfg.bpm) || 120;
  const changes = (Array.isArray(levelCfg.tempoChanges) ? levelCfg.tempoChanges : [])
    .map((c) => ({ beat: Number(c.beat), bpm: Number(c.bpm), trans: Number.isFinite(Number(c.transitionBeats)) ? Math.max(0, Number(c.transitionBeats)) : 0 }))
    .filter((c) => Number.isFinite(c.beat) && c.beat > 0 && Number.isFinite(c.bpm) && c.bpm > 0)
    .sort((a, b) => a.beat - b.beat);
  const segs = [];
  let cb = 0;
  let ct = 0;
  let p = 60 / base;
  const constSeg = (b1) => {
    if (!(b1 > cb)) return;
    segs.push({ b0: cb, b1, p0: p, k: 0, t0: ct });
    ct += (b1 - cb) * p;
    cb = b1;
  };
  for (const ch of changes) {
    const p1 = 60 / ch.bpm;
    const start = Math.max(cb, ch.beat - ch.trans);
    constSeg(start);
    const span = ch.beat - cb;
    if (span > 0) {
      segs.push({ b0: cb, b1: ch.beat, p0: p, k: (p1 - p) / (2 * span), t0: ct });
      ct += span * ((p + p1) / 2);
      cb = ch.beat;
    }
    p = p1;
  }
  segs.push({ b0: cb, b1: Infinity, p0: p, k: 0, t0: ct });
  const at = (b) => {
    const seg = segs.find((s) => b < s.b1) || segs[segs.length - 1];
    const x = b - seg.b0;
    return originSec + seg.t0 + x * seg.p0 + seg.k * x * x;
  };
  return {
    stub: true,
    originSec: () => originSec,
    beatLengthSec: (b) => {
      const seg = segs.find((s) => b < s.b1) || segs[segs.length - 1];
      return seg.p0 + 2 * seg.k * Math.max(0, Math.min(b, seg.b1 === Infinity ? seg.b1 + 1 : seg.b1) - seg.b0);
    },
    timeAtBeat: at,
    beatAt: (t) => {
      const s = t - originSec;
      const seg = segs.find((x) => s < (x.b1 === Infinity ? Infinity : x.t0 + (x.b1 - x.b0) * x.p0)) || segs[segs.length - 1];
      const dt = s - seg.t0;
      if (Math.abs(seg.k) < 1e-15) return seg.b0 + dt / seg.p0;
      const disc = seg.p0 * seg.p0 + 4 * seg.k * dt;
      return seg.b0 + (2 * dt) / (seg.p0 + Math.sqrt(Math.max(0, disc)));
    }
  };
}

let clockKind = 'tools 内部桩';
async function makeClock(levelCfg) {
  try {
    const mod = await import('../src/mocks/MockClock.js');
    const clock = new mod.MockClock({ t: 0 });
    clock.init({ bpm: levelCfg.bpm, sections: levelCfg.sections, tempoChanges: levelCfg.tempoChanges, introBeats: levelCfg.introBeats, lengthBeats: levelCfg.lengthBeats });
    clock.start(1.25); // 非零原点：任何「假设第 0 拍 = 0 秒」的实现都会被下面的互逆断言抓出来
    clockKind = 'src/mocks/MockClock.js（CORE 真实现，手动模式，originSec=1.25）';
    return clock;
  } catch {
    clockKind = 'tools 内部桩（C1 最小契约实现，含非零 originSec 与分段积分）';
    return stubClock(levelCfg);
  }
}

/* ----------------------------- 逐关检查 ----------------------------- */

function checkLevel(cfg, clock) {
  const errors = [];
  const warnings = [];
  const instances = build(cfg, clock);
  const all = buildAll(cfg, clock);
  const res = selfTest(cfg, instances, clock);
  errors.push(...res.errors);
  warnings.push(...res.warnings);
  const stats = res.stats;

  // S-02：hp=0 的**可判定**声部即使有事件也必须被裁掉（build 不输出，buildAll 标 inactive）
  for (const [track, tc] of Object.entries(cfg.tracks || {})) {
    if (!['kick', 'bass', 'synth'].includes(track)) continue; // bed 是 hp:0 的发声专用轨（CR-05）
    const declared = ((cfg.noteEvents || {})[track] || []).length;
    const emitted = all.filter((i) => i.track === track && i.active).length;
    if (Number(tc.hp) === 0) {
      if (declared > 0 && emitted > 0) errors.push(`${track}: hp=0 却产出了 ${emitted} 个障碍`);
      if (declared > 0) warnings.push(`${track}: hp=0 但 JSON 里仍有 ${declared} 条事件（纪律 3：不发声不生成，建议清空）`);
      if (all.some((i) => i.track === track && i.inactiveReason !== 'hp0')) errors.push(`${track}: hp=0 的事件未被标 inactiveReason='hp0'`);
    }
  }

  // CR-05：bed 音床必须存在、必须不可判定、必须落在可玩拍区间内（W-05 第三层 / W-07 分层重组依赖它）
  const bedAll = all.filter((i) => i.track === 'bed');
  if (!bedAll.length) errors.push('bed: 没有任何音床实例（六关都必须有）');
  if (bedAll.some((i) => i.judgable !== false || i.type !== 'bed' || i.core !== false)) errors.push('bed: 实例未被标为 judgable=false / type=bed / core=false');
  if (bedAll.some((i) => i.beat < introOf(cfg) - 1e-9 || i.beat > silenceStartBeat(cfg) + 1e-9)) errors.push('bed: 有实例落在 intro 安全区或寂静段之外');
  if (instances.filter((i) => i.track === 'bed').length !== bedAll.filter((i) => i.active).length) errors.push('bed: build() 与 buildAll() 的音床数量不一致');
  const spacing = arrivalSpacing(all, clock);
  if (spacing.some((g) => !(g.widthSec > 0))) errors.push('到达组拍长存在非正值（变速映射或时钟异常）');
  if (spacing.some((g) => !Number.isFinite(g.timeSec))) errors.push('到达组时刻存在非法值');
  if (all.some((i) => 'pxPerSec' in i || 'beatWidthSec' in i)) errors.push('实例仍带 pxPerSec/beatWidthSec（CR-09 批复要求删除，几何归 WORLD）');
  if (instances.length !== all.filter((i) => i.active).length) errors.push(`build() 与 buildAll().active 数量不一致：${instances.length} vs ${all.filter((i) => i.active).length}`);

  // 同源断言：发声序与障碍序必须来自同一份 noteEvents（MUS-03）
  const sched = buildSchedule(cfg, clock);
  for (const track of ['kick', 'bass', 'synth']) {
    if (Number((cfg.tracks || {})[track]?.hp) === 0) {
      if (sched.some((e) => e.track === track)) errors.push(`${track}: hp=0 却出现在发声序里`);
      continue;
    }
    const fromSched = sched.filter((e) => e.track === track && e.beat >= cfg.introBeats - 1e-9 && e.beat <= silenceStartBeat(cfg) + 1e-9);
    const fromBuild = instances.filter((i) => i.track === track);
    if (fromSched.length !== fromBuild.length) errors.push(`${track}: 发声事件 ${fromSched.length} ≠ 障碍 ${fromBuild.length}（谱曲即摆关卡的同源性被破坏）`);
    for (let i = 0; i < Math.min(fromSched.length, fromBuild.length); i++) {
      if (Math.abs(fromSched[i].timeSec - fromBuild[i].timeSec) > 1e-3) errors.push(`${track}: 第 ${i} 个事件发声时刻与障碍时刻不一致`);
    }
  }

  // 时刻与逆运算（T7 变速用例的前置）
  for (const i of instances) {
    const back = clock.beatAt(i.timeSec);
    if (Math.abs(back - i.beat) > 0.002) errors.push(`${i.id}: beatAt(timeSec)=${back.toFixed(4)} ≠ beat ${i.beat}`);
  }

  // 专项
  const ghosts = validateGhosts(cfg, instances);
  const tempo = validateTempoChanges(cfg);
  const free = validateFreeOrder(cfg, instances);
  errors.push(...ghosts.errors, ...tempo.errors, ...free.errors);
  warnings.push(...ghosts.warnings, ...tempo.warnings, ...free.warnings, ...feasibility(cfg, instances));

  // 喘息表（S-06）
  const rests = analyzeRests(cfg, instances);
  const lo = Number(cfg.introBeats) || 0;
  const hi = silenceStartBeat(cfg);
  let underBreathe = 0;
  for (let w = lo; w + BREATHE_WINDOW_BEATS <= hi; w++) {
    if (!rests.rests.some((r) => r.startBeat < w + BREATHE_WINDOW_BEATS && r.endBeat > w)) underBreathe++;
  }
  const emptyIntegers = [];
  for (let b = Math.ceil(lo); b < hi; b++) if (!instances.some((i) => Math.floor(i.beat) === b)) emptyIntegers.push(b);
  const sameBeatCross = new Map();
  for (const i of instances) sameBeatCross.set(i.beat, (sameBeatCross.get(i.beat) || 0) + 1);
  const crossDup = [...sameBeatCross.entries()].filter(([, n]) => n > 1);

  // 密度违规明细（同类 4 拍 >3 / 同轨 <1 拍）已在 selfTest 里，这里只做统计回显
  const perTrackMaxIn4 = {};
  for (const track of ['kick', 'bass', 'synth']) {
    const list = instances.filter((i) => i.track === track);
    let mx = 0;
    for (const a of list) mx = Math.max(mx, list.filter((i) => i.beat >= a.beat && i.beat < a.beat + DENSITY_WINDOW_BEATS).length);
    if (list.length) perTrackMaxIn4[track] = mx;
  }

  // §11 逐关专项门禁（leader 2026-11-23 追加：不许放宽这三条）
  const k = instances.filter((i) => i.track === 'kick');
  if (cfg.id === 1) {
    if (cfg.bpm !== 110 || cfg.lengthBeats !== 128 || cfg.silenceBeats !== 8 || cfg.windowScale !== 1.2) {
      errors.push('L1 参数偏离 §11（应 110BPM / 128 拍 / silenceBeats 8 / ×1.2）');
    }
    if (Number(cfg.tracks?.bass?.hp) !== 0 || Number(cfg.tracks?.synth?.hp) !== 0) errors.push('L1 应「仅鼓」：bass/synth 必须 hp=0');
    const off = k.filter((i) => Math.abs(i.beat % 1) > 1e-9);
    if (off.length) errors.push(`L1 kick 必须只在 4/4 正拍，发现 ${off.length} 个非正拍（首个 ${off[0].beat}）`);
    const head = k.filter((i) => i.beat <= 16);
    for (let i = 1; i < head.length; i++) if (head[i].beat - head[i - 1].beat !== 2) errors.push(`L1 前 16 拍必须每 2 拍一根桩（${head[i - 1].beat}→${head[i].beat}）`);
    if (head.length !== 7) errors.push(`L1 前 16 拍应有 7 根桩（4/6/8/10/12/14/16），实际 ${head.length}`);
    if (!head.slice(0, 4).every((i) => i.core)) errors.push('L1 核心节点必须是前 4 个正拍桩（4/6/8/10）');
    if (k.some((i) => i.beat > 112)) errors.push('L1 谱面应在 beat 112 收束，留 8 拍寂静段');
  }
  if (cfg.id === 2) {
    if (cfg.bpm !== 120 || cfg.lengthBeats !== 128 || cfg.silenceBeats !== 12 || cfg.windowScale !== 1.1) {
      errors.push('L2 参数偏离 §11（应 120BPM / 128 拍 / silenceBeats 12 / ×1.1）');
    }
    if (Number(cfg.tracks?.kick?.hp) !== 4 || Number(cfg.tracks?.bass?.hp) !== 4) errors.push('L2 应「鼓+贝斯」：kick/bass 都 hp=4');
    if (instances.some((i) => i.beat < 16 && i.track === 'bass')) errors.push('L2 段落 0–16 必须仅鼓（16 拍前不许出贝斯平台）');
    const mid = instances.filter((i) => i.beat >= 16 && i.beat < 96);
    if (!mid.some((i) => i.track === 'bass')) errors.push('L2 段落 16–96 必须鼓+贝斯');
    const hi2 = silenceStartBeat(cfg);
    const dens = (a, b) => instances.filter((i) => i.beat >= a && i.beat < b).length / ((b - a) / 4);
    const dMid = dens(16, 96);
    const dHigh = dens(96, hi2);
    if (!(dHigh > dMid)) errors.push(`L2 高密度段（96–${hi2}）密度 ${dHigh.toFixed(2)} 未高于主段 ${dMid.toFixed(2)}`);
    if (!instances.some((i) => i.beat >= 112 && i.beat < hi2)) errors.push('L2 收束段（112–寂静段）没有任何事件');
    const tiers = new Set(instances.filter((i) => i.track === 'bass').map((i) => i.pitchTier));
    if (tiers.size < 2) warnings.push(`L2 平台只用到 ${tiers.size} 档 pitchTier（§11 要求音高→三档）`);
  }

  // ---- §11 L3–L6 逐关门禁（R2 追加：新关卡的机制必须被断言触发，不许只有函数没有关卡）----
  const beatSecAt = (b) => (typeof clock.beatLengthSec === 'function' ? clock.beatLengthSec(b) : 60 / (Number(cfg.bpm) || 120));
  const threeTracks = (label) => {
    for (const t of ['kick', 'bass', 'synth']) if (Number(cfg.tracks?.[t]?.hp) !== 4) errors.push(`${label} 应三声部：${t}.hp 必须为 4`);
  };
  if (cfg.id === 3) {
    if (cfg.bpm !== 126 || cfg.lengthBeats !== 128 || cfg.silenceBeats !== 12 || cfg.windowScale !== 1.0) {
      errors.push('L3 参数偏离 §11（应 126BPM / 128 拍 / silenceBeats 12 / ×1.0）');
    }
    threeTracks('L3');
    // 弹幕只出现在冲刺拍（§11 L3 / R3 认知过载缓解）：落整数拍 + 上一到达已「落地+缓冲」完毕（玩家必定在地面上才谈得上冲刺），
    // 且冲刺本身（dashDurBeats + 缓冲）能在下一个到达之前走完。
    const sorted = [...instances].filter((i) => i.judgable !== false).sort((a, b) => a.beat - b.beat);
    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i];
      if (it.track !== 'synth') continue;
      if (Math.abs(it.beat % 1) > 1e-9) errors.push(`L3 弹幕 @${it.beat} 不在整数拍 → 不是可数的冲刺拍`);
      const prev = sorted[i - 1];
      const next = sorted[i + 1];
      if (prev) {
        const need = actionRecoveryBeats(beatSecAt(prev.beat)).jump;
        const gap = it.beat - prev.beat;
        if (gap < need - 1e-9) errors.push(`L3 弹幕 @${it.beat} 距上一到达 ${gap.toFixed(3)} 拍 < 跳跃恢复 ${need.toFixed(3)} 拍（玩家还在滞空，无法冲刺）`);
      }
      if (next) {
        const need = actionRecoveryBeats(beatSecAt(it.beat)).dash;
        const gap = next.beat - it.beat;
        if (gap < need - 1e-9) errors.push(`L3 弹幕 @${it.beat} 之后 ${gap.toFixed(3)} 拍就来下一到达 < 冲刺持续 ${need.toFixed(3)} 拍`);
      }
    }
    // 琶音时值 → 弹幕速度（OBS-04）：映射表必须真的把三档都跑出来，否则「看速度预判密度」落空
    const speeds = new Set(instances.filter((i) => i.track === 'synth').map((i) => i.speed));
    if (speeds.size < 3) errors.push(`L3 弹幕 speed 只映射出 ${speeds.size} 档（§11 要求 d→速度三档可辨）`);
    const durs = new Set(instances.filter((i) => i.track === 'synth').map((i) => i.durBeats));
    if (durs.size < 3) errors.push(`L3 琶音时值只有 ${durs.size} 种，映射不到三档速度`);
  }
  if (cfg.id === 4) {
    if (cfg.bpm !== 120 || cfg.lengthBeats !== 160 || cfg.silenceBeats !== 12 || cfg.windowScale !== 1.0) {
      errors.push('L4 参数偏离 §11（应 120→140 / 160 拍 / silenceBeats 12 / ×1.0）');
    }
    threeTracks('L4');
    const tc = Array.isArray(cfg.tempoChanges) ? cfg.tempoChanges : [];
    if (tc.length !== 1 || Number(tc[0].beat) !== 64 || Number(tc[0].bpm) !== 140 || Number(tc[0].transitionBeats) !== 2) {
      errors.push('L4 变速配置偏离 §11（应恰好一项：第 64 拍 120→140、过渡 2 拍）');
    } else {
      // CR-08 第 3 点 leader 批复口径 = 过渡区间对「拍长（周期）」线性插值（不是对 BPM 插值）→ 区间积分是梯形
      const pFrom = beatSecAt(62);
      const pTo = beatSecAt(64);
      const t62 = clock.timeAtBeat(62);
      const t64 = clock.timeAtBeat(64);
      const t66 = clock.timeAtBeat(66);
      if (Math.abs(pTo - 60 / 140) > 1e-6) errors.push(`L4 变速后拍长 ${pTo.toFixed(6)} ≠ 60/140=${(60 / 140).toFixed(6)}`);
      const trap = (pFrom + pTo) / 2 * 2;
      if (Math.abs((t64 - t62) - trap) > 2e-3) errors.push(`L4 过渡 2 拍实得 ${(t64 - t62).toFixed(5)}s ≠ 拍长线性梯形 ${trap.toFixed(5)}s（口径被改）`);
      if (Math.abs((t66 - t64) - 2 * pTo) > 2e-3) errors.push(`L4 变速后两拍 ${(t66 - t64).toFixed(5)}s ≠ 2×新拍长 ${(2 * pTo).toFixed(5)}s`);
      const inTransit = all.filter((i) => i.beat >= 62 - 1e-9 && i.beat < 64 - 1e-9);
      if (inTransit.length) errors.push(`L4 过渡区间 [62,64) 有 ${inTransit.length} 条谱面事件（含 bed）——这 2 拍必须留给变速提示音`);
      const post = instances.filter((i) => i.beat >= 64 - 1e-9);
      const bad = post.filter((i) => Math.abs(i.timeSec - clock.timeAtBeat(i.beat)) > 1e-4);
      if (bad.length) errors.push(`L4 变速后 ${bad.length} 个障碍的 timeSec ≠ timeAtBeat(beat)（例 ${bad[0].id}）`);
      stats.tempoPostEvents = post.length;
      stats.tempoTrapezoidSec = Number((t64 - t62).toFixed(4));
    }
  }
  if (cfg.id === 5) {
    if (cfg.bpm !== 128 || cfg.lengthBeats !== 144 || cfg.silenceBeats !== 12 || cfg.windowScale !== 0.95) {
      errors.push('L5 参数偏离 §11（应 128BPM / 144 拍 / silenceBeats 12 / ×0.95）');
    }
    threeTracks('L5');
    const gb = Array.isArray(cfg.ghostBeats) ? cfg.ghostBeats : [];
    if (!gb.length) errors.push('L5 ghostBeats 为空：§11 的假节拍机制没有落地（validateGhosts 就成了死代码）');
    if (ghosts.count !== gb.length) errors.push(`L5 validateGhosts 未被触发：count ${ghosts.count} ≠ 配置 ${gb.length}`);
    for (const g of gb) {
      const b = Number(g.beat);
      if (!(b >= lo - 1e-9 && b <= hi + 1e-9)) errors.push(`L5 ghost @${b} 落在可玩区 [${lo},${hi}] 外`);
      const len = Number(g.lengthBeats);
      if (!(len >= 1 && len <= 2)) errors.push(`L5 ghost @${b} 持续 ${len} 拍，§11 要求 1–2 拍`);
      if (!Number.isFinite(Number(g.offsetBeats))) errors.push(`L5 ghost @${b} 缺 offsetBeats（WORLD 的说谎位移量）`);
    }
    // 说谎的对象：核心拍已由 validateGhosts 硬拦；这里再量化「假标记里有多少压在真实到达拍上」
    const arrivals = new Set(instances.filter((i) => i.judgable !== false).map((i) => i.beat));
    const onReal = gb.filter((g) => arrivals.has(Number(g.beat))).length;
    stats.ghostsOnRealArrival = onReal;
    if (onReal < 2) warnings.push(`L5 假标记只有 ${onReal} 处压在真实到达拍上，「视觉说谎」偏弱`);
    // 压在真实到达拍上 = 设计意图（对非核心障碍拍说谎），核心拍已被 validateGhosts 硬拦，故这里不再报警。
    stats.ghostsOnEmptyBeats = gb.length - onReal;
  }
  if (cfg.id === 6) {
    if (cfg.bpm !== 132 || cfg.lengthBeats !== 160 || cfg.silenceBeats !== 12) {
      errors.push('L6 参数偏离 §11（应 132BPM / 160 拍 / silenceBeats 12）');
    }
    if (cfg.windowScale !== 0.95) errors.push(`L6 windowScale ${cfg.windowScale} ≠ 0.95（leader 决策 L-07：难度由密度表达，不用 §7.4 表的 0.9）`);
    if (cfg.freeOrder !== true) errors.push('L6 必须 freeOrder:true（§11 拆解顺序自选）');
    threeTracks('L6');
    if (free.errors.length === 0 && free.peakConcurrency < 3) errors.push(`L6 三声部核心同窗峰值 ${free.peakConcurrency} < 3`);
    let tri = 0;
    for (let b = lo; b + 4 <= hi; b++) {
      const s = new Set(instances.filter((i) => i.core && i.beat >= b && i.beat < b + 4).map((i) => i.track));
      if (s.size === 3) tri++;
    }
    stats.coreTriWindows = tri;
    if (tri < 4) errors.push(`L6 三声部核心同时在场的 4 拍窗只有 ${tri} 个（§11：三声部常驻可交互、任意顺序通关）`);
  }

  if (stats.seconds < SECONDS_RANGE[0] || stats.seconds > SECONDS_RANGE[1]) errors.push(`总时长 ${stats.seconds}s 不在 ${SECONDS_RANGE.join('–')}s`);  return {
    cfg,
    instances,
    schedule: sched,
    rests,
    stats: {
      ...stats,
      style: cfg.style,
      windowScale: cfg.windowScale,
      silenceStartBeat: hi,
      inactiveTotal: all.length - instances.length,
      breatheWindowsMissing: underBreathe,
      emptyIntegerBeats: emptyIntegers.length,
      sameBeatCrossCount: crossDup.length,
      maxPerTrackIn4Beats: perTrackMaxIn4,
      densityWindowMax: DENSITY_WINDOW_MAX,
      minSameTrackGap: MIN_SAME_TRACK_GAP,
      minTrackSpacing: MIN_TRACK_SPACING_BEATS,
      longestRest: rests.rests.reduce((m, r) => Math.max(m, r.beats), 0),
      scheduleEvents: sched.length
    },
    errors,
    warnings: warnings.filter((w) => w !== '（无）')
  };
}

/* ----------------------------- 输出 ----------------------------- */

const fmtRests = (rests, max = 12) => {
  if (!rests.length) return '（无）';
  const head = rests.slice(0, max).map((r) => `${r.startBeat}–${r.endBeat}(${r.beats})`);
  return head.join(' ') + (rests.length > max ? ` …共${rests.length}处` : '');
};

function table(rows) {
  const cols = [
    ['关', (r) => `L${r.stats.level}`],
    ['曲风', (r) => String(r.stats.style || '-')],
    ['BPM', (r) => String(r.stats.bpm)],
    ['拍', (r) => String(r.stats.lengthBeats)],
    ['秒', (r) => (Number.isFinite(r.stats.seconds) ? r.stats.seconds.toFixed(1) : '-')],
    ['障碍', (r) => String(r.stats.instances)],
    ['个/4拍', (r) => (r.stats.perFourBeats ?? 0).toFixed(2)],
    ['声明', (r) => String(r.stats.densityDeclared)],
    ['床', (r) => String(r.stats.events?.bed ?? 0)],
    ['核心(鼓/贝/合)', (r) => `${r.stats.coreTotal}(k/b/s ${r.stats.coreByTrack.kick}/${r.stats.coreByTrack.bass}/${r.stats.coreByTrack.synth})`],
    ['喘息 处/拍/最长', (r) => `${r.stats.restCount}/${r.stats.restBeats}/${r.stats.longestRest}`],
    ['空8拍窗', (r) => String(r.stats.breatheWindowsMissing)],
    ['同拍跨类', (r) => String(r.stats.sameBeatCrossCount)],
    ['每轨4拍峰值', (r) => Object.values(r.stats.maxPerTrackIn4Beats).join('/') || '-'],
    ['错误', (r) => String(r.errors.length)],
    ['警告', (r) => String(r.warnings.length)]
  ];
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)));
  const widths = cols.map(([h]) => Math.max([...h].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0) + 2, 10));
  console.log(cols.map(( [h], i) => pad(h, widths[i])).join('').replace(/\s+$/, ''));
  for (const r of rows) console.log(cols.map(([, f], i) => pad(String(f(r)), widths[i])).join('').replace(/\s+$/, ''));
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const quiet = args.includes('--quiet');
const lvArg = args.find((a) => a.startsWith('--lv'));
// --all 是默认行为（没有 --lv 就是全跑），这里只留 --lv 的解析
const wanted = lvArg ? String(args[args.indexOf('--lv') + 1] || '').split(',').map((n) => Number(n)).filter(Number.isFinite) : null;

const out = { clock: null, levels: [], pass: false, skipped: [] };

if (!existsSync(LEVEL_DIR)) {
  console.log('RESULT: SKIP src/data/levels 目录不存在');
  process.exit(0);
}
const files = readdirSync(LEVEL_DIR)
  .filter((f) => /^level\d+\.json$/.test(f))
  .map((f) => ({ f, n: Number(/level(\d+)\.json/.exec(f)[1]) }))
  .filter((x) => (wanted ? wanted.includes(x.n) : true))
  .sort((a, b) => a.n - b.n);

if (!files.length) {
  console.log(`RESULT: SKIP 没有匹配的关卡文件（找 levelN.json于 ${LEVEL_DIR}）`);
  process.exit(0);
}

const rows = [];
for (const { f, n } of files) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(LEVEL_DIR, f), 'utf8'));
  } catch (err) {
    rows.push({ stats: { level: n, style: '-', bpm: '-', lengthBeats: '-', seconds: NaN, instances: 0, perFourBeats: 0, densityDeclared: '-', events: { bed: 0 }, coreTotal: 0, coreByTrack: {}, restCount: 0, restBeats: 0, longestRest: 0, breatheWindowsMissing: 0, sameBeatCrossCount: 0, maxPerTrackIn4Beats: {}, scheduleEvents: 0, inactiveTotal: 0 }, errors: [`${f} 解析失败：${err.message}`], warnings: [], rests: { rests: [] } });
    continue;
  }
  const clock = await makeClock(cfg);
  out.clock = clockKind;
  const r = checkLevel(cfg, clock);
  rows.push(r);
}

const totalErrors = rows.reduce((s, r) => s + r.errors.length, 0);
const totalWarns = rows.reduce((s, r) => s + r.warnings.length, 0);
out.levels = rows.map((r) => ({ level: r.stats.level, stats: r.stats, errors: r.errors, warnings: r.warnings, rests: r.rests.rests, silence: r.rests.silence }));
out.pass = totalErrors === 0;

if (!json) {
  console.log(`checkLevel · 谱面自检（S-04/S-06/S-10）· 时钟：${clockKind}`);
  console.log(`门禁：时长 ${SECONDS_RANGE.join('–')}s ｜ ${DENSITY_WINDOW_BEATS} 拍内同类 ≤${DENSITY_WINDOW_MAX} ｜ 同轨相邻 ≥${MIN_TRACK_SPACING_BEATS} 拍 ｜ 每 ${BREATHE_WINDOW_BEATS} 拍 ≥1 次 ≥1 拍喘息 ｜ 同拍禁止跨类 ｜ 核心 ≥12 且每声部 ≥4 ｜ hp:0 不发声不生成\n`);
  table(rows);
  if (!quiet) {
    for (const r of rows) {
      console.log(`\nL${r.stats.level} ${r.cfg?.title || ''} 喘息表（拍：起–止(长度)）：${fmtRests(r.rests.rests || [])}`);
      if (r.rests.silence) console.log(`  寂静段：${r.rests.silence.startBeat}–${r.rests.silence.endBeat} 拍（${r.rests.silence.beats} 拍，仅节拍器光点，无可判定障碍）｜ 发声序 ${r.stats.scheduleEvents} 条（含 bed）`);
      for (const e of r.errors) console.log(`  ✗ ${e}`);
      for (const w of r.warnings.slice(0, 12)) console.log(`  ⚠ ${w}`);
      if (r.warnings.length > 12) console.log(`  ⚠ …另有 ${r.warnings.length - 12} 条警告`);
    }
  }
} else {
  console.log(JSON.stringify(out, null, 2));
}

const detail = `${rows.length}关 障碍${rows.reduce((s, r) => s + r.stats.instances, 0)} 核心${rows.reduce((s, r) => s + r.stats.coreTotal, 0)} 喘息${rows.reduce((s, r) => s + r.stats.restCount, 0)}处/${rows.reduce((s, r) => s + r.stats.restBeats, 0)}拍 空8拍窗${rows.reduce((s, r) => s + r.stats.breatheWindowsMissing, 0)} 同拍跨类${rows.reduce((s, r) => s + r.stats.sameBeatCrossCount, 0)} 错误${totalErrors} 警告${totalWarns}`;
console.log(`RESULT: ${totalErrors ? 'FAIL' : 'PASS'} ${detail}${totalErrors ? ` | ${rows.flatMap((r) => r.errors.slice(0, 3)).join(' ; ')}` : ''}`);
process.exit(totalErrors ? 1 : 0);
