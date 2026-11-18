import { defineScreencast } from 'autocast';

const LOAD = `import pandas as pd

df = pd.read_csv("data/weather.csv", parse_dates=["date"])
df.head()`;

const PLOT = `monthly = df.resample("ME", on="date").mean()
ax = monthly[["temp_min", "temp_max"]].plot(figsize=(9, 3.2), marker="o")
ax.set_title("Monthly temperature");`;

/**
 * A first data analysis in a new JupyterLab notebook.
 * Start the server with `examples/jupyterlab/serve.sh` first.
 */
export default defineScreencast({
  name: 'jupyterlab-notebook',
  url: 'http://localhost:8888/lab?reset',

  async setup({ page }) {
    await page.locator('.jp-Launcher').waitFor();
    await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
  },

  async run(cast) {
    const { page } = cast;
    const idle = page.locator('.jp-Notebook-ExecutionIndicator[data-status="idle"]');
    const cells = page.locator('.jp-Notebook .jp-Cell');

    await cast.click(page.locator('.jp-LauncherCard[data-category="Notebook"]').first());
    await cast.cut(() => idle.waitFor());

    await cast.zoomTo(cells.first(), { scale: 1.5 });
    await cast.type(LOAD, { into: cells.first().locator('.cm-content') });
    await cast.press('Shift+Enter');
    await cast.cut(() => page.locator('.jp-RenderedHTMLCommon table').waitFor());
    await cast.wait(600);
    await cast.zoomTo(page.locator('.jp-OutputArea-output').first(), { padding: 60 });
    await cast.wait(2200);

    await cast.zoomTo(cells.nth(1), { scale: 1.5 });
    await cast.type(PLOT);
    await cast.press('Shift+Enter');
    const plot = page.locator('.jp-OutputArea-output img');
    await cast.cut(() => plot.waitFor());
    await cast.zoomOut();
    await cast.scroll({ y: 320 }, { at: cells.nth(1) });
    await cast.zoomTo(plot, { padding: 30 });
    await cast.wait(2500);
    await cast.zoomOut();
    await cast.wait(800);
  },
});
