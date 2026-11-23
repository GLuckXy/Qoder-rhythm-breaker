// .agent/e2e/missProbe.mjs — Owner: leader
// 目的：contractTest 的 misstorm case 在不同命中策略下给出 51 与 101 两个数，必须判定放大发生在哪一段。
// 本脚本不读 contractTest，自己按 LevelRuntime 的接线重放一整局，并输出：
//   · 每个障碍产生的「有惩罚判定」条数直方图（>1 就是重复计账 = 风暴）
//   · 事件流与每次命中的返回值
// 用法：node .agent/e2e/missProbe.mjs [levelId] [core|head] [命中数]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const LV = Number(process.argv[2] || 1);
const MODE = process.argv[3] || 'head';
const N = Number(process.argv[4] || 4);

const MC = await imp('src/mocks/MockClock.js');
const JS = await imp('src/game/systems/JudgeSystem.js');
const DS = await imp('src/game/systems/DisassembleSystem.js');
const PG = await imp('src/game/systems/PatternGenerator.js');
const cfg = JSON.parse(readFileSync(join(ROOT, 'src/data/levels', `level${LV}.json`), 'utf8'));

const clock = new MC.MockClock({ t: 0 });
clock.init({ bpm: cfg.bpm, sections: cfg.sections, tempoChanges: cfg.tempoChanges, introBeats: cfg.introBeats, lengthBeats: cfg.lengthBeats });
clock.start(0);
const instances = PG.build(cfg, clock);
const events = new JS.EventLog();
const judge = JS.createJudgeSystem({ clock, events });
const ds = DS.createDisassembleSystem({ clock, events });
judge.setWindowScale(Number(cfg.windowScale) || 1);
ds.load(cfg, { instances });
ds.bindJudge(judge);
judge.registerObstacles(instances);
ds.attach();

const feed = [];
judge.onJudgment((j) => { feed.push(j); ds.onJudgment(j); });
const trace = [];
for (const n of ['hp-change', 'disassemble', 'revive', 'state-change']) {
  ds.on(n, (p) => trace.push(`t=${clock.time().toFixed(2)} ${n} ${JSON.stringify(p).slice(0, 130)}`));
}
// ★ 与 LevelRuntime._onDisassemble / _onRevive 完全同构的队列重同步
ds.on('disassemble', () => judge.syncObstacles(ds.activeInstances()));
ds.on('revive', () => judge.syncObstacles(ds.activeInstances()));

const live = instances.filter((o) => o.judgable !== false).sort((a, b) => a.timeSec - b.timeSec);
const end = clock.timeAtBeat(Number(cfg.lengthBeats) || 0) + 1.5;
let ptr = 0; let hits = 0; const rets = [];
let peakPending = 0; let peakQueue = 0;
while (clock.time() < end) {
  clock.advanceBy(0.025);
  if (MODE === 'all') {
    // 全命中玩家：直接从判定队列取（能看到 revive 下发的 -rvN 新实例，静态 live 数组看不到）
    for (const o of judge.pendingList()) {
      if (o.timeSec <= clock.time() + 0.001 && o.timeSec > clock.time() - 0.06) {
        hits += 1;
        const r = judge.onInput(JS.expectedAction(o.type), o.timeSec);
        if (hits <= N) rets.push(`#${hits} ${o.id} t=${o.timeSec.toFixed(3)} core=${!!o.core} → ${r ? `${r.grade}/${r.rule}` : String(r)}`);
      }
    }
    ptr = live.length;
  }
  while (ptr < live.length && live[ptr].timeSec <= clock.time() + 0.001) {
    const o = live[ptr];
    const want = hits < N && (MODE !== 'core' || o.core === true);
    if (want) {
      hits += 1;
      const r = judge.onInput(JS.expectedAction(o.type), o.timeSec);
      rets.push(`#${hits} ${o.id} t=${o.timeSec.toFixed(3)} core=${!!o.core} → ${r ? `${r.grade}/${r.rule}` : String(r)}`);
    }
    ptr += 1;
  }
  peakPending = Math.max(peakPending, judge.pendingCount());
  peakQueue = Math.max(peakQueue, judge.pendingList().length);
}
rets.forEach((l) => console.log('  命中 ' + l));
const penalized = feed.filter((j) => j.penalizes !== false && j.rule !== 'emptyBeat');
const perId = new Map();
for (const j of penalized) perId.set(j.obstacleId, (perId.get(j.obstacleId) || 0) + 1);
const hist = {};
for (const n of perId.values()) hist[n] = (hist[n] || 0) + 1;
const st = ds.stats();
console.log(`模式=${MODE} 命中数=${N} · 可判=${live.length} pending峰值=${peakPending} 队列峰值=${peakQueue}`);
console.log('stats', JSON.stringify({ state: st.state, total: st.total, perfect: st.perfect, good: st.good, miss: st.miss, dotMiss: st.dotMiss, hp: st.hp, dis: st.disassembledTracks }));
console.log('有惩罚判定条数', penalized.length, '· 涉及不同障碍', perId.size, '· 每障碍条数直方图', JSON.stringify(hist));
const dup = [...perId.entries()].filter(([, c]) => c > 1).slice(0, 6);
console.log('重复计账样例', JSON.stringify(dup));
console.log('事件流（前 18 条）');
trace.slice(0, 18).forEach((l) => console.log('  ' + l));
