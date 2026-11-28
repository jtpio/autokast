import { defineScreencast } from 'autokast';

/**
 * Spotlights on the Orbit demo app: each one dims the page around one element, to point
 * at it without a zoom. Start the app with `node examples/demo-app/serve.mjs` first.
 */
export default defineScreencast({
  name: 'orbit-spotlight',
  url: process.env.ORBIT_URL ?? 'http://localhost:4173',
  colorScheme: 'light',
  cursor: { start: { x: 900, y: 600 } },
  render: { background: 'dune' },

  async setup({ page }) {
    await page.getByTestId('card-ORB-118').waitFor();
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  },

  async run(cast) {
    const { page } = cast;
    const region = (name: string) => page.getByRole('region', { name });
    const bar = (index: number) => page.getByTestId(`chart-bar-${index}`);

    await cast.spotlight(page.locator('.sprint'), { wait: true });
    await cast.click(page.getByRole('link', { name: 'Analytics' }));

    await cast.spotlight(page.locator('#stats'), { duration: 2400, wait: true });

    // Enter the bar from above, so that no other tooltip flashes on the way.
    await cast.moveTo(bar(9), { position: { x: 0.5, y: -0.4 } });
    await cast.spotlight(region('Completed per week'), { duration: 3000 });
    await cast.hover(bar(9), { hold: 900 });
    await cast.hover(bar(11), { hold: 1100 });

    await cast.spotlight(region('Team'), { duration: 2800 });
    await cast.click(page.getByRole('columnheader', { name: 'Cycle time' }));
    await cast.wait(1900);
  },
});
