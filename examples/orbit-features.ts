import { defineScreencast } from '@jtpio/autocast';

/**
 * A tour of the autocast features on the Orbit demo app, with a caption for each one.
 * Start the app with `node examples/demo-app/serve.mjs` first.
 */
export default defineScreencast({
  name: 'orbit-features',
  url: process.env.ORBIT_URL ?? 'http://localhost:4173',
  colorScheme: 'light',
  cursor: { start: { x: 900, y: 600 } },
  render: { background: 'dune', keystrokes: { show: 'shortcuts' } },

  async setup({ page }) {
    await page.getByTestId('card-ORB-118').waitFor();
  },

  async run(cast) {
    const { page } = cast;
    const dialog = page.getByRole('dialog', { name: 'New task' });
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    const card = (id: string) => page.getByTestId(`card-ORB-${id}`);
    const bar = (index: number) => page.getByTestId(`chart-bar-${index}`);
    // Each caption stays until the next one replaces it.
    const caption = (label: string, text: string) => cast.caption(text, { label, duration: 9000 });

    await caption('01', 'A cursor with weight, and click effects');
    await cast.click(page.getByRole('button', { name: 'New task' }), { afterClick: 0 });
    await cast.cut(() => dialog.waitFor());
    await cast.type('Ship the onboarding tour', { into: page.getByLabel('Title') });
    await cast.click(page.getByRole('button', { name: 'Create task' }));
    await cast.wait(500);

    await caption('02', 'Zoom levels, and a camera that follows the cursor');
    await cast.moveTo(card('118'));
    await cast.zoom('medium');
    await cast.hover(card('133'), { hold: 250 });
    await cast.hover(card('115'), { hold: 250 });
    await cast.zoom('close');
    await cast.hover(card('104'), { hold: 900 });
    await cast.zoomOut();

    await caption('03', 'Any action on the page: click, type, drag, scroll');
    const created = page
      .locator('[data-testid^="card-ORB"]')
      .filter({ hasText: 'Ship the onboarding tour' });
    await cast.drag(created, card('112'), { position: { x: 0.5, y: 0.25 } });
    await cast.wait(1300);

    await caption('04', 'Shortcuts shown as keycaps');
    await cast.wait(500);
    await cast.press('Control+K');
    await cast.cut(() => palette.waitFor());
    await cast.wait(700);
    await cast.type('ana');
    await cast.wait(500);
    await cast.press('Enter');
    await cast.wait(1400);

    await cast.caption('Shots that frame one element', { label: '05', duration: 4200 });
    await cast.moveTo(bar(9), { position: { x: 0.5, y: -0.4 } });
    await cast.zoomTo(page.getByRole('region', { name: 'Completed per week' }), {
      padding: 30,
      follow: 'off',
    });
    await cast.hover(bar(9), { hold: 900 });
    await cast.hover(bar(11), { hold: 1200 });
    await cast.zoomOut();
    await cast.wait(400);
  },
});
