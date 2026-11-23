// src/game/systems/DisassembleSystem.js — Owner: CORE（K-07 + K-11 + K-12，C3 冻结契约）
// 职责：hp 的唯一写入口、复活选择（DIS-03/05/07）、拆解判定、状态机迁移（DIS-08）、
//       Perfect 率分母（§7.3 固定分母）、寂静段光点（K-11）、L6 freeOrder（K-12）。
// 明确不负责：音频（SOUND 订阅本文件的 'hp-change'/'disassemble'/'revive'）、画面（WORLD 同理）、
//       窗口匹配（JudgeSystem）。**三方单向流：input → Judge → Disassemble → 事件广播**。
//
// C3 冻结签名：hp(track) / onJudgment(judgment) / onMiss() / disassembled()
// 事件：'hp-change'{track,hp} | 'disassemble'{track} | 'revive'{track,ids} | 'state-change'{from,to,reason}
//
// 三条硬口径（CR-08 批复 + CR-09/CR-10 批复）：
//   1) emptyBeat 的过滤**只在本入口**做一次：`rule==='emptyBeat'` 或 `penalizes===false` 直通、不扣血；
//      HUD / ReplayAssembler 一律用 `penalizes` 字段过滤，不许再各写一份「算不算 MISS」。
//   2) 分流判据唯一化：只看 `judgable` 布尔，**禁止**用 `track==='bed'` / `type==='bed'` 猜；
//      `tracks.bed` 一律忽略（读 `disassemble:false`，不猜 `hp===0`）。
//   3) 分母 = **本关 noteEvents 生成的「可判定障碍」总数**（PRD §7.3 的固定分母，与复活/重开无关）＝
//      `setInstances()` 里 `judgable !== false` 的实例数，存为 `_denominator`。复活**不改分母**：
//      DIS-05 的「恢复该类障碍」= 把当前拍之后被拆解摘掉的**原件取消退役**放回场上，
//      不铸造 `-rvN` 新身份（旧 R6 口径「分母 = 初始谱面 + 补发副本」是给重复身份擦屁股的症状修复，DEF-04 已推翻：
//      一个源障碍同时以原件与副本两个身份进判定流，事件条数会超过谱面、perfectRate 只能靠 Math.min 夹住）。
//      重开（reset）回同一基线，不跨局累加。对外 `total()`/`baseTotal()` 同为该固定值。
//   4) **评级**用 DEF-05 裁决的「遭遇口径」分母 `encounterTotal()` = 本局真正进场过的可判事件数
//      = 真正被判定过（PERFECT/GOOD/有惩罚 MISS）的**不同障碍 id** + 寂静段真正亮起过的光点数。
//      被 DIS-04「停止生成」整批退役、从未到玩家手上的未来事件**不进这个分母**（它没进过场），
//      但照样占 §7.3 的固定分母 N —— 两个数各自如实展示，界面不许把两者混为一谈。
//      复活只是取消退役（DEF-04），id 不变 → 按 id 去重的 Set 天然不膨胀；光点按 Q5 必须计入。

import { BeatClock } from '../../audio/BeatClock.js';
import { FROZEN } from '../../data/physics.js';
import { EventLog } from './JudgeSystem.js';

/** 可拆解声部（C3 的三轨）。`bed` 不在内：CR-10 批复「永远不参与 hp / 拆解 / 分母」。 */
export const DIS_TRACKS = Object.freeze(['kick', 'bass', 'synth']);
/** DIS-03 并列口径：kick > bass > synth。 */
export const REVIVE_PRIORITY = Object.freeze(['kick', 'bass', 'synth']);
export const HP_MAX_DEFAULT = 4;
/** 复活后的 hp 值（DIS-05：是 1，不是 4）。 */
export const REVIVE_HP = 1;

export const GAME_STATES = Object.freeze(['INTRO', 'BUILD', 'PEAK', 'DISASSEMBLED', 'SILENCE', 'RESULT']);
/** DIS-08「只许向前」的量化口径；唯一的回退边是 revive 触发的 DISASSEMBLED→PEAK。 */
export const STATE_ORDER = Object.freeze({ INTRO: 0, BUILD: 1, PEAK: 2, DISASSEMBLED: 3, SILENCE: 4, RESULT: 5 });

/**
 * DIS-08 的合法迁移表。
 * · 只许向前（内容可以提前把关卡推进到 DISASSEMBLED，所以 INTRO/BUILD/PEAK 都可直接到 DISASSEMBLED）。
 * · 唯一向后的回退边 = `DISASSEMBLED → PEAK`，且**必须** reason==='revive'（DIS-03 真的有人复活了）。
 * · `SILENCE → PEAK` 非法（DIS-07：段内 MISS 不复活，否则出现「全拆完又退回 PEAK」的空洞回退）。
 * · `RESULT` 是终态，重开走 reset() 而不是迁移。
 */
export const LEGAL_TRANSITIONS = Object.freeze({
  INTRO: Object.freeze(['BUILD', 'DISASSEMBLED', 'RESULT']),
  BUILD: Object.freeze(['PEAK', 'DISASSEMBLED', 'RESULT']),
  PEAK: Object.freeze(['DISASSEMBLED', 'RESULT']),
  DISASSEMBLED: Object.freeze(['SILENCE', 'PEAK', 'RESULT']),
  SILENCE: Object.freeze(['RESULT']),
  RESULT: Object.freeze([])
});

/** 供 contractTest 与 DebugPanel 使用的纯函数。 */
export function isLegalTransition(from, to, reason = null) {
  if (!GAME_STATES.includes(from) || !GAME_STATES.includes(to)) return false;
  if (!(LEGAL_TRANSITIONS[from] || []).includes(to)) return false;
  if (from === 'DISASSEMBLED' && to === 'PEAK') return reason === 'revive';
  // DIS-08「只许向前」的第二重保险：表内若有回退边，也必须给出 reason==='revive'
  if (STATE_ORDER[to] < STATE_ORDER[from] && reason !== 'revive') return false;
  return true;
}

/** C5 的 silenceStartBeat（SOUND 名下函数的口径，这里只做等价兜底）。 */
function silenceStartBeatOf(cfg) {
  const len = Number(cfg && cfg.lengthBeats) || 0;
  return len - (Number(cfg && cfg.silenceBeats) || 0);
}

export class DisassembleSystemCore {
  /**
   * @param {{clock?:object, events?:EventLog, levelCfg?:object}} [deps]
   */
  constructor(deps = {}) {
    this._clock = deps.clock || BeatClock;
    this.events = deps.events instanceof EventLog ? deps.events : deps.events || null;
    this.cfg = deps.levelCfg || null;
    this._subs = { 'hp-change': [], disassemble: [], revive: [], 'state-change': [] };
    this._hp = { kick: 0, bass: 0, synth: 0 };
    this._hpMax = { kick: 0, bass: 0, synth: 0 };
    this._activeTrack = { kick: false, bass: false, synth: false };
    this._state = 'INTRO';
    this._pool = [];
    this._retired = new Set();
    this._restored = new Set();
    this._denominator = 0;
    this._coreTotal = 0;
    /** DEF-05 遭遇口径：本局真正进过场的可判障碍 id（按 id 去重，退役/恢复都不重记）。 */
    this._encounter = new Set();
    /** DEF-05 / Q5：寂静段真正亮起过的光点拍位（进 SILENCE 才记，没进场的关卡不计）。 */
    this._dotsLive = new Set();
    this._n = { perfect: 0, corePerfect: 0, good: 0, miss: 0, dotMiss: 0 };
    this.combo = 0;
    this.maxCombo = 0;
    this._invulnUntil = Number.NEGATIVE_INFINITY;
    this._disassembleBeat = { kick: null, bass: null, synth: null };
    this.dots = [];
    this.lastIgnored = null;
    this._unsubs = [];
    this._freeOrder = false;
    this._hpWrittenBy = null;
  }

  /* ---------------- 装载 / 重开 ---------------- */

  /**
   * C5 关卡配置 → hp 初值、段落口径、寂静段光点表。
   * `tracks.bed` 与 `disassemble:false` 的声部被忽略；`hp:0` 表示该关没有这个声部（DIS-01）。
   * @param {object} levelCfg
   * @param {{instances?:object[]}} [opts]
   */
  load(levelCfg, opts = {}) {
    this.cfg = levelCfg || {};
    this._freeOrder = !!(this.cfg && this.cfg.freeOrder === true);
    for (const t of DIS_TRACKS) {
      const tr = (this.cfg.tracks || {})[t];
      const dis = tr ? tr.disassemble !== false : false;
      const hpMax = tr && Number.isFinite(tr.hp) ? Math.max(0, Math.round(tr.hp)) : 0;
      this._hpMax[t] = hpMax;
      this._hp[t] = hpMax;
      this._activeTrack[t] = dis && hpMax > 0;
      this._disassembleBeat[t] = null;
    }
    if (Array.isArray(opts.instances)) this.setInstances(opts.instances);
    else {
      // 换了关卡配置却没带实例表：本局的退役/恢复状态必须一起归零，
      // 否则会把上一关的 `_retired` id 带进场（跨关累加，K-05 的漂移同类缺陷）。
      this._retired.clear();
      this._restored.clear();
      this._encounter.clear();
      this._dotsLive.clear();
    }
    this.dots = this._buildDots();
    this._state = 'INTRO';
    return this;
  }

  /**
   * C4 实例表（build() 的输出，可含 bed）。**固定分母在这里定死**（§7.3：与复活/重开无关）。
   * 判据唯一：`judgable === false` 的一律不是玩家对象（CR-09 批复）。
   */
  setInstances(instances) {
    const pool = (Array.isArray(instances) ? instances : []).filter((o) => o && o.judgable !== false);
    this._pool = pool;
    this._denominator = pool.length;
    this._coreTotal = pool.filter((o) => o.core === true).length;
    this._retired.clear();
    this._restored.clear();
    this._encounter.clear();
    this._dotsLive.clear();
    return this;
  }

  /** 本局重开（R）：hp / 计数 / 退役集回基线，分母始终是同一份**初始谱面**（§7.3 固定分母，T6 不跨局累加）。 */
  reset() {
    for (const t of DIS_TRACKS) {
      this._hp[t] = this._hpMax[t];
      this._disassembleBeat[t] = null;
    }
    this._retired.clear();
    this._restored.clear();
    // DEF-05：遭遇口径也是「本局」量，重开必须回零（K-05/T6 的 20 次重开无残留包含它）。
    this._encounter.clear();
    this._dotsLive.clear();
    this._n = { perfect: 0, corePerfect: 0, good: 0, miss: 0, dotMiss: 0 };
    this.combo = 0;
    this.maxCombo = 0;
    this._invulnUntil = Number.NEGATIVE_INFINITY;
    this._state = 'INTRO';
    this.dots = this._buildDots();
    this.lastIgnored = null;
    return this;
  }

  /* ---------------- C3 签名 ---------------- */

  /** C3：0..4；配置里 hp:0 表示该关无此声部；`bed` 恒为 0（且不参与任何拆解）。 */
  hp(track) {
    if (!DIS_TRACKS.includes(track)) return 0;
    return this._hp[track];
  }

  hpMax(track) {
    if (!DIS_TRACKS.includes(track)) return 0;
    return this._hpMax[track];
  }

  /** 只读快照（HUD / WorldLayer 的 hpByTrack / 引擎 applyHp 用）。 */
  hpByTrack() {
    return { kick: this._hp.kick, bass: this._hp.bass, synth: this._hp.synth };
  }

  /** DIS-06：本关所有**存在的**声部都 hp=0。 */
  disassembled() {
    const live = DIS_TRACKS.filter((t) => this._activeTrack[t]);
    if (!live.length) return false;
    return live.every((t) => this._hp[t] === 0);
  }

  disassembledTracks() {
    return DIS_TRACKS.filter((t) => this._activeTrack[t] && this._hp[t] === 0);
  }

  activeTrack(track) {
    return this._activeTrack[track] === true;
  }

  /** 本关声部数（结算与 freeOrder 断言用）。 */
  trackCount() {
    return DIS_TRACKS.filter((t) => this._activeTrack[t]).length;
  }

  freeOrder() {
    return this._freeOrder;
  }

  /**
   * ★ §7.3 固定分母：`总障碍数 N = 本关 noteEvents 生成的「可判定障碍」总数（与复活/重开无关）`。
   * DEF-04 之前这里是 `初始谱面 + _extra.length`（R6 口径），那是给「复活补发的 -rvN 副本与原件同时可判」
   * 这个症状擦的屁股：副本让判定流的事件条数超过谱面，于是反过来把分母撑大来让 perfectRate ≤ 1。
   * 根因修好后（复活 = 取消退役、id 不变）分母天然恒等于谱面，`perfect / total` 的上限就是 1，
   * 不需要任何补偿项。由 tools/contractTest.mjs 的 def04②③ 与 misstorm D 局守住：
   * 判定流里出现 `-rvN`、或有惩罚判定条数 > N，都会红。
   */
  total() {
    return this._denominator;
  }

  /** 初始谱面的可判定事件数（DebugPanel / 内容校验用；§7.3 之后与 total() 同值，字段保留为独立核对）。 */
  baseTotal() {
    return this._denominator;
  }

  /** 核心事件数：同为初始谱面口径，不随复活变化（与 total() 同一条固定分母）。 */
  coreTotal() {
    return this._coreTotal;
  }

  /**
   * ★ C3：hp 的**唯一**写入口。
   * 扣血条件四条全中才扣：`activeTrack && isCore && grade==='PERFECT' && actionMatch`
   * 且**先**排除 emptyBeat / penalizes:false（CR-08 批复第 1 点，过滤只在这里做一次）。
   * @param {object} j Judgment（C2）
   * @returns {object|null} 本次影响 `{track, hp, kind}`；无影响返回 null
   */
  onJudgment(j) {
    if (!j || typeof j !== 'object') return null;
    // ① 无惩罚空拍：不扣血、不清连击、不进耐久统计（JDG-04 ③）
    if (j.rule === 'emptyBeat' || j.penalizes === false) return null;
    // ★ DEF-05 遭遇口径的唯一记账点：一条**有惩罚**判定 = 这一次机会真的给到了玩家。
    //   被 DIS-04「停止生成」摘队的未来事件既不会 PERFECT 也不会超时 MISS（JudgeSystem._disarmGone
    //   撤了它的定时器），所以它永远进不了这个 Set；反过来同一原件被退役/恢复多少次都只记一次
    //   （Set 按 id 去重），复活既不涨分母也不铸新身份（DEF-04）。
    //   这里不读时间、不改判定，只在 hp 唯一写入口的门口登记，T4 不受影响。
    if (j.obstacleId) this._encounter.add(String(j.obstacleId));
    const nowSec = this._clock.now();
    if (j.grade === 'MISS') {
      const hit = this.onMiss({ atSec: nowSec, track: j.track, obstacleId: j.obstacleId });
      return hit ? { track: hit, hp: this._hp[hit], kind: 'revive' } : { track: null, hp: null, kind: 'miss' };
    }
    if (j.grade === 'GOOD') {
      this._bumpCombo();
      this._n.good += 1;
      return null;
    }
    // PERFECT
    this._bumpCombo();
    this._n.perfect += 1;
    const track = j.track;
    if (!DIS_TRACKS.includes(track) || this._activeTrack[track] !== true) return null;
    if (!j.isCore || !j.actionMatch) return null; // DIS-02：非核心 PERFECT 不涨拆解进度
    // 核心命中率的分子：命中即计，与「该声部 hp 是否已经见底」无关（否则满分的核心命中率只有 4/16）
    this._n.corePerfect += 1;
    if (this._hp[track] <= 0) return null; // 已拆解声部不再扣（停止生成后仍可能有漏网实例）
    this._hp[track] -= 1;
    this._hpWrittenBy = 'onJudgment';
    this._emit('hp-change', { track, hp: this._hp[track] }, nowSec);
    let out = { track, hp: this._hp[track], kind: 'hp' };
    if (this._hp[track] === 0) {
      this._disassembleBeat[track] = this._clock.beatAt(nowSec);
      this._retireTrack(track);
      this._emit('disassemble', { track, beat: this._disassembleBeat[track], ids: this._retiredIdsOf(track) }, nowSec);
      this._enterDisassembled(nowSec);
      out = { track, hp: 0, kind: 'disassemble' };
    }
    return out;
  }

  /**
   * DIS-03 复活选择（C3 签名 `onMiss()`，可选参数仅为归因，不影响口径）：
   *   · 清连击 + 起无敌帧（§7.2）
   *   · SILENCE 段内 → **不复活任何声部**（DIS-07），返回 null
   *   · 全部在场声部都在满 hp → 不改音频、不复活（DIS-03 第三条「全 hp=4」口径），返回 null
   *   · 否则取 hp 最小者（PRD 原文「损失点数最多」＝hp 最小且 ≥0）；并列按 kick > bass > synth；hp → REVIVE_HP(=1)
   * @returns {string|null} 受影响 track
   */
  onMiss(opt = {}) {
    if (opt.source !== 'silenceDot') this._n.miss += 1; // §7.3 的 MISS 数只统计谱面障碍；光点另计 _n.dotMiss
    else this._n.dotMiss += 1;
    this.combo = 0;
    const atSec = Number.isFinite(opt.atSec) ? opt.atSec : this._clock.now();
    this._invulnUntil = atSec + FROZEN.invulnSec;
    if (this._state === 'SILENCE') return null; // DIS-07：段内光点 MISS 不复活
    const live = DIS_TRACKS.filter((t) => this._activeTrack[t]);
    if (!live.length) return null;
    if (live.every((t) => this._hp[t] === this._hpMax[t])) return null; // 全满 → 仅清连击，不改音频
    const minHp = Math.min(...live.map((t) => this._hp[t]));
    const pick = REVIVE_PRIORITY.find((t) => this._hp[t] === minHp);
    if (!pick) return null;
    // DIS-03/05 的收口：一次 MISS 只有在**真的改变了什么**（hp 被抬起、或确有被拆解摘掉的未来事件要补发）
    // 时才发 hp-change / revive 事件。否则它只清连击+起无敌帧——与上面「全 hp=4 不改音频」同一条口径。
    // 不这样收口时，每次 MISS 都发一次 ids:[] 的 revive，LevelRuntime 会因此重跑队列登记，
    // 已被 registerObstacles 拉回 pending 的旧障碍再次超时 MISS，形成 MISS 指数放大（R5 浏览器实测）。
    const hpChanged = this._hp[pick] !== REVIVE_HP;
    if (hpChanged) {
      this._hp[pick] = REVIVE_HP;
      this._hpWrittenBy = 'onMiss';
      this._emit('hp-change', { track: pick, hp: REVIVE_HP, reason: 'revive' }, atSec);
    }
    const ids = this._regenerate(pick, atSec);
    if (!hpChanged && !ids.length) return pick; // 无事发生：不发 revive、不迁移状态（WORLD/SOUND/判定队列都不动）
    this._emit('revive', { track: pick, hp: REVIVE_HP, ids, from: 'revive' }, atSec);
    if (this._state === 'DISASSEMBLED') {
      // DIS-08 的回退边：这就是「世界重建」事件（WORLD 收到 state-change reason:'revive' + revive ids）
      this.transition('PEAK', { reason: 'revive', atSec });
    }
    return pick;
  }

  /* ---------------- 状态机（DIS-08） ---------------- */

  state() {
    return this._state;
  }

  /** 关卡时间轴上的先后级（INTRO=0…RESULT=5；未知名 -1）。DIS-08「只许向前」的可断言口径。 */
  stateIndex(name = this._state) {
    return Number.isInteger(STATE_ORDER[name]) ? STATE_ORDER[name] : -1;
  }

  /**
   * 显式迁移。**非法迁移抛 RangeError**（DIS-08 的「debug 面板报错」由此驱动）。
   * @param {string} to
   * @param {{reason?:string, atSec?:number, mirror?:boolean}} [opt]
   */
  transition(to, opt = {}) {
    const reason = opt.reason || 'manual';
    if (!GAME_STATES.includes(to)) {
      throw new RangeError(`[DisassembleSystem] 非法状态名 ${to}，合法值：${GAME_STATES.join('|')}`);
    }
    const from = this._state;
    if (from === to) return false;
    if (!isLegalTransition(from, to, reason)) {
      throw new RangeError(`[DisassembleSystem] 非法迁移 ${from} → ${to}（reason=${reason}）`);
    }
    this._state = to;
    const atSec = Number.isFinite(opt.atSec) ? opt.atSec : this._clock.now();
    this._emit('state-change', { from, to, reason, beat: this._clock.beatAt(atSec) }, atSec);
    if (opt.mirror !== false && typeof this._clock.setState === 'function' && this._clock.getState && this._clock.getState() !== to) {
      try {
        this._clock.setState(to);
      } catch {
        /* 时钟侧只做名字校验；镜像失败不影响本文件权威 */
      }
    }
    if (to === 'SILENCE') this._scheduleDots();
    return true;
  }

  /**
   * 内容（C5 sections）提出的状态：只在合法时才采纳，非法（如已 DISASSEMBLED 后 section 又写 PEAK）
   * 记入 lastIgnored 并**忽略**，不抛——否则 L1 在 beat 10 拆完鼓后、beat 20 的 PEAK 段落会炸掉整局。
   * 需要「必须报错」语义的调用方请用 transition()。
   */
  acceptSectionState(next, opt = {}) {
    if (!next || !GAME_STATES.includes(next)) return false;
    if (next === this._state) return false; // 段落写回同一状态是常态（连续多段 PEAK），不算「被忽略」
    if (isLegalTransition(this._state, next, opt.reason || 'section')) return this.transition(next, opt);
    this.lastIgnored = { from: this._state, to: next, reason: opt.reason || 'section', atSec: opt.atSec ?? null };
    return false;
  }

  /** 订阅时钟（段落驱动 + 关卡终点）。返回退订函数（K-05 teardown 登记项）。 */
  attach() {
    this.detach();
    const off = this._clock.onEvent((ev) => this._onClockEvent(ev));
    this._unsubs.push(off);
    const len = Number(this.cfg && this.cfg.lengthBeats) || 0;
    if (len > 0) {
      const at = this._clock.timeAtBeat(len);
      this._unsubs.push(this._clock.schedule(() => this._finalize({ atSec: at }), at));
    }
    return this;
  }

  detach() {
    while (this._unsubs.length) {
      const fn = this._unsubs.pop();
      try {
        fn();
      } catch {
        /* 退订失败不阻断 teardown */
      }
    }
    return this;
  }

  _onClockEvent(ev) {
    if (!ev) return;
    if (ev.type === 'section' && ev.state) {
      this.acceptSectionState(ev.state, { reason: 'section', atSec: ev.timeSec });
      // 段落已写 SILENCE 但 hp 还没全 0 → 上面的 accept 会忽略（关卡时间耗尽时由 _finalize 收口）
    }
    if (ev.type === 'beat' && this._state === 'DISASSEMBLED' && ev.beat >= silenceStartBeatOf(this.cfg) - 1e-9) {
      this.transition('SILENCE', { reason: 'silenceStart', atSec: ev.timeSec });
    }
  }

  _enterDisassembled(atSec) {
    if (this._state === 'RESULT') return;
    if (!this.disassembled()) return;
    if (!isLegalTransition(this._state, 'DISASSEMBLED', 'disassemble')) return;
    this.transition('DISASSEMBLED', { reason: 'disassemble', atSec });
  }

  _finalize(opt = {}) {
    const atSec = Number.isFinite(opt.atSec) ? opt.atSec : this._clock.now();
    if (this._state === 'RESULT') return false;
    // 关卡时间耗尽：无论停在哪个段落都要收口到 RESULT（未到 SILENCE 的按「向前」迁移处理）
    this.transition('RESULT', { reason: 'timeUp', atSec });
    return true;
  }

  _allDotsDone() {
    return this.dots.every((d) => d.state === 'stomped');
  }

  /* ---------------- K-11 寂静段光点 ---------------- */

  _buildDots() {
    if (!this.cfg) return [];
    const from = silenceStartBeatOf(this.cfg);
    const to = Number(this.cfg.lengthBeats) || 0;
    const out = [];
    for (let b = Math.ceil(from); b < to; b += 1) {
      out.push({ beat: b, timeSec: this._clock.timeAtBeat(b), state: 'lit', relitUntil: null });
    }
    return out;
  }

  /** 寂静段的光点表（只读副本）。 */
  silenceDots() {
    return this.dots.map((d) => ({ ...d }));
  }

  /**
   * 玩家在寂静段踩光点：**不产生 hp 变化、不进分母**（分母 = 可判定障碍总数）。
   * @returns {object|null} 被踩灭的光点
   */
  stompDot(opt = {}) {
    if (this._state !== 'SILENCE') return null;
    const atSec = Number.isFinite(opt.atSec) ? opt.atSec : this._clock.now();
    const win = this._goodSec();
    let best = null;
    let bestAbs = Infinity;
    for (const d of this.dots) {
      if (d.state !== 'lit') continue;
      const abs = Math.abs(atSec - d.timeSec);
      if (abs <= win && abs < bestAbs) {
        best = d;
        bestAbs = abs;
      }
    }
    if (!best) return null;
    best.state = 'stomped';
    this._bumpCombo();
    return { beat: best.beat, timeSec: best.timeSec, state: best.state };
  }

  /**
   * DIS-07：段内光点 MISS = 清连击 + 无敌帧 + 该光点**只重亮一拍**；**不复活任何声部**。
   * 复用 onMiss() 这条唯一 MISS 路径（SILENCE 内它的复活分支恒返回 null），不在这里再写一套「算不算 MISS」。
   * ★ DEF-05 / Q5 裁决：光点 MISS 只走 `_n.dotMiss`，**不并进 `_n.miss`**（PRD 7.2 那行没有 hp/通关惩罚，
   *   §7.3 的 `MISS == 0` 指的是有惩罚的障碍 MISS）；它的代价落在**遭遇分母**上——亮过就占一个名额、
   *   漏踩永不补分子，所以「故意不打光点」只会把自己的评级率拉下来（enc05② 逐关钉住）。
   * @returns {object} 供 WORLD 演出的描述
   */
  dotMiss(beat, opt = {}) {
    const atSec = Number.isFinite(opt.atSec) ? opt.atSec : this._clock.now();
    const dot = this.dots.find((d) => d.beat === beat);
    const before = this.hpByTrack();
    this.onMiss({ atSec, source: 'silenceDot' });
    const revived = DIS_TRACKS.filter((t) => this._hp[t] !== before[t]);
    if (dot && dot.state === 'lit') {
      dot.state = 'relit';
      dot.relitUntil = this._clock.timeAtBeat(dot.beat + 1);
      dot.missed = (dot.missed || 0) + 1;
      // 重亮一拍后再到期 → 直接 expired（保证「只重亮一拍」，不会无限 MISS）。
      // K-11 口径补完：一拍窗口已经在过去（时钟跳帧 / 契约测试一次性 advanceTo / 标签页挂起回来）时，
      // 不能再挂一个「过去时刻」的定时器——BeatClock 与 MockClock 都只在未来时刻派发，那样光点会永远停在
      // relit，既不算踩灭也不算到期（寂静段收尾演出漏演）。此时就地到期，语义与到点回调完全一致。
      if (this._clock.now() >= dot.relitUntil - 0.002) this._expireDot(dot);
      else this._armDotFinal(dot);
    }
    return { beat, combo: this.combo, invulnSec: FROZEN.invulnSec, revived, relitUntil: dot ? dot.relitUntil : null, state: dot ? dot.state : null };
  }

  /** 挂「重亮一拍后到期」的回调（退订登记进 _unsubs，K-05 teardown 用）。 */
  _armDotFinal(dot) {
    this._unsubs.push(this._clock.schedule(() => this._dotFinal(dot.beat), dot.relitUntil));
  }

  /** 到期收口：只许从 relit 进来，之后不再参与 MISS / 踩灭（DIS-07「只重亮一拍」的落地态）。 */
  _expireDot(dot) {
    if (!dot || dot.state !== 'relit') return;
    dot.state = 'expired';
  }

  _dotFinal(beat) {
    const dot = this.dots.find((d) => d.beat === beat);
    if (!dot || dot.state !== 'relit') return;
    const nowSec = this._clock.now();
    if (nowSec < dot.relitUntil - 0.002) {
      this._armDotFinal(dot); // CR-08 #4：提前派发要自检重挂
      return;
    }
    this._expireDot(dot);
  }

  _dotDeadline(beat) {
    if (this._state !== 'SILENCE') return;
    const dot = this.dots.find((d) => d.beat === beat);
    if (!dot || dot.state !== 'lit') return; // stomped / relit / expired 都不再触发 MISS
    const nowSec = this._clock.now();
    const due = dot.timeSec + this._goodSec();
    if (nowSec < due - 0.002) {
      this._unsubs.push(this._clock.schedule(() => this._dotDeadline(beat), due)); // CR-08 #4：提前派发要自检
      return;
    }
    this.dotMiss(beat, { atSec: nowSec });
  }

  _scheduleDots() {
    const nowSec = this._clock.now();
    for (const d of this.dots) {
      if (d.state !== 'lit') continue;
      // Q5：光点「亮过」才算一次遭遇事件（进分母）。踩灭算分子、漏踩只扣分——见 encounterRate()。
      this._dotsLive.add(d.beat);
      const due = d.timeSec + this._goodSec();
      // 进入 SILENCE 时窗口已经过去的 rare case（暂停恢复 / 时钟跳帧）：就地走一次到期检查，
      // 不挂到过去时刻（挂上也永不派发，光点会卡在 lit 既不 MISS 也不 expired）。
      if (due <= nowSec - 0.002) this._dotDeadline(d.beat);
      else this._unsubs.push(this._clock.schedule(() => this._dotDeadline(d.beat), due));
    }
  }

  _goodSec() {
    const win = typeof this._judge?.windows === 'function' ? this._judge.windows() : null;
    const ms = win && Number.isFinite(win.goodMs) ? win.goodMs : 110;
    return ms / 1000;
  }

  /** 让本文件能问到当前 GOOD 窗口（寂静段光点的容差）；不是 C3 的一部分，仅注入用。 */
  bindJudge(judge) {
    this._judge = judge || null;
    return this;
  }

  /* ---------------- 统计 / 结算 ---------------- */

  _bumpCombo() {
    this.combo += 1;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
  }

  invulnerable(atSec = this._clock.now()) {
    return atSec < this._invulnUntil;
  }

  counts() {
    return { ...this._n, combo: this.combo, maxCombo: this.maxCombo };
  }

  /**
   * §7.3：Perfect 率 = PERFECT 数 / **固定分母 N**（`total()` = 本关可判定障碍总数，与复活/重开无关）。
   * 分子永远不可能超过 N（一个事件最多一条有惩罚判定，JDG-05/R5 收口），所以值域天然落在 [0,1]。
   * `Math.min(1, …)` 保留为最后一道 UI/存档保险：DEF-04 之后真正的保证不在这里，而在
   * contractTest 的 dupIds / 「每障碍最多 1 条有惩罚判定」/「判定流里不出现 -rvN」三条断言上
   * （夹住只会把重复计账藏起来，正是 DEF-02 犯过的错，故注释把它标成保险而非口径）。
   * ★ DEF-05：这个「谱面口径」继续用于**展示与存档**；评级不再用它当尺子（见 rank()），
   *   否则拆解成功的一局会因为「退役了没进场的未来事件」被自己判成 7%（L1 实测 4/55 → C）。
   */
  perfectRate() {
    const d = this.total();
    return d > 0 ? Math.min(1, this._n.perfect / d) : 0;
  }

  /** PRD §14 建议的第二项：核心命中率（不进 Perfect 率口径，仅结算展示）。分母与 total() 同口径。 */
  coreHitRate() {
    const d = this.coreTotal();
    return d > 0 ? Math.min(1, this._n.corePerfect / d) : 0;
  }

  /* ---------------- DEF-05 遭遇口径（评级用；§7.3 的 P/N 原样保留在上面） ---------------- */

  /** 本局真正被判定过的**不同**障碍数（退役后再没进场的未来事件不在内）。 */
  encounterObstacles() {
    return this._encounter.size;
  }

  /** 寂静段真正亮起过的光点数（Q5：亮过就要进分母；没进过 SILENCE 的关卡是 0）。 */
  encounterDots() {
    return this._dotsLive.size;
  }

  /** 已踩灭的光点数——遭遇口径的分子里它们与障碍 PERFECT 等值（PRD 7.2「光点是障碍」+ Q5）。 */
  dotsStomped() {
    let n = 0;
    for (const d of this.dots) if (d.state === 'stomped') n += 1;
    return n;
  }

  /** ★ 遭遇分母：本局实际进场的可判事件数 = 被判定过的不同障碍 id + 亮起过的光点。 */
  encounterTotal() {
    return this._encounter.size + this._dotsLive.size;
  }

  /** ★ 遭遇分子：障碍 PERFECT 数 + 踩灭光点数。 */
  encounterPerfect() {
    return this._n.perfect + this.dotsStomped();
  }

  /**
   * ★ 评级尺子：`encounterPerfect / encounterTotal`。
   * 上限夹到 1 只作末道保险（与 perfectRate() 同理）：若判定流里出现同一 id 的两条 PERFECT，
   * 分子会超过按 id 去重的分母——那本身是 misstorm/def04 已经钉死不许复发的缺陷。
   */
  encounterRate() {
    const d = this.encounterTotal();
    return d > 0 ? Math.min(1, this.encounterPerfect() / d) : 0;
  }

  /**
   * ★ DEF-05 裁决：评级改用**遭遇口径**，§7.3 的阈值与「C = 通关即保底」一字不动
   * （S ≥0.85 且 MISS==0 / A ≥0.70 / B ≥0.50）。
   * 为什么不能再用 P/N：DIS-04 的「hp 归 0 → 停止生成 + 在场碎裂」把该轨未来的 pending 障碍整批摘掉，
   * 它们从未进场、谁也打不到，却照样占 N —— 实测六张出厂谱面「一个不漏全打中」最高只有
   * 4/55 ~ 39/83（CONTRACTS DEF-05），S/A/B 全线不可达，UI-03 徽章与 SAV-01「最高评级」都是废功能。
   * P/N 继续作为**谱面 Perfect 率**展示与存档（`perfectRate()` 一行未改）。
   *
   * 光点 MISS 的处理（裁决，写死在这里）：**只进分母、不进分子、不触碰 `MISS == 0` 那道闸**。
   * · PRD 7.2 明写「寂静段光点 MISS → hp 不变、音轨不变、光点重亮一拍」，表里没有任何 hp/通关惩罚，
   *   §7.3 的 `MISS == 0` 指的是那一列有惩罚的障碍 MISS（`_n.miss`），把它扩到光点属于加罚，不做；
   * · Q5 的反刷分机制是**分母**：光点亮过就占一个分母名额、漏踩永不补分子，
   *   所以「放过 8 个光点」这种打法在 L1 上直接掉到 4/12=0.33 → C（enc05② 逐关断言）。
   *   要刷 S 就必须把亮过的事件几乎全打中（0.85 允许漏 15%），而漏下的每一个光点都在扣自己的率。
   */
  rank() {
    const th = (this.cfg && this.cfg.rankThresholds) || { S: 0.85, A: 0.7, B: 0.5 };
    const r = this.encounterRate();
    if (r >= th.S && this._n.miss === 0) return 'S';
    if (r >= th.A) return 'A';
    if (r >= th.B) return 'B';
    return 'C';
  }

  stats() {
    return {
      state: this._state,
      total: this.total(),
      coreTotal: this.coreTotal(),
      /** §7.3 固定分母（与 total() 同值，保留为独立核对口径）：初始谱面的可判定障碍数，不随复活变化。 */
      baseTotal: this._denominator,
      baseCoreTotal: this._coreTotal,
      /** DEF-04 语义修订（字段只增不删，T5）：本局**被取消退役恢复的原件个数**（按 id 去重）。
       *  旧义是「复活补发的新实例数 = 分母增量」；固定分母下它不再进任何求和，只是观测量。 */
      revivedIssued: this._restored.size,
      ...this.counts(),
      perfect: this._n.perfect,
      perfectRate: this.perfectRate(),
      coreHitRate: this.coreHitRate(),
      /** ★ DEF-05 加性字段（T5：只加不改名不删）。`perfectRate` 仍是 §7.3 的谱面口径 P/N；
       *  评级改用下面这组遭遇口径，两者在结算屏并列展示、各标各的名字。 */
      encounterObstacles: this.encounterObstacles(),
      encounterDots: this.encounterDots(),
      encounterTotal: this.encounterTotal(),
      encounterPerfect: this.encounterPerfect(),
      encounterRate: this.encounterRate(),
      dotsStomped: this.dotsStomped(),
      /** 与 encounterDots 同值，留作 UI 的独立核对口径（亮起过的光点数 = 进分母的光点数）。 */
      dotsLive: this.encounterDots(),
      rank: this.rank(),
      hp: this.hpByTrack(),
      disassembled: this.disassembled(),
      disassembledTracks: this.disassembledTracks(),
      disassembleBeat: { ...this._disassembleBeat },
      freeOrder: this._freeOrder,
      dots: this.dots.map((d) => ({ beat: d.beat, state: d.state }))
    };
  }

  /** 诊断用：最近一次写 hp 的入口名（只应是 'onJudgment' 或 'onMiss'）。 */
  lastHpWriter() {
    return this._hpWrittenBy;
  }

  /* ---------------- 障碍生成（DIS-04/05：停止生成 / 当前拍后恢复、不补发历史） ---------------- */

  /** 当前应当「在场」的实例（WORLD 的 sync 与 JudgeSystem 的注册都用这一份）。§7.3：只有原件，无副本。 */
  activeInstances() {
    return this._pool.filter((o) => !this._retired.has(o.id));
  }

  _retireTrack(track) {
    for (const o of this._pool) {
      if (o.track === track && o.state === 'pending') this._retired.add(o.id);
    }
  }

  _retiredIdsOf(track) {
    return this._pool.filter((o) => o.track === track && this._retired.has(o.id)).map((o) => o.id);
  }

  /**
   * DIS-05「该类障碍自当前拍后恢复」= **把当前拍之后被拆解摘掉的原件取消退役**放回场上，
   * 不补发历史（`beat <= 当前拍` 的原件继续留在 `_retired` 里），**不铸造新身份**。
   *
   * 为什么必须用原件（DEF-04）：旧实现复制一份 `id: ${o.id}-rvN` 放进 `_extra`，于是同一个源障碍
   * 在判定流里有两个可判身份（原件退役、副本在场）。要维持 §7.3「固定分母」就得分母跟着 `_extra` 长，
   * 结果是 L1 上一局最多 4/55 → 全员评级 C。取消退役后 id / beat / core 全部不变，
   * 分母恒等于谱面，且天然满足 R5 的收口「一个原始事件在 activeInstances() 里最多占一个名额」。
   *
   * 只处理 `_retired` 里的项：hp>0 的声部从未被摘掉，再放回一次是空操作。
   * `_retired` 由 `_retireTrack` 只写入 `state==='pending'` 的原件，所以这里放回的对象必然仍是 pending，
   * JudgeSystem.syncObstacles(requeue:false) 会把它当普通在场障碍重新挂上超时定时器
   * （`_disarmGone` 在退役时已删掉旧定时器与 `_armed` 记录，因此是重新 arm 而不是复用）。
   * 已终态（被判过）的原件不可能在 `_retired` 里 → 不会被二次放回，也就不会出现同拍双实例。
   *
   * @returns {string[]} 被恢复的**原件 id**（revive 事件的 ids，DIS-05 验收：复活后需再打核心才拆解）
   */
  _regenerate(track, atSec) {
    const cur = this._clock.beatAt(atSec);
    const ids = [];
    for (const o of this._pool) {
      if (o.track !== track) continue;
      if (!this._retired.has(o.id)) continue;
      if (!(o.beat > cur + 1e-9)) continue; // 不补发历史（DIS-05）
      this._retired.delete(o.id);
      this._restored.add(o.id);
      ids.push(o.id);
    }
    return ids;
  }

  /* ---------------- 事件广播（单向） ---------------- */

  /** @returns {() => void} 退订（K-05 的 teardown 登记项） */
  on(name, cb) {
    if (!this._subs[name]) throw new RangeError(`[DisassembleSystem] 未知事件 ${name}，可用：${Object.keys(this._subs).join('|')}`);
    if (typeof cb !== 'function') throw new TypeError('[DisassembleSystem] on(name, cb) 需要函数');
    this._subs[name].push(cb);
    return () => {
      const i = this._subs[name].indexOf(cb);
      if (i >= 0) this._subs[name].splice(i, 1);
    };
  }

  listenerCount(name) {
    return (this._subs[name] || []).length;
  }

  _emit(name, payload, atSec) {
    const t = Number.isFinite(atSec) ? atSec : this._clock.now();
    if (name === 'hp-change' && this.events) this.events.hp({ t, track: payload.track, hp: payload.hp });
    if (name === 'state-change' && this.events) this.events.state({ t, from: payload.from, to: payload.to });
    for (const cb of this._subs[name].slice()) {
      try {
        cb(payload, t);
      } catch (err) {
        console.error(`[DisassembleSystem] '${name}' 回调抛错（已隔离，不影响其余订阅方）：`, err);
      }
    }
  }
}

export function createDisassembleSystem(deps) {
  return new DisassembleSystemCore(deps);
}

/** C3 冻结的单例（LevelScene 默认用它）。 */
export const DisassembleSystem = new DisassembleSystemCore({ clock: BeatClock });

export default DisassembleSystem;
