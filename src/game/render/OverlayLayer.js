// src/game/render/OverlayLayer.js — Owner: WORLD（W-13 教学浮层）
// PRD §10「三步上手」+ LVL-04「前 8 拍分步、每步文字 ≤2 行、可关闭且不重复打扰」的唯一实现体。
//
// 三条硬约束（写在这里，不许被后续需求磨掉）：
//  ① **纯呈现层**：不产生判定事件、不进 Perfect 分母、不影响音频、不改关卡数据。
//     它对游戏状态的回写 = 0（跳过状态由 CORE 落到 save.options.tutorialSkipped）。
//  ② **时间只来自 BeatClock**（T4）：本文件不出现场景时钟 / 挂钟 / setTimeout；
//     「现在第几拍」一律走 readNowBeat(frame.clock, view)。浮层的出现 / 换步 / 消失**全是拍的函数**，
//     所以暂停 = 自动冻结、掉帧 = 不脱节、变速关 = 照样按拍走。
//  ③ **不遮挡判定线**：面板左缘钉在 `view.rightSpawnX`（= 判定线 + 4 拍出生线）之右。
//     theme.js 给这一列的注释就是判据：「世界可读区（OBS-03 的 4 拍预告窗）：判定线 → 出生线。
//     **其右侧只画背景**」⇒ 浮层放在这一列，盖不到判定线，也盖不到任何障碍 / 角色 / 大字演出，
//     而且这条性质能在 Node 里被断言（rect.x0 ≥ rightSpawnX），不用人眼确认。
//
// 与 WorldLayer 同纪律：**不 import Phaser**。graphics / text 容器一律由 host 提供（假 host 可跑门禁）。
// 颜色与不透明度只从 theme.js 取（C8 / 纪律 3）：底 = DERIVED.bandHud，框与指向 = COLORS.system，
// 正文 = COLORS.white，次要文字 = DERIVED.ground，alpha 只用 alphaOf() 的既有键（本文件不新增 token）。

import { COLORS, DERIVED, FONT_MIN_PX, alphaOf, isView, resolveView } from '../../data/theme.js';
import { readNowBeat } from '../objects/Obstacle.js';

export const OVERLAY_VERSION = 'R1.0';

/** 只在第 1 关出现（PRD §11 的首次玩家验收线挂在这一关）。用 Number 比，兼容 '1'。 */
export const TUTORIAL_LEVEL_ID = 1;
/** 三步的起始拍（LVL-04「前 8 拍分步」）。第 3 步从第 4 拍起 = L1 首个核心桩到线的同一拍。 */
export const STEP_START_BEATS = Object.freeze([0, 2, 4]);
/** 第 8 拍（含）之后彻底不再画。 */
export const TUTORIAL_END_BEAT = 8;
/** LVL-04：每步正文最多 2 行（标题行是步骤名，不计入正文）。 */
export const BODY_LINES_MAX = 2;

/** 面板几何：只用比例与字号（em），不写死任何具体视口的像素。 */
export const PANEL = Object.freeze({
  edgePadRatio: 0.012, // 到画布右缘 / 世界带上缘的外边距
  insetBeat: 0.25, // 左缘相对出生线再向右内缩（拍）：绝不越进 4 拍预告窗
  innerPadEm: 0.7, // 内边距 = 0.7 个正文字号
  headTier: 'sub', // 标题字号阶
  bodyTier: 'caption', // 正文字号阶（= FONT_MIN_PX 阶）
  headLineRatio: 1.4,
  lineRatio: 1.5, // 行高 = 1.5 字号
  gapEm: 0.5, // 标题 ↔ 正文
  chipGapEm: 0.8, // 正文 ↔ 跳过条
  chipRatio: 1.2, // 跳过条高
  widthSafety: 1.06, // 换行宽度留 6% 余量：字体回退比估算宽时也不越框
  borderWidthRatio: 0.0012, // 描边宽（画布宽比例，下限 1px）
  dotRatio: 0.24, // 步骤点半径
  dotStepEm: 3, // 相邻步骤点的圆心距 = 3r
  arrowRatio: 0.5 // 左指向三角的半高 = 0.5 正文字号
});

/** 画布叠放：WorldLayer 占 0..4，浮层压在最上（5）。 */
export const OVERLAY_DEPTH = 5;

/**
 * 障碍种类 → 教学用名。**形状 + 高度**两条通道进文案，色相只作为数据留在 `hue`。
 * DEF-06：「红 vs 粉」的裸灰度差是 16，低于门禁自己钉的 40（`screenshotCheck.mjs:942` 还把这件事
 * 写成反证断言）。所以颜色**不能**是判别线索——教学若让玩家第一步去分红粉，对设计目标人群等于没教。
 * `hue` 保留给愿意讲的排版层用，但 `buildSteps` 不消费它，门禁里有专门一条断言盯着这件事。
 */
export const SHAPE_LABEL = Object.freeze({
  spike: { shape: '三角', hue: '红' },
  platform: { shape: '横条', hue: '黄' },
  barrage: { shape: '六边形', hue: '粉' }
});
/**
 * 障碍种类 → 高度词。口径是 `Obstacle.trackEnvelope` 的**可达性模式**，不是屏幕 y 排序：
 * kick = ground（贴地）、bass = jump-band（跳跃带内，说「半空」）、synth = dash-only（净空带，站着碰不到，说「头顶」）。
 * ★ 别说成「谁比谁高」：实测 `worldYFor('bass', pitchTier=2)` 的 y 比 synth 还小（高档横条确实盖在网的上方），
 *   排序口径不成立；模式口径成立，门禁 `render:overlay` 里有一条断言按 trackEnvelope 的 mode 钉住这三个词。
 */
export const HEIGHT_LABEL = Object.freeze({ spike: '贴地', platform: '半空', barrage: '头顶' });
/** 形状/高度词表（供门禁扫描「抹掉颜色词后还剩不剩判别线索」）。 */
export const NON_COLOR_CUES = Object.freeze([
  ...Object.values(SHAPE_LABEL).map((v) => v.shape),
  ...Object.values(HEIGHT_LABEL).map((v) => v)
]);
/** 两个动作的词面。键面由注入的 keys 给，动作归属由注入的 expectedAction 给。 */
export const ACTION_WORD = Object.freeze({ jump: '跳', dash: '冲' });

/** Phaser 键码 → 给人看的写法。KEYMAP 仍是键位唯一真相，这里只做排版。 */
const CODE_LABEL = Object.freeze({
  SPACE: '空格',
  ESC: 'Esc',
  ESCAPE: 'Esc',
  ENTER: '回车',
  OPEN_BRACKET: '[',
  CLOSE_BRACKET: ']'
});

export const DEFAULT_KEYS = Object.freeze({ jump: '空格/J', dash: 'K', skip: 'H' });

/**
 * KEYMAP（CORE 的 LevelRuntime 导出）→ 教学文案里的键名。**不另立键位表**，只做字符串排版。
 * @param {{jump?:string[],dash?:string[],skipTutorial?:string[]}} keymap
 */
export function keyLabelsFrom(keymap = {}, fallback = DEFAULT_KEYS) {
  const one = (code) => CODE_LABEL[code] || (typeof code === 'string' && code.length === 1 ? code : '');
  const join = (codes) => (Array.isArray(codes) ? codes.map(one).filter(Boolean).join('/') : '');
  return Object.freeze({
    jump: join(keymap.jump) || fallback.jump,
    dash: join(keymap.dash) || fallback.dash,
    skip: join(keymap.skipTutorial || keymap.skip) || fallback.skip
  });
}

/**
 * 「哪种障碍要哪个动作」的唯一来源是 JudgeSystem.expectedAction —— 由 CORE 注入，WORLD 不复述映射表。
 * 没注入时退成不含形状名的中性文案（宁可少说，不可说错），并如实报 known=false。
 */
export function actionGroupsFor(expectedAction) {
  const known = typeof expectedAction === 'function';
  const jump = [];
  const dash = [];
  if (known) {
    for (const type of Object.keys(SHAPE_LABEL)) {
      let act = 'jump';
      try {
        act = expectedAction(type) === 'dash' ? 'dash' : 'jump';
      } catch {
        act = 'jump'; // 注入方抛错也不能让浮层把话讲错：退回不含形状名的中性文案
      }
      (act === 'dash' ? dash : jump).push(SHAPE_LABEL[type].shape);
    }
  }
  return Object.freeze({
    known,
    jump: known ? jump.join('、') : '要跳的障碍',
    dash: known ? dash.join('、') : '要冲的障碍'
  });
}

/**
 * 三步定稿文案（正文每步 ≤ BODY_LINES_MAX 行）。
 * @param {{expectedAction?:(type:string)=>('jump'|'dash'), keys?:Record<string,string>}} [ctx]
 */
export function buildSteps(ctx = {}) {
  const keys = { ...DEFAULT_KEYS, ...(ctx.keys || {}) };
  const g = actionGroupsFor(ctx.expectedAction);
  const raw = [
    {
      id: 'read',
      head: '① 方块向左流',
      lines: ['先看着，这一步不用按', '三角贴地 · 横条半空 · 六边形头顶']
    },
    {
      id: 'wait',
      head: '② 等它压住竖线',
      lines: ['左侧竖线 = 判定线', `压住那一刻按 ${keys.jump} 才 PERFECT`]
    },
    {
      id: 'act',
      head: '③ 到线就按',
      lines: [`${g.jump}要${ACTION_WORD.jump}：按 ${keys.jump}`, `${g.dash}要${ACTION_WORD.dash}：按 ${keys.dash}`]
    }
  ];
  return Object.freeze(
    raw.map((s, i) =>
      Object.freeze({
        index: i,
        id: s.id,
        head: s.head,
        lines: Object.freeze(s.lines.slice(0, BODY_LINES_MAX)),
        startBeat: STEP_START_BEATS[i],
        endBeat: i + 1 < STEP_START_BEATS.length ? STEP_START_BEATS[i + 1] : TUTORIAL_END_BEAT,
        actionsKnown: i !== 2 || g.known
      })
    )
  );
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const numOf = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * 步界容差（拍）：BeatClock / MockClock 的拍号是分段积分出来的，`timeAtBeat(4)` 再 `beatAt()` 回来
 * 会得到 3.9999992 这类 **1e-7 级**残差。不给容差的话，「第 4 拍换第 3 步」会在真机上晚一帧多才发生，
 * 而那正是首个核心桩到线的时刻——教学晚一帧，玩家就按错了。
 * ★ 容差只能贴着残差的量级取：早先用 1e-3 拍，结果 `1.9999` 也被当成第 2 拍，
 *   第 2 步**提前 0.1 拍**（120BPM 下 ≈58ms，一整个判定窗的一半）就翻出来了。
 *   门禁的拍→步表把这件事抓成 FAIL（`screenshotCheck.mjs:1970`），改回 1e-6 拍 ≈0.008ms，
 *   既吃掉积分残差，又不会把「还没到拍」误判成「到了」。
 */
export const STEP_EPS_BEAT = 1e-6;

/**
 * 拍 → 当前步骤（**纯函数**：同一个拍永远得到同一步，这就是「按拍推进」的可断言形式）。
 * 第 8 拍（含）之后返回 null；负拍（起关预延迟里）返回第 1 步，浮层从第一帧就在读谱区右侧等着。
 */
export function stepForBeat(beat, opts = {}) {
  const b = Number(beat);
  const end = numOf(opts.endBeat, TUTORIAL_END_BEAT);
  const eps = numOf(opts.eps, STEP_EPS_BEAT);
  const starts = Array.isArray(opts.startBeats) && opts.startBeats.length ? opts.startBeats : STEP_START_BEATS;
  if (!Number.isFinite(b) || b >= end - eps) return null;
  let idx = 0;
  for (let i = 0; i < starts.length; i += 1) if (b >= starts[i] - eps) idx = i;
  const from = starts[idx];
  const to = idx + 1 < starts.length ? starts[idx + 1] : end;
  const span = to - from > 0 ? to - from : 1;
  return Object.freeze({ index: idx, startBeat: from, endBeat: to, beat: b, k: clamp01((b - from) / span) });
}

/** 一个字符占几个 em：CJK 全角 1，ASCII 0.55（等宽字体里的拉丁字母）。 */
export function charEm(ch) {
  return ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55;
}

/** 文本估宽（px）。 */
export function textWidthPx(text, px) {
  const s = String(text == null ? '' : text);
  let em = 0;
  for (const ch of s) em += charEm(ch);
  return em * px;
}

/** 切成「ASCII 词 / CJK 单字 / 单个符号」三类 token：ASCII 词不拆断（PERFECT 不许折成 PERFE/CT）。 */
export function tokenize(text) {
  return String(text == null ? '' : text).match(/[A-Za-z0-9/％%.,;:_+\-()]+|[^\s\0-\x7f]|\S/g) || [];
}

/**
 * 按宽度换行（纯函数；面板高度由它算出来，所以「文字不会溢出框」是可断言的）。
 * @returns {string[]} 视觉行
 */
export function wrapRows(text, maxPx, px) {
  const limit = Math.max(px, numOf(maxPx, px * 4));
  const out = [];
  let line = '';
  for (const tok of tokenize(text)) {
    const cand = line + (tok === ' ' && !line ? '' : tok);
    if (line && textWidthPx(cand, px) > limit) {
      out.push(line);
      line = tok.trim() === '' ? '' : tok;
    } else {
      line = cand;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/* ------------------------------------------------------------------ 排版 */

/** view → 槽位尺寸（只与视口有关，与第几步无关）。每帧查一次表，不重复分配。 */
const METRICS_CACHE = new Map();
const METRICS_CACHE_MAX = 24;

function metricsOf(v) {
  const bodyPx = Math.max(FONT_MIN_PX, numOf(v.fontPx && v.fontPx[PANEL.bodyTier], FONT_MIN_PX));
  const headPx = Math.max(bodyPx, numOf(v.fontPx && v.fontPx[PANEL.headTier], bodyPx));
  const edge = Math.round(Math.max(6, v.width * PANEL.edgePadRatio));
  const inset = Math.round(Math.max(6, v.pxPerBeat * PANEL.insetBeat));
  const spawnX = Math.round(numOf(v.rightSpawnX, numOf(v.worldWindow && v.worldWindow.x1, v.judgeX + v.pxPerBeat * numOf(v.leadBeats, 4))));
  const inner = Math.round(bodyPx * PANEL.innerPadEm);
  const x0 = Math.round(spawnX + inset);
  const x1 = Math.round(v.width - edge);
  const y0 = Math.round(v.zones.worldTop + edge);
  const bodyW = Math.max(bodyPx * 4, x1 - x0 - inner * 2);
  return {
    bodyPx,
    headPx,
    edge,
    inset,
    spawnX,
    inner,
    x0,
    x1,
    y0,
    bodyW,
    maxPx: bodyW / PANEL.widthSafety,
    lineH: Math.round(bodyPx * PANEL.lineRatio),
    headH: Math.round(headPx * PANEL.headLineRatio),
    gap: Math.round(bodyPx * PANEL.gapEm),
    chipGap: Math.round(bodyPx * PANEL.chipGapEm),
    chipH: Math.round(bodyPx * PANEL.chipRatio),
    dotR: Math.max(2, bodyPx * PANEL.dotRatio),
    bottomLimit: Math.round(v.zones.worldBottom - edge),
    judgeLineX: Math.round(v.judgeX)
  };
}

/** 视口 → 面板槽位尺寸（缓存：每帧调用不重复分配）。 */
export function metricsFor(view) {
  const v = isView(view) ? view : resolveView(view || {});
  const key = `${Math.round(v.width)}x${Math.round(v.height)}|${v.fontPx ? v.fontPx[PANEL.bodyTier] : '?'}|${Math.round(v.pxPerBeat)}`;
  let m = METRICS_CACHE.get(key);
  if (!m) {
    m = metricsOf(v);
    if (METRICS_CACHE.size >= METRICS_CACHE_MAX) METRICS_CACHE.clear();
    METRICS_CACHE.set(key, m);
  }
  return m;
}

/** 跳过条的文字：键盘写法来自注入的 keyLabels（KEYMAP 是唯一键位真相）。 */
export function chipTextFor(keys) {
  const k = { ...DEFAULT_KEYS, ...(keys || {}) };
  return `跳过教学 · 按 ${k.skip}`;
}

function rowsOf(m, step, chip) {
  const headRows = wrapRows(step.head, m.maxPx, m.headPx);
  const bodyRows = [];
  for (const ln of step.lines) bodyRows.push(...wrapRows(ln, m.maxPx, m.bodyPx));
  return { headRows, bodyRows, chipRows: wrapRows(chip, m.maxPx, m.bodyPx) };
}

/**
 * 这一步在给定 view 下的完整排版：行数组 + 面板框。
 * 面板高 = 内边距 + 标题行 + 正文行 + 跳过条行，**三处都用同一个换行函数**，
 * 于是「文字不会溢出框 / 框不会盖到判定线」是可断言的性质，而不是画完再看一眼。
 */
export function stepLayoutOf(view, step = null, opts = {}) {
  const v = isView(view) ? view : resolveView(view || {});
  const steps = Array.isArray(opts.steps) && opts.steps.length ? opts.steps : buildSteps(opts);
  const m = metricsFor(v);
  const chip = typeof opts.chipText === 'string' && opts.chipText ? opts.chipText : chipTextFor(opts.keys);
  const idx = Math.max(0, Math.min(steps.length - 1, numOf(step && step.index, 0)));
  const one = steps[idx];
  const laid = rowsOf(m, one, chip);
  const contentH =
    m.inner +
    laid.headRows.length * m.headH +
    m.gap +
    laid.bodyRows.length * m.lineH +
    m.chipGap +
    laid.chipRows.length * m.lineH +
    m.inner;
  const y1 = Math.round(m.y0 + contentH);
  return {
    index: idx,
    step: one,
    headRows: laid.headRows,
    bodyRows: laid.bodyRows,
    chipRows: laid.chipRows,
    chipText: chip,
    rows: laid.headRows.length + laid.bodyRows.length + laid.chipRows.length,
    bodyLines: one.lines.length,
    x0: m.x0,
    y0: m.y0,
    x1: m.x1,
    y1,
    w: m.x1 - m.x0,
    h: contentH,
    contentH,
    fits: contentH <= m.bottomLimit - m.y0,
    bottomLimit: m.bottomLimit,
    inner: m.inner,
    edge: m.edge,
    inset: m.inset,
    spawnX: m.spawnX,
    bodyPx: m.bodyPx,
    headPx: m.headPx,
    lineH: m.lineH,
    headH: m.headH,
    gap: m.gap,
    chipGap: m.chipGap,
    chipH: m.chipH,
    dotR: m.dotR,
    bodyW: m.bodyW,
    maxPx: m.maxPx,
    judgeLineX: m.judgeLineX,
    headY: Math.round(m.y0 + m.inner + laid.headRows.length * m.headH * 0.5),
    bodyTop: Math.round(m.y0 + m.inner + laid.headRows.length * m.headH + m.gap),
    chipTop: Math.round(m.y0 + m.inner + laid.headRows.length * m.headH + m.gap + laid.bodyRows.length * m.lineH + m.chipGap)
  };
}

/** 面板外框 + 槽位（门禁 / DebugPanel 的读取口，与 stepLayoutOf 同值）。 */
export function panelRect(view, step = null, opts = {}) {
  return stepLayoutOf(view, step, opts);
}

/** 跳过条的绘制槽。 */
export function chipRect(view, step = null, opts = {}) {
  const r = stepLayoutOf(view, step, opts);
  return { x0: r.x0 + r.inner, y0: r.chipTop, x1: r.x1 - r.inner, y1: r.chipTop + r.chipRows.length * r.lineH, w: r.w - r.inner * 2, h: r.chipRows.length * r.lineH };
}

/** 点击即跳过的命中区 = **整块面板**（教学期玩家手忙脚乱，别让人瞄一条小横幅）。 */
export function hitRect(view, step = null, opts = {}) {
  const r = stepLayoutOf(view, step, opts);
  return { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, w: r.w, h: r.h };
}

/** 点在不在这一步的浮层上。 */
export function pointInRect(x, y, rect) {
  const n = Number(x);
  const p = Number(y);
  if (!rect || !Number.isFinite(n) || !Number.isFinite(p)) return false;
  return n >= rect.x0 && n <= rect.x1 && p >= rect.y0 && p <= rect.y1;
}

export class OverlayLayer {
  /**
   * @param {{levelId?:number|string, skipped?:boolean, expectedAction?:(t:string)=>('jump'|'dash'),
   *          keys?:Record<string,string>, keymap?:object, depth?:number, endBeat?:number,
   *          steps?:object[], host?:object, view?:object}} [opts]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.host = null;
    this.view = isView(opts.view) ? opts.view : resolveView(opts.view || {});
    this.g = null;
    this.headLabel = null;
    this.bodyLabels = [];
    this.chipLabel = null;
    this.ready = false;
    this.depth = numOf(opts.depth, OVERLAY_DEPTH);
    this.levelId = opts.levelId == null ? TUTORIAL_LEVEL_ID : opts.levelId;
    this.keys = opts.keymap ? keyLabelsFrom(opts.keymap, opts.keys || DEFAULT_KEYS) : { ...DEFAULT_KEYS, ...(opts.keys || {}) };
    this.steps = Array.isArray(opts.steps) && opts.steps.length ? opts.steps : buildSteps({ expectedAction: opts.expectedAction, keys: this.keys });
    this.endBeat = numOf(opts.endBeat, TUTORIAL_END_BEAT);
    this.skipped = !!opts.skipped;
    this.chipText = chipTextFor(this.keys);
    this.plate = null;
    this.step = null;
    this.visible = false;
    this.beat = 0;
    /** 转换流水：只记「第几拍发生了什么」。拍是唯一时间来源，不给时序留第二条真相。 */
    this.transitions = [];
    this.syncs = 0;
  }

  /** 该不该给这一关做教学：只有第 1 关 + 没被跳过。 */
  eligible() {
    return Number(this.levelId) === TUTORIAL_LEVEL_ID && !this.skipped;
  }

  /** host = Phaser scene（或门禁里的假 host）：只需要 add.graphics / add.text。 */
  init(host, view) {
    if (!host || !host.add || typeof host.add.graphics !== 'function') throw new Error('[OverlayLayer] init(host): host.add.graphics 必需');
    if (this.ready) return this;
    this.host = host;
    if (view) this.setView(view);
    this.g = host.add.graphics();
    if (this.g.setDepth) this.g.setDepth(this.depth);
    this.headLabel = this._makeLabel('head');
    this.chipLabel = this._makeLabel('chip');
    this.ready = true;
    return this;
  }

  /**
   * 每一起关 / 每一次重开（R）都走这里：本局显示态清零，跳过态由 CORE 从存档重新给。
   * T6：重开与首次是同一条 start()，这里不留任何跨局残值（除持久化的 skipped）。
   */
  beginRun(ctx = {}) {
    if (typeof ctx.levelId !== 'undefined') this.levelId = ctx.levelId;
    this.skipped = !!ctx.skipped;
    this.step = null;
    this.plate = null;
    this.visible = false;
    this.beat = 0;
    this.transitions = [];
    this.syncs = 0;
    this._clear();
    return this;
  }

  /** view 归一（幂等）：resize 只换几何，不带任何时间态。 */
  setView(view) {
    if (!view) return this.view;
    this.view = isView(view) ? view : resolveView(view);
    return this.view;
  }

  /**
   * 每帧一次。入参只有 **clock（或调用方用同一帧的 clock.now() 换算好的 beat）+ view**，
   * 本方法不读任何别的时间源（T4）。frame.beat 优先：那是 LevelRuntime 一帧只取一次的取样点。
   * @param {{clock?:object|number, view?:object, beat?:number}} frame
   */
  sync(frame = {}) {
    if (!this.ready) throw new Error('[OverlayLayer] sync() 之前必须先 init(host, view)');
    const view = frame.view ? this.setView(frame.view) : this.view;
    let beat;
    if (frame.beat != null && Number.isFinite(Number(frame.beat))) beat = Number(frame.beat);
    else if (frame.clock != null) beat = readNowBeat(frame.clock, view);
    else throw new Error('[OverlayLayer] sync(frame): clock 或 beat 至少给一个（T4：第几拍只能问 BeatClock）');
    this.beat = beat;
    this.syncs += 1;
    const next = this.eligible() ? stepForBeat(beat, { endBeat: this.endBeat, startBeats: this.steps.map((s) => s.startBeat) }) : null;
    this._apply(next, beat);
    return this.snapshot();
  }

  /** 换步 / 显隐的落地（含转换流水记账）。 */
  _apply(next, beat) {
    const wasVisible = this.visible;
    const wasIndex = this.step ? this.step.index : null;
    if (!next) {
      if (wasVisible) this.transitions.push({ type: 'hide', beat, reason: this.skipped ? 'skipped' : 'window-end' });
      this.visible = false;
      this.step = null;
      this._clear();
      return;
    }
    this.step = next;
    this.visible = true;
    if (!wasVisible) this.transitions.push({ type: 'show', beat, index: next.index });
    else if (wasIndex !== next.index) this.transitions.push({ type: 'step', beat, index: next.index });
    this._draw();
  }

  /** 关闭本浮层（按 skip 键 / 点面板）。返回是否真的关掉了东西。 */
  skip(reason = 'manual') {
    if (this.skipped && !this.visible) return false;
    const wasVisible = this.visible;
    this.skipped = true;
    if (wasVisible) this.transitions.push({ type: 'hide', beat: this.beat, reason: reason === 'manual' ? 'skipped' : String(reason) });
    this.visible = false;
    this.step = null;
    this._clear();
    return wasVisible;
  }

  /** 只读快照（selftest / DebugPanel / 门禁）。已冻结字段只追加不改语义（T5）。 */
  snapshot() {
    const r = this.plate;
    const s = this.step && this.steps[this.step.index] ? this.steps[this.step.index] : null;
    return {
      version: OVERLAY_VERSION,
      levelId: this.levelId,
      tutorialLevel: TUTORIAL_LEVEL_ID,
      eligible: this.eligible(),
      skipped: this.skipped,
      visible: this.visible,
      stepIndex: this.step ? this.step.index : null,
      stepId: s ? s.id : null,
      beat: this.beat,
      endBeat: this.endBeat,
      stepStartBeats: this.steps.map((x) => x.startBeat),
      head: s ? s.head : '',
      lines: s ? s.lines.slice() : [],
      rows: r ? r.rows : 0,
      bodyLinesMax: BODY_LINES_MAX,
      actionsKnown: s ? !!s.actionsKnown : null,
      rect: r
        ? {
            x0: r.x0,
            y0: r.y0,
            x1: r.x1,
            y1: r.y1,
            w: r.w,
            h: r.h,
            fits: r.fits,
            spawnX: r.spawnX,
            bottomLimit: r.bottomLimit,
            bodyPx: r.bodyPx,
            headPx: r.headPx,
            rows: r.rows
          }
        : null,
      judgeLineSafe: r ? r.x0 >= r.spawnX : null,
      transitions: this.transitions.slice(),
      syncs: this.syncs
    };
  }

  /** 点在浮层上吗（CORE 的 pointerdown 用它决定是否跳过）。 */
  hitTest(x, y) {
    if (!this.visible || !this.plate) return false;
    return pointInRect(x, y, this.plate);
  }

  shutdown() {
    for (const t of this.bodyLabels) if (t && typeof t.destroy === 'function') t.destroy();
    this.bodyLabels = [];
    for (const key of ['headLabel', 'chipLabel']) {
      const t = this[key];
      if (t && typeof t.destroy === 'function') t.destroy();
      this[key] = null;
    }
    if (this.g) {
      if (typeof this.g.clear === 'function') this.g.clear();
      if (typeof this.g.destroy === 'function') this.g.destroy();
      this.g = null;
    }
    this.host = null;
    this.ready = false;
    this.visible = false;
    this.step = null;
    this.plate = null;
    return this;
  }

  // ------------------------------------------------------------------ 私有

  _makeLabel(role) {
    if (!this.host || !this.host.add || typeof this.host.add.text !== 'function') return null;
    const r = this.plate || stepLayoutOf(this.view, this.step, { steps: this.steps, chipText: this.chipText });
    const px = role === 'head' ? r.headPx : r.bodyPx;
    const color = role === 'chip' ? DERIVED.ground.hex : COLORS.white.hex;
    const t = this.host.add.text(r.x0 + r.inner, r.y0, '', {
      fontFamily: this.view.fontFamily,
      fontSize: `${Math.round(px)}px`,
      color,
      align: 'left',
      wordWrap: { width: Math.round(r.bodyW), useAdvancedWrap: true }
    });
    if (typeof t.setOrigin === 'function') t.setOrigin(0, role === 'head' || role === 'chip' ? 0.5 : 0);
    if (typeof t.setVisible === 'function') t.setVisible(false);
    if (t.setDepth) t.setDepth(this.depth);
    t.__role = role;
    t.__px = px;
    return t;
  }

  _bodyLabel(i) {
    if (!this.host || !this.host.add || typeof this.host.add.text !== 'function') return null;
    let t = this.bodyLabels[i];
    if (!t) {
      t = this._makeLabel('body');
      if (!t) return null;
      this.bodyLabels[i] = t;
    }
    return t;
  }

  _put(t, text, x, y, px, alpha) {
    if (!t) return;
    if (typeof t.setText === 'function') t.setText(String(text == null ? '' : text));
    if (typeof t.setPosition === 'function') t.setPosition(x, y);
    if (typeof t.setFontSize === 'function' && t.__px !== px) {
      t.setFontSize(`${Math.round(px)}px`);
      t.__px = px;
    }
    if (typeof t.setAlpha === 'function') t.setAlpha(alpha);
    if (typeof t.setVisible === 'function') t.setVisible(true);
  }

  _hide(t) {
    if (!t) return;
    if (typeof t.setText === 'function') t.setText('');
    if (typeof t.setVisible === 'function') t.setVisible(false);
  }

  _clear() {
    if (this.g && typeof this.g.clear === 'function') this.g.clear();
    this._hide(this.headLabel);
    this._hide(this.chipLabel);
    for (const t of this.bodyLabels) this._hide(t);
  }

  _draw() {
    const r = stepLayoutOf(this.view, this.step, { steps: this.steps, chipText: this.chipText });
    this.plate = r;
    const g = this.g;
    const v = this.view;
    if (g && typeof g.clear === 'function') g.clear();

    if (g) {
      // 底 + 框：alpha 只用 ALPHA 既有键（纪律 3：分层靠 alpha，不新增颜色）
      if (typeof g.fillStyle === 'function') g.fillStyle(DERIVED.bandHud.int, alphaOf('bandHud'));
      if (typeof g.fillRect === 'function') g.fillRect(r.x0, r.y0, r.w, r.h);
      if (typeof g.lineStyle === 'function') g.lineStyle(Math.max(1, v.width * PANEL.borderWidthRatio), COLORS.system.int, alphaOf('coreEdge'));
      if (typeof g.strokeRect === 'function') g.strokeRect(r.x0, r.y0, r.w, r.h);
      // 左缘指向判定线的箭头：整只三角都在 x0 右侧，一像素也不越进可读区
      const aw = Math.max(4, r.bodyPx * PANEL.arrowRatio);
      const ay = Math.round(r.y0 + r.h * 0.5);
      if (typeof g.fillStyle === 'function') g.fillStyle(COLORS.system.int, alphaOf('judgeLine'));
      if (typeof g.fillPoints === 'function') {
        g.fillPoints(
          [
            { x: r.x0 + aw, y: ay - aw },
            { x: r.x0 + aw, y: ay + aw },
            { x: r.x0 + 1, y: ay }
          ],
          true
        );
      }
      // 三步进度点（第 1..index 步点亮）：画在标题行右侧，不额外占高
      const dotY = r.headY;
      for (let i = 0; i < this.steps.length; i += 1) {
        const cx = Math.round(r.x1 - r.inner - r.dotR - (this.steps.length - 1 - i) * r.dotR * PANEL.dotStepEm);
        const on = i <= r.index;
        if (typeof g.fillStyle === 'function') g.fillStyle(on ? COLORS.system.int : DERIVED.beatTick.int, alphaOf(on ? 'coreEdge' : 'spawnLine'));
        if (typeof g.fillCircle === 'function') g.fillCircle(cx, dotY, r.dotR);
      }
      // 跳过条上方的分隔线
      const sepY = Math.round(r.chipTop - r.chipGap * 0.45);
      if (typeof g.lineStyle === 'function') g.lineStyle(Math.max(1, v.width * PANEL.borderWidthRatio), DERIVED.divider.int, alphaOf('divider'));
      if (typeof g.lineBetween === 'function') g.lineBetween(r.x0 + r.inner, sepY, r.x1 - r.inner, sepY);
    }

    this._put(this.headLabel, r.headRows.join('\n'), r.x0 + r.inner, r.headY, r.headPx, alphaOf('coreEdge'));
    for (let i = 0; i < r.bodyRows.length; i += 1) {
      this._put(this._bodyLabel(i), r.bodyRows[i], r.x0 + r.inner, r.bodyTop + i * r.lineH, r.bodyPx, alphaOf('bandHud'));
    }
    for (let i = r.bodyRows.length; i < this.bodyLabels.length; i += 1) this._hide(this.bodyLabels[i]);
    this._put(this.chipLabel, r.chipText, r.x0 + r.inner, r.chipTop + Math.round((r.chipRows.length * r.lineH) * 0.5), r.bodyPx, alphaOf('bandHud'));
  }
}

export default OverlayLayer;
