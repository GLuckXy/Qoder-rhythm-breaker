// tools/screenshotCheck.mjs — Owner: WORLD（W-02 / `npm run check:render`）
// Node 侧「几何 + 纯函数」渲染门禁：不需要浏览器、不需要 Phaser、不需要音频。
//
// 为什么能在 Node 里断言渲染：src/data/theme.js 与 src/game/objects|render 下的几何全部是
// **纯函数 + 纯数据**（不 import Phaser、不 import 时钟，时间由调用方以 nowSec 传入）。
// 本工具用「录制用 Graphics」（假 Phaser Graphics）驱动**生产代码路径本身**
// （WorldLayer / Timeline / Background / Obstacle / Spike），而不是复制一份公式来自证。
//
// 断言组（组名后缀 = TASKBOARD 的 check id）：
//   render:zones        分区比 8/60/32 → 1080p 像素值 + 绘制证据
//   render:judgeX       判定线：上下层同 x、角色固定 x = 判定线 x = 0.30W（DoD：< 1px）
//   render:pxPerBeat    上下层共享**同一个** pxPerBeat（不许两套值）
//   render:lead4        4 拍预告像素 = 4×pxPerBeat，110/120/126/132/128/140BPM 下一致（按拍不按秒）
//   render:grayscale    三声部灰度可辨（L-08：明度 + 形状 + 色相三通道，含反证）
//   render:obstaclePos  位置是时间的纯函数（单调、与公式一致、乱序/掉帧可重放）
//   render:chart        真谱面（SOUND 的 L1/L2 + CORE 的 MockClock）跑一遍 WorldLayer 与 Timeline
//   render:scan         源码扫描：0 处 scene.time / this.time.* / 挂钟 / x+=v*dt（含探测器自检）
//   render:colors       颜色字面量：theme.js 之外 0 处；neon.css 逐值等于 theme
//   render:quality      粒子/bloom 上限、审美三档候选（T16）、降级顺序
//   render:bg           背景/视差/地面线的拍域一致性
//   render:physics      theme ↔ physics 交叉一致（C8 不许两套口径）+ CORE selfTest 无 error
//   render:overlay      W-13 教学浮层：按拍三步（出现/换步/退场）/ 与判定线零交集 / 可跳过并持久化 / 不改世界几何
//   render:tierReach    W-09 Platform（模块缺失则 SKIP 并点名）
//   render:gap          W-10 Barrage（同上）
//   render:jumparc      W-03 Player（同上）
//   render:fx           W-07 EffectSystem（同上）
//   render:selftest     浏览器 `?selftest=render` 回传 JSON 的同口径复核（无负载则 SKIP）
//
// CLI：
//   node tools/screenshotCheck.mjs [--json] [--verbose] [--list] [--view WxH]
//                                 [--selftest <file|inline-json|->]
//
// ★ 浏览器负载（WORLD 侧口径，schema 常量 SELFTEST_SCHEMA；CORE 在 R2 的 LevelScene 里照此回传）：
//   { "schema":"world-selftest/v1", "nowSec":12.34, "viewport":{"width":1920,"height":1080},"dpr":1,
//     "world":    WorldLayer.snapshot(clock)   // {view:{judgeX,pxPerBeat,pxPerSec,rightSpawnX,timelineTop},items:[{id,track,x,y,beatsToJudge}],layers:[...]}
//     "timeline": Timeline.snapshot({view,nowSec,instances}),  // {judgeX,pxPerBeat,windowRightX,band,lanes,markerXs:[{id,track,x}]}
//     "pixels":   [{track:"kick",luma:101}, ...] }             // 可选：readPixels 灰度采样
//
// 约定（leader 的 tools/verifyAll.mjs 依赖）：**最后一行必须**是 `RESULT: PASS|FAIL|SKIP <细节>`。
// 退出码：FAIL → 1；PASS/SKIP → 0。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BACKGROUND_CFG,
  COLOR_HEX_WHITELIST,
  COLORS,
  CORE_MARK,
  DEFAULT_QUALITY,
  DEGRADE_ORDER,
  DERIVED,
  FONT_MIN_PX,
  FONT_TIERS,
  FX_TIMING,
  GRAY_CONTRAST_MIN,
  LEAD_BEATS,
  LUMA_BY_TRACK,
  LUMA_BY_TRACK_VOICE,
  MARKER_TONE_MODE_DEFAULT,
  MOTION,
  QUALITY_CAPS,
  QUALITY_PRESETS,
  SHAPE_BY_TRACK,
  SIZES,
  TIMELINE_CFG,
  TRACKS,
  TYPE_BY_TRACK,
  VIEW_RATIOS,
  ZONE_RATIOS,
  THEME_VERSION,
  beatOffsetX,
  beatToTimeOf,
  buildView,
  clampQuality,
  cssTokens,
  markerColor,
  markerHex,
  perceptualLuma,
  pxPerSecOf,
  quality
} from '../src/data/theme.js';
import { AUX, FROZEN, metrics, metrics1080, obstacleX as physicsObstacleX, platformTopY, selfTest as physicsSelfTest } from '../src/data/physics.js';
import {
  Obstacle,
  assertUniqueInstanceIds,
  beatsToJudge,
  coreBracketLines,
  isOnScreen,
  isRenderableInstance,
  judgeLineX,
  obstacleScreenX,
  pxPerBeatOf,
  screenXFromBeats,
  screenXFromSeconds,
  shapeOf,
  shapePoints,
  shapeVertexCount,
  spawnFadeAlpha,
  spawnLeadBeats,
  trackEnvelope,
  worldSpawnX,
  worldWindowRect,
  worldYFor
} from '../src/game/objects/Obstacle.js';
import Spike from '../src/game/objects/Spike.js';
import {
  TIMELINE_MARKER_COLORS,
  Timeline,
  alignDashAlpha,
  beatX,
  ghostGeometry,
  isBeatsVisible,
  laneY,
  normalizeGhosts,
  normalizeTempoCues,
  tempoCueGeometry,
  timelineJudgeX,
  timelineMarkerSize,
  timelinePxPerBeat,
  windowRightX
} from '../src/game/objects/Timeline.js';
import {
  Background,
  activeLayerCount,
  calmFactor,
  groundGeometry,
  judgeLineGeometry,
  layerGeometry,
  parallaxOffsetFor
} from '../src/game/render/Background.js';
import WorldLayer from '../src/game/render/WorldLayer.js';
import OverlayLayer, {
  BODY_LINES_MAX,
  OVERLAY_DEPTH,
  PANEL,
  STEP_START_BEATS,
  TUTORIAL_END_BEAT,
  TUTORIAL_LEVEL_ID,
  HEIGHT_LABEL,
  SHAPE_LABEL,
  buildSteps,
  chipTextFor,
  keyLabelsFrom,
  panelRect,
  stepForBeat,
  textWidthPx
} from '../src/game/render/OverlayLayer.js';
import { KEYMAP } from '../src/game/scenes/LevelRuntime.js';
import { expectedAction } from '../src/game/systems/JudgeSystem.js';
import { SAVE_KEY, SAVE_VERSION, defaultSave, mergeSave } from '../src/data/save.js';
import { MockClock } from '../src/mocks/MockClock.js';

export const SCREENSHOT_CHECK_VERSION = 'R1.1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** DoD 门限：上下层判定线偏差 < 1px */
const JUDGE_TOL_PX = 1;
/** 同函数派生量的等值容差 */
const EXACT_TOL_PX = 0.01;
const BASE = { w: 1920, h: 1080 };
const SWEEP_BPMS = [110, 120, 126, 132, 128, 140];
const VIEWPORTS = [
  { w: 1920, h: 1080 },
  { w: 1280, h: 720 },
  { w: 1600, h: 900 },
  { w: 2560, h: 1440 },
  { w: 1366, h: 768 }
];
/** WORLD 在 CSS 里允许的别名（值必须等于某个 theme token） */
const CSS_ALIAS_OF = {
  '--rb-bg': '--rb-base',
  '--rb-ink': '--rb-white',
  '--rb-hairline': '--rb-divider',
  '--rb-panel': '--rb-bandHud',
  '--rb-panel-strong': '--rb-bandTimeline'
};

/* ═══════════════════════════════════════════════════════════════
 * 1 · 结果收集器
 * ═══════════════════════════════════════════════════════════════ */

const PASS = 'pass';
const FAIL = 'fail';
const SKIP = 'skip';

/** 进度标记（`RENDER_CHECK_DEBUG=1` 时打到 stderr，用于定位卡点；正常跑静默） */
const T0 = Date.now();
function mark(what) {
  if (process.env.RENDER_CHECK_DEBUG) process.stderr.write(`  · ${what} (+${Date.now() - T0}ms)\n`);
}

const groups = [];
const groupIndex = new Map();
const headline = {};

function group(id, title) {
  if (groupIndex.has(id)) return groups[groupIndex.get(id)];
  const g = { id, title, checks: [], status: PASS };
  groupIndex.set(id, groups.length);
  groups.push(g);
  return g;
}

function record(groupId, name, status, detail, measured) {
  const g = group(groupId);
  const c = { name, status, detail, measured };
  g.checks.push(c);
  if (status === FAIL) g.status = FAIL;
  return c;
}

const fmt = (n, d = 2) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  const q = Number(n.toFixed(d));
  return Math.abs(q) >= 1e5 || (q !== 0 && Math.abs(q) < 1e-4) ? n.toExponential(2) : String(q);
};

function near(groupId, name, a, b, tol, unit = 'px') {
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
  return record(groupId, name, ok ? PASS : FAIL, `${fmt(a)} vs ${fmt(b)}（Δ${fmt(Math.abs(a - b), 5)}${unit} ≤ ${tol}${unit}）`, { a, b, diff: Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : null, tol });
}

function must(groupId, name, cond, detail) {
  return record(groupId, name, cond ? PASS : FAIL, detail);
}

function eq(groupId, name, a, b, detail = '') {
  return record(groupId, name, a === b ? PASS : FAIL, `${String(a)} === ${String(b)}${detail ? ` · ${detail}` : ''}`);
}

function skip(groupId, name, reason) {
  return record(groupId, name, SKIP, reason);
}

/** 多个读取点必须同值（「单一真相」类断言）；返回实测离散度 */
function singleSource(groupId, name, sources, tol = EXACT_TOL_PX) {
  const vals = Object.entries(sources).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  const spread = Math.max(...vals.map(([, v]) => v)) - Math.min(...vals.map(([, v]) => v));
  const entries = Object.entries(sources).map(([k, v]) => `${k}=${fmt(v)}`).join(' ');
  const c = record(groupId, name, spread <= tol ? PASS : FAIL, `${vals.length} 个读取点离散度 ${fmt(spread, 6)}px（≤${tol}）· ${entries}`, { spread, sources });
  return c.measured.spread;
}

/* ═══════════════════════════════════════════════════════════════
 * 2 · 录制用 Graphics（假 Phaser Graphics）
 * ═══════════════════════════════════════════════════════════════ */

export class RecordingGraphics {
  constructor(tag = 'g') {
    this.tag = tag;
    this.ops = [];
    this.fill = { color: 0, alpha: 1 };
    this.line = { width: 1, color: 0, alpha: 1 };
    this.destroyed = false;
    this.depth = 0;
  }

  clear() {
    this.ops = [];
    return this;
  }

  destroy() {
    this.destroyed = true;
    this.ops = [];
    return this;
  }

  setDepth(d) {
    this.depth = d;
    return this;
  }

  fillStyle(color, alpha = 1) {
    this.fill = { color, alpha };
    return this;
  }

  lineStyle(width, color, alpha = 1) {
    this.line = { width, color, alpha };
    return this;
  }

  fillRect(x, y, w, h) {
    this.ops.push({ op: 'fillRect', x, y, w, h, style: { ...this.fill } });
    return this;
  }

  strokeRect(x, y, w, h) {
    this.ops.push({ op: 'strokeRect', x, y, w, h, style: { ...this.line } });
    return this;
  }

  fillCircle(x, y, r) {
    this.ops.push({ op: 'fillCircle', x, y, r, style: { ...this.fill } });
    return this;
  }

  fillPoints(pts, close = true) {
    this.ops.push({ op: 'fillPoints', pts: pts.map((p) => ({ x: p.x, y: p.y })), close, style: { ...this.fill } });
    return this;
  }

  strokePoints(pts, close = true) {
    this.ops.push({ op: 'strokePoints', pts: pts.map((p) => ({ x: p.x, y: p.y })), close, style: { ...this.line } });
    return this;
  }

  lineBetween(x1, y1, x2, y2) {
    this.ops.push({ op: 'line', x1, y1, x2, y2, style: { ...this.line } });
    return this;
  }

  verticals() {
    return this.ops.filter((o) => o.op === 'line' && Math.abs(o.x1 - o.x2) < 1e-9);
  }

  verticalAt(x, tol = 0.001) {
    return this.verticals().filter((o) => Math.abs(o.x1 - x) <= tol);
  }

  horizontalAt(y, tol = 0.001) {
    return this.ops.filter((o) => o.op === 'line' && Math.abs(o.y1 - o.y2) < 1e-9 && Math.abs(o.y1 - y) <= tol);
  }

  /** 指定填充色的多边形质心（每种色一个声部 → 可按 track 反查） */
  centroids(color) {
    return this.ops
      .filter((o) => o.op === 'fillPoints' && o.style && o.style.color === color)
      .map((o) => {
        let sx = 0;
        let sy = 0;
        for (const p of o.pts) {
          sx += p.x;
          sy += p.y;
        }
        return { x: sx / o.pts.length, y: sy / o.pts.length, n: o.pts.length, alpha: o.style.alpha };
      });
  }
}

/**
 * 假 Phaser Text（W-07 大字标题的录制容器）：WorldLayer 只调 setText/setVisible/setAlpha/
 * setScale/setPosition/setFontSize，本类记录**每次调用的值**，于是「三要素是否同一帧落地」
 * 可以从操作序列里证明，而不是靠人眼看截图。
 */
export class RecordingText {
  constructor(tag = 't', style = {}) {
    this.tag = tag;
    this.style = style;
    this.text = '';
    this.visible = true;
    this.alpha = 1;
    this.scaleX = 1;
    this.scaleY = 1;
    this.x = 0;
    this.y = 0;
    this.fontSize = style.fontSize || null;
    this.depth = 0;
    this.destroyed = false;
    this.calls = [];
  }

  setText(v) {
    this.text = String(v);
    this.calls.push(['setText', this.text]);
    return this;
  }

  setVisible(v) {
    this.visible = !!v;
    this.calls.push(['setVisible', this.visible]);
    return this;
  }

  setAlpha(v) {
    this.alpha = v;
    this.calls.push(['setAlpha', v]);
    return this;
  }

  setScale(sx, sy) {
    this.scaleX = sx;
    this.scaleY = sy == null ? sx : sy;
    this.calls.push(['setScale', sx]);
    return this;
  }

  setPosition(x, y) {
    this.x = x;
    this.y = y;
    this.calls.push(['setPosition', x, y]);
    return this;
  }

  setFontSize(v) {
    this.fontSize = v;
    this.calls.push(['setFontSize', v]);
    return this;
  }

  setOrigin() {
    return this;
  }

  setDepth(d) {
    this.depth = d;
    return this;
  }

  destroy() {
    this.destroyed = true;
    return this;
  }
}

function makeHost() {
  const list = [];
  const texts = [];
  return {
    list,
    texts,
    add: {
      graphics: () => {
        const g = new RecordingGraphics(`g${list.length}`);
        list.push(g);
        return g;
      },
      // W-07 的大字标题落点：故意放进**独立数组**，避免挪动 list 的图层下标（既有断言用 list[1]/list[3]）
      text: (x, y, str, style) => {
        const t = new RecordingText(`t${texts.length}`, style || {});
        t.x = x;
        t.y = y;
        texts.push(t);
        return t;
      }
    }
  };
}

/* ═══════════════════════════════════════════════════════════════
 * 3 · 时钟与实例夹具
 * ═══════════════════════════════════════════════════════════════ */

function clockAt(bpm, tempoChanges = []) {
  const c = new MockClock();
  c.init({ bpm, introBeats: 0, sections: [{ beat: 0, state: 'INTRO', layers: [] }], tempoChanges });
  c.start(0);
  return c;
}

/** 把时钟挂进 view：变速关必须由 clock.beatAt/timeAtBeat 提供拍↔秒换算 */
function viewWithClock(w, h, clock, beatSec) {
  return buildView(w, h, {
    timeToBeat: (t) => clock.beatAt(t),
    beatToTime: (b) => clock.timeAtBeat(b),
    beatSec: beatSec != null ? beatSec : clock.beatLengthSec(0)
  });
}

let fixtureSeq = 0;
/** id 形如 `lv01-kick-007`：与 SOUND 的 PatternGenerator 同口径（laneKey 才可能对得上） */
function inst(track, beat, extra = {}) {
  const beatSec = extra.beatSec || 0.5;
  fixtureSeq += 1;
  return {
    id: `lv01-${track}-${String(fixtureSeq).padStart(3, '0')}`,
    track,
    type: TYPE_BY_TRACK[track],
    beat,
    timeSec: Math.round(beat * beatSec * 1e5) / 1e5,
    core: false,
    pitchTier: 1,
    speed: 1,
    state: 'pending',
    grade: null,
    judgable: true,
    ...extra
  };
}

/* ═══════════════════════════════════════════════════════════════
 * 4 · 源码扫描器（剥注释/字符串/正则，保留行号）
 * ═══════════════════════════════════════════════════════════════ */

const INTEGRATE_RHS = /\b(?:vx|vy|vel|velocity|speed|dt|deltaSec|deltaTime|frameDelta|pxPerSec)\b/;

/**
 * 「位置 += 速度 × dt」式积分。写成两段式而不是单条大正则：
 * 单条 `[\w$.]+\s*[+-]=\s*[^;\n]*\b(?:vx|…)` 会在长行上灾难性回溯（实测把整个门禁挂死）。
 * 语义：赋值目标像位置（x/y/pos/offset/dx/dy/screenX/worldX…），且右值含速度/时步符号。
 */
function detectIntegrate(code) {
  const re = /(^|[^\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\+|-)=/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const target = m[2];
    if (!/(?:x|y|X|Y|pos|Pos|offset|Offset|screenX|screenY|worldX|dx|dy)$/.test(target)) continue;
    const from = m.index + m[0].length;
    const rhs = code.slice(from).split(';')[0].slice(0, 200);
    const hit = INTEGRATE_RHS.exec(rhs);
    if (hit) return { col: m.index + (m[1] ? 1 : 0) + 1, target, token: hit[0] };
  }
  return null;
}

export const DETECTORS = [
  { id: 'scene.time', title: 'scene.time（T4 场景时钟）', re: /\bscene\s*\.\s*time\b/ },
  { id: 'this.time.now', title: 'this.time.*（Phaser 场景时钟）', re: /\bthis\s*\.\s*time\s*\.\s*[A-Za-z_$]/ },
  { id: 'wall-clock', title: 'Date.now / performance.now（挂钟当时序）', re: /\b(?:Date|performance)\s*\.\s*now\s*\(/ },
  { id: 'raf-as-clock', title: 'requestAnimationFrame 当时序源', re: /\brequestAnimationFrame\s*\(/ },
  { id: 'integrate', title: 'x += v*dt 式积分（纪律 1）', test: detectIntegrate },
  { id: 'arcade-velocity', title: 'Arcade 物理速度/加速度', re: /(?:\bsetVelocity\w*\s*\(|\bbody\s*\.\s*velocity\b|\bacceleration\b\s*[.=]|\bmaximumVelocity\b)/ },
  { id: 'tween-driven', title: 'tween 驱动位移（失败模式 3：与拍脱钩）', re: /(?:\bthis\s*\.\s*tween\s*\(|\baddTween\s*\(|\bgsap\s*\.|\bTweenMax\b|\bTweenLite\b)/ }
];

export function stripLine(line, st) {
  let out = '';
  let i = 0;
  if (st.block) {
    const j = line.indexOf('*/');
    if (j < 0) return out;
    st.block = false;
    i = j + 2;
    out += ' ';
  }
  while (i < line.length) {
    const c = line[i];
    const d = line[i + 1];
    if (c === '/' && d === '/') break;
    if (c === '/' && d === '*') {
      st.block = true;
      break;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(line, i, c);
      out += ' ';
      continue;
    }
    if (c === '/' && regexCanStart(st.prev)) {
      i = skipRegexLiteral(line, i);
      out += ' ';
      continue;
    }
    if (!/\s/.test(c)) st.prev = c;
    out += c;
    i += 1;
  }
  return out;
}

function skipQuoted(line, start, q) {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === '\\') i += 2;
    else if (line[i] === q) return i + 1;
    else i += 1;
  }
  return line.length;
}

function regexCanStart(prev) {
  return prev === '' || '(,=:[!&|?{};+-*/%<>~^'.includes(prev);
}

function skipRegexLiteral(line, start) {
  let i = start + 1;
  let inClass = false;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') i += 2;
    else if (c === '[') {
      inClass = true;
      i += 1;
    } else if (c === ']') {
      inClass = false;
      i += 1;
    } else if (c === '/' && !inClass) return i + 1;
    else i += 1;
  }
  return line.length;
}

/** 源码文本 → 违规列表（注释与字符串里的同名文字不算，因此扫描器自身可安全地解释纪律） */
export function scanSource(text) {
  const st = { block: false, prev: '' };
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const code = stripLine(lines[ln], st).slice(0, 3000);
    for (const det of DETECTORS) {
      if (det.re) {
        const m = det.re.exec(code);
        if (m) hits.push({ detector: det.id, line: ln + 1, col: m.index + 1, text: lines[ln].trim().slice(0, 140) });
      } else if (det.test) {
        const r = det.test(code);
        if (r) hits.push({ detector: det.id, line: ln + 1, col: r.col || 1, text: lines[ln].trim().slice(0, 140) });
      }
    }
  }
  return hits;
}

const SCAN_FIXTURES_BAD = {
  'scene.time': ['const t = scene.time.now;', 'this.scene.time.getDelta();'],
  'this.time.now': ['const t = this.time.now;', 'this.time.addDelayedCall(300, cb);'],
  'wall-clock': ['const t = Date.now();', 'return performance.now() / 1000;'],
  'raf-as-clock': ['requestAnimationFrame(step);'],
  integrate: ['this.screen.x += vx * dt;', 'offsetX -= speed * deltaTime;', 'px += pxPerSec * dt;'],
  'arcade-velocity': ['body.setVelocity(120, 0);', 'this.body.velocity.x = 3;', 'this.body.acceleration.set(1);'],
  'tween-driven': ['this.tween({ targets: o, x: 100, duration: 300 });']
};

const SCAN_FIXTURES_GOOD = {
  'scene.time': ['const t = clock.now();', 'const s = scene.assets;'],
  'this.time.now': ['const t = clock.now() + this.timeSec;', 'this.timings.push(1);'],
  'wall-clock': ['const t = Number(frame.nowSec);'],
  'raf-as-clock': ['// 由 CORE 的 main.js 驱动循环'],
  integrate: ['x += p.x;', 'for (let b = from; b <= to; b += step) {', 'this._lo += 1;', 'sum += Math.max(0, hp / 4);', 'this.speed = 1;'],
  'arcade-velocity': ['const speed = 3; // 只读展示字段', 'this.screen.x = judgeX + d * pxPerBeat;'],
  'tween-driven': ['const t = 300; // 纯计算，不动位置']
};

/** 探测器自检：植入的坏例必须全被抓到，好例不许误报（防止门禁空转） */
function scanSelfTest(groupId) {
  let caught = 0;
  let total = 0;
  const notes = [];
  for (const [id, lines] of Object.entries(SCAN_FIXTURES_BAD)) {
    for (const src of lines) {
      total += 1;
      if (scanSource(src).some((h) => h.detector === id)) caught += 1;
      else notes.push(`漏报[${id}] ${src}`);
    }
  }
  let falsePositive = 0;
  for (const [id, lines] of Object.entries(SCAN_FIXTURES_GOOD)) {
    for (const src of lines) {
      if (scanSource(src).some((h) => h.detector === id)) {
        falsePositive += 1;
        notes.push(`误报[${id}] ${src}`);
      }
    }
  }
  must(groupId, 'scan:selftest 探测器有效', caught === total && falsePositive === 0, `${total} 条植入违规抓到 ${caught} 条，误报 ${falsePositive} 条${notes.length ? `（${notes.join(' | ')}）` : ''}`);
  // 终止性/线性度自检：正则字面量与字符类是扫描器自己的坑（曾经把整个门禁挂死），必须有回归用例
  const tricky = [
    '  const m = /^lv?([A-Ga-g])([#b]?)(-?\\d)$/.exec(String(id || ""));',
    '  const rel = path.relative(ROOT, p).replace(/\\\\/g, "/");',
    '  const lines = String(text).split(/\\r?\\n/);',
    '  if (/[+-]=/.test(code) && /\\b(?:vx|vy)\\b/.test(rhs)) { hit = true; }',
    '  const tpl = `${a}${"nested \\"quote\\""}`;',
    '  // 注释里的 scene.time / this.time.now / x += vx * dt 不许被抓',
    '  /* 块注释 scene.time 与 x += vx*dt */ const t = clock.now();',
    '  const s = "字符串里的 Date.now() 与 #00f0ff 不算代码";'
  ];
  const stress = tricky.concat(tricky.map((l) => l + ' // 变体')).join('\n');
  const t0 = Date.now();
  let quick = 0;
  for (let k = 0; k < 60; k++) quick += scanSource(stress).length;
  const el = Date.now() - t0;
  must(groupId, 'scan:selftest 扫描器对正则/注释行线性且必然终止', el < 2000, `${60 * tricky.length * 2} 行耗时 ${el}ms（命中 ${quick} 条，植入的注释/字符串违规 0 命中）`);
  return { caught, total, falsePositive, notes, stressMs: el };
}

function walkFiles(dir, test) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.git', '.agent', 'docs'].includes(e.name)) continue;
      out.push(...walkFiles(path.join(dir, e.name), test));
    } else if (test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

const relOf = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/** C9 所有权：非 WORLD 的违规转成 CR，不代他人改文件 */
function ownerOf(rel) {
  if (rel === 'src/data/theme.js' || rel === 'src/styles/neon.css') return 'WORLD';
  if (rel.startsWith('src/game/objects/') || rel.startsWith('src/game/render/')) return 'WORLD';
  if (rel === 'src/game/systems/EffectSystem.js') return 'WORLD';
  if (rel === 'src/audio/BeatClock.js') return 'CORE';
  if (rel === 'src/game/systems/PatternGenerator.js' || rel.startsWith('src/data/levels/') || rel.startsWith('src/audio/')) return 'SOUND';
  return 'CORE';
}

/* ═══════════════════════════════════════════════════════════════
 * 5 · 断言组
 * ═══════════════════════════════════════════════════════════════ */

function checkZones(view) {
  const id = 'render:zones';
  group(id, '分区比 8/60/32 → 像素');
  const sum = ZONE_RATIOS.hud + ZONE_RATIOS.world + ZONE_RATIOS.timeline;
  must(id, 'zone-ratio 恰为 0.08/0.6/0.32 且和为 1', ZONE_RATIOS.hud === 0.08 && ZONE_RATIOS.world === 0.6 && ZONE_RATIOS.timeline === 0.32 && Math.abs(sum - 1) < 1e-9, `8/60/32 = ${fmt(sum, 6)}（C8 冻结）`);
  near(id, '1080p·HUD 带 = 86.4px', view.zones.hudHeight, 86.4, 0.05);
  near(id, '1080p·世界带 = 648px', view.zones.worldHeight, 648, 0.05);
  near(id, '1080p·时间轴带 = 345.6px', view.zones.timelineHeight, 345.6, 0.05);
  near(id, '1080p·世界带底 = 734.4px', view.zones.worldBottom, 734.4, 0.05);
  near(id, '1080p·三带相加 = 1080', view.zones.hudHeight + view.zones.worldHeight + view.zones.timelineHeight, 1080, 0.05);
  eq(id, '分隔线数量 === BACKGROUND_CFG.dividerCount', view.dividerYs.length, BACKGROUND_CFG.dividerCount);
  near(id, 'dividerYs[0] = HUD 带底', view.dividerYs[0], view.zones.hudHeight, EXACT_TOL_PX);
  near(id, 'dividerYs[1] = 世界带底 = 时间轴带顶', view.dividerYs[1], view.zones.timelineTop, EXACT_TOL_PX);
  for (const k of ['hud', 'world', 'timeline']) eq(id, `physics.AUX.${k}Band === theme`, AUX[`${k}Band`], ZONE_RATIOS[k], 'CORE 与 WORLD 同口径');
  for (const vp of VIEWPORTS) {
    const v = buildView(vp.w, vp.h, {});
    near(id, `${vp.w}x${vp.h}·三带相加=H`, v.zones.hudHeight + v.zones.worldHeight + v.zones.timelineHeight, vp.h, 0.05);
    near(id, `${vp.w}x${vp.h}·时间轴带=0.32H`, v.zones.timelineHeight, vp.h * 0.32, 0.05);
    must(id, `${vp.w}x${vp.h}·时间轴标记不越带`, v.lanes.markerH <= v.zones.timelineHeight * 0.18 + 1e-6, `markerH=${fmt(v.lanes.markerH, 1)} ≤ ${fmt(v.zones.timelineHeight * 0.18, 1)}`);
  }
  headline.zones = `${fmt(view.zones.hudHeight, 1)}/${fmt(view.zones.worldHeight, 1)}/${fmt(view.zones.timelineHeight, 1)}px`;
}

function checkZonesDrawn(view) {
  const id = 'render:zones';
  const g = new RecordingGraphics('zones');
  new Background().draw(g, { view, nowSec: 0 });
  for (const y of view.dividerYs) must(id, `分区分隔线已画@y=${fmt(y, 1)}`, g.horizontalAt(y).length >= 1, `水平线命中 ${g.horizontalAt(y).length} 条`);
  must(id, '判定线已画@judgeX', g.verticalAt(view.judgeX).length >= 1, `x=${fmt(view.judgeX, 1)} 竖线 ${g.verticalAt(view.judgeX).length} 条`);
  must(id, '出生线已画@4 拍窗右界', g.verticalAt(view.worldWindow.x1).length >= 1, `x=${fmt(view.worldWindow.x1, 1)} 竖线 ${g.verticalAt(view.worldWindow.x1).length} 条`);
  const big = g.ops.filter((o) => o.op === 'fillRect').sort((a, b) => b.w * b.h - a.w * a.h)[0];
  must(id, '整屏底色已填充（无透明洞）', !!big && big.w >= view.width - 0.01 && big.h >= view.height - 0.01, `最大 fillRect = ${big ? `${fmt(big.w, 0)}×${fmt(big.h, 0)}` : '无'}`);
  must(id, 'HUD 带底已铺', g.ops.some((o) => o.op === 'fillRect' && Math.abs(o.h - view.zones.hudHeight) < 0.5), `带高 ${fmt(view.zones.hudHeight, 1)}px 的 fillRect ${g.ops.filter((o) => o.op === 'fillRect' && Math.abs(o.h - view.zones.hudHeight) < 0.5).length} 条`);
  // 时间轴带底归 Timeline 自己画（drawBand），不许 Background 越界 —— 两层各画各的带
  const gT = new RecordingGraphics('band');
  new Timeline().draw(gT, { view, nowSec: 0, instances: [] });
  const bandFill = gT.ops.filter((o) => o.op === 'fillRect' && Math.abs(o.h - view.zones.timelineHeight) < 0.5);
  must(id, '时间轴带底已由下层铺好', bandFill.length >= 1, `带高 ${fmt(view.zones.timelineHeight, 1)}px 的 fillRect ${bandFill.length} 条 @y=${bandFill.length ? fmt(bandFill[0].y, 1) : '-'}`);
  must(id, '时间轴带不侵入世界带', bandFill.every((o) => o.y >= view.zones.worldBottom - 0.5), `带顶 y=${fmt(Math.min(...bandFill.map((o) => o.y)), 1)} ≥ 世界带底 ${fmt(view.zones.worldBottom, 1)}`);
}

function checkJudgeX(view, worldSnap, tlSnap) {
  const id = 'render:judgeX';
  group(id, '判定线同 x + 角色 x = 判定线 x');
  const m = metrics1080();
  near(id, '0.30W@1920 = 576px', view.judgeX, 576, EXACT_TOL_PX);
  const spread = singleSource(
    id,
    '判定线单一真相（10 个读取点）',
    {
      'theme.view.judgeX': view.judgeX,
      'theme.view.guideX': view.guideX,
      'theme.worldWindow.x0': view.worldWindow.x0,
      'Obstacle.judgeLineX': judgeLineX(view),
      'Timeline.timelineJudgeX': timelineJudgeX(view),
      'Background.judgeLineGeometry': judgeLineGeometry(view).x,
      'physics.metrics.judgeX': m.judgeX,
      'physics.metrics.playerX': m.playerX,
      'WorldLayer.snapshot': worldSnap.view.judgeX,
      'Timeline.snapshot': tlSnap.judgeX
    },
    EXACT_TOL_PX
  );
  headline.judgeSpread = fmt(spread, 6);
  must(id, 'theme.VIEW_RATIOS.judgeX === physics.FROZEN.judgeX', VIEW_RATIOS.judgeX === FROZEN.judgeX, `${VIEW_RATIOS.judgeX} vs ${FROZEN.judgeX}（C8 冻结，不许两份）`);
  for (const vp of VIEWPORTS) {
    const v = buildView(vp.w, vp.h, {});
    near(id, `${vp.w}x${vp.h}·judgeX=0.30W`, v.judgeX, 0.3 * vp.w, EXACT_TOL_PX);
    near(id, `${vp.w}x${vp.h}·physics 同值`, metrics({ w: vp.w, h: vp.h }).judgeX, v.judgeX, EXACT_TOL_PX);
    must(id, `${vp.w}x${vp.h}·判定线在屏内`, v.judgeX > 0 && v.judgeX < vp.w, `${fmt(v.judgeX, 1)}px`);
  }

  // ★ 绘制级证据：从录制的 Graphics 里量出两层判定线的 x
  const gU = new RecordingGraphics('upper');
  new Background().draw(gU, { view, nowSec: 0 });
  const upper = gU.verticalAt(view.judgeX).filter((o) => o.y1 >= view.zones.worldTop - 1 && o.y2 <= view.zones.worldBottom + 1);
  const gL = new RecordingGraphics('lower');
  new Timeline().draw(gL, { view, nowSec: 0, instances: [] });
  const lower = gL.verticalAt(view.judgeX).filter((o) => o.y1 >= view.zones.timelineTop - 2 && o.y2 <= view.height + 1);
  must(id, '上层已画判定线（世界带内）', upper.length >= 1, `竖线 ${upper.length} 条 @x=${fmt(view.judgeX, 1)}`);
  must(id, '下层已画判定线（时间轴带内）', lower.length >= 1, `竖线 ${lower.length} 条 @x=${fmt(view.judgeX, 1)}`);
  const dev = upper.length && lower.length ? Math.max(...upper.map((o) => Math.abs(o.x1 - view.judgeX)), ...lower.map((o) => Math.abs(o.x1 - view.judgeX))) : Infinity;
  must(id, `上下层绘制判定线偏差 < ${JUDGE_TOL_PX}px`, dev < JUDGE_TOL_PX, `实测 Δ=${fmt(dev, 4)}px（两层各自画线到 0.30W 的最大距离）`);
  headline.judgeXDev = fmt(dev, 4);
  headline.judgeX = fmt(view.judgeX, 1);

  const pl = optional.get('player');
  if (pl && typeof pl.fixedX === 'function') near(id, 'Player.fixedX === judgeX（角色钉在判定线上）', pl.fixedX(view), view.judgeX, EXACT_TOL_PX);
  else skip(id, 'Player 固定 x', 'src/game/objects/Player.js 尚不存在或没有 fixedX(view)（W-03）');
}

function checkPxPerBeat(view, worldSnap, tlSnap) {
  const id = 'render:pxPerBeat';
  group(id, '上下层共享同一 pxPerBeat');
  const m = metrics1080();
  const spread = singleSource(
    id,
    'pxPerBeat 单一真相（7 个读取点，不许两套值）',
    {
      'theme.view.pxPerBeat': view.pxPerBeat,
      'theme.worldWindow.pxPerBeat': view.worldWindow.pxPerBeat,
      'Obstacle.pxPerBeatOf': pxPerBeatOf(view),
      'Timeline.timelinePxPerBeat': timelinePxPerBeat(view),
      'physics.metrics.pxPerBeat': m.pxPerBeat,
      'WorldLayer.snapshot': worldSnap.view.pxPerBeat,
      'Timeline.snapshot': tlSnap.pxPerBeat
    },
    EXACT_TOL_PX
  );
  headline.pxSpread = fmt(spread, 6);
  near(id, '0.115W@1920 = 220.8px', view.pxPerBeat, 220.8, EXACT_TOL_PX);
  must(id, 'theme.VIEW_RATIOS.pxPerBeat === physics.FROZEN.pxPerBeat', VIEW_RATIOS.pxPerBeat === FROZEN.pxPerBeat, `${VIEW_RATIOS.pxPerBeat} vs ${FROZEN.pxPerBeat}`);
  for (const vp of VIEWPORTS) {
    const v = buildView(vp.w, vp.h, {});
    near(id, `${vp.w}x${vp.h}·pxPerBeat=0.115W`, v.pxPerBeat, 0.115 * vp.w, EXACT_TOL_PX);
    near(id, `${vp.w}x${vp.h}·下层 beatX 步进=pxPerBeat`, beatX(v, 9, 8) - beatX(v, 8, 8), v.pxPerBeat, EXACT_TOL_PX);
    near(id, `${vp.w}x${vp.h}·上层 screenXFromBeats 步进同值`, screenXFromBeats(9, v) - screenXFromBeats(8, v), v.pxPerBeat, EXACT_TOL_PX);
    near(id, `${vp.w}x${vp.h}·pxPerSec=pxPerBeat/拍长`, v.pxPerSec, v.pxPerBeat / v.beatSec, 0.01);
  }
}

function checkLead4(view) {
  const id = 'render:lead4';
  group(id, '4 拍预告 = 4×pxPerBeat（按拍不按秒）');
  const m = metrics1080();
  eq(id, 'LEAD_BEATS === 4', LEAD_BEATS, 4);
  eq(id, 'view.leadBeats === LEAD_BEATS', view.leadBeats, LEAD_BEATS);
  eq(id, 'TIMELINE_CFG.leadBeats === LEAD_BEATS', TIMELINE_CFG.leadBeats, LEAD_BEATS);
  eq(id, 'physics.AUX.lookAheadBeats === LEAD_BEATS', AUX.lookAheadBeats, LEAD_BEATS);
  const spread = singleSource(
    id,
    '4 拍像素距离单一真相（判定线右侧）',
    {
      'view.leadPx': view.leadPx,
      '4×pxPerBeat': 4 * view.pxPerBeat,
      'worldSpawnX-judgeX': worldSpawnX(view) - view.judgeX,
      'Timeline.windowRightX-judgeX': windowRightX(view) - view.judgeX,
      'worldWindow 宽': view.worldWindow.x1 - view.worldWindow.x0,
      'physics.metrics.lookAheadPx': m.lookAheadPx,
      'screenXFromBeats(4)-judgeX': screenXFromBeats(4, view) - view.judgeX
    },
    EXACT_TOL_PX
  );
  must(id, 'leadPx 离散度 = 0', spread <= EXACT_TOL_PX, `Δ${fmt(spread, 6)}px`);
  near(id, '1080p·leadPx = 883.2px', view.leadPx, 883.2, 0.05);
  must(id, '4 拍窗 ≤ 55% 屏宽（physics selfTest 口径）', view.leadPx <= view.width * 0.55 + 1e-6, `${fmt(view.leadPx, 1)}px ≤ ${fmt(view.width * 0.55, 1)}px；出生线右侧留 ${fmt(100 - ((view.judgeX + view.leadPx) / view.width) * 100, 1)}% 屏宽`);
  must(id, '出生线在判定线右侧且在屏内', worldSpawnX(view) > view.judgeX && worldSpawnX(view) < view.width, `spawnX=${fmt(worldSpawnX(view), 1)}`);

  // ★ BPM 一致性：同 W 下 4 拍像素距离不许随 BPM 变化（按拍不按秒）
  const perBpm = {};
  for (const bpm of SWEEP_BPMS) {
    perBpm[bpm] = buildView(BASE.w, BASE.h, { bpm }).leadPx;
  }
  eq(id, `六档 BPM 的 leadPx 全等（${Object.values(perBpm).map((v) => fmt(v, 1)).join('/')}）`, new Set(Object.values(perBpm).map((v) => v.toFixed(3))).size, 1);
  for (const bpm of [110, 120, 126, 132]) {
    const clock = clockAt(bpm);
    const v = viewWithClock(BASE.w, BASE.h, clock, 60 / bpm);
    near(id, `${bpm}BPM·leadPx 与 view.leadPx 同值`, v.leadPx, view.leadPx, EXACT_TOL_PX);
    near(id, `${bpm}BPM·距线 4 拍恰落在出生线`, obstacleScreenX(inst('kick', 32, { beatSec: 60 / bpm }), clock.timeAtBeat(28), v), worldSpawnX(v), 0.5);
    near(id, `${bpm}BPM·上下层 4 拍同列`, beatX(v, 32, clock.beatAt(clock.timeAtBeat(28))), windowRightX(v), 0.5);
    near(id, `${bpm}BPM·pxPerSec=pxPerBeat×bpm/60`, v.pxPerSec, (v.pxPerBeat * bpm) / 60, 0.01);
    clock.stop();
  }
  headline.lead4 = `${fmt(view.leadPx, 1)}px（六 BPM 全等）`;

  // 变速段：拍距恒定（TIM-02）；秒域公式在此处必然分叉 → 量化后写进报告
  const ramp = [{ beat: 64, bpm: 140, transitionBeats: 2 }];
  const clock = clockAt(120, ramp);
  const rv = viewWithClock(BASE.w, BASE.h, clock, 0.5);
  const midT = clock.timeAtBeat(63);
  const gapOf = (b) => obstacleScreenX(inst('kick', b, { beatSec: 0.5 }), midT, rv) - obstacleScreenX(inst('kick', b - 1, { beatSec: 0.5 }), midT, rv);
  near(id, '变速中·相邻拍像素差=pxPerBeat（第 70/69 拍）', gapOf(70), rv.pxPerBeat, 0.05);
  near(id, '变速中·相邻拍像素差=pxPerBeat（过渡区间内）', gapOf(64), rv.pxPerBeat, 0.05);
  const secDomain = physicsObstacleX({ w: BASE.w, h: BASE.h }, clock.timeAtBeat(70), midT, 0.5);
  const beatDomain = obstacleScreenX(inst('kick', 70, { beatSec: 0.5 }), midT, rv);
  const dev = Math.abs(secDomain - beatDomain);
  must(id, '变速中：秒域公式已分叉（所以必须按拍定位）', dev > 0.5, `秒域偏 ${fmt(dev, 1)}px = ${fmt(dev / rv.pxPerBeat, 3)}拍 → 定位以拍域（clock.beatAt）为准`);
  must(id, '下层可见窗 = [-1,+4] 拍', isBeatsVisible(4) && isBeatsVisible(-1) && !isBeatsVisible(4.001) && !isBeatsVisible(-1.001), '+4 可见 / +4.001 否 / -1 可见 / -1.001 否');
  must(id, '上层可见窗与下层同界', isOnScreen(worldSpawnX(view), view) && isOnScreen(view.judgeX, view) && !isOnScreen(worldSpawnX(view) + view.pxPerBeat * 0.5, view), `上界 x=${fmt(worldSpawnX(view), 1)}，下界 x=${fmt(view.judgeX - view.pxPerBeat, 1)}`);
  must(id, '挂接提前量 = 4 拍 + 淡入跨度（不多挂）', Math.abs(spawnLeadBeats(view) - (LEAD_BEATS + MOTION.spawnFadeBeats)) < 1e-9, `${fmt(spawnLeadBeats(view), 3)} 拍`);
  clock.stop();
}

function hueOf(int) {
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s / 2);
}

const LEGAL_COLOR_INTS = new Set([
  ...Object.values(COLORS).map((c) => c.int),
  ...Object.values(DERIVED).map((d) => d.int),
  ...TRACKS.map((t) => markerColor(t)),
  ...TRACKS.map((t) => markerColor(t, 'voice'))
]);

function checkGrayscale(view) {
  const id = 'render:grayscale';
  group(id, '三声部灰度可辨（L-08 色盲冗余编码）');
  eq(id, 'LUMA_BY_TRACK 覆盖三声部', Object.keys(LUMA_BY_TRACK).length, 3);
  for (const t of TRACKS) eq(id, `LUMA_BY_TRACK.${t} 由 markerColor 推导`, LUMA_BY_TRACK[t], Math.round(perceptualLuma(markerColor(t, MARKER_TONE_MODE_DEFAULT))));
  let minPair = Infinity;
  let minNames = '';
  for (let i = 0; i < TRACKS.length; i++) {
    for (let j = i + 1; j < TRACKS.length; j++) {
      const a = TRACKS[i];
      const b = TRACKS[j];
      const d = Math.abs(LUMA_BY_TRACK[a] - LUMA_BY_TRACK[b]);
      if (d < minPair) {
        minPair = d;
        minNames = `${a}/${b}`;
      }
      must(id, `灰度Δ(${a},${b}) ≥ ${GRAY_CONTRAST_MIN}`, d >= GRAY_CONTRAST_MIN, `${LUMA_BY_TRACK[a]} vs ${LUMA_BY_TRACK[b]} → Δ${d}（门限 ${GRAY_CONTRAST_MIN}，0..255）`);
    }
  }
  headline.gray = `${TRACKS.map((t) => `${t}:${LUMA_BY_TRACK[t]}`).join(' ')}；最小对 ${minNames} Δ${minPair}`;

  // 反证：不施加明度通道时红/品红会撞在一起 → 明度通道是承重的，不是装饰
  let voiceMin = Infinity;
  for (let i = 0; i < TRACKS.length; i++) for (let j = i + 1; j < TRACKS.length; j++) voiceMin = Math.min(voiceMin, Math.abs(LUMA_BY_TRACK_VOICE[TRACKS[i]] - LUMA_BY_TRACK_VOICE[TRACKS[j]]));
  must(id, '反证：裸声部色灰度差 < 门限（证明冗余通道必须存在）', voiceMin < GRAY_CONTRAST_MIN, `裸色最小差 ${voiceMin}（kick ${LUMA_BY_TRACK_VOICE.kick} vs synth ${LUMA_BY_TRACK_VOICE.synth}）< ${GRAY_CONTRAST_MIN}`);

  const verts = TRACKS.map((t) => shapeVertexCount(shapeOf(t)));
  eq(id, '形状顶点数互异（三角/横条/六边形）', new Set(verts).size, 3);
  must(id, '顶点数与 theme.SHAPE_BY_TRACK 口径一致', verts.join(',') === '3,4,6', `kick/bass/synth = ${verts.join('/')}`);
  const areas = TRACKS.map((t) => polygonArea(shapePoints(SHAPE_BY_TRACK[t], 0, 0, 100)));
  let areaRelMin = Infinity;
  for (let i = 0; i < areas.length; i++) for (let j = i + 1; j < areas.length; j++) areaRelMin = Math.min(areaRelMin, Math.abs(areas[i] - areas[j]) / Math.max(...areas));
  must(id, '形状面积两两相差 >10%（灰度轮廓不混）', areaRelMin > 0.1, `面积=${areas.map((a) => fmt(a, 0)).join('/')} px²@r=100，最小相对差 ${fmt(areaRelMin * 100, 1)}%`);

  const hues = TRACKS.map((t) => hueOf(markerColor(t, MARKER_TONE_MODE_DEFAULT)));
  const voiceHues = TRACKS.map((t) => hueOf(markerColor(t, 'voice')));
  let drift = 0;
  for (let i = 0; i < TRACKS.length; i++) drift = Math.max(drift, hueDist(hues[i], voiceHues[i]));
  must(id, '明度通道不漂色相（≤2°，仍是同一声部色 → 纪律 3）', drift <= 2, `最大色相漂移 ${fmt(drift, 3)}°`);
  let hueSep = Infinity;
  for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) hueSep = Math.min(hueSep, hueDist(hues[i], hues[j]));
  must(id, '三声部色相间隔 ≥ 10°（无第四种声部色）', hueSep >= 10, `最小间隔 ${fmt(hueSep, 1)}°（红/黄/品红）`);

  for (const t of TRACKS) eq(id, `下层标记色 === 上层 markerColor(${t})`, TIMELINE_MARKER_COLORS[t], markerColor(t, MARKER_TONE_MODE_DEFAULT));
  eq(id, 'Spike.describe().lumaChannel 同值', new Spike(inst('kick', 4)).describe().lumaChannel, markerColor('kick'));
  for (const t of TRACKS) eq(id, `markerHex(${t}) 与 markerColor 同一颜色`, parseInt(markerHex(t).slice(1), 16), markerColor(t));

  const ys = TRACKS.map((t) => laneY(t, view));
  must(id, '三泳道 y 互不相同（位置即第二编码）', new Set(ys.map((y) => Math.round(y))).size === 3, TRACKS.map((t, i) => `${t}=${fmt(ys[i], 1)}`).join(' '));
  must(id, '泳道顺序自上而下 = synth/bass/kick（低频在最下）', JSON.stringify(view.lanes.order) === JSON.stringify(TIMELINE_CFG.laneOrder) && laneY('synth', view) < laneY('bass', view) && laneY('bass', view) < laneY('kick', view), `order=${view.lanes.order.join('/')}，y：synth ${fmt(laneY('synth', view), 1)} < bass ${fmt(laneY('bass', view), 1)} < kick ${fmt(laneY('kick', view), 1)}`);
  must(id, '时间轴标记全在带内', ys.every((y) => y > view.zones.timelineTop && y < view.height - 1), `带 [${fmt(view.zones.timelineTop, 1)}, ${view.height}]`);
  eq(id, 'timelineMarkerSize === view.lanes.markerW', timelineMarkerSize(view), view.lanes.markerW);
  must(id, '声部图例落在判定线左侧（不遮读谱窗）', view.judgeX - view.pxPerBeat * TIMELINE_CFG.legendBeatOffset < view.judgeX, `x=${fmt(view.judgeX - view.pxPerBeat * TIMELINE_CFG.legendBeatOffset, 1)} < ${fmt(view.judgeX, 1)}`);
  // W-06 对齐虚线：按拍衰减，超时归零（不许用固定 ms tween）
  eq(id, 'alignDashAlpha：未触发 = 0', alignDashAlpha(null, 1, view), 0);
  must(id, 'alignDashAlpha：触发瞬间 = 1，超出 0.25 拍后 = 0', Math.abs(alignDashAlpha(1, 1, view) - 1) < 1e-9 && alignDashAlpha(1, 1 + MOTION.alignDashBeats * view.beatSec + 1e-6, view) === 0, `窗宽 ${MOTION.alignDashBeats} 拍 = ${fmt(MOTION.alignDashBeats * view.beatSec, 3)}s@${fmt(view.bpm, 0)}BPM`);
}

function checkPureTime(view, clock) {
  const id = 'render:obstaclePos';
  group(id, '位置 = 时间的纯函数（纪律 1）');
  const v = view;
  const o = inst('kick', 40);
  const t1 = clock.timeAtBeat(36);
  eq(id, '同 (instance, nowSec, view) 两次调用全等', obstacleScreenX(o, t1, v), obstacleScreenX(o, t1, v));

  const samples = [];
  const start = clock.timeAtBeat(30);
  for (let k = 0; k <= 240; k++) {
    const t = start + k * (0.5 / 60);
    samples.push({ t, x: obstacleScreenX(o, t, v) });
  }
  let mono = true;
  let stepErr = 0;
  const pps = pxPerSecOf(v);
  for (let i = 1; i < samples.length; i++) {
    if (!(samples[i].x < samples[i - 1].x - 1e-12)) mono = false;
    stepErr = Math.max(stepErr, Math.abs(samples[i].x - samples[i - 1].x + pps * (samples[i].t - samples[i - 1].t)));
  }
  must(id, 'x 随 nowSec 严格单调递减（不回望）', mono, `${samples.length} 个采样点（1/60s 步进，跨 2 拍）全部下降`);
  must(id, 'dx/dt ≡ -pxPerSec（无加速度、无积分漂移）', stepErr < 1e-6, `最大累积偏差 ${fmt(stepErr, 9)}px，pxPerSec=${fmt(pps, 2)}`);

  let fErr = 0;
  let bErr = 0;
  let judgeErr = 0;
  for (const s of samples) {
    fErr = Math.max(fErr, Math.abs(s.x - screenXFromSeconds(o.timeSec, s.t, v)));
    bErr = Math.max(bErr, Math.abs(s.x - beatOffsetX(v, o.beat - v.timeToBeat(s.t))));
    judgeErr = Math.max(judgeErr, Math.abs(s.x - (v.judgeX + beatsToJudge(o, s.t, v) * v.pxPerBeat)));
  }
  must(id, 'x === judgeX + (timeSec - now)×pxPerSec', fErr <= 1e-6, `最大偏差 ${fmt(fErr, 9)}px`);
  must(id, 'x === beatOffsetX(view, beat - nowBeat)', bErr <= 1e-6, `最大偏差 ${fmt(bErr, 9)}px`);
  must(id, 'x === judgeX + beatsToJudge × pxPerBeat（两域互逆）', judgeErr <= 0.02, `最大偏差 ${fmt(judgeErr, 6)}px`);

  const asc = samples.map((s) => s.x);
  const desc = [...samples].reverse().map((s) => obstacleScreenX(o, s.t, v));
  must(id, '乱序采样与正序逐点全等（不依赖调用历史）', desc.every((x, i) => x === [...asc].reverse()[i]), `${samples.length} 点`);

  // 掉帧可重放：整条链路（WorldLayer）跳走 5 秒再跳回，位置必须复现
  const host = makeHost();
  const wl = new WorldLayer();
  wl.init(host, v);
  const many = [inst('kick', 43), inst('bass', 44, { pitchTier: 0 }), inst('synth', 45, { core: true }), inst('kick', 46, { core: true }), inst('bass', 42.5, { pitchTier: 2 })];
  const tA = clock.timeAtBeat(42);
  const runSync = (t) => wl.sync({ clock: t, instances: many, view: v });
  const first = runSync(tA);
  const xa = wl.get(many[0].id).screen.x;
  runSync(clock.timeAtBeat(97)); // 掉帧/暂停 5 秒后
  runSync(clock.timeAtBeat(11)); // 再往回跳
  const again = runSync(tA);
  eq(id, '掉帧跳走再跳回 → 同实例 x 复现', wl.get(many[0].id).screen.x, xa);
  eq(id, '同刻两次 sync 的 frameStats.visible 相同', first.visible, again.visible);
  near(id, '到线瞬间 x === judgeX', obstacleScreenX(o, clock.timeAtBeat(40), v), v.judgeX, 0.01);
  near(id, '距线 1 拍 x === judgeX + pxPerBeat', obstacleScreenX(o, clock.timeAtBeat(39), v), v.judgeX + v.pxPerBeat, 0.01);
  near(id, '半拍网格实例（beat 42.5）在 42 拍时落在两拍正中', obstacleScreenX(many[4], clock.timeAtBeat(42), v), v.judgeX + 0.5 * v.pxPerBeat, 0.01);

  const wrap = new Obstacle(o, {});
  for (const t of [clock.timeAtBeat(30), clock.timeAtBeat(50), clock.timeAtBeat(39)]) wrap.update(t, v);
  near(id, '多次 update 后取 t=39 拍 → x 与公式一致', wrap.update(clock.timeAtBeat(39), v).x, obstacleScreenX(o, clock.timeAtBeat(39), v), 0.01);

  // ★ 上下层逐实例像素比对（双读谱承诺的量化形式）
  const gUpper = host.list[1];
  const gLower = new RecordingGraphics('lower');
  new Timeline().draw(gLower, { view: v, nowSec: tA, instances: many });
  let maxPair = 0;
  let compared = 0;
  for (const one of many) {
    const expect = obstacleScreenX(one, tA, v);
    const up = gUpper.centroids(markerColor(one.track)).find((c) => Math.abs(c.x - expect) < v.pxPerBeat);
    const dn = gLower.centroids(markerColor(one.track)).find((c) => Math.abs(c.x - expect) < v.pxPerBeat);
    if (!up || !dn) {
      record(id, `两层都画出了 ${one.id}`, FAIL, `upper=${up ? 'yes' : 'NO'} lower=${dn ? 'yes' : 'NO'}（期望 x=${fmt(expect, 2)}；上层 ops=${gUpper.ops.length} 下层 ops=${gLower.ops.length}）`);
      continue;
    }
    compared += 1;
    const d = Math.abs(up.x - dn.x);
    maxPair = Math.max(maxPair, d);
    must(id, `${one.track}@beat${one.beat} 上下层同 x`, d < JUDGE_TOL_PX, `上层 ${fmt(up.x, 2)} / 下层 ${fmt(dn.x, 2)} → Δ${fmt(d, 4)}px < ${JUDGE_TOL_PX}px`);
  }
  headline.pairDev = fmt(maxPair, 4);
  must(id, '比对样本数 = 实例数（无静默丢失）', compared === many.length, `${compared}/${many.length}`);
  must(id, '上层形状 = 下层形状（同一 drawTrackShape）', many.every((one) => gUpper.centroids(markerColor(one.track)).length >= 1) && new Spike(inst('kick', 4)).shape === shapeOf('kick'), `spike=${new Spike(inst('kick', 4)).shape} platform=${shapeOf('bass')} barrage=${shapeOf('synth')}`);

  eq(id, 'worldYFor 与时间无关（y 也是纯函数）', worldYFor('bass', v, { pitchTier: 1 }), worldYFor('bass', v, { pitchTier: 1 }));
  // ★ CR-08 第 1 点：空拍伪 MISS（obstacleId:null / penalizes:false）在渲染侧必须是 no-op，
  //   否则一次空按键会播一遍碎裂/MISS 演出（CORE 的过滤在 DisassembleSystem，这里守的是 WORLD 这一侧）。
  const emptyBeat = {
    grade: 'MISS',
    obstacleId: null,
    track: 'kick',
    type: 'spike',
    isCore: false,
    actionMatch: false,
    deltaMs: 0,
    rule: 'emptyBeat',
    trigger: 'input',
    penalizes: false,
    key: null
  };
  const probeWrap = wl.get(many[0].id);
  const applied = wl.applyJudgment(emptyBeat, tA);
  must(
    id,
    'CR-08：空拍 Judgment 转进 WorldLayer = no-op',
    applied === false && probeWrap.state === 'pending' && probeWrap.fx.judged === false && probeWrap.fx.missed === false,
    `applyJudgment 返回 ${applied}，实例仍 ${probeWrap.state}，fx.judged=${probeWrap.fx.judged} fx.missed=${probeWrap.fx.missed}`
  );
  const real = wl.applyJudgment({ ...emptyBeat, obstacleId: many[0].id, grade: 'PERFECT', rule: 'window', penalizes: true, key: 'jump' }, tA);
  must(id, '真 Judgment 则立刻迁移（对照，证明不是「全部忽略」）', real === true && wl.get(many[0].id).state === 'judged', `返回 ${real}，state=${wl.get(many[0].id).state}`);
  const env = trackEnvelope(v);
  must(id, '三声部 y 分层满足净空门限（弹幕带 ≥2.2×身高）', env.ok === true, `synth 净空 ${fmt(v.groundY - worldYFor('synth', v), 1)}px ≥ ${fmt(v.sizes.barrageGapMin, 1)}px；bass 带内 ${fmt(env.bass.y, 1)} ≥ ${fmt(env.bass.bandTopY, 1)}`);
  must(id, 'spawnFadeAlpha：窗内 1 / 出生线+跨度 0', spawnFadeAlpha(3) === 1 && spawnFadeAlpha(LEAD_BEATS + MOTION.spawnFadeBeats) === 0 && spawnFadeAlpha(LEAD_BEATS + MOTION.spawnFadeBeats + 0.1) === 0, `b=3→1，b=${LEAD_BEATS + MOTION.spawnFadeBeats}→0，再远→0`);
  wl.shutdown();
  must(id, 'WorldLayer.shutdown 释放全部 Graphics', host.list.every((g) => g.destroyed) && wl.ready === false, `${host.list.length} 个 Graphics 全部 destroyed`);
}

function checkRealChart() {
  const id = 'render:chart';
  group(id, '真谱面（SOUND L1/L2 + CORE MockClock）跑通两层');
  const levels = [];
  for (const n of [1, 2]) {
    const f = path.join(ROOT, 'src', 'data', 'levels', `level${n}.json`);
    if (!fs.existsSync(f)) {
      skip(id, `level${n}.json`, `文件不存在（SOUND 未交付 L${n}）`);
      continue;
    }
    try {
      levels.push({ n, cfg: JSON.parse(fs.readFileSync(f, 'utf8')) });
    } catch (err) {
      record(id, `level${n}.json 解析`, FAIL, String(err.message));
    }
  }
  if (!levels.length) return;
  const pg = optional.get('patternGenerator');
  if (!pg || typeof pg.build !== 'function') {
    skip(id, 'PatternGenerator.build', 'src/game/systems/PatternGenerator.js 未导出 build（SOUND）');
    return;
  }
  for (const { n, cfg } of levels) {
    const clock = clockAt(Number(cfg.bpm) || 120, cfg.tempoChanges || []);
    clock.init({ bpm: cfg.bpm, sections: cfg.sections, tempoChanges: cfg.tempoChanges, introBeats: cfg.introBeats, lengthBeats: cfg.lengthBeats });
    clock.start(0);
    const v = viewWithClock(BASE.w, BASE.h, clock, 60 / (Number(cfg.bpm) || 120));
    const all = pg.build(cfg, clock);
    const ids = assertUniqueInstanceIds(all);
    must(id, `L${n} id 唯一 + 字段合法`, ids.errors.length === 0, `实例 ${all.length} 条，error ${ids.errors.length}${ids.errors.length ? `：${ids.errors.slice(0, 3).join(' | ')}` : ''}，warn ${ids.warnings.length}`);
    const renderable = all.filter(isRenderableInstance);
    must(id, `L${n} bed/不可判定实例被过滤（CR-09）`, renderable.length < all.length && renderable.every((r) => r.judgable !== false && TRACKS.includes(r.track)), `总 ${all.length} → 可渲染 ${renderable.length}（过滤掉 ${all.length - renderable.length} 条 judgable:false / track:bed）`);
    must(id, `L${n} timeSec === clock.timeAtBeat(beat)（C4）`, all.every((i) => Math.abs(i.timeSec - clock.timeAtBeat(i.beat)) < 0.001), `最大偏差 ${fmt(Math.max(...all.map((i) => Math.abs(i.timeSec - clock.timeAtBeat(i.beat)))), 6)}s ≤ 1ms`);

    const host = makeHost();
    const wl = new WorldLayer();
    let threw = null;
    try {
      wl.init(host, v);
    } catch (err) {
      threw = err;
    }
    must(id, `L${n} WorldLayer.init 不崩`, !threw, threw ? String(threw.message) : 'ok');
    if (threw) {
      clock.stop();
      continue;
    }
    const tl = new Timeline({ tracks: Object.keys(cfg.tracks || {}).filter((t) => TRACKS.includes(t)) });
    const samples = [cfg.introBeats || 0, 8, 16, 24, 32, 40, 48].filter((b) => b < (Number(cfg.lengthBeats) || 128));
    let maxPair = 0;
    let compared = 0;
    let wrappedAny = false;
    let crash = null;
    try {
      for (const b of samples) {
        const t = clock.timeAtBeat(b);
        const stats = wl.sync({ clock: t, instances: all, view: v });
        const snap = wl.snapshot(t);
        const gLower = new RecordingGraphics('lower');
        tl.draw(gLower, { view: v, nowSec: t, instances: all });
        const sL = tl.snapshot({ view: v, nowSec: t, instances: all });
        if (stats.wrapped > 0) wrappedAny = true;
        const byId = new Map(snap.items.map((it) => [it.id, it]));
        for (const mk of sL.markerXs) {
          const up = byId.get(mk.id);
          if (!up) continue;
          compared += 1;
          maxPair = Math.max(maxPair, Math.abs(up.x - mk.x));
        }
      }
    } catch (err) {
      crash = err;
    }
    must(id, `L${n} 整关同步 + 绘制不抛错`, !crash, crash ? `崩在：${crash.message}` : `采样拍 ${samples.join('/')}，比对 ${compared} 条`);
    must(id, `L${n} WorldLayer 真的挂接到了实例`, wrappedAny, `wrapped=${wl.wraps.size}，visible=${wl.frameStats.visible}，drawn=${wl.frameStats.drawn}（若为 0 → 挂接/泳道键分叉，上层世界是空画面）`);
    must(id, `L${n} 上下层逐实例 x 偏差 < ${JUDGE_TOL_PX}px`, compared > 0 && maxPair < JUDGE_TOL_PX, `比对 ${compared} 条（跨 ${samples.length} 个采样时刻），最大 Δ${fmt(maxPair, 4)}px`);
    headline.chart = `L${n}:${compared}条/Δ${fmt(maxPair, 3)}px`;
    wl.shutdown();
    clock.stop();
  }
}

function checkScan(scopeFiles) {
  const id = 'render:scan';
  group(id, '源码扫描：无场景时钟 / 无速度积分');
  const self = scanSelfTest(id);
  let hits = 0;
  let worldHits = 0;
  let otherHits = 0;
  const byOwner = {};
  const scanned = [];
  for (const f of scopeFiles) {
    const rel = relOf(f);
    scanned.push(rel);
    const res = scanSource(fs.readFileSync(f, 'utf8'));
    if (!res.length) continue;
    hits += res.length;
    const owner = ownerOf(rel);
    byOwner[owner] = (byOwner[owner] || 0) + res.length;
    if (owner === 'WORLD') worldHits += res.length;
    else otherHits += res.length;
    for (const h of res.slice(0, 5)) record(id, `禁用形式 ${rel}:${h.line}`, owner === 'WORLD' ? FAIL : SKIP, `[${h.detector}] ${h.text}${owner === 'WORLD' ? '' : `（owner=${owner}，转 CR-13）`}`);
  }
  must(id, 'WORLD 名下 src/game/** 禁用形式 = 0 处', worldHits === 0, `扫描 ${scanned.length} 个文件 / ${DETECTORS.length} 条探测器 → WORLD 命中 ${worldHits}，他人命中 ${otherHits}`);
  headline.scan = `0/${worldHits}命中·${scanned.length}文件`;
  return { files: scanned.length, hits, worldHits, otherHits, byOwner, self };
}

const COLOR_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\brgba?\s*\(|\bhsla?\s*\(/g;

function checkColors() {
  const id = 'render:colors';
  group(id, '颜色字面量：theme.js 之外 0 处');
  const themeHexes = new Set(
    [...COLOR_HEX_WHITELIST, ...Object.values(DERIVED).map((d) => d.hex), ...TRACKS.map((t) => markerHex(t)), ...TRACKS.map((t) => markerHex(t, 'voice'))].map((h) => h.toLowerCase())
  );
  const files = [...walkFiles(path.join(ROOT, 'src'), (n) => /\.(js|mjs|css)$/.test(n)), path.join(ROOT, 'index.html')].filter((f) => fs.existsSync(f));
  let themeCount = 0;
  let cssCount = 0;
  let worldBad = 0;
  let otherBad = 0;
  const offenders = [];
  for (const f of files) {
    const rel = relOf(f);
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    const found = [];
    for (let ln = 0; ln < lines.length; ln++) {
      const m = lines[ln].match(COLOR_RE);
      if (m) found.push({ line: ln + 1, toks: m });
    }
    if (rel === 'src/data/theme.js') {
      themeCount = found.reduce((a, x) => a + x.toks.length, 0);
      continue;
    }
    if (!found.length) continue;
    const count = found.reduce((a, x) => a + x.toks.length, 0);
    if (rel === 'src/styles/neon.css') {
      cssCount = count;
      const bad = [];
      for (const one of found) for (const tok of one.toks) if (tok.startsWith('#') && !themeHexes.has(tok.toLowerCase())) bad.push(`${one.line}:${tok}`);
      worldBad += bad.length;
      must(id, 'neon.css 的每个色值都等于 theme 派生值', bad.length === 0, `${count} 个色值，越界 ${bad.length}${bad.length ? `：${bad.slice(0, 6).join(' ')}` : ''}`);
      continue;
    }
    const owner = ownerOf(rel);
    if (owner === 'WORLD') {
      worldBad += count;
      for (const one of found.slice(0, 5)) record(id, `散落颜色 ${rel}:${one.line}`, FAIL, one.toks.join(' '));
    } else {
      otherBad += count;
      offenders.push(`${rel}:${found[0].line}[${owner}] ${found.map((o) => o.toks.join('')).slice(0, 3).join('')}`);
    }
  }
  must(id, 'WORLD 名下颜色字面量 = 0 处（theme.js 唯一入口）', worldBad === 0, `theme.js 内 ${themeCount} 处（合法），neon.css ${cssCount} 处（逐值锁死），WORLD 其余 ${worldBad} 处`);
  if (otherBad) skip(id, '他人文件颜色字面量（转 CR，不代改）', `${otherBad} 处：${offenders.join(' | ')} —— 已提 CR-13 请 CORE/SOUND 改走 theme/CSS token`);
  else must(id, '他人文件颜色字面量 = 0 处', true, '干净');
  headline.colors = `theme=${themeCount} css=${cssCount} WORLD越界=${worldBad} 待CR=${otherBad}`;
  return { themeCount, cssCount, worldBad, otherBad, offenders };
}

function checkCssTokens() {
  const id = 'render:colors';
  const f = path.join(ROOT, 'src', 'styles', 'neon.css');
  if (!fs.existsSync(f)) {
    skip(id, 'neon.css token 覆盖', '文件不存在');
    return { tokens: 0 };
  }
  const css = fs.readFileSync(f, 'utf8');
  // 只检查 `--rb-*` 命名空间（= theme 的 token 层）；组件内部的局部变量（如 --chip-clip）不在此约束内
  const defined = [...css.matchAll(/(--rb-[a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g)].map((m) => ({ name: m[1], value: m[2].trim() }));
  const names = new Set(defined.map((d) => d.name));
  const tokens = cssTokens();
  const want = Object.keys(tokens);
  const missing = want.filter((k) => !names.has(k));
  const extras = [...names].filter((k) => !want.includes(k) && !CSS_ALIAS_OF[k]);
  must(id, 'neon.css 覆盖 theme.cssTokens() 全部键', missing.length === 0, `${want.length} 个 token，缺失 ${missing.length}${missing.length ? `：${missing.join(',')}` : ''}`);
  must(id, 'neon.css 不自造未登记 token（别名须登记）', extras.length === 0, `未登记 ${extras.length}${extras.length ? `：${extras.join(',')}` : ''}；别名表 ${Object.keys(CSS_ALIAS_OF).length} 个`);
  let mismatch = 0;
  for (const d of defined) {
    const aliasTarget = CSS_ALIAS_OF[d.name];
    if (tokens[d.name] !== undefined) {
      if (d.value.toLowerCase() !== String(tokens[d.name]).toLowerCase()) {
        mismatch += 1;
        record(id, `token 值与 theme 不一致 ${d.name}`, FAIL, `CSS=${d.value} ≠ theme=${tokens[d.name]}`);
      }
    } else if (aliasTarget) {
      const want2 = String(tokens[aliasTarget]).toLowerCase();
      const viaVar = `var(${aliasTarget})`.toLowerCase();
      const v = d.value.toLowerCase();
      if (v !== want2 && v !== viaVar) {
        mismatch += 1;
        record(id, `别名 ${d.name} 未指向 ${aliasTarget}`, FAIL, `CSS=${d.value} ≠ theme 值 ${tokens[aliasTarget]}（或 var(${aliasTarget})）`);
      }
    }
  }
  must(id, 'neon.css 每个 token 值逐条等于 theme（同口径）', mismatch === 0, `比对 ${defined.length} 条声明（${want.length} 个 theme token + ${Object.keys(CSS_ALIAS_OF).length} 个别名），不一致 ${mismatch} 条`);
  must(id, '字号 token ≥ 20px（PERF-05）', Object.entries(FONT_TIERS).every(([, v]) => v >= FONT_MIN_PX), `最小档 ${Math.min(...Object.values(FONT_TIERS))}px ≥ ${FONT_MIN_PX}px`);
  // CORE 的 DOM 界面层（#ui-root）依赖的 token 必须齐备：分区、判定线比例、三声部标记色/形状、字体、演出档
  const UI_NEEDED = [
    '--rb-zone-hud',
    '--rb-zone-world',
    '--rb-zone-timeline',
    '--rb-ratio-judgeX',
    '--rb-ratio-pxPerBeat',
    '--rb-font-family',
    '--rb-font-hud',
    '--rb-marker-kick',
    '--rb-marker-bass',
    '--rb-marker-synth',
    '--rb-shape-kick',
    '--rb-shape-bass',
    '--rb-shape-synth',
    '--rb-system',
    '--rb-quality'
  ];
  const lackUi = UI_NEEDED.filter((k) => !names.has(k));
  must(id, `CORE 界面层所需 ${UI_NEEDED.length} 个 token 齐备`, lackUi.length === 0, `缺失 ${lackUi.length}${lackUi.length ? `：${lackUi.join(',')}` : ''}`);
  headline.cssTokens = `${defined.length} 个 var`;
  return { tokens: defined.length, names: defined.map((d) => d.name) };
}

function checkQuality() {
  const id = 'render:quality';
  group(id, '粒子/bloom 上限 + 审美三档候选（T16）');
  eq(id, '默认档 = 最保守 quiet', DEFAULT_QUALITY, 'quiet');
  const names = Object.keys(QUALITY_PRESETS);
  eq(id, '审美候选档数 = 3（留给人类挑）', names.length, 3);
  const bursts = names.map((n) => QUALITY_PRESETS[n].particlesPerBurst);
  must(id, 'quiet 的粒子密度是三档最低', QUALITY_PRESETS.quiet.particlesPerBurst === Math.min(...bursts) && quality().bloomIntensity === 0 && quality().frameHoldBeats === 0, `burst ${QUALITY_PRESETS.quiet.particlesPerBurst}（三档 ${bursts.join('/')}），默认 bloom=0、顿帧=0`);
  for (const n of names) {
    const p = quality(n);
    const over = Object.entries(QUALITY_CAPS).filter(([k, cap]) => typeof p[k] === 'number' && p[k] > cap);
    must(id, `${n} 档不越硬上限`, over.length === 0, over.length ? over.map(([k, cap]) => `${k}=${p[k]}>${cap}`).join(' ') : `burst=${p.particlesPerBurst} live=${p.particlesLiveMax} bloom=${p.bloomIntensity}/${p.bloomLayers} parallax=${p.parallaxLayers} shake=${p.shakeMaxPx}`);
    must(id, `${n} 档不篡改分区/pxPerBeat`, !('pxPerBeat' in p) && !('zones' in p) && !('judgeX' in p), `预设键 ${Object.keys(p).length} 个，无几何类字段（降级只动演出）`);
  }
  const over = { ...QUALITY_PRESETS.vivid, particlesPerBurst: 999, particlesLiveMax: 9999, bloomIntensity: 5, bloomLayers: 99, shakeMaxPx: 500, parallaxLayers: 12 };
  const clamped = clampQuality('vivid', over);
  must(
    id,
    '越界值被 clampQuality 削减（上限第一天写死）',
    clamped.clamped &&
      clamped.particlesPerBurst === QUALITY_CAPS.particlesPerBurstMax &&
      clamped.particlesLiveMax === QUALITY_CAPS.particlesLiveMax &&
      clamped.bloomIntensity === QUALITY_CAPS.bloomIntensityMax &&
      clamped.bloomLayers === QUALITY_CAPS.bloomLayersMax &&
      clamped.shakeMaxPx === QUALITY_CAPS.shakeMaxPx &&
      clamped.parallaxLayers <= BACKGROUND_CFG.layersMax,
    `999→${clamped.particlesPerBurst}，9999→${clamped.particlesLiveMax}，bloom 5→${clamped.bloomIntensity}，layers 99→${clamped.bloomLayers}，shake 500→${clamped.shakeMaxPx}，parallax 12→${clamped.parallaxLayers}（notes=${clamped.clampNotes.join('/')}）`
  );
  const firstParticle = DEGRADE_ORDER.findIndex((s) => /particle/i.test(s));
  const firstBloom = DEGRADE_ORDER.findIndex((s) => /bloom/i.test(s));
  must(id, '降级顺序：先粒子后 bloom（VIS-04）', firstParticle >= 0 && firstBloom >= 0 && firstParticle < firstBloom, `DEGRADE_ORDER = ${DEGRADE_ORDER.join(' → ')}`);
  must(id, '三档演出时长均为拍系数', names.every((n) => typeof QUALITY_PRESETS[n].desaturateBeats === 'number' && typeof QUALITY_PRESETS[n].bigTextBeats === 'number'), names.map((n) => `${n}:${QUALITY_PRESETS[n].desaturateBeats}/${QUALITY_PRESETS[n].bigTextBeats}拍`).join(' '));
  headline.quality = `${quality().name}档·burst=${quality().particlesPerBurst}·bloom=${quality().bloomIntensity}·parallax=${quality().parallaxLayers}（候选 ${names.join('/')}）`;
}

function checkBackground(view) {
  const id = 'render:bg';
  group(id, '背景/视差/地面线的拍域一致性');
  const v = view;
  const g = new RecordingGraphics('bg');
  const bg = new Background();
  bg.layout(v);
  bg.draw(g, { view: v, nowSec: 1.234, calm: 0, pulse: 0.5 });
  const gg = groundGeometry(v);
  near(id, '地面线 y === 0.52H', gg.y, v.groundY, EXACT_TOL_PX);
  must(id, '地面线已按几何画出一条水平线', g.horizontalAt(gg.y).length >= 1, `y=${fmt(gg.y, 1)} 水平线 ${g.horizontalAt(gg.y).length} 条`);
  const jg = judgeLineGeometry(v);
  must(id, '上层判定线纵向跨过地面线（拆解点视觉锚在角色脚底）', jg.y0 < gg.y && jg.y1 > gg.y, `y∈[${fmt(jg.y0, 1)}, ${fmt(jg.y1, 1)}] 跨过地面线 ${fmt(gg.y, 1)}`);
  eq(id, '判定线锚点 = (judgeX, groundY)', `${jg.anchor.x},${jg.anchor.y}`, `${v.judgeX},${v.groundY}`);
  must(id, '判定线纵向范围在世界带内', jg.y0 >= v.zones.worldTop && jg.y1 <= v.zones.worldBottom + 1, `[${fmt(jg.y0, 1)}, ${fmt(jg.y1, 1)}] ⊂ [${fmt(v.zones.worldTop, 1)}, ${fmt(v.zones.worldBottom, 1)}]`);
  must(id, '视差位移是 nowSec 的纯函数', parallaxOffsetFor(1.234, v, 1, 100) === parallaxOffsetFor(1.234, v, 1, 100), `同刻重复调用相等（f=1 → ${fmt(parallaxOffsetFor(1.234, v, 1, 100), 2)}px）`);
  must(id, '视差层随时间移动（画面不死）', Math.abs(parallaxOffsetFor(1.234, v, 0.1, 100)) > 0 && Math.abs(parallaxOffsetFor(1.234, v, 0.1, 100)) < 100, `|off| < tileW 且 ≠ 0`);
  const n = activeLayerCount(v);
  must(id, '视差层数 ≥ 2（DoD）', n >= BACKGROUND_CFG.minLayers, `${n} 层（min ${BACKGROUND_CFG.minLayers}，表 ${BACKGROUND_CFG.layers.length}，cap ${QUALITY_CAPS.parallaxLayersMax}）`);
  for (let i = 0; i < n; i++) {
    const lg = layerGeometry(v, i);
    const ys = lg.traces.flatMap((t) => [t.y1, t.y2]);
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    must(id, `第 ${i} 层（${lg.name}）几何落在世界带内`, lo >= 0 && hi <= v.zones.worldBottom + 1, `y∈[${fmt(lo, 1)}, ${fmt(hi, 1)}] ≤ 世界带底 ${fmt(v.zones.worldBottom, 1)}，traces=${lg.traces.length} vias=${lg.vias.length}`);
    must(id, `第 ${i} 层用消色差派生色（不携带声部信息）`, LEGAL_COLOR_INTS.has(lg.color) && !TRACKS.some((t) => lg.color === markerColor(t)), `color=${lg.colorKey}`);
  }
  const factors = BACKGROUND_CFG.layers.map((l) => l.factor);
  must(id, '视差系数单调递增（远慢近快）', factors.every((f, i) => i === 0 || f > factors[i - 1]) && factors[0] < 1, factors.join(' < '));
  must(id, '拆解越深，远景 alpha 越低（只降透明度不加色）', calmFactor(1) < calmFactor(0) && calmFactor(0) === 1, `calm 0→${fmt(calmFactor(0), 2)}，1→${fmt(calmFactor(1), 2)}`);
  const colors = new Set(g.ops.filter((o) => o.style).map((o) => o.style.color));
  must(id, '背景不引入声部色以外的新色相', [...colors].every((c) => LEGAL_COLOR_INTS.has(c)), `出现 ${colors.size} 种颜色，全部在 COLORS/DERIVED/markerColor 值域内`);
  must(id, '背景不许用声部色画装饰（纪律 3）', ![...colors].some((c) => TRACKS.some((t) => c === markerColor(t)) || TRACKS.some((t) => c === markerColor(t, 'voice'))), `背景色集合不含任何声部色（含 marker 变体）`);
  must(id, '地面拍刻度落在拍网格上', g.verticalAt(v.judgeX + v.pxPerBeat * 3).length >= 1 || g.verticals().length > 6, `竖线 ${g.verticals().length} 条，其中 x=${fmt(v.judgeX + 3 * v.pxPerBeat, 1)} 命中 ${g.verticalAt(v.judgeX + v.pxPerBeat * 3).length} 条`);
}

function checkPhysics(view) {
  const id = 'render:physics';
  group(id, 'theme ↔ physics 交叉一致（C8 不许两套口径）');
  const pairs = [
    ['judgeX', VIEW_RATIOS.judgeX, FROZEN.judgeX],
    ['pxPerBeat', VIEW_RATIOS.pxPerBeat, FROZEN.pxPerBeat],
    ['groundY', VIEW_RATIOS.groundY, FROZEN.groundY],
    ['jumpPeakH', VIEW_RATIOS.jumpPeakH, FROZEN.jumpPeakH],
    ['jumpAirBeats', VIEW_RATIOS.jumpAirBeats, FROZEN.jumpAirBeats],
    ['dashDurBeats', VIEW_RATIOS.dashDurBeats, FROZEN.dashDurBeats],
    ['dashDist', VIEW_RATIOS.dashDist, FROZEN.dashDist],
    ['charH', VIEW_RATIOS.charH, AUX.charH],
    ['barrageGapRatio', BACKGROUND_CFG.gapToCharH, AUX.barrageGapRatio],
    ['lookAheadBeats', LEAD_BEATS, AUX.lookAheadBeats]
  ];
  for (const [k, a, b] of pairs) eq(id, `theme.${k} === physics`, a, b, '两份文件必须同值（C8 互相引用不改值）');
  eq(id, 'platformTiers 三档同值', JSON.stringify(VIEW_RATIOS.platformTiers), JSON.stringify([...FROZEN.platformTiers]), `theme ${VIEW_RATIOS.platformTiers.join('/')} vs physics ${[...FROZEN.platformTiers].join('/')}`);
  for (const k of ['spike', 'platform', 'barrage']) eq(id, `SIZES.${k} 与 physics.AUX.sizes 同值`, `${SIZES[k].w}x${SIZES[k].h}`, `${AUX.sizes[k].w}x${AUX.sizes[k].h}`, '固定像素尺寸只有一个来源');
  const st = physicsSelfTest();
  must(id, 'CORE physics.selfTest() 无 error', st.errors.length === 0, `errors ${st.errors.length}${st.errors.length ? `：${st.errors.join(' | ')}` : ''}；warnings ${st.warnings.length}${st.warnings.length ? `（${st.warnings.join(' | ')}）` : ''}`);
  must(id, '跳跃包络覆盖三档平台（W-09 前置）', st.rows.length === AUX.selfTestBpms.length && st.rows.every((r) => r.ok), `六档 BPM 全部 ok=${st.rows.map((r) => r.ok).join('/')}`);
  near(id, 'view.pxPerSec 与 physics.pxPerSec 同值（@view.beatSec）', view.pxPerSec, (metrics1080().pxPerBeat * view.bpm) / 60, 0.02);
}

/* ═══════════════════════════════════════════════════════════════
 * 6 · 可选模块（R2 渲染卡）：存在即断言，缺失则 SKIP 并点名
 * ═══════════════════════════════════════════════════════════════ */

const optional = new Map();

async function loadOptionals() {
  const mods = {
    platform: '../src/game/objects/Platform.js',
    barrage: '../src/game/objects/Barrage.js',
    player: '../src/game/objects/Player.js',
    fx: '../src/game/systems/EffectSystem.js',
    patternGenerator: '../src/game/systems/PatternGenerator.js'
  };
  for (const [key, rel] of Object.entries(mods)) {
    const abs = path.resolve(HERE, rel);
    if (!fs.existsSync(abs)) {
      optional.set(key, null);
      continue;
    }
    try {
      optional.set(key, await import(`file:///${abs.replace(/\\/g, '/')}`));
    } catch (err) {
      optional.set(key, null);
      record('render:optional', `${key} 模块加载`, FAIL, `${rel} import 抛错：${err.message}`);
    }
  }
  return optional;
}

function checkPlatform(mod, view) {
  const id = 'render:tierReach';
  group(id, 'W-09 Platform 三档高度 + 核心落点');
  if (!mod || !mod.Platform) {
    skip(id, 'Platform 模块', 'src/game/objects/Platform.js 尚不存在（W-09 未交付）');
    return;
  }
  const { Platform, PLATFORM_TIERS, tierTopY, coreLandingX, netClearancePx } = mod;
  const m = metrics1080();
  const tiers = Array.isArray(PLATFORM_TIERS) ? PLATFORM_TIERS : [...FROZEN.platformTiers];
  for (let i = 0; i < 3; i++) {
    eq(id, `第 ${i} 档比例 === physics.FROZEN[${i}]`, tiers[i], FROZEN.platformTiers[i]);
    if (typeof tierTopY === 'function') near(id, `第 ${i} 档顶面 y = groundY − ${tiers[i]}H`, tierTopY(view, i), m.groundY - tiers[i] * m.h, 0.6);
  }
  if (typeof tierTopY === 'function') near(id, 'tierTopY 与 CORE physics.platformTopY 同值', tierTopY(view, 2), platformTopY({ w: BASE.w, h: BASE.h }, 2), 0.6);
  const p0 = new Platform(inst('bass', 30, { pitchTier: 0 }));
  const p2 = new Platform(inst('bass', 31, { pitchTier: 2, core: true }));
  near(id, 'pitchTier=0 → 世界 y = 低档包络', p0.anchorY(view), worldYFor('bass', view, { pitchTier: 0 }), 1);
  near(id, 'pitchTier=2 → 世界 y = 高档包络', p2.anchorY(view), worldYFor('bass', view, { pitchTier: 2 }), 1);
  must(id, 'Platform.shape = 横条（形状通道）', p2.shape === SHAPE_BY_TRACK.bass, `shape=${p2.shape}`);
  must(id, '三档世界 y 互不相同（读谱不歧义）', new Set([0, 1, 2].map((t) => Math.round(worldYFor('bass', view, { pitchTier: t })))).size === 3, [0, 1, 2].map((t) => Math.round(worldYFor('bass', view, { pitchTier: t }))).join('/'));
  const env = trackEnvelope(view);
  must(id, '三档都在跳跃可达包络内', env.bass.y >= env.bass.bandTopY - 1e-6 && physicsSelfTest().errors.length === 0, `最高档 y=${fmt(env.bass.y, 1)} ≥ 带上界 ${fmt(env.bass.bandTopY, 1)}，reach=${fmt(env.bass.reachPx, 1)}px`);
  if (typeof netClearancePx === 'function') {
    for (let i = 0; i < 3; i++) must(id, `第 ${i} 档净空 ≥ 1.5× 角色高`, netClearancePx(view, i) >= view.sizes.charH * BACKGROUND_CFG.tierClearanceMinChars - 1e-6, `${fmt(netClearancePx(view, i), 1)}px ≥ ${fmt(view.sizes.charH * BACKGROUND_CFG.tierClearanceMinChars, 1)}px`);
  }
  if (typeof coreLandingX === 'function') near(id, '核心落点 x === 判定线 x', coreLandingX(view), view.judgeX, EXACT_TOL_PX);
}

function checkBarrage(mod, view) {
  const id = 'render:gap';
  group(id, 'W-10 Barrage 网间隙 ≥2.2×角色高 + 时值→速度');
  if (!mod || !mod.Barrage) {
    skip(id, 'Barrage 模块', 'src/game/objects/Barrage.js 尚不存在（W-10 未交付）');
    return;
  }
  const { Barrage, netGeometry, gapMinPx, speedForDur } = mod;
  const charH = view.sizes.charH;
  const minGap = charH * BACKGROUND_CFG.gapToCharH;
  near(id, `gapMinPx = ${BACKGROUND_CFG.gapToCharH}×角色高`, gapMinPx(view), minGap, 0.5);
  near(id, 'gapMinPx 与 physics.AUX.barrageGapRatio 同口径', gapMinPx(view), AUX.barrageGapRatio * metrics1080().charH, 0.5);
  for (const dur of [0.25, 0.5, 1, 2, 4]) {
    const net = netGeometry(view, { dur, core: true });
    must(id, `dur=${dur} 网：每行间隙 ≥ 门限`, net.gaps.length >= 1 && net.gaps.every((g) => g >= minGap - 1e-6) && net.rows >= 2, `rows=${net.rows} gaps=${net.gaps.map((g) => fmt(g, 1)).join('/')}px（门限 ${fmt(minGap, 1)}px）`);
    must(id, `dur=${dur} 网：核心能穿过孔（核心 ≤ 最小间隙）`, net.coreSize <= Math.min(...net.gaps), `核心 ${fmt(net.coreSize, 1)}px ≤ 最小间隙 ${fmt(Math.min(...net.gaps), 1)}px`);
    must(id, `dur=${dur} 网：最低边高过站立角色头顶（站着碰不到 = 必须冲刺）`, net.headroomOk && net.bandBottomY <= view.groundY - view.sizes.charH + 1e-6, `带底 y=${fmt(net.bandBottomY, 1)} ≤ 头顶 ${fmt(view.groundY - view.sizes.charH, 1)}（地面线 ${fmt(view.groundY, 1)}）`);
    must(id, `dur=${dur} 网：整体在世界带内`, net.bandTopY >= view.zones.worldTop && net.bandBottomY <= view.zones.worldBottom, `带 [${fmt(net.bandTopY, 1)}, ${fmt(net.bandBottomY, 1)}] ⊂ [${fmt(view.zones.worldTop, 1)}, ${fmt(view.zones.worldBottom, 1)}]`);
    must(id, `dur=${dur} 网：孔位按拍排布（变速自洽）`, Math.abs(net.holeEveryPx - view.pxPerBeat) < 1e-6, `孔距 = 1 拍 = ${fmt(net.holeEveryPx, 1)}px（NET_HOLE_BEATS 口径）`);
    must(id, `dur=${dur} 网：几何是纯函数`, JSON.stringify(netGeometry(view, { dur, core: true })) === JSON.stringify(net), `${net.rows} 行 / ${net.gaps.length} 间隙，重复调用深度相等`);
  }
  const sShort = speedForDur(0.25);
  const sLong = speedForDur(4);
  must(id, '时值→速度单调（短=快，OBS-04）', sShort > sLong && sLong > 0, `dur 0.25 拍 → ${fmt(sShort, 3)}；dur 4 拍 → ${fmt(sLong, 3)}`);
  const pg = optional.get('patternGenerator');
  if (pg && typeof pg.durToSpeed === 'function') {
    for (const d of [0.25, 0.5, 1, 2, 4]) near(id, `speedForDur(${d}) === SOUND durToSpeed(${d})（不另立映射）`, speedForDur(d), pg.durToSpeed(d), 1e-9, '');
  }
  const b = new Barrage(inst('synth', 30, { core: true }));
  must(id, 'Barrage.shape = 六边形（形状通道）', b.shape === SHAPE_BY_TRACK.synth, `shape=${b.shape}`);
  near(id, 'Barrage 世界 y = synth 带（2.2× 身高净空）', b.anchorY(view), worldYFor('synth', view), 1);
  must(id, 'Barrage 不改变判定线 x / pxPerBeat（纪律 2）', Math.abs(obstacleScreenX(b.instance, 1, view) - (view.judgeX + (b.instance.beat - view.timeToBeat(1)) * view.pxPerBeat)) < 0.01, 'x 仍由 beatOffsetX 给出');
}

function checkPlayer(mod, view, clock) {
  const id = 'render:jumparc';
  group(id, 'W-03 Player：固定 x + 按拍跳跃/冲刺纯函数');
  if (!mod || !mod.Player) {
    skip(id, 'Player 模块', 'src/game/objects/Player.js 尚不存在（W-03 未交付）');
    return;
  }
  const { Player, fixedX, jumpOffsetY, dashOffsetX } = mod;
  near(id, 'fixedX === judgeX（角色钉在判定线上）', fixedX(view), view.judgeX, EXACT_TOL_PX);
  const peak = view.height * FROZEN.jumpPeakH;
  const v120 = view;
  const t0 = clock.timeAtBeat(20);
  const air = FROZEN.jumpAirBeats * v120.beatSec;
  near(id, '顶点高度 = jumpPeakH（0.20H）', jumpOffsetY(v120, t0 + air / 2, t0), peak, 1);
  near(id, '顶点在滞空中点（对称抛物线）', jumpOffsetY(v120, t0 + air * 0.5, t0), jumpOffsetY(v120, t0 + air * 0.5 + 1 / 240, t0), 1);
  must(id, '起跳/落地高度为 0（不悬空不穿地）', Math.abs(jumpOffsetY(v120, t0, t0)) < 1e-6 && Math.abs(jumpOffsetY(v120, t0 + air, t0)) < 1e-6, `y(t0)=${fmt(jumpOffsetY(v120, t0, t0), 6)}，y(t0+air)=${fmt(jumpOffsetY(v120, t0 + air, t0), 6)}`);
  must(id, '滞空外返回 0（不许负高度=穿地）', jumpOffsetY(v120, t0 - 0.3, t0) === 0 && jumpOffsetY(v120, t0 + air + 0.3, t0) === 0, '起跳前/落地后恒 0');
  let up = true;
  for (let k = 1; k <= 8; k++) if (jumpOffsetY(v120, t0 + (air * k) / 32, t0) < jumpOffsetY(v120, t0 + (air * (k - 1)) / 32, t0)) up = false;
  must(id, '上升段单调递增', up, '前半段逐 1/32 滞空检查不减');
  const v132 = viewWithClock(BASE.w, BASE.h, clockAt(132), 60 / 132);
  near(id, '132BPM 顶点高度仍是 jumpPeakH（按拍表达）', jumpOffsetY(v132, 0 + (FROZEN.jumpAirBeats * v132.beatSec) / 2, 0), v132.height * FROZEN.jumpPeakH, 1);
  const dashHalf = (FROZEN.dashDurBeats * v120.beatSec) / 2;
  near(id, '冲刺中点位移 = dashDist(0.12W)', dashOffsetX(v120, t0 + dashHalf, t0), FROZEN.dashDist * v120.width, 1);
  must(id, '冲刺首尾位移为 0（角色不漂出判定线）', Math.abs(dashOffsetX(v120, t0, t0)) < 1e-6 && Math.abs(dashOffsetX(v120, t0 + dashHalf * 2, t0)) < 1e-6 && dashOffsetX(v120, t0 + dashHalf * 4, t0) === 0, `起点 ${fmt(dashOffsetX(v120, t0, t0), 6)} / 终点 ${fmt(dashOffsetX(v120, t0 + dashHalf * 2, t0), 6)}`);
  const pl = new Player({});
  pl.layout(v120);
  const probeA = pl.probeAt(t0 + 1.37, v120);
  const probeB = pl.probeAt(t0 + 1.37, v120);
  eq(id, 'probeAt 纯函数（同刻两次全等）', JSON.stringify(probeA), JSON.stringify(probeB));
  eq(id, 'Player 不持有累积位移（screen.x ≡ judgeX）', Math.round(probeA.x), Math.round(view.judgeX));
  pl.jump(t0);
  const gP = new RecordingGraphics('player');
  pl.update(t0 + air / 2, v120);
  pl.render(gP, v120);
  must(id, '跳跃中绘制体在角色基线上方', gP.ops.length > 0 && gP.ops.every((o) => (o.y === undefined ? true : o.y <= v120.groundY + 1)), `ops ${gP.ops.length} 条，峰值帧 y ≤ 地面线`);
  pl.hit(t0 + air);
  const after = pl.probeAt(t0 + air + 0.05, v120);
  must(id, '受击不改 x（只改表现态）', Math.round(after.x) === Math.round(view.judgeX), `hit 后 x=${fmt(after.x, 2)} state=${after.state}`);
}

function checkEffectSystem(mod, view) {
  const id = 'render:fx';
  group(id, 'W-07 拆解演出三要素同帧 + 上限');
  if (!mod || !mod.EffectSystem) {
    skip(id, 'EffectSystem 模块', 'src/game/systems/EffectSystem.js 尚不存在（W-07 未交付）');
    return;
  }
  const { EffectSystem } = mod;
  const fx = new EffectSystem({});
  fx.layout(view);
  const out = fx.onDisassemble({ track: 'bass', atSec: 1.0 }, 1.0, view);
  must(id, '碎裂/降饱和/大字同帧产出', !!(out && out.shatter && out.desaturate && out.bigText), `同帧返回键：${out ? Object.keys(out).join('/') : '无'}`);
  const q = quality();
  must(id, '降饱和时长 = desaturateBeats × 拍长（不写死 ms）', Math.abs(out.desaturate.sec - q.desaturateBeats * view.beatSec) < 1e-6, `${fmt(out.desaturate.sec, 4)}s = ${q.desaturateBeats}拍@${fmt(view.bpm, 0)}BPM`);
  must(id, '粒子数不越当前档上限', fx.liveCount() <= q.particlesLiveMax, `burst 后 live=${fx.liveCount()} ≤ ${q.particlesLiveMax}`);
  must(id, '演出时长随 BPM 缩放（132 比 110 短）', (out.desaturate.sec || 0) < 60 / 110 * (q.desaturateBeats + 0.001), `@${fmt(view.bpm, 0)}BPM ${fmt(out.desaturate.sec, 4)}s`);
}

/* ═══════════════════════════════════════════════════════════════
 * 6b · R3 新增：W-07 三要素同帧（经 WorldLayer.sync 驱动）/ W-11 核心可辨 / W-12 假节拍
 * ═══════════════════════════════════════════════════════════════ */

const WHITE = COLORS.white.int;
const opColor = (o) => (o && o.style ? o.style.color : null);
const whiteOps = (g) => g.ops.filter((o) => opColor(o) === WHITE);
const fullScreenRects = (g, view) => g.ops.filter((o) => o.op === 'fillRect' && o.x === 0 && o.y === 0 && Math.abs(o.w - view.width) < 0.01 && Math.abs(o.h - view.height) < 0.01);
const triShards = (g) => g.ops.filter((o) => o.op === 'fillPoints' && o.pts && o.pts.length === 3);
const lineOps = (g) => g.ops.filter((o) => o.op === 'line');

function renderObstacleLayer(view, nowSec, list) {
  const g = new RecordingGraphics('coreLayer');
  for (const it of list) {
    const o = new Obstacle(it);
    o.update(nowSec, view);
    o.render(g, view);
  }
  return g;
}

function renderTimelineLayer(view, nowSec, list) {
  const g = new RecordingGraphics('coreLower');
  new Timeline().draw(g, { nowSec, view, instances: list });
  return g;
}

function bboxOf(ops) {
  const pts = [];
  for (const o of ops) {
    if (o.op === 'fillPoints' || o.op === 'strokePoints') for (const p of o.pts) pts.push(p);
  }
  if (!pts.length) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { pts, minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** 端点是否落在包围盒外（留 0.5px 容差；角括号的「空间通道」就靠这个可数的事实） */
function outsideBBox(x, y, bb, pad = 0.5) {
  return x < bb.minX - pad || x > bb.maxX + pad || y < bb.minY - pad || y > bb.maxY + pad;
}
const outsideSeg = (s, bb) => outsideBBox(s.x1, s.y1, bb) && outsideBBox(s.x2, s.y2, bb);
const outsideOp = (o, bb) => outsideSeg(o, bb);

/** W-11：核心 vs 非核心的独立视觉编码（含「灰度化后仍能一眼指出」的可数/空间/明度三通道） */
function checkCoreIdentity(view, clock) {
  const id = 'render:core';
  group(id, 'W-11 核心节点独立编码 + 灰度可辨 + 非核心无 hp 暗示');
  const nowSec = clock.timeAtBeat(43);
  let minDelta = Infinity;
  const notes = [];
  for (const t of TRACKS) {
    const coreG = renderObstacleLayer(view, nowSec, [inst(t, 44, { core: true })]);
    const plainG = renderObstacleLayer(view, nowSec, [inst(t, 44, { core: false })]);
    must(id, `${t}：两层都画出了东西`, coreG.ops.length > 0 && plainG.ops.length > 0, `core=${coreG.ops.length} ops / plain=${plainG.ops.length} ops`);
    const coreWhite = whiteOps(coreG);
    const plainWhite = whiteOps(plainG);
    must(id, `${t}：非核心节点 0 处白墨（255 级灰度）`, plainWhite.length === 0, `白墨 ${plainWhite.length} 处（期望 0）`);
    must(id, `${t}：核心节点有白墨描边+中心点+角括号`, coreWhite.length >= 10, `白墨 ${coreWhite.length} 处（≥10 = 描边1 + 点1 + 括号8）`);
    const coreMax = Math.max(...coreG.ops.map((o) => perceptualLuma(opColor(o))));
    const plainMax = Math.max(...plainG.ops.map((o) => perceptualLuma(opColor(o))));
    const delta = coreMax - plainMax;
    minDelta = Math.min(minDelta, delta);
    notes.push(`${t}:${Math.round(plainMax)}→${Math.round(coreMax)}`);
    must(id, `${t}：灰度 Δ(核心,非核心) ≥ ${GRAY_CONTRAST_MIN}`, delta >= GRAY_CONTRAST_MIN, `${Math.round(plainMax)} → ${Math.round(coreMax)}，Δ${Math.round(delta)}（门限 ${GRAY_CONTRAST_MIN}，0..255）`);
    // 空间通道：4 个角括号必须整体落在字形包围盒之外（去色、去亮度差后仍可分辨）
    const glyphBBox = bboxOf(whiteOps(coreG).filter((o) => o.op === 'strokePoints'));
    const drawnBrackets = whiteOps(coreG).filter((o) => o.op === 'line');
    eq(id, `${t}：画出的角括号段数 === CORE_MARK.count×2`, drawnBrackets.length, CORE_MARK.count * 2);
    must(id, `${t}：画出的角括号全部在字形包围盒外`, !!glyphBBox && drawnBrackets.every((o) => outsideOp(o, glyphBBox)), glyphBBox ? `字形盒=[${fmt(glyphBBox.minX, 1)},${fmt(glyphBBox.maxX, 1)}]×[${fmt(glyphBBox.minY, 1)},${fmt(glyphBBox.maxY, 1)}]，8 段端点全在外` : '取不到字形盒');
    const pure = coreBracketLines(glyphBBox.pts, 40);
    eq(id, `${t}：coreBracketLines 段数 = count×2（纯几何可数）`, pure.length, CORE_MARK.count * 2);
    const pureBB = bboxOf([{ op: 'fillPoints', pts: glyphBBox.pts }]);
    must(id, `${t}：纯几何角括号也在包围盒外（与绘制口径一致）`, pure.every((s) => outsideSeg(s, pureBB)), `pad=${fmt(CORE_MARK.bracketGapRatio, 2)}×half`);
    must(id, `${t}：非核心节点不画角括号（本体无 hp 暗示）`, coreG.ops.length - plainG.ops.length === CORE_MARK.count * 2 + 2, `Δ${coreG.ops.length - plainG.ops.length} 条 op（= 括号 8 + 描边 1 + 中心点 1）`);
    // 下层同一套编码（两层不许分叉）
    const lowCore = renderTimelineLayer(view, nowSec, [inst(t, 44, { core: true })]);
    const lowPlain = renderTimelineLayer(view, nowSec, [inst(t, 44, { core: false })]);
    const dLow = whiteOps(lowCore).length - whiteOps(lowPlain).length;
    const dUp = coreWhite.length - plainWhite.length;
    eq(id, `${t}：上下层核心增量墨迹同数（永不分叉）`, dLow, dUp);
    must(id, `${t}：下层非核心也无白墨增量`, dLow >= CORE_MARK.count * 2, `下层核心比非核心多 ${dLow} 处白墨`);
  }
  headline.core = `三声部灰度 Δ 最小 ${Math.round(minDelta)}（≥${GRAY_CONTRAST_MIN}）· ${notes.join(' ')}`;
  must(id, '核心编码不引入第四种颜色（白=系统色 token）', whiteOps(renderObstacleLayer(view, nowSec, [inst('kick', 44, { core: true })])).every((o) => o.style.color === WHITE) && COLOR_HEX_WHITELIST.includes(COLORS.white.hex), `核心墨迹全部 = COLORS.white（${COLORS.white.hex}）`);
  must(id, 'CORE_MARK.minLumaDelta === GRAY_CONTRAST_MIN（同一门限，不另立）', CORE_MARK.minLumaDelta, GRAY_CONTRAST_MIN);
  must(id, '实测最小 Δ ≥ CORE_MARK.minLumaDelta', minDelta >= CORE_MARK.minLumaDelta, `最小 Δ${Math.round(minDelta)} ≥ ${CORE_MARK.minLumaDelta}`);
}

/** W-07/W-08：拆解演出的同帧、按拍、preset 驱动（**全部经 WorldLayer.sync 驱动**，与浏览器接线同一条路径） */
function checkFxIntegration(view, clock) {
  const id = 'render:fxFrame';
  group(id, 'W-07 三要素同帧（WorldLayer.sync 驱动）+ W-08 复活不补发');
  const q = quality();
  const nowSec = clock.timeAtBeat(44);
  const live = [inst('kick', 44, { core: true }), inst('kick', 45), inst('kick', 46), inst('bass', 45), inst('synth', 44)];
  const host = makeHost();
  const wl = new WorldLayer();
  wl.init(host, view);
  must(id, 'WorldLayer 已内建 EffectSystem（CORE 无需另接线）', !!wl.effects && typeof wl.effects.onDisassemble === 'function', `effects=${wl.effects ? 'yes' : 'NO'}`);

  // 帧 0：先正常同步一帧。**CORE 的调用口径 = 每帧原样下发累积集合（无拆解时是 []）**，
  // 首轮只采纳不重播（从存档恢复的关卡不该一进场就炸）→ 所以帧 0 要带 []，不能省掉这个键。
  const f0 = wl.sync({ clock: nowSec, instances: live, view }, { disassembledTracks: [] });
  must(id, '无事件的帧 0 不画任何演出', f0.fx.ops === 0 && f0.fx.live === 0 && host.texts[0].visible === false, `ops=${f0.fx.ops} live=${f0.fx.live} text.visible=${host.texts[0].visible}`);

  // 帧 1：拆解 kick（★ leader 验收线就是这一句调用形态）
  const textCalls0 = host.texts[0].calls.length;
  const f1 = wl.sync({ clock: nowSec, instances: live, view }, { disassembledTracks: ['kick'] });
  const fxCalls = host.texts[0].calls.length - textCalls0;
  const st = f1.fx.state;
  must(id, '三要素在同一帧起（同一条记录）', !!(st.shatter && st.desaturate && st.bigText) && st.sameFrame.sharedRecord, `sharedRecord=${st.sameFrame && st.sameFrame.sharedRecord}`);
  eq(id, '同帧：碎裂/降饱和/大字的 startSec 全等', `${st.shatter?.startSec}|${st.desaturate?.startSec}|${st.bigText?.startSec}`, `${nowSec}|${nowSec}|${nowSec}`);
  eq(id, '同帧：三者的 startBeat 全等', `${st.shatter?.startBeat}|${st.desaturate?.startBeat}|${st.bigText?.startBeat}`, `${st.sameFrame?.startBeat}|${st.sameFrame?.startBeat}|${st.sameFrame?.startBeat}`);
  eq(id, '同帧：三者的 k 全等（此刻都还是 0）', `${st.shatter?.k}|${st.desaturate?.k}|${st.bigText?.k}`, '0|0|0');
  eq(id, '同帧：触发时刻 = 调用时的 nowSec（没有延后一帧）', st.sameFrame?.startSec, nowSec);
  must(id, '触发帧三要素都已可见（alpha>0）', st.shatter?.alpha > 0 && st.desaturate?.alpha > 0 && st.bigText?.alpha > 0, `碎裂${fmt(st.shatter?.alpha, 3)} / 降饱和${fmt(st.desaturate?.alpha, 3)} / 大字${fmt(st.bigText?.alpha, 3)}`);
  const gFx = host.list[3];
  must(id, '演出画在 fx 层（depth 3，同帧）', gFx != null && gFx.depth === 3 && gFx.ops.length > 0, `fx 层 ${gFx ? gFx.ops.length : 0} 条 op，depth=${gFx && gFx.depth}`);
  must(id, '① 碎裂：每只在场障碍炸出一片三角碎片', triShards(gFx).length === 3 * q.particlesPerBurst, `${triShards(gFx).length} 片 = 在场 3 只 × ${q.particlesPerBurst} 粒（quiet 档）`);
  must(id, '② 降饱和：满屏 base 叠印（整幅 fillRect）', fullScreenRects(gFx, view).some((o) => o.style.color === COLORS.base.int), `满屏叠印 ${fullScreenRects(gFx, view).length} 块`);
  must(id, '① 整屏裂纹横贯画布（全屏碎裂，不是判定点）', lineOps(gFx).length >= FX_TIMING.crackCount * 2, `裂纹 ${lineOps(gFx).length} 段（= ${FX_TIMING.crackCount}×2 折线）`);
  must(id, '③ 大字：同一帧落到 text 对象', host.texts[0].visible === true && host.texts[0].text === '鼓 · 已拆解' && host.texts[0].alpha > 0, `text=「${host.texts[0].text}」 alpha=${fmt(host.texts[0].alpha, 3)} scale=${host.texts[0].scaleX}`);
  must(id, '大字字号 = FONT_TIERS.display 阶（不许自创字号）', host.texts[0].fontSize, view.fontPx.display);
  must(id, '三要素落地在同一次 sync 内（不跨帧）', fxCalls === 6 && gFx.ops.length > 0, `这次 sync 对 text 下了 ${fxCalls} 条指令（ setText/显/隐/alpha/scale/pos/size 各 1），同时 fx 层有 ${gFx.ops.length} 条 op`);
  eq(id, '一次拆解 = 一条事件（绝不逐帧重播）', wl.effects.stats.disassembles, 1);

  // 帧 2..4：同一集合重复下发（只播一次，但碎片必须继续随拍位飞）
  const f4 = wl.sync({ clock: nowSec + view.beatSec * 0.3, instances: live, view }, { disassembledTracks: ['kick'] });
  wl.sync({ clock: nowSec + view.beatSec * 0.45, instances: live, view }, { disassembledTracks: ['kick'] });
  const f6 = wl.sync({ clock: nowSec + view.beatSec * 0.6, instances: live, view }, { disassembledTracks: ['kick'] });
  eq(id, '重复下发不再新增事件', wl.effects.stats.disassembles, 1);
  must(id, '碎片随拍位外扩（是时间函数，不是静止贴图）', f6.fx.state.shatter.k > f4.fx.state.shatter.k && f6.fx.state.shatter.k < 1, `k: ${fmt(f4.fx.state.shatter.k, 4)} → ${fmt(f6.fx.state.shatter.k, 4)}`);
  must(id, '演出时长用拍表达 → 0.6 拍时 k = 0.6/寿命', Math.abs(f6.fx.state.shatter.k - 0.6 / FX_TIMING.shatterBeats) < 1e-9, `k=${fmt(f6.fx.state.shatter.k, 6)} = 0.6拍 / ${FX_TIMING.shatterBeats}拍`);

  // 归零后 fx 层应清空（三要素全部播完：寿命取三者最长的拍系数 + 余量）
  const lifeBeats = Math.max(FX_TIMING.shatterBeats, quality().desaturateBeats, quality().bigTextBeats) + 0.5;
  const fEnd = wl.sync({ clock: nowSec + view.beatSec * lifeBeats, instances: live, view }, { disassembledTracks: ['kick'] });
  must(id, '碎裂寿命走完后粒子归 0、大字隐藏', fEnd.fx.live === 0 && host.texts[0].visible === false, `live=${fEnd.fx.live} text.visible=${host.texts[0].visible}`);

  // W-08 复活：自当前拍之后恢复、不补发、hp 回 1
  const revBeat = 47;
  const revInst = inst('kick', revBeat, { state: 'revived' });
  const tRev = clock.timeAtBeat(46);
  const fRev = wl.sync({ clock: tRev, instances: [revInst], view }, { disassembledTracks: [], revivedIds: [revInst.id] });
  const rv = fRev.fx.state.revive;
  must(id, '复活演出被驱动起来（不是空实现）', !!rv && rv.k < 1, `revive=${rv ? `k${fmt(rv.k, 3)}` : 'null'}`);
  near(id, '不补发历史：扫回起点 = 判定线 x', rv.x0, view.judgeX, EXACT_TOL_PX);
  must(id, '自当前拍之后恢复：复活实例的拍位在 now 之后', revInst.beat > view.timeToBeat(tRev), `${revInst.beat} > nowBeat ${fmt(view.timeToBeat(tRev), 2)}`);
  eq(id, 'hp 显示回 1（不是 4）', rv.hpDisplay, FX_TIMING.reviveHpDisplay);
  eq(id, 'FX_TIMING.reviveHpDisplay === 1（C3 批复的登记值）', FX_TIMING.reviveHpDisplay, 1);
  must(id, '扫回前沿随拍位右推', rv.x1 >= view.judgeX && rv.x1 <= windowRightX(view) + 1, `x1=${fmt(rv.x1, 1)} ∈ [判定线, 出生线 ${fmt(windowRightX(view), 1)}]`);

  // 判定事件驱动：PERFECT / MISS / 空拍
  const hostJ = makeHost();
  const wj = new WorldLayer();
  wj.init(hostJ, view);
  const jd = inst('bass', 45);
  wj.sync({ clock: nowSec, instances: [jd], view }, {});
  wj.sync({ clock: nowSec, instances: [jd], view }, { judgment: { grade: 'PERFECT', obstacleId: jd.id, track: 'bass', type: 'platform', isCore: true, actionMatch: true, deltaMs: 8, rule: 'window', penalizes: true } });
  const sPer = wj.effects.probe();
  must(id, 'PERFECT：粒子数 ≤ preset 上限', sPer.burst && sPer.burst.live <= q.particlesLiveMax, `burst=${sPer.burst ? sPer.burst.live : 0} ≤ ${q.particlesLiveMax}（PRD 22 粒属 standard 档）`);
  must(id, 'PERFECT：判定线金闪（白墨竖线）', whiteOps(hostJ.list[3]).some((o) => o.op === 'line'), `白墨线 ${whiteOps(hostJ.list[3]).filter((o) => o.op === 'line').length} 段`);
  eq(id, '顿帧：quiet 档 frameHoldBeats=0 ⇒ WORLD 不擅自冻结时序', sPer.hitStop.beats, q.frameHoldBeats);
  const before = wj.effects.events.length;
  wj.sync({ clock: nowSec + 0.01, instances: [jd], view }, { judgment: { grade: 'MISS', rule: 'emptyBeat', obstacleId: null, penalizes: false, actionMatch: false, deltaMs: 0 } });
  eq(id, '空拍（CR-08）= 演出 no-op', wj.effects.events.length, before);
  const missInst = inst('synth', 45);
  const fMiss = wj.sync({ clock: nowSec + 0.02, instances: [missInst], view }, { judgment: { grade: 'MISS', obstacleId: missInst.id, track: 'synth', type: 'barrage', isCore: true, actionMatch: true, deltaMs: 120, rule: 'timeout', penalizes: true } });
  const sMiss = wj.effects.probe();
  must(id, 'MISS：红 vignette 叠印存在且只用 kick 红 token', sMiss.vignette && sMiss.vignette.alpha > 0 && hostJ.list[3].ops.some((o) => o.op === 'fillRect' && o.style.color === COLORS.kick.int), `vignette alpha=${fmt(sMiss.vignette ? sMiss.vignette.alpha : 0, 3)}`);
  const sh = { x: hostJ.list[1].x, y: hostJ.list[1].y };
  must(id, 'MISS：震屏把位移**赋**给各层（是时间的函数，不是积分累加）', Math.hypot(sh.x, sh.y) > 0 && fMiss.fx.shake > 0 && Math.hypot(sh.x, sh.y) <= Math.min(q.shakeMaxPx, QUALITY_CAPS.shakeMaxPx), `dx=${fmt(sh.x, 3)} dy=${fmt(sh.y, 3)}（|Δ|=${fmt(fMiss.fx.shake, 3)} ≤ min(preset ${q.shakeMaxPx}, cap ${QUALITY_CAPS.shakeMaxPx})）`);
  must(id, 'MISS：各层同步位移（同一 dx/dy，两层不许分叉）', hostJ.list[0].x === sh.x && hostJ.list[2].x === sh.x && hostJ.list[3].y === sh.y, 'bg/障碍/角色/fx 四层拿到的是同一个位移赋值');
  wj.sync({ clock: nowSec + 0.02 + MOTION.shakeBeats * view.beatSec + 0.01, instances: [missInst], view }, {});
  must(id, '震屏走完后各层位移归 0（不残留）', hostJ.list[1].x === 0 && hostJ.list[1].y === 0, `(${fmt(sh.x, 2)},${fmt(sh.y, 2)}) → (0,0)`);

  // 按拍而非按毫秒：110 vs 150 的同一拍数演出
  const vA = viewWithClock(BASE.w, BASE.h, clockAt(110), 60 / 110);
  const vB = viewWithClock(BASE.w, BASE.h, clockAt(150), 60 / 150);
  const fx110 = new (wl.effects.constructor)({});
  const fx150 = new (wl.effects.constructor)({});
  fx110.layout(vA);
  fx150.layout(vB);
  const oA = fx110.onDisassemble({ track: 'kick', atSec: 0 }, 0, vA);
  const oB = fx150.onDisassemble({ track: 'kick', atSec: 0 }, 0, vB);
  must(id, '同一拍数演出在两关等长（k 相同）', Math.abs(oA.desaturate.k - oB.desaturate.k) < 1e-12 && Math.abs(oA.bigText.k - oB.bigText.k) < 1e-12, `k=${oA.desaturate.k}/${oB.desaturate.k}`);
  near(id, '秒数随拍长缩放（0.545s vs 0.4s）', oA.desaturate.sec / oB.desaturate.sec, vA.beatSec / vB.beatSec, 1e-9, '×');
  eq(id, '拍系数在两关相同（写死 ms 就会在这里红）', oA.desaturate.beats, oB.desaturate.beats);
  const pA = fx110.stateAt(q.desaturateBeats * vA.beatSec, vA);
  const pB = fx150.stateAt(q.desaturateBeats * vB.beatSec, vB);
  must(id, '走完 preset 拍数后两关同时结束', pA.desaturate.done === true && pB.desaturate.done === true && pA.shatter.done === pB.shatter.done, `@110 ${fmt(pA.desaturate.k, 3)} / @150 ${fmt(pB.desaturate.k, 3)}`);

  // 三档审美 + 上限
  const perPreset = {};
  for (const name of Object.keys(QUALITY_PRESETS)) {
    const f = new (wl.effects.constructor)({ quality: name });
    const gh = new RecordingGraphics(`fx-${name}`);
    const out = f.onDisassemble({ track: 'kick', atSec: 1 }, 1, view);
    f.draw(gh, { nowSec: 1, view });
    const pq = quality(name);
    perPreset[name] = { shards: triShards(gh).length, live: out.shatter.live, full: fullScreenRects(gh, view).length, bloomLayers: pq.bloomLayers };
    must(id, `${name} 档：粒子 ≤ preset ≤ 硬上限`, out.shatter.live <= pq.particlesLiveMax && pq.particlesLiveMax <= QUALITY_CAPS.particlesLiveMax, `live=${out.shatter.live} ≤ ${pq.particlesLiveMax} ≤ ${QUALITY_CAPS.particlesLiveMax}`);
    must(id, `${name} 档：bloom 只在 preset 允许时叠印`, (perPreset[name].full > 1) === (pq.bloomLayers > 0), `满屏级叠印 ${perPreset[name].full} 块（bloomLayers=${pq.bloomLayers}）`);
  }
  must(id, '三档强度互不相同（T16 不许独断）', new Set(Object.values(perPreset).map((p) => p.shards)).size === 3, Object.entries(perPreset).map(([k, p]) => `${k}=${p.shards}片/${p.full}叠印`).join(' '));
  const quietA = quality('quiet'), vividA = quality('vivid');
  must(id, '光敏安全档的叠印强度更低（PERF-05 ③）', quietA.flashReductionSafe === true && vividA.flashReductionSafe === false && perPreset.quiet.live < perPreset.vivid.live, `quiet safe=${quietA.flashReductionSafe} vivid safe=${vividA.flashReductionSafe}`);
  const off = new (wl.effects.constructor)({ enabled: false });
  off.layout(view);
  const offOut = off.onDisassemble({ track: 'kick', atSec: 1 }, 1, view);
  const offG = new RecordingGraphics('fxOff');
  const offDraw = off.draw(offG, { nowSec: 1, view });
  must(id, '演出可整档关闭（拆解总开关 = 光敏）', offOut.shatter === null && off.liveCount(1, view) === 0 && offDraw.drawn === 0 && offG.ops.length === 0, `shatter=${offOut.shatter} live=${off.liveCount(1, view)} 画出 ${offG.ops.length} 条 op`);
  wl.shutdown();
  wj.shutdown();
  headline.fx = `同帧三要素=${st.sameFrame.sharedRecord ? '✓' : '×'} ${triShards(gFx).length}片/${fullScreenRects(gFx, view).length}叠印/「${host.texts[0].text}」；110↔150 拍系数等值`;
}

/** W-12：假节拍只渲染在下层 + 跨度按拍 + 变速预告读 clock.getTempoCues() */
function checkGhostLayer(view, _clock) {
  const id = 'render:ghost';
  group(id, 'W-12 假节拍只在下层 + lengthBeats 按拍 + 变速预告读 cues');
  const src = [
    { beat: 40, offsetBeats: 0.5, lengthBeats: 2 },
    { beat: 42, lengthBeats: 1 },
    { beat: 44, offsetBeats: 0.5, lengthBeats: 1.5, glitch: true },
    { beat: 46, lengthBeats: 2, glitch: true },
    { beat: 48, lengthBeats: 1 },
    { beat: 50, lengthBeats: 1, glitch: true },
    { beat: 52, lengthBeats: 2 },
    { beat: 54, lengthBeats: 1 },
    { beat: 56, lengthBeats: 1 },
    { beat: 58, lengthBeats: 2 }
  ];
  const gs = normalizeGhosts(src);
  must(id, `条数被 ghostMax=${TIMELINE_CFG.ghostMax} 截住（L-06 预砍口径）`, gs.length === TIMELINE_CFG.ghostMax, `${gs.length} 条（输入 ${src.length}）`);
  must(id, 'lengthBeats 原样进渲染层（CR-12：不换算秒）', gs[0].lengthBeats === 2 && gs[2].lengthBeats === 1.5, `[${gs.map((g) => g.lengthBeats).join(',')}]`);
  must(id, 'lengthBeats 越界被削（SOUND gate 的镜像）', normalizeGhosts([{ beat: 40, lengthBeats: 9 }])[0].lengthBeats === TIMELINE_CFG.ghostLenMaxBeats, `9 拍 → ${TIMELINE_CFG.ghostLenMaxBeats}`);
  const nowBeat = 42;
  const nowSec = beatToTimeOf(view, nowBeat);
  for (const g of gs.slice(0, 3)) {
    const geo = ghostGeometry(view, { beat: g.beat, offsetBeats: g.offsetBeats, lengthBeats: g.lengthBeats }, nowBeat);
    near(id, `ghost@${g.beat} 跨度 = ${g.lengthBeats}拍 × pxPerBeat`, geo.spanPx, g.lengthBeats * view.pxPerBeat, 0.02);
    eq(id, `ghost@${g.beat} 跨度与拍数换算同式（beatOffsetX）`, geo.spanPx, beatOffsetX(view, g.beat + g.offsetBeats + g.lengthBeats - nowBeat) - beatOffsetX(view, g.beat + g.offsetBeats - nowBeat));
  }
  const tl = new Timeline({ ghostBeats: src });
  const gTl = new RecordingGraphics('ghostOnly');
  const stats = tl.draw(gTl, { nowSec, view, instances: [] });
  must(id, '下层确实画出了假标记', stats.ghosts > 0, `本帧 ${stats.ghosts} 条`);
  const only = new RecordingGraphics('ghostOnly2');
  tl.drawGhostMarkers(only, view, nowBeat);
  const glitchLines = only.ops.filter((o) => opColor(o) === WHITE);
  must(id, '故障闪烁处数 ≤ ghostGlitchMax', new Set(glitchLines.map((o) => Math.round(o.x1))).size <= TIMELINE_CFG.ghostGlitchMax, `${new Set(glitchLines.map((o) => Math.round(o.x1))).size} 处白扫描线 ≤ ${TIMELINE_CFG.ghostGlitchMax}`);
  must(id, '假标记绝不用声部色（不会被误读成真事件）', only.ops.every((o) => opColor(o) === COLORS.system.int || opColor(o) === WHITE), `${only.ops.length} 条 op 只有系统青/白两种色`);
  must(id, '假标记绝不进判定/音频：本模块不认识 judgable', !/judgable|Judge|clock/.test(String(tl.drawGhostMarkers)), 'drawGhostMarkers 不引用判定/时钟（渲染层唯一职责）');
  // 只在下层：上层（障碍层 + 演出层）一个假标记都没有
  const host = makeHost();
  const wl = new WorldLayer();
  wl.init(host, view);
  wl.sync({ clock: nowSec, instances: [inst('kick', 44), inst('bass', 45)], view }, {});
  const upper = host.list[1].ops.concat(host.list[3].ops);
  must(id, '上层 0 处菱形假标记（只在下层时间轴）', upper.filter((o) => (o.op === 'strokePoints' || o.op === 'fillPoints') && o.pts && o.pts.length === 4 && opColor(o) === COLORS.system.int).length === 0, `上层 ${upper.length} 条 op，菱形假标记 0 处`);
  must(id, '上层不含系统色描边（假标记没漏进世界里）', host.list[1].ops.every((o) => opColor(o) !== COLORS.system.int), `障碍层系统色 op = 0`);
  // 变速关：按拍等距仍然成立（L4 120→140）
  const tcView = viewWithClock(BASE.w, BASE.h, clockAt(120, [{ beat: 64, bpm: 140, transitionBeats: 6 }]), 0.5);
  const nb = tcView.timeToBeat(tcView.beatToTime(60));
  const a = ghostGeometry(tcView, { beat: 59, offsetBeats: 0.5, lengthBeats: 2 }, nb);
  const b = ghostGeometry(tcView, { beat: 61, offsetBeats: 0.5, lengthBeats: 2 }, nb);
  near(id, '变速点两侧 ghost 仍按拍等距（Δ=2拍×pxPerBeat）', b.x - a.x, 2 * tcView.pxPerBeat, 0.05);
  must(id, '假标记不吃秒域公式（否则变速后会漂）', Math.abs(a.x - beatOffsetX(tcView, 59 + 0.5 - nb)) < 0.01, `x=${fmt(a.x, 2)} = beatOffsetX(拍域)`);
  // 变速视觉预告：数据源 = CORE 的 clock.getTempoCues()（CR-08 批复：WORLD 不自行推算）
  // 这里用**契约桩**（形状逐字段照 C1/CR-08），这样 SOUND 的 BeatClock 怎么改都不影响本门禁
  const cueData = [{ beat: 64, targetBeat: 70, bpmFrom: 120, bpmTo: 140, timeSec: 32, targetTimeSec: 35.0 }];
  const cueClock = { getTempoCues: () => cueData.map((c) => ({ ...c })), beatAt: (t) => t / 0.5, timeAtBeat: (b) => b * 0.5 };
  const cues = normalizeTempoCues(cueClock);
  must(id, 'cue 直接读自 clock.getTempoCues()（不是本层算的）', cues.length === 1 && cueData.length === 1, `${cues.length} 条：${JSON.stringify(cues[0])}`);
  eq(id, 'cue 的 targetBeat/bpmTo 原样透传（不换算、不四舍五入）', `${cues[0].targetBeat}/${cues[0].bpmTo}`, '70/140');
  const tl4 = new Timeline({ clock: cueClock });
  eq(id, 'Timeline 拿到 clock 就能建出预告（setTempoCues 同源）', tl4.setTempoCues(cueClock), cues.length);
  const g4 = new RecordingGraphics('tempo');
  const s4 = tl4.draw(g4, { nowSec: cueClock.timeAtBeat(60), view: tcView, instances: [] });
  must(id, '变速预告在本帧画出来了', s4.tempoCues === 1, `stats.tempoCues=${s4.tempoCues}`);
  const geo4 = tempoCueGeometry(tcView, cues[0], tcView.timeToBeat(cueClock.timeAtBeat(60)));
  near(id, '预告区间 = [beat, targetBeat] 的拍距 × pxPerBeat', geo4.spanPx, geo4.beats * tcView.pxPerBeat, 0.05);
  eq(id, '预告区间拍距 = targetBeat − beat（6 拍过渡）', geo4.beats, 6);
  const chev4 = g4.ops.filter((o) => o.op === 'strokePoints' && o.close === false && o.style.color === COLORS.system.int && o.pts && o.pts.length === 3);
  must(id, '变速预告箭头数 = tempoCueChevrons（不多不少 → 没有第二个变速点）', chev4.length === TIMELINE_CFG.tempoCueChevrons, `${chev4.length} 支箭头（预算 ${TIMELINE_CFG.tempoCueChevrons}）`);
  must(id, '预告只画一次 chevron（无自算的第二个变速点）', g4.ops.filter((o) => o.style.color === COLORS.system.int && o.op === 'line').length <= TIMELINE_CFG.tempoCueChevrons + 4, `${g4.ops.length} 条 op / ${TIMELINE_CFG.tempoCueChevrons} 个箭头`);
  const tlEmpty = new Timeline({ ghostBeats: [] });
  const g5 = new RecordingGraphics('noTempo');
  const s5 = tlEmpty.draw(g5, { nowSec: cueClock.timeAtBeat(70), view: tcView, instances: [] });
  must(id, '无 cue / cue 出窗 → 一条都不画（不许自己推算）', s5.tempoCues === 0 && tlEmpty.tempoCues.length === 0, `tempoCues=${tlEmpty.tempoCues.length}`);
  eq(id, 'normalizeTempoCues 对非时钟输入返回空（防御）', normalizeTempoCues(null).length, 0);
  eq(id, 'normalizeTempoCues 接受 cues 数组原样', normalizeTempoCues([{ beat: 10, targetBeat: 16, bpmFrom: 120, bpmTo: 140 }]).length, 1);
  eq(id, '把缺 targetBeat 的残缺 cue 归一成零宽度（绝不猜过渡长度）', normalizeTempoCues([{ beat: 10, bpmTo: 140 }])[0].targetBeat, 10);
  wl.shutdown();
  headline.ghost = `${gs.length}条/跨度按拍(${fmt(gs[0].lengthBeats, 1)}拍=${fmt(ghostGeometry(view, gs[0], nowBeat).spanPx, 1)}px)/cues=${cues.length}`;
}


export const SELFTEST_SCHEMA = 'world-selftest/v1';

function parseSelftestArg(arg) {
  if (arg == null) return { skip: `未提供 --selftest：浏览器端 ?selftest=render 负载未接入（端点归 CORE 的 R2/K-05，schema=${SELFTEST_SCHEMA}）` };
  if (arg === '-') {
    try {
      return { json: JSON.parse(fs.readFileSync(0, 'utf8')) };
    } catch (err) {
      return { error: `stdin 读取/解析失败：${err.message}` };
    }
  }
  const p = path.resolve(ROOT, arg);
  if (fs.existsSync(p)) {
    try {
      return { json: JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch (err) {
      return { error: `${arg} 不是合法 JSON：${err.message}` };
    }
  }
  try {
    return { json: JSON.parse(arg) };
  } catch {
    return { error: `--selftest 参数既不是可读文件也不是合法 JSON：${String(arg).slice(0, 80)}` };
  }
}

/* ═══════════════════════════════════════════════════════════════
 * 7z · W-13 教学浮层（render:overlay）
 *   需求侧的数（PRD LVL-04 / §10 / §11）写死在这里，被测模块对着它们量 ——
 *   反过来「从 OverlayLayer 读常量再断言等于自己」就是脚手架，不算断言。
 * ═══════════════════════════════════════════════════════════════ */

/** PRD LVL-04「前 8 拍分步」+ §10「3 步」：门禁侧的独立要求，不 import 被测常量 */
const REQ_TUTORIAL_LEVEL = 1;
const REQ_STEP_START_BEATS = [0, 2, 4];
const REQ_TUTORIAL_END_BEAT = 8;
/** PRD §11 L1「首次玩家 20 拍内出现首个 PERFECT」：教学必须在 20 拍这条线之前把话讲完 */
const REQ_FIRST_PERFECT_BEAT = 20;

/** 一组绘制指令的包围盒（**绘制真相**：浮层实际把笔落在了哪些像素上）。 */
function opsBBox(ops) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const eat = (xs, ys) => {
    if (!xs.length || !ys.length) return;
    x0 = Math.min(x0, ...xs);
    x1 = Math.max(x1, ...xs);
    y0 = Math.min(y0, ...ys);
    y1 = Math.max(y1, ...ys);
  };
  for (const o of ops || []) {
    if (o.op === 'fillRect' || o.op === 'strokeRect') eat([o.x, o.x + o.w], [o.y, o.y + o.h]);
    else if (o.op === 'fillCircle') eat([o.x - o.r, o.x + o.r], [o.y - o.r, o.y + o.r]);
    else if (o.op === 'fillPoints' || o.op === 'strokePoints') eat(o.pts.map((p) => p.x), o.pts.map((p) => p.y));
    else if (o.op === 'line') eat([o.x1, o.x2], [o.y1, o.y2]);
  }
  return { x0, y0, x1, y1, n: (ops || []).length };
}

/** 抹掉所有空白：换行会把一行拆成多行，比对文案落屏时用「去空白后包含」才不会误判。 */
function squashAll(s) {
  return String(s).replace(/\s+/g, '');
}

function checkOverlay(baseView) {
  const id = 'render:overlay';
  group(id, 'W-13 教学浮层：前 8 拍三步 / 不遮挡判定线 / 可跳过且持久化');
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src', 'game', 'scenes', 'LevelRuntime.js'), 'utf8');
  const overlaySrc = fs.readFileSync(path.join(ROOT, 'src', 'game', 'render', 'OverlayLayer.js'), 'utf8');
  const keys = keyLabelsFrom(KEYMAP);
  const steps = buildSteps({ expectedAction: (type) => expectedAction(type), keys });

  /* —— ③ 三步内容：非空、互不相同、键名与真实键位一致 —— */
  eq(id, 'PRD LVL-04：三步的起始拍 = 0/2/4 拍', STEP_START_BEATS.join(','), REQ_STEP_START_BEATS.join(','));
  eq(id, 'PRD LVL-04：第 8 拍（含）起不再出现', TUTORIAL_END_BEAT, REQ_TUTORIAL_END_BEAT);
  eq(id, 'PRD §10：恰好 3 步', steps.length, REQ_STEP_START_BEATS.length);
  eq(id, 'PRD §11：教学只挂第 1 关', TUTORIAL_LEVEL_ID, REQ_TUTORIAL_LEVEL);
  must(id, '每步都有标题与非空正文', steps.every((s) => s.head.trim().length >= 3 && s.lines.length >= 1 && s.lines.every((l) => l.trim().length >= 4)), steps.map((s) => `${s.index}:${s.head}(${s.lines.length}行)`).join(' '));
  must(id, `每步正文 ≤ ${BODY_LINES_MAX} 行（LVL-04「文字 ≤2 行/步」）`, steps.every((s) => s.lines.length <= BODY_LINES_MAX), steps.map((s) => s.lines.length).join('/'));
  must(id, '三步标题两两不同', new Set(steps.map((s) => s.head)).size === steps.length, steps.map((s) => s.head).join(' | '));
  must(id, '三步正文两两不同（没有复制粘贴的占位话）', new Set(steps.map((s) => s.lines.join(''))).size === steps.length, '三步正文拼接后互不相等');
  const allCopy = steps.map((s) => s.head + s.lines.join('')).join('') + chipTextFor(keys);
  must(id, `文案里出现的键名 = KEYMAP 真键位（跳=${keys.jump} 冲=${keys.dash} 跳过=${keys.skip}）`, allCopy.includes(keys.jump.split('/')[0]) && allCopy.includes(keys.dash) && allCopy.includes(keys.skip), `jump「${keys.jump}」dash「${keys.dash}」skip「${keys.skip}」都在文案里`);
  const shapeWords = Object.values(SHAPE_LABEL).map((v) => v.shape);
  const heightWords = Object.values(HEIGHT_LABEL);
  must(id, '第 3 步按形状点名要按什么（不是「请注意」这种虚话）', steps[2].lines.join('').includes(shapeWords[0]) && steps[2].lines.join('').includes(shapeWords[2]) && steps[2].lines.join('').includes(keys.jump), steps[2].lines.join(' / '));
  const blind = buildSteps({ keys });
  must(id, '没注入 expectedAction ⇒ 不谎报形状归属（宁可少说）', blind[2].actionsKnown === false && !blind[2].lines.join('').includes(shapeWords[0]), `退化成「${blind[2].lines.join(' / ')}」`);
  const inverted = buildSteps({ expectedAction: () => 'dash', keys });
  const invCopy = inverted[2].lines.join('');
  must(id, '反证：文案跟随注入的动作表而变 ⇒ 映射只有一份真相（JudgeSystem）',
    invCopy.includes(`${shapeWords[2]}要${'冲'}`) && !shapeWords.some((w) => invCopy.includes(`${w}要跳`)),
    `把 expectedAction 换成恒 dash 的假函数后：${inverted[2].lines.join(' / ')}`);
  must(id, '浮层源码里没有第二张动作表（ACTION_BY_TYPE / barrage:dash 之类）', !/ACTION_BY_TYPE|barrage\s*:\s*.?dash/.test(overlaySrc), '形状归属只能从 expectedAction 问出来');

  /* —— DEF-06：颜色词不得作唯一判别线索（教学通道必须走已证可辨的冗余通道）—— */
  must(id, 'DEF-06 文案不把颜色词与形状名绑在一起（「红三角」这类写法为 0 处）',
    !steps.some((s) => /[红黄粉蓝绿橙紫青](三角|横条|六边形)/.test(s.head + s.lines.join(''))),
    steps.map((s) => s.head).join(' | '));
  const decol = steps.map((s) => (s.head + s.lines.join('')).replace(/[红黄粉蓝绿橙紫青]/g, ''));
  must(id, 'DEF-06 抹掉全部颜色词后，第 ① 步仍能认出声部（形状 + 高度两条已证通道都在）',
    shapeWords.every((w) => decol[0].includes(w)) && heightWords.every((w) => decol[0].includes(w)),
    `① 去色后=「${decol[0]}」，需含 ${shapeWords.join('/')} + ${heightWords.join('/')}`);
  must(id, 'DEF-06 抹掉全部颜色词后，第 ③ 步仍能指认每个声部该按什么',
    shapeWords.filter((w) => decol[2].includes(w)).length >= 2 && /[跳冲]/.test(decol[2]),
    `③ 去色后=「${decol[2]}」`);
  must(id, 'DEF-06 去色后三步仍两两不同（颜色不是区分步骤的暗道）', new Set(decol).size === decol.length, decol.map((s) => s.slice(0, 12)).join(' | '));
  must(id, '高度词与可达性包络一致（贴地=ground / 半空=jump-band / 头顶=dash-only）', (() => {
    const env = trackEnvelope(baseView);
    // 注意：断言的是**各自的可达性模式**，不是 bass 与 synth 的 y 排序——
    // 实测 worldYFor(bass, pitchTier=2)=334.8 比 worldYFor(synth)=383.4 更高，
    // 高档横条确实会盖到网的上方，所以「谁更靠上」不成立，「贴地/跳跃带/只需冲的净空」才成立。
    return env.kick.mode === 'ground' && HEIGHT_LABEL.spike === '贴地'
      && env.bass.mode === 'jump-band' && HEIGHT_LABEL.platform === '半空'
      && env.synth.mode === 'dash-only' && HEIGHT_LABEL.barrage === '头顶'
      && env.synth.clearancePx >= baseView.sizes.player.h
      && env.kick.y === baseView.groundY;
  })(), `modes ${trackEnvelope(baseView).kick.mode}/${trackEnvelope(baseView).bass.mode}/${trackEnvelope(baseView).synth.mode}，synth 净空 ${fmt(trackEnvelope(baseView).synth.clearancePx, 1)}px ≥ 身高 ${fmt(baseView.sizes.player.h, 1)}px`);

  /* —— ① 显隐时刻按拍算（纯函数 + 真时钟两种口径） —— */
  const table = [-1, -0.0004, 0, 0.5, 1.9, 1.9999, 2, 3.4, 3.9999, 4, 6, 7.9, 7.9999, 8, 9, 120];
  const mapped = table.map((b) => {
    const s = stepForBeat(b);
    return `${b}→${s == null ? 'off' : s.index}`;
  });
  must(id, '拍→步 与 PRD 分步表一致（窗内 3 段、窗外 null）', mapped.join(' ') === '-1→0 -0.0004→0 0→0 0.5→0 1.9→0 1.9999→0 2→1 3.4→1 3.9999→1 4→2 6→2 7.9→2 7.9999→2 8→off 9→off 120→off', mapped.join(' '));
  must(id, '拍→步 是纯函数（同拍同问 100 次全等）', (() => {
    for (let i = 0; i < 100; i += 1) {
      const a = stepForBeat(4.2);
      const b = stepForBeat(4.2);
      if (!a || !b || a.index !== b.index || a.startBeat !== b.startBeat) return false;
    }
    return true;
  })(), '100 次重复调用逐字段相等（无内部状态、无累积）');
  must(id, 'NaN/undefined 拍 ⇒ 不显示（不拿脏值蒙进步骤）', stepForBeat(NaN) === null && stepForBeat(undefined) === null, 'stepForBeat(NaN)=null');

  const clk = clockAt(120);
  const ovHost = makeHost();
  const ov = new OverlayLayer({ levelId: 1, expectedAction: (t) => expectedAction(t), keymap: KEYMAP });
  ov.init(ovHost, baseView);
  const marks = [];
  let lastKey = null;
  for (let f = 0; f <= 1320; f += 1) {
    const t = f / 120; // 1/120s 一步，0..11s = 0..22 拍 @120BPM
    const s = ov.sync({ clock: t, view: baseView });
    const key = s.visible ? `step${s.stepIndex}` : 'off';
    if (key !== lastKey) {
      marks.push({ key, t, beat: clk.beatAt(t) });
      lastKey = key;
    }
  }
  const at = (key) => marks.find((m) => m.key === key);
  must(id, '真时钟推进下的转换序列 = 出现→换步→换步→消失', marks.map((m) => m.key).join(',') === 'step0,step1,step2,off', marks.map((m) => `${m.key}@${fmt(m.beat, 3)}拍`).join(' '));
  const beatTol = 0.02;
  for (const [key, want] of [['step0', 0], ['step1', REQ_STEP_START_BEATS[1]], ['step2', REQ_STEP_START_BEATS[2]], ['off', REQ_TUTORIAL_END_BEAT]]) {
    const m = at(key);
    must(id, `${key} 的触发拍 = ${want}（±${beatTol} 拍）`, !!m && Math.abs(m.beat - want) <= beatTol, m ? `实测 ${fmt(m.beat, 4)} 拍（t=${fmt(m.t, 4)}s）` : '从未出现该转换');
  }
  must(id, '消失是「到 8 拍」而不是「过了 N 秒」', !!at('off') && Math.abs(at('off').t - REQ_TUTORIAL_END_BEAT * clk.beatLengthSec(0)) <= beatTol * clk.beatLengthSec(0), `off 在 t=${fmt(at('off') ? at('off').t : -1, 4)}s，8 拍 @120BPM = ${fmt(REQ_TUTORIAL_END_BEAT * clk.beatLengthSec(0), 4)}s`);
  const fast = clockAt(150);
  const fv = viewWithClock(BASE.w, BASE.h, fast, fast.beatLengthSec(0));
  const ovFastHost = makeHost();
  const ovFast = new OverlayLayer({ levelId: 1, expectedAction: (t) => expectedAction(t), keymap: KEYMAP });
  ovFast.init(ovFastHost, fv);
  const fastOff = (() => {
    for (let f = 0; f <= 1320; f += 1) {
      const t = f / 120;
      const s = ovFast.sync({ clock: t, view: fv });
      if (!s.visible && f > 0) return t;
    }
    return null;
  })();
  must(id, '变速不改分步：150BPM 下同样在第 8 拍退场（按拍不按秒）', fastOff != null && Math.abs(fastOff - 8 * fast.beatLengthSec(0)) < 0.02, `150BPM：退场 t=${fmt(fastOff, 4)}s = ${fmt((fastOff || 0) / fast.beatLengthSec(0), 3)} 拍（120BPM 时是 4.0s）`);
  fast.stop();
  clk.stop();

  /* —— ② 几何：与判定线 / 可读窗 / HUD 带 / 时间轴带零交集，且装得下自己的文字 —— */
  for (const vp of VIEWPORTS) {
    const v = buildView(vp.w, vp.h, {});
    const wid = `${vp.w}x${vp.h}`;
    let worstGap = Infinity;
    let allFit = true;
    let minFont = Infinity;
    let maxRowW = 0;
    let maxLines = 0;
    for (let i = 0; i < steps.length; i += 1) {
      const r = panelRect(v, { index: i }, { steps });
      allFit = allFit && r.fits;
      minFont = Math.min(minFont, r.bodyPx, r.headPx);
      maxLines = Math.max(maxLines, r.bodyLines);
      for (const row of r.headRows.concat(r.bodyRows, r.chipRows)) {
        const wPx = textWidthPx(row, r.bodyPx);
        maxRowW = Math.max(maxRowW, wPx);
        worstGap = Math.min(worstGap, r.maxPx - wPx);
      }
      must(id, `${wid}·第${i + 1}步整块面板在 4 拍可读窗右侧（判定线盖不到）`, r.x0 >= r.spawnX && r.spawnX === Math.round(v.rightSpawnX), `x0=${r.x0} ≥ 出生线=${r.spawnX}（判定线 x=${fmt(v.judgeX, 1)}，间距 ${fmt(r.x0 - v.judgeX, 1)}px = ${fmt((r.x0 - v.judgeX) / v.pxPerBeat, 2)} 拍）`);
      must(id, `${wid}·第${i + 1}步不压 HUD 带也不压时间轴带`, r.y0 >= v.zones.worldTop && r.y1 <= v.zones.worldBottom, `y ${r.y0}..${r.y1} ⊂ 世界带 ${fmt(v.zones.hudHeight, 1)}..${fmt(v.zones.worldBottom, 1)}`);
    }
    must(id, `${wid}·面板高度在世界带内（文字不溢出框）`, allFit, '三步的 contentH ≤ 世界带净高');
    must(id, `${wid}·字号 ≥ ${FONT_MIN_PX}px（PERF-05 最小可读）`, minFont >= FONT_MIN_PX, `正文/标题最小 ${minFont}px`);
    must(id, `${wid}·每行估宽 ≤ 换行上限（留 ${Math.round((PANEL.widthSafety - 1) * 100)}% 字体回退余量）`, worstGap > 0, `最宽行 ${fmt(maxRowW, 1)}px，距上限还有 ${fmt(worstGap, 1)}px`);
    must(id, `${wid}·正文行数不超 ${BODY_LINES_MAX} 行`, maxLines <= BODY_LINES_MAX, `最多 ${maxLines} 个逻辑行`);
    must(id, `${wid}·面板整体落在画布内`, panelRect(v, { index: 0 }, { steps }).x1 <= v.width && panelRect(v, { index: 0 }, { steps }).y0 >= 0, `x1=${panelRect(v, { index: 0 }, { steps }).x1} ≤ ${v.width}`);
  }

  /* —— 绘制真相：从假 Graphics 的指令包围盒反查（不是模块自述） —— */
  const v1080 = buildView(BASE.w, BASE.h, {});
  const truthHost = makeHost();
  const truth = new OverlayLayer({ levelId: 1, expectedAction: (t) => expectedAction(t), keymap: KEYMAP });
  truth.init(truthHost, v1080);
  for (let i = 0; i < steps.length; i += 1) {
    truth.sync({ clock: clk.timeAtBeat ? clk.timeAtBeat(0) : 0, beat: REQ_STEP_START_BEATS[i], view: v1080 });
    const box = opsBBox(truthHost.list[0].ops);
    must(id, `第${i + 1}步：所有绘制指令都在出生线右侧`, truth.visible && box.x0 >= Math.round(v1080.rightSpawnX), `${box.n} 条 op，最小 x=${fmt(box.x0, 1)} ≥ 出生线 ${fmt(v1080.rightSpawnX, 1)}（判定线在 ${fmt(v1080.judgeX, 1)}）`);
    must(id, `第${i + 1}步：绘制包围盒不越出世界带`, box.y0 >= v1080.zones.worldTop && box.y1 <= v1080.zones.worldBottom, `y ${fmt(box.y0, 1)}..${fmt(box.y1, 1)} ⊂ ${fmt(v1080.zones.worldTop, 1)}..${fmt(v1080.zones.worldBottom, 1)}`);
    const visTexts = truthHost.texts.filter((t) => t.visible);
    must(id, `第${i + 1}步：文本对象也全在出生线右侧`, visTexts.length >= 3 && visTexts.every((t) => t.x >= Math.round(v1080.rightSpawnX)), `${visTexts.length} 个可见文本，最小 x=${fmt(Math.min(...visTexts.map((t) => t.x)), 1)}`);
    const onscreen = squashAll(visTexts.map((x) => x.text).join(''));
    must(id, `第${i + 1}步：屏幕上的文本就是该步文案（标题 + 至少一行正文）`, onscreen.includes(squashAll(steps[i].head)) && steps[i].lines.some((l) => onscreen.includes(squashAll(l))), onscreen);
  }
  must(id, '浮层只用自己的那一个 Graphics 容器（不借 WorldLayer 的层）', truthHost.list.length === 1 && truthHost.list[0].depth === OVERLAY_DEPTH, `${truthHost.list.length} 个容器，depth=${truthHost.list[0].depth}（WorldLayer 占 0..4）`);
  must(id, '浮层压在最上（否则教学会被障碍/演出盖住）', OVERLAY_DEPTH > 4, `depth ${OVERLAY_DEPTH} > WorldLayer 的 4`);
  truth.shutdown();
  must(id, 'shutdown 释放容器（K-05 不遗留）', truthHost.list.every((g) => g.destroyed) && truthHost.texts.every((t) => t.destroyed) && truth.ready === false, `${truthHost.list.length} graphics + ${truthHost.texts.length} text 全部 destroyed`);

  /* —— ④ 跳过开关 —— */
  const skipHost = makeHost();
  const sk = new OverlayLayer({ levelId: 1, expectedAction: (t) => expectedAction(t), keymap: KEYMAP });
  sk.init(skipHost, baseView);
  sk.sync({ clock: clk.timeAtBeat(3), view: baseView });
  must(id, '跳过前：第 3 拍浮层在（对照，证明 skip 真的改变了东西）', sk.visible === true && sk.snapshot().stepIndex === 1, `visible=${sk.visible} step=${sk.snapshot().stepIndex}`);
  eq(id, 'skip() 返回 true（确实关掉了东西）', sk.skip('key'), true);
  must(id, 'skip() 之后窗口内每个采样点都不再出现', [0, 1, 2, 3, 4, 6, 7.9].every((b) => {
    sk.sync({ clock: clk.timeAtBeat(b), view: baseView });
    return sk.visible === false;
  }), '采样拍 0/1/2/3/4/6/7.9 全部 invisible');
  eq(id, 'skip() 幂等（第二次按不动状态机，也不重复落盘）', sk.skip('key'), false);
  const hide = sk.transitions.filter((t) => t.type === 'hide');
  must(id, 'skip() 记一次 hide，原因写来源（key/pointer），不许冒充自然退场', hide.length === 1 && hide[0].reason === 'key' && hide[0].type === 'hide', JSON.stringify(hide));
  const natural = ov.transitions.filter((t) => t.type === 'hide');
  must(id, '自然退场（到 8 拍）记 window-end，与跳过两条路可区分', natural.length === 1 && natural[0].reason === 'window-end' && Math.abs(natural[0].beat - REQ_TUTORIAL_END_BEAT) <= beatTol, JSON.stringify(natural));
  must(id, '转换流水只记「第几拍」不记秒（T4：拍是唯一时间来源）', ov.transitions.every((t) => Number.isFinite(t.beat) && typeof t.sec === 'undefined' && typeof t.timeSec === 'undefined' && typeof t.ms === 'undefined'), JSON.stringify(ov.transitions.map((t) => `${t.type}@${fmt(t.beat, 2)}`)));
  sk.beginRun({ levelId: 1, skipped: false });
  sk.sync({ clock: clk.timeAtBeat(0.5), view: baseView });
  must(id, '重开（R）后 skipped=false ⇒ 浮层回到第 1 步（T6：本局态不跨局泄漏）', sk.visible === true && sk.snapshot().stepIndex === 0, `visible=${sk.visible} step=${sk.snapshot().stepIndex} transitions=${sk.transitions.length}`);
  sk.beginRun({ levelId: 1, skipped: true });
  const persistedHidden = [0, 1, 2, 4, 6, 7.9].every((b) => {
    sk.sync({ clock: clk.timeAtBeat(b), view: baseView });
    return sk.visible === false;
  });
  must(id, '存档说「已跳过」⇒ 第一次进关的 8 拍里一帧都不出现（PRD P2 不打扰第 2 次）', persistedHidden && sk.transitions.length === 0, `transitions=${JSON.stringify(sk.transitions)} eligible=${sk.eligible()}`);
  sk.beginRun({ levelId: 2, skipped: false });
  const otherLevelHidden = [0, 1, 2, 4, 6, 7.9, 12].every((b) => {
    sk.sync({ clock: clk.timeAtBeat(b), view: baseView });
    return sk.visible === false && sk.eligible() === false;
  });
  must(id, '第 2 关及以后永不出教学（只有 L1）', otherLevelHidden, 'levelId=2 ⇒ eligible=false');
  const sk3 = new OverlayLayer({ levelId: 1, expectedAction: (t) => expectedAction(t), keymap: KEYMAP });
  const hitHost = makeHost();
  sk3.init(hitHost, baseView);
  sk3.sync({ clock: clk.timeAtBeat(5), view: baseView });
  const hitR = sk3.snapshot().rect;
  must(id, '点面板任意处 = 跳过（鼠标通道）', sk3.hitTest((hitR.x0 + hitR.x1) / 2, (hitR.y0 + hitR.y1) / 2) === true, `面板 x ${hitR.x0}..${hitR.x1} y ${hitR.y0}..${hitR.y1}，中心点命中`);
  must(id, '点判定线 / HUD 文字 / 时间轴都不算跳过（误点不毁教学）', sk3.hitTest(baseView.judgeX, baseView.groundY) === false && sk3.hitTest(48, 24) === false && sk3.hitTest(48, baseView.height - 44) === false && sk3.hitTest(baseView.width / 2, baseView.zones.timelineTop + 10) === false, '判定线、(48,24)、左下日志行、时间轴带四处的 hitTest 全 false');
  sk.shutdown();
  sk3.shutdown();

  /* —— 存档字段：加性、老档兼容、版本不动 —— */
  const sv = defaultSave();
  eq(id, '默认档 options.tutorialSkipped = false（新人第一次要教）', sv.options.tutorialSkipped, false);
  eq(id, '老档（没这个字段）补 false ⇒ 读取不抛错（SAV-03）', mergeSave({ options: { strictWindow: true } }).options.tutorialSkipped, false);
  eq(id, '已跳过的档读回来仍是 true ⇒ 跨会话持久', mergeSave({ options: { tutorialSkipped: true } }).options.tutorialSkipped, true);
  eq(id, '加性字段不 bump schema（T5：version 仍是 1）', mergeSave({ version: SAVE_VERSION, options: { tutorialSkipped: true } }).version, 1);
  eq(id, '没有新增存储键（还是那一个键）', SAVE_KEY, 'rhythm-breaker/save');

  /* —— CORE 侧接线：只允许这一条时间来源，且不复用动作键 —— */
  const startBodyOf = (() => {
    const i = runtimeSrc.indexOf('  start() {');
    let depth = 0;
    let started = false;
    for (let j = runtimeSrc.indexOf('{', i); j < runtimeSrc.length; j += 1) {
      if (runtimeSrc[j] === '{') {
        depth += 1;
        started = true;
      }
      if (runtimeSrc[j] === '}') depth -= 1;
      if (started && depth === 0) return runtimeSrc.slice(i, j + 1);
    }
    return '';
  })();
  must(id, '接线：起关/重开同一条 start() 里 beginRun（教学态随本局重置，T6）', startBodyOf.includes('this.overlay.beginRun('), startBodyOf ? 'start() 体内含 beginRun' : 'start() 方法体没找到');
  must(id, '接线：sync 的拍来自 clock.beatAt(nowSec)（不是 scene.time / 挂钟）', /this\.overlay\.sync\(\{[^}]*beat:[^}]*clock\.beatAt\(nowSec\)[^}]*\}\)/.test(runtimeSrc), '帧序里复用同一个 nowSec 取样点');
  must(id, '接线：OverlayLayer 的 expectedAction 由注入给出（浮层不自建动作表）', /new OverlayLayer\(\{[\s\S]{0,240}expectedAction:[\s\S]{0,80}expectedActionFor/.test(runtimeSrc), '构造点把 expectedActionFor 递进去');
  must(id, '接线：跳过键 = KEYMAP.skipTutorial，且与 jump/dash 键无交集（教学期按空格仍是正常跳）', Array.isArray(KEYMAP.skipTutorial) && KEYMAP.skipTutorial.length > 0 && KEYMAP.skipTutorial.every((c) => !KEYMAP.jump.includes(c) && !KEYMAP.dash.includes(c)), `skip=${KEYMAP.skipTutorial.join('/')} jump=${KEYMAP.jump.join('/')} dash=${KEYMAP.dash.join('/')}`);
  must(id, '接线：跳过即落盘 options.tutorialSkipped（唯一写入口）', runtimeSrc.includes('save.options.tutorialSkipped = true'), 'LevelRuntime.skipTutorial 里 updateSave');
  must(id, '接线：shutdown() 里释放浮层（K-05 全释放）', runtimeSrc.includes('this.overlay.shutdown()'), '与 world.shutdown() 同一段');
  must(id, '浮层是纯呈现层：源码不认识判定/存档/音频（不产生事件、不进分母）', !/\bds\b|\bjudge\b|engine|updateSave|localStorage|onJudgment/.test(overlaySrc), 'OverlayLayer.js 里 0 处 ds/judge/engine/save 标识符');

  /* —— ⑤ 静帧：浮层不改障碍几何（同帧两次 WorldLayer 快照逐字段全等） —— */
  const wHost = makeHost();
  const wl = new WorldLayer();
  wl.init(wHost, baseView);
  const probe2 = [inst('kick', 10), inst('bass', 10.5), inst('synth', 11), inst('kick', 12)];
  const tFrame = clk.timeAtBeat(5);
  const pickItems = (s) => JSON.stringify((s.items || []).map((it) => [it.id, it.track, it.x, it.y, it.beatsToJudge, it.state]));
  wl.sync({ clock: tFrame, instances: probe2, view: baseView }, {});
  const geoBefore = pickItems(wl.snapshot(tFrame));
  const opsBefore = wHost.list.map((g) => g.ops.length);
  const wrappedBefore = wl.wraps.size;
  const stateBefore = probe2.map((i) => i.state).join(',');
  const quietHost = makeHost();
  const quiet = new OverlayLayer({ levelId: 1, expectedAction: (t) => expectedAction(t), keymap: KEYMAP });
  quiet.init(quietHost, baseView);
  quiet.sync({ clock: tFrame, view: baseView });
  wl.sync({ clock: tFrame, instances: probe2, view: baseView }, {});
  const geoAfter = pickItems(wl.snapshot(tFrame));
  must(id, '浮层在 / 不在：障碍几何与状态逐字段全等（纯呈现，不参与世界）', geoBefore === geoAfter && wl.wraps.size === wrappedBefore && probe2.map((i) => i.state).join(',') === stateBefore, `items ${probe2.length} 条 x/y/beatsToJudge/state 全等；wraps ${wrappedBefore}→${wl.wraps.size}`);
  must(id, '浮层没往 WorldLayer 的四个容器里画一笔', wHost.list.every((g, i) => g.ops.length === opsBefore[i]), `上层各容器 op 数 ${opsBefore.join('/')} 不变`);
  must(id, '浮层自己确实画了东西（不是靠「不画」冒充不干扰）', quietHost.list[0].ops.length >= 4 && quietHost.texts.filter((t) => t.visible).length >= 3, `浮层本帧 ${quietHost.list[0].ops.length} 条 op / ${quietHost.texts.filter((t) => t.visible).length} 个可见文本`);
  quiet.shutdown();
  wl.shutdown();

  /* —— 🚩「20 拍内首次 PERFECT」的机器侧代理：拿真 L1 谱面量教学窗盖不盖住第一件要按的东西 —— */
  const pg = optional.get('patternGenerator');
  const l1File = path.join(ROOT, 'src', 'data', 'levels', 'level1.json');
  if (!pg || !fs.existsSync(l1File)) {
    skip(id, 'L1 真谱面：教学窗盖住首个核心障碍', pg ? 'level1.json 未交付' : 'PatternGenerator.build 未交付（SOUND）');
  } else {
    const cfg1 = JSON.parse(fs.readFileSync(l1File, 'utf8'));
    const c1 = clockAt(Number(cfg1.bpm) || 110, cfg1.tempoChanges || []);
    c1.init({ bpm: cfg1.bpm, sections: cfg1.sections, tempoChanges: cfg1.tempoChanges, introBeats: cfg1.introBeats, lengthBeats: cfg1.lengthBeats });
    c1.start(0);
    const list = pg.build(cfg1, c1).filter((o) => o.judgable !== false);
    const core = list.filter((o) => o.core !== false);
    const firstAny = list.length ? Math.min(...list.map((o) => o.beat)) : Infinity;
    const firstCore = core.length ? Math.min(...core.map((o) => o.beat)) : Infinity;
    must(id, 'L1 首个可判障碍落在教学窗内（[0,8) 拍 ⇒ 玩家按的时候第 3 步还在屏上）', firstAny < TUTORIAL_END_BEAT, `首个可判 beat=${fmt(firstAny, 2)}，核心 beat=${fmt(firstCore, 2)}，窗口 [0,${TUTORIAL_END_BEAT})`);
    must(id, '第 3 步（讲哪个键按哪个障碍）上线不晚于首个核心障碍', STEP_START_BEATS[STEP_START_BEATS.length - 1] <= firstCore, `第 3 步 @${STEP_START_BEATS[2]} 拍 ≤ 首个核心桩 @${fmt(firstCore, 2)} 拍`);
    must(id, '整个教学窗（含消失拍）压在 20 拍这条人类验收线之内', TUTORIAL_END_BEAT <= REQ_FIRST_PERFECT_BEAT && firstCore <= REQ_FIRST_PERFECT_BEAT, `窗口结束 ${TUTORIAL_END_BEAT} 拍、首个 PERFECT 机会 ${fmt(firstCore, 2)} 拍，均 ≤ ${REQ_FIRST_PERFECT_BEAT} 拍`);
    c1.stop();
  }

  const r0 = panelRect(v1080, { index: 0 }, { steps });
  headline.overlay = `3步@${STEP_START_BEATS.join('/')}拍·${TUTORIAL_END_BEAT}拍退场·x0=${r0.x0}≥出生线${fmt(v1080.rightSpawnX, 0)}（判定线间距${fmt(r0.x0 - v1080.judgeX, 0)}px）·跳过持久化`;
  ovHost.list.forEach((g) => g.destroy());
  ov.shutdown();
  ovFast.shutdown();
  return true;
}

function runSelftest(groupId, payload) {
  const w = payload.world;
  const t = payload.timeline;
  const vp = payload.viewport;
  must(groupId, '负载含 world / timeline / viewport', !!(w && t && vp), `顶层键：${Object.keys(payload).join('/')}`);
  if (!w || !t || !vp) return;
  const wv = w.view || w;
  const dev = Math.abs(wv.judgeX - t.judgeX);
  must(groupId, `浏览器实测上下层判定线偏差 < ${JUDGE_TOL_PX}px`, dev < JUDGE_TOL_PX, `world=${fmt(wv.judgeX, 2)} timeline=${fmt(t.judgeX, 2)} Δ${fmt(dev, 4)}px`);
  near(groupId, '浏览器 pxPerBeat 上下层同值', wv.pxPerBeat, t.pxPerBeat, EXACT_TOL_PX);
  near(groupId, '0.30W 口径（含 DPR 缩放容差 1.5px）', wv.judgeX, VIEW_RATIOS.judgeX * vp.width, 1.5);
  near(groupId, '4 拍窗右界同列（world.rightSpawnX = timeline.windowRightX）', wv.rightSpawnX, t.windowRightX, JUDGE_TOL_PX);
  near(groupId, 'leadPx = 4×pxPerBeat', wv.rightSpawnX - wv.judgeX, 4 * wv.pxPerBeat, 1);
  near(groupId, '时间轴带顶边 = 0.68H', t.band.y, (1 - ZONE_RATIOS.timeline) * vp.height, 1);
  const byId = new Map((w.items || []).map((i) => [i.id, i]));
  let maxPair = 0;
  let pairs = 0;
  for (const mk of t.markerXs || []) {
    const up = byId.get(mk.id);
    if (!up) continue;
    pairs += 1;
    maxPair = Math.max(maxPair, Math.abs(up.x - mk.x));
  }
  if (pairs) must(groupId, `逐实例上下层 x 偏差 < ${JUDGE_TOL_PX}px`, maxPair < JUDGE_TOL_PX, `${pairs} 条比对，最大 Δ${fmt(maxPair, 3)}px`);
  else skip(groupId, '逐实例 x 比对', 'world.items 与 timeline.markerXs 无 id 交集（CORE 需给两层同一批 instances）');
  if (Array.isArray(payload.pixels) && payload.pixels.length >= 2) {
    let min = Infinity;
    for (let i = 0; i < payload.pixels.length; i++) for (let j = i + 1; j < payload.pixels.length; j++) min = Math.min(min, Math.abs(payload.pixels[i].luma - payload.pixels[j].luma));
    must(groupId, '浏览器灰度采样两两差 ≥ 门限', min >= GRAY_CONTRAST_MIN, `最小 Δ${fmt(min, 1)} ≥ ${GRAY_CONTRAST_MIN}`);
  } else skip(groupId, '浏览器灰度采样', '负载未带 pixels[]（需 readPixels 或 canvas 灰度化后取样）');
  must(groupId, '视差层数 ≥ 2', (w.layers || []).length >= BACKGROUND_CFG.minLayers, `${(w.layers || []).length} 层`);
}

/* ═══════════════════════════════════════════════════════════════
 * 8 · 编排
 * ═══════════════════════════════════════════════════════════════ */

function parseArgs() {
  const a = process.argv.slice(2);
  const si = a.indexOf('--selftest');
  const vi = a.indexOf('--view');
  let view = null;
  if (vi >= 0 && a[vi + 1]) {
    const m = /^(\d+)x(\d+)$/i.exec(a[vi + 1]);
    if (m) view = { w: Number(m[1]), h: Number(m[2]) };
  }
  return {
    json: a.includes('--json'),
    verbose: a.includes('--verbose') || a.includes('-v'),
    list: a.includes('--list'),
    help: a.includes('--help') || a.includes('-h'),
    selftest: si >= 0 ? a[si + 1] : null,
    view
  };
}

export async function run(opts = {}) {
  const o = { json: false, verbose: false, list: false, selftest: null, view: null, ...opts };
  mark('loadOptionals');
  await loadOptionals();
  const clock = clockAt(120);
  const view = viewWithClock(BASE.w, BASE.h, clock, 0.5);
  const probe = [inst('kick', 44), inst('bass', 45), inst('synth', 46)];

  const host = makeHost();
  const wl = new WorldLayer();
  wl.init(host, view);
  mark('world init');
  const nowSec = clock.timeAtBeat(42);
  wl.sync({ clock: nowSec, instances: probe, view });
  mark('world sync');
  const worldSnap = wl.snapshot(nowSec);
  const tlSnap = new Timeline().snapshot({ view, nowSec, instances: probe });
  wl.shutdown();
  mark('timeline snapshot');

  checkZones(view);
  mark('zones');
  checkZonesDrawn(view);
  if (o.view) {
    const v2 = buildView(o.view.w, o.view.h, {});
    checkZones(v2);
    record('render:zones', `--view ${o.view.w}x${o.view.h} 已并入`, PASS, `judgeX=${fmt(v2.judgeX, 1)}px pxPerBeat=${fmt(v2.pxPerBeat, 1)}px leadPx=${fmt(v2.leadPx, 1)}px`);
  }
  checkJudgeX(view, worldSnap, tlSnap);
  mark('judgeX');
  checkPxPerBeat(view, worldSnap, tlSnap);
  checkLead4(view);
  mark('lead4');
  checkGrayscale(view);
  mark('grayscale');
  checkPureTime(view, clock);
  mark('obstaclePos');
  checkRealChart();
  mark('chart');

  const scope = walkFiles(path.join(ROOT, 'src', 'game'), (n) => /\.(js|mjs)$/.test(n));
  scope.push(path.join(ROOT, 'src', 'data', 'theme.js'));
  const scanRes = checkScan(scope);
  mark('scan');
  const colorRes = checkColors();
  const cssRes = checkCssTokens();
  mark('colors');
  checkQuality();
  checkBackground(view);
  mark('bg+quality');
  checkPhysics(view);
  mark('physics');

  checkPlatform(optional.get('platform'), view);
  checkBarrage(optional.get('barrage'), view);
  checkPlayer(optional.get('player'), view, clock);
  checkEffectSystem(optional.get('fx'), view);
  mark('optional modules');
  checkCoreIdentity(view, clock);
  mark('core identity');
  checkFxIntegration(view, clock);
  mark('fx same-frame');
  checkGhostLayer(view, clock);
  mark('ghost layer');
  checkOverlay(view);
  mark('tutorial overlay');

  {
    const id = 'render:selftest';
    group(id, '浏览器 ?selftest=render 负载');
    const parsed = parseSelftestArg(o.selftest);
    if (parsed.skip) skip(id, '负载', parsed.skip);
    else if (parsed.error) record(id, '负载解析', FAIL, parsed.error);
    else {
      if (parsed.json.schema && parsed.json.schema !== SELFTEST_SCHEMA) record(id, '负载 schema 版本', FAIL, `收到 ${parsed.json.schema}，期望 ${SELFTEST_SCHEMA}`);
      else must(id, '负载 schema 声明', parsed.json.schema === SELFTEST_SCHEMA, `schema=${parsed.json.schema || '（缺省，按 ' + SELFTEST_SCHEMA + ' 宽松解析）'}`);
      runSelftest(id, parsed.json);
    }
  }
  clock.stop();

  const failed = groups.filter((g) => g.status === FAIL);
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const g of groups) for (const c of g.checks) counts[c.status] += 1;
  const status = failed.length ? 'FAIL' : counts.pass === 0 ? 'SKIP' : 'PASS';

  const detail = [
    `判定线Δ${headline.judgeXDev}px(≤${JUDGE_TOL_PX})`,
    `角色x=${headline.judgeX}=judgeX=0.30W`,
    `4拍=${headline.lead4}`,
    `pxPerBeatΔ${headline.pxSpread}`,
    `灰度 ${headline.gray}`,
    `上下层逐实例Δ${headline.pairDev}px`,
    headline.chart ? `真谱面 ${headline.chart}` : '真谱面 SKIP',
    headline.scan,
    headline.colors,
    `CSS ${headline.cssTokens}`,
    headline.zones ? `分区 ${headline.zones}` : '',
    headline.quality,
    headline.overlay ? `教学浮层 ${headline.overlay}` : '教学浮层未检查',
    `${counts.pass}通过/${counts.fail}失败/${counts.skip}SKIP`
  ]
    .filter(Boolean)
    .join(' ');

  return {
    tool: 'screenshotCheck',
    version: SCREENSHOT_CHECK_VERSION,
    themeVersion: THEME_VERSION,
    schema: SELFTEST_SCHEMA,
    status,
    detail,
    headline,
    counts,
    groups: groups.map((g) => ({ id: g.id, title: g.title, status: g.status, checks: g.checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail, measured: c.measured })) })),
    failures: failed.map((g) => ({ group: g.id, checks: g.checks.filter((c) => c.status === FAIL).map((c) => `${c.name} · ${c.detail}`) })),
    skips: groups.flatMap((g) => g.checks.filter((c) => c.status === SKIP).map((c) => `${g.id}/${c.name}: ${c.detail}`)),
    scan: scanRes,
    colors: colorRes,
    css: cssRes,
    optionalModules: Object.fromEntries([...optional.keys()].map((k) => [k, !!optional.get(k)])),
    candidates: QUALITY_PRESETS,
    zones: { ratios: ZONE_RATIOS, pixels1080: { hud: view.zones.hudHeight, world: view.zones.worldHeight, timeline: view.zones.timelineHeight, timelineTop: view.zones.timelineTop } },
    geometry: { judgeX: view.judgeX, groundY: view.groundY, pxPerBeat: view.pxPerBeat, pxPerSec: view.pxPerSec, leadPx: view.leadPx, spawnX: worldSpawnX(view), worldWindow: worldWindowRect(view) },
    lumaByTrack: LUMA_BY_TRACK,
    markerHexByTrack: Object.fromEntries(TRACKS.map((t) => [t, markerHex(t)]))
  };
}

function print(report, o) {
  const line = (s) => process.stdout.write(`${s}\n`);
  if (o.json) {
    line(JSON.stringify(report, null, o.verbose ? 2 : 1));
  } else {
    line(`screenshotCheck v${SCREENSHOT_CHECK_VERSION} · theme ${report.themeVersion} · 纯函数几何门禁（Node，无浏览器）`);
    for (const g of report.groups) {
      const icon = g.status === 'FAIL' ? '×' : g.checks.every((c) => c.status === 'skip') ? '-' : '·';
      const n = { pass: 0, fail: 0, skip: 0 };
      for (const c of g.checks) n[c.status] += 1;
      line(`${icon} ${g.id.padEnd(18)} ${g.title}  [${n.pass}✓ ${n.fail}× ${n.skip}-]`);
      for (const c of g.checks) {
        if (c.status === PASS && !o.verbose) continue;
        line(`      [${c.status.toUpperCase().padEnd(4)}] ${c.name} — ${c.detail}`);
      }
    }
    for (const s of report.skips) if (!o.verbose) line(`  SKIP ${s}`);
  }
  if (o.list) for (const f of report.failures) line(`FAIL ${f.group}: ${f.checks.join('\n        ')}`);
  line(`RESULT: ${report.status} ${report.detail}`);
}

async function main() {
  const o = parseArgs();
  if (o.help) {
    process.stdout.write(
      '用法：node tools/screenshotCheck.mjs [--json] [--verbose] [--list] [--view WxH] [--selftest <file|inline-json|->]\n' +
        `浏览器负载 schema：${SELFTEST_SCHEMA}（CORE 在 LevelScene 里 ?selftest=render 时回传）\n` +
        '最后一行输出 RESULT: PASS|FAIL|SKIP <细节>（tools/verifyAll.mjs 依赖）\n'
    );
    return;
  }
  const report = await run(o);
  print(report, o);
  process.exitCode = report.status === 'FAIL' ? 1 : 0;
}

if (process.argv[1] && /screenshotCheck\.mjs$/.test(path.resolve(process.argv[1]).replace(/\\/g, '/'))) {
  main().catch((err) => {
    process.stdout.write(`${err && err.stack ? err.stack : ''}\nRESULT: FAIL 工具自身崩溃：${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
