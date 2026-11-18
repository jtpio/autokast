import { defineScreencast } from '@jtpio/autocast';
import { resetJupyterLab } from './jupyterlab/reset.ts';

const BASE = process.env.JUPYTER_URL ?? 'http://localhost:8888';

/**
 * The optional text overlays: captions on the backdrop and keycaps for shortcuts.
 * Both are off unless a script asks for them. Start the server with
 * `examples/jupyterlab/serve.sh` first.
 */
export default defineScreencast({
  name: 'jupyterlab-overlays',
  url: `${BASE}/lab?reset`,
  render: { keystrokes: { show: 'shortcuts' } },

  async setup({ page }) {
    await resetJupyterLab(page, BASE);
    await page.goto(`${BASE}/lab?reset`);
    await page.locator('.jp-Launcher').waitFor();
    await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
  },

  async run(cast) {
    const { page } = cast;
    const cells = page.locator('.jp-Notebook .jp-Cell');
    const output = page.locator('.jp-OutputArea-output');

    await cast.caption('Start a notebook from the launcher', { label: '01', duration: 4200 });
    await cast.wait(1200);
    await cast.click(page.locator('.jp-LauncherCard[data-category="Notebook"]').first());
    await cast.cut(() =>
      page.locator('.jp-Notebook-ExecutionIndicator[data-status="idle"]').waitFor(),
    );
    await cast.wait(1600);

    await cast.caption('Run a cell with Shift + Enter', { label: '02', duration: 7500 });
    await cast.zoomTo(cells.first(), { scale: 1.5 });
    await cast.type('sum(range(1, 101))');
    await cast.wait(500);
    await cast.press('Shift+Enter');
    await cast.cut(() => output.waitFor());
    await cast.wait(2600);
    await cast.zoomOut();
    await cast.wait(1200);
  },
});
