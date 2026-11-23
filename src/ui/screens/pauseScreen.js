// src/ui/screens/pauseScreen.js — Owner: CORE（K-13 界面③：暂停）
// ★ 暂停的唯一权威是 BeatClock：本界面只调 deps.onResume/onRestart…，由宿主走到
//   LevelRuntime.togglePause() → clock.pause() / clock.resume()（R11）。这里没有任何 setTimeout / 自停表。
// 面板上把「已冻结」的证据摆出来：clock.isPaused() 与当前拍（暂停期拍序不推进）。

import { h, row, col, headline, caption, panel, primaryButton, button } from './dom.js';

function line(label, value) {
  return row([
    h('span', { class: 'rb-text rb-text-caption', style: 'min-width:9.5em', text: label }),
    h('span', { class: 'rb-text rb-text-body rb-num', text: String(value) })
  ]);
}

/**
 * @param {{stats?:object, clock?:object, latencyMs?:number, level?:object}} data
 * @param {{onResume:Function, onRestart:Function, onSettings:Function, onQuit:Function, onCalibrate?:Function, uiSound?:Function}} deps
 */
export function buildPause(data = {}, deps = {}) {
  const st = data.stats || {};
  const clock = data.clock || null;
  const paused = !!(clock && typeof clock.isPaused === 'function' && clock.isPaused());

  const act = (fn) => () => {
    if (deps.uiSound) deps.uiSound(); // SFX_TRIGGERS.ui：调用点直发
    if (fn) fn();
  };

  const resume = primaryButton('继续（Esc）', act(() => deps.onResume && deps.onResume()));
  resume.setAttribute('data-role', 'pause-resume');
  const restart = button('重开本局（R）', act(() => deps.onRestart && deps.onRestart()));
  restart.setAttribute('data-role', 'pause-restart');
  const settings = button('设置', act(() => deps.onSettings && deps.onSettings()));
  settings.setAttribute('data-role', 'pause-settings');
  // UI-05：暂停面板要有校准入口。此处音频钟被 clock.pause() 冻住（R11），
  // 面板会如实说明「小游戏不可用 → 用 ±1ms 微调」，从标题/结算进设置才打得成小游戏。
  const calibrate = button('校准（小游戏 / ±1ms 微调）', act(() => deps.onCalibrate && deps.onCalibrate()));
  calibrate.setAttribute('data-role', 'pause-calibrate');
  const quit = button('回标题（Q）', act(() => deps.onQuit && deps.onQuit()));
  quit.setAttribute('data-role', 'pause-quit');

  const beat = clock && typeof clock.currentBeat === 'function' ? clock.currentBeat().toFixed(2) : '—';
  const hp = ['kick', 'bass', 'synth'].filter((t) => ((data.hpMaxByTrack || {})[t] || 0) > 0);

  return panel(
    col(
      [
        headline('暂停', 'rb-text-title rb-glow-system'),
        caption(`时钟已冻结：isPaused=${paused ? 'true' : 'false'} · 停在 beat ${beat}（恢复后拍序不重置，R11）`),
        line('状态机', `${st.state || '—'}${data.stateLine ? ` · ${data.stateLine}` : ''}`),
        line('Perfect 率', `${((st.perfectRate || 0) * 100).toFixed(1)}%（${st.perfect || 0}/${st.total || 0}）`),
        line('连击 / 最高', `${st.combo || 0} / ${st.maxCombo || 0}`),
        line('MISS', `${st.miss || 0}（背景层不计入分母）`),
        line('延迟补偿', `${Number.isFinite(data.latencyMs) ? data.latencyMs.toFixed(0) : '—'}ms（[ / ] 逐 1ms 微调）`),
        hp.length
          ? row(
              hp.map((t) => {
                const max = (data.hpMaxByTrack || {})[t] || 0;
                const cur = (st.hp || {})[t] || 0;
                return h('span', { class: 'rb-chip', dataset: { track: t } }, [
                  h('span', { class: 'rb-hp', dataset: { track: t } }, Array.from({ length: max }, (_, i) => h('i', { dataset: { spent: i >= cur ? 'true' : 'false' } })))
                ]);
              })
            )
          : null,
        row([resume, restart, settings, calibrate, quit])
      ].filter(Boolean),
      { style: 'gap:.55em' }
    ),
    { role: 'pause' }
  );
}

export default buildPause;
