import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return send(response, 405, 'Method not allowed');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    return send(response, 400, 'Bad request');
  }
  const file = path.join(root, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
  if (file !== root && !file.startsWith(root + path.sep)) return send(response, 403, 'Forbidden');
  try {
    const body = await readFile(file);
    const type = types[path.extname(file)] ?? 'application/octet-stream';
    send(response, 200, request.method === 'HEAD' ? undefined : body, type);
  } catch {
    send(response, 404, 'Not found');
  }
});

server.on('error', (error) => {
  console.error(`Could not start the server: ${error.message}`);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`Orbit demo app: http://localhost:${server.address().port}/`);
});
