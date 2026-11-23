// src/ui/screens/resultScreen.js — Owner: CORE（K-13 界面⑤：结算 + K-15 的「下一关」出口）
// 口径（§7.3 + PRD §14，DEF-04 修回固定分母）：
//   · Perfect 率 = PERFECT 数 / **本关可判定障碍总数 N**（固定分母，与复活/重开无关；复活只把原件放回场上，不新增可判对象）
//     背景层 judgable:false 始终不计入；重开（R）回同一基线，不跨局累加
//   · 核心命中率 = 核心可判事件 PERFECT 数 / 核心可判事件数（展示项，不参与 Perfect 率）
//   · rank S/A/B/C 由 DisassembleSystem.rank() 给（界面不自算第二套口径，只解释它用了哪套）
//   · 寂静段光点的 MISS 单列（dotMiss），它不进 §7.3 的 miss 数
// DEF-05（两个数并存，屏幕上不许混为一谈）：
//   · 「谱面 Perfect 率」= PERFECT / 本关可判定障碍 N（§7.3 字面口径，展示 + 存档 perfectRate）
//   · 「评级 Perfect 率」= (PERFECT + 踩灭光点) / 本局实际遭遇（遭遇口径；被拆解退役后没再回来的
//     障碍没被玩家面对过，不进它的分母；进过场的光点按 Q5 进分母）。rank 阈值 ≥0.85/0.70/0.50 卡的是这个。
//   老快照缺 encounter* 字段时评级率显示「—」，不影响其余数字（字段是加性的，T5）。
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
 * 分母口径行（DEF-04 修订回 PRD §7.3 的文案）：
 *   分母 = 本关可判定障碍总数 N（固定分母，与复活/重开无关）。复活只是把被拆解摘掉的原件放回场上，
 *   不新增可判定对象，所以「复活恢复 K」是**独立观测量、不参与求和**（旧的「+ 复活补发 R」写法已推翻）。
 */
function denomNote(st) {
  const total = st.total || 0;
  const revived = st.revivedIssued || 0;
  const base = Number.isFinite(st.baseTotal) ? st.baseTotal : total;
  const obs = revived > 0 ? ` · 复活恢复 ${revived}（不改分母）` : '';
  return `分母 = 本关可判定障碍 ${base}（固定分母，与复活/重开无关）${obs} · PERFECT ${st.perfect || 0} · 核心 ${st.coreTotal || 0} · 背景层不计入`;
}

/**
 * 评级口径行（DEF-05）：S/A/B/C 卡的是「遭遇口径」，与上面那行 §7.3 的固定分母并存、互不替换。
 *   分母 = 本局真正面对过的可判定障碍（同一 id 只计一次；拆解退役后没再回来的没被面对过，不计；
 *          背景层 judgable:false 永不进队列也不计）+ 寂静段里真正亮起过的光点（Q5：不打也要付分母）。
 *   分子 = 障碍 PERFECT + 踩灭的光点。
 * @returns {string} 缺 encounter 字段（老快照）时返回 ''，让调用方不渲染这行而不是撒谎
 */
function rankNote(st) {
  if (!Number.isFinite(st.encounterRate)) return '';
  const dots = st.encounterDots || 0;
  const stomped = st.dotsStomped || 0;
  return `评级口径 = （PERFECT ${st.perfect || 0} + 踩灭光点 ${stomped}）/（实际遭遇障碍 ${st.encounterObstacles || 0} + 进场光点 ${dots}）= ${st.encounterPerfect || 0}/${st.encounterTotal || 0}` +
    ` · 退役未回来的障碍没被面对过，不进这一分母（${Math.max(0, (st.baseTotal || 0) - (st.encounterObstacles || 0))} 个）· 阈值 S 0.85 / A 0.70 / B 0.50 · C 通关即保底`;
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

  const enc = Number.isFinite(st.encounterRate);
  const rn = rankNote(st);
  const cols = [
    row([
      h('div', { class: 'rb-text rb-text-display rb-glow-system', dataset: { role: 'rank' }, text: rank }),
      col([
        headline(`L${(data.level || {}).id ?? '?'} ${(data.level || {}).title || ''}`, 'rb-text-title'),
        caption(`${RANK_NOTE[rank] || ''} · ${st.disassembled ? '全声部已拆解 → 寂静段走完' : '未拆完（分母仍按本局可判事件计，Perfect 率照算）'}`)
      ])
    ]),
    row(
      [
        stat('评级 Perfect 率', enc ? `${(st.encounterRate * 100).toFixed(1)}%` : '—', 'encounter-rate'),
        stat('谱面 Perfect 率', `${((st.perfectRate || 0) * 100).toFixed(1)}%`, 'perfect-rate'),
        stat('核心命中率', `${((st.coreHitRate || 0) * 100).toFixed(0)}%`, 'core-rate'),
        stat('最高连击', st.maxCombo || 0, 'max-combo'),
        stat('MISS', st.miss || 0, 'miss'),
        stat('光点 MISS', st.dotMiss || 0, 'dot-miss')
      ],
      { style: 'display:flex;gap:1.4em;flex-wrap:wrap;align-items:flex-start' }
    ),
    caption(denomNote(st))
  ];
  if (rn) cols.push(caption(rn));
  cols.push(
    row(active.map((t) => trackRow(t, hp[t], hpMax[t], (st.disassembledTracks || []).includes(t))), { style: 'display:flex;gap:1.6em;flex-wrap:wrap' }),
    row([next, retry, select, title])
  );

  return panel(
    col(cols.filter(Boolean), { style: 'gap:.85em;align-items:flex-start' }),
    { role: 'result' }
  );
}

export default buildResult;
