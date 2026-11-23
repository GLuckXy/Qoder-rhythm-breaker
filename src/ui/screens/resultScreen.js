// src/ui/screens/resultScreen.js — Owner: CORE（K-13 界面⑤：结算 + K-15 的「下一关」出口）
// 口径（§7.3 + PRD §14，R6 修订）：
//   · Perfect 率 = PERFECT 数 / **本局可判事件数** = 初始谱面可判定障碍 + 复活补发的新实例（DIS-05）
//     背景层 judgable:false 始终不计入；重开（R）回初始谱面基线，不跨局累加
//   · 核心命中率 = 核心可判事件 PERFECT 数 / 核心可判事件数（展示项，不参与 Perfect 率）
//   · rank S/A/B/C 由 DisassembleSystem.rank() 给（S 需 Perfect 率达阈且 MISS=0）
//   · 寂静段光点的 MISS 单列（dotMiss），它不进 §7.3 的 miss 数
// 本界面不读时间（T4）：所有数字都来自 stats 快照。

import { h, row, col, headline, caption, panel, primaryButton, button } from './dom.js';

const RANK_NOTE = { S: '完美拆解', A: '声部还原', B: '还能更准', C: '再来一遍' };

function stat(label, value, role) {
  const box = h(
    'div',
    {
      class: 'rb-text',
      dataset: { role: role || 'stat' },
      style: 'display:flex;flex-direction:column;gap:.15em;min-width:8.5em'
    },
    [h('div', { class: 'rb-text rb-text-caption', text: label }), h('div', { class: 'rb-text rb-text-hud rb-num', text: String(value) })]
  );
  return box;
}

/**
 * 分母口径行（DEF-02 / R6 修订后的文案）：
 *   分母 = 本局可判事件数 = 初始谱面可判定障碍 + 复活补发的新实例（DIS-05 的 -rvN）。
 *   补发数为 0 的干净局不写增量（没有的东西不必解释）；老快照缺 baseTotal 时按 total−补发 回推。
 */
function denomNote(st) {
  const total = st.total || 0;
  const revived = st.revivedIssued || 0;
  const base = Number.isFinite(st.baseTotal) ? st.baseTotal : Math.max(0, total - revived);
  const split = revived > 0 ? `（初始谱面可判定障碍 ${base} + 复活补发 ${revived}）` : '（初始谱面可判定障碍）';
  return `分母 = 本局可判事件 ${total}${split} · PERFECT ${st.perfect || 0} · 核心 ${st.coreTotal || 0} · 背景层不计入`;
}

function trackRow(track, hp, hpMax, silenced) {
  return row([
    h('span', { class: 'rb-chip rb-text-caption', dataset: { track } }, []),
    h('span', { class: 'rb-hp', dataset: { track, role: `hp-${track}` } }, Array.from({ length: hpMax || 0 }, (_, i) => h('i', { dataset: { spent: i >= (hp || 0) ? 'true' : 'false' } }))),
    caption(hpMax ? (hp === 0 ? '已拆解' : `${hp}/${hpMax}${silenced ? '' : '（仍在本关）'}`) : '本关无声部')
  ]);
}

/**
 * @param {{stats:object, level?:object, hpMax?:object, hasNext:boolean, nextId?:number, allCleared?:boolean}} data
 * @param {{onNext:Function, onRetry:Function, onSelect:Function, onTitle:Function}} deps
 */
export function buildResult(data = {}, deps = {}) {
  const st = data.stats || {};
  const hpMax = data.hpMax || { kick: 0, bass: 0, synth: 0 };
  const hp = st.hp || {};
  const rank = st.rank || 'C';
  const active = ['kick', 'bass', 'synth'].filter((t) => hpMax[t] > 0);

  const next = primaryButton(data.hasNext ? `下一关 · L${data.nextId}` : data.allCleared ? '全部通关 · 回标题' : '回标题', () => {
    if (data.hasNext && deps.onNext) deps.onNext(data.nextId);
    else if (deps.onTitle) deps.onTitle({ notice: data.allCleared ? '六关全部拆解完成 · 通关' : '回到标题' });
  });
  next.setAttribute('data-role', st.disassembled ? 'result-next' : 'result-next-incomplete');
  const retry = button('重开本关（R）', () => deps.onRetry && deps.onRetry());
  retry.setAttribute('data-role', 'result-retry');
  const select = button('选关', () => deps.onSelect && deps.onSelect());
  select.setAttribute('data-role', 'result-select');
  const title = button('回标题', () => deps.onTitle && deps.onTitle({ notice: `L${(data.level || {}).id ?? '?'} 已结算` }));
  title.setAttribute('data-role', 'result-title');

  return panel(
    col(
      [
        row([
          h('div', { class: 'rb-text rb-text-display rb-glow-system', dataset: { role: 'rank' }, text: rank }),
          col([
            headline(`L${(data.level || {}).id ?? '?'} ${(data.level || {}).title || ''}`, 'rb-text-title'),
            caption(`${RANK_NOTE[rank] || ''} · ${st.disassembled ? '全声部已拆解 → 寂静段走完' : '未拆完（分母仍按本局可判事件计，Perfect 率照算）'}`)
          ])
        ]),
        row(
          [
            stat('Perfect 率', `${((st.perfectRate || 0) * 100).toFixed(1)}%`, 'perfect-rate'),
            stat('核心命中率', `${((st.coreHitRate || 0) * 100).toFixed(0)}%`, 'core-rate'),
            stat('最高连击', st.maxCombo || 0, 'max-combo'),
            stat('MISS', st.miss || 0, 'miss'),
            stat('光点 MISS', st.dotMiss || 0, 'dot-miss')
          ],
          { style: 'display:flex;gap:1.4em;flex-wrap:wrap;align-items:flex-start' }
        ),
        caption(denomNote(st)),
        row(active.map((t) => trackRow(t, hp[t], hpMax[t], (st.disassembledTracks || []).includes(t))), { style: 'display:flex;gap:1.6em;flex-wrap:wrap' }),
        row([next, retry, select, title])
      ].filter(Boolean),
      { style: 'gap:.85em;align-items:flex-start' }
    ),
    { role: 'result' }
  );
}

export default buildResult;
