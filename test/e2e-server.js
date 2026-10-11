// Local server for browser tests: the real static files + the real API handlers on PGlite, external services mocked.
// node test/e2e-server.js [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, sql, mock } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.FRONT_ENV = 'test';
process.env.ADMIN_EMAIL = 'owner@front.test';
await freshDb();

const routes = {
  '/api/config': '../api/config.js', '/api/order': '../api/order.js', '/api/track': '../api/track.js', '/api/agent-link': '../api/agent-link.js',
  '/api/brief/note': '../api/brief/note.js', '/api/brief/contact': '../api/brief/contact.js', '/api/brief/finish': '../api/brief/finish.js',
  '/api/paypal/create': '../api/paypal/create.js', '/api/paypal/capture': '../api/paypal/capture.js', '/api/paypal/webhook': '../api/paypal/webhook.js',
  '/api/elevenlabs/webhook': '../api/elevenlabs/webhook.js', '/api/admin/summary': '../api/admin/summary.js', '/api/admin/order': '../api/admin/order.js',
  '/api/admin/verify-manual': '../api/admin/verify-manual.js', '/api/cron/meta-flush': '../api/cron/meta-flush.js',
  '/api/consent': '../api/consent.js', '/api/admin/recover': '../api/admin/recover.js', '/api/admin/login': '../api/admin/login.js', '/api/admin/paypal-check': '../api/admin/paypal-check.js',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.json': 'application/json' };

// Test-only control endpoints (never deployed): approve a PayPal order, inspect the DB.
async function control(path, body) {
  if (path === '/__test/approve') { mock.approve(body.id); return { ok: true }; }
  if (path === '/__test/sql') return { rows: await sql(body.q, body.p || []) };
  if (path === '/__test/calls') return { calls: mock.calls.map(c => ({ url: c.url, method: c.method })) };
  if (path === '/__test/lastmail') { const m = mock.calls.filter(c => /hook\.make\.test/.test(c.url)).pop(); return { body: m ? m.body : null }; }
  return null;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (url.pathname.startsWith('/__test/')) {
      const out = await control(url.pathname, body.length ? JSON.parse(body) : {});
      res.writeHead(out ? 200 : 404, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out));
    }
    if (routes[url.pathname]) {
      const mod = await import(routes[url.pathname]);
      const handler = mod[req.method];
      if (!handler) { res.writeHead(405); return res.end(); }
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(',') : v);
      headers.set('x-forwarded-for', req.headers['x-forwarded-for'] || '127.0.0.1');   // a test context may act as its own visitor
      const r = await handler(new Request('http://localhost' + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
      res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!extname(p)) p += '.html';                                  // cleanUrls
    const file = join(root, p);
    if (!file.startsWith(root) || p.includes('..')) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end('not found'); }
    console.error(e); res.writeHead(500); res.end('error');
  }
}).listen(Number(process.argv[2] || 8787), () => console.log('e2e server ready'));
