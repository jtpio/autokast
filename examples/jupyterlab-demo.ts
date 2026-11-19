import { defineScreencast } from 'autokast';
import { resetJupyterLab } from './jupyterlab/reset.ts';

const BASE = process.env.JUPYTER_URL ?? 'http://localhost:8888';

const LOAD = `import pandas as pd

df = pd.read_csv("data/weather.csv", parse_dates=["date"])
df.head()`;

const PLOT = `df.plot(x="date", y="temp_max", figsize=(9, 3));`;

/**
 * JupyterLab in less than a minute, with a caption for each part: a notebook, the table
 * of contents, documents side by side and the command palette. This is the video of the
 * README. Start the server with `examples/jupyterlab/serve.sh` first.
 */
export default defineScreencast({
  name: 'jupyterlab-demo',
  url: `${BASE}/lab?reset`,
  typing: { delay: 30 },
  render: { keystrokes: { show: 'shortcuts' } },

  async setup({ page }) {
    await resetJupyterLab(page, BASE);
    await page.goto(`${BASE}/lab?reset`);
    await page.locator('.jp-Launcher').waitFor();
    await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
  },

  async run(cast) {
    const { page } = cast;
    const idle = page.locator('.jp-Notebook-ExecutionIndicator[data-status="idle"]');
    const cells = page.locator('.jp-Notebook .jp-Cell');
    const sidebar = (id: string) => page.locator(`.jp-SideBar .lm-TabBar-tab[data-id="${id}"]`);
    const file = (name: string) => page.locator('.jp-DirListing-item', { hasText: name });
    const tab = (name: string) =>
      page.locator('.lm-DockPanel-tabBar .lm-TabBar-tab', { hasText: name });
    const heading = (name: string) =>
      page.locator('#table-of-contents').getByText(name, { exact: true });
    // Each caption stays until the next one replaces it.
    const caption = (text: string) => cast.caption(text, { duration: 20_000 });

    await caption('Write code in a **notebook** and see the result below it');
    await cast.click(page.locator('.jp-LauncherCard[data-category="Notebook"]').first(), {
      afterClick: 0,
    });
    await cast.cut(() => idle.waitFor());
    await cast.zoomTo(cells.first(), { level: 'medium' });
    await cast.type(LOAD, { into: cells.first().locator('.cm-content') });
    await cast.press('Shift+Enter');
    await cast.cut(() => page.locator('.jp-RenderedHTMLCommon table').waitFor());
    await cast.zoomTo(cells.first(), { padding: 24 });
    await cast.wait(1600);
    await cast.zoomTo(cells.nth(1), { level: 'medium' });
    await cast.type(PLOT);
    await cast.press('Shift+Enter');
    const plot = page.locator('.jp-OutputArea-output img').first();
    await cast.cut(() => plot.waitFor());
    await cast.zoomTo(plot, { padding: 36 });
    await cast.hover(plot, { position: { x: 0.56, y: 0.3 }, hold: 1600 });

    await caption('Jump to a section with the **table of contents**');
    await cast.zoomOut();
    await cast.dblclick(file('weather-report.ipynb'), { afterClick: 0 });
    await cast.cut(() => page.locator('.jp-Notebook h1', { hasText: 'Weather report' }).waitFor());
    await cast.click(sidebar('table-of-contents'));
    await cast.zoomTo({ x: 0, y: 28, width: 860, height: 423 }, { padding: 0 });
    await cast.click(heading('Rain and sunshine'));
    await cast.wait(1400);
    await cast.click(heading('Wind'));
    await cast.wait(1200);
    // Back to the top: a notebook that is scrolled down can be empty in the split view.
    await cast.click(heading('Weather report 2025'));
    await cast.wait(700);

    await caption('Arrange documents **side by side**');
    await cast.zoomOut();
    await cast.click(sidebar('filebrowser'));
    await cast.dblclick(file('data'));
    await cast.dblclick(file('weather.csv'), { afterClick: 0 });
    await cast.cut(async () => {
      await page.locator('.jp-CSVViewer').waitFor();
      await page.locator('.jp-Spinner').waitFor({ state: 'detached' });
    });
    // A closed sidebar gives the two documents more room.
    await cast.click(sidebar('filebrowser'));
    await cast.drag(tab('weather.csv'), '#jp-main-dock-panel', {
      toPosition: { x: 0.85, y: 0.5 },
    });
    await cast.wait(1800);

    await caption('Find every command in the **command palette**');
    await cast.zoomOut({ wait: true });
    await cast.press('Control+Shift+C');
    await cast.moveTo(page.locator('#modal-command-palette .lm-CommandPalette-search'));
    await cast.zoomTo({ x: 320, y: 28, width: 640, height: 315 }, { padding: 0 });
    await cast.type('jupyterlab dark');
    await cast.wait(400);
    await cast.click(
      page.getByRole('menuitemcheckbox', { name: 'Use Theme: JupyterLab Dark', exact: true }),
    );
    // A theme change shows the splash screen until the new theme is loaded.
    await cast.cut(async () => {
      await page.locator('body[data-jp-theme-light="false"]').waitFor({ state: 'attached' });
      await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
      await page.waitForTimeout(300);
    });
    await cast.zoomOut({ wait: false });
    await cast.moveTo({ x: 940, y: 560 });
    await cast.wait(2400);
  },
});
