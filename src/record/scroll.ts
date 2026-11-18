import type { Point, Rect } from '../types.ts';

export type Block = 'start' | 'center' | 'end' | 'nearest';

export interface ScrollPlanArgs {
  block: Block;
  /**
   * Leaves a container as it is when the target is already fully visible in it.
   */
  ifNeeded: boolean;
  cursor: Point;
  /**
   * Plans for this viewport rectangle and the page scroll only, instead of the element.
   */
  rect?: Rect;
}

/**
 * The next wheel step that brings a target into view.
 */
export interface ScrollPlan {
  /**
   * Wheel delta in CSS pixels. Zero when no container has to scroll.
   */
  dx: number;
  dy: number;
  /**
   * Where the cursor must be so that the wheel scrolls the right container. Null when the
   * wheel cannot reach that container.
   */
  point: Point | null;
  /**
   * Depth of the container to scroll: 0 is the outermost one.
   */
  level: number;
  /**
   * The target is visible in the viewport and in all its clipping ancestors.
   */
  inView: boolean;
  /**
   * The target is in a child frame, which the planner does not handle.
   */
  inFrame: boolean;
}

/**
 * In-page: plans the next wheel step that brings `element` into view. It simulates the
 * scroll of each scroll container, inner to outer, like `scrollIntoView`, then returns the
 * step of the outermost container that must move, so that inner containers come into view
 * first. Playwright serializes this function into the page: it must be self-contained.
 */
export function planScroll(element: Element, args: ScrollPlanArgs): ScrollPlan {
  type Box = { left: number; top: number; right: number; bottom: number };
  type Axis = 'x' | 'y';
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  const result = { dx: 0, dy: 0, point: null, level: 0, inView: true, inFrame: false };
  if (!win || win !== win.top) {
    return { ...result, inFrame: true };
  }
  const root = doc.scrollingElement ?? doc.documentElement;
  const html = doc.documentElement;
  // In quirks mode the scrolling element is <body>, and its client size is the viewport.
  const viewport: Box = { left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight };
  const rootStyles = [html, doc.body].filter(Boolean).map((el) => getComputedStyle(el));

  const parentOf = (node: Element): Element | null =>
    node.assignedSlot ?? node.parentElement ?? ((node.getRootNode() as ShadowRoot).host || null);
  const portOf = (el: Element): Box => {
    if (el === root) {
      return viewport;
    }
    const rect = el.getBoundingClientRect();
    const left = rect.left + el.clientLeft;
    const top = rect.top + el.clientTop;
    return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight };
  };
  const intersect = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const range = (el: Element, axis: Axis) =>
    axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  const scrollable = (el: Element, axis: Axis): boolean => {
    if (range(el, axis) < 1) {
      return false;
    }
    const key = axis === 'y' ? 'overflowY' : 'overflowX';
    if (el === root) {
      return !rootStyles.some((style) => /hidden|clip/.test(style[key]));
    }
    return /auto|scroll|overlay/.test(getComputedStyle(el)[key]);
  };
  const offset = (el: Element, axis: Axis) => (axis === 'y' ? el.scrollTop : el.scrollLeft);
  const room = (el: Element, axis: Axis, sign: number): number => {
    if (!scrollable(el, axis)) {
      return 0;
    }
    return sign > 0 ? range(el, axis) - offset(el, axis) : offset(el, axis);
  };
  const delta = (
    a0: number,
    a1: number,
    p0: number,
    p1: number,
    block: Block,
    ifNeeded: boolean,
  ) => {
    const size = a1 - a0;
    const port = p1 - p0;
    const margin = Math.max(0, Math.min(32, port * 0.1, (port - size) / 2));
    const inside = a0 >= p0 - 0.5 && a1 <= p1 + 0.5;
    if (inside && (ifNeeded || block === 'nearest')) {
      return 0;
    }
    if (size > port || block === 'start') {
      return a0 - (p0 + margin);
    }
    if (block === 'end') {
      return a1 - (p1 - margin);
    }
    if (block === 'nearest') {
      return a0 < p0 ? a0 - (p0 + margin) : a1 - (p1 - margin);
    }
    return (a0 + a1) / 2 - (p0 + p1) / 2;
  };
  const hit = (x: number, y: number): Element | null => {
    let el = doc.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) {
        break;
      }
      el = inner;
    }
    return el;
  };

  const clips: Element[] = [];
  const chain: Element[] = [];
  let fixed = false;
  let node = args.rect ? null : parentOf(element);
  const htmlVisible = getComputedStyle(html).overflowX === 'visible';
  while (node && node !== root && node !== html) {
    const style = getComputedStyle(node);
    // Overflow on <body> moves to the viewport when <html> has none.
    const clipping =
      (style.overflowX !== 'visible' || style.overflowY !== 'visible') &&
      !(node === doc.body && htmlVisible);
    if (clipping) {
      clips.push(node);
      if (scrollable(node, 'x') || scrollable(node, 'y')) {
        chain.push(node);
      }
    }
    if (style.position === 'fixed') {
      fixed = true;
      break;
    }
    node = parentOf(node);
  }
  if (!fixed) {
    chain.push(root);
  }

  const target: Box = args.rect
    ? {
        left: args.rect.x,
        top: args.rect.y,
        right: args.rect.x + args.rect.width,
        bottom: args.rect.y + args.rect.height,
      }
    : (({ left, top, right, bottom }) => ({ left, top, right, bottom }))(
        element.getBoundingClientRect(),
      );
  const region = clips.map(portOf).reduce(intersect, viewport);
  const seen = intersect(target, region);
  const fits = (a0: number, a1: number, s0: number, s1: number, r0: number, r1: number) =>
    s1 - s0 >= Math.min(a1 - a0, r1 - r0) - 1;
  const inView =
    fits(target.top, target.bottom, seen.top, seen.bottom, region.top, region.bottom) &&
    fits(target.left, target.right, seen.left, seen.right, region.left, region.right);

  let box = { ...target };
  const steps = chain.map((el) => {
    const port = portOf(el);
    const clamp = (d: number, axis: Axis) =>
      scrollable(el, axis)
        ? Math.max(-offset(el, axis), Math.min(range(el, axis) - offset(el, axis), d))
        : 0;
    const dy = clamp(
      delta(box.top, box.bottom, port.top, port.bottom, args.block, args.ifNeeded),
      'y',
    );
    const dx = clamp(delta(box.left, box.right, port.left, port.right, 'center', true), 'x');
    box = {
      left: box.left - dx,
      right: box.right - dx,
      top: box.top - dy,
      bottom: box.bottom - dy,
    };
    return { el, dx, dy };
  });
  const index = steps.findLastIndex((step) => Math.abs(step.dx) >= 1 || Math.abs(step.dy) >= 1);
  if (index < 0) {
    return { ...result, inView };
  }
  const step = steps[index];
  const axis: Axis = Math.abs(step.dy) >= 1 ? 'y' : 'x';
  const amount = axis === 'y' ? step.dy : step.dx;
  const outer = step.el === root ? [] : clips.slice(clips.indexOf(step.el) + 1);
  const area = [portOf(step.el), ...outer.map(portOf)].reduce(intersect, viewport);
  const reaches = (p: Point): boolean => {
    for (let el = hit(p.x, p.y); el; el = el === root ? null : parentOf(el)) {
      if (room(el, axis, amount) >= 1) {
        return el === step.el;
      }
    }
    return false;
  };
  const candidates: Point[] = [];
  const grid = 7;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      candidates.push({
        x: area.left + ((area.right - area.left) * (i + 0.5)) / grid,
        y: area.top + ((area.bottom - area.top) * (j + 0.5)) / grid,
      });
    }
  }
  const distance = (p: Point) => Math.hypot(p.x - args.cursor.x, p.y - args.cursor.y);
  candidates.sort((a, b) => distance(a) - distance(b));
  const { x, y } = args.cursor;
  if (x > area.left + 2 && x < area.right - 2 && y > area.top + 2 && y < area.bottom - 2) {
    candidates.unshift(args.cursor);
  }
  const usable = area.right - area.left >= 4 && area.bottom - area.top >= 4;
  return {
    ...result,
    dx: axis === 'x' ? amount : 0,
    dy: axis === 'y' ? amount : 0,
    point: usable ? (candidates.find(reaches) ?? null) : null,
    level: chain.length - 1 - index,
    inView,
  };
}

/**
 * In-page: resolves when the scroll offsets of the element's ancestors stop changing,
 * or after about 1.5 s.
 */
export async function scrollIdle(element: Element): Promise<void> {
  const parentOf = (node: Element): Element | null =>
    node.assignedSlot ?? node.parentElement ?? ((node.getRootNode() as ShadowRoot).host || null);
  const ancestors: Element[] = [];
  for (let node = parentOf(element); node; node = parentOf(node)) {
    ancestors.push(node);
  }
  let last = '';
  let same = 0;
  for (let i = 0; i < 90 && same < 3; i++) {
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
      setTimeout(resolve, 50);
    });
    const now = ancestors.map((el) => `${el.scrollLeft},${el.scrollTop}`).join(';');
    same = now === last ? same + 1 : 0;
    last = now;
  }
}
