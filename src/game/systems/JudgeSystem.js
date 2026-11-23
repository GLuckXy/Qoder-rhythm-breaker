// src/game/systems/JudgeSystem.js — Owner: CORE（K-02 + K-06，C2/C7 冻结契约）
// 职责（PRD §4）：窗口分级、输入队列与「最近未判定障碍」匹配、空拍识别、超时 MISS 结算、校准偏移。
// 明确不负责：拆解进度（DisassembleSystem）、音频、画面。
//
// 规则优先级（JDG-04，三方统一口径）：
//   ① 窗口匹配 → 判定（rule:'window'）
//   ② 未命中且处于「上一次动作的落地后 inputBufferMs 内」→ 视为对下一拍的预输入，GOOD 起步（rule:'preInput'）
//   ③ 其余 → 空拍（rule:'emptyBeat'）：无惩罚、不入耐久统计、不发 judge 事件，只发 input(hasTarget:false)
// 超时 MISS 由 BeatClock.schedule 在 obstacleT + goodWindow 处驱动，与玩家输入无关（JDG-05）。
//
// K-09 增补（R2）：
//   · JDG-07 动作类型校验：Spike/Platform 只接受 jump、Barrage 只接受 dash；用错动作**降为 GOOD**
//     （既不算 PERFECT、也不算 MISS），并在 Judgment 里带 `actionMatch:false` —— 不涨 hp 也不扣 hp
//     由 DisassembleSystem 唯一的写入口按这条分支执行（本文件不改 hp）。
//   · JDG-08 同拍单消费：一次 onInput 最多消费一个 obstacle；并且**同一 beat 只允许一次输入被消费**
//     （`_beatConsumed`）。第二次同拍输入找不到可消费目标 → 走 ②/③ → 通常落成 emptyBeat（无惩罚）。
//     超时 MISS 不占用该名额（它不是输入）。
//
// 关于 emptyBeat 的 grade：C2 的 grade 枚举里没有「无判定」这一值，因此空拍返回
// grade:'MISS' + rule:'emptyBeat' + obstacleId:null。**消费方（DisassembleSystem / HUD）
// 必须先判 rule === 'emptyBeat' 再决定是否按 MISS 处理**，否则会把无惩罚空拍算成掉血。
// 已在 CR-08 里向三方广播。

import { BeatClock } from '../../audio/BeatClock.js';
import { JUDGE_CONFIG, resolveWindows } from '../../data/config.js';
import { FROZEN, jumpAirSec, dashSec } from '../../data/physics.js';

/** 障碍类型 → 唯一正确动作（JDG-07）。 */
export const ACTION_BY_TYPE = Object.freeze({
  spike: 'jump',
  platform: 'jump',
  barrage: 'dash'
});

/** @returns {'jump'|'dash'} */
export function expectedAction(type) {
  return ACTION_BY_TYPE[type] === 'dash' ? 'dash' : 'jump';
}

/* ------------------------------------------------------------------ */
/* C7 事件流（K-06）：结算、回放、D7 试玩分析共用同一份                  */
/* ------------------------------------------------------------------ */

export class EventLog {
  constructor() {
    /** 按 t 升序的事件数组（C7 四类）。 */
    this.events = [];
  }

  _push(ev) {
    const list = this.events;
    let i = list.length;
    while (i > 0 && list[i - 1].t > ev.t) i -= 1;
    list.splice(i, 0, ev);
    return ev;
  }

  judge({ t, grade, id, deltaMs, rule }) {
    return this._push({ t, kind: 'judge', grade, id, deltaMs, rule });
  }

  hp({ t, track, hp }) {
    return this._push({ t, kind: 'hp', track, hp });
  }

  input({ t, key, hasTarget }) {
    return this._push({ t, kind: 'input', key, hasTarget });
  }

  state({ t, from, to }) {
    return this._push({ t, kind: 'state', from, to });
  }

  count() {
    return this.events.length;
  }

  /** 本局重开（R）只覆盖当前局事件流（PRD §7.3），保留数组引用不清引用方。 */
  clear() {
    this.events.length = 0;
  }

  /** DebugPanel 的导出按钮 / 试玩分析落盘用。 */
  exportEvents(opts = {}) {
    return JSON.stringify(this.events, null, opts.pretty ? 2 : 0);
  }
}

/* ------------------------------------------------------------------ */
/* JudgeSystem                                                         */
/* ------------------------------------------------------------------ */

export class JudgeSystemCore {
  /**
   * @param {{clock?:object, events?:EventLog, strictWindow?:boolean, latencyMs?:number}} [deps]
   */
  constructor(deps = {}) {
    this._clock = deps.clock || BeatClock;
    this.events = deps.events instanceof EventLog ? deps.events : new EventLog();
    this._log = this.events instanceof EventLog ? this.events : null;
    this._scale = JUDGE_CONFIG.defaultWindowScale;
    this._strict = !!deps.strictWindow;
    this._win = resolveWindows({ scale: this._scale, strict: this._strict });
    this._latencyMs = Number.isFinite(deps.latencyMs) ? deps.latencyMs : 0;
    this._obstacles = [];
    this._ignored = 0;
    this._lo = 0;
    this._lastLandSec = Number.NaN;
    this._listeners = [];
    /** JDG-08：同一拍最多 1 次输入被消费。已消费的 beat 集合（超时 MISS 不计入）。 */
    this._beatConsumed = new Set();
  }

  /**
   * 判定结果出口（§9 单向流 input → JudgeSystem → DisassembleSystem）。
   * 超时 MISS 也从这里出来；消费方必须先排除 `rule === 'emptyBeat'`（无惩罚空拍）。
   * @returns {() => void} 退订
   */
  onJudgment(cb) {
    if (typeof cb !== 'function') throw new TypeError('[JudgeSystem] onJudgment(cb) 需要函数');
    this._listeners.push(cb);
    return () => {
      const i = this._listeners.indexOf(cb);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  _notify(judgment) {
    for (const cb of this._listeners.slice()) {
      try {
        cb(judgment);
      } catch (err) {
        console.error('[JudgeSystem] onJudgment 回调抛错（已隔离）：', err);
      }
    }
    return judgment;
  }

  /* ---- 配置 ---- */

  /** C2：关卡窗口缩放，带下限保护（JDG-02：PERFECT≥40 / GOOD≥80ms）。 */
  setWindowScale(k) {
    const scale = Number.isFinite(k) && k > 0 ? k : JUDGE_CONFIG.defaultWindowScale;
    if (scale === this._scale) return this.windows();
    this._scale = scale;
    this._win = resolveWindows({ scale: this._scale, strict: this._strict });
    this._rearmPending();
    return this.windows();
  }

  getWindowScale() {
    return this._scale;
  }

  /** L-01：严格模式（存档 options.strictWindow）切换窗口基准，缩放与下限不变。 */
  setStrictWindow(on) {
    const strict = !!on;
    if (strict === this._strict) return this.windows();
    this._strict = strict;
    this._win = resolveWindows({ scale: this._scale, strict: this._strict });
    this._rearmPending();
    return this.windows();
  }

  /** 当前生效窗口（DebugPanel 显示用）。 */
  windows() {
    return {
      perfectMs: this._win.perfectMs,
      goodMs: this._win.goodMs,
      scale: this._scale,
      strict: this._strict,
      floored: this._win.floored,
      bufferMs: FROZEN.inputBufferMs
    };
  }

  /** C2：校准偏移（ms，带符号）。判定用 t = atSec - latency/1000。 */
  setLatency(ms) {
    this._latencyMs = Number.isFinite(ms) ? ms : 0;
    return this._latencyMs;
  }

  getLatency() {
    return this._latencyMs;
  }

  /** 本局重开：清队列与事件流（PRD §7.3 不污染上一局）。 */
  reset() {
    this._obstacles = [];
    this._ignored = 0;
    this._lo = 0;
    this._lastLandSec = Number.NaN;
    this._beatConsumed.clear();
    for (const off of this._armed().values()) {
      try {
        off();
      } catch {
        /* 退订失败不阻断重开 */
      }
    }
    this._armed().clear();
    this._log?.clear();
  }

  /* ---- 队列 ---- */

  /**
   * C2：登记障碍实例（C4 ObstacleInstance[]），内部按 timeSec 升序建待判定队列，
   * 并为每个 pending 项挂上超时 MISS 定时器（JDG-05）。
   * `judgable === false` 的实例（SOUND 的 bed 背景层，见 CR-09）**不入队、不挂定时器、
   * 也不产生任何 judge 事件**——否则背景节点会被超时 MISS 污染耐久与事件流。缺省视为可判定。
   */
  registerObstacles(instances) {
    return this._ingest(instances, { requeue: true });
  }

  /**
   * 运行中的**队列重同步**（JDG-05 的第二个入口，唯一正确的收口点）：
   * 拆解「停止生成」要把该类 pending 实例摘队，复活「补发未来事件」要把新实例入队，
   * 两处都只应当**增删队列成员**，绝不改写任何实例的 state/grade——
   * 若误用 registerObstacles（重开语义：把终态拉回 pending），已判过的障碍会被重新挂上超时定时器，
   * 每一次超时又是一次 MISS→revive→再登记，MISS 会指数级放大（R5 的浏览器实测 MISS 风暴根因）。
   * 入队仍跳过 `judgable === false`，并保证同一 `id` 在队列里只有一份。
   */
  syncObstacles(instances) {
    return this._ingest(instances, { requeue: false });
  }

  _ingest(instances, { requeue }) {
    const list = Array.isArray(instances) ? instances.slice() : [];
    const judgable = [];
    this._ignored = 0;
    list.forEach((o, i) => {
      if (!o) return;
      if (o.judgable === false) {
        this._ignored += 1;
        return; // 背景/装饰层：保持原对象不动，交给 WORLD 的 timeline 渲染
      }
      if (typeof o.id !== 'string') o.id = `lv-unknown-${i}`;
      if (requeue) {
        // T6「本局重开」：registerObstacles 是重开路径上唯一的入队口，同一批实例再次登记时必须
        // 回到待判定基线——否则上一局写回的终态（judged / expired）会让重开的整局 0 判定、
        // 分母与 Perfect 数一起漂走（K-05 的 20 次重开基线断言就是抓它的）。
        // 'revived' 是生成侧下发的新实例（DIS-05），不是终态，保留。
        if (o.state !== 'pending' && o.state !== 'revived') {
          o.state = 'pending';
          o.grade = null;
        }
      }
      if (o.grade === undefined) o.grade = null;
      if (!Number.isFinite(o.timeSec)) {
        o.timeSec = this._clock.timeAtBeat(Number(o.beat) || 0);
      }
      judgable.push(o);
    });
    // 幂等收口：同一 id 只保留队列里的第一份（重复入队 = 重复 MISS）
    const seen = new Set();
    this._obstacles = judgable
      .filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)))
      .sort((a, b) => a.timeSec - b.timeSec);
    this._lo = 0;
    if (requeue) {
      this._lastLandSec = Number.NaN;
      this._beatConsumed.clear();
    }
    this._disarmGone(this._obstacles); // 先退掉已离队实例的超时定时器，再为在场实例补挂
    for (const o of this._obstacles) if (this._live(o)) this._arm(o);
    return this._obstacles;
  }

  /**
   * R5（浏览器实测 MISS 风暴的收口点）：实例 → 超时定时器退订函数。
   * 「摘队」（拆解停止生成、实例离开 `ds.activeInstances()`）**必须同时退掉它已挂的超时定时器**，
   * 否则退役轨的旧实例仍会在 due 时刻被 `_onTimeout` 补发一次 MISS——它已经不在队列里、
   * 也不再出现在结算的分母里，却照样进 `_n.miss`，于是 MISS 数远超可判对象数。
   * 这张表同时充当「该实例当前确实在判定队列里」的唯一凭据。
   */
  _armed() {
    if (!this._armedMap) this._armedMap = new Map();
    return this._armedMap;
  }

  /** 把离开队列的实例的超时定时器退掉（拆解摘队 / 重开 / 重复入队都走这里）。 */
  _disarmGone(next) {
    const keep = new Set(next);
    const map = this._armed();
    for (const [o, off] of [...map.entries()]) {
      if (keep.has(o)) continue;
      map.delete(o);
      try {
        off();
      } catch {
        /* 退订失败不影响其余 */
      }
    }
  }

  /** 被登记但因 `judgable:false` 跳过的实例数（DebugPanel / selftest 用）。 */
  ignoredCount() {
    return this._ignored || 0;
  }

  /** 待判定（pending / revived）障碍数，DebugPanel 用。 */
  pendingCount() {
    let n = 0;
    for (const o of this._obstacles) if (this._live(o)) n += 1;
    return n;
  }

  /** 只读快照（DebugPanel / selftest）。 */
  pendingList() {
    return this._obstacles.filter((o) => this._live(o)).map((o) => ({ ...o }));
  }

  /**
   * 队列意义上的「活着」（DIS-05）：`pending` 与 `revived` 都可判定。
   * 复活的表达是生成侧下发**新实例**（state:'revived'，见 WORLD 的 Obstacle.LEGAL_TRANSITIONS），
   * 所以超时 MISS 与窗口匹配都必须接受 revived，否则复活后的障碍永不判定。
   */
  _live(o) {
    return o.state === 'pending' || o.state === 'revived';
  }

  /* ---- 判定 ---- */

  /**
   * C2：一次按键的判定。
   * @param {'jump'|'dash'} keyId
   * @param {number} atSec 权威时刻（BeatClock.now()，在 keydown 里取）
   * @returns {object|null} Judgment；keyId 非法时返回 null
   */
  onInput(keyId, atSec) {
    if (keyId !== 'jump' && keyId !== 'dash') return null;
    const t = Number(atSec);
    if (!Number.isFinite(t)) return null;
    const inputSec = t - this._latencyMs / 1000;
    const { perfectMs, goodMs } = this._win;
    const perfectSec = perfectMs / 1000;
    const goodSec = goodMs / 1000;

    // ① 窗口匹配：时间轴上最近的未判定障碍（JDG-03）
    let best = null;
    let bestAbs = Infinity;
    let bestDelta = 0;
    this._skipConsumed();
    for (let i = this._lo; i < this._obstacles.length; i += 1) {
      const o = this._obstacles[i];
      if (o.timeSec - inputSec > goodSec) break;
      if (!this._live(o)) continue;
      if (this._beatConsumed.has(o.beat)) continue; // JDG-08：同一拍最多 1 次输入被消费
      const d = inputSec - o.timeSec;
      const abs = Math.abs(d);
      if (abs <= goodSec && abs < bestAbs) {
        best = o;
        bestAbs = abs;
        bestDelta = d;
      }
    }

    this._log?.input({ t, key: keyId, hasTarget: !!best });

    if (best) {
      const actionMatch = keyId === expectedAction(best.type);
      let grade = Math.abs(bestDelta) <= perfectSec ? 'PERFECT' : 'GOOD';
      if (!actionMatch && grade === 'PERFECT') grade = 'GOOD'; // JDG-07：错动作按 GOOD 通过
      return this._consume(best, { grade, rule: 'window', keyId, actionMatch, atSec: t, inputSec });
    }

    // ② 落地后 inputBufferMs 内的按键 → 下一拍预输入（GOOD 起步）
    const bufferSec = FROZEN.inputBufferMs / 1000;
    const next = this._nextPendingAfter(inputSec);
    if (
      next &&
      Number.isFinite(this._lastLandSec) &&
      inputSec >= this._lastLandSec - 1e-9 &&
      inputSec <= this._lastLandSec + bufferSec
    ) {
      const early = next.timeSec - inputSec;
      if (early > 0 && early <= goodSec + bufferSec + 1e-9) {
        return this._consume(next, {
          grade: 'GOOD',
          rule: 'preInput',
          keyId,
          actionMatch: keyId === expectedAction(next.type),
          atSec: t,
          inputSec
        });
      }
    }

    // ③ 空拍：无惩罚、不入耐久统计（PRD §8.4 里以 input/hasTarget:false 呈现）
    const nearest = this._nearestPending(inputSec);
    const deltaMs = nearest ? Math.round((inputSec - nearest.timeSec) * 1000) : 0;
    return {
      grade: 'MISS',
      obstacleId: null,
      track: null,
      type: null,
      isCore: false,
      actionMatch: false,
      deltaMs,
      rule: 'emptyBeat',
      trigger: 'input',
      key: keyId,
      penalizes: false,
      atSec: t
    };
  }

  /* ---- 内部 ---- */

  _consume(o, { grade, rule, keyId, actionMatch, atSec, inputSec }) {
    o.state = 'judged';
    o.grade = grade;
    this._beatConsumed.add(o.beat); // JDG-08：本拍的输入名额已用掉（仅输入路径会走到这里）
    const deltaMs = Math.round((inputSec - o.timeSec) * 1000);
    this._lastLandSec = o.timeSec + this._arcSec(o);
    const judgment = {
      grade,
      obstacleId: o.id,
      track: o.track ?? null,
      type: o.type ?? null,
      isCore: !!o.core,
      actionMatch,
      deltaMs,
      rule,
      trigger: 'input',
      key: keyId,
      penalizes: true,
      atSec // WORLD 的 Obstacle.onJudgment 用它记 judgedAtSec（纯新增字段，见 R2-CORE 的 CR 说明）
    };
    this._log?.judge({ t: atSec, grade, id: o.id, deltaMs, rule });
    return this._notify(judgment);
  }

  _arcSec(o) {
    const beatSec = this._beatSec(o);
    return o.type === 'barrage' ? dashSec(beatSec) : jumpAirSec(beatSec);
  }

  _beatSec(o) {
    const b = Number.isFinite(o.beat) ? o.beat : this._clock.beatAt(o.timeSec);
    const p = typeof this._clock.beatLengthSec === 'function' ? this._clock.beatLengthSec(b) : 0.5;
    return Number.isFinite(p) && p > 0 ? p : 0.5;
  }

  _skipConsumed() {
    while (this._lo < this._obstacles.length && !this._live(this._obstacles[this._lo])) this._lo += 1;
  }

  _nextPendingAfter(inputSec) {
    this._skipConsumed();
    for (let i = this._lo; i < this._obstacles.length; i += 1) {
      const o = this._obstacles[i];
      if (this._live(o) && o.timeSec > inputSec && !this._beatConsumed.has(o.beat)) return o;
    }
    return null;
  }

  _nearestPending(inputSec) {
    let best = null;
    let bestAbs = Infinity;
    for (const o of this._obstacles) {
      if (!this._live(o)) continue;
      const abs = Math.abs(o.timeSec - inputSec);
      if (abs < bestAbs) {
        best = o;
        bestAbs = abs;
      }
    }
    return best;
  }

  /** 超时 MISS 定时器（JDG-05）。due 随窗口变化重算，且不吃 120ms 提前派发。 */
  _arm(o) {
    const map = this._armed();
    if (map.has(o)) return; // 同一个实例只挂一只定时器（重同步幂等）
    const due = o.timeSec + this._win.goodMs / 1000;
    if (due < this._clock.now() - 1) return; // 登记时早已过窗：留给复位路径，不挂定时器
    map.set(o, this._sub(o, due));
  }

  _sub(o, due) {
    const off = this._clock.schedule(() => this._onTimeout(o), due);
    return typeof off === 'function' ? off : () => {};
  }

  _rearmPending() {
    const map = this._armed();
    for (const off of map.values()) {
      try {
        off();
      } catch {
        /* 退订失败不阻断窗口切换 */
      }
    }
    map.clear();
    for (const o of this._obstacles) if (this._live(o)) this._arm(o);
  }

  _onTimeout(o) {
    const map = this._armed();
    // ★ MISS 的唯一闸门：定时器还在表上 = 这个实例当前确实在判定队列里。
    //   拆解「停止生成」把实例摘队时（_disarmGone）退订即失效，退役轨不会再补发过期 MISS。
    if (!map.has(o)) return;
    map.delete(o);
    if (!this._live(o)) return;
    const due = o.timeSec + this._win.goodMs / 1000;
    const nowSec = this._clock.now();
    if (nowSec < due - 0.002) {
      // 预调度允许提前 ≤120ms 派发；未到真正 due 时刻 → 重挂，保证 MISS 不早于窗口结束
      map.set(o, this._sub(o, due));
      return;
    }
    o.state = 'expired';
    o.grade = 'MISS';
    const judgment = {
      grade: 'MISS',
      obstacleId: o.id,
      track: o.track ?? null,
      type: o.type ?? null,
      isCore: !!o.core,
      actionMatch: false,
      deltaMs: Math.round((nowSec - o.timeSec) * 1000),
      rule: 'window',
      trigger: 'timeout',
      key: null,
      penalizes: true,
      atSec: nowSec
    };
    this._log?.judge({ t: nowSec, grade: 'MISS', id: o.id, deltaMs: judgment.deltaMs, rule: 'window' });
    this._notify(judgment);
  }
}

/** 工厂：离线测试与多关卡并存用。 */
export function createJudgeSystem(deps) {
  return new JudgeSystemCore(deps);
}

/** C2 冻结的单例（LevelScene 默认用它）。 */
export const JudgeSystem = new JudgeSystemCore({ clock: BeatClock });

export default JudgeSystem;
