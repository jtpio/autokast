# JupyterLab, Notebook and JupyterLite

Verified with JupyterLab 4.6.

## Server

Start a server without a token, on a copy of your files, with clean settings:

```sh
export JUPYTERLAB_SETTINGS_DIR="$(mktemp -d)"   # theme changes stay out of the user settings
export JUPYTERLAB_WORKSPACES_DIR="$(mktemp -d)"
mkdir -p "$JUPYTERLAB_SETTINGS_DIR/@jupyterlab/apputils-extension"
echo '{ "fetchNews": "false", "checkForUpdates": false }' \
  > "$JUPYTERLAB_SETTINGS_DIR/@jupyterlab/apputils-extension/notification.jupyterlab-settings"
jupyter lab --no-browser --port 8888 --IdentityProvider.token='' --ServerApp.root_dir="$WORK"
```

The notification setting removes the "Jupyter news" prompt, which otherwise appears in the
recording. `examples/jupyterlab/serve.sh` in the autocast repository does all of this.

## Start state

- Open `http://localhost:8888/lab?reset`. `?reset` restores the default layout.
- In `setup`, wait for the app:

  ```ts
  await page.locator('.jp-Launcher').waitFor();
  await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
  ```

- Delete files from earlier runs so names such as `Untitled.ipynb` repeat. The contents API
  needs the XSRF cookie:

  ```ts
  const xsrf = (await page.context().cookies()).find((c) => c.name === '_xsrf')?.value ?? '';
  await page.request.delete('http://localhost:8888/api/contents/Untitled.ipynb', {
    headers: { 'X-XSRFToken': xsrf },
    failOnStatusCode: false,
  });
  ```

- A viewport of 1280x720 gives a readable UI in a 1080p video. Use 1440x810 when you need more
  room.

## Locators

| Element                    | Locator                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launcher card, notebook    | `.jp-LauncherCard[data-category="Notebook"]` (use `.first()`)                                                                                                                           |
| Launcher card, console     | `.jp-LauncherCard[data-category="Console"]`                                                                                                                                             |
| Main menu                  | `page.getByRole('menuitem', { name: 'Settings' })`                                                                                                                                      |
| Open menu items            | `.lm-Menu-item` filtered by text; submenus open on hover                                                                                                                                |
| Notebook cells             | `.jp-Notebook .jp-Cell` (`.nth(i)`)                                                                                                                                                     |
| Cell editor                | `.jp-Cell .cm-content`                                                                                                                                                                  |
| Cell output                | `.jp-OutputArea-output`; images `.jp-OutputArea-output img`; tables `.jp-RenderedHTMLCommon table`                                                                                      |
| Notebook toolbar           | `.jp-NotebookPanel-toolbar` buttons by `title` or role                                                                                                                                  |
| Kernel idle                | `.jp-Notebook-ExecutionIndicator[data-status="idle"]`                                                                                                                                   |
| Document tabs              | `.lm-DockPanel-tabBar .lm-TabBar-tab`                                                                                                                                                   |
| Sidebar tabs               | `.jp-SideBar .lm-TabBar-tab[data-id="filebrowser"]`, `"table-of-contents"`, `"jp-running-sessions"`, `"extensionmanager.main-view"`, `"jp-property-inspector"`, `"jp-debugger-sidebar"` |
| File browser items         | `.jp-DirListing-item` filtered by text; double-click opens                                                                                                                              |
| Command palette            | `Control+Shift+C` opens `#modal-command-palette`; items `.lm-CommandPalette-item`                                                                                                       |
| Dialog buttons             | `.jp-Dialog .jp-mod-accept`, `.jp-mod-reject`                                                                                                                                           |
| Table of contents entries  | `page.locator('#table-of-contents').getByText(name, { exact: true })`                                                                                                                   |
| Main area                  | `#jp-main-dock-panel`; split handle `#jp-main-dock-panel > .lm-DockPanel-handle` (filter visible)                                                                                       |
| CSV viewer                 | `.jp-CSVViewer`                                                                                                                                                                         |
| Command palette search box | `#modal-command-palette .lm-CommandPalette-search`                                                                                                                                      |
| Command palette item       | `page.getByRole('menuitemcheckbox', { name: 'Use Theme: JupyterLab Dark', exact: true })`                                                                                               |

## Waits

- JupyterLab: after a new notebook opens, cut until the kernel is ready:
  `await cast.cut(() => page.locator('.jp-Notebook-ExecutionIndicator[data-status="idle"]').waitFor())`.
  In JupyterLite the indicator shows `idle` before the kernel exists, so wait for outputs there.
- A double-click that opens a document shows a blank panel or a spinner first. Pass
  `{ afterClick: 0 }` to the click and cut until the content is there.
- After `Shift+Enter`, cut until the output exists, for example
  `await cast.cut(() => page.locator('.jp-OutputArea-output img').waitFor())`. The idle
  indicator alone can still show the earlier idle state for a moment.
- A new notebook puts the cursor in the first cell, in edit mode. To type into another cell,
  pass `{ into: cells.nth(i).locator('.cm-content') }`.
- The toolbar of the active cell covers the right end of its editor. Click an editor at
  `position: { x: 0.75, y: 0.5 }` or further left.

## Code in cells

- `cast.type` keeps the indentation of multi-line code; the editor's own indentation does not
  double it.
- `Shift+Enter` runs the cell and moves to the next one, which it creates when needed.
- Keep figures small enough for the viewport, for example `figsize=(9, 3.2)` at 1280x720, or
  `cast.scrollTo(output)` before the zoom.
- A trailing `;` on the last line hides the text representation of a plot call.

## Layout

- Side by side: drag a document tab to the right third of the main area, at mid-height:
  `cast.drag(tab, '#jp-main-dock-panel', { toPosition: { x: 0.85, y: 0.5 } })`.
- Collapse a sidebar: click its active tab again.
- Resize a split: drag the split handle.

## Themes and settings

- Dark theme: Settings menu, Theme, `JupyterLab Dark`; or the command palette with the query
  `jupyterlab dark` (the query `dark` alone selects another command first).
- A theme change shows the splash screen for a moment. Cut it:

  ```ts
  await cast.cut(async () => {
    await page.locator('body[data-jp-theme-light="false"]').waitFor({ state: 'attached' });
    await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
  });
  ```

  `body` needs `{ state: 'attached' }`: Playwright does not see it as visible.

- To start in the dark theme without showing the change, apply it in `setup`.
- `?reset` restores the layout only. The theme setting, running kernels and files from an
  earlier run stay. `examples/jupyterlab/reset.ts` in the autocast repository resets them
  through the REST API; copy it.

## Notebook 7

The same server serves Notebook at `/tree`. A notebook opens at `/notebooks/<path>`. Cell and
output locators are the same as in JupyterLab.

## JupyterLite

Verified with jupyterlite-core 0.8 and jupyterlite-pyodide-kernel 0.8.

- Build and serve a site: `jupyter lite build --contents <dir> --output-dir <site>`, then serve
  `<site>` with any static server (`python3 -m http.server --directory <site>`) and open
  `/lab/index.html`. The files in `<dir>` appear at the root of the file browser. The build
  writes a cache file into the current directory, so run it in a temporary directory.
  `examples/jupyterlite/serve.sh` in the autocast repository does this.
- The launcher has a Notebook card and a Console card, both named `Python (Pyodide)`. There is
  no terminal. The locators above apply. No news prompt appears.
- The first kernel start loads Pyodide, and each first import loads its package: several
  seconds each. Wait for the output, not for the idle indicator, and cut the wait.
- Each recording uses a new browser profile with an empty cache. To make the recorded part
  fast and independent of the network, warm the cache in `setup`: open a second tab in the same
  context (`page.context().newPage()`), start a Console there, run the imports the video needs,
  then close the tab.
- Pyodide comes from a CDN. When the browser needs a proxy, pass it in the definition:
  `browser: { launchOptions: { proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } } }`.
- `platform.platform()` returns a string that starts with `Emscripten`, and `sys.platform` is
  `emscripten`: a short way to show that Python runs in the browser.
- The notebook has no empty space after its last cell, so the last cell cannot scroll to the
  center of the panel.
