// src/ui/screens/UiLayer.js — Owner: CORE（K-13 五界面的唯一宿主 + K-15 的流程串接 + K-14 校准小游戏入口）
// 位置：`#ui-root`（L-04：界面是 DOM 覆盖层，canvas 之上、z-index 由 neon.css 给；pointer-events 默认穿透，
// 只有 button/input/面板本体吃事件）。本文件只做「装配数据 → 建 DOM → 挂/摘 → 把动作交回宿主」，
// 不含判定、不含时序、不含颜色字面量（CR-13）。
//
// 生命周期纪律（K-05）：所有 addEventListener 都过 binder 登记，close()/destroy() 必须把节点摘干净，
// 20 次重开不得留下任何一个界面节点（contractTest 的 screens case 就是数这个）。
//
// `ui` 音效（SFX_TRIGGERS：「调用点直发：UI 按钮与关卡选择」）：唯一通路是 `playUiSound()` →
// `engine.playSfx('ui')`（C6 冻结方法），五个界面的每一颗按钮都调它。**这里不 new AudioContext、
// 不挂解锁监听**（CR-11：解锁只在 main.js 一处），引擎没接上时静默跳过。

import { mountRoot, detach, binder, setFlashReduced } from './dom.js';
import { buildTitle } from './titleScreen.js';
import { buildSelect } from './levelSelect.js';
import { buildPause } from './pauseScreen.js';
import { buildSettings } from './settingsScreen.js';
import { buildResult } from './resultScreen.js';
import { createCalibrationPanel, calibrationAvailability } from '../Calibration.js';
import { getSave, updateSave } from '../../data/save.js';

const NAMES = ['title', 'select', 'pause', 'settings', 'result', 'calibration'];

/**
 * @param {{root?:object, clock:object, judge:object, ds:object, engine:object,
 *   levels?:Function, gotoLevel:Function, toTitle:Function, runtime?:Function,
 *   cal?:{clock?:object, now?:Function, click?:Function}}} deps
 */
export function createUiLayer(deps = {}) {
  const root = mountRoot(deps);
  // PERF-05③（光敏安全）：勾过「降低闪烁」的玩家重开页面，第一帧就得拿到 data-rb-flash，
  // 不能等第一次进设置页才补——「先闪一下再说」在这种开关上不成立。
  setFlashReduced(!!getSave().options.reduceFlash);
  const bag = binder();
  let currentEl = null;
  let currentName = null;
  let settingsReturn = 'title';
  let calPanel = null; // K-14：校准面板只许同时存在一份（会话在跑时它持有那个独立 BeatClock）

  /* ---------------- 存档侧的写入口（唯一一份，界面不各自存） ---------------- */

  function applyVolumes(v) {
    if (deps.engine && typeof deps.engine.setVolumes === 'function') deps.engine.setVolumes(v);
    updateSave((s) => {
      s.audio.master = Number(v.master);
      s.audio.music = Number(v.music);
      s.audio.sfx = Number(v.sfx);
      return s;
    });
  }

  function applyStrict(on) {
    if (deps.judge && typeof deps.judge.setStrictWindow === 'function') deps.judge.setStrictWindow(!!on);
    updateSave((s) => {
      s.options.strictWindow = !!on;
      return s;
    });
  }

  /**
   * TIM-05 / PERF-05③：两个辅助线/闪烁开关的唯一写口（写档仍走 updateSave 这一条路，SAV-02）。
   * 消费侧不需要这里通知：`LevelRuntime._syncA11y()` 每帧从 `getSave()` 现算 `view.a11y`，
   * canvas 侧同帧跟上；CSS 侧由 settingsScreen 自己调 `setFlashReduced`。
   */
  function applyOption(key, on) {
    if (key !== 'showTimelineGuides' && key !== 'reduceFlash') return false;
    updateSave((s) => {
      s.options[key] = !!on;
      return s;
    });
    return true;
  }

  function applyLatency(ms) {
    if (deps.judge && typeof deps.judge.setLatency === 'function') deps.judge.setLatency(Number(ms) || 0);
    updateSave((s) => {
      s.audio.latencyOffset = Number(ms) || 0;
      return s;
    });
  }

  function runtime() {
    return typeof deps.runtime === 'function' ? deps.runtime() : null;
  }

  /** 当前生效的延迟补偿（judge 是真相，存档只是它的镜像）。 */
  function readLatency() {
    if (deps.judge && typeof deps.judge.getLatency === 'function') return Number(deps.judge.getLatency()) || 0;
    return Number(getSave().audio.latencyOffset) || 0;
  }

  /* ---------------- `ui` 音效：五界面 + 关卡选择的唯一调用点 ---------------- */

  function playUiSound() {
    if (deps.engine && typeof deps.engine.playSfx === 'function') {
      try {
        deps.engine.playSfx('ui');
      } catch {
        /* 音效不许把界面点击带下水（引擎未解锁时 SoundEngine 自己会跳过） */
      }
      return true;
    }
    return false;
  }

  /** deps.levels() 允许是同步数组或异步清单（要 await level*.json 的标题/BPM）。 */
  function levelList() {
    const raw = typeof deps.levels === 'function' ? deps.levels() : [];
    return Promise.resolve(raw).then((list) => (Array.isArray(list) ? list : []));
  }

  /* ---------------- 挂载 / 卸载 ---------------- */

  function mount(name, el) {
    close();
    if (!el || !root || typeof root.appendChild !== 'function') return null;
    el.setAttribute('data-screen', name);
    root.appendChild(el);
    currentEl = el;
    currentName = name;
    return el;
  }

  /** 关掉当前界面（不动其它层）。返回是否真的摘掉了节点。 */
  function close() {
    closeCalibration();
    if (!currentEl) return false;
    detach(currentEl);
    currentEl = null;
    currentName = null;
    settingsReturn = 'title';
    return true;
  }

  /* ---------------- ⑥ 校准小游戏（K-14 完整版；入口在设置与暂停两处） ---------------- */

  /**
   * 校准面板停表 + 摘键盘监听（DOM 由 close() 摘）。没开过面板就是空操作。
   * @returns {boolean}
   */
  function closeCalibration() {
    if (!calPanel) return false;
    calPanel.stop(); // 会话 stop() = clock.stop()（PERF-08 不留轮询）+ window keydown 退订
    calPanel = null;
    return true;
  }

  /**
   * @param {{back?:Function, from?:string}} [opt] back = 「取消/返回」要回哪一层（调用方给闭包；
   *   沿用 showSettings 的老坑规避：mount()→close() 会复位 settingsReturn，回跳目标必须提前抓住）
   */
  function showCalibration(opt = {}) {
    const backTo = typeof opt.back === 'function' ? opt.back : () => showTitle();
    closeCalibration();
    const panel = createCalibrationPanel({
      engine: deps.engine,
      cal: deps.cal, // 测试注入口（contractTest latency case 用 MockClock 驱动会话）；生产缺省 = 独立 BeatClock + engine.ctx.currentTime
      host: typeof window !== 'undefined' ? window : null,
      availability: () => {
        // K-21：这里给的是**函数**而不是建面板时的那一份快照——面板每次 render/start 前重读，
        // 于是「面板开着时把主音量拉到 0」（K-20）或「中途被暂停」都能立刻改成只微调。
        const r = runtime();
        return calibrationAvailability(deps.engine, r ? { paused: !!r.paused } : null);
      },
      apply: applyLatency, // ★ 唯一写入通路：judge.setLatency + updateSave({audio:{latencyOffset}})
      getLatency: readLatency,
      windows: () => (deps.judge && typeof deps.judge.windows === 'function' ? deps.judge.windows() : null),
      uiSound: playUiSound,
      onBack: () => {
        closeCalibration();
        backTo();
      }
    });
    // 先 mount 再登记：mount() 内部会 close()，而 close() 会顺手关掉上一份校准面板，
    // 反过来写就是「刚登记就被自己关掉」。
    const el = mount('calibration', panel.element);
    calPanel = panel;
    return el;
  }

  /* ---------------- ① 标题 ---------------- */

  function showTitle(data = {}) {
    return levelList().then((levels) => {
      const save = getSave();
      const resume = (levels.find((l) => !((save.levels || {})[String(l.id)] || {}).cleared) || levels[0] || { id: 1 }).id;
      return mount(
        'title',
        buildTitle(
          { notice: data.notice || '', levels, resumeId: resume },
          {
            engine: deps.engine,
            uiSound: playUiSound,
            gotoLevel: (id) => deps.gotoLevel(id),
            onSelect: () => showSelect(),
            onSettings: () => showSettings('title')
          }
        )
      );
    });
  }

  /* ---------------- ② 选关 ---------------- */

  function showSelect() {
    return levelList().then((levels) =>
      mount(
        'select',
        buildSelect(
          { levels, entries: getSave().levels || {} },
          {
            uiSound: playUiSound,
            onPick: (id) => deps.gotoLevel(id),
            onBack: () => {
              const back = settingsReturn === 'pause' ? showPause() : showTitle();
              return back;
            }
          }
        )
      )
    );
  }

  /* ---------------- ③ 暂停（时钟由 runtime.togglePause 走 clock.pause/resume） ---------------- */

  function pauseData() {
    const rt = runtime();
    const ds = deps.ds;
    const stats = ds && typeof ds.stats === 'function' ? ds.stats() : {};
    const hpMax = {};
    for (const t of ['kick', 'bass', 'synth']) hpMax[t] = ds && typeof ds.hpMax === 'function' ? ds.hpMax(t) : 0;
    return {
      stats,
      hpMaxByTrack: hpMax,
      clock: deps.clock,
      latencyMs: deps.judge && typeof deps.judge.getLatency === 'function' ? deps.judge.getLatency() : NaN,
      level: (rt && rt.cfg) || null,
      stateLine: rt && typeof rt.stateLine === 'function' ? rt.stateLine() : ''
    };
  }

  function showPause() {
    settingsReturn = 'pause';
    return mount(
      'pause',
      buildPause(pauseData(), {
        uiSound: playUiSound,
        onCalibrate: () => showCalibration({ from: 'pause', back: () => showPause() }),
        onResume: () => {
          const rt = runtime();
          if (rt && rt.paused) rt.togglePause(); // ★ 唯一解冻路径：clock.resume()
          close();
        },
        onRestart: () => {
          const rt = runtime();
          close();
          if (rt && rt.paused) rt.togglePause(); // 面板里重开要先交还时钟，否则重开完仍是暂停态（卡死）
          if (rt && typeof rt.restart === 'function') rt.restart();
        },
        onSettings: () => showSettings('pause'),
        onQuit: () => {
          const rt = runtime();
          close();
          if (rt && typeof rt.quit === 'function') rt.quit();
          else deps.toTitle({ notice: '回到标题' });
        }
      })
    );
  }

  /* ---------------- ④ 设置（音量三通道 / 严格窗口 / 延迟显示，K-14 降级版） ---------------- */

  function settingsData() {
    const save = getSave();
    const vol = deps.engine && typeof deps.engine.getVolumes === 'function' ? deps.engine.getVolumes() : { master: save.audio.master, music: save.audio.music, sfx: save.audio.sfx };
    return {
      volumes: vol,
      strictWindow: !!save.options.strictWindow,
      latencyMs: deps.judge && typeof deps.judge.getLatency === 'function' ? deps.judge.getLatency() : Number(save.audio.latencyOffset) || 0,
      windows: deps.judge && typeof deps.judge.windows === 'function' ? deps.judge.windows() : null,
      // TIM-05 / PERF-05③：这两个字段以前只是写进档里没人读（假开关）。
      // showTimelineGuides 的「未设置」按开处理（老档没这个键时保持出厂表现）。
      showTimelineGuides: save.options.showTimelineGuides !== false,
      reduceFlash: !!save.options.reduceFlash
    };
  }

  function showSettings(from) {
    settingsReturn = from === 'pause' ? 'pause' : 'title';
    // mount() 里会先 close()，而 close() 把 settingsReturn 复位 —— 回跳目标必须在挂载前就地记住，
    // 否则「暂停 → 设置 → 返回」会既不回暂停面板也不回标题（时钟还停着，等于卡死）。
    const origin = settingsReturn;
    return mount(
      'settings',
      buildSettings(settingsData(), {
        uiSound: playUiSound,
        onVolumes: applyVolumes,
        onStrict: applyStrict,
        onOption: applyOption,
        onLatency: applyLatency,
        onCalibrate: () => showCalibration({ from: 'settings', back: () => showSettings(origin) }),
        onBack: () => {
          close();
          if (origin === 'pause') showPause();
          else if (!runtime()) showTitle();
        }
      })
    );
  }

  /* ---------------- ⑤ 结算 ---------------- */

  function showResult(stats, data = {}) {
    const rt = runtime();
    const level = data.level || (rt && rt.cfg) || null;
    return levelList().then((levels) => {
      const ids = levels.map((l) => l.id);
      const cur = Number((level || {}).id) || 0;
      const idx = ids.indexOf(cur);
      const hasNext = idx >= 0 && idx < ids.length - 1;
      const save = getSave();
      const allCleared = levels.length > 0 && levels.every((l) => (save.levels[String(l.id)] || {}).cleared);
      const hpMax = {};
      for (const t of ['kick', 'bass', 'synth']) hpMax[t] = deps.ds && typeof deps.ds.hpMax === 'function' ? deps.ds.hpMax(t) : 0;
      return mount(
        'result',
        buildResult(
          { stats, level, hpMax, hasNext, nextId: hasNext ? ids[idx + 1] : null, allCleared },
          {
            uiSound: playUiSound,
            onNext: (id) => deps.gotoLevel(id),
            onRetry: () => {
              close();
              if (rt && typeof rt.restart === 'function') rt.restart();
            },
            onSelect: () => showSelect(),
            onTitle: (d) => {
              close();
              deps.toTitle(d || {});
            }
          }
        )
      );
    });
  }

  /* ---------------- 生命周期 ---------------- */

  function destroy() {
    close();
    bag.offAll();
    currentEl = null;
    currentName = null;
  }

  return {
    names: NAMES,
    root: root || null,
    mounted: !!root,
    current: () => currentName,
    element: () => currentEl,
    showTitle,
    showSelect,
    showPause,
    showSettings,
    showResult,
    showCalibration,
    calibration: () => calPanel,
    playUiSound,
    close,
    destroy,
    applyVolumes,
    applyStrict,
    applyLatency,
    listenerCount: () => bag.count(),
    /** 宿主（LevelScene）在 create() 里调用：保证任何一次进关都不带着上一次的界面。 */
    onLevelStart: () => close()
  };
}

export default createUiLayer;
