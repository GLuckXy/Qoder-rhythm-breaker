// src/game/scenes/LevelScene.js — Owner: CORE（K-05 · ★薄编排层，硬上限 250 行）
// 这里只允许存在：Phaser 场景胶水 + 画布上的只读文字。编排逻辑全在 LevelRuntime.js，
// hp / 状态机在 DisassembleSystem.js，窗口与匹配在 JudgeSystem.js（T3：超过 250 行就是违规）。
// 本文件不读时间（T4）：帧序取样只在 LevelRuntime.update 里做，且只用 clock.now()。
// 正式 HUD 与五界面属 R3 的 K-13；这里的文字只为 L-10 门禁提供可读证据。

import Phaser from 'phaser';
import WorldLayer from '../render/WorldLayer.js';
import LevelRuntime from './LevelRuntime.js';
import { BeatClock, JudgeSystem, DisassembleSystem, sharedEvents, soundEngine } from './appDeps.js';

const VOICE_LABEL = { kick: '鼓', bass: '贝斯', synth: '合成' };

export class LevelScene extends Phaser.Scene {
  constructor() {
    super('Level');
  }

  create(data = {}) {
    const cfg = data.cfg;
    if (!cfg || !Number.isFinite(Number(cfg.bpm))) {
      this.add.text(48, 48, '缺少关卡数据（请从标题进入）', { fontFamily: 'monospace', fontSize: '20px', color: '#ff4757' });
      return;
    }
    this.cfg = cfg;
    this.hud = this.add.text(48, 24, '', { fontFamily: 'monospace', fontSize: '20px', color: '#00f0ff' });
    this.logLine = this.add.text(48, this.scale.height - 44, '', { fontFamily: 'monospace', fontSize: '20px', color: '#e8ecf4' });
    this.result = this.add.text(this.scale.width * 0.5 - 180, this.scale.height * 0.32, '', {
      fontFamily: 'monospace',
      fontSize: '26px',
      color: '#ffd166'
    });

    this.runtime = new LevelRuntime({
      scene: this,
      clock: BeatClock,
      judge: JudgeSystem,
      ds: DisassembleSystem,
      events: sharedEvents,
      engine: soundEngine,
      world: new WorldLayer(),
      cfg,
      onEnd: (stats) => this.showResult(stats),
      onQuit: () => this.backToTitle({ notice: `L${cfg.id} 已退出` }),
      onLog: (text) => this.setLog(text)
    });
    this.runtime.create();
    this.setLog(`L${cfg.id} ${cfg.title || ''} · ${cfg.bpm}BPM`);

    // K-05：离场（回标题 / 关页面）与 R 重开共用同一张释放登记表
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
  }

  update() {
    if (!this.runtime) return;
    this.runtime.update();
    this.refreshHud();
  }

  refreshHud() {
    const ds = this.runtime.ds;
    const st = ds.stats();
    const hp = ['kick', 'bass', 'synth']
      .filter((t) => ds.hpMax(t) > 0)
      .map((t) => `${VOICE_LABEL[t]} ${'■'.repeat(ds.hp(t))}${'□'.repeat(Math.max(0, ds.hpMax(t) - ds.hp(t)))}`)
      .join('   ');
    this.hud.setText(
      [
        `${st.state}  beat ${this.runtime.clock.currentBeat().toFixed(2)}  combo ${st.combo}/${st.maxCombo}`,
        hp || '（本关无可拆解声部）',
        `Perfect ${(st.perfectRate * 100).toFixed(1)}%  P${st.perfect}/${st.total}  MISS ${st.miss}  重开 ${this.runtime.restarts}`
      ].join('\n')
    );
  }

  setLog(text) {
    if (this.logLine) this.logLine.setText(String(text || ''));
  }

  showResult(stats) {
    this.setLog('RESULT');
    this.result.setText(
      [
        `L${this.cfg.id} 结算 · 评级 ${stats.rank}`,
        `Perfect ${(stats.perfectRate * 100).toFixed(1)}%（${stats.perfect}/${stats.total}）`,
        `核心命中 ${(stats.coreHitRate * 100).toFixed(0)}% · 最高连击 ${stats.maxCombo} · MISS ${stats.miss}`,
        stats.disassembled ? '全声部已拆解 → 寂静' : '未拆完（分母不变）',
        '',
        'R 重开 · Q 回标题'
      ].join('\n')
    );
  }

  backToTitle(data = {}) {
    this.teardown();
    this.scene.start('Title', data);
  }

  /** ★ 统一 teardown：interval / 音源指针 / 监听 / Phaser 事件全释放。 */
  teardown(opt = {}) {
    if (!this.runtime) return 0;
    const left = this.runtime.listenerCount();
    this.runtime.shutdown(opt);
    this.runtime = null;
    return left;
  }

  /** selftest / DebugPanel 用：只读快照（world 的几何 + 拆解统计）。 */
  snapshot() {
    if (!this.runtime) return { ready: false };
    return {
      ready: true,
      level: this.cfg.id,
      restarts: this.runtime.restarts,
      world: this.runtime.world.snapshot(this.runtime.clock.now()),
      sound: this.runtime.engine.getStatus(),
      stats: this.runtime.ds.stats()
    };
  }
}

export default LevelScene;
