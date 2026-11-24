'use strict';

const element = (id) => document.getElementById(id);
const canvas = element('canvas');
const scene = element('scene');
const namespace = 'http://www.w3.org/2000/svg';
const cardWidth = 250;
const horizontalGap = 30;
let nodes = new Map();
let roots = [];
let expanded = new Set();
let positions = new Map();
let selected = '';
let transform = { x: 0, y: 0, scale: 1 };
let minimumScale = 0.002;
let matches = [];
let activeResult = -1;
let noticeTimer;
let animationFrame;
let importVersion = 0;

function svgElement(tag, attributes = {}, content) {
  const result = document.createElementNS(namespace, tag);
  for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, value);
  if (content !== undefined) result.textContent = content;
  return result;
}

function notify(message) {
  clearTimeout(noticeTimer);
  element('notice').textContent = message;
  element('notice').hidden = false;
  noticeTimer = setTimeout(() => { element('notice').hidden = true; }, 6500);
}

function validate(records) {
  if (!Array.isArray(records) || !records.length) throw new Error('JSON 顶层必须是非空节点数组。');
  const index = new Map();
  for (const [position, record] of records.entries()) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`第 ${position + 1} 条必须是节点对象。`);
    if (typeof record.node !== 'string' || !record.node.trim() || typeof record.name !== 'string' || typeof record.parent !== 'string') throw new Error(`第 ${position + 1} 条的 node/name/parent 必须为字符串，node 不能为空。`);
    if (index.has(record.node)) throw new Error(`重复 ID：${record.node}`);
    const abstract = record.abstract === undefined ? [] : record.abstract;
    const otherInfo = record.other_info === undefined ? {} : record.other_info;
    if (!Array.isArray(abstract) || abstract.some((line) => typeof line !== 'string')) throw new Error(`节点 ${record.node} 的 abstract 必须为字符串数组。`);
    if (!otherInfo || typeof otherInfo !== 'object' || Array.isArray(otherInfo)) throw new Error(`节点 ${record.node} 的 other_info 必须为对象。`);
    index.set(record.node, { ...record, abstract, other_info: otherInfo, children: [] });
  }
  const completed = new Set();
  for (const identifier of index.keys()) {
    const path = new Set();
    let current = identifier;
    while (index.has(current) && !completed.has(current)) {
      if (path.has(current)) throw new Error(`检测到循环关系：${current}`);
      path.add(current);
      current = index.get(current).parent;
    }
    for (const entry of path) completed.add(entry);
  }
  const treeRoots = [];
  for (const record of index.values()) {
    if (record.parent && index.has(record.parent)) index.get(record.parent).children.push(record.node);
    else treeRoots.push(record.node);
  }
  // Count every descendant once, independent of the visible expansion state.
  const traversal = [...treeRoots];
  for (let position = 0; position < traversal.length; position += 1) {
    traversal.push(...index.get(traversal[position]).children);
  }
  for (const identifier of traversal.reverse()) {
    const record = index.get(identifier);
    record.descendantCount = record.children.reduce((total, child) => total + 1 + index.get(child).descendantCount, 0);
  }
  return { index, treeRoots };
}

function loadRecords(records, filename) {
  const { index, treeRoots } = validate(records);
  clearTimeout(noticeTimer);
  element('notice').hidden = true;
  cancelAnimationFrame(animationFrame);
  nodes = index;
  roots = treeRoots;
  element('expand-all').disabled = false;
  element('collapse-all').disabled = false;
  expanded = new Set();
  selected = '';
  let level = roots;
  for (let depth = 0; depth < 2; depth += 1) {
    const next = [];
    for (const identifier of level) {
      expanded.add(identifier);
      next.push(...nodes.get(identifier).children);
    }
    level = next;
  }
  element('welcome').hidden = true;
  element('details').hidden = true;
  element('search').value = '';
  closeResults();
  element('title').textContent = filename.replace(/\.json$/i, '');
  const missing = roots.filter((identifier) => nodes.get(identifier).parent).length;
  element('summary').textContent = `${nodes.size.toLocaleString()} 个节点 · ${roots.length} 棵树${missing ? ` · ${missing} 个节点缺失父节点，已作为独立树展示` : ''}`;
  render();
  const firstRoot = positions.get(roots[0]);
  const initialScale = Math.min(0.85, (canvas.clientWidth - 48) / cardWidth);
  transform = { scale: initialScale, x: canvas.clientWidth / 2 - (firstRoot.x + cardWidth / 2) * initialScale, y: 165 };
  applyTransform();
  if (missing) notify(`${missing} 个节点的父节点不在文件中，已保留为独立子树。`);
}

async function loadFile(file) {
  if (!file) return;
  const version = ++importVersion;
  try {
    const records = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
    if (version === importVersion) loadRecords(records, file.name);
  } catch (error) {
    if (version === importVersion) notify(`加载失败：${error.message}`);
  }
}

function shorten(text, length) {
  const characters = Array.from(text);
  let width = 0;
  let result = '';
  for (const character of characters) {
    width += /[^\x00-\xff]/.test(character) ? 1.7 : 1;
    if (width > length) return `${result}…`;
    result += character;
  }
  return result;
}

function render() {
  const visible = [];
  const stack = roots.map((identifier) => [identifier, 0]).reverse();
  const levelHeights = [];
  while (stack.length) {
    const [identifier, depth] = stack.pop();
    const record = nodes.get(identifier);
    const height = 84 + record.abstract.length * 18;
    visible.push({ identifier, depth, height });
    levelHeights[depth] = Math.max(levelHeights[depth] || 0, height);
    if (expanded.has(identifier)) {
      for (let index = record.children.length - 1; index >= 0; index -= 1) stack.push([record.children[index], depth + 1]);
    }
  }
  const widths = new Map();
  for (const { identifier } of [...visible].reverse()) {
    const children = expanded.has(identifier) ? nodes.get(identifier).children : [];
    widths.set(identifier, Math.max(cardWidth, children.reduce((sum, child) => sum + widths.get(child), 0) + Math.max(0, children.length - 1) * horizontalGap));
  }
  const levelOffsets = [0];
  for (const height of levelHeights) levelOffsets.push(levelOffsets[levelOffsets.length - 1] + height + 60);
  const leftEdges = new Map();
  let rootOffset = 0;
  for (const root of roots) {
    leftEdges.set(root, rootOffset);
    rootOffset += widths.get(root) + 80;
  }
  positions = new Map();
  for (const entry of visible) {
    const { identifier, depth } = entry;
    const left = leftEdges.get(identifier);
    const width = widths.get(identifier);
    positions.set(identifier, { x: left + width / 2 - cardWidth / 2, y: levelOffsets[depth], height: entry.height });
    if (expanded.has(identifier)) {
      const children = nodes.get(identifier).children;
      const total = children.reduce((sum, child) => sum + widths.get(child), 0) + Math.max(0, children.length - 1) * horizontalGap;
      let offset = left + (width - total) / 2;
      for (const child of children) {
        leftEdges.set(child, offset);
        offset += widths.get(child) + horizontalGap;
      }
    }
  }
  const fragment = document.createDocumentFragment();
  for (const { identifier } of visible) {
    const record = nodes.get(identifier);
    const position = positions.get(identifier);
    const parentPosition = positions.get(record.parent);
    if (parentPosition) {
      const startX = parentPosition.x + cardWidth / 2;
      const startY = parentPosition.y + parentPosition.height;
      const endX = position.x + cardWidth / 2;
      const middleY = (startY + position.y) / 2;
      fragment.append(svgElement('path', { class: 'link', d: `M${startX},${startY} C${startX},${middleY} ${endX},${middleY} ${endX},${position.y}` }));
    }
  }
  for (const { identifier } of visible) {
    const record = nodes.get(identifier);
    const position = positions.get(identifier);
    const group = svgElement('g', { class: `node${selected === identifier ? ' selected' : ''}`, transform: `translate(${position.x},${position.y})`, tabindex: 0, role: 'button', 'aria-label': `${record.name}，查看详情`, 'data-node': identifier });
    group.append(svgElement('title', {}, [record.name, ...record.abstract].join('\n')));
    group.append(svgElement('rect', { class: 'node-card', width: cardWidth, height: position.height, rx: 12 }));
    group.append(svgElement('circle', { class: 'node-avatar', cx: 29, cy: 29, r: 14 }));
    group.append(svgElement('text', { class: 'node-initial', x: 29, y: 33, 'text-anchor': 'middle' }, Array.from(record.name.trim())[0] || '·'));
    group.append(svgElement('text', { class: 'node-name', x: 51, y: 34 }, shorten(record.name, 17)));
    record.abstract.forEach((line, index) => group.append(svgElement('text', { class: 'node-abstract', x: 18, y: 63 + index * 18 }, shorten(line, 27))));
    if (record.parent && !nodes.has(record.parent)) group.append(svgElement('text', { class: 'missing-mark', x: 18, y: position.height - 12 }, '父节点缺失'));
    group.addEventListener('click', (event) => {
      if (suppressClick) return;
      selectNode(identifier);
      showDetails(record, event.clientX, event.clientY);
    });
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const bounds = group.getBoundingClientRect();
        selectNode(identifier);
        showDetails(record, bounds.right, bounds.top);
      }
    });
    if (record.children.length) {
      const toggle = svgElement('g', { class: 'toggle', transform: `translate(${cardWidth - 180},${position.height - 24})`, role: 'button', tabindex: 0, 'aria-label': `${expanded.has(identifier) ? '收起' : '展开'} ${record.name}，直属下级 ${record.children.length} 人，全部下级 ${record.descendantCount} 人`, 'aria-expanded': expanded.has(identifier), 'data-toggle': identifier });
      toggle.append(svgElement('title', {}, '全部下级包含直属及更深层下级，不包含当前节点；折叠时仍统计全部下级。'));
      toggle.append(svgElement('rect', { width: 166, height: 19, rx: 6 }));
      toggle.append(svgElement('text', { x: 83, y: 13, 'text-anchor': 'middle' }, `${expanded.has(identifier) ? '−' : '+'} 直属 ${record.children.length} · 全部 ${record.descendantCount}`));
      const activate = (event) => { event.stopPropagation(); if (!suppressClick) toggleNode(identifier); };
      toggle.addEventListener('click', activate);
      toggle.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event); }
      });
      group.append(toggle);
    }
    fragment.append(group);
  }
  scene.replaceChildren(fragment);
  minimumScale = Math.min(0.002, fittingTransform().scale / 2);
  applyTransform();
}

function selectNode(identifier) {
  selected = identifier;
  for (const group of scene.querySelectorAll('.node')) group.classList.toggle('selected', group.dataset.node === identifier);
}

function toggleNode(identifier) {
  cancelAnimationFrame(animationFrame);
  const previous = positions.get(identifier);
  if (expanded.has(identifier)) expanded.delete(identifier);
  else expanded.add(identifier);
  element('details').hidden = true;
  render();
  const current = positions.get(identifier);
  transform.x += (previous.x - current.x) * transform.scale;
  transform.y += (previous.y - current.y) * transform.scale;
  applyTransform();
  for (const toggle of scene.querySelectorAll('[data-toggle]')) if (toggle.dataset.toggle === identifier) toggle.focus({ preventScroll: true });
}

function applyTransform() {
  scene.setAttribute('transform', `translate(${transform.x},${transform.y}) scale(${transform.scale})`);
  const percentage = transform.scale * 100;
  element('reset-zoom').textContent = `${percentage < 1 ? percentage.toFixed(2) : Math.round(percentage)}%`;
}

function fittingTransform() {
  if (!positions.size) return { x: 0, y: 0, scale: 1 };
  let right = 0;
  let bottom = 0;
  for (const position of positions.values()) {
    right = Math.max(right, position.x + cardWidth);
    bottom = Math.max(bottom, position.y + position.height);
  }
  const width = Math.max(100, canvas.clientWidth - 80);
  const height = Math.max(100, canvas.clientHeight - 235);
  const scale = Math.min(1, width / right, height / bottom);
  return { x: (canvas.clientWidth - right * scale) / 2, y: 145 + (height - bottom * scale) / 2, scale };
}

function moveTo(target) {
  cancelAnimationFrame(animationFrame);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { transform = target; applyTransform(); return; }
  const original = { ...transform };
  const start = performance.now();
  function frame(now) {
    const progress = Math.min(1, (now - start) / 300);
    const eased = 1 - (1 - progress) ** 3;
    for (const key of ['x', 'y', 'scale']) transform[key] = original[key] + (target[key] - original[key]) * eased;
    applyTransform();
    if (progress < 1) animationFrame = requestAnimationFrame(frame);
  }
  animationFrame = requestAnimationFrame(frame);
}

function fitView() { if (positions.size) moveTo(fittingTransform()); }

function setAllExpanded(shouldExpand) {
  if (!nodes.size) return;
  cancelAnimationFrame(animationFrame);
  expanded = new Set(shouldExpand ? [...nodes.values()].filter((record) => record.children.length).map((record) => record.node) : []);
  element('details').hidden = true;
  render();
  fitView();
}

function zoomAt(scale, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
  cancelAnimationFrame(animationFrame);
  const next = Math.max(minimumScale, Math.min(3, scale));
  transform.x = x - (x - transform.x) * next / transform.scale;
  transform.y = y - (y - transform.y) * next / transform.scale;
  transform.scale = next;
  element('details').hidden = true;
  applyTransform();
}

function closeResults() {
  element('results').hidden = true;
  element('search').setAttribute('aria-expanded', 'false');
  element('search').removeAttribute('aria-activedescendant');
}

function updateSearch() {
  const query = element('search').value.trim().toLocaleLowerCase();
  const results = element('results');
  results.replaceChildren();
  matches = query ? [...nodes.values()].filter((record) => record.name.toLocaleLowerCase().includes(query)) : [];
  activeResult = -1;
  element('search').removeAttribute('aria-activedescendant');
  if (!query) { closeResults(); selectNode(''); return; }
  results.hidden = false;
  element('search').setAttribute('aria-expanded', 'true');
  const count = document.createElement('div');
  count.className = 'result-count';
  count.textContent = matches.length ? `${matches.length} 个匹配结果` : nodes.size ? '没有找到匹配的姓名' : '请先导入组织数据';
  results.append(count);
  for (const [index, record] of matches.entries()) {
    const button = document.createElement('button');
    button.className = 'result';
    button.id = `search-result-${index}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', 'false');
    button.tabIndex = -1;
    for (const [tag, content] of [['strong', record.name], ['small', record.abstract.join(' · ')], ['em', record.node]]) {
      const text = document.createElement(tag);
      text.textContent = content;
      button.append(text);
    }
    button.addEventListener('click', () => focusResult(record));
    results.append(button);
  }
}

function focusResult(record) {
  let current = record.parent;
  while (nodes.has(current)) { expanded.add(current); current = nodes.get(current).parent; }
  selected = record.node;
  render();
  const position = positions.get(record.node);
  const scale = Math.min(1, (canvas.clientWidth - 40) / cardWidth);
  moveTo({ scale, x: canvas.clientWidth / 2 - (position.x + cardWidth / 2) * scale, y: Math.max(170, canvas.clientHeight / 2) - (position.y + position.height / 2) * scale });
  element('details').hidden = true;
  closeResults();
}

function showDetails(record, clientX, clientY) {
  const details = element('details');
  element('detail-name').textContent = record.name;
  element('detail-abstract').textContent = record.abstract.join('\n');
  const fields = element('detail-fields');
  fields.replaceChildren();
  for (const [label, value] of [['ID', record.node], ...Object.entries(record.other_info)]) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value === '' || value === null ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    fields.append(term, description);
  }
  details.hidden = false;
  const bounds = element('workspace').getBoundingClientRect();
  details.style.left = `${Math.max(12, Math.min(bounds.width - details.offsetWidth - 12, clientX - bounds.left + 12))}px`;
  details.style.top = `${Math.max(12, Math.min(bounds.height - details.offsetHeight - 12, clientY - bounds.top + 12))}px`;
}

let drag = null;
let suppressClick = false;
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('.node')) return;
  cancelAnimationFrame(animationFrame);
  drag = { x: event.clientX, y: event.clientY, originalX: transform.x, originalY: transform.y, moved: false };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const deltaX = event.clientX - drag.x;
  const deltaY = event.clientY - drag.y;
  if (Math.abs(deltaX) + Math.abs(deltaY) > 4) drag.moved = true;
  transform.x = drag.originalX + deltaX;
  transform.y = drag.originalY + deltaY;
  applyTransform();
  element('details').hidden = true;
});
function finishDrag() {
  suppressClick = Boolean(drag?.moved);
  drag = null;
  canvas.classList.remove('dragging');
  setTimeout(() => { suppressClick = false; }, 0);
}
canvas.addEventListener('pointerup', finishDrag);
canvas.addEventListener('pointercancel', finishDrag);
canvas.addEventListener('wheel', (event) => {
  if (!nodes.size) return;
  event.preventDefault();
  const bounds = canvas.getBoundingClientRect();
  zoomAt(transform.scale * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.03 : 0.002)), event.clientX - bounds.left, event.clientY - bounds.top);
}, { passive: false });
element('zoom-in').addEventListener('click', () => zoomAt(transform.scale * 1.25));
element('zoom-out').addEventListener('click', () => zoomAt(transform.scale / 1.25));
element('reset-zoom').addEventListener('click', () => zoomAt(1));
element('fit').addEventListener('click', fitView);
element('expand-all').addEventListener('click', () => setAllExpanded(true));
element('collapse-all').addEventListener('click', () => setAllExpanded(false));
element('close-details').addEventListener('click', () => { element('details').hidden = true; });
document.addEventListener('click', (event) => {
  if (!event.target.closest('#details, .node')) element('details').hidden = true;
  if (!event.target.closest('.search-area')) closeResults();
});
element('search').addEventListener('input', updateSearch);
element('search').addEventListener('focus', updateSearch);
element('search').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeResults(); return; }
  if (!matches.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    activeResult = (activeResult + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
    element('results').hidden = false;
    element('search').setAttribute('aria-expanded', 'true');
    const buttons = element('results').querySelectorAll('.result');
    buttons.forEach((button, index) => { button.classList.toggle('active', index === activeResult); button.setAttribute('aria-selected', String(index === activeResult)); });
    buttons[activeResult].scrollIntoView({ block: 'nearest' });
    element('search').setAttribute('aria-activedescendant', buttons[activeResult].id);
  }
  if (event.key === 'Enter') { event.preventDefault(); focusResult(matches[Math.max(0, activeResult)]); }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); element('search').focus(); }
  if (event.key === 'Escape') { closeResults(); element('details').hidden = true; }
});
for (const id of ['open-file', 'choose-file']) element(id).addEventListener('click', () => element('file').click());
element('file').addEventListener('change', (event) => { loadFile(event.target.files[0]); event.target.value = ''; });
let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (!Array.from(event.dataTransfer.types).includes('Files')) return;
  event.preventDefault(); dragDepth += 1; element('drop-overlay').hidden = false;
});
document.addEventListener('dragover', (event) => { event.preventDefault(); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) element('drop-overlay').hidden = true; });
document.addEventListener('drop', (event) => {
  event.preventDefault(); dragDepth = 0; element('drop-overlay').hidden = true;
  loadFile(event.dataTransfer.files[0]);
});
element('demo').addEventListener('click', () => {
  importVersion += 1;
  const records = [];
  const names = ['林知远', '陈星河', '许亦舟', '叶青', '周予安', '宋时雨', '苏明', '江澄'];
  for (let index = 0; index < 34; index += 1) {
    records.push({ node: `demo-${index}`, name: index < names.length ? names[index] : `团队伙伴 ${index - 7}`, parent: index === 0 || index === 29 ? '' : index > 29 ? 'demo-29' : `demo-${Math.floor((index - 1) / 3)}`, abstract: [index < 4 ? '组织与团队' : '产品与技术', ['上海 · 创新中心', '深圳 · 研发中心', '北京 · 产品中心'][index % 3]], other_info: { 角色: index === 0 ? '负责人' : '团队成员', 邮箱: `member${index}@example.com`, 备注: '这是一份虚构的演示数据。' } });
  }
  loadRecords(records, '探索示例 · 一起看见连接');
});
window.addEventListener('resize', () => { element('details').hidden = true; });
