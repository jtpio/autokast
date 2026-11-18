import path from 'node:path';
import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { BackgroundOptions, Size } from '../types.ts';
import { mixOklab, parseColor, rgba } from './color.ts';

interface Light {
  /**
   * Center as fractions of the output size (may lie outside 0-1).
   */
  x: number;
  y: number;
  /**
   * Radius as a fraction of the output diagonal.
   */
  r: number;
  color: string;
  alpha: number;
}

/**
 * A backdrop lit like a studio sweep: a base gradient, broad soft lights, a vignette
 * and film grain against banding.
 */
interface Preset {
  stops: string[];
  angle: number;
  lights: Light[];
  vignette: number;
  grain: number;
}

const PRESETS: Record<string, Preset> = {
  paper: {
    stops: ['#eee8dd', '#e2d9cb'],
    angle: 160,
    lights: [{ x: 0.18, y: -0.12, r: 0.95, color: '#fbf8f2', alpha: 0.9 }],
    vignette: 0.09,
    grain: 3,
  },
  fog: {
    stops: ['#e6e9ed', '#d3d8df'],
    angle: 170,
    lights: [{ x: 0.3, y: -0.15, r: 0.95, color: '#f7f9fb', alpha: 0.85 }],
    vignette: 0.1,
    grain: 3,
  },
  sage: {
    stops: ['#c7cdbd', '#a3ad9b'],
    angle: 150,
    lights: [{ x: 0.2, y: -0.05, r: 0.85, color: '#e3e7da', alpha: 0.75 }],
    vignette: 0.14,
    grain: 3,
  },
  dune: {
    stops: ['#ddcbb1', '#c1a680'],
    angle: 145,
    lights: [{ x: 0.22, y: -0.08, r: 0.9, color: '#f2e8d6', alpha: 0.75 }],
    vignette: 0.14,
    grain: 3,
  },
  clay: {
    stops: ['#c99e88', '#a06d58'],
    angle: 150,
    lights: [{ x: 0.2, y: -0.05, r: 0.85, color: '#e8cbb8', alpha: 0.65 }],
    vignette: 0.18,
    grain: 3,
  },
  dusk: {
    stops: ['#3c475e', '#5d5a6c', '#9a7a6c'],
    angle: 125,
    lights: [
      { x: 0.12, y: -0.05, r: 0.75, color: '#5a6782', alpha: 0.55 },
      { x: 0.98, y: 1.05, r: 0.6, color: '#c3937b', alpha: 0.35 },
    ],
    vignette: 0.22,
    grain: 3.5,
  },
  harbor: {
    stops: ['#2c4b52', '#1a2f35'],
    angle: 160,
    lights: [{ x: 0.25, y: -0.12, r: 0.95, color: '#4a747d', alpha: 0.6 }],
    vignette: 0.25,
    grain: 3.5,
  },
  graphite: {
    stops: ['#35373c', '#1f2024'],
    angle: 170,
    lights: [{ x: 0.35, y: -0.18, r: 0.95, color: '#50535a', alpha: 0.7 }],
    vignette: 0.3,
    grain: 3.5,
  },
  ink: {
    stops: ['#161c2a', '#0b0f18'],
    angle: 165,
    lights: [
      { x: 0.2, y: -0.12, r: 0.9, color: '#28344d', alpha: 0.75 },
      { x: 0.96, y: 1.08, r: 0.55, color: '#1c3b45', alpha: 0.4 },
    ],
    vignette: 0.3,
    grain: 3.5,
  },
  ember: {
    stops: ['#2b201c', '#16100e'],
    angle: 160,
    lights: [{ x: 0.82, y: -0.12, r: 0.9, color: '#5e3d2e', alpha: 0.65 }],
    vignette: 0.3,
    grain: 3.5,
  },
};

export const BACKGROUND_PRESETS: string[] = Object.keys(PRESETS);

/**
 * Linear gradient along a CSS angle (0deg points up, 90deg right), with stops mixed
 * in OKLab.
 */
function fillLinear(ctx: SKRSContext2D, size: Size, colors: string[], angle: number): void {
  const { width: w, height: h } = size;
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const g = ctx.createLinearGradient(
    w / 2 - dx * half,
    h / 2 - dy * half,
    w / 2 + dx * half,
    h / 2 + dy * half,
  );
  const parsed = colors.map((c) => parseColor(c));
  if (parsed.some((c) => !c) || colors.length < 2) {
    colors.forEach((c, i) => g.addColorStop(colors.length > 1 ? i / (colors.length - 1) : 0, c));
  } else {
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const p = (i / steps) * (colors.length - 1);
      const k = Math.min(colors.length - 2, Math.floor(p));
      g.addColorStop(i / steps, rgba(mixOklab(parsed[k]!, parsed[k + 1]!, p - k)));
    }
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/**
 * A soft light: a radial glow with a smooth, compact falloff (no visible edge).
 */
function fillLight(ctx: SKRSContext2D, size: Size, light: Light): void {
  const color = parseColor(light.color);
  if (!color) return;
  const diag = Math.hypot(size.width, size.height);
  const x = light.x * size.width;
  const y = light.y * size.height;
  const g = ctx.createRadialGradient(x, y, 0, x, y, light.r * diag);
  for (let i = 0; i <= 16; i++) {
    const u = i / 16;
    g.addColorStop(u, rgba(color, light.alpha * (1 - u * u) ** 3));
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size.width, size.height);
}

function fillVignette(ctx: SKRSContext2D, size: Size, strength: number): void {
  const diag = Math.hypot(size.width, size.height);
  const x = size.width / 2;
  const y = size.height * 0.42;
  const g = ctx.createRadialGradient(x, y, diag * 0.25, x, y, diag * 0.62);
  for (let i = 0; i <= 12; i++) {
    const u = i / 12;
    g.addColorStop(u, `rgba(0, 0, 0, ${(strength * u * u * (3 - 2 * u)).toFixed(4)})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size.width, size.height);
}

/**
 * Adds monochrome film grain with a triangular distribution of +-`amount` levels.
 */
export function addGrain(canvas: Canvas, amount: number, seed = 1): void {
  if (amount <= 0) return;
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < d.length; i += 4) {
    const n = (next() + next() - 1) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(image, 0, 0);
}

async function drawImageBackground(
  ctx: SKRSContext2D,
  size: Size,
  file: string,
  blur: number,
): Promise<void> {
  const image = await loadImage(path.resolve(file));
  const { width: w, height: h } = size;
  const over = blur * 2;
  const scale = Math.max((w + over * 2) / image.width, (h + over * 2) / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (blur > 0) ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.filter = 'none';
}

/**
 * Renders the background once into an opaque canvas of the output size.
 * `unit` scales pixel values (image blur) from a 1080-pixel output.
 */
export async function createBackground(
  options: BackgroundOptions,
  size: Size,
  unit: number,
): Promise<Canvas> {
  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size.width, size.height);
  if (options.type === 'solid') {
    ctx.fillStyle = options.color;
    ctx.fillRect(0, 0, size.width, size.height);
  } else if (options.type === 'gradient') {
    fillLinear(
      ctx,
      size,
      options.colors.length ? options.colors : ['#000000'],
      options.angle ?? 135,
    );
    addGrain(canvas, 2.5);
  } else if (options.type === 'image') {
    await drawImageBackground(ctx, size, options.path, (options.blur ?? 0) * unit);
  } else {
    const preset = PRESETS[options.name];
    if (!preset) {
      throw new Error(
        `Unknown background preset "${options.name}". Presets: ${BACKGROUND_PRESETS.join(', ')}.`,
      );
    }
    fillLinear(ctx, size, preset.stops, preset.angle);
    for (const light of preset.lights) fillLight(ctx, size, light);
    fillVignette(ctx, size, preset.vignette);
    addGrain(canvas, preset.grain);
  }
  return canvas;
}
