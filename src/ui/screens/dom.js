// src/ui/screens/dom.js — Owner: CORE（K-13 五界面的 DOM 基座，leader 决策 L-04：界面是 DOM 覆盖层，不进 Phaser）
// 约束（与 tools/contractTest.mjs 的 installFakeDom 同一能力子集，这样界面在无浏览器环境里也能回归）：
//   · 只用 createElement / setAttribute / appendChild / removeChild / addEventListener / textContent
//   · 不用 className / innerHTML / querySelector / el.remove() / CSS.escape
//   · 颜色一律走 neon.css 的 var(--rb-*) 与 .rb-* 类（CR-13：本文件不出现任何色值字面量）
// #ui-root 默认 pointer-events:none，只有 button/input/select/a 自动可点（neon.css 已开好）。

/** 当前文档（Node 环境里没有 document 时返回 null，所有挂载函数都要能退化）。 */
export function doc() {
  return typeof document !== 'undefined' && document ? document : null;
}

const PROP_MAP = { class: 'class', style: 'style', type: 'type', value: 'value', min: 'min', max: 'max', step: 'step', checked: 'checked', disabled: 'disabled', id: 'id', title: 'title', 'aria-label': 'aria-label' };

/**
 * 建一个元素。`props` 里 on* 键当监听器装，其余走 setAttribute；`text` 键写文本。
 * @param {string} tag
 * @param {object} [props]
 * @param {Array<string|number|object|null>} [children]
 */
export function h(tag, props = {}, children = []) {
  const d = doc();
  if (!d) return null;
  const el = d.createElement(tag);
  for (const key of Object.keys(props || {})) {
    const v = props[key];
    if (v === null || v === undefined || v === false) continue;
    if (key.startsWith('on') && typeof v === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), v);
    } else if (key === 'dataset') {
      for (const dk of Object.keys(v || {})) el.setAttribute(`data-${dk}`, String(v[dk]));
    } else if (key === 'text') {
      el.textContent = String(v);
    } else if (key in PROP_MAP || key.startsWith('data-')) {
      el.setAttribute(key === 'class' ? 'class' : key, v === true ? '' : String(v));
    }
  }
  // children 允许三种写法：单个节点 / 节点数组 / 字符串。
  // （早先用 `children.length ? children : []` 判定，单个节点对象没有 length → 整棵子树被丢掉，
  //  panel(col(...)) 就只剩下空面板框 —— 假 DOM 的 screens case 就是这么抓到的。）
  const list = children === null || children === undefined ? [] : [].concat(children);
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : d.createTextNode(String(c)));
  }
  return el;
}

/**
 * 按钮皮肤：neon.css 只给了 pointer-events 与焦点环，没给按钮外形（`.rb-panel` 是唯一的面板底），
 * 所以这里用 **同源表达式**拼外形——全部取 var(--rb-*) + color-mix，不写色值字面量（CR-13）。
 */
export const BTN_STYLE =
  'font:inherit;color:var(--rb-ink);' +
  'background:color-mix(in srgb, var(--rb-panel) 86%, transparent);' +
  'border:1px solid color-mix(in srgb, var(--rb-hairline) 70%, transparent);' +
  'border-radius:4px;padding:.35em .9em;cursor:pointer';

/** 主按钮：系统青描边（PRD 纪律：系统色不表达声部，只表达「可操作」）。 */
export const BTN_PRIMARY_STYLE =
  'font:inherit;color:var(--rb-ink);' +
  'background:color-mix(in srgb, var(--rb-panel) 86%, transparent);' +
  'border:1px solid color-mix(in srgb, var(--rb-system) 70%, transparent);' +
  'border-radius:4px;padding:.45em 1.2em;cursor:pointer';

/** 按钮：界面里所有可点项都走它，保证 pointer-events 与焦点环（neon.css :focus-visible）都在。 */
export function button(label, onClick, props = {}) {
  return h(
    'button',
    Object.assign({ type: 'button', class: 'rb-text rb-text-sub rb-btn', style: BTN_STYLE, onclick: onClick, text: String(label) }, props),
    []
  );
}

/** 主按钮（点击进入 / 下一关这种一步动作）。 */
export function primaryButton(label, onClick, props = {}) {
  return button(label, onClick, Object.assign({ class: 'rb-text rb-text-body rb-btn rb-btn-primary', style: BTN_PRIMARY_STYLE }, props));
}

/** 通用行容器（DOM 里没有 .rb-row 类，布局用 inline style 的 flex —— 布局不是颜色，允许）。 */
export function row(children, extra = {}) {
  return h('div', Object.assign({ style: 'display:flex;gap:.8em;align-items:center;flex-wrap:wrap' }, extra), children);
}

export function col(children, extra = {}) {
  return h('div', Object.assign({ style: 'display:flex;flex-direction:column;gap:.6em' }, extra), children);
}

/** 标题层大字（.rb-text-display + 系统青发光，neon.css 里的唯一合法写法）。 */
export function headline(text, cls = 'rb-text-display rb-glow-system') {
  return h('div', { class: cls, text: String(text) });
}

export function caption(text) {
  return h('div', { class: 'rb-text rb-text-caption', text: String(text) });
}

/** 面板外框：满屏居中遮罩 + .rb-panel。遮罩本身不许吃鼠标事件以外的颜色，全部由 neon.css 给。 */
export function panel(children, opts = {}) {
  return h(
    'div',
    {
      dataset: { role: opts.role || 'panel' },
      style: [
        'position:absolute',
        'inset:0',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        opts.blockPointer ? '' : 'pointer-events:none',
        'padding:2vh 2vw'
      ]
        .filter(Boolean)
        .join(';')
    },
    [h('div', { class: 'rb-panel rb-text', style: 'max-width:min(92vw,72em);pointer-events:auto' }, children)]
  );
}

/** 从父节点摘掉（假 DOM 没有 el.remove()，一律走 parentNode.removeChild）。 */
export function detach(el) {
  if (!el) return false;
  const p = el.parentNode;
  if (p && typeof p.removeChild === 'function') p.removeChild(el);
  return true;
}

/** 目标挂载点：优先 deps.root（测试注入），其次 #ui-root。 */
export function mountRoot(deps = {}) {
  if (deps.root) return deps.root;
  const d = doc();
  return d && typeof d.getElementById === 'function' ? d.getElementById('ui-root') : null;
}

/** 事件流退订登记表（K-05 同款纪律：DOM 界面也不许留监听）。 */
export function binder() {
  const offs = [];
  return {
    on(el, type, fn) {
      if (!el || typeof el.addEventListener !== 'function') return () => {};
      el.addEventListener(type, fn);
      offs.push(() => {
        if (typeof el.removeEventListener === 'function') el.removeEventListener(type, fn);
      });
      return offs[offs.length - 1];
    },
    offAll() {
      while (offs.length) {
        const fn = offs.pop();
        try {
          fn();
        } catch {
          /* 退订抛错不阻断销毁 */
        }
      }
    },
    count() {
      return offs.length;
    }
  };
}
