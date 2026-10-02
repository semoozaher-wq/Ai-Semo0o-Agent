/* eslint-disable */
/**
 * Minimal static file server for the exported web build (dist/).
 *
 * Adds SPA-style fallbacks so client-side routes such as /agent/gpt-5 or
 * /analytics resolve to their exported HTML (or the app shell) instead of a
 * 404 — mirroring how a CDN would host the static export.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function send(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const direct = path.join(ROOT, urlPath);
  const safeDirect = direct.startsWith(ROOT) ? direct : ROOT;

  // 1) exact file
  if (fs.existsSync(safeDirect) && fs.statSync(safeDirect).isFile()) {
    return send(res, safeDirect);
  }

  // 2) <route>.html
  const asHtml = `${safeDirect}.html`;
  if (fs.existsSync(asHtml)) {
    return send(res, asHtml);
  }

  // 3) <route>/index.html
  const asIndex = path.join(safeDirect, 'index.html');
  if (fs.existsSync(asIndex)) {
    return send(res, asIndex);
  }

  // 4) SPA fallback
  return send(res, path.join(ROOT, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Semo0o AI preview running at http://localhost:${PORT}`);
});
