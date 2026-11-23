// tools/audioAssert.mjs — Owner: SOUND（S-01 验收 + S-02 结构审计）.
// 两种用法，同一份断言代码：
//   ① Node CLI：`node tools/audioAssert.mjs [--all|--lv 1,2] [--json] [--quiet]`
//      → 读 src/data/levels/levelN.json，用 CORE 的真 MockClock（手动模式）驱动，
//        再用**假 AudioContext** 记录全部 automation，逐条断言。
//   ② 浏览器：`import { run } from '../tools/audioAssert.mjs'` → `await run({ levels, mount })`
//      （本文件顶层不 import 任何 Node 内置模块；Node 专用的 fs 在 CLI 分支里动态取，
//        所以 `npm run build` 不会因为这份工具被浏览器引用而炸。）
//
// 断言清单（对应 S-01 验收）：
//   A1 事件时刻 vs clock.timeAtBeat < 1ms
//   A2 gain 包络无 >0.05 阶跃（形状侧 32 点 + automation 侧 1ms 网格双重）
//   A3 同一拍不许跨声部发声
//   A4 hp:0 的声部完全不发声
//   A5 轨间响度：可判定声部两两 ≤3dB；bed 比主声部低 6–24dB
//   A8 假上下文整关仿真：每个事件恰好响一次、不早不晚、无迟到堆积
//   A9 静音 0.1s / 复活 0.15s 的线性斜坡（且全程无 `gain.value =` 瞬时写入）
//   A10 节拍器计划（倒计时 4 拍 + 寂静段逐拍）与变速提示双音间隔

export const AUDIO_ASSERT_VERSION = 'R1';

/* ───────────────────────────────────────────────────────────────
 * 假 AudioContext：只记录 automation，不出声。用于结构断言。
 * ─────────────────────────────────────────────────────────────── */
const EPS = 1e-9;

function makeParam(holder, name, node, initialValue = 1) {
  const events = [{ t: 0, kind: 'initial', v: initialValue }];
  const p = {
    name,
    events,
    get value() { return holder.t; },
    set value(v) { holder.t = v; node.writes.push({ param: name, kind: 'value=', at: events.length, v }); },
    _last(at, v, kind) { events.push({ t: at, kind, v }); },
    setValueAtTime(v, at) { events.push({ t: at, kind: 'set', v }); return p; },
    linearRampToValueAtTime(v, at) { events.push({ t: at, kind: 'lin', v }); return p; },
    exponentialRampToValueAtTime(v, at) { events.push({ t: at, kind: 'exp', v: Math.max(1e-6, v) }); return p; },
    setTargetAtTime(v, at, tc) { events.push({ t: at, kind: 'target', v, tc }); return p; },
    cancelScheduledValues(at) { events.push({ t: at, kind: 'cancel', v: null }); return p; },
    computedValueAtTime(at) { return evalParam(events, at); }
  };
  return p;
}

/**
 * 按 automation 事件求值（Web Audio 语义的够用近似）：
 * set/cancel → 到点即变；lin/exp → 从前一锚点线性/指数插值；target → 指数趋近且可被后续事件接管。
 */
export function evalParam(events, t) {
  let anchorT = events.length ? events[0].t : 0;
  let value = events.length ? (events[0].v == null ? 0 : events[0].v) : 0;
  let anchorV = value;
  const at = (a, b, k) => a + (b - a) * Math.min(1, Math.max(0, k));
  for (const e of events) {
    if (e.t > t) {
      const span = Math.max(EPS, e.t - anchorT);
      const k = (t - anchorT) / span;
      if (e.kind === 'lin') return at(anchorV, e.v, k);
      if (e.kind === 'exp') {
        const a = Math.max(1e-6, anchorV);
        return a * Math.pow(Math.max(1e-6, e.v) / a, Math.min(1, Math.max(0, k)));
      }
      if (e.kind === 'target') {
        const tc = Math.max(1e-6, e.tc || 0.01);
        return e.v + (anchorV - e.v) * Math.exp(-(t - anchorT) / tc);
      }
      return anchorV;
    }
    if (e.kind === 'target') {
      const tc = Math.max(1e-6, e.tc || 0.01);
      value = e.v + (anchorV - e.v) * Math.exp(-(e.t - anchorT) / tc);
      anchorV = value;
      anchorT = e.t;
      continue;
    }
    if (e.kind === 'cancel') { value = anchorV; anchorT = Math.max(anchorT, e.t); continue; }
    value = e.v == null ? anchorV : e.v;
    anchorV = value;
    anchorT = e.t;
  }
  return anchorV;
}

/**
 * 建假上下文。`holder.t` 与外部时钟同步，node 树只是记账。
 * @param {{currentTimeRef?:{t:number}}} [opts]
 */
export function makeFakeContext(opts = {}) {
  const ref = opts.currentTimeRef || { t: 0 };
  const nodes = [];
  const mkNode = (kind, extra = {}) => {
    const node = Object.assign({ kind, writes: [], connects: [] }, extra);
    node.connect = (dst) => { node.connects.push(dst); return dst; };
    node.disconnect = () => { node.connects.length = 0; };
    nodes.push(node);
    return node;
  };
  const ctx = {
    kind: 'ctx',
    sampleRate: 48000,
    state: 'running',
    nodes,
    get currentTime() { return ref.t; },
    destination: mkNode('destination'),
    createGain: () => {
      const n = mkNode('gain', { gain: null });
      n.gain = makeParam({ get t() { return n._v; }, set t(v) { n._v = v; } }, 'gain', n, 1);
      n._v = 1;
      return n;
    },
    createStereoPanner: () => {
      const n = mkNode('panner', { pan: null });
      n.pan = makeParam({ get t() { return n._p; }, set t(v) { n._p = v; } }, 'pan', n, 0);
      n._p = 0;
      return n;
    },
    createBiquadFilter: () => {
      const n = mkNode('biquad', { frequency: null, Q: null, type: 'lowpass' });
      n.frequency = makeParam({ get t() { return n._f; }, set t(v) { n._f = v; } }, 'freq', n, 350);
      n.Q = makeParam({ get t() { return n._q; }, set t(v) { n._q = v; } }, 'Q', n, 1);
      return n;
    },
    createOscillator: () => {
      const n = mkNode('osc', { frequency: null, detune: null, type: 'sine', starts: [], stops: [] });
      n.frequency = makeParam({ get t() { return n._f; }, set t(v) { n._f = v; } }, 'freq', n, 440);
      n.detune = makeParam({ get t() { return n._d; }, set t(v) { n._d = v; } }, 'detune', n, 0);
      n.start = (at) => { n.starts.push(Number.isFinite(at) ? at : ref.t); };
      n.stop = (at) => { n.stops.push(Number.isFinite(at) ? at : ref.t); };
      return n;
    },
    createBuffer: (ch, len) => ({ numberOfChannels: ch, length: len, sampleRate: ctx.sampleRate, getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => {
      const n = mkNode('bufferSource', { buffer: null, loop: false, starts: [], stops: [] });
      n.start = (at) => { n.starts.push(Number.isFinite(at) ? at : ref.t); };
      n.stop = (at) => { n.stops.push(Number.isFinite(at) ? at : ref.t); };
      return n;
    },
    createDynamicsCompressor: () => {
      const n = mkNode('compressor');
      for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = { value: 0, setValueAtTime: () => n[k] };
      return n;
    },
    resume: () => { ctx.state = 'running'; return Promise.resolve(); },
    suspend: () => { ctx.state = 'suspended'; return Promise.resolve(); },
    close: () => { ctx.state = 'closed'; return Promise.resolve(); }
  };
  ctx._ref = ref;
  return ctx;
}

/**
 * A2/A9 的 automation 侧（混音层）：master/music/sfx/duck + 每声部 gain。
 * 从各节点第一个自动化事件起以 1ms 网格求值，断言 |Δ| ≤ 0.05；
 * 「瞬时赋值」只惩罚**已经排过程序化自动化之后**再写 gain.value 的行为（建图时的初值合法）。
 * @param {object} fakeCtx
 * @param {number} fromSec
 * @param {number} toSec
 * @param {'mix'|'note'} scope
 */
export function auditMixAutomation(fakeCtx, fromSec, toSec, scope = 'mix') {
  const errors = [];
  const nodes = fakeCtx.nodes.filter((n) => n.kind === 'gain' && n.gain && n.gain.events.length > 1);
  const scoped = scope === 'mix' ? nodes.filter((n) => n.__tag === 'mix') : nodes.filter((n) => n.__tag !== 'mix');
  let worst = 0;
  let worstAt = 0;
  let worstNode = '';
  const step = 0.001;
  for (const n of scoped) {
    const bad = n.writes.filter((w) => w.at > 1);
    if (bad.length) errors.push(`${scope} 层节点在已有自动化排程后又写 gain.value=${bad[0].v}（会盖掉斜坡，纪律禁止）`);
    const evs = n.gain.events;
    const t0 = Math.max(fromSec, evs[0].t);
    let prev = evalParam(evs, t0);
    for (let t = t0 + step; t <= Math.max(toSec, t0); t += step) {
      const v = evalParam(evs, t);
      const d = Math.abs(v - prev);
      if (d > worst) { worst = d; worstAt = t; worstNode = `${scope}:${evs.length}事件 峰${Math.max(...evs.map((e) => e.v || 0)).toFixed(2)}`; }
      prev = v;
    }
  }
  if (worst > 0.05 + 1e-6) errors.push(`${scope} 斜坡在 1ms 网格上最大变化 ${worst.toFixed(4)} > 0.05（@${worstAt.toFixed(3)}s, ${worstNode}）`);
  return { errors, maxStep: Number(worst.toFixed(5)), maxStepAt: Number(worstAt.toFixed(3)), nodes: scoped.length };
}

/**
 * 音符级包络（每个发声体自己的 gain）：必须从静音起、attack ≥6ms、末尾线性归零。
 * 这是「爆音」的另一半来源：拆解/复活时若某条音没归零就被下个音叠加，会听见台阶。
 */
export function auditNoteEnvelopes(fakeCtx) {
  const errors = [];
  const notes = fakeCtx.nodes.filter((n) => n.kind === 'gain' && n.gain && n.gain.events.length > 2 && n.__tag !== 'mix');
  let attacks = [];
  let modNodes = 0;
  for (const n of notes) {
    const evs = n.gain.events.filter((e) => e.kind !== 'initial');
    // 调制深度节点不是幅度包络（FM 载波的 modGain 值域是 Hz，几十到几百）；幅度包络由 peak 归一保证 ≤1，
    // 因此「最大值 >1.5」是唯一的区分依据 —— 真音符增益永远进不来这一支。
    if (Math.max(...evs.map((e) => e.v || 0)) > 1.5) { modNodes += 1; continue; }
    if (evs[0].kind !== 'set' || evs[0].v > 0.001) { errors.push(`音符包络没有从静音起（首事件 ${evs[0].kind}=${evs[0].v}，序列 ${evs.map((x) => x.kind).join('>')}）`); continue; }
    if (evs[evs.length - 1].kind !== 'lin' || evs[evs.length - 1].v > 0.0005) errors.push('音符包络末尾没有线性归零');
    const peak = Math.max(...evs.map((e) => e.v || 0));
    const peakIdx = evs.findIndex((e) => e.v === peak);
    if (peakIdx <= 0) continue;
    attacks.push(evs[peakIdx].t - evs[0].t);
    if (evs[peakIdx].kind !== 'lin') errors.push(`音符起音不是线性斜坡（${evs[peakIdx].kind}）`);
    if (peak > 1.0001) errors.push(`音符峰值 ${peak} > 1`);
  }
  const minAttack = attacks.length ? Math.min(...attacks) : null;
  if (minAttack !== null && minAttack < 0.006 - 1e-9) errors.push(`最短起音 ${minAttack.toFixed(4)}s < 6ms（可闻爆音下限）`);
  return { errors, notes: notes.length, modNodes, minAttackSec: minAttack === null ? null : Number(minAttack.toFixed(4)), maxAttackSec: attacks.length ? Number(Math.max(...attacks).toFixed(4)) : null };
}

/** A9：silence 必须 0.1s 线性到 min，revive 必须 0.15s 线性回升；任何 <4ms 的斜坡视为瞬断。 */
export function auditRamps(fakeCtx, label = '') {
  const errors = [];
  const ramps = [];
  for (const n of fakeCtx.nodes) {
    if (n.kind !== 'gain' || !n.gain || n.__tag !== 'mix') continue;
    const evs = n.gain.events;
    for (let i = 1; i < evs.length; i++) {
      const e = evs[i];
      if (e.kind !== 'lin') continue;
      const prevEv = evs[i - 1];
      const dur = e.t - Math.max(prevEv.t, 0);
      if (prevEv.kind === 'cancel' || dur <= 0) continue; // 取消后重排：长度按新起点算，不算瞬断
      if (dur < 0.004) errors.push(`${label}混音层出现 ${dur.toFixed(4)}s 的斜坡（<4ms ≈ 瞬断，禁止）`);
      const fromNearSilence = prevEv.v !== null && prevEv.v <= 0.0002;
      if (Math.abs(dur - 0.1) < 1e-6 && e.v <= 0.0002) ramps.push({ kind: 'silence', dur: Number(dur.toFixed(4)) });
      else if (Math.abs(dur - 0.15) < 1e-6 && e.v > 0.01 && fromNearSilence) ramps.push({ kind: 'revive', dur: Number(dur.toFixed(4)) });
    }
  }
  return { errors, ramps };
}

/* ───────────────────────────────────────────────────────────────
 * 主入口（Node 与浏览器共用）
 * ─────────────────────────────────────────────────────────────── */

/**
 * @param {{levels?:object[],clockFor?:Function,quiet?:boolean,simulate?:boolean}} [opts]
 * @returns {Promise<{result:'PASS'|'FAIL'|'SKIP',checked:number,detail:object}>}
 */
export async function run(opts = {}) {
  const levels = Array.isArray(opts.levels) ? opts.levels.filter(Boolean) : [];
  const detail = { version: AUDIO_ASSERT_VERSION, levels: [], errors: [], warnings: [], notes: [], library: null, ramps: null };
  const finish = (result) => ({ result, checked: detail.levels.length, detail });
  if (!levels.length) {
    detail.notes.push('没有可断言的谱面：src/data/levels/levelN.json 缺失或参数没给（SKIP，不算失败）');
    return finish('SKIP');
  }

  // L-1 音色库与斜坡常量（结构性，一次就够）
  const { libraryAudit, STYLE_PRESETS, VOICE_LIBRARY } = await import('../src/audio/SynthVoices.js');
  const lib = libraryAudit();
  detail.library = { styles: lib.styles, sfx: lib.sfx, voices: Object.keys(VOICE_LIBRARY), candidates: lib.rows.length, errors: lib.errors };
  detail.errors.push(...lib.errors.map((e) => `音色库：${e}`));
  const { RAMP, auditSchedule, buildSchedule } = await import('../src/audio/TrackMixer.js');
  if (Math.abs(RAMP.silenceSec - 0.1) > 1e-9) detail.errors.push(`静音斜坡 ${RAMP.silenceSec}s ≠ 0.1s`);
  if (Math.abs(RAMP.reviveSec - 0.15) > 1e-9) detail.errors.push(`复活斜坡 ${RAMP.reviveSec}s ≠ 0.15s`);
  const { auditMetronome, METRONOME_SHAPE } = await import('../src/audio/Metronome.js');
  detail.ramps = { silenceSec: RAMP.silenceSec, reviveSec: RAMP.reviveSec, minAttackSec: RAMP.minAttackSec, cue: METRONOME_SHAPE.cue };

  for (const cfg of levels) {
    const name = `L${cfg.id ?? '?'} ${cfg.title || ''}`.trim();
    const clock = opts.clockFor ? opts.clockFor(cfg) : await defaultClock(cfg);
    const schedule = buildSchedule(cfg, clock);
    const audit = auditSchedule(cfg, schedule, clock);
    const met = auditMetronome(cfg, clock);
    const row = {
      name,
      style: cfg.style,
      bpm: cfg.bpm,
      lengthBeats: cfg.lengthBeats,
      clockUsed: clock.stub ? (clock.label || 'isoClock 等速桩') : (clock.label || 'MockClock（CORE 真实现）'),
      events: schedule.length,
      byTrack: audit.stats.byTrack,
      ampDb: audit.stats.ampDb,
      areaDb: audit.stats.areaDb,
      pairs: audit.stats.pairs,
      bedDelta: audit.stats.bedDelta,
      peakSum: audit.stats.peakSum,
      maxPairDb: audit.stats.maxPairDb,
      clicks: met.stats,
      cues: met.cues,
      errors: [...audit.errors, ...met.errors],
      warnings: [...audit.warnings, ...met.warnings]
    };
    if (!STYLE_PRESETS[cfg.style]) row.errors.push(`曲风预设缺失：${cfg.style}`);
    if (schedule.length === 0) row.errors.push('发声序为空（这关不会发出任何声音）');

    // A8/A2/A9：假上下文整关仿真
    if (opts.simulate !== false) {
      const sim = await simulateLevel(cfg, schedule, met, RAMP);
      Object.assign(row, sim.stats);
      row.errors.push(...sim.errors);
      row.warnings.push(...sim.warnings);
    }
    detail.errors.push(...row.errors.map((e) => `${name}: ${e}`));
    detail.warnings.push(...row.warnings.map((e) => `${name}: ${e}`));
    detail.levels.push(row);
  }
  return finish(detail.errors.length ? 'FAIL' : 'PASS');
}

/** 时钟：优先用 CORE 的真 MockClock（手动模式，非零原点），拿不到就退回等速桩。 */
async function defaultClock(cfg) {
  try {
    const { MockClock } = await import('../src/mocks/MockClock.js');
    const clock = new MockClock({ t: 0 });
    clock.init({ bpm: cfg.bpm, sections: cfg.sections, tempoChanges: cfg.tempoChanges, introBeats: cfg.introBeats, lengthBeats: cfg.lengthBeats });
    clock.start(1.25);
    clock.label = 'src/mocks/MockClock.js（CORE 真实现，originSec=1.25）';
    return clock;
  } catch (err) {
    const { isoClock } = await import('../src/game/systems/PatternGenerator.js');
    const c = isoClock(cfg);
    c.label = `isoClock 等速桩（MockClock 不可用：${err.message}）`;
    return c;
  }
}

/**
 * 用假 AudioContext 把一整关「跑一遍」：验证每个事件恰好响一次、时刻不提前、
 * 迟到宁跳不糊，静音/复活是纯斜坡。
 */
async function simulateLevel(cfg, schedule, met) {
  const errors = [];
  const warnings = [];
  const mod = await import('../src/audio/SoundEngine.js');
  const ref = { t: 0 };
  const fake = makeFakeContext({ currentTimeRef: ref });
  const savedCtor = globalThis.AudioContext;
  const created = [];
  globalThis.AudioContext = function FakeCtor() { created.push(fake); return fake; };
  const played = [];
  let clock;
  try {
    clock = await defaultClock(cfg);
    const engine = mod.createSoundEngine();
    engine.init();
    if (!engine.ready) errors.push(`引擎 init 失败：${engine.lastError}`);
    const originalPlay = engine.playAt.bind(engine);
    engine.playAt = (e, atSec, leadSec) => {
      const ok = originalPlay(e, atSec, leadSec);
      if (ok) played.push({ track: e.track, beat: e.beat, want: e.timeSec, at: Math.max(atSec, fake.currentTime + 0.0005), lead: leadSec });
      return ok;
    };
    engine.loadLevel(cfg, clock);
    if (clock.start) clock.start(1.25);
    const endSec = clock.timeAtBeat(cfg.lengthBeats) + 0.4;
    let guard = 0;
    while (clock.now() < endSec && guard++ < 20000) {
      if (clock.advanceBy) clock.advanceBy(0.025);
      else break;
      ref.t = clock.now();
      engine.update(0.025);
    }
    const byTrack = {};
    for (const p of played) byTrack[p.track] = (byTrack[p.track] || 0) + 1;
    const wantByTrack = {};
    for (const e of schedule) wantByTrack[e.track] = (wantByTrack[e.track] || 0) + 1;
    for (const t of Object.keys(wantByTrack)) {
      if (byTrack[t] !== wantByTrack[t]) errors.push(`仿真：${t} 排了 ${wantByTrack[t]} 个音却响了 ${byTrack[t] || 0} 次`);
    }
    if (engine.stats.lateSkipped) errors.push(`仿真：${engine.stats.lateSkipped} 个事件因迟到被跳过（正常应为 0；25ms 步长跑完整关不该迟到）`);
    for (const p of played) {
      if (p.at < p.want - 1e-6) errors.push(`仿真：${p.track}@${p.beat} 提前 ${(p.want - p.at) * 1000}ms 发声`);
      if (Math.abs(p.at - p.want) > 1e-3) errors.push(`仿真：${p.track}@${p.beat} 实际时刻偏离 ${(p.at - p.want) * 1000}ms（须 <1ms）`);
    }
    const clickWant = met.plan.length;
    if (engine.stats.clicks !== clickWant) errors.push(`仿真：节拍器应 ${clickWant} 次，实际 ${engine.stats.clicks} 次`);

    // 主线程长阻塞：整段一口气推进 → 迟到的必须跳过，不许补发一堆糊在一起
    // 长阻塞仿真：独立的第二个引擎 + 独立假上下文（通过 init 注入，绝不污染第一关的节点图）
    const ref2 = { t: 0 };
    const fake2 = makeFakeContext({ currentTimeRef: ref2 });
    const engine2 = mod.createSoundEngine();
    engine2.init(fake2);
    if (!engine2.ready) errors.push(`仿真2：注入假上下文后 init 失败（${engine2.lastError}）`);
    const clock2 = await defaultClock(cfg); // 必须与外层同一口径：isoClock 桩不认 tempoChanges，
    // L4（120→140）的节拍器/事件时刻会被排成等速，与真时钟算出的 schedule 错位，长阻塞仿真末尾的光点永远排不到。
    clock2.now = () => ref2.t;
    const queue2 = [];
    clock2.schedule = (fn, at) => { queue2.push({ fn, at }); return () => {}; };
    let played2 = 0;
    let late2 = 0;
    let clicked2 = 0;
    engine2.playAt = (e, atSec, leadSec) => {
      if (Number.isFinite(leadSec) && leadSec < -0.002) { late2 += 1; return false; }
      played2 += 1;
      return true;
    };
    engine2.playClick = (c, atSec, leadSec) => {
      if (Number.isFinite(leadSec) && leadSec < -0.002) { late2 += 1; return false; }
      clicked2 += 1;
      return true;
    };
    engine2.loadLevel(cfg, clock2);
    // 先正常预调度一小段（队列里只有 horizon 内的事件），再一口气跳过半关（主线程长阻塞）
    ref2.t = Math.max(0, schedule[0].timeSec - 0.3);
    const queued = engine2.pump(ref2.t);
    if (queued > 24) warnings.push(`仿真：单次预调度灌入 ${queued} 个事件，horizon 可能过宽`);
    const half = Math.floor(schedule.length / 2);
    ref2.t = schedule[half].timeSec;
    for (const q of queue2) q.fn(q.at, q.at - ref2.t);
    const wantLate = queue2.length;
    if (wantLate !== late2 + 0) errors.push(`仿真（长阻塞）：队列 ${wantLate} 项应全部判迟到，实际跳过 ${late2}（补发 ${played2 + clicked2}）`);
    if (played2 + clicked2 > 0) errors.push(`仿真（长阻塞）：迟到的 ${played2 + clicked2} 个事件被补发了（纪律：leadSec<0 不发声）`);
    // 恢复后按 BeatClock 的语义继续滚动：先灌队列 → 派发 due → 再推进时间
    const jumpSec = ref2.t;
    queue2.length = 0;
    const totalItems = schedule.length + met.plan.length;
    const afterJump = totalItems - queued;
    let played3 = 0;
    let clicked3 = 0;
    let late3 = 0;
    const heard = [];
    engine2.playAt = (e, atSec, leadSec) => { if (leadSec < -0.002) { late3++; return false; } played3++; heard.push([e.track, e.beat, atSec]); return true; };
    engine2.playClick = (c, atSec, leadSec) => { if (leadSec < -0.002) { late3++; return false; } clicked3++; heard.push(['click', c.beat, atSec]); return true; };
    const step2 = 0.025;
    const end2 = Math.max(schedule[schedule.length - 1].timeSec, clock.timeAtBeat(cfg.lengthBeats)) + 0.6;
    let g2 = 0;
    while (ref2.t < end2 && g2++ < 20000) {
      engine2.pump(ref2.t);
      for (const q of queue2.slice()) {
        if (q.at <= ref2.t + 0.12) {
          queue2.splice(queue2.indexOf(q), 1);
          q.fn(q.at, q.at - ref2.t);
        }
      }
      ref2.t += step2;
    }
    if (played3 + clicked3 + late3 !== afterJump) {
      errors.push(`仿真（长阻塞后恢复）：跳点后的 ${afterJump} 条应全部有归属（发声或判迟到），实际 发 ${played3 + clicked3} + 迟到 ${late3} = ${played3 + clicked3 + late3}`);
    }
    if (played3 + clicked3 < afterJump - late2 - 8) {
      warnings.push(`仿真（长阻塞后恢复）：跳点吞掉了 ${afterJump - played3 - clicked3} 条（含 ${late3} 条迟到），属预期内的「宁缺不糊」`);
    }
    // 「补发」的定义：跳点（=恢复瞬间的墙上时刻）已经过去的时刻还被发声。
    // 旧口径把 jumpSec 之后 0.14s 内的事件也算补发，那是预调度视域内的**未来**事件，本来就该响（L4 变速关必现误报）。
    const replayed = heard.filter((h) => h[2] < jumpSec - 0.002);
    if (replayed.length) errors.push(`仿真（长阻塞后恢复）：将跳点之前的 ${replayed.length} 个事件补发了（例 ${replayed[0].join('@')}）`);
    const dup = heard.filter((h, i) => heard.findIndex((x) => x[0] === h[0] && x[1] === h[1]) !== i);
    if (dup.length) errors.push(`仿真（长阻塞后恢复）：${dup[0][0]}@${dup[0][1]} 重复发声`);

    // A9：静音/复活斜坡在真节点上的形状
    const tag = (n, t) => { n.__tag = t; return n; };
    if (engine.mixer) {
      for (const t of ['kick', 'bass', 'synth', 'bed', 'click']) tag(engine.mixer.gains[t], 'mix');
      tag(engine.master, 'mix');
      tag(engine.music, 'mix');
      tag(engine.sfx, 'mix');
      if (engine.duck) tag(engine.duck, 'mix');
    }
    const before = fake.nodes.length;
    engine.silence('kick');
    ref.t = clock.now() + 0.2;
    engine.revive('kick');
    const toSec = Math.max(endSec, clock.now()) + 0.5;
    const auto = auditMixAutomation(fake, 0, toSec, 'mix');
    const notes = auditNoteEnvelopes(fake);
    const ramps = auditRamps(fake, '');
    const sil = ramps.ramps.filter((r) => r.kind === 'silence');
    const rev = ramps.ramps.filter((r) => r.kind === 'revive');
    if (!sil.length) errors.push('没有找到 0.1s 静音斜坡（silence 未走 ramp？）');
    if (!rev.length) errors.push('没有找到 0.15s 复活斜坡（revive 未走 ramp？）');
    const volErr = [];
    engine.setVolumes({ master: 0.5, music: 0.4, sfx: 0.6 });
    if (Math.abs(engine.getVolumes().master - 0.5) > 1e-9) volErr.push('setVolumes 没落到状态');
    engine.setDuck(true);
    engine.playSfx('perfect');
    engine.playSfx('ui');
    // A12（S-08）：音效合成已拆到 src/audio/Sfx.js —— 8 个名字逐个要在假 ctx 上真长出节点，
    // 且 C7 路由必须「先判 penalizes === false 再落 grade」（CR-08 第 1 点），空拍伪 MISS 不许出声。
    const sfxMod = await import('../src/audio/Sfx.js');
    const sfxAuditRes = sfxMod.sfxAudit();
    if (sfxAuditRes.errors.length) errors.push(...sfxAuditRes.errors.map((e) => `Sfx 审计：${e}`));
    const sfxBefore = fake.nodes.length;
    const sfxSilent = sfxMod.SFX_NAMES.filter((n) => engine.playSfx(n) !== true);
    if (sfxSilent.length) errors.push(`Sfx：${sfxSilent.join(',')} 发不出声（名字表与合成器对不上？）`);
    if (fake.nodes.length <= sfxBefore) errors.push('Sfx：调用后节点图没有增长（playSfx 退化成空操作？）');
    if (engine.playSfx('nope') !== false) errors.push('Sfx：未知名字应返回 false');
    const sfxRoute = [
      [{ kind: 'judge', grade: 'PERFECT', id: 'x' }, true],
      [{ kind: 'judge', grade: 'GOOD', id: 'x' }, true],
      [{ kind: 'judge', grade: 'MISS', rule: 'timeout', id: null }, true],
      [{ kind: 'judge', grade: 'MISS', rule: 'emptyBeat', obstacleId: null, penalizes: false }, false],
      [{ kind: 'hp', track: 'bass', hp: 0 }, true],
      [{ kind: 'hp', track: 'bass', hp: 60 }, false],
      [{ kind: 'input', key: 'jump', hasTarget: false }, false],
      [{ kind: 'state', from: 'PEAK', to: 'RESULT' }, true],
      [{ type: 'tempo', beat: 62, fromBpm: 120, toBpm: 140 }, true]
    ];
    const sfxRouted = [];
    for (const [ev, want] of sfxRoute) {
      const got = engine.playForEvent(ev);
      if (got !== want) errors.push(`Sfx 路由 ${JSON.stringify(ev)}：应 ${want ? '响' : '不响'}，实得 ${got}`);
      const name = sfxMod.sfxForEvent(ev);
      if (name) sfxRouted.push(name);
    }
    if (sfxMod.sfxForJudgment({ grade: 'MISS', rule: 'emptyBeat', penalizes: false }) !== null) {
      errors.push('Sfx 路由：emptyBeat 伪 MISS 被路由成音效（违反 CR-08 第 1 点）');
    }
    const cueNoArg = engine.tempoCue();
    if (cueNoArg !== false) volErr.push('tempoCue() 无参调用应返回 false（签名 = tempoCue(atSec)）');
    const cueSec = engine.cues[0] ? engine.cues[0].timeSec : clock.timeAtBeat(8);
    if (engine.tempoCue(cueSec) !== true) volErr.push('tempoCue(atSec) 在就绪状态下应返回 true');
    if (engine.beatClick(false) !== false) volErr.push('beatClick(false) 应回读 false');
    engine.beatClick(true);
    if (engine.ensureRunning() === undefined) volErr.push('ensureRunning() 应返回布尔（CORE 每帧调用）');
    errors.push(...auto.errors, ...notes.errors, ...ramps.errors, ...volErr);
    if (fake.nodes.length <= before) warnings.push('仿真：节点图没有增长（发声体可能没被调用）');
    const simExtra = { mixMaxStep: auto.maxStep, mixNodes: auto.nodes, noteNodes: notes.notes, noteModNodes: notes.modNodes, noteMinAttackSec: notes.minAttackSec, noteMaxAttackSec: notes.maxAttackSec, sfxNames: sfxMod.SFX_NAMES.length, sfxRouted: [...new Set(sfxRouted)].sort() };
    const status = engine.getStatus();
    return {
      errors,
      warnings,
      stats: {
        sim: {
          played: played.length,
          byTrack,
          clicks: engine.stats.clicks,
          lateSkipped: engine.stats.lateSkipped,
          stallQueued: queued,
          stallLateSkipped: late2,
          stallPlayed: played2,
          resumedPlayed: played3,
          resumedClicks: clicked3,
          resumedWant: afterJump,
          totalItems,
          ...simExtra,
          silenceRamps: sil.length,
          reviveRamps: rev.length,
          ctxState: status.ctxState,
          duck: status.duck,
          volumes: status.volumes
        }
      }
    };
  } catch (err) {
    return { errors: [`仿真崩在：${err.message}`], warnings: ['（假上下文仿真异常，已隔离）'], stats: { sim: { failed: true, message: String(err && err.stack ? err.stack.split('\n')[0] : err) } } };
  } finally {
    if (savedCtor === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = savedCtor;
    void created;
  }
}

/* ───────────────────────────────────────────────────────────────
 * CLI
 * ─────────────────────────────────────────────────────────────── */

async function loadLevels(only) {
  const fsMod = await import(/* @vite-ignore */ 'node:' + 'fs');
  const pathMod = await import(/* @vite-ignore */ 'node:' + 'path');
  const urlMod = await import(/* @vite-ignore */ 'node:' + 'url');
  const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  const dir = pathMod.join(here, '..', 'src', 'data', 'levels');
  const out = [];
  const missing = [];
  for (const n of only) {
    const f = pathMod.join(dir, `level${n}.json`);
    try {
      out.push(JSON.parse(fsMod.readFileSync(f, 'utf8')));
    } catch {
      missing.push(n);
    }
  }
  return { levels: out, missing };
}

function line(s) { process.stdout.write(`${s}\n`); }

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const noSim = argv.includes('--nosim');
  const lvIdx = argv.indexOf('--lv');
  let only = [1, 2, 3, 4, 5, 6];
  if (lvIdx >= 0 && argv[lvIdx + 1]) only = String(argv[lvIdx + 1]).split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
  const { levels, missing } = await loadLevels(only);
  if (!quiet) line(`audioAssert v${AUDIO_ASSERT_VERSION} · 结构断言（假 AudioContext + CORE 真时钟）· 目标 L${only.join(',L')}`);
  if (missing.length) line(`  未就绪（跳过，不算失败）：L${missing.join(',L')} —— src/data/levels 里没有对应 JSON`);

  const res = await run({ levels, quiet, simulate: !noSim });
  const d = res.detail;
  if (json) {
    line(JSON.stringify(res, null, 2));
  } else {
    for (const r of d.levels) {
      line(`${r.name} [${r.style}] 时钟=${r.clockUsed}`);
      line(`  发声 ${r.events} 条 ${JSON.stringify(r.byTrack)}｜响度 ${JSON.stringify(r.ampDb)} dB｜面积 ${JSON.stringify(r.areaDb)}`);
      line(`  轨间差 ${r.pairs.length ? r.pairs.join(' ') : '（不足两条可判定声部）'}｜bed 相对主声部 ${r.bedDelta === null ? 'n/a' : `${r.bedDelta}dB`}｜同时峰值 ${r.peakSum}`);
      line(`  节拍器 ${JSON.stringify(r.clicks)}｜变速提示 ${r.cues.length} 条`);
      if (r.sim) {
        line(`  仿真：响 ${r.sim.played} 次（应 ${r.events}）｜节拍器 ${r.sim.clicks}｜迟到跳过 ${r.sim.lateSkipped}｜长阻塞：队列 ${r.sim.stallQueued} 项全部跳过 ${r.sim.stallLateSkipped}、补发 ${r.sim.stallPlayed}，恢复后 ${r.sim.resumedPlayed}+${r.sim.resumedClicks}/${r.sim.resumedWant}`);
        line(`  斜坡：静音 ${r.sim.silenceRamps} 条 / 复活 ${r.sim.reviveRamps} 条｜混音 1ms 最大步长 ${r.sim.mixMaxStep}（限 0.05）｜节点 ${r.sim.mixNodes} 个 gain`);
      }
      for (const e of r.errors) line(`    ✗ ${e}`);
      for (const w of r.warnings.slice(0, 8)) line(`    ⚠ ${w}`);
    }
    if (d.library) line(`音色库：${d.library.styles} 曲风 / ${d.library.voices.join(',')} / ${d.library.candidates} 个候选 / ${d.library.sfx} 个 SFX`);
  }
  const errs = d.errors;
  const warns = d.warnings;
  const loud = d.levels.map((r) => r.maxPairDb ?? 0);
  const step = d.levels.map((r) => (r.sim && r.sim.mixMaxStep != null ? r.sim.mixMaxStep : 0));
  const detail = `${d.levels.length}关 事件${d.levels.reduce((a, r) => a + r.events, 0)} 轨间差max=${loud.length ? Math.max(...loud).toFixed(2) : '—'}dB(≤3) 混音阶跃max=${step.length ? Math.max(...step).toFixed(3) : '—'}(≤0.05) 音符包络${Math.max(0, ...d.levels.map((r) => (r.sim && r.sim.noteNodes ? r.sim.noteNodes : 0)))}条`
  const result = !d.levels.length ? 'SKIP' : errs.length ? 'FAIL' : 'PASS';
  if (result === 'SKIP') line(`RESULT: SKIP 没有可断言的谱面（src/data/levels/levelN.json 缺失）`);
  else line(`RESULT: ${result} ${detail} 错误${errs.length} 警告${warns.length}`);
  for (const e of errs.filter((x) => !d.levels.some((r) => r.errors.includes(x))).slice(0, 10)) line(`  · ${e}`);
  process.exitCode = result === 'FAIL' ? 1 : 0;
}

if (typeof process !== 'undefined' && process.argv && process.argv[1] && /audioAssert\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((err) => {
    line(`RESULT: FAIL 工具自身崩在 ${err.message}`);
    process.exitCode = 1;
  });
}

export default run;
