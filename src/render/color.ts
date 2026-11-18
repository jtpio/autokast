/**
 * An sRGB color with channels in 0-255 and alpha in 0-1.
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  transparent: '#00000000',
};

/**
 * Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`. Returns null for
 * other syntaxes (the canvas still accepts them where the color is used as is).
 */
export function parseColor(input: string): Rgba | null {
  const s = (NAMED[input.trim().toLowerCase()] ?? input).trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (!m) return null;
  const parts = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some((v) => Number.isNaN(v))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}

export function rgba(c: Rgba, alpha = c.a): string {
  const ch = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  return `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${Math.min(1, Math.max(0, alpha)).toFixed(4)})`;
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

function toOklab(c: Rgba): [number, number, number] {
  const r = toLinear(c.r);
  const g = toLinear(c.g);
  const b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: [number, number, number], a: number): Rgba {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186182 * m + 1.707614701 * s),
    a,
  };
}

/**
 * Mixes two colors in OKLab, which keeps blends free of muddy or grey midpoints.
 */
export function mixOklab(a: Rgba, b: Rgba, t: number): Rgba {
  const la = toOklab(a);
  const lb = toOklab(b);
  return fromOklab(
    [la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t],
    a.a + (b.a - a.a) * t,
  );
}

/**
 * Relative luminance, 0 (black) to 1 (white).
 */
export function luminance(c: Rgba): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}
