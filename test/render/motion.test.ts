import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { clampCamera, zoomTarget } from '../../src/render/camera.ts';
import { buildScene, type Scene } from '../../src/render/scene.ts';
import { contentMap, IDENTITY, stageAt } from '../../src/render/stage.ts';
import type { RenderOptions, Session, TimelineEvent } from '../../src/types.ts';
import { createFixture } from './fixture.ts';

type Point = [number, number];

const POINTS: Point[] = [
  [0, 0],
  [1280, 0],
  [0, 720],
  [1280, 720],
  [640, 360],
  [200, 600],
  [1000, 150],
];

/**
 * Output position of page point p at frame i; `stage` false leaves out the caption band.
 */
function screen(scene: Scene, i: number, [x, y]: Point, stage = true): Point {
  const m = contentMap(scene.layout, stage ? stageAt(scene.band, scene.bandOpen[i]) : IDENTITY, {
    scale: scene.camera.scale[i],
    cx: scene.camera.cx[i],
    cy: scene.camera.cy[i],
  });
  return [m.ex + x * m.ks, m.ey + y * m.ks];
}

function trace(scene: Scene, from: number, to: number, p: Point, stage = true): Point[] {
  const out: Point[] = [];
  scene.times.forEach((t, i) => {
    if (t >= from && t <= to) out.push(screen(scene, i, p, stage));
  });
  return out;
}

/**
 * Straightness, monotonic progress, speed peaks and axis reversals of a screen path, or
 * null when the point does not move.
 */
function analyze(p: Point[]) {
  const [x0, y0] = p[0];
  const [x1, y1] = p[p.length - 1];
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1) return null;
  let cross = 0;
  let monotonic = true;
  let reversal = false;
  let last = -Infinity;
  const speed: number[] = [];
  for (let i = 0; i < p.length; i++) {
    const dx = p[i][0] - x0;
    const dy = p[i][1] - y0;
    cross = Math.max(cross, Math.abs(dx * (y1 - y0) - dy * (x1 - x0)) / len);
    const progress = (dx * (x1 - x0) + dy * (y1 - y0)) / len;
    if (progress < last - 1e-6) monotonic = false;
    last = progress;
    if (i > 0) speed.push(Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
    if (i > 1) {
      for (const a of [0, 1]) {
        const v0 = p[i - 1][a] - p[i - 2][a];
        const v1 = p[i][a] - p[i - 1][a];
        if (v0 * v1 < 0 && Math.abs(v0) > 0.05 && Math.abs(v1) > 0.05) reversal = true;
      }
    }
  }
  let peaks = 0;
  let rising = false;
  for (let i = 1; i < speed.length; i++) {
    const d = speed[i] - speed[i - 1];
    if (d > 1e-6) rising = true;
    else if (d < -1e-6 && rising) {
      peaks++;
      rising = false;
    }
  }
  if (rising) peaks++;
  return { cross, monotonic, peaks, reversal };
}

/**
 * Largest frame-to-frame change of velocity over the peak speed, for all points.
 */
function jerkRatio(scene: Scene, stage = true): number {
  let worst = 0;
  for (const p of POINTS) {
    let peak = 0;
    let change = 0;
    for (let i = 2; i < scene.times.length; i++) {
      const a = screen(scene, i, p, stage);
      const b = screen(scene, i - 1, p, stage);
      const c = screen(scene, i - 2, p, stage);
      peak = Math.max(peak, Math.hypot(a[0] - b[0], a[1] - b[1]));
      change = Math.max(change, Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1]));
    }
    if (peak > 0) worst = Math.max(worst, change / peak);
  }
  return worst;
}

const VP = { width: 1280, height: 720 };

function session(events: TimelineEvent[], cursor: Point = [640, 360]): Session {
  return {
    version: 1,
    name: 'motion',
    createdAt: '',
    viewport: VP,
    deviceScaleFactor: 1,
    captureMode: 'frame-perfect',
    frameSize: VP,
    duration: 4000,
    frames: [{ t: 0, file: 'none.jpg' }],
    cursor: [{ t: 0, x: cursor[0], y: cursor[1] }],
    events,
  };
}

const zoom = (t: number, focus: { x: number; y: number } | null, scale?: number) =>
  ({
    type: 'zoom',
    t,
    focus: focus && { ...focus, width: 60, height: 40 },
    scale,
  }) as TimelineEvent;

const TARGETS = {
  corner: { x: 0, y: 0 },
  right: { x: 1220, y: 340 },
  bottom: { x: 620, y: 680 },
  center: { x: 610, y: 340 },
};

const MODES: RenderOptions['zoom'][] = [{}, { edges: 'keep' }, { mode: 'crop' }];

function assertPivot(scene: Scene, from: number, to: number, label: string): void {
  let moving = 0;
  for (const p of POINTS) {
    const r = analyze(trace(scene, from, to, p));
    if (!r) continue;
    moving++;
    assert.ok(r.cross < 0.5, `${label}: cross-track ${r.cross}`);
    assert.ok(r.monotonic, `${label}: progress goes back`);
    assert.equal(r.peaks, 1, `${label}: ${r.peaks} speed peaks`);
    assert.ok(!r.reversal, `${label}: reversal`);
  }
  assert.ok(moving > 0, `${label}: nothing moves`);
}

test('every transition from rest is one pivot zoom, in fill, keep and crop mode', () => {
  for (const mode of MODES) {
    for (const [name, focus] of Object.entries(TARGETS)) {
      for (const scale of [1.5, 2]) {
        const scene = buildScene(session([zoom(300, focus, scale)]), {
          zoom: { ...mode, follow: 'off' },
        });
        assertPivot(scene, 300, 1200, `${JSON.stringify(mode)} ${name} ${scale}`);
      }
    }
  }
});

test('transitions stay one pivot zoom in every follow mode, with a moving cursor', () => {
  for (const follow of ['off', 'edge', 'cursor'] as const) {
    for (const [name, focus] of Object.entries(TARGETS)) {
      const moving: Session = {
        ...session([zoom(300, focus, 2)]),
        cursor: [
          { t: 0, x: focus.x + 30, y: focus.y + 20 },
          { t: 1500, x: focus.x + 160, y: focus.y + 60 },
        ],
      };
      const scene = buildScene(moving, { zoom: { follow } });
      assertPivot(scene, 300, 1200, `${follow} ${name}`);
    }
  }
});

test('a transition between two zoomed states is one pivot zoom', () => {
  const scene = buildScene(
    session([zoom(300, TARGETS.corner, 1.5), zoom(2000, { x: 900, y: 500 }, 2.5)]),
    { zoom: { follow: 'off' } },
  );
  assertPivot(scene, 2000, 2900, 'zoomed to zoomed');
});

test('an interrupted transition blends into the new one without a velocity jump', () => {
  const scene = buildScene(
    session([zoom(300, { x: 600, y: 340 }, 2), zoom(750, { x: 700, y: 380 }, 2.6)]),
    { zoom: { follow: 'off' } },
  );
  assert.ok(jerkRatio(scene) < 0.12, `velocity jump ${jerkRatio(scene)}`);
  const last = scene.times.length - 1;
  const target = zoomTarget(
    { focus: { x: 700, y: 380, width: 60, height: 40 }, scale: 2.6 },
    VP,
    3,
  );
  assert.equal(scene.camera.scale[last], target.scale);
  assert.ok(Math.abs(scene.camera.cx[last] - target.cx) < 1e-9);
});

test('a transition lands on the follow target, with no second move', () => {
  const home = zoomTarget({ focus: { x: 600, y: 340, width: 80, height: 40 }, scale: 2 }, VP, 3);
  const hw = VP.width / (2 * home.scale);
  const cursor: Point = [home.cx + hw - 30, 360];
  const scene = buildScene(session([zoom(300, { x: 610, y: 340 }, 2)], cursor));
  const end = scene.times.findIndex((t) => t >= 1200);
  const landed = scene.camera.cx[end];
  assert.ok(landed - home.cx > 20, `landing offset ${landed - home.cx}`);
  for (let i = end; i < scene.times.length; i++) {
    assert.ok(Math.abs(scene.camera.cx[i] - landed) < 1e-6, `moves after landing at ${i}`);
  }
  assertPivot(scene, 300, 1200, 'landing transition');
});

test('end states keep their framing: fill bleeds past the edges, keep and crop clamp', () => {
  const corner = [zoom(300, TARGETS.corner, 2)];
  const held = (options: RenderOptions) => {
    const scene = buildScene(session(corner, [1100, 600]), options);
    const i = scene.times.length - 1;
    return {
      scene,
      m: contentMap(scene.layout, IDENTITY, {
        scale: scene.camera.scale[i],
        cx: scene.camera.cx[i],
        cy: scene.camera.cy[i],
      }),
    };
  };
  const fill = held({});
  const bleed = 0.32 * fill.scene.layout.radius * 2 + 2;
  assert.ok(Math.abs(fill.m.ex + bleed) < 1e-6 && Math.abs(fill.m.ey + bleed) < 1e-6);
  const keep = held({ zoom: { edges: 'keep' } });
  assert.ok(Math.abs(keep.m.ex - keep.scene.layout.content.x) < 1e-6);
  assert.ok(Math.abs(keep.m.ey - keep.scene.layout.content.y) < 1e-6);
  const crop = held({ zoom: { mode: 'crop' } });
  const i = crop.scene.times.length - 1;
  const expected = clampCamera(
    zoomTarget({ focus: { x: 0, y: 0, width: 60, height: 40 }, scale: 2 }, VP, 3),
    VP,
  );
  assert.deepEqual(
    { scale: crop.scene.camera.scale[i], cx: crop.scene.camera.cx[i], cy: crop.scene.camera.cy[i] },
    expected,
  );
});

let dir: string;
let fixture: Session;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-motion-'));
  fixture = await createFixture(dir, { deviceScaleFactor: 1 });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('no page point reverses in a fixture transition that starts from a still camera', () => {
  const scene = buildScene(fixture);
  const zooms = scene.session.events
    .filter((e) => e.type === 'zoom')
    .map((e) => ({
      out: scene.map.toOutput(e.t),
      duration: (e as { duration?: number }).duration ?? 900,
    }))
    .sort((a, b) => a.out - b.out);
  let checked = 0;
  zooms.forEach((z, j) => {
    const end = Math.min(z.out + z.duration, zooms[j + 1]?.out ?? Infinity);
    const i0 = scene.times.findIndex((t) => t >= z.out);
    const still = POINTS.every((p) => {
      const a = screen(scene, i0 - 1, p, false);
      const b = screen(scene, i0 - 2, p, false);
      return Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05;
    });
    if (!still) return;
    checked++;
    for (const p of POINTS) {
      const r = analyze(trace(scene, z.out, end, p, false));
      if (!r) continue;
      assert.ok(!r.reversal && r.monotonic, `reversal in zoom at ${z.out}`);
      assert.ok(r.cross < 0.5, `cross-track ${r.cross} in zoom at ${z.out}`);
    }
  });
  assert.ok(checked >= 2, `${checked} transitions checked`);
});

test('motion stays continuous through transitions, follow and the caption band', () => {
  const scene = buildScene(fixture);
  assert.ok(jerkRatio(scene, false) < 0.12, `camera ${jerkRatio(scene, false)}`);
  assert.ok(jerkRatio(scene, true) < 0.12, `with band ${jerkRatio(scene, true)}`);
});

test('a pure camera pan does not tilt the cursor', () => {
  const scene = buildScene(
    session([zoom(300, TARGETS.corner, 2), zoom(1500, TARGETS.right, 2), zoom(2700, null)]),
    { zoom: { follow: 'off' } },
  );
  assert.ok(
    scene.camera.cx.some((c) => Math.abs(c - 640) > 100),
    'the camera pans',
  );
  assert.ok(scene.cursor.angle.every((a) => a === 0));
});
