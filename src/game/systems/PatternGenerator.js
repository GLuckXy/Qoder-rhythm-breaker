// src/game/systems/PatternGenerator.js — Owner: SOUND (S-04 / S-06).
// 契约：C4（CONTRACTS.md）。唯一输入 = levelCfg.noteEvents（C5），唯一时间真相 = clock.timeAtBeat（C1）。
// 纪律 1：本文件内不得出现任何 pattern 字面量；这里只有「映射与校验」。
// 纪律 4：build/analyze 为纯函数，可在 Node 里断言（tools/checkLevel.mjs）。
// 可行性常量一律引用 CORE 的 physics.js（C8：互相引用不改值），不在这里另立一套数值。
import { AUX, FROZEN, bufferBeats } from '../../data/physics.js';
import { resolveVoice, pitchToHz } from '../../audio/SynthVoices.js';

/** 声部 → 障碍类型（OBS-01 固定映射，PRD §5.4）。 */
export const TRACK_TYPE = Object.freeze({ kick: 'spike', bass: 'platform', synth: 'barrage' });
/** 声部 → 中文标签（仅用于校验信息与 UI 文案，不是颜色：颜色归 WORLD 的 theme.js）。 */
export const TRACK_LABEL = Object.freeze({ kick: '鼓', bass: '贝斯', synth: '合成器' });
const JUDGABLE_TRACKS = Object.freeze(['kick', 'bass', 'synth']);
/** CR-01/CR-03：音床轨——只发声，永不生成障碍、永不参与拆解。 */
export const BED_TRACK = 'bed';
/** 休止判定用 1/8 拍栅格；半拍事件（b:10.5）因此不会被误判为喘息。 */
/** PRD §7.5 / C8：同类障碍最小间隔（physics.AUX.minSameTypeGapBeats = 1.33 拍）。 */
export const MIN_SAME_TRACK_GAP = AUX.minSameTypeGapBeats;
/** 4 拍窗口内同类 ≤3（OBS-06）。 */
export const DENSITY_WINDOW_BEATS = 4;
export const DENSITY_WINDOW_MAX = 3;
/** 每 8 拍至少 1 拍喘息（OBS-06）。 */
export const BREATHE_WINDOW_BEATS = 8;
export const BREATHE_MIN_BEATS = 1;
/** 每 16 拍至少 2 拍的乐句呼吸（S-06，R1 先警告，R3 六关齐后升为错误）。 */
export const PHRASE_WINDOW_BEATS = 16;
export const PHRASE_MIN_BEATS = 2;
/** leader 追加的硬规则：同轨相邻事件 ≥1 拍（0.5 判违规，否则 BeatClock 分段积分在变速关不可预测）。 */
export const MIN_TRACK_SPACING_BEATS = 1.0;

/**
 * 落完地才能做下一个动作：跳跃滞空 jumpAirBeats + 落地缓冲 inputBufferMs 换算的拍数；
 * 冲刺只占 dashDurBeats 且全程无敌。两者都用 physics.js 的冻结值算，不在这里写死秒数。
 * @param {number} beatSec 该拍处的拍长（秒）
 * @returns {{jump:number, dash:number}}
 */
export function actionRecoveryBeats(beatSec) {
  const b = Number.isFinite(beatSec) && beatSec > 0 ? beatSec : 0.5;
  const buf = bufferBeats(b);
  return { jump: FROZEN.jumpAirBeats + buf, dash: FROZEN.dashDurBeats + buf };
}

/**
 * 离线校验桩（**只给 selfTest / Node 工具用**）：等速时钟，无变速。
 * 游戏运行时必须由 CORE 注入真 BeatClock，否则第 4 关的变速会算错时刻。
 * @param {object} levelCfg
 * @returns {{timeAtBeat:(b:number)=>number, beatAt:(t:number)=>number, beatLengthSec:(b:number)=>number, stub:true}}
 */
export function isoClock(levelCfg) {
  const bpm = Number(levelCfg.bpm) || 120;
  const beat = 60 / bpm;
  return {
    stub: true,
    beatLengthSec: () => beat,
    timeAtBeat: (b) => b * beat,
    beatAt: (t) => t / beat
  };
}

/**
 * pitch 名 → MIDI（`C#4` / `Db4` / `C4`）。纯音高换算，不含曲风信息。
 * @param {string|null} pitch
 * @returns {number|null}
 */
export function pitchToMidi(pitch) {
  if (typeof pitch !== 'string') return null;
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(pitch.trim());
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  const semi = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (parseInt(m[3], 10) + 1) * 12 + base + semi;
}

/**
 * 音高 → 平台三档高度（OBS-04）。切点在 levelCfg.mapping.platformTiers 里可调（LVL-03）。
 * 缺省把 C0–B5 的音域三等分。
 * @param {string|null} pitch
 * @param {number[]|undefined} bounds
 * @returns {0|1|2}
 */
export function pitchToTier(pitch, bounds) {
  const [lo, hi] = Array.isArray(bounds) && bounds.length >= 2 ? [bounds[0], bounds[1]] : [40, 76];
  const midi = pitchToMidi(pitch);
  if (midi === null) return 1;
  const cut1 = lo + (hi - lo) / 3;
  const cut2 = lo + ((hi - lo) * 2) / 3;
  return midi < cut1 ? 0 : midi < cut2 ? 1 : 2;
}

/**
 * 时值 → 弹幕速度档（OBS-04）。切点在 levelCfg.mapping.speedCuts。
 * 语义：时值越短＝网越密＝穿越越快；数值为「拍/秒」归一的相对速度，WORLD 用它乘 pxPerSec。
 * @param {number} durBeats
 * @param {number[]|undefined} cuts
 * @param {number[]|undefined} outs
 * @returns {number}
 */
export function durToSpeed(durBeats, cuts, outs) {
  const c = Array.isArray(cuts) && cuts.length >= 2 ? cuts : [0.4, 0.75];
  const o = Array.isArray(outs) && outs.length >= 3 ? outs : [1.35, 1.0, 0.75];
  const d = Number.isFinite(durBeats) ? durBeats : 1;
  return d <= c[0] ? o[0] : d <= c[1] ? o[1] : o[2];
}

/**
 * gain 包络形状代理：32 个等距采样，归一到峰值 ≤1，**任意相邻差 |Δ| ≤ 0.05**（升与降都限斜率）。
 * 这是「不许出现爆音/阶跃」的结构替身：真实 automation 用 attackSec 线性起音 + setTargetAtTime 衰减 +
 * 末值线性归零，只要这里查不出阶跃，浏览器侧就不存在瞬断写入（纪律：静音 0.1s / 复活 0.15s 只用斜坡）。
 * 做法：先按 (attack 线性 → decay 指数) 生成原始曲线并归一，再前后各扫一遍做斜率限幅。
 * @param {number} attackFrac 起音占包络比例
 * @param {number} decayK     衰减陡度
 * @param {number} [samples]
 * @param {number} [maxStep]  单步最大变化（audioAssert 的门限值）
 * @returns {number[]}
 */
export function adsrEnvelope(attackFrac, decayK, samples = 32, maxStep = 0.05) {
  const peak = Math.max(0, Math.min(1, attackFrac));
  let raw = [];
  for (let i = 0; i < samples; i++) {
    const x = samples === 1 ? 0 : i / (samples - 1);
    const v = peak > 0 && x < peak ? x / peak : Math.exp(-Math.max(0, decayK) * (x - peak));
    raw.push(v);
  }
  const top = Math.max(...raw) || 1;
  raw = raw.map((v) => v / top);
  raw[raw.length - 1] = 0;
  // 正向限斜率：不许有瞬间起音
  let prev = 0;
  for (let i = 0; i < samples; i++) {
    raw[i] = Math.max(0, Math.min(1, Math.min(raw[i], prev + maxStep)));
    prev = raw[i];
  }
  // 反向限斜率：末值恒为 0，且归零过程也不许有台阶
  for (let i = samples - 2; i >= 0; i--) raw[i] = Math.min(raw[i], raw[i + 1] + maxStep);
  return raw.map((v) => Number(v.toFixed(4)));
}

/** 轨道是否参与发声与生成障碍（DIS-01：hp 缺省即 0；bed 无 hp 概念、恒可发声）。 */
function trackActive(levelCfg, track) {
  if (track === BED_TRACK) return true;
  const t = (levelCfg.tracks || {})[track];
  return !!t && Number(t.hp) > 0;
}

/**
 * 寂静段起始拍 = lengthBeats - silenceBeats（DIS-06）。
 * WORLD 的 Obstacle.update 用它做截断门（beat > silenceStartBeat ⇒ expire），
 * 全拆时 CORE 另用 DisassembleSystem 的时刻提前截断。
 * @param {object} levelCfg
 * @returns {number}
 */
export function silenceStartBeat(levelCfg) {
  const len = Number(levelCfg.lengthBeats) || 0;
  return len - (Number(levelCfg.silenceBeats) || 0);
}

function eventsOf(levelCfg, track) {
  const arr = (levelCfg.noteEvents || {})[track];
  return Array.isArray(arr) ? arr : [];
}

function idFor(levelCfg, track, seq, beat) {
  const lv = String(levelCfg.id ?? 0).padStart(2, '0');
  return `lv${lv}-${track}-${String(seq).padStart(3, '0')}${beat % 1 ? `b${beat}` : ''}`;
}

/**
 * noteEvents → 实例数组（C4 + leader 2026-11-23 追加口径）。纯函数，无副作用、无状态。
 * 输出**同时**包含可判定障碍与 bed 背景床：
 *  - kick/bass/synth：`judgable:true`，参与密度/间隔/喘息/同拍等一切自检；
 *  - bed（CR-05）：`type:'bed'` + `judgable:false` + `core:false` + `pitchTier:1`，
 *    beat 范围同样限 [introBeats, silenceStartBeat]。给 W-05 时间轴第三层与 W-07 分层重组直接吃；
 *    **上层世界不应渲染它**（按 judgable 或 type==='bed' 过滤），CORE 只注册 judgable=true 的队列。
 *  - 缺省只输出 active 条目（`hp>0` 声部 + 未被 intro/寂静段裁掉的）。CORE 的 K-07 拆解与
 *    WORLD 的 W-04 渲染链都依赖这个直觉，不要改。
 *  - `opts.includeInactive === true` 时输出全量，每条附 `active` 与 `inactiveReason:'hp0'|'intro'|'silence'|null`。
 * @param {object} levelCfg
 * @param {{timeAtBeat:(beat:number)=>number, beatLengthSec?:(beat:number)=>number}} [clock]
 *        运行时必须注入 CORE 的 BeatClock（C1）；离线自检缺省用 isoClock 等速桩。
 * @param {{includeInactive?:boolean}} [opts]
 * @returns {object[]} 按 beat 升序（同拍 judgable 优先）
 */
export function build(levelCfg, clock = isoClock(levelCfg), opts = {}) {
  const includeInactive = !!opts.includeInactive;
  const lo = Number(levelCfg.introBeats) || 0;
  const hi = silenceStartBeat(levelCfg);
  const rows = [];
  for (const track of [...JUDGABLE_TRACKS, BED_TRACK]) {
    const judgable = track !== BED_TRACK;
    const active = trackActive(levelCfg, track);
    if (!active && !includeInactive) continue;
    for (const ev of eventsOf(levelCfg, track)) {
      const beat = Number(ev.b);
      if (!Number.isFinite(beat)) continue;
      let reason = null;
      if (!active) reason = 'hp0';
      else if (beat < lo - 1e-9) reason = 'intro';
      else if (beat > hi + 1e-9) reason = 'silence';
      if (reason && !includeInactive) continue;
      rows.push({ track, ev, beat, judgable, active: !reason, reason });
    }
  }
  rows.sort((a, b) => a.beat - b.beat || Number(b.judgable) - Number(a.judgable) || JUDGABLE_TRACKS.indexOf(a.track) - JUDGABLE_TRACKS.indexOf(b.track));
  const seq = { kick: 0, bass: 0, synth: 0, bed: 0 };
  let groupIndex = -1;
  let lastBeat = null;
  return rows.map(({ track, ev, beat, judgable, active, reason }) => {
    seq[track] += 1;
    if (beat !== lastBeat) {
      groupIndex += 1;
      lastBeat = beat;
    }
    const dur = Number.isFinite(Number(ev.d)) ? Number(ev.d) : 1;
    const inst = {
      id: idFor(levelCfg, track, seq[track], beat),
      track,
      type: judgable ? TRACK_TYPE[track] : 'bed',
      beat,
      timeSec: roundSec(clock.timeAtBeat(beat)),
      core: judgable && !!ev.core,
      pitchTier: track === 'bass' ? pitchToTier(ev.pitch ?? null, (levelCfg.mapping || {}).platformTiers) : 1,
      speed: track === 'synth' ? durToSpeed(dur, (levelCfg.mapping || {}).speedCuts, (levelCfg.mapping || {}).speedLevels) : 1,
      state: 'pending',
      grade: null,
      pitch: typeof ev.pitch === 'string' ? ev.pitch : null,
      durBeats: dur,
      judgable,
      /** 同一拍到达的实例共享 groupIndex（WORLD 的时间轴列/组对齐用）。
       *  CR-09 批复：实例里不带 pxPerSec/beatWidthSec —— 几何换算唯一归 WORLD（physics.js + 视口），
       *  需要拍长请调本文件的 arrivalSpacing(instances, clock)。 */
      groupIndex
    };
    if (!judgable) inst.layer = 'timeline';
    if (includeInactive) {
      inst.active = active;
      inst.inactiveReason = reason;
    }
    return inst;
  });
}

/**
 * 每个到达组的拍长（秒）——CR-09 批复后取代实例内的 beatWidthSec/pxPerSec：
 * WORLD 若要算滚动速率，请 `physics.pxPerSec(view, spacing[i].widthSec)`（几何唯一真相仍在 physics.js）。
 * @param {object[]} instances build() 的输出
 * @param {{timeAtBeat:(b:number)=>number}} clock 必填（BeatClock / MockClock / isoClock 均可）
 * @returns {Array<{beat:number,groupIndex:number,timeSec:number,widthSec:number,ids:string[]}>}
 */
export function arrivalSpacing(instances, clock) {
  if (!clock || typeof clock.timeAtBeat !== 'function') {
    throw new TypeError('[PatternGenerator] arrivalSpacing(instances, clock) 需要一个带 timeAtBeat 的时钟——拍长只能由时钟给出');
  }
  const ids = new Map();
  for (const i of instances) {
    if (!ids.has(i.beat)) ids.set(i.beat, []);
    ids.get(i.beat).push(i.id);
  }
  const out = [];
  for (const [beat, list] of [...ids.entries()].sort((a, b) => a[0] - b[0])) {
    out.push({
      beat,
      groupIndex: out.length,
      timeSec: roundSec(clock.timeAtBeat(beat)),
      widthSec: roundSec(clock.timeAtBeat(beat + 1) - clock.timeAtBeat(beat)),
      ids: list
    });
  }
  return out;
}

/**
 * 按到达拍分组的索引表（WORLD 的 W-05 列对齐 / W-04 组 x 用）。
 * @param {object[]} instances build() 的输出
 * @returns {Map<number, {index:number, beat:number, timeSec:number, ids:string[]}>}
 */
export function arrivalGroups(instances) {
  const map = new Map();
  for (const i of instances) {
    if (!map.has(i.beat)) map.set(i.beat, { index: i.groupIndex, beat: i.beat, timeSec: i.timeSec, ids: [] });
    map.get(i.beat).ids.push(i.id);
  }
  return map;
}

/**
 * 全量构建（含 hp=0 声部与被裁剪事件），每条带 active/inactiveReason。
 * CORE 的分层重组 / 结算覆盖率与 tools/checkLevel.mjs 用这个；游戏内注册队列请用 build()。
 * @param {object} levelCfg
 * @param {object} [clock]
 * @returns {object[]}
 */
export function buildAll(levelCfg, clock = isoClock(levelCfg)) {
  return build(levelCfg, clock, { includeInactive: true });
}

/**
 * S-06 休止符 → 显式喘息区。不塞进 C4 的 ObstacleInstance，避免契约漂移。
 * 喘息 = 相邻两次「到达」之间空出 ≥1 拍（含 intro 尾到首事件、末事件到寂静段两头）。
 * 口径用到达时刻而不是发声时长：玩家能不能喘气取决于下一次要按的时刻。
 * @param {object} levelCfg
 * @param {object[]} instances build() 的输出
 * @returns {{rests:Array, silence:object|null, beats:number, occupiedBeats:number}}
 */
export function analyzeRests(levelCfg, instances) {
  const lo = Number(levelCfg.introBeats) || 0;
  const hi = silenceStartBeat(levelCfg);
  const beats = [...instances].filter((i) => i.beat >= lo - 1e-9 && i.beat <= hi + 1e-9).map((i) => i.beat).sort((a, b) => a - b);
  const rests = [];
  let cursor = lo;
  for (const b of beats) {
    if (b - cursor >= BREATHE_MIN_BEATS - 1e-9) rests.push({ startBeat: round4(cursor), endBeat: round4(b), beats: round4(b - cursor) });
    cursor = Math.max(cursor, b);
  }
  if (hi - cursor >= BREATHE_MIN_BEATS - 1e-9) rests.push({ startBeat: round4(cursor), endBeat: round4(hi), beats: round4(hi - cursor) });
  const silenceLen = Number(levelCfg.silenceBeats) || 0;
  return {
    rests,
    silence: silenceLen > 0 ? { startBeat: round4(hi), endBeat: round4(hi + silenceLen), beats: silenceLen } : null,
    beats: round4(hi - lo),
    occupiedBeats: countOccupiedBeats(lo, hi, beats)
  };
}

function countOccupiedBeats(lo, hi, beats) {
  const touched = new Set();
  for (const b of beats) {
    const floor = Math.floor(b + 1e-9);
    if (floor >= lo && floor < hi) touched.add(floor);
  }
  return touched.size;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * 绝对秒统一量化到 1e-4（0.1ms，见 CONTRACTS CR 附录）。
 * 理由：BeatClock.timeAtBeat 在变速段是二次式，返回的是带二进制尾数的商，
 * 三方各自再乘除会放大差异；量化到固定精度让 `timeSec === timeAtBeat(beat)` 能精确比对。
 */
function roundSec(v) {
  return Math.round(v * 10000) / 10000;
}

/** 把逐拍的违规窗口折叠成连续区间，免得一条警告刷几十行。 */
function mergeWindows(starts, width) {
  const runs = [];
  let a = null;
  let prev = null;
  for (const s of starts) {
    if (a === null) {
      a = s;
      prev = s;
    } else if (s === prev + 1) {
      prev = s;
    } else {
      runs.push([a, prev + width]);
      a = s;
      prev = s;
    }
  }
  if (a !== null) runs.push([a, prev + width]);
  return runs;
}

/**
 * 发声序：noteEvents（kick/bass/synth + bed 音床）→ [{track,timeSec,dur,gainEnvelope}]（C6 纯函数侧）。
 * 与 build() 同源不同用：
 *  - `hp:0` 的声部整轨不发声（纪律 3 / DoD 断言项）；
 *  - bed（CR-05）恒发声，但不生成障碍；
 *  - 寂静段（beat > silenceStartBeat）一律不排任何音（DIS-06：段内只有节拍器光点）；
 *  - dur 用 timeAtBeat(b+d) - timeAtBeat(b) 求得秒数，**不依赖** BeatClock 未承诺的 beatDuration 方法
 *    （leader 的 CR-03 批复：tempoMap.beatDuration 未导出，不得消费）。
 * @param {object} levelCfg
 * @param {{timeAtBeat:(beat:number)=>number}} [clock]
 * @returns {Array<{track:string,beat:number,timeSec:number,dur:number,durBeats:number,pitch:string|null,gain:number,gainEnvelope:number[],voice:object,active:boolean}>}
 */
export function buildSchedule(levelCfg, clock = isoClock(levelCfg)) {
  const out = [];
  const hi = silenceStartBeat(levelCfg);
  for (const track of [...JUDGABLE_TRACKS, BED_TRACK]) {
    const active = trackActive(levelCfg, track);
    if (!active) continue;
    const voice = voiceOf(levelCfg, track);
    for (const ev of eventsOf(levelCfg, track)) {
      const beat = Number(ev.b);
      if (!Number.isFinite(beat)) continue;
      if (beat > hi + 1e-9) continue;
      const dur = Number.isFinite(Number(ev.d)) ? Number(ev.d) : 1;
      const durSec = round4(clock.timeAtBeat(beat + dur) - clock.timeAtBeat(beat));
      const evGain = Number.isFinite(Number(ev.gain)) ? Number(ev.gain) : 1;
      const trackGain = Number(((levelCfg.tracks || {})[track] || {}).gain);
      const peak = round4(evGain * (Number.isFinite(trackGain) ? trackGain : 1) * voice.styleMix);
      out.push({
        track,
        beat,
        timeSec: roundSec(clock.timeAtBeat(beat)),
        dur: durSec,
        durBeats: dur,
        pitch: typeof ev.pitch === 'string' ? ev.pitch : null,
        gain: evGain,
        /** 该事件的绝对峰值幅度 = ev.gain × tracks[].gain × 曲风 mix；audioAssert 用它算轨间响度。 */
        peak,
        /** 浏览器侧建自动化用的绝对秒数（≥6ms 才不爆音；斜坡规则见 TrackMixer）。 */
        attackSec: Math.max(0.006, Math.min(voice.attack * durSec, durSec * 0.6)),
        releaseSec: Math.max(0.012, durSec / Math.max(0.5, voice.decay)),
        pan: voice.pan ?? 0,
        hz: pitchToHz(ev.pitch),
        candidate: voice.candidateName,
        gainEnvelope: adsrEnvelope(voice.attack, voice.decay),
        voice,
        active: true
      });
    }
  }
  out.sort((a, b) => a.timeSec - b.timeSec || a.track.localeCompare(b.track));
  return out;
}

/** 音色的可断言子集：唯一真相在 src/audio/SynthVoices.js（浏览器侧建 node 时读同一份）。 */
export function voiceOf(levelCfg, track) {
  const style = levelCfg.style || 'minimal-electro';
  const cand = ((levelCfg.tracks || {})[track] || {}).voice;
  return resolveVoice(style, track, cand);
}

/**
 * C4 自检（PRD §7.5 + OBS-06 + SOUND.md DoD + leader 的 R1 追加硬规则）。errors 必须清零才算谱面可用。
 * 注：`core` 的语义按 leader 2026-11-23 口径 = 「视觉与时间轴高亮 + 结算核心命中率」，
 * 不再作为扣 hp 的门（任何 PERFECT 都扣 1 格）。所以核心节点数不再决定「可否拆解」，
 * 但仍按 §7.3 断言 ≥12 且每声部 ≥4。
 * @param {object} levelCfg
 * @param {object[]} instances
 * @param {object} [clock] 缺省用 isoClock 等速桩（离线自检用）
 * @returns {{errors:string[],warnings:string[],stats:object}}
 */
export function selfTest(levelCfg, instances, clock = isoClock(levelCfg)) {
  const errors = [];
  const warnings = [];
  const add = (list, msg) => list.push(msg);
  // 结构自检只针对可判定障碍：bed（type:'bed' / judgable:false）不受密度、间隔、同拍约束。
  instances = (instances || []).filter((i) => i.judgable !== false);

  for (const track of JUDGABLE_TRACKS) {
    if (!trackActive(levelCfg, track) && eventsOf(levelCfg, track).length > 0) {
      warnings.push(`${track}: hp=0 但 noteEvents 有 ${eventsOf(levelCfg, track).length} 条残留事件（已忽略，建议清空）`);
    }
  }
  if (!eventsOf(levelCfg, BED_TRACK).length) {
    add(errors, `${BED_TRACK} 音床为空：W-05 时间轴第三层与 W-07 分层重组需要每关都有一段与关卡等长的音床（leader 2026-11-23 追加口径）`);
  }

  const byTrack = {};
  for (const it of instances) (byTrack[it.track] ||= []).push(it);

  for (const it of instances) {
    const want = clock.timeAtBeat(it.beat);
    if (Math.abs(it.timeSec - want) > 0.001) add(errors, `${it.id}: timeSec ${it.timeSec.toFixed(5)} ≠ timeAtBeat(${it.beat}) ${want.toFixed(5)}`);
    if (it.beat < (Number(levelCfg.introBeats) || 0) - 1e-9) add(errors, `${it.id}: beat ${it.beat} 落在 intro 安全区`);
    if (it.beat > silenceStartBeat(levelCfg) + 1e-9) add(errors, `${it.id}: beat ${it.beat} 落在寂静段`);
  }

  const ids = new Set();
  for (const it of instances) {
    if (ids.has(it.id)) add(errors, `id 重复: ${it.id}`);
    ids.add(it.id);
  }

  const byBeat = new Map();
  for (const it of instances) {
    const key = round4(it.beat);
    if (!byBeat.has(key)) byBeat.set(key, []);
    byBeat.get(key).push(it);
  }
  for (const [beat, list] of byBeat) if (list.length > 1) add(errors, `第 ${beat} 拍有 ${list.length} 类障碍（§7.5：同一拍禁止跨类并存）`);

  for (const track of Object.keys(byTrack)) {
    const list = byTrack[track];
    for (const anchor of list) {
      const n = list.filter((i) => i.beat >= anchor.beat && i.beat < anchor.beat + DENSITY_WINDOW_BEATS).length;
      if (n > DENSITY_WINDOW_MAX) {
        errors.push(`${track}: [${round4(anchor.beat)},${round4(anchor.beat + 4)}) 拍窗口内同类 ${n} 个 > ${DENSITY_WINDOW_MAX}`);
      }
    }
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].beat - list[i - 1].beat;
      if (gap < MIN_SAME_TRACK_GAP - 1e-9) add(errors, `${track}: 第 ${list[i - 1].beat}→${list[i].beat} 拍同类间隔 ${round4(gap)} < ${MIN_SAME_TRACK_GAP}`);
    }
  }

  const sorted = [...instances].sort((a, b) => a.beat - b.beat);
  const beatSec = (b) => (typeof clock.beatLengthSec === 'function' ? clock.beatLengthSec(b) : 60 / (Number(levelCfg.bpm) || 120));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap = round4(cur.beat - prev.beat);
    const rec = actionRecoveryBeats(beatSec(prev.beat));
    const min = prev.track === 'synth' ? rec.dash : rec.jump;
    if (gap < min - 1e-9) {
      add(errors, `beat ${prev.beat}→${cur.beat} 间隔 ${gap} 拍 < ${round4(min)}（${prev.type} 之后需落地/收冲：滞空+缓冲，physics.js C8）`);
    }
    if (cur.track === prev.track && gap < MIN_TRACK_SPACING_BEATS - 1e-9) {
      add(errors, `${cur.track}: 同轨相邻事件 ${prev.beat}→${cur.beat} 间隔 ${gap} 拍 < ${MIN_TRACK_SPACING_BEATS}（leader 硬规则：半拍交错一律违规）`);
    }
  }

  const rests = analyzeRests(levelCfg, instances);
  const lo = Number(levelCfg.introBeats) || 0;
  const hi = silenceStartBeat(levelCfg);
  for (let w = lo; w + BREATHE_WINDOW_BEATS <= hi; w++) {
    const ok = rests.rests.some((r) => r.startBeat < w + BREATHE_WINDOW_BEATS && r.endBeat > w);
    if (!ok) add(errors, `[${w},${w + BREATHE_WINDOW_BEATS}) 拍内没有 ≥${BREATHE_MIN_BEATS} 拍的喘息（OBS-06 每 8 拍 ≥1 喘息）`);
  }
  const phraseGaps = [];
  for (let w = lo; w + PHRASE_WINDOW_BEATS <= hi; w++) {
    const ok = rests.rests.some((r) => r.startBeat < w + PHRASE_WINDOW_BEATS && r.endBeat > w && r.beats >= PHRASE_MIN_BEATS);
    if (!ok) phraseGaps.push(w);
  }
  if (phraseGaps.length) {
    const runs = mergeWindows(phraseGaps, BREATHE_WINDOW_BEATS);
    for (const [a, b] of runs) add(warnings, `[${a},${b}) 拍内没有 ≥${PHRASE_MIN_BEATS} 拍的乐句呼吸（连续 ${b - a} 个 16 拍窗）`);
  }
  if (rests.beats > 0 && rests.occupiedBeats / rests.beats > 0.8) {
    add(warnings, `拍占用率 ${(100 * rests.occupiedBeats / rests.beats).toFixed(0)}%，谱面偏满`);
  }

  const coreTotal = instances.filter((i) => i.core).length;
  if (coreTotal < 12) add(errors, `核心节点总数 ${coreTotal} < 12（§7.3）`);
  for (const track of JUDGABLE_TRACKS) {
    if (!trackActive(levelCfg, track)) continue;
    const list = byTrack[track] || [];
    if (!list.length) add(errors, `${track}: hp>0 却没有任何障碍`);
    const core = list.filter((i) => i.core).length;
    if (core < 4) add(errors, `${track}: 核心节点 ${core} < 4（每声部至少 4 次拆解机会）`);
  }

  const total = clock.timeAtBeat(Number(levelCfg.lengthBeats) || 0) - clock.timeAtBeat(0);
  if (total < 60 || total > 90) add(errors, `总时长 ${total.toFixed(1)}s 不在 60–90s（PRD §7.4）`);

  const declared = Number(levelCfg.density);
  const measured = instances.length / ((hi - lo) / 4);
  if (Number.isFinite(declared) && instances.length) {
    if (Math.abs(measured - declared) / declared > 0.25) add(warnings, `density 声明 ${declared} 与实测 ${round4(measured)} 个/4拍 相差 >25%`);
  }

  for (const it of instances) {
    if (it.track === 'bass' && it.pitch === null) add(warnings, `${it.id}: bass 缺 pitch，pitchTier 退化为中档`);
    if (it.track === 'kick' && Math.abs(it.beat % 1) > 1e-9) add(warnings, `${it.id}: kick 出现在非正拍（L1 口径要求正拍）`);
  }

  const stats = {
    level: Number(levelCfg.id) || 0,
    title: levelCfg.title || '',
    bpm: Number(levelCfg.bpm) || 0,
    lengthBeats: Number(levelCfg.lengthBeats) || 0,
    seconds: round4(total),
    events: {
      kick: instances.filter((i) => i.track === 'kick').length,
      bass: instances.filter((i) => i.track === 'bass').length,
      synth: instances.filter((i) => i.track === 'synth').length,
      bed: eventsOf(levelCfg, 'bed').length
    },
    instances: instances.length,
    judgable: instances.length,
    bedEvents: eventsOf(levelCfg, BED_TRACK).length,
    perFourBeats: round4(measured),
    densityDeclared: declared,
    coreTotal,
    coreByTrack: {
      kick: (byTrack.kick || []).filter((i) => i.core).length,
      bass: (byTrack.bass || []).filter((i) => i.core).length,
      synth: (byTrack.synth || []).filter((i) => i.core).length
    },
    rests: rests.rests,
    restCount: rests.rests.length,
    restBeats: round4(rests.rests.reduce((s, r) => s + r.beats, 0)),
    silence: rests.silence,
    gapMinSameTrack: minGap(instances, (a, b) => a.track === b.track),
    tracksActive: JUDGABLE_TRACKS.filter((t) => trackActive(levelCfg, t)),
    platformTiers: tiersOf(instances),
    crossTrackMinGapBeats: minGap(instances, (a, b) => a.track !== b.track)
  };
  return { errors, warnings, stats };
}

function tiersOf(instances) {
  const t = [0, 0, 0];
  for (const i of instances) if (i.track === 'bass') t[i.pitchTier]++;
  return t;
}

function minGap(instances, same) {
  const s = [...instances].sort((a, b) => a.beat - b.beat);
  let min = Infinity;
  for (let i = 1; i < s.length; i++) if (same(s[i - 1], s[i])) min = Math.min(min, round4(s[i].beat - s[i - 1].beat));
  return min === Infinity ? null : min;
}

/**
 * PRD §11 L5 硬约束：假标记 ≤8 处且不落在核心拍上。纯函数，供 checkLevel 与 contractTest 共用。
 * @param {object} levelCfg
 * @param {object[]} instances
 * @returns {{errors:string[],warnings:string[],count:number}}
 */
export function validateGhosts(levelCfg, instances) {
  const ghosts = Array.isArray(levelCfg.ghostBeats) ? levelCfg.ghostBeats : [];
  const errors = [];
  const warnings = [];
  if (ghosts.length > 8) errors.push(`ghostBeats ${ghosts.length} 处 > 8（§11 L5）`);
  const coreBeats = new Set(instances.filter((i) => i.core).map((i) => round4(i.beat)));
  for (const g of ghosts) {
    const b = round4(Number(g.beat));
    if (coreBeats.has(b)) errors.push(`ghost 落在核心拍 ${b}（§11：绝不落核心节点）`);
    const len = Number(g.lengthBeats) || 1;
    if (len < 1 || len > 2) warnings.push(`ghost @${b} 持续 ${len} 拍，建议 1–2 拍`);
  }
  return { errors, warnings, count: ghosts.length };
}

/**
 * PRD §11 L4 变速：过渡 2 拍提示音 + 变更后 BPM 正确。纯函数侧校验。
 * @param {object} levelCfg
 * @returns {{errors:string[],warnings:string[],cues:number[]}}
 */
export function validateTempoChanges(levelCfg) {
  const changes = Array.isArray(levelCfg.tempoChanges) ? levelCfg.tempoChanges : [];
  const errors = [];
  const warnings = [];
  const cues = [];
  for (const tc of changes) {
    const b = Number(tc.beat);
    const tb = Number(tc.transitionBeats) || 0;
    cues.push(round4(b - tb));
    if (tb !== 2) warnings.push(`tempoChange @${b}: transitionBeats=${tb}，§11 要求 2 拍过渡提示`);
    if (!Number.isFinite(Number(tc.bpm)) || Number(tc.bpm) <= 0) errors.push(`tempoChange @${b}: bpm 非法`);
  }
  return { errors, warnings, cues };
}

/**
 * PRD §11 L6 freeOrder：三声部核心同时在场、单声部 ≥6 核心。
 * @param {object} levelCfg
 * @param {object[]} instances
 * @returns {{errors:string[],warnings:string[],peakConcurrency:number}}
 */
export function validateFreeOrder(levelCfg, instances) {
  const errors = [];
  const warnings = [];
  if (!levelCfg.freeOrder) return { errors, warnings, peakConcurrency: 0 };
  const active = JUDGABLE_TRACKS.filter((t) => trackActive(levelCfg, t));
  if (active.length < 3) errors.push(`freeOrder 关必须三声部齐全，当前 ${active.join('/')}`);
  for (const t of active) {
    const core = instances.filter((i) => i.track === t && i.core).length;
    if (core < 6) errors.push(`${t}: freeOrder 关核心节点 ${core} < 6（§11 容错要求）`);
  }
  let peak = 0;
  const lo = Number(levelCfg.introBeats) || 0;
  const hi = silenceStartBeat(levelCfg);
  for (let b = lo; b < hi; b++) {
    const n = new Set(instances.filter((i) => i.track === 'kick' || i.track === 'bass' || i.track === 'synth').filter((i) => i.core).filter((i) => i.beat >= b && i.beat < b + 4).map((i) => i.track)).size;
    peak = Math.max(peak, n);
  }
  if (peak < 3) warnings.push(`4 拍窗口内三声部核心同时在场的峰值只有 ${peak}，freeOrder 的「顺序自选」表达不足`);
  return { errors, warnings, peakConcurrency: peak };
}

/** 供 WORLD 用的最小几何可行性提示（不改 physics 值，只报越界）。 */
export function feasibility(levelCfg, instances) {
  const warnings = [];
  for (const it of instances) {
    if (it.track === 'bass' && ![0, 1, 2].includes(it.pitchTier)) warnings.push(`${it.id}: pitchTier ${it.pitchTier} 超出三档`);
    if (it.track === 'synth' && !(it.speed > 0)) warnings.push(`${it.id}: speed ${it.speed} 非正`);
  }
  return warnings;
}

export default { build, buildSchedule, selfTest, analyzeRests, validateGhosts, validateTempoChanges, validateFreeOrder, feasibility };
