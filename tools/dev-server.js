/**
 * Serves the real console (index.html / admin.html / order.html / assets) and
 * proxies /api to the new backend.
 *
 * The frontend points CONFIG.API_URL at '/api' whenever it is on localhost, so
 * this is what lets the untouched admin.js talk to the TypeScript API exactly
 * as it will talk to the deployed one -- same protocol, same paths, no edits
 * to the frontend.
 *
 *   node tools/dev-server.js      -> http://localhost:8900  (API on :8901)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8900;
const API = process.env.API_ORIGIN || 'http://localhost:8901';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const target = new URL(API);
      const proxied = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: '/',
          method: req.method,
          headers: {
            'content-type': req.headers['content-type'] || 'text/plain',
            'content-length': body.length,
          },
        },
        (upstream) => {
          res.writeHead(upstream.statusCode || 502, {
            'content-type': upstream.headers['content-type'] || 'application/json',
          });
          upstream.pipe(res);
        },
      );
      proxied.on('error', (err) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `API unreachable: ${err.message}` }));
      });
      proxied.end(body);
    });
    return;
  }

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  // Keep the served tree inside the repo: a path with .. must not escape it.
  const full = path.normalize(path.join(ROOT, file));
  if (!full.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Console on http://localhost:${PORT}  ->  API ${API}`);
});
