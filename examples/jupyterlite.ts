import { defineScreencast } from 'autocast';

const SITE = process.env.JUPYTERLITE_URL ?? 'http://localhost:8000';
const PROXY = process.env.HTTPS_PROXY;
const KERNEL = { timeout: 120_000 };

const PLATFORM = `import platform
platform.platform()`;

const LOAD = `import pandas as pd

df = pd.read_csv("data/weather.csv", parse_dates=["date"])
df.head()`;

const PLOT = `import matplotlib.pyplot as plt

plt.figure(figsize=(9, 3.2))
plt.scatter(df["sun_hours"], df["temp_max"], c=df["date"].dt.month, cmap="twilight", s=14)
plt.xlabel("Sun hours")
plt.ylabel("Max temperature");`;

/**
 * Python in a browser tab: a JupyterLite notebook on the Pyodide kernel, no server.
 * Start the site with `examples/jupyterlite/serve.sh` first.
 */
export default defineScreencast({
  name: 'jupyterlite',
  url: `${SITE}/lab/index.html`,
  typing: { delay: 30 },
  browser: PROXY
    ? { launchOptions: { proxy: { server: PROXY, bypass: 'localhost,127.0.0.1' } } }
    : undefined,

  async setup({ page }) {
    const ready = async () => {
      await page.locator('.jp-Launcher').waitFor();
      await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
    };
    await ready();

    // Download Pyodide and the packages once, so that the recording does not wait on the
    // network. A console creates no file, and the reset closes it.
    await page.locator('.jp-LauncherCard[data-category="Console"]').click();
    await page.locator('.jp-CodeConsole-input .cm-content').click();
    await page.keyboard.type('import pandas, matplotlib.pyplot; print("ready")');
    await page.keyboard.press('Shift+Enter');
    await page.locator('.jp-OutputArea-output', { hasText: 'ready' }).waitFor(KERNEL);
    await page.goto(`${SITE}/lab/index.html?reset`);
    await ready();
  },

  async run(cast) {
    const { page } = cast;
    const card = page.locator('.jp-LauncherCard[data-category="Notebook"]');
    const files = page.locator('.jp-DirListing-item');
    const cells = page.locator('.jp-Notebook .jp-Cell');
    const editor = (i: number) => cells.nth(i).locator('.cm-content');
    const output = (i: number) => cells.nth(i).locator('.jp-OutputArea-output');
    // Clicks land left of the cell toolbar, which covers the right end of the active editor.
    // On the launcher card, the cursor stays off the kernel name.
    const aside = { position: { x: 0.75, y: 0.5 } };
    const label = { position: { x: 0.5, y: 0.3 } };

    await cast.zoomTo(card, { scale: 1.8 });
    await cast.hover(card, { ...label, hold: 700 });
    await cast.click(card, label);
    await cast.cut(() => editor(0).waitFor());
    await cast.zoomOut();

    // The camera follows the cursor while zoomed, so park it inside the notebook views below.
    // The new notebook already has the focus in cell 1.
    await cast.moveTo(page.locator('.jp-Notebook'), { position: { x: 0.75, y: 0.35 } });

    // At scale 1.55 the view is as wide as the notebook panel. `top` starts at the tab bar,
    // `bottom` ends at the bottom of the panel.
    const box = (await page.locator('.jp-NotebookPanel').boundingBox())!;
    const top = { x: box.x + box.width / 2, y: box.y + 240 };
    const bottom = { x: top.x, y: box.y + box.height - 268 };
    const notebook = { scale: 1.55 };

    // The kernel starts while cell 1 is typed; the cut hides the rest of the start.
    await cast.zoomTo(top, notebook);
    await cast.type(PLATFORM);
    await cast.press('Shift+Enter');
    await cast.cut(() => output(0).waitFor(KERNEL));
    await cast.wait(1600);

    await cast.zoomOut();
    await cast.dblclick(files.filter({ hasText: 'data' }));
    await cast.cut(() => files.filter({ hasText: 'weather.csv' }).waitFor());
    await cast.wait(900);

    await cast.click(editor(1), aside);
    await cast.zoomTo(top, notebook);
    await cast.type(LOAD);
    await cast.press('Shift+Enter');
    await cast.cut(() => output(1).locator('table').waitFor(KERNEL));
    await cast.wait(1600);

    await cast.click(editor(2), aside);
    await cast.zoomTo(bottom, notebook);
    await cast.type(PLOT);
    await cast.press('Shift+Enter');
    const plot = output(2).locator('img');
    await cast.cut(() => plot.waitFor(KERNEL));
    await cast.scrollTo(cells.nth(2), { block: 'end' });
    // Point at the sunny, warm days of summer.
    await cast.hover(plot, { position: { x: 0.8, y: 0.25 }, hold: 1800 });
    await cast.zoomOut();
    await cast.wait(700);
  },
});
