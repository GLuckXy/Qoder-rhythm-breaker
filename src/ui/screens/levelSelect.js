// src/ui/screens/levelSelect.js — Owner: CORE（K-13 界面②：选关）
// 数据来源：src/data/save.js 的 levels[id]（{cleared, rank, perfectRate, maxCombo, miss}）+ BootScene 的关卡清单。
// 本界面不读时间（T4），不猜进度锁：PRD 的关卡推进是「结算→下一关」的线性流，选关只做直达入口。

import { h, row, col, headline, caption, panel, button } from './dom.js';

const RANK_LABEL = { S: 'S', A: 'A', B: 'B', C: 'C' };

/** 一张关卡卡：编号 + 曲名 + BPM + 已通关徽章 + Perfect 率。 */
function card(level, entry, onPick) {
  const cleared = !!(entry && entry.cleared);
  const rate = Number.isFinite(entry && entry.perfectRate) ? entry.perfectRate : null;
  const badge = h('span', {
    class: 'rb-chip rb-text-caption',
    dataset: { role: cleared ? 'badge-cleared' : 'badge-todo' },
    style: 'border:1px solid color-mix(in srgb, var(--rb-hairline) 70%, transparent);border-radius:3px;padding:.1em .45em',
    text: cleared ? `已通关 ${RANK_LABEL[entry.rank] || '—'}` : '未通关'
  });
  const btn = button(`L${level.id} · ${level.title || ''}`, () => onPick(level.id));
  btn.setAttribute('data-role', `pick-${level.id}`);
  btn.setAttribute('data-cleared', cleared ? 'true' : 'false');
  return h(
    'div',
    {
      class: 'rb-text',
      dataset: { role: 'level-card' },
      style: 'display:flex;flex-direction:column;gap:.35em;min-width:15em;padding:.5em .7em;border:1px solid color-mix(in srgb, var(--rb-hairline) 45%, transparent);border-radius:4px'
    },
    [btn, caption(`${level.bpm || '?'} BPM · ${level.lengthBeats || '?'} 拍`), row([badge, caption(rate === null ? 'Perfect —' : `Perfect ${(rate * 100).toFixed(1)}%`)])]
  );
}

/**
 * @param {{levels:Array<object>, entries:Record<string,object>}} data
 * @param {{onPick:Function, onBack:Function}} deps
 */
export function buildSelect(data = {}, deps = {}) {
  const levels = Array.isArray(data.levels) ? data.levels : [];
  const entries = data.entries || {};
  const back = button('返回标题', () => deps.onBack && deps.onBack());
  back.setAttribute('data-role', 'select-back');
  const grid = h(
    'div',
    { dataset: { role: 'level-grid' }, style: 'display:flex;gap:.7em;flex-wrap:wrap;justify-content:flex-start' },
    levels.map((l) => card(l, entries[String(l.id)] || entries[l.id], (id) => deps.onPick && deps.onPick(id)))
  );
  if (!levels.length) grid.appendChild(caption('尚无谱面（SOUND 名下 level*.json 未就位）'));

  return panel(col([headline('选关', 'rb-text-title rb-glow-system'), grid, row([back]), caption('徽章 = 已把该关全部声部拆解；谱面 Perfect 率 = PERFECT 数 / 本关可判定障碍总数（固定分母，与复活/重开无关，不含背景层）')], { style: 'gap:.9em' }), { role: 'select' });
}

export default buildSelect;
