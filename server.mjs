import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = +(process.env.PORT || 3101);

// Single-page app: every GET serves the scene, so it works mounted at any
// base path (e.g. behind `tailscale serve` at /brownstone).
createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const page = readFileSync(join(here, 'brownstone.html'));
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : page);
}).listen(PORT, HOST, () => {
  console.log(`voxel-brownstone listening on http://${HOST}:${PORT}`);
});
