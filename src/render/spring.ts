/**
 * Advances a critically damped spring by `dt` seconds toward a constant `target`.
 * Uses the exact solution, so it is stable for any step size. Returns [position, velocity].
 */
export function springStep(
  x: number,
  v: number,
  target: number,
  omega: number,
  dt: number,
): [number, number] {
  const d = x - target;
  const c = v + omega * d;
  const decay = Math.exp(-omega * dt);
  return [target + (d + c * dt) * decay, (v - omega * c * dt) * decay];
}

/**
 * Zero-phase smoothing of a sampled signal: a critically damped spring run forward,
 * then backward. Unlike a one-way spring, it adds no lag. `breaks[i]` restarts the
 * spring at sample i (for example after a cut).
 */
export function springSmooth(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  omega: number,
  breaks?: ArrayLike<boolean>,
): Float64Array {
  const n = values.length;
  const forward = new Float64Array(n);
  const out = new Float64Array(n);
  if (n === 0) return out;
  let x = values[0];
  let v = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 || breaks?.[i]) {
      x = values[i];
      v = 0;
    } else {
      [x, v] = springStep(x, v, values[i], omega, (times[i] - times[i - 1]) / 1000);
    }
    forward[i] = x;
  }
  x = forward[n - 1];
  v = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (i === n - 1 || breaks?.[i + 1]) {
      x = forward[i];
      v = 0;
    } else {
      [x, v] = springStep(x, v, forward[i], omega, (times[i + 1] - times[i]) / 1000);
    }
    out[i] = x;
  }
  return out;
}
