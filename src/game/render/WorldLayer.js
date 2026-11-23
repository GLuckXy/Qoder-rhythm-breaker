// src/game/render/WorldLayer.js — Owner: WORLD（W-01 总入口 / W-04 挂接 / W-05 下层）
// 上层世界的**总入口**：CORE 的 LevelScene 只需这三个方法（签名即契约，R2 集成请勿改形）：
//
//   import WorldLayer from '../render/WorldLayer.js';
//   const world = new WorldLayer();
//   world.init(scene);                          // scene.create() 里调一次（scene 需有 add.graphics()）
//   world.sync({ clock, instances, view }, extra);   // 每帧一次；与调用时刻/帧序无关（纯函数）
//   world.shutdown();                           // scene 的统一 teardown（K-05）里调
//
// 可选第二参 extra（都由 CORE 的事件驱动，WORLD 只被动消费）：
//   {
//     judgment,                     // C2 Judgment 原样传入（W-07 演出消费 fx 标志）
//     disassembledTracks:[track],   // C3 'disassemble'
//     revivedIds:[id],              // C3 'revive' 后生成侧的新实例 id
//     hpByTrack:{kick:3,...},       // C3 'hp-change' 汇总（远景变安静，VIS-06）
//     action:{kind,atSec},          // ★ 玩家动作（W-03）：kind='jump'|'dash'|'fine'|'hit'，atSec 绝对秒
//     combo,                        // 连击数（≥10 时判定线走金边，W-07）
//     view
//   }
// 查询：world.player / world.snapshot(clockOrNow) / world.live() / world.get(id)
//       world.worldYOf(trackOrInstance, view?)  —— 声部在世界层的 y（剪影/特效对齐用）
//
// 纪律 1：本文件不出现 scene.time / this.time.now / 速度积分。时间只从 clock.now() 读一次，
//         然后作为参数传给所有纯几何函数。
// 纪律 2：判定线 x 与 pxPerBeat 只在 view 里存在，上下层共用（下层 = objects/Timeline.js）。
// 纪律 3：颜色只在 draw 时从 theme 取。
//
// 注意：**不 import Phaser**。绘制容器由 host.add.graphics() 提供，本文件只调它的方法。

import { a11yOf, buildView, isView, resolveView, COLORS } from '../../data/theme.js';
import { Background } from './Background.js';
import EffectSystem from '../systems/EffectSystem.js';
import Spike from '../objects/Spike.js';
import Platform from '../objects/Platform.js';
import Barrage from '../objects/Barrage.js';
import Player, { fixedX } from '../objects/Player.js';
import {
  Obstacle,
  beatsToJudge,
  isLiveState,
  isRenderableInstance,
  laneKeyOf,
  obstacleScreenX,
  readNowSec,
  spawnLeadBeats,
  worldSpawnX,
  worldYFor
} from '../objects/Obstacle.js';

export const WORLD_LAYER_VERSION = 'R1.0';

/** type/track → 包裹类（新增 Platform/Barrage 时只加这张表，不改挂接逻辑） */
const CLASS_BY_TYPE = { spike: Spike, platform: Platform, barrage: Barrage };
const CLASS_BY_TRACK = { kick: Spike, bass: Platform, synth: Barrage };

export class WorldLayer {
  constructor(opts = {}) {
    this.opts = opts;
    this.host = null;
    this.view = buildView(1920, 1080, {});
    this.background = new Background(opts.background || {});
    /** id → Obstacle 子类包裹对象（同 id 二次下发 = 换绑而非追加；不做历史改写） */
    this.wraps = new Map();
    /** 拆解态声部：该类的终态实例不再画（DIS-04/07） */
    this.disassembledTracks = new Set();
    this.calm = 0; // 0..1 远景安静度（VIS-06）
    this.combo = 0; // DIS-09：连击数（UI-04 的金边档），CORE 每帧通过 extra.combo 传入
    this.g = { bg: null, obstacles: null, player: null, fx: null };
    /** 角色（W-03）：opts.player === false 时不建（CORE 想自绘时） */
    this.player = opts.player === false ? null : new Player(opts.player || {});
    this.frameStats = { nowSec: 0, nowBeat: 0, instances: 0, visible: 0, drawn: 0, layers: 0 };
    this.ready = false;
    /**
     * ★ W-07/W-08（R3 接线）：拆解演出系统。opts.fx === false 可整个关掉（光敏/低配）。
     * 世界带 y 由注入函数给出（真相仍是 Obstacle.worldYFor，EffectSystem 不自立几何口径）。
     */
    this.effects =
      opts.fx === false
        ? null
        : new EffectSystem({
            ...(opts.fx || {}),
            trackYOf: (track, v) => worldYFor(track, v, { pitchTier: opts.fx && opts.fx.pitchTier != null ? opts.fx.pitchTier : 2 })
          });
    /** 首轮 sync 只「采纳」CORE 传来的拆解态，不为已存在的拆解重播演出（存档恢复场景） */
    this._primed = false;
  }

  // ------------------------------------------------------------------ 生命周期

  /**
   * @param {object} host Phaser Scene（用到 host.add.graphics()）
   * @param {object} [view] 可先给 view；否则第一次 sync 时按传入尺寸建立
   */
  init(host, view = null) {
    if (!host || !host.add || typeof host.add.graphics !== 'function') {
      throw new Error('[WorldLayer] init(host) 需要一个提供 add.graphics() 的 Phaser Scene');
    }
    this.host = host;
    if (view) this.view = resolveView(view);
    this.g.bg = host.add.graphics();
    this.g.obstacles = host.add.graphics();
    this.g.player = host.add.graphics();
    this.g.fx = host.add.graphics(); // W-07 的碎裂/大字/vignette 画在这里（同帧入口）
    if (this.g.bg.setDepth) this.g.bg.setDepth(0);
    if (this.g.obstacles.setDepth) this.g.obstacles.setDepth(1);
    if (this.g.player.setDepth) this.g.player.setDepth(2);
    if (this.g.fx.setDepth) this.g.fx.setDepth(3);
    // 大字标题（W-07 三要素之一）：Phaser 只当容器（L-09）——文本对象由 host 提供，本文件只管它的值与可见性。
    // host 没有 add.text（Node 断言里的假 host）时留空，snapshot 仍报告描述子。
    if (host.add && typeof host.add.text === 'function' && !this.g.bigText) {
      this.g.bigText = host.add.text(this.view.judgeX, this.view.zones.worldTop, '', {
        fontFamily: this.view.fontFamily,
        fontSize: `${Math.round(this.view.fontPx.display)}px`,
        color: COLORS.white.hex,
        align: 'left'
      });
      if (typeof this.g.bigText.setOrigin === 'function') this.g.bigText.setOrigin(0, 0.5);
      if (typeof this.g.bigText.setVisible === 'function') this.g.bigText.setVisible(false);
      if (this.g.bigText.setDepth) this.g.bigText.setDepth(4);
    }
    if (this.effects) this.effects.layout(this.view);
    this.background.layout(this.view);
    if (this.player) this.player.layout(this.view);
    this.ready = true;
    return this;
  }

  /** 统一 teardown（K-05 的 shutdown 登记点）：销毁 Graphics、清空挂接表 */
  shutdown() {
    for (const key of Object.keys(this.g)) {
      const gfx = this.g[key];
      if (!gfx) continue;
      if (typeof gfx.clear === 'function') gfx.clear();
      if (typeof gfx.destroy === 'function') gfx.destroy();
      this.g[key] = null;
    }
    this.wraps.clear();
    this.disassembledTracks.clear();
    this.background.shutdown();
    if (this.effects) this.effects.reset();
    this.host = null;
    this.ready = false;
    return this;
  }

  // ------------------------------------------------------------------ 每帧入口

  /**
   * @param {{clock:object|number, instances?:object[], view?:object}} frame
   * @param {{judgment?:object, disassembledTracks?:string[], revivedIds?:string[], hpByTrack?:Record<string,number>}} [extra]
   * @returns {object} frameStats（供 DebugPanel）
   */
  sync(frame, extra = {}) {
    if (!this.ready) throw new Error('[WorldLayer] sync() 之前必须先 init(host)');
    const nowSec = readNowSec(frame.clock);
    const view = this._resolveView(frame.view || extra.view);
    const instances = (frame.instances || []).filter(isRenderableInstance);

    if (extra.hpByTrack) this.calm = calmOf(extra.hpByTrack);
    if (Array.isArray(extra.disassembledTracks)) this._syncDisassembled(extra.disassembledTracks, nowSec, view);
    if (this.player) this.applyAction(extra.action, nowSec, view);
    // ★ DIS-09 的连击数（UI-04 的金边档）：CORE 的 ds.counts().combo 原样传入，WORLD 只消费不持有真相。
    if (typeof extra.combo === 'number') this.combo = extra.combo;

    this._reconcile(instances, nowSec, view);
    if (extra.judgment) this.applyJudgment(extra.judgment, nowSec);
    if (Array.isArray(extra.revivedIds)) this.applyRevived(extra.revivedIds, nowSec);
    this._render(nowSec, view, instances);
    return this.frameStats;
  }

  /**
   * ★ W-07 的接线点：CORE 每帧把「已拆解声部集合」原样传进来（C3 'disassemble' 的累积态）。
   * 只对**新增**的 track 开一次演出 → 同一次拆解绝不会被逐帧重播；
   * 首轮 sync 只采纳不重播（从存档恢复的关卡不该一进场就炸）。
   */
  _syncDisassembled(list, nowSec, view) {
    const next = new Set(list);
    if (!this._primed) {
      this._primed = true;
      this.disassembledTracks = next;
      return;
    }
    for (const track of next) {
      if (this.disassembledTracks.has(track)) continue;
      this._fireDisassemble(track, nowSec, view);
    }
    this.disassembledTracks = next;
  }

  /** 三要素同帧的唯一发射口：在场该类障碍的屏幕位置作为碎裂原点（DIS-04「全屏碎裂」） */
  _fireDisassemble(track, nowSec, view) {
    if (!track) return null;
    this.disassembledTracks.add(track);
    const targets = [];
    for (const wrap of this.wraps.values()) {
      if (wrap.track !== track || !wrap.screen.onScreen || wrap.screen.x == null) continue;
      targets.push({ x: wrap.screen.x, y: wrap.screen.y, size: wrap.glyphSize ? wrap.glyphSize(view) : view.sizes.spike.h / 2, track, beat: wrap.beat });
      wrap.markDisassembling();
    }
    if (!this.effects) return null;
    return this.effects.onDisassemble({ track, atSec: nowSec }, nowSec, view, targets);
  }

  _resolveView(view) {
    if (!view) return this.view;
    if (isView(view)) {
      if (view.width !== this.view.width || view.height !== this.view.height) {
        this.view = view;
        this.background.layout(view);
      } else this.view = view;
      return this.view;
    }
    const next = resolveView(view);
    if (next.width !== this.view.width || next.height !== this.view.height) {
      this.view = next;
      this.background.layout(next);
    } else this.view = next;
    return this.view;
  }

  /** 挂接：只增不删地镜像生成侧的实例表；被摘除者 retire 后等演出结束再清 */
  _reconcile(instances, nowSec, view) {
    const lead = spawnLeadBeats(view);
    const seen = new Set();
    for (const inst of instances) {
      if (!inst || typeof inst.id !== 'string') continue;
      seen.add(inst.id);
      let wrap = this.wraps.get(inst.id);
      if (!wrap) {
        if (beatsToJudge(inst, nowSec, view) > lead) continue; // 超出出生提前量：下一帧再看
        const Cls = CLASS_BY_TYPE[inst.type] || CLASS_BY_TRACK[inst.track] || Obstacle;
        wrap = new Cls(inst, { ...this.opts, maxLeadBeats: lead });
        if (wrap.laneKey !== laneOf(inst)) continue; // 跨泳道 id 冲突：不覆盖，交给 SOUND 的 CR-11
        this.wraps.set(inst.id, wrap);
      } else {
        wrap.attach(inst, nowSec);
      }
    }
    for (const [id, wrap] of this.wraps) {
      if (seen.has(id)) continue;
      if (wrap.retired || !isLiveState(wrap.state)) this.wraps.delete(id);
      else wrap.retire();
    }
    // 终态且演出已播完（无待消费 fx）的实例回收
    for (const [id, wrap] of this.wraps) {
      if (!isLiveState(wrap.state) && !wrap.fx.judged && !wrap.fx.missed && !wrap.fx.disintegrating) this.wraps.delete(id);
    }
  }

  _render(nowSec, view, instances) {
    if (this.g.bg) this.background.draw(this.g.bg, { view, nowSec, calm: this.calm, pulse: pulseOf(nowSec, view), combo: this.combo });
    const g = this.g.obstacles;
    if (!g) {
      this._renderFx(nowSec, view);
      return this.frameStats;
    }
    g.clear();
    let visible = 0;
    let drawn = 0;
    for (const wrap of this.wraps.values()) {
      wrap.update(nowSec, view);
      if (!wrap.screen.onScreen) continue;
      visible++;
      if (this.disassembledTracks.has(wrap.track) && !isLiveState(wrap.state)) continue;
      if (wrap.render(g, view)) drawn++;
    }
    this.frameStats = {
      nowSec,
      nowBeat: view.timeToBeat ? view.timeToBeat(nowSec) : nowSec / (view.beatSec || 1),
      instances: instances.length,
      wrapped: this.wraps.size,
      visible,
      drawn,
      layers: this.background.layers.length,
      judgeX: view.judgeX,
      pxPerBeat: view.pxPerBeat,
      spawnX: worldSpawnX(view),
      playerX: this.player ? this.player.screen.x : fixedX(view),
      playerState: this.player ? this.player.screen.state : 'run',
      combo: this.combo
    };
    const fxDrawn = this._renderFx(nowSec, view);
    this.frameStats.fx = fxDrawn;
    return this.frameStats;
  }

  /**
   * ★ W-07/W-08 的每帧演出层：① 把碎片/裂纹/叠印画进 g.fx（depth 3，同帧）
   *   ② 把大字描述子落到 text 对象（同一帧，绝不用 tween 延后一帧）
   *   ③ 震屏 = 把 shakeAt() 的位移**赋值**给各层 x/y（时间的纯函数，不是积分；无事件时归 0）
   */
  _renderFx(nowSec, view) {
    const out = { ops: 0, live: 0, bigText: null, shake: 0 };
    if (!this.ready || !this.effects) return out;
    // PERF-05③：削减系数先落到本实例的 preset 副本上（EffectSystem 每帧读它自己的 q），
    // 再走原有 draw 路径 —— 不改 EffectSystem 一行，也不污染 theme.QUALITY_PRESETS 那张公共表。
    const a = a11yOf(view);
    this._applyFlashScale(a.flash);
    const g = this.g.fx;
    const st = this.effects.stateAt(nowSec, view);
    if (g) {
      g.clear();
      const counts = this.effects.draw(g, { nowSec, view });
      out.ops = counts && counts.total != null ? counts.total : 0;
      out.live = st.liveCount;
    }
    const t = this.g.bigText;
    if (t && st.bigText) {
      const on = st.bigText.alpha > 0 && !st.bigText.done;
      if (typeof t.setText === 'function') t.setText(st.bigText.text);
      if (typeof t.setVisible === 'function') t.setVisible(on);
      if (typeof t.setAlpha === 'function') t.setAlpha(on ? st.bigText.alpha : 0);
      if (typeof t.setScale === 'function') t.setScale(on ? st.bigText.scale : 1);
      if (typeof t.setPosition === 'function') t.setPosition(st.bigText.x, st.bigText.y);
      if (typeof t.setFontSize === 'function') t.setFontSize(st.bigText.fontSizePx);
      out.bigText = on ? { text: st.bigText.text, alpha: st.bigText.alpha, scale: st.bigText.scale, startSec: st.bigText.startSec } : null;
    }
    const sh = st.shake;
    // PERF-05③：震屏是位移型闪烁（preset 的 shakeMaxPx 已被 ×0，这里再乘一次是为了
    // 即便有人另建 EffectSystem 桩、或审美档被换掉，本层也绝不因为一个开关而晃屏）。
    const mag = sh && !sh.done && sh.amp > 0 && a.flash.shake > 0 ? sh : null;
    const dx = mag ? Math.max(-view.width * 0.02, Math.min(view.width * 0.02, mag.x)) : 0;
    const dy = mag ? Math.max(-view.height * 0.02, Math.min(view.height * 0.02, mag.y)) : 0;
    for (const key of Object.keys(this.g)) {
      const gfx = this.g[key];
      if (!gfx || typeof gfx !== 'object') continue;
      gfx.x = dx;
      gfx.y = dy;
    }
    out.shake = mag ? Math.hypot(dx, dy) : 0;
    out.state = st;
    return out;
  }

  /**
   * PERF-05③：把「降低闪烁」的系数写进 **EffectSystem 实例自己的 preset 副本**（`this.q`）。
   * 这些都是 preset 已有的入口字段（vignetteAlpha / bloomIntensity / bloomLayers / shakeMaxPx /
   * flashReductionSafe），所以不必改 EffectSystem 一行，也不必往公共的 QUALITY_PRESETS 里塞状态。
   * 基线值第一次抓下来存着、系数每次从基线重算 ⇒ 中途开关 N 次不会叠乘漂移；
   * 档名一变（W-16 降级 / setQuality）自动重抓。
   * @param {typeof import('../../data/theme.js').FLASH_REDUCTION} f
   */
  _applyFlashScale(f) {
    const q = this.effects && typeof this.effects.preset === 'function' ? this.effects.preset() : null;
    if (!q) return false;
    if (!this._qBase || this._qBase.name !== q.name) {
      this._qBase = {
        name: q.name,
        vignetteAlpha: q.vignetteAlpha,
        bloomIntensity: q.bloomIntensity,
        bloomLayers: q.bloomLayers,
        shakeMaxPx: q.shakeMaxPx,
        flashReductionSafe: q.flashReductionSafe
      };
    }
    q.vignetteAlpha = Math.round(this._qBase.vignetteAlpha * f.vignetteAlpha * 1e6) / 1e6;
    q.bloomIntensity = this._qBase.bloomIntensity * f.bloom;
    q.bloomLayers = Math.round(this._qBase.bloomLayers * f.bloom);
    q.shakeMaxPx = this._qBase.shakeMaxPx * f.shake;
    q.flashReductionSafe = f.forceSafeScale ? true : this._qBase.flashReductionSafe;
    return true;
  }

  /**
   * ★ W-03 的玩家动作入口（CORE 在输入/判定处调用，只带**绝对时刻**，不带位移）。
   * kind: 'jump' | 'dash' | 'fine'（微调）| 'hit'；null/undefined = 本帧无动作。
   * 动作之后的位置/高度全部由 Player 的纯函数在每帧 update 里现算（纪律 1）。
   */
  applyAction(action, nowSec, view = this.view) {
    if (!this.player) return false;
    if (this._lastActionAt !== (action && action.atSec) || this._lastActionKind !== (action && action.kind)) {
      if (action && typeof action.atSec === 'number') {
        if (action.kind === 'jump') this.player.jump(action.atSec, view.beatSec);
        else if (action.kind === 'dash') this.player.dash(action.atSec, view.beatSec);
        else if (action.kind === 'fine' || action.kind === 'micro') this.player.fine(action.atSec, view.beatSec);
        else if (action.kind === 'hit') this.player.hit(action.atSec);
        else if (action.kind === 'run' || action.kind === 'reset') this.player.reset(action.atSec);
      }
      this._lastActionAt = action && action.atSec;
      this._lastActionKind = action && action.kind;
      if (this.effects) this.effects.onAction(action, nowSec, view);
    }
    this.player.layout(view);
    this.player.update(nowSec, view);
    const g = this.g.player;
    if (g) {
      g.clear();
      this.player.render(g, view);
    }
    return true;
  }

  // ------------------------------------------------------------------ 事件消费（被动）

  /** ★ 只转发 CORE 的 Judgment（C2）；本文件不含命中逻辑。演出侧只消费 fx 标志（W-07 的粒子/金闪/vignette） */
  applyJudgment(judgment, nowSec = null) {
    const wrap = this.wraps.get(judgment && judgment.obstacleId);
    const t = typeof nowSec === 'number' ? nowSec : this.frameStats.nowSec;
    if (this.effects) this.effects.onJudgment({ ...(judgment || {}), core: judgment ? judgment.core != null ? judgment.core : !!judgment.isCore : false, atSec: judgment && judgment.atSec != null ? judgment.atSec : t, x: wrap ? wrap.screen.x : null, y: wrap ? wrap.screen.y - (wrap.glyphSize ? wrap.glyphSize(this.view) : 0) : null }, t, this.view);
    if (!wrap) return false;
    const moved = wrap.onJudgment(judgment);
    if (moved && typeof this.opts.onFx === 'function') this.opts.onFx({ ...wrap.fx }, wrap, t);
    return moved;
  }

  /** DIS-04：该声部拆解 → 在场实例标记碎裂 + **同帧**开三要素（走 _fireDisassemble 这个唯一发射口） */
  markTrackDisassembled(track, nowSec = null) {
    const t = typeof nowSec === 'number' ? nowSec : this.frameStats.nowSec;
    const out = this._fireDisassemble(track, t, this.view);
    const onStage = [];
    for (const wrap of this.wraps.values()) {
      if (wrap.track !== track) continue;
      wrap.markDisassembling();
      onStage.push(wrap.id);
    }
    this.lastDisassembleFx = out;
    return onStage;
  }

  /** C3 'revive'：复活的新实例由生成侧下发（新 id，state:'revived'）；这里点亮 fx 并交给 W-08 的扫回演出 */
  applyRevived(ids, nowSec = null) {
    const t = typeof nowSec === 'number' ? nowSec : this.frameStats.nowSec;
    const hit = [];
    const byTrack = new Map();
    for (const id of ids || []) {
      const wrap = this.wraps.get(id);
      if (!wrap) continue;
      wrap.fx.revived = true;
      hit.push(id);
      if (!byTrack.has(wrap.track)) byTrack.set(wrap.track, []);
      byTrack.get(wrap.track).push(id);
    }
    if (this.effects) {
      for (const [track, list] of byTrack) this.effects.onRevive({ track, ids: list, atSec: t }, t, this.view);
    }
    return hit;
  }

  // ------------------------------------------------------------------ 查询

  get(id) {
    return this.wraps.get(id) || null;
  }

  /** 在场（可判定态）包裹对象；W-07 全屏碎裂要遍历的就是这个集合 */
  live() {
    return [...this.wraps.values()].filter((w) => isLiveState(w.state));
  }

  /** 声部在世界的 y（给 Player/剪影/特效对齐用） */
  worldYOf(trackOrInstance, view = null) {
    return worldYFor(trackOrInstance, view || this.view);
  }

  /** 本帧几何快照（纯数据，供 screenshotCheck / DebugPanel / selftest 端点） */
  snapshot(clockOrNow) {
    const nowSec = typeof clockOrNow === 'number' ? clockOrNow : readNowSec(clockOrNow || 0);
    const items = [];
    for (const wrap of this.wraps.values()) {
      items.push({
        id: wrap.id,
        track: wrap.track,
        shape: wrap.shape,
        state: wrap.state,
        core: wrap.core,
        x: obstacleScreenX(wrap.instance, nowSec, this.view),
        y: worldYFor(wrap.track, this.view, { pitchTier: wrap.pitchTier }),
        beatsToJudge: beatsToJudge(wrap.instance, nowSec, this.view)
      });
    }
    return {
      version: WORLD_LAYER_VERSION,
      view: {
        width: this.view.width,
        height: this.view.height,
        judgeX: this.view.judgeX,
        groundY: this.view.groundY,
        pxPerBeat: this.view.pxPerBeat,
        pxPerSec: this.view.pxPerSec,
        rightSpawnX: worldSpawnX(this.view),
        timelineTop: this.view.zones.timelineTop
      },
      player: this.player
        ? { ...this.player.probeAt(nowSec, this.view), fixedX: fixedX(this.view), size: this.view.sizes.player }
        : null,
      nowSec,
      layers: this.background.layers.map((l) => ({ name: l.name, factor: l.factor, traces: l.traces.length })),
      items,
      stats: this.frameStats,
      /** W-07/W-08 演出的本帧状态（?selftest=render 与 DebugPanel 的读数点；不影响既有字段） */
      fx: this.effects ? this.effects.audit(nowSec, this.view) : null
    };
  }

  /** W-16/设置项：演出总开关（光敏安全 = PERF-05 ③）；关掉的瞬间已排队的叠印也归零 */
  setFxEnabled(on) {
    if (!this.effects) return false;
    this.effects.enabled = !!on;
    if (!on && this.g.fx) this.g.fx.clear();
    if (!on && this.g.bigText && typeof this.g.bigText.setVisible === 'function') this.g.bigText.setVisible(false);
    return !!on;
  }

  /** 审美档切换（W-16）：只改 preset，不改分区与 pxPerBeat（VIS-04） */
  setQuality(name) {
    const q = this.effects ? this.effects.setQuality(name) : null;
    if (this.view) this.view.quality = q || this.view.quality;
    return q;
  }
}

function laneOf(inst) {
  // ★ 必须与 Obstacle 包裹对象的 laneKey 同一函数：先前这里另算了一份（`id.split('-')[0..1]`
  //   → `lv01-kick`），而 laneKeyOf 给的是 `1-kick`，两者不等 → 每个实例都被下面的跨道保护
  //   拦掉，上层世界画不出任何障碍（真谱面必现）。现改为唯一口径。
  return laneKeyOf(inst);
}

/** 拆解进度 → 远景安静度（VIS-06 v0：只用 hp 推，不引入新色） */
export function calmOf(hpByTrack) {
  const tracks = Object.keys(hpByTrack || {});
  if (!tracks.length) return 0;
  let sum = 0;
  let n = 0;
  for (const t of tracks) {
    const hp = hpByTrack[t];
    if (typeof hp !== 'number') continue;
    sum += Math.max(0, Math.min(1, hp / 4));
    n++;
  }
  return n ? 1 - sum / n : 0;
}

/**
 * 边缘节拍脉冲强度（VIS-03 第一项）。拍后瞬间 = 1，按拍长指数衰减 →
 * 变速关自动跟随，不用固定 ms tween（失败模式 3）。画在 W-14/EffectSystem。
 */
export function pulseOf(nowSec, view) {
  const beatSec = view.beatSec || 0.5;
  const phase = ((((nowSec % beatSec) + beatSec) % beatSec) / beatSec);
  return Math.max(0, 1 - phase / (view.pulseDecayBeats || 0.45));
}

export default WorldLayer;
