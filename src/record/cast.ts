import type { Locator, Page } from 'playwright';
import type {
  CaptionEvent,
  CaptionOptions,
  Cast,
  ClickOptions,
  DragOptions,
  MouseButton,
  MoveOptions,
  Point,
  Rect,
  ScrollOptions,
  ScrollToOptions,
  Size,
  SpotlightOptions,
  Target,
  TimelineEvent,
  TypeOptions,
  ZoomToOptions,
} from '../types.ts';
import type { CursorStyleProbe } from './cursor-style.ts';
import { CAST_DEFAULTS, type ResolvedOptions } from './defaults.ts';
import { caretLinePrefix, leadingWhitespace } from './editor.ts';
import {
  cursorPath,
  dragEase,
  easeInOutCubic,
  moveDuration,
  moveEase,
  scrollDuration,
  typingDelay,
} from './motion.ts';
import type { Pace } from './pace.ts';
import { createRandom, type Random } from './random.ts';
import { planScroll, scrollIdle, type Block } from './scroll.ts';
import type { Timeline } from './timeline.ts';

const MOVE_TICK = 8;
const SCROLL_TICK = 16;
const STABLE_INTERVAL = 20;
const MAX_SCROLL_STEPS = 8;

type Modifier = NonNullable<ClickOptions['modifiers']>[number];

interface Resolved {
  point: Point;
  box?: Rect;
  locator?: Locator;
}

/**
 * The Cast call that threw an error, and the record time of the failure.
 */
export interface CallFailure {
  call: string;
  t: number;
}

export interface DirectorContext {
  page: Page;
  options: ResolvedOptions;
  timeline: Timeline;
  pace: Pace;
  cursorStyle: CursorStyleProbe;
}

function isPoint(target: Target): target is Point | Rect {
  return (
    typeof target === 'object' &&
    target !== null &&
    typeof (target as Point).x === 'number' &&
    typeof (target as Point).y === 'number'
  );
}

function isRect(target: Point | Rect): target is Rect {
  return typeof (target as Rect).width === 'number' && typeof (target as Rect).height === 'number';
}

/**
 * True when a position (fractions of the target size) is outside the target.
 */
function isOutside(position?: { x: number; y: number }): boolean {
  return !!position && (position.x < 0 || position.x > 1 || position.y < 0 || position.y > 1);
}

function sameBox(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Short description of a target, for error messages and the action log.
 */
export function describeTarget(target: Target): string {
  if (typeof target === 'string') {
    return JSON.stringify(shorten(target, 60));
  }
  if (isPoint(target)) {
    const { x, y } = target;
    return JSON.stringify(
      isRect(target) ? { x, y, width: target.width, height: target.height } : { x, y },
    );
  }
  return shorten(String(target), 60);
}

function describeText(text: string): string {
  return JSON.stringify(shorten(text, 30));
}

/**
 * The Cast implementation: drives the page with human-like input and logs the timeline.
 */
export class Director implements Cast {
  readonly page: Page;
  readonly viewport: Size;
  /**
   * The last Cast call that succeeded, for error messages.
   */
  lastCall?: string;
  private readonly options: ResolvedOptions;
  private readonly timeline: Timeline;
  private readonly pace: Pace;
  /**
   * Default time limit for Playwright waits, which run in real time.
   */
  private readonly timeout: number;
  private readonly cursorStyle: CursorStyleProbe;
  private readonly motionRandom: Random;
  private readonly typingRandom: Random;
  private readonly failures = new WeakMap<object, CallFailure>();
  private position: Point;
  private region?: 'cut' | 'speed';

  constructor(context: DirectorContext) {
    this.page = context.page;
    this.options = context.options;
    this.timeline = context.timeline;
    this.pace = context.pace;
    this.timeout = context.options.timeout * context.pace.timeoutScale;
    this.cursorStyle = context.cursorStyle;
    this.viewport = { ...context.options.viewport };
    this.position = { ...context.options.cursor.start };
    this.motionRandom = createRandom(context.options.seed);
    this.typingRandom = createRandom(context.options.seed ^ 0x9e3779b9);
  }

  /**
   * The innermost Cast call that threw `error`, if a Cast call threw it.
   */
  failureOf(error: unknown): CallFailure | undefined {
    return typeof error === 'object' && error !== null ? this.failures.get(error) : undefined;
  }

  moveTo(target: Target, options: MoveOptions = {}): Promise<void> {
    return this.step(`moveTo(${describeTarget(target)})`, async () => {
      const { point } = await this.resolve(target, options);
      await this.moveCursor(point, options.duration);
    });
  }

  click(target: Target, options: ClickOptions = {}): Promise<void> {
    return this.step(`click(${describeTarget(target)})`, () => this.clickTarget(target, options));
  }

  dblclick(target: Target, options: ClickOptions = {}): Promise<void> {
    return this.step(`dblclick(${describeTarget(target)})`, () =>
      this.clickTarget(target, { ...options, clickCount: 2 }),
    );
  }

  rightClick(target: Target, options: ClickOptions = {}): Promise<void> {
    return this.step(`rightClick(${describeTarget(target)})`, () =>
      this.clickTarget(target, { ...options, button: 'right' }),
    );
  }

  hover(target: Target, options: MoveOptions & { hold?: number } = {}): Promise<void> {
    return this.step(`hover(${describeTarget(target)})`, async () => {
      const { point } = await this.resolve(target, options);
      await this.moveCursor(point, options.duration);
      await this.pace.sleep(options.hold ?? CAST_DEFAULTS.hoverHold);
    });
  }

  drag(from: Target, to: Target, options: DragOptions = {}): Promise<void> {
    return this.step(`drag(${describeTarget(from)}, ${describeTarget(to)})`, async () => {
      const source = await this.resolve(from, options);
      await this.moveCursor(source.point, options.duration);
      await this.pace.sleep(this.options.pacing.beforeClick);
      await this.mouseDown('left', 1);
      try {
        await this.pace.sleep(CAST_DEFAULTS.dragHold);
        const destination = await this.resolve(to, { ...options, position: options.toPosition });
        const distance = Math.hypot(
          destination.point.x - this.position.x,
          destination.point.y - this.position.y,
        );
        const duration =
          options.dragDuration ??
          Math.max(
            CAST_DEFAULTS.dragMinDuration,
            CAST_DEFAULTS.dragSlowdown * moveDuration(distance, this.options.cursor),
          );
        const curvature = this.options.cursor.curvature / 2;
        await this.moveCursor(destination.point, duration, curvature, dragEase);
        await this.pace.sleep(CAST_DEFAULTS.dragHold);
      } finally {
        await this.mouseUp('left', 1);
      }
      await this.pace.sleep(this.options.pacing.afterClick);
    });
  }

  scroll(delta: { x?: number; y?: number }, options: ScrollOptions = {}): Promise<void> {
    return this.step(`scroll(${JSON.stringify(delta)})`, async () => {
      if (options.at !== undefined) {
        const { point } = await this.resolve(options.at);
        await this.moveCursor(point);
      }
      const dx = delta.x ?? 0;
      const dy = delta.y ?? 0;
      const distance = Math.hypot(dx, dy);
      if (distance === 0) {
        return;
      }
      await this.wheel(dx, dy, options.duration ?? scrollDuration(distance));
    });
  }

  scrollTo(target: Target, options: ScrollToOptions = {}): Promise<void> {
    return this.step(`scrollTo(${describeTarget(target)})`, async () => {
      const timeout = options.timeout ?? this.timeout;
      const block = options.block ?? 'center';
      if (isPoint(target)) {
        const rect = isRect(target) ? target : { ...target, width: 0, height: 0 };
        const plan = await this.page
          .locator(':root')
          .evaluate(planScroll, { block, ifNeeded: false, cursor: this.position, rect });
        if (plan.point && (plan.dx || plan.dy)) {
          await this.moveCursor(plan.point);
          await this.wheel(
            plan.dx,
            plan.dy,
            options.duration ?? scrollDuration(Math.hypot(plan.dx, plan.dy)),
          );
        }
        return;
      }
      const locator = this.locatorOf(target);
      await locator.waitFor({ state: 'visible', timeout });
      await this.bringIntoView(locator, {
        block,
        ifNeeded: block === 'nearest',
        duration: options.duration,
        timeout,
        smooth: true,
      });
    });
  }

  type(text: string, options: TypeOptions = {}): Promise<void> {
    return this.step(`type(${describeText(text)})`, async () => {
      if (options.into !== undefined) {
        await this.clickTarget(options.into, { position: options.position });
      }
      const delay = options.delay ?? this.options.typing.delay;
      const variance = options.variance ?? this.options.typing.variance;
      const chars = [...text.replace(/\r\n?/g, '\n')];
      const auto = (options.indent ?? 'auto') === 'auto';
      let due = this.timeline.now();
      let previous = '';
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        if (previous) {
          due += typingDelay(previous, delay, variance, this.typingRandom);
          await this.pace.sleep(due - this.timeline.now());
        }
        const t = await this.pace.input(() =>
          char === '\n' ? this.page.keyboard.press('Enter') : this.page.keyboard.type(char),
        );
        this.timeline.push({ type: 'key', t, kind: 'text', key: char });
        previous = char;
        if (auto && char === '\n') {
          const next = chars
            .slice(i + 1)
            .join('')
            .split('\n')[0];
          const present = await this.alignIndent(leadingWhitespace(next), delay, variance);
          i += present;
          previous = present > 0 ? chars[i] : previous;
        }
        // After a slow dispatch, keep the rhythm instead of rushing to catch up.
        due = Math.max(due, this.timeline.now());
      }
      await this.pace.sleep(this.options.pacing.afterType);
    });
  }

  press(keys: string, options: { hold?: number } = {}): Promise<void> {
    return this.step(`press(${JSON.stringify(keys)})`, async () => {
      const t = await this.pace.input(() =>
        this.page.keyboard.press(keys, { delay: options.hold }),
      );
      this.timeline.push({ type: 'key', t, kind: 'shortcut', key: keys });
      await this.pace.sleep(this.options.pacing.afterType);
    });
  }

  zoomTo(target: Target, options: ZoomToOptions = {}): Promise<void> {
    return this.step(`zoomTo(${describeTarget(target)})`, async () => {
      const focus = await this.resolveRect(target);
      const { scale, padding, duration, easing, follow } = options;
      const t = this.timeline.now();
      this.push({ type: 'zoom', t, focus, scale, padding, duration, easing, follow });
      if (options.wait !== false) {
        await this.pace.sleep(duration ?? CAST_DEFAULTS.zoomDuration);
      }
    });
  }

  zoomOut(options: Omit<ZoomToOptions, 'scale' | 'padding'> = {}): Promise<void> {
    return this.step('zoomOut()', async () => {
      const { duration, easing, follow } = options;
      this.push({ type: 'zoom', t: this.timeline.now(), focus: null, duration, easing, follow });
      if (options.wait !== false) {
        await this.pace.sleep(duration ?? CAST_DEFAULTS.zoomDuration);
      }
    });
  }

  wait(ms: number): Promise<void> {
    return this.step(`wait(${ms})`, async () => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`cast.wait(ms) needs a number of milliseconds of 0 or more, got ${ms}.`);
      }
      await this.pace.sleep(ms);
    });
  }

  cut<T>(fn: () => Promise<T>): Promise<T> {
    return this.step('cut()', () =>
      this.inRegion('cut', fn, (t, end) => this.push({ type: 'cut', t, end })),
    );
  }

  speed<T>(rate: number, fn: () => Promise<T>): Promise<T> {
    return this.step(`speed(${rate})`, async () => {
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(
          `cast.speed(rate, fn) needs a rate above 0 (4 plays 4x faster), got ${rate}.`,
        );
      }
      return this.inRegion('speed', fn, (t, end) => this.push({ type: 'speed', t, end, rate }));
    });
  }

  caption(text: string, options: CaptionOptions = {}): Promise<void> {
    return this.step(`caption(${describeText(text)})`, async () => {
      const duration =
        options.duration ?? CAST_DEFAULTS.captionBase + CAST_DEFAULTS.captionPerChar * text.length;
      const event: CaptionEvent = { type: 'caption', t: this.timeline.now(), duration, text };
      if (options.label) {
        event.label = options.label;
      }
      this.push(event);
      if (options.wait) {
        await this.pace.sleep(duration);
      }
    });
  }

  spotlight(target: Target, options: SpotlightOptions = {}): Promise<void> {
    return this.step(`spotlight(${describeTarget(target)})`, async () => {
      const rect = await this.resolveRect(target);
      const duration = options.duration ?? CAST_DEFAULTS.spotlightDuration;
      const { padding, radius } = options;
      this.push({ type: 'spotlight', t: this.timeline.now(), duration, rect, padding, radius });
      if (options.wait) {
        await this.pace.sleep(duration);
      }
    });
  }

  marker(label: string): void {
    const t = this.timeline.now();
    this.push({ type: 'marker', t, label: String(label) });
    this.push({ type: 'action', t, end: t, call: `marker(${describeText(String(label))})` });
  }

  /**
   * Runs one Cast call. Remembers the innermost failing call for the error message.
   */
  private async step<T>(call: string, action: () => Promise<T>): Promise<T> {
    const t = this.timeline.now();
    try {
      const result = await action();
      this.lastCall = `cast.${call}`;
      return result;
    } catch (error) {
      if (typeof error === 'object' && error !== null && !this.failures.has(error)) {
        this.failures.set(error, { call: `cast.${call}`, t: this.timeline.now() });
      }
      throw error;
    } finally {
      this.timeline.push({ type: 'action', t, end: this.timeline.now(), call });
    }
  }

  private push(event: TimelineEvent): void {
    this.timeline.push(withoutUndefined(event));
  }

  private async inRegion<T>(
    kind: 'cut' | 'speed',
    fn: () => Promise<T>,
    done: (t: number, end: number) => void,
  ): Promise<T> {
    if (this.region) {
      throw new Error(
        `cast.${kind}() cannot run inside cast.${this.region}(): cut and speed regions do not nest. ` +
          `Move the cast.${kind}() call out of the cast.${this.region}() callback.`,
      );
    }
    this.region = kind;
    const t = this.timeline.now();
    if (kind === 'cut') {
      await this.pace.capture(false);
    }
    try {
      return await fn();
    } finally {
      const end = kind === 'cut' ? await this.pace.capture(true) : this.timeline.now();
      this.region = undefined;
      done(t, end);
    }
  }

  private locatorOf(target: string | Locator): Locator {
    return typeof target === 'string' ? this.page.locator(target) : target;
  }

  private async resolve(target: Target, options: MoveOptions = {}): Promise<Resolved> {
    if (isPoint(target)) {
      if (!isRect(target)) {
        return { point: { x: target.x, y: target.y } };
      }
      return { point: this.pointIn(target, options.position), box: target };
    }
    const locator = this.locatorOf(target);
    const box = await this.stableBox(locator, options.timeout);
    return { point: this.pointIn(box, options.position), box, locator };
  }

  private async resolveRect(target: Target): Promise<Rect> {
    if (isPoint(target)) {
      const { x, y } = target;
      return isRect(target)
        ? { x, y, width: target.width, height: target.height }
        : { x, y, width: 0, height: 0 };
    }
    return this.stableBox(this.locatorOf(target));
  }

  /**
   * A point inside `box`: at `position` (fractions of the size), or near the center of the
   * visible part with a small random offset.
   */
  private pointIn(box: Rect, position?: { x: number; y: number }): Point {
    if (position) {
      return { x: box.x + box.width * position.x, y: box.y + box.height * position.y };
    }
    const area = intersect(box, { x: 0, y: 0, ...this.viewport }) ?? box;
    const jitterX = Math.min(area.width * 0.15, 8);
    const jitterY = Math.min(area.height * 0.15, 4);
    return {
      x: area.x + area.width / 2 + (this.motionRandom() * 2 - 1) * jitterX,
      y: area.y + area.height / 2 + (this.motionRandom() * 2 - 1) * jitterY,
    };
  }

  /**
   * Waits until the element is visible, scrolls it into view, and returns its bounding box
   * once two reads in a row give the same box.
   */
  private async stableBox(locator: Locator, timeout = this.timeout): Promise<Rect> {
    await locator.waitFor({ state: 'visible', timeout });
    await this.bringIntoView(locator, {
      block: 'center',
      ifNeeded: true,
      timeout,
      smooth: this.options.scrollBehavior === 'smooth',
    });
    // The time limit is for the page, so the scroll animation does not count.
    const deadline = Date.now() + timeout;
    const remaining = () => Math.max(1, deadline - Date.now());
    let previous = await locator.boundingBox({ timeout: remaining() });
    for (;;) {
      await this.pace.sleep(STABLE_INTERVAL);
      const box = await locator.boundingBox({ timeout: remaining() });
      if (box && previous && sameBox(box, previous)) {
        return box;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${String(locator)} did not stop moving within ${timeout} ms ` +
            `(last bounding box: ${JSON.stringify(box)}).`,
        );
      }
      previous = box;
    }
  }

  private async clickTarget(target: Target, options: ClickOptions): Promise<void> {
    const resolved = await this.resolve(target, options);
    await this.moveCursor(resolved.point, options.duration);
    await this.pace.sleep(this.options.pacing.beforeClick);
    if (resolved.locator && resolved.box) {
      const box = await this.followTarget(resolved.locator, resolved.box, options.timeout);
      // Outside the target, the click lands on whatever is at that point, like a real
      // click: a check that the target receives it would always fail.
      if (!options.force && !isOutside(options.position)) {
        await this.checkActionable(resolved.locator, box, options.timeout);
      }
    }
    await this.pressButton(options.button ?? 'left', options.clickCount ?? 1, options.modifiers);
    await this.pace.sleep(options.afterClick ?? this.options.pacing.afterClick);
  }

  /**
   * Moves the cursor again when the element moved after the cursor arrived.
   * Keeps the same relative position inside the element. Returns the current box.
   */
  private async followTarget(locator: Locator, box: Rect, timeout?: number): Promise<Rect> {
    const now = await locator.boundingBox({ timeout: timeout ?? this.timeout });
    if (now && sameBox(now, box)) {
      return now;
    }
    const current = await this.stableBox(locator, timeout);
    const fx = box.width > 0 ? (this.position.x - box.x) / box.width : 0.5;
    const fy = box.height > 0 ? (this.position.y - box.y) / box.height : 0.5;
    const point = { x: current.x + current.width * fx, y: current.y + current.height * fy };
    const distance = Math.hypot(point.x - this.position.x, point.y - this.position.y);
    await this.moveCursor(point, Math.min(250, moveDuration(distance, this.options.cursor)));
    return current;
  }

  /**
   * Runs the Playwright actionability checks at the exact cursor point, without clicking.
   */
  private async checkActionable(locator: Locator, box: Rect, timeout?: number): Promise<void> {
    const border = await locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        x: parseFloat(style.borderLeftWidth) || 0,
        y: parseFloat(style.borderTopWidth) || 0,
      };
    });
    const { x, y } = this.position;
    await locator.click({
      trial: true,
      position: { x: x - box.x - border.x, y: y - box.y - border.y },
      timeout: timeout ?? this.timeout,
    });
    // The trial run moves the mouse to a rounded point: put it back on the exact point.
    await this.page.mouse.move(x, y);
  }

  private async pressButton(
    button: MouseButton,
    clickCount: number,
    modifiers: Modifier[] = [],
  ): Promise<void> {
    const hold =
      clickCount > 1
        ? Math.min(this.options.pacing.pressDuration, 60)
        : this.options.pacing.pressDuration;
    for (const key of modifiers) {
      await this.pace.input(() => this.page.keyboard.down(key));
    }
    try {
      for (let count = 1; count <= clickCount; count++) {
        if (count > 1) {
          await this.pace.sleep(CAST_DEFAULTS.doubleClickGap);
        }
        await this.mouseDown(button, count);
        await this.pace.sleep(hold);
        await this.mouseUp(button, count);
      }
    } finally {
      for (const key of [...modifiers].reverse()) {
        await this.pace.input(() => this.page.keyboard.up(key));
      }
    }
  }

  private async mouseDown(button: MouseButton, clickCount: number): Promise<void> {
    const { x, y } = this.position;
    const t = await this.pace.input(() => this.page.mouse.down({ button, clickCount }));
    this.timeline.push({ type: 'mouseDown', t, x, y, button });
  }

  private async mouseUp(button: MouseButton, clickCount: number): Promise<void> {
    const { x, y } = this.position;
    const t = await this.pace.input(() => this.page.mouse.up({ button, clickCount }));
    this.timeline.push({ type: 'mouseUp', t, x, y, button });
  }

  /**
   * Moves the cursor along a human-like path, sampled every few milliseconds.
   */
  private async moveCursor(
    to: Point,
    duration?: number,
    curvature = this.options.cursor.curvature,
    ease = moveEase,
  ): Promise<void> {
    const from = this.position;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance === 0) {
      return;
    }
    const path = cursorPath(from, to, curvature, this.motionRandom, this.viewport);
    const total = distance < 1 ? 0 : (duration ?? moveDuration(distance, this.options.cursor));
    await this.pace.animate(total, MOVE_TICK, (progress, t) => {
      const point = progress >= 1 ? to : path(ease(progress));
      this.position = point;
      this.cursorStyle.pointer = point;
      this.timeline.sample(point, t);
      return () => this.page.mouse.move(point.x, point.y);
    });
  }

  /**
   * Scrolls by wheel events at the cursor, with an ease-in-out over `duration`.
   */
  private async wheel(dx: number, dy: number, duration: number): Promise<void> {
    const target = { x: Math.round(dx), y: Math.round(dy) };
    let planned = { x: 0, y: 0 };
    const sent = { x: 0, y: 0 };
    await this.pace.animate(duration, SCROLL_TICK, (progress) => {
      const eased = easeInOutCubic(progress);
      const total = { x: Math.round(target.x * eased), y: Math.round(target.y * eased) };
      if (total.x === planned.x && total.y === planned.y) {
        return undefined;
      }
      planned = total;
      // A skipped step adds to the next one: the delta comes from what is already sent.
      return () => {
        const delta = { x: total.x - sent.x, y: total.y - sent.y };
        sent.x = total.x;
        sent.y = total.y;
        return this.page.mouse.wheel(delta.x, delta.y);
      };
    });
  }

  /**
   * Brings an element into view. Smooth: wheel steps over each scroll container, outer
   * to inner, with the cursor moved over the container first. Falls back to an instant
   * scroll when the wheel does not reach the element.
   */
  private async bringIntoView(
    locator: Locator,
    view: { block: Block; ifNeeded: boolean; timeout: number; smooth: boolean; duration?: number },
  ): Promise<void> {
    const { timeout } = view;
    if (view.smooth) {
      let last = { level: -1, distance: Infinity };
      for (let i = 0; i < MAX_SCROLL_STEPS; i++) {
        const plan = await locator.evaluate(
          planScroll,
          { block: view.block, ifNeeded: view.ifNeeded, cursor: this.position },
          { timeout },
        );
        const distance = Math.hypot(plan.dx, plan.dy);
        if (distance < 1 && plan.inView) {
          return;
        }
        const stuck = plan.level === last.level && distance >= last.distance - 1;
        if (plan.inFrame || distance < 1 || !plan.point || stuck) {
          break;
        }
        last = { level: plan.level, distance };
        await this.moveCursor(plan.point);
        await this.wheel(plan.dx, plan.dy, view.duration ?? scrollDuration(distance));
        await locator.evaluate(scrollIdle, undefined, { timeout });
      }
    }
    await locator.scrollIntoViewIfNeeded({ timeout });
  }

  /**
   * After Enter in `auto` indent mode: removes the indentation that the editor added and
   * that `wanted` does not have. Returns how many characters of `wanted` are already there.
   */
  private async alignIndent(wanted: string, delay: number, variance: number): Promise<number> {
    const read = () => this.page.evaluate(caretLinePrefix).catch(() => null);
    let present = await read();
    if (present === null || /\S/.test(present)) {
      return 0;
    }
    for (let presses = present.length; presses > 0 && !wanted.startsWith(present); presses--) {
      await this.pace.sleep(typingDelay('', delay, variance, this.typingRandom));
      await this.pace.input(() => this.page.keyboard.press('Backspace'));
      const after = await read();
      if (after === null || after.length >= present.length) {
        return 0;
      }
      present = after;
    }
    return wanted.startsWith(present) ? present.length : 0;
  }
}
