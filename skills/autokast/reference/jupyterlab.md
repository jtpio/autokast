# JupyterLab, Notebook and JupyterLite

Setup and known problems only. Find the locators when you explore the app, as for any other
app.

Verified with JupyterLab 4.6 and JupyterLite 0.9.

## Server and start state

Start a server without a token, on a copy of your files, with clean settings:

```sh
export JUPYTERLAB_SETTINGS_DIR="$(mktemp -d)"   # theme changes stay out of the user settings
export JUPYTERLAB_WORKSPACES_DIR="$(mktemp -d)"
mkdir -p "$JUPYTERLAB_SETTINGS_DIR/@jupyterlab/apputils-extension"
echo '{ "fetchNews": "false", "checkForUpdates": false }' \
  > "$JUPYTERLAB_SETTINGS_DIR/@jupyterlab/apputils-extension/notification.jupyterlab-settings"
jupyter lab --no-browser --port 8888 --IdentityProvider.token='' --ServerApp.root_dir="$WORK"
```

- The notification setting removes the "Jupyter news" prompt, which otherwise appears in the
  recording.
- Open `http://localhost:8888/lab?reset`, and wait for the app in `setup`:

  ```ts
  await page.locator('.jp-Launcher').waitFor();
  await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
  ```

- `?reset` restores the layout only. The theme, the running kernels and the files from an
  earlier run stay, so names such as `Untitled.ipynb` do not repeat. Reset them through the
  REST API in `setup`. The API needs the XSRF cookie:

  ```ts
  const xsrf = (await page.context().cookies()).find((c) => c.name === '_xsrf')?.value ?? '';
  await page.request.delete('http://localhost:8888/api/contents/Untitled.ipynb', {
    headers: { 'X-XSRFToken': xsrf },
    failOnStatusCode: false,
  });
  ```

- `examples/jupyterlab/serve.sh` and `examples/jupyterlab/reset.ts` in the autokast repository
  do all of this; copy them.
- The same server serves Notebook at `/tree`. A notebook opens at `/notebooks/<path>`.

## Known problems

- **Kernel start.** After a new notebook opens, cut until the kernel is ready:
  `await cast.cut(() => page.locator('.jp-Notebook-ExecutionIndicator[data-status="idle"]').waitFor())`.
- **Cell output.** After `Shift+Enter`, cut until the output exists, for example
  `page.locator('.jp-OutputArea-output img').waitFor()`. The idle indicator can still show
  the earlier idle state for a moment.
- **A document that opens** shows a blank panel or a spinner first. Pass `{ afterClick: 0 }`
  to the click, then cut until the content is there and `.jp-Spinner` is detached.
- **Cell toolbar.** The toolbar of the active cell covers the right end of its editor. Click
  an editor at `position: { x: 0.75, y: 0.5 }` or further left.
- **Figures.** Keep them small enough for the viewport, for example `figsize=(9, 3.2)` at
  1280x720. A trailing `;` on the last line hides the text representation of a plot call.
- **Theme change.** It shows the splash screen for a moment. Cut it:

  ```ts
  await cast.cut(async () => {
    await page.locator('body[data-jp-theme-light="false"]').waitFor({ state: 'attached' });
    await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
  });
  ```

  `body` needs `{ state: 'attached' }`: Playwright does not see it as visible. In the command
  palette, use the query `jupyterlab dark`: the query `dark` alone selects another command.

- **Split view.** Drag a document tab to the right third of the main area:
  `cast.drag(tab, '#jp-main-dock-panel', { toPosition: { x: 0.85, y: 0.5 } })`. Close the
  sidebar first (click its active tab): in a narrow panel, the notebook toolbar wraps over
  the content.
- **Empty notebook.** A notebook that is scrolled down and then hidden behind another tab can
  be empty when it shows again in a split view. Scroll it to the top first.

## JupyterLite

- Build and serve a site: `jupyter lite build --contents <dir> --output-dir <site>`, then serve
  `<site>` with any static server and open `/lab/index.html`. The build writes a cache file
  into the current directory, so run it in a temporary directory. `--contents` needs
  `jupyter-server` in the same environment. `examples/jupyterlite/serve.sh` in the autokast
  repository does this.
- The kernel indicator shows `idle` before the kernel exists. Wait for the output, not for
  the indicator.
- The first kernel start loads Pyodide, and each first import loads its package: several
  seconds each. Cut these waits.
- Each recording uses a new browser profile with an empty cache. To make the recorded part
  fast, warm the cache in `setup` on the same page: start a Console from the launcher, run
  the imports the video needs, wait for the output, then load `/lab/index.html?reset` again.
- Pyodide comes from a CDN. When the browser needs a proxy, pass it in the definition:
  `browser: { launchOptions: { proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } } }`.
- The notebook has no empty space after its last cell, so the last cell cannot scroll to the
  center of the panel.
