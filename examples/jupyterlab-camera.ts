import { defineScreencast } from 'autokast';
import { resetJupyterLab } from './jupyterlab/reset.ts';

const BASE = process.env.JUPYTER_URL ?? 'http://localhost:8888';

/**
 * The camera options: named zoom levels, a camera that travels with the cursor, and a
 * fixed shot. Start the server with `examples/jupyterlab/serve.sh` first.
 */
export default defineScreencast({
  name: 'jupyterlab-camera',
  url: `${BASE}/lab?reset`,
  cursor: { start: { x: 700, y: 560 } },

  async setup({ page }) {
    await resetJupyterLab(page, BASE);
    await page.goto(`${BASE}/lab?reset`);
    await page.locator('.jp-Launcher').waitFor();
    await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
    await page.locator('.jp-DirListing-item', { hasText: 'weather-report.ipynb' }).dblclick();
    await page.locator('.jp-Notebook-ExecutionIndicator[data-status="idle"]').waitFor();
    await page.locator('.jp-OutputArea-output img').first().waitFor();
  },

  async run(cast) {
    const { page } = cast;
    const sidebarTab = (id: string) => page.locator(`.jp-SideBar .lm-TabBar-tab[data-id="${id}"]`);
    const heading = (name: string) =>
      page.locator('#table-of-contents').getByText(name, { exact: true });
    const plot = page.locator('.jp-OutputArea-output img').first();
    const along = (x: number, y: number, hold: number) =>
      cast.hover(plot, { position: { x, y }, hold });

    // Medium level: the camera travels with the cursor across the window.
    await cast.zoom('medium');
    await cast.click(sidebarTab('table-of-contents'));
    await cast.click(heading('Temperature'));
    await cast.hover(page.getByRole('menuitem', { name: 'Settings' }), { hold: 350 });
    await cast.hover(page.locator('.jp-Toolbar-kernelName'), { hold: 500 });
    await along(0.08, 0.8, 400);

    // Close level: the camera stays with the cursor along the curve.
    await cast.zoom('close');
    await along(0.3, 0.42, 350);
    await along(0.55, 0.13, 450);
    await along(0.78, 0.4, 350);
    await along(0.95, 0.7, 600);

    // Fixed shot: the camera does not move while the cursor works inside it.
    await cast.zoomTo({ x: 0, y: 28, width: 800, height: 450 }, { follow: 'off' });
    await cast.click(heading('Rain and sunshine'));
    await cast.wait(700);
    await cast.click(heading('Wind'));
    await cast.wait(700);
    await cast.click(heading('Summary'));
    await cast.wait(900);

    await cast.zoomOut();
  },
});
