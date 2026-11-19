---
name: autokast
description: Record polished, Screen Studio-style screencasts of web apps with the autokast library (smooth cursor, click effects, eased zooms, framed window). Use when asked to record a screencast, demo video, GIF or feature showcase of a web app or any site that opens in a browser.
---

# autokast

`autokast` turns a script into a finished screencast. You write what happens on the page and
where the camera looks. The library records the page with Playwright, then renders the cursor,
the click effects, the zooms and the framed window.

You cannot watch a video, so the workflow depends on two commands that show you the result:
`autokast inspect` (timeline as text plus a contact sheet image) and `autokast frame` (one
still). Look at their output with your image reader after every recording.

## Setup

```sh
npm install --save-dev autokast playwright
npx playwright install chromium                # skip when Chromium is already installed
ffmpeg -version                                # must be on the PATH
```

Run the commands as `npx autokast <command>`. Scripts import from `autokast`. In a clone
of the autokast repository, `node src/cli.ts <command>` runs from source.

## Workflow

1. **Explore the app first.** Open it with plain Playwright, take screenshots at the recording
   viewport (1280x720 by default), and find stable locators for everything you will touch.
   Run the whole flow once without autokast to learn what needs a wait.
2. **Write a storyboard.** Four to eight beats, one idea per beat, 30 to 90 seconds in total.
   For each beat: the action, what the viewer must read, and whether the camera zooms.
3. **Write the script** (template below). Put everything that must not be on video in `setup`.
4. **Record**: `autokast record script.ts --no-render`. A failure names the failing call and
   saves `error.png` in the session directory; look at it.
5. **Inspect**: `autokast inspect .autokast/<name> -o sheet.png`, then read `sheet.png`. Check
   the list in "Review" below. For a closer look at one moment:
   `autokast inspect .autokast/<name> --from 10 --to 14 --every 0.25 -o part.png` or
   `autokast frame .autokast/<name> --at 12.4 -o still.png`. Keep a sheet to 16 tiles or
   fewer so the tiles stay readable; `--tile-width 640 --cols 3` gives larger tiles.
6. **Adjust and repeat** from step 4 until the sheet is right. Look options (backdrop, cursor
   size, output size) need no new recording: pass them to `render` or `inspect`.
7. **Final recording and render**: record once more with
   `--set capture.mode=frame-perfect` (see "Capture modes"), then
   `autokast render .autokast/<name> -o demo.mp4`. Run `autokast inspect demo.mp4 -o final.png`
   and read it as the last check.

## Script template

```ts
import { defineScreencast } from 'autokast';

export default defineScreencast({
  name: 'feature-demo',
  url: 'http://localhost:3000',
  viewport: { width: 1280, height: 720 },
  render: { background: 'dusk' },

  // Not recorded: wait for the app, log in, prepare data, reset state.
  async setup({ page }) {
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  },

  // Recorded. Use cast for every action the viewer must see.
  async run(cast) {
    const { page } = cast;

    await cast.click(page.getByRole('button', { name: 'New task' }));
    await cast.zoomTo(page.getByRole('dialog'), { padding: 40 });
    await cast.type('Write the release notes', { into: page.getByLabel('Title') });
    await cast.click(page.getByRole('button', { name: 'Create task' }));
    await cast.zoomOut();
  },
});
```

Scripts are TypeScript or `.mjs`, and Node runs them directly. In a project whose
`package.json` has no `"type": "module"`, name the script `.mts`: with `.ts`, Node prints a
module warning (it does no harm).

## Cast calls

A target is a Playwright locator, a selector string, a point `{ x, y }` or a rectangle
`{ x, y, width, height }` (viewport pixels). Locators are strict: a locator that matches two
elements fails, so narrow it.

| Call                                                                | Use                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cast.click(target)` / `dblclick` / `rightClick`                    | Cursor moves to the target, then presses. Options: `position: { x, y }` as fractions of the target, `modifiers`, `force`.                                                                                                                                       |
| `cast.moveTo(target)` / `cast.hover(target, { hold: 800 })`         | Cursor move without a press. `position` may go outside 0..1, for example `{ x: 0.5, y: -0.2 }` to arrive from above a target without crossing its neighbours.                                                                                                   |
| `cast.drag(from, to)`                                               | Press on `from`, move, release on `to`. Options: `position` (source), `toPosition` (destination), `dragDuration`.                                                                                                                                               |
| `cast.scrollTo(target)` / `cast.scroll({ y: 400 }, { at: target })` | Smooth scroll. Targets off screen scroll into view by themselves before an action.                                                                                                                                                                              |
| `cast.type(text, { into: target })`                                 | Human typing. Multi-line code keeps its indentation, also in editors that indent by themselves.                                                                                                                                                                 |
| `cast.press('Shift+Enter')`                                         | Key combination (Playwright key names).                                                                                                                                                                                                                         |
| `cast.goto(url)`                                                    | Opens a URL and removes the load from the video. With the browser frame, the address bar first shows the URL as typed text.                                                                                                                                     |
| `cast.showUrl({ duration })`                                        | Browser frame only: makes the address bar larger for a moment (default 2 s), so that the viewer can read the URL.                                                                                                                                               |
| `cast.zoomTo(target, { level, scale, padding, follow })`            | Frames a target. `level` is a named zoom level (`wide`, `medium`, `close`), `scale` a number; with neither, the target plus `padding` fills the view. `follow` is `off`, `edge` or `cursor`. The next action overlaps the move; `wait: true` waits for its end. |
| `cast.zoom(level)`                                                  | Zooms on the cursor, to a level name or a number, and the camera then travels with the cursor. Use it to guide the eye across the interface without a fixed target.                                                                                             |
| `cast.zoomOut()`                                                    | Back to the full view.                                                                                                                                                                                                                                          |
| `cast.wait(ms)`                                                     | Hold the shot.                                                                                                                                                                                                                                                  |
| `cast.cut(fn)`                                                      | Run `fn` and remove that time from the video.                                                                                                                                                                                                                   |
| `cast.speed(rate, fn)`                                              | Run `fn` and play that time `rate` times faster.                                                                                                                                                                                                                |
| `cast.spotlight(target, { duration })`                              | Dim everything except the target.                                                                                                                                                                                                                               |
| `cast.caption(text, { duration })`                                  | Optional caption on the backdrop below the window. `**` around words gives them the emphasis. Use only when asked for text in the video.                                                                                                                        |
| `cast.marker(label)`                                                | Name a point in time; shown by `inspect`.                                                                                                                                                                                                                       |

`cast.page` is the Playwright page. Use it to wait and to read state
(`await cast.cut(() => page.getByText('Done').waitFor())`). Never click, type or scroll through
`cast.page` inside `run`: the page would change but the cursor in the video would not move.

## Direction

Good screencasts are calm but never idle. The viewer follows one thing at a time, and every
moment has motion or something new to read.

**Structure**

- Open on the full view and end on the full view (`zoomOut`). The recording already holds
  0.4 s before the first call and 0.9 s after the last one; do not add more at the start.
- The cursor starts at the center of the viewport. If that puts it on top of something
  distracting, set `cursor: { start: { x, y } }` to an empty spot.
- One idea per beat. Show the result of each action before the next action starts.
- Hold on a result only as long as a reader needs: about 1.2 s for one fact, up to 2 s for a
  table or a plot.

**Camera**

- Zoom when the viewer must read small text, watch typing, or see a small control. Do not zoom
  for large layout changes or navigation.
- Scale 1.3 to 1.6 for a panel, 1.6 to 2.2 for a control or a few lines. Above 2.5 is rare.
  `scale` is how much larger the page looks than in the full view. Without `scale`, the target
  plus `padding` fills the video exactly; use that to frame one panel or one output.
- Call `zoomTo` just before the action. The call returns after about a third of the camera
  move, so the cursor or the typing starts while the camera still travels. Pass
  `{ wait: true }` only when the viewer must see the shot settle before something happens.
- Go from one zoomed shot to the next with one `zoomTo`: the camera pans and rescales in one
  move, and a target below the fold scrolls into view by itself. Do not zoom out between two
  shots unless the next action needs the full layout.
- Choose how the camera reacts to the cursor for each shot, with `follow`:
  `edge` (default for `zoomTo`) keeps your framing and pans only when the cursor comes near
  the edge; `cursor` (default for `cast.zoom`) travels with the cursor; `off` never moves.
  Use `off` for a shot that must stay still, and `cursor` when the action crosses the page.
- Use the named levels so that shots of the same kind have the same size: `wide` (1.3) for a
  panel, `medium` (1.6) for a group of controls, `close` (2.2) for one control or a few
  lines. A render can change these values with `zoom.levels`.

**Time**

- No dead time. Do not put `cast.wait` between actions: the built-in pauses after a click or
  a key are enough. Use `cast.wait` only to hold on a result. A video that feels slow has too
  many waits.
- Hide every wait for the app: `await cast.cut(() => locator.waitFor())` for page loads,
  kernels, network. Pass `{ afterClick: 0 }` to the click before a `cut`, so that no loading
  state shows.
- Typing runs at about 16 characters per second. For code, use `typing: { delay: 30 }` (about
  25 characters per second) and keep cells short; 40 seconds of typing in a one-minute video
  is too much.
- To show another URL, call `cast.goto(url)`: it opens the page and removes the load from
  the video. Then cut the wait for the content: `await cast.cut(() => locator.waitFor())`.
  For a click that reloads the page, start `const loaded = page.waitForEvent('load')` before
  the click and `await loaded` inside the cut. A camera move continues across a cut, so go to
  the full view first with `cast.zoomOut({ wait: true })`.
- When the URL is part of the story, set `render: { frame: { chrome: 'browser' } }`. The
  address bar follows the page, and `cast.goto` shows the URL as typed text, in a larger
  field, before the page opens. When the page changes its own URL (a redirect, a new query),
  call `cast.showUrl()` to make the address bar larger for a moment. A zoomed shot hides the
  toolbar, so stay in the full view while the viewer must read the URL.

**Captions**

- Use captions for a tour of several features: one caption for each feature. Put `**` around
  the words that name the feature: `cast.caption('**Site Drive** shows the site files')`.
  These words keep the full tone and the other words are dimmed.
- A new caption replaces the one on screen, so give each caption a `duration` longer than its
  part, and let the last one stay until the end.
- A caption shows one line: write one short sentence of about 60 characters, with no
  number. For more text, use several captions. Text that is too long for one line shows as
  several lines, one at a time, and the lines share the `duration`.
- A viewer needs about 3 s to read a caption and see the action. Make each part at least
  that long; the limit of one fifth for holds does not apply to a captioned tour.
- While a caption shows, the view above the caption is wider than the video: about 2:1 for
  a 16:9 video. A `zoomTo` without `scale` or `level` keeps the whole target in that view,
  so a 16:9 target shows more of the page at its sides. Give the target the shape of the
  view, for example `{ x: 0, y: 28, width: 960, height: 472 }` with `padding: 0`, or use a
  `level`.

**State**

- A recording must start from the same state every time. Reset the app in `setup` (URL
  parameters, API calls, deleting files from an earlier run).
- Choose the theme, window size and data so the feature is the most visible thing on screen.

## Review

Read the contact sheet and check:

- The first and last tiles show the full view, with no loading state and no leftover dialog.
- In each zoomed tile, the target is inside the view and its text is large enough to read.
- The cursor is on the control that the timeline says was clicked.
- No tile shows a spinner, an empty panel or a half-loaded page (add a `cut` around the wait).
- Add up the `wait` and `hold` times in the timeline. More than about a fifth of the video is
  too slow: trim them. A result that the viewer cannot read in time needs a longer hold.
- Total length matches the storyboard.

## Look and quality

Pass these to `record`, `render`, `frame` or `inspect`. None of them needs a new recording.

```sh
autokast render .autokast/demo -o demo.mp4 --background harbor
autokast render .autokast/demo -o demo-4k.mp4 --size 3840x2160 --set encode.quality=high
autokast render .autokast/demo -o demo.gif --size 1280x720 --fps 20
autokast render .autokast/demo -o tall.mp4 --size 1080x1920
autokast render .autokast/demo --preview -o quick.mp4
```

| Option                                                | Values                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `size`, `fps`                                         | Any size; 24 to 120 fps. Default 1920x1080 at 60.                                                                                                       |
| `encode.quality`                                      | `draft`, `standard` (default), `high`, `max`. Also `encode.crf`, `encode.preset`.                                                                       |
| `background`                                          | `paper`, `fog`, `sage`, `dune`, `clay`, `dusk` (default), `harbor`, `graphite`, `ink`, `ember`, a CSS color, or `{ type: 'gradient' \| 'image', ... }`. |
| `frame.padding`, `frame.radius`, `frame.shadow`       | Space around the window, corner radius, shadow.                                                                                                         |
| `frame.chrome`                                        | `none`, `window` (title bar; set `frame.title`) or `browser` (toolbar with an address bar that follows the page URL).                                   |
| `frame.chromeTheme`                                   | `light` (default) or `dark`, for the title bar and the browser toolbar.                                                                                 |
| `frame.address`, `frame.origin`                       | Browser frame: a fixed text for the address bar (`false` for none), and a text that replaces the origin of the page URL.                                |
| `cursor.size`, `cursor.smoothing`, `cursor.hideAfter` | Cursor size (default 1.9), path smoothing, hide when idle (ms).                                                                                         |
| `cursor.click.type`                                   | `ripple`, `ring`, `none`.                                                                                                                               |
| `zoom.mode`                                           | `camera` (the window grows past the edges) or `crop` (zoom inside a fixed window).                                                                      |
| `zoom.easing`, `zoom.duration`, `zoom.maxScale`       | Camera feel.                                                                                                                                            |
| `zoom.follow`, `zoom.followSpeed`                     | Follow mode for shots that do not set one (`off`, `edge`, `cursor`), and how fast the camera catches up (default 1).                                    |
| `zoom.levels`                                         | Scale of each named level, for example `--set 'zoom.levels={"close":2.6}'`.                                                                             |
| `zoom.auto`                                           | `true` adds zooms on clicks and typing when the script has none.                                                                                        |
| `zoom.edges`                                          | `fill` (default: a zoomed shot is all page) or `keep` (the window edge and backdrop stay in view).                                                      |
| `cursor.tilt`                                         | How much the cursor leans into its travel (default 1; 0 turns it off).                                                                                  |
| `cursor.motionBlur`, `zoom.motionBlur`                | 0 to 1. The cursor has motion blur by default; camera moves have none unless you set it.                                                                |
| `keystrokes.show`                                     | `none` (default) or `shortcuts`: shows key combinations from `cast.press` as keycaps.                                                                   |
| `captions.position`                                   | `bottom` (default) or `top`, for `cast.caption`.                                                                                                        |

Backdrops, light to dark: `paper` (warm white), `fog` (cool gray), `sage` (muted green), `dune`
(sand), `clay` (terracotta), `dusk` (slate blue with a warm corner), `harbor` (deep teal),
`graphite` (dark gray), `ink` (blue-black), `ember` (dark brown). Pick one that does not fight
the app's own colors, and check it with `autokast frame <session> --at 1 --background <name>`.

The capture scale is `deviceScaleFactor: 2` by default. For deep zooms or 4K output, record
with `deviceScaleFactor: 3`.

Camera moves across a page with much text make most of the file size. When a file must be
below an upload limit (GitHub accepts 10 MB), render with a higher `encode.crf`:
`--set encode.crf=23` gives about half the size of `standard`, and text stays sharp.

To change a camera move without a new recording, edit the `zoom` events in
`.autokast/<name>/session.json` (`focus` rectangle, `scale`, `t` in milliseconds) and render
again.

## Capture modes

- `realtime` (default): the recording takes as long as the video. The page is captured as fast
  as it paints. On a machine without a GPU, a heavy page paints only 20 to 25 frames per
  second while it scrolls or animates.
- `frame-perfect`: the library controls the page clock and captures one frame for each 1/60 s
  of page time. Scrolls, drags and animations are exact at 60 fps on any machine, and the
  result does not change with the machine load. The recording takes 3 to 4 times longer.

Work in `realtime` while you write and adjust the script. Make the final recording with
`--set capture.mode=frame-perfect` (or `capture: { mode: 'frame-perfect' }` in the script).

Rules for `frame-perfect`:

- It needs the default headless Chromium: no `--headed`, no `browser.channel`.
- Only the recorded page gets frames. Do not open a second tab in `setup` or `run`.
- `cast.wait` and all Cast pauses are page time. `page.waitForTimeout` is real time.
- Waits inside `cast.cut` cost little: no frames are captured there.
- Answers from a server arrive early in page time, so a loading state can be very short.

## Problems

| Symptom                                   | Fix                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `strict mode violation`                   | The locator matches several elements. Narrow it or use `.first()`.                      |
| `intercepts pointer events`               | Something covers the target (dialog, toast). Close it or wait.                          |
| Timeout on a Cast call                    | The target is not visible. Look at `error.png`. Wait for it inside `cast.cut`.          |
| Cursor does not move but the page changes | The script uses `page.click` or `page.keyboard`. Use `cast`.                            |
| Blurry text when zoomed                   | Lower the zoom scale or record with `deviceScaleFactor: 3`.                             |
| Choppy scroll, drag or page animation     | The page paints slowly on this machine. Record with `--set capture.mode=frame-perfect`. |

## More

- [reference/jupyterlab.md](reference/jupyterlab.md): server setup and known problems of
  JupyterLab, Notebook and JupyterLite. Read it only for these apps.
- `src/types.ts` in the autokast package: every option with its type.
