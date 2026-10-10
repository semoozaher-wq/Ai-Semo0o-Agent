#!/usr/bin/env node
/**
 * Minimal static file server for the exported Expo web build.
 *
 * Expo's static export emits `chat.html`, `agents.html`, ... and expects the
 * host to resolve extension-less paths to the matching `.html` file (the same
 * behaviour Vercel/Netlify provide). Python's http.server does not, so this tiny
 * server implements that mapping for local screenshot capture.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'dist');
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

async function exists(file) {
  try {
    const s = await stat(file);
    return s.isFile();
  } catch {
    return false;
  }
}

async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const safe = path.normalize(clean).replace(/^(\.\.(\/|\\|$))+/, '');
  const direct = path.join(ROOT, safe);
  if (await exists(direct)) return direct;
  if (await exists(`${direct}.html`)) return `${direct}.html`;
  if (await exists(path.join(direct, 'index.html'))) return path.join(direct, 'index.html');
  return null;
}

const server = createServer(async (request, response) => {
  try {
    let file = await resolveFile(request.url || '/');
    if (!file) {
      const notFound = path.join(ROOT, '+not-found.html');
      file = (await exists(notFound)) ? notFound : path.join(ROOT, 'index.html');
      response.statusCode = 404;
    }
    const body = await readFile(file);
    response.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    response.setHeader('cache-control', 'no-store');
    response.end(body);
  } catch (error) {
    response.statusCode = 500;
    response.end(`server error: ${error.message}`);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`static preview server on http://0.0.0.0:${PORT} (root: ${ROOT})`);
});
