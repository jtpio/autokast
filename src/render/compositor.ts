import { createCanvas, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import type { CursorStyle, Rect, Size, SpotlightEvent } from '../types.ts';
import type { CameraState } from './camera.ts';
import { luminance, parseColor, rgba, type Rgba } from './color.ts';
import {
  CAPTION_WIDTH,
  captionMeasure,
  drawCaption,
  layoutCaption,
  LINE_HEIGHT,
  type CaptionCue,
  type CaptionLine,
  type CaptionStyle,
} from './captions.ts';
import type { ClickMark } from './cursor.ts';
import { drawCursor } from './cursors/shapes.ts';
import type { ResolvedOptions } from './defaults.ts';
import {
  adaptiveClickColor,
  drawClick,
  drawSpotlight,
  parseClickColor,
  type ClickStyle,
} from './effects.ts';
import { smoothstep } from './easing.ts';
import {
  capLayouts,
  capsWidth,
  DARK_CAPS,
  drawKeycaps,
  LIGHT_CAPS,
  type CapTheme,
  type KeyCue,
} from './keycaps.ts';
import { contentMap, IDENTITY, type BandLayout, type StageTransform } from './stage.ts';
import type { TimedEvent } from './timeline.ts';

/**
 * Placement of the frame at rest, in output pixels.
 */
export interface Layout {
  size: Size;
  unit: number;
  viewport: Size;
  /**
   * Window box: the title bar (if any) plus the content.
   */
  window: Rect;
  content: Rect;
  bar: number;
  radius: number;
  padding: number;
  /**
   * Output pixels per CSS pixel at rest.
   */
  k: number;
}

const BAR_HEIGHT = 38;

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/**
 * The content box is the largest box with the viewport aspect ratio inside the padded
 * output. Its width snaps to whole pixels so that, when the ratio allows, both edges land
 * on pixel boundaries.
 */
export function computeLayout(options: ResolvedOptions, viewport: Size): Layout {
  const { width: w, height: h } = options.size;
  const unit = options.unit;
  const p = options.frame.padding;
  const pad = p < 1 ? p * Math.min(w, h) : p * unit;
  const bar = options.frame.chrome === 'window' ? BAR_HEIGHT * unit : 0;
  const aspect = viewport.width / viewport.height;
  let cw = Math.max(16, Math.min(w - 2 * pad, (h - 2 * pad - bar) * aspect));
  const vw = Math.round(viewport.width);
  const vh = Math.round(viewport.height);
  const step = vw / gcd(vw, vh);
  if (Number.isInteger(step) && step <= 64 && cw >= step) cw = Math.floor(cw / step) * step;
  else cw = Math.floor(cw);
  const ch = cw / aspect;
  const x = Math.round((w - cw) / 2);
  const y = Math.round((h - ch - bar) / 2);
  return {
    size: options.size,
    unit,
    viewport,
    window: { x, y, width: cw, height: ch + bar },
    content: { x, y: y + bar, width: cw, height: ch },
    bar,
    radius: Math.min(options.frame.radius * unit, cw / 4),
    padding: pad,
    k: cw / viewport.width,
  };
}

export interface CursorFrame {
  x: number;
  y: number;
  style: CursorStyle;
  previousStyle: CursorStyle;
  styleMix: number;
  press: number;
  opacity: number;
  /**
   * Lean about the hotspot, in radians.
   */
  angle: number;
}

export interface FrameInput {
  /**
   * Output time in milliseconds, for text animations.
   */
  t: number;
  /**
   * How far the caption band is open, 0 to 1, and the stage transform it gives.
   */
  band: number;
  stage: StageTransform;
  camera: CameraState;
  image: Image | null;
  cursor: CursorFrame | null;
  /**
   * Cursor positions across the shutter, for cursor motion blur.
   */
  cursorTrail?: { x: number; y: number }[];
  clicks: { mark: ClickMark; age: number }[];
  spotlights: { event: TimedEvent<SpotlightEvent>; amount: number }[];
  captions: CaptionCue[];
  keys: KeyCue[];
}

/**
 * Width of the soft edge where the wallpaper covers a zoomed frame in the caption band.
 */
const FEATHER = 56;

/**
 * Shadow layers as fractions of the configured blur and offset, with their share of the
 * shadow color's alpha: a tight contact shadow, two mid layers and a broad key shadow.
 */
const SHADOW_LAYERS = [
  { f: 0.03, a: 0.24 },
  { f: 0.14, a: 0.2 },
  { f: 0.4, a: 0.2 },
  { f: 1, a: 0.34 },
];

const CHROME = {
  light: {
    bar: '#f3f3f2',
    barShade: '#ebebea',
    separator: 'rgba(0, 0, 0, 0.09)',
    title: '#5b5b5f',
    dotBorder: 'rgba(0, 0, 0, 0.12)',
  },
  dark: {
    bar: '#2b2b2e',
    barShade: '#252528',
    separator: 'rgba(0, 0, 0, 0.55)',
    title: '#b4b4b9',
    dotBorder: 'rgba(0, 0, 0, 0.25)',
  },
};

const DOTS = ['#ff5f57', '#febc2e', '#28c840'];

function floatCanvas(width: number, height: number): Canvas {
  const canvas = createCanvas(width, height);
  canvas.getContext('2d', { colorType: 'float16' });
  return canvas;
}

/**
 * Draws the cursor of one frame. A style change swaps the shape at the midpoint of a
 * small scale dip, so the cursor never shows two half-transparent shapes; a change to or
 * from `none` fades.
 */
function drawCursorFrame(
  ctx: SKRSContext2D,
  cur: CursorFrame,
  x: number,
  y: number,
  scale: number,
  weight: number,
): void {
  const alpha = cur.opacity * weight;
  const mix = cur.styleMix;
  if (mix >= 1 || cur.previousStyle === cur.style) {
    drawCursor(ctx, cur.style, x, y, scale, alpha, cur.angle);
  } else if (cur.previousStyle === 'none' || cur.style === 'none') {
    drawCursor(ctx, cur.previousStyle, x, y, scale, alpha * (1 - mix), cur.angle);
    drawCursor(ctx, cur.style, x, y, scale, alpha * mix, cur.angle);
  } else {
    const style = mix < 0.5 ? cur.previousStyle : cur.style;
    drawCursor(ctx, style, x, y, scale * (1 - 0.1 * Math.sin(Math.PI * mix)), alpha, cur.angle);
  }
}

/**
 * Draws output frames. The background and the frame shadow are rendered once; the
 * camera transform then moves the frame, while the background stays fixed.
 */
export class Compositor {
  readonly canvas: Canvas;
  readonly layout: Layout;
  private readonly options: ResolvedOptions;
  private readonly ctx: SKRSContext2D;
  private readonly background: Canvas;
  private readonly base: Canvas;
  private readonly shadow: Canvas | null;
  private readonly click: ClickStyle;
  private readonly clickColors = new Map<ClickMark, Rgba>();
  private readonly probe = createCanvas(4, 4);
  private accumulator: Canvas | null = null;
  private cursorLayer: Canvas | null = null;
  private sprite: Canvas | null = null;
  private spriteKey = '';
  private readonly band: BandLayout | null;
  private moving: Canvas | null = null;
  private movingKey = '';
  private lastKey = '';
  private overlay: Canvas | null = null;
  private overlayKey = '';
  private readonly captionStyle: CaptionStyle;
  private readonly captionLines = new Map<CaptionCue, CaptionLine>();
  private readonly keyThemes = new Map<KeyCue, CapTheme>();

  constructor(
    options: ResolvedOptions,
    layout: Layout,
    background: Canvas,
    band: BandLayout | null = null,
  ) {
    this.options = options;
    this.layout = layout;
    this.background = background;
    this.band = band;
    const { width, height } = layout.size;
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
    this.shadow = options.frame.shadow ? this.renderShadow() : null;
    this.base = createCanvas(width, height);
    const b = this.base.getContext('2d');
    b.drawImage(background, 0, 0);
    if (this.shadow) b.drawImage(this.shadow, 0, 0);
    const click = options.cursor.click;
    this.click = {
      type: click.type,
      color: parseClickColor(click.color),
      radius: click.size,
      duration: Math.max(1, click.duration),
    };
    const u = layout.unit;
    const { width: W, height: H } = layout.size;
    const textArea = band
      ? {
          x: band.window.x,
          y: band.center - band.height / 3,
          w: band.window.width * 0.7,
          h: (band.height * 2) / 3,
        }
      : { x: 0, y: H * 0.85, w: W, h: H * 0.15 };
    const dark = this.backgroundLuminance(textArea) < 0.4;
    this.captionStyle = {
      family: options.captions.fontFamily,
      fontSize: options.captions.fontSize * u,
      color: dark ? { r: 246, g: 244, b: 240, a: 0.97 } : { r: 23, g: 24, b: 28, a: 0.94 },
      unit: u,
    };
  }

  /**
   * Mean luminance of the background in a rectangle.
   */
  private backgroundLuminance(r: { x: number; y: number; w: number; h: number }): number {
    const probe = createCanvas(16, 4);
    const p = probe.getContext('2d');
    p.imageSmoothingEnabled = true;
    p.imageSmoothingQuality = 'medium';
    p.drawImage(this.background, r.x, r.y, Math.max(1, r.w), Math.max(1, r.h), 0, 0, 16, 4);
    const d = p.getImageData(0, 0, 16, 4).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4)
      sum += luminance({ r: d[i], g: d[i + 1], b: d[i + 2], a: 1 });
    return sum / (d.length / 4);
  }

  private renderShadow(): Canvas {
    const { width, height } = this.layout.size;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const shadow = this.options.frame.shadow;
    if (!shadow) return canvas;
    const color = parseColor(shadow.color) ?? { r: 0, g: 0, b: 0, a: 0.5 };
    const u = this.layout.unit;
    const r = this.layout.window;
    const away = width + height + shadow.blur * u * 4;
    ctx.fillStyle = '#000000';
    for (const layer of SHADOW_LAYERS) {
      ctx.shadowColor = rgba(color, color.a * layer.a);
      ctx.shadowBlur = shadow.blur * layer.f * u;
      ctx.shadowOffsetX = away;
      ctx.shadowOffsetY = shadow.offsetY * layer.f * u;
      ctx.beginPath();
      ctx.roundRect(r.x - away, r.y, r.width, r.height, this.layout.radius);
      ctx.fill();
    }
    return canvas;
  }

  /**
   * True when the color of a click still needs `prepareClick`.
   */
  needsClickColor(mark: ClickMark): boolean {
    return !this.click.color && !this.clickColors.has(mark);
  }

  /**
   * Picks the adaptive click color from the page brightness under the click, in the
   * frame captured when the button went down.
   */
  prepareClick(mark: ClickMark, image: Image | null): void {
    let lum = 1;
    if (image) {
      const s = image.width / this.layout.viewport.width;
      const half = 18 * s;
      const p = this.probe.getContext('2d');
      p.imageSmoothingEnabled = true;
      p.drawImage(image, mark.x * s - half, mark.y * s - half, half * 2, half * 2, 0, 0, 4, 4);
      const d = p.getImageData(0, 0, 4, 4).data;
      lum = 0;
      for (let i = 0; i < d.length; i += 4) {
        lum += luminance({ r: d[i], g: d[i + 1], b: d[i + 2], a: 1 });
      }
      lum /= d.length / 4;
    }
    this.clickColors.set(mark, adaptiveClickColor(lum));
  }

  private clickColor(mark: ClickMark): Rgba {
    return this.click.color ?? this.clickColors.get(mark) ?? adaptiveClickColor(1);
  }

  /**
   * Renders one frame into `canvas`. The stage transform (caption band) and the camera
   * combine into one frame matrix; content points map with the matching content matrix.
   */
  draw(input: FrameInput): void {
    const ctx = this.ctx;
    const L = this.layout;
    const H = L.size.height;
    const st = input.stage ?? IDENTITY;
    const s = input.camera.scale;
    const { ks, ex, ey, fa, fe, ff } = this.matrices(input);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    this.drawBase(ctx, fa, fe, ff);

    ctx.setTransform(fa, 0, 0, fa, fe, ff);
    if (L.bar > 0) this.drawChrome(ctx);

    ctx.save();
    const c = L.content;
    const rr = L.radius;
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, c.width, c.height, L.bar > 0 ? [0, 0, rr, rr] : rr);
    ctx.clip();
    if (input.image) {
      const k = (L.viewport.width / input.image.width) * ks;
      ctx.setTransform(k, 0, 0, k, ex, ey);
      ctx.drawImage(input.image, 0, 0);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    if (input.spotlights.length) {
      ctx.setTransform(ks, 0, 0, ks, ex, ey);
      const vp = { x: 0, y: 0, ...L.viewport };
      for (const sp of input.spotlights) drawSpotlight(ctx, sp.event, sp.amount, vp, L.unit);
    }
    for (const { mark, age } of input.clicks) {
      const color = this.clickColor(mark);
      const scale = s * st.scale * L.unit;
      drawClick(ctx, this.click, color, ex + mark.x * ks, ey + mark.y * ks, age, scale);
    }
    const cur = input.cursor;
    if (cur && cur.opacity > 0) {
      const press = 1 - (1 - this.options.cursor.pressScale) * cur.press;
      const scale = this.options.cursor.size * ks * press;
      const trail = input.cursorTrail ?? [cur];
      const points = trail.map((p) => ({ x: ex + p.x * ks, y: ey + p.y * ks }));
      if (points.length > 1) this.drawCursorTrail(ctx, cur, points, scale);
      else drawCursorFrame(ctx, cur, points[0].x, points[0].y, scale, 1);
    }
    ctx.restore();

    ctx.setTransform(fa, 0, 0, fa, fe, ff);
    this.drawEdges(ctx);

    if (input.band > 0 && this.band) this.drawBandCover(ctx, input.band, fa, ff, H);
    for (const cue of input.captions) this.drawCaptionCue(ctx, cue, input.t);
    for (const cue of input.keys) this.drawKeys(ctx, cue, input.band, input.t);
  }

  /**
   * The content matrix (CSS pixels to output: scale `ks`, offset `ex`, `ey`) and the frame
   * matrix (rest layout to output: scale `fa`, offset `fe`, `ff`): plain affine maps of the
   * camera state and the stage.
   */
  private matrices(input: Pick<FrameInput, 'camera' | 'stage'>) {
    const L = this.layout;
    const st = input.stage ?? IDENTITY;
    const { ks, ex, ey } = contentMap(L, st, input.camera);
    const camera = this.options.zoom.mode === 'camera';
    const fa = camera ? st.scale * input.camera.scale : st.scale;
    return {
      ks,
      ex,
      ey,
      fa,
      fe: camera ? ex - fa * L.content.x : st.x,
      ff: camera ? ey - fa * L.content.y : st.y,
    };
  }

  /**
   * Background and frame shadow. At rest this is one cached image; for a frame matrix
   * that repeats (a still camera with the band open) it is cached on its second use.
   */
  private drawBase(ctx: SKRSContext2D, fa: number, fe: number, ff: number): void {
    const L = this.layout;
    const { width: W, height: H } = L.size;
    if (Math.abs(fa - 1) < 1e-9 && Math.abs(fe) < 1e-6 && Math.abs(ff) < 1e-6) {
      ctx.drawImage(this.base, 0, 0);
      this.lastKey = '';
      return;
    }
    const w = L.window;
    const r = L.radius * fa;
    const left = w.x * fa + fe;
    const top = w.y * fa + ff;
    if (left <= -r && top <= -r && left + w.width * fa >= W + r && top + w.height * fa >= H + r) {
      return;
    }
    const key = `${fa.toFixed(6)}:${fe.toFixed(3)}:${ff.toFixed(3)}`;
    const target = key === this.lastKey ? (this.moving ??= createCanvas(W, H)) : null;
    this.lastKey = key;
    if (target && this.movingKey === key) {
      ctx.drawImage(target, 0, 0);
      return;
    }
    const out = target ? target.getContext('2d') : ctx;
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.drawImage(this.background, 0, 0);
    if (this.shadow) {
      out.imageSmoothingQuality = 'medium';
      out.setTransform(fa, 0, 0, fa, fe, ff);
      out.drawImage(this.shadow, 0, 0);
      out.imageSmoothingQuality = 'high';
      out.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (target) {
      this.movingKey = key;
      ctx.drawImage(target, 0, 0);
    }
  }

  /**
   * Redraws the wallpaper over the band where a zoomed frame overflows into it, with a
   * feathered edge. At rest the frame never overflows, so its shadow stays visible.
   */
  private drawBandCover(ctx: SKRSContext2D, open: number, fa: number, ff: number, H: number): void {
    const band = this.band!;
    const L = this.layout;
    const u = L.unit;
    const feather = FEATHER * u;
    const rest = band.window;
    const bottom = band.side === 'bottom';
    const edge = bottom
      ? H + feather / 2 + (rest.y + rest.height - H - feather / 2) * open
      : -feather / 2 + (rest.y + feather / 2) * open;
    const frameEdge = bottom ? fa * (L.window.y + L.window.height) + ff : fa * L.window.y + ff;
    const intrusion = bottom ? frameEdge - edge : edge - frameEdge;
    const alpha = smoothstep(0, feather, intrusion);
    if (alpha <= 0) return;
    const { width: W } = L.size;
    const y0 = bottom ? Math.max(0, Math.floor(edge - feather / 2)) : 0;
    const y1 = bottom ? H : Math.min(H, Math.ceil(edge + feather / 2));
    if (y1 <= y0) return;
    const key = `${band.side}:${edge.toFixed(2)}`;
    if (this.overlayKey !== key) {
      this.overlay ??= createCanvas(W, H);
      const o = this.overlay.getContext('2d');
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.globalCompositeOperation = 'copy';
      o.drawImage(this.background, 0, y0, W, y1 - y0, 0, y0, W, y1 - y0);
      o.globalCompositeOperation = 'destination-in';
      const g = o.createLinearGradient(0, edge - feather / 2, 0, edge + feather / 2);
      for (let i = 0; i <= 16; i++) {
        const v = i / 16;
        const a = v * v * v * (v * (6 * v - 15) + 10);
        g.addColorStop(v, `rgba(0, 0, 0, ${(bottom ? a : 1 - a).toFixed(4)})`);
      }
      o.fillStyle = g;
      o.fillRect(0, y0, W, y1 - y0);
      o.globalCompositeOperation = 'source-over';
      this.overlayKey = key;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.overlay!, 0, y0, W, y1 - y0, 0, y0, W, y1 - y0);
    ctx.restore();
  }

  private captionLayout(cue: CaptionCue): CaptionLine {
    let line = this.captionLines.get(cue);
    if (!line) {
      const style = this.captionStyle;
      const width = this.band ? this.band.window.width : this.layout.window.width;
      line = layoutCaption(
        cue.text,
        captionMeasure(style.family),
        width * CAPTION_WIDTH,
        style.fontSize,
      );
      this.captionLines.set(cue, line);
    }
    return line;
  }

  private drawCaptionCue(ctx: SKRSContext2D, cue: CaptionCue, t: number): void {
    const band = this.band;
    if (!band) return;
    const line = this.captionLayout(cue);
    const top = band.center - (line.fontSize * LINE_HEIGHT) / 2;
    drawCaption(ctx, cue, line, this.captionStyle, band.window.x, top, t);
  }

  /**
   * Keycaps sit centered in the padding at rest; with the caption band open on their side
   * they move into the band, right-aligned with the frame.
   */
  private keysBox(cue: KeyCue, open: number) {
    const L = this.layout;
    const u = L.unit;
    const caps = capLayouts(cue.keys, u);
    const width = capsWidth(caps, u);
    const h = 40 * u;
    const top = this.options.keystrokes.position === 'top';
    let x = (L.size.width - width) / 2;
    let y = top
      ? L.window.y - L.padding / 2 - h / 2
      : L.window.y + L.window.height + L.padding / 2 - h / 2;
    const band = this.band;
    if (band && (band.side === 'top') === top && open > 0) {
      x += (band.window.x + band.window.width - width - x) * open;
      y += (band.center - h / 2 - y) * open;
    }
    return { caps, x, y, width, height: h };
  }

  needsKeyTheme(cue: KeyCue): boolean {
    return !this.keyThemes.has(cue);
  }

  /**
   * Picks light or dark caps from what is behind them when they appear: the page when
   * the zoomed frame covers their place, the wallpaper otherwise.
   */
  prepareKeys(cue: KeyCue, input: FrameInput): void {
    const L = this.layout;
    const box = this.keysBox(cue, input.band);
    const area = { x: box.x, y: box.y, w: box.width, h: box.height };
    const { ks, ex, ey, fa, fe, ff } = this.matrices(input);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const c = L.content;
    const inside =
      cx >= fa * c.x + fe &&
      cx <= fa * (c.x + c.width) + fe &&
      cy >= fa * c.y + ff &&
      cy <= fa * (c.y + c.height) + ff;
    const band = this.band;
    const covered =
      band !== null &&
      input.band > 0.5 &&
      (band.side === 'bottom' ? cy > band.window.y + band.window.height : cy < band.window.y);
    let lum: number;
    if (inside && !covered && input.image) {
      const s = input.image.width / L.viewport.width;
      const p = this.probe.getContext('2d');
      p.imageSmoothingEnabled = true;
      p.drawImage(
        input.image,
        ((box.x - ex) / ks) * s,
        ((box.y - ey) / ks) * s,
        (box.width / ks) * s,
        (box.height / ks) * s,
        0,
        0,
        4,
        4,
      );
      const d = p.getImageData(0, 0, 4, 4).data;
      lum = 0;
      for (let i = 0; i < d.length; i += 4) {
        lum += luminance({ r: d[i], g: d[i + 1], b: d[i + 2], a: 1 });
      }
      lum /= d.length / 4;
    } else {
      lum = this.backgroundLuminance(area);
    }
    this.keyThemes.set(cue, lum < 0.4 ? LIGHT_CAPS : DARK_CAPS);
  }

  private drawKeys(ctx: SKRSContext2D, cue: KeyCue, open: number, t: number): void {
    const box = this.keysBox(cue, open);
    const theme =
      this.keyThemes.get(cue) ??
      (this.backgroundLuminance({ x: box.x, y: box.y, w: box.width, h: box.height }) < 0.4
        ? LIGHT_CAPS
        : DARK_CAPS);
    drawKeycaps(ctx, cue, box.caps, theme, box.x, box.y, this.layout.unit, t);
  }

  /**
   * Renders several sub-frame inputs across the shutter and averages them (camera
   * motion blur). The average runs in a float16 canvas, so it adds no banding.
   */
  drawBlurred(inputs: FrameInput[]): void {
    if (inputs.length < 2) {
      this.draw(inputs[0]);
      return;
    }
    const { width, height } = this.layout.size;
    this.accumulator ??= floatCanvas(width, height);
    const acc = this.accumulator.getContext('2d');
    inputs.forEach((input, k) => {
      this.draw(input);
      acc.globalAlpha = 1 / (k + 1);
      acc.drawImage(this.canvas, 0, 0);
    });
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.accumulator, 0, 0);
  }

  /**
   * Cursor motion blur: the average of the cursor at its positions across the shutter.
   * The cursor (fill, outline, shadow) is drawn once into a sprite, which is added with
   * premultiplied weights 1/N into a float16 layer, so the smear keeps its brightness.
   */
  private drawCursorTrail(
    ctx: SKRSContext2D,
    cur: CursorFrame,
    points: { x: number; y: number }[],
    scale: number,
  ): void {
    const { width, height } = this.layout.size;
    const m = Math.ceil(30 * scale);
    const key = [
      cur.style,
      cur.previousStyle,
      cur.styleMix,
      cur.press,
      cur.opacity,
      cur.angle,
      scale,
    ].join();
    if (!this.sprite || this.sprite.width < 2 * m) this.sprite = createCanvas(2 * m, 2 * m);
    if (key !== this.spriteKey) {
      const sprite = this.sprite.getContext('2d');
      sprite.setTransform(1, 0, 0, 1, 0, 0);
      sprite.clearRect(0, 0, this.sprite.width, this.sprite.height);
      drawCursorFrame(sprite, cur, m, m, scale, 1);
      this.spriteKey = key;
    }
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - m));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - m));
    const x1 = Math.min(width, Math.ceil(Math.max(...xs) + m));
    const y1 = Math.min(height, Math.ceil(Math.max(...ys) + m));
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0;
    const h = y1 - y0;
    if (!this.cursorLayer || this.cursorLayer.width < w || this.cursorLayer.height < h) {
      this.cursorLayer = floatCanvas(
        Math.max(w, this.cursorLayer?.width ?? 0),
        Math.max(h, this.cursorLayer?.height ?? 0),
      );
    }
    const layer = this.cursorLayer.getContext('2d');
    layer.imageSmoothingEnabled = true;
    layer.imageSmoothingQuality = 'low';
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.clearRect(0, 0, w, h);
    layer.globalCompositeOperation = 'lighter';
    layer.globalAlpha = 1 / points.length;
    for (const p of points) layer.drawImage(this.sprite, p.x - m - x0, p.y - m - y0);
    layer.globalAlpha = 1;
    layer.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.cursorLayer, 0, 0, w, h, x0, y0, w, h);
    ctx.restore();
  }

  private drawChrome(ctx: SKRSContext2D): void {
    const L = this.layout;
    const u = L.unit;
    const w = L.window;
    const theme = CHROME[this.options.frame.chromeTheme === 'dark' ? 'dark' : 'light'];
    const g = ctx.createLinearGradient(0, w.y, 0, w.y + L.bar);
    g.addColorStop(0, theme.bar);
    g.addColorStop(1, theme.barShade);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(w.x, w.y, w.width, L.bar + L.radius, [L.radius, L.radius, 0, 0]);
    ctx.fill();
    ctx.fillStyle = theme.separator;
    ctx.fillRect(w.x, w.y + L.bar - u, w.width, u);
    const cy = w.y + L.bar / 2;
    const dot = 6.6 * u;
    DOTS.forEach((color, i) => {
      ctx.beginPath();
      ctx.arc(w.x + 21 * u + i * 20 * u, cy, dot, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 0.8 * u;
      ctx.strokeStyle = theme.dotBorder;
      ctx.stroke();
    });
    const title = this.options.frame.title;
    if (title) {
      ctx.font = `500 ${14 * u}px Inter, sans-serif`;
      ctx.fillStyle = theme.title;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const max = w.width - 2 * 90 * u;
      let text = title;
      while (text.length > 1 && ctx.measureText(text).width > max) text = text.slice(0, -2) + '…';
      ctx.fillText(text, w.x + w.width / 2, cy + 0.5 * u);
    }
  }

  /**
   * Hairlines that define the window edge: dark outside for light backgrounds, a faint
   * light rim inside for dark content.
   */
  private drawEdges(ctx: SKRSContext2D): void {
    const L = this.layout;
    const u = L.unit;
    const w = L.window;
    ctx.lineWidth = u;
    ctx.beginPath();
    ctx.roundRect(w.x - u / 2, w.y - u / 2, w.width + u, w.height + u, L.radius + u / 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(
      w.x + u / 2,
      w.y + u / 2,
      w.width - u,
      w.height - u,
      Math.max(0, L.radius - u / 2),
    );
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
    ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
