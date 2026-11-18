/**
 * In-page: waits until the finite CSS animations, transitions and Web Animations of the
 * document have finished, at most `timeout` ms. Infinite and paused animations do not count.
 * Returns how many finite animations still run. Playwright serializes this function into
 * the page: it must be self-contained.
 */
export async function settleAnimations(timeout: number): Promise<number> {
  const deadline = performance.now() + timeout;
  const finite = () =>
    document.getAnimations().filter((animation) => {
      if (animation.playState !== 'running' && !animation.pending) {
        return false;
      }
      const end = animation.effect?.getComputedTiming().endTime;
      return typeof end === 'number' && Number.isFinite(end);
    });
  let running = finite();
  // An animation can start another one when it ends, so look again until none is left.
  while (running.length > 0) {
    const left = deadline - performance.now();
    if (left <= 0) {
      break;
    }
    await Promise.race([
      Promise.all(running.map((animation) => animation.finished.catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, left)),
    ]);
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
      setTimeout(resolve, 50);
    });
    running = finite();
  }
  return running.length;
}
