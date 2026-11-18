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
 * A camera directive. `focus: null` returns to the full view.
 * Without `scale`, the renderer fits `focus` plus `padding` into the view.
 */
export interface ZoomEvent {
  type: 'zoom';
  t: number;
  focus: Rect | null;
  scale?: number;
  padding?: number;
  duration?: number;
  easing?: EasingName;
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
 * A text caption shown from `t` for `duration` milliseconds.
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

export type TimelineEvent =
  | CursorStyleEvent
  | MouseButtonEvent
  | KeyEvent
  | ZoomEvent
  | CutEvent
  | SpeedEvent
  | CaptionEvent
  | SpotlightEvent
  | MarkerEvent;

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
   * Mean delay between characters, in milliseconds.
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
   * Directory for the session. Default: `.autocast/<name>`.
   */
  sessionDir?: string;
  browser?: BrowserOptions;
  capture?: CaptureOptions;
  cursor?: CursorMotionOptions;
  typing?: TypingOptions;
  pacing?: PacingOptions;
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
   * Position inside the target, as fractions of its size. Default: near the center.
   */
  position?: { x: number; y: number };
  timeout?: number;
}

export interface ClickOptions extends MoveOptions {
  button?: MouseButton;
  clickCount?: number;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  /**
   * Skips the Playwright actionability check.
   */
  force?: boolean;
}

export interface TypeOptions extends TypingOptions {
  /**
   * Clicks this target first to focus it.
   */
  into?: Target;
}

export interface ScrollOptions {
  /**
   * Moves the cursor to this target before the scroll.
   */
  at?: Target;
  duration?: number;
}

export interface ZoomToOptions {
  scale?: number;
  padding?: number;
  duration?: number;
  easing?: EasingName;
  /**
   * Waits for the camera move to end before the next action. Default: true.
   */
  wait?: boolean;
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
  drag(from: Target, to: Target, options?: MoveOptions): Promise<void>;
  scroll(delta: { x?: number; y?: number }, options?: ScrollOptions): Promise<void>;

  type(text: string, options?: TypeOptions): Promise<void>;
  press(keys: string, options?: { hold?: number }): Promise<void>;

  zoomTo(target: Target, options?: ZoomToOptions): Promise<void>;
  zoomOut(options?: Omit<ZoomToOptions, 'scale' | 'padding'>): Promise<void>;

  wait(ms: number): Promise<void>;
  /**
   * Runs `fn` and removes that time from the video.
   */
  cut<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Runs `fn` and plays that time at `rate` times the normal speed.
   */
  speed<T>(rate: number, fn: () => Promise<T>): Promise<T>;

  caption(text: string, options?: CaptionOptions): Promise<void>;
  spotlight(target: Target, options?: SpotlightOptions): Promise<void>;
  marker(label: string): void;
}

/*
 * Render options.
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
   * Space around the content. Below 1: a fraction of the output height. Otherwise pixels.
   */
  padding?: number;
  radius?: number;
  shadow?: ShadowOptions | false;
  /**
   * `window` adds a title bar above the content.
   */
  chrome?: 'none' | 'window';
  title?: string;
  chromeTheme?: 'light' | 'dark';
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
  motionBlur?: number;
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
  maxScale?: number;
  duration?: number;
  easing?: EasingName;
  /**
   * Pans the camera to keep the cursor in view while zoomed.
   */
  followCursor?: boolean;
  motionBlur?: number;
}

export interface KeystrokeOptions {
  show?: 'none' | 'shortcuts' | 'all';
  position?: 'bottom' | 'top';
}

export interface CaptionRenderOptions {
  position?: 'bottom' | 'top';
  fontSize?: number;
  fontFamily?: string;
}

export interface EncodeOptions {
  /**
   * `draft` renders fast for iteration; `high` gives the best quality.
   */
  quality?: 'draft' | 'standard' | 'high';
  crf?: number;
  ffmpegPath?: string;
}

export interface RenderOptions {
  /**
   * Output file. The extension selects the format: `.mp4`, `.webm` or `.gif`.
   */
  output?: string;
  size?: Size;
  fps?: number;
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
