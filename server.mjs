// Zero-dependency static server for IIYAMA 3D.
// Binds 0.0.0.0 so the Arena preview proxy can reach it; accepts any Host header.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'bad url');
  }
  if (urlPath === '/') urlPath = '/index.html';
  // prevent path traversal
  const abs = path.normalize(path.join(ROOT, urlPath));
  if (!abs.startsWith(ROOT)) return send(res, 403, 'forbidden');

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      return send(res, 404, `not found: ${urlPath}`, { 'content-type': 'text/plain; charset=utf-8' });
    }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const isText = /^text\/|json|javascript|wasm/.test(type);
    const headers = {
      'content-type': type,
      'cache-control': ext === '.glb' ? 'public, max-age=31536000, immutable' : 'no-cache',
      'access-control-allow-origin': '*',
      // allow the game to be framed by the preview host
      'cross-origin-resource-policy': 'cross-origin',
    };
    // Serve a pre-compressed sibling when it is smaller and the client accepts it.
    const gzPath = `${abs}.gz`;
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip && fs.existsSync(gzPath)) {
      const gzStat = fs.statSync(gzPath);
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = gzStat.size;
      res.writeHead(200, headers);
      return fs.createReadStream(gzPath).pipe(res);
    }
    if (isText && st.size > 4096) {
      const raw = fs.readFileSync(abs);
      const gz = zlib.gzipSync(raw, { level: 6 });
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = gz.length;
      res.writeHead(200, headers);
      return res.end(gz);
    }
    headers['content-length'] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(abs).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`IIYAMA 3D dev server on http://0.0.0.0:${PORT}`);
});
