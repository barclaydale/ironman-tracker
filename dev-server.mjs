// Local stand-in for Vercel: serves the static site and runs api/*.js handlers.
// Uses the in-memory store unless Upstash env vars are set.
//   npm run dev            -> http://localhost:3000  (passcode: EDIT_PASSCODE or "dev")
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
process.env.EDIT_PASSCODE ||= 'dev';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Minimal Vercel-style req/res helpers
function wrapRes(res) {
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (obj) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const m = url.pathname.match(/^\/api\/([a-z]+)$/);
      if (m) {
        const { default: handler } = await import(`./api/${m[1]}.js`);
        let raw = '';
        for await (const chunk of req) raw += chunk;
        req.query = Object.fromEntries(url.searchParams);
        req.body = raw ? JSON.parse(raw) : {};
        return await handler(req, wrapRes(res));
      }
      const rel = url.pathname === '/' ? 'ironman-training-calendar.html' : decodeURIComponent(url.pathname.slice(1));
      const file = normalize(join(ROOT, rel));
      if (!file.startsWith(ROOT) || rel.startsWith('api/')) throw Object.assign(new Error(), { code: 'ENOENT' });
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      if (e.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not found');
      } else {
        console.error(e);
        res.writeHead(500);
        res.end(e.message);
      }
    }
  })
  .listen(PORT, () => console.log(`Training tracker on http://localhost:${PORT}  (edit passcode: ${process.env.EDIT_PASSCODE})`));
