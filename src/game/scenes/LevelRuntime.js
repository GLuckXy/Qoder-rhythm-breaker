// src/game/scenes/LevelRuntime.js — Owner: CORE（K-05 的场景生命周期实现体）
// LevelScene 只做 Phaser 胶水，所有编排逻辑下沉到这里（T3：LevelScene ≤250 行）。
//
// 本文件负责的四件事（对应 K-05 / CR-11 批复 / §9 单向流）：
//   ① 装载一关：clock.init → PG.build → ds.load/setInstances → judge.register → engine.loadLevel → clock.start → engine.arm
//   ② 帧序（CR-11 第 2 点裁决）：**先 clock.now() 取样 → engine.ensureRunning() → engine.pump(nowSec) → world.sync**
//   ③ 事件订阅表：judge.onJudgment → ds.onJudgment（唯一 hp 写入口）；ds 的四个事件 → WORLD 的 WorldLayer + SOUND 的 SoundEngine
//   ④ 统一 shutdown()：interval / 音源指针 / 监听 / Phaser 事件**全部登记在 this._offs**，逐条释放
//
// 不在此文件：判定算法（JudgeSystem）、hp 与状态机（DisassembleSystem）、绘制（WORLD 的 WorldLayer）、发声（SOUND 的 SoundEngine）。

import { buildView } from '../../data/theme.js';
import { nudgeLatency } from '../../data/config.js';
import { getSave, updateSave } from '../../data/save.js';
import * as PG from '../systems/PatternGenerator.js';
import { expectedAction } from '../systems/JudgeSystem.js';
import { GAME_STATES } from '../systems/DisassembleSystem.js';

/** 键位（JDG-01）。左右微调属 WORLD 的角色，这里只登记不实现。 */
export const KEYMAP = Object.freeze({
  jump: ['SPACE', 'J'],
  dash: ['K'],
  restart: ['R'],
  pause: ['ESC'],
  calDown: ['OPEN_BRACKET'],
  calUp: ['CLOSE_BRACKET'],
  quit: ['Q']
});

const START_LEAD_SEC = 0.35; // 第 0 拍钉在未来，保证 intro 的 4 拍倒计时也能被预调度到

export class LevelRuntime {
  /**
   * @param {{scene:object, clock:object, judge:object, ds:object, events:object, engine:object, world:object, cfg:object, onEnd?:(stats:object)=>void, onLog?:(text:string)=>void}} deps
   */
  constructor(deps) {
    this.scene = deps.scene;
    this.clock = deps.clock;
    this.judge = deps.judge;
    this.ds = deps.ds;
    this.events = deps.events;
    this.engine = deps.engine;
    this.world = deps.world;
    this.cfg = deps.cfg;
    this.onEnd = typeof deps.onEnd === 'function' ? deps.onEnd : null;
    this.onQuit = typeof deps.onQuit === 'function' ? deps.onQuit : null;
    this.onLog = typeof deps.onLog === 'function' ? deps.onLog : null;
    /** K-13：暂停面板的开/关通知（paused: boolean）。暂停权威仍在 BeatClock，这里只报状态变化。 */
    this.onPauseChange = typeof deps.onPauseChange === 'function' ? deps.onPauseChange : null;
    this._offs = []; // ★ 唯一的释放登记表：每一项都必须是 0 参函数
    this._keys = [];
    this._extra = {};
    this._instances = [];
    this._judgment = null;
    this._judgmentAt = 0;
    this.paused = false;
    this.running = false;
    this.finished = false;
    this.restarts = 0;
    this.startedAtSec = 0;
    this.view = buildView(1280, 720, {});
  }

  /* ---------------- ① 装载 ---------------- */

  /** scene.create() 调一次：建世界层 + 订阅表 + 键位，然后 start()。 */
  create() {
    this.view = buildView(this.scene.scale.width || 1280, this.scene.scale.height || 720, {});
    this.world.init(this.scene, this.view);

    const save = getSave();
    this.judge.setStrictWindow(!!save.options.strictWindow);
    this.judge.setLatency(Number(save.audio.latencyOffset) || 0);
    this.judge.events.clear();

    // §9 单向流：input → Judge → Disassemble（本文件不再写 hp，也不在这里做画面/音频决策）
    this._off(this.judge.onJudgment((j) => this._onJudgment(j)));

    // C3 的四个事件：WORLD 与 SOUND 各自订阅，**不许被反向调用**
    this._off(this.ds.on('hp-change', ({ track, hp }) => this._onHpChange(track, hp)));
    this._off(this.ds.on('disassemble', (p) => this._onDisassemble(p)));
    this._off(this.ds.on('revive', (p) => this._onRevive(p)));
    this._off(this.ds.on('state-change', (p) => this._onStateChange(p)));

    this._bindKeys();
    this.start();
    return this;
  }

  /** 起关 / 重开（R）：同一条路径，保证 20 次重开与首次的登记项数量一致。 */
  start() {
    const cfg = this.cfg;
    this.clock.init({
      bpm: cfg.bpm,
      sections: cfg.sections,
      tempoChanges: cfg.tempoChanges,
      introBeats: cfg.introBeats,
      lengthBeats: cfg.lengthBeats
    });
    this._instances = PG.build(cfg, this.clock);
    this.judge.setWindowScale(Number(cfg.windowScale) || 1);
    this.ds.load(cfg, { instances: this._instances });
    this.ds.bindJudge(this.judge);
    this.ds.attach();
    this.judge.registerObstacles(this._instances);
    this._extra = {};
    this._judgment = null;
    this.finished = false;

    if (this.engine && typeof this.engine.loadLevel === 'function') this.engine.loadLevel(cfg, this.clock);
    const atSec = this.clock.now() + START_LEAD_SEC;
    this.clock.start(atSec);
    this.startedAtSec = atSec;
    // CR-11 批复：arm() 必须在 clock.start(atSec) **之后**
    if (this.engine && typeof this.engine.arm === 'function') this.engine.arm(atSec);
    this.running = true;
    this._log(`L${cfg.id} ${cfg.title || ''} · ${cfg.bpm}BPM · ${cfg.lengthBeats}拍 · 障碍 ${this._instances.filter((o) => o.judgable !== false).length}`);
    return this;
  }

  restart() {
    this.restarts += 1;
    this.judge.reset();
    this.clock.stop();
    this.ds.reset();
    this.start();
    this._log(`重开第 ${this.restarts} 次（分母仍为 ${this.ds.total()}）`);
    return this;
  }

  /* ---------------- ② 帧序 ---------------- */

  /** 由 LevelScene.update 每帧调用。顺序是 CR-11 的裁决，别改。 */
  update() {
    if (!this.running) return;
    const nowSec = this.clock.now(); // ① 取样（全帧只用这一个时刻值）
    if (this.engine) this.engine.ensureRunning(); // ② 自愈（暂停权威在 BeatClock）
    if (this.engine && typeof this.engine.pump === 'function') this.engine.pump(nowSec); // ③ 滚动预调度
    const extra = this._extra;
    this._extra = {};
    extra.judgment = this._judgment;
    extra.hpByTrack = this.ds.hpByTrack();
    extra.disassembledTracks = this.ds.disassembledTracks();
    this.world.sync({ clock: this.clock, instances: this.ds.activeInstances(), view: this.view }, extra);
    if (this._judgmentAt && nowSec - this._judgmentAt > 0.25) this._judgment = null;
  }

  /* ---------------- ③ 事件接线 ---------------- */

  _onJudgment(j) {
    this._judgment = j;
    this._judgmentAt = this.clock.now();
    if (this.onLog && j && j.rule !== 'emptyBeat') this.onLog(`${j.grade}${j.actionMatch === false ? '（动作不符）' : ''} ${j.deltaMs >= 0 ? '+' : ''}${j.deltaMs}ms`);
    // CR-12：判定 → 音效的唯一路由。C2 的 judgment 自带 type（障碍种类）会串进 sfxForEvent 的 ev.type，
    // 所以在这里显式打 kind:'judge'（kind 优先于 type）；penalizes===false 的空拍由 SOUND 侧拦住，不在这判。
    this._sfx(j ? { ...j, kind: 'judge' } : null);
    this.ds.onJudgment(j); // ★ hp 的唯一写入口
  }

  /** CR-12 唯一发声出口：CORE 不持有 grade → 音效名 的映射，只做事件打标与转发。 */
  _sfx(ev) {
    if (!ev || !this.engine || typeof this.engine.playForEvent !== 'function') return false;
    try {
      return this.engine.playForEvent(ev);
    } catch (err) {
      console.error('[LevelRuntime] playForEvent 抛错（已隔离，不影响判定）：', err);
      return false;
    }
  }

  _onHpChange(track, hp) {
    if (this.engine && typeof this.engine.applyHp === 'function') this.engine.applyHp(track, hp, this.ds.hpMax(track));
    this._sfx({ kind: 'hp', track, hp }); // hp 归零 → 'crack'（Sfx.SFX_TRIGGERS 的 C7 口径），途中扣血不出声
  }

  _onDisassemble(p) {
    if (this.engine) this.engine.silence(p.track); // C6 的唯一静音出口（0.1s 线性斜坡）
    this.world.markTrackDisassembled(p.track);
    this.judge.registerObstacles(this.ds.activeInstances()); // 停止生成：该类 pending 实例摘队
    this._log(`拆解 ${p.track} @ beat ${p.beat == null ? '?' : p.beat.toFixed(1)}`);
  }

  _onRevive(p) {
    if (this.engine) this.engine.revive(p.track); // 0.15s 线性斜坡淡入
    // SFX_TRIGGERS 里 'revive' 标注「调用点直发」（C7 无此事件：hp 单调不增），不是 grade 映射，不违反 CR-12。
    if (this.engine && typeof this.engine.playSfx === 'function') this.engine.playSfx('revive');
    this._extra.revivedIds = (this._extra.revivedIds || []).concat(p.ids || []);
    this.judge.registerObstacles(this.ds.activeInstances()); // 当前拍之后恢复生成（不补发历史）
    this._log(`复活 ${p.track} → hp ${p.hp}，新下发 ${p.ids.length} 个实例`);
  }

  _onStateChange(p) {
    this._sfx({ kind: 'state', to: p.to }); // → RESULT 时 Sfx 出 'finish'
    if (p.to === 'SILENCE' && this.engine) this.engine.beatClick(true); // 寂静段逐拍光点音
    if (p.to === 'RESULT') this._finish();
    if (p.from === 'DISASSEMBLED' && p.to === 'PEAK' && p.reason === 'revive') {
      this._log('世界重建：DISASSEMBLED → PEAK（revivedIds 已下发，disassembledTracks 下一帧回退）');
    }
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    const stats = this.ds.stats();
    this._writeSave(stats);
    if (this.engine) this.engine.beatClick(false);
    if (this.onEnd) this.onEnd(stats);
  }

  _writeSave(stats) {
    const key = String(this.cfg.id ?? 0);
    updateSave((save) => {
      save.levels[key] = {
        cleared: stats.disassembled,
        rank: stats.rank,
        perfectRate: Number(stats.perfectRate.toFixed(4)),
        maxCombo: stats.maxCombo,
        miss: stats.miss
      };
      save.meta.totalRuns = (Number(save.meta.totalRuns) || 0) + 1;
      return save;
    });
  }

  /* ---------------- 输入 ---------------- */

  _bindKeys() {
    const kb = this.scene.input && this.scene.input.keyboard;
    if (!kb || typeof kb.addKeys !== 'function') return;
    const codes = [];
    for (const group of Object.keys(KEYMAP)) for (const code of KEYMAP[group]) if (!codes.includes(code)) codes.push(code);
    const keys = kb.addKeys(codes.join(','));
    this._keys = keys;
    const bind = (code, fn) => {
      const k = keys[code];
      if (!k || typeof k.on !== 'function') return;
      k.on('down', fn);
      this._offs.push(() => {
        if (typeof k.off === 'function') k.off('down', fn);
      });
    };
    const capture = (action) => (evt) => {
      if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
      this.onAction(action);
    };
    for (const code of KEYMAP.jump) bind(code, capture('jump'));
    for (const code of KEYMAP.dash) bind(code, capture('dash'));
    bind('R', () => this.restart());
    bind('ESCAPE', () => this.togglePause());
    bind('Q', () => this.quit());
    bind('OPEN_BRACKET', () => this._nudge(-1));
    bind('CLOSE_BRACKET', () => this._nudge(1));
  }

  /**
   * 一次动作输入。时刻在这里取（PERF-02：keydown → 判定 ≤3ms，不经帧）。
   * 寂静段（DIS-06/07）的对象是节拍器光点，不是声部障碍 → 走 stompDot，不产生 judge 事件、不进分母。
   * @param {'jump'|'dash'} action
   */
  onAction(action) {
    if (!this.running || this.paused || (action !== 'jump' && action !== 'dash')) return null;
    const atSec = this.clock.now();
    // W-03 契约的 extra.action：{kind:'jump'|'dash', atSec}。WorldLayer.sync 第 2 参消费它驱动角色，
    // 不填这一项 = 判定/音频照跑但角色原地不动（R3 的断链，见 rounds/R4-CORE.md）。
    this._extra.action = { kind: action, atSec };
    const state = this.ds.state();
    if (state === 'SILENCE') {
      const dot = this.ds.stompDot({ atSec });
      if (dot) {
        this._log(`光点 ${dot.beat} 踩灭`);
        return { kind: 'dot', ...dot };
      }
      return null;
    }
    if (state === 'RESULT') return null;
    return judge(this.judge, action, atSec);
  }

  /** 期望当前最近障碍的动作（DebugPanel / 教学提示用；不参与判定本身）。 */
  expectedActionFor(obstacleType) {
    return expectedAction(obstacleType);
  }

  togglePause() {
    if (!this.running) return false;
    this.paused = !this.paused;
    if (this.paused) this.clock.pause();
    else this.clock.resume();
    if (this.engine) this.engine.setPaused(this.paused);
    this._log(this.paused ? '暂停（clock.pause 是唯一权威）' : '恢复（拍序不重置，R11）');
    if (this.onPauseChange) this.onPauseChange(this.paused);
    return this.paused;
  }

  _nudge(dir) {
    const next = nudgeLatency(this.judge.getLatency(), dir);
    this.judge.setLatency(next);
    updateSave((save) => {
      save.audio.latencyOffset = next;
      return save;
    });
    this._log(`校准 → ${next}ms`);
    return next;
  }

  quit() {
    this._log('退出本关');
    if (this.onQuit) this.onQuit();
  }

  /* ---------------- ④ 统一 teardown ---------------- */

  /**
   * K-05：interval / 音源 / 监听 / Phaser 事件全释放。
   * @param {{disposeAudio?:boolean}} [opt] 离场（回标题）才 dispose 音频图；重开不 dispose
   */
  shutdown(opt = {}) {
    this.running = false;
    this.paused = false;
    while (this._offs.length) {
      const off = this._offs.pop();
      try {
        off();
      } catch (err) {
        console.error('[LevelRuntime] 释放登记项抛错（已隔离）：', err);
      }
    }
    this._keys = [];
    this.judge.reset();
    this.ds.detach();
    this.clock.stop();
    this.world.shutdown();
    if (this.engine) {
      this.engine.beatClick(false);
      if (opt.disposeAudio) this.engine.dispose();
      else this.engine.stop();
    }
    this._extra = {};
    this._judgment = null;
    return this;
  }

  /** 本关已登记的监听数（teardown 断言用）。 */
  listenerCount() {
    return this._offs.length;
  }

  stateLine() {
    return GAME_STATES.join(' → ');
  }

  _off(fn) {
    if (typeof fn === 'function') this._offs.push(fn);
    return this;
  }

  _log(text) {
    if (this.onLog) this.onLog(text);
  }
}

/** onInput 的中转（单独成函数是为了让 contractTest 能替换 judge 桩）。 */
function judge(judgeSystem, action, atSec) {
  return judgeSystem.onInput(action, atSec);
}

export default LevelRuntime;
