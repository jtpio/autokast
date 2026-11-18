import { defineScreencast } from 'autokast';

const TITLE = 'Ship the onboarding tour';

/**
 * Product tour of Orbit, the project tracker in `examples/demo-app`.
 * Start the app with `node examples/demo-app/serve.mjs` first.
 */
export default defineScreencast({
  name: 'orbit-board',
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
    const dialog = page.getByRole('dialog', { name: 'New task' });
    const palette = page.getByRole('dialog', { name: 'Command palette' });

    await cast.wait(400);

    await cast.click(page.getByRole('button', { name: 'New task' }));
    await cast.cut(() => dialog.waitFor());
    // The camera follows the cursor, so the cursor goes into each zoom target first.
    await cast.moveTo(page.getByLabel('Title'));
    await cast.zoomTo(dialog, { scale: 1.3 });
    await cast.type(TITLE, { into: page.getByLabel('Title') });
    await cast.click(page.getByRole('button', { name: 'Priority' }));
    await cast.click(page.getByRole('option', { name: 'High' }));
    await cast.click(dialog.getByRole('button', { name: 'Frontend' }));
    await cast.click(page.getByRole('button', { name: 'Create task' }));
    await cast.zoomOut();
    await cast.wait(1000);

    const card = page.locator('[data-testid^="card-ORB"]').filter({ hasText: TITLE });
    // A drop on the upper part of ORB-112 puts the card at the top of the column.
    await cast.drag(card, page.getByTestId('card-ORB-112'), {
      position: { x: 0.5, y: 0.25 },
    });
    await cast.wait(1000);

    await cast.click(page.getByRole('button', { name: 'Quick actions' }));
    await cast.cut(() => palette.waitFor());
    await cast.moveTo(page.getByRole('combobox', { name: 'Search commands' }));
    await cast.zoomTo(palette, { scale: 1.6 });
    await cast.type('ana');
    await cast.wait(250);
    await cast.click(page.getByRole('option', { name: 'Go to Analytics' }));
    await cast.zoomOut();
    await cast.wait(900);

    const bar = page.getByTestId('chart-bar-9');
    const box = (await bar.boundingBox())!;
    // Enter the bar from above, so that no other tooltip flashes on the way.
    await cast.moveTo({ x: box.x + box.width / 2, y: box.y - 24 });
    await cast.zoomTo(page.getByRole('region', { name: 'Completed per week' }), { scale: 1.55 });
    await cast.hover(bar, { hold: 1000 });
    await cast.hover(page.getByTestId('chart-bar-11'), { hold: 1200 });

    await cast.zoomTo(page.getByRole('region', { name: 'Team' }), { scale: 1.55 });
    await cast.click(page.getByRole('columnheader', { name: 'Cycle time' }));
    await cast.wait(1100);

    await cast.zoomOut();
    await cast.click(page.getByRole('button', { name: 'Toggle theme' }));
    await cast.wait(1000);
    await cast.click(page.getByRole('link', { name: 'Board' }));
    await cast.wait(1300);
  },
});
