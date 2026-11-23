// src/audio/Sfx.js — Owner: SOUND（S-08 音效；从 R1 的 SoundEngine.playSfx 拆出，leader R2 派工第 5 条）.
//
// 拆分原则：**不新造机制**。
//   · 候选音色仍只有 SynthVoices.SFX_CANDIDATES 里那 8 个名字（T16：默认取最保守候选，其余留给审美门 1 由人类挑）。
//   · 时刻仍由调用方给 `atSec`；本文件不出现 60/bpm、不 import BeatClock、不 import 关卡数据。
//   · 目标总线仍只有一个 dest（SoundEngine 的 sfx 增益）：静音/音量/duck 归 C6 TrackMixer，不在这里做第二套。
//   · 包络与 R1 逐字一致（0.008s 起音 → setTargetAtTime → durSec 处归零），改一个数就要重跑 audioAssert。
//
// C7 消费口径（CR-08 第 1 点，leader 已裁）：**先判 `penalizes === false` 再落 `grade`**。
//   `emptyBeat` 的伪 MISS（`grade:'MISS', rule:'emptyBeat', penalizes:false`）不许出声——
//   否则空拍会跟着掉血音效一起响，玩家听见的是没有发生的惩罚。

import { SFX_CANDIDATES } from './SynthVoices.js';

/** 冻结的 8 个名字：perfect/good/miss/crack/revive/ui/tempo/finish（CORE 只需按名字调）。 */
export const SFX_NAMES = Object.freeze(Object.keys(SFX_CANDIDATES));

/**
 * 每个名字的**触发来源**（写死在这里，避免 CORE/WORLD 各自发明一份「什么时候响」。
 * 前 6 个来自 C7 事件流，后 2 个是调用点直发：C7 里没有「菜单点击」和「复活」这两类事件）。
 */
export const SFX_TRIGGERS = Object.freeze({
  perfect: "C7 {kind:'judge',grade:'PERFECT',penalizes!==false}",
  good: "C7 {kind:'judge',grade:'GOOD',penalizes!==false}",
  miss: "C7 {kind:'judge',grade:'MISS',penalizes!==false}（rule:'timeout'/正常漏判）",
  crack: "C7 {kind:'hp',track,hp:0}（该声部彻底碎裂；扣血途中不出声，与判定声叠加会糊）",
  finish: "C7 {kind:'state',to:'RESULT'}（终点踩灭）",
  tempo: "C1 {type:'tempo',...}（变速预告，CR-08 第 3 点的过渡区间起点）",
  revive: '调用点直发：复活/checkpoint 回来（C7 无此事件，hp 单调不增）',
  ui: '调用点直发：UI 按钮与关卡选择（C7 的 input 事件不配音，声音挂在 judge 上）'
});

/** C6：只夹紧到 0..1，越界不许抛（音量来自 save.js，可能是脏数据）。 */
export function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }

/** sineRise 用线性上滑，sineDrop 用指数下滑（指数到 0 非法，故终点恒 >0）。 */
function rampKind(kind) { return kind === 'sineRise' ? 'linearRampToValueAtTime' : 'exponentialRampToValueAtTime'; }

/**
 * 发一个音效（合成部分与 R1 的 SoundEngine.playSfx 逐字等价）。
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} dest sfx 总线
 * @param {string} name SFX_NAMES 之一
 * @param {{candidate?:string,atSec?:number,gain?:number}} [opts]
 * @returns {boolean} false = 名字不存在 / 引擎没就绪（调用方自己决定要不要退化成别的）
 */
export function playSfxAt(ctx, dest, name, opts = {}) {
  if (!ctx || !dest) return false;
  const def = SFX_CANDIDATES[name];
  if (!def) return false;
  const v = def.options[opts.candidate || def.default];
  const at = Math.max(Number.isFinite(opts.atSec) ? opts.atSec : ctx.currentTime, ctx.currentTime + 0.0005);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0002, at);
  g.gain.linearRampToValueAtTime(clamp01(v.level * (opts.gain ?? 1)), at + 0.008);
  g.gain.setTargetAtTime(0.0002, at + 0.008, Math.max(0.02, v.durSec / 5));
  g.gain.linearRampToValueAtTime(0, at + v.durSec);
  g.connect(dest);
  const osc = (type, hz) => {
    const o = ctx.createOscillator();
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
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      const g2 = ctx.createGain();
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
      const len = Math.max(1, Math.floor(ctx.sampleRate * v.durSec));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const s = ctx.createBufferSource();
      s.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = v.kind === 'noise' ? 'highpass' : 'bandpass';
      f.frequency.setValueAtTime(v.hpHz, at);
      if (v.kind === 'noiseRise') f.frequency.linearRampToValueAtTime(v.hpHz * 3, at + v.durSec);
      s.connect(f).connect(g);
      s.start(at);
      s.stop(at + v.durSec + 0.02);
      break;
    }
    case 'fm': {
      const car = ctx.createOscillator();
      car.frequency.setValueAtTime(v.carrierHz, at);
      const mod = ctx.createOscillator();
      mod.frequency.setValueAtTime(v.carrierHz * v.modRatio, at);
      const mg = ctx.createGain();
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

/**
 * 一条 C2/C7 判定 → 音效名（**先判 penalizes，再落 grade**）。
 * @param {{grade?:string,penalizes?:boolean,rule?:string}} judgment
 * @returns {string|null}
 */
export function sfxForJudgment(judgment) {
  if (!judgment || typeof judgment !== 'object') return null;
  if (judgment.penalizes === false) return null; // 空拍伪 MISS：不许出声
  switch (judgment.grade) {
    case 'PERFECT': return 'perfect';
    case 'GOOD': return 'good';
    case 'MISS': return 'miss';
    default: return null; // 'EARLY'|'LATE'|无等级（C2 里不扣血的提示）
  }
}

/**
 * 一条事件流条目（C7 的 `kind`，或 C1 的 `type`）→ 音效名。
 * 纯函数：不碰 ctx，方便 contractTest / ReplayAssembler 直接断言。
 * @param {{kind?:string,type?:string}} ev
 * @returns {string|null}
 */
export function sfxForEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const tag = ev.kind || ev.type;
  switch (tag) {
    case 'judge': return sfxForJudgment(ev);
    case 'hp': return Number(ev.hp) === 0 && ev.track ? 'crack' : null;
    case 'input': return null; // 按键本身不配音：成功/失败的声音挂在 judge 上，双份会糊
    case 'state': return ev.to === 'RESULT' ? 'finish' : null;
    case 'tempo': return 'tempo'; // C1 的变速预告事件（CR-08 第 3 点）
    default: return null;
  }
}

/**
 * 整条 C7 事件流 → 可发声序（给 tools 与 ReplayAssembler 用；已按 sfxForEvent 过滤）。
 * @param {Array<object>} events
 * @returns {Array<{t:number,name:string,ev:object}>}
 */
export function sfxPlanForEvents(events = []) {
  const out = [];
  for (const ev of events) {
    const name = sfxForEvent(ev);
    if (name) out.push({ t: Number(ev.t) || 0, name, ev });
  }
  return out;
}

/** 审计：候选表与路由表是否一一对应（audioAssert 用，防止以后加名字忘了加触发来源）。 */
export function sfxAudit() {
  const errors = [];
  for (const n of SFX_NAMES) if (!SFX_TRIGGERS[n]) errors.push(`SFX "${n}" 没有登记触发来源（SFX_TRIGGERS）`);
  for (const n of Object.keys(SFX_TRIGGERS)) if (!SFX_CANDIDATES[n]) errors.push(`SFX_TRIGGERS 里的 "${n}" 在 SFX_CANDIDATES 不存在`);
  for (const [n, def] of Object.entries(SFX_CANDIDATES)) {
    if (!def.options[def.default]) errors.push(`SFX "${n}" 的默认候选 ${def.default} 不存在`);
    for (const [cn, c] of Object.entries(def.options)) {
      if (!(c.durSec > 0) || !(c.level > 0)) errors.push(`SFX "${n}.${cn}" 缺少 durSec/level`);
    }
  }
  const covered = new Set();
  for (const j of [{ grade: 'PERFECT' }, { grade: 'GOOD' }, { grade: 'MISS' },
    { grade: 'MISS', rule: 'emptyBeat', penalizes: false },
    { hp: 0, track: 'bass' }, { to: 'RESULT' }, { type: 'tempo' }]) {
    const r = sfxForEvent(Object.assign({ kind: 'judge' }, j));
    if (r) covered.add(r);
  }
  if (sfxForJudgment({ grade: 'MISS', rule: 'emptyBeat', penalizes: false }) !== null) errors.push('emptyBeat 伪 MISS 竟然路由出了音效（违反 CR-08 第 1 点）');
  return { errors, names: SFX_NAMES.slice(), covered: [...covered].sort(), triggers: Object.keys(SFX_TRIGGERS).length };
}

export default { SFX_NAMES, SFX_TRIGGERS, playSfxAt, sfxForJudgment, sfxForEvent, sfxPlanForEvents, sfxAudit, clamp01 };
