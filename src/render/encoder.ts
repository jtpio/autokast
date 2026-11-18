import { spawn, type ChildProcess } from 'node:child_process';
import type { Size } from '../types.ts';
import type { ResolvedOptions } from './defaults.ts';

const X264: Record<string, { preset: string; crf: number }> = {
  draft: { preset: 'veryfast', crf: 24 },
  standard: { preset: 'medium', crf: 16 },
  high: { preset: 'slow', crf: 12 },
  max: { preset: 'slow', crf: 6 },
};

const VP9: Record<string, { cpu: number; crf: number }> = {
  draft: { cpu: 5, crf: 38 },
  standard: { cpu: 2, crf: 28 },
  high: { cpu: 1, crf: 20 },
  max: { cpu: 1, crf: 10 },
};

const COLOR_TAGS = [
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
];

/*
 * Newer ffmpeg versions take the color tags from the frames, not from the output options,
 * so the filter chain sets them too.
 */
const FRAME_TAGS = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv';

/**
 * The ffmpeg binary: `encode.ffmpegPath`, then `AUTOKAST_FFMPEG`, then `ffmpeg` on PATH.
 */
export function ffmpegPath(options: ResolvedOptions): string {
  return options.encode.ffmpegPath || process.env.AUTOKAST_FFMPEG || 'ffmpeg';
}

/**
 * Fails early, with install advice, when ffmpeg cannot run.
 */
export async function checkFfmpeg(binary: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['-version'], { stdio: 'ignore' });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === 'ENOENT'
            ? `ffmpeg not found ("${binary}"). Install ffmpeg, or set encode.ffmpegPath or the AUTOKAST_FFMPEG environment variable.`
            : `Cannot run ffmpeg ("${binary}"): ${error.message}`,
        ),
      );
    });
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`"${binary} -version" exited with code ${code}.`)),
    );
  });
}

/**
 * Arguments that encode raw RGBA frames from stdin into `output`.
 */
export function encoderArgs(
  format: 'mp4' | 'webm' | 'mkv',
  size: Size,
  fps: number,
  encode: ResolvedOptions['encode'],
  output: string,
): string[] {
  const input = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${size.width}x${size.height}`,
    '-framerate',
    String(fps),
    '-i',
    'pipe:0',
  ];
  if (format === 'mkv') {
    return [...input, '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-qp', '0', output];
  }
  const pixelFormat = encode.pixelFormat;
  const convert = [
    '-vf',
    `scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=${pixelFormat},${FRAME_TAGS}`,
  ];
  if (format === 'webm') {
    const q = VP9[encode.quality] ?? VP9.standard;
    return [
      ...input,
      ...convert,
      '-c:v',
      'libvpx-vp9',
      '-crf',
      String(encode.crf ?? q.crf),
      '-b:v',
      '0',
      '-deadline',
      'good',
      '-cpu-used',
      String(q.cpu),
      '-row-mt',
      '1',
      '-pix_fmt',
      pixelFormat,
      ...COLOR_TAGS,
      output,
    ];
  }
  const q = X264[encode.quality] ?? X264.standard;
  return [
    ...input,
    ...convert,
    '-c:v',
    'libx264',
    '-preset',
    encode.preset ?? q.preset,
    '-crf',
    String(encode.crf ?? q.crf),
    '-x264-params',
    'aq-mode=3:colorprim=bt709:transfer=bt709:colormatrix=bt709',
    '-pix_fmt',
    pixelFormat,
    ...COLOR_TAGS,
    '-movflags',
    '+faststart',
    output,
  ];
}

/**
 * GIF fps and width: 25 fps (GIF delays are in hundredths of a second) and at most
 * 1280 pixels wide.
 */
export function gifSettings(size: Size, fps: number): { fps: number; width: number } {
  return { fps: Math.min(fps, 25), width: Math.min(size.width, 1280) };
}

/**
 * Arguments that turn a lossless intermediate into an optimized GIF with its own palette.
 */
export function gifArgs(input: string, output: string, fps: number, width: number): string[] {
  const filter =
    `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];` +
    `[a]palettegen=max_colors=256:stats_mode=diff[p];` +
    `[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    filter,
    '-loop',
    '0',
    output,
  ];
}

/**
 * Runs ffmpeg to completion, with its stderr in the error on failure.
 */
export function runFfmpeg(binary: string, args: string[]): Promise<void> {
  return new FfmpegProcess(binary, args).finish();
}

/**
 * An ffmpeg process fed through stdin, with backpressure and clear failures.
 */
export class FfmpegProcess {
  private readonly child: ChildProcess;
  private stderr = '';
  private failure: Error | null = null;
  private readonly done: Promise<void>;

  constructor(binary: string, args: string[]) {
    this.child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.child.stdin?.on('error', (error) => {
      this.failure ??= error;
    });
    this.done = new Promise((resolve, reject) => {
      this.child.on('error', (error) => {
        this.failure = error;
        reject(new Error(`Cannot run ffmpeg ("${binary}"): ${error.message}`));
      });
      this.child.on('close', (code, signal) => {
        if (code === 0) resolve();
        else {
          const reason = signal ? `signal ${signal}` : `code ${code}`;
          this.failure ??= new Error(`ffmpeg exited with ${reason}`);
          reject(new Error(`ffmpeg failed (${reason}):\n${this.stderr.trim() || '(no output)'}`));
        }
      });
    });
    this.done.catch(() => {});
  }

  /**
   * Writes one frame; waits when the pipe is full.
   */
  async write(data: Buffer): Promise<void> {
    if (this.failure) await this.done;
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) {
      await this.done;
      throw new Error('ffmpeg closed its input.');
    }
    if (!stdin.write(data)) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          stdin.off('drain', finish);
          this.child.off('close', finish);
          resolve();
        };
        stdin.on('drain', finish);
        this.child.on('close', finish);
      });
      if (this.failure) await this.done;
    }
  }

  /**
   * Closes the input and waits for ffmpeg to exit.
   */
  async finish(): Promise<void> {
    this.child.stdin?.end();
    await this.done;
  }

  /**
   * Stops ffmpeg (after an error in the render loop).
   */
  kill(): void {
    this.child.stdin?.destroy();
    this.child.kill('SIGKILL');
  }
}
