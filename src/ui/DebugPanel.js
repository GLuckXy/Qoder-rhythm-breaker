// src/ui/DebugPanel.js — Owner: CORE（K-03，MAINT-02）
// 全员共用基础设施：实时显示 当前拍 / now() / 待判定队列长度 / 当前窗口 ms / driftMs。
// DOM 覆盖层挂在 #debug-root（L-04：UI 层用 DOM，不进 Phaser）。
// 默认按 ` 或 D 开关，URL 带 ?debug=1 时自动展开。
// 说明：面板只用中性灰白，不消费声部色，因此不 import WORLD 的 theme.js（避免 C8 色板耦合与循环依赖）。

import { CLOCK_LOOKAHEAD_SEC, CLOCK_POLL_MS } from '../audio/BeatClock.js';

const STYLE = [
  'position:fixed',
  'left:8px',
  'bottom:8px',
  'z-index:9999',
  'max-width:46vw',
  'padding:8px 10px',
  'font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace',
  'color:#e8ecf4',
  'background:rgba(6,10,18,0.78)',
  'border:1px solid rgba(232,236,244,0.28)',
  'border-radius:6px',
  'white-space:pre',
  'pointer-events:auto',
  'user-select:none'
].join(';');

const BTN_STYLE = [
  'font:inherit',
  'color:inherit',
  'background:transparent',
  'border:1px solid rgba(232,236,244,0.28)',
  'border-radius:4px',
  'padding:0 6px',
  'cursor:pointer'
].join(';');

function fmt(n, digits = 3) {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

function stateLine(clock) {
  if (!clock || typeof clock.getState !== 'function') return '-';
  const paused = typeof clock.isPaused === 'function' && clock.isPaused() ? ' (PAUSED)' : '';
  const running = typeof clock.isRunning === 'function' && !clock.isRunning() ? ' (IDLE)' : '';
  return `${clock.getState()}${paused}${running}`;
}

/**
 * 装配调试面板。
 * @param {{clock?:object, judge?:object, root?:HTMLElement, intervalMs?:number,
 *          toggleKeys?:string[], autoShow?:boolean}} [deps]
 * @returns {{show:Function, hide:Function, toggle:Function, isVisible:Function,
 *            update:Function, destroy:Function, exportText:Function, el:?HTMLElement}}
 */
export function mountDebugPanel(deps = {}) {
  const clock = deps.clock ?? null;
  const judge = deps.judge ?? null;
  const intervalMs = Number.isFinite(deps.intervalMs) ? deps.intervalMs : 100;
  const toggleKeys = deps.toggleKeys ?? ['`', 'd', 'D'];
  const root = deps.root ?? (typeof document !== 'undefined' ? document.getElementById('debug-root') : null);

  let visible = !!deps.autoShow;
  if (!visible && typeof window !== 'undefined' && window?.location?.search) {
    visible = /(?:^|[?&])debug=1/.test(window.location.search);
  }
  if (!root || typeof document === 'undefined') {
    // 没有挂载点（例如 Node 自检）→ 返回空操作句柄，调用方无需分支
    const noop = () => {};
    return {
      show: noop,
      hide: noop,
      toggle: noop,
      isVisible: () => false,
      update: noop,
      destroy: noop,
      exportText: () => '[]',
      el: null
    };
  }

  const el = document.createElement('div');
  el.setAttribute('data-role', 'debug-panel');
  el.setAttribute('style', STYLE);
  const pre = document.createElement('pre');
  pre.setAttribute('style', 'margin:0');
  const bar = document.createElement('div');
  bar.setAttribute('style', 'display:flex;gap:6px;margin-bottom:6px');

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.setAttribute('style', BTN_STYLE);
  exportBtn.textContent = '导出事件流';
  exportBtn.addEventListener('click', () => downloadEvents());

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.setAttribute('style', BTN_STYLE);
  clearBtn.textContent = '清屏计数';
  clearBtn.addEventListener('click', () => {
    peak.drift = 0;
  });

  bar.appendChild(exportBtn);
  bar.appendChild(clearBtn);
  el.appendChild(bar);
  el.appendChild(pre);
  root.appendChild(el);

  const peak = { drift: 0 };

  function exportText() {
    if (judge?.events?.exportEvents) return judge.events.exportEvents();
    if (Array.isArray(judge?.events)) return JSON.stringify(judge.events);
    return '[]';
  }

  function downloadEvents() {
    const href = `data:application/json;charset=utf-8,${encodeURIComponent(exportText())}`;
    const a = document.createElement('a');
    a.href = href;
    a.download = 'rhythm-breaker-events.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function lines() {
    const nowSec = clock?.now ? clock.now() : Number.NaN;
    const beat = clock?.beatAt && Number.isFinite(nowSec) ? clock.beatAt(nowSec) : Number.NaN;
    const drift = clock?.driftMs ? clock.driftMs() : Number.NaN;
    if (Number.isFinite(drift)) peak.drift = Math.max(peak.drift, Math.abs(drift));
    const win = judge?.windows ? judge.windows() : null;
    const rows = [
      `beat     ${fmt(beat, 3)}   now ${fmt(nowSec, 3)}s`,
      `state    ${stateLine(clock)}`,
      `queue    judge ${judge?.pendingCount ? judge.pendingCount() : '-'}   clock ${clock?.queueSize ? clock.queueSize() : '-'}`,
      `window   PERFECT ±${win ? fmt(win.perfectMs, 1) : '-'}ms  GOOD ±${win ? fmt(win.goodMs, 1) : '-'}ms  scale ×${win ? fmt(win.scale, 2) : '-'}${win?.strict ? '  strict' : ''}${win?.floored ? '  [FLOOR]' : ''}`,
      `latency  ${judge?.getLatency ? `${fmt(judge.getLatency(), 1)}ms` : '-'}`,
      `drift    ${fmt(drift, 2)}ms  peak ${fmt(peak.drift, 2)}ms  (poll ${CLOCK_POLL_MS}ms / lead ${Math.round(CLOCK_LOOKAHEAD_SEC * 1000)}ms)`,
      `events   ${judge?.events?.count ? judge.events.count() : 0}`
    ];
    if (clock?.getTempoCues) {
      const cues = clock.getTempoCues();
      if (cues.length) {
        rows.push(
          ...cues.map((c) => `tempo    beat ${fmt(c.beat, 2)} cue@${fmt(c.timeSec, 3)} → ${c.bpmFrom}→${c.bpmTo}BPM`)
        );
      }
    }
    return rows.join('\n');
  }

  function update() {
    pre.textContent = lines();
  }

  function show() {
    visible = true;
    el.style.display = 'block';
    ensureTimer();
    update();
  }

  function hide() {
    visible = false;
    el.style.display = 'none';
    stopTimer();
  }

  let timer = null;
  function ensureTimer() {
    if (timer !== null || typeof setInterval !== 'function') return;
    timer = setInterval(update, intervalMs);
    timer?.unref?.();
  }
  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function onKey(ev) {
    if (!ev || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '')) return;
    if (!toggleKeys.includes(ev.key)) return;
    if (visible) hide();
    else show();
  }

  if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);

  if (visible) show();
  else {
    el.style.display = 'none';
    update();
  }

  return {
    show,
    hide,
    toggle: () => (visible ? hide() : show()),
    isVisible: () => visible,
    update,
    exportText,
    destroy: () => {
      stopTimer();
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    el
  };
}

export default mountDebugPanel;
