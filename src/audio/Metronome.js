// src/audio/Metronome.js — Owner: SOUND（S-02 附带 + S-01 的 beatClick/tempoCue 入口）.
// 三件事：① 寂静段逐拍「光点」音（DIS-06：段内没有障碍，只剩节拍）；② 开场 4 拍倒计时 1-2-3-GO；
// ③ 变速提示音（tempoCue）。发声仍然全程序合成，仓库零素材。
//
// 时刻来源：一律 clock.timeAtBeat(beat) / BeatClock.schedule(fn, atSec)，本文件不乘 60/bpm。
// 纯数据 + 纯函数（clickPlan / tempoCuePlan / METRONOME_SHAPE）在 Node 侧被 audioAssert 断言；
// 浏览器侧只负责把这些计划变成 OscillatorNode。

import { silenceStartBeat } from '../game/systems/PatternGenerator.js';
import { resolveVoice, VOICE_LIBRARY, METRONOME_DEFAULT } from './SynthVoices.js';

/** 节拍器形状参数（审美门 1 可改；候选见 VOICE_LIBRARY.click）。 */
export const METRONOME_SHAPE = Object.freeze({
  /** 开场倒计时拍数 = introBeats，标签固定 4 个（PRD §9「1-2-3-GO」）。 */
  countdown: Object.freeze({ beats: 4, labels: Object.freeze(['1', '2', '3', 'GO']), lastIsGo: true }),
  /** 寂静段：每拍一次光点音，重拍（能被 4 整除）升调。 */
  silenceTick: Object.freeze({ accentEvery: 4 }),
  /** 变速提示：1056Hz 主音 60ms + 0.11 拍后 1579Hz 次音，整体过高通 800Hz。 */
  cue: Object.freeze({ hzA: 1056, durA: 0.06, hzB: 1579, durB: 0.05, offsetBeats: 0.11, hpHz: 800, level: 0.55 }),
  /** 默认候选名（VOICE_LIBRARY.click 的键）。 */
  candidate: METRONOME_DEFAULT
});

/** 声部候选名列表（人类试听用；纯数据）。 */
export function clickCandidates() {
  return Object.keys(VOICE_LIBRARY.click).map((name) => ({
    name,
    default: name === METRONOME_SHAPE.candidate,
    label: VOICE_LIBRARY.click[name].label,
    audition: VOICE_LIBRARY.click[name].audition
  }));
}

/**
 * 某拍该不该出节拍器音（纯函数）。
 * @param {number} beat
 * @param {object} levelCfg
 * @param {{intro?:boolean,silence?:boolean,mainBeat?:boolean}} [scope] 只统计其中一部分
 * @returns {null|{beat:number,kind:'count'|'tick',accent:boolean,label:string|null}}
 */
export function clickAt(beat, levelCfg, scope = {}) {
  const intro = Number(levelCfg.introBeats) || 0;
  const hi = silenceStartBeat(levelCfg);
  const len = Number(levelCfg.lengthBeats) || 0;
  const b = Math.round(beat);
  if (scope.intro !== false && b >= 0 && b < intro) {
    const idx = intro - 1 - b;
    const labels = METRONOME_SHAPE.countdown.labels;
    return { beat: b, kind: 'count', accent: b === intro - 1 || b === 0, label: labels[Math.min(labels.length - 1, Math.max(0, labels.length - 1 - idx))] || String(b + 1) };
  }
  if (scope.silence !== false && b >= hi && b < len) {
    return { beat: b, kind: 'tick', accent: b % METRONOME_SHAPE.silenceTick.accentEvery === 0, label: null };
  }
  if (scope.mainBeat === true && b >= intro && b < hi) {
    return { beat: b, kind: 'tick', accent: b % METRONOME_SHAPE.silenceTick.accentEvery === 0, label: null };
  }
  return null;
}

/**
 * 节拍器计划（倒计时 + 寂静段逐拍）。时刻来自 clock.timeAtBeat。
 * @param {object} levelCfg
 * @param {{timeAtBeat:(b:number)=>number}} clock
 * @param {{mainBeat?:boolean}} [opts] mainBeat=true 时主段落也打点（练习/无障碍模式）
 */
export function clickPlan(levelCfg, clock, opts = {}) {
  const out = [];
  const intro = Number(levelCfg.introBeats) || 0;
  const len = Number(levelCfg.lengthBeats) || 0;
  const hi = silenceStartBeat(levelCfg);
  const beats = [];
  for (let b = 0; b < intro; b++) beats.push(b);
  for (let b = Math.ceil(hi); b < len; b++) beats.push(b);
  if (opts.mainBeat) for (let b = intro; b < hi; b++) beats.push(b);
  for (const b of beats) {
    const c = clickAt(b, levelCfg, opts.mainBeat ? { intro: true, silence: true, mainBeat: true } : { intro: true, silence: true });
    if (c) out.push(Object.assign({}, c, { timeSec: Number(clock.timeAtBeat(b).toFixed(4)) }));
  }
  out.sort((a, b) => a.timeSec - b.timeSec);
  return out;
}

/**
 * 变速提示计划（L4/L6 才有）。CR-03 口径：`clock.getTempoCues()` 是真相；
 * 桩时钟没有该方法时回落到 levelCfg.tempoChanges（transitionBeats 必须是 2，见 PatternGenerator.validateTempoChanges）。
 * @returns {Array<{beat:number,timeSec:number,secondAtSec:number,bpmFrom:number,bpmTo:number}>}
 */
export function tempoCuePlan(levelCfg, clock) {
  const cues = typeof clock.getTempoCues === 'function'
    ? clock.getTempoCues()
    : (levelCfg.tempoChanges || []).map((tc) => ({
      beat: Number(tc.beat) - 2,
      timeSec: Number(clock.timeAtBeat(Number(tc.beat) - 2).toFixed(4)),
      bpmFrom: Number(tc.from),
      bpmTo: Number(tc.to)
    }));
  return (cues || []).map((c) => {
    const b = Number(c.beat);
    const t0 = Number.isFinite(c.timeSec) ? c.timeSec : Number(clock.timeAtBeat(b).toFixed(4));
    const secondAtSec = Number(clock.timeAtBeat(b + METRONOME_SHAPE.cue.offsetBeats).toFixed(4));
    return { beat: b, timeSec: t0, secondAtSec, bpmFrom: Number(c.bpmFrom), bpmTo: Number(c.bpmTo) };
  }).filter((c) => Number.isFinite(c.beat) && Number.isFinite(c.timeSec) && Number.isFinite(c.secondAtSec) && c.secondAtSec > c.timeSec);
}

/** 计划自检（Node/浏览器共用）：不许有非法时刻、重叠或超出关卡长度。 */
export function auditMetronome(levelCfg, clock) {
  const errors = [];
  const plan = clickPlan(levelCfg, clock);
  const cues = tempoCuePlan(levelCfg, clock);
  const intro = Number(levelCfg.introBeats) || 0;
  const len = Number(levelCfg.lengthBeats) || 0;
  const hi = silenceStartBeat(levelCfg);
  const count = plan.filter((p) => p.kind === 'count');
  if (count.length !== intro) errors.push(`倒计时 ${count.length} 拍 ≠ introBeats ${intro}`);
  if (count.length && count[count.length - 1].label !== 'GO') errors.push(`倒计时末拍标签应为 GO，实际 ${count[count.length - 1].label}`);
  const ticks = plan.filter((p) => p.kind === 'tick');
  const wantTicks = Math.max(0, len - Math.ceil(hi));
  if (ticks.length !== wantTicks) errors.push(`寂静段节拍器 ${ticks.length} 拍 ≠ ${wantTicks} 拍`);
  for (const p of plan) {
    if (!(p.timeSec >= 0) || !Number.isFinite(p.timeSec)) errors.push(`节拍器 @${p.beat} 时刻非法 ${p.timeSec}`);
  }
  for (let i = 1; i < plan.length; i++) {
    if (plan[i].timeSec <= plan[i - 1].timeSec) errors.push(`节拍器计划未按时间升序：${plan[i - 1].beat}→${plan[i].beat}`);
  }
  for (const c of cues) {
    if (!(c.secondAtSec - c.timeSec > 0)) errors.push(`变速提示双音间隔非正 @${c.beat}`);
    const bl = typeof clock.beatLengthSec === 'function' ? clock.beatLengthSec(c.beat) : (60 / (levelCfg.bpm || 120));
    if (!(c.secondAtSec < c.timeSec + bl * 0.8)) errors.push(`变速提示第二音离主音太远 @${c.beat}`);
  }
  const warnings = [];
  if (intro > 0 && intro !== 4) warnings.push(`introBeats=${intro} 与倒计时标签 4 个不一致（UI 需要按 labels.length 显示）`);
  if (wantTicks > 0 && ticks.length !== wantTicks) warnings.push('寂静段 tick 数量与 lengthBeats-silenceBeats 不完全一致（非整拍寂静）');
  return { errors, warnings, plan, cues, stats: { clicks: plan.length, countdown: count.length, silenceTicks: ticks.length, cues: cues.length } };
}

/* ───────────────────────── 浏览器侧 ───────────────────────── */

/**
 * 节拍器发声体。
 * @param {AudioContext} ctx
 * @param {{bus:AudioNode,candidate?:string,style?:string}} opts bus = mixer.bus('click')
 */
export function createMetronome(ctx, opts = {}) {
  const voice = resolveVoice(opts.style || 'minimal-electro', 'synth', undefined);
  const click = VOICE_LIBRARY.click[opts.candidate || METRONOME_SHAPE.candidate] || VOICE_LIBRARY.click[METRONOME_DEFAULT];
  const bus = opts.bus || ctx.destination;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = METRONOME_SHAPE.cue.hpHz;
  hp.Q.value = 0.4;
  hp.connect(bus);
  void voice;

  const tone = (hz, atSec, durSec, level, dest) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(hz, atSec);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0002, atSec);
    g.gain.linearRampToValueAtTime(Math.max(0.001, level), atSec + Math.max(0.006, click.attack));
    g.gain.setTargetAtTime(0.0002, atSec + click.attack, Math.max(0.008, durSec / 6));
    g.gain.linearRampToValueAtTime(0, atSec + durSec);
    o.connect(g);
    g.connect(dest || bus);
    o.start(atSec);
    o.stop(atSec + durSec + 0.02);
  };

  return {
    /** 计划里的一拍（kind: count|tick）。 */
    play(item, atSec) {
      const accent = !!item.accent;
      const base = accent ? click.accentHz : click.hz;
      tone(base, atSec, accent ? click.durSec * 1.25 : click.durSec, (click.level || 0.5) * (accent ? 1 : 0.7));
      if (item.kind === 'count' && item.label === 'GO') tone(base * 1.5, atSec, click.durSec * 2.2, (click.level || 0.5) * 0.9);
      return true;
    },
    /**
     * 变速提示：1056Hz 主音 + 0.11 拍后 1579Hz 次音，过高通 800Hz。
     * 签名 = tempoCue(atSec: number, secondAtSec?: number)；无参调用视为调用方 bug：
     * 只 warn 一次并返回 false，绝不抛（CORE 每帧都可能碰到）。
     */
    tempoCue(atSec, secondAtSec) {
      if (!Number.isFinite(atSec)) {
        if (!createMetronome._warned) {
          createMetronome._warned = true;
          console.warn('[Metronome] tempoCue(atSec) 需要绝对时刻（秒），请传 clock.timeAtBeat(cue.beat)；本次已忽略');
        }
        return false;
      }
      const c = METRONOME_SHAPE.cue;
      const t = Math.max(atSec, ctx.currentTime);
      tone(c.hzA, t, c.durA, c.level, hp);
      const t2 = Number.isFinite(secondAtSec) && secondAtSec > t ? secondAtSec : t + c.durA + 0.02;
      tone(c.hzB, t2, c.durB, c.level * 0.85, hp);
      return true;
    },
    /** 倒计时用的可视标签（UI 侧也可以自己画）。 */
    labels: METRONOME_SHAPE.countdown.labels,
    click
  };
}

export default { METRONOME_SHAPE, clickAt, clickPlan, tempoCuePlan, auditMetronome, createMetronome, clickCandidates };
