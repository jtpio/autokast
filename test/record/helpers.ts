import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Size } from '../../src/types.ts';

/**
 * Python code with a nested loop, dedents and blank lines, for the indentation tests.
 */
export const CODE = `def table(n):
    for i in range(n):
        for j in range(n):
            print(i * j, end=" ")
        print()

    return n


table(3)`;

/**
 * A local HTTP server for test pages.
 */
export interface TestServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Serves HTML pages by path. `host` selects the origin: `localhost` and `127.0.0.1` are
 * different sites, so a link between them is a cross-site navigation.
 */
export function serve(pages: Record<string, string>, host = '127.0.0.1'): Promise<TestServer> {
  const server = http.createServer((request, response) => {
    const body = pages[new URL(request.url ?? '/', 'http://x').pathname];
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html' });
    response.end(body ?? 'not found');
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${port}`,
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Pixel size of an image file, read with ffprobe.
 */
export function probeImageSize(file: string): Size {
  const output = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    file,
  ]).toString();
  const [width, height] = output.trim().split(',').map(Number);
  return { width, height };
}

export function hasFfprobe(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isMonotonic(values: number[]): boolean {
  return values.every((value, i) => i === 0 || value >= values[i - 1]);
}
