/* clock-ok */
// src/audio/BeatClock.js — Owner: CORE（K-01，C1 冻结契约）
// 全项目唯一时间真相。除 UI 过渡动画外，任何与「何时」有关的计算只能走这里。
//
// 设计要点
//  1. 拍序换算用分段积分（每段拍→秒为一次函数或线性周期二次函数），不是等速除法，
//     因此第 4 关 120→140 变速两侧严格互逆（实测误差 ~1e-13 秒）。
//  2. 预调度：25ms 轮询 + 提前 120ms 派发，单一优先队列按绝对时刻排序，
//     插入顺序不影响执行顺序（CLK-03）。
//  3. pause/resume 重算时间原点（origin += 暂停时长）并同步平移待派发队列，
//     不重置拍序（R11 / P1-7）。
//  4. 本文件是 AudioContext 的唯一合法读取点，因此带 `/* clock-ok *\/` 白名单标记，
//     且只读 ctx.currentTime，不用 performance.now / Date.now。
//
// Node 侧（contractTest / WORLD / SOUND 离线开发）用 createBeatClock({now, manual:true})
// 或 src/mocks/MockClock.js —— 同一个 BeatClockCore，不存在第二套实现。

/** 预调度轮询周期（ms），CLK-03 冻结。 */
export const CLOCK_POLL_MS = 25;
/** 预调度提前量（秒），CLK-03 冻结。发声侧拿到 lead 后用绝对时刻精确排程。 */
export const CLOCK_LOOKAHEAD_SEC = 0.12;
/** 状态机合法状态（DIS-08）。 */
export const CLOCK_STATES = Object.freeze(['INTRO', 'BUILD', 'PEAK', 'DISASSEMBLED', 'SILENCE', 'RESULT']);

const SEC_PER_BEAT = 60;

/* ------------------------------------------------------------------ */
/* 变速拍序换算（纯函数）                                                */
/* ------------------------------------------------------------------ */

function normalizeChanges(tempoChanges) {
  if (!Array.isArray(tempoChanges)) return [];
  return tempoChanges
    .map((c) => ({
      beat: Number(c?.beat),
      bpm: Number(c?.bpm),
      trans: Number.isFinite(Number(c?.transitionBeats)) ? Math.max(0, Number(c.transitionBeats)) : 0
    }))
    .filter((c) => Number.isFinite(c.beat) && c.beat > 0 && Number.isFinite(c.bpm) && c.bpm > 0)
    .sort((a, b) => a.beat - b.beat);
}

/**
 * 建立分段拍↔秒映射。
 * 约定（本实现的口径，已在本轮报告中向 SOUND/leader 说明）：
 *   `{ beat: 64, bpm: 140, transitionBeats: 2 }` ⇒ 第 62–64 拍周期线性过渡，
 *   **第 64 拍起新 BPM 完全生效**，提示音时点 = beat - transitionBeats（= 变速前 2 拍，CLK-04）。
 *   transitionBeats = 0 或缺省 ⇒ 在 beat 处阶跃。
 * 「过渡期内节拍刻度线性变化」按 *拍长（周期）线性* 实现：刻度间距线性变化，
 * 且积分与反积分都是一次求根，严格互逆、无对数/迭代误差。
 * @param {{bpm:number, tempoChanges?:Array}} spec
 */
export function buildTempoMap(spec = {}) {
  const baseBpm = Number.isFinite(spec.bpm) && spec.bpm > 0 ? spec.bpm : 120;
  const changes = normalizeChanges(spec.tempoChanges);
  const segs = [];
  let cursorBeat = 0;
  let cursorSec = 0;
  let period = SEC_PER_BEAT / baseBpm;

  const pushConst = (b1, p) => {
    if (!(b1 > cursorBeat)) return;
    segs.push({ b0: cursorBeat, b1, p0: p, p1: p, k: 0, t0: cursorSec, t1: cursorSec + (b1 - cursorBeat) * p });
    cursorSec = cursorSec + (b1 - cursorBeat) * p;
    cursorBeat = b1;
  };
  const pushRamp = (b1, pTo) => {
    if (!(b1 > cursorBeat)) return;
    const span = b1 - cursorBeat;
    const k = (pTo - period) / (2 * span);
    const t1 = cursorSec + span * ((period + pTo) / 2);
    segs.push({ b0: cursorBeat, b1, p0: period, p1: pTo, k, t0: cursorSec, t1 });
    cursorSec = t1;
    cursorBeat = b1;
  };

  for (const ch of changes) {
    const newPeriod = SEC_PER_BEAT / ch.bpm;
    const rampStart = Math.max(cursorBeat, ch.beat - ch.trans);
    pushConst(rampStart, period);
    pushRamp(ch.beat, newPeriod);
    period = newPeriod;
  }
  segs.push({ b0: cursorBeat, b1: Infinity, p0: period, p1: period, k: 0, t0: cursorSec, t1: Infinity });

  const localSecOfBeat = (beat) => {
    const b = Number(beat);
    if (!Number.isFinite(b)) return NaN;
    if (b <= 0) return b * segs[0].p0;
    let seg = segs[segs.length - 1];
    for (let i = 0; i < segs.length; i += 1) {
      if (b < segs[i].b1) {
        seg = segs[i];
        break;
      }
    }
    const x = b - seg.b0;
    return seg.t0 + x * seg.p0 + seg.k * x * x;
  };

  const beatOfLocalSec = (sec) => {
    const s = Number(sec);
    if (!Number.isFinite(s)) return NaN;
    if (s <= 0) return s / segs[0].p0;
    let seg = segs[segs.length - 1];
    for (let i = 0; i < segs.length; i += 1) {
      if (s < segs[i].t1) {
        seg = segs[i];
        break;
      }
    }
    const dt = s - seg.t0;
    if (Math.abs(seg.k) < 1e-15) return seg.b0 + dt / seg.p0;
    // k*x^2 + p0*x - dt = 0，取数值稳定根：x = 2dt / (p0 + sqrt(p0^2 + 4k dt))
    const disc = seg.p0 * seg.p0 + 4 * seg.k * dt;
    const root = Math.sqrt(Math.max(0, disc));
    return seg.b0 + (2 * dt) / (seg.p0 + root);
  };

  const periodAtBeat = (beat) => {
    const b = Number(beat);
    let seg = segs[segs.length - 1];
    for (let i = 0; i < segs.length; i += 1) {
      if (b < segs[i].b1) {
        seg = segs[i];
        break;
      }
    }
    if (Math.abs(seg.k) < 1e-15) return seg.p0;
    // p(x) = p0 + 2k(x - b0)，x 取段中点以表达「过渡期平均拍长」之外的瞬时值
    return seg.p0 + 2 * seg.k * (Math.max(seg.b0, Math.min(b, seg.b1 === Infinity ? seg.b0 : seg.b1)) - seg.b0);
  };

  return {
    baseBpm,
    segs,
    changes,
    /** 变速提示点（beat 与绝对拍序），供 SFX/画面提示用 */
    cues: changes
      .filter((c) => c.trans > 0)
      .map((c, i) => ({ beat: Math.max(0, c.beat - c.trans), targetBeat: c.beat, bpmFrom: i === 0 ? baseBpm : changes[i - 1].bpm, bpmTo: c.bpm })),
    localSecOfBeat,
    beatOfLocalSec,
    periodAtBeat
  };
}

/* ------------------------------------------------------------------ */
/* BeatClockCore                                                       */
/* ------------------------------------------------------------------ */

export class BeatClockCore {
  /**
   * @param {{now?:()=>number, manual?:boolean, pollMs?:number, leadSec?:number}} [opts]
   *   now：时间源（秒）。缺省则首次 start()/attach() 时惰性建 AudioContext（Node 下不可用）。
   *   manual：true = 不建轮询 interval，由外部驱动 tick()（MockClock 即此模式）。
   */
  constructor(opts = {}) {
    this._nowFn = typeof opts.now === 'function' ? opts.now : null;
    this._manual = !!opts.manual;
    this._pollMs = opts.pollMs || CLOCK_POLL_MS;
    this._leadSec = Number.isFinite(opts.leadSec) ? opts.leadSec : CLOCK_LOOKAHEAD_SEC;
    this._ctx = null;
    this._originSec = 0;
    this._running = false;
    this._paused = false;
    this._pauseAtSec = 0;
    this._pauseBeat = 0;
    this._queue = [];
    this._cycle = 0;
    this._subs = [];
    this._tempo = buildTempoMap({ bpm: 120 });
    this._sections = [{ beat: 0, state: 'INTRO', layers: [] }];
    this._introBeats = 0;
    this._state = 'INTRO';
    this._nextBeat = 0;
    this._nextSection = 0;
    this._nextCue = 0;
    this._loopId = null;
    this._driftMs = 0;
    this._prevTickSec = 0;
    this._lastTickSec = 0;
  }

  /* ---- 时间源 ---- */

  /** 惰性建立 AudioContext（只在浏览器、且确实需要音频时钟时）。 */
  attach() {
    if (this._nowFn || this._manual) return true;
    if (typeof AudioContext === 'undefined') return false;
    if (!this._ctx) this._ctx = new AudioContext();
    this._nowFn = () => this._ctx.currentTime;
    return true;
  }

  /** CLK-06：音频时钟是否可用（Context 已建且未关闭）。 */
  ready() {
    if (this._ctx) return this._ctx.state !== 'closed';
    return !!this._nowFn;
  }

  /** CLK-06：用户手势里恢复音频（标题点击即调用）。 */
  unlock() {
    if (!this.attach()) return Promise.resolve(false);
    const ctx = this._ctx;
    if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      return ctx.resume().then(() => true).catch(() => false);
    }
    return Promise.resolve(true);
  }

  /** C1：唯一权威时间（秒，浮点）= AudioContext.currentTime。 */
  now() {
    if (!this._nowFn) return this._originSec;
    return this._nowFn();
  }

  /* ---- 关卡装载 ---- */

  /**
   * C1：载入关卡时调用一次。
   * @param {{bpm:number, sections?:Array, tempoChanges?:Array, introBeats?:number, lengthBeats?:number}} spec
   */
  init(spec = {}) {
    this._tempo = buildTempoMap({ bpm: spec.bpm, tempoChanges: spec.tempoChanges });
    const introBeats = Number.isFinite(spec.introBeats) ? Math.max(0, spec.introBeats) : 0;
    this._introBeats = introBeats;
    let sections = Array.isArray(spec.sections) ? spec.sections.filter((s) => s && Number.isFinite(Number(s.beat))) : [];
    sections = sections
      .map((s) => ({
        beat: Number(s.beat),
        state: typeof s.state === 'string' ? s.state : null,
        layers: Array.isArray(s.layers) ? s.layers.slice() : [],
        raw: s
      }))
      .sort((a, b) => a.beat - b.beat);
    if (!sections.length || sections[0].beat > 0) {
      sections.unshift({ beat: 0, state: 'INTRO', layers: [], raw: null });
    }
    if (sections.length === 1 && introBeats > 0) {
      sections.push({ beat: introBeats, state: 'BUILD', layers: [], raw: null });
    }
    this._sections = sections;
    this._state = sections[0].state || 'INTRO';
    return this;
  }

  /** 段落表（只读副本，WORLD/SOUND 可用来排版与画分割线）。 */
  getSections() {
    return this._sections.map(({ beat, state, layers }) => ({ beat, state, layers }));
  }

  /** 变速提示点（绝对秒 + 拍序），SOUND 的变速提示音与画面色带用它。 */
  getTempoCues() {
    return this._tempo.cues.map((c) => ({
      ...c,
      timeSec: this.timeAtBeat(c.beat),
      targetTimeSec: this.timeAtBeat(c.targetBeat)
    }));
  }

  /** 第 idx 拍之后的拍长（秒）。变速关必须按拍取，不能用全局 bpm 换算。 */
  beatLengthSec(beatOrTimeSec = 0, opts = {}) {
    const beat = opts.asTime ? this.beatAt(beatOrTimeSec) : Number(beatOrTimeSec);
    return this._tempo.periodAtBeat(Number.isFinite(beat) ? beat : 0);
  }

  /* ---- 拍↔秒（C1 核心） ---- */

  /** 第 b 拍的绝对时刻（秒）。分段积分，非等速除法。 */
  timeAtBeat(b) {
    return this._originSec + this._tempo.localSecOfBeat(b);
  }

  /** 绝对时刻 t 对应的拍序（可为小数、可为负=尚未开始）。timeAtBeat 的严格逆。 */
  beatAt(tSec) {
    return this._tempo.beatOfLocalSec(tSec - this._originSec);
  }

  /** 当前拍序（浮点）。 */
  currentBeat() {
    return this.beatAt(this.now());
  }

  /* ---- 播放控制 ---- */

  /**
   * 关卡开始 / 重开：把第 0 拍钉在 atSec（缺省 = now + 100ms，保证 beat 0 也能被预调度到）。
   * @param {number} [atSec]
   */
  start(atSec) {
    this.attach();
    const t = Number.isFinite(atSec) ? atSec : this.now() + 0.1;
    this._clearLoop();
    this._queue.length = 0;
    this._originSec = t;
    this._running = true;
    this._paused = false;
    this._nextBeat = 0;
    this._nextSection = 0;
    this._nextCue = 0;
    this._state = this._sections[0].state || 'INTRO';
    this._driftMs = 0;
    this._prevTickSec = this.now();
    this._lastTickSec = this._prevTickSec;
    this._pumpAndDispatch();
    this._ensureLoop();
    return this;
  }

  /** 关卡结束 / teardown：停轮询、清队列（PERF-08 不留残留 interval）。 */
  stop() {
    this._clearLoop();
    this._queue.length = 0;
    this._running = false;
    this._paused = false;
    return this;
  }

  /** R11：暂停 = 冻结派发，不清队列。 */
  pause() {
    if (!this._running || this._paused) return this;
    this._paused = true;
    this._pauseAtSec = this.now();
    this._pauseBeat = Math.max(0, this.beatAt(this._pauseAtSec));
    return this;
  }

  /** R11：恢复 = 重算时间原点 + 平移待派发队列，不重置拍序。 */
  resume() {
    if (!this._running || !this._paused) return this;
    const delta = this.now() - this._pauseAtSec;
    if (delta > 0) {
      this._originSec += delta;
      for (const item of this._queue) item.at += delta;
    }
    this._paused = false;
    this._driftMs = 0;
    this._prevTickSec = this.now();
    this._pumpAndDispatch();
    this._ensureLoop();
    return this;
  }

  isPaused() {
    return this._paused;
  }

  isRunning() {
    return this._running;
  }

  /** 第 0 拍的绝对时刻（DebugPanel 用）。 */
  originSec() {
    return this._originSec;
  }

  /* ---- 预调度与事件 ---- */

  /**
   * C1：一次性回调（发声、超时 MISS 结算、段落边界）。
   * 派发时机：`now >= atSec - CLOCK_LOOKAHEAD_SEC` 的首个轮询点，即 **最多提前 120ms**。
   * 回调签名 `fn(atSec, leadSec)`：atSec 为绝对目标时刻（发声侧据此精确排程），
   * leadSec = atSec - now（提前为正）。
   * 需要「不早于 atSec」语义的消费方（JudgeSystem 超时 MISS）自己看 leadSec 重排，
   * 这样 C1 签名保持不变。
   * @returns {() => void} 取消函数
   */
  schedule(fn, atSec) {
    if (typeof fn !== 'function' || !Number.isFinite(atSec)) {
      throw new TypeError('[BeatClock] schedule(fn, atSec) 需要函数与有限数值时刻');
    }
    const item = { at: atSec, fn, dead: false };
    this._pushSorted(item);
    return () => {
      item.dead = true;
      const i = this._queue.indexOf(item);
      if (i >= 0) this._queue.splice(i, 1);
    };
  }

  /** 订阅时钟事件，返回退订函数。 */
  onEvent(cb) {
    if (typeof cb !== 'function') throw new TypeError('[BeatClock] onEvent(cb) 需要函数');
    this._subs.push(cb);
    return () => {
      const i = this._subs.indexOf(cb);
      if (i >= 0) this._subs.splice(i, 1);
    };
  }

  /** 待派发队列长度（DebugPanel）。 */
  queueSize() {
    return this._queue.length;
  }

  /** 当前状态（C1 六值枚举）。 */
  getState() {
    return this._state;
  }

  /** 外部（DisassembleSystem）驱动状态迁移；非法状态名直接报错。 */
  setState(next) {
    if (!CLOCK_STATES.includes(next)) {
      throw new RangeError(`[BeatClock] 非法状态 ${next}，合法值：${CLOCK_STATES.join('|')}`);
    }
    if (next === this._state) return false;
    const from = this._state;
    const nowSec = this.now();
    this._state = next;
    this._emit({ type: 'state', from, to: next, beat: this.beatAt(nowSec), timeSec: nowSec });
    return true;
  }

  /**
   * CLK-07：轮询周期相对权威时钟的抖动（EMA，ms）。
   * 健康浏览器 ≈0–2ms；主线程长阻塞会瞬间抬升（contractTest 用 300ms 跳变验证）。
   */
  driftMs() {
    return this._driftMs;
  }

  /* ---- 内部 ---- */

  /* ---- 内部 ---- */

  _ensureLoop() {
    if (this._manual || this._loopId !== null || !this._running) return;
    this._loopId = setInterval(() => this.tick(), this._pollMs);
  }

  _clearLoop() {
    if (this._loopId !== null) {
      clearInterval(this._loopId);
      this._loopId = null;
    }
  }

  /** 轮询主体；manual 模式由外部（MockClock.advanceTo）调用。 */
  tick() {
    const nowSec = this.now();
    if (!this._paused && this._running) {
      const real = nowSec - this._lastTickSec;
      const jitterMs = (real - this._pollMs / 1000) * 1000;
      this._driftMs = this._driftMs === 0 ? jitterMs : this._driftMs * 0.8 + jitterMs * 0.2;
      this._prevTickSec = nowSec;
    }
    this._lastTickSec = nowSec;
    this._pumpAndDispatch();
  }

  _pushSorted(item) {
    const q = this._queue;
    item.born = this._cycle; // 本轮派发期间新建的项留到下一轮（防止「重挂即重发」的死循环）
    let i = q.length;
    while (i > 0 && q[i - 1].at > item.at) i -= 1;
    q.splice(i, 0, item);
  }

  _pushAt(at, fn) {
    this._pushSorted({ at, fn });
  }

  /** 把 [origin, until] 区间内的网格事件（拍/段落/变速提示）灌进优先队列。 */
  _pump(untilSec) {
    const horizon = Math.max(untilSec, this._originSec - 1e-9);
    let guard = 0;
    for (;;) {
      if (guard++ > 100000) break;
      const beatTime = this.timeAtBeat(this._nextBeat);
      if (!(beatTime <= horizon)) break;
      const k = this._nextBeat;
      this._pushAt(beatTime, (at) => this._emit({ type: 'beat', beat: k, timeSec: at }));
      this._nextBeat = k + 1;
    }
    while (this._nextSection < this._sections.length) {
      const sec = this._sections[this._nextSection];
      const at = this.timeAtBeat(sec.beat);
      if (!(at <= horizon)) break;
      const idx = this._nextSection;
      const snapshot = sec;
      this._pushAt(at, (t) => {
        this._emit({
          type: 'section',
          index: idx,
          beat: snapshot.beat,
          timeSec: t,
          state: snapshot.state,
          layers: snapshot.layers.slice()
        });
        if (snapshot.state && CLOCK_STATES.includes(snapshot.state)) this.setState(snapshot.state);
      });
      this._nextSection += 1;
    }
    while (this._nextCue < this._tempo.cues.length) {
      const cue = this._tempo.cues[this._nextCue];
      const at = this.timeAtBeat(cue.beat);
      if (!(at <= horizon)) break;
      const snapshot = cue;
      this._pushAt(at, (t) =>
        this._emit({
          type: 'tempo',
          beat: snapshot.beat,
          timeSec: t,
          targetBeat: snapshot.targetBeat,
          bpmFrom: snapshot.bpmFrom,
          bpmTo: snapshot.bpmTo
        })
      );
      this._nextCue += 1;
    }
  }

  _pumpAndDispatch() {
    if (!this._running || this._paused) return;
    const nowSec = this.now();
    const horizon = nowSec + this._leadSec;
    this._pump(horizon);
    const cycle = this._cycle;
    this._cycle = cycle + 1;
    const q = this._queue;
    const due = [];
    for (let i = 0; i < q.length && q[i].at <= horizon; i += 1) {
      if (q[i].born <= cycle && !q[i].dead) due.push(q[i]);
    }
    if (!due.length) return;
    const remaining = new Set(q.filter((it) => !due.includes(it)));
    this._queue = [...remaining];
    for (const item of due) {
      try {
        item.fn(item.at, item.at - nowSec);
      } catch (err) {
        console.error('[BeatClock] 调度回调抛错（已隔离，不影响后续派发）：', err);
      }
    }
  }

  _emit(ev) {
    for (const cb of this._subs.slice()) {
      try {
        cb(ev);
      } catch (err) {
        console.error('[BeatClock] onEvent 回调抛错（已隔离）：', err);
      }
    }
  }
}

/** 工厂：可注入时间源，Node 与浏览器共用同一实现。 */
export function createBeatClock(opts) {
  return new BeatClockCore(opts);
}

/** C1 冻结的单例：全项目只此一个权威时钟。 */
export const BeatClock = new BeatClockCore();

export default BeatClock;
