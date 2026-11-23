// src/game/scenes/appDeps.js — Owner: CORE（K-05 的依赖注入点）
// 为什么单独一个文件：`src/main.js` 与三个场景互相需要同一批单例（音频引擎、事件流、时钟、判定、
// 拆解系统）。若场景直接 import main.js 会形成循环依赖（main → scenes → main），rollup 下初始化顺序
// 不可靠。这里做「叶子」：所有人都只 import 本文件，main.js 也只 import 本文件，无环。
//
// 单例的归属不变：BeatClock / JudgeSystem / DisassembleSystem 仍是各自文件里的 C1/C2/C3 冻结单例。

import { BeatClock } from '../../audio/BeatClock.js';
import { EventLog, JudgeSystem } from '../systems/JudgeSystem.js';
import { DisassembleSystem } from '../systems/DisassembleSystem.js';
import { SoundEngine } from '../../audio/SoundEngine.js';

/** C7：判定、拆解、结算、回放共用同一份事件流（同一份真相）。 */
export const sharedEvents = JudgeSystem.events instanceof EventLog ? JudgeSystem.events : new EventLog();
DisassembleSystem.events = sharedEvents;

/** SOUND 名下（CR-11 批复进 C9）：全工程唯一 AudioContext 持有者，import 时零副作用。 */
export const soundEngine = new SoundEngine();

/**
 * K-13 界面层（DOM 覆盖层）的注册位：`main.js` 建好 UiLayer 后写进 `uiRef.current`，场景只读不建。
 * 走这个口子而不是 import main.js，理由与上面一样——避免 main ↔ scenes 的循环依赖。
 * 为 null 时（Node 契约测试 / 无 #ui-root 的环境）场景退回「画布文字」形态，流程不受影响。
 */
export const uiRef = { current: null };

export { BeatClock, JudgeSystem, DisassembleSystem };
