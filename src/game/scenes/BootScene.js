// src/game/scenes/BootScene.js — Owner: CORE（K-05 场景生命周期 · 第一站）
// 职责：① 建立「关卡数据入口」（六关 JSON 由 SOUND 维护，这里只做 vite glob 装载与可用清单）
//       ② 读存档里的校准值与严格模式（L-06 的降级版校准，落到 JudgeSystem 的两个 setter）
//       ③ 交给 TitleScene。不做任何与「何时」有关的计算（T4）。
//
// 为什么 glob 写在这里：`src/data/levels/*.json` 是 SOUND 名下内容，CORE 不新建 index.js（T2），
// 只在 CORE 名下的场景文件里做装载。缺文件 → 清单为空，TitleScene 会显示「无谱面」而不是崩。

import Phaser from 'phaser';
import { JudgeSystem } from '../systems/JudgeSystem.js';
import { getSave } from '../../data/save.js';

/** 懒加载器表：`level1.json … level6.json`（构建时按实际存在的文件生成，缺的不进产物）。 */
const LOADERS = import.meta.glob('../../data/levels/level*.json');

/** 已就位的关卡号（升序）。 */
export function availableLevelIds() {
  return Object.keys(LOADERS)
    .map((k) => Number(/level(\d+)\.json$/.exec(k)?.[1]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

/**
 * 读一关配置。缺文件返回 null（调用方负责呈现，不抛）。
 * @param {number|string} id
 * @returns {Promise<object|null>}
 */
export async function loadLevel(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  const key = Object.keys(LOADERS).find((k) => k.endsWith(`/level${n}.json`));
  if (!key) return null;
  try {
    const mod = await LOADERS[key]();
    return mod && mod.default ? mod.default : mod || null;
  } catch (err) {
    console.error(`[Boot] level${n}.json 装载失败（SOUND 名下内容，CORE 不修）：`, err);
    return null;
  }
}

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    const save = getSave();
    JudgeSystem.setLatency(Number(save.audio.latencyOffset) || 0);
    JudgeSystem.setStrictWindow(!!save.options.strictWindow);
    const ids = availableLevelIds();
    this.registry.set('levelIds', ids);
    this.add.text(40, 40, `Rhythm Breaker · Boot\n谱面就位：${ids.length ? `L${ids.join(' L')}` : '（无，SOUND 尚未交付）'}\n校准 ${save.audio.latencyOffset}ms · 严格窗口 ${save.options.strictWindow ? 'ON' : 'OFF'}`, {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#e8ecf4'
    });
    this.scene.start('Title');
  }
}

export default BootScene;
