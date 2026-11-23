// src/ui/screens/settingsScreen.js — Owner: CORE（K-13 界面④：设置 + K-14 校准入口）
// 音量三通道唯一的写入口是 SOUND 的 engine.setVolumes({master,music,sfx})（CR-12 批复：不在界面里碰 GainNode）；
// 严格窗口走 judge.setStrictWindow；延迟补偿走 judge.setLatency + config.nudgeLatency 的钳位。
// K-14 完整版（leader 批复：降级版一条不许掉）：这里既保留 ±1ms 手动微调（JDG-09），也挂「校准小游戏」入口，
// 小游戏本体与写入通路在 src/ui/Calibration.js + UiLayer.showCalibration，本文件只出入口、不含时序。
// 所有取值同时写进 save（存档口径见 src/data/save.js）。

import { h, row, col, headline, caption, panel, primaryButton, button, setFlashReduced } from './dom.js';
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
 * 一个布尔开关行（TIM-05 / PERF-05③ / 严格窗口共用同一具皮肤）。
 * 用原生 `<input type=checkbox>` 而不是自造按钮：键盘（空格）与读屏器免费拿到，
 * 焦点环由 neon.css 的 `:focus-visible` 给 ⇒ PERF-05④「键盘可达所有界面」不用另写代码。
 * @param {string} role data-role（断言与自动化点它的手）
 * @param {string} label
 * @param {string} hint
 * @param {boolean} checked
 * @param {(on:boolean)=>void} onChange
 * @param {()=>void} [onSound]
 */
function toggleRow(role, label, hint, checked, onChange, onSound) {
  const box = h('input', {
    type: 'checkbox',
    id: `rb-opt-${role}`,
    class: 'rb-check',
    dataset: { role },
    style: 'accent-color:var(--rb-system);width:1.1em;height:1.1em',
    onchange: (e) => {
      if (onSound) onSound();
      onChange(!!(e && e.target && e.target.checked));
    }
  });
  if (checked) box.setAttribute('checked', '');
  // label 包 input：点文字也能翻开关（触控/平板 UI-09 的同一条便宜）
  return row([
    h('label', { for: `rb-opt-${role}`, class: 'rb-text rb-text-caption', style: 'min-width:9.5em;display:flex;gap:.5em;align-items:center;cursor:pointer' }, [box, label]),
    h('span', { class: 'rb-text rb-text-caption', text: hint })
  ]);
}

/**
 * @param {{volumes:object, strictWindow:boolean, latencyMs:number, windows?:object, muted?:boolean,
 *   showTimelineGuides?:boolean, reduceFlash?:boolean}} data
 * @param {{onVolumes:Function, onStrict:Function, onLatency:Function, onBack:Function,
 *   onCalibrate?:Function, onOption?:(key:string,on:boolean)=>void, uiSound?:Function}} deps
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
  // TIM-05 / PERF-05③：这两个开关从 R1 起就在存档 schema 里，但界面上没有入口、渲染层也没读它们
  //（死开关）。现在两头都接上了：写档仍走 UiLayer 那唯一一条 updateSave 通路（deps.onOption），
  // 读侧是 view.a11y（LevelRuntime 每帧复核）⇒ 翻完下一帧生效，不用重开本关、不用刷新页面。
  const emitOption = (key, on) => {
    if (typeof deps.onOption === 'function') deps.onOption(key, on); // 可选：leader 接线前本屏照样能渲染
    if (key === 'reduceFlash') setFlashReduced(on); // CSS 侧（neon.css :root[data-rb-flash]）同帧跟上
  };
  return panel(
    col(
      [
        headline('设置', 'rb-text-title rb-glow-system'),
        volumeChannel('master', '主音量', Number(vol.master), push),
        volumeChannel('music', '音乐（三声部）', Number(vol.music), push),
        volumeChannel('sfx', '音效', Number(vol.sfx), push),
        row([h('span', { class: 'rb-text rb-text-caption', style: 'min-width:9.5em', text: '严格窗口（判定不放宽）' }), strictBox, h('span', { class: 'rb-text rb-text-caption', text: '关闭时窗口按关卡 scale 放宽' })]),
        toggleRow('opt-guides', '时间轴辅助线', '关闭后不画拍刻度 / 网格 / 出生线 / 4 拍窗边界（TIM-05；判定线与分区照常保留）', data.showTimelineGuides !== false, (on) => emitOption('showTimelineGuides', on), deps.uiSound),
        toggleRow('opt-reduce-flash', '降低闪烁', '削弱整屏频闪：震屏与 bloom 关闭、MISS 红边降到 1/4、判定线不再每拍呼吸（PERF-05③ 光敏安全）', !!data.reduceFlash, (on) => emitOption('reduceFlash', on), deps.uiSound),
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
