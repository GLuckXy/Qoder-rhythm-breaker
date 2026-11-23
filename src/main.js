// src/main.js — Owner: CORE (K-03/R1). leader 的 D0 占位实现，CORE 在 R1 必须整体替换为：
//   Phaser 启动 + BootScene/TitleScene/LevelScene + ?selftest=audio|render 路由 + DOM 界面挂载。
import Phaser from 'phaser';

class PlaceholderScene extends Phaser.Scene {
  constructor() {
    super('Placeholder');
  }
  create() {
    this.add.text(40, 40, 'Rhythm Breaker · scaffold D0', {
      fontFamily: 'monospace',
      fontSize: '24px',
      color: '#00f0ff'
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

game.events.once('destroy', () => {});
