// src/audio/SoundEngine.js — Owner: SOUND（S-01/S-02 的浏览器出口，CR-02 已批的三总线 + duck）.
// 这里是全工程**唯一**创建/持有 AudioContext 的地方。CORE 只需三件事：
//   1) 主循环每帧调 `ensureRunning()`（自愈：切标签页/系统中断后 ctx 会掉回 suspended）；
//   2) 首次 pointerdown/keydown 调 `unlockOnFirstGesture()`（Safari/Chrome 自动播放策略）；
//   3) 关卡里 `loadLevel(cfg, clock)` → `start()`，拆解/复活调 `silence/revive/applyHp`。
//
// 硬规则（写在这里并由 tools/audioAssert.mjs 守）：
//   · 时刻一律来自 clock.timeAtBeat(beat)；本文件不出现 60/bpm。
//   · 排程用 BeatClock.schedule(fn, atSec) 的滚动预调度，不用 setTimeout 累加（leader 2026-11-23 批复）。
//   · leadSec < 0（迟到）→ 不发声，只计数；主线程卡顿时宁缺不糊。
//   · BeatClock.pause()/resume() 是唯一的挂起权威：engine 自己只记 `paused` 标志，
//     绝不抢 ctx.resume()（否则暂停后声音会自己跑起来）。自愈分支只在**未暂停**时补 resume。

import { buildSchedule, silenceStartBeat, isoClock } from '../game/systems/PatternGenerator.js';
import { TrackMixer, RAMP, MIXER_TRACKS, auditSchedule, db } from './TrackMixer.js';
import { SFX_CANDIDATES, createVoiceEngine, resolveVoice, pitchToHz } from './SynthVoices.js';
import { createMetronome, clickPlan, tempoCuePlan, METRONOME_SHAPE } from './Metronome.js';

const PRELOOK_SEC = 0.14; // 略大于 CLOCK_LOOKAHEAD_SEC(0.12)，保证每个事件都能在派发前进了队列

/**
 * 建引擎。**不在构造函数里 new AudioContext**（Node 侧 import 也必须安全）。
 * @param {{latencyOffsetSec?:number,candidateOverrides?:object}} [opts]
 */
export function createSoundEngine(opts = {}) {
  return new SoundEngine(opts);
}

export class SoundEngine {
  constructor(opts = {}) {
    this.opts = opts;
    this.ctx = null;
    this.mixer = null;
    this.metronome = null;
    this.voices = null;
    this.levelCfg = null;
    this.clock = null;
    this.schedule = [];
    this.clicks = [];
    this.cues = [];
    this.paused = false;
    this.ready = false;
    this.lastError = null;
    this.stats = { played: 0, lateSkipped: 0, cues: 0, clicks: 0, sinceRestart: 0 };
    this._idx = 0;
    this._clickIdx = 0;
    this._cueIdx = 0;
    this._lastBeat = -1;
    this._beatClick = true;
    this._volumes = { master: 0.9, music: 0.85, sfx: 1.0 };
    this._duck = { amount: 0.35, attackSec: 0.02, releaseSec: 0.15, on: true };
    this._unlockBound = false;
    this._gestureHandlers = [];
  }

  /* ---------------- 生命周期 ---------------- */

  /**
   * 首次用户手势：建 ctx（或被拦下的那次不算，继续等下一个手势）。
   * @param {EventTarget} [target] 默认 window
   * @returns {boolean} 是否已经 ready
   */
  unlockOnFirstGesture(target) {
    if (this.ready) return true;
    const host = target || (typeof window !== 'undefined' ? window : null);
    if (!host || typeof host.addEventListener !== 'function') return false;
    const fire = () => {
      const ok = this.init();
      if (ok) {
        for (const [ev, fn] of this._gestureHandlers) host.removeEventListener(ev, fn);
        this._gestureHandlers = [];
        this._unlockBound = false;
      }
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      host.addEventListener(ev, fire, { once: false, passive: true });
      this._gestureHandlers.push([ev, fire]);
    }
    this._unlockBound = true;
    return this.ready;
  }

  /**
   * 真正建图：AudioContext + 三总线 + 压限 + mixer + voices + metronome。
   * @param {BaseAudioContext} [injectedCtx] 测试注入（tools/audioAssert.mjs 的假上下文）；浏览器不传
   */
  init(injectedCtx) {
    if (this.ready) return true;
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : null;
    if (!injectedCtx && !Ctor) {
      this.lastError = 'no-AudioContext';
      return false;
    }
    try {
      this.ctx = injectedCtx || new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this._volumes.master;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -8;
      comp.knee.value = 24;
      comp.ratio.value = 3;
      comp.attack.value = 0.004;
      comp.release.value = 0.12;
      this.music = this.ctx.createGain();
      this.music.gain.value = this._volumes.music;
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = this._volumes.sfx;
      this.duck = this.ctx.createGain();
      this.duck.gain.value = 1;
      this.duckPan = typeof this.ctx.createStereoPanner === 'function' ? this.ctx.createStereoPanner() : null;
      this.music.connect(this.duck);
      if (this.duckPan) { this.duck.connect(this.duckPan); this.duckPan.connect(comp); } else { this.duck.connect(comp); }
      this.sfx.connect(comp);
      comp.connect(this.master);
      this.master.connect(this.ctx.destination);

      this.mixer = new TrackMixer(this.ctx, { music: this.music, sfx: this.sfx, master: this.master, volumes: (v) => this._applyVolumes(v) });
      const clickBus = this.mixer.bus('click');
      this.voiceKits = {};
      for (const t of ['kick', 'bass', 'synth', 'bed']) this.voiceKits[t] = createVoiceEngine(this.ctx, this.mixer.bus(t));
      this.voices = this.voiceKits.kick;
      this.metronome = createMetronome(this.ctx, { bus: clickBus, candidate: METRONOME_SHAPE.candidate });
      this.ready = true;
      this.lastError = null;
      this.resumeCtx();
      return true;
    } catch (err) {
      this.lastError = String(err && err.message ? err.message : err);
      return false;
    }
  }

  /** 自愈：只在**未暂停**时把 suspended 的 ctx 拉回来（暂停的权威在 BeatClock）。 */
  ensureRunning() {
    if (!this.ready) return false;
    const st = this.ctx.state;
    if (st === 'suspended' && !this.paused) {
      this.resumeCtx();
      return false;
    }
    if (this.paused && st === 'running') this.suspendCtx();
    return st === 'running';
  }

  resumeCtx() {
    if (!this.ctx || typeof this.ctx.resume !== 'function') return Promise.resolve(false);
    return this.ctx.resume().then(() => true).catch(() => false);
  }

  suspendCtx() {
    if (!this.ctx || typeof this.ctx.suspend !== 'function') return Promise.resolve(false);
    return this.ctx.suspend().then(() => true).catch(() => false);
  }

  /** CORE 的暂停/恢复入口：只翻标志，具体 ctx 挂起交给 ensureRunning 的自愈分支。 */
  setPaused(flag) {
    this.paused = !!flag;
    if (this.paused) this.suspendCtx();
    else this.resumeCtx();
    return this.paused;
  }

  /* ---------------- 关卡 ---------------- */

  /**
   * 装载一关：算发声序 + 节拍器计划 + 变速提示，并设各声部目标响度。
   * @param {object} levelCfg
   * @param {{timeAtBeat:(b:number)=>number,schedule?:Function,now?:Function}} clock
   */
  loadLevel(levelCfg, clock) {
    if (!levelCfg) return false;
    this.levelCfg = levelCfg;
    this.clock = clock || this.clock || isoClock(levelCfg);
    const mix = levelCfg.mix || {};
    if (mix.master != null || mix.music != null || mix.sfx != null) {
      this._volumes = { master: mix.master ?? this._volumes.master, music: mix.music ?? this._volumes.music, sfx: mix.sfx ?? this._volumes.sfx };
    }
    if (mix.duck) this._duck = Object.assign({}, this._duck, mix.duck);
    if (this.mixer) this.mixer.load(levelCfg, this.clock);
    if (this.ctx) this._applyVolumes(this._volumes);
    this.schedule = buildSchedule(levelCfg, this.clock);
    this.clicks = clickPlan(levelCfg, this.clock);
    this.cues = tempoCuePlan(levelCfg, this.clock);
    this.hi = silenceStartBeat(levelCfg);
    this.audit = auditSchedule(levelCfg, this.schedule, this.clock);
    this.arm();
    return true;
  }

  /** 归零指针（start/restart 后必须调，否则半路接着上一关的索引）。 */
  arm(atSec) {
    this._idx = 0;
    this._clickIdx = 0;
    this._cueIdx = 0;
    this._lastBeat = -1;
    this._armedAt = Number.isFinite(atSec) ? atSec : null;
    this.stats.sinceRestart = 0;
    return this;
  }

  /**
   * 滚动预调度：把「未来 PRELOOK_SEC 内」的事件塞进 BeatClock 队列。
   * @param {number} [nowSec] 测试可注入；缺省 clock.now()
   */
  pump(nowSec) {
    if (!this.ready || !this.clock || typeof this.clock.schedule !== 'function') return 0;
    const now = Number.isFinite(nowSec) ? nowSec : (typeof this.clock.now === 'function' ? this.clock.now() : 0);
    const beat = typeof this.clock.currentBeat === 'function' ? this.clock.currentBeat() : null;
    if (Number.isFinite(beat) && this._lastBeat >= 0 && beat < this._lastBeat - 0.5) this.arm(); // 重开/回跳
    if (Number.isFinite(beat)) this._lastBeat = beat;
    const horizon = now + PRELOOK_SEC;
    let pushed = 0;
    pushed += this._pumpList(this.schedule, '_idx', horizon, (e, at, lead) => this.playAt(e, at, lead));
    pushed += this._pumpList(this.clicks, '_clickIdx', horizon, (c, at, lead) => this.playClick(c, at, lead));
    pushed += this._pumpList(this.cues, '_cueIdx', horizon, (c, at, lead) => this.playCue(c, at, lead));
    return pushed;
  }

  _pumpList(list, key, horizon, fire) {
    const clock = this.clock;
    let n = 0;
    while (this[key] < list.length && list[this[key]].timeSec <= horizon) {
      const item = list[this[key]];
      this[key] += 1;
      const at = item.timeSec;
      if (typeof clock.schedule === 'function') {
        clock.schedule((absSec, leadSec) => { fire(item, absSec, leadSec); }, at);
        n += 1;
      } else {
        fire(item, at, at - (typeof clock.now === 'function' ? clock.now() : 0));
      }
    }
    return n;
  }

  /** 主循环入口：CORE 每帧调一次（内部先自愈再预调度）。 */
  update(dtSec, nowSec) {
    void dtSec;
    if (!this.ready) return false;
    this.ensureRunning();
    this.pump(nowSec);
    return true;
  }

  /* ---------------- 发声 ---------------- */

  /** 一条 schedule 事件 → 具体发声体。leadSec<0 表示迟到：宁缺不糊。 */
  playAt(e, atSec, leadSec) {
    if (!this.ready || !this.ctx) return false;
    if (Number.isFinite(leadSec) && leadSec < -0.002) { this.stats.lateSkipped++; return false; }
    if (this.mixer && this.mixer.isMuted(e.track)) return false;
    const at = Math.max(atSec, this.ctx.currentTime + 0.0005);
    const kit = this.voiceKits[e.track] || this.voices;
    const voice = e.voice || resolveVoice(this.levelCfg && this.levelCfg.style, e.track);
    const level = e.peak;
    if (e.track === 'kick') kit.kick(voice, at, e.dur, level);
    else if (e.track === 'bass') kit.bass(voice, at, e.dur, e.hz || pitchToHz(e.pitch) || 55, level);
    else if (e.track === 'synth') kit.arp(voice, at, e.dur, e.hz || pitchToHz(e.pitch) || 440, level);
    else if (e.track === 'bed') kit.hihat(voice, at, e.dur, level);
    if (e.track === 'kick' && this._duck.on) this.duckKick(at, e.dur);
    this.stats.played++;
    this.stats.sinceRestart++;
    return true;
  }

  playClick(c, atSec, leadSec) {
    if (!this.ready || !this.beatClickOn() || !this.metronome) return false;
    if (Number.isFinite(leadSec) && leadSec < -0.002) { this.stats.lateSkipped++; return false; }
    const r = this.metronome.play(c, Math.max(atSec, this.ctx.currentTime + 0.0005));
    if (r) this.stats.clicks++;
    return r;
  }

  playCue(cue, atSec, leadSec) {
    if (!this.ready) return false;
    if (Number.isFinite(leadSec) && leadSec < -0.002) { this.stats.lateSkipped++; return false; }
    const ok = this.tempoCue(atSec, cue.secondAtSec);
    if (ok) this.stats.cues++;
    return ok;
  }

  /** 侧链 duck：每个底鼓把 music 压低 amount，再按 releaseSec 回弹（全用斜坡）。 */
  duckKick(atSec, durSec) {
    if (!this.duck) return false;
    const p = this.duck.gain;
    const t0 = Math.max(atSec, this.ctx.currentTime);
    const target = Math.max(0.05, 1 - this._duck.amount);
    // 三个时刻必须单调递增，否则 lin 会先于 set 结束 → 可闻跳变（audioAssert 的 1ms 网格会抓到）
    const attack = Math.max(0.004, this._duck.attackSec);
    const release = Math.max(0.02, this._duck.releaseSec);
    const t1 = t0 + attack;
    const hold = t1 + Math.min(0.06, Math.max(0.004, durSec * 0.3));
    const t2 = hold + release;
    p.cancelScheduledValues(t0);
    p.setValueAtTime(typeof p.computedValueAtTime === 'function' ? p.computedValueAtTime(t0) : p.value, t0);
    p.linearRampToValueAtTime(target, t1);
    p.setValueAtTime(target, hold);
    p.linearRampToValueAtTime(1, t2);
    return true;
  }

  setDuck(onOrCfg) {
    if (typeof onOrCfg === 'boolean') this._duck.on = onOrCfg;
    else if (onOrCfg && typeof onOrCfg === 'object') this._duck = Object.assign({}, this._duck, onOrCfg, { on: onOrCfg.on ?? true });
    return this._duck;
  }

  /* ---------------- 拆解 / 复活（C7 消费侧） ---------------- */

  silence(track) { return this.mixer ? this.mixer.silence(track) : false; }
  revive(track) { return this.mixer ? this.mixer.revive(track) : false; }
  applyHp(track, hp, hpMax) { return this.mixer ? this.mixer.applyHp(track, hp, hpMax) : false; }

  /** C6 的 beatClick(on)：寂静段/倒计时的逐拍光点音开关。 */
  beatClick(on) {
    this._beatClick = !!on;
    if (this.mixer) this.mixer._ramp('click', this._beatClick ? (this.mixer.levels && this.mixer.levels.click) || 0.5 : RAMP.min, RAMP.uiSec);
    return this._beatClick;
  }

  beatClickOn() { return this._beatClick; }

  /**
   * 变速提示音。**签名 = tempoCue(atSec: number)**；无参调用是调用方 bug（warn 一次，不抛）。
   * @param {number} atSec 绝对时刻（秒）
   * @param {number} [secondAtSec] 第二音时刻，缺省 atSec + 0.11 拍
   */
  tempoCue(atSec, secondAtSec) {
    if (!Number.isFinite(atSec)) {
      if (!SoundEngine._cueWarned) {
        SoundEngine._cueWarned = true;
        console.warn('[SoundEngine] tempoCue(atSec) 需要绝对时刻（秒）：请传 clock.timeAtBeat(cue.beat)；本次忽略');
      }
      return false;
    }
    if (!this.ready || !this.metronome) return false;
    const sec = secondAtSec ?? (this.clock && this.clock.timeAtBeat ? this.clock.timeAtBeat((this.clock.beatAt ? this.clock.beatAt(atSec) : 0) + METRONOME_SHAPE.cue.offsetBeats) : undefined);
    return this.metronome.tempoCue(atSec, Number.isFinite(sec) ? sec : undefined);
  }

  /* ---------------- 音量 / SFX ---------------- */

  _applyVolumes(v) {
    if (!this.ctx) return v;
    const t = this.ctx.currentTime;
    ramp(this.master.gain, clamp01(v.master ?? v.music), t, RAMP.uiSec);
    if (Number.isFinite(v.music)) ramp(this.music.gain, clamp01(v.music), t, RAMP.uiSec);
    if (Number.isFinite(v.sfx)) ramp(this.sfx.gain, clamp01(v.sfx), t, RAMP.uiSec);
    return v;
  }

  /** C6：三通道音量（0..1），全部 0.05s 斜坡。 */
  setVolumes(v = {}) {
    for (const k of ['master', 'music', 'sfx']) if (Number.isFinite(v[k])) this._volumes[k] = clamp01(v[k]);
    if (this.ctx) this._applyVolumes(this._volumes);
    return Object.assign({}, this._volumes);
  }

  getVolumes() { return Object.assign({}, this._volumes); }

  /** SFX（S-08 的接口先冻结在这里：名字见 SFX_CANDIDATES）。 */
  playSfx(name, opts = {}) {
    if (!this.ready) return false;
    const def = SFX_CANDIDATES[name];
    if (!def) return false;
    const v = def.options[opts.candidate || def.default];
    const at = Math.max(Number.isFinite(opts.atSec) ? opts.atSec : this.ctx.currentTime, this.ctx.currentTime + 0.0005);
    const dest = this.sfx;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0002, at);
    g.gain.linearRampToValueAtTime(clamp01(v.level * (opts.gain ?? 1)), at + 0.008);
    g.gain.setTargetAtTime(0.0002, at + 0.008, Math.max(0.02, v.durSec / 5));
    g.gain.linearRampToValueAtTime(0, at + v.durSec);
    g.connect(dest);
    const osc = (type, hz) => {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(hz, at);
      o.connect(g);
      o.start(at);
      o.stop(at + v.durSec + 0.02);
      return o;
    };
    switch (v.kind) {
      case 'sine': osc('sine', v.hz); break;
      case 'saw': osc('sawtooth', v.hz); break;
      case 'pluck': { const o = osc('triangle', v.hz); o.frequency.setTargetAtTime(v.hz * 0.6, at, v.durSec / 3); break; }
      case 'twoTone': {
        osc('sine', v.hzA);
        const o2 = this.ctx.createOscillator();
        o2.type = 'sine';
        const g2 = this.ctx.createGain();
        g2.gain.setValueAtTime(0.0002, at + v.durSec * 0.4);
        g2.gain.linearRampToValueAtTime(clamp01(v.level * 0.8), at + v.durSec * 0.42);
        g2.gain.linearRampToValueAtTime(0, at + v.durSec);
        o2.frequency.setValueAtTime(v.hzB, at + v.durSec * 0.4);
        o2.connect(g2).connect(dest);
        o2.start(at + v.durSec * 0.4);
        o2.stop(at + v.durSec + 0.02);
        break;
      }
      case 'sineDrop': case 'sineRise': {
        const o = osc('sine', v.startHz);
        o.frequency[rampKind(v.kind)](Math.max(20, v.endHz), at + v.durSec * 0.9);
        break;
      }
      case 'noiseRise': case 'noiseBurst': case 'noise': {
        const len = Math.max(1, Math.floor(this.ctx.sampleRate * v.durSec));
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const s = this.ctx.createBufferSource();
        s.buffer = buf;
        const f = this.ctx.createBiquadFilter();
        f.type = v.kind === 'noise' ? 'highpass' : 'bandpass';
        f.frequency.setValueAtTime(v.hpHz, at);
        if (v.kind === 'noiseRise') f.frequency.linearRampToValueAtTime(v.hpHz * 3, at + v.durSec);
        s.connect(f).connect(g);
        s.start(at);
        s.stop(at + v.durSec + 0.02);
        break;
      }
      case 'fm': {
        const car = this.ctx.createOscillator();
        car.frequency.setValueAtTime(v.carrierHz, at);
        const mod = this.ctx.createOscillator();
        mod.frequency.setValueAtTime(v.carrierHz * v.modRatio, at);
        const mg = this.ctx.createGain();
        mg.gain.setValueAtTime(v.modIndex, at);
        mg.gain.setTargetAtTime(v.modIndex * 0.1, at, v.durSec / 2);
        mod.connect(mg).connect(car.frequency);
        car.connect(g);
        car.start(at); mod.start(at);
        car.stop(at + v.durSec + 0.02); mod.stop(at + v.durSec + 0.02);
        break;
      }
      default: osc('sine', 440);
    }
    return true;
  }

  /** 结算/重开时清场：停掉未派发的排程（BeatClock.stop 会自己清队列，这里只归零指针）。 */
  stop() {
    this.arm();
    return this;
  }

  dispose() {
    if (this.mixer) this.mixer.dispose();
    if (this.ctx && typeof this.ctx.close === 'function') this.ctx.close().catch(() => { /* 已关闭 */ });
    this.ready = false;
    return this;
  }

  /** 给 DebugPanel / HUD 的一行状态。 */
  getStatus() {
    return {
      ready: this.ready,
      ctxState: this.ctx ? this.ctx.state : 'none',
      paused: this.paused,
      unlockBound: this._unlockBound,
      level: this.levelCfg ? `${this.levelCfg.id ?? '?'} ${this.levelCfg.title ?? ''}`.trim() : null,
      events: this.schedule.length,
      bedEvents: this.schedule.filter((e) => e.track === 'bed').length,
      clicks: this.clicks.length,
      cues: this.cues.length,
      volumes: this.getVolumes(),
      duck: this._duck,
      muted: this.mixer ? Object.fromEntries(MIXER_TRACKS.map((t) => [t, this.mixer.isMuted(t)])) : null,
      loudnessDb: this.audit ? this.audit.stats.ampDb : null,
      bedDeltaDb: this.audit ? this.audit.stats.bedDelta : null,
      errors: this.audit ? this.audit.errors.length : null,
      lastError: this.lastError,
      stats: Object.assign({}, this.stats)
    };
  }
}

/** sineRise 用线性上滑，sineDrop 用指数下滑（指数到 0 非法，故终点恒 >0）。 */
function rampKind(kind) { return kind === 'sineRise' ? 'linearRampToValueAtTime' : 'exponentialRampToValueAtTime'; }
function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }
function ramp(param, value, atSec, sec) {
  if (!param) return;
  param.cancelScheduledValues(atSec);
  param.setValueAtTime(param.value, atSec);
  param.linearRampToValueAtTime(Math.max(0.0001, value), atSec + Math.max(0.001, sec));
}

export { TrackMixer, RAMP, db, buildSchedule, auditSchedule };
export default createSoundEngine;
