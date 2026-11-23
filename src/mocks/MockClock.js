// src/mocks/MockClock.js — Owner: CORE（K-01 交付物之一）
// 与 BeatClock **完全同构**的手动时钟：同一个 BeatClockCore，只是时间源由外部推进。
// 用途：WORLD / SOUND 在 Node 里离线开发自验（判定、排程、谱面时刻换算），不需要浏览器、
// 不需要 AudioContext、不需要 requestAnimationFrame。
//
// 用法：
//   import { MockClock } from '../mocks/MockClock.js';
//   const clock = new MockClock();
//   clock.init({ bpm: 120, sections: [...], tempoChanges: [...], introBeats: 4 });
//   clock.start(0);                    // 第 0 拍钉在 t=0
//   clock.onEvent(e => log.push(e));
//   clock.advanceTo(3.2);              // 推进到权威时刻 3.2s，按绝对时刻升序派发所有到期项
//   clock.advanceBy(0.025);            // 步长推进（模拟 25ms 轮询）
// 语义与 BeatClock 一致：派发允许提前 ≤120ms（CLOCK_LOOKAHEAD_SEC）。

import { BeatClockCore, CLOCK_LOOKAHEAD_SEC, CLOCK_POLL_MS, CLOCK_STATES } from '../audio/BeatClock.js';

export class MockClock extends BeatClockCore {
  /** @param {{t?:number, leadSec?:number}} [opts] 起始权威时刻与提前量 */
  constructor(opts = {}) {
    const holder = { t: Number.isFinite(opts.t) ? opts.t : 0 };
    super({ manual: true, now: () => holder.t, leadSec: opts.leadSec });
    this._holder = holder;
  }

  /** 手动模式恒为 ready，方便离线断言。 */
  ready() {
    return true;
  }

  unlock() {
    return Promise.resolve(true);
  }

  /** 当前手动时间（秒）。 */
  time() {
    return this._holder.t;
  }

  /** 绝对推进到某个权威时刻（不会倒退），并派发到期项。 */
  advanceTo(tSec) {
    const t = Number(tSec);
    if (!Number.isFinite(t)) throw new TypeError('[MockClock] advanceTo 需要一个数值时刻');
    if (t > this._holder.t) {
      this._holder.t = t;
      this.tick();
    }
    return this;
  }

  /** 相对推进 dt 秒。 */
  advanceBy(dt) {
    return this.advanceTo(this._holder.t + dt);
  }

  /**
   * 重开语义与 BeatClock 对齐：`start(atSec)` 把第 0 拍钉在 atSec（C1），**手动时间源同步回到 atSec**。
   * BeatClock 侧的墙钟由 AudioContext 提供、原点换了时间就换；MockClock 的时间源是 holder.t，
   * 不回零的话第二次起跑一进来就落在关卡终点之后，整局 0 判定（K-05 的 20 次重开基线就是抓它）。
   * 不带参数时保持 BeatClock 的 `now()+0.1` 缺省，不去动 holder。
   */
  start(atSec) {
    const t = Number(atSec);
    if (Number.isFinite(t)) this._holder.t = t;
    return super.start(atSec);
  }

  /** 按 stepSec 步长推进 n 步（模拟逐帧/逐轮询）。 */
  advanceSteps(n, stepSec = CLOCK_POLL_MS / 1000) {
    for (let i = 0; i < n; i += 1) this.advanceBy(stepSec);
    return this;
  }

  /** 直接跑一次派发（不推进时间）。 */
  flush() {
    this.tick();
    return this;
  }

  /** init + start(0) 的便利组合，离线开发一行起关。 */
  loadAndStart(spec = {}) {
    this.init(spec);
    this.start(0);
    return this;
  }
}

/** 单例：给只需要一个离线时钟的消费者用。 */
export const mockClock = new MockClock();

export { CLOCK_LOOKAHEAD_SEC, CLOCK_POLL_MS, CLOCK_STATES };
export default mockClock;
