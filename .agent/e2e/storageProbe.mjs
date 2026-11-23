// .agent/e2e/storageProbe.mjs — Owner: leader
// 目的：判定 R12/R13 的浏览器存档证据到底测的是不是真持久化。
// 撞出来的现象：每一轮 e2e 的 console 里都有 3 条
//   `[save] localStorage 不可用（隐私模式或 iframe 分区） → 本次会话使用内存档`
// 但 L2/L3/L5 的 `存档 levels=...` 又确实读到了东西。两者只能有一个是真的，
// 必须量出：警告发生在哪个 URL、游戏自己的 setItem 有没有真的落盘。
// 用法：node .agent/e2e/storageProbe.mjs [--url=http://127.0.0.1:4174/] [--port=9344] [--lv=4]

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const flag = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const URL_BASE = flag('url', 'http://127.0.0.1:4174/');
const PORT = Number(flag('port', 9344));
const LV = flag('lv', '4');
const EXE = flag('edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const profile = join(tmpdir(), `rb-storage-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pending = new Map();
let seq = 0;
let ws = null;
const entries = []; // 所有 Log.entryAdded（带 url）

const child = spawn(EXE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1280,720', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => {
  try {
    child.kill();
  } catch {
    /* noop */
  }
});

let target = null;
for (let i = 0; i < 60 && !target; i += 1) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch {
    /* 还没起监听 */
  }
}
if (!target) {
  console.log('CDP 未就绪');
  process.exit(1);
}

const rpc = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('ws open failed'));
});
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    return;
  }
  if (msg.method === 'Log.entryAdded') entries.push({ t: Date.now(), level: msg.params.entry.level, url: msg.params.entry.url, text: String(msg.params.entry.text).slice(0, 120) });
  if (msg.method === 'Runtime.consoleAPICalled') {
    const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    entries.push({ t: Date.now(), level: msg.params.type, url: `ctx#${msg.params.executionContextId}`, text: txt.slice(0, 120) });
  }
  if (msg.method === 'Runtime.executionContextCreated') {
    const c = msg.params.context;
    entries.push({ t: Date.now(), level: 'ctx', url: `${c.origin} ${c.url}`.trim(), text: `#${c.id} aux=${JSON.stringify(c.auxData || {})}` });
  }
};

const ev = async (expr) => {
  const r = await rpc('Runtime.evaluate', { expression: `(()=>{${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result.value;
};

await rpc('Page.enable');
await rpc('Runtime.enable');
await rpc('Log.enable');

console.log('== 1) 导航前的空白页上访问 localStorage ==');
console.log(JSON.stringify(await ev('const o={href:location.href};try{o.type=typeof localStorage;o.set=localStorage.setItem.__name||"fn";localStorage.setItem("p","1");o.ok=localStorage.getItem("p")}catch(e){o.threw=e.name+":"+e.message}return o'), null, 0));

console.log(`== 2) 载入游戏 ${URL_BASE} ==`);
await rpc('Page.navigate', { url: URL_BASE });
await sleep(3500);
console.log(JSON.stringify(await ev('const o={href:location.href};try{o.writable=true;localStorage.setItem("probe-key","v1");o.readback=localStorage.getItem("probe-key");localStorage.removeItem("probe-key")}catch(e){o.threw=e.name+":"+e.message;o.writable=false}o.core=!!window.__CORE__;return o'), null, 0));

console.log('== 3) 时间线：上下文创建 / [save] 警告 的先后 ==');
const t0 = entries.length ? entries[0].t : 0;
for (const e of entries) {
  if (e.level === 'ctx' || /\[save\]/.test(e.text)) console.log(` +${e.t - t0}ms [${e.level}] url=${e.url} :: ${e.text.slice(0, 80)}`);
}
const saveWarns = entries.filter((e) => /localStorage 不可用|内存档/.test(e.text));
const ctxOnGame = entries.filter((e) => e.level === 'ctx' && /127\.0\.0\.1:4174/.test(String(e.url)));
console.log(`· [save] 警告 ${saveWarns.length} 条；游戏 origin 上创建的执行上下文 ${ctxOnGame.length} 个（含 auxData.isDefault/isEval/isSubframe 可判断是不是 iframe）`);

console.log(`== 4) 进第 ${LV} 关，跑到结算，立刻读盘 ==`);
await rpc('Page.navigate', { url: `${URL_BASE}?level=${LV}&autoplay=1` }).catch(() => {});
await sleep(1000);
console.log(JSON.stringify(await ev('const c=window.__CORE__;return c?{route:c.route&&c.route.level,hasGoto:typeof c.gotoLevel==="function"}:{noCore:true}'), null, 0));
if (flag('goto', '1') === '1') await ev(`window.__CORE__ && window.__CORE__.gotoLevel(${LV}); return true`);
await sleep(2500);
console.log(JSON.stringify(await ev('return {href:location.href,probe:(function(){try{localStorage.setItem("late","1");return localStorage.getItem("late")}catch(e){return "THREW:"+e.name}})(),raw:localStorage.getItem("rhythm-breaker/save"),degradedLog:window.__CONSOLE_ERRORS__?window.__CONSOLE_ERRORS__.errors:null}'), null, 0));

console.log('== 5) 结论口径 ==');
const writable = entries.filter((e) => /127.0.0.1:4174/.test(String(e.url)));
console.log(`· 警告源：${[...new Set(saveWarns.map((w) => String(w.url).replace(/[?#].*$/, '')))].join(' , ') || '（consoleAPI 无 url，需要看导航前后顺序）'}`);
console.log(`· 游戏 origin 自身的日志条数 = ${writable.length}`);
process.exit(0);
