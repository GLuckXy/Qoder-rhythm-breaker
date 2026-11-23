// src/game/render/HudLayer.js — Owner: WORLD（W-14 / UI-04 / DIS-09 / VIS-02「HUD 上 8%」）
// 游戏内实况 HUD：**左上连击 + 右上三声部耐久 ×3 + 顶部 8% 高度带**。
//
// 三个方法就是全部接口（与 Background/WorldLayer/OverlayLayer 同一形状，方便 Node 门闸直接 drive）：
//   const hud = new HudLayer();
//   hud.init(scene, view);                 // scene.create() 里一次（scene 要有 add.graphics()/add.text()）
//   hud.sync({ view, combo, hpByTrack, hpMaxByTrack, disassembledTracks, a11y });   // 每帧一次，纯函数
//   hud.shutdown();                        // 统一 teardown（K-05）
//
// 纪律（逐条对应 CONTRACTS，破哪条都会让门闸变绿为红）：
// 1. **不 import Phaser**：容器由 host.add.graphics()/add.text() 提供，本文件只调它的方法（全部特性检测）。
// 2. **几何唯一口径 = theme.hudLayout(view)**：本文件不出现任何像素常量、不自算分区、不读存档、不读时钟。
//    band 高度恒等于 view.zones.hudHeight = 8%·H（VIS-02），每个矩形都在带内 ⇒ 判定线净空
//    = view.zones.worldHeight × BACKGROUND_CFG.judgeLineTopRatio（1080p=51.84px）恒 > 0。
// 3. **颜色只在 theme 里**：COLORS / DERIVED / TRACK_COLOR / HUD_CFG.gold，alpha 一律 alphaOf(已登记键)。
//    金边不新增色相（bass→white 35%），也不进 cssTokens()（否则 neon.css 必须加 token = 越界改 CORE 文件）。
// 4. **T4 时间**：本层连 nowSec 都不收。连击金边 = 「combo ≥ 10」这一**状态**的纯函数，
//    不是按秒/按拍推进的动画 ⇒ 结构上不可能逐帧脉冲（PERF-05③ reduceFlash 见第 5 条）。
// 5. **reduceFlash**：HUD 无位移/无抖动/无积分（前四项天然为真），唯一的视觉增量 = 金边；
//    reduceFlash 时撤掉外层辉光（那一圈才是「闪」），保留描边与金数字（那是**信息**，撤了就漏读连击档位）。
// 6. **纯表现**：判定/调度路径不读这里的任何东西；HUD 也不回写任何状态。DIS-09 的「不影响判定」由此成立。
//
// 数据源只有 CORE 一个（T2/T5）：combo = ds.counts().combo、hp = ds.hpByTrack()、hpMax = ds.hpMax(t)、
// 已拆解 = ds.disassembledTracks()。本文件不维护第二套连击/耐久真相。

import {
  a11yOf,
  alphaOf,
  buildView,
  COLORS,
  DERIVED,
  FX_TIMING,
  HUD_CFG,
  hudLayout,
  isView,
  resolveView,
  TRACK_COLOR,
  TRACKS,
  VOICE_NAME
} from '../../data/theme.js';

export const HUD_VERSION = 'hud/v1';
/** 叠放次序：bg0 / obstacles1 / player2 / fx3 / bigText4 / overlay5 ⇒ HUD 必须在最上（带内不与浮层抢位） */
export const HUD_DEPTH = 6;
/** UI-04 文案：题注与「已拆解」标记。后者复用 FX_TIMING 的既有文案口径（同一事件同一个词，不自造） */
export const COMBO_CAPTION = 'COMBO';
export const DISASSEMBLED_WORD = FX_TIMING.wordDisassemble;
/** 连击数字最多占几位（超过就只显示后 4 位宽，不越带） */
const MAX_DIGITS = HUD_CFG.numeralMaxDigits;
/** 像素两位小数：与 theme 的 r2 同口径（断言可比对） */
const r2 = (n) => Math.round(n * 100) / 100;

/** 连击是否进入金边档（DIS-09：≥10）。**判定路径永不调用本函数**（纯表现）。 */
export function comboGold(combo) {
  const n = Number(combo);
  return Number.isFinite(n) && n >= HUD_CFG.goldComboMin;
}

/** 连击数字的显示串（纯函数，门闸可直接断言；不做补零/不做千分位，HUD 只读数） */
export function comboText(combo) {
  const n = Number(combo);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return String(Math.floor(n)).slice(-MAX_DIGITS);
}

/**
 * snapshot → 本层可直接消费的形状（全部来自 CORE 的 DisassembleSystem 读数，零自算真相）。
 * @param {{view?:object, combo?:number, hpByTrack?:Record<string,number>,
 *          hpMaxByTrack?:Record<string,number>, disassembledTracks?:string[], a11y?:object}} [snapshot]
 */
export function hudModel(snapshot = {}) {
  const combo = Math.max(0, Number(snapshot.combo) || 0);
  const hp = snapshot.hpByTrack || {};
  const hpMax = snapshot.hpMaxByTrack || {};
  const disList = Array.isArray(snapshot.disassembledTracks) ? snapshot.disassembledTracks : [];
  const dis = new Set(disList);
  return {
    combo,
    gold: comboGold(combo),
    tracks: TRACKS.map((track) => {
      const max = Math.max(0, Math.round(Number(hpMax[track]) || 0));
      const now = Math.max(0, Math.min(max, Math.round(Number(hp[track]) || 0)));
      // 「已拆解」= 配置过（hpMax>0）且打空了（hp=0）；CORE 的 disassembledTracks 若给了就优先采信
      const dead = max > 0 && now === 0;
      return { track, name: VOICE_NAME[track], hp: now, hpMax: max, disassembled: dis.size ? dis.has(track) : dead, inactive: max === 0 };
    })
  };
}

function countOps(g) {
  return g && Array.isArray(g.ops) ? g.ops.length : 0;
}

function textsOf(list) {
  const out = [];
  for (const t of list) if (t && t.visible !== false) out.push({ text: String(t.text == null ? '' : t.text), x: t.x, y: t.y });
  return out;
}

export class HudLayer {
  constructor(opts = {}) {
    this.opts = opts;
    this.host = null;
    this.view = buildView(1920, 1080, {});
    this.layout = null;
    this.g = { band: null, rows: null };
    this.texts = { numeral: null, caption: null, labels: [], marks: [] };
    this.model = hudModel({});
    this.stats = { frames: 0, bandOps: 0, rowsOps: 0, numeralText: '0', gold: false };
    this.ready = false;
  }

  /** @param {{add:{graphics:()=>object, text?:Function}}} host scene（或门闸的假 host） */
  init(host, viewOrOpts = {}) {
    this.host = host;
    const view = isView(viewOrOpts) || viewOrOpts?.width != null || viewOrOpts?.w != null ? resolveView(viewOrOpts) : this.view;
    this.layout = hudLayout(view);
    this.view = view;
    const add = host && host.add;
    if (!add || typeof add.graphics !== 'function') {
      this.stats.missingHost = true;
      return this;
    }
    this.g.band = add.graphics();
    this.g.rows = add.graphics();
    for (const gfx of [this.g.band, this.g.rows]) if (gfx && typeof gfx.setDepth === 'function') gfx.setDepth(HUD_DEPTH);
    // 文本：连击数字 + 题注 + 三行声部名 + 三个「已拆解」标记 = 8 个常驻对象（只改值/可见性，不再增删）
    const t = this.texts;
    if (typeof add.text === 'function') {
      const font = (px, colorKey) => ({
        fontFamily: view.fontFamily,
        fontSize: `${Math.round(px)}px`,
        color: colorKey
      });
      t.numeral = add.text(0, 0, '0', font(this.layout.fonts.numeral, COLORS.system.hex));
      t.caption = add.text(0, 0, COMBO_CAPTION, font(this.layout.fonts.caption, COLORS.system.hex));
      for (let i = 0; i < TRACKS.length; i++) {
        t.labels[i] = add.text(0, 0, VOICE_NAME[TRACKS[i]], font(this.layout.fonts.row, COLORS.white.hex));
        t.marks[i] = add.text(0, 0, DISASSEMBLED_WORD, font(this.layout.fonts.mark, COLORS.white.hex));
        if (typeof t.marks[i].setVisible === 'function') t.marks[i].setVisible(false);
      }
      for (const obj of [t.numeral, t.caption, ...t.labels, ...t.marks]) {
        if (obj && typeof obj.setOrigin === 'function') obj.setOrigin(0, 0);
        if (obj && typeof obj.setDepth === 'function') obj.setDepth(HUD_DEPTH);
      }
    }
    this.ready = true;
    return this;
  }

  /** 改分辨率（C7 resize 走这里）：重算 hudLayout + 重设字号，不重建对象 */
  setView(view) {
    if (!view) return this.layout;
    this.view = resolveView(view);
    this.layout = hudLayout(this.view);
    this._syncFonts();
    return this.layout;
  }

  /**
   * 每帧一次（**LevelRuntime.update 里唯一的 HUD 入口**）。
   * @param {ReturnType<typeof hudModel> extends never ? never : object} snapshot
   *        { view, combo, hpByTrack, hpMaxByTrack, disassembledTracks, a11y }
   */
  sync(snapshot = {}) {
    if (!this.ready) return this.stats;
    if (snapshot.view && (!this.layout || snapshot.view.width !== this.view.width || snapshot.view.height !== this.view.height)) {
      this.setView(snapshot.view);
    }
    const model = hudModel(snapshot);
    this.model = model;
    // a11y 只从 view.a11y 来（LevelRuntime._syncA11y 每帧已刷过一次）；本层不读存档
    const a = a11yOf(snapshot.a11y || this.view);
    this._drawBand(model, a);
    this._drawRows(model);
    this._syncTexts(model);
    this.stats = {
      frames: this.stats.frames + 1,
      bandOps: countOps(this.g.band),
      rowsOps: countOps(this.g.rows),
      numeralText: comboText(model.combo),
      gold: model.gold,
      reduceFlash: a.reduceFlash,
      clearance: this.layout.clearance
    };
    return this.stats;
  }

  /** 读回侧（?selftest=render / DebugPanel）：几何 = hudLayout 原样，数字 = 本帧消费的快照 */
  snapshot() {
    return {
      version: HUD_VERSION,
      depth: HUD_DEPTH,
      layout: this.layout,
      combo: this.model.combo,
      comboText: comboText(this.model.combo),
      gold: this.model.gold,
      tracks: this.model.tracks,
      stats: this.stats,
      /** 文本落位读回：门闸可逐条对齐 hudLayout 的矩形（x/y = 矩形左上角，origin(0,0)） */
      texts: textsOf([this.texts.numeral, this.texts.caption, ...this.texts.labels, ...this.texts.marks])
    };
  }

  shutdown() {
    for (const key of Object.keys(this.g)) {
      const gfx = this.g[key];
      if (!gfx) continue;
      if (typeof gfx.clear === 'function') gfx.clear();
      if (typeof gfx.destroy === 'function') gfx.destroy();
      this.g[key] = null;
    }
    for (const obj of [this.texts.numeral, this.texts.caption, ...this.texts.labels, ...this.texts.marks]) {
      if (obj && typeof obj.destroy === 'function') obj.destroy();
    }
    this.texts = { numeral: null, caption: null, labels: [], marks: [] };
    this.ready = false;
    return this;
  }

  // ─────────────────────────────────────── 绘制（全部几何来自 this.layout，一个像素都不自算）

  _drawBand(model) {
    const g = this.g.band;
    if (!g || typeof g.clear !== 'function') return;
    const r = this.layout.band;
    g.clear();
    // ① 8% 带底（VIS-02 的「HUD 上 8%」落地：fillRect 的 h 恰为 zones.hudHeight）
    g.fillStyle(DERIVED.bandHud.int, alphaOf('bandHud'));
    g.fillRect(r.x, r.y, r.w, r.h);
    // ② 下沿 = 第一条分区边界（复用 Background 的 divider 口径：bandEdge 色 + divider alpha）
    g.fillStyle(DERIVED.bandEdge.int, alphaOf('divider'));
    g.fillRect(r.x, r2(r.y + r.h - this.view.designScale), r.w, Math.max(1, r2(this.view.designScale)));
    // ③ 连击金边：状态驱动（combo ≥ 10），无任何时间项
    const num = this.layout.combo;
    if (model.gold) {
      const a = a11yOf(this.view);
      g.lineStyle(Math.max(1, r2(2 * this.view.designScale)), HUD_CFG.gold.int, alphaOf('coreEdge'));
      g.strokeRect(num.x, num.y, num.w, num.h);
      // 辉光是唯一「闪」的增量 ⇒ reduceFlash 时整圈撤掉（描边与金数字保留：那是信息，不是闪）
      if (!a.reduceFlash) {
        const out = r2(this.view.designScale * 3);
        g.lineStyle(Math.max(1, r2(this.view.designScale)), HUD_CFG.gold.int, alphaOf('legend'));
        g.strokeRect(num.x - out, num.y - out, num.w + out * 2, num.h + out * 2);
      }
    }
  }

  _drawRows(model) {
    const g = this.g.rows;
    if (!g || typeof g.clear !== 'function') return;
    g.clear();
    const rows = this.layout.hpRows;
    const lw = Math.max(1, r2(this.view.designScale));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const m = model.tracks[i];
      if (!m || m.inactive) continue; // DIS-01：未配置声部 hp=0 且不参与 ⇒ 整行不画（不留空壳误导读数）
      const color = TRACK_COLOR[row.track];
      // 格 = 形状通道（与声部形状无关的纯计数）；画 hpMax 个框，其中前 hp 个填充。
      // 最后一格降到 vignette(0.55)：灰度截图也读得出「只剩一格」（PERF-05② 的明度通道）。
      const filledAlpha = alphaOf(m.hp <= 1 ? 'vignette' : 'judgeDot');
      for (let c = 0; c < row.cells.length; c++) {
        if (c >= m.hpMax) break;
        const cell = row.cells[c];
        g.lineStyle(lw, COLORS.white.int, alphaOf('dim'));
        if (typeof g.strokeRect === 'function') g.strokeRect(cell.x, cell.y, cell.w, cell.h);
        if (c < m.hp) {
          g.fillStyle(color, filledAlpha);
          g.fillRect(cell.x, cell.y, cell.w, cell.h);
        }
      }
      // 打空那一行：整行铺一层 20% 声部色底，让「已拆解」在灰度截图里也与活着的行区分
      if (m.hp === 0) {
        g.fillStyle(color, alphaOf('dim'));
        g.fillRect(row.x, row.y, row.w, row.h);
      }
    }
  }

  _syncTexts(model) {
    const L = this.layout;
    const t = this.texts;
    // 连击数字：金档走金数字，平时走系统青；题注恒为系统青（不闪）
    this._place(t.numeral, comboText(model.combo), L.combo, model.gold ? HUD_CFG.gold.hex : COLORS.system.hex, alphaOf('coreEdge'));
    this._place(t.caption, COMBO_CAPTION, L.comboCaption, COLORS.system.hex, alphaOf('legend'));
    for (let i = 0; i < L.hpRows.length; i++) {
      const row = L.hpRows[i];
      const m = model.tracks[i];
      this._place(t.labels[i], m && m.inactive ? '—' : row.name, row.label, COLORS.white.hex, alphaOf('divider'));
      if (m && m.disassembled) this._place(t.marks[i], DISASSEMBLED_WORD, row.mark, COLORS.white.hex, alphaOf('judgeHead'));
      else if (t.marks[i] && typeof t.marks[i].setVisible === 'function') t.marks[i].setVisible(false);
    }
  }

  _syncFonts() {
    const f = this.layout.fonts;
    const t = this.texts;
    this._fontSize(t.numeral, f.numeral);
    this._fontSize(t.caption, f.caption);
    for (const obj of t.labels) this._fontSize(obj, f.row);
    for (const obj of t.marks) this._fontSize(obj, f.mark);
  }

  _fontSize(obj, px) {
    if (!obj || typeof obj.setFontSize !== 'function') return;
    obj.setFontSize(`${Math.round(px)}px`);
  }

  /** 文本落位 = hudLayout 的矩形左上角（origin(0,0)）：门闸可直接把 x/y/fontSize 与 hudLayout 对齐断言 */
  _place(obj, text, rect, colorHex, alpha) {
    if (!obj) return;
    if (typeof obj.setVisible === 'function') obj.setVisible(true);
    if (typeof obj.setText === 'function') obj.setText(String(text));
    if (typeof obj.setPosition === 'function') obj.setPosition(rect.x, rect.y);
    this._fontSize(obj, rect.fontPx);
    if (typeof obj.setColor === 'function' && colorHex) obj.setColor(colorHex);
    else if (obj) obj.color = colorHex || obj.color;
    if (typeof obj.setAlpha === 'function') obj.setAlpha(alpha);
  }
}

export default HudLayer;
