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
  eq('save: levelEntry 缺关给完整默认', JSON.stringify(levelEntry(s1, 5)), JSON.stringify(defaultSave().levels?.['5'] ?? { cleared: false, rank: null, perfectRate: 0, maxCombo: 0, miss: 0 }));

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

/** 只实现 DebugPanel 用到的 DOM 子集：createElement / getElementById / body / 事件绑定。 */
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
  const body = makeNode('body');
  globalThis.document = {
    getElementById: (id) => (id === 'debug-root' ? root : null),
    createElement: (tag) => makeNode(tag),
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
/* 入口                                                                 */
/* ------------------------------------------------------------------ */

const CASES = [
  ['clock', caseClock],
  ['judge', caseJudge],
  ['physics', casePhysics],
  ['save', caseSave],
  ['eventlog', caseEventLog],
  ['debug', caseDebug],
  ['forbid-clock', caseForbidClock]
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
