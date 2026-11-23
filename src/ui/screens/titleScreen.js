// src/ui/screens/titleScreen.js — Owner: CORE（K-13 界面①：标题）
// 点击 = AudioContext 解锁：手势解锁的监听绑在 main.js 的 soundEngine.unlockOnFirstGesture（CR-11 批复），
// 本界面只保证「第一次点击一定发生在页面上」并把 id 交给 deps.gotoLevel；不自建 AudioContext、不读时间。

import { row, col, headline, caption, panel, primaryButton, button } from './dom.js';

/**
 * @param {{notice?:string, resumeId?:number, levels?:Array<{id:number,title:string,bpm:number,cleared:boolean}>}} data
 * @param {{onSelect:Function, onSettings:Function, gotoLevel:Function, engine?:object}} deps
 */
export function buildTitle(data = {}, deps = {}) {
  const levels = Array.isArray(data.levels) ? data.levels : [];
  const next = Number.isFinite(data.resumeId) ? data.resumeId : (levels.find((l) => !l.cleared) || levels[0] || { id: 1 }).id;
  const cleared = levels.filter((l) => l.cleared).length;

  const start = primaryButton(`开始 · L${next}`, () => {
    if (deps.engine && typeof deps.engine.ensureRunning === 'function') deps.engine.ensureRunning();
    if (deps.gotoLevel) deps.gotoLevel(next);
  });
  start.setAttribute('data-role', 'title-start');

  const select = button('选关', () => deps.onSelect && deps.onSelect());
  select.setAttribute('data-role', 'title-select');
  const settings = button('设置', () => deps.onSettings && deps.onSettings());
  settings.setAttribute('data-role', 'title-settings');

  return panel(
    col(
      [
        headline('节奏拆解台'),
        caption('RHYTHM BREAKER · 把一首歌拆回去，再把它拼回来'),
        caption(levels.length ? `已就位 ${levels.length} 关 · 已通关 ${cleared}/${levels.length}` : '尚无谱面（等 SOUND 的 level*.json）'),
        row([start, select, settings]),
        caption('空格/J = 跳 · K = 冲 · R = 重开 · Esc = 暂停 · [ ] = 延迟微调（±1ms，当前值见暂停面板）'),
        data.notice ? caption(String(data.notice)) : null
      ].filter(Boolean),
      { style: 'align-items:flex-start;gap:.7em' }
    ),
    { role: 'title' } // 遮罩层不吃事件：画布上的「点击任意处进 L1」（TitleScene）与按钮各走各的
  );
}

export default buildTitle;
