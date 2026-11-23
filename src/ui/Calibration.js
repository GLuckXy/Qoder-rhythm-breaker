// src/ui/Calibration.js — Owner: CORE（K-14 完整版：校准小游戏 + 设置项持久化）
//
// PRD 口径（**以需求原文为准，不以现有实现反推**）
//   · JDG-09「校准小游戏：8 拍跟拍敲击，取**中位数**（非均值，抗离群）写入 localStorage；
//     提供手动 ±1ms 微调与「重置为 0」」
//   · §10 界面「校准小游戏：8 拍引导敲击（听合成节拍器跟拍）、**结果偏移与稳定度**、**应用/取消**；
//     说明文字 ≤ 2 行」
//   · §10 界面「设置：延迟校准（小游戏入口 + 当前值 + ±1ms + 重置）」、「全部持久化」（UI-08）、
//     「校准完成」是 SAV-02 明写的写入时机之一
//   降级版（L-06：`[` `]` 每步 1ms + 当前值显示）**一条不许掉**：本面板同样提供 ±1ms 与清零，
//   `LevelRuntime._nudge` 那条快捷键通路原样保留（本文件不碰 scenes/**）。
//
// 为什么是**中位数**而不是均值：离群点（玩家走神晚了一拍）会把均值整段拖跑，
// 而校准要的是「这个人系统性偏多少」。见 contractTest 的 `latency` case：同一批样本，
// 中位数 3.5ms / 均值 17.9ms，写进去的必须是前者。
//
// T4（时钟唯一真相）在本文件的具体形式
//   · 每一拍的**理论时刻** = `clock.timeAtBeat(k)`，收口时刻 = `clock.timeAtBeat(beats-1+tail)`，
//     都出自 BeatClock 的分段积分换算；文件里不出现 `60/bpm`、`setTimeout`、`performance.now`、
//     `Date.now`、`scene.time`（`forbid-clock` 与 `render:scan` 双向扫）。
//   · 敲击时刻 = `clock.now()`（keydown 当场取，PERF-02 不经帧）。
//   · `deltaMs = (敲击时刻 − 该拍理论时刻) × 1000`，正=打得晚。这个符号与 C2 一致：
//     `JudgeSystem.onInput` 里 `inputSec = t − latency/1000`（`JudgeSystem.js:336`），
//     把 +60ms 写进 latency 正好把「系统性晚 60ms」补成 deltaMs≈0。口径由 `latency` case 端到端钉住。
//   · 本文件用**自己 new 的独立 BeatClock 实例**（时间源注入 AudioContext.currentTime），
//     不复用跑关卡的共享单例 `appDeps.BeatClock`，所以在任意界面独立跑都不干扰关卡链路。
//
// CR-11（音频解锁单点）在本文件的具体形式
//   · **不 new AudioContext**、不调 `engine.init()`、不再挂第二个解锁监听：时间源是从
//     `soundEngine.ctx` 读的 `currentTime`（SOUND 名下唯一持有者），发声只调既有入口
//     `engine.playClick(...)` / `engine.beatClick(bool)`（C6 冻结方法）。
//   · 音频钟停着（关卡暂停 → `ctx.suspend()`）时小游戏**不可用**并明写原因：那种状态下
//     `clock.now()` 不走，采到的样本全是同一时刻，写进存档是假校准。

import { CALIB_GAME, CALIBRATION, clampLatency, nudgeLatency } from '../data/config.js';
import { createBeatClock } from '../audio/BeatClock.js';
import { h, row, col, headline, caption, panel, primaryButton, button } from './screens/dom.js';

/* ------------------------------------------------------------------ */
/* 纯函数层（Node 侧可断言，不需要浏览器 / 不需要 AudioContext）        */
/* ------------------------------------------------------------------ */

/** 只保留有限数值并升序排（不改动入参）。 */
export function sortedNums(values) {
  const list = (Array.isArray(values) ? values : [])
    .map((v) => (typeof v === 'number' ? v : Number(v && v.deltaMs)) * 1)
    .filter((v) => Number.isFinite(v));
  return list.slice().sort((a, b) => a - b);
}

/**
 * 中位数：奇数取正中一个，偶数取中间两值的平均。
 * 空输入返回 NaN（调用方按「样本不足」处理，绝不返回 0 —— 0 会被当成「校准过了」）。
 * @param {Array<number|{deltaMs:number}>} values
 * @returns {number}
 */
export function median(values) {
  const s = sortedNums(values);
  const n = s.length;
  if (!n) return Number.NaN;
  const mid = n >> 1;
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 算术均值——只作为**对照量**显示与断言（它会被离群点带跑，所以不用它写入）。 */
export function mean(values) {
  const s = sortedNums(values);
  if (!s.length) return Number.NaN;
  return s.reduce((a, b) => a + b, 0) / s.length;
}

/** 线性插值分位（q ∈ [0,1]），用于稳定度 IQR。 */
export function quantile(values, q) {
  const s = sortedNums(values);
  const n = s.length;
  if (!n) return Number.NaN;
  if (n === 1) return s[0];
  const p = Math.min(1, Math.max(0, Number(q) || 0)) * (n - 1);
  const lo = Math.floor(p);
  const hi = Math.min(n - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
}

/** 四分位距（上四分位 − 下四分位，ms）= PRD 要的「稳定度」；对离群点不敏感。 */
export function iqr(values) {
  const q3 = quantile(values, 0.75);
  const q1 = quantile(values, 0.25);
  return Number.isFinite(q3) && Number.isFinite(q1) ? q3 - q1 : Number.NaN;
}

/** 按精度位取整（默认 0.1ms，与存档/DebugPanel 的显示位一致，再细是假精度）。 */
export function roundMs(v, step = CALIB_GAME.precisionMs) {
  if (!Number.isFinite(v)) return Number.NaN;
  const s = Number.isFinite(step) && step > 0 ? step : 0.1;
  return Math.round(v / s) * s;
}

/** 丢弃前 warmup 个样本（起手第一下最不稳，JDG-09/K-14 口径）。 */
export function dropWarmup(values, warmup = CALIB_GAME.warmupBeats) {
  const list = Array.isArray(values) ? values : [];
  const k = Number.isFinite(warmup) ? Math.max(0, Math.round(warmup)) : 0;
  return list.slice(k);
}

/**
 * 一次校准的结算：中位数（不是均值）+ 稳定度 + 是否够格写入 + 夹紧后的待写值。
 * @param {Array<{deltaMs:number}|number>} samples 按敲击顺序排列的样本
 * @param {{warmup?:number,minSamples?:number,beats?:number,precisionMs?:number}} [opt]
 * @returns {{taps:number,dropped:number,used:number,minSamples:number,medianMs:number,
 *   meanMs:number,iqrMs:number,stable:boolean,accepted:boolean,clamped:boolean,
 *   appliedMs:number,reason:string}}
 */
export function summarize(samples = [], opt = {}) {
  const warmup = Number.isFinite(opt.warmup) ? Math.max(0, Math.round(opt.warmup)) : CALIB_GAME.warmupBeats;
  const minSamples = Number.isFinite(opt.minSamples) ? Math.max(1, Math.round(opt.minSamples)) : CALIB_GAME.minSamples;
  const precision = Number.isFinite(opt.precisionMs) ? opt.precisionMs : CALIB_GAME.precisionMs;
  const beats = Number.isFinite(opt.beats) ? Math.max(1, Math.round(opt.beats)) : CALIB_GAME.beats;
  const all = (Array.isArray(samples) ? samples : []).map((s) => (typeof s === 'number' ? s : Number(s && s.deltaMs))).filter((v) => Number.isFinite(v));
  const used = dropWarmup(all, warmup);
  const out = {
    taps: all.length,
    dropped: all.length - used.length,
    used: used.length,
    minSamples,
    medianMs: Number.NaN,
    meanMs: Number.NaN,
    iqrMs: Number.NaN,
    stable: false,
    accepted: false,
    clamped: false,
    appliedMs: 0,
    reason: ''
  };
  if (used.length < minSamples) {
    out.reason = `样本不足：热身之后只剩 ${used.length} 个有效样本（要 ≥ ${minSamples} 个）· 请跟着节拍器把 ${beats} 拍打满再「应用」`;
    return out;
  }
  const med = roundMs(median(used), precision);
  const applied = clampLatency(med);
  out.medianMs = med;
  out.meanMs = roundMs(mean(used), precision);
  out.iqrMs = roundMs(iqr(used), precision);
  out.stable = Number.isFinite(out.iqrMs) && out.iqrMs <= CALIB_GAME.stableIqrMs;
  out.accepted = true;
  out.clamped = applied !== med;
  out.appliedMs = applied;
  out.reason = out.clamped
    ? `中位数 ${med}ms 超出存档允许的 ${CALIBRATION.minMs}..${CALIBRATION.maxMs}ms，夹紧到 ${applied}ms`
    : out.stable
      ? `中位数 ${med}ms（同批均值 ${out.meanMs}ms 被离群点带跑，不用它）· IQR ${out.iqrMs}ms = 稳`
      : `中位数 ${med}ms · IQR ${out.iqrMs}ms 偏大（> ${CALIB_GAME.stableIqrMs}ms）→ 建议重测一次再应用`;
  return out;
}

/* ------------------------------------------------------------------ */
/* 会话层：节拍器 + 收口，全部由 BeatClock 驱动（无 setTimeout）        */
/* ------------------------------------------------------------------ */

/**
 * 一次校准会话。
 * @param {{clock?:object, game?:object,
 *   click?:(item:{beat:number,kind:string,accent:boolean},atSec:number,leadSec:number)=>any,
 *   onTap?:Function,onBeat?:Function,onFinish?:Function}} [opt]
 *   clock：注入时钟（Node 侧用 MockClock）；缺省 new 一个**独立** BeatClock 实例。
 */
export function createCalibrationSession(opt = {}) {
  const cfg = Object.assign({}, CALIB_GAME, opt.game || {});
  const beats = Math.max(1, Math.round(cfg.beats));
  const clock = opt.clock || createBeatClock({ now: opt.now });
  const sink = typeof opt.click === 'function' ? opt.click : null;
  const theory = []; // 每拍的理论时刻（秒）——只由 clock.timeAtBeat 得出
  const sounded = new Set(); // 真的响过的拍（迟到的拍不出声 → 不该记账）
  const samples = [];
  const stats = { lateSkipped: 0, ignoredOutOfRange: 0, ignoredUnheard: 0, ignoredDuplicate: 0 };
  let offs = [];
  let running = false;
  let finished = false;
  let summary = null;

  const clearSubs = () => {
    for (const off of offs) {
      try {
        off();
      } catch {
        /* 退订抛不垮会话 */
      }
    }
    offs = [];
  };

  /** 收口：算中位数、停钟（停轮询 = PERF-08 不留残留 interval）、回调。 */
  function finish() {
    if (finished) return summary;
    finished = true;
    running = false;
    clearSubs();
    if (clock && typeof clock.stop === 'function') clock.stop();
    summary = summarize(samples, { warmup: cfg.warmupBeats, minSamples: cfg.minSamples, beats });
    if (opt.onFinish) opt.onFinish(summary, samples.slice(), stats);
    return summary;
  }

  /** 放一拍：时刻 = timeAtBeat(k)，迟到（leadSec < -0.002）按 CR-11 口径不补发。 */
  function scheduleBeat(k, atSec) {
    const off = clock.schedule((abs, lead) => {
      if (!running) return;
      if (Number.isFinite(lead) && lead < -cfg.lateLimitSec) {
        stats.lateSkipped += 1;
        return;
      }
      sounded.add(k);
      if (sink) sink({ beat: k, kind: 'tick', accent: k % 4 === 0 }, abs, lead);
      if (opt.onBeat) opt.onBeat(k, abs);
    }, atSec);
    offs.push(typeof off === 'function' ? off : () => {});
  }

  return {
    clock,
    cfg,
    stats,
    /** 每拍理论时刻（会话未跑时为空数组）。 */
    plan: () => theory.slice(),
    samples: () => samples.slice(),
    isRunning: () => running,
    summary: () => summary,
    /**
     * 起钟。DEF-03 的教训写进顺序里：**先 start() 起钟，再注册节拍与收口 schedule**——
     * `BeatClock.start()` 内部会清空调度队列，反过来就会被抹掉（永远不收口）。
     * @param {number} [atSec] 第 0 拍的绝对时刻；缺省 now() + startLeadSec
     * @returns {null|{startSec:number,endSec:number,beats:number}}
     */
    start(atSec) {
      const hasNow = clock && typeof clock.now === 'function';
      const t = Number.isFinite(atSec) ? Number(atSec) : hasNow ? clock.now() + cfg.startLeadSec : Number.NaN;
      if (!Number.isFinite(t) || !clock || typeof clock.timeAtBeat !== 'function') return null; // 音频钟不可用（未解锁/已挂起）
      if (typeof clock.stop === 'function') clock.stop();
      clearSubs();
      theory.length = 0;
      samples.length = 0;
      sounded.clear();
      stats.lateSkipped = 0;
      stats.ignoredOutOfRange = 0;
      stats.ignoredUnheard = 0;
      stats.ignoredDuplicate = 0;
      summary = null;
      finished = false;
      if (typeof clock.init === 'function') clock.init({ bpm: cfg.bpm, introBeats: 0 });
      if (typeof clock.start === 'function') clock.start(t);
      running = true;
      for (let k = 0; k < beats; k += 1) {
        theory[k] = clock.timeAtBeat(k);
        scheduleBeat(k, theory[k]);
      }
      const endSec = clock.timeAtBeat(beats - 1 + cfg.tailBeats);
      const off = clock.schedule(() => finish(), endSec);
      offs.push(typeof off === 'function' ? off : () => {});
      return { startSec: t, endSec, beats };
    },
    /**
     * 一次敲击。归到「最近的一拍」，同拍只吃一次（JDG-08 同口径），没响过的拍不计。
     * @param {number} [tapSec] 缺省取 clock.now()（keydown 当场）
     * @returns {null|{beat:number,tapSec:number,theorySec:number,deltaMs:number}}
     */
    tap(tapSec) {
      if (!running || finished) return null;
      const t = Number.isFinite(tapSec) ? Number(tapSec) : clock.now();
      if (!Number.isFinite(t)) return null;
      const k = Math.round(clock.beatAt(t));
      if (!(k >= 0 && k < beats)) {
        stats.ignoredOutOfRange += 1;
        return null;
      }
      if (samples.some((s) => s.beat === k)) {
        stats.ignoredDuplicate += 1;
        return null;
      }
      if (!sounded.has(k)) {
        stats.ignoredUnheard += 1;
        return null;
      }
      const theorySec = Number.isFinite(theory[k]) ? theory[k] : clock.timeAtBeat(k);
      const sample = { beat: k, tapSec: t, theorySec, deltaMs: (t - theorySec) * 1000 };
      samples.push(sample);
      if (opt.onTap) opt.onTap(sample, samples.slice());
      if (samples.length >= beats) finish();
      return sample;
    },
    /** 玩家中途取消/界面关闭：停表停轮询，已采样本作废。 */
    stop() {
      running = false;
      finished = true;
      clearSubs();
      if (clock && typeof clock.stop === 'function') clock.stop();
      return this;
    }
  };
}

/* ------------------------------------------------------------------ */
/* 可用性判定（唯一一份：界面据此决定是「放拍」还是「只微调」）          */
/* ------------------------------------------------------------------ */

/**
 * @param {{getStatus?:Function}} [engine] SOUND 的引擎（C6 只读状态）
 * @param {{paused?:boolean}} [runtime] 关卡 runtime（只读它的 paused 标志）
 * @returns {{ok:boolean,code:string,reason:string}}
 */
export function calibrationAvailability(engine, runtime) {
  if (!engine || typeof engine.getStatus !== 'function') {
    return { ok: false, code: 'no-engine', reason: '音频引擎未接线（engine.getStatus 缺失）→ 只能用 ±1ms 微调' };
  }
  const st = engine.getStatus() || {};
  if (!st.ready) {
    return { ok: false, code: 'locked', reason: '音频还没解锁：先点一下页面或按任意键（解锁监听只在 main.js 一处，CR-11）' };
  }
  if (runtime && runtime.paused) {
    return { ok: false, code: 'paused', reason: '关卡正停在暂停态：音频钟被挂起（clock.pause 是唯一权威，R11），拍子不会走 → 本次请用 ±1ms 微调，或回标题/结算后再打小游戏' };
  }
  if (st.paused || st.ctxState !== 'running') {
    return { ok: false, code: 'suspended', reason: `AudioContext 当前是 ${st.ctxState || 'unknown'}（不是 running）→ 节拍器出不来，本次请用 ±1ms 微调` };
  }
  return { ok: true, code: 'ok', reason: '' };
}

/**
 * 生产环境的发声通路：只用 SOUND 已冻结的入口，不在界面里碰 GainNode（CR-12）。
 * click 子总线默认被 `beatClick(false)` 压到 RAMP.min（寂静段才抬起来），所以会话期间要抬一次、结束还一次。
 */
function makeEngineClick(engine) {
  let saved = null;
  return {
    begin() {
      if (engine && typeof engine.beatClick === 'function' && typeof engine.beatClickOn === 'function') {
        saved = engine.beatClickOn();
        engine.beatClick(true);
      }
    },
    play(item, atSec, leadSec) {
      if (engine && typeof engine.playClick === 'function') return engine.playClick(item, atSec, leadSec);
      return false;
    },
    end() {
      if (saved !== null && engine && typeof engine.beatClick === 'function') engine.beatClick(saved);
      saved = null;
    }
  };
}

/* ------------------------------------------------------------------ */
/* 界面层：设置/暂停面板的校准子页（DOM 覆盖层，L-04）                   */
/* ------------------------------------------------------------------ */

function lineNode(label, valueNode) {
  return row([h('span', { class: 'rb-text rb-text-caption', style: 'min-width:13em', text: label }), valueNode]);
}

/** 只读数值节点（假 DOM 支持 textContent 写入，不用 innerHTML/querySelector）。 */
function valueNode(role, text) {
  return h('span', { class: 'rb-text rb-text-body rb-num', dataset: { role }, text: String(text) });
}

/** 敲击键（空格 / J）与回车应用的判定：与 JDG-01 的键位口径一致。 */
function isTapKey(ev) {
  if (!ev) return false;
  const key = String(ev.key || '');
  const code = String(ev.code || '');
  return key === ' ' || key === 'Spacebar' || key === 'j' || key === 'J' || code === 'Space' || code === 'KeyJ';
}

function isEnterKey(ev) {
  if (!ev) return false;
  const key = String(ev.key || '');
  return key === 'Enter' || String(ev.code || '') === 'NumpadEnter';
}

/**
 * 校准面板 = DOM + 会话生命周期 + 写入通道。**不自己碰存档**：写入一律回调 `opt.apply(ms)`
 * （UiLayer.applyLatency → judge.setLatency + updateSave({audio:{latencyOffset}})）。
 * @param {{engine?:object, cal?:{clock?:object,now?:Function,click?:Function},
 *   apply?:Function, getLatency?:Function, windows?:Function, availability?:object,
 *   host?:object, uiSound?:Function, onBack?:Function, game?:object}} opt
 * @returns {{element:object,start:Function,stop:Function,dispose:Function,tap:Function,
 *   session:Function,render:Function,state:Function}}
 */
export function createCalibrationPanel(opt = {}) {
  const cfg = Object.assign({}, CALIB_GAME, opt.game || {});
  const cal = opt.cal || {};
  const host = opt.host !== undefined ? opt.host : typeof window !== 'undefined' ? window : null;
  const readLatency = typeof opt.getLatency === 'function' ? opt.getLatency : () => Number(opt.latencyMs) || 0;
  const availability = opt.availability || { ok: true, code: 'ok', reason: '' };

  const clickSink = cal.click ? { play: cal.click, begin: () => {}, end: () => {} } : makeEngineClick(opt.engine);
  const nowSource = cal.now || (() => (opt.engine && opt.engine.ctx && Number.isFinite(opt.engine.ctx.currentTime) ? opt.engine.ctx.currentTime : Number.NaN));

  let session = null;
  let phase = 'idle'; // idle | running | done
  let summary = null;
  let keyOff = null;

  /* ---- DOM ---- */
  const statusEl = caption('');
  const medianEl = valueNode('cal-median', '—');
  const samplesEl = valueNode('cal-samples', `0/${cfg.beats}`);
  const iqrEl = valueNode('cal-iqr', '—');
  const deltasEl = valueNode('cal-deltas', '—');
  const currentEl = valueNode('cal-current', '—');
  const latOut = valueNode('latency-out', '—');
  const noteEl = caption('');

  const START_LABEL = `开始 · 放 ${cfg.beats} 拍`;
  const START_LABEL_UNAVAILABLE = '小游戏当前不可用（原因见上方）';
  const startBtn = primaryButton(START_LABEL, () => {
    if (opt.uiSound) opt.uiSound();
    start();
  });
  startBtn.setAttribute('data-role', 'cal-start');
  const applyBtn = button('应用（写入并生效）', () => {
    if (opt.uiSound) opt.uiSound();
    doApply();
  });
  applyBtn.setAttribute('data-role', 'cal-apply');
  const resetBtn = button('清零（重置为 0ms）', () => {
    if (opt.uiSound) opt.uiSound();
    opt.apply && opt.apply(0);
    render();
  });
  resetBtn.setAttribute('data-role', 'cal-reset');
  const backBtn = button('取消（返回，不写入）', () => {
    if (opt.uiSound) opt.uiSound();
    stop();
    if (opt.onBack) opt.onBack();
  });
  backBtn.setAttribute('data-role', 'cal-back');

  const nudgeBtn = (dir) => {
    const b = button(dir > 0 ? `＋${CALIBRATION.stepMs}ms` : `－${CALIBRATION.stepMs}ms`, () => {
      if (opt.uiSound) opt.uiSound();
      opt.apply && opt.apply(nudgeLatency(readLatency(), dir));
      render();
    });
    b.setAttribute('data-role', dir > 0 ? 'latency-up' : 'latency-down');
    return b;
  };

  const body = col(
    [
      headline('延迟校准', 'rb-text-title rb-glow-system'),
      // 说明 ≤ 2 行（PRD §10 校准小游戏）
      caption(`跟节拍器打 ${cfg.beats} 下：${cfg.warmupBeats} 拍热身不计，剩下取**中位数**（不是均值，抗离群）。`),
      caption('敲击键 = 空格 / J · 回车 = 应用 · 取消不写入。'),
      statusEl,
      lineNode('当前值（生效中）', currentEl),
      lineNode('本次中位数', medianEl),
      lineNode('样本数（热身后/共敲）', samplesEl),
      lineNode('稳定度 IQR', iqrEl),
      lineNode('逐拍偏差 ms', deltasEl),
      noteEl,
      row([startBtn, applyBtn, resetBtn, nudgeBtn(-1), latOut, nudgeBtn(1), backBtn]),
      caption(`小游戏不可用时仍能手动微调：游戏内 [ / ] 与此处按钮同一步长 ${CALIBRATION.stepMs}ms，夹 ${CALIBRATION.minMs}..${CALIBRATION.maxMs}ms（JDG-09 的「重置为 0」= 上面的清零）。`)
    ],
    { style: 'gap:.55em;align-items:flex-start' }
  );
  const element = panel(body, { role: 'calibration' });

  /* ---- 会话 ---- */

  function start() {
    if (!availability.ok) {
      phase = 'idle';
      render();
      return false;
    }
    stopSession();
    clickSink.begin();
    session = createCalibrationSession({
      clock: cal.clock || null,
      now: cal.clock ? undefined : nowSource,
      game: cfg,
      click: (item, atSec, leadSec) => clickSink.play(item, atSec, leadSec),
      onTap: () => {
        phase = 'running';
        render();
      },
      onBeat: () => render(),
      onFinish: (sum) => {
        summary = sum;
        phase = 'done';
        clickSink.end();
        render();
      }
    });
    const info = session.start();
    if (!info) {
      session = null;
      phase = 'idle';
      noteEl.textContent = '音频钟没有可用时刻（ctx.currentTime 读不到）→ 本次只能微调';
      clickSink.end();
      render();
      return false;
    }
    summary = null;
    phase = 'running';
    render();
    return true;
  }

  function tap() {
    if (!session) return null;
    const s = session.tap();
    render();
    return s;
  }

  function doApply() {
    const sum = summary || (session ? session.summary() : null);
    if (!sum || !sum.accepted) {
      noteEl.textContent = (sum && sum.reason) || '还没有可应用的校准结果：请先「开始」并打满拍子';
      render();
      return false;
    }
    if (opt.apply) opt.apply(sum.appliedMs);
    render();
    return true;
  }

  function stopSession() {
    if (session) {
      session.stop();
      session = null;
    }
    clickSink.end();
  }

  /** 只停会话 + 摘键盘监听，DOM 保留（关面板与 dispose 用）。 */
  function stop() {
    stopSession();
    unbindKey();
    return true;
  }

  function dispose() {
    stop();
    phase = 'idle';
    summary = null;
    return true;
  }

  /* ---- 键盘 ---- */

  function onKey(ev) {
    if (ev && ev.repeat) return; // 长按自动重复不算第二次敲击
    if (isTapKey(ev)) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault(); // JDG-01：空格不许滚页面
      if (!session) return;
      tap();
      return;
    }
    if (isEnterKey(ev)) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      doApply();
    }
  }

  function bindKey() {
    if (keyOff || !host || typeof host.addEventListener !== 'function') return;
    host.addEventListener('keydown', onKey);
    keyOff = () => {
      if (host && typeof host.removeEventListener === 'function') host.removeEventListener('keydown', onKey);
      keyOff = null;
    };
  }

  function unbindKey() {
    if (keyOff) keyOff();
  }

  /* ---- 渲染 ---- */

  function render() {
    const cur = Number(readLatency()) || 0;
    currentEl.textContent = `${roundMs(cur)}ms`;
    latOut.textContent = `${roundMs(cur)}ms`;
    const list = session ? session.samples() : [];
    const w = typeof opt.windows === 'function' ? opt.windows() : null;
    // 不用 disabled 属性（假 DOM 没实现 removeAttribute，且「点了给原因」比灰按钮更好读）
    if (!availability.ok) {
      statusEl.textContent = availability.reason || '小游戏当前不可用';
      startBtn.textContent = START_LABEL_UNAVAILABLE;
    } else {
      startBtn.textContent = START_LABEL;
    }
    if (availability.ok && phase === 'idle') {
      statusEl.textContent = `按「开始」放 ${cfg.beats} 拍，跟着每一拍按 空格/J`;
    } else if (phase === 'running') {
      statusEl.textContent = `进行中：已敲 ${list.length}/${cfg.beats} 拍（前 ${cfg.warmupBeats} 拍只当热身）`;
    } else if (phase === 'done' && summary) {
      statusEl.textContent = `${summary.accepted ? '采到了' : '不写入'} · ${summary.reason}`;
    }
    samplesEl.textContent = summary ? `${summary.used}/${summary.taps}` : `${Math.max(0, list.length - cfg.warmupBeats)}/${list.length}`;
    medianEl.textContent = summary && summary.accepted ? `${summary.medianMs}ms` : '—';
    iqrEl.textContent = summary && summary.accepted ? `${summary.iqrMs}ms ${summary.stable ? '（稳）' : '（偏散）'}` : '—';
    deltasEl.textContent = list.length ? list.map((s) => `${s.deltaMs >= 0 ? '+' : ''}${roundMs(s.deltaMs, 1)}`).join(' ') : '—';
    if (session && session.stats.lateSkipped) {
      noteEl.textContent = `有 ${session.stats.lateSkipped} 拍因派发迟到没出声（主线程卡顿），这些拍不计样本。`;
    } else if (summary && summary.accepted && w && Number.isFinite(w.perfectMs)) {
      noteEl.textContent = `写入后判定窗：PERFECT ±${Number(w.perfectMs).toFixed(1)}ms · GOOD ±${Number(w.goodMs).toFixed(1)}ms（补偿后你的系统性偏差会落到窗口中心）`;
    } else if (!summary || !summary.accepted) {
      if (!noteEl.textContent.includes('没出声')) noteEl.textContent = w && Number.isFinite(w.perfectMs) ? `当前判定窗：PERFECT ±${Number(w.perfectMs).toFixed(1)}ms · GOOD ±${Number(w.goodMs).toFixed(1)}ms` : '';
    }
    if (typeof opt.onRender === 'function') opt.onRender(state());
    return true;
  }

  function state() {
    return { phase, summary, availability, taps: session ? session.samples().length : 0, stats: session ? session.stats : null, session };
  }

  bindKey();
  render();
  return { element, start, stop, dispose, tap, apply: doApply, session: () => session, render, state };
}

export default { median, mean, iqr, quantile, roundMs, dropWarmup, summarize, createCalibrationSession, calibrationAvailability, createCalibrationPanel };
