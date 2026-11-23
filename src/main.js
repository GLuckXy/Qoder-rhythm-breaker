// src/main.js — Owner: CORE
// R1 阶段：仍是 D0 占位画面（R2 的 K-05/K-13 才换成 Boot/Title/Level + ?selftest= 路由）。
// 本轮唯一新增：把 CORE 的 R1 交付面（BeatClock 单例 + JudgeSystem 单例 + DebugPanel）
// 真正接进构建，使 K-03 的 verify=`build` 覆盖到这些模块，并让 leader 能在浏览器里
// 按 ` 或 D 或 ?debug=1 看到调试面板（时钟未 start，故显示 IDLE）。
import Phaser from 'phaser';
import { BeatClock } from './audio/BeatClock.js';
import { JudgeSystem } from './game/systems/JudgeSystem.js';
import { mountDebugPanel } from './ui/DebugPanel.js';

class PlaceholderScene extends Phaser.Scene {
  constructor() {
    super('Placeholder');
  }

  create() {
    // 注意：这里只显示「画面存在」，不做任何与「何时」有关的计算（T4）。
    this.add.text(40, 40, 'Rhythm Breaker · R1（契约与纯函数）', {
      fontFamily: 'monospace',
      fontSize: '24px',
      color: '#00f0ff'
    });
    this.add.text(40, 78, '权威时钟未启动 · 按 ` 或 D 打开调试面板 · node tools/contractTest.mjs --all', {
      fontFamily: 'monospace',
      fontSize: '16px',
      color: '#e8ecf4'
    });
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-root',
  backgroundColor: '#0a0e1a',
  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH, width: 1280, height: 720 },
  scene: [PlaceholderScene]
});

export const debugPanel = mountDebugPanel({ clock: BeatClock, judge: JudgeSystem });

game.events.once('destroy', () => {
  debugPanel.destroy();
});
