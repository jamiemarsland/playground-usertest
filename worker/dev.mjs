// The service on this machine, for trying it by hand: http://localhost:8787.
// Same worker.js as the live space, with the database in a local file
// (local.sqlite, kept out of git) so tests survive a restart.
//
//   npm run dev
//   PLUGIN_ZIP_URL=http://localhost:8799/card.zip npm run dev   # a card you are working on
import http from 'node:http';
import worker from './worker.js';
import { localDb } from './local-db.mjs';

const PORT = Number(process.env.PORT || 8787);
const env = { DB: localDb(new URL('./local.sqlite', import.meta.url).pathname) };
if (process.env.PLUGIN_ZIP_URL) env.PLUGIN_ZIP_URL = process.env.PLUGIN_ZIP_URL;

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  // the address the rate caps count by, as the live runtime supplies it
  headers.set('cf-connecting-ip', req.socket.remoteAddress || '127.0.0.1');
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
  try {
    const out = await worker.fetch(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body }), env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e && e.stack || e));
  }
}).listen(PORT, () => console.log(`Playground user testing on http://localhost:${PORT}`));
