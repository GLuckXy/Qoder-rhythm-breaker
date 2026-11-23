// src/audio/TrackMixer.js — Owner: SOUND（S-01）.
// 两副面孔：
//  ① 纯数据侧（Node 可断言，零 Web Audio 依赖）：RAMP 常量、trackLoudness()、auditSchedule()、
//     以及 C6 要求的 buildSchedule 再导出（谱面 → 发声序的唯一真相在 PatternGenerator）。
//  ② 浏览器侧（TrackMixer 类）：每声部一条 gain+pan 子总线，静音/复活**只允许斜坡**，
//     任何地方都不写 `gain.value = 0`（纪律 3 / PRD 失败模式 4「拆解后世界必须变安静但不得爆音」）。
//
// 时钟全部外部注入：时刻一律来自 clock.timeAtBeat(beat)，本文件绝不乘 60/bpm。

import { isoClock, silenceStartBeat, buildSchedule as buildScheduleFromChart } from '../game/systems/PatternGenerator.js';
import { STYLE_PRESETS } from './SynthVoices.js';

/** 斜坡常量（秒）。S-01 验收：静音 0.1s、复活 0.15s，线性。 */
export const RAMP = Object.freeze({
  silenceSec: 0.1,
  reviveSec: 0.15,
  uiSec: 0.05,
  min: 0.0001,
  /** 起音短于此值会有可闻爆音（与 SynthVoices 的 attackSec 下限同源）。 */
  minAttackSec: 0.006
});

/** 可寻址子总线；click = 节拍器/UI 短音，走 music 但独立静音通道。 */
export const MIXER_TRACKS = Object.freeze(['kick', 'bass', 'synth', 'bed', 'click']);

const JUDGED_TRACKS = ['kick', 'bass', 'synth'];

/** 20·log10(x)，x≤0 返回 -Infinity。 */
export function db(x) {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}

/**
 * 轨间响度（纯函数）。两种口径都算，避免用词歧义：
 *  - ampDb  ：该轨所有事件的**峰值幅度**最大值（ev.gain × tracks[].gain × 曲风 mix）。
 *            这是 PRD「三轨响度差 ≤3dB」的门（可判定声部两两比较）。
 *  - areaDb ：包络面积 × 时长 × 峰值再摊到整关秒数（时间平均功率），只做展示。
 *            bed 是背景层：它**必须**比主声部低（拆完鼓世界才安静），所以 bed 不参与 ≤3dB 门，
 *            改断言「bed 比最响主声部低 6–24dB」。此口径已写进 R1 报告，等人类审美门确认。
 * @param {object[]} schedule buildSchedule 的输出
 * @param {number} spanSec
 */
export function trackLoudness(schedule, spanSec = 0) {
  const byTrack = {};
  for (const e of schedule) {
    const t = byTrack[e.track] || (byTrack[e.track] = { events: 0, peak: 0, area: 0 });
    t.events++;
    if (e.peak > t.peak) t.peak = e.peak;
    const mean = e.gainEnvelope.reduce((a, b) => a + b, 0) / Math.max(1, e.gainEnvelope.length);
    t.area += mean * Math.max(0.01, e.dur) * e.peak;
  }
  const span = spanSec > 0 ? spanSec : Math.max(1, ...schedule.map((e) => e.timeSec + e.dur));
  for (const t of Object.values(byTrack)) {
    t.ampDb = Number(db(t.peak).toFixed(2));
    t.areaDb = Number((10 * Math.log10(t.area / span)).toFixed(2));
  }
  const judged = JUDGED_TRACKS.filter((k) => byTrack[k]);
  const pairs = [];
  for (let i = 0; i < judged.length; i++) {
    for (let j = i + 1; j < judged.length; j++) {
      pairs.push({ a: judged[i], b: judged[j], deltaDb: Number(Math.abs(byTrack[judged[i]].ampDb - byTrack[judged[j]].ampDb).toFixed(2)) });
    }
  }
  const loudestJudged = judged.length ? Math.max(...judged.map((k) => byTrack[k].ampDb)) : null;
  return {
    byTrack,
    pairs,
    bedDelta: byTrack.bed && loudestJudged !== null ? Number((byTrack.bed.ampDb - loudestJudged).toFixed(2)) : null,
    spanSec: Number(span.toFixed(2))
  };
}

/**
 * 发声序审计（S-01 验收的 5 条硬断言，纯函数，Node 与浏览器共用同一段代码）。
 * @param {object} levelCfg
 * @param {object[]} schedule
 * @param {{timeAtBeat:(b:number)=>number}} [clock]
 * @returns {{errors:string[],warnings:string[],stats:object}}
 */
export function auditSchedule(levelCfg, schedule, clock = isoClock(levelCfg)) {
  const errors = [];
  const warnings = [];
  const push = (bag, msg) => { if (!bag.includes(msg)) bag.push(msg); };
  const hi = silenceStartBeat(levelCfg);
  const intro = Number(levelCfg.introBeats) || 0;

  // A0 基本形状
  let prevT = -Infinity;
  for (const e of schedule) {
    if (!Number.isFinite(e.timeSec) || !Number.isFinite(e.dur) || e.dur <= 0) push(errors, `${e.track}@${e.beat} 时刻/时长非法 timeSec=${e.timeSec} dur=${e.dur}`);
    if (e.timeSec < prevT - 1e-9) push(errors, `发声序未按时间升序：${e.track}@${e.beat} ${e.timeSec} < ${prevT.toFixed(4)}`);
    prevT = e.timeSec;
    // A1 与 clock.timeAtBeat 一致（<1ms）
    const want = clock.timeAtBeat(e.beat);
    if (Math.abs(e.timeSec - want) > 1e-3) push(errors, `${e.track}@${e.beat} 时刻偏离时钟 ${(e.timeSec - want) * 1000} ms（须 <1ms）`);
    // A6 不许越过寂静段
    if (e.beat > hi + 1e-9) push(errors, `${e.track}@${e.beat} 落在寂静段（>${hi}）却仍排了音`);
    if (e.beat < intro - 1e-9) push(errors, `${e.track}@${e.beat} 在 intro 之前发声（introBeats=${intro}）`);
    // A2 包络无阶跃
    const env = e.gainEnvelope || [];
    if (env.length !== 32) push(errors, `${e.track}@${e.beat} 包络长度 ${env.length} ≠ 32`);
    let mx = 0;
    for (let i = 1; i < env.length; i++) mx = Math.max(mx, Math.abs(env[i] - env[i - 1]));
    if (mx > 0.05 + 1e-6) push(errors, `${e.track}@${e.beat} 包络阶跃 ${mx.toFixed(4)} > 0.05（可闻爆音）`);
    if (env[0] > 0.001 || env[env.length - 1] > 0.001) push(errors, `${e.track}@${e.beat} 包络首尾未归零（${env[0]}/${env[env.length - 1]}）`);
    // A7 真实 automation 的起音不许短于 minAttackSec
    if (!(e.attackSec >= RAMP.minAttackSec)) push(errors, `${e.track}@${e.beat} attackSec ${e.attackSec} < ${RAMP.minAttackSec}s`);
    if (!(e.attackSec <= e.dur * 0.6 + 1e-9)) push(warnings, `${e.track}@${e.beat} attackSec ${e.attackSec.toFixed(3)} 相对时长 ${e.dur.toFixed(3)} 过长`);
    if (!(e.peak > 0 && e.peak <= 1)) push(errors, `${e.track}@${e.beat} 峰值幅度 ${e.peak} 超出 (0,1]`);
  }

  // A3 同一拍不许跨声部（同一 beat 只允许一个可判定声部发声；bed 是背景层，允许同拍）
  const byBeat = new Map();
  for (const e of schedule) {
    if (!JUDGED_TRACKS.includes(e.track)) continue;
    const k = Number(e.beat.toFixed(4));
    if (!byBeat.has(k)) byBeat.set(k, []);
    byBeat.get(k).push(e.track);
  }
  for (const [beat, list] of byBeat) if (list.length > 1) push(errors, `第 ${beat} 拍同时有 ${list.join('+')} 发声（跨类同拍）`);

  // A4 hp:0 的声部必须完全静音
  for (const track of JUDGED_TRACKS) {
    const t = (levelCfg.tracks || {})[track];
    if (t && !(Number(t.hp) > 0) && schedule.some((e) => e.track === track)) push(errors, `${track} hp=${t.hp} 却仍有发声事件`);
  }
  const bed = (levelCfg.tracks || {}).bed;
  if (bed && bed.disassemble === false && schedule.some((e) => e.track === 'bed' && e.core)) push(errors, 'bed 事件带 core，可能被误当可拆解声部');

  // A5 轨间响度
  const loud = trackLoudness(schedule);
  for (const p of loud.pairs) {
    if (p.deltaDb > 3) push(errors, `轨间响度差 ${p.a}/${p.b} = ${p.deltaDb}dB > 3dB`);
  }
  if (loud.bedDelta !== null) {
    if (loud.bedDelta > -6) push(errors, `bed 仅比主声部低 ${-loud.bedDelta}dB（要求 ≥6dB，拆完鼓世界必须变安静）`);
    if (loud.bedDelta < -24) push(warnings, `bed 低到 ${-loud.bedDelta}dB，铺底可能听不见`);
  }
  if (!loud.pairs.length) warnings.push('可判定声部不足两条，轨间响度差未参与断言');

  // 同时发声的幅度叠加（削顶风险）
  const active = [];
  let worst = 0;
  let worstAt = 0;
  for (const e of schedule) {
    while (active.length && active[0].timeSec + active[0].dur <= e.timeSec - 1e-9) active.shift();
    active.push(e);
    const sum = active.reduce((a, x) => a + x.peak, 0);
    if (sum > worst) { worst = sum; worstAt = e.timeSec; }
  }
  if (worst > 1.0001) push(warnings, `峰值叠加 ${worst.toFixed(3)} @${worstAt.toFixed(2)}s > 1.0（依赖主压限器，SoundEngine 已挂 DynamicsCompressor）`);

  const events = {};
  for (const e of schedule) events[e.track] = (events[e.track] || 0) + 1;
  return {
    errors,
    warnings,
    stats: {
      level: `${levelCfg.id ?? '?'} ${levelCfg.title ?? ''}`.trim(),
      style: levelCfg.style,
      events: schedule.length,
      byTrack: events,
      spanSec: loud.spanSec,
      ampDb: Object.fromEntries(Object.entries(loud.byTrack).map(([k, v]) => [k, v.ampDb])),
      areaDb: Object.fromEntries(Object.entries(loud.byTrack).map(([k, v]) => [k, v.areaDb])),
      pairs: loud.pairs.map((p) => `${p.a}/${p.b}=${p.deltaDb}dB`),
      maxPairDb: loud.pairs.length ? Math.max(...loud.pairs.map((p) => p.deltaDb)) : 0,
      bedDelta: loud.bedDelta,
      peakSum: Number(worst.toFixed(3))
    }
  };
}

/** C6 契约入口再导出：CORE 只需 `import { buildSchedule } from './audio/TrackMixer.js'`。 */
export const buildSchedule = buildScheduleFromChart;

/* ───────────────────────── 以下是浏览器侧（只有 new AudioContext 环境才用到） ───────────────────────── */

/**
 * 每声部一条 gain→panner→music 子总线。
 * 静音 = cancelScheduledValues + setValueAtTime(当前值) + linearRamp(min, +0.1s)
 * 复活 = 同上但 0.15s；两者都保留「斜坡起点是当前真实值」，所以在半路被打断也不会跳。
 */
export class TrackMixer {
  /**
   * @param {AudioContext} ctx
   * @param {{music:AudioNode,sfx:AudioNode,master:AudioNode,voices?:object,volumes?:(v:object)=>void}} opts
   */
  constructor(ctx, opts = {}) {
    if (!ctx || typeof ctx.createGain !== 'function') throw new TypeError('TrackMixer 需要真 AudioContext（浏览器侧）');
    this.ctx = ctx;
    this.music = opts.music || opts.dest || ctx.destination;
    this.sfx = opts.sfx || this.music;
    this.master = opts.master || this.music;
    this.onVolumes = opts.volumes || null;
    this._volumes = { master: 1, music: 0.85, sfx: 1 };
    this.buses = {};
    this.gains = {};
    this.muted = {};
    for (const track of MIXER_TRACKS) {
      const g = ctx.createGain();
      g.gain.value = track === 'click' ? RAMP.min : 0.9;
      const p = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
      if (p) { g.connect(p); p.connect(this.music); } else { g.connect(this.music); }
      this.buses[track] = p || g;
      this.gains[track] = g;
      this.muted[track] = false;
    }
  }

  /** 当前值取 computedValueAtTime，保证斜坡从真实位置起步（暂停/半路静音也不会跳）。 */
  _current(track) {
    const p = this.gains[track].gain;
    const t = this.ctx.currentTime;
    if (typeof p.computedValueAtTime === 'function') {
      try { return p.computedValueAtTime(t); } catch { /* 老浏览器 */ }
    }
    return p.value;
  }

  _ramp(track, target, rampSec, atSec) {
    const g = this.gains[track];
    const t0 = Number.isFinite(atSec) ? Math.max(atSec, this.ctx.currentTime) : this.ctx.currentTime;
    const from = this._current(track);
    g.gain.cancelScheduledValues(t0);
    g.gain.setValueAtTime(from, t0);
    g.gain.linearRampToValueAtTime(Math.max(RAMP.min, target), t0 + Math.max(0.001, rampSec));
    return g.gain;
  }

  /** 静音某声部（0.1s 线性斜坡）。 */
  silence(track, atSec) {
    if (!this.gains[track]) return false;
    this._ramp(track, RAMP.min, RAMP.silenceSec, atSec);
    this.muted[track] = true;
    return true;
  }

  /** 复活某声部（0.15s 线性斜坡）。 */
  revive(track, atSec) {
    if (!this.gains[track]) return false;
    this._ramp(track, this.levels && this.levels[track] != null ? this.levels[track] : 0.9, RAMP.reviveSec, atSec);
    this.muted[track] = false;
    return true;
  }

  /** hp 变化时用：level0 → 静音；level>0 → 按 hp 比例复活。 */
  applyHp(track, hp, hpMax) {
    const full = this.levels ? this.levels[track] : 0.9;
    if (!(hp > 0)) return this.silence(track);
    const ratio = hpMax > 0 ? Math.max(0.35, Math.min(1, 0.55 + 0.45 * (hp / hpMax))) : 1;
    this._ramp(track, Math.max(RAMP.min, full * ratio), RAMP.reviveSec);
    this.muted[track] = false;
    return true;
  }

  /** 设定目标响度（不立即改变已排定的声音，只改斜坡终点）。 */
  setLevel(track, value) {
    if (!(track in this.gains)) return false;
    this.levels = this.levels || {};
    this.levels[track] = Math.max(RAMP.min, Math.min(1, value));
    if (!this.muted[track]) this._ramp(track, this.levels[track], RAMP.uiSec);
    return true;
  }

  setGain(track, value) { return this.setLevel(track, value); }

  /**
   * 装载一关：按 levelCfg.tracks[].gain × 曲风 mix 设各声部目标响度。
   * @param {object} levelCfg
   * @param {object} [clock]
   */
  load(levelCfg, clock) {
    this.levelCfg = levelCfg;
    this.clock = clock || null;
    this.levels = {};
    for (const track of MIXER_TRACKS) {
      const t = (levelCfg.tracks || {})[track] || {};
      const g = Number(t.gain);
      const mix = resolveStyleMix(levelCfg.style, track);
      this.levels[track] = Math.max(RAMP.min, Math.min(1, (Number.isFinite(g) ? g : track === 'click' ? 0.5 : 0.9) * mix));
      this._ramp(track, track === 'click' ? RAMP.min : this.levels[track], RAMP.uiSec);
      this.muted[track] = track !== 'click' && !(Number(t.hp) > 0) && track !== 'bed';
    }
    if (levelCfg.mix && this.onVolumes) this.onVolumes(levelCfg.mix);
    return this;
  }

  /** 三条音量（0..1）。master/music/sfx；由 SoundEngine 落到对应总线节点。 */
  setVolumes(v = {}) {
    for (const k of ['master', 'music', 'sfx']) if (Number.isFinite(v[k])) this._volumes[k] = v[k];
    if (this.onVolumes) this.onVolumes(this._volumes);
    else {
      rampTo(this.master.gain, this._volumes.master, RAMP.uiSec, this.ctx.currentTime);
      rampTo(this.music.gain, this._volumes.music, RAMP.uiSec, this.ctx.currentTime);
      rampTo(this.sfx.gain, this._volumes.sfx, RAMP.uiSec, this.ctx.currentTime);
    }
    return this._volumes;
  }

  /** 某声部的目标总线（SoundEngine 把发声体接这里）。 */
  bus(track) { return this.buses[track] || this.music; }

  isMuted(track) { return !!this.muted[track]; }

  /** 当前应到达的响度（未静音时的目标值），play 侧用来算 peak。 */
  levelOf(track) { return this.muted[track] ? 0 : (this.levels && this.levels[track]) || 0.9; }

  dispose() {
    for (const t of MIXER_TRACKS) { try { this.gains[t].disconnect(); } catch { /* 已断开 */ } }
  }
}

function rampTo(param, value, sec, atSec) {
  if (!param) return;
  const from = typeof param.value === 'number' ? param.value : value;
  param.cancelScheduledValues(atSec);
  param.setValueAtTime(from, atSec);
  param.linearRampToValueAtTime(Math.max(0.0001, value), atSec + Math.max(0.001, sec));
}

/** 曲风级相对响度（STYLE_PRESETS 的唯一真相）；缺失时按 1 处理。 */
function resolveStyleMix(style, track) {
  const mix = (STYLE_PRESETS[style] || {}).mix;
  return mix && Number.isFinite(mix[track]) ? mix[track] : 1;
}

export default TrackMixer;
