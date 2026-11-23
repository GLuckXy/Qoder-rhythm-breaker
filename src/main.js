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
import { mountDebugPanel } from './ui/DebugPanel.js';
import { BeatClock, JudgeSystem, DisassembleSystem, soundEngine } from './game/scenes/appDeps.js';
import BootScene, { loadLevel, availableLevelIds } from './game/scenes/BootScene.js';
import TitleScene from './game/scenes/TitleScene.js';
import LevelScene from './game/scenes/LevelScene.js';

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
  backgroundColor: '#0a0e1a',
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

/**
 * ?selftest=render → 世界渲染自检。
 * leader 的 tools/screenshotCheck.mjs 静态 import node:fs，**不能进浏览器包**，
 * 所以这条路由只吃 WorldLayer.snapshot() 的纯数据（已在 R2 里提 CR 请 WORLD 补浏览器入口）。
 * 断言口径与 screenshotCheck 的结构部分对齐：实例非空、坐标有限、右侧生成左侧判定、无 NaN。
 */
export async function runWorldSelftest(opt = {}) {
  const id = Number(opt.level) || route.level || availableLevelIds()[0] || 1;
  const frames = Number(opt.frames) || route.frames;
  const out = { result: 'FAIL', checked: 0, detail: { level: id, errors: [], notes: [], samples: [] } };
  const err = (m) => out.detail.errors.push(m);
  const cfg = await loadLevel(id);
  if (!cfg) {
    err(`level${id}.json 读不到`);
    if (typeof window !== 'undefined') window.__WORLD_SELFTEST__ = out;
    return out;
  }

  if (!game.scene.isActive('Level')) {
    game.scene.stop('Title');
    game.scene.stop('Boot');
    game.scene.start('Level', { cfg });
  }
  await waitFrames(Math.max(2, route.wait));

  const s = levelScene();
  if (!s) {
    err('LevelScene 未起来（runtime 缺失）');
    out.detail.level = id;
    if (typeof window !== 'undefined') window.__WORLD_SELFTEST__ = out;
    return out;
  }
  out.checked = 1;
  await waitFrames(frames);
  const snap = s.snapshot();
  const world = snap.world || {};
  const items = Array.isArray(world.items) ? world.items : [];
  out.samples = items.slice(0, 12);
  out.detail.stats = world.stats || null;
  out.detail.view = world.view || null;
  out.detail.sound = snap.sound || null;
  out.detail.stats2 = snap.stats || null;
  out.detail.consoleErrors = console_.errors;

  if (!items.length) err(`世界里 0 个障碍（L${id} 应有实例渲染）`);
  for (const it of items) {
    if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) err(`实例 ${it.id} 坐标非有限：x=${it.x} y=${it.y}`);
    if (typeof it.id !== 'string' || !it.track) err(`实例缺 id/track：${JSON.stringify(it).slice(0, 80)}`);
  }
  const view = world.view || {};
  for (const k of ['width', 'height', 'judgeX', 'pxPerBeat', 'pxPerSec']) {
    if (!Number.isFinite(view[k]) || view[k] <= 0) err(`view.${k} 异常：${view[k]}`);
  }
  // 右侧生成 → 向左流到判定线：beatsToJudge 越大应越靠右
  const sorted = items.slice().sort((a, b) => a.beatsToJudge - b.beatsToJudge);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].x < sorted[i - 1].x - 0.5) err(`顺序反转：beatsToJudge ${sorted[i].beatsToJudge} 的 x=${sorted[i].x} < 前一个 ${sorted[i - 1].x}`);
  }
  if (console_.errors) err(`console.error ${console_.errors} 条：${console_.lines.join(' | ').slice(0, 200)}`);
  if (!snap.sound || snap.sound.ready !== true) out.detail.notes.push('音频未解锁：自检开始前请先点一下页面（L-09 的手势门）');
  out.result = out.detail.errors.length ? 'FAIL' : 'PASS';
  if (typeof window !== 'undefined') window.__WORLD_SELFTEST__ = out;
  return out;
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
});

/* ------------------------------------------------------------------ */
/* 对外句柄（只读；自检与 leader 验收用）                                */
/* ------------------------------------------------------------------ */

export const api = {
  version: 'R2',
  game,
  clock: BeatClock,
  judge: JudgeSystem,
  ds: DisassembleSystem,
  engine: soundEngine,
  debugPanel,
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
