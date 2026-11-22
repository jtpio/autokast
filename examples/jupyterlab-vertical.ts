import { defineScreencast } from 'autokast';
import { resetJupyterLab } from './jupyterlab/reset.ts';

const BASE = process.env.JUPYTER_URL ?? 'http://localhost:8888';

const IMPORT = `import pandas as pd

`;

const LOAD = `df = pd.read_csv("data/weather.csv",
                 parse_dates=["date"])
df.head()`;

const PLOT = `df.plot("date", "temp_max", figsize=(6, 4));`;

/**
 * JupyterLab as a vertical video with animated subtitles, for the platforms that show
 * short videos on a phone. Start the server with `examples/jupyterlab/serve.sh` first.
 * Render with `--voice` for a voice that says the subtitles: the captions are a
 * narration with one sentence for each action, and the waits give each sentence the
 * time to end before the next one starts.
 */
export default defineScreencast({
  name: 'jupyterlab-vertical',
  url: `${BASE}/lab?reset`,
  vertical: true,
  typing: { delay: 30 },
  render: {
    captions: { style: 'subtitles' },
    keystrokes: { show: 'shortcuts', size: 1.5 },
  },

  async setup({ page }) {
    await resetJupyterLab(page, BASE);
    await page.goto(`${BASE}/lab?reset`);
    await page.locator('.jp-Launcher').waitFor();
    await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
    // The file browser takes a third of a narrow window.
    await page.locator('.jp-SideBar .lm-TabBar-tab[data-id="filebrowser"]').click();
    await page.locator('#filebrowser').waitFor({ state: 'hidden' });
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
    // The left part of a cell, where the code is: a narrow target gives a closer shot.
    const code = async (index: number, width: number) => {
      const box = (await cells.nth(index).boundingBox())!;
      return { x: box.x, y: box.y, width, height: box.height };
    };

    await cast.caption("Let's write some code in a JupyterLab notebook.");
    await cast.click(page.locator('.jp-LauncherCard[data-category="Notebook"]').first(), {
      afterClick: 0,
    });
    await cast.cut(() => idle.waitFor());
    await cast.zoomTo(await code(0, 430), { padding: 12 });
    await cast.type(IMPORT, { into: cells.first().locator('.cm-content') });

    await cast.caption('First, we load a year of weather data with pandas.');
    await cast.type(LOAD);
    await cast.wait(700);

    await cast.caption('Press Shift Enter to run it, and the table shows up right below.');
    await cast.wait(900);
    await cast.press('Shift+Enter');
    await cast.cut(() => page.locator('.jp-RenderedHTMLCommon table').waitFor());
    await cast.zoomTo(await code(0, 560), { padding: 12 });
    await cast.wait(2700);

    await cast.caption('One more line turns that data into a chart.');
    await cast.zoomTo(await code(1, 430), { padding: 12 });
    await cast.type(PLOT);
    await cast.wait(500);
    await cast.press('Shift+Enter');
    const plot = page.locator('.jp-OutputArea-output img').first();
    await cast.cut(() => plot.waitFor());

    await cast.caption('And there it is: the temperature for the whole year.');
    await cast.zoomTo(plot, { padding: 24 });
    await cast.hover(plot, { position: { x: 0.56, y: 0.3 }, hold: 2600 });

    await cast.caption('Long notebook? Open the table of contents.');
    await cast.zoomOut();
    await cast.click(sidebar('filebrowser'));
    await cast.dblclick(file('weather-report.ipynb'), { afterClick: 0 });
    await cast.cut(() => page.locator('.jp-Notebook h1', { hasText: 'Weather report' }).waitFor());
    await cast.click(sidebar('table-of-contents'));
    await cast.wait(300);

    await cast.caption('Click any heading, and you jump straight to that section.');
    await cast.zoomTo({ x: 0, y: 28, width: 600, height: 620 }, { padding: 0 });
    await cast.click(heading('Rain and sunshine'));
    await cast.wait(1200);
    await cast.click(heading('Wind'));
    await cast.wait(500);

    await cast.caption('Then back to the top.');
    await cast.click(heading('Weather report 2025'));
    await cast.wait(1300);

    await cast.caption('Need two notebooks at once? Drag a tab down to split the screen.');
    await cast.zoomOut();
    await cast.click(sidebar('table-of-contents'));
    await cast.drag(tab('Untitled.ipynb'), '#jp-main-dock-panel', {
      toPosition: { x: 0.5, y: 0.85 },
    });
    await cast.wait(900);

    await cast.caption('The command palette finds any command. Like the dark theme.');
    await cast.press('Control+Shift+C');
    const search = page.locator('#modal-command-palette .lm-CommandPalette-search');
    await cast.moveTo(search);
    // The list is long until the text of the search makes it short.
    const palette = (await page.locator('#modal-command-palette').boundingBox())!;
    await cast.zoomTo({ ...palette, height: 300 }, { padding: 60 });
    await cast.wait(600);
    await cast.type('jupyterlab dark');
    await cast.wait(1200);
    await cast.click(
      page.getByRole('menuitemcheckbox', { name: 'Use Theme: JupyterLab Dark', exact: true }),
      { afterClick: 0 },
    );
    // A theme change shows the splash screen until the new theme is loaded.
    await cast.cut(async () => {
      await page.locator('body[data-jp-theme-light="false"]').waitFor({ state: 'attached' });
      await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
      await page.waitForTimeout(300);
    });

    await cast.caption('And just like that, JupyterLab is yours.');
    await cast.zoomOut({ wait: false });
    await cast.moveTo({ x: 640, y: 905 });
    await cast.wait(1900);
  },
});
