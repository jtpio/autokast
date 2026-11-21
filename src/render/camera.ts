import type { FollowMode, MouseButtonEvent, KeyEvent, Size, ZoomEvent } from '../types.ts';
import { clamp, easing, type EasingFunction } from './easing.ts';
import { springStep } from './spring.ts';
import type { ResolvedAutoZoom } from './defaults.ts';
import type { TimedEvent } from './timeline.ts';

/**
 * Camera state in viewport CSS pixels: `scale` 1 shows the full viewport; the visible
 * rectangle has size viewport / scale and is centered on (cx, cy).
 */
export interface CameraState {
  scale: number;
  cx: number;
  cy: number;
}

export interface CameraTrack {
  scale: Float64Array;
  cx: Float64Array;
  cy: Float64Array;
}

export interface CameraOptions {
  maxScale: number;
  duration: number;
  easing: ZoomEvent['easing'];
  /**
   * Follow mode for shots that do not set one.
   */
  follow: FollowMode;
  /**
   * Multiplies the follow spring frequency.
   */
  followSpeed?: number;
  /**
   * Named zoom levels for events with `level`.
   */
  levels?: Record<string, number>;
  /**
   * Size of the region a fit zoom fills, relative to the rest frame, at an output time:
   * larger than 1 in camera mode, where the page may use the whole output.
   */
  fit?: (t: number) => FitRegion;
  /**
   * Framing rules for end states and held states at an output time (edges, caption
   * band). Default: the visible rectangle stays inside the viewport.
   */
  constrain?: Constrain;
}

export type Constrain = (state: CameraState, t: number) => CameraState;

export interface FitRegion {
  x: number;
  y: number;
}

/**
 * Default space around a zoom focus without `scale`, in CSS pixels.
 */
export const DEFAULT_FOCUS_PADDING = 40;
/**
 * Follow keeps the cursor this fraction of the visible size away from the edges.
 */
export const FOLLOW_MARGIN = 0.06;
/**
 * Angular frequency of the follow spring, in 1/s (settles in about 0.7 s).
 */
export const FOLLOW_OMEGA = 6;
/**
 * Follow mode 'cursor': the cursor may move freely inside this central fraction of the
 * visible size; the camera travels when it pushes past, on a calmer spring.
 */
export const DEAD_ZONE = 0.3;
export const CURSOR_OMEGA = 5;

/**
 * The scale a zoom event asks for: `scale`, else its named `level`, else undefined (fit).
 */
export function zoomScale(
  event: Pick<ZoomEvent, 'scale' | 'level'>,
  levels: Record<string, number>,
): number | undefined {
  if (event.scale !== undefined) return event.scale;
  if (event.level === undefined) return undefined;
  const scale = levels[event.level];
  if (scale === undefined) {
    throw new Error(
      `Unknown zoom level "${event.level}". Known levels: ${Object.keys(levels).join(', ')}.`,
    );
  }
  return scale;
}

/**
 * Moves the center so that the visible rectangle stays inside the viewport.
 */
export function clampCamera(state: CameraState, viewport: Size): CameraState {
  const hw = viewport.width / (2 * state.scale);
  const hh = viewport.height / (2 * state.scale);
  return {
    scale: state.scale,
    cx: clamp(state.cx, hw, viewport.width - hw),
    cy: clamp(state.cy, hh, viewport.height - hh),
  };
}

/**
 * The camera state that a zoom event asks for. `scale` is the magnification relative to
 * the rest view. Without it, the focus plus `padding` fits the region the camera can
 * use, which is `fit` times the rest frame.
 */
export function zoomTarget(
  event: Pick<ZoomEvent, 'focus' | 'scale' | 'padding'>,
  viewport: Size,
  maxScale: number,
  fit: FitRegion = { x: 1, y: 1 },
): CameraState {
  const focus = event.focus;
  if (!focus) return { scale: 1, cx: viewport.width / 2, cy: viewport.height / 2 };
  let scale = event.scale;
  if (scale === undefined) {
    const pad = event.padding ?? DEFAULT_FOCUS_PADDING;
    scale = Math.min(
      (viewport.width * fit.x) / Math.max(1, focus.width + 2 * pad),
      (viewport.height * fit.y) / Math.max(1, focus.height + 2 * pad),
    );
  }
  scale = clamp(scale, 1, maxScale);
  const center = { scale, cx: focus.x + focus.width / 2, cy: focus.y + focus.height / 2 };
  return clampCamera(center, viewport);
}

/**
 * Interpolates two camera states. The scale changes geometrically and the center moves
 * so that the zoom pivots on the one page point that has the same screen position in
 * both states, like a pinch zoom: every page point moves on a straight line, with one
 * speed peak. Equal scales give a straight pan. Only the end states are constrained.
 */
export function interpolateCamera(a: CameraState, b: CameraState, e: number): CameraState {
  const r = a.scale / b.scale;
  const lr = Math.log(r);
  const f = Math.abs(lr) < 1e-6 ? e : (1 - Math.exp(lr * e)) / (1 - r);
  return {
    scale: a.scale * Math.exp(-lr * e),
    cx: a.cx + (b.cx - a.cx) * f,
    cy: a.cy + (b.cy - a.cy) * f,
  };
}

interface TransitionTrajectory {
  kind: 'transition';
  from: Trajectory;
  to: CameraState;
  t0: number;
  duration: number;
  ease: EasingFunction;
}

type Trajectory =
  | { kind: 'static'; state: CameraState }
  | {
      kind: 'coast';
      state: CameraState;
      vx: number;
      vy: number;
      t0: number;
      constrain: Constrain;
      omega: number;
    }
  | TransitionTrajectory;

/**
 * Camera state of a trajectory at output time `t`.
 */
function evaluate(tr: Trajectory, t: number): CameraState {
  if (tr.kind === 'static') return tr.state;
  if (tr.kind === 'coast') {
    const k = (1 - Math.exp((-tr.omega * (t - tr.t0)) / 1000)) / tr.omega;
    const s = tr.state;
    return tr.constrain({ scale: s.scale, cx: s.cx + tr.vx * k, cy: s.cy + tr.vy * k }, t);
  }
  if (t >= tr.t0 + tr.duration) return tr.to;
  const e = tr.duration > 0 ? tr.ease((t - tr.t0) / tr.duration) : 1;
  return interpolateCamera(evaluate(tr.from, t), tr.to, e);
}

export interface CursorInput {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /**
   * Size of the drawn cursor in CSS pixels, kept in view below and right of the hotspot.
   */
  extent: number;
}

interface Transition {
  t0: number;
  end: number;
  event: TimedEvent<ZoomEvent>;
  mode: FollowMode;
  omega: number;
  /**
   * The directed framing, constrained at the end time.
   */
  home: CameraState;
  /**
   * Where the transition lands: the home view, or the follow target at the end time.
   */
  land: CameraState;
}

/**
 * Follow targets, by the follow mode of each shot:
 * - 'off': the directed framing (home).
 * - 'edge': home moved by the smallest offset that keeps the cursor `FOLLOW_MARGIN` inside
 *   the view (plus room for the cursor body below and right of the hotspot); the offset
 *   is 0 again when the cursor is well inside. A cursor-anchored shot has no framing to
 *   return to: the view stays where the cursor pushed it.
 * - 'cursor': the view travels with the cursor, which may move freely in a central dead
 *   zone; the view never returns home.
 * After each directive the follow waits until the cursor has been inside the home view:
 * a cursor left outside when the zoom started does not pull the camera. NaN during
 * transitions.
 */
function followTargets(
  times: ArrayLike<number>,
  active: Int32Array,
  transitions: Transition[],
  cursor: CursorInput | null,
  viewport: Size,
  fallback: FollowMode,
  constrain: Constrain,
): [Float64Array, Float64Array] {
  const n = times.length;
  const fx = new Float64Array(n).fill(NaN);
  const fy = new Float64Array(n).fill(NaN);
  const rest: CameraState = { scale: 1, cx: viewport.width / 2, cy: viewport.height / 2 };
  let segment = -2;
  let engaged = false;
  let ax = rest.cx;
  let ay = rest.cy;
  for (let i = 0; i < n; i++) {
    const tr = active[i] >= 0 ? transitions[active[i]] : null;
    const home = tr ? tr.home : rest;
    if (active[i] !== segment) {
      segment = active[i];
      engaged = false;
      ax = home.cx;
      ay = home.cy;
    }
    const mode = tr ? tr.mode : fallback;
    const s = home.scale;
    const hw = viewport.width / (2 * s);
    const hh = viewport.height / (2 * s);
    const x = cursor ? cursor.x[i] : home.cx;
    const y = cursor ? cursor.y[i] : home.cy;
    if (Math.abs(x - home.cx) <= hw && Math.abs(y - home.cy) <= hh) engaged = true;
    if (tr && times[i] < tr.end) continue;
    let cx = home.cx;
    let cy = home.cy;
    if (mode !== 'off' && cursor && engaged && s > 1.001) {
      const mx = (FOLLOW_MARGIN * viewport.width) / s;
      const my = (FOLLOW_MARGIN * viewport.height) / s;
      const ext = Math.min(cursor.extent, hw - mx);
      let left = hw - mx;
      let right = hw - mx - ext;
      let up = hh - my;
      let down = hh - my - ext;
      if (mode === 'cursor') {
        left = right = (DEAD_ZONE / 2) * 2 * hw;
        up = down = (DEAD_ZONE / 2) * 2 * hh;
      }
      const accumulate = mode === 'cursor' || tr?.event.anchor === 'cursor';
      const bx = accumulate ? ax : home.cx;
      const by = accumulate ? ay : home.cy;
      cx = x < bx - left ? x + left : x > bx + right ? x - right : bx;
      cy = y < by - up ? y + up : y > by + down ? y - down : by;
      const c = constrain({ scale: s, cx, cy }, times[i]);
      cx = c.cx;
      cy = c.cy;
      if (accumulate) {
        ax = cx;
        ay = cy;
      }
    }
    fx[i] = cx;
    fy[i] = cy;
  }
  return [fx, fy];
}

/**
 * Computes the camera for every output frame. A zoom event starts a transition from the
 * current motion (a running transition keeps running underneath, so position and
 * velocity stay continuous). Between transitions, a critically damped spring pans toward
 * the follow target. The spring reads the target 2/omega ahead, which cancels its lag, so
 * the cursor stays in view even during fast moves. A transition lands on the follow target
 * of its end time, so an engaged follow adds no second move.
 */
export function computeCamera(
  times: ArrayLike<number>,
  zooms: TimedEvent<ZoomEvent>[],
  cursor: CursorInput | null,
  viewport: Size,
  options: CameraOptions,
): CameraTrack {
  const n = times.length;
  const track: CameraTrack = {
    scale: new Float64Array(n),
    cx: new Float64Array(n),
    cy: new Float64Array(n),
  };
  const constrain: Constrain = options.constrain ?? ((state) => clampCamera(state, viewport));
  const speed = options.followSpeed ?? 1;
  const levels = options.levels ?? {};
  const transitions: Transition[] = [...zooms]
    .sort((a, b) => a.out - b.out)
    .map((event) => {
      const end = event.out + Math.max(0, event.duration ?? options.duration);
      const scale = zoomScale(event, levels);
      const target = zoomTarget(
        { focus: event.focus, scale, padding: event.padding },
        viewport,
        options.maxScale,
        options.fit?.(end),
      );
      const home = constrain(target, end);
      const mode = event.follow ?? options.follow;
      const omega = (mode === 'cursor' ? CURSOR_OMEGA : FOLLOW_OMEGA) * speed;
      return { t0: event.out, end, event, mode, omega, home, land: home };
    });
  const active = new Int32Array(n).fill(-1);
  for (let i = 0, j = -1; i < n; i++) {
    while (j + 1 < transitions.length && transitions[j + 1].t0 <= times[i]) j++;
    active[i] = j;
  }
  const [fx, fy] = followTargets(
    times,
    active,
    transitions,
    cursor,
    viewport,
    options.follow,
    constrain,
  );
  const omegaAt = (i: number) =>
    active[i] >= 0 ? transitions[active[i]].omega : FOLLOW_OMEGA * speed;
  const lookAhead = (from: number) => {
    let a = from;
    const lead = 2000 / omegaAt(from);
    while (
      a + 1 < n &&
      times[a + 1] <= times[from] + lead &&
      active[a + 1] === active[from] &&
      !Number.isNaN(fx[a + 1])
    ) {
      a++;
    }
    return a;
  };
  transitions.forEach((tr, j) => {
    let i = 0;
    while (i < n && (active[i] < j || (active[i] === j && times[i] < tr.end))) i++;
    if (i >= n || active[i] !== j || Number.isNaN(fx[i])) return;
    const a = lookAhead(i);
    tr.land = constrain({ scale: tr.home.scale, cx: fx[a], cy: fy[a] }, tr.end);
  });

  let state: CameraState = { scale: 1, cx: viewport.width / 2, cy: viewport.height / 2 };
  let vx = 0;
  let vy = 0;
  let traj: TransitionTrajectory | null = null;
  let current = -1;
  let ahead = 0;
  let prevT = n > 0 ? times[0] : 0;
  for (let i = 0; i < n; i++) {
    const t = times[i];
    while (current < active[i]) {
      const tr = transitions[++current];
      let from: Trajectory;
      if (traj && tr.t0 < traj.t0 + traj.duration) from = traj;
      else if (Math.hypot(vx, vy) > 1) {
        from = { kind: 'coast', state, vx, vy, t0: prevT, constrain, omega: omegaAt(i - 1) };
      } else from = { kind: 'static', state };
      traj = {
        kind: 'transition',
        from,
        to: tr.land,
        t0: tr.t0,
        duration: tr.end - tr.t0,
        ease: easing(tr.event.easing ?? options.easing),
      };
    }
    const dt = Math.max(1e-6, t - prevT) / 1000;
    if (traj && t < traj.t0 + traj.duration) {
      const s = evaluate(traj, t);
      if (i > 0) {
        vx = (s.cx - state.cx) / dt;
        vy = (s.cy - state.cy) / dt;
      }
      state = s;
    } else {
      if (traj) {
        state = traj.to;
        traj = null;
        vx = 0;
        vy = 0;
      }
      const omega = omegaAt(i);
      if (ahead < i) ahead = i;
      while (
        ahead + 1 < n &&
        times[ahead + 1] <= t + 2000 / omega &&
        active[ahead + 1] === active[i] &&
        !Number.isNaN(fx[ahead + 1])
      ) {
        ahead++;
      }
      const tx = Number.isNaN(fx[ahead]) ? state.cx : fx[ahead];
      const ty = Number.isNaN(fy[ahead]) ? state.cy : fy[ahead];
      let cx: number;
      let cy: number;
      [cx, vx] = springStep(state.cx, vx, tx, omega, dt);
      [cy, vy] = springStep(state.cy, vy, ty, omega, dt);
      const held = constrain({ scale: state.scale, cx, cy }, t);
      if (held.cx !== cx) vx = 0;
      if (held.cy !== cy) vy = 0;
      state = held;
    }
    track.scale[i] = state.scale;
    track.cx[i] = state.cx;
    track.cy[i] = state.cy;
    prevT = t;
  }
  return track;
}

/**
 * Generates zoom events from clicks and typing: zoom in so the camera arrives
 * about 300 ms before the first click, pan when a later click is far away, and
 * zoom out `hold` ms after the last activity.
 */
export function autoZoomEvents(
  events: TimedEvent[],
  cursorAt: (out: number) => { x: number; y: number },
  viewport: Size,
  auto: ResolvedAutoZoom,
  duration: number,
): TimedEvent<ZoomEvent>[] {
  const lead = 300;
  const acts: { out: number; t: number; x: number; y: number }[] = [];
  for (const e of events) {
    if (e.type === 'mouseDown' && (e as MouseButtonEvent).button === 'left') {
      acts.push({ out: e.out, t: e.t, x: (e as MouseButtonEvent).x, y: (e as MouseButtonEvent).y });
    } else if (e.type === 'key' && (e as KeyEvent).kind === 'text') {
      acts.push({ out: e.out, t: e.t, ...cursorAt(e.out) });
    }
  }
  const zooms: TimedEvent<ZoomEvent>[] = [];
  const point = (a: { x: number; y: number }) => ({ x: a.x, y: a.y, width: 0, height: 0 });
  const visibleW = viewport.width / auto.scale;
  const visibleH = viewport.height / auto.scale;
  let i = 0;
  let free = 0;
  while (i < acts.length) {
    const first = acts[i];
    const start = Math.max(free, first.out - lead - duration);
    zooms.push({ type: 'zoom', t: first.t, out: start, focus: point(first), scale: auto.scale });
    let center = clampCamera({ scale: auto.scale, cx: first.x, cy: first.y }, viewport);
    let last = first;
    let lastZoom = start;
    i++;
    while (i < acts.length) {
      const a = acts[i];
      const joins =
        a.out - last.out <= auto.mergeWindow ||
        a.out - lead - duration <= last.out + auto.hold + duration;
      if (!joins) break;
      const far =
        Math.abs(a.x - center.cx) > visibleW * 0.3 || Math.abs(a.y - center.cy) > visibleH * 0.3;
      if (far) {
        const out = Math.max(lastZoom + 1, a.out - lead - duration);
        zooms.push({ type: 'zoom', t: a.t, out, focus: point(a), scale: auto.scale });
        center = clampCamera({ scale: auto.scale, cx: a.x, cy: a.y }, viewport);
        lastZoom = out;
      }
      last = a;
      i++;
    }
    const zoomOut = Math.max(lastZoom + 1, last.out + auto.hold);
    zooms.push({ type: 'zoom', t: last.t, out: zoomOut, focus: null });
    free = zoomOut + duration;
  }
  return zooms;
}
