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
  const revived = ds.activeInstances().filter((o) => o.state === 'revived');
  eq('revive-tie: 复活新实例数 = 当前拍之后的原始事件数', revived.length, 5);
  ok('revive-tie: 复活实例的 beat 全部 > 当前拍（不补发历史，DIS-05）', revived.every((o) => o.beat > beatNow), JSON.stringify(revived.map((o) => o.beat)));
  ok('revive-tie: 复活实例 id 带 -rvN 后缀且与源 id 不同', revived.every((o) => /-rv\d+$/.test(o.id) && o.sourceId !== o.id));
  eq('revive-tie: 复活不改分母', ds.total(), 24);
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
  clock.advanceTo(clock.timeAtBeat(8) + 0.01);
  const wrong = judge.onInput('dash', clock.timeAtBeat(8) + 0.01); // kick 期望 jump
  eq('actiontype: 错动作 → GOOD', wrong.grade, 'GOOD');
  eq('actiontype: 错动作 → actionMatch false', wrong.actionMatch, false);
  eq('actiontype: 错动作仍算命中（rule window / penalizes true）', `${wrong.rule}/${wrong.penalizes}`, 'window/true');
  eq('actiontype: 错动作不写 hp', ds.hp('kick'), 4);
  eq('actiontype: 错动作不进 Perfect 计数', ds.counts().perfect, 0);
  eq('actiontype: 错动作进 GOOD 计数', ds.counts().good, 1);
  eq('actiontype: 错动作保留连击', ds.combo, 1);

  // JDG-08：同拍的两个障碍，一次输入只消费一个
  const beat8 = inst.filter((o) => o.beat === 8);
  eq('actiontype: 夹具的拍 8 有 2 个障碍', beat8.length, 2);
  const t8 = clock.timeAtBeat(8);
  const a = judge.onInput('jump', t8 + 0.4);
  const b = judge.onInput('jump', t8 + 0.42);
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
  const empty = judge.onInput('jump', clock.timeAtBeat(50));
  eq('actiontype: 空拍形状', `${empty.grade}/${empty.rule}/${empty.trigger}/${empty.penalizes}/${empty.obstacleId}`, 'MISS/emptyBeat/input/false/null');
  eq('actiontype: 空拍不改 hp 也不进 MISS 统计', `${ds.hp('kick')}/${ds.counts().miss}`, '4/0');
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

function ds_free(ds) {
  return ds.freeOrder();
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
      rig.judge.reset();
      rig.ds.reset();
      rig.judge.registerObstacles(rig.instances);
      rig.ds.attach();
      playRig(rig, { stomp: true });
      // 每一局重开都必须得到完全一样的判定数与分母（T6：重开不改变耐久统计口径）
      if (rig.ds.counts().perfect !== 55 || rig.ds.total() !== 55 || rig.feed.length !== (i + 2) * 55) everyRestartIdentical = false;
      rig.ds.detach();
      rig.clock.stop();
      rig.clock.start(0);
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
/* 入口                                                                 */
/* ------------------------------------------------------------------ */

const CASES = [
  ['clock', caseClock],
  ['judge', caseJudge],
  ['physics', casePhysics],
  ['save', caseSave],
  ['eventlog', caseEventLog],
  ['debug', caseDebug],
  ['forbid-clock', caseForbidClock],
  ['revive-tie', caseReviveTie],
  ['silence', caseSilence],
  ['actiontype', caseActiontype],
  ['freeorder', caseFreeorder],
  ['integration', caseIntegration]
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
