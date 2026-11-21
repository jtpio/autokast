import type { BrowserContext, Frame, Page } from 'playwright';
import type { CursorStyle, Point } from '../types.ts';

const REPORT_BINDING = '__autokastCursorStyle';
const POINTER_BINDING = '__autokastPointer';
const PROBE_FUNCTION = '__autokastProbe';

/**
 * Reported by a frame when the pointer is over a child frame, which reports for itself.
 */
const OVER_FRAME = 'frame';

/**
 * Maps a computed CSS `cursor` value to a cursor style the renderer can draw.
 * Custom `url()` cursors use their keyword fallback. `auto` gives `default` here: the page
 * probe resolves it first. This function runs in the page too, so it is self-contained.
 */
export function mapCssCursor(value: string): CursorStyle {
  const aliases: Record<string, CursorStyle> = {
    'col-resize': 'ew-resize',
    'e-resize': 'ew-resize',
    'w-resize': 'ew-resize',
    'row-resize': 'ns-resize',
    'n-resize': 'ns-resize',
    's-resize': 'ns-resize',
    'ne-resize': 'nesw-resize',
    'sw-resize': 'nesw-resize',
    'nw-resize': 'nwse-resize',
    'se-resize': 'nwse-resize',
    'all-scroll': 'move',
    'vertical-text': 'text',
    'no-drop': 'not-allowed',
    '-webkit-grab': 'grab',
    '-webkit-grabbing': 'grabbing',
  };
  const known = [
    'default',
    'pointer',
    'text',
    'grab',
    'grabbing',
    'crosshair',
    'move',
    'ew-resize',
    'ns-resize',
    'nesw-resize',
    'nwse-resize',
    'not-allowed',
    'none',
  ];
  const keyword = (value.split(',').pop() ?? '').trim().toLowerCase();
  if (keyword in aliases) {
    return aliases[keyword];
  }
  return known.includes(keyword) ? (keyword as CursorStyle) : 'default';
}

interface ProbeConfig {
  report: string;
  pointer: string;
  probe: string;
  overFrame: string;
}

/**
 * In-page probe that reports the effective cursor under the pointer when it changes.
 * Serialized into an init script: it must not use anything from the outer scope.
 */
function cursorProbe(config: ProbeConfig, toStyle: (value: string) => string): void {
  const win = window as unknown as Record<string, unknown>;
  if (win[config.probe]) {
    return;
  }
  const isTop = window === window.top;
  const textInputs = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
  let pointer: { x: number; y: number } | null = null;
  let last = '';

  const send = (style: string) => {
    const report = win[config.report];
    if (typeof report === 'function') {
      Promise.resolve(report(style)).catch(() => {});
    }
  };

  const elementAt = (x: number, y: number) => {
    const roots: ShadowRoot[] = [];
    let element = document.elementFromPoint(x, y);
    while (element?.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) {
        break;
      }
      roots.push(element.shadowRoot);
      element = inner;
    }
    return { element, roots };
  };

  const isEditable = (element: Element) => {
    if ((element as HTMLElement).isContentEditable) {
      return true;
    }
    if (element instanceof HTMLTextAreaElement) {
      return !element.disabled;
    }
    return element instanceof HTMLInputElement && !element.disabled && textInputs.has(element.type);
  };

  const isOverText = (element: Element, roots: ShadowRoot[], x: number, y: number) => {
    const node = document.caretPositionFromPoint(x, y, { shadowRoots: roots })?.offsetNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !element.contains(node)) {
      return false;
    }
    const parent = node.parentElement;
    if (!parent || getComputedStyle(parent).userSelect === 'none') {
      return false;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    return Array.from(range.getClientRects()).some(
      (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
    );
  };

  const styleAt = (x: number, y: number) => {
    const { element, roots } = elementAt(x, y);
    if (!element) {
      return 'default';
    }
    if (/^(IFRAME|FRAME|EMBED|OBJECT)$/.test(element.tagName)) {
      return config.overFrame;
    }
    const value = getComputedStyle(element).cursor;
    if ((value.split(',').pop() ?? '').trim() !== 'auto') {
      return toStyle(value);
    }
    return isEditable(element) || isOverText(element, roots, x, y) ? 'text' : 'default';
  };

  const probe = (force = false) => {
    if (!pointer || !document.documentElement) {
      return null;
    }
    let style = 'default';
    try {
      style = styleAt(pointer.x, pointer.y);
    } catch {
      // Keep the default style when the document is in a transient state.
    }
    if (style !== last || force) {
      last = style;
      send(style);
    }
    return style;
  };

  const later = () => {
    requestAnimationFrame(() => probe());
    setTimeout(() => probe(), 150);
  };

  Object.defineProperty(window, config.probe, {
    value: (point?: { x: number; y: number }) => {
      if (point) {
        pointer = point;
      }
      return probe(true);
    },
  });
  const options = { capture: true, passive: true };
  // The top document gets no mousemove while the pointer is over a child frame, but it gets
  // mouseover on the frame element. A child frame reports on entry, even without a change.
  const track = (event: MouseEvent) => {
    const entering = !pointer;
    pointer = { x: event.clientX, y: event.clientY };
    probe(entering && !isTop);
  };
  addEventListener('mousemove', track, options);
  addEventListener('mouseover', track, options);
  addEventListener(
    'mouseout',
    (event) => {
      if (!isTop && !event.relatedTarget) {
        pointer = null;
      }
    },
    options,
  );
  for (const type of ['mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'wheel', 'scroll']) {
    addEventListener(type, later, options);
  }
  addEventListener('DOMContentLoaded', later);
  addEventListener('load', later);
  setInterval(() => probe(), 250);

  const getPointer = win[config.pointer];
  if (isTop && typeof getPointer === 'function') {
    Promise.resolve(getPointer())
      .then((point: { x: number; y: number } | null) => {
        if (point && !pointer) {
          pointer = point;
          probe();
        }
      })
      .catch(() => {});
  }
}

/**
 * Tracks the cursor style that the page shows under the pointer.
 * `pointer` must follow the mouse so that a new document can probe before any mouse move.
 */
export class CursorStyleProbe {
  style: CursorStyle = 'default';
  pointer: Point = { x: 0, y: 0 };
  onChange?: (style: CursorStyle) => void;
  private mainStyle = 'default';
  private childStyle = 'default';

  /**
   * Installs the bindings and the init script. Call before the page is created.
   */
  async install(context: BrowserContext): Promise<void> {
    await context.exposeBinding(REPORT_BINDING, (source, style: unknown) => {
      this.report(source.frame, source.page, style);
    });
    await context.exposeBinding(POINTER_BINDING, (source) =>
      source.frame === source.page.mainFrame() ? this.pointer : null,
    );
    const config: ProbeConfig = {
      report: REPORT_BINDING,
      pointer: POINTER_BINDING,
      probe: PROBE_FUNCTION,
      overFrame: OVER_FRAME,
    };
    await context.addInitScript({
      content: `(${cursorProbe.toString()})(${JSON.stringify(config)}, ${mapCssCursor.toString()});`,
    });
  }

  /**
   * Probes the main frame now, at the current pointer position.
   */
  async refresh(page: Page): Promise<void> {
    const style = await page
      .evaluate(
        ([name, point]) => {
          const probe = (window as unknown as Record<string, unknown>)[name as string];
          return typeof probe === 'function' ? (probe(point) as string | null) : null;
        },
        [PROBE_FUNCTION, this.pointer] as const,
      )
      .catch(() => null);
    if (style) {
      this.report(page.mainFrame(), page, style);
    }
  }

  /**
   * Takes a report from a frame. Reports from frames can arrive in any order, so the style
   * comes from the last report of the main frame, or of a child frame when the main frame
   * says that the pointer is over a frame.
   */
  private report(frame: Frame, page: Page, style: unknown): void {
    if (typeof style !== 'string') {
      return;
    }
    if (frame === page.mainFrame()) {
      this.mainStyle = style;
    } else {
      this.childStyle = style;
    }
    const effective = this.mainStyle === OVER_FRAME ? this.childStyle : this.mainStyle;
    if (mapCssCursor(effective) !== effective || effective === this.style) {
      return;
    }
    this.style = effective as CursorStyle;
    this.onChange?.(this.style);
  }
}
