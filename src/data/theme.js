// src/data/theme.js — Owner: WORLD (W-01)
// ★ CONTRACTS C8 冻结项的唯一落地：全项目**唯一**允许出现颜色字面量的文件。
//   其它任何 .js / .css 出现 #rrggbb / rgb() / hsl() 字面量 = 违规（tools/screenshotCheck.mjs 会扫）。
//   本文件同时是「分区 / 字号 / 尺寸 / 粒子与 bloom 上限 / 色盲冗余编码通道」的唯一入口。
//
// 纯数据 + 纯函数：不 import Phaser、不读 DOM、不用任何时钟 → 可在 Node 直接 import（渲染与断言读同一份）。
//
// 三条实现纪律（WORLD.md）在本文件的挂钩：
//   纪律 2：上下层共享同一 pxPerBeat → PX_PER_BEAT_RATIO；角色 x = 判定线 x → JUDGE_X_RATIO。
//   纪律 3：禁止第四种声部色 → 只有 6 个字面量（底 / 三声部 / 青 / 白），其余全部由 mix() 从这 6 个派生，
//           且派生只走「base↔white 的消色差轴」，不引入任何新色相。

/** 主题版本（供 CR 与截图断言比对，字段只增不改） */
export const THEME_VERSION = 'R1.0';

// ---------------------------------------------------------------------------
// 1 · 色板（C8 冻结的 6 个字面量）
// ---------------------------------------------------------------------------

const hexInt = (hex) => parseInt(hex.slice(1), 16);

const RAW = {
  base: '#0a0e1a', // 底色
  kick: '#ff4757', // 鼓 · 红 · 尖刺
  bass: '#ffd166', // 贝斯 · 黄 · 横条平台
  synth: '#ff2d78', // 合成器 · 品红 · 六边形
  system: '#00f0ff', // 系统色 · 青（判定线/HUD/选中）
  white: '#ffffff' // 系统色 · 白（大字/描边/高亮）
};

/** @type {Record<keyof typeof RAW, {hex:string,int:number,r:number,g:number,b:number}>} */
export const COLORS = Object.fromEntries(
  Object.entries(RAW).map(([k, hex]) => {
    const int = hexInt(hex);
    return [
      k,
      { hex, int, r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff }
    ];
  })
);

/** 全项目合法颜色字面量白名单（screenshotCheck 用它反查泄漏）。 */
export const COLOR_HEX_WHITELIST = Object.values(RAW);

/**
 * 消色差派生：只允许 base↔white 轴（不产生新色相）或声部色↔white / 声部色↔base（保色相的明度分离）。
 * @param {{r:number,g:number,b:number}} a
 * @param {{r:number,g:number,b:number}} b
 * @param {number} k 0..1
 */
function mixRgb(a, b, k) {
  const t = Math.max(0, Math.min(1, k));
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t)
  };
}
const toHex = ({ r, g, b }) => `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
const toInt = ({ r, g, b }) => ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
const intToRgb = (int) => ({ r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff });

/**
 * 派生色（全部由上面 6 个字面量算出，无新字面量）。
 * 用途：分区底、网格、视差电路、描边。任何装饰不得占用第四种「声部色相」。
 */
function derive(name, k) {
  const c = mixRgb(COLORS.base, COLORS.white, k);
  return { hex: toHex(c), int: toInt(c), k };
}
export const DERIVED = {
  /** 时间轴带底（比底色亮一档，划出「读谱区」） */
  bandTimeline: derive('bandTimeline', 0.035),
  /** HUD 带底 */
  bandHud: derive('bandHud', 0.05),
  /** 分区分隔线 */
  divider: derive('divider', 0.14),
  /** 视差远景 第 1 层（最远最暗） */
  parallaxFar: derive('parallaxFar', 0.075),
  /** 视差远景 第 2 层 */
  parallaxMid: derive('parallaxMid', 0.13),
  /** 视差近景（第 3 层，可选档） */
  parallaxNear: derive('parallaxNear', 0.2),
  /** 拍刻度 */
  beatTick: derive('beatTick', 0.26),
  /** 小节线（每 4 拍） */
  barLine: derive('barLine', 0.44),
  /** 地面线 */
  ground: derive('ground', 0.52),
  /** 静音/暗态（用于 expired 障碍） */
  dim: derive('dim', 0.1)
};

// ---------------------------------------------------------------------------
// 2 · 声部通道（L-08 色盲冗余编码：颜色 + 形状 + 明度 三通道同时编码）
// ---------------------------------------------------------------------------

export const TRACKS = ['kick', 'bass', 'synth'];

/** track → 类型（C4） */
export const TYPE_BY_TRACK = { kick: 'spike', bass: 'platform', synth: 'barrage' };

/** track → 中文声部名（大字标题用，UI 文案唯一来源） */
export const VOICE_NAME = { kick: '鼓', bass: '贝斯', synth: '合成器' };

/** 纪律 3：声部色只此三色 */
export const TRACK_COLOR = {
  kick: COLORS.kick.int,
  bass: COLORS.bass.int,
  synth: COLORS.synth.int
};
export const TRACK_HEX = {
  kick: COLORS.kick.hex,
  bass: COLORS.bass.hex,
  synth: COLORS.synth.hex
};

/** 形状通道（渲染与断言读同一份）：三角 / 横条平台 / 六边形 */
export const SHAPE_BY_TRACK = {
  kick: 'triangle',
  bass: 'platformBar',
  synth: 'hexagon'
};
/** 每种形状的顶点数（灰度化后形状通道的可断言形式） */
export const SHAPE_VERTEX_COUNT = { triangle: 3, platformBar: 4, hexagon: 6 };

/**
 * 明度通道：把三色在「灰度截图」上拉开。tone = { white:k, dark:k }
 * 只沿明度轴移动（保色相），不新增色相 → 不违反纪律 3。
 * 数值来源：#ff4757 感知亮度≈111、#ffd166≈211、#ff2d78≈95 → 红/品红几乎同灰度，
 * 故 kick 压暗、synth 提亮，把三档目标灰度拉开到约 101 / 215 / 161。
 */
export const TONE_BY_TRACK = {
  kick: { white: 0.0, dark: 0.1 },
  bass: { white: 0.05, dark: 0.0 },
  synth: { white: 0.41, dark: 0.0 }
};

/** 可访问性模式：'luma' = 三色各自移明度（默认，灰度可辨）；'voice' = 用原始声部色（仅靠形状区分） */
export const MARKER_TONE_MODES = ['luma', 'voice'];
export const MARKER_TONE_MODE_DEFAULT = 'luma';

/** 灰度可辨门限：三声部两两感知灰度差必须 ≥ 此值（0..255）。40 ≈ 明显可分。 */
export const GRAY_CONTRAST_MIN = 40;

/** 感知亮度（Rec.709，与浏览器 filter: grayscale 的口径接近） */
export function perceptualLuma(int) {
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * alpha 唯一取用入口：只能拿 ALPHA 表里的键（可选再乘一个系数）。
 * 目的：不许在渲染代码里现写魔法透明度，更不许靠「新颜色」做层次（纪律 3）。
 * @param {keyof typeof ALPHA} key
 * @param {number} [k=1] 系数，结果夹到 0..1
 */
export function alphaOf(key, k = 1) {
  const a = ALPHA[key];
  if (typeof a !== 'number') throw new Error(`[theme] unknown alpha key: ${key}`);
  return Math.max(0, Math.min(1, a * k));
}

/** 应用 tone 后的实际填充色（int）——渲染走这个，断言也读这个。 */
export function markerColor(track, mode = MARKER_TONE_MODE_DEFAULT) {
  const voice = TRACK_COLOR[track];
  if (voice == null) throw new Error(`[theme] unknown track: ${track}`);
  if (mode === 'voice') return voice;
  const tone = TONE_BY_TRACK[track] || { white: 0, dark: 0 };
  const lifted = mixRgb(COLORS[track], COLORS.white, tone.white);
  return toInt(mixRgb(lifted, COLORS.base, tone.dark));
}

export function markerHex(track, mode = MARKER_TONE_MODE_DEFAULT) {
  return toHex(intToRgb(markerColor(track, mode)));
}

/**
 * 明度通道表（由 TONE_BY_TRACK 推导，非独立常量 → 永远不会与渲染脱钩）。
 * @type {Record<string, number>} 0..255
 */
export const LUMA_BY_TRACK = Object.fromEntries(
  TRACKS.map((t) => [t, Math.round(perceptualLuma(markerColor(t, 'luma')))])
);
/** 同上的 voice 模式（用于「关掉明度分离」时的对照断言） */
export const LUMA_BY_TRACK_VOICE = Object.fromEntries(
  TRACKS.map((t) => [t, Math.round(perceptualLuma(TRACK_COLOR[t]))])
);

/** 描边/发光用的高亮（同色相提亮，不新增色相） */
export const CORE_EDGE = { color: COLORS.white.int, alpha: 0.95, widthRatio: 0.055 };

// ---------------------------------------------------------------------------
// 3 · 屏幕分区（VIS-02：HUD 8% / 上层世界 60% / 下层时间轴 32%）
// ---------------------------------------------------------------------------

export const ZONE_RATIOS = { hud: 0.08, world: 0.6, timeline: 0.32 };

/** 基准分辨率（PRD §7.5 的值都以它为 1.0） */
export const DESIGN_BASE = { width: 1920, height: 1080 };

/** 与 C8 physics.js 冻结项对齐的**画面几何口径**（值由 WORLD 拥有，CORE 的 physics.js 必须引用同口径，见 CR-10） */
export const VIEW_RATIOS = {
  judgeX: 0.3, // 判定线 x = 0.30W = 角色固定 x
  groundY: 0.52, // 地面线 y = 0.52H
  pxPerBeat: 0.115, // 上下层共享；4 拍预告 = 0.46W
  dashDist: 0.12, // 冲刺位移（表现侧引用，物理真相在 physics.js）
  jumpPeakH: 0.2, // 跳跃峰值高（表现侧）
  jumpAirBeats: 0.9, // 滞空按拍（L-03）
  dashDurBeats: 0.35,
  charH: 0.075, // 角色高（physics.AUX.charH 同值：弹幕间隙 = 2.2×charH 的基准）
  platformTiers: [0.1, 0.16, 0.21] // 三档高（相对地面线上方）
};

/** OBS-03：4 拍预告窗（上下层一致） */
export const LEAD_BEATS = 4;

/** 下层时间轴带专属常量（W-05） */
export const TIMELINE_CFG = {
  leadBeats: LEAD_BEATS,
  /** 泳道顺序：**上→下 = synth / bass / kick**（低频在最下，直觉与 PRD §9 一致，不许两处各写一套） */
  laneOrder: ['synth', 'bass', 'kick'],
  /** 最右（kick）泳道基线在带中线的下方比例 */
  laneBottomOffset: 0.24,
  /** 每格拍数：1 = 整拍格。变速关仍按拍等距（TIM-02），只是拍长变短 */
  gridBeats: 1,
  /** 左侧预滚区（已过线、正在消散的标记）宽度占拍数 */
  pastBeats: 1,
  /** 声部图例（道首小形状）x = 判定线 − N×pxPerBeat；0 = 关闭 */
  legendBeatOffset: 0.75,
  /** W-12 假节拍上限（L-06：≤8 处标记、其中仅 2 处演出型故障闪烁） */
  ghostMax: 8,
  ghostGlitchMax: 2
};

/** 尺寸（1080p 基准，PRD §7.5） */
export const SIZES = {
  spike: { w: 48, h: 40 },
  platform: { w: 120, h: 24 },
  barrage: { w: 56, h: 56 },
  player: { w: 34, h: 56 },
  timelineMarkerH: 40,
  judgeLineWidth: 3,
  groundLineWidth: 2
};

/** 不透明度（分层用 alpha，而不是新颜色）。渲染代码只能引用这里的键（`alphaOf()`）。 */
export const ALPHA = {
  parallaxFar: 0.5,
  parallaxMid: 0.38,
  parallaxNear: 0.24,
  beatTick: 0.5,
  barLine: 0.72,
  guideLine: 0.28,
  markerExpired: 0.22,
  markerJudged: 0.3,
  coreEdge: 0.9,
  silhouette: 0.35,
  vignette: 0.55,
  // —— 背景 / 分区（Background.js）——
  bandHud: 0.85,
  bandTimeline: 1,
  divider: 0.85,
  bandEdge: 0.9,
  ground: 0.9,
  judgeLine: 0.8,
  judgeDot: 0.85,
  judgeHead: 0.95,
  spawnLine: 0.3,
  // —— 下层时间轴（Timeline.js）——
  legend: 0.42,
  ghost: 0.4,
  ghostGlitch: 0.75,
  ghostScan: 0.3
};

/**
 * 上层世界背景（W-01 / VIS-01「霓虹电路板」、VIS-06 ≥2 层视差）。
 * 只允许用 DERIVED 的消色差派生色 —— 视差层不许携带声部信息（纪律 3）。
 */
export const BACKGROUND_CFG = {
  /** 层序 = 由远及近；factor = 相对世界速率的视差系数（必须单调递增，由断言守） */
  layers: [
    { name: 'far', factor: 0.1, colorKey: 'parallaxFar', alphaKey: 'parallaxFar', tileW: 0.085, trace: 'h', vias: false, yFrom: 0.06, yTo: 0.42, lineWidth: 1 },
    { name: 'mid', factor: 0.26, colorKey: 'parallaxMid', alphaKey: 'parallaxMid', tileW: 0.115, trace: 'zig', vias: true, yFrom: 0.28, yTo: 0.52, lineWidth: 1.5 },
    { name: 'near', factor: 0.45, colorKey: 'parallaxNear', alphaKey: 'parallaxNear', tileW: 0.17, trace: 'v', vias: true, yFrom: 0.44, yTo: 0.52, lineWidth: 2 }
  ],
  /** 视差最少层数（DoD） */
  minLayers: 2,
  /** 视差层数硬上限（= layers.length；质量档不得越过） */
  layersMax: 3,
  viaRadius: 3,
  /** 弹幕底部净空 = 2.2 × 角色高（physics.AUX.barrageGapRatio 同值：W-10 的硬约束） */
  gapToCharH: 2.2,
  /**
   * 平台最低档下方的净空下限（角色身高倍数）。
   * 口径来自 physics 的冻结档：tier0 = 0.10H → 板顶距地 108px@1080p，减去板厚 24px 后下方剩 84px
   * = 1.04 × 角色高（81px）。跑动的角色必须能从低档板下穿过而不碰头，所以这个下限只能贴着
   * 1.0 取；写 1.5 会和 C8 冻结的 0.10H 直接矛盾（W-09 自检会红）。想抬高它必须先与 CORE 一起改档位表。
   */
  tierClearanceMinChars: 1.0,
  /** 地面线：按拍落刻度（拍域定位 → 变速关与障碍严格同步，见纪律 1） */
  ground: { tickEveryBeats: 1, tickHeight: 0.018, glowBeats: 0.25, lineWidthRatio: 1 },
  /** 分区边界数（HUD/世界 与 世界/时间轴） */
  dividerCount: 2,
  /**
   * 表现强度系数（VIS-06 的「拆解后变安静」与 VIS-03 的「边缘脉冲」）。
   * 一律只调 alpha —— 绝不靠新增颜色做层次（纪律 3）。审美候选值留在这里，
   * 人类若要更浓/更淡只改这张表（T16），代码里不许现写。
   */
  MODULATION: {
    calmFadeRange: 0.45, // 远景随拆解进度的最大变暗幅度（0 = 不随拆解变淡）
    groundCalmRange: 0.3, // 地面线随拆解进度的变暗幅度
    viaAlphaGain: 1.4, // 过孔比走线亮的倍数
    judgePulseBase: 0.55, // 判定线脉冲的底座强度
    judgePulseRange: 0.45, // 判定线脉冲的可变强度
    spawnPulseRange: 0.2 // 出生线随脉冲的可变强度
  }
};

// ---------------------------------------------------------------------------
// 4 · 字号阶（PERF-05：全部 UI 文本 ≥ 20px @1080p）
// ---------------------------------------------------------------------------

export const FONT_FAMILY =
  'ui-monospace, "JetBrains Mono", "SFMono-Regular", Consolas, "Noto Sans SC", "Microsoft YaHei", monospace';

/** 1080p 基准字号 */
export const FONT_TIERS = {
  display: 104, // 大字标题（拆解/评级）
  title: 56, // 界面主标题
  hud: 30, // 连击数字
  sub: 24, // HUD 标签
  body: 22, // 正文/按钮
  caption: 20, // 最小可读（= 下限）
  debug: 20
};
export const FONT_MIN_PX = 20;

// ---------------------------------------------------------------------------
// 5 · 演出时长：一律表达为**拍长系数**（失败模式 3：固定 ms 会在变速关脱钩）
// ---------------------------------------------------------------------------

/** 拍长系数（beat = 60/BPM 秒）。1 拍 @110BPM=545ms、@132BPM=455ms。 */
export const MOTION = {
  desaturateBeats: 0.55, // ≈0.3s@110 → 拆解降饱和
  desaturateFloor: 0.35, // 降到多少饱和度
  bigTextBeats: 1.0, // 大字驻留
  bigTextScaleFrom: 1.35,
  coreFlashBeats: 0.12, // PERFECT 金闪
  frameHoldBeats: 0.04, // 顿帧（≈2 帧@60fps，按拍微调）
  shakeBeats: 0.2, // MISS 震动衰减
  shakeMaxPx: 14, // PRD：14px 衰减震动
  edgePulseBeats: 0.5,
  reviveFlashBeats: 0.35,
  alignDashBeats: 0.25, // TIM-03 上下层对齐虚线（W-06 用）
  trailBeats: 0.3,
  /** 障碍入画淡入跨度（拍）：出生线在「4 拍 + 本值」处，到线时 alpha 恰为 1（OBS-03） */
  spawnFadeBeats: 0.45
};

/** 把拍系数换算成秒 */
export function beatsToSec(beats, beatSec) {
  return beats * beatSec;
}

// ---------------------------------------------------------------------------
// 6 · 质量预设（C8 的「粒子与 bloom 上限」+ T16 审美候选）
// ---------------------------------------------------------------------------

/** 硬上限：任何预设/任何运行时都不得越过（防 D9 才发现掉帧） */
export const QUALITY_CAPS = {
  particlesLiveMax: 300,
  particlesPerBurstMax: 40,
  bloomIntensityMax: 0.8,
  bloomLayersMax: 3,
  /** 视差层上限 = BACKGROUND_CFG.layersMax（层表只有 3 条，写 4 会让降级开关要一个不存在的层） */
  parallaxLayersMax: 3,
  shakeMaxPx: 20
};

/**
 * 三档审美候选（人类在 D3 审美门挑，PLAN §0：默认取最保守档）。
 * 各档都 ≤ QUALITY_CAPS；差在「密度/强度/时长系数」，**不改分区与 pxPerBeat**。
 */
export const QUALITY_PRESETS = {
  quiet: {
    label: '安静档（默认）',
    particlesPerBurst: 12,
    particlesLiveMax: 80,
    bloomIntensity: 0,
    bloomLayers: 0,
    parallaxLayers: 2,
    edgePulseAlpha: 0.28,
    vignetteAlpha: 0.42,
    shakeMaxPx: 10,
    frameHoldBeats: 0,
    desaturateBeats: 0.55,
    bigTextBeats: 1.0,
    trailOn: false,
    flashReductionSafe: true
  },
  standard: {
    label: '标准档',
    particlesPerBurst: 22, // PRD §15.2 的 22 粒
    particlesLiveMax: 150,
    bloomIntensity: 0.3,
    bloomLayers: 1,
    parallaxLayers: 3,
    edgePulseAlpha: 0.42,
    vignetteAlpha: 0.55,
    shakeMaxPx: 14,
    frameHoldBeats: 0.04,
    desaturateBeats: 0.6,
    bigTextBeats: 1.25,
    trailOn: true,
    flashReductionSafe: true
  },
  vivid: {
    label: '浓烈档（需实测帧率）',
    particlesPerBurst: 34,
    particlesLiveMax: 260,
    bloomIntensity: 0.55,
    bloomLayers: 2,
    parallaxLayers: 3,
    edgePulseAlpha: 0.6,
    vignetteAlpha: 0.68,
    shakeMaxPx: 18,
    frameHoldBeats: 0.07,
    desaturateBeats: 0.75,
    bigTextBeats: 1.5,
    trailOn: true,
    flashReductionSafe: false
  }
};
export const DEFAULT_QUALITY = 'quiet';

/** 降级顺序（VIS-04）：先粒子后 bloom，分区与 pxPerBeat 永不动 */
export const DEGRADE_ORDER = [
  'particlesPerBurst→1/2',
  'particlesLiveMax→1/2',
  'bloomLayers−1',
  'bloomIntensity→0',
  'parallaxLayers→2',
  'shakeMaxPx→0'
];

/** 兼容旧名：CORE/SOUND 可用 `FX_CAPS` 读「粒子与 bloom 上限」 */
export const FX_CAPS = {
  particlesPerBurst: QUALITY_CAPS.particlesPerBurstMax,
  particlesLiveMax: QUALITY_CAPS.particlesLiveMax,
  bloomIntensity: QUALITY_CAPS.bloomIntensityMax,
  bloomLayers: QUALITY_CAPS.bloomLayersMax
};

let qualityOverride = null;

/** 运行时切档（W-16 降级开关 / 设置项用）。传 null 复位到默认档。 */
export function setQuality(name) {
  if (name === null) {
    qualityOverride = null;
    return quality();
  }
  if (!QUALITY_PRESETS[name]) throw new Error(`[theme] unknown quality preset: ${name}`);
  qualityOverride = name;
  return quality();
}

/** 取当前档（已 clamp 到硬上限，越界即被削减） */
export function quality(name = qualityOverride || DEFAULT_QUALITY) {
  const p = QUALITY_PRESETS[name];
  if (!p) throw new Error(`[theme] unknown quality preset: ${name}`);
  return clampQuality(name, p);
}

/** 越界裁剪（纯函数，断言直接调用它验证「上限第一天就写死」） */
export function clampQuality(name, p) {
  const out = {
    ...p,
    name,
    clamped: false,
    clampNotes: []
  };
  const cap = (key, max) => {
    if (typeof out[key] === 'number' && out[key] > max) {
      out[key] = max;
      out.clamped = true;
      out.clampNotes.push(`${key}>${max}`);
    }
  };
  cap('particlesPerBurst', QUALITY_CAPS.particlesPerBurstMax);
  cap('particlesLiveMax', QUALITY_CAPS.particlesLiveMax);
  cap('bloomIntensity', QUALITY_CAPS.bloomIntensityMax);
  cap('bloomLayers', QUALITY_CAPS.bloomLayersMax);
  cap('parallaxLayers', QUALITY_CAPS.parallaxLayersMax);
  cap('shakeMaxPx', QUALITY_CAPS.shakeMaxPx);
  return out;
}

// ---------------------------------------------------------------------------
// 7 · buildView：把比例换算成像素（上下层唯一的几何来源，杜绝两处各算各的）
// ---------------------------------------------------------------------------

const r2 = (n) => Math.round(n * 100) / 100;
/** 拍长与速率必须比像素多留几位：否则 view.pxPerSec ≠ view.pxPerBeat / view.beatSec（差到 0.8%，
 *  秒域回退公式与拍域就会在 4 拍窗上偏出 1px 级）。像素量用 r2 足够，速率量用 r6。 */
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * @param {number} width  画布逻辑宽（CSS px）
 * @param {number} height 画布逻辑高
 * @param {object} [opts]
 * @param {number} [opts.bpm=110] 关卡通用拍速（仅用于默认 pxPerSec）
 * @param {number} [opts.beatSec] 直接给拍长秒
 * @param {(tSec:number)=>number} [opts.timeToBeat] clock.beatAt —— 存在时 view 可换算拍域
 * @param {(beat:number)=>number} [opts.beatToTime] clock.timeAtBeat —— 存在时可换算秒域
 * @param {Partial<typeof SIZES>} [opts.sizes]
 * @param {Partial<typeof FONT_TIERS>} [opts.font]
 * @param {Record<string,number>} [opts.fontPx]
 * @param {Partial<typeof VIEW_RATIOS>} [opts.ratios] physics.js 可注入覆盖（不改值只转发）
 * @param {number} [opts.dpr] 仅记录，供截图端用
 */
export function buildView(width, height, opts = {}) {
  // 允许三种调用：buildView(1920,1080,opts) / buildView({width,height,...}) / buildView({w,h,...})
  // 后者是为了兼容 CORE 的 physics.js 视口形状（{w,h}），避免集成时出现两种 view 口径。
  const src = width && typeof width === 'object' ? { ...width, ...opts } : opts;
  const W = Math.max(1, Number(width && typeof width === 'object' ? width.w || width.width : width) || Number(src.w) || DESIGN_BASE.width);
  const H = Math.max(1, Number(height && typeof height === 'object' ? height.h || height.height : height) || Number(src.h) || DESIGN_BASE.height);
  // 字形/线宽缩放系数：与 physics.uiScale 同式 = min(W/1920, H/1080)（非 16:9 时不越界）
  const hs = Math.min(W / DESIGN_BASE.width, H / DESIGN_BASE.height);
  const ratios = { ...VIEW_RATIOS, ...(src.ratios || {}) };

  const hudH = H * ZONE_RATIOS.hud;
  const worldH = H * ZONE_RATIOS.world;
  const timelineH = H * ZONE_RATIOS.timeline;
  const worldTop = hudH;
  const worldBottom = hudH + worldH;
  const timelineTop = worldBottom;
  const timelineMidY = timelineTop + timelineH / 2;
  const pxPerBeat = W * ratios.pxPerBeat;
  const beatSec = src.beatSec != null ? Number(src.beatSec) : 60 / (src.bpm || 110);
  const pxPerSec = pxPerBeat / beatSec;
  const laneGap = timelineH * TIMELINE_CFG.laneBottomOffset;

  const fontBase = { ...FONT_TIERS, ...(src.font || {}) };
  const fontPx = {};
  for (const [k, v] of Object.entries(fontBase)) {
    fontPx[k] = Math.max(Math.round((v * hs) / 2) * 2, FONT_MIN_PX);
  }
  const playerH = H * ratios.charH; // 角色高 = physics.AUX.charH × H（弹幕间隙口径的基准）

  return {
    version: THEME_VERSION,
    width: r2(W),
    height: r2(H),
    designScale: r2(hs),
    dpr: src.dpr != null ? Number(src.dpr) : 1,
    zones: {
      hudTop: 0,
      hudHeight: r2(hudH),
      worldTop: r2(worldTop),
      worldHeight: r2(worldH),
      worldBottom: r2(worldBottom),
      timelineTop: r2(timelineTop),
      timelineHeight: r2(timelineH)
    },
    dividerYs: [r2(hudH), r2(worldBottom)],
    /** 世界可读区（OBS-03 的 4 拍预告窗）：判定线 → 出生线。其右侧只画背景。 */
    worldWindow: {
      x0: r2(W * ratios.judgeX),
      x1: r2(W * ratios.judgeX + pxPerBeat * LEAD_BEATS),
      pxPerBeat: r2(pxPerBeat)
    },
    judgeX: r2(W * ratios.judgeX),
    groundY: r2(H * ratios.groundY),
    /** 出生/入画 x = 判定线 + 4 拍（OBS-03：与下层时间轴可见窗右界同列） */
    rightSpawnX: r2(W * ratios.judgeX + pxPerBeat * LEAD_BEATS),
    pxPerBeat: r2(pxPerBeat),
    pxPerSec: r6(pxPerSec),
    beatSec: r6(beatSec),
    bpm: r6(60 / beatSec),
    leadBeats: LEAD_BEATS,
    leadPx: r2(pxPerBeat * LEAD_BEATS),
    timeToBeat: typeof src.timeToBeat === 'function' ? src.timeToBeat : null,
    beatToTime: typeof src.beatToTime === 'function' ? src.beatToTime : null,
    ratios,
    lanes: {
      kick: r2(timelineMidY + laneGap),
      bass: r2(timelineMidY),
      synth: r2(timelineMidY - laneGap),
      order: TIMELINE_CFG.laneOrder.slice(),
      timelineMidY: r2(timelineMidY),
      gap: r2(laneGap),
      markerH: r2(Math.min(SIZES.timelineMarkerH * hs, timelineH * 0.18)),
      markerW: r2(Math.min(SIZES.timelineMarkerH * hs, timelineH * 0.18))
    },
    /** 时间轴带中线（假节拍标记等「无归属泳道」元素的落点） */
    timelineMidY: r2(timelineMidY),
    /** W-06 对齐虚线的基准 x（与判定线同值；留独立字段是为了能单独断言「两者必须相等」） */
    guideX: r2(W * ratios.judgeX),
    sizes: {
      spike: { w: r2(SIZES.spike.w * hs), h: r2(SIZES.spike.h * hs) },
      platform: { w: r2(SIZES.platform.w * hs), h: r2(SIZES.platform.h * hs) },
      barrage: { w: r2(SIZES.barrage.w * hs), h: r2(SIZES.barrage.h * hs) },
      player: { w: r2(playerH * SIZES.player.w / SIZES.player.h), h: r2(playerH) },
      charH: r2(playerH),
      barrageGapMin: r2(playerH * BACKGROUND_CFG.gapToCharH),
      judgeLineWidth: r2(Math.max(1, SIZES.judgeLineWidth * hs)),
      groundLineWidth: r2(Math.max(1, SIZES.groundLineWidth * hs))
    },
    spawnFadeBeats: MOTION.spawnFadeBeats,
    pulseDecayBeats: MOTION.edgePulseBeats,
    timeline: { ...TIMELINE_CFG },
    platformTierY: ratios.platformTiers.map((t) => r2(H * ratios.groundY - H * t)),
    fontPx,
    fontFamily: FONT_FAMILY,
    quality: opts.quality ? quality(opts.quality) : quality()
  };
}

/** 已是 view？（鸭子判定，避免重复换算） */
export function isView(v) {
  return !!v && typeof v.judgeX === 'number' && typeof v.pxPerBeat === 'number' && !!v.zones;
}

/** view 或 {width,height,...} → 归一化 view（幂等：真 view 原样返回） */
export function resolveView(v) {
  if (isView(v)) return v;
  const src = v || {};
  return buildView(src.width, src.height, src);
}

// ---------------------------------------------------------------------------
// 7b · 拍 ↔ 像素的唯一换算口径（上下层都调它，从根上杜绝「两条线不同 x」）
// ---------------------------------------------------------------------------

/** 由 view（或任意 {pxPerBeat,beatSec,pxPerSec}）取 pxPerSec */
export function pxPerSecOf(viewOrPxPerSec, beatSec) {
  if (typeof viewOrPxPerSec === 'number') {
    return beatSec != null ? viewOrPxPerSec / beatSec : 0;
  }
  const v = viewOrPxPerSec || {};
  if (typeof v.pxPerSec === 'number' && v.pxPerSec > 0) return v.pxPerSec;
  if (typeof v.pxPerBeat === 'number' && typeof v.beatSec === 'number' && v.beatSec > 0) {
    return v.pxPerBeat / v.beatSec;
  }
  throw new Error('[theme] pxPerSecOf: need view.pxPerSec or view.pxPerBeat + view.beatSec');
}

/**
 * 判定线基准偏移：距「现在」N 拍 → 屏幕 x（正 = 未来 = 判定线右侧）。
 * 上下层共用（TIM-02 按拍等距 + OBS-03 上下层 4 拍同像素，由此函数天然成立）。
 */
export function beatOffsetX(view, beatsFromNow) {
  return r2(view.judgeX + beatsFromNow * view.pxPerBeat);
}

/** 秒 → 拍：优先用 view.timeToBeat（= clock.beatAt，支持变速），否则按当前拍长等速回退 */
export function timeToBeatOf(view, tSec) {
  if (view && typeof view.timeToBeat === 'function') return view.timeToBeat(tSec);
  const beatSec = view && view.beatSec > 0 ? view.beatSec : 1;
  return tSec / beatSec;
}

/** 拍 → 秒：优先 view.beatToTime（= clock.timeAtBeat），否则等速 */
export function beatToTimeOf(view, beat) {
  if (view && typeof view.beatToTime === 'function') return view.beatToTime(beat);
  const beatSec = view && view.beatSec > 0 ? view.beatSec : 1;
  return beat * beatSec;
}

/**
 * CSS token 单一真相：DOM 界面（CORE 的 src/ui/**）用 var(--rb-*)，值来自这里。
 * 覆盖 CSS 时须与本表逐值一致（screenshotCheck 会做 --css 比对）。
 */
export function cssTokens() {
  const p = quality();
  const out = {};
  for (const [k, v] of Object.entries(COLORS)) out[`--rb-${k}`] = v.hex;
  for (const [k, v] of Object.entries(DERIVED)) out[`--rb-${k}`] = v.hex;
  for (const [k, v] of Object.entries(TRACK_HEX)) {
    out[`--rb-track-${k}`] = v;
    out[`--rb-marker-${k}`] = markerHex(k);
    out[`--rb-shape-${k}`] = SHAPE_BY_TRACK[k];
  }
  for (const [k, v] of Object.entries(ZONE_RATIOS)) out[`--rb-zone-${k}`] = String(v);
  for (const [k, v] of Object.entries(VIEW_RATIOS)) {
    out[`--rb-ratio-${k}`] = Array.isArray(v) ? v.join(' ') : String(v);
  }
  for (const [k, v] of Object.entries(FONT_TIERS)) out[`--rb-font-${k}`] = `${v}px`;
  out['--rb-font-family'] = FONT_FAMILY;
  out['--rb-particles-per-burst'] = String(p.particlesPerBurst);
  out['--rb-particles-live-max'] = String(p.particlesLiveMax);
  out['--rb-bloom-intensity'] = String(p.bloomIntensity);
  out['--rb-quality'] = p.name;
  return out;
}

export default {
  THEME_VERSION,
  COLORS,
  DERIVED,
  TRACKS,
  TRACK_COLOR,
  TRACK_HEX,
  SHAPE_BY_TRACK,
  TONE_BY_TRACK,
  LUMA_BY_TRACK,
  GRAY_CONTRAST_MIN,
  ZONE_RATIOS,
  VIEW_RATIOS,
  SIZES,
  ALPHA,
  FONT_TIERS,
  MOTION,
  QUALITY_CAPS,
  QUALITY_PRESETS,
  DEFAULT_QUALITY,
  buildView,
  cssTokens
};
