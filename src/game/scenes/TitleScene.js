// src/game/scenes/TitleScene.js — Owner: CORE（K-05 场景生命周期 · 标题）
// 「点击 = AudioContext 手势解锁」这一动作本身在 main.js 里绑（engine.unlockOnFirstGesture 需要
// pointerdown/keydown/touchstart 三选一，见 CR-11 批复第 2 点）；本场景只负责：
//   · 显示标题与可用关卡清单（L-10 的门禁要求「从标题走到 L1 结算」）
//   · 接受点击进入 / 数字键直达 → 预载该关 JSON 后 start('Level', {cfg})
// 时间一律不读（T4）：本文件没有任何与「何时」相关的计算。

import Phaser from 'phaser';
import { loadLevel, availableLevelIds } from './BootScene.js';

export class TitleScene extends Phaser.Scene {
  constructor() {
    super('Title');
  }

  create(data = {}) {
    const ids = availableLevelIds();
    this.lastNotice = data.notice || '';
    const lines = [
      '节奏拆解台 · Rhythm Breaker',
      '',
      ids.length ? `关卡：${ids.map((n) => `${n}`).join(' / ')}` : '尚无谱面（等 SOUND 的 level*.json）',
      '',
      '点击任意处 / 按 1-6 进入 · J 或 空格=跳 · K=冲 · R=重开 · Esc=暂停 · [ ]=校准',
      this.lastNotice
    ].filter(Boolean);
    this.label = this.add.text(48, 48, lines.join('\n'), {
      fontFamily: 'monospace',
      fontSize: '20px',
      color: '#e8ecf4',
      lineSpacing: 6
    });
    this._go = null;
    this.input.once('pointerdown', () => this.enter(ids[0] ?? 1));
    const DIGITS = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
    if (this.input.keyboard) {
      ids.forEach((n, i) => {
        const key = this.input.keyboard.addKey(DIGITS[Math.min(ids.length, i + 1) - 1]);
        if (key) key.on('down', () => this.enter(n));
      });
    }
  }

  /**
   * 进一关：先 await 谱面（避免 LevelScene.create 变 async），失败留在标题并提示。
   * @param {number} id
   */
  async enter(id) {
    if (this._go) return this._go;
    this._go = (async () => {
      const cfg = await loadLevel(id);
      if (!cfg) {
        this.label.setText(`节奏拆解台 · Rhythm Breaker\n\nlevel${id}.json 读不到（SOUND 名下内容）\n点击回可用关列表`);
        this._go = null;
        this.input.once('pointerdown', () => this.enter(availableLevelIds()[0] ?? 1));
        return false;
      }
      this.scene.start('Level', { cfg });
      return true;
    })();
    return this._go;
  }
}

export default TitleScene;
