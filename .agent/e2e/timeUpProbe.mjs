// .agent/e2e/timeUpProbe.mjs — Owner: leader
// 假设：LevelRuntime.start() 的调用顺序是 ds.attach() → clock.start(atSec)，
//       而 ds.attach() 用 clock.schedule(_finalize, timeAtBeat(lengthBeats)) 注册「关卡终点」，
//       BeatClock.start() 内部 `this._queue.length = 0` 会把这条注册**清空** → 关卡永不收口 → 结算屏不出现。
//       Node 门禁抓不到，因为 contractTest 的 buildRig 是 clock.start(0) 在 ds.attach() **之前**。
// 本脚本不改产品码，只用真 BeatClock（manual 模式）把两种顺序各跑一遍，看 _finalize 到底有没有触发。
// 用法：node .agent/e2e/timeUpProbe.mjs [levelId]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const LV = Number(process.argv[2] || 1);

const BC = await imp('src/audio/BeatClock.js');
const JS = await imp('src/game/systems/JudgeSystem.js');
const DS = await imp('src/game/systems/DisassembleSystem.js');
const PG = await imp('src/game/systems/PatternGenerator.js');
const cfg = JSON.parse(readFileSync(join(ROOT, 'src/data/levels', `level${LV}.json`), 'utf8'));

function makeClock() {
  const holder = { t: 0 };
  const clock = BC.createBeatClock({ manual: true, now: () => holder.t });
  clock._holder = holder;
  clock.advanceBy = (dt) => {
    holder.t += dt;
    clock.tick();
  };
  return clock;
}

/** @param {'runtime'|'fixed'} order runtime = 照 LevelRuntime.start 的真实顺序 */
function run(order) {
  const clock = makeClock();
  clock.init({ bpm: cfg.bpm, sections: cfg.sections, tempoChanges: cfg.tempoChanges, introBeats: cfg.introBeats, lengthBeats: cfg.lengthBeats });
  const instances = PG.build(cfg, clock);
  const events = new JS.EventLog();
  const judge = JS.createJudgeSystem({ clock, events });
  const ds = DS.createDisassembleSystem({ clock, events });
  judge.setWindowScale(Number(cfg.windowScale) || 1);
  ds.load(cfg, { instances });
  ds.bindJudge(judge);

  let finalFired = false;
  const origAttach = ds.attach.bind(ds);
  ds.attach = () => { const r = origAttach(); return r; };

  judge.onJudgment((j) => ds.onJudgment(j));
  ds.on('disassemble', () => judge.syncObstacles(ds.activeInstances()));
  ds.on('revive', () => judge.syncObstacles(ds.activeInstances()));
  ds.on('state-change', (p) => { if (p.to === 'RESULT') finalFired = true; });

  const LEAD = 0.35;
  if (order === 'runtime') {
    // LevelRuntime.start 的真实顺序：… ds.attach → judge.register → engine.loadLevel → clock.start → engine.arm
    ds.attach();
    judge.registerObstacles(instances);
    clock.start(clock.now() + LEAD);
  } else {
    // 修正顺序：先起钟，再让 ds 注册终点
    clock.start(clock.now() + LEAD);
    ds.attach();
    judge.registerObstacles(instances);
  }
  const endSec = clock.timeAtBeat(Number(cfg.lengthBeats)) + 3;
  while (clock.now() < endSec) clock.advanceBy(0.025);
  return { order, queueSize: clock.queueSize(), finalFired, dsState: ds.state(), now: +clock.now().toFixed(2), endSec: +clock.timeAtBeat(Number(cfg.lengthBeats)).toFixed(2) };
}

for (const o of ['runtime', 'fixed']) {
  const r = run(o);
  console.log(`${r.order === 'runtime' ? 'LevelRuntime 现顺序（attach→start）' : '起钟在前（start→attach）'}：` +
    ` 终点是否收口=${r.finalFired} 终态=${r.dsState} 队列残留=${r.queueSize} 跑到 now=${r.now}（终点应在 ${r.endSec}）`);
}
