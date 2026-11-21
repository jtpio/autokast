import type { BrowserContextOptions, LaunchOptions, Locator, Page } from 'playwright';

/**
 * A point in viewport CSS pixels, origin at the top-left corner.
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * A size in pixels.
 */
export interface Size {
  width: number;
  height: number;
}

/**
 * A rectangle in viewport CSS pixels.
 */
export interface Rect extends Point, Size {}

/**
 * Named easing curves that the renderer knows.
 */
export type EasingName =
  | 'linear'
  | 'easeInOutCubic'
  | 'easeInOutQuart'
  | 'easeInOutQuint'
  | 'easeOutCubic'
  | 'easeOutQuart'
  | 'easeOutExpo'
  | 'smooth';

/**
 * Cursor shapes that the renderer can draw. Unknown CSS cursors map to `default`.
 */
export type CursorStyle =
  | 'default'
  | 'pointer'
  | 'text'
  | 'grab'
  | 'grabbing'
  | 'crosshair'
  | 'move'
  | 'ew-resize'
  | 'ns-resize'
  | 'nesw-resize'
  | 'nwse-resize'
  | 'not-allowed'
  | 'none';

export type MouseButton = 'left' | 'right' | 'middle';

/*
 * Session: the output of the recorder and the input of the renderer.
 * All times are milliseconds from the start of the recording ("record time").
 */

/**
 * A captured frame. `file` is relative to the session directory.
 */
export interface FrameRef {
  t: number;
  file: string;
}

/**
 * One cursor position sample.
 */
export interface CursorSample extends Point {
  t: number;
}

export interface CursorStyleEvent {
  type: 'cursorStyle';
  t: number;
  style: CursorStyle;
}

export interface MouseButtonEvent extends Point {
  type: 'mouseDown' | 'mouseUp';
  t: number;
  button: MouseButton;
}

/**
 * A key action. `shortcut` holds a combination such as `Shift+Enter`;
 * `text` holds a typed character.
 */
export interface KeyEvent {
  type: 'key';
  t: number;
  kind: 'shortcut' | 'text';
  key: string;
}

/**
 * How the camera reacts to the cursor during a zoomed shot.
 * `off`: the camera stays on its framing.
 * `edge`: the camera pans only when the cursor comes near the edge of the view.
 * `cursor`: the camera travels with the cursor and keeps it near the middle of the view.
 */
export type FollowMode = 'off' | 'edge' | 'cursor';

/**
 * A camera directive. `focus: null` returns to the full view.
 * The magnification is `scale`, or the named `level`, or else the scale that fits
 * `focus` plus `padding` into the view.
 */
export interface ZoomEvent {
  type: 'zoom';
  t: number;
  focus: Rect | null;
  scale?: number;
  /**
   * Name of a zoom level from the `zoom.levels` render option.
   */
  level?: string;
  padding?: number;
  duration?: number;
  easing?: EasingName;
  /**
   * Follow mode until the next zoom directive. Default: the `zoom.follow` render option.
   * `true` means `edge` and `false` means `off`.
   */
  follow?: FollowMode | boolean;
  /**
   * `cursor` marks a zoom on the cursor position with no target: the camera has no
   * framing to return to.
   */
  anchor?: 'target' | 'cursor';
}

/**
 * Removes the record time range [t, end) from the output.
 */
export interface CutEvent {
  type: 'cut';
  t: number;
  end: number;
}

/**
 * Plays the record time range [t, end) at `rate` times the normal speed.
 */
export interface SpeedEvent {
  type: 'speed';
  t: number;
  end: number;
  rate: number;
}

/**
 * A text caption shown from `t` for `duration` milliseconds. `**` in the text starts and
 * ends the emphasis.
 */
export interface CaptionEvent {
  type: 'caption';
  t: number;
  duration: number;
  text: string;
}

/**
 * Dims everything except `rect` from `t` for `duration` milliseconds.
 */
export interface SpotlightEvent {
  type: 'spotlight';
  t: number;
  duration: number;
  rect: Rect;
  padding?: number;
  radius?: number;
}

/**
 * A named point in time, for chapters and for debugging.
 */
export interface MarkerEvent {
  type: 'marker';
  t: number;
  label: string;
}

/**
 * The address of the page from `t`. With `typing`, the address bar of the browser frame
 * shows the text as it is typed during that many milliseconds. With `show`, the address
 * bar is larger for that many milliseconds.
 */
export interface UrlEvent {
  type: 'url';
  t: number;
  url: string;
  typing?: number;
  show?: number;
}

/**
 * One Cast call with its start and end time, for inspection and debugging.
 */
export interface ActionEvent {
  type: 'action';
  t: number;
  end: number;
  call: string;
}

export type TimelineEvent =
  | ActionEvent
  | CursorStyleEvent
  | MouseButtonEvent
  | KeyEvent
  | ZoomEvent
  | CutEvent
  | SpeedEvent
  | CaptionEvent
  | SpotlightEvent
  | MarkerEvent
  | UrlEvent;

/**
 * The content of `session.json`.
 */
export interface Session {
  version: 1;
  name: string;
  createdAt: string;
  url?: string;
  viewport: Size;
  deviceScaleFactor: number;
  /**
   * Pixel size of the captured frames (viewport times device scale factor).
   */
  frameSize: Size;
  duration: number;
  frames: FrameRef[];
  cursor: CursorSample[];
  events: TimelineEvent[];
  /**
   * Render options that the script supplied. `render()` options override them.
   */
  render?: RenderOptions;
}

/*
 * Record options.
 */

export interface CaptureOptions {
  /**
   * `realtime` captures the page as it paints. `frame-perfect` controls the page clock and
   * captures one frame for each step of page time: the recording takes longer than real
   * time, but page motion is exact on any machine. Needs the headless shell of Chromium.
   */
  mode?: 'realtime' | 'frame-perfect';
  /**
   * Frames per second of page time in `frame-perfect` mode. Default: 60.
   */
  fps?: number;
  /**
   * In `frame-perfect` mode, how far the page clock starts ahead of the real clock, in
   * milliseconds. The page clock runs slower than real time, so without a lead a time
   * stamp from a server can be in the page's future. Default: 600000.
   */
  clockLead?: number;
  format?: 'jpeg' | 'png';
  /**
   * JPEG quality, 0-100.
   */
  quality?: number;
}

export interface BrowserOptions {
  headless?: boolean;
  channel?: string;
  executablePath?: string;
  args?: string[];
  launchOptions?: LaunchOptions;
  contextOptions?: BrowserContextOptions;
}

export interface CursorMotionOptions {
  /**
   * Start position. Default: the center of the viewport.
   */
  start?: Point;
  /**
   * Speed multiplier for cursor moves. 2 is twice as fast.
   */
  speed?: number;
  /**
   * Path curvature, 0 (straight) to 1.
   */
  curvature?: number;
  /**
   * Limits for the duration of one move, in milliseconds.
   */
  minDuration?: number;
  maxDuration?: number;
}

export interface TypingOptions {
  /**
   * Mean delay between characters, in milliseconds. Default: 55, which gives about
   * 13 characters per second with the pauses after spaces and punctuation.
   */
  delay?: number;
  /**
   * Random variation of the delay, 0 to 1.
   */
  variance?: number;
}

export interface PacingOptions {
  /**
   * Pause before the first action and after the last one, in milliseconds.
   */
  startDelay?: number;
  endDelay?: number;
  /**
   * Pause between the end of a cursor move and the button press.
   */
  beforeClick?: number;
  afterClick?: number;
  afterType?: number;
  /**
   * Time the mouse button stays down for a click.
   */
  pressDuration?: number;
}

export interface RecordOptions {
  /**
   * Name of the screencast. Used for the session directory and the default output.
   */
  name?: string;
  url?: string;
  viewport?: Size;
  deviceScaleFactor?: number;
  colorScheme?: 'light' | 'dark';
  /**
   * Directory for the session. Default: `.autokast/<name>`.
   */
  sessionDir?: string;
  browser?: BrowserOptions;
  capture?: CaptureOptions;
  cursor?: CursorMotionOptions;
  typing?: TypingOptions;
  pacing?: PacingOptions;
  /**
   * How an off-screen target comes into view before an action. Default: `smooth`.
   */
  scrollBehavior?: 'smooth' | 'instant';
  /**
   * Default time limit for one Cast call, in milliseconds.
   */
  timeout?: number;
  /**
   * Seed for the random variations (path curvature, typing rhythm).
   */
  seed?: number;
  /**
   * Render options stored in the session as its defaults.
   */
  render?: RenderOptions;
}

/*
 * The Cast API: what a screencast script calls.
 */

/**
 * Something on the page: a Playwright locator, a selector, a point or a rectangle.
 */
export type Target = Locator | string | Point | Rect;

export interface MoveOptions {
  /**
   * Duration in milliseconds. Default: computed from the distance.
   */
  duration?: number;
  /**
   * Position relative to the target, as fractions of its size: 0.5 is the middle, and
   * values below 0 or above 1 are outside the target. Default: near the center.
   */
  position?: { x: number; y: number };
  timeout?: number;
}

export interface DragOptions extends MoveOptions {
  /**
   * Position relative to the destination. `position` is for the source.
   */
  toPosition?: { x: number; y: number };
  /**
   * Duration of the move while the button is down. Default: computed, slower than a free move.
   */
  dragDuration?: number;
}

export interface ClickOptions extends MoveOptions {
  button?: MouseButton;
  clickCount?: number;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  /**
   * Skips the Playwright actionability check.
   */
  force?: boolean;
  /**
   * Pause after the press, in milliseconds. Default: `pacing.afterClick`. Use 0 before a
   * `cut` so that a loading state does not show.
   */
  afterClick?: number;
}

export interface TypeOptions extends TypingOptions {
  /**
   * Clicks this target first to focus it, at `position` (fractions of its size) when given.
   */
  into?: Target;
  position?: { x: number; y: number };
  /**
   * `auto` makes each line start at the indentation given in the text, also in
   * editors that indent by themselves. `raw` sends the characters as they are.
   */
  indent?: 'auto' | 'raw';
}

export interface ScrollOptions {
  /**
   * Moves the cursor to this target before the scroll.
   */
  at?: Target;
  duration?: number;
}

export interface ScrollToOptions {
  /**
   * Where the target ends in its scroll container. Default: `center`.
   */
  block?: 'start' | 'center' | 'end' | 'nearest';
  duration?: number;
  timeout?: number;
}

export interface ZoomToOptions {
  /**
   * Magnification of the page relative to the full view: 2 shows the page twice as large.
   * Without `scale` and `level`, the camera fits the target plus `padding` in the output.
   */
  scale?: number;
  /**
   * A named zoom level: `wide`, `medium`, `close`, or a name from the `zoom.levels` render
   * option. A render can change what each level means without a new recording.
   */
  level?: string;
  padding?: number;
  /**
   * How the camera reacts to the cursor during this shot: `off`, `edge` or `cursor`
   * (`true` is `edge`, `false` is `off`). Default: the `zoom.follow` render option.
   */
  follow?: FollowMode | boolean;
  duration?: number;
  easing?: EasingName;
  /**
   * How long the call waits before the next action: `true` for the whole camera move,
   * `false` for no wait, or a number of milliseconds. Default: about a third of the move,
   * so the next action overlaps the camera move.
   */
  wait?: boolean | number;
}

export interface CaptionOptions {
  /**
   * Default: computed from the text length.
   */
  duration?: number;
  /**
   * Waits for the caption to end. Default: false.
   */
  wait?: boolean;
}

export interface GotoOptions {
  /**
   * Shows the URL as typed text in the address bar before the page opens. Default: true
   * when the script selects the browser frame, false otherwise.
   */
  typing?: boolean;
}

export interface ShowUrlOptions {
  /**
   * Default: 2000 ms.
   */
  duration?: number;
  /**
   * Waits for the end. Default: true.
   */
  wait?: boolean;
}

export interface SpotlightOptions {
  duration?: number;
  padding?: number;
  radius?: number;
  wait?: boolean;
}

/**
 * The director that a script uses to act on the page and to control the camera.
 * Every method adds to the timeline at the current record time.
 */
export interface Cast {
  readonly page: Page;
  readonly viewport: Size;

  moveTo(target: Target, options?: MoveOptions): Promise<void>;
  click(target: Target, options?: ClickOptions): Promise<void>;
  dblclick(target: Target, options?: ClickOptions): Promise<void>;
  rightClick(target: Target, options?: ClickOptions): Promise<void>;
  hover(target: Target, options?: MoveOptions & { hold?: number }): Promise<void>;
  drag(from: Target, to: Target, options?: DragOptions): Promise<void>;
  /**
   * Clicks a native `<select>` and chooses options by value or label. The list does not
   * open: the browser draws it outside the page, so the video could not show it.
   */
  select(
    target: Locator | string,
    values: string | string[],
    options?: ClickOptions,
  ): Promise<void>;
  scroll(delta: { x?: number; y?: number }, options?: ScrollOptions): Promise<void>;
  /**
   * Scrolls smoothly until the target is in view.
   */
  scrollTo(target: Target, options?: ScrollToOptions): Promise<void>;

  type(text: string, options?: TypeOptions): Promise<void>;
  press(keys: string, options?: { hold?: number }): Promise<void>;
  /**
   * Opens a URL and removes the load from the video. With the browser frame
   * (`render.frame.chrome: 'browser'`), the address bar first shows the URL as it is typed.
   */
  goto(url: string, options?: GotoOptions): Promise<void>;
  /**
   * Makes the address bar of the browser frame larger for a moment, so that the viewer can
   * read the URL of the page. Does nothing when the script does not select the browser
   * frame.
   */
  showUrl(options?: ShowUrlOptions): Promise<void>;

  zoomTo(target: Target, options?: ZoomToOptions): Promise<void>;
  /**
   * Zooms on the cursor position, to a named level or a scale, and lets the camera travel
   * with the cursor (`follow: 'cursor'` unless the options say otherwise).
   */
  zoom(
    level: string | number,
    options?: Omit<ZoomToOptions, 'scale' | 'level' | 'padding'>,
  ): Promise<void>;
  zoomOut(options?: Omit<ZoomToOptions, 'scale' | 'level' | 'padding' | 'follow'>): Promise<void>;

  wait(ms: number): Promise<void>;
  /**
   * Runs `fn` and removes that time from the video.
   */
  cut<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Runs `fn` and plays that time at `rate` times the normal speed.
   */
  speed<T>(rate: number, fn: () => Promise<T>): Promise<T>;

  /**
   * Shows a caption on the backdrop, one line at a time: text that is too long for one
   * line shows as several lines in sequence. Words between `**` get the emphasis: they
   * keep the full tone and the other words are dimmed.
   */
  caption(text: string, options?: CaptionOptions): Promise<void>;
  spotlight(target: Target, options?: SpotlightOptions): Promise<void>;
  marker(label: string): void;
}

/*
 * Render options.
 */

/**
 * What shows behind the window. An image covers the output and keeps its aspect ratio;
 * `path` is relative to the working directory of the render, and `blur` is in pixels of a
 * 1080-pixel output. `angle` of a gradient is a CSS angle in degrees (default: 135).
 */
export type BackgroundOptions =
  | { type: 'solid'; color: string }
  | { type: 'gradient'; colors: string[]; angle?: number }
  | { type: 'image'; path: string; blur?: number }
  | { type: 'preset'; name: string };

export interface ShadowOptions {
  color?: string;
  blur?: number;
  offsetY?: number;
}

export interface FrameOptions {
  /**
   * Space between the window and the edges of the video, which is how much of the
   * background shows. Below 1: a fraction of the short side of the output. Otherwise
   * pixels of a 1080-pixel output. 0 fills the video with the window. Default: 0.07.
   */
  padding?: number;
  radius?: number;
  shadow?: ShadowOptions | false;
  /**
   * `window` adds a title bar above the content. `browser` adds a browser toolbar with an
   * address bar that follows the URL of the page.
   */
  chrome?: 'none' | 'window' | 'browser';
  title?: string;
  chromeTheme?: 'light' | 'dark';
  /**
   * Text of the address bar. `true` (default) shows the URL of the page, a string shows
   * that text for the whole video, and `false` leaves the address bar empty.
   */
  address?: boolean | string;
  /**
   * Replaces the origin of the page URL in the address bar, for example
   * `jupyterlite.github.io/demo` for a site that was recorded on `localhost:8000`.
   */
  origin?: string;
}

export interface ClickEffectOptions {
  type?: 'ripple' | 'ring' | 'none';
  color?: string;
  /**
   * Final radius in output pixels at scale 1.
   */
  size?: number;
  duration?: number;
}

export interface CursorRenderOptions {
  visible?: boolean;
  /**
   * Size multiplier. 1 is the size of a system cursor at the capture scale.
   */
  size?: number;
  /**
   * Position smoothing with a spring, 0 (off) to 1.
   */
  smoothing?: number;
  /**
   * Scale of the cursor while a button is down.
   */
  pressScale?: number;
  /**
   * Hides the cursor after this many milliseconds without a move. 0 keeps it visible.
   */
  hideAfter?: number;
  /**
   * Motion blur of the cursor during fast moves, 0 (off) to 1 (a full frame of blur).
   */
  motionBlur?: number;
  /**
   * How much the cursor leans into its travel, as if it had weight: 0 (off) to 1 and
   * above. It swings back upright when the cursor stops.
   */
  tilt?: number;
  click?: ClickEffectOptions;
}

export interface AutoZoomOptions {
  scale?: number;
  /**
   * Time the camera stays on a click after the last activity near it.
   */
  hold?: number;
  /**
   * Clicks closer in time than this join into one zoom.
   */
  mergeWindow?: number;
}

export interface ZoomRenderOptions {
  /**
   * Generates zooms from clicks and typing when the script gives no zoom directives.
   */
  auto?: boolean | AutoZoomOptions;
  /**
   * `camera` scales the full frame past the output edges; `crop` zooms inside a fixed frame.
   */
  mode?: 'camera' | 'crop';
  /**
   * In `camera` mode, what a zoomed shot shows at an edge of the page: `fill` covers the
   * output with the page, `keep` keeps the window edge and the backdrop in view.
   */
  edges?: 'fill' | 'keep';
  maxScale?: number;
  duration?: number;
  easing?: EasingName;
  /**
   * How the camera reacts to the cursor while zoomed, for shots that do not set it.
   * Default: `edge`.
   */
  follow?: FollowMode;
  /**
   * How fast the camera catches up with the cursor. 1 is the default; 2 is twice as fast.
   */
  followSpeed?: number;
  /**
   * Named zoom levels. Defaults: `wide` 1.3, `medium` 1.6, `close` 2.2.
   */
  levels?: Record<string, number>;
  motionBlur?: number;
}

export interface KeystrokeOptions {
  show?: 'none' | 'shortcuts' | 'all';
  position?: 'bottom' | 'top';
  /**
   * Key names on the caps: `mac` (⌘ Cmd, ⌥ Opt) or `pc` (Ctrl, Alt). Default: `mac` when
   * the render runs on macOS, else `pc`.
   */
  labels?: 'mac' | 'pc';
}

export interface CaptionRenderOptions {
  position?: 'bottom' | 'top';
  fontSize?: number;
  fontFamily?: string;
}

export interface EncodeOptions {
  /**
   * `draft` renders fast for iteration; `max` is visually lossless and gives large files.
   */
  quality?: 'draft' | 'standard' | 'high' | 'max';
  /**
   * Overrides for the encoder: constant rate factor, speed preset, pixel format.
   */
  crf?: number;
  preset?: string;
  pixelFormat?: string;
  ffmpegPath?: string;
}

export interface RenderOptions {
  /**
   * Output file. The extension selects the format: `.mp4`, `.webm` or `.gif`.
   */
  output?: string;
  size?: Size;
  fps?: number;
  /**
   * A string is a preset name, the path of an image file, or a CSS color.
   */
  background?: BackgroundOptions | string;
  frame?: FrameOptions;
  cursor?: CursorRenderOptions;
  zoom?: ZoomRenderOptions;
  keystrokes?: KeystrokeOptions;
  captions?: CaptionRenderOptions;
  encode?: EncodeOptions;
  /**
   * Renders only this output time range, in milliseconds.
   */
  range?: { start?: number; end?: number };
  onProgress?: (done: number, total: number) => void;
}

export interface RenderResult {
  output: string;
  duration: number;
  frames: number;
  size: Size;
  fps: number;
}

/**
 * Handle to a recorded session on disk.
 */
export interface RecordedSession {
  dir: string;
  session: Session;
  render(options?: RenderOptions): Promise<RenderResult>;
}

/**
 * Context for the `setup` step, which runs before the recording starts.
 */
export interface SetupContext {
  page: Page;
}

/**
 * A screencast definition: the default export of a script for the CLI.
 */
export interface ScreencastDefinition extends RecordOptions {
  setup?: (context: SetupContext) => Promise<void>;
  run: (cast: Cast) => Promise<void>;
}
