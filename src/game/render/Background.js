// src/game/render/Background.js — Owner: WORLD (W-01)
// 上层世界的**静止帧骨架**（VIS-01「霓虹电路板 × 示波器」）：
//   · 分区底色与两条分区线（HUD 8% / 世界 60% / 时间轴 32%，`view.dividerYs`）
//   · ≥2 层视差电路远景（`view.bgLayers`，程序绘制，零位图素材，VIS-06）
//   · 地面线 y = 0.52H
//   · 上层判定线 x = 0.30W（与下层时间轴同一 x，纪律 2）
//
// 纪律 1：视差位移 = f(nowSec)，见 parallaxOffsetFor()。**没有 x += v*dt**，所以掉帧 5 秒后画面仍在正确位置。
// 纪律 3：只用 DERIVED 的消色差派生色。**视差层禁止携带声部信息**（否则「颜色即信息」被污染）。
// 不 import Phaser：绘制目标是调用方给的 Graphics → 本文件可在 Node 用 RecordingGraphics 断言。
//
// 无障碍（每帧从 `view.a11y` 读，无副作用）：
//   · TIM-05 关辅助线 → 不画地面拍刻度、不画出生线（4 拍窗右界）。分区线/地面线/判定线是棋盘，留。
//   · PERF-05③ 降低闪烁 → 判定线的每拍脉冲幅度 ×0（线还在，不再呼吸）。

import { BACKGROUND_CFG, COLORS, DERIVED, HUD_CFG, a11yOf, alphaOf, beatOffsetX, resolveView, timeToBeatOf } from '../../data/theme.js';

const MOD = BACKGROUND_CFG.MODULATION;

/** 确定性「随机」：同一 (i, seed) 永远同一输出（不依赖 Math.random → 截图可逐像素复现） */
export function hash01(i, seed = 0) {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = (h * 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h % 100000) / 100000;
}

/** 拆解进度 → 远景强度系数（纯 alpha，1 = 原样，越小越暗） */
export function calmFactor(calm = 0) {
  const c = Math.max(0, Math.min(1, Number(calm) || 0));
  return 1 - c * MOD.calmFadeRange;
}

/**
 * 某视差层在 nowSec 时刻的整体位移（纯函数）。
 * @param {number} nowSec
 * @param {object} view
 * @param {number} factor  BACKGROUND_CFG.layers[].factor
 * @param {number} [tileW] 平铺周期（缺省 = 层 tileW 像素）
 */
export function parallaxOffsetFor(nowSec, view, factor, tileW) {
  const v = resolveView(view);
  const period = tileW || Math.max(1, v.width * BACKGROUND_CFG.layers[0].tileW);
  const raw = nowSec * v.pxPerSec * factor;
  return -(((raw % period) + period) % period); // ≤ 0：随时间向左流
}

/**
 * 视差层几何：每个单元给出一条电路走线 + 可选过孔。
 * @returns {{index:number,name:string,factor:number,color:int,alpha:number,
 *            traces:Array<{x1:number,y1:number,x2:number,y2:number}>,
 *            vias:Array<{x:number,y:number,r:number}>,tileW:number}}
 */
export function layerGeometry(view, index = 0) {
  const v = resolveView(view);
  const cfg = BACKGROUND_CFG.layers[index];
  if (!cfg) throw new Error(`[Background] no such parallax layer: ${index}`);
  const tileW = Math.max(24, v.width * cfg.tileW);
  const top = v.height * cfg.yFrom;
  const bottom = v.height * cfg.yTo;
  const cols = Math.ceil(v.width / tileW) + 2;
  const rowH = (bottom - top) / 3;
  const traces = [];
  const vias = [];
  for (let c = 0; c < cols; c++) {
    const x0 = c * tileW;
    const h = hash01(c, index + 1);
    const row = Math.floor(h * 3);
    const y = top + row * rowH + rowH * 0.5;
    if (cfg.trace === 'v') {
      traces.push({ x1: x0 + tileW * 0.5, y1: top, x2: x0 + tileW * 0.5, y2: bottom });
      traces.push({ x1: x0 + tileW * 0.5, y1: y, x2: x0 + tileW * 1.0, y2: y });
    } else if (cfg.trace === 'zig') {
      traces.push({ x1: x0, y1: y, x2: x0 + tileW * 0.42, y2: y });
      traces.push({ x1: x0 + tileW * 0.42, y1: y, x2: x0 + tileW * 0.58, y2: y + rowH * 0.42 });
      traces.push({ x1: x0 + tileW * 0.58, y1: y + rowH * 0.42, x2: x0 + tileW, y2: y + rowH * 0.42 });
    } else {
      traces.push({ x1: x0, y1: y, x2: x0 + tileW * 0.86, y2: y });
      traces.push({ x1: x0 + tileW * 0.86, y1: y, x2: x0 + tileW * 0.86, y2: y - rowH * 0.28 });
    }
    if (cfg.vias) {
      const t = traces[traces.length - 1];
      vias.push({ x: t.x2, y: t.y2, r: Math.max(1.5, v.designScale * BACKGROUND_CFG.viaRadius) });
    }
  }
  return {
    index,
    name: cfg.name,
    factor: cfg.factor,
    color: DERIVED[cfg.colorKey].int,
    colorKey: cfg.colorKey,
    alphaKey: cfg.alphaKey,
    alpha: alphaOf(cfg.alphaKey),
    traces,
    vias,
    tileW,
    lineWidth: Math.max(1, cfg.lineWidth * v.designScale)
  };
}

/** 地面线几何（y = 0.52H，全宽） */
export function groundGeometry(view) {
  const v = resolveView(view);
  return {
    y: v.groundY,
    x0: 0,
    x1: v.width,
    color: DERIVED.ground.int,
    alpha: alphaOf('ground'),
    lineWidth: v.sizes.groundLineWidth
  };
}

/** 上层判定线几何（x = 0.30W = 下层判定线 x；纵向跨度读 theme.BACKGROUND_CFG，与 hudLayout 同一口径） */
export function judgeLineGeometry(view) {
  const v = resolveView(view);
  return {
    x: v.judgeX,
    y0: v.zones.worldTop + v.zones.worldHeight * BACKGROUND_CFG.judgeLineTopRatio,
    y1: v.groundY + v.zones.worldHeight * BACKGROUND_CFG.judgeLineBottomRatio,
    color: COLORS.system.int,
    alpha: alphaOf('judgeLine'),
    lineWidth: v.sizes.judgeLineWidth,
    // 判定线与地面线的交点：这是「拆解点」的视觉锚（角色固定 x 也在这里）
    anchor: { x: v.judgeX, y: v.groundY }
  };
}

/** 本帧该画几层视差（质量档 × 硬上限，永不低于 minLayers） */
export function activeLayerCount(view, preset = null) {
  const v = resolveView(view);
  const want = preset ? preset.parallaxLayers : v.quality.parallaxLayers;
  const capped = Math.min(want, BACKGROUND_CFG.layers.length, BACKGROUND_CFG.layersMax || BACKGROUND_CFG.layers.length);
  return Math.max(BACKGROUND_CFG.minLayers, capped);
}

// ---------------------------------------------------------------------------
// 绘制器
// ---------------------------------------------------------------------------

export class Background {
  constructor(opts = {}) {
    this.opts = opts;
    this.calm = 0; // 0 = 满编曲；1 = 全拆解后的「安静」（VIS-06 降饱和的入参，由 WorldLayer 从 hp 推）
    this.layers = [];
    this.view = null;
  }

  /** 换关/改分辨率后重算几何（静态，不含时间） */
  layout(view) {
    this.view = resolveView(view);
    const n = activeLayerCount(this.view);
    this.layers = [];
    for (let i = 0; i < n; i++) this.layers.push(layerGeometry(this.view, i));
    this.ground = groundGeometry(this.view);
    this.judge = judgeLineGeometry(this.view);
    return this;
  }

  /**
   * 画整帧背景（**每帧重画，全部几何来自 view + nowSec**）。
   * @param {object} g Phaser Graphics
   * @param {{view:object,nowSec:number,calm?:number,pulse?:number}} frame
   */
  draw(g, frame) {
    const view = resolveView(frame.view);
    if (!this.view || this.view.width !== view.width || this.view.height !== view.height) this.layout(view);
    const nowSec = Number(frame.nowSec) || 0;
    const calm = frame.calm == null ? this.calm : frame.calm;
    this.calm = calm;
    const fade = calmFactor(calm); // 拆解进度越高，远景越安静（只降 alpha，不引入新色 → 纪律 3）

    g.clear();
    this.drawZones(g, view);
    for (const layer of this.layers) this.drawParallax(g, layer, view, nowSec, fade);
    this.drawGround(g, view, { ...frame, nowSec });
    this.drawJudgeLine(g, view, { ...frame, nowSec });
    return this;
  }

  /** 分区底色 + 分区线（HUD 带 / 世界带 / 时间轴带的可见边界） */
  drawZones(g, view) {
    g.fillStyle(COLORS.base.int, 1);
    g.fillRect(0, 0, view.width, view.height);
    g.fillStyle(DERIVED.bandHud.int, alphaOf('bandHud'));
    g.fillRect(0, 0, view.width, view.zones.hudHeight);
    for (const y of view.dividerYs) {
      g.lineStyle(Math.max(1, view.designScale), DERIVED.divider.int, alphaOf('divider'));
      g.lineBetween(0, y, view.width, y);
    }
  }

  /** 单层视差：位移是 nowSec 的纯函数（纪律 1） */
  drawParallax(g, layer, view, nowSec, fade = 1) {
    const off = parallaxOffsetFor(nowSec, view, layer.factor, layer.tileW);
    g.lineStyle(layer.lineWidth, layer.color, layer.alpha * fade);
    for (const t of layer.traces) {
      const x1 = t.x1 + off;
      const x2 = t.x2 + off;
      if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > view.width) continue;
      g.lineBetween(x1, t.y1, x2, t.y2);
    }
    if (layer.vias.length) {
      g.fillStyle(layer.color, alphaOf(layer.alphaKey, MOD.viaAlphaGain) * fade);
      for (const v of layer.vias) {
        const x = v.x + off;
        if (x < 0 || x > view.width) continue;
        g.fillCircle(x, v.y, v.r);
      }
    }
  }

  /** 地面线 + 按拍落刻度（拍域定位 → 与障碍、下层标记严格同拍） */
  drawGround(g, view, frame) {
    const gr = this.ground || groundGeometry(view);
    const calm = Math.max(0, Math.min(1, this.calm));
    g.lineStyle(gr.lineWidth, gr.color, gr.alpha * (1 - calm * MOD.groundCalmRange));
    g.lineBetween(gr.x0, gr.y, gr.x1, gr.y);
    // TIM-05：地面线本体是「棋盘」（角色就在它上面跑），拍刻度才是辅助线 —— 关掉只摘刻度。
    if (!a11yOf(view).showTimelineGuides) return this;
    const nowSec = Number(frame.nowSec) || 0;
    const nowBeat = timeToBeatOf(view, nowSec);
    const step = BACKGROUND_CFG.ground.tickEveryBeats;
    const from = Math.floor(nowBeat) - 1;
    const to = Math.ceil(nowBeat + view.leadBeats) + 1;
    const h = Math.max(3, view.height * BACKGROUND_CFG.ground.tickHeight);
    g.lineStyle(Math.max(1, view.designScale), DERIVED.beatTick.int, alphaOf('beatTick', 1.1));
    for (let b = from; b <= to; b += step) {
      const x = beatOffsetX(view, b - nowBeat); // 与上层障碍同一个换算（纪律 2）
      if (x < 0 || x > view.width) continue;
      const strong = ((b % 4) + 4) % 4 === 0;
      g.lineBetween(x, gr.y, x, gr.y + (strong ? h : h * 0.5));
    }
  }

  /** 上层判定线（与下层同 x）；pulse = 边缘节拍脉冲强度（W-14 消费，v0 只做线本身） */
  drawJudgeLine(g, view, frame = {}) {
    const j = this.judge || judgeLineGeometry(view);
    const a = a11yOf(view);
    // PERF-05③：脉冲的**可变**幅度（每拍一次的整线明暗，110BPM ≈ 1.83Hz）是频闪主体，
    // reduceFlash 下 ×0 → 亮度钉在 MODULATION.judgePulseBase，线本身照画（VIS-05 的两层同 x）。
    const pulse = Math.max(0, Math.min(1, Number(frame.pulse) || 0)) * a.flash.edgePulseRange;
    // ★ DIS-09：连击 ≥10 → 判定线金色描边。**纯表现**：只读 frame.combo（CORE 传下来的显示态），
    //   判定路径不读它，它也不吃时间 —— 状态驱动 ⇒ 结构上不会逐帧脉冲。
    //   reduceFlash 只撤「外圈辉光」这一项闪源；金描边本身留（它是连击档位的冗余提示，不是装饰闪光）。
    const gold = Number(frame.combo) >= HUD_CFG.goldComboMin;
    if (gold) {
      if (!a.reduceFlash) {
        g.lineStyle(j.lineWidth * HUD_CFG.goldGlowScale, HUD_CFG.gold.int, alphaOf('legend'));
        g.lineBetween(j.x, j.y0, j.x, j.y1);
      }
      g.lineStyle(j.lineWidth * HUD_CFG.goldStrokeScale, HUD_CFG.gold.int, alphaOf('coreEdge'));
      g.lineBetween(j.x, j.y0, j.x, j.y1);
    }
    g.lineStyle(j.lineWidth, j.color, j.alpha * (MOD.judgePulseBase + MOD.judgePulseRange * pulse));
    g.lineBetween(j.x, j.y0, j.x, j.y1);
    // 判定点：地面线上的一枚小白块（角色脚底正对此处，PLR-01）
    const s = Math.max(3, view.designScale * 6);
    g.fillStyle(COLORS.white.int, alphaOf('judgeDot'));
    g.fillRect(j.anchor.x - s / 2, j.anchor.y - s / 2, s, s);
    if (!a.showTimelineGuides) return this; // TIM-05：出生线 = 4 拍预告窗右界，属辅助线
    // 世界可读区右界（出生线）：淡竖线 = 「障碍从这里开始出现」= 4 拍预告窗（与下层同列）
    const sx = view.worldWindow ? view.worldWindow.x1 : view.rightSpawnX;
    g.lineStyle(Math.max(1, view.designScale), DERIVED.divider.int, alphaOf('spawnLine', 1 + MOD.spawnPulseRange * pulse));
    g.lineBetween(sx, view.zones.worldTop, sx, view.groundY);
    return this;
  }

  shutdown(g = null) {
    if (g && typeof g.clear === 'function') g.clear();
    this.layers = [];
    this.view = null;
  }
}

/** 便捷：一帧的完整背景（无实例） */
export function drawStaticFrame(g, view, nowSec = 0) {
  return new Background().draw(g, { view, nowSec });
}

export default Background;
