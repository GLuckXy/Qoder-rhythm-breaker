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
  DEFAULT_QUALITY,
  DEGRADE_ORDER,
  DERIVED,
  FONT_MIN_PX,
  FONT_TIERS,
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
  isBeatsVisible,
  laneY,
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

function makeHost() {
  const list = [];
  return {
    list,
    add: {
      graphics: () => {
        const g = new RecordingGraphics(`g${list.length}`);
        list.push(g);
        return g;
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
 * 7 · 浏览器 selftest 负载
 * ═══════════════════════════════════════════════════════════════ */

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
