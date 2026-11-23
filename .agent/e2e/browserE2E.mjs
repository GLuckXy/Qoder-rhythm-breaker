// .agent/e2e/browserE2E.mjs — Owner: leader（编排者的取证工具，不属于 CORE/WORLD/SOUND 任何独占域）
// 目的：在真实浏览器内核里把游戏从「打开页面」跑到「结算」，产出 console 证据 + 截图 +
//       ?selftest=render 负载（喂给 tools/screenshotCheck.mjs --selftest）。
// 为什么不用 src 里的工具：agents 不许 npm i，也不许装测试依赖（C10 白名单）。这里只用
// Node 24 自带能力（child_process + 全局 fetch/WebSocket）走 CDP，驱动本机 Edge headless。
//
// 用法：node .agent/e2e/browserE2E.mjs [--url=http://127.0.0.1:4174/] [--lv=1]
//                                     [--secs=100] [--out=.agent/e2e] [--cdp-keys]

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const URL_BASE = flag('url', 'http://127.0.0.1:4174/');
const LV = Number(flag('lv', 1));
const SECS = Number(flag('secs', 100));
const OUT = resolve(flag('out', '.agent/e2e'));
const PORT = Number(flag('port', 9333));
const CDP_KEYS = argv.includes('--cdp-keys');

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const EXE = BROWSERS.find((p) => existsSync(p));
if (!EXE) die('找不到 Edge/Chrome，无法做浏览器实测');

mkdirSync(OUT, { recursive: true });
const profile = join(tmpdir(), `rb-e2e-${Date.now()}`);
const consoleLines = [];
const errors = [];
const netFails = [];

// ---------------------------------------------------------------- CDP client
let ws, mid = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function rpc(method, params = {}) {
  return send(method, params).catch((e) => {
    throw new Error(`${method}: ${e.message}`);
  });
}
async function ev(expression, { awaitPromise = false, timeoutMs = 30000 } = {}) {
  const r = await rpc('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  void timeoutMs;
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  console.error('!! ' + msg);
  process.exitCode = 1;
  throw new Error(msg);
}

// ---------------------------------------------------------------- launch
console.log(`· 启动 headless 浏览器：${EXE}`);
const child = spawn(EXE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1280,720',
  '--no-first-run', '--no-default-browser-check', '--disable-translate',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  // 后台节流会把 rAF 饿死（实跑过 fps≈0、 Phaser update 不跑 → SILENCE→RESULT 的 timeUp 永不触发，
  // 于是「结算屏不出现」被误判成游戏缺陷）。这四条让无头窗口始终保持前台语义。
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch { /* noop */ } });

let target = null;
for (let i = 0; i < 60 && !target; i += 1) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* 还没起监听 */ }
}
if (!target) die('CDP 端点未就绪');

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws: ' + e.type)); });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    consoleLines.push(`${msg.params.type}: ${txt}`);
    if (msg.params.type === 'error') errors.push(`console.error: ${txt}`);
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error') errors.push(`${e.source}: ${e.text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push('uncaught: ' + (d.exception?.description || d.text));
  }
  if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
    netFails.push(`${msg.params.response.status} ${msg.params.response.url}`);
  }
  if (msg.method === 'Network.loadingFailed') netFails.push(`FAILED ${msg.params.errorText} ${msg.params.type}`);
};

await rpc('Page.enable');
await rpc('Runtime.enable');
await rpc('Log.enable');
await rpc('Network.enable');
// 再补一层协议侧的「永远在前台」，与启动参数双保险（无头窗口的可见性默认是 hidden）
await rpc('Emulation.setFocusEmulationEnabled', { enabled: true }).catch((e) => console.log('· focus 仿真不可用：' + e.message));
await rpc('Page.setWebLifecycleState', { state: 'active' }).catch((e) => console.log('· 生命周期设定不可用：' + e.message));

// ---------------------------------------------------------------- boot
console.log(`· 导航 ${URL_BASE}`);
await rpc('Page.navigate', { url: URL_BASE });
for (let i = 0; i < 40; i += 1) {
  const ok = await ev('!!(window.__CORE__ && window.__CORE__.game && window.__CORE__.game.isRunning)');
  if (ok) break;
  await sleep(500);
}
const booted = await ev('!!(window.__CORE__ && window.__CORE__.game && window.__CORE__.game.isRunning)');
if (!booted) die('页面未进入运行态（__CORE__ 不存在或 game.isRunning=false）');

const canvasInfo = await ev('(()=>{const c=document.querySelector("canvas");return {w:c?.width,h:c?.height,scenes:Object.keys(window.__CORE__.game.scene.getScenes(true).map(s=>s.key||"?")).join(",")||document.visibilityState}})()');
console.log(`· 已启动 canvas=${canvasInfo.w}x${canvasInfo.h} activeScenes=${canvasInfo.scenes}`);

async function shot(name) {
  const r = await rpc('Page.captureScreenshot', { format: 'png' });
  const p = join(OUT, name);
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log(`· 截图 ${p}`);
  return p;
}
await shot('01-title.png');

// ---------------------------------------------------------------- title → level
const titleDom = await ev('(()=>{const r=document.getElementById("ui-root");return {children:r?r.children.length:-1, text:(r?r.innerText:"").replace(/\\s+/g," ").slice(0,160)}})()');
console.log(`· 标题界面 ui-root 子节点=${titleDom.children} 文案「${titleDom.text}」`);

// 用真事件（trusted）点标题，顺带满足 AudioContext 的手势要求
const box = await ev('(()=>{const r=document.getElementById("ui-root");const el=r&&(r.querySelector("button,[role=button],.rb-cta,[data-action]")||r.firstElementChild);if(!el)return null;const b=el.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,w:b.width,tag:el.tagName}})()');
if (box && box.w > 0) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await rpc('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  console.log(`· 已点击标题按钮 ${box.tag} @${box.x.toFixed(0)},${box.y.toFixed(0)}`);
} else {
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
  console.log('· 标题无可点按钮，改用 Space 进入');
}
await sleep(1200);
// AudioContext 由 SOUND 的 SoundEngine 独占创建（全工程唯一持有者），字段是私有的，
// 因此这里做一次「找带 currentTime 的对象」的通用探测，而不是猜字段名。
const ctx = await ev(`(()=>{const c=window.__CORE__;const seen=new Set();let found=null;const walk=(o,d)=>{if(!o||found||d>3||typeof o!=='object'||seen.has(o))return;seen.add(o);if(typeof o.currentTime==='number'&&typeof o.state==='string'){found=o;return;}for(const k of Object.keys(o)){try{walk(o[k],d+1);}catch{}}};walk(c.engine,0);if(!found)walk(c,0);return {state:found?found.state:'no-ctx',time:found?+found.currentTime.toFixed(3):null,builder:found?found.constructor.name:null,engineKeys:Object.keys(c.engine||{}).join(','),now:+c.clock.now().toFixed(3),route:c.route&&c.route.level}})()`);
console.log(`· AudioContext=${ctx.state}@${ctx.builder} currentTime=${ctx.time} clock.now=${ctx.now} engine=[${ctx.engineKeys}]`);

// 若标题点击只到选关，再显式进 L{LV}
const inLevel = await ev(`(()=>{const c=window.__CORE__;return !!(c.levelScene&&c.clock&&(c.clock.state?c.clock.state():null)==="running")})()`);
if (!inLevel) {
  console.log('· 未在关卡内，调 __CORE__.gotoLevel 直达（这是 CORE 暴露的调试入口，非绕过判定链）');
  await ev(`window.__CORE__.gotoLevel(${LV})`);
  await sleep(1500);
}

const pre = await ev('(()=>{const c=window.__CORE__;const g=c.game.scene.getScenes(true).map(s=>s.key);return {scenes:g.join(","),now:+c.clock.now().toFixed(2),state:(c.clock.state?c.clock.state():null),pending:c.judge.pendingList?c.judge.pendingList().length:-1,tracks:c.ds.trackCount(),hp:JSON.stringify(c.ds.hpByTrack())}})()');
console.log(`· 关卡内 scenes=${pre.scenes} now=${pre.now} state=${pre.state} pending=${pre.pending} tracks=${pre.tracks} hp=${pre.hp}`);
await shot('02-level-start.png');

// ---------------------------------------------------------------- autoplayer
// 在页内按拍打点：取 pendingList 里**离 now 最近**的目标（不是最早的——队列里会有尚未消费的过期项，
// 按最早取会永远盯在一个已过去的障碍上，这是首轮实跑 fires=8/missed=887 的根因），
// 动作映射与 JudgeSystem 同源（spike/platform→jump，barrage→dash）。
const INSTALL = `
window.__E2E__ = (() => {
  const c = window.__CORE__;
  const ACT = (t) => (t === 'barrage' ? 'dash' : 'jump');
  const CODE = { jump: { code: 'Space', key: ' ', vk: 32 }, dash: { code: 'KeyK', key: 'k', vk: 75 } };
  const T = (o) => (o.timeSec !== undefined ? o.timeSec : (o.atSec !== undefined ? o.atSec : o.t));
  const num = (v, k) => (v === undefined || v === null ? null : +Number(v).toFixed(k));
  const log = { fires: 0, stale: 0, byGrade: { PERFECT: 0, GOOD: 0, MISS: 0 }, notes: [], queueShape: null, judgmentFields: null };
  const press = (action) => {
    const d = CODE[action];
    const ev = new KeyboardEvent('keydown', { code: d.code, key: d.key, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => d.vk });
    Object.defineProperty(ev, 'which', { get: () => d.vk });
    document.body.dispatchEvent(ev);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: d.code, key: d.key, bubbles: true }));
    log.fires += 1;
  };
  c.judge.onJudgment((j) => {
    if (!j) return;
    if (log.judgmentFields === null) log.judgmentFields = Object.keys(j).join(',');
    if (log.byGrade[j.grade] !== undefined) log.byGrade[j.grade] += 1;
    if (log.notes.length < 400) log.notes.push({ t: num(j.tSec ?? j.atSec ?? j.t, 3), grade: j.grade, rule: j.rule, type: j.type, deltaMs: num(j.deltaMs, 1) });
  });
  let raf = 0;
  const fired = new Set();
  const ctxOf = () => { const e = c.engine; const k = ['ctx', '_ctx', 'context'].find((n) => e && e[n] && typeof e[n].currentTime === 'number'); return k ? e[k] : null; };
  // 页内只做「择时」：按 timeSec 升序给 Node 一批还没被调度过的目标，Node 用本地 setTimeout
  // 在目标时刻前投递 CDP 可信按键。前两轮实跑（页内 new KeyboardEvent 23 击发→1 判定，
  // 而直接 judge.onInput(t) 立刻 PERFECT）说明断点在输入投递，故改走真实事件通道。
  const batch = (n) => {
    const now = c.clock.now();
    const due = c.judge.pendingList()
      .filter((o) => Number.isFinite(T(o)) && !fired.has(o.id) && T(o) - now > 0.03)
      .sort((a, b) => T(a) - T(b))
      .slice(0, n);
    for (const o of due) fired.add(o.id);
    return due.map((o) => ({ id: o.id, type: o.type, action: ACT(o.type), t: T(o), core: o.core, track: o.track }));
  };
  const frames = { n: 0 };
  const step = () => { frames.n += 1; raf = requestAnimationFrame(step); };
  raf = requestAnimationFrame(step);
  const take = (n = 8) => batch(n);
  return { log, fired, frames, stop: () => cancelAnimationFrame(raf), ctxOf, take, report: () => ({ ...log, noteCount: log.notes.length, notes: undefined, targets: fired.size, frames: frames.n }) };
})();
'installed';`;
await ev(INSTALL);
console.log(`· 自动打点器已装（synthetic key），跑 ${SECS}s`);

// 现场事实摊开：pendingList 的 timeSec 到底相对谁、状态字段是什么、onInput 直接喂目标时刻会怎样。
const diag = await ev(`(()=>{const c=window.__CORE__;const L=c.judge.pendingList();const now=c.clock.now();const ts=L.map(o=>o.timeSec).filter(Number.isFinite);const k=c.clock;const probe={};for(const m of ['origin','originSec','startSec','_originSec','_startSec','startedAt']){try{probe[m]=typeof k[m]==='function'?+k[m]().toFixed(3):k[m]}catch{}}
  const o = null;
  return {now:+now.toFixed(3),pendingN:L.length,tMin:ts.length?+Math.min(...ts).toFixed(3):null,tMax:ts.length?+Math.max(...ts).toFixed(3):null,first5:L.slice(0,5).map(x=>({id:x.id,t:+x.timeSec.toFixed(3),type:x.type,core:x.core,state:x.state,judgable:x.judgable})),probe,windows:JSON.stringify(c.judge.windows()),latency:c.judge.getLatency(),scale:c.judge.getWindowScale()}})()`);
console.log('· 页内诊断 ' + JSON.stringify(diag));

const KEYDEF = { jump: { code: 'Space', key: ' ', vk: 32 }, dash: { code: 'KeyK', key: 'k', vk: 75 } };
async function pressKey(action) {
  const d = KEYDEF[action];
  if (!d) return;
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', code: d.code, key: d.key, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', code: d.code, key: d.key, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk });
}

const samples = [];
let dispatched = 0, late = 0;
const t0 = Date.now();
let prev = await ev('({now:+__CORE__.clock.now().toFixed(2),perf:+performance.now().toFixed(0),frames:window.__E2E__.frames.n})');
let lastSample = 0;
let sched = [];
const stopAt = t0 + SECS * 1000;
const sample = async () => {
  const s = await ev('(()=>{const c=window.__CORE__,r=window.__E2E__;return {now:+c.clock.now().toFixed(2),perf:+performance.now().toFixed(0),frames:r.frames.n,state:c.ds.state(),dis:c.ds.disassembledTracks().join("|"),hp:JSON.stringify(c.ds.hpByTrack()),combo:c.ds.stats().combo,pending:c.judge.pendingCount(),grades:JSON.stringify(r.log.byGrade)}})()');
  const dWall = (s.perf - prev.perf) / 1000;
  const dGame = s.now - prev.now;
  const fps = dWall > 0 ? (s.frames - prev.frames) / dWall : 0;
  const ratio = +(dGame / dWall).toFixed(3);
  samples.push({ ...s, dWall: +dWall.toFixed(2), dGame: +dGame.toFixed(2), ratio, dispatched });
  prev = s;
  console.log(`  t+${((Date.now() - t0) / 1000).toFixed(0)}s Δ墙${dWall.toFixed(2)}/Δ钟${dGame.toFixed(2)} r=${ratio} fps≈${fps.toFixed(0)} state=${s.state} 拆解=[${s.dis}] hp=${s.hp} combo=${s.combo} 判定=${s.grades} pending=${s.pending} 按键=${dispatched}`);
  lastSample = Date.now() - t0;
  return s;
};
while (Date.now() < stopAt) {
  if (!sched.length) sched = (await ev('window.__E2E__.take(12)')) || [];
  if (sched.length) {
    const q = sched[0];
    const now = await ev('+__CORE__.clock.now()');
    const waitMs = (q.t - now - 0.006) * 1000;
    if (waitMs > 30) await sleep(Math.min(waitMs, 120));
    else {
      sched.shift();
      if (waitMs < -0.09 * 1000) late += 1;
      await pressKey(q.action);
      dispatched += 1;
    }
  } else {
    await sleep(150);
  }
  if (Date.now() - t0 - lastSample >= 5000) {
    const s = await sample();
    if (['result', 'finished', 'complete', 'FINISH', 'ARRIVED', 'END'].includes(s.state)) { console.log('  · 已到终点/结算'); break; }
    if (['dead', 'GAME_OVER', 'FAILED'].includes(s.state)) { console.log('  · 本局失败（revive 用尽）'); break; }
  }
}
await shot('03-mid-play.png');

// 终局诊断：Node 仿真里 SILENCE→RESULT 由 timeUp 在 beat 128 触发，浏览器里跑满 174s 仍停在 SILENCE。
// 把「时钟还在不在跑、拍号到没到终点、轮询 interval 是否存活」一次摊开，别再靠猜。
const endgame = await ev('(()=>{const c=window.__CORE__;const n=c.clock.now();return {clockState:c.clock.state?c.clock.state():null,running:!!c.clock._running,loopId:c.clock._loopId===null?"null":typeof c.clock._loopId,now:+n.toFixed(2),origin:+(c.clock.originSec?c.clock.originSec():NaN).toFixed(2),beat:Number(c.clock.beatAt(n).toFixed?c.clock.beatAt(n).toFixed(2):c.clock.beatAt(n)),lengthBeats:c.levelCfg?c.levelCfg.lengthBeats:(c.cfg?c.cfg.lengthBeats:null),dsState:c.ds.state(),runtimeRunning:(c.runtime?!!c.runtime.running:null),pending:c.judge.pendingCount(),ticks:c.clock._tickCount===undefined?null:c.clock._tickCount}})()');
console.log('· 终局诊断 ' + JSON.stringify(endgame));

// 终点/结算屏等待窗口：拆解完还有寂静段与终点，给 45s 让它自己走到结算
let resultWaited = 0, sawUi = false;
while (resultWaited < 45000) {
  const u = await ev('(()=>{const r=document.getElementById("ui-root");return {children:r?r.children.length:-1,text:(r?r.innerText:"").replace(/\\s+/g," ").slice(0,200),state:window.__CORE__.ds.state()}})()');
  if (u.children > 0) { sawUi = true; console.log(`· 等待 ${resultWaited / 1000}s 后出现界面层：节点=${u.children} state=${u.state} 文案「${u.text}」`); break; }
  await sleep(3000);
  resultWaited += 3000;
}
if (!sawUi) console.log(`· 等待 ${resultWaited / 1000}s 后仍未出现任何界面层（state=${await ev('window.__CORE__.ds.state()')}）——这是缺陷，不是脚本问题`);

const e2e = await ev('(()=>{window.__E2E__.stop();return JSON.stringify(window.__E2E__.report())})()');
const final = await ev('(()=>{const c=window.__CORE__;const r=document.getElementById("ui-root");return {state:c.ds.state(),stats:JSON.stringify(c.ds.stats()),ui:(r?r.innerText:"").replace(/\\s+/g," ").slice(0,220),uiChildren:r?r.children.length:-1,canvas:document.querySelectorAll("canvas").length}})()');
console.log('· 自动打点汇总 ' + e2e);
console.log(`· 终态 state=${final.state} ui节点=${final.uiChildren} UI文案「${final.ui}」`);
console.log(`· 结算数据 stats=${final.stats}`);
await shot('04-final.png');

// ---------------------------------------------------------------- teardown 压力（DoD：重开 20 次无残留）
const beforeTeardown = await ev('(()=>{const c=window.__CORE__;return {pending:c.judge.pendingCount(),ignored:c.judge.ignoredCount(),listeners:c.ds.listenerCount?Object.keys({}).length:0}})()');
const restarts = await ev(`(async ()=>{const c=window.__CORE__;for(let i=0;i<20;i++){c.gotoLevel(${LV});await new Promise(r=>setTimeout(r,120));}c.gotoLevel(${LV});return 'done'})()`, { awaitPromise: true });
await sleep(2500);
const afterTeardown = await ev('(()=>{const c=window.__CORE__;return {pending:c.judge.pendingCount(),ignored:c.judge.ignoredCount(),canvas:document.querySelectorAll("canvas").length,running:c.game.isRunning,now:+c.clock.now().toFixed(2)}})()');
console.log(`· 重开 20 次：${restarts} → 重开后 pending=${afterTeardown.pending} ignored=${afterTeardown.ignored} canvas=${afterTeardown.canvas} running=${afterTeardown.running} now=${afterTeardown.now}`);

// ---------------------------------------------------------------- selftest 负载
async function harvest(kind) {
  await rpc('Page.navigate', { url: `${URL_BASE}?selftest=${kind}&level=${LV}` });
  const keyName = kind === 'render' ? '__WORLD_SELFTEST__' : '__SOUND_SELFTEST__';
  for (let i = 0; i < 40; i += 1) {
    const has = await ev(`typeof window.${keyName} !== "undefined" && window.${keyName} !== null`);
    if (has) break;
    await sleep(500);
  }
  const json = await ev(`JSON.stringify(window.${keyName})`);
  if (!json || json === 'undefined' || json === 'null') return null;
  const p = join(OUT, `selftest-${kind}.json`);
  writeFileSync(p, json);
  console.log(`· selftest=${kind} 负载 ${json.length} 字节 → ${p}`);
  return p;
}
const renderPayload = await harvest('render');
const audioPayload = await harvest('audio');
const bootErrors = errors.slice();

const gameErrors = errors.filter((e) => !/__E2E__|已隔离/.test(e));
writeFileSync(join(OUT, 'e2e-report.json'), JSON.stringify({
  url: URL_BASE, level: LV, browser: EXE, canvas: canvasInfo, audioContext: ctx,
  title: titleDom, entry: pre, samples, autoplayer: JSON.parse(e2e), final,
  teardown: { before: beforeTeardown, after: afterTeardown },
  consoleErrorCount: gameErrors.length, gameErrors: gameErrors.slice(0, 20),
  harnessErrors: errors.filter((e) => /__E2E__|已隔离/.test(e)).slice(0, 5),
  networkFailures: netFails.slice(0, 20),
  consoleSample: consoleLines.slice(0, 12),
}, null, 2));
writeFileSync(join(OUT, 'console.txt'), consoleLines.join('\n'));

console.log('\n================ 浏览器实测结论 ================');
console.log(`游戏自身 console 错误数 = ${gameErrors.length}（另有 ${errors.length - gameErrors.length} 条来自本取证脚本自身，已单列）`);
if (gameErrors.length) gameErrors.slice(0, 10).forEach((e) => console.log('  × ' + e));
if (netFails.length) console.log(`网络失败 ${netFails.length} 条：${netFails.slice(0, 4).join(' | ')}`);
console.log(`自动打点击发 ${JSON.parse(e2e).fires} 次 · 判定分布 ${JSON.stringify(JSON.parse(e2e).byGrade)}`);
if (renderPayload) console.log(`render 负载已落 ${renderPayload}`);
if (audioPayload) console.log(`audio 负载已落 ${audioPayload}`);
try { child.kill(); } catch { /* noop */ }
process.exit(gameErrors.length ? 2 : 0);
