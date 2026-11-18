import { defineScreencast } from 'autocast';

const server = process.env.JUPYTER_URL ?? 'http://localhost:8888';

/**
 * A tour of the JupyterLab interface: table of contents, side-by-side
 * documents, sidebars, command palette and dark theme.
 * Start the server with `examples/jupyterlab/serve.sh` first; set `JUPYTER_URL`
 * when it does not run on port 8888.
 */
export default defineScreencast({
  name: 'jupyterlab-tour',
  url: `${server}/lab?reset`,

  async setup({ page }) {
    const ready = async () => {
      await page.locator('.jp-Launcher').waitFor();
      await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
    };
    await ready();

    // `?reset` restores the layout, but not the theme setting or a running kernel.
    const xsrf = (await page.context().cookies()).find((c) => c.name === '_xsrf')?.value ?? '';
    const headers = { 'X-XSRFToken': xsrf };
    await page.request.put(`${server}/lab/api/settings/@jupyterlab/apputils-extension:themes`, {
      headers,
      data: { raw: '{}' },
    });
    const sessions: { id: string }[] = await (
      await page.request.get(`${server}/api/sessions`)
    ).json();
    for (const { id } of sessions) {
      await page.request.delete(`${server}/api/sessions/${id}`, { headers });
    }
    await page.goto(`${server}/lab?reset`);
    await ready();
  },

  async run(cast) {
    const { page } = cast;
    const sidebarTab = (id: string) => page.locator(`.jp-SideBar .lm-TabBar-tab[data-id="${id}"]`);
    const file = (name: string) => page.locator('.jp-DirListing-item', { hasText: name });
    const heading = (name: string) =>
      page.locator('#table-of-contents').getByText(name, { exact: true });

    await cast.wait(1500);
    await cast.dblclick(file('weather-report.ipynb'));
    await cast.cut(() =>
      page.locator('.jp-Notebook-ExecutionIndicator[data-status="idle"]').waitFor(),
    );
    await cast.wait(2500);
    await cast.scroll({ y: 600 }, { at: page.locator('.jp-NotebookPanel-notebook') });
    await cast.wait(2000);

    await cast.click(sidebarTab('table-of-contents'));
    await cast.zoomTo({ x: 0, y: 28, width: 720, height: 405 }, { scale: 1.6 });
    await cast.click(heading('Rain and sunshine'));
    await cast.wait(3000);
    await cast.click(heading('Temperature'));
    await cast.wait(3000);
    await cast.zoomOut();
    await cast.wait(1000);

    await cast.click(sidebarTab('filebrowser'));
    await cast.dblclick(file('data'));
    await cast.dblclick(file('weather.csv'));
    await cast.cut(() => page.locator('.jp-CSVViewer').waitFor());
    const csvTab = page.locator('.lm-DockPanel-tabBar .lm-TabBar-tab', { hasText: 'weather.csv' });
    await cast.moveTo(csvTab);
    await cast.wait(2000);
    const dock = (await page.locator('#jp-main-dock-panel').boundingBox())!;
    await cast.drag(csvTab, { x: dock.x + dock.width * 0.85, y: dock.y + dock.height * 0.5 });
    await cast.wait(3500);

    await cast.click(sidebarTab('filebrowser'));
    await cast.wait(2000);
    const handle = page
      .locator('#jp-main-dock-panel > .lm-DockPanel-handle')
      .filter({ visible: true });
    const { y, height } = (await handle.boundingBox())!;
    await cast.drag(handle, { x: 790, y: y + height / 2 });
    await cast.wait(3000);

    await cast.press('Control+Shift+C');
    // The zoomed camera follows the cursor, so bring the cursor into the shot first.
    await cast.moveTo(page.locator('#modal-command-palette .lm-CommandPalette-search'));
    await cast.zoomTo({ x: 320, y: 28, width: 640, height: 360 }, { scale: 1.8 });
    await cast.type('jupyterlab dark');
    await cast.wait(1500);
    await cast.click(
      page.getByRole('menuitemcheckbox', { name: 'Use Theme: JupyterLab Dark', exact: true }),
    );
    // A theme change shows the splash screen until the new theme is loaded. Captured frames
    // can lag the page, so the cut also keeps the last frames of its fade-out.
    await cast.cut(async () => {
      await page.locator('body[data-jp-theme-light="false"]').waitFor({ state: 'attached' });
      await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
      await page.waitForTimeout(300);
    });
    await cast.zoomOut({ wait: false });
    // Leaving the toolbar button repaints the page, so the capture gets a frame without the splash.
    await cast.moveTo({ x: 120, y: 560 });
    await cast.wait(4500);
  },
});
