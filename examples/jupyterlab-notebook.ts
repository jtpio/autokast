import { defineScreencast } from 'autocast';
import { resetJupyterLab } from './jupyterlab/reset.ts';

const BASE = process.env.JUPYTER_URL ?? 'http://localhost:8888';

const LOAD = `import pandas as pd

df = pd.read_csv("data/weather.csv", parse_dates=["date"])
df.head()`;

const PLOT = `monthly = df.resample("ME", on="date").mean()
ax = monthly[["temp_min", "temp_max"]].plot(figsize=(9, 3.2), marker="o")
ax.set_title("Monthly temperature");`;

const RAIN = `rain = df.groupby(df["date"].dt.month_name(), sort=False)["rain_mm"].sum()
rain.plot.bar(figsize=(9, 3), color="#4c78a8", title="Rain per month (mm)");`;

/**
 * A first data analysis in a new JupyterLab notebook: load a CSV file, plot it,
 * give the notebook a name. Start the server with `examples/jupyterlab/serve.sh` first.
 */
export default defineScreencast({
  name: 'jupyterlab-notebook',
  url: `${BASE}/lab?reset`,
  typing: { delay: 45 },

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
    const table = page.locator('.jp-RenderedHTMLCommon table');
    const plots = page.locator('.jp-OutputArea-output img');

    await cast.wait(400);
    await cast.click(page.locator('.jp-LauncherCard[data-category="Notebook"]').first());
    await cast.cut(() => idle.waitFor());
    await cast.wait(500);

    await cast.zoomTo(cells.first(), { scale: 1.5 });
    await cast.type(LOAD, { into: cells.first().locator('.cm-content') });
    await cast.wait(300);
    await cast.press('Shift+Enter');
    await cast.cut(() => table.waitFor());
    await cast.wait(500);
    await cast.zoomTo(cells.first(), { padding: 24 });
    await cast.wait(2400);

    await cast.zoomTo(cells.nth(1), { scale: 1.5 });
    await cast.type(PLOT);
    await cast.wait(300);
    await cast.press('Shift+Enter');
    await cast.cut(() => plots.first().waitFor());
    await cast.zoomOut();
    await cast.scrollTo(plots.first());
    await cast.zoomTo(plots.first(), { padding: 36 });
    await cast.hover(plots.first(), { position: { x: 0.56, y: 0.2 }, hold: 2000 });

    await cast.zoomOut();
    await cast.scrollTo(cells.nth(2));
    await cast.zoomTo(cells.nth(2), { scale: 1.5 });
    await cast.type(RAIN, { into: cells.nth(2).locator('.cm-content') });
    await cast.wait(300);
    await cast.press('Shift+Enter');
    await cast.cut(() => plots.nth(1).waitFor());
    await cast.zoomOut();
    await cast.scrollTo(plots.nth(1));
    await cast.zoomTo(plots.nth(1), { padding: 36 });
    await cast.hover(plots.nth(1), { position: { x: 0.5, y: 0.3 }, hold: 2000 });

    await cast.zoomOut();
    const tab = page.locator('.lm-DockPanel-tabBar .lm-TabBar-tab.lm-mod-current');
    const dialog = page.locator('.jp-Dialog-content');
    await cast.rightClick(tab);
    await cast.wait(400);
    await cast.click(page.locator('.lm-Menu-item', { hasText: 'Rename Notebook' }));
    await cast.moveTo(dialog.locator('input'), { position: { x: 0.8, y: 0.5 } });
    await cast.zoomTo(dialog, { padding: 90 });
    await cast.type('weather-analysis');
    await cast.click(dialog.getByRole('button', { name: 'Rename' }));
    await cast.cut(() => tab.filter({ hasText: 'weather-analysis' }).waitFor());
    await cast.wait(300);
    await cast.zoomTo({ x: 0, y: 0, width: 660, height: 300 }, { follow: false });
    await cast.hover(page.locator('.jp-DirListing-item', { hasText: 'weather-analysis' }), {
      hold: 1800,
    });
    await cast.zoomOut();
    await cast.wait(1000);
  },
});
