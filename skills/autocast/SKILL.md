---
name: autocast
description: Record polished, Screen Studio-style screencasts of web apps with the autocast library (smooth cursor, click effects, eased zooms, framed window). Use when asked to record a screencast, demo video, GIF or feature showcase of a web UI such as JupyterLab, JupyterLite or any site that opens in a browser.
---

# autocast

`autocast` turns a script into a finished screencast. You write what happens on the page and
where the camera looks. The library records the page with Playwright, then renders the cursor,
the click effects, the zooms and the framed window.

You cannot watch a video, so the workflow depends on two commands that show you the result:
`autocast inspect` (timeline as text plus a contact sheet image) and `autocast frame` (one
still). Look at their output with your image reader after every recording.

## Setup

```sh
npm install github:jtpio/autocast playwright   # or use a clone: npm install && npm run build
npx playwright install chromium                # skip when Chromium is already installed
ffmpeg -version                                # must be on the PATH
```

In a clone of the repository, `node src/cli.ts <command>` runs from source and
`node dist/cli.js <command>` runs the build. Elsewhere use `npx autocast <command>`.

## Workflow

1. **Explore the app first.** Open it with plain Playwright, take screenshots at the recording
   viewport (1280x720 by default), and find stable locators for everything you will touch.
   Run the whole flow once without autocast to learn what needs a wait.
2. **Write a storyboard.** Four to eight beats, one idea per beat, 30 to 90 seconds in total.
   For each beat: the action, what the viewer must read, and whether the camera zooms.
3. **Write the script** (template below). Put everything that must not be on video in `setup`.
4. **Record**: `autocast record script.ts --no-render`. A failure names the failing call and
   saves `error.png` in the session directory; look at it.
5. **Inspect**: `autocast inspect .autocast/<name> -o sheet.png`, then read `sheet.png`. Check
   the list in "Review" below. For a closer look at one moment:
   `autocast inspect .autocast/<name> --from 10 --to 14 --every 0.25 -o part.png` or
   `autocast frame .autocast/<name> --at 12.4 -o still.png`. Keep a sheet to 16 tiles or
   fewer so the tiles stay readable; `--tile-width 640 --cols 3` gives larger tiles.
6. **Adjust and repeat** from step 4 until the sheet is right. Look options (backdrop, cursor
   size, output size) need no new recording: pass them to `render` or `inspect`.
7. **Render**: `autocast render .autocast/<name> -o demo.mp4`. Then
   `autocast inspect demo.mp4 -o final.png` and read it as the last check.

## Script template

```ts
import { defineScreencast } from 'autocast';

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
    await cast.wait(1000);
  },
});
```

Scripts are TypeScript or `.mjs`, and Node runs them directly.

## Cast calls

A target is a Playwright locator, a selector string, a point `{ x, y }` or a rectangle
`{ x, y, width, height }` (viewport pixels). Locators are strict: a locator that matches two
elements fails, so narrow it.

| Call                                                                | Use                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cast.click(target)` / `dblclick` / `rightClick`                    | Cursor moves to the target, then presses. Options: `position: { x, y }` as fractions of the target, `modifiers`, `force`.                                        |
| `cast.moveTo(target)` / `cast.hover(target, { hold: 800 })`         | Cursor move without a press. `position` may go outside 0..1, for example `{ x: 0.5, y: -0.2 }` to arrive from above a target without crossing its neighbours.    |
| `cast.drag(from, to)`                                               | Press on `from`, move, release on `to`. Options: `position` (source), `toPosition` (destination), `dragDuration`.                                                |
| `cast.scrollTo(target)` / `cast.scroll({ y: 400 }, { at: target })` | Smooth scroll. Targets off screen scroll into view by themselves before an action.                                                                               |
| `cast.type(text, { into: target })`                                 | Human typing. Multi-line code keeps its indentation, also in editors that indent by themselves.                                                                  |
| `cast.press('Shift+Enter')`                                         | Key combination (Playwright key names).                                                                                                                          |
| `cast.zoomTo(target, { scale, padding })`                           | Camera move. With `scale` the camera centers on the target; without it the target plus `padding` fills the view. Waits for the move to end unless `wait: false`. |
| `cast.zoomOut()`                                                    | Back to the full view.                                                                                                                                           |
| `cast.wait(ms)`                                                     | Hold the shot.                                                                                                                                                   |
| `cast.cut(fn)`                                                      | Run `fn` and remove that time from the video.                                                                                                                    |
| `cast.speed(rate, fn)`                                              | Run `fn` and play that time `rate` times faster.                                                                                                                 |
| `cast.spotlight(target, { duration })`                              | Dim everything except the target.                                                                                                                                |
| `cast.caption(text, { label, duration })`                           | Optional caption on the backdrop below the window. Use only when asked for text in the video.                                                                    |
| `cast.marker(label)`                                                | Name a point in time; shown by `inspect`.                                                                                                                        |

`cast.page` is the Playwright page. Use it to wait and to read state
(`await cast.cut(() => page.getByText('Done').waitFor())`). Never click, type or scroll through
`cast.page` inside `run`: the page would change but the cursor in the video would not move.

## Direction

Good screencasts are calm. The viewer follows one thing at a time.

**Structure**

- Open on the full view and wait about a second. End on the full view (`zoomOut`, then wait).
  The recording already holds 0.6 s before the first call and 1.2 s after the last one.
- The cursor starts at the center of the viewport. If that puts it on top of something
  distracting, set `cursor: { start: { x, y } }` to an empty spot.
- One idea per beat. Show the result of each action before the next action starts.
- Hold on results long enough to read: about 1.5 s, plus 0.3 s for each line of text.

**Camera**

- Zoom when the viewer must read small text, watch typing, or see a small control. Do not zoom
  for large layout changes or navigation.
- Scale 1.3 to 1.6 for a panel, 1.6 to 2.2 for a control or a few lines. Above 2.5 is rare.
  `scale` is how much larger the page looks than in the full view. Without `scale`, the target
  plus `padding` fills the video exactly; use that to frame one panel or one output.
- Zoom first, then act. The camera needs its 0.9 s before the action starts.
- For the next target in the same area, call `zoomTo` again at the same scale: the camera pans.
  Zoom out before the cursor travels far.
- While zoomed, the camera pans a little to keep the cursor in view and returns to your
  framing when the cursor is back inside it (`zoom.followCursor`, on by default). For a shot
  that must not move at all, pass `{ follow: false }` to `zoomTo`.
- Two or three zooms in 30 seconds is a good rhythm. Constant zooming is tiring.

**Time**

- Hide every wait: `await cast.cut(() => locator.waitFor())` for page loads, kernels, network.
- Typing runs at about 13 characters per second, so a 150-character cell takes 12 seconds.
  Long typing is dull: type short text, raise the speed with `typing: { delay: 35 }`, or wrap
  the call in `cast.speed(2, ...)`.
- After a click that changes the page, the default pause is enough for small changes. Add
  `cast.wait(500)` after a large change.

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
- The timeline has no long gap without an action (trim the waits) and no burst of actions
  without a pause (add waits).
- Total length matches the storyboard.

## Look and quality

Pass these to `record`, `render`, `frame` or `inspect`. None of them needs a new recording.

```sh
autocast render .autocast/demo -o demo.mp4 --background harbor
autocast render .autocast/demo -o demo-4k.mp4 --size 3840x2160 --set encode.quality=high
autocast render .autocast/demo -o demo.gif --size 1280x720 --fps 20
autocast render .autocast/demo -o tall.mp4 --size 1080x1920
autocast render .autocast/demo --preview -o quick.mp4
```

| Option                                                | Values                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `size`, `fps`                                         | Any size; 24 to 120 fps. Default 1920x1080 at 60.                                                                                                       |
| `encode.quality`                                      | `draft`, `standard` (default), `high`, `max`. Also `encode.crf`, `encode.preset`.                                                                       |
| `background`                                          | `paper`, `fog`, `sage`, `dune`, `clay`, `dusk` (default), `harbor`, `graphite`, `ink`, `ember`, a CSS color, or `{ type: 'gradient' \| 'image', ... }`. |
| `frame.padding`, `frame.radius`, `frame.shadow`       | Space around the window, corner radius, shadow.                                                                                                         |
| `frame.chrome`                                        | `none` or `window` (title bar; set `frame.title`).                                                                                                      |
| `cursor.size`, `cursor.smoothing`, `cursor.hideAfter` | Cursor size (default 1.6), path smoothing, hide when idle (ms).                                                                                         |
| `cursor.click.type`                                   | `ripple`, `ring`, `none`.                                                                                                                               |
| `zoom.mode`                                           | `camera` (the window grows past the edges) or `crop` (zoom inside a fixed window).                                                                      |
| `zoom.easing`, `zoom.duration`, `zoom.maxScale`       | Camera feel.                                                                                                                                            |
| `zoom.auto`                                           | `true` adds zooms on clicks and typing when the script has none.                                                                                        |
| `zoom.edges`                                          | `fill` (default: a zoomed shot is all page) or `keep` (the window edge and backdrop stay in view).                                                      |
| `zoom.motionBlur`, `cursor.motionBlur`                | 0 to 1.                                                                                                                                                 |
| `keystrokes.show`                                     | `none` (default) or `shortcuts`: shows key combinations from `cast.press` as keycaps.                                                                   |
| `captions.position`                                   | `bottom` (default) or `top`, for `cast.caption`.                                                                                                        |

Backdrops, light to dark: `paper` (warm white), `fog` (cool gray), `sage` (muted green), `dune`
(sand), `clay` (terracotta), `dusk` (slate blue with a warm corner), `harbor` (deep teal),
`graphite` (dark gray), `ink` (blue-black), `ember` (dark brown). Pick one that does not fight
the app's own colors, and check it with `autocast frame <session> --at 1 --background <name>`.

The capture scale is `deviceScaleFactor: 2` by default. For deep zooms or 4K output, record
with `deviceScaleFactor: 3`.

To change a camera move without a new recording, edit the `zoom` events in
`.autocast/<name>/session.json` (`focus` rectangle, `scale`, `t` in milliseconds) and render
again.

## Problems

| Symptom                                   | Fix                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `strict mode violation`                   | The locator matches several elements. Narrow it or use `.first()`.                                         |
| `intercepts pointer events`               | Something covers the target (dialog, toast). Close it or wait.                                             |
| Timeout on a Cast call                    | The target is not visible. Look at `error.png`. Wait for it inside `cast.cut`.                             |
| Cursor does not move but the page changes | The script uses `page.click` or `page.keyboard`. Use `cast`.                                               |
| Blurry text when zoomed                   | Lower the zoom scale or record with `deviceScaleFactor: 3`.                                                |
| Choppy page animation                     | The page paints slowly on this machine. Close other work, or accept it: the cursor and camera stay smooth. |

## More

- [reference/jupyterlab.md](reference/jupyterlab.md): server setup, locators and waits for
  JupyterLab, Notebook and JupyterLite.
- `src/types.ts` in the autocast package: every option with its type.
