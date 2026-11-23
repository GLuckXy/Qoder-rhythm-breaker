// tools/orderCheck.mjs — Owner: leader（第五道门禁）
// 守的是 DEF-03：`BeatClock.start()` 会 `this._queue.length = 0`，而 `DisassembleSystem.attach()`
// 正是用 `clock.schedule(_finalize, timeAtBeat(lengthBeats))` 注册「关卡终点」。
// 顺序写反（attach 在 start 之前）时，四道 Node 门禁全绿、判定/拆解/寂静都正常，
// **但游戏在真实浏览器里永远走不到结算屏**——这是 2026-11-23 无头 Edge 实测抓到的发布阻断缺陷。
//
// 本门禁做两件事，缺一不可：
//   ① 静态钉住 LevelRuntime.start() 的内部顺序（被测时序一旦漂移，仿真就失去意义，所以先钉住）；
//   ② 用**真 BeatClock**（manual 模式，非 MockClock）按该顺序起一关，跑到 lengthBeats 之后断言进 RESULT。
//      六关全跑。旧顺序下 ② 必然红（`.agent/e2e/timeUpProbe.mjs` 留了红样）。
//
// 用法：node tools/orderCheck.mjs [--json] [--lv=1]
// 约定（与其余门禁一致）：最后一行打印 `RESULT: PASS <统计>` 或 `RESULT: FAIL <第一个失败断言>`。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const ONLY = argv.find((a) => a.startsWith('--lv='));
const LEVELS = ONLY ? [Number(ONLY.slice(5))] : [1, 2, 3, 4, 5, 6];

const fails = [];
let checks = 0;
function ok(label, cond, detail = '') {
  checks += 1;
  if (!cond && !fails.length) fails.push(`${label} — ${detail || '条件不成立'}`);
  return cond;
}

/* ---------------- ① 静态顺序 ---------------- */

function methodBody(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return null;
  let depth = 0;
  let started = false;
  for (let j = src.indexOf('{', i); j < src.length; j += 1) {
    if (src[j] === '{') { depth += 1; started = true; }
    if (src[j] === '}') depth -= 1;
    if (started && depth === 0) return src.slice(i, j + 1);
  }
  return null;
}

const runtimeSrc = readFileSync(join(ROOT, 'src/game/scenes/LevelRuntime.js'), 'utf8');
const startBody = methodBody(runtimeSrc, '  start() {');
if (!startBody) {
  fails.push('LevelRuntime.start() 方法体没找到 — 结构变了，请同步本门禁');
} else {
  const at = (needle) => startBody.indexOf(needle);
  const iStart = at('this.clock.start(');
  const iAttach = at('this.ds.attach()');
  const iReg = at('this.judge.registerObstacles(');
  const iArm = at('this.engine.arm(');
  ok('order: start() 里有 clock.start(', iStart >= 0, `iStart=${iStart}`);
  ok('order: ds.attach() 在 clock.start() 之后（DEF-03）', iAttach >= 0 && iStart >= 0 && iAttach > iStart, `attach=${iAttach} start=${iStart}`);
  ok('order: registerObstacles 在 clock.start() 之后', iReg >= 0 && iReg > iStart, `register=${iReg} start=${iStart}`);
  ok('order: engine.arm 仍在 clock.start 之后（CR-11 不回退）', iArm >= 0 && iArm > iStart, `arm=${iArm} start=${iStart}`);
}

// 同时钉住「start 会清队列」这条前提：哪天 BeatClock 不清了，本门禁的顺序约束就退化成洁癖，
// 至少要让人意识到 DEF-03 的因果链变了。
const clockSrc = readFileSync(join(ROOT, 'src/audio/BeatClock.js'), 'utf8');
const startClock = methodBody(clockSrc, '  start(atSec) {') || '';
ok('order: BeatClock.start() 仍清空派发队列（DEF-03 的前提）', /_queue\.length\s*=\s*0/.test(startClock), '没找到 _queue.length = 0');

/* ---------------- ② 真 BeatClock 起关到结算 ---------------- */

const BC = await imp('src/audio/BeatClock.js');
const JS = await imp('src/game/systems/JudgeSystem.js');
const DS = await imp('src/game/systems/DisassembleSystem.js');
const PG = await imp('src/game/systems/PatternGenerator.js');

function makeClock() {
  const holder = { t: 0 };
  const clock = BC.createBeatClock({ manual: true, now: () => holder.t });
  clock.advanceBy = (dt) => {
    holder.t += dt;
    clock.tick();
  };
  return { clock, holder };
}

const LEAD = 0.35; // 与 LevelRuntime.START_LEAD_SEC 同值

for (const id of LEVELS) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(ROOT, 'src/data/levels', `level${id}.json`), 'utf8'));
  } catch (e) {
    ok(`L${id} 谱面可读`, false, e.message);
    continue;
  }
  const { clock, holder } = makeClock();
  clock.init({ bpm: cfg.bpm, sections: cfg.sections, tempoChanges: cfg.tempoChanges, introBeats: cfg.introBeats, lengthBeats: cfg.lengthBeats });
  const instances = PG.build(cfg, clock);
  const events = new JS.EventLog();
  const judge = JS.createJudgeSystem({ clock, events });
  const ds = DS.createDisassembleSystem({ clock, events });
  judge.setWindowScale(Number(cfg.windowScale) || 1);
  ds.load(cfg, { instances });
  ds.bindJudge(judge);
  judge.onJudgment((j) => ds.onJudgment(j));
  ds.on('disassemble', () => judge.syncObstacles(ds.activeInstances()));
  ds.on('revive', () => judge.syncObstacles(ds.activeInstances()));

  // ★ 严格照 LevelRuntime.start() 钉住的顺序
  const atSec = clock.now() + LEAD;
  clock.start(atSec);
  ds.attach();
  judge.registerObstacles(instances);

  const endSec = clock.timeAtBeat(Number(cfg.lengthBeats) || 0) + 3;
  let judged = 0;
  while (holder.t < endSec) {
    holder.t += 0.025;
    clock.tick();
    judged += 0; // 判定条数由 ds 侧统计，这里只推进时钟
  }
  const st = ds.stats();
  ok(`L${id}: 按 LevelRuntime 顺序起关能收口到 RESULT（DEF-03）`, ds.state() === 'RESULT', `终态=${ds.state()} now=${holder.t.toFixed(1)} 终点应在 ${endSec.toFixed(1)}`);
  ok(`L${id}: 收口前判定链确实在跑（不是空转到终点）`, st.total > 0, `total=${st.total}`);
  void judged;
}

/* ---------------- 输出 ---------------- */

if (JSON_OUT) {
  console.log(JSON.stringify({ tool: 'orderCheck', pass: fails.length === 0, stats: `${checks} 项 · ${LEVELS.length} 关`, fails }));
} else if (fails.length) {
  console.log(`orderCheck 失败 ${fails.length} 项：`);
  fails.forEach((f) => console.log('  ✗ ' + f));
}
if (fails.length) console.log(`RESULT: FAIL ${fails[0]}`);
else console.log(`RESULT: PASS ${checks} 项顺序与收口断言 · L${LEVELS.join('/')} 全部抵达结算`);
process.exitCode = fails.length ? 1 : 0;
