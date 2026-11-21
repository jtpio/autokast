import type { PresetName, RenderOptions } from '../types.ts';

const PLAIN: RenderOptions = {
  frame: { padding: 0, chrome: 'none' },
  zoom: { enabled: false },
  captions: { enabled: false },
  keystrokes: { show: 'none' },
  spotlight: { enabled: true },
};

/**
 * Built-in render presets. Each one sets the options that make its look, so that it also
 * replaces the look that the script selects.
 */
export const RENDER_PRESETS: Record<PresetName, RenderOptions> = {
  plain: PLAIN,
  focus: { ...PLAIN, zoom: { enabled: true } },
  showcase: {
    frame: { padding: 0.07, chrome: 'browser' },
    zoom: { enabled: true },
    captions: { enabled: true },
    keystrokes: { show: 'shortcuts' },
    spotlight: { enabled: true },
  },
};
