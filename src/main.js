// src/main.js — Owner: CORE（K-05 · R2 真实接线，替换 R1 的占位画面）
// 本文件只做四件事，任何玩法/时序逻辑都不许长在这里：
//   ① Phaser Game 配置 + 场景注册（Boot → Title → Level，T3 三层结构）
//   ② CR-11 批复第 2 点：**手势解锁挂在 main**（pointerdown/keydown/touchstart 三选一由
//      SoundEngine.unlockOnFirstGesture 自己登记），别的模块不再各自 init AudioContext。
//   ③ ?selftest=audio / ?selftest=render 两条自检路由（输出 window.__SOUND_SELFTEST__ /
//      window.__WORLD_SELFTEST__），以及 ?level=N / ?debug=1 深链。
//   ④ 把 R1 就有的 DebugPanel 挂上；导出 window.__CORE__ 只读句柄供自检与 leader 验收。
//
// T4：本文件不读时间——没有 performance.now/Date.now/scene.time/game.loop.delta。
// 帧计数只用「第几帧」这个整数（Phaser 的 POST_UPDATE 信号），要「何时」一律 clock.now()。

import Phaser from 'phaser';
import { COLORS } from './data/theme.js'; // CR-13：底色走 C8 色板，不写字面量
import { mountDebugPanel } from './ui/DebugPanel.js';
import { BeatClock, JudgeSystem, DisassembleSystem, soundEngine } from './game/scenes/appDeps.js';
import BootScene, { loadLevel, availableLevelIds, levelCatalog } from './game/scenes/BootScene.js';
import TitleScene from './game/scenes/TitleScene.js';
import LevelScene from './game/scenes/LevelScene.js';
import { createUiLayer } from './ui/screens/UiLayer.js';
import { uiRef } from './game/scenes/appDeps.js';

/* ------------------------------------------------------------------ */
/* 路由（纯函数，Node 里也能跑）                                        */
/* ------------------------------------------------------------------ */

/**
 * 解析 location.search / hash。
 * @param {string} search
 * @returns {{selftest:string|null, level:number|null, debug:boolean, frames:number, wait:number}}
 */
export function parseRoute(search = '') {
  const q = String(search || '').replace(/^[?#&]/, '&');
  const pick = (key) => {
    const m = new RegExp(`(?:^|[&])${key}(?:=([^&#]*))?`).exec(q);
    return m && m[1] != null && m[1] !== '' ? decodeURIComponent(m[1]) : (m ? '' : null);
  };
  const selftestRaw = pick('selftest');
  const selftest = selftestRaw === 'audio' || selftestRaw === 'render' ? selftestRaw : null;
  const level = Number(pick('level'));
  const num = (key, dflt) => {
    const v = Number(pick(key));
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    selftest,
    level: Number.isFinite(level) && level >= 1 ? Math.trunc(level) : null,
    debug: pick('debug') === '1' || pick('debug') === '',
    frames: num('frames', 90),
    wait: num('wait', 2)
  };
}

const route = parseRoute(typeof window !== 'undefined' ? window.location.search : '');

/* ------------------------------------------------------------------ */
/* 控制台错误计数（L-08：console.error 必须为空，自检要给出可机读证据）   */
/* ------------------------------------------------------------------ */

const console_ = { errors: 0, warns: 0, lines: [] };
if (typeof window !== 'undefined' && window.console) {
  const raw = window.console.error.bind(window.console);
  window.console.error = (...args) => {
    console_.errors += 1;
    if (console_.lines.length < 50) console_.lines.push(args.map((a) => String(a?.message ?? a)).join(' '));
    return raw(...args);
  };
  const rawWarn = window.console.warn.bind(window.console);
  window.console.warn = (...args) => {
    console_.warns += 1;
    return rawWarn(...args);
  };
}

/* ------------------------------------------------------------------ */
/* Game                                                               */
/* ------------------------------------------------------------------ */

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-root',
  backgroundColor: COLORS.base.hex, // CR-13：底色取 C8 色板，不写字面量
  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH, width: 1280, height: 720 },
  audio: { noAudio: true }, // C9：AudioContext 只允许 SOUND 持有（engine.init），Phaser 不得再建第二个
  scene: [BootScene, TitleScene, LevelScene]
});

const debugPanel = mountDebugPanel({ clock: BeatClock, judge: JudgeSystem, autoShow: route.debug });

// CR-11 批复第 2 点：首次用户手势解锁音频，绑在 main（唯一入口），解锁后自行摘监听。
soundEngine.unlockOnFirstGesture(typeof window !== 'undefined' ? window : null);

/** 当前在跑的 LevelScene（没有则 null）。 */
function levelScene() {
  const s = game.scene.isActive('Level') ? game.scene.getScene('Level') : null;
  return s && s.runtime ? s : null;
}

/* ------------------------------------------------------------------ */
/* K-13 界面层 + K-15 流程串接（DOM 覆盖层，leader 决策 L-04）            */
/* ------------------------------------------------------------------ */

/**
 * 全流程唯一的「装谱面 → 起 Level」出口：标题、选关、结算的「下一关」、深链 ?level=N 都收敛到这里，
 * 断点只会出现在这一处（K-15 的零断言检查就是查它）。
 * @param {number} id
 * @returns {Promise<boolean>}
 */
async function gotoLevel(id) {
  ui.close();
  const cfg = await loadLevel(id);
  if (!cfg) {
    ui.showTitle({ notice: `level${id}.json 读不到（SOUND 名下内容）` });
    return false;
  }
  if (game.scene.isActive('Title')) game.scene.stop('Title');
  if (game.scene.isActive('Boot')) game.scene.stop('Boot');
  game.scene.start('Level', { cfg });
  return true;
}

/** 回标题：Q 退出、结算面板的「回标题」都走这里；标题界面由 TitleScene.create 负责弹（单一出口）。 */
function toTitle(data = {}) {
  ui.close();
  if (game.scene.isActive('Level')) game.scene.stop('Level');
  game.scene.start('Title', data);
  return true;
}

const ui = createUiLayer({
  clock: BeatClock,
  judge: JudgeSystem,
  ds: DisassembleSystem,
  engine: soundEngine,
  levels: levelCatalog,
  gotoLevel: (id) => gotoLevel(id),
  toTitle: (data) => toTitle(data),
  runtime: () => {
    const s = levelScene();
    return s ? s.runtime : null;
  }
});
uiRef.current = ui;

/** 只读快照：world 几何 + sound 状态 + 拆解统计（DebugPanel / 验收用，不改变任何状态）。 */
function snapshot() {
  const s = levelScene();
  return {
    route,
    inLevel: !!s,
    soundReady: !!soundEngine.ready,
    clockState: BeatClock.state ? BeatClock.state() : (BeatClock.getState ? BeatClock.getState() : null),
    consoleErrors: console_.errors,
    world: s ? s.snapshot() : null
  };
}

/* ------------------------------------------------------------------ */
/* 自检路由                                                             */
/* ------------------------------------------------------------------ */

/** 等 n 帧（只数帧，不读时间）。 */
function waitFrames(n) {
  return new Promise((resolve) => {
    let left = Math.max(1, Math.floor(n));
    const step = () => {
      left -= 1;
      if (left <= 0) {
        game.events.off(Phaser.Scenes.Events.POST_UPDATE, step);
        resolve(left);
      }
    };
    game.events.on(Phaser.Scenes.Events.POST_UPDATE, step);
  });
}

/**
 * ?selftest=audio → SOUND 名下断言（tools/audioAssert.mjs 是浏览器安全版），
 * 结果写 window.__SOUND_SELFTEST__。CORE 只负责装载谱面并调用，不改它的判定口径。
 */
export async function runSoundSelftest(ids = availableLevelIds()) {
  const levels = [];
  for (const id of ids) {
    const cfg = await loadLevel(id);
    if (cfg) levels.push(cfg);
  }
  const mod = await import('../tools/audioAssert.mjs');
  const res = await mod.run({ levels });
  if (typeof window !== 'undefined') window.__SOUND_SELFTEST__ = res;
  return res;
}

/** WORLD 在 tools/screenshotCheck.mjs:1853 声明的负载版本（照抄常量值，不 import 那个文件——它静态依赖 node:fs）。 */
const SELFTEST_SCHEMA = 'world-selftest/v1';

/**
 * ?selftest=render → 世界渲染自检（W-02 的浏览器侧回传）。
 *
 * 产出 = WORLD 在 tools/screenshotCheck.mjs 头部声明的 **`world-selftest/v1`** 负载，于是
 * `node tools/screenshotCheck.mjs --selftest <file|inline-json|->` 能把浏览器实测折回同一套断言：
 *   { schema, nowSec, viewport:{width,height}, dpr,
 *     world: WorldLayer.snapshot(nowSec),
 *     timeline: new Timeline().snapshot({view,nowSec,instances}),
 *     pixels: [{track,luma}] | [] }
 * 两层吃**同一批 instances 与同一个 view**，否则 runSelftest 的「逐实例 x 比对」会 SKIP。
 * pixels 要 readPixels（绘制真相归 WORLD），CORE 不猜灰度值 → 留空数组，那边自带 SKIP 分支。
 * CORE 自己的结构体检放在 `checks` 顶层键里（screenshotCheck 忽略未知键）。
 * @param {{level?:number,frames?:number,timeline?:boolean}} [opt]
 */
export async function runWorldSelftest(opt = {}) {
  const id = Number(opt.level) || route.level || availableLevelIds()[0] || 1;
  const frames = Number(opt.frames) || route.frames;
  const errors = [];
  const cfg = await loadLevel(id);
  const payload = {
    schema: SELFTEST_SCHEMA,
    level: id,
    nowSec: 0,
    viewport: { width: 1280, height: 720 },
    dpr: typeof window !== 'undefined' ? Number(window.devicePixelRatio) || 1 : 1,
    world: null,
    timeline: null,
    pixels: [],
    checks: { result: 'FAIL', consoleErrors: 0, errors, notes: [], samples: [], stats: null, stats2: null, sound: null }
  };
  const publish = () => {
    if (typeof window !== 'undefined') window.__WORLD_SELFTEST__ = payload;
    return payload;
  };
  if (!cfg) {
    errors.push(`level${id}.json 读不到`);
    return publish();
  }

  if (!game.scene.isActive('Level')) {
    game.scene.stop('Title');
    game.scene.stop('Boot');
    game.scene.start('Level', { cfg });
  }
  await waitFrames(Math.max(2, route.wait));

  const s = levelScene();
  if (!s || !s.runtime) {
    errors.push('LevelScene 未起来（runtime 缺失）');
    return publish();
  }
  await waitFrames(frames);

  const rt = s.runtime;
  const nowSec = rt.clock.now(); // T4：时刻只从 BeatClock 取，这里不碰 performance.now
  const view = rt.view;
  const instances = rt.ds.activeInstances();
  payload.nowSec = nowSec;
  payload.viewport = { width: view.width, height: view.height };
  payload.world = rt.world.snapshot(nowSec);
  if (opt.timeline !== false) {
    try {
      // 动态 import：Timeline 归 WORLD，只在这条路由需要，装不进也只降级掉 timeline 一项。
      const mod = await import('./game/objects/Timeline.js');
      const T = mod.Timeline || mod.default;
      payload.timeline = new T().snapshot({ view, nowSec, instances });
    } catch (err) {
      errors.push(`timeline 侧载入失败：${String(err?.message ?? err)}`);
    }
  }

  const snap = s.snapshot();
  const world = payload.world || {};
  const items = Array.isArray(world.items) ? world.items : [];
  payload.checks.samples = items.slice(0, 12);
  payload.checks.stats = world.stats || null;
  payload.checks.view = world.view || null;
  payload.checks.sound = snap.sound || null;
  payload.checks.stats2 = snap.stats || null;
  payload.checks.consoleErrors = console_.errors;

  if (!items.length) errors.push(`世界里 0 个障碍（L${id} 应有实例渲染）`);
  for (const it of items) {
    if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) errors.push(`实例 ${it.id} 坐标非有限：x=${it.x} y=${it.y}`);
    if (typeof it.id !== 'string' || !it.track) errors.push(`实例缺 id/track：${JSON.stringify(it).slice(0, 80)}`);
  }
  const wv = world.view || {};
  for (const k of ['width', 'height', 'judgeX', 'pxPerBeat', 'pxPerSec']) {
    if (!Number.isFinite(wv[k]) || wv[k] <= 0) errors.push(`world.view.${k} 异常：${wv[k]}`);
  }
  if (!payload.timeline) errors.push('timeline 快照缺失（上下层对齐无从比对）');
  else {
    const t = payload.timeline;
    for (const k of ['judgeX', 'pxPerBeat', 'windowRightX']) {
      if (!Number.isFinite(t[k])) errors.push(`timeline.${k} 异常：${t[k]}`);
    }
    if (Number.isFinite(wv.judgeX) && Math.abs(wv.judgeX - t.judgeX) > 1e-6) errors.push(`上下层判定线不一致：world=${wv.judgeX} timeline=${t.judgeX}`);
    const seen = new Set(items.map((i) => i.id));
    if (!(t.markerXs || []).some((m) => seen.has(m.id))) errors.push('world.items 与 timeline.markerXs 无 id 交集（两层没吃到同一批 instances）');
  }
  // 右侧生成 → 向左流到判定线：beatsToJudge 越大应越靠右
  const sorted = items.slice().sort((a, b) => a.beatsToJudge - b.beatsToJudge);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].x < sorted[i - 1].x - 0.5) errors.push(`顺序反转：beatsToJudge ${sorted[i].beatsToJudge} 的 x=${sorted[i].x} < 前一个 ${sorted[i - 1].x}`);
  }
  if (console_.errors) errors.push(`console.error ${console_.errors} 条：${console_.lines.join(' | ').slice(0, 200)}`);
  if (!snap.sound || snap.sound.ready !== true) payload.checks.notes.push('音频未解锁：自检开始前请先点一下页面（L-09 的手势门）');
  payload.checks.errors = errors;
  payload.checks.result = errors.length ? 'FAIL' : 'PASS';
  return publish();
}

async function bootSelftest() {
  try {
    if (route.selftest === 'audio') await runSoundSelftest();
    else if (route.selftest === 'render') await runWorldSelftest({ level: route.level });
  } catch (e) {
    const bad = { result: 'FAIL', checked: 0, detail: { errors: [String(e?.stack ?? e)] } };
    if (typeof window !== 'undefined') {
      window[route.selftest === 'audio' ? '__SOUND_SELFTEST__' : '__WORLD_SELFTEST__'] = bad;
    }
  }
}

game.events.once(Phaser.Scenes.Events.POST_UPDATE, () => {
  if (route.selftest) bootSelftest();
  else if (route.level) gotoLevel(route.level); // K-15：?level=N 深链直达（标题界面会被这一步关掉）
});

/* ------------------------------------------------------------------ */
/* 对外句柄（只读；自检与 leader 验收用）                                */
/* ------------------------------------------------------------------ */

export const api = {
  version: 'R3',
  game,
  clock: BeatClock,
  judge: JudgeSystem,
  ds: DisassembleSystem,
  engine: soundEngine,
  debugPanel,
  ui,
  gotoLevel,
  toTitle,
  route,
  levelScene,
  snapshot,
  parseRoute,
  loadLevel,
  availableLevelIds,
  runSoundSelftest,
  runWorldSelftest
};

if (typeof window !== 'undefined') {
  window.__CORE__ = api;
  window.__CONSOLE_ERRORS__ = console_;
}

game.events.once('destroy', () => {
  const s = levelScene();
  if (s) s.teardown();
  debugPanel.destroy();
  soundEngine.dispose();
});

export default api;
