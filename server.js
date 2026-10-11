import { readFileSync } from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase, addIndex, freeSeatsSql } from './database.js';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function integer(raw, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}
async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw new Error('body exceeds 16384 bytes');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('body must be valid JSON'); }
}

export function createService(path) {
  const db = openDatabase(path);
  addIndex(db);
  const list = db.prepare(freeSeatsSql);
  const event = db.prepare('SELECT id FROM events WHERE id = ?');
  const seat = db.prepare('SELECT id FROM seats WHERE id = ?');
  const reserve = db.prepare(`INSERT INTO orders(seat_id, customer_name, created_at)
    VALUES (?, ?, ?) ON CONFLICT(seat_id) DO NOTHING RETURNING *`);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(readFileSync(new URL('./public/index.html', import.meta.url)));
      }
      if (req.method === 'GET' && url.pathname === '/events') return json(res, 200, { items: db.prepare('SELECT id, name, starts_at FROM events ORDER BY id').all() });
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      const free = url.pathname.match(/^\/events\/([^/]+)\/seats$/);
      if (req.method === 'GET' && free) {
        const eventId = integer(free[1]);
        const after = integer(url.searchParams.get('after') ?? '0', 0);
        const limit = integer(url.searchParams.get('limit') ?? '100', 1, 100);
        const fields = {};
        if (eventId === null) fields.eventId = 'must be a positive integer';
        if (after === null) fields.after = 'must be a nonnegative integer';
        if (limit === null) fields.limit = 'must be an integer between 1 and 100';
        if (Object.keys(fields).length) return json(res, 400, { error: 'validation', fields });
        if (!event.get(eventId)) return json(res, 404, { error: 'not_found', message: 'event was not found' });
        const rows = list.all(eventId, after, limit + 1);
        const items = rows.slice(0, limit);
        return json(res, 200, { items, nextCursor: rows.length > limit ? items.at(-1).id : null });
      }
      const booking = url.pathname.match(/^\/seats\/([^/]+)\/reserve$/);
      if (req.method === 'POST' && booking) {
        const seatId = integer(booking[1]);
        if (seatId === null) return json(res, 400, { error: 'validation', fields: { seatId: 'must be a positive integer' } });
        let input;
        try { input = await body(req); }
        catch (error) { return json(res, 400, { error: 'validation', fields: { body: error.message } }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(res, 400, { error: 'validation', fields: { body: 'must be a JSON object' } });
        if (typeof input.customerName !== 'string' || !input.customerName.trim() || input.customerName.length > 100) {
          return json(res, 400, { error: 'validation', fields: { customerName: 'must be a nonempty string of at most 100 characters' } });
        }
        if (!seat.get(seatId)) return json(res, 404, { error: 'not_found', message: 'seat was not found' });
        const order = reserve.get(seatId, input.customerName.trim(), new Date().toISOString());
        return order ? json(res, 201, { order }) : json(res, 409, { error: 'conflict', message: 'seat is already reserved' });
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      const id = randomUUID();
      console.error(JSON.stringify({ id, error: error.name }));
      if (!res.headersSent) json(res, 500, { error: 'internal', id });
      else res.end();
    }
  });
  server.on('close', () => db.close());
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = integer(process.env.PORT ?? '3001', 0, 65535);
  if (port === null) throw new Error('PORT must be an integer between 0 and 65535');
  const server = createService();
  server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ listening: server.address().port })));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
