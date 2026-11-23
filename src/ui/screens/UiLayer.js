// src/ui/screens/UiLayer.js — Owner: CORE（K-13 五界面的唯一宿主 + K-15 的流程串接）
// 位置：`#ui-root`（L-04：界面是 DOM 覆盖层，canvas 之上、z-index 由 neon.css 给；pointer-events 默认穿透，
// 只有 button/input/面板本体吃事件）。本文件只做「装配数据 → 建 DOM → 挂/摘 → 把动作交回宿主」，
// 不含判定、不含时序、不含颜色字面量（CR-13）。
//
// 生命周期纪律（K-05）：所有 addEventListener 都过 binder 登记，close()/destroy() 必须把节点摘干净，
// 20 次重开不得留下任何一个界面节点（contractTest 的 screens case 就是数这个）。

import { mountRoot, detach, binder } from './dom.js';
import { buildTitle } from './titleScreen.js';
import { buildSelect } from './levelSelect.js';
import { buildPause } from './pauseScreen.js';
import { buildSettings } from './settingsScreen.js';
import { buildResult } from './resultScreen.js';
import { getSave, updateSave } from '../../data/save.js';

const NAMES = ['title', 'select', 'pause', 'settings', 'result'];

/**
 * @param {{root?:object, clock:object, judge:object, ds:object, engine:object,
 *   levels?:Function, gotoLevel:Function, toTitle:Function, runtime?:Function}} deps
 */
export function createUiLayer(deps = {}) {
  const root = mountRoot(deps);
  const bag = binder();
  let currentEl = null;
  let currentName = null;
  let settingsReturn = 'title';

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
    if (!currentEl) return false;
    detach(currentEl);
    currentEl = null;
    currentName = null;
    settingsReturn = 'title';
    return true;
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
      windows: deps.judge && typeof deps.judge.windows === 'function' ? deps.judge.windows() : null
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
        onVolumes: applyVolumes,
        onStrict: applyStrict,
        onLatency: applyLatency,
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
