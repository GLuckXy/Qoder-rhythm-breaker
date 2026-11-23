// src/ui/tokens.js — Owner: CORE（CR-13：全项目除 theme.js / neon.css 外 0 处颜色字面量）
// 本文件是 **UI 与场景文字取色的唯一入口**：所有值都从 WORLD 名下的 C8 色板（`src/data/theme.js`）
// 或 neon.css 的 `--rb-*` token 派生，这里不写任何色值字面量（十六进制与函数式写法都不行）。
//
// CR-13 的 leader 批复把那支冷白登记成消色轴（base↔white）上的界面墨色 `COLORS.inkSoft` /
// `--rb-inkSoft`。WORLD 正在改 theme.js，所以这里按「有则用、无则回落 `--rb-ink` 的语义」取值：
// WORLD 补上 inkSoft 后本文件不用改一行，界面墨色自动跟着 theme.js 走（不会出现「画布白得不一样」）。

import { COLORS, DERIVED } from '../data/theme.js';

const has = (c, name) => c && c[name] && typeof c[name].hex === 'string';

/** 界面墨色（CR-13 登记前的冷白字面量，语义角色 = ink，不是第四种声部色）。 */
export const INK = has(COLORS, 'inkSoft') ? COLORS.inkSoft : COLORS.white;

/** 分区/面板底（消色差派生，theme.js 的 DERIVED 已登记）。 */
export const PANEL = has(DERIVED, 'bandHud') ? DERIVED.bandHud : COLORS.base;

/** 细线 / 分隔（同 DERIVED.divider）。 */
export const HAIRLINE = has(DERIVED, 'divider') ? DERIVED.divider : COLORS.system;

/** Phaser 文字样式只要 hex 字符串，这里统一成 `text()` 的取值口，避免各场景各写一份。 */
export function hexOf(token) {
  return token && typeof token.hex === 'string' ? token.hex : COLORS.white.hex;
}

/** CSS 侧用 var()，DOM 界面（K-13）一律走这个函数拼样式。 */
export const cssVar = (name) => `var(--rb-${name})`;

export const INK_HEX = hexOf(INK);
export const PANEL_HEX = hexOf(PANEL);
export const SYSTEM_HEX = hexOf(COLORS.system);
export const KICK_HEX = hexOf(COLORS.kick);
export const BASS_HEX = hexOf(COLORS.bass);
