// src/audio/SynthVoices.js — Owner: SOUND（S-02）.
// 全程序合成，仓库内零音频素材（L-02 / PRD P0-1：Safari 不支持 Ogg Vorbis，文件方案会直接阻断）。
// 本文件同时是「音色参数」的唯一真相：包络形状（attack/decay）被 PatternGenerator.buildSchedule
// 直接读走，Node 侧断言的就是这里的数据结构（纪律 4：可断言部分写成纯数据 + 纯函数）。
//
// ⚠ 审美不许独断（T16）：每条声部给 3 套候选，`STYLE_PRESETS[style].voices[track]` 指向
//   **最保守**的那一套作为默认，人类在审美门 1 里改名即可换音色，不需要动任何逻辑。
//   本文件所有数值都是「结构参数」（频率、时间、滤波 Q），不含任何时刻/pattern。

/** 声部 → 发声体用的库名（bed 走 hihat 库：音床就是铺底的碎镲/噪声层）。 */
export const TRACK_VOICE = Object.freeze({ kick: 'kick', bass: 'bass', synth: 'arp', bed: 'hihat' });

/**
 * 候选库：每条声部 3 套。attack/decay 是**包络形状参数**（占包络比例 + 指数衰减陡度），
 * 纯函数 adsrEnvelope() 与浏览器侧 GainNode 共用同一份，保证「断言到的曲线 = 听到的曲线」。
 */
export const VOICE_LIBRARY = Object.freeze({
  kick: Object.freeze({
    soft: Object.freeze({ kind: 'kick', attack: 0.04, decay: 7.5, startHz: 150, endHz: 48, fallSec: 0.09, noiseMs: 3, hpHz: 30, label: '柔软：正弦下滑、瞬态极少，长听不累', audition: 'sine 150→48Hz / 90ms' }),
    punch: Object.freeze({ kind: 'kick', attack: 0.02, decay: 9.0, startHz: 190, endHz: 52, fallSec: 0.055, noiseMs: 6, hpHz: 40, label: '有劲：更短的下滑 + 一点敲击噪声', audition: 'sine 190→52Hz / 55ms + 6ms 噪声' }),
    metal: Object.freeze({ kind: 'kick', attack: 0.01, decay: 11.0, startHz: 230, endHz: 58, fallSec: 0.04, noiseMs: 12, hpHz: 60, label: '金属：click 头明显，DnB 常用', audition: 'sine 230→58Hz + 12ms 高通噪声' })
  }),
  bass: Object.freeze({
    round: Object.freeze({ kind: 'bass', attack: 0.06, decay: 4.5, wave: 'triangle', cutoffHz: 320, q: 0.7, detuneCents: 0, subRatio: 0.5, label: '圆润：三角波 + 低通 320Hz，不糊鼓', audition: 'triangle → LP320' }),
    saw: Object.freeze({ kind: 'bass', attack: 0.05, decay: 3.6, wave: 'sawtooth', cutoffHz: 460, q: 1.2, detuneCents: 6, subRatio: 0.6, label: '锯齿：synthwave 招牌，带一点合唱失谐', audition: 'saw ×2 detune6¢ → LP460 Q1.2' }),
    reese: Object.freeze({ kind: 'bass', attack: 0.03, decay: 4.0, wave: 'sawtooth', cutoffHz: 620, q: 2.4, detuneCents: 18, subRatio: 0.7, label: 'Reese：厚、脏、有颤动，DnB/glitch 用', audition: 'saw ×3 detune18¢ → LP620 Q2.4' })
  }),
  arp: Object.freeze({
    square: Object.freeze({ kind: 'arp', attack: 0.02, decay: 6.0, wave: 'square', cutoffHz: 2200, q: 0.8, detuneCents: 0, modRatio: 0, modIndex: 0, label: '像素：方波琶音，chiptune 一眼（一耳）可辨', audition: 'square → LP2200' }),
    supo: Object.freeze({ kind: 'arp', attack: 0.05, decay: 4.2, wave: 'sawtooth', cutoffHz: 2800, q: 1.1, detuneCents: 12, modRatio: 0, modIndex: 0, label: '超锯齿：两层失谐，synthwave lead', audition: 'saw ×2 detune12¢ → LP2800' }),
    fm: Object.freeze({ kind: 'arp', attack: 0.01, decay: 8.0, wave: 'fm', cutoffHz: 3400, q: 0.9, detuneCents: 0, modRatio: 3.0, modIndex: 240, label: 'FM：金属味琶音，glitch/终曲用', audition: 'FM(carrier,3×,240) → LP3400' })
  }),
  hihat: Object.freeze({
    hat: Object.freeze({ kind: 'hihat', attack: 0.05, decay: 12, noiseMs: 40, hpHz: 7000, peakHz: 9000, q: 1.2, level: 0.5, label: '闭镲：40ms 高通噪声，最不打扰主旋律', audition: 'noise HP7k 40ms' }),
    ride: Object.freeze({ kind: 'hihat', attack: 0.03, decay: 7, noiseMs: 120, hpHz: 4200, peakHz: 6200, q: 0.8, level: 0.55, label: 'Ride：更长更亮，铺底存在感强', audition: 'noise HP4.2k 120ms' }),
    bit: Object.freeze({ kind: 'hihat', attack: 0.01, decay: 16, noiseMs: 22, hpHz: 2600, peakHz: 3600, q: 3.2, level: 0.45, label: '比特：窄带共振 + 极短，glitch 质感', audition: 'noise BP3.6k Q3.2 22ms' })
  }),
  click: Object.freeze({
    met: Object.freeze({ kind: 'click', attack: 0.002, decay: 26, hz: 1600, accentHz: 2400, durSec: 0.035, level: 0.5, label: '节拍器：干净短音，重拍升 8 半音', audition: 'sine 1.6k / 2.4k 35ms' }),
    wood: Object.freeze({ kind: 'click', attack: 0.001, decay: 34, hz: 900, accentHz: 1350, durSec: 0.05, level: 0.55, label: '木鱼：带宽噪声敲击，更像真拍点', audition: 'noise BP900 50ms' }),
    dot: Object.freeze({ kind: 'click', attack: 0.004, decay: 18, hz: 2200, accentHz: 3300, durSec: 0.06, level: 0.42, label: '光点：柔和高频，寂静段逐拍踩灭用', audition: 'sine 2.2k + 衰减 60ms' })
  })
});

/**
 * 六曲风预设（PRD §11）。`voices` 里选的是**最保守**的一套候选（T16：不许独断审美，
 * 但默认值必须存在且唯一）；`mix` 是曲风级相对响度，与 level JSON 的 tracks[].gain 相乘。
 */
export const STYLE_PRESETS = Object.freeze({
  'minimal-electro': Object.freeze({
    label: '极简电子', levels: [1],
    voices: Object.freeze({ kick: 'soft', bass: 'round', arp: 'square', hihat: 'hat' }),
    mix: Object.freeze({ kick: 1.0, bass: 0.95, synth: 0.9, bed: 0.28 }),
    tone: Object.freeze({ masterHpHz: 24, masterLpHz: 11000, reverb: 0.12 }),
    note: 'L1 只有一条可判定声部，铺底刻意做轻，拆完鼓立刻「世界变安静」。'
  }),
  synthwave: Object.freeze({
    label: 'Synthwave', levels: [2],
    voices: Object.freeze({ kick: 'soft', bass: 'saw', arp: 'supo', hihat: 'hat' }),
    mix: Object.freeze({ kick: 1.0, bass: 0.95, synth: 0.9, bed: 0.28 }),
    tone: Object.freeze({ masterHpHz: 28, masterLpHz: 12500, reverb: 0.22 }),
    note: '锯齿贝斯 + 失谐 lead，鼓保持柔软给贝斯让低频。'
  }),
  chiptune: Object.freeze({
    label: 'Chiptune', levels: [3],
    voices: Object.freeze({ kick: 'punch', bass: 'round', arp: 'square', hihat: 'bit' }),
    mix: Object.freeze({ kick: 1.0, bass: 0.95, synth: 0.92, bed: 0.26 }),
    tone: Object.freeze({ masterHpHz: 60, masterLpHz: 9000, reverb: 0.05 }),
    note: '方波为主，包络极短，模拟 4 声道芯片。'
  }),
  'drum-and-bass': Object.freeze({
    label: 'Drum & Bass', levels: [4],
    voices: Object.freeze({ kick: 'metal', bass: 'reese', arp: 'fm', hihat: 'ride' }),
    mix: Object.freeze({ kick: 1.0, bass: 0.98, synth: 0.88, bed: 0.3 }),
    tone: Object.freeze({ masterHpHz: 30, masterLpHz: 14000, reverb: 0.1 }),
    note: '薄而响的底鼓 + Reese 贝斯；变速关（L4）的拍长全靠 BeatClock，音色不掺和。'
  }),
  glitch: Object.freeze({
    label: 'Glitch', levels: [5],
    voices: Object.freeze({ kick: 'metal', bass: 'reese', arp: 'fm', hihat: 'bit' }),
    mix: Object.freeze({ kick: 1.0, bass: 0.94, synth: 0.9, bed: 0.32 }),
    tone: Object.freeze({ masterHpHz: 80, masterLpHz: 8000, reverb: 0.06 }),
    note: '窄带 + 极短衰减，配合 L5 的假节拍（假标记只属于渲染层，音色层没有任何假事件）。'
  }),
  'full-arrangement': Object.freeze({
    label: '完整编曲', levels: [6],
    voices: Object.freeze({ kick: 'punch', bass: 'saw', arp: 'supo', hihat: 'ride' }),
    mix: Object.freeze({ kick: 1.0, bass: 0.95, synth: 0.92, bed: 0.3 }),
    tone: Object.freeze({ masterHpHz: 32, masterLpHz: 13500, reverb: 0.28 }),
    note: '三声部同时在场，靠 mix 与 bed 拉开层次而不是靠总音量（失败模式 4）。'
  })
});

/** SFX 候选（S-08 在 R2 落地，但接口与候选先冻结，CORE 已可按名字调 playSfx）。 */
export const SFX_CANDIDATES = Object.freeze({
  perfect: Object.freeze({ default: 'bell', options: Object.freeze({
    bell: Object.freeze({ kind: 'fm', carrierHz: 1046, modRatio: 2.0, modIndex: 420, durSec: 0.22, level: 0.5, label: '铜铃：明亮不刺耳' }),
    pluck: Object.freeze({ kind: 'pluck', hz: 1318, durSec: 0.14, level: 0.46, label: '拨弦：更短更干' }),
    chime: Object.freeze({ kind: 'twoTone', hzA: 1318, hzB: 1976, durSec: 0.3, level: 0.42, label: '双音：奖励感最强' })
  }) }),
  good: Object.freeze({ default: 'tick', options: Object.freeze({
    tick: Object.freeze({ kind: 'noise', hpHz: 3200, durSec: 0.05, level: 0.34, label: '轻 tick' }),
    blip: Object.freeze({ kind: 'sine', hz: 880, durSec: 0.07, level: 0.36, label: '短促正弦' })
  }) }),
  miss: Object.freeze({ default: 'thud', options: Object.freeze({
    thud: Object.freeze({ kind: 'sineDrop', startHz: 220, endHz: 70, durSec: 0.2, level: 0.5, label: '闷坠' }),
    buzz: Object.freeze({ kind: 'saw', hz: 116, durSec: 0.16, level: 0.42, label: '锯齿嗡' })
  }) }),
  crack: Object.freeze({ default: 'shatter', options: Object.freeze({
    shatter: Object.freeze({ kind: 'noiseBurst', hpHz: 1200, durSec: 0.32, level: 0.55, label: '碎裂：噪声下滑' }),
    glass: Object.freeze({ kind: 'noiseBurst', hpHz: 3600, durSec: 0.22, level: 0.5, label: '玻璃：更亮更短' })
  }) }),
  revive: Object.freeze({ default: 'swell', options: Object.freeze({
    swell: Object.freeze({ kind: 'sineRise', startHz: 300, endHz: 900, durSec: 0.28, level: 0.42, label: '上升：复活=回来' }),
    reverse: Object.freeze({ kind: 'noiseRise', hpHz: 800, durSec: 0.34, level: 0.4, label: '反向镲' })
  }) }),
  ui: Object.freeze({ default: 'click', options: Object.freeze({
    click: Object.freeze({ kind: 'sine', hz: 1200, durSec: 0.04, level: 0.3, label: 'UI 点击' }),
    soft: Object.freeze({ kind: 'sine', hz: 760, durSec: 0.06, level: 0.26, label: '柔和点击' })
  }) }),
  tempo: Object.freeze({ default: 'sweep', options: Object.freeze({
    sweep: Object.freeze({ kind: 'sineRise', startHz: 520, endHz: 1560, durSec: 0.34, level: 0.44, label: '变速上滑' }),
    double: Object.freeze({ kind: 'twoTone', hzA: 784, hzB: 1176, durSec: 0.26, level: 0.42, label: '双音提示' })
  }) }),
  finish: Object.freeze({ default: 'stomp', options: Object.freeze({
    stomp: Object.freeze({ kind: 'sineDrop', startHz: 320, endHz: 45, durSec: 0.5, level: 0.6, label: '终点踩灭' }),
    gate: Object.freeze({ kind: 'noiseBurst', hpHz: 600, durSec: 0.6, level: 0.55, label: '闸门落下' })
  }) })
});

/** 寂静段/倒计时的节拍器候选（Metronome 用）。 */
export const METRONOME_DEFAULT = 'dot';

/** 声部默认声像（bed 稍偏右，给左侧的障碍判定线让出空间；纯数据，可断言）。 */
export const TRACK_PAN = Object.freeze({ kick: 0, bass: -0.06, synth: 0.12, bed: 0.2 });

/**
 * 解析出某关某声部实际用的音色参数（纯函数，可断言）。
 * @param {string} style levelCfg.style
 * @param {'kick'|'bass'|'synth'|'bed'} track
 * @param {string} [candidate] 覆盖候选名（审美门 1 选定后由 CORE 传进来）
 * @returns {Readonly<object>}
 */
export function resolveVoice(style, track, candidate) {
  const preset = STYLE_PRESETS[style] || STYLE_PRESETS['minimal-electro'];
  const lib = TRACK_VOICE[track] || 'kick';
  const name = candidate || preset.voices[lib] || Object.keys(VOICE_LIBRARY[lib])[0];
  const voice = VOICE_LIBRARY[lib][name] || VOICE_LIBRARY[lib][Object.keys(VOICE_LIBRARY[lib])[0]];
  return Object.assign({}, voice, {
    track,
    style,
    candidateName: name,
    styleMix: (preset.mix && preset.mix[track]) || 1,
    pan: track in TRACK_PAN ? TRACK_PAN[track] : 0,
    tone: preset.tone
  });
}

/** 六关曲风 → 关卡号（S-12 分关视觉参数也会读这张表）。 */
export function styleForLevel(id) {
  const hit = Object.entries(STYLE_PRESETS).find(([, p]) => p.levels.includes(Number(id)));
  return hit ? hit[0] : 'minimal-electro';
}

/** 纯 JS 端可断言：包络峰值恒为 1、长度恒等、无 NaN。 */
export function libraryAudit() {
  const errors = [];
  const rows = [];
  for (const [lib, cands] of Object.entries(VOICE_LIBRARY)) {
    const names = Object.keys(cands);
    if (names.length < 2) errors.push(`${lib}: 候选只有 ${names.length} 套（审美门要求 2–3 套）`);
    const keyset = names.map((n) => Object.keys(cands[n]).sort().join(','));
    if (new Set(keyset).size > 1) errors.push(`${lib}: 各候选参数键不一致 → ${[...new Set(keyset)].join(' | ')}`);
    for (const n of names) {
      const v = cands[n];
      if (!(v.attack > 0 && v.attack < 0.5)) errors.push(`${lib}.${n}: attack ${v.attack} 不在 (0,0.5)`);
      if (!(v.decay > 0)) errors.push(`${lib}.${n}: decay ${v.decay} 非正`);
      rows.push(`${lib}.${n}`);
    }
  }
  for (const [style, p] of Object.entries(STYLE_PRESETS)) {
    for (const [track, lib] of Object.entries(TRACK_VOICE)) {
      if (!VOICE_LIBRARY[lib][p.voices[lib]]) errors.push(`${style}: 声部 ${track} 的候选 ${p.voices[lib]} 不存在`);
      if (!(p.mix[track] > 0 && p.mix[track] <= 1)) errors.push(`${style}: mix.${track}=${p.mix[track]} 超出 (0,1]`);
    }
    if (!(p.tone.masterHpHz >= 0 && p.tone.masterLpHz > p.tone.masterHpHz)) errors.push(`${style}: 主滤波区间非法`);
  }
  for (const [name, s] of Object.entries(SFX_CANDIDATES)) {
    if (!s.options[s.default]) errors.push(`sfx.${name}: 默认候选 ${s.default} 不存在`);
    if (Object.keys(s.options).length < 2) errors.push(`sfx.${name}: 候选少于 2 套`);
  }
  return { errors, rows, styles: Object.keys(STYLE_PRESETS).length, sfx: Object.keys(SFX_CANDIDATES).length };
}

/**
 * 浏览器侧：建一组「发声到指定总线」的函数。只在真 AudioContext 下调用。
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} dest 目标总线（TrackMixer 给的 track bus）
 */
export function createVoiceEngine(ctx, dest) {
  const now = () => ctx.currentTime;
  const noiseBuf = (() => {
    const len = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  })();

  const env = (v, atSec, durSec, level) => {
    const g = ctx.createGain();
    const peak = Math.max(0.0002, level);
    // 起音下限与 PatternGenerator.buildSchedule 的 attackSec 同口径（TrackMixer.RAMP.minAttackSec = 6ms）：
    // 短时值音符（如 L3/L6 的 1/16 琶音、铺底）按 attack×durSec 会算出 1–3ms → 可闻爆音，且与 Node 侧断言不一致。
    const a = Math.max(0.006, Math.min(v.attack * durSec, durSec * 0.6));
    g.gain.setValueAtTime(0.0002, atSec);
    g.gain.linearRampToValueAtTime(peak, atSec + a);
    g.gain.setTargetAtTime(0.0002, atSec + a, Math.max(0.008, durSec / Math.max(0.5, v.decay)));
    g.gain.linearRampToValueAtTime(0, atSec + durSec);
    g.connect(dest);
    return g;
  };
  const osc = (type, hz, atSec) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, atSec);
    return o;
  };
  const noise = (atSec, durSec) => {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.start(atSec, Math.random() * 0.2);
    s.stop(atSec + durSec + 0.02);
    return s;
  };
  const filter = (type, hz, q, atSec) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(hz, atSec);
    if (Number.isFinite(q)) f.Q.setValueAtTime(q, atSec);
    return f;
  };
  const stop = (o, atSec, durSec) => o.stop(atSec + durSec + 0.02);

  return {
    /** 底鼓：正弦下滑 + 极短噪声瞬态。 */
    kick(v, atSec, durSec, level = 1) {
      const g = env(v, atSec, durSec, level * (v.level || 1));
      const o = osc('sine', v.startHz, atSec);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, v.endHz), atSec + v.fallSec);
      o.connect(g);
      o.start(atSec);
      o.stop(atSec + durSec + 0.02);
      if (v.noiseMs > 0) {
        const ng = ctx.createGain();
        // 6ms 起音的极短爆破：仍是斜坡（全图不允许任何瞬时阶跃，audioAssert 的 1ms 网格才站得住）
        ng.gain.setValueAtTime(0.0002, atSec);
        ng.gain.linearRampToValueAtTime(0.25 * level, atSec + 0.006);
        ng.gain.linearRampToValueAtTime(0, atSec + Math.max(0.012, v.noiseMs / 1000));
        const hp = filter('highpass', v.hpHz, 0.7, atSec);
        const n = noise(atSec, v.noiseMs / 1000);
        n.connect(hp).connect(ng);
        ng.connect(dest);
      }
    },
    /** 贝斯：1 或 2 层失谐锯齿/三角 + 低通，另给一路副八度正弦垫低。 */
    bass(v, atSec, durSec, hz, level = 1) {
      const g = env(v, atSec, durSec, level * (v.level || 1));
      const lp = filter('lowpass', v.cutoffHz, v.q, atSec);
      lp.connect(g);
      const layers = v.detuneCents > 0 ? 2 : 1;
      for (let i = 0; i < layers; i++) {
        const o = osc(v.wave, hz, atSec);
        o.detune.setValueAtTime(i === 0 ? -v.detuneCents : v.detuneCents, atSec);
        o.connect(lp);
        o.start(atSec);
        stop(o, atSec, durSec);
      }
      if (v.subRatio > 0) {
        const sub = osc('sine', hz / 2, atSec);
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(v.subRatio, atSec);
        sub.connect(sg).connect(lp);
        sub.start(atSec);
        stop(sub, atSec, durSec);
      }
    },
    /** 琶音/lead：方波、超锯齿或 FM。 */
    arp(v, atSec, durSec, hz, level = 1) {
      const g = env(v, atSec, durSec, level * (v.level || 1));
      const lp = filter('lowpass', v.cutoffHz, v.q, atSec);
      lp.connect(g);
      if (v.wave === 'fm') {
        const car = osc('sine', hz, atSec);
        const mod = osc('sine', hz * v.modRatio, atSec);
        const mg = ctx.createGain();
        mg.gain.setValueAtTime(v.modIndex, atSec);
        mg.gain.setTargetAtTime(v.modIndex * 0.15, atSec, durSec * 0.4);
        mod.connect(mg).connect(car.frequency);
        car.connect(lp);
        car.start(atSec);
        mod.start(atSec);
        stop(car, atSec, durSec);
        stop(mod, atSec, durSec);
        return;
      }
      const layers = v.detuneCents > 0 ? 2 : 1;
      for (let i = 0; i < layers; i++) {
        const o = osc(v.wave, hz, atSec);
        o.detune.setValueAtTime(i === 0 ? -v.detuneCents : v.detuneCents, atSec);
        o.connect(lp);
        o.start(atSec);
        stop(o, atSec, durSec);
      }
    },
    /** 音床（hi-hat / ride / 比特噪声）：高通或带通噪声短促爆破。 */
    hihat(v, atSec, durSec, level = 1) {
      const g = env(v, atSec, durSec, level * (v.level || 1));
      const f = filter(v.q > 2 ? 'bandpass' : 'highpass', v.q > 2 ? v.peakHz : v.hpHz, v.q, atSec);
      f.connect(g);
      const n = noise(atSec, Math.min(durSec, v.noiseMs / 1000));
      n.connect(f);
    },
    /** 节拍器 / UI 一类短音。 */
    click(v, atSec, accent = false, level = 1) {
      const dur = v.durSec;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0002, atSec);
      g.gain.linearRampToValueAtTime((v.level || 0.5) * level, atSec + v.attack);
      g.gain.setTargetAtTime(0.0002, atSec + v.attack, dur / Math.max(1, v.decay * 0.35));
      g.gain.linearRampToValueAtTime(0, atSec + dur);
      g.connect(dest);
      const o = osc('sine', accent ? v.accentHz : v.hz, atSec);
      o.connect(g);
      o.start(atSec);
      o.stop(atSec + dur + 0.02);
      if (v.kind === 'click' && v.hz < 1200) {
        const n = noise(atSec, 0.012);
        const bp = filter('bandpass', accent ? v.accentHz : v.hz, 4, atSec);
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0002, atSec);
        ng.gain.linearRampToValueAtTime(0.18 * level, atSec + 0.006);
        ng.gain.linearRampToValueAtTime(0, atSec + 0.016);
        n.connect(bp).connect(ng).connect(dest);
      }
    },
    now
  };
}

/** 音名 → 频率（A4=440，与 PatternGenerator.pitchToMidi 同一套命名）。 */
export function pitchToHz(pitch) {
  if (typeof pitch !== 'string') return null;
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(pitch.trim());
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  const semi = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const midi = (parseInt(m[3], 10) + 1) * 12 + base + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export default { VOICE_LIBRARY, STYLE_PRESETS, SFX_CANDIDATES, resolveVoice, createVoiceEngine, libraryAudit, pitchToHz, styleForLevel };
