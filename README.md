# autocast

Automated, polished screencasts of web apps. Built for agents.

`autocast` drives a web app with Playwright and produces a video that looks edited by hand:
a large, smooth cursor, click effects, eased zooms that follow the action, a framed window on a
soft backdrop. There is no editor. A script says what happens on the page and where the camera
looks; the library does the rest.

It works with anything that opens in a browser. It was made with JupyterLab and JupyterLite in
mind.

```ts
import { defineScreencast } from 'autocast';

export default defineScreencast({
  name: 'first-notebook',
  url: 'http://localhost:8888/lab?reset',

  async setup({ page }) {
    await page.locator('.jp-Launcher').waitFor();
  },

  async run(cast) {
    const { page } = cast;
    await cast.click(page.locator('.jp-LauncherCard[data-category="Notebook"]').first());
    await cast.zoomTo(page.locator('.jp-Cell').first(), { scale: 1.5 });
    await cast.type('print("Hello")');
    await cast.press('Shift+Enter');
    await cast.wait(1500);
    await cast.zoomOut();
  },
});
```

```sh
autocast record first-notebook.ts
```

## How it works

```
script ──▶ record ──▶ session ──▶ render ──▶ video
           Playwright   frames +   camera, cursor,   mp4 / webm / gif
           + CDP        timeline   frame, backdrop
```

1. **Record.** Headless Chromium runs the script. The page is captured at twice the viewport
   resolution through the Chrome DevTools Protocol, in real time or frame by frame. No cursor
   is in the capture. Every cursor position, click, key, zoom and cut goes to a timeline.
2. **Session.** The result is a directory with `session.json` and the frames. It is plain data,
   so a session can be rendered again with other settings without a new recording.
3. **Render.** For each output frame the renderer composes the backdrop, the framed page, the
   camera move, a vector cursor and the click effects, then sends the frame to ffmpeg.

## Requirements

- Node.js 22.18 or later
- Playwright with Chromium (`npm install playwright && npx playwright install chromium`)
- `ffmpeg` on the `PATH` (or `AUTOCAST_FFMPEG`)

## Install

```sh
npm install github:jtpio/autocast
```

From a clone: `npm install && npm run build`, then use `node dist/cli.js` or `npm link`.

## Command line

```sh
autocast record <script>           # record, then render
autocast render <session>          # render a session again
autocast frame <session> --at 12   # one still frame, at 12 s of output time
autocast inspect <session|video>   # print the timeline, write a contact sheet
```

| Option              | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `-o, --out <file>`  | Output file. The extension selects `.mp4`, `.webm` or `.gif`.     |
| `--preview`         | Fast render: half size, 30 fps, draft quality.                    |
| `--size <WxH>`      | Output size, for example `3840x2160` or `1080x1920`.              |
| `--fps <n>`         | Output frame rate, 24 to 120.                                     |
| `--background <b>`  | Backdrop preset or CSS color.                                     |
| `--range <a:b>`     | Render only this part, in seconds of output time.                 |
| `--config <file>`   | JSON file with render options.                                    |
| `--set <key=value>` | Set any option by path, for example `--set zoom.maxScale=2.5`.    |
| `--session <dir>`   | `record`: where to store the session. Default `.autocast/<name>`. |
| `--no-render`       | `record`: record only.                                            |
| `--headed`          | `record`: show the browser window.                                |

`inspect` is how an agent reviews its work without a video player. It prints each action with
its time and writes a grid of stills:

```sh
autocast inspect .autocast/first-notebook -o sheet.png
autocast inspect .autocast/first-notebook --from 10 --to 14 --every 0.25 -o zoom.png
```

## The Cast API

`run(cast)` receives the director. Every call acts on the page in real time and adds to the
timeline. A target is a Playwright locator, a selector string, a point `{ x, y }` or a rectangle
`{ x, y, width, height }` in viewport pixels.

| Call                                           | Effect                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| `click(target)`, `dblclick`, `rightClick`      | Moves the cursor along a natural path, then presses.      |
| `moveTo(target)`, `hover(target, { hold })`    | Moves the cursor.                                         |
| `drag(from, to)`                               | Presses on `from`, moves to `to`, releases.               |
| `scroll({ y }, { at })`, `scrollTo(target)`    | Smooth wheel scroll.                                      |
| `type(text, { into, delay })`                  | Types with a human rhythm. Keeps the indentation of code. |
| `press('Shift+Enter')`                         | Presses a key combination.                                |
| `zoomTo(target, { scale, padding, duration })` | Moves the camera to a target.                             |
| `zoomOut()`                                    | Returns to the full view.                                 |
| `wait(ms)`                                     | Holds the shot.                                           |
| `cut(fn)`                                      | Runs `fn` and removes that time from the video.           |
| `speed(rate, fn)`                              | Runs `fn` and plays that time faster.                     |
| `spotlight(target, { duration })`              | Dims everything except the target.                        |
| `caption(text, { label, duration })`           | Shows a caption below the stage.                          |
| `marker(label)`                                | Names a point in time.                                    |
| `page`                                         | The Playwright page, for waits and assertions.            |

Use `cast.page` to wait and to read state. Do not use it to click or to type: the cursor in the
video would not follow.

## Options

Record options are fields of the screencast definition. Render options go under `render`, and
every one can be overridden when a session is rendered again.

```ts
export default defineScreencast({
  name: 'demo',
  url: 'http://localhost:3000',
  viewport: { width: 1280, height: 720 }, // CSS pixels; a smaller viewport gives a larger UI
  deviceScaleFactor: 2, // capture scale; 3 keeps deep zooms and 4K output sharp
  colorScheme: 'dark',
  capture: { mode: 'realtime' }, // or 'frame-perfect' for final recordings
  cursor: { speed: 1, curvature: 0.2 },
  typing: { delay: 45, variance: 0.35 },
  pacing: { startDelay: 400, endDelay: 900, afterClick: 180 },

  render: {
    size: { width: 1920, height: 1080 },
    fps: 60,
    background: 'dusk', // paper, fog, sage, dune, clay, dusk, harbor, graphite, ink, ember
    frame: { padding: 0.07, radius: 16, chrome: 'none' },
    cursor: { size: 1.6, smoothing: 0.3, click: { type: 'ripple' } },
    zoom: { mode: 'camera', easing: 'smooth', duration: 900, followCursor: true, auto: false },
    encode: { quality: 'standard' }, // draft, standard, high, max
  },

  async run(cast) {},
});
```

Notes on the options that change the look most:

- **`render.size`, `render.fps`, `render.encode`** set the resolution, the frame rate and the
  quality. `encode.crf`, `encode.preset` and `encode.pixelFormat` give full control of x264.
- **`capture.mode`**: `realtime` (default) records at the speed of the video.
  `frame-perfect` controls the page clock and captures one frame for each 1/60 s of page time,
  so scrolls, drags and animations are exact on any machine; the recording takes 3 to 4 times
  longer. Use it for final recordings: `autocast record script.ts --set capture.mode=frame-perfect`.
- **`render.zoom.mode`**: `camera` scales the full window past the edges of the video, like a
  camera that moves closer. `crop` zooms inside a fixed window.
- **`render.zoom.auto`** adds zooms on clicks and typing when the script has none.
- **`render.frame.chrome: 'window'`** adds a title bar.
- **`render.cursor.motionBlur`** and **`render.zoom.motionBlur`** (0 to 1) add motion blur.
- Pixel values are for a 1080-pixel output and scale with the output size, so a preview looks
  like the final render.

The full list with types is in [`src/types.ts`](src/types.ts).

## Library API

```ts
import { record, render, renderFrame, loadSession } from 'autocast';

const recorded = await record({ url, name: 'demo' }, async (cast) => {
  await cast.click('text=Get started');
});
await recorded.render({ output: 'demo.mp4' });
await render('.autocast/demo', { output: 'demo-4k.mp4', size: { width: 3840, height: 2160 } });
const png = await renderFrame('.autocast/demo', 4200);
```

## For agents

[`skills/autocast/SKILL.md`](skills/autocast/SKILL.md) is a skill that teaches an agent the
workflow: explore the app, write the script, record a preview, inspect the contact sheet, adjust,
render the final video. It also holds direction rules (pacing, when to zoom) and notes for
JupyterLab.

## Examples

| Script                                                               | Shows                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`examples/jupyterlab-notebook.ts`](examples/jupyterlab-notebook.ts) | JupyterLab: a first data analysis in a new notebook.                                |
| [`examples/jupyterlab-tour.ts`](examples/jupyterlab-tour.ts)         | JupyterLab: table of contents, side-by-side documents, command palette, dark theme. |
| [`examples/jupyterlite.ts`](examples/jupyterlite.ts)                 | JupyterLite: Python in the browser with the Pyodide kernel.                         |
| [`examples/orbit-board.ts`](examples/orbit-board.ts)                 | A generic web app: dialog, drag, command palette, chart, theme.                     |
| [`examples/jupyterlab-overlays.ts`](examples/jupyterlab-overlays.ts) | The optional captions and keycaps.                                                  |

`examples/jupyterlab/serve.sh` starts JupyterLab, `examples/jupyterlite/serve.sh` builds and
serves a JupyterLite site, and `node examples/demo-app/serve.mjs` serves the demo app. Set
`JUPYTER_URL`, `JUPYTERLITE_URL` or `ORBIT_URL` when a server runs on another port.

## Development

```sh
npm install
npm test          # unit and integration tests
npm run typecheck
node src/cli.ts record examples/orbit-board.ts   # run from source, no build
```

Source files run directly with Node (type stripping). `src/record` holds the recorder,
`src/render` the renderer, and `src/types.ts` the contract between them.

## Limits

- One page per recording. Popups, new tabs and native `<select>` lists are not captured.
- The default capture is in real time: a page that paints slowly gives fewer distinct frames.
  The `frame-perfect` capture mode removes this limit at the cost of a longer recording.
- No audio.
