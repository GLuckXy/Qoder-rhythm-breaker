// src/ui/screens/settingsScreen.js — Owner: CORE（K-13 界面④：设置 + K-14 校准入口）
// 音量三通道唯一的写入口是 SOUND 的 engine.setVolumes({master,music,sfx})（CR-12 批复：不在界面里碰 GainNode）；
// 严格窗口走 judge.setStrictWindow；延迟补偿走 judge.setLatency + config.nudgeLatency 的钳位。
// K-14 完整版（leader 批复：降级版一条不许掉）：这里既保留 ±1ms 手动微调（JDG-09），也挂「校准小游戏」入口，
// 小游戏本体与写入通路在 src/ui/Calibration.js + UiLayer.showCalibration，本文件只出入口、不含时序。
// 所有取值同时写进 save（存档口径见 src/data/save.js）。

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
 * @param {{onVolumes:Function, onStrict:Function, onLatency:Function, onBack:Function, onCalibrate?:Function, uiSound?:Function}} deps
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
      if (deps.uiSound) deps.uiSound(); // SFX_TRIGGERS.ui：调用点直发
      const next = nudgeLatency(Number(data.latencyMs) || 0, dir);
      data.latencyMs = next;
      latOut.textContent = `${Math.round(next)}ms`;
      if (deps.onLatency) deps.onLatency(next);
    });
    b.setAttribute('data-role', dir > 0 ? 'latency-up' : 'latency-down');
    return b;
  };

  const back = primaryButton('返回', () => {
    if (deps.uiSound) deps.uiSound();
    if (deps.onBack) deps.onBack();
  });
  back.setAttribute('data-role', 'settings-back');

  // K-14 完整版入口：8 拍跟节拍器敲击 → 取中位数写入（面板自己会说明当前能不能打小游戏）
  const calibrate = button('校准小游戏（跟拍 8 下 · 取中位数）', () => {
    if (deps.uiSound) deps.uiSound();
    if (deps.onCalibrate) deps.onCalibrate();
  });
  calibrate.setAttribute('data-role', 'open-calibration');

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
          caption(`±1ms：每步 ${CALIBRATION.stepMs}ms，范围 ${CALIBRATION.minMs}..${CALIBRATION.maxMs}ms（游戏内 [ / ] 同一步长）；「重置为 0」与校准小游戏在下面的面板里（JDG-09）`)
        ]),
        caption(w.perfectMs != null ? `当前判定窗：PERFECT ±${Number(w.perfectMs).toFixed(1)}ms · GOOD ±${Number(w.goodMs).toFixed(1)}ms` : '判定窗：进入关卡后可读'),
        calibrate,
        back
      ].filter(Boolean),
      { style: 'gap:.7em;align-items:flex-start' }
    ),
    { role: 'settings' }
  );
}

export default buildSettings;
