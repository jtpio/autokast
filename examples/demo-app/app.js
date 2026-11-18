import { COLUMNS, PEOPLE, PRIORITIES, STATS, TAGS, TASKS, TEAM, WEEKLY } from './data.js';

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const root = document.documentElement;
const board = $('#board-columns');
const searchInput = $('#search');
const toasts = $('.toasts');
const chart = $('#chart');
const tooltip = $('.chart-tooltip');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
const VIEWS = ['board', 'analytics', 'settings'];

const people = structuredClone(PEOPLE);
const state = {
  view: null,
  theme: root.dataset.theme,
  query: '',
  tasks: new Map(TASKS.map((task) => [task.id, structuredClone(task)])),
  nextId: 142,
  wipLimit: 4,
  selectedId: null,
  sort: { key: 'done', dir: 'desc' },
};

let drag = null;
let justDragged = false;
let detail = null;
let modal = null;
let palette = null;
let themeTimer = 0;
let chartWidth = 0;
const countFrames = new Map();

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const icon = (name, className = 'icon') =>
  `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const columnName = (id) => COLUMNS.find((column) => column.id === id).name;
const listFor = (status) => $(`[data-column="${status}"] .card-list`, board);
const isTyping = (element) =>
  element instanceof Element &&
  element.matches('input:not([type="range"]), textarea, [contenteditable="true"]');

function initials(name) {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0].toUpperCase()).join('') || '?';
}

function avatar(personId, size = 'sm') {
  const person = people[personId];
  return `<span class="avatar avatar-${size}" style="--avatar: ${person.color}" data-person="${personId}">${escapeHtml(initials(person.name))}</span>`;
}

function priorityIcon(priority) {
  if (priority === 'urgent') {
    return '<svg class="prio-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="4" fill="currentColor"/><path d="M8 4.6v4.2M8 11.3v.1" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>';
  }
  const level = { low: 1, medium: 2, high: 3 }[priority];
  const bars = [0, 1, 2].map(
    (i) =>
      `<rect x="${2 + i * 4.5}" y="${10 - i * 3.5}" width="3" height="${4 + i * 3.5}" rx="1" fill="currentColor" opacity="${i < level ? 1 : 0.22}"/>`,
  );
  return `<svg class="prio-icon" viewBox="0 0 16 16" aria-hidden="true">${bars.join('')}</svg>`;
}

const priorityBadge = (priority) =>
  `<span class="prio" data-priority="${priority}">${priorityIcon(priority)}<span>${PRIORITIES[priority]}</span></span>`;
const tagChip = (tag) => `<span class="tag" data-tag="${tag}">${TAGS[tag]}</span>`;

/**
 * Orbit status glyph: a satellite that travels further along its ring as work advances.
 */
function statusGlyph(status) {
  const svg = (body) =>
    `<svg class="status-glyph" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const ring = (extra) =>
    `<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" ${extra}/>`;
  if (status === 'backlog') return svg(ring('stroke-dasharray="1.8 2.1"'));
  if (status === 'done') {
    return svg(
      '<circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="m5.3 8.2 1.9 1.9 3.6-3.9" fill="none" style="stroke: var(--surface)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    );
  }
  const angle = ((status === 'progress' ? 130 : 250) * Math.PI) / 180;
  const x = (8 + 5.5 * Math.sin(angle)).toFixed(2);
  const y = (8 - 5.5 * Math.cos(angle)).toFixed(2);
  const large = status === 'progress' ? 0 : 1;
  return svg(
    `${ring('opacity="0.25"')}<path d="M8 2.5A5.5 5.5 0 ${large} 1 ${x} ${y}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="${x}" cy="${y}" r="2.2" fill="currentColor"/>`,
  );
}

const statusLabel = (status) =>
  `<span class="status" data-status="${status}">${statusGlyph(status)}${columnName(status)}</span>`;

function highlight(text, query) {
  const index = query ? text.toLowerCase().indexOf(query) : -1;
  if (index < 0) return escapeHtml(text);
  const end = index + query.length;
  return `${escapeHtml(text.slice(0, index))}<mark>${escapeHtml(text.slice(index, end))}</mark>${escapeHtml(text.slice(end))}`;
}

function matches(task, query) {
  if (!query) return true;
  const text = [
    task.title,
    task.id,
    ...task.tags.map((tag) => TAGS[tag]),
    people[task.assignee].name,
    PRIORITIES[task.priority],
  ]
    .join(' ')
    .toLowerCase();
  return query.split(/\s+/).every((word) => text.includes(word));
}

function mount(templateId) {
  const element = $(`#${templateId}`).content.firstElementChild.cloneNode(true);
  document.body.append(element);
  return element;
}

/**
 * Plays the exit animation, then removes the element. It leaves the accessibility tree at once.
 */
function dismiss(element) {
  if (element.contains(document.activeElement)) document.activeElement.blur();
  element.classList.add('is-closing');
  element.setAttribute('aria-hidden', 'true');
  element.inert = true;
  setTimeout(() => element.remove(), 200);
}

/**
 * Animates elements from their old to their new layout position after `mutate` runs.
 */
function flip(elements, mutate) {
  const before = new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
  mutate();
  if (reducedMotion) return;
  for (const [element, first] of before) {
    if (!element.isConnected) continue;
    element.getAnimations().forEach((animation) => animation.cancel());
    const last = element.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 240,
      easing: EASE,
    });
  }
}

function toast(message) {
  const element = document.createElement('div');
  element.className = 'toast';
  element.dataset.testid = 'toast';
  element.innerHTML = `<span class="toast-mark">${icon('check')}</span>`;
  element.append(message);
  toasts.append(element);
  while (toasts.children.length > 3) toasts.firstElementChild.remove();
  setTimeout(() => dismiss(element), 2800);
}

function setTheme(theme) {
  if (theme === state.theme) return;
  state.theme = theme;
  root.classList.add('theme-switching');
  root.dataset.theme = theme;
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => root.classList.remove('theme-switching'), 320);
  syncThemeControls();
}

const toggleTheme = () => setTheme(state.theme === 'dark' ? 'light' : 'dark');

function syncThemeControls() {
  $('[data-testid="theme-toggle"]').setAttribute('aria-pressed', String(state.theme === 'dark'));
  selectSegment($('[data-setting="theme"]'), state.theme);
}

function viewFromHash() {
  const view = location.hash.slice(1);
  return VIEWS.includes(view) ? view : 'board';
}

function navigate(view) {
  if (location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
  showView(view);
}

function showView(view) {
  if (view === state.view) return;
  state.view = view;
  for (const section of $$('.view')) section.hidden = section.dataset.view !== view;
  for (const link of $$('.nav-link')) {
    if (link.dataset.view === view) {
      link.setAttribute('aria-current', 'page');
      $('.nav-indicator').style.setProperty('--y', `${link.offsetTop + 8}px`);
    } else {
      link.removeAttribute('aria-current');
    }
  }
  $('.views').scrollTop = 0;
  if (view !== 'board') closeDetail();
  if (view === 'analytics') playAnalytics();
}

function createCard(task) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = task.id;
  card.dataset.testid = `card-${task.id}`;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', task.title);
  const comments = task.comments
    ? `<span class="card-meta">${icon('comment', 'icon icon-xs')}${task.comments}</span>`
    : '';
  card.innerHTML = `
    <div class="card-top"><span class="card-id">${task.id}</span>${priorityBadge(task.priority)}</div>
    <p class="card-title">${highlight(task.title, state.query)}</p>
    <div class="card-foot">${task.tags.map(tagChip).join('')}${comments}${avatar(task.assignee)}</div>`;
  card.hidden = !matches(task, state.query);
  return card;
}

function renderBoard() {
  board.innerHTML = COLUMNS.map(
    (column) => `
    <section class="column" data-column="${column.id}" data-status="${column.id}" data-testid="column-${column.id}" aria-labelledby="column-${column.id}-name">
      <header class="column-head">
        ${statusGlyph(column.id)}
        <h2 class="micro column-name" id="column-${column.id}-name">${column.name}</h2>
        <span class="count" data-testid="column-count-${column.id}"></span>
        ${column.id === 'progress' ? '<span class="wip" data-testid="wip-indicator"></span>' : ''}
        <button class="column-add" type="button" aria-label="Add task to ${column.name}" data-testid="add-task-${column.id}">${icon('plus')}</button>
      </header>
      <div class="card-list" data-testid="card-list-${column.id}"></div>
    </section>`,
  ).join('');
  for (const task of state.tasks.values()) listFor(task.status).append(createCard(task));
  updateColumns();
}

function updateColumns() {
  for (const column of $$('.column', board)) {
    const list = $('.card-list', column);
    const count = $$('.card:not([hidden]):not(.is-drag-source), .drop-placeholder', list).length;
    $('.count', column).textContent = count;
    column.classList.toggle('is-empty', count === 0);
    list.dataset.empty = state.query ? 'No matching tasks' : 'Drop tasks here';
    if (column.dataset.column === 'progress') {
      column.classList.toggle('is-over-limit', count > state.wipLimit);
      $('.wip', column).textContent = `/ ${state.wipLimit}`;
    }
  }
  $('#board-count').textContent = `${state.tasks.size} tasks`;
  $('#nav-board-count').textContent = state.tasks.size;
}

function setQuery(value) {
  searchInput.value = value;
  state.query = value.trim().toLowerCase();
  $('.search').classList.toggle('has-value', value !== '');
  $('[data-testid="search-clear"]').hidden = value === '';
  for (const card of $$('.card', board)) {
    const task = state.tasks.get(card.dataset.id);
    card.hidden = !matches(task, state.query);
    $('.card-title', card).innerHTML = highlight(task.title, state.query);
  }
  updateColumns();
}

function focusSearch() {
  searchInput.focus();
  searchInput.select();
}

function columnAt(x) {
  return $$('.column', board).find((column) => {
    const rect = column.getBoundingClientRect();
    return x >= rect.left && x <= rect.right;
  });
}

function nextCard(element) {
  let next = element.nextElementSibling;
  while (next && (next.hidden || next.classList.contains('is-drag-source'))) {
    next = next.nextElementSibling;
  }
  return next;
}

function insertionPoint(list, y) {
  const top = list.getBoundingClientRect().top - list.scrollTop;
  const cards = $$('.card:not([hidden]):not(.is-drag-source)', list);
  return cards.find((card) => y < top + card.offsetTop + card.offsetHeight / 2) ?? null;
}

function startDrag() {
  const { card } = drag;
  const rect = card.getBoundingClientRect();
  const placeholder = document.createElement('div');
  placeholder.className = 'drop-placeholder';
  placeholder.dataset.testid = 'drop-placeholder';
  placeholder.style.height = `${rect.height}px`;
  const ghost = card.cloneNode(true);
  ghost.className = 'card drag-ghost';
  ghost.dataset.testid = 'drag-ghost';
  ghost.removeAttribute('role');
  ghost.removeAttribute('tabindex');
  ghost.removeAttribute('aria-label');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.width = `${rect.width}px`;
  document.body.append(ghost);
  card.after(placeholder);
  card.classList.add('is-drag-source');
  card.closest('.column').classList.add('is-over');
  document.body.classList.add('is-dragging');
  Object.assign(drag, {
    active: true,
    ghost,
    placeholder,
    from: card.closest('.column').dataset.column,
    offsetX: drag.startX - rect.left,
    offsetY: drag.startY - rect.top,
  });
}

function moveDrag(x, y) {
  const { ghost, placeholder } = drag;
  ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`;
  const column = columnAt(x);
  if (!column) return;
  const list = $('.card-list', column);
  const before = insertionPoint(list, y);
  if (placeholder.parentElement === list && nextCard(placeholder) === before) return;
  const cards = $$('.card:not([hidden]):not(.is-drag-source)', board);
  flip(cards, () => list.insertBefore(placeholder, before));
  for (const other of $$('.column', board)) other.classList.toggle('is-over', other === column);
  updateColumns();
}

function finishDrag(cancel) {
  const { card, ghost, placeholder, from } = drag;
  drag = null;
  if (cancel) card.after(placeholder);
  const target = placeholder.getBoundingClientRect();
  const list = placeholder.parentElement;
  placeholder.replaceWith(card);
  card.classList.remove('is-drag-source');
  card.classList.add('is-settling');
  document.body.classList.remove('is-dragging');
  for (const column of $$('.column.is-over', board)) column.classList.remove('is-over');
  const task = state.tasks.get(card.dataset.id);
  task.status = list.closest('.column').dataset.column;
  updateColumns();
  const settle = ghost.animate(
    [{ transform: `translate(${target.left}px, ${target.top}px)`, rotate: '0deg', scale: '1' }],
    { duration: reducedMotion ? 1 : 220, easing: EASE, fill: 'forwards' },
  );
  settle.onfinish = () => {
    ghost.remove();
    card.classList.remove('is-settling');
  };
  if (task.status !== from) toast(`${task.id} moved to ${columnName(task.status)}`);
  if (state.selectedId === task.id) renderDetail();
}

function onPointerDown(event) {
  const card = event.target.closest('.card');
  if (!card || event.button !== 0 || drag) return;
  drag = {
    card,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
  };
}

function onPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    startDrag();
  }
  moveDrag(event.clientX, event.clientY);
}

function onPointerUp(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    drag = null;
    return;
  }
  finishDrag(event.type === 'pointercancel');
  justDragged = true;
  setTimeout(() => (justDragged = false));
}

function openDetail(id) {
  state.selectedId = id;
  if (!detail) {
    detail = mount('tpl-detail');
    $('[data-testid="detail-close"]', detail).addEventListener('click', closeDetail);
  }
  renderDetail();
}

function renderDetail() {
  const task = state.tasks.get(state.selectedId);
  const slot = (name) => $(`[data-slot="${name}"]`, detail);
  const assignee = people[task.assignee].name;
  slot('id').textContent = task.id;
  slot('title').textContent = task.title;
  slot('status').innerHTML = statusLabel(task.status);
  slot('priority').innerHTML = priorityBadge(task.priority);
  slot('assignee').innerHTML = `${avatar(task.assignee)}<span>${escapeHtml(assignee)}</span>`;
  slot('tags').innerHTML = task.tags.map(tagChip).join('') || 'None';
  slot('due').innerHTML = task.due ? `${icon('calendar')}${task.due}` : 'No due date';
  slot('description').textContent = task.description || 'No description yet.';
  const activity = [
    `<li>${avatar(task.assignee)}<span><strong>${escapeHtml(assignee)}</strong> created the task</span><time>${task.created}</time></li>`,
  ];
  if (task.comments) {
    activity.push(
      `<li><span class="activity-icon">${icon('comment', 'icon icon-xs')}</span><span><strong>${task.comments} comments</strong> in the thread</span><time>Nov 16</time></li>`,
    );
  }
  slot('activity').innerHTML = activity.join('');
  for (const card of $$('.card', board)) {
    card.classList.toggle('is-selected', card.dataset.id === task.id);
  }
}

function closeDetail() {
  if (!detail) return;
  dismiss(detail);
  detail = null;
  state.selectedId = null;
  for (const card of $$('.card.is-selected', board)) card.classList.remove('is-selected');
}

function trapFocus(event, container) {
  if (event.key !== 'Tab') return;
  const items = $$('button:not(:disabled), input, textarea, [tabindex="0"]', container);
  const first = items[0];
  const last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openModal(column = 'backlog') {
  if (modal || palette) return;
  if (drag?.active) finishDrag(true);
  if (state.view !== 'board') navigate('board');
  const overlay = mount('tpl-modal');
  const form = $('form', overlay);
  const title = $('#task-title', overlay);
  const create = $('[data-testid="create-task"]', overlay);
  modal = {
    overlay,
    column,
    priority: 'medium',
    tags: new Set(),
    listbox: null,
    returnFocus: document.activeElement,
  };
  $('[data-slot="column"]', overlay).textContent = columnName(column);
  $('[data-slot="tags"]', overlay).innerHTML = Object.entries(TAGS)
    .map(
      ([tag, label]) =>
        `<button class="chip" type="button" aria-pressed="false" data-tag="${tag}" data-testid="tag-${tag}">${label}</button>`,
    )
    .join('');
  setPriority('medium');

  title.addEventListener('input', () => (create.disabled = !title.value.trim()));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    createTask();
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      createTask();
    }
  });
  overlay.addEventListener('pointerdown', (event) => {
    if (modal.listbox && !event.target.closest('.select')) closeListbox(false);
    if (event.target === overlay) closeModal();
  });
  overlay.addEventListener('click', (event) => {
    const target = event.target;
    if (target.closest('[data-action="cancel"]')) closeModal();
    else if (target.closest('.select-trigger')) modal.listbox ? closeListbox(true) : openListbox();
    else if (target.closest('[role="option"]')) choosePriority(target.closest('[role="option"]'));
    else if (target.closest('.chip')) toggleChip(target.closest('.chip'));
  });
  $('.select-trigger', overlay).addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openListbox();
    }
  });
  overlay.addEventListener('keydown', (event) => trapFocus(event, overlay));
  title.focus();
}

function closeModal() {
  if (!modal) return;
  const { overlay, returnFocus } = modal;
  modal = null;
  dismiss(overlay);
  returnFocus?.focus?.();
}

function toggleChip(chip) {
  const pressed = chip.getAttribute('aria-pressed') === 'true';
  chip.setAttribute('aria-pressed', String(!pressed));
  if (pressed) modal.tags.delete(chip.dataset.tag);
  else modal.tags.add(chip.dataset.tag);
}

function setPriority(value) {
  modal.priority = value;
  $('[data-slot="priority"]', modal.overlay).innerHTML = priorityBadge(value).replace(
    '<span>',
    '<span id="priority-value">',
  );
}

function openListbox() {
  const select = $('.select', modal.overlay);
  const listbox = document.createElement('ul');
  listbox.className = 'listbox';
  listbox.id = 'priority-listbox';
  listbox.tabIndex = -1;
  listbox.dataset.testid = 'priority-options';
  listbox.setAttribute('role', 'listbox');
  listbox.setAttribute('aria-labelledby', 'priority-label');
  listbox.innerHTML = Object.keys(PRIORITIES)
    .map(
      (value) =>
        `<li role="option" id="priority-option-${value}" data-value="${value}" data-testid="priority-option-${value}" aria-selected="${value === modal.priority}">${priorityBadge(value)}${icon('check', 'icon option-check')}</li>`,
    )
    .join('');
  listbox.addEventListener('keydown', onListboxKey);
  listbox.addEventListener('pointermove', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) setActiveOption(option.dataset.value);
  });
  select.append(listbox);
  const trigger = $('.select-trigger', select);
  trigger.setAttribute('aria-expanded', 'true');
  trigger.setAttribute('aria-controls', listbox.id);
  modal.listbox = listbox;
  setActiveOption(modal.priority);
  listbox.focus();
}

function closeListbox(focusTrigger) {
  const trigger = $('.select-trigger', modal.overlay);
  dismiss(modal.listbox);
  modal.listbox = null;
  trigger.setAttribute('aria-expanded', 'false');
  trigger.removeAttribute('aria-controls');
  if (focusTrigger) trigger.focus();
}

function setActiveOption(value) {
  modal.active = value;
  modal.listbox.setAttribute('aria-activedescendant', `priority-option-${value}`);
  for (const option of $$('[role="option"]', modal.listbox)) {
    option.classList.toggle('is-active', option.dataset.value === value);
  }
}

function choosePriority(option) {
  setPriority(option.dataset.value);
  closeListbox(true);
}

function onListboxKey(event) {
  const values = Object.keys(PRIORITIES);
  const index = values.indexOf(modal.active);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : values.length - 1;
    setActiveOption(values[(index + step) % values.length]);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    choosePriority($(`[data-value="${modal.active}"]`, modal.listbox));
  } else if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    event.stopPropagation();
    closeListbox(true);
  }
}

function createTask() {
  const title = $('#task-title', modal.overlay).value.trim();
  if (!title) return;
  const task = {
    id: `ORB-${state.nextId++}`,
    title,
    status: modal.column,
    tags: Object.keys(TAGS).filter((tag) => modal.tags.has(tag)),
    priority: modal.priority,
    assignee: 'me',
    comments: 0,
    due: '',
    created: 'Today',
    description: $('#task-description', modal.overlay).value.trim(),
  };
  state.tasks.set(task.id, task);
  closeModal();
  if (!matches(task, state.query)) setQuery('');
  const list = listFor(task.status);
  const card = createCard(task);
  list.scrollTop = 0;
  flip($$('.card:not([hidden])', list), () => list.prepend(card));
  card.classList.add('is-new');
  card.addEventListener('animationend', () => card.classList.remove('is-new'), { once: true });
  updateColumns();
  toast(`${task.id} created in ${columnName(task.status)}`);
}

const COMMANDS = [
  {
    id: 'go-board',
    group: 'Navigate',
    label: 'Go to Board',
    icon: 'board',
    keywords: 'kanban tasks view',
    run: () => navigate('board'),
  },
  {
    id: 'go-analytics',
    group: 'Navigate',
    label: 'Go to Analytics',
    icon: 'chart',
    keywords: 'stats metrics reports chart',
    run: () => navigate('analytics'),
  },
  {
    id: 'go-settings',
    group: 'Navigate',
    label: 'Go to Settings',
    icon: 'settings',
    keywords: 'preferences profile options',
    run: () => navigate('settings'),
  },
  {
    id: 'new-task',
    group: 'Actions',
    label: 'New task',
    icon: 'plus',
    keys: ['N'],
    keywords: 'create add issue',
    run: () => openModal(),
  },
  {
    id: 'toggle-theme',
    group: 'Actions',
    label: 'Toggle theme',
    icon: 'theme',
    keywords: 'dark light mode appearance',
    run: toggleTheme,
  },
  {
    id: 'search-tasks',
    group: 'Actions',
    label: 'Search tasks',
    icon: 'search',
    keys: ['/'],
    keywords: 'find filter',
    run: focusSearch,
  },
];

function openPalette() {
  if (palette || modal) return;
  if (drag?.active) finishDrag(true);
  const overlay = mount('tpl-palette');
  palette = {
    overlay,
    input: $('.palette-input', overlay),
    list: $('.palette-list', overlay),
    results: [],
    active: 0,
    returnFocus: document.activeElement,
  };
  palette.input.addEventListener('input', () => {
    palette.active = 0;
    renderPalette();
  });
  palette.input.addEventListener('keydown', onPaletteKey);
  palette.list.addEventListener('pointermove', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option && Number(option.dataset.index) !== palette.active) {
      setPaletteActive(Number(option.dataset.index));
    }
  });
  palette.list.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) runCommand(palette.results[Number(option.dataset.index)]);
  });
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) closePalette();
  });
  renderPalette();
  palette.input.focus();
}

function closePalette() {
  if (!palette) return;
  const { overlay, returnFocus } = palette;
  palette = null;
  dismiss(overlay);
  returnFocus?.focus?.();
}

function runCommand(command) {
  closePalette();
  command.run();
}

function renderPalette() {
  const query = palette.input.value.trim().toLowerCase();
  const words = query.split(/\s+/);
  palette.results = COMMANDS.filter((command) =>
    words.every((word) => `${command.label} ${command.keywords}`.toLowerCase().includes(word)),
  );
  if (!palette.results.length) {
    palette.list.innerHTML = '<div class="palette-empty">No commands match</div>';
    setPaletteActive(-1);
    return;
  }
  const groups = [...new Set(palette.results.map((command) => command.group))];
  palette.list.innerHTML = groups
    .map((group) => {
      const options = palette.results
        .map((command, index) => ({ command, index }))
        .filter(({ command }) => command.group === group)
        .map(({ command, index }) => {
          const name =
            command.icon === 'theme' ? (state.theme === 'dark' ? 'sun' : 'moon') : command.icon;
          const keys = command.keys
            ? `<span class="option-keys" aria-hidden="true">${command.keys.map((key) => `<kbd>${key}</kbd>`).join('')}</span>`
            : '';
          return `<div class="option" role="option" id="command-${command.id}" data-index="${index}" data-testid="command-${command.id}" aria-selected="false">${icon(name)}<span>${highlight(command.label, query)}</span>${keys}</div>`;
        })
        .join('');
      const id = `command-group-${group.toLowerCase()}`;
      return `<div role="group" aria-labelledby="${id}"><div class="micro option-group" id="${id}">${group}</div>${options}</div>`;
    })
    .join('');
  setPaletteActive(Math.min(palette.active, palette.results.length - 1));
}

function setPaletteActive(index) {
  palette.active = index;
  const options = $$('[role="option"]', palette.list);
  options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
  if (options[index]) {
    palette.input.setAttribute('aria-activedescendant', options[index].id);
    options[index].scrollIntoView({ block: 'nearest' });
  } else {
    palette.input.removeAttribute('aria-activedescendant');
  }
}

function onPaletteKey(event) {
  if (!palette) return;
  const count = palette.results.length;
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count) {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : count - 1;
    setPaletteActive((palette.active + step) % count);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (palette.results[palette.active]) runCommand(palette.results[palette.active]);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closePalette();
  } else if (event.key === 'Tab') {
    event.preventDefault();
  }
}

const formatNumber = (value, decimals = 0) =>
  value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

function renderStats() {
  $('#stats').innerHTML = STATS.map((stat) => {
    const unit = stat.unit ? `<span class="stat-unit">${stat.unit}</span>` : '';
    const arrow = icon(stat.trend === 'up' ? 'arrow-up' : 'arrow-down', 'icon icon-xs');
    return `
      <div class="stat" data-testid="stat-${stat.id}">
        <span class="micro">${stat.label}</span>
        <span class="stat-value"><span data-count="${stat.value}" data-decimals="${stat.decimals ?? 0}" data-suffix="${stat.suffix ?? ''}">${formatNumber(stat.value, stat.decimals)}${stat.suffix ?? ''}</span>${unit}</span>
        <span class="delta ${stat.good ? 'is-good' : 'is-bad'}"><span class="delta-value">${arrow}${stat.delta}</span>vs prior 12 weeks</span>
      </div>`;
  }).join('');
}

function countUp(element) {
  const target = Number(element.dataset.count);
  const decimals = Number(element.dataset.decimals);
  const suffix = element.dataset.suffix;
  cancelAnimationFrame(countFrames.get(element));
  if (reducedMotion) {
    element.textContent = formatNumber(target, decimals) + suffix;
    return;
  }
  element.textContent = formatNumber(0, decimals) + suffix;
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - start) / 1100);
    const eased = 1 - (1 - progress) ** 4;
    element.textContent = formatNumber(target * eased, decimals) + suffix;
    if (progress < 1) countFrames.set(element, requestAnimationFrame(step));
  };
  countFrames.set(element, requestAnimationFrame(step));
}

function playAnalytics() {
  for (const element of $$('[data-count]')) countUp(element);
  renderChart(true);
}

function barPath(x, y, width, height) {
  const r = Math.min(4, height, width / 2);
  return `M${x} ${y + height}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${y + r}V${y + height}Z`;
}

function renderChart(animate) {
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  if (!width) return;
  chartWidth = width;
  const pad = { top: 24, bottom: 30, left: 30 };
  const plotWidth = width - pad.left;
  const plotHeight = height - pad.top - pad.bottom;
  const slot = plotWidth / WEEKLY.length;
  const barWidth = Math.min(24, slot * 0.56);
  const round = (value) => Math.round(value * 10) / 10;
  const y = (value) => round(pad.top + plotHeight * (1 - value / 25));
  const grid = [0, 5, 10, 15, 20, 25]
    .map(
      (tick) =>
        `<line class="grid-line${tick ? '' : ' is-base'}" x1="${pad.left}" x2="${width}" y1="${y(tick)}" y2="${y(tick)}"/><text class="tick" x="${pad.left - 10}" y="${y(tick)}" dy="0.32em" text-anchor="end">${tick}</text>`,
    )
    .join('');
  const bars = WEEKLY.map((week, index) => {
    const x = round(pad.left + slot * index + (slot - barWidth) / 2);
    const top = y(week.value);
    const center = round(x + barWidth / 2);
    const current = index === WEEKLY.length - 1;
    const label = current
      ? `<text class="bar-value" x="${center}" y="${top - 8}" text-anchor="middle">${week.value}</text>`
      : '';
    return `<g class="bar-group" tabindex="0" role="img" aria-label="Week of ${week.label}: ${week.value} tasks completed" data-index="${index}" data-testid="chart-bar-${index}">
      <rect class="bar-hit" x="${round(pad.left + slot * index)}" y="${pad.top}" width="${round(slot)}" height="${plotHeight + pad.bottom}"/>
      <path class="bar${current ? ' is-current' : ''}" style="--delay: ${index * 45}ms" d="${barPath(x, top, round(barWidth), round(y(0) - top))}"/>
      ${label}<text class="axis-label${index % 2 ? '' : ' is-minor'}" x="${center}" y="${height - 8}" text-anchor="middle">${week.label}</text>
    </g>`;
  }).join('');
  $('svg', chart)?.remove();
  if (animate) chart.classList.remove('is-in');
  chart.insertAdjacentHTML(
    'afterbegin',
    `<svg width="${width}" height="${height}" role="group" aria-label="Tasks completed per week">${grid}${bars}</svg>`,
  );
  chart.getBoundingClientRect();
  chart.classList.add('is-in');
}

function showTooltip(group) {
  const index = Number(group.dataset.index);
  const week = WEEKLY[index];
  const bar = $('.bar', group).getBBox();
  const previous = WEEKLY[index - 1]?.value;
  const change =
    previous === undefined
      ? ''
      : `, ${week.value - previous >= 0 ? '+' : '−'}${Math.abs(week.value - previous)} on prior`;
  $('strong', tooltip).textContent = `${week.value} tasks`;
  $('span', tooltip).textContent = `Week of ${week.label}${change}`;
  const half = tooltip.offsetWidth / 2;
  const center = bar.x + bar.width / 2;
  tooltip.style.left = `${Math.min(Math.max(center, half), chart.clientWidth - half)}px`;
  tooltip.style.top = `${bar.y}px`;
  tooltip.classList.add('is-visible');
}

const hideTooltip = () => tooltip.classList.remove('is-visible');

function applySort(animate) {
  const { key, dir } = state.sort;
  const nameOf = (row) => people[row.person].name;
  const rows = [...TEAM].sort((a, b) => {
    const order = key === 'name' ? nameOf(a).localeCompare(nameOf(b)) : a[key] - b[key];
    return (dir === 'asc' ? order : -order) || nameOf(a).localeCompare(nameOf(b));
  });
  const tbody = $('#team-body');
  const elements = rows.map((row) => $(`[data-row="${row.person}"]`, tbody));
  const reorder = () => tbody.append(...elements);
  if (animate) flip(elements, reorder);
  else reorder();
  for (const th of $$('#team-table th')) {
    const sort = dir === 'asc' ? 'ascending' : 'descending';
    th.setAttribute('aria-sort', th.dataset.key === key ? sort : 'none');
  }
}

function renderTable() {
  $('#team-body').innerHTML = TEAM.map(
    (row) => `
    <tr data-row="${row.person}" data-testid="team-row-${row.person}">
      <td><span class="member">${avatar(row.person)}<span data-name-of="${row.person}">${escapeHtml(people[row.person].name)}</span></span></td>
      <td class="num">${row.open}</td>
      <td class="num">${row.done}</td>
      <td class="num">${row.cycle.toFixed(1)} d</td>
    </tr>`,
  ).join('');
  applySort(false);
}

function sortBy(key) {
  const { sort } = state;
  if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
  else sort.dir = key === 'name' ? 'asc' : 'desc';
  sort.key = key;
  applySort(true);
}

function selectSegment(group, value) {
  $$('[role="radio"]', group).forEach((button, index) => {
    const checked = button.dataset.value === value;
    button.setAttribute('aria-checked', String(checked));
    button.tabIndex = checked ? 0 : -1;
    if (checked) group.style.setProperty('--index', index);
  });
}

function applySetting(group, value) {
  if (group.dataset.setting === 'theme') {
    setTheme(value);
  } else {
    root.dataset.density = value;
    selectSegment(group, value);
  }
}

function renderPeople() {
  const me = people.me.name;
  for (const element of $$('[data-person="me"]')) element.textContent = initials(me);
  for (const element of $$('[data-name-of="me"]')) element.textContent = me;
  $('#me-avatar').setAttribute('aria-label', me || 'Account');
  if (detail) renderDetail();
}

function onEscape() {
  if (drag?.active) finishDrag(true);
  else if (palette) closePalette();
  else if (modal) closeModal();
  else if (detail) closeDetail();
}

renderBoard();
renderStats();
renderTable();
$('#members').innerHTML = Object.keys(people)
  .map((id) => avatar(id))
  .join('');
$('#members').setAttribute('aria-label', `${Object.keys(people).length} members`);
const meAvatar = $('#me-avatar');
meAvatar.className = 'avatar avatar-md';
meAvatar.dataset.person = 'me';
meAvatar.style.setProperty('--avatar', people.me.color);
meAvatar.textContent = initials(people.me.name);
syncThemeControls();
showView(viewFromHash());

board.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);
window.addEventListener('hashchange', () => showView(viewFromHash()));

board.addEventListener('click', (event) => {
  const add = event.target.closest('.column-add');
  const card = event.target.closest('.card');
  if (justDragged) return;
  if (add) openModal(add.closest('.column').dataset.column);
  else if (card) openDetail(card.dataset.id);
  else closeDetail();
});

board.addEventListener('keydown', (event) => {
  const card = event.target.closest('.card');
  if (card && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openDetail(card.dataset.id);
  }
});

searchInput.addEventListener('input', () => {
  if (state.view !== 'board') navigate('board');
  setQuery(searchInput.value);
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  if (searchInput.value) setQuery('');
  else searchInput.blur();
});

$('[data-testid="search-clear"]').addEventListener('click', () => {
  setQuery('');
  searchInput.focus();
});
$('[data-testid="new-task-button"]').addEventListener('click', () => openModal());
$('[data-testid="theme-toggle"]').addEventListener('click', toggleTheme);
$('[data-testid="quick-actions"]').addEventListener('click', openPalette);
$('[data-testid="save-settings"]').addEventListener('click', () => toast('Settings saved'));

document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'k') {
    event.preventDefault();
    if (palette) closePalette();
    else openPalette();
    return;
  }
  if (event.key === 'Escape') {
    onEscape();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
  if (modal || palette || drag) return;
  if (key === 'n') {
    event.preventDefault();
    openModal();
  } else if (key === '/') {
    event.preventDefault();
    focusSearch();
  }
});

chart.addEventListener('pointerover', (event) => {
  const group = event.target.closest('.bar-group');
  if (group) showTooltip(group);
});
chart.addEventListener('pointerleave', hideTooltip);
chart.addEventListener('focusin', (event) => {
  const group = event.target.closest('.bar-group');
  if (group) showTooltip(group);
});
chart.addEventListener('focusout', hideTooltip);
new ResizeObserver(() => {
  if (state.view === 'analytics' && chart.clientWidth !== chartWidth) renderChart(false);
}).observe(chart);

$('#team-table thead').addEventListener('click', (event) => {
  const th = event.target.closest('th');
  if (th) sortBy(th.dataset.key);
});

for (const group of $$('.segmented')) {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('[role="radio"]');
    if (button) applySetting(group, button.dataset.value);
  });
  group.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const buttons = $$('[role="radio"]', group);
    const index = buttons.indexOf(document.activeElement) + step + buttons.length;
    const next = buttons[index % buttons.length];
    next.focus();
    applySetting(group, next.dataset.value);
  });
}

for (const toggle of $$('.switch')) {
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-checked', String(toggle.getAttribute('aria-checked') !== 'true'));
  });
}

$('#display-name').addEventListener('input', (event) => {
  people.me.name = event.target.value.trim();
  renderPeople();
});

const wip = $('#wip-limit');
wip.addEventListener('input', () => {
  state.wipLimit = Number(wip.value);
  $('#wip-output').textContent = wip.value;
  wip.style.setProperty('--p', (wip.value - wip.min) / (wip.max - wip.min));
  updateColumns();
});
