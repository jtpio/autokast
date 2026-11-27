import { defineScreencast } from 'autokast';

const ORBIT = process.env.ORBIT_URL ?? 'http://localhost:4173';

/**
 * The browser frame on the Orbit demo app: the address bar shows a URL as typed text
 * before the page opens, and follows the page after that.
 * Start the app with `node examples/demo-app/serve.mjs` first.
 */
export default defineScreencast({
  name: 'orbit-browser',
  url: ORBIT,
  colorScheme: 'light',
  cursor: { start: { x: 900, y: 600 } },
  render: {
    background: 'harbor',
    frame: { chrome: 'browser', origin: 'orbit.example' },
  },

  async setup({ page }) {
    await page.getByTestId('card-ORB-118').waitFor();
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  },

  async run(cast) {
    const { page } = cast;
    const bar = (index: number) => page.getByTestId(`chart-bar-${index}`);

    await cast.goto(`${ORBIT}/#analytics`);
    await cast.cut(() => page.getByRole('heading', { name: 'Analytics' }).waitFor());
    // Enter the bar from above, so that no other tooltip flashes on the way.
    await cast.moveTo(bar(9), { position: { x: 0.5, y: -0.4 } });
    await cast.hover(bar(9), { hold: 700 });
    await cast.hover(bar(11), { hold: 900 });

    await cast.click(page.getByRole('link', { name: 'Settings' }));
    await cast.showUrl();
    await cast.click(page.getByTestId('theme-dark'));
    await cast.wait(1600);
  },
});
