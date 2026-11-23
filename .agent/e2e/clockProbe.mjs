// .agent/e2e/clockProbe.mjs — leader 取证用：判断 headless 里 AudioContext.currentTime 是否跟得上墙钟。
// 只读，不改任何 src。用法：node .agent/e2e/clockProbe.mjs [--mute] [--secs=6]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9337;
const URL_BASE = process.argv.find((a) => a.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:4174/';
const SECS = Number((process.argv.find((a) => a.startsWith('--secs=')) || '').split('=')[1] || 6);
const EXE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));

const child = spawn(EXE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), `rb-probe-${Date.now()}`)}`,
  '--window-size=1280,720', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  ...(process.argv.includes('--mute') ? ['--mute-audio'] : []),
  'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, mid = 0;
const pending = new Map();
const rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };

let target = null;
for (let i = 0; i < 40 && !target; i += 1) {
  await sleep(400);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); } catch { /* retry */ }
}
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res) => { ws.onopen = res; });
ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && pending.has(x.id)) { const p = pending.get(x.id); pending.delete(x.id); x.error ? p.rej(new Error(x.error.message)) : p.res(x.result); } };
await rpc('Page.enable'); await rpc('Runtime.enable');
await rpc('Page.navigate', { url: URL_BASE });
await sleep(2500);

// 一个裸 AudioContext（不经游戏）+ 游戏自己的时钟，同时采样，横向对比。
const script = `
(async () => {
  const bare = new AudioContext();
  await bare.resume().catch(() => {});
  const rafFrames = await new Promise((res) => {
    let n = 0; const w0 = performance.now();
    const step = () => { n++; if (performance.now() - w0 < ${SECS * 1000}) requestAnimationFrame(step); else res(n); };
    requestAnimationFrame(step);
  });
  const w0 = performance.now(), b0 = bare.currentTime, g0 = window.__CORE__ ? window.__CORE__.clock.now() : null;
  const c0 = Date.now();
  await new Promise((r) => setTimeout(r, ${SECS * 1000}));
  const w1 = performance.now(), b1 = bare.currentTime, g1 = window.__CORE__ ? window.__CORE__.clock.now() : null;
  const c1 = Date.now();
  return {
    wallMsByPerf: +(w1 - w0).toFixed(0), wallMsByDate: c1 - c0,
    bareAudioSec: +(b1 - b0).toFixed(3),
    gameClockSec: g0 === null ? null : +(g1 - g0).toFixed(3),
    bareRatio: +((b1 - b0) / ((w1 - w0) / 1000)).toFixed(3),
    gameRatio: g0 === null ? null : +((g1 - g0) / ((w1 - w0) / 1000)).toFixed(3),
    rafFrames, visibility: document.visibilityState, bareState: bare.state,
  };
})()`;
const out = await ev(script);
console.log(JSON.stringify(out, null, 2));
console.log(`\n判读：bareAudioSec/wallSec = ${out.bareRatio}；gameClock/wall = ${out.gameRatio}；rAF ${out.rafFrames} 帧 / ${SECS}s（期望 ≈${SECS * 60}）`);
try { child.kill(); } catch { /* noop */ }
process.exit(0);
