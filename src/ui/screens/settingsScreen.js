// src/ui/screens/settingsScreen.js — Owner: CORE（K-13 界面④：设置 + K-14 降级版校准）
// 音量三通道唯一的写入口是 SOUND 的 engine.setVolumes({master,music,sfx})（CR-12 批复：不在界面里碰 GainNode）；
// 严格窗口走 judge.setStrictWindow；延迟补偿走 judge.setLatency + config.nudgeLatency 的钳位（K-14 只做 [ / ] 手动微调，
// 不做校准小游戏 —— leader 决策 L-06）。所有取值同时写进 save（存档口径见 src/data/save.js）。

import { h, row, col, headline, caption, panel, primaryButton, button } from './dom.js';
import { nudgeLatency, CALIBRATION } from '../../data/config.js';

function volumeChannel(key, label, value, onInput) {
  const out = h('span', { class: 'rb-text rb-text-body rb-num', dataset: { role: `vol-out-${key}` }, text: `${Math.round(value * 100)}%` });
  const input = h('input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.05',
    value: String(value),
    class: 'rb-range',
    dataset: { role: `vol-${key}` },
    style: 'width:min(34vw,22em);accent-color:var(--rb-system)',
    oninput: (e) => {
      const v = Number(e && e.target ? e.target.value : value);
      out.textContent = `${Math.round((Number.isFinite(v) ? v : value) * 100)}%`;
      onInput(key, Number.isFinite(v) ? v : value);
    }
  });
  return row([h('span', { class: 'rb-text rb-text-caption', style: 'min-width:9.5em', text: label }), input, out]);
}

/**
 * @param {{volumes:object, strictWindow:boolean, latencyMs:number, windows?:object, muted?:boolean}} data
 * @param {{onVolumes:Function, onStrict:Function, onLatency:Function, onBack:Function}} deps
 */
export function buildSettings(data = {}, deps = {}) {
  const vol = data.volumes || { master: 1, music: 1, sfx: 1 };
  let local = Object.assign({}, vol);
  const push = (key, v) => {
    local[key] = v;
    if (deps.onVolumes) deps.onVolumes(Object.assign({}, local));
  };

  const strictBox = h('input', {
    type: 'checkbox',
    class: 'rb-check',
    dataset: { role: 'strict-window' },
    style: 'accent-color:var(--rb-system);width:1.1em;height:1.1em',
    onchange: (e) => deps.onStrict && deps.onStrict(!!(e && e.target && e.target.checked))
  });
  if (data.strictWindow) strictBox.setAttribute('checked', '');

  const latOut = h('span', { class: 'rb-text rb-text-body rb-num', dataset: { role: 'latency-out' }, text: `${Math.round(Number(data.latencyMs) || 0)}ms` });
  const latBtn = (dir) => {
    const b = button(dir > 0 ? '＋1ms' : '－1ms', () => {
      const next = nudgeLatency(Number(data.latencyMs) || 0, dir);
      data.latencyMs = next;
      latOut.textContent = `${Math.round(next)}ms`;
      if (deps.onLatency) deps.onLatency(next);
    });
    b.setAttribute('data-role', dir > 0 ? 'latency-up' : 'latency-down');
    return b;
  };

  const back = primaryButton('返回', () => deps.onBack && deps.onBack());
  back.setAttribute('data-role', 'settings-back');

  const w = data.windows || {};
  return panel(
    col(
      [
        headline('设置', 'rb-text-title rb-glow-system'),
        volumeChannel('master', '主音量', Number(vol.master), push),
        volumeChannel('music', '音乐（三声部）', Number(vol.music), push),
        volumeChannel('sfx', '音效', Number(vol.sfx), push),
        row([h('span', { class: 'rb-text rb-text-caption', style: 'min-width:9.5em', text: '严格窗口（判定不放宽）' }), strictBox, h('span', { class: 'rb-text rb-text-caption', text: '关闭时窗口按关卡 scale 放宽' })]),
        row([
          h('span', { class: 'rb-text rb-text-caption', style: 'min-width:9.5em', text: '延迟补偿' }),
          latBtn(-1),
          latOut,
          latBtn(1),
          caption(`游戏内 [ / ] 每步 ${CALIBRATION.stepMs}ms，范围 ${CALIBRATION.minMs}..${CALIBRATION.maxMs}ms（L-06：本轮不做校准小游戏）`)
        ]),
        caption(w.perfectMs != null ? `当前判定窗：PERFECT ±${Number(w.perfectMs).toFixed(1)}ms · GOOD ±${Number(w.goodMs).toFixed(1)}ms` : '判定窗：进入关卡后可读'),
        back
      ].filter(Boolean),
      { style: 'gap:.7em;align-items:flex-start' }
    ),
    { role: 'settings' }
  );
}

export default buildSettings;
