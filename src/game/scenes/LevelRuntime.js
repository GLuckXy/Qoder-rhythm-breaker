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
//
// W-13 教学浮层的最小接线（leader 授权，只做四件事，全部走已有通道）：
//   装载时 overlay.init(scene, view) → 每帧 overlay.sync({clock, beat}) → H/点击 → skipTutorial() 落存档
//   → shutdown() 里释放。浮层的显隐与换步**只由拍决定**（拍来自 BeatClock），本文件不替它记任何秒表。
//
// TIM-05 / PERF-05③ 的两个存档开关（本轮接上，此前是零消费者的死字段）：
//   create() 建 view 时带上 save.options → update() 里 _syncA11y() 每帧比一次布尔保持新鲜
//   → WorldLayer / Background 从 view.a11y 读。写档仍然只有设置面板那一条 updateSave 通路。

import { a11yOf, buildView } from '../../data/theme.js';
import { nudgeLatency } from '../../data/config.js';
import { getSave, updateSave } from '../../data/save.js';
import * as PG from '../systems/PatternGenerator.js';
import { expectedAction } from '../systems/JudgeSystem.js';
import { GAME_STATES } from '../systems/DisassembleSystem.js';
import OverlayLayer from '../render/OverlayLayer.js';
import HudLayer from '../render/HudLayer.js';

/** 键位（JDG-01）。左右微调属 WORLD 的角色，这里只登记不实现。 */
export const KEYMAP = Object.freeze({
  jump: ['SPACE', 'J'],
  dash: ['K'],
  restart: ['R'],
  pause: ['ESC'],
  calDown: ['OPEN_BRACKET'],
  calUp: ['CLOSE_BRACKET'],
  quit: ['Q'],
  /** W-13 教学浮层的跳过键。**不能**复用空格/J：教学期玩家正要按它拿首个 PERFECT。 */
  skipTutorial: ['H']
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
    /**
     * W-13 教学浮层（WORLD 名下的纯呈现层）。这里只做三件事：给 view/host、给拍、把跳过写进存档。
     * 键面来自 KEYMAP（唯一键位真相），动作归属来自 JudgeSystem.expectedAction（唯一动作真相）——
     * 浮层自己不复述任何一张表，所以改键 / 改判定动作都不会让教学文案变成假话。
     */
    this.overlay = deps.overlay || new OverlayLayer({ expectedAction: (type) => this.expectedActionFor(type), keymap: KEYMAP });
    /** UI-04 / DIS-09：游戏内 HUD（左上连击 + 右上三声部耐久 ×3 + 顶部 8% 带）。
     *  与 world/overlay 同一个 host、同一个 view；数据源 = ds.counts() + ds.hpByTrack()，不另持真相。 */
    this.hud = deps.hud || new HudLayer();
  }

  /* ---------------- ① 装载 ---------------- */

  /** scene.create() 调一次：建世界层 + 订阅表 + 键位，然后 start()。 */
  create() {
    // TIM-05 / PERF-05③：存档里的两个开关从「建 view」这一刻就带着（view 是渲染层唯一读侧）。
    // 开关在设置里被改动时不必重开关卡 —— update() 每帧复核一次，见 _syncA11y()。
    this.view = buildView(this.scene.scale.width || 1280, this.scene.scale.height || 720, a11yOf(getSave().options));
    this.world.init(this.scene, this.view);
    this.overlay.init(this.scene, this.view); // W-13：与 world 同一个 host、同一个 view
    this.hud.init(this.scene, this.view);     // UI-04：与 world/overlay 同一个 host、同一个 view

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
    this._bindPointer();
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
    this._extra = {};
    this._judgment = null;
    this.finished = false;
    // W-13：起关与重开（R）是同一条路 ⇒ 本局浮层显示态清零，「是否已跳过」只认存档。
    // 教学态若跨局残留（第 20 拍还浮着第 3 步），T6 的 20 次重开一致性就先崩在这里。
    this.overlay.beginRun({ levelId: cfg.id, skipped: !!(getSave().options || {}).tutorialSkipped });

    if (this.engine && typeof this.engine.loadLevel === 'function') this.engine.loadLevel(cfg, this.clock);
    const atSec = this.clock.now() + START_LEAD_SEC;
    this.clock.start(atSec);
    this.startedAtSec = atSec;
    // DEF-03（浏览器实测：游戏永远走不到结算屏）：`BeatClock.start()` 会清空派发队列，
    // 而 `ds.attach()` 正是用 `clock.schedule(_finalize, timeAtBeat(lengthBeats))` 注册「关卡终点」。
    // 所以**一切向时钟注册事项的 attach 必须发生在 start 之后**——顺序换回来，收口那一发才打得出去。
    // CR-11 的「arm 必须在 clock.start 之后」继续成立。
    this.ds.attach();
    this.judge.registerObstacles(this._instances);
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
    this._syncA11y(); // 设置里刚翻的开关必须在 world.sync 之前落到 view 上（同帧生效，不用重开）
    extra.judgment = this._judgment;
    extra.hpByTrack = this.ds.hpByTrack();
    extra.disassembledTracks = this.ds.disassembledTracks();
    this.world.sync({ clock: this.clock, instances: this.ds.activeInstances(), view: this.view }, extra);
    // W-13：浮层吃**同一帧的同一个取样点**（beat = clock.beatAt(nowSec)），不另开第二个时间源。
    this.overlay.sync({ clock: this.clock, beat: this.clock.beatAt(nowSec), view: this.view });
    // UI-04：HUD 读同一帧的 combo / hp / 已拆解集合（数据源 = ds，本层不另持真相）。
    // 不传 a11y：HUD 从 view.a11y 读（_syncA11y 每帧已刷），避免多一次 getSave()。
    if (this.hud) {
      this.hud.sync({
        view: this.view,
        combo: this.ds.counts().combo,
        hpByTrack: extra.hpByTrack,
        hpMaxByTrack: { kick: this.ds.hpMax('kick'), bass: this.ds.hpMax('bass'), synth: this.ds.hpMax('synth') },
        disassembledTracks: extra.disassembledTracks
      });
    }
    if (this._judgmentAt && nowSec - this._judgmentAt > 0.25) this._judgment = null;
  }

  /**
   * TIM-05 / PERF-05③：把 `save.options` 的两个开关保持到 `view.a11y` 上（渲染层每帧读 view）。
   * `getSave()` 返回的是 save.js 的内存单例（不在帧里读 localStorage），加上这里只比两个布尔，
   * 代价低于本帧已有的任何一次 Math.hypot ⇒ 所以用「每帧复核」换掉「订阅/事件通道」这套接线：
   * 设置面板翻完开关，下一帧世界就变，不必重开本关，也不新增任何跨模块耦合（T5 只是追加字段）。
   * 只做布尔相等比较 ⇒ 无抖动写入；几何、分区、pxPerBeat 一律不动（T5 不许重定义既有字段）。
   * @returns {boolean} 本帧是否发生了切换
   */
  _syncA11y() {
    const next = a11yOf(getSave().options);
    const cur = this.view.a11y;
    if (cur && cur.showTimelineGuides === next.showTimelineGuides && cur.reduceFlash === next.reduceFlash) return false;
    this.view.a11y = next;
    return true;
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
    this.judge.syncObstacles(this.ds.activeInstances()); // 停止生成：该类 pending 实例摘队（不改写终态，见 R5 MISS 风暴）
    this._log(`拆解 ${p.track} @ beat ${p.beat == null ? '?' : p.beat.toFixed(1)}`);
  }

  _onRevive(p) {
    if (this.engine) this.engine.revive(p.track); // 0.15s 线性斜坡淡入
    // SFX_TRIGGERS 里 'revive' 标注「调用点直发」（C7 无此事件：hp 单调不增），不是 grade 映射，不违反 CR-12。
    if (this.engine && typeof this.engine.playSfx === 'function') this.engine.playSfx('revive');
    this._extra.revivedIds = (this._extra.revivedIds || []).concat(p.ids || []);
    this.judge.syncObstacles(this.ds.activeInstances()); // 当前拍之后恢复生成（不补发历史、不重开别人的队列）
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
    // PRD:559「写档在结算出现时完成」：结算是一次性的终态写入，不 rides SAV-02 的 500ms 节流
    //（节流是给音量拖动用的）。异步 = 玩家在结算后立刻关页就会丢成绩。
    updateSave(
      (save) => {
        save.levels[key] = {
          cleared: stats.disassembled,
          rank: stats.rank,
          perfectRate: Number(stats.perfectRate.toFixed(4)),
          encounterRate: Number(stats.encounterRate.toFixed(4)),
          maxCombo: stats.maxCombo,
          miss: stats.miss
        };
        save.meta.totalRuns = (Number(save.meta.totalRuns) || 0) + 1;
        return save;
      },
      { throttleMs: 0 }
    );
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
    for (const code of KEYMAP.skipTutorial) bind(code, () => this.skipTutorial('key'));
    bind('R', () => this.restart());
    bind('ESCAPE', () => this.togglePause());
    bind('Q', () => this.quit());
    bind('OPEN_BRACKET', () => this._nudge(-1));
    bind('CLOSE_BRACKET', () => this._nudge(1));
  }

  /**
   * W-13 的第二条跳过通道：点浮层任意处（PRD 开篇「点击/任意键跳过教学浮层」）。
   * 这里只读指针坐标做命中测试，**不吃玩家的动作键**：浮层期按空格仍然是一次正常跳跃。
   * 监听照 K-05 登记进 this._offs，与键盘、事件订阅同生同灭（20 次重开不遗留）。
   */
  _bindPointer() {
    const input = this.scene.input;
    if (!input || typeof input.on !== 'function') return;
    const onDown = (p) => {
      if (!p || !this.overlay || !this.overlay.visible) return;
      const x = Number(p.worldX != null ? p.worldX : p.x);
      const y = Number(p.worldY != null ? p.worldY : p.y);
      if (this.overlay.hitTest(x, y)) this.skipTutorial('pointer');
    };
    input.on('pointerdown', onDown);
    this._offs.push(() => {
      if (typeof input.off === 'function') input.off('pointerdown', onDown);
    });
  }

  /**
   * W-13：关掉教学浮层并落存档 ⇒ 下一次进第 1 关不再打扰（PRD P2「第 2 次进第 1 关的人不需要再看」）。
   * 只写 save.options.tutorialSkipped 这一个追加字段；不碰判定、不碰音频、不碰关卡数据。
   * @param {'key'|'pointer'|'api'} [source]
   */
  skipTutorial(source = 'api') {
    if (!this.overlay.skip(source)) return false; // 本就没有浮层可关 ⇒ 不写存档，也不刷日志
    updateSave((save) => {
      save.options.tutorialSkipped = true;
      return save;
    });
    this._log(`教学浮层已跳过（${source}），下次进第 1 关不再出现`);
    return true;
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

  /**
   * 期望当前最近障碍的动作（DebugPanel / **W-13 教学浮层**用；不参与判定本身）。
   * 浮层的「哪种障碍按哪个键」必须从这里问，不许另立一张表 —— 否则改判定会悄悄把教学变成假话。
   */
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
    this.overlay.shutdown(); // W-13：graphics/text 容器与 world 一起释放（监听已在 _offs 里逐条摘掉）
    this.hud.shutdown();     // UI-04：HUD 的 graphics/text 容器与 world/overlay 一起释放
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
