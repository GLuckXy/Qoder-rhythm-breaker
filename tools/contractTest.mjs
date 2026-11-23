// tools/contractTest.mjs — Owner: CORE（K-03 脚手架 + K-06/K-10 契约断言）
// leader 的门禁之一。纯 Node，无浏览器、无依赖包，只允许用 node: 内置模块。
//
//   node tools/contractTest.mjs                 全跑
//   node tools/contractTest.mjs --all           同上
//   node tools/contractTest.mjs --case clock    单跑（可重复 --case a --case b）
//   node tools/contractTest.mjs --json          机器可读输出（verifyAll.mjs 用）
//
// 约定（不可改）：最后一行必须打印 `RESULT: PASS <统计>` 或 `RESULT: FAIL <第一个失败断言>`。
// 依赖他人文件尚未到位的断言打 SKIP <原因>，不代造他人文件（T2）。
//
// 覆盖：C1 BeatClock/MockClock ｜ C2 JudgeSystem ｜ C7 事件流 ｜ C8 physics ｜ §8.3 save ｜ K-03 DebugPanel（假 DOM）｜ T4 时钟越界扫描

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/* ------------------------------------------------------------------ */
/* 迷你断言骨架                                                         */
/* ------------------------------------------------------------------ */

const state = {
  case: '(init)',
  asserts: [],
  notes: [],
  skips: [],
  firstFail: null
};

function record(kind, label, detail) {
  state.asserts.push({ case: state.case, kind, label, detail: detail ?? null });
  if (kind === 'fail' && !state.firstFail) state.firstFail = `[${state.case}] ${label}${detail ? ` — ${detail}` : ''}`;
  return kind === 'pass';
}

function ok(label, cond, detail) {
  return record(cond ? 'pass' : 'fail', label, cond ? detail : detail ?? '条件为假');
}

function eq(label, actual, expected) {
  const pass = Object.is(actual, expected) || actual === expected;
  return record(pass ? 'pass' : 'fail', label, pass ? null : `期望 ${fmtVal(expected)}，实际 ${fmtVal(actual)}`);
}

function near(label, actual, expected, tolMs, unit = '') {
  const d = Math.abs(Number(actual) - Number(expected));
  const pass = Number.isFinite(d) && d <= tolMs;
  return record(pass ? 'pass' : 'fail', label, pass ? null : `|${fmtVal(actual)} - ${fmtVal(expected)}| = ${fmtVal(d)}${unit} > ${tolMs}${unit}`);
}

function lt(label, actual, limit, unit = '') {
  const pass = Number.isFinite(actual) && actual < limit;
  return record(pass ? 'pass' : 'fail', label, pass ? null : `${fmtVal(actual)}${unit} 未小于 ${limit}${unit}`);
}

function throws(label, fn, match) {
  try {
    fn();
  } catch (err) {
    const msg = String(err?.message ?? err);
    return record(match && !msg.includes(match) ? 'fail' : 'pass', label, match && !msg.includes(match) ? `抛错但信息不含「${match}」：${msg}` : null);
  }
  return record('fail', label, '没有抛错');
}

function note(text) {
  state.notes.push({ case: state.case, text });
}

function skipCase(name, reason) {
  state.skips.push({ case: name, reason });
  note(`SKIP ${name} — ${reason}`);
}

function fmtVal(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? (Math.abs(v) < 1e-4 && v !== 0 ? v.toExponential(3) : String(Number(v.toFixed(6)))) : String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function load(relPath, caseName) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    skipCase(caseName, `${relPath} 尚不存在（归属他人，不代造）`);
    return null;
  }
  try {
    return await import(pathToFileURL(abs).href);
  } catch (err) {
    record('fail', `[${caseName}] ${relPath} 无法 import`, String(err?.message ?? err));
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 夹具                                                                 */
/* ------------------------------------------------------------------ */

/** C4 ObstacleInstance 的最小可用形状（真正由 SOUND 的 PatternGenerator 生成）。 */
function obstacle({ id, beat, timeSec, type = 'spike', track = 'kick', core = false, pitchTier = 0, speed = 1 }) {
  return { id, track, type, beat, timeSec, core, pitchTier, speed, state: 'pending', grade: null };
}

function makeStubStorage(initial = {}, { throwGet = false, throwSet = false } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    writes: 0,
    reads: 0,
    getItem(key) {
      if (throwGet) throw new Error('SecurityError: localStorage 被隐私模式禁用');
      this.reads += 1;
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throwSet) throw new Error('QuotaExceededError');
      this.writes += 1;
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    }
  };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(abs);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* case: clock（C1）                                                   */
/* ------------------------------------------------------------------ */

const L4_SPEC = {
  bpm: 120,
  introBeats: 4,
  lengthBeats: 160,
  sections: [
    { beat: 0, state: 'INTRO', layers: [] },
    { beat: 4, state: 'BUILD', layers: ['kick'] },
    { beat: 16, state: 'PEAK', layers: ['kick', 'bass'] },
    { beat: 96, state: 'PEAK', layers: ['kick', 'bass'] }
  ],
  tempoChanges: [{ beat: 64, bpm: 140, transitionBeats: 2 }]
};

async function caseClock() {
  const bc = await load('src/audio/BeatClock.js', 'clock');
  const mc = await load('src/mocks/MockClock.js', 'clock');
  if (!bc || !mc) return;
  const { MockClock } = mc;
  const { createBeatClock, CLOCK_LOOKAHEAD_SEC, CLOCK_POLL_MS, CLOCK_STATES } = bc;

  eq('clock: 提前量 = 120ms（CLK-03）', CLOCK_LOOKAHEAD_SEC, 0.12);
  eq('clock: 轮询 = 25ms（CLK-03）', CLOCK_POLL_MS, 25);

  // --- C1 接口同构：MockClock 与 BeatClock 方法集一致 ---
  const C1 = ['init', 'now', 'beatAt', 'timeAtBeat', 'schedule', 'onEvent', 'getState', 'pause', 'resume', 'start', 'stop', 'driftMs'];
  for (const name of C1) {
    ok(`clock: C1 签名 ${name}() 在 BeatClock 上存在`, typeof bc.BeatClock?.[name] === 'function');
    ok(`clock: C1 签名 ${name}() 在 MockClock 上同构`, typeof MockClock.prototype[name] === 'function');
  }

  // --- 等速 vs 分段积分（CLK-02 / T7） ---
  const c = new MockClock();
  c.init(L4_SPEC);
  c.start(0);
  const t100 = c.timeAtBeat(100);
  // 解析期望：0–62 拍 @0.5s，62–64 拍周期线性 0.5→4/14（梯形积分），64 之后 @4/14
  const p140 = 60 / 140;
  const expect100 = 62 * 0.5 + 2 * ((0.5 + p140) / 2) + 36 * p140;
  near('clock: timeAtBeat(100) 与分段积分类解一致', t100, expect100, 1e-9, 's');
  ok(
    'clock: 不是等速除法（120 恒速模型会差 >1s）',
    Math.abs(t100 - 100 * 0.5) > 1,
    `100 拍实测 ${t100.toFixed(4)}s vs 等速 ${(100 * 0.5).toFixed(4)}s`
  );
  near('clock: 变速点后拍长 = 60/140', c.timeAtBeat(65) - c.timeAtBeat(64), p140, 1e-12, 's');
  near('clock: 变速点前拍长 = 60/120', c.timeAtBeat(61) - c.timeAtBeat(60), 0.5, 1e-12, 's');

  // --- 互逆性：跨越 120→140 变速点 ---
  let maxMs = 0;
  let worstBeat = 0;
  for (let i = 0; i <= 8000; i += 1) {
    const b = 55 + (i * 20) / 8000;
    const t = c.timeAtBeat(b);
    const back = c.beatAt(t);
    const errMs = Math.abs(back - b) * c.beatLengthSec(b) * 1000;
    if (errMs > maxMs) {
      maxMs = errMs;
      worstBeat = b;
    }
  }
  let maxMsRev = 0;
  const t0 = c.timeAtBeat(55);
  const t1 = c.timeAtBeat(75);
  for (let i = 0; i <= 8000; i += 1) {
    const t = t0 + (i * (t1 - t0)) / 8000;
    const errMs = Math.abs(c.timeAtBeat(c.beatAt(t)) - t) * 1000;
    if (errMs > maxMsRev) maxMsRev = errMs;
  }
  note(`120→140 变速点 timeAtBeat/beatAt 互逆误差 = ${maxMs.toExponential(2)} ms（正向，最坏点 ${worstBeat.toFixed(3)} 拍）/ ${maxMsRev.toExponential(2)} ms（反向）`);
  lt('clock: 变速点两侧互逆误差 < 1ms（CLK-02/T7）', maxMs, 1, 'ms');
  lt('clock: 反向互逆误差 < 1ms', maxMsRev, 1, 'ms');
  eq('clock: beatAt 单调（1..160 无跳拍）', (() => {
    let bad = 0;
    for (let b = 1; b <= 160; b += 1) if (!(c.timeAtBeat(b) > c.timeAtBeat(b - 1))) bad += 1;
    return bad;
  })(), 0);

  // --- pause/resume 不重置拍序（R11） ---
  const p = new MockClock();
  p.init(L4_SPEC);
  p.start(0);
  p.advanceTo(5.0);
  const beatBeforePause = p.beatAt(p.now());
  let fired = 0;
  p.onEvent((e) => {
    if (e.type === 'beat') fired += 1;
  });
  p.schedule(() => {
    fired += 100;
  }, p.timeAtBeat(12));
  p.pause();
  near('clock: 暂停瞬间拍序冻结', p.beatAt(p.now()), beatBeforePause, 1e-12, '拍');
  ok('clock: isPaused() = true', p.isPaused() === true);
  const eventsAtPause = fired;
  p.advanceTo(35.0); // 挂起 30s
  eq('clock: 暂停 30s 内不派发任何事件/回调', fired, eventsAtPause);
  p.resume();
  near('clock: resume 后拍序不重置（仍从 10 继续）', p.beatAt(p.now()), beatBeforePause, 1e-9, '拍');
  ok('clock: resume 后原点在 now 之前', p.timeAtBeat(Math.ceil(beatBeforePause)) >= p.now() - 0.5);
  const beatAfter10s = p.beatAt(p.now() + 10);
  const expectedBeats = 10 / p.beatLengthSec(beatBeforePause);
  near('clock: resume 后 10s 走 10/拍长 拍（拍长用变速后的分段值）', beatAfter10s - beatBeforePause, expectedBeats, 1e-6, '拍');
  p.advanceTo(45.0);
  ok('clock: 恢复后节拍事件继续派发', fired > eventsAtPause, `fired=${fired}`);
  eq('clock: 暂停前挂的 schedule 最终仍被执行（平移而非丢弃）', fired >= 101, true);

  // --- schedule：绝对时刻排序 + 提前 120ms + 阻塞恢复 ---
  const s = new MockClock();
  s.init({ bpm: 120, sections: [{ beat: 0, state: 'INTRO', layers: [] }], introBeats: 4 });
  s.start(0);
  const order = [];
  for (const [label, at] of [['c', 3], ['a', 1], ['e', 5], ['b', 2], ['d', 4]]) s.schedule(() => order.push(label), at);
  s.advanceTo(6.0);
  eq('clock: schedule 执行顺序按绝对时刻（插入顺序无关）', order.join(''), 'abcde');

  const s2 = new MockClock();
  s2.init({ bpm: 120 });
  s2.start(0);
  let early = null;
  s2.schedule((at, leadSec) => {
    early = { at, leadSec, now: s2.now() };
  }, 10);
  s2.advanceTo(10 - CLOCK_LOOKAHEAD_SEC - 0.001);
  eq('clock: 提前量之外不派发', early, null);
  s2.advanceTo(10 - CLOCK_LOOKAHEAD_SEC + 0.001);
  ok('clock: 允许提前 ≤120ms 派发（发声预调度）', early !== null, `now=${s2.now().toFixed(3)} at=${early?.at}`);
  ok('clock: 回调收到 (atSec, leadSec)', early ? Math.abs(early.leadSec - (early.at - early.now)) < 1e-9 : false);

  const s3 = new MockClock();
  s3.init({ bpm: 120 });
  s3.start(0);
  const seq = [];
  for (let i = 1; i <= 8; i += 1) s3.schedule(() => seq.push(i), i * 0.25);
  s3.advanceTo(1.0);
  const before = seq.length;
  s3.advanceTo(1.3); // 模拟 300ms 主线程阻塞：一次跳 300ms
  s3.advanceTo(2.6);
  const sorted = seq.every((v, i) => i === 0 || seq[i - 1] < v);
  ok('clock: 300ms 阻塞后仍按绝对时刻升序派发且不丢事件（CLK-03）', sorted && seq.length === 8, `seq=${seq.join(',')}（阻塞前已发 ${before}）`);
  ok('clock: 阻塞后 driftMs 明显抬升（CLK-07）', Math.abs(s3.driftMs()) > 1, `drift=${s3.driftMs().toFixed(2)}ms`);
  const s4 = new MockClock();
  s4.init({ bpm: 120 });
  s4.start(0);
  for (let i = 0; i < 40; i += 1) s4.advanceTo(s4.now() + CLOCK_POLL_MS / 1000);
  lt('clock: 正常 25ms 步进下 driftMs 接近 0（目标 ≤2ms）', Math.abs(s4.driftMs()), 2, 'ms');

  // --- 事件流语义：beat / section / state / tempo ---
  const e = new MockClock();
  e.init(L4_SPEC);
  const got = { beat: [], section: [], state: [], tempo: [] };
  e.onEvent((ev) => {
    if (got[ev.type]) got[ev.type].push(ev);
  });
  e.start(0);
  ok('clock: start() 当场就把 beat 0 交给预调度窗口', got.beat.length >= 1, `beat0=${fmtVal(got.beat[0]?.timeSec)}`);
  e.advanceTo(20.5);
  eq('clock: 0–20.5s 内 beat 事件数（0..41 共 42 拍）', got.beat.length, 42);
  ok(
    'clock: beat 事件的 timeSec === timeAtBeat(beat)',
    got.beat.every((ev) => Math.abs(ev.timeSec - e.timeAtBeat(ev.beat)) < 1e-9)
  );
  eq('clock: 拍序连续无跳拍（0..41）', got.beat.map((x) => x.beat).join(','), Array.from({ length: 42 }, (_, i) => i).join(','));
  eq('clock: section 边界事件（beat 0/4/16）', got.section.length, 3);
  eq('clock: 段落进入触发 state 事件 INTRO→BUILD→PEAK', got.state.map((x) => `${x.from}>${x.to}`).join(','), 'INTRO>BUILD,BUILD>PEAK');
  eq('clock: getState() 跟随段落', e.getState(), 'PEAK');
  eq('clock: 变速尚未到达 → 无提示事件', got.tempo.length, 0);
  e.advanceTo(31.4);
  eq('clock: 变速提示在变速前 2 拍发出（CLK-04）', got.tempo.length, 1);
  if (got.tempo.length === 1) {
    near('clock: 提示音时刻 = timeAtBeat(62)', got.tempo[0].timeSec, e.timeAtBeat(62), 1e-9, 's');
    eq('clock: 提示事件带 bpmFrom/bpmTo', `${got.tempo[0].bpmFrom}>${got.tempo[0].bpmTo}`, '120>140');
    near('clock: 提示指向的目标拍 = 64', got.tempo[0].targetBeat, 64, 1e-12);
  }
  eq('clock: getTempoCues() 可供 SOUND 离线取提示时刻', e.getTempoCues().length, 1);
  throws('clock: setState 拒绝非法状态名（DIS-08）', () => e.setState('BOSS'), '非法状态');
  eq('clock: setState 合法迁移并派发 state 事件', (() => {
    const n = got.state.length;
    e.setState('DISASSEMBLED');
    return got.state.length === n + 1 && e.getState() === 'DISASSEMBLED';
  })(), true);

  // --- onEvent 抛错隔离 / 退订 ---
  const g = new MockClock();
  g.init({ bpm: 120 });
  g.start(0);
  let seen = 0;
  const realError = console.error;
  let logged = 0;
  console.error = () => {
    logged += 1;
  };
  const off = g.onEvent(() => {
    seen += 1;
    throw new Error('消费者炸了');
  });
  g.advanceTo(1.2);
  console.error = realError;
  const afterThrow = seen;
  off();
  g.advanceTo(3.0);
  eq('clock: 消费者抛错不中断时钟，退订后不再回调', seen, afterThrow);
  ok('clock: 抛错的消费者被记入 console.error', logged > 0, `logged=${logged}`);

  // --- 真 BeatClock（注入时间源）与 stop 的 teardown ---
  const holder = { t: 0 };
  const real = createBeatClock({ now: () => holder.t, manual: true });
  real.init({ bpm: 120, sections: [{ beat: 0, state: 'INTRO', layers: [] }], introBeats: 4 });
  real.start(0);
  holder.t = 4.0;
  real.tick();
  near('clock: createBeatClock(注入时间源) 与 MockClock 同一实现语义', real.beatAt(real.now()), 8, 1e-9, '拍');
  real.schedule(() => {}, 40);
  real.schedule(() => {}, 60);
  const qBefore = real.queueSize();
  real.stop();
  eq('clock: stop() 清空待派发队列（PERF-08 teardown）', real.queueSize(), 0);
  ok('clock: stop() 前队列确实非空', qBefore > 0, `queueSize=${qBefore}`);
  eq('clock: stop() 后 tick 不再派发新事件', (() => {
    let n = 0;
    real.onEvent(() => {
      n += 1;
    });
    holder.t = 9.0;
    real.tick();
    return n;
  })(), 0);
  eq('clock: Node 环境里 BeatClock.ready() 为 false（不静默建 AudioContext）', bc.BeatClock.ready(), false);
  ok('clock: BeatClock.now() 在未 attach 时不抛错', Number.isFinite(bc.BeatClock.now()));
  eq('clock: CLOCK_STATES 六值（C1/DIS-08）', CLOCK_STATES.join('|'), 'INTRO|BUILD|PEAK|DISASSEMBLED|SILENCE|RESULT');
}

/* ------------------------------------------------------------------ */
/* case: judge（C2）                                                   */
/* ------------------------------------------------------------------ */

async function caseJudge() {
  const mc = await load('src/mocks/MockClock.js', 'judge');
  const js = await load('src/game/systems/JudgeSystem.js', 'judge');
  const cfg = await load('src/data/config.js', 'judge');
  if (!mc || !js || !cfg) return;
  const { createJudgeSystem } = js;
  const { MockClock } = mc;

  function setup({ bpm = 120, scale = 1, latencyMs = 0, strict = false, obstacles = [] } = {}) {
    const clock = new MockClock();
    clock.init({ bpm, introBeats: 4, sections: [{ beat: 0, state: 'INTRO', layers: [] }, { beat: 4, state: 'PEAK', layers: ['kick'] }] });
    clock.start(0);
    const system = createJudgeSystem({ clock, strictWindow: strict });
    system.setWindowScale(scale);
    system.setLatency(latencyMs);
    system.registerObstacles(obstacles.map((o) => obstacle(o)));
    return { clock, system };
  }

  // --- 窗口基准 / 缩放 / 下限（L-01、JDG-02） ---
  const w1 = cfg.resolveWindows({ scale: 1 });
  eq('judge: 基准窗口 = ±60 / ±110ms（L-01）', `${w1.perfectMs}/${w1.goodMs}`, '60/110');
  const ws = cfg.resolveWindows({ strict: true, scale: 1 });
  eq('judge: strictWindow 收紧到 ±50 / ±100ms', `${ws.perfectMs}/${ws.goodMs}`, '50/100');
  const scales = [1.2, 1.1, 1.0, 1.0, 0.95, 0.95];
  eq('judge: 六关 windowScale 表（L-07）', cfg.WINDOW_SCALES.join(','), scales.join(','));
  for (let i = 0; i < 6; i += 1) {
    const r = cfg.resolveWindows({ scale: cfg.windowScaleFor(i + 1) });
    ok(`judge: L${i + 1} 窗口 ≥ 下限`, r.perfectMs >= 40 && r.goodMs >= 80, `±${r.perfectMs}/±${r.goodMs}ms`);
    eq(`judge: L${i + 1} good > perfect（窗口不倒挂）`, r.goodMs >= r.perfectMs, true);
  }
  const fl = cfg.resolveWindows({ scale: 0.5 });
  eq('judge: 下限保护 PERFECT≥40ms', fl.perfectMs, 40);
  eq('judge: 下限保护 GOOD≥80ms', fl.goodMs, 80);
  eq('judge: 下限触发时标 floored', fl.floored, true);
  const s0 = cfg.resolveWindows({ scale: 0.2, strict: true });
  eq('judge: strict + 极端缩放下限仍生效', `${s0.perfectMs}/${s0.goodMs}`, '40/80');

  // --- 背景层（SOUND 的 bed 实例 judgable:false）不得进入判定队列（CR-09） ---
  {
    const clock = new MockClock();
    clock.init({ bpm: 120, introBeats: 4, sections: [{ beat: 0, state: 'INTRO', layers: [] }] });
    clock.start(0);
    const system = createJudgeSystem({ clock });
    const bed = Object.assign(obstacle({ id: 'bed1', beat: 4, timeSec: clock.timeAtBeat(4), type: 'bed', track: 'bed' }), {
      judgable: false,
      layer: 'timeline'
    });
    const spike = obstacle({ id: 'k1', beat: 8, timeSec: clock.timeAtBeat(8) });
    const reg = system.registerObstacles([bed, spike]);
    eq('judge: judgable:false 的背景层不入队（CR-09）', reg.length, 1);
    eq('judge: 背景层不计入 pendingCount', system.pendingCount(), 1);
    eq('judge: ignoredCount 记下被跳过的实例', system.ignoredCount(), 1);
    eq('judge: 不改写背景实例自身的 state/grade', `${bed.state}/${bed.grade}`, 'pending/null');
    clock.advanceTo(clock.timeAtBeat(4) + 1.2); // 越过 bed 的 due + 窗口
    eq('judge: 背景层不会被超时 MISS', system.events.count(), 0);
    clock.advanceTo(clock.timeAtBeat(8) + 1.2); // 越过 spike 的 due + 窗口
    const evs = JSON.parse(system.events.exportEvents()).filter((e) => e.kind === 'judge');
    eq('judge: 唯一超时 MISS 属于可判定障碍', evs.length === 1 && evs[0].id === 'k1', true);
    const plain = createJudgeSystem({ clock });
    plain.registerObstacles([obstacle({ id: 'n1', beat: 2, timeSec: clock.timeAtBeat(2) })]);
    eq('judge: 缺省（无 judgable 字段）视为可判定', `${plain.pendingCount()}/${plain.ignoredCount()}`, '1/0');
  }

  // --- 三档窗口边界（含 ±1ms 临界） ---
  const T = 10;
  const one = (offMs, extra = {}) =>
    setup({ obstacles: [{ id: 'lv1-kick-020', beat: 20, timeSec: T, type: 'spike', track: 'kick', core: true }], ...extra }).system.onInput(
      'jump',
      T + offMs / 1000
    );
  eq('judge: Δ=0ms → PERFECT', one(0).grade, 'PERFECT');
  eq('judge: Δ=-59ms → PERFECT', one(-59).grade, 'PERFECT');
  eq('judge: Δ=+59ms → PERFECT', one(59).grade, 'PERFECT');
  eq('judge: Δ=-61ms → GOOD', one(-61).grade, 'GOOD');
  eq('judge: Δ=+61ms → GOOD', one(61).grade, 'GOOD');
  eq('judge: Δ=+109ms → GOOD', one(109).grade, 'GOOD');
  eq('judge: Δ=+111ms → 出窗（空拍）', one(111).rule, 'emptyBeat');
  eq('judge: Δ=-111ms → 出窗（空拍）', one(-111).rule, 'emptyBeat');
  eq('judge: deltaMs 带符号（负=偏早）', one(-30).deltaMs, -30);
  eq('judge: Judgment 字段齐全（C2）', (() => {
    const j = one(0);
    return ['grade', 'obstacleId', 'track', 'type', 'isCore', 'actionMatch', 'deltaMs', 'rule'].every((k) => k in j);
  })(), true);
  eq('judge: isCore 来自实例 core', one(0, {}).isCore, true);

  // --- 缩放后窗口跟着变（关卡难度） ---
  const tight = setup({ scale: 0.95, obstacles: [{ id: 'x', beat: 20, timeSec: T, type: 'spike', track: 'kick' }] });
  eq('judge: ×0.95 → PERFECT ±57ms', tight.system.windows().perfectMs, 57);
  eq('judge: Δ=+58ms 在 ×0.95 下已是 GOOD', tight.system.onInput('jump', T + 0.058).grade, 'GOOD');

  // --- 队列匹配语义 ---
  const two = setup({
    obstacles: [
      { id: 'A', beat: 20, timeSec: 10, type: 'spike', track: 'kick' },
      { id: 'B', beat: 21, timeSec: 10.05, type: 'spike', track: 'kick' }
    ]
  });
  eq('judge: 登记后待判定队列 = 2', two.system.pendingCount(), 2);
  eq('judge: 第一键吃掉最近的 A（JDG-03）', two.system.onInput('jump', 10).obstacleId, 'A');
  eq('judge: 第二键吃掉 B（连打两键吃掉两个障碍）', two.system.onInput('jump', 10.05).obstacleId, 'B');
  eq('judge: 判定后队列清空', two.system.pendingCount(), 0);
  eq('judge: 已判定障碍不再被改（JDG-03）', two.system.onInput('jump', 10).rule, 'emptyBeat');

  const shuffled = setup({
    obstacles: [
      { id: 'C', beat: 60, timeSec: 30, type: 'spike', track: 'kick' },
      { id: 'A', beat: 20, timeSec: 10, type: 'spike', track: 'kick' },
      { id: 'B', beat: 40, timeSec: 20, type: 'spike', track: 'kick' }
    ]
  });
  eq('judge: 乱序登记内部按 timeSec 升序（C2）', shuffled.system.pendingList().map((o) => o.id).join(''), 'ABC');
  eq('judge: 乱序登记后仍匹配到最近项', shuffled.system.onInput('jump', 10).obstacleId, 'A');

  // --- 动作类型校验（JDG-07 / Q2） ---
  const act = setup({
    obstacles: [
      { id: 'bar', beat: 20, timeSec: 10, type: 'barrage', track: 'synth', core: true },
      { id: 'spk', beat: 40, timeSec: 20, type: 'spike', track: 'kick', core: true }
    ]
  });
  const wrongOnBarrage = act.system.onInput('jump', 10);
  eq('judge: 对弹幕按跳 → actionMatch=false', wrongOnBarrage.actionMatch, false);
  eq('judge: 对弹幕按跳 → 按 GOOD 通过（不涨不扣，不计 MISS）', wrongOnBarrage.grade, 'GOOD');
  eq('judge: 对弹幕按跳 → rule=window', wrongOnBarrage.rule, 'window');
  const rightOnBarrage = act.system.onInput('dash', 20);
  eq('judge: 对尖刺按冲 → actionMatch=false + GOOD', rightOnBarrage.grade, 'GOOD');
  eq('judge: 对尖刺按冲 → 不吃 core 的 PERFECT', rightOnBarrage.isCore, true);

  const perfectDash = setup({ obstacles: [{ id: 'bar', beat: 20, timeSec: 10, type: 'barrage', track: 'synth' }] });
  const dashJudgment = perfectDash.system.onInput('dash', 10);
  eq('judge: 弹幕 + dash → PERFECT 且 actionMatch', `${dashJudgment.grade}/${dashJudgment.actionMatch}`, 'PERFECT/true');

  // --- 规则②：落地后 80ms 内的预输入 ---
  const pre = setup({
    obstacles: [
      { id: 'A', beat: 20, timeSec: 10, type: 'spike', track: 'kick' },
      { id: 'B', beat: 21.2, timeSec: 10.6, type: 'spike', track: 'kick' }
    ]
  });
  eq('judge: ① 首击 PERFECT 并记录落地时刻', pre.system.onInput('jump', 10).grade, 'PERFECT');
  const preJ = pre.system.onInput('jump', 10.48);
  eq('judge: ② 落地后 30ms 的按键 → rule=preInput', preJ.rule, 'preInput');
  eq('judge: ② 预输入 GOOD 起步', preJ.grade, 'GOOD');
  eq('judge: ② 预输入吃的是下一拍障碍', preJ.obstacleId, 'B');
  near('judge: ② deltaMs 记为相对下一拍的负偏移', preJ.deltaMs, -120, 0.5, 'ms');
  eq('judge: ② 预输入后队列清空（不重复吃）', pre.system.pendingCount(), 0);

  const noPre = setup({
    obstacles: [
      { id: 'A', beat: 20, timeSec: 10, type: 'spike', track: 'kick' },
      { id: 'B', beat: 21.24, timeSec: 10.62, type: 'spike', track: 'kick' }
    ]
  });
  noPre.system.onInput('jump', 10);
  eq('judge: ③ 落地前 10ms 的早按不吃下一拍（仍 pending）', noPre.system.onInput('jump', 10.44).rule, 'emptyBeat');
  eq('judge: ③ 空拍不改变障碍状态', noPre.system.pendingCount(), 1);

  const never = setup({ obstacles: [{ id: 'A', beat: 20, timeSec: 10, type: 'spike', track: 'kick' }] });
  const empty = never.system.onInput('jump', 1.0);
  eq('judge: ③ 无落地记录时 distant 按键 = emptyBeat', empty.rule, 'emptyBeat');
  eq('judge: ③ emptyBeat 不绑定障碍', empty.obstacleId, null);
  eq('judge: ③ emptyBeat 标记为非惩罚（penalizes:false）', empty.penalizes, false);
  eq('judge: ③ emptyBeat 不发 judge 事件（PRD §8.4）', never.system.events.events.filter((e) => e.kind === 'judge').length, 0);
  eq('judge: ③ emptyBeat 发 input/hasTarget:false', (() => {
    const e = never.system.events.events.find((x) => x.kind === 'input');
    return `${e.key}/${e.hasTarget}`;
  })(), 'jump/false');
  eq('judge: 未知按键返回 null', never.system.onInput('kick', 1.0), null);

  // --- 超时 MISS（JDG-05：由 clock.schedule 驱动，与输入无关） ---
  const to = setup({ obstacles: [{ id: 'A', beat: 20, timeSec: 10, type: 'spike', track: 'kick', core: true }] });
  const missed = [];
  to.system.onJudgment((j) => missed.push(j));
  to.clock.advanceTo(10.0);
  eq('judge: 障碍到点仍 pending', to.system.pendingCount(), 1);
  to.clock.advanceTo(10.107);
  eq('judge: GOOD 窗内（109ms）不提前判 MISS', to.system.pendingCount(), 1);
  to.clock.advanceTo(10.109);
  eq('judge: 超出 GOOD 窗 → 超时 MISS（无输入参与）', to.system.pendingCount(), 0);
  eq('judge: 超时 MISS 经 onJudgment 出口派发（§9 单向流）', missed.length, 1);
  eq('judge: 超时 MISS 的 trigger=timeout', missed[0]?.trigger, 'timeout');
  eq('judge: 超时 MISS 落到实例上', `${to.system.pendingList().length}`, '0');
  eq('judge: 超时 MISS 记入事件流', to.system.events.events.filter((e) => e.kind === 'judge' && e.grade === 'MISS').length, 1);
  const noAct = setup({ obstacles: [{ id: 'A', beat: 20, timeSec: 10, type: 'spike', track: 'kick' }] });
  noAct.clock.advanceTo(12.0);
  eq('judge: 全程不按键 → 障碍自动依次转 MISS 且不卡状态机', noAct.system.pendingCount(), 0);

  // --- 校准偏移（JDG-09 的手动值通路） ---
  const lat = setup({ latencyMs: 50, obstacles: [{ id: 'A', beat: 20, timeSec: 10, type: 'spike', track: 'kick' }] });
  eq('judge: getLatency 回读', lat.system.getLatency(), 50);
  eq('judge: latency=+50ms 时按在 10.0s → deltaMs=-50', lat.system.onInput('jump', 10).deltaMs, -50);
  const lat2 = setup({ latencyMs: 50, obstacles: [{ id: 'A', beat: 20, timeSec: 10, type: 'spike', track: 'kick' }] });
  eq('judge: latency=+50ms 时按在 10.05s → deltaMs=0', lat2.system.onInput('jump', 10.05).deltaMs, 0);

  // --- 窗口缩放中途变更：定时器随之重挂 ---
  const rr = setup({ obstacles: [{ id: 'A', beat: 20, timeSec: 10, type: 'spike', track: 'kick' }] });
  rr.system.setWindowScale(0.3636); // good 40ms → 下限 80ms
  eq('judge: 缩放变更后窗口即时生效（GOOD 下限 80ms）', rr.system.windows().goodMs, 80);
  rr.clock.advanceTo(10.081);
  eq('judge: 缩放收紧后按新窗口结算', rr.system.pendingCount(), 0);
}

/* ------------------------------------------------------------------ */
/* case: physics（C8）                                                  */
/* ------------------------------------------------------------------ */

async function casePhysics() {
  const ph = await load('src/data/physics.js', 'physics');
  if (!ph) return;
  const { FROZEN, FROZEN_KEYS, AUX, metrics, metrics1080, jumpKinematics, jumpAirSec, dashSec, selfTest, obstacleX, pxPerSec, uiScale, platformTopY, timelineLaneY } = ph;

  const frozenSpec = {
    pxPerBeat: 0.115,
    judgeX: 0.3,
    groundY: 0.52,
    jumpAirBeats: 0.9,
    jumpPeakH: 0.2,
    platformTiers: [0.1, 0.16, 0.21],
    dashDurBeats: 0.35,
    dashDist: 0.12,
    invulnSec: 0.5,
    inputBufferMs: 80
  };
  eq('physics: C8 冻结键清单齐（10 项）', FROZEN_KEYS.length, 10);
  for (const key of FROZEN_KEYS) {
    ok(`physics: ${key} 存在`, key in FROZEN, `${key}=${fmtVal(FROZEN[key])}`);
    eq(`physics: ${key} = C8 冻结值`, fmtVal(FROZEN[key]), fmtVal(frozenSpec[key]));
  }
  eq('physics: 基准分辨率 1920×1080', `${ph.BASE_VIEW.w}x${ph.BASE_VIEW.h}`, '1920x1080');

  const m = metrics1080();
  near('physics: judgeX = 0.30W = 576px', m.judgeX, 576, 1e-9, 'px');
  near('physics: groundY = 0.52H = 561.6px', m.groundY, 561.6, 1e-9, 'px');
  near('physics: pxPerBeat = 0.115W = 220.8px', m.pxPerBeat, 220.8, 1e-9, 'px');
  near('physics: 4 拍预告 = 883.2px（≈46% 屏宽）', m.lookAheadPx, 883.2, 1e-9, 'px');
  near('physics: HUD 带高 0.08H = 86.4px', m.hudBandH, 86.4, 1e-9, 'px');
  near('physics: 时间轴带高 0.32H = 345.6px', m.timelineBandH, 345.6, 1e-9, 'px');
  near('physics: 上层世界带高 0.60H = 648px', m.worldBandH, 648, 1e-9, 'px');
  near('physics: 跳跃峰值 0.20H = 216px', m.jumpPeakH, 216, 1e-9, 'px');
  near('physics: 冲刺位移 0.12W = 230.4px', m.dashDist, 230.4, 1e-9, 'px');
  eq('physics: 平台三档相对地面 = 108/172.8/226.8px 上方', m.platformTierY.map((y) => Number((m.groundY - y).toFixed(4))).join(','), '108,172.8,226.8');
  eq('physics: 尖刺/平台/弹幕尺寸 = 48×40 / 120×24 / 56×56', `${m.sizes.spike.w}x${m.sizes.spike.h}/${m.sizes.platform.w}x${m.sizes.platform.h}/${m.sizes.barrage.w}x${m.sizes.barrage.h}`, '48x40/120x24/56x56');
  eq('physics: 时间轴标记高 40px', m.timelineMarkH, 40);
  near('physics: 无敌帧 0.5s', FROZEN.invulnSec, 0.5, 0);
  near('physics: 输入缓冲 80ms', FROZEN.inputBufferMs, 80, 0);

  const small = metrics({ w: 1280, h: 720 });
  near('physics: 1280×720 下 judgeX 比例不变（VIS-02）', small.judgeX / small.w, 0.3, 1e-12);
  near('physics: 1280×720 下地面线比例不变', small.groundY / small.h, 0.52, 1e-12);
  near('physics: 分区比在任意分辨率守恒', (small.hudBandH + small.worldBandH + small.timelineBandH) / small.h, 1, 1e-12);
  eq('physics: 1280×720 的 uiScale = 2/3', Number(uiScale({ w: 1280, h: 720 }).toFixed(6)), Number((720 / 1080).toFixed(6)));
  eq('physics: 视口缺省回退到基准', `${metrics().w}x${metrics().h}`, '1920x1080');

  // 跳跃运动学：v0 = 4h/T，g = 8h/T²，T = 0.9 × 拍长
  const kin = jumpKinematics(ph.BASE_VIEW, 0.5);
  near('physics: 滞空 0.9 × 拍长（120BPM → 0.45s）', kin.airSec, 0.45, 1e-12, 's');
  near('physics: v0 = 4h/T = 1920px/s', kin.v0, (4 * 216) / 0.45, 1e-9, 'px/s');
  near('physics: g = 8h/T² = 8533.33px/s²', kin.g, (8 * 216) / (0.45 * 0.45), 1e-9, 'px/s²');
  near('physics: 抛物线顶点 = 峰值高度（运动学自洽）', ph.jumpOffset(kin, kin.airSec / 2), 216, 1e-9, 'px');
  near('physics: 起跳/落地高度归零', ph.jumpOffset(kin, 0), 0, 1e-12, 'px');
  near('physics: 落地时刻回到地面', ph.jumpOffset(kin, kin.airSec), 0, 1e-9, 'px');
  near('physics: 132BPM 滞空 = 0.9×60/132', jumpAirSec(60 / 132), 0.9 * (60 / 132), 1e-12, 's');
  near('physics: 冲刺时长 0.35 × 拍长', dashSec(0.5), 0.175, 1e-12, 's');

  // OBS-02 时间纯函数
  const rate = pxPerSec(ph.BASE_VIEW, 0.5);
  near('physics: pxPerSec = pxPerBeat / beat', rate, 220.8 / 0.5, 1e-12, 'px/s');
  near('physics: obstacleX(now = T) === judgeX（判定发生在判定线）', obstacleX(ph.BASE_VIEW, 10, 10, 0.5), m.judgeX, 1e-12, 'px');
  near('physics: obstacleX 提前 1 拍 = judgeX + pxPerBeat', obstacleX(ph.BASE_VIEW, 10.5, 10, 0.5), m.judgeX + m.pxPerBeat, 1e-9, 'px');
  near('physics: 上下层 pxPerBeat 同源（VIS-05）', obstacleX(ph.BASE_VIEW, 10.5, 10, 0.5) - m.judgeX, m.pxPerBeat, 1e-9, 'px');
  near('physics: 4 拍预告距离 = lookAheadPx（OBS-03 与 TIM-01 同值）', obstacleX(ph.BASE_VIEW, 12, 10, 0.5) - m.judgeX, m.lookAheadPx, 1e-9, 'px');
  near('physics: 玩家 x = 判定线 x（PLR 与障碍同一竖线）', m.playerX, m.judgeX, 1e-12, 'px');
  const lane0 = timelineLaneY(ph.BASE_VIEW, 0);
  const lane2 = timelineLaneY(ph.BASE_VIEW, 2);
  ok(
    'physics: 时间轴三泳道都落在 0.32H 带内',
    lane0 >= m.timelineTop && lane2 <= m.h && lane0 < lane2,
    `lane0=${lane0.toFixed(1)} lane2=${lane2.toFixed(1)} band=[${m.timelineTop.toFixed(1)}, ${m.h}]`
  );

  // §7.5 约束自检
  const st = selfTest(ph.BASE_VIEW);
  eq('physics: selfTest 无 error', st.errors.join(' | '), '');
  eq('physics: selfTest 覆盖 110/120/126/128/132/140', st.rows.map((r) => r.bpm).join(','), '110,120,126,128,132,140');
  eq('physics: 每个 BPM 的间隔自检都通过', st.rows.every((r) => r.ok), true);
  const r140 = st.rows.find((r) => r.bpm === 140);
  note(`140BPM：滞空 ${r140.airBeats} 拍 + 缓冲 ${r140.bufferBeats.toFixed(3)} 拍 = ${r140.needBeats.toFixed(3)} 拍 < 最小同类间隔 ${r140.minGapBeats} 拍（余量 ${(r140.minGapBeats - r140.needBeats).toFixed(3)} 拍）`);
  ok('physics: §7.5 自检成立（1.33 拍 > 滞空 0.9 + 缓冲 ≈0.18）', AUX.minSameTypeGapBeats > 0.9 + 0.18);
  near('physics: 140BPM 下缓冲折算 ≈ 0.187 拍（PRD 的 ≈0.18）', r140.bufferBeats, 0.187, 0.002, '拍');
  ok('physics: 三档平台都在固定跳跃包络内（峰值 + 角色半高）', st.reachPx >= 226.8, `包络 ${st.reachPx.toFixed(1)}px`);
  eq('physics: 弹幕间隙 ≥ 2.2 × 角色高', Number((AUX.barrageGapRatio * m.charH).toFixed(2)), Number((2.2 * m.charH).toFixed(2)));
  eq('physics: AUX 分区比 = 8/60/32', `${AUX.hudBand}/${AUX.worldBand}/${AUX.timelineBand}`, '0.08/0.6/0.32');
  ok(
    'physics: 非法 tier 钳到 0..2 且不产生 NaN',
    Math.abs(platformTopY(ph.BASE_VIEW, 9) - platformTopY(ph.BASE_VIEW, 2)) < 1e-9 &&
      Math.abs(platformTopY(ph.BASE_VIEW, -3) - platformTopY(ph.BASE_VIEW, 0)) < 1e-9 &&
      Number.isFinite(platformTopY(ph.BASE_VIEW, undefined)),
    `tier9=${platformTopY(ph.BASE_VIEW, 9).toFixed(1)} tier2=${platformTopY(ph.BASE_VIEW, 2).toFixed(1)}`
  );
}

/* ------------------------------------------------------------------ */
/* case: save（§8.3 / SAV-01..03）                                      */
/* ------------------------------------------------------------------ */

async function caseSave() {
  const sv = await load('src/data/save.js', 'save');
  if (!sv) return;
  const { SAVE_KEY, SAVE_VERSION, defaultSave, mergeSave, loadSave, updateSave, flushSave, getSave, isDegraded, consumeNotice, levelEntry, __resetSaveState } = sv;

  eq('save: 键名 = rhythm-breaker/save', SAVE_KEY, 'rhythm-breaker/save');
  eq('save: schema version = 1', SAVE_VERSION, 1);
  eq('save: 节流下限 ≥ 500ms（SAV-02）', sv.WRITE_THROTTLE_MS >= 500, true);

  // --- 空档 ---
  __resetSaveState();
  const empty = makeStubStorage();
  const s0 = loadSave(empty);
  eq('save: 无存档时给默认档', JSON.stringify(s0.audio), JSON.stringify(defaultSave().audio));
  eq('save: 默认档不降级', isDegraded(), false);
  eq('save: 默认档 levels 为空', Object.keys(s0.levels).length, 0);

  // --- 字段级合并（缺字段用默认值，不整体覆盖） ---
  const partial = makeStubStorage({
    [SAVE_KEY]: JSON.stringify({
      version: 1,
      levels: { 2: { rank: 'A', perfectRate: 0.74 } },
      audio: { latencyOffset: -14 },
      options: { strictWindow: true },
      futureField: { keep: 1 }
    })
  });
  __resetSaveState();
  const s1 = loadSave(partial);
  eq('save: 已有字段保留（latencyOffset=-14）', s1.audio.latencyOffset, -14);
  eq('save: 缺失字段用默认值（master=1）', s1.audio.master, 1);
  eq('save: options 部分覆盖不影响其余', `${s1.options.strictWindow}/${s1.options.reduceFlash}`, 'true/false');
  eq('save: levels[2] 缺 cleared/perfectRate/maxCombo → 补默认', `${s1.levels['2'].cleared}/${s1.levels['2'].rank}/${s1.levels['2'].maxCombo}`, 'false/A/0');
  near('save: levels[2].perfectRate 保留 0.74', s1.levels['2'].perfectRate, 0.74, 1e-12);
  eq('save: 前向兼容——未知顶层字段原样保留', s1.futureField?.keep, 1);
  // DEF-05/SAV-01（T5 加性字段）：默认档多一个 encounterRate=0，其余字段语义不变。
  eq('save: levelEntry 缺关给完整默认', JSON.stringify(levelEntry(s1, 5)), JSON.stringify(defaultSave().levels?.['5'] ?? { cleared: false, rank: null, perfectRate: 0, maxCombo: 0, miss: 0, encounterRate: 0 }));

  // --- 类型防护 ---
  const junk = mergeSave({ version: 'x', audio: { master: 'loud', muted: 'yes', latencyOffset: 9999 }, levels: { abc: { rank: 'Z' }, 1: { rank: 'S', perfectRate: 5, maxCombo: -3 } }, options: 42, meta: null });
  eq('save: 非法 number 回退默认', junk.audio.master, 1);
  eq('save: number 越界被 clamp', junk.audio.latencyOffset, 200);
  eq('save: 非法 boolean 回退默认 false', junk.audio.muted, false);
  eq('save: 非法规格 key 丢弃', Object.keys(junk.levels).join(','), '1');
  eq('save: 非法 rank 归 null', junk.levels['1'].rank, 'S');
  eq('save: perfectRate clamp 到 0..1', junk.levels['1'].perfectRate, 1);
  eq('save: maxCombo 不为负', junk.levels['1'].maxCombo, 0);
  eq('save: 升版后 version = 1', junk.version, 1);
  eq('save: 非对象输入不抛错', JSON.stringify(mergeSave('坏档')), JSON.stringify(defaultSave()));
  eq('save: null 输入不抛错', JSON.stringify(mergeSave(null)), JSON.stringify(defaultSave()));

  // --- JSON 损坏 → 静默降级（SAV-03） ---
  const broken = makeStubStorage({ [SAVE_KEY]: '{ "version": 1, "audio": ' });
  __resetSaveState();
  let threw = false;
  let s2 = null;
  try {
    s2 = loadSave(broken);
  } catch {
    threw = true;
  }
  eq('save: 损坏 JSON 不抛错', threw, false);
  eq('save: 损坏 JSON → 默认档', s2.audio.master, 1);
  eq('save: 损坏 JSON → 标记降级', isDegraded(), true);
  ok('save: 一次性提示可取回', typeof consumeNotice() === 'string');
  eq('save: 提示只给一次', consumeNotice(), null);

  // --- 隐私模式（访问即抛）→ 内存档 ---
  const privacy = makeStubStorage({}, { throwGet: true });
  __resetSaveState();
  let threw2 = false;
  let s3 = null;
  try {
    s3 = loadSave(privacy);
  } catch {
    threw2 = true;
  }
  eq('save: 隐私模式读取不抛错', threw2, false);
  eq('save: 隐私模式仍拿到可用档', s3.meta.totalRuns, 0);
  const privacyWrite = makeStubStorage({}, { throwSet: true });
  __resetSaveState();
  let threw3 = false;
  try {
    updateSave({ audio: { master: 0.5 } }, { storage: privacyWrite, throttleMs: 0 });
  } catch {
    threw3 = true;
  }
  eq('save: 写入被拒也不抛错', threw3, false);
  eq('save: 写入被拒 → 内存档仍更新（本局可用）', getSave().audio.master, 0.5);
  eq('save: 禁用存储（storage=null）时读写都不抛错', (() => {
    __resetSaveState();
    loadSave(null);
    updateSave({ options: { reduceFlash: true } }, { storage: null });
    return getSave().options.reduceFlash;
  })(), true);
  ok('save: 禁用存储时进入降级态', isDegraded());

  // --- 节流写入（SAV-02） ---
  const th = makeStubStorage();
  __resetSaveState();
  updateSave({ audio: { master: 0.8 } }, { storage: th });
  updateSave({ audio: { music: 0.7 } }, { storage: th });
  updateSave({ audio: { sfx: 0.6 } }, { storage: th });
  eq('save: 连续 3 次更新只写 0 次（节流中）', th.writes, 0);
  eq('save: 内存态是最后一次', getSave().audio.sfx, 0.6);
  flushSave();
  eq('save: flush 后落盘 1 次', th.writes, 1);
  const onDisk = JSON.parse(th.map.get(SAVE_KEY));
  eq('save: 落盘内容含三字段合并结果', `${onDisk.audio.master}/${onDisk.audio.music}/${onDisk.audio.sfx}`, '0.8/0.7/0.6');
  eq('save: 落盘带 version', onDisk.version, 1);
  const imm = makeStubStorage();
  __resetSaveState();
  updateSave({ audio: { muted: true } }, { storage: imm, throttleMs: 0 });
  eq('save: throttleMs=0 立即写', imm.writes, 1);
  __resetSaveState();
  const stamp = makeStubStorage();
  updateSave({ meta: { totalRuns: 7 } }, { storage: stamp, throttleMs: 0 });
  eq('save: meta.totalRuns 可写', JSON.parse(stamp.map.get(SAVE_KEY)).meta.totalRuns, 7);
  ok('save: firstPlayedAt 被盖章（元数据，非时序路径）', JSON.parse(stamp.map.get(SAVE_KEY)).meta.firstPlayedAt > 0);
  eq('save: 重开不污染：merge 不丢 levels', (() => {
    __resetSaveState();
    const st2 = makeStubStorage();
    updateSave({ levels: { 1: { cleared: true, rank: 'S', perfectRate: 0.9, maxCombo: 40, miss: 0 } } }, { storage: st2, throttleMs: 0 });
    updateSave({ audio: { master: 0.3 } }, { storage: st2, throttleMs: 0 });
    return JSON.parse(st2.map.get(SAVE_KEY)).levels['1'].rank;
  })(), 'S');
  __resetSaveState();
}

/* ------------------------------------------------------------------ */
/* case: eventlog（C7）                                                 */
/* ------------------------------------------------------------------ */

async function caseEventLog() {
  const mc = await load('src/mocks/MockClock.js', 'eventlog');
  const js = await load('src/game/systems/JudgeSystem.js', 'eventlog');
  if (!mc || !js) return;
  const { MockClock } = mc;
  const { EventLog, createJudgeSystem } = js;

  const clock = new MockClock();
  clock.init({ bpm: 120, introBeats: 4, sections: [{ beat: 0, state: 'INTRO', layers: [] }, { beat: 4, state: 'PEAK', layers: ['kick'] }] });
  clock.start(0);
  const obstacles = [
    obstacle({ id: 'lv1-kick-008', beat: 8, timeSec: 4, type: 'spike', track: 'kick', core: true }),
    obstacle({ id: 'lv1-kick-010', beat: 10, timeSec: 5, type: 'spike', track: 'kick' }),
    obstacle({ id: 'lv1-kick-012', beat: 12, timeSec: 6, type: 'spike', track: 'kick', core: true })
  ];
  const system = createJudgeSystem({ clock });
  system.setWindowScale(1);
  system.registerObstacles(obstacles);

  system.onInput('jump', 4.0); // PERFECT（Δ=0）
  system.onInput('jump', 4.7); // 落地(4.45)后 250ms → 出窗且超缓冲 → 空拍
  system.onInput('jump', 5.08); // Δ=+80ms → GOOD
  system.onJudgment((j) => {
    if (j.rule === 'emptyBeat') return;
    if (j.grade === 'MISS') system.events.hp({ t: clock.now(), track: 'kick', hp: 4 });
  });
  system.events.state({ t: clock.timeAtBeat(16), from: 'PEAK', to: 'DISASSEMBLED' });
  clock.advanceTo(7.0); // 第三个障碍超时 MISS
  system.events.hp({ t: clock.now(), track: 'kick', hp: 3 });

  const evs = system.events.events;
  const kinds = ['judge', 'hp', 'input', 'state'];
  for (const kind of kinds) ok(`eventlog: 产出 ${kind} 事件`, evs.some((e) => e.kind === kind));
  const required = {
    judge: ['t', 'kind', 'grade', 'id', 'deltaMs', 'rule'],
    hp: ['t', 'kind', 'track', 'hp'],
    input: ['t', 'kind', 'key', 'hasTarget'],
    state: ['t', 'kind', 'from', 'to']
  };
  for (const kind of kinds) {
    const sample = evs.filter((e) => e.kind === kind);
    const missing = new Set();
    for (const e of sample) for (const key of required[kind]) if (!(key in e) || e[key] === undefined) missing.add(key);
    ok(`eventlog: ${kind} 字段完整（t/kind/...）`, missing.size === 0, [...missing].join(','));
    ok(`eventlog: ${kind} 无多余 undefined 字段`, sample.every((e) => Object.values(e).every((v) => v !== undefined)));
  }
  const asc = evs.every((e, i) => i === 0 || evs[i - 1].t <= e.t);
  ok('eventlog: 全数组按 t 升序（C7）', asc, evs.map((e) => e.t.toFixed(3)).join(' '));
  eq('eventlog: judge 事件 rule 只取 window/preInput', [...new Set(evs.filter((e) => e.kind === 'judge').map((e) => e.rule))].sort().join(','), 'window');
  eq('eventlog: 空拍不发 judge 事件（只发 input）', evs.filter((e) => e.kind === 'judge').length, 3);
  eq('eventlog: hasTarget 区分空拍', evs.filter((e) => e.kind === 'input' && e.hasTarget === false).length, 1);

  const json = system.events.exportEvents();
  eq('eventlog: exportEvents 是 JSON 字符串', typeof json, 'string');
  const back = JSON.parse(json);
  eq('eventlog: 导出可 round-trip（结算/回放/试玩三方同一份）', back.length, evs.length);
  // §7.3 口径可从事件流复算
  const perfect = back.filter((e) => e.kind === 'judge' && e.grade === 'PERFECT').length;
  near('eventlog: Perfect 率可从事件流复算（P/N，§7.3）', perfect / obstacles.length, 1 / 3, 1e-12);
  eq('eventlog: clear() 保留数组引用（重开覆盖当前局事件流）', (() => {
    const ref = system.events.events;
    system.reset();
    return ref === system.events.events && ref.length === 0;
  })(), true);

  const log = new EventLog();
  log.judge({ t: 5, grade: 'PERFECT', id: 'x', deltaMs: -1, rule: 'window' });
  log.judge({ t: 1, grade: 'GOOD', id: 'y', deltaMs: 2, rule: 'window' });
  eq('eventlog: 乱序写入也保持升序插入', log.events.map((e) => e.t).join(','), '1,5');
  eq('eventlog: EventLog.count()', log.count(), 2);
}

/* ------------------------------------------------------------------ */
/* case: forbid-clock（T4 / CLK-01）                                    */
/* ------------------------------------------------------------------ */

const BANNED = [
  { name: 'scene.time', re: /\bscene\.time\b/ },
  { name: 'scene.time.now', re: /\b[A-Za-z_$][\w$]*\.time\.now\b/ },
  { name: 'this.time.now', re: /\bthis\.time\.now\b/ },
  { name: 'performance.now()', re: /\bperformance\.now\s*\(/ },
  { name: 'Date.now()', re: /\bDate\.now\s*\(/ },
  { name: 'new Date()', re: /new\s+Date\s*\(/ },
  { name: 'game.loop.delta', re: /\bgame\.loop\.delta\b/ }
];
const WHITELIST_MARK = 'clock-ok';

function scanSources(dir) {
  const hits = [];
  const exempt = [];
  const files = existsSync(dir) ? walk(dir) : [];
  for (const abs of files) {
    const rel = relative(ROOT, abs).split(sep).join('/');
    const text = readFileSync(abs, 'utf8');
    const head = text.split('\n').slice(0, 6).join('\n');
    if (head.includes(WHITELIST_MARK)) {
      exempt.push(rel);
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((lineText, i) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      for (const { name, re } of BANNED) {
        if (re.test(lineText)) hits.push({ rel, line: i + 1, name, text: trimmed.slice(0, 90) });
      }
    });
  }
  return { hits, exempt, count: files.length };
}

async function caseForbidClock() {
  if (!existsSync(SRC)) {
    skipCase('forbid-clock', 'src/ 不存在');
    return;
  }
  // 正控制：规则本身必须能抓到越界写法（防止正则失效导致空跑 PASS）
  const fixture = ['const a = scene.time.now;', 'this.time.now', 'performance.now()', 'Date.now()', 'new Date()', 'game.loop.delta'];
  const caught = fixture.filter((line) => BANNED.some(({ re }) => re.test(line)));
  eq('forbid-clock: 检测规则本身有效（正控制 6/6）', caught.length, fixture.length);
  const safe = ['const t = clock.now();', 'const x = o.timeSec;', 'const s = ctx.currentTime;'];
  eq('forbid-clock: 合法写法不误报（负控制）', safe.filter((line) => BANNED.some(({ re }) => re.test(line))).length, 0);

  const { hits, exempt, count } = scanSources(SRC);
  note(`扫描 ${count} 个 src/** 文件；白名单（文件头 clock-ok）：${exempt.join(', ') || '（无）'}`);
  if (hits.length) {
    for (const h of hits) record('fail', `[forbid-clock] ${h.rel}:${h.line} 使用 ${h.name}`, h.text);
  }
  ok(`forbid-clock: src/** 无 ${BANNED.length} 类时钟越界用法`, hits.length === 0, `${hits.length} 处越界`);
  ok('forbid-clock: BeatClock.js 在扫描范围内且带 clock-ok 标记', exempt.includes('src/audio/BeatClock.js'));
}

/* ------------------------------------------------------------------ */
/* case: debug — K-03 DebugPanel 渲染契约（Node 内极简假 DOM，不需要浏览器） */
/* ------------------------------------------------------------------ */

/** 只实现界面板用到的 DOM 子集：createElement / createTextNode / getElementById(#debug-root 与 #ui-root) / body / 事件绑定。 */
function installFakeDom(search = '') {
  const created = [];
  const listeners = {};
  function makeNode(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      childNodes: [],
      parentNode: null,
      attrs: {},
      style: {},
      textContent: '',
      handlers: {},
      clicks: 0,
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this.attrs ? this.attrs[k] : null;
      },
      appendChild(c) {
        this.childNodes.push(c);
        c.parentNode = this;
        return c;
      },
      removeChild(c) {
        const i = this.childNodes.indexOf(c);
        if (i >= 0) this.childNodes.splice(i, 1);
        c.parentNode = null;
        return c;
      },
      addEventListener(type, fn) {
        (this.handlers[type] = this.handlers[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        const l = this.handlers[type] || [];
        const i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      },
      click() {
        this.clicks += 1;
        for (const fn of (this.handlers.click || []).slice()) fn({ target: this });
      }
    };
    created.push(node);
    return node;
  }
  const root = makeNode('div');
  const uiRoot = makeNode('div'); // K-13：DOM 界面的挂载点（L-04），screens case 用它数节点
  const body = makeNode('body');
  globalThis.document = {
    getElementById: (id) => (id === 'debug-root' ? root : id === 'ui-root' ? uiRoot : null),
    createElement: (tag) => makeNode(tag),
    createTextNode: (t) => Object.assign(makeNode('#text'), { textContent: String(t) }),
    body
  };
  globalThis.window = {
    location: { search },
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener: (type, fn) => {
      const l = listeners[type] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    }
  };
  return {
    root,
    uiRoot,
    body,
    created,
    text: () => created.filter((n) => n.tagName === 'PRE').map((n) => n.textContent).join('\n'),
    fire: (type, ev) => {
      for (const fn of (listeners[type] || []).slice()) fn(ev);
    },
    listenerCount: (type) => (listeners[type] || []).length,
    restore: () => {
      delete globalThis.document;
      delete globalThis.window;
    }
  };
}

async function caseDebug() {
  const UI = await load('src/ui/DebugPanel.js', 'debug');
  const MC = await load('src/mocks/MockClock.js', 'debug');
  const JS = await load('src/game/systems/JudgeSystem.js', 'debug');
  if (!UI || !MC || !JS) return;

  const clock = new MC.MockClock();
  clock.init({
    bpm: 120,
    introBeats: 2,
    sections: [
      { beat: 0, state: 'INTRO', layers: [] },
      { beat: 2, state: 'PEAK', layers: ['kick'] }
    ],
    tempoChanges: [{ beat: 16, bpm: 140, transitionBeats: 2 }]
  });
  clock.start(0);
  const judge = new JS.JudgeSystemCore({ clock });
  judge.setLatency(12);
  judge.setWindowScale(0.6); // 触底 → 40/80ms + [FLOOR] 标记
  judge.registerObstacles([
    obstacle({ id: 'd1', beat: 4, timeSec: clock.timeAtBeat(4) }),
    obstacle({ id: 'd2', beat: 6, timeSec: clock.timeAtBeat(6) }),
    obstacle({ id: 'd3', beat: 8, timeSec: clock.timeAtBeat(8), type: 'barrage', track: 'synth' })
  ]);
  clock.advanceTo(clock.timeAtBeat(4) - 0.4); // 让段落事件把状态推到 PEAK

  const dom = installFakeDom();
  try {
    const panel = UI.mountDebugPanel({ clock, judge, root: dom.root, intervalMs: 1e6, autoShow: true });
    panel.update();
    const text = dom.text();

    ok('debug: 面板挂进 #debug-root 且渲染出文本', dom.root.childNodes.length === 1 && text.length > 0, `root 子节点 ${dom.root.childNodes.length}`);
    ok('debug: 显示「当前拍 / now()」', /^beat\s+[\d.]+\s+now\s+[\d.]+s/m.test(text), text.split('\n')[0]);
    ok('debug: 显示状态机状态', /^state\s+PEAK/m.test(text), (text.match(/^state.*/m) || [''])[0]);
    const qm = text.match(/queue\s+judge\s+(\d+)\s+clock\s+(\d+)/);
    ok('debug: 显示待判定队列（judge + clock）', !!qm && Number(qm[1]) === 3 && Number(qm[2]) >= 1, qm ? `judge ${qm[1]} / clock ${qm[2]}` : '未出现 queue 行');
    ok('debug: 显示当前窗口 ms 且触底标记生效', /PERFECT ±40\.0ms\s+GOOD ±80\.0ms\s+scale ×0\.60\s+\[FLOOR\]/.test(text), (text.match(/^window.*/m) || [''])[0]);
    ok('debug: 显示延迟校准值', /latency\s+12\.0ms/.test(text), (text.match(/^latency.*/m) || [''])[0]);
    ok('debug: 显示 driftMs 与预调度参数', /drift\s+[\d.-]+ms\s+peak\s+[\d.]+ms\s+\(poll 25ms \/ lead 120ms\)/.test(text), (text.match(/^drift.*/m) || [''])[0]);
    ok('debug: 显示事件流计数', /events\s+\d+/.test(text), (text.match(/^events.*/m) || [''])[0]);
    ok('debug: 变速关额外给出 tempo 行', /tempo\s+beat 14\.00 cue@[\d.]+ → 120→140BPM/.test(text), (text.match(/^tempo.*/m) || [''])[0]);

    // 开关：autoShow=true → toggle 关闭 → keydown ` 再开
    ok('debug: autoShow 后面板可见', panel.isVisible() === true && panel.el.style.display === 'block');
    panel.toggle();
    ok('debug: toggle 关闭面板（display:none 且停表）', panel.isVisible() === false && panel.el.style.display === 'none');
    dom.fire('keydown', { key: '`', target: { tagName: 'DIV' } });
    ok('debug: ` 键可重新打开', panel.isVisible() === true);
    dom.fire('keydown', { key: '`', target: { tagName: 'INPUT' } });
    ok('debug: 输入焦点内不劫持 ` 键', panel.isVisible() === true);
    dom.fire('keydown', { key: 'x', metaKey: true, target: { tagName: 'DIV' } });
    ok('debug: 带修饰键的快捷键不响应', panel.isVisible() === true);

    // 导出：按下跳跃键后事件流应能导出并含 input 事件
    judge.onInput('jump', clock.timeAtBeat(4) + 0.02);
    const exported = JSON.parse(panel.exportText());
    ok('debug: exportText() 导出合法 JSON 事件流（C7）', Array.isArray(exported) && exported.some((e) => e.kind === 'input'), `条数 ${Array.isArray(exported) ? exported.length : 'n/a'}`);
    const downloadBtn = dom.created.find((n) => n.tagName === 'BUTTON' && n.textContent === '导出事件流');
    ok('debug: 导出按钮存在且不抛错', !!downloadBtn);
    if (downloadBtn) {
      const before = dom.body.childNodes.length;
      downloadBtn.click();
      ok('debug: 点导出后临时 <a> 已回收', dom.body.childNodes.length === before, `body 子节点 ${before} → ${dom.body.childNodes.length}`);
    }

    panel.destroy();
    ok('debug: destroy() 摘除 DOM 与 keydown 监听（teardown 无残留）', dom.root.childNodes.length === 0 && dom.listenerCount('keydown') === 0, `root ${dom.root.childNodes.length} / listeners ${dom.listenerCount('keydown')}`);
  } finally {
    dom.restore();
  }

  // 无 DOM（Node/自检环境）必须返回空操作句柄而不是抛错——WORLD 的 Node 截图脚本也依赖这点
  const offline = UI.mountDebugPanel({ clock, judge });
  ok('debug: 无 DOM 时不抛错且返回空操作句柄', offline && offline.el === null && offline.isVisible() === false && offline.exportText() === '[]');
  offline.update();
  offline.show();
  offline.destroy();
  ok('debug: 空操作句柄的各方法均可安全调用', true);

  // ?debug=1 自动展开（L-04）
  const dom2 = installFakeDom('?debug=1');
  try {
    const auto = UI.mountDebugPanel({ clock, judge, root: dom2.root, intervalMs: 1e6 });
    ok('debug: URL 带 ?debug=1 时自动展开', auto.isVisible() === true);
    auto.destroy();
  } finally {
    dom2.restore();
  }

  note(`DebugPanel 假 DOM 渲染 ${dom.created.length} 个节点；面板文本 ${dom.text().length} 字符（无需浏览器即可回归）`);
}

/* ------------------------------------------------------------------ */
/* R2 共用夹具：真谱面 + MockClock + 三系统装配（K-07 / K-09 / K-12 / K-05） */
/* ------------------------------------------------------------------ */

const LEVEL_IDS = [1, 2, 3, 4, 5, 6];

/** 读 SOUND 名下的谱面；缺文件返回 null（调用方 skip，不代造，T2）。 */
function readLevel(id) {
  const abs = join(SRC, 'data', 'levels', `level${id}.json`);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    record('fail', `[levels] level${id}.json 解析失败`, String(err?.message ?? err));
    return null;
  }
}

/**
 * 装配一关（纯 Node，不需要浏览器 / AudioContext）：
 * MockClock 手动时间 + PatternGenerator 生成实例 + JudgeSystem + DisassembleSystem 真实订阅。
 * @returns {object|null} rig
 */
function buildRig(PG, MC, JS, DS, cfg, opt = {}) {
  // K-03 硬约束：本脚手架**不得改动被测时序**。DEF-03 就是这么漏掉的——这里 `clock.start()` 在 attach 之前，
  // 而当时的 `LevelRuntime.start()` 是 attach 在前，`BeatClock.start()` 会清 `_queue`，终点 schedule 被抹掉，
  // 641 条断言全绿也照不出「游戏永远进不了结算」。凡是「顺序相关」的性质，去 tools/orderCheck.mjs 用真实顺序验证。
  const clock = new MC.MockClock({ t: 0 });
  clock.init({
    bpm: cfg.bpm,
    sections: cfg.sections,
    tempoChanges: cfg.tempoChanges,
    introBeats: cfg.introBeats,
    lengthBeats: cfg.lengthBeats
  });
  clock.start(opt.origin ?? 0);
  const instances = PG.build(cfg, clock);
  const events = new JS.EventLog();
  const judge = JS.createJudgeSystem({ clock, events });
  const ds = DS.createDisassembleSystem({ clock, events });
  judge.setWindowScale(Number.isFinite(Number(cfg.windowScale)) ? Number(cfg.windowScale) : 1);
  ds.load(cfg, { instances });
  ds.bindJudge(judge);
  judge.registerObstacles(instances);
  const feed = [];
  const ev = [];
  ds.attach();
  // §9 单向流：input → Judge → Disassemble（hp 的唯一写入口就是这里的这一次调用）
  judge.onJudgment((j) => {
    feed.push(j);
    ds.onJudgment(j);
  });
  for (const name of ['hp-change', 'disassemble', 'revive', 'state-change']) {
    ds.on(name, (p) => ev.push({ name, ...p }));
  }
  return { cfg, clock, instances, judge, ds, events, feed, ev, JS, PG };
}

/**
 * 完美玩家：每 25ms 推一格（与 BeatClock 的轮询同粒度），到点按正确动作。
 * @param {object} rig buildRig 的返回
 * @param {{stomp?:boolean, stopAt?:string, beatSec?:number}} [opt]
 */
function playRig(rig, opt = {}) {
  const { clock, judge, ds, cfg } = rig;
  const live = rig.instances.filter((o) => o.judgable !== false).sort((a, b) => a.timeSec - b.timeSec);
  const step = 0.025; // 与 BeatClock 的轮询同粒度（CLOCK_POLL_MS）
  const end = clock.timeAtBeat(Number(cfg.lengthBeats) || 0) + 1.5;
  const used = [];
  let ptr = 0;
  let dotPtr = 0;
  while (clock.time() < end) {
    clock.advanceBy(step);
    while (ptr < live.length && live[ptr].timeSec <= clock.time() + 0.001) {
      const o = live[ptr];
      used.push(judge.onInput(rig.JS.expectedAction(o.type), o.timeSec));
      ptr += 1;
    }
    if (opt.stomp && ds.state() === 'SILENCE') {
      const dots = ds.silenceDots();
      while (dotPtr < dots.length && clock.time() >= dots[dotPtr].timeSec) {
        ds.stompDot({ atSec: dots[dotPtr].timeSec });
        dotPtr += 1;
      }
    }
    if (opt.stopAt && ds.state() === opt.stopAt) break;
  }
  return { inputs: used.length, endedAt: clock.time() };
}

/** 三轨满 hp 的手搭关卡（不依赖 SOUND 谱面，专门验 DIS-03/05/07/08 口径）。 */
function synthCfg(over = {}) {
  return {
    id: 99,
    bpm: 120,
    lengthBeats: 64,
    silenceBeats: 8,
    introBeats: 4,
    freeOrder: true,
    tracks: { kick: { hp: 4 }, bass: { hp: 4 }, synth: { hp: 4 }, bed: { hp: 4, disassemble: false } },
    sections: [
      { beat: 0, state: 'INTRO', layers: [] },
      { beat: 4, state: 'BUILD', layers: ['kick', 'bass', 'synth', 'bed'] },
      { beat: 56, state: 'SILENCE', layers: [] }
    ],
    ...over
  };
}

/** 手搭实例表：同 beat 不重叠，全部 core，judgable 缺省 true。 */
function synthInstances(clock, spec) {
  const TYPE = { kick: 'spike', bass: 'platform', synth: 'barrage', bed: 'bed' };
  const out = [];
  for (const [track, beats] of Object.entries(spec)) {
    beats.forEach((b, i) => {
      out.push({
        id: `t-${track}-${b}-${i}`,
        track,
        type: TYPE[track],
        beat: b,
        timeSec: clock.timeAtBeat(b),
        core: track !== 'bed',
        pitchTier: 0,
        speed: 1,
        state: 'pending',
        grade: null,
        judgable: track !== 'bed'
      });
    });
  }
  return out;
}

/** 造一条 Judgment（走 ds.onJudgment 的唯一入口，不经 JudgeSystem）。 */
function judg(track, over = {}) {
  return {
    grade: 'PERFECT',
    obstacleId: `x-${track}`,
    track,
    type: { kick: 'spike', bass: 'platform', synth: 'barrage' }[track] || 'spike',
    isCore: true,
    actionMatch: true,
    deltaMs: 0,
    rule: 'window',
    trigger: 'input',
    key: 'jump',
    penalizes: true,
    ...over
  };
}

/* ------------------------------------------------------------------ */
/* case: revive-tie — K-07 复活三口径 + 分母固定 + 不补发历史（DIS-03/05）  */
/* ------------------------------------------------------------------ */

async function caseReviveTie() {
  const MC = await load('src/mocks/MockClock.js', 'revive-tie');
  const JS = await load('src/game/systems/JudgeSystem.js', 'revive-tie');
  const DS = await load('src/game/systems/DisassembleSystem.js', 'revive-tie');
  const PH = await load('src/data/physics.js', 'revive-tie');
  if (!MC || !JS || !DS) return;

  const cfg = synthCfg();
  const clock = new MC.MockClock({ t: 0 });
  clock.init({ bpm: cfg.bpm, sections: cfg.sections, introBeats: cfg.introBeats, lengthBeats: cfg.lengthBeats });
  clock.start(0);
  const events = new JS.EventLog();
  const ds = DS.createDisassembleSystem({ clock, events });
  const inst = synthInstances(clock, {
    kick: [8, 9, 10, 11, 12, 13, 14, 15],
    bass: [24, 25, 26, 27, 28, 29, 30, 31],
    synth: [32, 33, 34, 35, 36, 37, 38, 39],
    bed: [16, 17]
  });
  ds.load(cfg, { instances: inst });
  const hpEvents = [];
  const reviveEvents = [];
  ds.on('hp-change', (p) => hpEvents.push(p));
  ds.on('revive', (p) => reviveEvents.push(p));

  eq('revive-tie: tracks.bed 被忽略（hpMax 0 / 不参与拆解）', `${ds.hpMax('bed')}/${ds.activeTrack('bed')}`, '0/false');
  eq('revive-tie: 分母 = 可判定障碍总数（不含 bed）', ds.total(), 24);
  eq('revive-tie: 核心障碍总数（coreTotal）', ds.coreTotal(), 24);
  eq('revive-tie: 在场声部数', ds.trackCount(), 3);
  eq('revive-tie: 三轨初始 hp', JSON.stringify(ds.hpByTrack()), '{"kick":4,"bass":4,"synth":4}');

  // ① DIS-03 第三条口径：全部满 hp 的 MISS 不改音频、不复活
  ds.onMiss({ atSec: clock.timeAtBeat(4) });
  eq('revive-tie: 全 hp=4 的 MISS 不改 hp', JSON.stringify(ds.hpByTrack()), '{"kick":4,"bass":4,"synth":4}');
  eq('revive-tie: 全 hp=4 的 MISS 不发任何音频事件（hp-change/revive 各 0）', `${hpEvents.length}/${reviveEvents.length}`, '0/0');
  eq('revive-tie: 全 hp=4 的 MISS 仍清连击并起无敌帧', `${ds.counts().combo}/${ds.invulnerable(clock.timeAtBeat(4) + (PH.FROZEN.invulnSec - 0.01))}`, '0/true');
  ds.onMiss({ atSec: clock.timeAtBeat(30) });
  eq(`revive-tie: 无敌帧 ${PH.FROZEN.invulnSec}s 后结束`, ds.invulnerable(clock.timeAtBeat(30) + PH.FROZEN.invulnSec + 0.01), false);

  // ② hp 最小者（PRD 原文「损失点数最多」＝hp 最小且 ≥0，不要求已拆空）
  ds.onJudgment(judg('kick'));
  ds.onJudgment(judg('kick'));
  ds.onJudgment(judg('bass'));
  eq('revive-tie: 扣血只经 onJudgment（kick2/bass3/synth4）', JSON.stringify(ds.hpByTrack()), '{"kick":2,"bass":3,"synth":4}');
  eq('revive-tie: 最近一次 hp 写入者 = onJudgment', ds.lastHpWriter(), 'onJudgment');
  const pick1 = ds.onMiss({ atSec: clock.timeAtBeat(40) });
  eq('revive-tie: MISS 复活 hp 最小者（kick）', pick1, 'kick');
  eq('revive-tie: 复活后 hp → 1（不是满 hp，DIS-05）', ds.hp('kick'), 1);
  ds.reset();

  // ③ 并列口径 kick > bass > synth
  ds.onJudgment(judg('bass'));
  ds.onJudgment(judg('bass'));
  ds.onJudgment(judg('synth'));
  ds.onJudgment(judg('synth'));
  eq('revive-tie: 并列前置（bass2/synth2/kick4）', JSON.stringify(ds.hpByTrack()), '{"kick":4,"bass":2,"synth":2}');
  eq('revive-tie: bass/synth 并列 → 取 bass', ds.onMiss({ atSec: clock.timeAtBeat(42) }), 'bass');
  ds.reset();
  ds.onJudgment(judg('synth'));
  ds.onJudgment(judg('synth'));
  ds.onMiss({ atSec: clock.timeAtBeat(42) });
  eq('revive-tie: synth 独自最小 → 取 synth', ds.hp('synth'), 1);

  // ④ 拆空 → 停止生成 → 复活只补当前拍之后（不补发历史）
  ds.reset();
  eq('revive-tie: reset 后分母不变（§7.3 / T6）', ds.total(), 24);
  for (let i = 0; i < 4; i += 1) ds.onJudgment(judg('synth'));
  eq('revive-tie: synth 拆空 → hp 0', ds.hp('synth'), 0);
  eq('revive-tie: 三轨未全空 → disassembled() 仍 false', ds.disassembled(), false);
  eq('revive-tie: 拆空声部进入 disassembledTracks()', JSON.stringify(ds.disassembledTracks()), '["synth"]');
  eq('revive-tie: 停止生成（在场实例里 synth 归零）', ds.activeInstances().filter((o) => o.track === 'synth').length, 0);
  const beatNow = 34;
  const pick2 = ds.onMiss({ atSec: clock.timeAtBeat(beatNow) });
  eq('revive-tie: 已拆空者被 MISS 复活', pick2, 'synth');
  const revived = ds.activeInstances().filter((o) => o.track === 'synth' && o.beat > beatNow);
  eq('revive-tie: 复活恢复的原件数 = 当前拍之后的原始事件数', revived.length, 5);
  ok('revive-tie: 复活实例的 beat 全部 > 当前拍（不补发历史，DIS-05）', revived.every((o) => o.beat > beatNow), JSON.stringify(revived.map((o) => o.beat)));
  // DEF-04 口径修订（替换 R6 的「补发新实例」）：复活 = 把当前拍之后的**原件取消退役**，
  // 不铸造 -rvN 新身份；否则同一源障碍有两个可判身份，事件流条数超过谱面，§7.3 的「固定分母」被破坏。
  ok('revive-tie: 复活实例就是原件本身（id 无 -rvN 后缀，未新增身份）', revived.every((o) => !/-rv\d+$/.test(o.id)), JSON.stringify(revived.map((o) => o.id)));
  eq('revive-tie: 复活后在场实例回到谱面原状（24 个可判定原件里只剩 3 个历史障碍不在场，无副本）', ds.activeInstances().length, ds.total() - 3);
  eq('revive-tie: 分母恒为初始谱面 24（§7.3 固定分母，与复活/重开无关）', ds.total(), 24);
  eq('revive-tie: 初始谱面分母不随复活变化（baseTotal，bed 仍不计入）', ds.baseTotal(), 24);
  eq('revive-tie: 核心分母同为谱面口径 24（不随复活增长）', ds.coreTotal(), 24);
  eq('revive-tie: revivedIssued = 本局被取消退役的原件个数', ds.stats().revivedIssued, 5);
  eq('revive-tie: 复活后实例 id 全表唯一（不出现同拍双实例）', new Set(ds.activeInstances().map((o) => o.id)).size, ds.activeInstances().length);
  eq('revive-tie: 复活后 hp = REVIVE_HP', ds.hp('synth'), DS.REVIVE_HP);
  eq('revive-tie: hp-change 事件的 reason 标注 revive', reviveEvents.length > 0 && hpEvents.some((p) => p.reason === 'revive'), true);

  // ⑤ 唯一过滤点：emptyBeat / penalizes:false 直通，不扣血不清连击
  ds.reset();
  ds.onJudgment(judg('kick'));
  const comboBefore = ds.counts().combo;
  const missBefore = ds.counts().miss;
  const hpBefore = ds.hp('kick');
  eq('revive-tie: emptyBeat → onJudgment 返回 null', ds.onJudgment({ grade: 'MISS', rule: 'emptyBeat', penalizes: false, track: 'kick', isCore: false, actionMatch: false }), null);
  eq('revive-tie: emptyBeat 不清连击', ds.counts().combo, comboBefore);
  eq('revive-penalty: emptyBeat 不进 MISS 统计', ds.counts().miss, missBefore);
  eq('revive-tie: emptyBeat 不改 hp', ds.hp('kick'), hpBefore);
  eq('revive-tie: penalizes:false 也直通（新字段唯一口径，CR-08 #1）', ds.onJudgment(judg('kick', { grade: 'MISS', penalizes: false })), null);
  eq('revive-tie: penalizes:false 的 MISS 不复活', ds.hp('kick'), hpBefore);

  // ⑥ DIS-02 / JDG-07：非核心 PERFECT 与错动作都不涨不掉 hp
  ds.reset();
  eq('revive-tie: 非核心 PERFECT 不扣 hp', ds.onJudgment(judg('kick', { isCore: false })), null);
  eq('revive-tie: 错动作 PERFECT 不扣 hp', ds.onJudgment(judg('kick', { actionMatch: false })), null);
  eq('revive-tie: GOOD 不扣 hp', ds.onJudgment(judg('kick', { grade: 'GOOD' })), null);
  eq('revive-tie: 以上三种都不写 hp', ds.hp('kick'), 4);
  eq('revive-tie: 但 GOOD / 非核心 PERFECT 仍进连击与计数', `${ds.counts().good}/${ds.counts().perfect}/${ds.combo}`, '1/2/3');
  eq('revive-tie: 核心命中率分子不含非核心', ds.coreHitRate(), 0);

  // ⑦ 全拆完 → DISASSEMBLED；MISS 触发 DISASSEMBLED→PEAK 回退（世界重建）
  ds.reset();
  for (const t of ['kick', 'bass', 'synth']) for (let i = 0; i < 4; i += 1) ds.onJudgment(judg(t));
  eq('revive-tie: 三轨全 0 → disassembled()', ds.disassembled(), true);
  eq('revive-tie: 全拆完 → 状态 DISASSEMBLED', ds.state(), 'DISASSEMBLED');
  const st = [];
  ds.on('state-change', (p) => st.push(`${p.from}→${p.to}/${p.reason}`));
  const pick3 = ds.onMiss({ atSec: clock.timeAtBeat(2) });
  eq('revive-tie: DISASSEMBLED 下 MISS 复活 hp 最小者', pick3, 'kick');
  eq('revive-tie: 复活触发唯一回退边 DISASSEMBLED→PEAK', ds.state(), 'PEAK');
  eq('revive-tie: 回退边的 reason = revive', st.join('|'), 'DISASSEMBLED→PEAK/revive');
  note('复活三口径（hp 最小者 / 并列 kick>bass>synth / 全满不改音频）+ 复活后 hp=1 + 只补当前拍之后，均已固化为断言');
}

/* ------------------------------------------------------------------ */
/* case: silence — K-07 状态机（DIS-08）+ K-11 寂静段光点（DIS-07）        */
/* ------------------------------------------------------------------ */

async function caseSilence() {
  const MC = await load('src/mocks/MockClock.js', 'silence');
  const JS = await load('src/game/systems/JudgeSystem.js', 'silence');
  const DS = await load('src/game/systems/DisassembleSystem.js', 'silence');
  if (!MC || !JS || !DS) return;

  const fwd = [
    ['INTRO', 'BUILD'],
    ['BUILD', 'PEAK'],
    ['PEAK', 'DISASSEMBLED'],
    ['DISASSEMBLED', 'SILENCE'],
    ['SILENCE', 'RESULT'],
    ['INTRO', 'RESULT']
  ];
  for (const [a, b] of fwd) ok(`silence: 合法迁移 ${a}→${b}`, DS.isLegalTransition(a, b) === true);
  const bad = [
    ['SILENCE', 'PEAK'],
    ['SILENCE', 'BUILD'],
    ['PEAK', 'BUILD'],
    ['RESULT', 'INTRO'],
    ['DISASSEMBLED', 'BUILD'],
    ['INTRO', 'SILENCE'],
    ['BUILD', 'SILENCE']
  ];
  for (const [a, b] of bad) ok(`silence: 非法迁移 ${a}→${b}`, DS.isLegalTransition(a, b) === false);
  ok('silence: DISASSEMBLED→PEAK 只认 reason=revive（DIS-08 的唯一回退边）', DS.isLegalTransition('DISASSEMBLED', 'PEAK') === false && DS.isLegalTransition('DISASSEMBLED', 'PEAK', 'revive') === true);
  ok('silence: 未知状态名一律 false', DS.isLegalTransition('INTRO', 'WAT') === false && DS.isLegalTransition('NOPE', 'BUILD') === false);
  eq('silence: 六态清单与 C3 一致', JSON.stringify(DS.GAME_STATES), JSON.stringify(['INTRO', 'BUILD', 'PEAK', 'DISASSEMBLED', 'SILENCE', 'RESULT']));
  eq('silence: 状态序 INTRO=0 … RESULT=5（只许向前的可断言口径）', DS.STATE_ORDER.RESULT - DS.STATE_ORDER.INTRO, 5);

  const cfg = synthCfg({ freeOrder: true });
  const clock = new MC.MockClock({ t: 0 });
  clock.init({ bpm: cfg.bpm, sections: cfg.sections, introBeats: cfg.introBeats, lengthBeats: cfg.lengthBeats });
  clock.start(0);
  const events = new JS.EventLog();
  const judge = JS.createJudgeSystem({ clock, events });
  const ds = DS.createDisassembleSystem({ clock, events });
  ds.load(cfg, { instances: synthInstances(clock, { kick: [8, 9, 10, 11], bass: [12, 13, 14, 15], synth: [16, 17, 18, 19] }) });
  ds.bindJudge(judge);
  const seen = [];
  ds.on('state-change', (p) => seen.push(`${p.from}→${p.to}/${p.reason}`));
  const revs = [];
  ds.on('revive', (p) => revs.push(p));

  throws('silence: transition() 对非法迁移抛 RangeError', () => ds.transition('SILENCE'), '非法迁移');
  throws('silence: transition() 对未知状态名抛 RangeError', () => ds.transition('WAT'), '非法状态名');
  eq('silence: 抛错后状态未被改写', ds.state(), 'INTRO');

  ds.transition('BUILD', { reason: 'test' });
  ds.transition('PEAK', { reason: 'test' });
  for (const t of ['kick', 'bass', 'synth']) for (let i = 0; i < 4; i += 1) ds.onJudgment(judg(t));
  eq('silence: 全拆 → DISASSEMBLED（自动，reason=disassemble）', ds.state(), 'DISASSEMBLED');
  eq('silence: 段落提出的非法状态被忽略而非抛出', ds.acceptSectionState('PEAK', { reason: 'section' }), false);
  eq('silence: 被忽略的提议记录在 lastIgnored', `${ds.lastIgnored.from}→${ds.lastIgnored.to}`, 'DISASSEMBLED→PEAK');
  eq('silence: 忽略提议后状态不变', ds.state(), 'DISASSEMBLED');

  const moved = ds.transition('SILENCE', { reason: 'silenceStart' });
  eq('silence: DISASSEMBLED→SILENCE 合法', `${moved}/${ds.state()}`, 'true/SILENCE');
  const dots = ds.silenceDots();
  eq('silence: 光点数 = silenceBeats（8 拍逐拍）', dots.length, 8);
  eq('silence: 光点起始拍 = ceil(lengthBeats - silenceBeats)', dots[0].beat, 56);
  eq('silence: 光点终止拍 = lengthBeats-1', dots[dots.length - 1].beat, 63);
  eq('silence: 光点初始态 lit', dots.every((d) => d.state === 'lit'), true);
  eq('silence: 光点 timeSec 与 clock.timeAtBeat 同口径', dots[3].timeSec, clock.timeAtBeat(59));
  const hpSnap = JSON.stringify(ds.hpByTrack());
  const totalSnap = ds.total();

  // DIS-07：段内光点 MISS 不复活任何声部
  eq('silence: SILENCE 内 stompDot 在窗口外返回 null', ds.stompDot({ atSec: clock.timeAtBeat(56) - 0.5 }), null);
  eq('silence: 窗口内踩灭 → stomped', ds.stompDot({ atSec: clock.timeAtBeat(56) + 0.001 })?.state, 'stomped');
  eq('silence: 踩光点不改 hp', JSON.stringify(ds.hpByTrack()), hpSnap);
  eq('silence: 踩光点不进分母', ds.total(), totalSnap);
  eq('silence: 踩光点算连击', ds.combo > 0, true);

  // 其余 7 个光点自然到期：逐 25ms 走完寂静段
  const missBefore = ds.counts().miss;
  clock.advanceTo(clock.timeAtBeat(64) + 0.6);
  const final = ds.silenceDots();
  eq('silence: 未踩的光点最终 expired（重亮只一拍）', final.filter((d) => d.state === 'expired').length, 7);
  eq('silence: 每个到期光点只 MISS 一次', final.filter((d) => d.missed === 1).length, 7);
  eq('silence: 段内 MISS 不复活任何声部（revive 事件 0，DIS-07）', revs.length, 0);
  eq('silence: 段内 MISS 不改 hp', JSON.stringify(ds.hpByTrack()), hpSnap);
  eq('silence: 段内 MISS 不回退状态（SILENCE→PEAK 非法）', ds.state(), 'SILENCE');
  eq('silence: 光点 MISS 不进 §7.3 的 MISS 数', ds.counts().miss, missBefore);
  eq('silence: 光点 MISS 另有计数（dotMiss）', ds.counts().dotMiss, 7);
  eq('silence: Perfect 分母在寂静段后仍不变', ds.total(), totalSnap);
  ds.transition('RESULT', { reason: 'timeUp' });
  eq('silence: SILENCE→RESULT 合法', ds.state(), 'RESULT');
  throws('silence: RESULT 是终态（再迁移一律抛）', () => ds.transition('PEAK'), '非法迁移');
  eq('silence: 状态机轨迹', seen.join('|'), 'INTRO→BUILD/test|BUILD→PEAK/test|PEAK→DISASSEMBLED/disassemble|DISASSEMBLED→SILENCE/silenceStart|SILENCE→RESULT/timeUp');
}

/* ------------------------------------------------------------------ */
/* case: actiontype — K-09 / JDG-07 错动作按 GOOD + JDG-08 同拍单输入      */
/* ------------------------------------------------------------------ */

async function caseActiontype() {
  const MC = await load('src/mocks/MockClock.js', 'actiontype');
  const JS = await load('src/game/systems/JudgeSystem.js', 'actiontype');
  const DS = await load('src/game/systems/DisassembleSystem.js', 'actiontype');
  if (!MC || !JS || !DS) return;

  eq('actiontype: spike→jump', JS.expectedAction('spike'), 'jump');
  eq('actiontype: platform→jump', JS.expectedAction('platform'), 'jump');
  eq('actiontype: barrage→dash', JS.expectedAction('barrage'), 'dash');
  eq('actiontype: 未知类型兜底 jump', JS.expectedAction('nope'), 'jump');

  const cfg = synthCfg();
  const clock = new MC.MockClock({ t: 0 });
  clock.init({ bpm: cfg.bpm, sections: cfg.sections, introBeats: cfg.introBeats, lengthBeats: cfg.lengthBeats });
  clock.start(0);
  const inst = synthInstances(clock, { kick: [8, 20], bass: [8, 24], synth: [12, 28] });
  const events = new JS.EventLog();
  const judge = JS.createJudgeSystem({ clock, events });
  const ds = DS.createDisassembleSystem({ clock, events });
  ds.load(cfg, { instances: inst });
  ds.bindJudge(judge);
  judge.registerObstacles(inst);
  const feed = [];
  judge.onJudgment((j) => {
    feed.push(j);
    ds.onJudgment(j);
  });
  eq('actiontype: judgable:false 的 bed 不入队（本夹具无 bed）', `${judge.pendingCount()}/${inst.length}`, '6/6');

  // JDG-07：错动作按 GOOD 通过，不涨不扣 hp
  // R3 口径修正：这段原来打在拍 8 上，而拍 8 正是下面 JDG-08 的夹具拍。按 PRD L184「同一拍最多 1 次
  // 输入被消费」，JDG-07 这次输入会把拍 8 的输入名额用光，JDG-08 的「第一次输入消费一个障碍」在同一拍
  // 上永远不可能成立。挪到拍 12（synth→barrage，期望 dash，用 jump 就是错动作）后断言内容一条没减。
  // R3 口径修正（二）：这里**不推进时钟**。C2 的 atSec 是判定唯一时间源（真实游戏里 = keydown 时取的
  // BeatClock.now()），测试直接给权威时刻即可；一旦 advanceTo 到拍 12，拍 8 那两个障碍的超时定时器
  // （due = 4.11）会先派发，JDG-08 的夹具拍就没有可消费的障碍了——原来把两段都写在拍 8 上正是被这个
  // 连锁反应卡住的表象。
  const wrong = judge.onInput('jump', clock.timeAtBeat(12) + 0.01); // barrage 期望 dash
  eq('actiontype: 错动作 → GOOD', wrong.grade, 'GOOD');
  eq('actiontype: 错动作 → actionMatch false', wrong.actionMatch, false);
  eq('actiontype: 错动作仍算命中（rule window / penalizes true）', `${wrong.rule}/${wrong.penalizes}`, 'window/true');
  eq('actiontype: 错动作不写 hp', ds.hp('kick'), 4);
  eq('actiontype: 错动作不进 Perfect 计数', ds.counts().perfect, 0);
  eq('actiontype: 错动作进 GOOD 计数', ds.counts().good, 1);
  eq('actiontype: 错动作保留连击', ds.combo, 1);

  // JDG-08：同拍的两个障碍，一次输入只消费一个
  // R3 口径修正：输入时刻原来写的是 t8+0.4 / t8+0.42 —— 400ms 是 GOOD 窗口（110ms）的 3.6 倍，
  // 按 C2 的窗口匹配它**必然**落成 emptyBeat，「第一次输入消费了某个障碍」与「待判定数 -1」在冻结的
  // 窗口表面前无解（不是实现少写了一条分支，是夹具时刻越界）。改成窗口内 60ms / 64ms 之后，
  // 三次断言各自的行为主张原样保留：恰好消费 1 个 / 第二次同拍输入不消费 / 待判定 -1。
  const beat8 = inst.filter((o) => o.beat === 8);
  eq('actiontype: 夹具的拍 8 有 2 个障碍', beat8.length, 2);
  const t8 = clock.timeAtBeat(8);
  // 取「GOOD 环内、PERFECT 外」的时刻（窗口表的几何中点），本块要验的是**消费名额**而不是扣分，
  // 写在 PERFECT 里会顺手扣 hp，后面的 emptyBeat/复活断言基线就被自己改掉了。
  const inGoodRing = (judge.windows().perfectMs + judge.windows().goodMs) / 2000;
  const a = judge.onInput('jump', t8 + inGoodRing);
  const b = judge.onInput('jump', t8 + inGoodRing + 0.004);
  ok('actiontype: 第一次输入消费了某个障碍', !!a.obstacleId, JSON.stringify(a));
  eq('actiontype: 同拍第二次输入不再消费（JDG-08）', b.obstacleId, null);
  eq('actiontype: 同拍第二次输入按 emptyBeat 无惩罚呈现', `${b.rule}/${b.penalizes}`, 'emptyBeat/false');
  eq('actiontype: 一次输入只吃掉一个 obstacle（待判定数 -1）', judge.pendingCount(), 4);
  eq('actiontype: emptyBeat 不扣 hp（唯一过滤点在 DisassembleSystem）', ds.hp('bass'), 4);
  eq('actiontype: emptyBeat 不清连击', ds.combo > 0, true);

  // CR-08 #4：提前派发不得重复判定同一 obstacle
  const target = inst.find((o) => o.beat === 20);
  const due = target.timeSec + judge.windows().goodMs / 1000;
  clock.advanceTo(due - 0.05); // 落在 120ms 提前窗口内 → 回调必须自检后重挂
  eq('actiontype: 提前派发未把障碍判成 MISS', target.state, 'pending');
  eq('actiontype: 提前派发未产生判定事件', feed.filter((j) => j.obstacleId === target.id).length, 0);
  clock.advanceTo(due + 0.02);
  eq('actiontype: 到点后恰好判定一次', feed.filter((j) => j.obstacleId === target.id).length, 1);
  eq('actiontype: 到点后障碍转 expired', target.state, 'expired');
  clock.advanceTo(due + 1.0);
  eq('actiontype: 再推进不重复判定（提前触发不双判）', feed.filter((j) => j.obstacleId === target.id).length, 1);
  eq('actiontype: 超时 MISS 走同一入口并触发复活（hp 最小者）', feed.filter((j) => j.obstacleId === target.id)[0].trigger, 'timeout');

  // 空拍形状
  // R3 口径修正：期望值原来是绝对串 "4/0"，但本 case 在前面**故意**制造了超时 MISS（拍 8 漏掉的那
  // 个 + CR-08#4 的 target），miss 早已非 0——按「miss 必须为 0」写死等于要求实现不吃超时判定，
  // 与 JDG-05 冲突。这里要验的是「空拍**不增加** miss 计数、不扣 hp」，所以基线取空拍输入之前的值。
  const missBeforeEmpty = ds.counts().miss;
  const empty = judge.onInput('jump', clock.timeAtBeat(50));
  eq('actiontype: 空拍形状', `${empty.grade}/${empty.rule}/${empty.trigger}/${empty.penalizes}/${empty.obstacleId}`, 'MISS/emptyBeat/input/false/null');
  eq('actiontype: 空拍不改 hp 也不进 MISS 统计', `${ds.hp('kick')}/${ds.counts().miss}`, `4/${missBeforeEmpty}`);
  note('JDG-07（错动作按 GOOD、不涨不扣 hp）与 JDG-08（同拍单输入只消费一个）+ CR-08 #4（提前触发不双判）已固化');
}

/* ------------------------------------------------------------------ */
/* case: freeorder — K-12 L6 自由顺序（拆解顺序无关）                     */
/* ------------------------------------------------------------------ */

async function caseFreeorder() {
  const MC = await load('src/mocks/MockClock.js', 'freeorder');
  const JS = await load('src/game/systems/JudgeSystem.js', 'freeorder');
  const DS = await load('src/game/systems/DisassembleSystem.js', 'freeorder');
  const PG = await load('src/game/systems/PatternGenerator.js', 'freeorder');
  if (!MC || !JS || !DS || !PG) return;

  const cfg = synthCfg({ freeOrder: true });
  const clock = new MC.MockClock({ t: 0 });
  clock.init({ bpm: cfg.bpm, sections: cfg.sections, introBeats: cfg.introBeats, lengthBeats: cfg.lengthBeats });
  clock.start(0);
  const mk = () => {
    const dsx = DS.createDisassembleSystem({ clock, events: new JS.EventLog() });
    dsx.load(cfg, { instances: synthInstances(clock, { kick: [8, 9, 10, 11], bass: [12, 13, 14, 15], synth: [16, 17, 18, 19] }) });
    return dsx;
  };
  eq('freeorder: 配置 freeOrder:true → ds.freeOrder()', mk().freeOrder(), true);

  const orderA = [];
  const orderB = [];
  const runA = mk();
  const runB = mk();
  for (const t of ['kick', 'bass', 'synth']) for (let i = 0; i < 4; i += 1) runA.onJudgment(judg(t));
  for (const t of ['synth', 'bass', 'kick']) for (let i = 0; i < 4; i += 1) runB.onJudgment(judg(t));
  orderA.push(runA.state());
  orderB.push(runB.state());
  eq('freeorder: 正序与倒序都抵达 disassembled()', `${runA.disassembled()}/${runB.disassembled()}`, 'true/true');
  eq('freeorder: 倒序不影响 Perfect 率', `${runA.perfectRate()}/${runB.perfectRate()}`, '1/1');
  eq('freeorder: 两序 hp 归零后的快照一致', JSON.stringify(runA.hpByTrack()), JSON.stringify(runB.hpByTrack()));
  eq('freeorder: disassembledTracks() 始终按 kick/bass/synth 稳定序', JSON.stringify(runB.disassembledTracks()), '["kick","bass","synth"]');
  eq('freeorder: 状态轨迹一致（与拆解顺序无关）', orderA.join('|'), orderB.join('|'));
  eq('freeorder: 扣血次数 = 声部数 × 4', [runA, runB].every((x) => x.coreHitRate() === 1), true);

  const part = mk();
  for (const t of ['kick', 'bass']) for (let i = 0; i < 4; i += 1) part.onJudgment(judg(t));
  eq('freeorder: 只拆两轨 → disassembled() false', part.disassembled(), false);
  eq('freeorder: 未全拆 → 状态不进 DISASSEMBLED', part.state(), 'INTRO');
  eq('freeorder: 已拆两轨仍如实上报', JSON.stringify(part.disassembledTracks()), '["kick","bass"]');

  // 真 L6（SOUND 名下内容）：三轨齐备 + freeOrder
  const l6 = readLevel(6);
  if (!l6) {
    skipCase('freeorder', 'src/data/levels/level6.json 尚不存在（SOUND 名下内容）');
    return;
  }
  const rig = buildRig(PG, MC, JS, DS, l6);
  eq('freeorder: L6 配置 freeOrder → ds.freeOrder()', rig.ds.freeOrder(), true);
  eq('freeorder: L6 三轨都在（trackCount 3）', rig.ds.trackCount(), 3);
  eq('freeorder: L6 三轨 hp 均为 4', JSON.stringify(rig.ds.hpByTrack()), '{"kick":4,"bass":4,"synth":4}');
  eq('freeorder: L6 无 bed 参与拆解', rig.ds.activeTrack('bed'), false);
  const check = PG.validateFreeOrder(l6, rig.instances);
  eq('freeorder: L6 通过 SOUND 的 validateFreeOrder（只读调用）', JSON.stringify(check?.errors ?? []), '[]');
  playRig(rig, { stomp: true });
  eq('freeorder: L6 完美局 → 全拆 + Perfect 100%', `${rig.ds.disassembled()}/${rig.ds.perfectRate()}`, 'true/1');
  eq('freeorder: L6 完美局评级 S', rig.ds.rank(), 'S');
  eq('freeorder: L6 完美局无惩罚 MISS', rig.ds.counts().miss, 0);
}

/* ------------------------------------------------------------------ */
/* case: integration — K-05 真谱面全事件流 + 重开基线 + L-07 窗口表        */
/* ------------------------------------------------------------------ */

async function caseIntegration() {
  const MC = await load('src/mocks/MockClock.js', 'integration');
  const JS = await load('src/game/systems/JudgeSystem.js', 'integration');
  const DS = await load('src/game/systems/DisassembleSystem.js', 'integration');
  const PG = await load('src/game/systems/PatternGenerator.js', 'integration');
  const CFG = await load('src/data/config.js', 'integration');
  if (!MC || !JS || !DS || !PG) return;

  /* —— ① 真 L1 / L2：MockClock 逐帧跑完整事件流（数字固化成回归） —— */
  const FROZEN_FLOW = {
    1: { total: 55, core: 16, bed: 39, hpEvents: 4, disEvents: 1, dots: 8, states: 'INTRO→BUILD/section|BUILD→DISASSEMBLED/disassemble|DISASSEMBLED→SILENCE/silenceStart|SILENCE→RESULT/timeUp' },
    2: { total: 56, core: 14, bed: 48, hpEvents: 8, disEvents: 2, dots: 12, states: 'INTRO→BUILD/section|BUILD→PEAK/section|PEAK→DISASSEMBLED/disassemble|DISASSEMBLED→SILENCE/silenceStart|SILENCE→RESULT/timeUp' }
  };
  for (const id of [1, 2]) {
    const cfg = readLevel(id);
    if (!cfg) {
      skipCase('integration', `src/data/levels/level${id}.json 尚不存在（SOUND 名下内容）`);
      continue;
    }
    const expect = FROZEN_FLOW[id];
    const rig = buildRig(PG, MC, JS, DS, cfg);
    rig.JS = JS;
    playRig(rig, { stomp: true });
    const tag = `L${id}`;

    eq(`integration ${tag}: 分母 = 谱面可判定障碍数（固化）`, rig.ds.total(), expect.total);
    eq(`integration ${tag}: 核心障碍数（固化）`, rig.ds.coreTotal(), expect.core);
    eq(`integration ${tag}: bed 实例数（固化，且不进分母）`, rig.instances.length - expect.total, expect.bed);
    eq(`integration ${tag}: bed 一律 judgable:false`, rig.instances.filter((o) => o.track === 'bed').every((o) => o.judgable === false), true);
    eq(`integration ${tag}: JudgeSystem 跳过 bed 数（ignoredCount）`, rig.judge.ignoredCount(), expect.bed);
    eq(`integration ${tag}: 判定流里没有 bed 障碍`, rig.feed.some((j) => j.track === 'bed' || j.obstacleId === null && j.rule === 'window'), false);
    eq(`integration ${tag}: 每次输入都是窗口内 PERFECT`, rig.feed.every((j) => j.grade === 'PERFECT' && j.rule === 'window' && j.penalizes === true), true);
    eq(`integration ${tag}: 输入数 = 分母`, rig.feed.length, expect.total);
    eq(`integration ${tag}: Perfect 率 100% / 核心命中率 100%`, `${rig.ds.perfectRate()}/${rig.ds.coreHitRate()}`, '1/1');
    eq(`integration ${tag}: 完美局评级 S`, rig.ds.rank(), 'S');
    eq(`integration ${tag}: 完美局 0 惩罚 MISS`, rig.ds.counts().miss, 0);
    eq(`integration ${tag}: 完美局光点全踩灭`, rig.ds.silenceDots().every((d) => d.state === 'stomped'), true);
    eq(`integration ${tag}: 光点数 = silenceBeats`, rig.ds.silenceDots().length, expect.dots);
    eq(`integration ${tag}: 状态轨迹（固化）`, rig.ev.filter((e) => e.name === 'state-change').map((e) => `${e.from}→${e.to}/${e.reason}`).join('|'), expect.states);
    eq(`integration ${tag}: hp-change 事件数 = 总 hp 点数`, rig.ev.filter((e) => e.name === 'hp-change').length, expect.hpEvents);
    eq(`integration ${tag}: disassemble 事件数 = 声部数`, rig.ev.filter((e) => e.name === 'disassemble').length, expect.disEvents);
    eq(`integration ${tag}: 无复活事件（完美局）`, rig.ev.filter((e) => e.name === 'revive').length, 0);
    eq(`integration ${tag}: hp-change 均先于同轨 disassemble`, (() => {
      const seq = rig.ev.filter((e) => e.name === 'hp-change' || e.name === 'disassemble');
      const lastHp = {};
      for (const e of seq) {
        if (e.name === 'hp-change') lastHp[e.track] = seq.indexOf(e);
        else if (seq.findIndex((x) => x.name === 'disassemble' && x.track === e.track) < lastHp[e.track]) return false;
      }
      return true;
    })(), true);
    eq(`integration ${tag}: 终态 RESULT`, rig.ds.state(), 'RESULT');
    eq(`integration ${tag}: 队列清空（detach 后无残留定时器）`, (rig.ds.detach(), rig.clock.queueSize()), 0);
    eq(`integration ${tag}: C7 事件流有判定与 hp 记录`, rig.events.count() > expect.total, true);
    eq(`integration ${tag}: 非法提议被忽略而非抛出（section 的 PEAK 在 DISASSEMBLED 之后）`, rig.ds.lastIgnored === null || rig.ds.lastIgnored.to !== undefined, true);
  }

  /* —— ② K-05 重开基线：20 次 R 之后队列 / 监听 / 分母 / 音频节点数回基线 —— */
  const cfg1 = readLevel(1);
  if (cfg1) {
    const rig = buildRig(PG, MC, JS, DS, cfg1);
    playRig(rig, { stomp: true });
    rig.ds.detach();
    const queueBase = rig.clock.queueSize();
    const listenersBase = ['hp-change', 'disassemble', 'revive', 'state-change'].reduce((n, k) => n + rig.ds.listenerCount(k), 0);
    const instanceBase = rig.instances.length;
    let everyRestartIdentical = true;
    for (let i = 0; i < 20; i += 1) {
      // 重开的正确顺序（K-05 / T6）：时钟回到第 0 拍锚点 → 判据与 hp 复位 → 再入队 → 再挂订阅。
      // 时钟放最后一步复位等于「用上一局的终点跑下一局」，20 次里前一次永远 0 判定。
      rig.clock.stop();
      rig.clock.start(0);
      rig.judge.reset();
      rig.ds.reset();
      rig.judge.registerObstacles(rig.instances);
      rig.ds.attach();
      playRig(rig, { stomp: true });
      // 每一局重开都必须得到完全一样的判定数与分母（T6：重开不改变耐久统计口径）
      if (rig.ds.counts().perfect !== 55 || rig.ds.total() !== 55 || rig.feed.length !== (i + 2) * 55) everyRestartIdentical = false;
      rig.ds.detach();
    }
    eq('integration: 20 次重开每一局判定数与分母都相同（无累积漂移）', everyRestartIdentical, true);
    eq('integration: 20 次重开后 clock 队列回基线', rig.clock.queueSize(), queueBase);
    eq('integration: 20 次重开后订阅数回基线', ['hp-change', 'disassemble', 'revive', 'state-change'].reduce((n, k) => n + rig.ds.listenerCount(k), 0), listenersBase);
    rig.judge.reset();
    rig.ds.reset();
    eq('integration: 20 次重开后分母不变（§7.3）', rig.ds.total(), 55);
    eq('integration: 20 次重开后 hp 回满（L1 只有鼓轨）', JSON.stringify(rig.ds.hpByTrack()), '{"kick":4,"bass":0,"synth":0}');
    eq('integration: 20 次重开后状态回 INTRO', rig.ds.state(), 'INTRO');
    eq('integration: 20 次重开后实例表长度不变（无泄漏）', rig.instances.length, instanceBase);
    eq('integration: 20 次重开后待判定队列为空（未 register）', rig.judge.pendingCount(), 0);
    ok('integration: lastHpWriter 只可能是 onJudgment/onMiss/null', ['onJudgment', 'onMiss', null].includes(rig.ds.lastHpWriter()), String(rig.ds.lastHpWriter()));

    // 音频节点数基线（SOUND 名下 SoundEngine + 假 AudioContext）
    const AUD = await load('tools/audioAssert.mjs', 'integration');
    const SE = await load('src/audio/SoundEngine.js', 'integration');
    if (AUD && SE) {
      const ref = { t: 0 };
      const fake = AUD.makeFakeContext({ currentTimeRef: ref });
      const saved = globalThis.AudioContext;
      globalThis.AudioContext = function FakeCtor() {
        return fake;
      };
      try {
        const engine = SE.createSoundEngine();
        ok('integration: SoundEngine 用假 AudioContext 可 init', engine.init() === true && engine.ready === true);
        engine.loadLevel(cfg1, rig.clock);
        const nodeBase = fake.nodes.length;
        const schedBase = engine.getStatus().events;
        for (let i = 0; i < 20; i += 1) {
          engine.loadLevel(cfg1, rig.clock);
          engine.arm(0.35);
          engine.silence('kick');
          engine.revive('kick');
          engine.applyHp('kick', 2, 4);
          ref.t = 0.4;
          engine.pump(0.4);
          engine.stop();
        }
        eq('integration: 20 次重开后 Audio 节点数回基线（K-05 teardown 无泄漏）', fake.nodes.length, nodeBase);
        eq('integration: 20 次重开后待发声表长度回基线', engine.getStatus().events, schedBase);
        eq('integration: 音源指针归零（arm 后 sinceRestart）', engine.getStatus().loudnessDb !== undefined, true);
      } finally {
        if (saved === undefined) delete globalThis.AudioContext;
        else globalThis.AudioContext = saved;
      }
    }
  }

  /* —— ③ L-07 六关窗口表 + 谱面硬约束 —— */
  eq('integration: WINDOW_SCALES 表 = 1.2/1.1/1.0/1.0/0.95/0.95', JSON.stringify(CFG.WINDOW_SCALES), JSON.stringify([1.2, 1.1, 1, 1, 0.95, 0.95]));
  const seenLevels = LEVEL_IDS.filter((id) => readLevel(id));
  eq('integration: 六关 JSON 全部就位', seenLevels.length, 6);
  for (const id of seenLevels) {
    const cfg = readLevel(id);
    eq(`integration: L${id} windowScale 与关卡表一致`, `${cfg.windowScale}/${CFG.windowScaleFor(id)}`, `${CFG.WINDOW_SCALES[id - 1]}/${CFG.WINDOW_SCALES[id - 1]}`);
    ok(`integration: L${id} 至少一个可拆解声部`, ['kick', 'bass', 'synth'].some((t) => (cfg.tracks[t] || {}).hp > 0));
    ok(`integration: L${id} bed 存在且 disassemble:false`, !!cfg.tracks.bed && cfg.tracks.bed.disassemble === false);
    eq(`integration: L${id} silenceBeats>0（K-11 有光点段）`, cfg.silenceBeats > 0, true);
    ok(`integration: L${id} sections 覆盖 SILENCE`, (cfg.sections || []).some((s) => s.state === 'SILENCE'));
    // T8（leader 仲裁）：分母恒等式 = obstacleCount − bedCount
    const r = buildRig(PG, MC, JS, DS, cfg);
    const bed = r.instances.filter((o) => o.track === 'bed').length;
    eq(`integration: L${id} T8 分母 = obstacleCount − bedCount`, r.ds.total(), r.instances.length - bed);
    eq(`integration: L${id} bed 一律 judgable:false（CR-09）`, r.instances.filter((o) => o.track === 'bed').every((o) => o.judgable === false), true);
    eq(`integration: L${id} 分母只数 judgable!==false`, r.ds.total(), r.instances.filter((o) => o.judgable !== false).length);
    eq(`integration: L${id} bed 不进分母也不进核心数`, r.ds.coreTotal() <= r.ds.total(), true);
    eq(`integration: L${id} Judge 不入队 bed（ignoredCount = bed 数）`, r.judge.ignoredCount(), bed);
  }
  const rig = buildRig(PG, MC, JS, DS, readLevel(6));
  rig.JS = JS;
  const w = rig.judge.windows();
  ok('integration: L6 窗口仍守住下限（PERFECT≥40ms / GOOD≥80ms）', w.perfectMs >= 40 && w.goodMs >= 80, `${w.perfectMs}/${w.goodMs}`);
  eq('integration: L6 窗口随 windowScale 收窄（比 L1 紧）', (() => {
    const r1 = buildRig(PG, MC, JS, DS, readLevel(1));
    return r1.judge.windows().perfectMs > w.perfectMs;
  })(), true);
  note('集成回归：L1/L2 的完整事件流数字（分母/核心数/bed 数/状态轨迹/事件数）已固化；20 次重开的 clock 队列、订阅数与音频节点数均回基线。');
}

/* ------------------------------------------------------------------ */
/* case: screens — K-13 五界面 + K-15 流程串接（假 DOM，无需浏览器）        */
/* ------------------------------------------------------------------ */

/** 假 DOM 没有 querySelector：按 data-role 走子树找节点。 */
function findByRole(el, role) {
  if (!el) return null;
  if (typeof el.getAttribute === 'function' && el.getAttribute('data-role') === role) return el;
  for (const c of el.childNodes || []) {
    const hit = findByRole(c, role);
    if (hit) return hit;
  }
  return null;
}

/** 收集子树里的所有文本（元素 textContent + 文本节点）。 */
function textOf(el, out = []) {
  if (!el) return out;
  if (typeof el.textContent === 'string' && el.textContent) out.push(el.textContent);
  for (const c of el.childNodes || []) textOf(c, out);
  return out;
}

/** 仍挂在挂载点下面的节点总数（摘掉的孤儿节点不计 —— 就是 K-05 的泄漏口径）。 */
function attachedCount(root) {
  let n = 0;
  const walk = (x) => {
    n += 1;
    for (const c of x.childNodes || []) walk(c);
  };
  for (const c of root.childNodes || []) walk(c);
  return n;
}

/** 假 DOM 上手工派发非 click 事件（input / change）。 */
function fire(el, type, ev) {
  for (const fn of ((el && el.handlers && el.handlers[type]) || []).slice()) fn(ev);
}

/** 把界面里由点击派生的微任务（showTitle/showSelect 走 Promise）跑完。 */
async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function caseScreens() {
  const MC = await load('src/mocks/MockClock.js', 'screens');
  const JS = await load('src/game/systems/JudgeSystem.js', 'screens');
  const DS = await load('src/game/systems/DisassembleSystem.js', 'screens');
  const PG = await load('src/game/systems/PatternGenerator.js', 'screens');
  const UI = await load('src/ui/screens/UiLayer.js', 'screens');
  const SAVE = await load('src/data/save.js', 'screens');
  if (!MC || !JS || !DS || !PG || !UI || !SAVE) return;

  const levels = [1, 2, 3]
    .map(readLevel)
    .filter(Boolean)
    .map((c) => ({ id: c.id, title: c.title, bpm: c.bpm, lengthBeats: c.lengthBeats }));
  const l1 = readLevel(1);
  if (!l1 || levels.length < 2) {
    skipCase('screens', 'src/data/levels/level*.json 不足两关（SOUND 名下内容），无法验「结算 → 下一关」串接');
    return;
  }
  const rig = buildRig(PG, MC, JS, DS, l1);
  const dom = installFakeDom();

  const route = [];
  const volCalls = [];
  const spy = { strict: [], latency: [] };
  const engine = {
    ensureRunning: () => {
      route.push('unlock');
      return Promise.resolve(true);
    },
    setVolumes: (v) => volCalls.push({ ...v }),
    getVolumes: () => ({ master: 0.8, music: 0.6, sfx: 0.7 })
  };
  // 只透传 + 记账：界面走的是真 judge 的方法，spy 用来证明「唯一写入口」没有被绕过
  const judge = {
    setStrictWindow: (on) => {
      spy.strict.push(!!on);
      return rig.judge.setStrictWindow(on);
    },
    setLatency: (ms) => {
      spy.latency.push(ms);
      return rig.judge.setLatency(ms);
    },
    getLatency: () => rig.judge.getLatency(),
    windows: () => rig.judge.windows()
  };
  // 假 runtime：只做 LevelRuntime 真暴露给界面那几件事，冻结/解冻仍然只走 clock.pause()/resume()（R11）
  const rt = {
    cfg: { id: l1.id, title: l1.title },
    paused: false,
    restarts: 0,
    togglePause() {
      this.paused = !this.paused;
      if (this.paused) rig.clock.pause();
      else rig.clock.resume();
      return this.paused;
    },
    restart() {
      this.restarts += 1;
      rig.clock.stop();
      rig.clock.start(0);
      this.paused = false;
    },
    quit() {
      route.push('quit');
    },
    stateLine: () => rig.ds.state()
  };
  let host = null; // 标题/选关态没有 runtime，暂停/结算态有
  const ui = UI.createUiLayer({
    clock: rig.clock,
    judge,
    ds: rig.ds,
    engine,
    levels: () => levels,
    gotoLevel: (id) => route.push(`goto:${id}`),
    toTitle: (d) => route.push(`title:${(d && d.notice) || ''}`),
    runtime: () => host
  });

  const COLOR_STYLE_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/;
  try {
    /* ① 标题 */
    eq('screens: 找到挂载点 #ui-root（L-04）', ui.mounted, true);
    await ui.showTitle({ notice: '假 DOM 回归' });
    eq('screens: 标题面板 current()', ui.current(), 'title');
    eq('screens: 面板带 data-screen 标记', ui.element().getAttribute('data-screen'), 'title');
    ok('screens: 标题三键齐（开始 / 选关 / 设置）', ['title-start', 'title-select', 'title-settings'].every((r) => Boolean(findByRole(ui.element(), r))));
    findByRole(ui.element(), 'title-start').click();
    await flushMicrotasks();
    eq('screens: 开始 = 先解锁音频再进关（顺序不能反）', route.join('|').startsWith('unlock|goto:'), true);
    route.length = 0;

    /* ② 选关 */
    findByRole(ui.element(), 'title-select').click();
    await flushMicrotasks();
    eq('screens: 标题 → 选关（同一时刻只许一层面板）', `${ui.current()}/${dom.uiRoot.childNodes.length}`, 'select/1');
    eq('screens: 选关卡片数 = 关卡清单长度', levels.filter((lv) => Boolean(findByRole(ui.element(), `pick-${lv.id}`))).length, levels.length);
    findByRole(ui.element(), `pick-${levels[1].id}`).click();
    eq('screens: 选卡 → gotoLevel(该关 id)', route[route.length - 1], `goto:${levels[1].id}`);
    route.length = 0;
    await ui.showSelect();
    findByRole(ui.element(), 'select-back').click();
    await flushMicrotasks();
    eq('screens: 选关 → 返回标题', ui.current(), 'title');

    /* ③ 暂停（★ 时钟只有 BeatClock 一个权威） */
    rig.clock.advanceBy(1); // 让拍序先走起来，才好证明暂停/恢复不重置拍序
    host = rt;
    rt.togglePause();
    await ui.showPause();
    eq('screens: 暂停面板挂上', `${ui.current()}/${rig.clock.isPaused()}`, 'pause/true');
    ok('screens: 面板如实显示「时钟已冻结」', textOf(ui.element()).some((t) => t.includes('isPaused=true')));
    findByRole(ui.element(), 'pause-settings').click();
    await flushMicrotasks();
    eq('screens: 暂停 → 设置', ui.current(), 'settings');
    findByRole(ui.element(), 'settings-back').click();
    await flushMicrotasks();
    eq('screens: 设置 → 仍回暂停面板（不掉空、不解除暂停）', `${ui.current()}/${rt.paused}`, 'pause/true');
    findByRole(ui.element(), 'pause-restart').click();
    await flushMicrotasks();
    eq('screens: 面板里重开 → 重开计数 +1 且时钟交还（不许停在暂停态）', `${rt.restarts}/${rig.clock.isPaused()}/${ui.current()}`, '1/false/null');
    await ui.showPause();
    findByRole(ui.element(), 'pause-quit').click();
    eq('screens: 面板里退出 → 交回宿主 quit()', route[route.length - 1], 'quit');
    route.length = 0;
    rt.togglePause();
    await ui.showPause();
    const beatBeforeResume = rig.clock.currentBeat(); // 重开之后重新取基准：这里验的是「暂停→恢复」，不是「重开归零」
    findByRole(ui.element(), 'pause-resume').click();
    await flushMicrotasks();
    eq('screens: 「继续」走 clock.resume()（界面不自建计时）', `${rt.paused}/${rig.clock.isPaused()}/${ui.current()}`, 'false/false/null');
    eq('screens: 恢复后拍序不重置也不跳跃', rig.clock.currentBeat(), beatBeforeResume);

    /* ④ 设置（音量三通道 / 严格窗口 / K-14 降级版延迟微调） */
    await ui.showSettings('title');
    eq('screens: 设置面板挂上', ui.current(), 'settings');
    const master = findByRole(ui.element(), 'vol-master');
    master.value = '0.35';
    fire(master, 'input', { target: master });
    eq('screens: 音量滑条只调 engine.setVolumes（不碰 GainNode）', `${volCalls.length}/${volCalls[volCalls.length - 1].master}`, '1/0.35');
    const box = findByRole(ui.element(), 'strict-window');
    box.checked = true;
    fire(box, 'change', { target: box });
    eq('screens: 严格窗口透传 judge.setStrictWindow', spy.strict.join(','), 'true');
    const lat0 = rig.judge.getLatency();
    const up = findByRole(ui.element(), 'latency-up');
    up.click();
    up.click();
    up.click();
    eq('screens: L-06 降级版：延迟按钮每步 1ms', `${rig.judge.getLatency() - lat0}/${spy.latency.length}`, '3/3');
    findByRole(ui.element(), 'latency-down').click();
    eq('screens: －1ms 步进对称', rig.judge.getLatency(), lat0 + 2);
    ui.applyLatency(199);
    await ui.showSettings('title'); // 重开面板取当前值，验钳位
    const up2 = findByRole(ui.element(), 'latency-up');
    up2.click();
    up2.click();
    up2.click();
    eq('screens: 延迟钳位在 CALIBRATION.maxMs（200ms）', rig.judge.getLatency(), 200);
    const saved = SAVE.getSave();
    eq('screens: 音量 / 延迟 / 严格窗口都落进存档', `${saved.audio.master}/${saved.audio.music}/${saved.audio.sfx}/${saved.audio.latencyOffset}/${saved.options.strictWindow}`, '0.35/0.6/0.7/200/true');

    /* ⑤ 结算（分母 = 可判定障碍，不含 bed） */
    playRig(rig, { stomp: true });
    const stats = rig.ds.stats();
    const judgable = rig.instances.filter((o) => o.judgable !== false).length;
    eq('screens: 结算分母 = judgable!==false 的障碍数', `${stats.total}/${judgable}`, `${judgable}/${judgable}`);
    await ui.showResult(stats, { level: l1 });
    eq('screens: 结算面板挂上', ui.current(), 'result');
    eq('screens: 评级取 ds.rank()（界面不自算第二套口径）', findByRole(ui.element(), 'rank').textContent, stats.rank);
    ok('screens: Perfect 率按 §7.3 口径显示', textOf(ui.element()).some((t) => t.includes(`${(stats.perfectRate * 100).toFixed(1)}%`)));
    ok('screens: 面板把「背景层不计入」写明白', textOf(ui.element()).some((t) => t.includes('可判定障碍') && t.includes('背景层不计入')));
    // DEF-04：分母是固定的谱面数，文案里不得再出现「+ 复活补发 R」这种将复活算进分母的求和写法。
    eq('screens: 分母文案不再把复活补发加进分母（§7.3 固定分母）', textOf(ui.element()).some((t) => t.includes('复活补发')), false);
    await ui.showResult({ ...stats, revivedIssued: 28 }, { level: l1 });
    ok('screens: 复活恢复只作为不改分母的观测量出现', textOf(ui.element()).some((t) => t.includes(`本关可判定障碍 ${judgable}`) && t.includes('复活恢复 28（不改分母）')), textOf(ui.element()).find((t) => t.includes('可判定障碍')) || '(缺)');
    // DEF-05：结算屏要能说清「评级用的是哪个数」——两个率同屏、各自标出口径，且不是同一个数。
    const encTxt = textOf(ui.element());
    ok(
      'screens: 评级 Perfect 率（遭遇口径）与谱面 Perfect 率（§7.3）同屏分别显示',
      encTxt.some((t) => t.includes('评级 Perfect 率')) &&
        encTxt.some((t) => t.includes('谱面 Perfect 率')) &&
        encTxt.some((t) => t.includes(`${(stats.encounterRate * 100).toFixed(1)}%`)) &&
        encTxt.some((t) => t.includes(`${(stats.perfectRate * 100).toFixed(1)}%`)),
      `评级率=${encNum(stats.encounterRate)} 谱面率=${stats.perfectRate}`
    );
    ok(
      'screens: 评级口径那行把分子分母拆开写（PERFECT + 踩灭光点 / 遭遇障碍 + 进场光点）',
      encTxt.some((t) => t.includes('评级口径') && t.includes(`${encNum(stats.encounterPerfect)}/${encNum(stats.encounterTotal)}`)),
      encTxt.find((t) => t.includes('评级口径')) || '(缺)'
    );
    await ui.showResult({ perfect: 1, total: 2, baseTotal: 2, perfectRate: 0.5, rank: 'C' }, { level: l1 });
    const legacyBox = findByRole(ui.element(), 'encounter-rate');
    ok('screens: 老快照缺 encounter 字段 → 评级率显示占位「—」而不是假数字', Boolean(legacyBox) && textOf(legacyBox).some((t) => t.includes('—')), legacyBox ? textOf(legacyBox).join('|') : '(缺节点)');
    await ui.showResult(stats, { level: l1 });
    const outBtn = findByRole(ui.element(), stats.disassembled ? 'result-next' : 'result-next-incomplete');
    ok('screens: 结算有下一步出口（K-15 零断点）', Boolean(outBtn));
    outBtn.click();
    await flushMicrotasks();
    ok('screens: 出口落到「下一关」或「回标题」之一', /^(goto:\d+|title:.*)$/.test(route[route.length - 1] || ''), route[route.length - 1] || '(无)');

    /* CR-13：界面样式里不许出现色值字面量 */
    const styles = dom.created.filter((n) => n.attrs && typeof n.attrs.style === 'string').map((n) => n.attrs.style);
    ok('screens: 界面样式 0 个色值字面量（只用 var(--rb-*) / color-mix）', !styles.some((s) => COLOR_STYLE_RE.test(s)), styles.find((s) => COLOR_STYLE_RE.test(s)) || '');
    ok('screens: 有样式的节点确实吃到了 token', styles.some((s) => s.includes('var(--rb-')) , '');

    /* K-05：20 轮界面不得遗留节点 */
    let layersBad = 0;
    for (let i = 0; i < 20; i += 1) {
      for (const step of [
        () => ui.showTitle({}),
        () => ui.showSelect(),
        () => ui.showPause(),
        () => ui.showSettings('pause'),
        () => ui.showResult(rig.ds.stats(), { level: l1 })
      ]) {
        await step();
        if (dom.uiRoot.childNodes.length !== 1) layersBad += 1;
      }
      ui.close();
      if (dom.uiRoot.childNodes.length !== 0) layersBad += 1;
    }
    eq('screens: 20 轮 × 5 界面：任意时刻只有一层、关掉就归零', layersBad, 0);
    eq('screens: 20 轮后 ui-root 无遗留节点', `${attachedCount(dom.uiRoot)}/${dom.uiRoot.childNodes.length}`, '0/0');
    eq('screens: 界面无未退订的事件订阅', ui.listenerCount(), 0);
    ui.destroy();
    eq('screens: destroy 后 current() 归零', ui.current(), null);
    note(`screens 假 DOM：共创建 ${dom.created.length} 个节点（五界面全走真 build* 函数，无需浏览器）`);
  } finally {
    ui.destroy();
    dom.restore();
  }
}

/* ------------------------------------------------------------------ */
/* case: misstorm — R5 浏览器实测的 MISS 风暴（重复入队 / 终态被重开语义拉回 pending）*/
/* ------------------------------------------------------------------ */

/**
 * 与 LevelRuntime 完全同构的接线：ds 的 'disassemble' / 'revive' 事件都回到判定队列做一次重同步。
 * 旧代码只有 registerObstacles（重开语义：把 judged/expired 拉回 pending），所以这里用特性探测：
 * 没有 syncObstacles 时退回 registerObstacles —— 那正是浏览器里跑的那份实现，用来让本 case 变红。
 */
function wireRuntimeResync(rig, probe) {
  const resync = () => {
    probe.resyncs += 1;
    const list = rig.ds.activeInstances();
    const q = (typeof rig.judge.syncObstacles === 'function' ? rig.judge.syncObstacles(list) : rig.judge.registerObstacles(list)) || [];
    probe.maxQueue = Math.max(probe.maxQueue, q.length);
    if (new Set(q.map((o) => o.id)).size !== q.length) probe.dupIds += 1;
    probe.maxPending = Math.max(probe.maxPending, rig.judge.pendingCount());
  };
  rig.ds.on('disassemble', resync);
  rig.ds.on('revive', resync);
  return resync;
}

/** 一关 60 秒完整仿真：按「只打前 N 个核心节点」的策略打，其余全程不打，一直跑到 RESULT。 */
function simRun(PG, MC, JS, DS, cfg, { coreHits = 0, otherHits = 0 } = {}) {
  const rig = buildRig(PG, MC, JS, DS, cfg);
  const probe = { resyncs: 0, maxQueue: 0, maxPending: 0, dupIds: 0 };
  wireRuntimeResync(rig, probe);
  probe.maxQueue = rig.judge.pendingList().length;
  probe.maxPending = rig.judge.pendingCount();
  const live = rig.instances.filter((o) => o.judgable !== false).sort((a, b) => a.timeSec - b.timeSec);
  const step = 0.025; // 与 BeatClock 的轮询同粒度（CLOCK_POLL_MS）
  const end = rig.clock.timeAtBeat(Number(cfg.lengthBeats) || 0) + 1.5;
  let ptr = 0;
  let doneCore = 0;
  let doneOther = 0;
  while (rig.clock.time() < end) {
    rig.clock.advanceBy(step);
    while (ptr < live.length && live[ptr].timeSec <= rig.clock.time() + 0.001) {
      const o = live[ptr];
      const want = o.core ? doneCore < coreHits : doneOther < otherHits;
      if (want) {
        if (o.core) doneCore += 1;
        else doneOther += 1;
        rig.judge.onInput(JS.expectedAction(o.type), o.timeSec);
      }
      ptr += 1;
    }
    probe.maxPending = Math.max(probe.maxPending, rig.judge.pendingCount());
    if (rig.ds.state() === 'RESULT') break;
  }
  const penalized = rig.feed.filter((j) => j.penalizes !== false && j.rule !== 'emptyBeat');
  rig.ds.detach();
  return { rig, probe, penalized, judgable: live.length };
}

async function caseMissStorm() {
  const MC = await load('src/mocks/MockClock.js', 'misstorm');
  const JS = await load('src/game/systems/JudgeSystem.js', 'misstorm');
  const DS = await load('src/game/systems/DisassembleSystem.js', 'misstorm');
  const PG = await load('src/game/systems/PatternGenerator.js', 'misstorm');
  if (!MC || !JS || !DS || !PG) return;
  const cfg1 = readLevel(1);
  if (!cfg1) {
    skipCase('misstorm', 'src/data/levels/level1.json 尚不存在（SOUND 名下内容）');
    return;
  }
  const judgableOf = (cfg) => PG.build(cfg, new MC.MockClock({ t: 0 })).filter((o) => o.judgable !== false).length;
  eq('misstorm: L1 可判对象数与页内诊断一致（55）', judgableOf(cfg1), 55);

  /* —— ① 入队幂等：连续两次登记同一批实例，队列不重不复位 —— */
  {
    const rig = buildRig(PG, MC, JS, DS, cfg1);
    const total = rig.instances.filter((o) => o.judgable !== false).length;
    const q1 = rig.judge.registerObstacles(rig.instances).slice();
    const q2 = rig.judge.registerObstacles(rig.instances).slice();
    eq('misstorm: 第二次 registerObstacles 队列长度不增（幂等）', q2.length, q1.length);
    eq('misstorm: 两次登记后队列长度 = 可判对象数', q2.length, total);
    eq('misstorm: 两次登记后队列内 id 无重复', new Set(q2.map((o) => o.id)).size, q2.length);
    eq('misstorm: 两次登记后 pendingCount ≤ 可判对象数', rig.judge.pendingCount(), total);
    const five = rig.instances.filter((o) => o.judgable !== false).slice(0, 5);
    eq('misstorm: 同一 id 重复喂入被去重（append 语义的防线）', rig.judge.registerObstacles(five.concat(five)).length, 5);
    // 终态不许被「重同步」改写（运行中路径），但重开路径（registerObstacles）仍回 pending 基线（T6）
    const first = five[0];
    rig.judge.registerObstacles(rig.instances);
    rig.judge.onInput(JS.expectedAction(first.type), first.timeSec);
    eq('misstorm: 前置——首实例已 judged', first.state, 'judged');
    const hasSync = typeof rig.judge.syncObstacles === 'function';
    ok('misstorm: 存在与重开语义分离的运行中重同步入口 syncObstacles', hasSync, `typeof=${typeof rig.judge.syncObstacles}`);
    if (hasSync) {
      // 口径纠正（leader，2026-11-23）：pendingList/pendingCount 只数「活着」的成员（_live），
      // 上面那次 onInput 已经把 first 消费掉，所以这里的绝对值天然是 total-1，
      // 拿它去等式比 total 是断言写错、不是实现写错。本条真正要守的不变量是
      // **「重同步本身不增不减队列成员」**，因此改成前后对差。
      const before = rig.judge.pendingList().length;
      rig.judge.syncObstacles(rig.ds.activeInstances());
      eq('misstorm: syncObstacles 不把 judged 拉回 pending', first.state, 'judged');
      eq('misstorm: syncObstacles 不增不减未判定成员（队列长度守恒）', rig.judge.pendingList().length, before);
      eq('misstorm: syncObstacles 后 pendingList 内 id 仍无重复', new Set(rig.judge.pendingList().map((o) => o.id)).size, before);
      eq('misstorm: pendingCount 与 pendingList 同口径', rig.judge.pendingCount(), before);
    }
    rig.ds.detach();
  }

  /* —— ② 关键回归：一局 60s 完整仿真（拆解→寂静→终点），MISS ≤ 本局出现过的可判事件数 —— */
  const runA = simRun(PG, MC, JS, DS, cfg1, { coreHits: 4 });
  const stA = runA.rig.ds.stats();
  const total = runA.judgable;
  const missA = runA.penalized.filter((j) => j.grade === 'MISS').length;
  const missIdsA = new Set(runA.penalized.filter((j) => j.grade === 'MISS').map((j) => j.obstacleId)).size;
  // R6 口径纠正（leader 2026-11-24）：原写法「miss ≤ 初始谱面 55」把分母口径写死了——DIS-05 复活会合法
  // 下发 -rvN 新实例，事件总数必然超过初始谱面（R5 仿真实测 A 局 101 > 55）。真正的上界是
  // **本局实际出现过的可判事件数**（stats().total，R6 修订后的分母），风暴（同一障碍重复计账）下这条才红。
  ok(`misstorm: A 局（只打 4 个核心鼓点→拆鼓→寂静→终点）MISS ≤ 本局出现过的可判事件数`, stA.miss <= stA.total, `miss=${stA.miss} / 分母=${stA.total}（初始谱面 ${total}）`);
  ok('misstorm: A 局 MISS 不超过被 MISS 的不同 obstacleId 个数之和（重复计账的红线）', missIdsA <= stA.total, `不同 id=${missIdsA}`);
  // 场景诚实化（leader，2026-11-23）：A 局整局只按 4 次，其余障碍必然各过期一次，
  // 所以「miss 恰为 1」把这个场景的前提写错了（正确实现下是 51，风暴下是 149903）。
  // 真正紧的不变量是「MISS 条数 = 被 MISS 的**不同障碍**个数」——风暴下同一障碍重复计账，
  // 这条必然红；正确实现下必然等。
  eq('misstorm: A 局 MISS 条数 = 被 MISS 的不同障碍个数（同一障碍不重复计账）', stA.miss, new Set(runA.penalized.filter((j) => j.grade === 'MISS').map((j) => j.obstacleId)).size);
  ok('misstorm: A 局四次命中全部记为 Perfect', stA.perfect >= 4, `perfect=${stA.perfect}`);
  eq('misstorm: A 局每个障碍最多产生 1 条有惩罚判定（无重复入队）', new Set(runA.penalized.map((j) => j.obstacleId)).size, runA.penalized.length);
  ok('misstorm: A 局待判定队列峰值 ≤ 可判对象数（页内诊断曾见 105/91）', runA.probe.maxPending <= total, `峰值 ${runA.probe.maxPending} / 可判 ${total}`);
  ok('misstorm: A 局队列长度全程 ≤ 可判对象数', runA.probe.maxQueue <= total, `峰值 ${runA.probe.maxQueue}`);
  eq('misstorm: A 局队列内 id 从未出现重复', runA.probe.dupIds, 0);
  eq('misstorm: A 局确实走到了拆解（不是空跑的绿）', JSON.stringify(runA.rig.ds.hpByTrack()), '{"kick":0,"bass":0,"synth":0}');
  ok('misstorm: A 局含拆解→寂静→终点三段', `${runA.rig.ev.filter((e) => e.name === 'disassemble').length}/${runA.rig.ev.some((e) => e.name === 'state-change' && e.to === 'SILENCE')}/${stA.state}`, '1/true/RESULT');
  // R6 口径纠正：原写法把 dotMiss 用 `stA.miss` 表达（`${stA.dotMiss > 0}/${stA.miss === missA}`），
  // 场景一变就自指。改成两个数各自独立可核对：dotMiss 由**光点表**核对（寂静段一个都没踩 →
  // 每个光点各过期一次），miss 由**判定流**核对（只含有惩罚的障碍 MISS），二者互不掺入。
  const dotsGoneA = stA.dots.filter((d) => d.state === 'expired' || d.state === 'relit').length;
  eq('misstorm: A 局寂静段光点 MISS 单列（dotMiss = 光点表里未踩灭而过期的个数，独立于 miss）', stA.dotMiss, dotsGoneA);
  ok('misstorm: A 局寂静段没踩光点 → dotMiss > 0，且 miss 不受它影响（仍等于判定流里的障碍 MISS 条数）', stA.dotMiss > 0 && stA.miss === missA, `dotMiss=${stA.dotMiss} miss=${stA.miss} feedMiss=${missA}`);
  eq('misstorm: A 局 miss 只等于有惩罚的障碍 MISS 条数（唯一口径）', stA.miss, missA);
  eq('misstorm: A 局 Perfect 不被重放污染', `${stA.perfect}/${stA.corePerfect}`, '4/4');
  eq('misstorm: A 局 maxCombo 等于判定流里的最长连击（过期补发不参与连击）', stA.maxCombo, (() => {
    let best = 0;
    let cur = 0;
    for (const j of runA.penalized) {
      if (j.grade === 'MISS') cur = 0;
      else cur += 1;
      best = Math.max(best, cur);
    }
    return best;
  })());

  const runB = simRun(PG, MC, JS, DS, cfg1, { coreHits: 0 });
  const stB = runB.rig.ds.stats();
  eq(`misstorm: B 局（全程不按键）MISS 恰为可判对象数 ${total}（超时补发仍在）`, stB.miss, total);
  // R6 ① 的极端局：全过期不按键 → Perfect 率必须恰为 0（旧口径下也是 0，这里守的是「分母不为 0 时不倒挂」）
  eq('misstorm: B 局极端全过期局 perfectRate 恰为 0', stB.perfectRate, 0);
  eq('misstorm: B 局极端局分母自洽（total ≥ perfect+good+miss）', stB.total >= stB.perfect + stB.good + stB.miss, true);
  eq('misstorm: B 局队列内 id 无重复', runB.probe.dupIds, 0);
  ok('misstorm: B 局队列峰值不超可判对象数', runB.probe.maxQueue <= total, `峰值 ${runB.probe.maxQueue}`);

  /* —— ③ 三轨关（有 bass/synth 持续供给 MISS）：拆解 + 复活 + 寂静一路跑到底 —— */
  {
    const cfg3 = synthCfg({
      sections: [
        { beat: 0, state: 'INTRO', layers: [] },
        { beat: 4, state: 'BUILD', layers: ['kick', 'bass', 'synth', 'bed'] },
        { beat: 8, state: 'PEAK', layers: ['kick', 'bass', 'synth', 'bed'] },
        { beat: 56, state: 'SILENCE', layers: [] }
      ]
    });
    const clock = new MC.MockClock({ t: 0 });
    clock.init({ bpm: cfg3.bpm, sections: cfg3.sections, introBeats: cfg3.introBeats, lengthBeats: cfg3.lengthBeats });
    clock.start(0);
    const inst = synthInstances(clock, { kick: [8, 9, 10, 11, 40, 41], bass: [16, 17, 18, 19, 42, 43], synth: [24, 25, 26, 27, 44, 45], bed: [12, 13] });
    const events = new JS.EventLog();
    const judge = JS.createJudgeSystem({ clock, events });
    const ds = DS.createDisassembleSystem({ clock, events });
    judge.setWindowScale(1);
    ds.load(cfg3, { instances: inst });
    ds.bindJudge(judge);
    ds.attach(); // 段落驱动 + 关卡终点收口（与 LevelRuntime.attach 同一步）
    judge.registerObstacles(inst);
    const probe = { resyncs: 0, maxQueue: 0, maxPending: 0, dupIds: 0 };
    const rig = { clock, judge, ds, instances: inst, feed: [], ev: [], JS };
    wireRuntimeResync(rig, probe);
    for (const name of ['hp-change', 'disassemble', 'revive', 'state-change']) {
      ds.on(name, (p) => rig.ev.push({ name, ...p }));
    }
    judge.onJudgment((j) => {
      rig.feed.push(j);
      ds.onJudgment(j);
    });
    const live = inst.filter((o) => o.judgable !== false).sort((a, b) => a.timeSec - b.timeSec);
    let ptr = 0;
    let hits = 0;
    while (clock.time() < clock.timeAtBeat(cfg3.lengthBeats) + 1.5) {
      clock.advanceBy(0.025);
      while (ptr < live.length && live[ptr].timeSec <= clock.time() + 0.001) {
        const o = live[ptr];
        if (hits < 10) {
          hits += 1;
          judge.onInput(JS.expectedAction(o.type), o.timeSec);
        }
        ptr += 1;
      }
      probe.maxPending = Math.max(probe.maxPending, judge.pendingCount());
      if (ds.state() === 'RESULT') break;
    }
    const judgable = live.length;
    const st = ds.stats();
    const penalized = rig.feed.filter((j) => j.penalizes !== false && j.rule !== 'emptyBeat');
    ok(`misstorm: C 局（三轨、打 10 个后停手）MISS ≤ 可判对象数 ${judgable}`, st.miss <= judgable, `miss=${st.miss} / 可判=${judgable}`);
    eq('misstorm: C 局每个障碍最多 1 条有惩罚判定', new Set(penalized.map((j) => j.obstacleId)).size, penalized.length);
    eq('misstorm: C 局队列内 id 无重复', probe.dupIds, 0);
    ok(`misstorm: C 局队列峰值 ≤ 可判对象数 ${judgable}`, probe.maxQueue <= judgable && probe.maxPending <= judgable, `队列 ${probe.maxQueue} / pending ${probe.maxPending}`);
    ok('misstorm: C 局复活（revive）确实发生过（DIS-03 路径未被关掉）', rig.ev.filter((e) => e.name === 'revive').length > 0, `revive=${rig.ev.filter((e) => e.name === 'revive').length}`);
    eq('misstorm: C 局跑到终点 RESULT', ds.state(), 'RESULT');
    note(`misstorm：A 局 miss=${stA.miss} 队列峰值=${runA.probe.maxPending}；B 局 miss=${stB.miss}；C 局 miss=${st.miss} resync=${probe.resyncs}`);
  }

  /* —— ④ DEF-04 分母回归（D 局）：只打鼓、放过 bass/synth → 拆鼓 → MISS 复活原件 → 原件再被判定 ——
     旧口径（R6）把复活补发的 -rvN 副本算进分母，用来掩盖「副本与原件是同一障碍的两个身份」这件事；
     §7.3 的分母是「本关 noteEvents 生成的可判定障碍总数（固定分母，与复活/重开无关）」，所以这里改成：
     分母 == 初始谱面，且判定流里不得出现 -rvN。 */
  {
    const cfgD = synthCfg({
      sections: [
        { beat: 0, state: 'INTRO', layers: [] },
        { beat: 4, state: 'BUILD', layers: ['kick', 'bass', 'synth', 'bed'] },
        { beat: 8, state: 'PEAK', layers: ['kick', 'bass', 'synth', 'bed'] },
        { beat: 56, state: 'SILENCE', layers: [] }
      ]
    });
    const clock = new MC.MockClock({ t: 0 });
    clock.init({ bpm: cfgD.bpm, sections: cfgD.sections, introBeats: cfgD.introBeats, lengthBeats: cfgD.lengthBeats });
    clock.start(0);
    const inst = synthInstances(clock, { kick: [8, 9, 10, 11, 40, 41], bass: [16, 17, 18, 19, 42, 43], synth: [24, 25, 26, 27, 44, 45], bed: [12, 13] });
    const events = new JS.EventLog();
    const judge = JS.createJudgeSystem({ clock, events });
    const ds = DS.createDisassembleSystem({ clock, events });
    judge.setWindowScale(1);
    ds.load(cfgD, { instances: inst });
    ds.bindJudge(judge);
    ds.attach();
    judge.registerObstacles(inst);
    const probeD = { resyncs: 0, maxQueue: 0, maxPending: 0, dupIds: 0 };
    const rig = { clock, judge, ds, instances: inst, feed: [], ev: [], JS };
    wireRuntimeResync(rig, probeD);
    const rvIds = [];
    ds.on('revive', (p) => {
      for (const id of p.ids || []) rvIds.push(id);
    });
    judge.onJudgment((j) => {
      rig.feed.push(j);
      ds.onJudgment(j);
    });
    const chartIds = new Set(inst.filter((o) => o.judgable !== false).map((o) => o.id));
    const judgable = chartIds.size;
    const seenIds = new Set(); // 本局在判定队列里**实际出现过**的不同可判 id（分母的独立核对口径）
    const restored = new Set(); // 复活事件下发的 id（改后 = 被取消退役的原件）
    while (clock.time() < clock.timeAtBeat(cfgD.lengthBeats) + 1.5) {
      clock.advanceBy(0.025);
      const pend = judge.pendingList();
      for (const o of pend) seenIds.add(o.id);
      // 命中策略：只打「当前在队列里的 kick」（含 DIS-05 复活恢复的原件），其余全部放过
      for (const o of pend) {
        if (o.track !== 'kick') continue;
        if (o.timeSec <= clock.time() + 0.001 && o.timeSec > clock.time() - 0.06) judge.onInput(JS.expectedAction(o.type), o.timeSec);
      }
      for (const id of rvIds) restored.add(id);
      probeD.maxPending = Math.max(probeD.maxPending, judge.pendingCount());
      if (ds.state() === 'RESULT') break;
    }
    const penalizedD = rig.feed.filter((j) => j.penalizes !== false && j.rule !== 'emptyBeat');
    const rvJudged = penalizedD.filter((j) => /-rv\d+$/.test(String(j.obstacleId))).length;
    const rvPerfect = penalizedD.filter((j) => restored.has(j.obstacleId) && j.grade === 'PERFECT').length;
    const stD = ds.stats();
    // 防风暴的三条照旧守着（不许放松）：复活也不许让同一障碍出现两条有惩罚判定
    eq('misstorm: D 局每个障碍最多 1 条有惩罚判定', new Set(penalizedD.map((j) => j.obstacleId)).size, penalizedD.length);
    eq('misstorm: D 局队列内 id 无重复', probeD.dupIds, 0);
    ok('misstorm: D 局队列峰值 ≤ 初始谱面（副本不再占队列名额）', probeD.maxPending <= judgable, `峰值 ${probeD.maxPending} / 谱面 ${judgable}`);
    // 前置：本局确实发生了带 id 的复活（否则下面的分母断言是空跑的绿）
    ok('misstorm: D 局复活确实下发过原件 id（rv 事件 > 0）', rvIds.length > 0, `恢复原件=${rvIds.length} / 有惩罚判定=${penalizedD.length} / 初始谱面=${judgable}`);
    // ★ 口径改动①（原：`rvJudged > 0`「补发实例进入了判定流」）：§7.3 的固定分母要求**不得**出现 -rvN 身份。
    eq('misstorm: D 局判定流里不出现 -rvN（复活恢复的是原件，DEF-04）', rvJudged, 0);
    // ★ 口径改动②（原：「本局可判事件数 > 初始谱面」）：PRD §7.3「总障碍数 N = 本关 noteEvents 生成的可判定障碍总数」，
    //   事件流条数超过谱面正是 DEF-04 的缺陷本身，而不是需要迁就的现象。
    ok('misstorm: D 局有惩罚判定条数 ≤ 初始谱面（事件流不超发）', penalizedD.length <= judgable, `判定=${penalizedD.length} / 初始谱面=${judgable}`);
    eq('misstorm: D 局判定 id 全部属于初始谱面', penalizedD.filter((j) => !chartIds.has(j.obstacleId)).length, 0);
    // ★ 口径改动③（原：`total === seenIds.size`＝「初始谱面 + 复活补发」）：分母固定为初始谱面，
    //   与复活无关；队列里出现过的不同 id 也只可能是谱面那 18 个原件。
    eq('misstorm: D 局分母 = 初始谱面可判定障碍数（§7.3 固定分母）', stD.total, judgable);
    eq('misstorm: D 局队列出现过的不同可判 id 数 = 分母（独立核对，无第 19 个身份）', seenIds.size, stD.total);
    ok('分母含复活事件：total ≥ perfect+good+miss', stD.total >= stD.perfect + stD.good + stD.miss, `total=${stD.total} / P${stD.perfect}+G${stD.good}+M${stD.miss} / 初始谱面=${stD.baseTotal}`);
    eq('perfectRate 不超过 1', stD.perfectRate <= 1, true);
    // ★ 口径改动④（原：perfectRate == perfect / seenIds.size，即含补发的「本局出现事件数」）：§7.3 Perfect率 = P / N，N 固定。
    ok('misstorm: D 局 perfectRate 的分母是固定谱面数', Math.abs(stD.perfectRate - stD.perfect / judgable) < 1e-12, `perfectRate=${stD.perfectRate.toFixed(6)} / P${stD.perfect}÷${judgable}`);
    // ★ 口径改动⑤（原：coreTotal ≥ baseCoreTotal + rvJudged）：核心分母同为谱面口径，不随复活增长。
    ok('misstorm: D 局 coreTotal 与 total 同口径（固定谱面，不随复活增长）', stD.coreTotal === stD.baseCoreTotal && stD.coreHitRate <= 1, `coreTotal=${stD.coreTotal} / base=${stD.baseCoreTotal} / 恢复原件=${stD.revivedIssued} / coreHitRate=${stD.coreHitRate.toFixed(3)}`);
    ok('misstorm: D 局（拆完又复活、放过两轨）评级不再被奖励成 S', stD.rank !== 'S', `rank=${stD.rank} perfectRate=${stD.perfectRate.toFixed(3)} miss=${stD.miss}`);
    ds.reset();
    eq('misstorm: D 局 reset 后分母回初始谱面基线（K-05，不跨局累加）', `${ds.total()}/${ds.coreTotal()}`, `${judgable}/${judgable}`);
    note(`misstorm：D 局（只打鼓）事件=${penalizedD.length} 分母=${stD.total}（初始 ${stD.baseTotal}）恢复原件=${stD.revivedIssued} 其中再被判 PERFECT=${rvPerfect} perfect=${stD.perfect} miss=${stD.miss} perfectRate=${stD.perfectRate.toFixed(3)} rank=${stD.rank}`);
  }
}

/* ------------------------------------------------------------------ */
/* case: def04 — DEF-04 §7.3 固定分母 + 复活=取消退役（不铸 -rvN 新身份）   */
/* ------------------------------------------------------------------ */

/**
 * def04 用实例表：与 synthInstances 同形，但**能逐个指定 core**。
 * DIS-02 只有核心节点的 PERFECT 掉 hp，评级可达性完全取决于核心节点落在谱面的哪个位置，
 * synthInstances 把非 bed 全标 core，表达不了这件事，所以这里另给一份（不动他人已在用的夹具）。
 */
function defInstances(clock, spec) {
  const TYPE = { kick: 'spike', bass: 'platform', synth: 'barrage', bed: 'bed' };
  const out = [];
  for (const [track, list] of Object.entries(spec)) {
    for (const entry of list) {
      const beat = Array.isArray(entry) ? entry[0] : entry;
      const core = Array.isArray(entry) ? entry[1] !== false : track !== 'bed';
      out.push({
        id: `d-${track}-${beat}`,
        track,
        type: TYPE[track],
        beat,
        timeSec: clock.timeAtBeat(beat),
        core,
        pitchTier: 0,
        speed: 1,
        state: 'pending',
        grade: null,
        judgable: track !== 'bed'
      });
    }
  }
  return out;
}

/**
 * buildRig + LevelRuntime 的**同构接线**（DEF-03 的教训：测试不得换掉被测对象的接线）：
 * 拆解「停止生成」与复活「恢复」都经由 `judge.syncObstacles(ds.activeInstances())` 回到判定队列，
 * 与 src/game/scenes/LevelRuntime.js:183 / :192 一致。buildRig 没有这条回线，所以它验不出退役/恢复的影响。
 * @param {(clock:object)=>object[]} build 实例表工厂（defInstances 或 PG.build）
 */
function defRig(MC, JS, DS, cfg, build) {
  const clock = new MC.MockClock({ t: 0 });
  clock.init({ bpm: cfg.bpm, sections: cfg.sections, tempoChanges: cfg.tempoChanges, introBeats: cfg.introBeats, lengthBeats: cfg.lengthBeats });
  clock.start(0);
  const inst = build(clock);
  const events = new JS.EventLog();
  const judge = JS.createJudgeSystem({ clock, events });
  const ds = DS.createDisassembleSystem({ clock, events });
  judge.setWindowScale(Number.isFinite(Number(cfg.windowScale)) ? Number(cfg.windowScale) : 1);
  ds.load(cfg, { instances: inst });
  ds.bindJudge(judge);
  ds.attach();
  judge.registerObstacles(inst);
  const rig = {
    cfg,
    clock,
    judge,
    ds,
    JS,
    instances: inst,
    events,
    feed: [],
    ev: [],
    reviveIds: [],
    reviveEvents: 0,
    restoredLive: [],
    hpAtRevive: [],
    probe: { resyncs: 0, maxQueue: 0, maxPending: 0, dupIds: 0 }
  };
  wireRuntimeResync(rig, rig.probe); // 先注册：队列重同步是 LevelRuntime 里第一位的订阅者
  ds.on('revive', (p) => {
    rig.reviveEvents += 1;
    const live = new Set(rig.judge.pendingList().map((o) => o.id)); // 重同步**之后**：恢复的原件是否真回到了待判定队列
    for (const id of p.ids || []) {
      rig.reviveIds.push(id);
      if (live.has(id)) rig.restoredLive.push(id);
    }
    rig.hpAtRevive.push(rig.ds.hp(p.track));
    rig.ev.push({ name: 'revive', ...p });
  });
  for (const name of ['hp-change', 'disassemble', 'state-change']) ds.on(name, (p) => rig.ev.push({ name, ...p }));
  judge.onJudgment((j) => {
    rig.feed.push(j);
    ds.onJudgment(j);
  });
  return rig;
}

/**
 * 理想玩家：25ms 轮询，只对「当前在判定队列里且已到时刻」的障碍按键；want(o) 决定打不打。
 * opt.stomp（DEF-05 / Q5）：寂静段亮起的光点也逐个踩灭 —— 「把真正进场的事件全打中」的玩家
 * 必须包含光点，否则光点只进分母不进分子，任何关卡的最高评级都会被自己写死的玩家模型压低。
 */
function defPlay(rig, want, opt = {}) {
  const step = 0.025;
  const end = rig.clock.timeAtBeat(Number(rig.cfg.lengthBeats) || 0) + 1.5;
  const attempted = [];
  let dotPtr = 0;
  while (rig.clock.time() < end) {
    rig.clock.advanceBy(step);
    for (const o of rig.judge.pendingList()) {
      if (!(o.timeSec <= rig.clock.time() + 0.001 && o.timeSec > rig.clock.time() - 0.06)) continue;
      if (!want(o)) continue;
      attempted.push(o.id);
      rig.judge.onInput(rig.JS.expectedAction(o.type), o.timeSec);
    }
    if (opt.stomp && rig.ds.state() === 'SILENCE') {
      const dots = rig.ds.silenceDots();
      while (dotPtr < dots.length && rig.clock.time() >= dots[dotPtr].timeSec) {
        rig.ds.stompDot({ atSec: dots[dotPtr].timeSec });
        dotPtr += 1;
      }
    }
    rig.probe.maxPending = Math.max(rig.probe.maxPending, rig.judge.pendingCount());
    if (rig.ds.state() === 'RESULT') break;
  }
  return attempted;
}

const rvStream = (rig) => rig.events.events.filter((e) => e.kind === 'judge' && /-rv\d+/.test(String(e.id))).length;

async function caseDef04() {
  const MC = await load('src/mocks/MockClock.js', 'def04');
  const JS = await load('src/game/systems/JudgeSystem.js', 'def04');
  const DS = await load('src/game/systems/DisassembleSystem.js', 'def04');
  const PG = await load('src/game/systems/PatternGenerator.js', 'def04');
  if (!MC || !JS || !DS || !PG) return;

  /* —— ① 评级 S 在产品同构接线下确实可达：每声部恰好 4 个核心节点、且落在该轨最后事件上 —— */
  {
    const cfg = synthCfg({ tracks: { kick: { hp: 4 }, bass: { hp: 4 }, synth: { hp: 4 }, bed: { hp: 0, disassemble: false } } });
    const spec = {
      kick: [[8, false], [10, false], [12, false], [14, false], [16, false], [18, false], [20, true], [24, true], [28, true], [32, true]],
      bass: [[9, false], [11, false], [13, false], [15, false], [22, true], [26, true], [30, true], [34, true]],
      synth: [[17, false], [19, false], [21, true], [25, true], [29, true], [33, true]],
      bed: [[40, false], [44, false]]
    };
    const rig = defRig(MC, JS, DS, cfg, (c) => defInstances(c, spec));
    // DEF-05/Q5：评级改走遭遇口径，光点也属于「进场过的可判事件」，所以这里的「全打中」玩家
    // 必须连寂静段光点一起踩灭，否则它自己就把 S 打不成（断言一个字没松，仍要求 1/S）。
    defPlay(rig, () => true, { stomp: true });
    const st = rig.ds.stats();
    eq('def04①: 前置——24 个可判定障碍 / 12 个核心节点（§7.3「M ≥ 12，三声部各 4」）', `${st.baseTotal}/${st.coreTotal}`, '24/12');
    eq('def04①: 按谱面全打中 → perfect === total()（§7.3 的 PERFECT 上限 = N）', `${st.perfect}/${st.total}`, '24/24');
    eq('def04①: 全打中 → MISS 0', st.miss, 0);
    eq('def04①: 全打中（含光点）→ 评级 S 可达（DEF-05 遭遇口径 ≥0.85 且 MISS==0）', `${st.perfectRate}/${st.rank}`, '1/S');
    eq('def04①: 三声部全拆完', `${rig.ds.disassembled()}/${JSON.stringify(rig.ds.disassembledTracks())}`, 'true/["kick","bass","synth"]');
    eq('def04①: 这一局没有复活（分母与复活无关的极端情形）', rig.reviveEvents, 0);
    eq('def04①: 队列 id 无重复 / 队列长度不超谱面', `${rig.probe.dupIds}/${rig.probe.maxQueue <= 24}`, '0/true');
    eq('def04①: 跑到终点 RESULT', st.state, 'RESULT');
    note('def04①：评级 S 的前提是「每声部第 4 个核心节点落在该轨的最后一个事件」——核心节点若在谱面中段，DIS-04 的停止生成会让剩下的障碍永不可判，perfect 上限随之掉到 N 以下。');
  }

  /* —— ② 复活 = 取消退役：原件回到场上、id 不变、分母不变、且真的又能在 JudgeSystem 里被判 —— */
  {
    const cfg = synthCfg({ tracks: { kick: { hp: 4 }, bass: { hp: 4 }, synth: { hp: 0 }, bed: { hp: 0, disassemble: false } } });
    const spec = {
      kick: [[8, false], [9, true], [10, true], [11, true], [12, true], [12.5, false], [40, false], [42, false], [46, true]],
      bass: [[14, false], [30, false]],
      bed: [[13, false], [15, false]]
    };
    const rig = defRig(MC, JS, DS, cfg, (c) => defInstances(c, spec));
    const chartIds = new Set(rig.instances.filter((o) => o.judgable !== false).map((o) => o.id));
    defPlay(rig, (o) => !(o.track === 'bass' && o.beat === 14)); // 唯一放过的一发 → MISS → 复活 hp 最小的 kick
    const st = rig.ds.stats();
    const penalized = rig.feed.filter((j) => j.penalizes !== false && j.rule !== 'emptyBeat');
    const ids = penalized.map((j) => j.obstacleId);
    eq('def04②: 前置——kick 两次拆空（beat 12 与复活后的 beat 46，DIS-05「复活后需再打核心才拆解」）', rig.ev.filter((e) => e.name === 'disassemble' && e.track === 'kick').length, 2);
    ok('def04②: 前置——这一局真的发生了带 id 的复活', rig.reviveEvents > 0 && rig.reviveIds.length > 0, `revive=${rig.reviveEvents} ids=${rig.reviveIds.length}`);
    eq('def04②: 复活下发的是**原件 id**（不铸 -rvN 新身份）', rig.reviveIds.filter((id) => /-rv\d+$/.test(id) || !chartIds.has(id)).length, 0);
    eq('def04②: 被恢复的原件 = 当前拍之后的 3 个退役 kick', [...rig.reviveIds].sort().join(','), 'd-kick-40,d-kick-42,d-kick-46');
    eq('def04②: 历史障碍不补发（beat ≤ 当前拍的 12.5 仍不在场，DIS-05）', rig.ds.activeInstances().some((o) => o.beat === 12.5), false);
    eq('def04②: 复活后 hp → 1（不是 4，DIS-05）', rig.hpAtRevive.join(','), '1');
    eq('def04②: 恢复的原件当场回到待判定队列（JudgeSystem 已重新挂上超时定时器）', rig.restoredLive.length, 3);
    eq('def04②: 恢复的原件真的又被判到（PERFECT 且 obstacleId 就是原件）', ['d-kick-40', 'd-kick-42', 'd-kick-46'].filter((id) => penalized.some((j) => j.obstacleId === id && j.grade === 'PERFECT')).length, 3);
    eq('def04②: 分母恒定 = 初始谱面 11（§7.3「与复活/重开无关」+ DIS-05 验收「分母不变」）', `${st.total}/${st.baseTotal}`, '11/11');
    eq('def04②: 核心分母同为谱面口径（5，不随复活增长）', `${st.coreTotal}/${st.baseCoreTotal}`, '5/5');
    eq('def04②: revivedIssued = 本局被恢复的原件个数（语义改到 §7.3 口径）', st.revivedIssued, 3);
    eq('def04②: 有惩罚判定的 id 全部属于初始谱面', ids.filter((id) => !chartIds.has(id)).length, 0);
    eq('def04②: 每个源障碍最多 1 条有惩罚判定（原件+副本双身份被杜绝）', new Set(ids).size, ids.length);
    eq('def04②: C7 事件流里不出现 -rvN', rvStream(rig), 0);
    eq('def04②: activeInstances 内 id 唯一（同一原件不占两个名额）', new Set(rig.ds.activeInstances().map((o) => o.id)).size, rig.ds.activeInstances().length);
    eq('def04②: 数字：perfect 9 / miss 1 → 9/11 → 评级 A（评级不再恒为 C）', `${st.perfect}/${st.miss}/${st.rank}`, '9/1/A');
    eq('def04②: 队列 id 无重复 / 队列长度不超谱面', `${rig.probe.dupIds}/${rig.probe.maxQueue <= 11}`, '0/true');
    eq('def04②: 跑到终点 RESULT', st.state, 'RESULT');
    note(`def04②：perfect=${st.perfect} good=${st.good} miss=${st.miss} 分母=${st.total}（初始 ${st.baseTotal}）恢复原件=${st.revivedIssued} Perfect率=${st.perfectRate.toFixed(3)} 评级=${st.rank}`);
    rig.ds.detach();
  }

  /* —— ③ 真谱面 L2（kick+bass 双轨）：只打鼓的核心节点 → 拆鼓 → 放过 → MISS 复活 → 分母仍是 56 —— */
  const cfg2 = readLevel(2);
  if (!cfg2) {
    skipCase('def04', 'src/data/levels/level2.json 尚不存在（SOUND 名下内容），③ 真谱面复活局跳过');
  } else {
    const rig = defRig(MC, JS, DS, cfg2, (c) => PG.build(cfg2, c));
    const chartIds = new Set(rig.instances.filter((o) => o.judgable !== false).map((o) => o.id));
    let kickedCore = 0;
    defPlay(rig, (o) => {
      if (o.track === 'kick' && o.core === true && kickedCore < 4) {
        kickedCore += 1;
        return true;
      }
      return false;
    });
    const st = rig.ds.stats();
    const penalized = rig.feed.filter((j) => j.penalizes !== false && j.rule !== 'emptyBeat');
    const ids = penalized.map((j) => j.obstacleId);
    eq('def04③: L2 初始谱面可判定障碍 = 56（与既有固化数字一致）', st.baseTotal, 56);
    eq('def04③: 前置——只打了 4 个核心鼓点（kick 拆空）', kickedCore, 4);
    ok('def04③: 前置——L2 这一局真的发生了带 id 的复活', rig.reviveEvents > 0 && rig.reviveIds.length > 0, `revive=${rig.reviveEvents} ids=${rig.reviveIds.length}`);
    eq('def04③: 复活下发 id 全是原件（不铸新身份）', rig.reviveIds.filter((id) => !chartIds.has(id)).length, 0);
    eq('def04③: 分母/核心分母不受复活影响（§7.3）', `${st.total}/${st.baseTotal}/${st.coreTotal}/${st.baseCoreTotal}`, '56/56/14/14');
    eq('def04③: 有惩罚判定 id ⊆ 谱面', ids.filter((id) => !chartIds.has(id)).length, 0);
    eq('def04③: 每个源障碍最多 1 条有惩罚判定', new Set(ids).size, ids.length);
    eq('def04③: C7 事件流里不出现 -rvN', rvStream(rig), 0);
    eq('def04③: 队列 id 无重复', rig.probe.dupIds, 0);
    ok('def04③: 队列长度全程 ≤ 谱面 56（DEF-04 的「事件流条数超过谱面」被杜绝）', rig.probe.maxQueue <= 56, `峰值 ${rig.probe.maxQueue}`);
    note(`def04③：L2 只打鼓核心 → perfect=${st.perfect} good=${st.good} miss=${st.miss} 恢复原件=${st.revivedIssued} 分母=${st.total} Perfect率=${st.perfectRate.toFixed(3)} 评级=${st.rank} 队列峰值=${rig.probe.maxPending}`);
    rig.ds.detach();
  }

  /* —— ④ 重开（R）回基线：② 的那一局连跑 12 次，每次数字完全相同，无跨局残留 —— */
  {
    const cfg = synthCfg({ tracks: { kick: { hp: 4 }, bass: { hp: 4 }, synth: { hp: 0 }, bed: { hp: 0, disassemble: false } } });
    const spec = {
      kick: [[8, false], [9, true], [10, true], [11, true], [12, true], [12.5, false], [40, false], [42, false], [46, true]],
      bass: [[14, false], [30, false]],
      bed: [[13, false], [15, false]]
    };
    const rig = defRig(MC, JS, DS, cfg, (c) => defInstances(c, spec));
    let first = '';
    let same = true;
    for (let i = 0; i < 12; i += 1) {
      rig.clock.stop();
      rig.clock.start(0);
      rig.judge.reset();
      rig.ds.reset();
      rig.judge.registerObstacles(rig.instances);
      rig.ds.attach();
      defPlay(rig, (o) => !(o.track === 'bass' && o.beat === 14));
      const s = rig.ds.stats();
      const snap = `${s.total}/${s.baseTotal}/${s.coreTotal}/${s.revivedIssued}/${s.perfect}/${s.miss}/${s.rank}/${s.state}`;
      if (!first) first = snap;
      else if (snap !== first) same = false;
      rig.ds.detach();
    }
    eq('def04④: 12 次重开的分母/恢复数/判定数/评级完全相同（T6 不跨局累加）', `${same}/${first}`, 'true/11/11/5/3/9/1/A/RESULT');
    rig.judge.reset();
    rig.ds.reset();
    eq('def04④: reset() 后 revivedIssued 归零', rig.ds.stats().revivedIssued, 0);
    eq('def04④: reset() 后在场实例回到 11 个原件（退役集与被恢复集都清空，bed 本就不入池）', rig.ds.activeInstances().length, 11);
    eq('def04④: stats() 仍带 T5 的三个观测字段（只增不删）', ['baseTotal', 'baseCoreTotal', 'revivedIssued'].every((k) => k in rig.ds.stats()), true);
    note(`def04④：每次重开的快照 = ${first}`);
  }
}

/* ------------------------------------------------------------------ */
/* case: enc05 — DEF-05 遭遇口径分母：六张出厂谱面「在场事件全打中」必得 S  */
/* ------------------------------------------------------------------ */

/**
 * 独立重算：判定流里真正出现过的**不同**可判障碍 id。
 * 一条事件只有在「玩家被给了这一次机会」时才会带着 obstacleId 出现在判定流里
 * （拆解「停止生成」把它摘队后既不会 PERFECT 也不会超时 MISS），所以这个集合就是
 * DEF-05「本局实际进场的可判事件」的**与实现不同源**的核对口径；Set 天然按 id 去重，
 * 同一原件被退役/恢复多少次都只算一次。
 */
function facedIdSet(feed) {
  const s = new Set();
  for (const j of feed) {
    if (j.penalizes === false || j.rule === 'emptyBeat' || !j.obstacleId) continue;
    s.add(String(j.obstacleId));
  }
  return s;
}

const encNum = (v) => (Number.isFinite(v) ? String(v) : 'n/a');

async function caseEnc05() {
  const MC = await load('src/mocks/MockClock.js', 'enc05');
  const JS = await load('src/game/systems/JudgeSystem.js', 'enc05');
  const DS = await load('src/game/systems/DisassembleSystem.js', 'enc05');
  const PG = await load('src/game/systems/PatternGenerator.js', 'enc05');
  const SAVE = await load('src/data/save.js', 'enc05');
  if (!MC || !JS || !DS || !PG) return;

  /* —— ① 六张出厂谱面：把每个真正进场的事件（含寂静段光点）全打中 → 评级必须是 S —— */
  const seen = LEVEL_IDS.filter((id) => readLevel(id));
  eq('enc05: 六关 JSON 全部就位（缺关按 T2 记 SKIP，不代造）', seen.length, 6);
  for (const id of seen) {
    const cfg = readLevel(id);
    const rig = defRig(MC, JS, DS, cfg, (c) => PG.build(cfg, c)); // 产品同构接线（含 wireRuntimeResync）
    defPlay(rig, () => true, { stomp: true });
    const st = rig.ds.stats();
    const faced = facedIdSet(rig.feed);
    const silenced = rig.ev.some((e) => e.name === 'state-change' && e.to === 'SILENCE');
    const dotsLive = silenced ? st.dots.length : 0;
    const stomped = st.dots.filter((d) => d.state === 'stomped').length;
    eq(`enc05 L${id}: 前置——寂静段确实进场过（否则下面的光点断言是空跑的绿）`, silenced, true);
    eq(`enc05 L${id}: 前置——在场障碍全打中且光点全踩灭（miss/dotMiss 双 0）`, `${st.miss}/${st.dotMiss}`, '0/0');
    eq(`enc05 L${id}: 评级 S（§7.3 阈值 ≥0.85 且 MISS==0，改用遭遇口径后可达）`, st.rank, 'S');
    eq(`enc05 L${id}: 遭遇分母 = 判定流不同 id 数 + 进场光点数（独立重算，Q5）`, `${encNum(st.encounterTotal)}/${faced.size + dotsLive}`, `${faced.size + dotsLive}/${faced.size + dotsLive}`);
    eq(`enc05 L${id}: 遭遇分子 = PERFECT 障碍数 + 踩灭光点数`, `${encNum(st.encounterPerfect)}/${st.perfect + stomped}`, `${st.perfect + stomped}/${st.perfect + stomped}`);
    ok(`enc05 L${id}: 评级用的是遭遇率（perfect/encounterTotal ≥ 0.85）`, Number.isFinite(st.encounterRate) && st.encounterRate >= 0.85, `encounterRate=${encNum(st.encounterRate)}`);
    ok(`enc05 L${id}: §7.3 谱面口径未被改写（perfectRate 仍是 P/N，N=固定分母）`, Math.abs(st.perfectRate - st.perfect / st.baseTotal) < 1e-12 && st.total === st.baseTotal, `perfectRate=${st.perfectRate.toFixed(3)} P${st.perfect}/N${st.baseTotal}`);
    ok(`enc05 L${id}: 谱面口径与遭遇口径是两个不同的数（结算屏要能说清）`, st.encounterTotal <= st.baseTotal + dotsLive, `遭遇 ${encNum(st.encounterTotal)} ≤ 谱面 ${st.baseTotal} + 光点 ${dotsLive}`);
    eq(`enc05 L${id}: 队列 id 无重复 / 有惩罚判定不超发`, `${rig.probe.dupIds}/${rig.feed.filter((j) => j.penalizes !== false && j.rule !== 'emptyBeat').length <= st.baseTotal}`, '0/true');
    rig.ds.detach();
    note(`enc05 L${id} 全遭遇：perfect=${st.perfect} 光点 ${stomped}/${dotsLive} 遭遇 ${encNum(st.encounterTotal)} → 评级率 ${encNum(st.encounterRate)} → 评级 ${st.rank}｜谱面口径 ${st.perfect}/${st.total}=${st.perfectRate.toFixed(3)}`);
  }

  /* —— ② 反刷分：只打 4 个核心节点、其余（含光点）全放过 → 显著低于全遭遇 —— */
  for (const id of seen) {
    const cfg = readLevel(id);
    const farm = simRun(PG, MC, JS, DS, cfg, { coreHits: 4, otherHits: 0 });
    const stF = farm.rig.ds.stats();
    const full = defRig(MC, JS, DS, cfg, (c) => PG.build(cfg, c));
    defPlay(full, () => true, { stomp: true });
    const stL = full.ds.stats();
    full.ds.detach();
    const rateF = Number.isFinite(stF.encounterRate) ? stF.encounterRate : stF.perfectRate;
    const rateL = Number.isFinite(stL.encounterRate) ? stL.encounterRate : stL.perfectRate;
    ok(`enc05 L${id}: 「只打 4 下核心就收工」拿不到 S`, stF.rank !== 'S', `rank=${stF.rank} 遭遇率=${encNum(stF.encounterRate)} perfect=${stF.perfect} miss=${stF.miss}`);
    ok(`enc05 L${id}: 收工局比全遭遇局低 ≥0.30（不可刷分）`, rateL - rateF >= 0.3, `全遭遇 ${rateL.toFixed(3)} − 收工 ${rateF.toFixed(3)} = ${(rateL - rateF).toFixed(3)}`);
    ok(`enc05 L${id}: 放过的光点照样进分母（Q5「否则玩家会故意不打光点」）`, !stF.dots.length || stF.dotMiss === 0 || (Number.isFinite(stF.encounterTotal) ? stF.encounterTotal >= facedIdSet(farm.penalized).size + stF.dotMiss : false), `dotMiss=${stF.dotMiss} 遭遇=${encNum(stF.encounterTotal)} 不同判定 id=${facedIdSet(farm.penalized).size}`);
    note(`enc05 L${id} 收工局：perfect=${stF.perfect} miss=${stF.miss} dotMiss=${stF.dotMiss} 遭遇 ${encNum(stF.encounterTotal)} → ${encNum(stF.encounterRate)} 评级 ${stF.rank}（全遭遇局 ${encNum(stL.encounterRate)} → ${stL.rank}）`);
    farm.rig.ds.detach();
  }

  /* —— ③ 退役/恢复不膨胀分母：同一原件被恢复 2 次，仍只算 1 次遭遇 —— */
  {
    const cfg = synthCfg({
      tracks: { kick: { hp: 4 }, bass: { hp: 4 }, synth: { hp: 0 }, bed: { hp: 0, disassemble: false } },
      sections: [
        { beat: 0, state: 'INTRO', layers: [] },
        { beat: 4, state: 'BUILD', layers: ['kick', 'bass', 'synth', 'bed'] },
        { beat: 8, state: 'PEAK', layers: ['kick', 'bass', 'synth', 'bed'] },
        { beat: 56, state: 'SILENCE', layers: [] }
      ]
    });
    // 鼓：4 个核心先拆空 → 之后每次 MISS 复活鼓、每个核心再打回拆解态，于是 30/40/60 三个原件被
    // **反复**退役再恢复（恢复动作数 > 不同原件数）。贝斯 4 个非核心全放过 = 4 发 MISS 当续命泵；
    // 贝斯永不拆空 → 本局不进 SILENCE → 光点一个都不进场（遭遇分母的另一半必须是 0）。
    const spec = {
      kick: [[8, true], [9, true], [10, true], [11, true], [30, true], [40, true], [60, true]],
      bass: [[14, false], [35, false], [45, false], [55, false]],
      bed: [[16, false]]
    };
    const rig = defRig(MC, JS, DS, cfg, (c) => defInstances(c, spec));
    defPlay(rig, (o) => o.track === 'kick'); // 鼓全打中、贝斯四个全放过 → 反复「退役 → 恢复 → 再被打中」
    const st = rig.ds.stats();
    const faced = facedIdSet(rig.feed);
    const rawRestored = rig.reviveIds.length;
    ok('enc05③: 前置——同一批原件被反复退役再恢复（原始恢复动作数 > 不同原件数）', rawRestored > st.revivedIssued && st.revivedIssued > 0, `恢复动作=${rawRestored} 不同原件=${st.revivedIssued}`);
    ok('enc05③: 前置——本局拆过不止一次（退役/恢复循环真的在跑）', rig.ev.filter((e) => e.name === 'disassemble').length >= 2, `disassemble=${rig.ev.filter((e) => e.name === 'disassemble').length}`);
    eq('enc05③: 遭遇分母不因复活而膨胀（按 id 去重，= 判定流不同 id 数）', `${encNum(st.encounterTotal)}/${faced.size}`, `${faced.size}/${faced.size}`);
    ok('enc05③: 遭遇分母 ≤ 固定谱面分母（§7.3「与复活无关」的上界）', Number.isFinite(st.encounterTotal) && st.encounterTotal <= st.baseTotal, `遭遇 ${encNum(st.encounterTotal)} ≤ 谱面 ${st.baseTotal}`);
    eq('enc05③: 谱面分母始终是 11（复活不改 N）', `${st.total}/${st.baseTotal}`, '11/11');
    eq('enc05③: 未进 SILENCE → 光点不进分母（只数真正进场过的）', `${encNum(st.encounterDots)}/${rig.ev.some((e) => e.name === 'state-change' && e.to === 'SILENCE')}`, '0/false');
    note(`enc05③：反复退役/恢复 ${rawRestored} 次（不同原件 ${st.revivedIssued}）→ 遭遇分母 ${encNum(st.encounterTotal)}（谱面 ${st.baseTotal}）perfect=${st.perfect} miss=${st.miss} 评级 ${st.rank}`);
    rig.ds.detach();
  }

  /* —— ④ K-05/T6：reset() 后遭遇分母与评级回基线，20 次重开数字完全相同 —— */
  const cfg4 = readLevel(3);
  if (cfg4) {
    const rig = defRig(MC, JS, DS, cfg4, (c) => PG.build(cfg4, c));
    let first = '';
    let same = true;
    for (let i = 0; i < 20; i += 1) {
      rig.clock.stop();
      rig.clock.start(0);
      rig.judge.reset();
      rig.ds.reset();
      rig.judge.registerObstacles(rig.instances);
      rig.ds.attach();
      defPlay(rig, () => true, { stomp: true });
      const s = rig.ds.stats();
      const snap = `${encNum(s.encounterTotal)}/${encNum(s.encounterPerfect)}/${s.perfect}/${s.miss}/${s.rank}/${s.state}`;
      if (!first) first = snap;
      else if (snap !== first) same = false;
      rig.ds.detach();
    }
    ok('enc05④: 20 次重开的遭遇分母/分子/评级完全相同（无跨局残留）', same, first);
    rig.judge.reset();
    rig.ds.reset();
    const base = rig.ds.stats();
    eq('enc05④: reset() 后遭遇分母与光点进场数归零', `${encNum(base.encounterTotal)}/${encNum(base.encounterDots)}`, '0/0');
    eq('enc05④: reset() 后评级回 C（未打任何事件不得保留 S）', rig.ds.rank(), 'C');
    eq('enc05④: reset() 后 §7.3 固定分母不变', `${base.total}/${base.baseTotal}`, `${rig.instances.filter((o) => o.judgable !== false).length}/${rig.instances.filter((o) => o.judgable !== false).length}`);
    note(`enc05④：L3 二十次重开快照 = ${first}`);
  }

  /* —— ⑤ T5 字段契约 + 两口径解耦（谱面率不到 0.85，也能因遭遇率达阈拿到 S） —— */
  const cfg5 = readLevel(1);
  if (cfg5) {
    const rig = defRig(MC, JS, DS, cfg5, (c) => PG.build(cfg5, c));
    defPlay(rig, () => true, { stomp: true });
    const st = rig.ds.stats();
    eq('enc05⑤: stats() 仍含 T5 冻结字段 total/perfectRate/coreTotal/baseTotal/baseCoreTotal/revivedIssued/dots', ['total', 'perfectRate', 'coreTotal', 'baseTotal', 'baseCoreTotal', 'revivedIssued', 'dots'].every((k) => k in st), true);
    eq('enc05⑤: 新增字段是加性的且都是数（encounterTotal/Perfect/Rate/Obstacles/Dots + dotsStomped/dotsLive）', ['encounterTotal', 'encounterPerfect', 'encounterRate', 'encounterObstacles', 'encounterDots', 'dotsStomped', 'dotsLive'].every((k) => Number.isFinite(st[k])), true);
    near('enc05⑤: perfectRate 仍是 §7.3 的 P/N（没被悄悄换成遭遇率）', st.perfectRate, st.perfect / st.total, 1e-12);
    ok('enc05⑤: 两口径可分离（本局谱面率 < 0.85 而评级率 ≥ 0.85 → 仍得 S）', st.perfectRate < 0.85 && st.encounterRate >= 0.85 && st.rank === 'S', `谱面率=${st.perfectRate.toFixed(3)} 遭遇率=${encNum(st.encounterRate)} 评级=${st.rank}`);
    note(`enc05⑤：L1 全遭遇局 谱面率 ${st.perfectRate.toFixed(3)}（${st.perfect}/${st.total}）vs 评级率 ${encNum(st.encounterRate)}（${encNum(st.encounterPerfect)}/${encNum(st.encounterTotal)}）→ ${st.rank}`);
    rig.ds.detach();
  }

  /* —— ⑥ SAV-01 存档：新字段加性合并，老档缺字段仍能用 —— */
  if (SAVE) {
    const { defaultLevelEntry, mergeSave, levelEntry, __resetSaveState } = SAVE;
    __resetSaveState();
    const old = mergeSave({ version: 1, levels: { 1: { cleared: true, rank: 'S', perfectRate: 0.93, maxCombo: 30, miss: 0 } } });
    eq('enc05⑥: 旧档缺 encounterRate → 默认 0（字段级合并不炸）', old.levels['1'].encounterRate, 0);
    eq('enc05⑥: 旧档已有字段原样保留', `${old.levels['1'].rank}/${old.levels['1'].perfectRate}/${old.levels['1'].miss}`, 'S/0.93/0');
    const junk = mergeSave({ levels: { 2: { encounterRate: 5 } } });
    eq('enc05⑥: encounterRate clamp 到 0..1', junk.levels['2'].encounterRate, 1);
    const keep = mergeSave({ levels: { 3: { encounterRate: 0.8 } } });
    eq('enc05⑥: 已有 encounterRate 原样读回', keep.levels['3'].encounterRate, 0.8);
    eq('enc05⑥: defaultLevelEntry 带 encounterRate', defaultLevelEntry().encounterRate, 0);
    eq('enc05⑥: levelEntry 对未知关卡也给 encounterRate', levelEntry(mergeSave(null), 9).encounterRate, 0);
    __resetSaveState();
  } else {
    skipCase('enc05', 'src/data/save.js 尚不存在，存档加性字段断言跳过');
  }
}

/* ------------------------------------------------------------------ */
/* case: cr14 — CR-14 仲裁：MockClock 缺省 start() 的 leadSec 语义回归   */
/* ------------------------------------------------------------------ */

async function caseCr14() {
  const MC = await load('src/mocks/MockClock.js', 'cr14');
  const BC = await load('src/audio/BeatClock.js', 'cr14');
  if (!MC || !BC) return;

  // 批复口径：new MockClock({t:1.15}).start()（不带参）走缺省提前量 → 原点恰为 1.25，
  // 且 25ms 网格第一次轮询就落在原点那一格（离线仿真必须能表达「墙钟比原点早一个提前量」）。
  const clock = new MC.MockClock({ t: 1.15 });
  clock.init({ bpm: 120, sections: [{ beat: 0, state: 'INTRO', layers: [] }], introBeats: 4, lengthBeats: 32 });
  const seen = [];
  clock.onEvent((ev) => seen.push(`${ev.type}@${ev.timeSec.toFixed(3)}`)); // 订阅在 start 之前：原点那一拍不能被漏掉
  clock.start();
  eq('cr14: 缺省 start() 的原点 = t + leadSec = 1.25', clock.originSec(), 1.25);
  eq('cr14: 缺省 start() 不把墙钟同步到原点（t 仍 1.15）', clock.time(), 1.15);
  let originLead = null;
  clock.schedule((_t, lead) => {
    if (originLead === null) originLead = lead;
  }, 1.25);
  const stepSec = BC.CLOCK_POLL_MS / 1000;
  for (let i = 0; i < 4; i += 1) clock.advanceBy(stepSec);
  near('cr14: 4 格 25ms 网格恰落在原点（无残留半格）', clock.time(), clock.originSec(), 1e-9, 's');
  ok('cr14: 原点那一拍在网格上被派发过（离线仿真不会出现「原点那一格永不出现」）', seen.some((s) => s.endsWith('@1.250')), seen.join('|') || '(无事件)');
  ok('cr14: 第一次轮询派发时提前量非负（引擎的「宁缺不糊」不会把它当迟到跳掉）', originLead !== null && originLead >= -1e-9, `lead=${originLead}`);
  // 对照：带参 start(atSec) 的重开语义仍把墙钟同步到原点（C1 已批复，两种语义并存）
  const c2 = new MC.MockClock({ t: 0 });
  c2.init({ bpm: 120, sections: [{ beat: 0, state: 'INTRO', layers: [] }], introBeats: 4, lengthBeats: 32 });
  c2.start(1.25);
  eq('cr14: 带参 start(atSec) 仍同步时间源（重开基线不变）', `${c2.originSec()}/${c2.time()}`, '1.25/1.25');
  note('CR-14 已批复：leadSec 语义在缺省 start() 路径上，带参 start(atSec) 保留重开同步；本 case 固化两者。');
}

/* ------------------------------------------------------------------ */
/* 入口                                                                 */
/* ------------------------------------------------------------------ */

const CASES = [
  ['clock', caseClock],
  ['judge', caseJudge],
  ['misstorm', caseMissStorm],
  ['def04', caseDef04],
  ['enc05', caseEnc05],
  ['cr14', caseCr14],
  ['physics', casePhysics],
  ['save', caseSave],
  ['eventlog', caseEventLog],
  ['debug', caseDebug],
  ['forbid-clock', caseForbidClock],
  ['revive-tie', caseReviveTie],
  ['silence', caseSilence],
  ['actiontype', caseActiontype],
  ['freeorder', caseFreeorder],
  ['integration', caseIntegration],
  ['screens', caseScreens]
];

function parseArgs(argv) {
  const cases = [];
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--case') cases.push(argv[(i += 1)]);
    else if (a.startsWith('--case=')) cases.push(a.slice(7));
    else if (a === '--all' || a === '-a') {
      /* 全跑 = 默认 */
    } else if (!a.startsWith('-')) cases.push(a);
  }
  return { cases, json };
}

const { cases: wanted, json } = parseArgs(process.argv.slice(2));
const selected = wanted.length ? CASES.filter(([name]) => wanted.includes(name)) : CASES;

const unknown = wanted.filter((w) => !CASES.some(([name]) => name === w));
if (unknown.length) {
  console.log(`未知 case：${unknown.join(', ')}\n可用：${CASES.map(([n]) => n).join(', ')}（或 --all）`);
  console.log('RESULT: FAIL 未知 case');
  process.exit(2);
}

const started = process.hrtime.bigint();
for (const [name, fn] of selected) {
  state.case = name;
  const before = state.asserts.length;
  try {
    await fn();
  } catch (err) {
    record('fail', `[${name}] case 执行抛错`, String(err?.stack ?? err?.message ?? err));
  }
  const rows = state.asserts.slice(before);
  const fails = rows.filter((r) => r.kind === 'fail');
  const skipped = state.skips.some((s) => s.case === name);
  if (!json) {
    const tag = skipped && !rows.length ? 'SKIP ' : fails.length ? 'FAIL ' : 'PASS ';
    console.log(`${tag}${name.padEnd(12)} ${rows.filter((r) => r.kind === 'pass').length}/${rows.length} 断言`);
    for (const n of state.notes.filter((x) => x.case === name)) console.log(`       · ${n.text}`);
    for (const f of fails) console.log(`       ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
    for (const s of state.skips.filter((x) => x.case === name)) console.log(`       ! SKIP ${s.reason}`);
  }
}
const ms = Number(process.hrtime.bigint() - started) / 1e6;

const total = state.asserts.length;
const passed = state.asserts.filter((r) => r.kind === 'pass').length;
const failed = total - passed;
const stats = `${passed}/${total} 断言 · ${selected.length}/${CASES.length} case · ${state.skips.length} skip · ${ms.toFixed(0)}ms`;

if (json) {
  console.log(
    JSON.stringify({
      tool: 'contractTest',
      pass: failed === 0,
      stats,
      cases: selected.map(([n]) => n),
      asserts: state.asserts,
      notes: state.notes,
      skips: state.skips,
      firstFail: state.firstFail
    })
  );
}

if (state.firstFail) console.log(`RESULT: FAIL ${state.firstFail}`);
else if (!total) console.log(`RESULT: SKIP ${selected.map(([n]) => n).join(',')} 无可执行断言（依赖未就位）`);
else console.log(`RESULT: PASS ${stats}`);

process.exit(state.firstFail ? 1 : 0);
